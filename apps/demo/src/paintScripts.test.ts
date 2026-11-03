import { describe, expect, it } from "vitest";
import { CHECKED, NODE_SCRIPTS, runPaintScript } from "./paintScriptHarness";

// See paintScriptHarness.ts: the other scripts' tests are in the other `paintScripts*` files.
describe("paint agent scripts", () => {
  it.each(NODE_SCRIPTS.filter((s) => !CHECKED.includes(s.id)).map((s) => [s.id] as const))("%s runs to the end", async (id) => {
    await runPaintScript(id);
  }, 60_000);

  it("names only scripts that exist in its list of checked scripts", () => {
    expect(CHECKED.filter((id) => !NODE_SCRIPTS.some((s) => s.id === id))).toEqual([]);
  });

  it("paints with gradient paint: a sunset by distance, a rainbow across the tip, hills by pressure", async () => {
    const controller = await runPaintScript("paint-gradient");
    const strokes = controller.getStrokes();
    expect(strokes.map((s) => (s.paint?.type === "gradient" ? s.paint.map.by : undefined))).toEqual(["distance", "distance", "across-tip", "pressure"]);
    expect(controller.getState().swatches.at(-1)!.name).toBe("Sunset");
  }, 120_000);

  it("draws with stencils, particle and bristle brushes and editable stickers", async () => {
    const controller = await runPaintScript("paint-procedural");
    const stars = controller.listLayers().find((l) => l.name === "Stars")!;
    expect(controller.listStickers(stars.id)[0].size).toBe(70);
    expect(controller.listStencils()).toHaveLength(0);
  }, 120_000);

  it("paints a particle stroke on a stroke layer, then restyles and moves it", async () => {
    const controller = await runPaintScript("paint-stroke-layer");
    const wisps = controller.listLayers().find((l) => l.name === "Wisps")!;
    const [stroke] = controller.listLiveStrokes(wisps.id);
    expect(stroke).toMatchObject({ color: "#f59e0b" });
    expect(stroke.brush.id).toBe("orbit-curls");
    expect(stroke.brush.tip.size).toBe(40);
  }, 120_000);

  it("paints a live ribbon whose effect is laid along the stroke and plays", async () => {
    const controller = await runPaintScript("paint-live-effect");
    expect(controller.getAnimation()).toMatchObject({ strokes: 1, sources: 1 });
    expect(controller.getStrokes().at(-1)!.paint).toMatchObject({ type: "effect", live: true, map: { by: "stroke", length: 400 } });
    expect(controller.getState().effectPlayback).toMatchObject({ playing: true, fps: 24 });
  }, 120_000);

  it("sprays stickers from the host's library and places a tinted badge", async () => {
    const controller = await runPaintScript("paint-library-stickers");
    const layer = controller.listLayers().find((l) => l.name === "Weather")!;
    const refs = new Set(controller.listStickers(layer.id).map((s) => s.ref));
    expect([...refs].every((r) => r.startsWith("fake:weather-") || r === "fake:badge-new")).toBe(true);
    expect(refs.size).toBeGreaterThan(2);
    expect(controller.listStickers(layer.id).at(-1)).toMatchObject({ ref: "fake:badge-new", color: "#16a34a" });
  }, 120_000);
});
