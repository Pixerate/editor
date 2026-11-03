import { describe, expect, it } from "vitest";
import { runPaintScript } from "./paintScriptHarness";

describe("paint agent scripts: light and glass", () => {
  it("paints glowing glass loops on dark paper, one per layer, with spill", async () => {
    const controller = await runPaintScript("paint-light");
    const loops = controller.listLayers().filter((l) => l.name.startsWith("Loop"));
    expect(loops).toHaveLength(2);
    for (const l of loops) expect(controller.lightOf(l.id).hasLight).toBe(true);
    expect(controller.lightOf(loops.find((l) => l.name === "Loop 2")!.id).spill).toEqual({ radius: 48, strength: 1.4 });
  }, 120_000);

  it("paints light ribbons, flames and bokeh on dark paper, each layer lighting its surroundings", async () => {
    const controller = await runPaintScript("paint-light-ribbons");
    const layers = controller.listLayers();
    for (const name of ["Ribbons", "Flames", "Bokeh"]) expect(controller.lightOf(layers.find((l) => l.name === name)!.id).hasLight, name).toBe(true);
    expect(controller.getStrokes().filter((s) => s.brush.id === "light-ribbon")).toHaveLength(2);
    expect(controller.getStrokes().find((s) => s.brush.id === "light-ribbon" && s.brush.particle.waveSpeed > 0)).toBeDefined();
    expect(controller.lightOf(layers.find((l) => l.name === "Bokeh")!.id).spill).toEqual({ radius: 40, strength: 1.2 });
  }, 120_000);

  it("paints a neon sign whose glow is a layer style, recoloured after painting", async () => {
    const controller = await runPaintScript("paint-neon-glow-style");
    const neon = controller.listLayers().find((l) => l.name === "Neon")!;
    const fx = controller.getLayerEffects(neon.id).items;
    expect(fx.map((e) => e.kind)).toEqual(["outer-glow", "inner-glow"]);
    expect(fx[0]).toMatchObject({ size: 64, blend: "linear-dodge", fill: { type: "color", color: "#22d3ee" } });
    expect(neon.effects).toBe(2);
  }, 120_000);

  it("paints stained glass on backlit paper: glazes and lead lines", async () => {
    const controller = await runPaintScript("paint-stained-glass");
    expect(controller.document.paper).toMatchObject({ preset: "stained-glass", backlight: 0.8 });
    expect(controller.listLayers().map((l) => l.name)).toEqual(expect.arrayContaining(["Glass", "Lead"]));
    expect(controller.exportPsd().warnings.some((w) => /Backlit paper/.test(w))).toBe(true);
  }, 120_000);
});
