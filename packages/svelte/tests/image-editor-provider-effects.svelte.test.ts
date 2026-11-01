import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock } from "@pixerate/editor/tools";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { ImageEditorController, type PixelLayer, type SmartObjectLayer } from "@pixerate/editor/image-editor";
import { ImageProviderEffectsPanel, LayerPanel } from "../src/image-editor";
import ImageEffectsProbe from "./fixtures/ImageEffectsProbe.svelte";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});
beforeAll(() => {
  window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
});

let target: HTMLElement;
function render(component: any, props: Record<string, any>) {
  target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanups.push(() => {
    unmount(instance);
    target.remove();
  });
}
const q = <T extends Element = HTMLElement>(sel: string) => {
  const el = target.querySelector(sel) as T | null;
  if (!el) throw new Error(`No element for ${sel}`);
  return el;
};
const button = (text: string) => [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};
const click = async (el: Element) => {
  (el as HTMLElement).click();
  flushSync();
  await settle();
};

function setup(effects: ReturnType<typeof createFakeEffectProvider> | null = createFakeEffectProvider()) {
  const fake = { width: 8, height: 4, naturalWidth: 8, naturalHeight: 4 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, effects });
  const data = new Uint8ClampedArray(8 * 4 * 4).fill(255);
  const id = c.addPixelLayer({ name: "Photo", pixels: { width: 8, height: 4, data } });
  return { c, id };
}

const select = (label: string) => q<HTMLSelectElement>(`select[aria-label="${label}"]`);
const choose = async (label: string, value: string) => {
  const el = select(label);
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  await settle();
};

describe("ImageProviderEffectsPanel (Svelte)", () => {
  it("is the LayerPanel for provider-effects", async () => {
    const { c } = setup();
    render(LayerPanel, { controller: c, panelId: "provider-effects" });
    expect(q("[data-image-provider-effects]")).toBeTruthy();
    expect(target.textContent).toMatch(/No filters yet/);
  });

  it("applies a filter effect from Add filter as a smart filter, edits it and removes it", async () => {
    const { c, id } = setup();
    render(ImageProviderEffectsPanel, { controller: c });
    await click(button("Add filter…"));
    await click(q('[data-effect-id="fake.invert"]'));
    const layer = c.getLayer(id) as SmartObjectLayer;
    expect(layer.type).toBe("smart");
    const f = layer.smartFilters!.filters[0];
    expect(f).toMatchObject({ kind: "effect", effect: "fake.invert" });
    await click(q(`[data-smart-effect="${f.id}"] input[type="checkbox"]`));
    expect((c.getLayer(id) as SmartObjectLayer).smartFilters!.filters[0].enabled).toBe(false);
    await click(q('[aria-label="Remove Invert"]'));
    expect((c.getLayer(id) as SmartObjectLayer).smartFilters?.filters ?? []).toEqual([]);
  });

  it("keeps the layer's transparency for a new filter, toggled by Keep transparency", async () => {
    const { c, id } = setup();
    render(ImageProviderEffectsPanel, { controller: c });
    await click(button("Add filter…"));
    await click(q('[data-effect-id="fake.invert"]'));
    const f = (c.getLayer(id) as SmartObjectLayer).smartFilters!.filters[0];
    expect(f).toMatchObject({ kind: "effect", preserveTransparency: true });
    const keep = q<HTMLInputElement>('input[aria-label="Invert: keep transparency"]');
    expect(keep.checked).toBe(true);
    await click(keep);
    expect((c.getLayer(id) as SmartObjectLayer).smartFilters!.filters[0]).toMatchObject({ preserveTransparency: false });
    expect(q<HTMLInputElement>('input[aria-label="Invert: keep transparency"]').checked).toBe(false);
  });

  it("adds an effect layer above the active layer, clipped to it with Clip to layer below", async () => {
    const { c, id } = setup();
    render(ImageProviderEffectsPanel, { controller: c });
    await click(q('input[aria-label="Clip to layer below"]'));
    await click(button("Add effect layer…"));
    await click(q('[data-effect-id="fake.gradient"]'));
    const layers = c.getState().layers;
    const added = layers[layers.length - 1];
    expect(added).toMatchObject({ type: "pixel", clipped: true, generator: { effect: "fake.gradient" } });
    expect(layers[layers.length - 2].id).toBe(id);
  });

  it("leaves layer styles to the layer's properties", async () => {
    const { c, id } = setup();
    c.addLayerEffect(id, "drop-shadow");
    render(ImageProviderEffectsPanel, { controller: c });
    expect(target.querySelector('[data-testid="layer-effects"]')).toBeNull();
    expect(target.querySelector("select")).toBeNull();
    expect(target.textContent).toMatch(/Layer styles such as a drop shadow are in the layer's properties/);
  });

  it("shows Layer Style in LayerPanel's properties, with its Add style menu", async () => {
    const { c, id } = setup();
    render(LayerPanel, { controller: c, panelId: "properties" });
    expect(q('[data-testid="layer-effects"]').textContent).toMatch(/Layer Style/);
    await choose("Add style", "drop-shadow");
    expect(c.getLayerEffects(id).items.map((e) => e.kind)).toEqual(["drop-shadow"]);
  });

  it("has no Layer Style in properties for an adjustment layer", () => {
    const { c } = setup();
    c.setActiveLayer(c.addAdjustmentLayer("curves"));
    render(LayerPanel, { controller: c, panelId: "properties" });
    expect(target.querySelector('[data-testid="layer-effects"]')).toBeNull();
  });

  it("shows an effect layer's controls, changes its effect and rasterizes it", async () => {
    const { c } = setup();
    const id = await c.addEffectLayer("fake.bar");
    render(ImageProviderEffectsPanel, { controller: c });
    await settle();
    expect(q('[data-effect-part="generator"]').textContent).toMatch(/Lower-third bar/);
    await click(button("Change…"));
    await click(q('[data-effect-id="fake.gradient"]'));
    expect((c.getLayer(id) as PixelLayer).generator).toMatchObject({ effect: "fake.gradient", values: { opacity: 0 } });
    await settle();
    expect(q('[data-effect-part="generator"]').textContent).toMatch(/Gradient/);
    expect(target.querySelectorAll("[data-effect-control]").length).toBe(5);
    await click(button("Rasterize"));
    expect((c.getLayer(id) as PixelLayer).generator).toBeUndefined();
  });

  it("picks a still frame or an animation with its length", async () => {
    const { c } = setup();
    const id = await c.addEffectLayer("fake.gradient");
    render(ImageProviderEffectsPanel, { controller: c });
    await settle();
    const timing = q('[data-effect-part="timing"]');
    expect(timing.querySelector('[aria-checked="true"]')!.textContent).toBe("Still frame");
    const frame = q<HTMLInputElement>('input[aria-label="Frame"]');
    expect(frame.max).toBe("4000");
    frame.value = "1000";
    frame.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect((c.getLayer(id) as PixelLayer).generator!.time).toBe(1000);
    await click(button("Animate"));
    expect((c.getLayer(id) as PixelLayer).generator!.animate).toEqual({ duration: 4000 });
    expect(c.getAnimation()).toMatchObject({ duration: 4000 });
    const length = q<HTMLInputElement>('input[aria-label="Animation length in seconds"]');
    length.value = "2.5";
    length.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect((c.getLayer(id) as PixelLayer).generator!.animate).toEqual({ duration: 2500 });
    expect(target.textContent).toMatch(/loops every 4\.00 s/);
    await click(button("Still frame"));
    expect(c.getAnimation()).toBeNull();
  });

  it("keeps the frame slider mounted while it is dragged", async () => {
    const { c } = setup();
    const id = await c.addEffectLayer("fake.gradient");
    render(ImageProviderEffectsPanel, { controller: c });
    await settle();
    const frame = q<HTMLInputElement>('input[aria-label="Frame"]');
    // Each step of a drag edits the layer; the slider under the pointer must survive it, or
    // the browser ends the drag.
    for (const value of ["500", "1000", "1500"]) {
      frame.value = value;
      frame.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      expect(frame.isConnected).toBe(true);
      expect(q('input[aria-label="Frame"]')).toBe(frame);
      await settle();
      expect(q('input[aria-label="Frame"]')).toBe(frame);
    }
    expect((c.getLayer(id) as PixelLayer).generator!.time).toBe(1500);
  });

  it("hides frames for an effect that does not move", async () => {
    const provider = createFakeEffectProvider();
    const { c } = setup(provider);
    const describe = provider.describe.bind(provider);
    provider.describe = async (id: string) => ({ ...(await describe(id)), duration: undefined });
    await c.addEffectLayer("fake.gradient");
    render(ImageProviderEffectsPanel, { controller: c });
    await settle();
    expect(target.querySelector('[data-effect-part="timing"]')).toBeNull();
  });

  it("without a provider, says so and adds no filters", () => {
    const { c } = setup(null);
    render(ImageProviderEffectsPanel, { controller: c });
    expect(target.textContent).toMatch(/No effects provider/);
    expect(button("Add filter…")).toBeUndefined();
  });

  it("useImageEffectsTools registers the tools", async () => {
    const { c, id } = setup();
    const registry = new ToolRegistry();
    render(ImageEffectsProbe, { registry, controller: c });
    const r = await registry.callTool("imgfx__apply_effect", { target: id, effect: "fake.tint" });
    expect(r.isError).toBeFalsy();
  });

  it("useImageEffectsTools plays the tools on an explicit playbackSurface", async () => {
    const { c, id } = setup();
    const registry = new ToolRegistry();
    const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
    playback.install(registry);
    playback.attach("image4:surface", { presence: new PresenceStore(), locate: () => ({ x: 0, y: 0, width: 4, height: 4 }) });
    const steps = playback.record();
    render(ImageEffectsProbe, { registry, controller: c, options: { namespace: "imgfx", playbackSurface: "image4:surface" } });
    const r = await registry.callTool("imgfx__apply_effect", { target: id, effect: "fake.tint" });
    expect(r.isError).toBeFalsy();
    expect(steps.length).toBeGreaterThan(0);
    expect(new Set(steps.map((s) => s.surface))).toEqual(new Set(["image4:surface"]));
  });
});
