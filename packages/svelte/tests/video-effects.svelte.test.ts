import { describe, it, expect, afterEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { createFakeEffectProvider, type EffectProvider } from "@pixerate/editor/effects";
import { VideoEditorController, type VideoProject } from "@pixerate/editor/video-editor";
import { EffectParameters, EffectsBrowser } from "../src/effects";
import { VideoEditor, VideoEffectsPanel } from "../src/video-editor";
import EffectsProbe from "./fixtures/EffectsProbe.svelte";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

let target: HTMLElement;
function render(component: any, props: Record<string, any>) {
  target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  const cleanup = () => {
    unmount(instance);
    target.remove();
  };
  cleanups.push(cleanup);
  return { target, instance, cleanup };
}

const PROJECT: VideoProject = {
  version: 1,
  width: 64,
  height: 36,
  fps: 30,
  assets: [],
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        { id: "a", type: "color", color: "#000000", start: 0, duration: 1000 },
        { id: "b", type: "color", color: "#ffffff", start: 1000, duration: 1000 },
      ],
    },
  ],
};
const make = (effects?: EffectProvider) => new VideoEditorController({ project: PROJECT, clock: new ManualClock(), effects });
const q = <T extends Element = HTMLElement>(sel: string) => {
  const el = target.querySelector(sel) as T | null;
  if (!el) throw new Error(`No element for ${sel}`);
  return el;
};
const flush = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};
const click = async (el: Element) => {
  (el as HTMLElement).click();
  flushSync();
  await flush();
};
const button = (text: string) => {
  const b = [...target.querySelectorAll("button")].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`No button "${text}"`);
  return b;
};

describe("effects (Svelte)", () => {
  it("VideoEditor without a provider is as before: no effects panel, no provider", () => {
    const c = make();
    render(VideoEditor, { controller: c, showTranscript: false });
    expect(target.querySelector("[data-video-effects]")).toBeNull();
    expect(c.getState().effectsProvider).toBeNull();
  });

  it("VideoEditor registers the provider while mounted and shows the effects panel", () => {
    const c = make();
    const provider = createFakeEffectProvider();
    const { cleanup } = render(VideoEditor, { controller: c, effects: provider, showTranscript: false });
    expect(c.effectsProvider).toBe(provider);
    expect(target.querySelector("[data-video-effects]")).not.toBeNull();
    cleanup();
    cleanups = [];
    expect(c.effectsProvider).toBeNull();
  });

  it("useEffects and useVideoEffectsTools register while mounted", async () => {
    const c = make();
    const registry = new ToolRegistry();
    const provider = createFakeEffectProvider();
    const { cleanup } = render(EffectsProbe, { registry, controller: c, provider });
    expect(c.effectsProvider).toBe(provider);
    expect(registry.listTools().tools.map((t) => t.name)).toContain("fx__apply_effect");
    const r = await registry.callTool("fx__apply_effect", { target: "a", effect: "fake.invert" });
    expect(r.isError).toBeFalsy();
    cleanup();
    cleanups = [];
    expect(c.effectsProvider).toBeNull();
    expect(registry.listTools().tools).toEqual([]);
  });

  it("EffectsBrowser lists, filters and picks effects, and says when there is no provider", async () => {
    const onpick = vi.fn();
    render(EffectsBrowser, { provider: createFakeEffectProvider(), uses: ["filter", "overlay"], onpick, thumbnails: false });
    await flush();
    const ids = () => [...target.querySelectorAll("[data-effect-id]")].map((b) => b.getAttribute("data-effect-id"));
    expect(ids()).toEqual(["fake.invert", "fake.tint", "fake.bar"]);
    const search = q<HTMLInputElement>('input[type="search"]');
    search.value = "tint";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(ids()).toEqual(["fake.tint"]);
    await click(q('[data-effect-id="fake.tint"]'));
    expect(onpick).toHaveBeenCalledWith(expect.objectContaining({ id: "fake.tint" }));
    render(EffectsBrowser, { provider: null, onpick });
    expect(target.querySelector("[data-effects-unavailable]")?.textContent).toMatch(/No effects provider/);
  });

  it("EffectsBrowser leaves camera moves out unless asked for the camera use, and labels their thumbnails", async () => {
    const provider = createFakeEffectProvider({ camera: true });
    render(EffectsBrowser, { provider, onpick: vi.fn(), thumbnails: false });
    await flush();
    const ids = () => [...target.querySelectorAll("[data-effect-id]")].map((b) => b.getAttribute("data-effect-id"));
    expect(ids()).not.toContain("fake.glide");
    expect(ids()).toContain("fake.tint");
    render(EffectsBrowser, { provider, uses: ["camera"], onpick: vi.fn() });
    await flush();
    expect(ids()).toEqual(["fake.glide", "fake.whip", "fake.drift"]);
    expect(target.querySelector('[data-effect-thumbnail="fake.whip"]')?.textContent?.trim()).toBe("Camera");
  });

  it("EffectParameters builds controls from the JSON Schema and reports changes", async () => {
    const provider = createFakeEffectProvider();
    const onchange = vi.fn();
    render(EffectParameters, { description: await provider.describe("fake.crossfade"), values: { curve: "smooth" }, onchange });
    expect(q('[data-effect-control="curve"]')).toBeTruthy();
    await click([...target.querySelectorAll("[role=radiogroup] button")].find((b) => b.textContent?.trim().toLowerCase() === "linear")!);
    expect(onchange).toHaveBeenCalledWith("curve", "linear", null);
    render(EffectParameters, { description: await provider.describe("fake.tint"), values: { amount: { keys: [] } }, keyframed: new Set(["amount"]), onchange });
    expect(target.querySelectorAll("[data-effect-control]").length).toBe(2);
    expect(q('[data-effect-control="amount"]').textContent).toMatch(/keyframed/);
  });

  it("VideoEffectsPanel adds, turns off, reorders and removes clip effects as undo steps", async () => {
    const c = make(createFakeEffectProvider());
    c.select(["a"]);
    render(VideoEffectsPanel, { controller: c });
    await click(button("Add effect…"));
    await click(q('[data-effect-id="fake.tint"]'));
    expect(c.getProject().tracks[0].clips[0].effects?.map((e) => e.effect)).toEqual(["fake.tint"]);
    await click(button("Add effect…"));
    await click(q('[data-effect-id="fake.invert"]'));
    await click(target.querySelectorAll('[aria-label="Move up"]')[1]);
    expect(c.getProject().tracks[0].clips[0].effects?.map((e) => e.id)).toEqual(["fx2", "fx1"]);
    await click(q('[aria-label="Tint on"]'));
    expect(c.getProject().tracks[0].clips[0].effects?.[1].enabled).toBe(false);
    await click(q('[aria-label="Remove Invert"]'));
    expect(c.getProject().tracks[0].clips[0].effects?.map((e) => e.id)).toEqual(["fx1"]);
    expect(c.history.getState().undoName).toBe("Remove effect Invert");
  });

  it("VideoEffectsPanel sets effect transitions and adds effect clips at the playhead", async () => {
    const c = make(createFakeEffectProvider());
    c.select(["b"]);
    render(VideoEffectsPanel, { controller: c });
    await click(button("Effect transition…"));
    await click(q('[data-effect-id="fake.crossfade"]'));
    expect(c.getProject().tracks[0].clips[1].transition).toMatchObject({ type: "effect", effect: { effect: "fake.crossfade" } });
    c.seek(2000);
    flushSync();
    await click(button("Add effect clip"));
    await click(q('[data-effect-id="fake.gradient"]'));
    const added = c.getProject().tracks[0].clips[2];
    expect(added).toMatchObject({ type: "effect", effect: "fake.gradient", start: 2000 });
    expect(c.getState().selection).toEqual([added.id]);
  });
});
