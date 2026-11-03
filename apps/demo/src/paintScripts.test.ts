import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@pixerate/editor/tools";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { createPaintEditorToolProvider, createPaintEffectsToolProvider, PaintEditorController } from "@pixerate/editor/paint-editor";
import { combineStickerProviders, createFakeStickerProvider, editorStickers } from "@pixerate/editor/stickers";
import { runAgentScript } from "./agentScript";
import { PAINT_SCRIPTS } from "./agentScripts";

// The Paint tab's scripts, replayed against the tab's canvas through the real tools.
function setup() {
  const controller = new PaintEditorController({ width: 1200, height: 800, paper: "cold-pressed", stickers: combineStickerProviders([editorStickers(), createFakeStickerProvider()]) });
  // The tab's effects provider: the built-in test effects (Flair needs a page to render; its script is checked in the browser).
  controller.setEffectsProvider(createFakeEffectProvider());
  const registry = new ToolRegistry();
  registry.register(createPaintEditorToolProvider(controller, { id: "paint", namespace: "paint" }));
  registry.register(createPaintEffectsToolProvider(controller, { id: "paint-effects", namespace: "paintfx" }));
  return { controller, registry };
}

describe("paint agent scripts", () => {
  // Flair renders on a GPU canvas, which Node does not have: its script is left to the browser.
  it.each(PAINT_SCRIPTS.filter((s) => !s.id.endsWith("-flair")).map((s) => [s.id, s] as const))("%s runs to the end", async (_id, script) => {
    const { registry } = setup();
    const errors: string[] = [];
    const { ok } = await runAgentScript(registry, script, { control: { speed: Infinity, stopped: false }, onEvent: (e) => e.type === "error" && errors.push(e.message) });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  }, 60_000);

  it("blends and glazes: a watercolour glaze layer over a blended underpainting", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-blend-glaze")!, { control: { speed: Infinity, stopped: false } });
    const glaze = controller.listLayers().find((l) => l.name === "Glaze")!;
    expect(glaze).toMatchObject({ blend: "watercolor", opacity: 0.45 });
    expect(controller.getStrokes().map((s) => s.brush.id)).toEqual(["oil-pastel", "dirty-round", "blender", "multicolor-flat"]);
  }, 60_000);

  it("paints a watercolour: wet-in-wet sky, blotted clouds, granulating hills, all dried", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-watercolor")!, { control: { speed: Infinity, stopped: false } });
    expect(controller.getState().wet.wet).toBe(false);
    expect(controller.getStrokes().map((s) => s.brush.id)).toEqual(["watercolor-wash", "watercolor-wash", "blot", "watercolor-wash"]);
    const sky = controller.listLayers().find((l) => l.name === "Sky wash")!;
    expect(sky.bounds).not.toBeNull();
    controller.dispose();
  }, 120_000);

  it("paints thick oil: a blended wet ground, tube petals dragged by the knife, a metallic centre", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-impasto")!, { control: { speed: Infinity, stopped: false } });
    expect(controller.getLighting().elevation).toBe(28);
    const flowers = controller.listLayers().find((l) => l.name === "Flowers")!;
    expect(controller.reliefOf(flowers.id)!.maxHeight).toBeGreaterThan(50);
    expect(controller.getState().wet.wet).toBe(false);
    controller.dispose();
  }, 120_000);

  it("paints with gradient paint: a sunset by distance, a rainbow across the tip, hills by pressure", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-gradient")!, { control: { speed: Infinity, stopped: false } });
    const strokes = controller.getStrokes();
    expect(strokes.map((s) => (s.paint?.type === "gradient" ? s.paint.map.by : undefined))).toEqual(["distance", "distance", "across-tip", "pressure"]);
    expect(controller.getState().swatches.at(-1)!.name).toBe("Sunset");
  }, 120_000);

  it("draws with stencils, particle and bristle brushes and editable stickers", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-procedural")!, { control: { speed: Infinity, stopped: false } });
    const stars = controller.listLayers().find((l) => l.name === "Stars")!;
    expect(controller.listStickers(stars.id)[0].size).toBe(70);
    expect(controller.listStencils()).toHaveLength(0);
  }, 120_000);

  it("paints a particle stroke on a stroke layer, then restyles and moves it", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-stroke-layer")!, { control: { speed: Infinity, stopped: false } });
    const wisps = controller.listLayers().find((l) => l.name === "Wisps")!;
    const [stroke] = controller.listLiveStrokes(wisps.id);
    expect(stroke).toMatchObject({ color: "#f59e0b" });
    expect(stroke.brush.id).toBe("orbit-curls");
    expect(stroke.brush.tip.size).toBe(40);
  }, 120_000);

  it("paints a live ribbon whose effect is laid along the stroke and plays", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-live-effect")!, { control: { speed: Infinity, stopped: false } });
    expect(controller.getAnimation()).toMatchObject({ strokes: 1, sources: 1 });
    expect(controller.getStrokes().at(-1)!.paint).toMatchObject({ type: "effect", live: true, map: { by: "stroke", length: 400 } });
    expect(controller.getState().effectPlayback).toMatchObject({ playing: true, fps: 24 });
  }, 120_000);

  it("paints glowing glass loops on dark paper, one per layer, with spill", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-light")!, { control: { speed: Infinity, stopped: false } });
    const loops = controller.listLayers().filter((l) => l.name.startsWith("Loop"));
    expect(loops).toHaveLength(2);
    for (const l of loops) expect(controller.lightOf(l.id).hasLight).toBe(true);
    expect(controller.lightOf(loops.find((l) => l.name === "Loop 2")!.id).spill).toEqual({ radius: 48, strength: 1.4 });
  }, 120_000);

  it("paints a glowing watercolour wash whose light flows and dries into the layer", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-glow-wash")!, { control: { speed: Infinity, stopped: false } });
    const glow = controller.listLayers().find((l) => l.name === "Glow")!;
    expect(controller.getState().wet.wet).toBe(false);
    expect(controller.lightOf(glow.id).hasLight).toBe(true);
    expect(controller.getStrokes().filter((s) => s.brush.id === "glow-wash")).toHaveLength(2);
  }, 120_000);

  it("paints light ribbons, flames and bokeh on dark paper, each layer lighting its surroundings", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-light-ribbons")!, { control: { speed: Infinity, stopped: false } });
    const layers = controller.listLayers();
    for (const name of ["Ribbons", "Flames", "Bokeh"]) expect(controller.lightOf(layers.find((l) => l.name === name)!.id).hasLight, name).toBe(true);
    expect(controller.getStrokes().filter((s) => s.brush.id === "light-ribbon")).toHaveLength(2);
    expect(controller.getStrokes().find((s) => s.brush.id === "light-ribbon" && s.brush.particle.waveSpeed > 0)).toBeDefined();
    expect(controller.lightOf(layers.find((l) => l.name === "Bokeh")!.id).spill).toEqual({ radius: 40, strength: 1.2 });
  }, 120_000);

  it("paints a neon sign whose glow is a layer style, recoloured after painting", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-neon-glow-style")!, { control: { speed: Infinity, stopped: false } });
    const neon = controller.listLayers().find((l) => l.name === "Neon")!;
    const fx = controller.getLayerEffects(neon.id).items;
    expect(fx.map((e) => e.kind)).toEqual(["outer-glow", "inner-glow"]);
    expect(fx[0]).toMatchObject({ size: 64, blend: "linear-dodge", fill: { type: "color", color: "#22d3ee" } });
    expect(neon.effects).toBe(2);
  }, 120_000);

  it("sprays stickers from the host's library and places a tinted badge", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-library-stickers")!, { control: { speed: Infinity, stopped: false } });
    const layer = controller.listLayers().find((l) => l.name === "Weather")!;
    const refs = new Set(controller.listStickers(layer.id).map((s) => s.ref));
    expect([...refs].every((r) => r.startsWith("fake:weather-") || r === "fake:badge-new")).toBe(true);
    expect(refs.size).toBeGreaterThan(2);
    expect(controller.listStickers(layer.id).at(-1)).toMatchObject({ ref: "fake:badge-new", color: "#16a34a" });
  }, 120_000);

  it("paints stained glass on backlit paper: glazes and lead lines", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-stained-glass")!, { control: { speed: Infinity, stopped: false } });
    expect(controller.document.paper).toMatchObject({ preset: "stained-glass", backlight: 0.8 });
    expect(controller.listLayers().map((l) => l.name)).toEqual(expect.arrayContaining(["Glass", "Lead"]));
    expect(controller.exportPsd().warnings.some((w) => /Backlit paper/.test(w))).toBe(true);
  }, 120_000);
});
