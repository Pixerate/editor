import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@pixerate/editor/tools";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { createPaintEditorToolProvider, createPaintEffectsToolProvider, PaintEditorController } from "@pixerate/editor/paint-editor";
import { runAgentScript } from "./agentScript";
import { PAINT_SCRIPTS } from "./agentScripts";

// The Paint tab's scripts, replayed against the tab's canvas through the real tools.
function setup() {
  const controller = new PaintEditorController({ width: 1200, height: 800, paper: "cold-pressed" });
  // The tab's effects provider: the built-in test effects (Flair needs a page to render; its script is checked in the browser).
  controller.setEffectsProvider(createFakeEffectProvider());
  const registry = new ToolRegistry();
  registry.register(createPaintEditorToolProvider(controller, { id: "paint", namespace: "paint" }));
  registry.register(createPaintEffectsToolProvider(controller, { id: "paint-effects", namespace: "paintfx" }));
  return { controller, registry };
}

describe("paint agent scripts", () => {
  // Flair renders on a GPU canvas, which Node does not have: its script is left to the browser.
  it.each(PAINT_SCRIPTS.filter((s) => s.id !== "paint-effects-flair").map((s) => [s.id, s] as const))("%s runs to the end", async (_id, script) => {
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
    expect(strokes.map((s) => s.paint?.map.by)).toEqual(["distance", "distance", "across-tip", "pressure"]);
    expect(controller.getState().swatches.at(-1)!.name).toBe("Sunset");
  }, 120_000);

  it("draws with stencils, particle and bristle brushes and editable stickers", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, PAINT_SCRIPTS.find((s) => s.id === "paint-procedural")!, { control: { speed: Infinity, stopped: false } });
    const stars = controller.listLayers().find((l) => l.name === "Stars")!;
    expect(controller.listStickers(stars.id)[0].size).toBe(70);
    expect(controller.listStencils()).toHaveLength(0);
  }, 120_000);
});
