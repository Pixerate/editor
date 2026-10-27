import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { createVideoDialogueToolProvider, createVideoEditorToolProvider, createVideoEffectsToolProvider, createVideoMusicToolProvider, VideoEditorController, videoClipEnd } from "@pixerate/editor/video-editor";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { flairEffects } from "@pixerate/flair/integrations";
import { runAgentScript } from "./agentScript";
import { VIDEO_SCRIPTS } from "./agentScripts";
import { sampleProject } from "./videoSample";

// The Video tab's scripts, replayed against the tab's sample project through the real tools.
function setup(script?: string) {
  // The Flair turn names Flair's effect ids; the others use the built-in test effects.
  const effects = script === "video-effects-flair" ? flairEffects() : createFakeEffectProvider();
  const controller = new VideoEditorController({ project: sampleProject(), clock: new ManualClock(), effects });
  const registry = new ToolRegistry();
  registry.register(createVideoEditorToolProvider(controller, { id: "video", namespace: "video" }));
  registry.register(createVideoEffectsToolProvider(controller, { id: "video-effects", namespace: "videofx" }));
  registry.register(createVideoDialogueToolProvider(controller, { id: "video-dialogue", namespace: "videodialogue" }));
  registry.register(createVideoMusicToolProvider(controller, { id: "video-music", namespace: "videomusic" }));
  return { controller, registry };
}

const clip = (c: VideoEditorController, id: string) => c.getProject().tracks.flatMap((t) => t.clips).find((x) => x.id === id);

describe("video agent scripts", () => {
  it.each(VIDEO_SCRIPTS.map((s) => [s.id, s] as const))("%s runs to the end", async (id, script) => {
    const { controller, registry } = setup(id);
    const errors: string[] = [];
    const { ok } = await runAgentScript(registry, script, { control: { speed: Infinity, stopped: false }, onEvent: (e) => e.type === "error" && errors.push(e.message) });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(controller.getState().issues.filter((i) => i.severity === "error")).toEqual([]);
    controller.destroy();
  });

  it("the Flair turn applies Flair's film look, pixel dissolve and lens flare from the real catalog", async () => {
    const { controller, registry } = setup("video-effects-flair");
    const script = VIDEO_SCRIPTS.find((s) => s.id === "video-effects-flair")!;
    const { ok } = await runAgentScript(registry, script, { control: { speed: Infinity, stopped: false } });
    expect(ok).toBe(true);
    expect(clip(controller, "shot-1")?.effects?.[0]).toMatchObject({ effect: "film-look", provider: "flair", values: { uTint: "#ffd9a8", uGrain: 0.12 } });
    expect(clip(controller, "shot-2")?.transition).toMatchObject({ type: "effect", effect: { effect: "transition-pixel-dissolve", provider: "flair" } });
    expect(controller.getProject().tracks.find((t) => t.id === "titles")?.clips.some((c) => c.type === "effect" && c.effect === "lens-flare")).toBe(true);
    controller.destroy();
  });

  it("tints the sunrise with keyframes and swaps in the provider's crossfade", async () => {
    const { controller, registry } = setup();
    const script = VIDEO_SCRIPTS.find((s) => s.id === "video-effects")!;
    await runAgentScript(registry, script, { control: { speed: Infinity, stopped: false } });
    expect(clip(controller, "shot-1")?.effects?.[0]).toMatchObject({ effect: "fake.tint", values: { color: "#ff7a1a", amount: { keys: [{ t: 0, v: 0 }, { t: 2000, v: 0.35, ease: "ease-out" }] } } });
    expect(clip(controller, "shot-2")?.transition).toMatchObject({ type: "effect", duration: 800, effect: { effect: "fake.crossfade" } });
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
