import { describe, it, expect, afterEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { VideoEditorController, VideoFrameCache, buildVideoAudioPeaks, findVideoClip, type VideoProject } from "@pixerate/editor/video-editor";
import { ClipInspector, MediaBin, TranscriptPanel, VideoEditor, VideoPreview, VideoScopes, VideoTimeline, VideoTransport, createVideoEditor } from "../src/video-editor";
import ToolsProbe from "./fixtures/VideoToolsProbe.svelte";

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
  name: "demo",
  width: 1920,
  height: 1080,
  fps: 30,
  assets: [{ id: "clip", kind: "video", src: "clip.mp4", name: "Clip", duration: 10000 }],
  tracks: [
    {
      id: "v1",
      kind: "video",
      name: "Video 1",
      clips: [
        { id: "c1", type: "media", asset: "clip", start: 0, duration: 2000 },
        { id: "c2", type: "text", text: "Hello", start: 2000, duration: 2000, transition: { type: "dip", duration: 400 } },
      ],
    },
    { id: "a1", kind: "audio", name: "Audio 1", clips: [] },
  ],
  markers: [{ id: "m1", time: 1000, label: "Beat" }],
};

const make = () => new VideoEditorController({ project: PROJECT, clock: new ManualClock() });
const q = <T extends Element = HTMLElement>(sel: string) => target.querySelector(sel) as T;
const qa = (sel: string) => [...target.querySelectorAll(sel)] as HTMLElement[];
const act = (fn: () => void) => {
  fn();
  flushSync();
};
const Pointer = ((globalThis as any).PointerEvent ?? MouseEvent) as typeof MouseEvent;
function pointer(el: EventTarget, type: string, init: MouseEventInit = {}) {
  act(() => el.dispatchEvent(new Pointer(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, ...init })));
}
/** Sets a value and fires `change` (what a select or a committed input does). */
function change(el: HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const clipOf = (c: VideoEditorController, id: string) => findVideoClip(c.getState().project, id)?.clip;
const ids = (c: VideoEditorController, track = "v1") => c.getState().project.tracks.find((t) => t.id === track)!.clips.map((x) => x.id);

describe("createVideoEditor (Svelte)", () => {
  it("exposes reactive state and bound actions", () => {
    const editor = createVideoEditor({ project: PROJECT, clock: new ManualClock() });
    expect(editor.state.duration).toBe(4000);
    editor.controller.apply({ op: "move_clip", clip: "c2", start: 5000 });
    expect(editor.state.duration).toBe(7000);
    editor.seek(1000);
    expect(editor.state.time).toBe(1000);
    editor.step(3);
    expect(editor.state.time).toBe(1100);
    expect(editor.splitAtPlayhead().ok).toBe(true);
    expect(editor.state.project.tracks[0].clips).toHaveLength(3);
    editor.undo();
    expect(editor.state.project.tracks[0].clips).toHaveLength(2);
    editor.redo();
    editor.controller.select(["c2"]);
    expect(editor.deleteSelection({ ripple: false }).ok).toBe(true);
    expect(editor.state.duration).toBe(2000);
    editor.destroy();
  });

  it("registers agent tools while mounted", async () => {
    const registry = new ToolRegistry();
    const controller = make();
    const { cleanup } = render(ToolsProbe, { registry, controller });
    expect(registry.listTools().tools.map((t) => t.name)).toContain("video__add_video_clip");
    const result = await registry.callTool("video__delete_video_clips", { clips: ["c2"] });
    expect(result.isError).toBeFalsy();
    expect(ids(controller)).toEqual(["c1"]);
    cleanup();
    cleanups.pop();
    expect(registry.listTools().tools).toEqual([]);
    controller.destroy();
  });
});

describe("VideoTransport (Svelte)", () => {
  it("plays, steps, splits, deletes and undoes", () => {
    const controller = make();
    render(VideoTransport, { controller });
    expect(q("[data-timecode]").textContent).toBe("00:00:00:00 / 00:00:04:00");
    expect(q<HTMLButtonElement>("[data-undo]").disabled).toBe(true);
    expect(q<HTMLButtonElement>("[data-delete]").disabled).toBe(true);
    act(() => q<HTMLButtonElement>("[data-step-forward]").click());
    expect(controller.getState().time).toBeCloseTo(1000 / 30);
    act(() => q<HTMLButtonElement>("[data-play]").click());
    expect(controller.getState().playing).toBe(true);
    expect(q("[data-play]").getAttribute("aria-label")).toBe("Pause");
    act(() => q<HTMLButtonElement>("[data-play]").click());

    act(() => controller.seek(1000));
    act(() => q<HTMLButtonElement>("[data-split]").click());
    expect(ids(controller)).toHaveLength(3);
    act(() => controller.select(["c2"]));
    act(() => q<HTMLButtonElement>("[data-ripple-delete]").click());
    expect(ids(controller)).not.toContain("c2");
    act(() => q<HTMLButtonElement>("[data-undo]").click());
    expect(ids(controller)).toContain("c2");
    act(() => q<HTMLButtonElement>("[data-undo]").click());
    expect(ids(controller)).toEqual(["c1", "c2"]);
    act(() => q<HTMLButtonElement>("[data-redo]").click());
    expect(ids(controller)).toHaveLength(3);

    act(() => controller.setReadOnly(true));
    expect(q<HTMLButtonElement>("[data-split]").disabled).toBe(true);
    controller.destroy();
  });
});

describe("VideoTimeline (Svelte)", () => {
  it("draws waveforms in audio clips once their sound has loaded", async () => {
    const loads: string[] = [];
    const controller = new VideoEditorController({
      project: {
        ...PROJECT,
        assets: [...PROJECT.assets, { id: "music", kind: "audio", src: "music.mp3", duration: 20000 }],
        tracks: [PROJECT.tracks[0], { id: "a1", kind: "audio", clips: [{ id: "m1", type: "media", asset: "music", start: 0, duration: 4000 }] }],
      },
      clock: new ManualClock(),
      audioPeaks: async (asset) => {
        loads.push(asset.id);
        return buildVideoAudioPeaks([Float32Array.from({ length: 8000 * 20 }, (_, i) => 0.5 * Math.sin(i / 3))], 8000);
      },
    });
    render(VideoTimeline, { controller, pxPerSecond: 100 });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(q('[data-waveform="m1"] path').getAttribute("d")).toMatch(/^M1\.0 /);
    expect(q('[data-waveform="c1"]')).toBeNull();
    expect(loads).toEqual(["music"]);
    controller.destroy();
  });

  it("draws no waveforms when asked not to", async () => {
    const controller = new VideoEditorController({
      project: { ...PROJECT, assets: [...PROJECT.assets, { id: "music", kind: "audio", src: "music.mp3", duration: 20000 }], tracks: [PROJECT.tracks[0], { id: "a1", kind: "audio", clips: [{ id: "m1", type: "media", asset: "music", start: 0, duration: 4000 }] }] },
      clock: new ManualClock(),
      audioPeaks: async () => buildVideoAudioPeaks([new Float32Array(8000).fill(0.5)], 8000),
    });
    render(VideoTimeline, { controller, pxPerSecond: 100, waveforms: "none" });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(q("[data-waveform]")).toBeNull();
    controller.destroy();
  });


  it("draws a block per clip at its place, markers and the playhead", () => {
    const controller = make();
    render(VideoTimeline, { controller, pxPerSecond: 100 });
    const blocks = qa("[data-clip]");
    expect(blocks.map((b) => b.dataset.clip)).toEqual(["c1", "c2"]);
    expect([blocks[0].style.left, blocks[0].style.width]).toEqual(["0px", "200px"]);
    expect([blocks[1].style.left, blocks[1].style.width]).toEqual(["200px", "200px"]);
    expect(blocks[0].textContent).toContain("Clip");
    expect(blocks[1].textContent).toContain("Hello");
    expect(q('[data-clip="c2"] [data-transition]').dataset.transition).toBe("dip");
    expect(q('[data-clip="c1"] [data-transition]')).toBeNull();
    expect(q('[data-marker="m1"]').style.left).toBe("100px");
    expect(qa("[data-track]").map((t) => t.dataset.track)).toEqual(["v1", "a1"]);
    act(() => controller.seek(1500));
    expect(q("[data-playhead]").style.left).toBe(`${144 + 150}px`);
    act(() => q<HTMLButtonElement>('button[aria-label="Zoom in"]').click());
    expect(q('[data-clip="c2"]').style.left).toBe("250px");
    controller.destroy();
  });

  it("selects on click and adds with shift-click", () => {
    const controller = make();
    render(VideoTimeline, { controller });
    pointer(q('[data-clip="c1"]'), "pointerdown", { clientX: 50 });
    pointer(window, "pointerup", { clientX: 50 });
    expect(controller.getState().selection).toEqual(["c1"]);
    expect(q('[data-clip="c1"]').hasAttribute("data-selected")).toBe(true);
    pointer(q('[data-clip="c2"]'), "pointerdown", { clientX: 250, shiftKey: true });
    pointer(window, "pointerup", { clientX: 250, shiftKey: true });
    expect(controller.getState().selection).toEqual(["c1", "c2"]);
    pointer(q('[data-clip="c2"]'), "pointerdown", { clientX: 250, metaKey: true });
    pointer(window, "pointerup", { clientX: 250 });
    expect(controller.getState().selection).toEqual(["c1"]);
    expect(controller.getState().canUndo).toBe(false);
    controller.destroy();
  });

  it("moves a clip by dragging its body, as one undo step", () => {
    const controller = make();
    render(VideoTimeline, { controller, pxPerSecond: 100 });
    pointer(q('[data-clip="c2"]'), "pointerdown", { clientX: 250 });
    pointer(window, "pointermove", { clientX: 350 });
    pointer(window, "pointermove", { clientX: 450 });
    expect(q('[data-clip="c2"]').style.left).toBe("400px");
    expect(q('[data-clip="c2"]').hasAttribute("data-dragging")).toBe(true);
    expect(clipOf(controller, "c2")!.start).toBe(2000);
    pointer(window, "pointerup", { clientX: 450 });
    expect(clipOf(controller, "c2")!.start).toBe(4000);
    expect(controller.getState().undoLabel).toBe("Move clip");
    expect(q('[data-clip="c2"]').hasAttribute("data-dragging")).toBe(false);
    controller.undo();
    expect(clipOf(controller, "c2")!.start).toBe(2000);
    controller.destroy();
  });

  it("drags a clip in with alt (insert) or over with shift (overwrite)", () => {
    const controller = make();
    render(VideoTimeline, { controller, pxPerSecond: 100 });
    // Shift (held once the drag is going; at pointer-down it adds to the selection).
    pointer(q('[data-clip="c2"]'), "pointerdown", { clientX: 250 });
    pointer(window, "pointermove", { clientX: 150, shiftKey: true });
    pointer(window, "pointerup", { clientX: 150, shiftKey: true });
    expect(clipOf(controller, "c1")).toMatchObject({ start: 0, duration: 1000 });
    expect(clipOf(controller, "c2")!.start).toBe(1000);
    expect(controller.getState().undoLabel).toBe("Overwrite clip");
    controller.undo();
    pointer(q('[data-clip="c2"]'), "pointerdown", { clientX: 250 });
    pointer(window, "pointermove", { clientX: 150, altKey: true });
    pointer(window, "pointerup", { clientX: 150, altKey: true });
    expect(controller.getState().undoLabel).toBe("Insert clip");
    expect(ids(controller)).toEqual(["c1", "c2", "c1-1"]);
    expect(clipOf(controller, "c1-1")).toMatchObject({ start: 3000, duration: 1000 });
    controller.destroy();
  });

  it("trims a clip by dragging an edge, and shows a refused edit", () => {
    const controller = make();
    render(VideoTimeline, { controller, pxPerSecond: 100 });
    pointer(q('[data-clip="c1"] [data-edge="end"]'), "pointerdown", { clientX: 200 });
    pointer(window, "pointermove", { clientX: 150 });
    expect(q('[data-clip="c1"]').style.width).toBe("150px");
    pointer(window, "pointerup", { clientX: 150 });
    expect(clipOf(controller, "c1")).toMatchObject({ start: 0, duration: 1500 });
    expect(controller.getState().undoLabel).toBe("Trim clip");

    // Dragging c1 onto c2 is refused when released, with the reason shown.
    pointer(q('[data-clip="c1"]'), "pointerdown", { clientX: 50 });
    pointer(window, "pointermove", { clientX: 150 });
    pointer(window, "pointerup", { clientX: 150 });
    expect(clipOf(controller, "c1")!.start).toBe(0);
    expect(q("[data-edit-error]").textContent).toMatch(/overlap/);
    controller.destroy();
  });

  it("toggles a track's mute, visibility and lock", () => {
    const controller = make();
    render(VideoTimeline, { controller });
    act(() => q<HTMLButtonElement>('[data-track="v1"] [data-toggle="muted"]').click());
    expect(controller.getState().project.tracks[0].muted).toBe(true);
    expect(q('[data-track="v1"] [data-toggle="muted"]').getAttribute("aria-pressed")).toBe("true");
    expect(controller.getState().undoLabel).toBe("Mute track");
    expect(q('[data-track="a1"] [data-toggle="hidden"]')).toBeNull();
    act(() => q<HTMLButtonElement>('[data-track="v1"] [data-toggle="locked"]').click());
    expect(controller.getState().project.tracks[0].locked).toBe(true);
    expect(q('[data-clip="c1"] [data-edge]')).toBeNull();
    // A locked track's clips select but do not drag.
    pointer(q('[data-clip="c2"]'), "pointerdown", { clientX: 250 });
    pointer(window, "pointermove", { clientX: 450 });
    pointer(window, "pointerup", { clientX: 450 });
    expect(clipOf(controller, "c2")!.start).toBe(2000);
    expect(controller.getState().selection).toEqual(["c2"]);
    controller.destroy();
  });

  it("handles the edit keys", () => {
    const controller = make();
    render(VideoTimeline, { controller });
    const key = (k: string, init: KeyboardEventInit = {}) => act(() => q("[data-video-timeline]").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init })));
    key("ArrowRight");
    key("ArrowRight");
    expect(controller.getState().time).toBeCloseTo(2000 / 30);
    act(() => controller.seek(1000));
    key("s");
    expect(ids(controller)).toHaveLength(3);
    act(() => controller.select(["c2"]));
    key("Backspace", { shiftKey: true });
    expect(ids(controller)).not.toContain("c2");
    expect(controller.getState().undoLabel).toBe("Ripple delete");
    key("z", { metaKey: true });
    expect(ids(controller)).toContain("c2");
    key("z", { metaKey: true, shiftKey: true });
    expect(ids(controller)).not.toContain("c2");
    key(" ");
    expect(controller.getState().playing).toBe(true);
    controller.destroy();
  });
});

describe("compound clips (Svelte)", () => {
  it("shows a compound clip with its sequence on the timeline and in the inspector, and mutes it", () => {
    const project: VideoProject = {
      ...PROJECT,
      sequences: [{ id: "seq", name: "Opening", tracks: [{ id: "sv", kind: "video", clips: [{ id: "inside", type: "color", color: "#ff0000", start: 0, duration: 3000 }] }] }],
      tracks: [{ id: "v0", kind: "video", clips: [{ id: "comp", type: "sequence", sequence: "seq", in: 500, start: 0, duration: 2000 }] }, ...PROJECT.tracks],
    };
    const controller = new VideoEditorController({ project, clock: new ManualClock() });
    render(VideoTimeline, { controller });
    const block = q('[data-clip="comp"]');
    expect(block.dataset.compound).toBe("seq");
    expect(block.textContent).toContain("Compound: Opening");
    render(ClipInspector, { controller });
    act(() => controller.select(["comp"]));
    expect(q('[data-field="sequence"]').textContent).toContain("Opening · from 0.50 s");
    expect(q('input[aria-label="Speed"]')).toBeNull();
    act(() => q<HTMLInputElement>('input[aria-label="Muted"]').click());
    expect((clipOf(controller, "comp") as any).muted).toBe(true);
    controller.destroy();
  });
});

describe("ClipInspector (Svelte)", () => {
  it("edits the selected clip, one undo step per change", () => {
    const controller = make();
    render(ClipInspector, { controller });
    expect(q("[data-inspector-hint]").textContent).toMatch(/Select a clip/);
    act(() => controller.select(["c1"]));
    expect(q('[data-field="volume"]')).not.toBeNull();
    change(q<HTMLInputElement>('[data-field="opacity"]'), "0.5");
    expect(clipOf(controller, "c1")!.opacity).toBe(0.5);
    expect(controller.getState().undoLabel).toBe("Change opacity");
    change(q<HTMLInputElement>('[data-field="opacity"]'), "3");
    expect(q("[data-edit-error]").textContent).toMatch(/between 0 and 1/);
    expect(clipOf(controller, "c1")!.opacity).toBe(0.5);
    controller.undo();
    expect(clipOf(controller, "c1")!.opacity).toBeUndefined();
    expect(controller.getState().canUndo).toBe(false);

    act(() => controller.select(["c2"]));
    change(q<HTMLTextAreaElement>('[data-field="text"]'), "Hi there");
    expect(clipOf(controller, "c2")).toMatchObject({ text: "Hi there" });
    change(q<HTMLSelectElement>('[data-field="transition"]'), "crossfade");
    expect(clipOf(controller, "c2")!.transition).toEqual({ type: "crossfade", duration: 400 });
    change(q<HTMLSelectElement>('[data-field="transition"]'), "");
    expect(clipOf(controller, "c2")!.transition).toBeUndefined();
    controller.destroy();
  });

  it("grades a picture: a look, then single settings", () => {
    const controller = make();
    render(ClipInspector, { controller });
    act(() => controller.select(["c1"]));
    change(q<HTMLSelectElement>('[data-field="gradePreset"]'), "cool");
    expect(clipOf(controller, "c1")!.grade).toEqual({ temperature: -0.4, tint: -0.05 });
    change(q<HTMLInputElement>('[data-field="grade.hue"]'), "-500");
    expect(clipOf(controller, "c1")!.grade).toEqual({ hue: -180, temperature: -0.4, tint: -0.05 });
    // Clearing a setting removes it.
    change(q<HTMLInputElement>('[data-field="grade.hue"]'), "");
    expect(clipOf(controller, "c1")!.grade).toEqual({ temperature: -0.4, tint: -0.05 });
    controller.destroy();
  });

  it("sets a picture's blend mode", () => {
    const controller = make();
    render(ClipInspector, { controller });
    act(() => controller.select(["c1"]));
    change(q<HTMLSelectElement>('[data-field="blend"]'), "multiply");
    expect(clipOf(controller, "c1")!.blend).toBe("multiply");
    change(q<HTMLSelectElement>('[data-field="blend"]'), "normal");
    expect(clipOf(controller, "c1")!.blend).toBeUndefined();
    controller.destroy();
  });

  it("animates a title in and out", () => {
    const controller = make();
    render(ClipInspector, { controller });
    act(() => controller.select(["c2"]));
    change(q<HTMLSelectElement>('[data-field="animateOut"]'), "drop");
    expect(clipOf(controller, "c2")!.animateOut).toEqual({ effect: "drop" });
    change(q<HTMLSelectElement>('[data-field="animateOut"]'), "");
    expect(clipOf(controller, "c2")!.animateOut).toBeUndefined();
    controller.destroy();
  });

  it("freezes a frame at the playhead and takes the ramp off", () => {
    const controller = make();
    render(ClipInspector, { controller });
    act(() => controller.select(["c1"]));
    act(() => controller.seek(1000));
    act(() => q<HTMLButtonElement>('[data-action="freeze"]').click());
    expect(clipOf(controller, "c1")!.duration).toBe(3000);
    expect(q("[data-ramped]")).not.toBeNull();
    act(() => qa("button").find((b) => b.textContent === "Remove ramp")!.click());
    expect((clipOf(controller, "c1") as any).timeRemap).toBeUndefined();
    act(() => q<HTMLButtonElement>('[data-action="slow-mo"]').click());
    expect((clipOf(controller, "c1") as any).timeRemap).toBeDefined();
    controller.destroy();
  });

  it("offers a direction for push, slide and wipe only", () => {
    const controller = make();
    render(ClipInspector, { controller });
    act(() => controller.select(["c2"]));
    expect(document.querySelector('[data-field="transitionDirection"]')).toBeNull();
    change(q<HTMLSelectElement>('[data-field="transition"]'), "slide");
    change(q<HTMLSelectElement>('[data-field="transitionDirection"]'), "left");
    expect(clipOf(controller, "c2")!.transition).toEqual({ type: "slide", duration: 400, direction: "left" });
    controller.destroy();
  });

  it("shapes a transition's sound, storing only a change from the type's default", () => {
    const controller = make();
    render(ClipInspector, { controller });
    act(() => controller.select(["c2"]));
    expect(q<HTMLSelectElement>('[data-field="transitionAudioCurve"]').value).toBe("linear");
    change(q<HTMLSelectElement>('[data-field="transitionAudioCurve"]'), "s-curve");
    expect(clipOf(controller, "c2")!.transition).toEqual({ type: "dip", duration: 400, audioCurve: "s-curve" });
    change(q<HTMLSelectElement>('[data-field="transitionAudioCurve"]'), "linear");
    expect(clipOf(controller, "c2")!.transition).toEqual({ type: "dip", duration: 400 });
    controller.destroy();
  });

  it("shapes a media clip's sound fades once it has them", () => {
    const controller = make();
    render(ClipInspector, { controller });
    act(() => controller.select(["c1"]));
    expect(document.querySelector('[data-field="fadeOutCurve"]')).toBeNull();
    change(q<HTMLInputElement>('[data-field="fadeOut"]'), "800");
    expect(q<HTMLSelectElement>('[data-field="fadeOutCurve"]').value).toBe("linear");
    change(q<HTMLSelectElement>('[data-field="fadeOutCurve"]'), "exponential");
    expect((clipOf(controller, "c1") as any).fadeOutCurve).toBe("exponential");
    expect(controller.getState().undoLabel).toBe("Change fade out curve");
    change(q<HTMLSelectElement>('[data-field="fadeOutCurve"]'), "linear");
    expect((clipOf(controller, "c1") as any).fadeOutCurve).toBeUndefined();
    controller.destroy();
  });
});

describe("ClipInspector keyframes (Svelte)", () => {
  it("adds keys at the playhead, sets the key there by typing, and removes them", () => {
    const controller = make();
    render(ClipInspector, { controller });
    act(() => controller.select(["c2"]));
    expect(qa("[data-keyframe-row]").map((r) => r.dataset.keyframeRow)).toEqual(["opacity", "x", "y", "scale", "rotation"]);
    act(() => controller.seek(2500));
    act(() => q<HTMLButtonElement>('[data-keyframe-toggle="opacity"]').click());
    expect(clipOf(controller, "c2")!.opacity).toEqual({ keys: [{ t: 500, v: 1 }] });
    expect(controller.getState().undoLabel).toBe("Add opacity keyframe");
    act(() => controller.seek(3500));
    change(q<HTMLInputElement>('[data-field="opacity"]'), "0");
    expect(clipOf(controller, "c2")!.opacity).toEqual({ keys: [{ t: 500, v: 1 }, { t: 1500, v: 0 }] });
    expect(controller.getState().undoLabel).toBe("Keyframe opacity");
    act(() => controller.seek(3000));
    expect(q<HTMLInputElement>('[data-field="opacity"]').value).toBe("0.5");
    expect(q('[data-keyframe-toggle="opacity"]').getAttribute("aria-pressed")).toBe("false");
    change(q<HTMLInputElement>('[data-field="opacity"]'), "2");
    expect(q("[data-edit-error]").textContent).toMatch(/between 0 and 1/);
    act(() => controller.seek(2500));
    act(() => q<HTMLButtonElement>('[data-keyframe-toggle="opacity"]').click());
    expect(clipOf(controller, "c2")!.opacity).toEqual({ keys: [{ t: 1500, v: 0 }] });
    controller.destroy();
  });
});

describe("MediaBin (Svelte)", () => {
  it("adds an asset to the timeline and selects the new clip", () => {
    const controller = make();
    render(MediaBin, { controller });
    expect(qa("[data-asset]").map((a) => a.dataset.asset)).toEqual(["clip"]);
    act(() => q<HTMLButtonElement>("[data-add-to-timeline]").click());
    const added = ids(controller).filter((id) => id !== "c1" && id !== "c2");
    expect(added).toHaveLength(1);
    expect(clipOf(controller, added[0])).toMatchObject({ type: "media", asset: "clip", start: 4000, duration: 10000 });
    expect(controller.getState().selection).toEqual(added);
    controller.destroy();
  });
});

describe("VideoPreview (Svelte)", () => {
  it("draws on a canvas and stops when unmounted", () => {
    const controller = make();
    controller.seek(3000);
    let calls = 0;
    const context = new Proxy({} as Record<string, unknown>, {
      get: (obj, prop) => (prop in obj ? obj[prop as string] : () => void calls++),
      set: (obj, prop, value) => {
        obj[prop as string] = value;
        return true;
      },
    });
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => context) as any;
    try {
      const { cleanup } = render(VideoPreview, { controller, resolution: 0.25 });
      const canvas = q<HTMLCanvasElement>("canvas[data-video-preview]");
      expect(canvas.style.aspectRatio).toBe("1920 / 1080");
      expect([canvas.width, canvas.height]).toEqual([480, 270]);
      expect(calls).toBeGreaterThan(0);
      const before = calls;
      controller.seek(3500);
      expect(calls).toBeGreaterThan(before);
      cleanup();
      cleanups.pop();
      const after = calls;
      controller.seek(1000);
      expect(calls).toBe(after);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
    controller.destroy();
  });
});

describe("VideoEditor (Svelte)", () => {
  it("composes the panels and creates its own controller from options", () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => null) as any;
    try {
      render(VideoEditor, { options: { project: PROJECT, clock: new ManualClock() } });
      for (const part of ["media-bin", "video-preview", "video-transport", "video-timeline", "clip-inspector"]) expect(q(`[data-${part}]`)).not.toBeNull();
      expect(qa("[data-video-timeline] [data-clip]")).toHaveLength(2);
      render(VideoEditor, { controller: make(), editable: false });
      expect(q("[data-media-bin]")).toBeNull();
      expect(q("[data-split]")).toBeNull();
      expect(q("[data-video-timeline] [data-edge]")).toBeNull();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});

describe("TranscriptPanel (Svelte)", () => {
  it("seeks to a word and cuts a shift-selected run and the fillers", () => {
    const controller = new VideoEditorController({
      clock: new ManualClock(),
      project: {
        version: 1, width: 640, height: 360, fps: 25,
        assets: [{ id: "talk", kind: "audio", src: "talk.wav", duration: 4000, transcript: [
  { word: "So", start: 0, end: 300 },
  { word: "um", start: 400, end: 700 },
  { word: "I", start: 800, end: 900 },
  { word: "think", start: 900, end: 1200 },
  { word: "we", start: 2500, end: 2700 },
  { word: "ship", start: 2700, end: 3000 },
] }],
        tracks: [{ id: "a1", kind: "audio", clips: [{ id: "t", type: "media", asset: "talk", start: 0, duration: 4000 }] }],
      },
    });
    render(TranscriptPanel, { controller });
    const words = () => qa("[data-word]").map((w) => w.textContent);
    expect(words()).toEqual(["So", "um", "I", "think", "we", "ship"]);
    act(() => q<HTMLElement>('[data-word="2"]').click());
    expect(controller.getState().time).toBe(800);
    act(() => void q<HTMLElement>('[data-word="3"]').dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    act(() => qa("button").find((b) => b.textContent === "Delete selected words")!.click());
    expect(words()).toEqual(["So", "um", "we", "ship"]);
    act(() => qa("button").find((b) => b.textContent === "Remove fillers")!.click());
    expect(words()).toEqual(["So", "we", "ship"]);
    expect(controller.getState().undoLabel).toBe("Remove fillers");
    controller.destroy();
  });
});

describe("VideoScopes (Svelte)", () => {
  const pixels = (rgb: [number, number, number], w = 8, h = 8) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
    return { width: w, height: h, data };
  };
  const tick = async () => {
    await new Promise((r) => setTimeout(r, 40));
    flushSync();
  };

  it("says to show the preview until one draws, then shows scopes and figures for each frame", async () => {
    const controller = make();
    const put = vi.fn();
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({ putImageData: put })) as any;
    (globalThis as any).ImageData ??= class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    };
    try {
      render(VideoScopes, { controller, scopes: ["waveform", "vectorscope"], width: 64, height: 32 });
      await tick();
      expect(q("[data-scope-message]").textContent).toBe("Show the preview to see its scopes.");
      expect(qa("canvas").map((c) => [c.dataset.scope, (c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height])).toEqual([
        ["waveform", 64, 32],
        ["vectorscope", 32, 32],
      ]);
      let colour: [number, number, number] = [0, 0, 0];
      const detach = controller.previewPixels.attach(() => ({ time: 0, complete: true, pixels: pixels(colour) }));
      controller.previewPixels.drawn(0, true);
      await tick();
      expect(q("[data-scope-stats]").textContent).toMatch(/crushed 100%/);
      expect(put).toHaveBeenCalledTimes(2);
      colour = [255, 255, 255];
      controller.previewPixels.drawn(0, true);
      await tick();
      expect(q("[data-scope-stats]").textContent).toMatch(/blown 100%/);
      detach();
      await tick();
      expect(q("[data-scope-message]").textContent).toBe("Show the preview to see its scopes.");
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
    controller.destroy();
  });

  it("shows under the preview in <VideoEditor showScopes>", () => {
    const controller = make();
    render(VideoEditor, { controller, showScopes: true });
    expect(qa("[data-video-scopes] canvas[data-scope]").length).toBe(3);
    controller.destroy();
  });
});

describe("ClipInspector LUT (Svelte)", () => {
  it("loads a .cube by path or file, sets its strength and removes it, one undo step each", async () => {
    const controller = new VideoEditorController({ project: PROJECT, clock: new ManualClock(), luts: async (src) => {
      if (src !== "swap.cube") throw new Error("404 Not Found");
      return 'TITLE "Swap"\nLUT_3D_SIZE 2\n0 0 0\n0 1 0\n1 0 0\n1 1 0\n0 0 1\n0 1 1\n1 0 1\n1 1 1\n';
    } });
    render(ClipInspector, { controller });
    act(() => controller.select(["c1"]));
    const lutInput = () => q<HTMLInputElement>('input[aria-label="LUT file"]');
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 0));
      flushSync();
    };
    change(lutInput(), "missing.cube");
    await settle();
    expect(q("[data-edit-error]").textContent).toBe('The LUT "missing.cube" could not be read: 404 Not Found');
    change(lutInput(), "swap.cube");
    await settle();
    expect(clipOf(controller, "c1")!.grade).toEqual({ lut: { src: "swap.cube", name: "Swap" } });
    expect(controller.getState().undoLabel).toBe("Apply LUT");
    change(q<HTMLInputElement>('[data-field="grade.lut.strength"]'), "0.4");
    expect(clipOf(controller, "c1")!.grade!.lut).toEqual({ src: "swap.cube", name: "Swap", strength: 0.4 });
    change(q<HTMLSelectElement>('[data-field="gradePreset"]'), "cool");
    expect(clipOf(controller, "c1")!.grade!.lut).toEqual({ src: "swap.cube", name: "Swap", strength: 0.4 });
    act(() => q<HTMLButtonElement>('button[aria-label="Remove LUT"]').click());
    expect(clipOf(controller, "c1")!.grade!.lut).toBeUndefined();
    const file = new File(['TITLE "Swap"\nLUT_3D_SIZE 2\n0 0 0\n0 1 0\n1 0 0\n1 1 0\n0 0 1\n0 1 1\n1 0 1\n1 1 1\n'], "local.cube");
    const input = q<HTMLInputElement>('input[aria-label="Load a .cube LUT"]');
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(clipOf(controller, "c1")!.grade!.lut).toEqual({ src: "local.cube", name: "Swap" });
    controller.destroy();
  });
});

describe("proxies (Svelte)", () => {
  it("offers a preview size once an asset has proxies, and marks those assets in the media bin", () => {
    const controller = make();
    render(VideoTransport, { controller });
    expect(q("[data-preview-scale]")).toBeNull();
    act(() => void controller.apply({ op: "update_asset", asset: "clip", set: { proxies: [{ scale: 0.5, src: "clip.proxy-50.mp4" }] } }, "Attach proxies"));
    const select = q<HTMLSelectElement>("select[data-preview-scale]");
    expect([...select.options].map((o) => o.textContent)).toEqual(["Auto", "Full", "½", "¼"]);
    change(select, "0.25");
    expect(controller.getState().previewScale).toBe(0.25);
    render(MediaBin, { controller });
    expect(q('[data-asset="clip"] [data-asset-proxies]').title).toMatch(/Proxies: 50%/);
    controller.destroy();
  });
});

describe("frame cache strip (Svelte)", () => {
  it("marks the stretches whose frames are cached under the ruler, and follows the cache", async () => {
    const frameCache = new VideoFrameCache({ decode: null, prefetch: 0 });
    const controller = new VideoEditorController({ project: PROJECT, clock: new ManualClock(), frameCache });
    render(VideoTimeline, { controller, pxPerSecond: 100 });
    expect(q("[data-cached-range]")).toBeNull();
    for (let f = 0; f < 15; f++) frameCache.put({ key: `${f}@clip.mp4`, time: (f * 1000) / 30 }, { image: {} as any, width: 2, height: 2 });
    await new Promise((r) => setTimeout(r, 300));
    flushSync();
    const strip = q("[data-cached-range]");
    expect(strip.style.left).toBe("0px");
    expect(parseFloat(strip.style.width)).toBeCloseTo(50, -1);
    controller.destroy();
  });
});
