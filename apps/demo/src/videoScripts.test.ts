import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { createVideoEditorToolProvider, VideoEditorController, videoClipEnd } from "@pixerate/editor/video-editor";
import { runAgentScript } from "./agentScript";
import { VIDEO_SCRIPTS } from "./agentScripts";
import { sampleProject } from "./videoSample";

// The Video tab's scripts, replayed against the tab's sample project through the real tools.
function setup() {
  const controller = new VideoEditorController({ project: sampleProject(), clock: new ManualClock() });
  const registry = new ToolRegistry();
  registry.register(createVideoEditorToolProvider(controller, { id: "video", namespace: "video" }));
  return { controller, registry };
}

const clip = (c: VideoEditorController, id: string) => c.getProject().tracks.flatMap((t) => t.clips).find((x) => x.id === id);

describe("video agent scripts", () => {
  it.each(VIDEO_SCRIPTS.map((s) => [s.id, s] as const))("%s runs to the end", async (_id, script) => {
    const { controller, registry } = setup();
    const errors: string[] = [];
    const { ok } = await runAgentScript(registry, script, { control: { speed: Infinity, stopped: false }, onEvent: (e) => e.type === "error" && errors.push(e.message) });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(controller.getState().issues.filter((i) => i.severity === "error")).toEqual([]);
    controller.destroy();
  });

  it("tightens the cut: the forest shot moves up with its dip, music and markers follow", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, VIDEO_SCRIPTS.find((s) => s.id === "video-tighten")!, { control: { speed: Infinity, stopped: false } });
    expect(clip(controller, "shot-2")).toMatchObject({ start: 4000, duration: 2000 });
    expect(clip(controller, "shot-3")).toMatchObject({ start: 6000, transition: { type: "dip" } });
    expect(videoClipEnd(clip(controller, "score")!)).toBe(10000);
    expect(clip(controller, "end-card")).toMatchObject({ start: 8000, duration: 2000 });
    expect(controller.getProject().markers?.map((m) => [m.label, m.time])).toEqual([
      ["Ocean", 4000],
      ["Forest", 6000],
    ]);
    expect(controller.getState().duration).toBe(10000);
    controller.destroy();
  });

  it("reframes for 9:16 as one undo step for the clip changes", async () => {
    const { controller, registry } = setup();
    await runAgentScript(registry, VIDEO_SCRIPTS.find((s) => s.id === "video-vertical")!, { control: { speed: Infinity, stopped: false } });
    expect(controller.getProject()).toMatchObject({ width: 1080, height: 1920 });
    expect(clip(controller, "shot-1")?.fit).toBe("cover");
    expect(controller.frame(1000).layers.find((l) => l.clip === "shot-1")!.rect.height).toBeGreaterThanOrEqual(1920);
    controller.undo();
    expect(clip(controller, "shot-1")?.fit).toBeUndefined();
    expect(controller.getProject().width).toBe(1080);
    controller.destroy();
  });
});
