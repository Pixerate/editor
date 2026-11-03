import { describe, expect, it } from "vitest";
import { runPaintScript } from "./paintScriptHarness";

describe("paint agent scripts: wet media", () => {
  it("blends and glazes: a watercolour glaze layer over a blended underpainting", async () => {
    const controller = await runPaintScript("paint-blend-glaze");
    const glaze = controller.listLayers().find((l) => l.name === "Glaze")!;
    expect(glaze).toMatchObject({ blend: "watercolor", opacity: 0.45 });
    expect(controller.getStrokes().map((s) => s.brush.id)).toEqual(["oil-pastel", "dirty-round", "blender", "multicolor-flat"]);
  }, 60_000);

  it("paints thick oil: a blended wet ground, tube petals dragged by the knife, a metallic centre", async () => {
    const controller = await runPaintScript("paint-impasto");
    expect(controller.getLighting().elevation).toBe(28);
    const flowers = controller.listLayers().find((l) => l.name === "Flowers")!;
    expect(controller.reliefOf(flowers.id)!.maxHeight).toBeGreaterThan(50);
    expect(controller.getState().wet.wet).toBe(false);
    controller.dispose();
  }, 120_000);

  it("paints a glowing watercolour wash whose light flows and dries into the layer", async () => {
    const controller = await runPaintScript("paint-glow-wash");
    const glow = controller.listLayers().find((l) => l.name === "Glow")!;
    expect(controller.getState().wet.wet).toBe(false);
    expect(controller.lightOf(glow.id).hasLight).toBe(true);
    expect(controller.getStrokes().filter((s) => s.brush.id === "glow-wash")).toHaveLength(2);
  }, 120_000);
});
