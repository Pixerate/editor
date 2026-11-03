import { describe, expect, it } from "vitest";
import { runPaintScript } from "./paintScriptHarness";

// The slowest script (about 27 s on CI), in a file of its own so it runs beside the others.
describe("paint agent scripts: watercolour", () => {
  it("paints a watercolour: wet-in-wet sky, blotted clouds, granulating hills, all dried", async () => {
    const controller = await runPaintScript("paint-watercolor");
    expect(controller.getState().wet.wet).toBe(false);
    expect(controller.getStrokes().map((s) => s.brush.id)).toEqual(["watercolor-wash", "watercolor-wash", "blot", "watercolor-wash"]);
    const sky = controller.listLayers().find((l) => l.name === "Sky wash")!;
    expect(sky.bounds).not.toBeNull();
    controller.dispose();
  }, 120_000);
});
