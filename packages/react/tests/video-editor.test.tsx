// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { VideoEditorController, VideoPreviewEngine, buildVideoAudioPeaks, findVideoClip, type VideoProject } from "@pixerate/editor/video-editor";
import {
  ClipInspector,
  MediaBin,
  TranscriptPanel,
  VideoEditor,
  VideoPreview,
  VideoTimeline,
  VideoTransport,
  useVideoEditor,
  useVideoEditorTools,
  type UseVideoEditorResult,
} from "../src/video-editor";

const PROJECT: VideoProject = {
  version: 1,
  name: "demo",
  width: 640,
  height: 360,
  fps: 30,
  assets: [
    { id: "intro", kind: "video", src: "intro.mp4", name: "Intro", duration: 10000 },
    { id: "music", kind: "audio", src: "music.mp3", name: "Music", duration: 20000 },
  ],
  tracks: [
    {
      id: "v1",
      kind: "video",
      name: "Video 1",
      clips: [
        { id: "c1", type: "media", asset: "intro", start: 0, duration: 2000 },
        { id: "c2", type: "media", asset: "intro", start: 2000, duration: 2000, in: 3000, transition: { type: "crossfade", duration: 400 } },
      ],
    },
    { id: "v2", kind: "video", name: "Titles", clips: [{ id: "t1", type: "text", text: "Hello", start: 500, duration: 1000 }] },
    { id: "a1", kind: "audio", name: "Audio 1", clips: [{ id: "m1", type: "media", asset: "music", start: 0, duration: 4000 }] },
  ],
  markers: [{ id: "mk", time: 1000, label: "Beat" }],
};

let container: HTMLDivElement;
let root: any;

const make = (extra: { readOnly?: boolean } = {}) => new VideoEditorController({ project: PROJECT, clock: new ManualClock(), ...extra });
/** Takes the title and music tracks out of sync lock, so ripples on v1 leave them where they are. */
const unsync = (c: VideoEditorController) =>
  act(() => void c.apply(["v2", "a1"].map((track) => ({ op: "update_track" as const, track, set: { syncLocked: false } })), "Unsync"));
const $ = <T extends Element = HTMLElement>(sel: string) => {
  const el = container.querySelector<T>(sel);
  if (!el) throw new Error(`No element for ${sel}`);
  return el;
};
const clip = (c: VideoEditorController, id: string) => findVideoClip(c.getProject(), id);
const pointer = (el: Element | Window, type: string, clientX: number, init: MouseEventInit = {}) =>
  act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0, buttons: type === "pointerup" ? 0 : 1, ...init })));
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));
const commit = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    input.value = value;
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no 2D canvas; the preview engine draws nothing without a context.
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
  // …and no media playback: keep the preview's element bookkeeping quiet.
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useVideoEditor (React)", () => {
  it("follows the controller and registers agent tools while mounted", async () => {
    const registry = new ToolRegistry();
    let api: UseVideoEditorResult | null = null;
    function Probe() {
      api = useVideoEditor({ project: PROJECT, clock: new ManualClock() });
      useVideoEditorTools(registry, api.controller, { namespace: "video" });
      return <span>{api.state.duration}</span>;
    }
    act(() => root.render(<Probe />));
    expect(container.textContent).toBe("4000");
    expect(registry.listTools().tools.map((t) => t.name)).toContain("video__add_video_clip");
    const result = await act(async () => registry.callTool("video__move_video_clip", { clip: "c2", start: 3000 }));
    expect(result.isError).toBeFalsy();
    expect(container.textContent).toBe("5000");
    act(() => api!.undo());
    expect(container.textContent).toBe("4000");
    act(() => api!.seek(1000));
    expect(api!.state.time).toBe(1000);
    act(() => api!.step(1));
    expect(api!.state.time).toBeCloseTo(1033.333, 2);
    act(() => root.unmount());
    expect(registry.listTools().tools).toEqual([]);
    root = createRoot(container);
  });

  it("plays on the controller's clock", async () => {
    const clock = new ManualClock();
    const controller = new VideoEditorController({ project: PROJECT, clock });
    act(() => root.render(<VideoTransport controller={controller} />));
    act(() => $<HTMLButtonElement>("[data-play]").click());
    expect($("[data-play]").textContent).toBe("Pause");
    await act(async () => clock.advance(1000));
    expect($("[data-timecode]").textContent).toBe("00:00:01:00 / 00:00:04:00");
    controller.destroy();
  });
});

describe("VideoTransport (React)", () => {
  it("splits, deletes and undoes through its buttons", () => {
    const controller = make();
    act(() => root.render(<VideoTransport controller={controller} />));
    expect($<HTMLButtonElement>("[data-delete]").disabled).toBe(true);
    expect($<HTMLButtonElement>("[data-undo]").disabled).toBe(true);
    act(() => {
      controller.select(["c1"]);
      controller.seek(1000);
    });
    act(() => $<HTMLButtonElement>("[data-split]").click());
    expect(controller.getProject().tracks[0].clips.map((c) => [c.start, c.duration])).toEqual([[0, 1000], [1000, 1000], [2000, 2000]]);
    act(() => controller.select(["c2"]));
    // The title and the music run under the gap and are sync-locked, so the ripple is refused...
    act(() => $<HTMLButtonElement>("[data-ripple-delete]").click());
    expect(clip(controller, "c2")).not.toBeNull();
    // ...until they are let go.
    unsync(controller);
    act(() => controller.select(["c2"]));
    act(() => $<HTMLButtonElement>("[data-ripple-delete]").click());
    expect(clip(controller, "c2")).toBeNull();
    expect(controller.getState().duration).toBe(4000); // the music still runs to 4 s
    act(() => $<HTMLButtonElement>("[data-undo]").click());
    expect(clip(controller, "c2")).not.toBeNull();
    act(() => $<HTMLButtonElement>("[data-redo]").click());
    expect(clip(controller, "c2")).toBeNull();
    controller.destroy();
  });

  it("disables editing when read-only", () => {
    const controller = make({ readOnly: true });
    act(() => root.render(<VideoTransport controller={controller} />));
    expect($<HTMLButtonElement>("[data-split]").disabled).toBe(true);
    expect($<HTMLButtonElement>("[data-step-forward]").disabled).toBe(false);
    controller.destroy();
  });
});

describe("VideoTimeline (React)", () => {
  it("draws waveforms in audio clips once their sound has loaded", async () => {
    const loads: string[] = [];
    const controller = new VideoEditorController({
      project: PROJECT,
      clock: new ManualClock(),
      audioPeaks: async (asset) => {
        loads.push(asset.id);
        return buildVideoAudioPeaks([Float32Array.from({ length: 8000 * 20 }, (_, i) => 0.5 * Math.sin(i / 3))], 8000);
      },
    });
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    await act(async () => {});
    const wave = $('[data-waveform="m1"] path');
    expect(wave.getAttribute("d")).toMatch(/^M1\.0 /);
    // Only audio clips by default; video clips with sound only with waveforms="all".
    expect(container.querySelector('[data-waveform="c1"]')).toBeNull();
    expect(loads).toEqual(["music"]);
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} waveforms="all" />));
    await act(async () => {});
    expect(container.querySelector('[data-waveform="c1"]')).not.toBeNull();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} waveforms="none" />));
    expect(container.querySelector("[data-waveform]")).toBeNull();
    controller.destroy();
  });


  it("draws a block per clip at its time, with markers, transitions and the playhead", () => {
    const controller = make();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    expect([...container.querySelectorAll("[data-clip]")].map((el) => (el as HTMLElement).dataset.clip)).toEqual(["c1", "c2", "t1", "m1"]);
    const c2 = $<HTMLElement>('[data-clip="c2"]');
    expect([c2.style.left, c2.style.width]).toEqual(["200px", "200px"]);
    expect($<HTMLElement>('[data-clip="t1"]').style.left).toBe("50px");
    expect($<HTMLElement>('[data-clip="t1"]').textContent).toContain("Hello");
    expect(c2.querySelector('[data-transition="crossfade"]')).not.toBeNull();
    expect($<HTMLElement>('[data-marker="mk"]').style.left).toBe("100px");
    expect($('[data-track="a1"] [data-track-kind]').textContent).toBe("audio");
    act(() => controller.seek(1500));
    expect($<HTMLElement>("[data-playhead]").style.left).toBe(`${150 + 150}px`);
    // Its own zoom control rescales the clips.
    const zoom = $<HTMLInputElement>("[data-zoom]");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(zoom, "200");
      zoom.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect($<HTMLElement>('[data-clip="c2"]').style.left).toBe("400px");
    controller.destroy();
  });

  it("uses a host-owned zoom without its own control", () => {
    const controller = make();
    const onZoom = vi.fn();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={50} onPxPerSecondChange={onZoom} />));
    expect(container.querySelector("[data-zoom]")).toBeNull();
    expect($<HTMLElement>('[data-clip="c2"]').style.left).toBe("100px");
    controller.destroy();
  });

  it("scrubs from the ruler", () => {
    const controller = make();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    const ruler = $("[data-ruler]");
    pointer(ruler, "pointerdown", 250);
    expect(controller.getState().time).toBe(2500);
    pointer(ruler, "pointermove", 100);
    expect(controller.getState().time).toBe(1000);
    controller.destroy();
  });

  it("selects on click and toggles with shift-click", () => {
    const controller = make();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    const click = (id: string, init: MouseEventInit = {}) => {
      pointer($(`[data-clip="${id}"]`), "pointerdown", 10, init);
      pointer($(`[data-clip="${id}"]`), "pointerup", 10, init);
    };
    click("c1");
    expect(controller.getState().selection).toEqual(["c1"]);
    expect($('[data-clip="c1"]').hasAttribute("data-selected")).toBe(true);
    click("t1", { shiftKey: true });
    expect(controller.getState().selection).toEqual(["c1", "t1"]);
    click("c1", { metaKey: true });
    expect(controller.getState().selection).toEqual(["t1"]);
    click("c2");
    expect(controller.getState().selection).toEqual(["c2"]);
    controller.destroy();
  });

  it("moves a clip by dragging its body, as one undo step", () => {
    const controller = make();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    const c2 = $('[data-clip="c2"]');
    pointer(c2, "pointerdown", 0);
    pointer(c2, "pointermove", 300);
    // While dragging the block follows the plan; the project is unchanged.
    expect($<HTMLElement>('[data-clip="c2"]').style.left).toBe("500px");
    expect($('[data-clip="c2"]').hasAttribute("data-dragging")).toBe(true);
    expect(clip(controller, "c2")!.clip.start).toBe(2000);
    pointer(c2, "pointerup", 300);
    expect(clip(controller, "c2")!.clip.start).toBe(5000);
    expect(controller.getState().selection).toEqual(["c2"]);
    expect(controller.getState().undoLabel).toBe("Move clip");
    act(() => void controller.undo());
    expect(clip(controller, "c2")!.clip.start).toBe(2000);
    controller.destroy();
  });

  it("shows why a drag was refused", () => {
    const controller = make();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    const c2 = $('[data-clip="c2"]');
    pointer(c2, "pointerdown", 0);
    pointer(c2, "pointermove", -100);
    pointer(c2, "pointerup", -100);
    expect(clip(controller, "c2")!.clip.start).toBe(2000);
    expect($("[data-edit-error]").textContent).toMatch(/overlap clip "c1"/);
    controller.destroy();
  });

  it("moves a clip onto the track under the pointer when it is the same kind", () => {
    const controller = make();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    const rect = (top: number) => () => ({ left: 0, top, width: 1000, height: 40, right: 1000, bottom: top + 40, x: 0, y: top, toJSON() {} }) as DOMRect;
    $('[data-track-lane="v1"]').getBoundingClientRect = rect(0);
    $('[data-track-lane="v2"]').getBoundingClientRect = rect(40);
    $('[data-track-lane="a1"]').getBoundingClientRect = rect(80);
    const c2 = $('[data-clip="c2"]');
    pointer(c2, "pointerdown", 0, { clientY: 10 });
    pointer(c2, "pointermove", 50, { clientY: 50 });
    expect(container.querySelector('[data-track-lane="v2"] [data-clip="c2"]')).not.toBeNull();
    // The block now lives in another row, so the rest of the drag reaches the window, as it does in a browser.
    pointer(window, "pointerup", 50, { clientY: 90 }); // over the audio track: not a drop target, stays on v1
    expect(clip(controller, "c2")!.track.id).toBe("v1");
    expect(clip(controller, "c2")!.clip.start).toBe(2500);
    const again = $('[data-clip="c2"]');
    pointer(again, "pointerdown", 0, { clientY: 10 });
    pointer(again, "pointermove", 50, { clientY: 50 });
    pointer(window, "pointerup", 50, { clientY: 50 });
    expect(clip(controller, "c2")!.track.id).toBe("v2");
    expect(clip(controller, "c2")!.clip.start).toBe(3000);
    controller.destroy();
  });

  it("drags a clip in with Alt (insert) or over with Shift (overwrite)", () => {
    const controller = make();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    // Shift: c2 lands on the back half of c1, which is trimmed away.
    pointer($('[data-clip="c2"]'), "pointerdown", 0);
    pointer(window, "pointermove", -100, { shiftKey: true });
    pointer(window, "pointerup", -100, { shiftKey: true });
    expect(clip(controller, "c1")!.clip).toMatchObject({ start: 0, duration: 1000 });
    expect(clip(controller, "c2")!.clip.start).toBe(1000);
    expect(controller.getState().undoLabel).toBe("Overwrite clip");
    act(() => void controller.undo());
    // Alt: c1 is cut at the drop point and its rest, the title and the music move along with it.
    pointer($('[data-clip="c2"]'), "pointerdown", 0);
    pointer(window, "pointermove", -100, { altKey: true });
    pointer(window, "pointerup", -100, { altKey: true });
    expect(controller.getState().undoLabel).toBe("Insert clip");
    expect(clip(controller, "c2")!.clip.start).toBe(1000);
    expect(clip(controller, "c1-1")!.clip).toMatchObject({ start: 3000, duration: 1000 });
    expect(clip(controller, "t1-1")!.clip.start).toBe(3000);
    expect(clip(controller, "m1-1")!.clip.start).toBe(3000);
    controller.destroy();
  });

  it("trims a clip by dragging an edge, and ripples with Alt", () => {
    const controller = make();
    unsync(controller);
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    const end = $('[data-clip="c1"] [data-handle="end"]');
    const c1 = $('[data-clip="c1"]');
    pointer(end, "pointerdown", 200);
    pointer(c1, "pointermove", 150);
    expect($<HTMLElement>('[data-clip="c1"]').style.width).toBe("150px");
    pointer(c1, "pointerup", 150);
    expect(clip(controller, "c1")!.clip.duration).toBe(1500);
    expect(clip(controller, "c2")!.clip.start).toBe(2000);
    expect(controller.getState().undoLabel).toBe("Trim clip");

    const start = $('[data-clip="c2"] [data-handle="start"]');
    const c2 = $('[data-clip="c2"]');
    pointer(start, "pointerdown", 200, { altKey: true });
    pointer(c2, "pointermove", 250, { altKey: true });
    pointer(c2, "pointerup", 250, { altKey: true });
    expect(clip(controller, "c2")!.clip).toMatchObject({ start: 2000, duration: 1500, in: 3500 });
    expect(controller.getState().undoLabel).toBe("Ripple trim");
    controller.destroy();
  });

  it("toggles track mute, hide and lock as undoable edits", () => {
    const controller = make();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    expect(container.querySelector('[data-track="a1"] [data-track-toggle="hidden"]')).toBeNull();
    act(() => $<HTMLButtonElement>('[data-track="v1"] [data-track-toggle="muted"]').click());
    expect(controller.getProject().tracks[0].muted).toBe(true);
    expect($('[data-track="v1"] [data-track-toggle="muted"]').getAttribute("aria-pressed")).toBe("true");
    act(() => $<HTMLButtonElement>('[data-track="v1"] [data-track-toggle="locked"]').click());
    expect(controller.getProject().tracks[0].locked).toBe(true);
    expect(container.querySelector('[data-clip="c1"] [data-handle]')).toBeNull();
    act(() => void controller.undo());
    expect(controller.getProject().tracks[0].locked).toBeFalsy();
    expect(controller.getProject().tracks[0].muted).toBe(true);
    controller.destroy();
  });

  it("handles the keyboard shortcuts", () => {
    const controller = make();
    unsync(controller);
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} />));
    const tl = $("[data-video-timeline]");
    key(tl, "ArrowRight");
    key(tl, "ArrowRight");
    expect(controller.getState().time).toBeCloseTo(66.667, 2);
    key(tl, "ArrowLeft");
    expect(controller.getState().time).toBeCloseTo(33.333, 2);
    act(() => controller.seek(1000));
    act(() => controller.select(["c1"]));
    key(tl, "s");
    expect(controller.getProject().tracks[0].clips).toHaveLength(3);
    key(tl, "Delete", { shiftKey: true });
    expect(clip(controller, "c1")).toBeNull();
    expect(controller.getProject().tracks[0].clips[0].start).toBe(0); // rippled into the gap
    key(tl, "z", { metaKey: true });
    expect(clip(controller, "c1")).not.toBeNull();
    key(tl, "z", { ctrlKey: true, shiftKey: true });
    expect(clip(controller, "c1")).toBeNull();
    key(tl, " ");
    expect(controller.getState().playing).toBe(true);
    key(tl, " ");
    expect(controller.getState().playing).toBe(false);
    act(() => controller.select(["c2"]));
    key(tl, "Escape");
    expect(controller.getState().selection).toEqual([]);
    controller.destroy();
  });

  it("does not edit when not editable", () => {
    const controller = make();
    act(() => root.render(<VideoTimeline controller={controller} pxPerSecond={100} editable={false} />));
    expect(container.querySelector("[data-track-toggle]")).toBeNull();
    const c2 = $('[data-clip="c2"]');
    pointer(c2, "pointerdown", 0);
    pointer(c2, "pointermove", 300);
    pointer(c2, "pointerup", 300);
    expect(clip(controller, "c2")!.clip.start).toBe(2000);
    expect(controller.getState().selection).toEqual([]);
    key($("[data-video-timeline]"), "Delete");
    expect(controller.getState().canUndo).toBe(false);
    controller.destroy();
  });
});

describe("ClipInspector (React)", () => {
  it("edits the selected clip, one undo step per change", () => {
    const controller = make();
    act(() => root.render(<ClipInspector controller={controller} />));
    expect(container.textContent).toMatch(/Select a clip/);
    act(() => controller.select(["c1", "t1"]));
    expect(container.textContent).toMatch(/2 clips selected/);
    act(() => controller.select(["c1"]));
    expect($('[data-field="start"]').textContent).toContain("0.00 s");
    commit($<HTMLInputElement>('input[aria-label="Opacity"]'), "0.5");
    expect(clip(controller, "c1")!.clip.opacity).toBe(0.5);
    commit($<HTMLInputElement>('input[aria-label="Fade in"]'), "250");
    expect(clip(controller, "c1")!.clip.fadeIn).toBe(250);
    act(() => $<HTMLInputElement>('input[aria-label="Muted"]').click());
    expect((clip(controller, "c1")!.clip as any).muted).toBe(true);
    act(() => void controller.undo());
    expect((clip(controller, "c1")!.clip as any).muted).toBeUndefined();
    expect(clip(controller, "c1")!.clip.fadeIn).toBe(250);
    act(() => void controller.undo());
    expect(clip(controller, "c1")!.clip.fadeIn).toBeUndefined();
    expect(clip(controller, "c1")!.clip.opacity).toBe(0.5);
    // Clearing a field removes it.
    commit($<HTMLInputElement>('input[aria-label="Opacity"]'), "");
    expect(clip(controller, "c1")!.clip.opacity).toBeUndefined();
    controller.destroy();
  });

  it("grades a picture: a look, then single settings, clamped and removable", () => {
    const controller = make();
    act(() => root.render(<ClipInspector controller={controller} />));
    act(() => controller.select(["c1"]));
    choose($<HTMLSelectElement>('select[aria-label="Apply a look"]'), "warm");
    expect(clip(controller, "c1")!.clip.grade).toEqual({ temperature: 0.4, saturation: 0.1 });
    expect(controller.getState().undoLabel).toBe("Apply warm look");
    commit($<HTMLInputElement>('input[aria-label="Exposure"]'), "9");
    expect(clip(controller, "c1")!.clip.grade).toEqual({ exposure: 3, temperature: 0.4, saturation: 0.1 });
    commit($<HTMLInputElement>('input[aria-label="Exposure"]'), "");
    commit($<HTMLInputElement>('input[aria-label="Temperature"]'), "0");
    commit($<HTMLInputElement>('input[aria-label="Saturation"]'), "0");
    expect(clip(controller, "c1")!.clip.grade).toBeUndefined();
    act(() => controller.select(["m1"]));
    expect(container.querySelector('input[aria-label="Exposure"]')).toBeNull();
    controller.destroy();
  });

  it("sets a picture's blend mode, and offers none for sound", () => {
    const controller = make();
    act(() => root.render(<ClipInspector controller={controller} />));
    act(() => controller.select(["t1"]));
    choose($<HTMLSelectElement>('select[aria-label="Blend mode"]'), "screen");
    expect(clip(controller, "t1")!.clip.blend).toBe("screen");
    expect(controller.getState().undoLabel).toBe("Change blend mode");
    choose($<HTMLSelectElement>('select[aria-label="Blend mode"]'), "normal");
    expect(clip(controller, "t1")!.clip.blend).toBeUndefined();
    act(() => controller.select(["m1"]));
    expect(container.querySelector('select[aria-label="Blend mode"]')).toBeNull();
    controller.destroy();
  });

  it("animates a title in and out, keeping a duration it already has", () => {
    const controller = make();
    act(() => root.render(<ClipInspector controller={controller} />));
    act(() => controller.select(["t1"]));
    choose($<HTMLSelectElement>('select[aria-label="Animate in"]'), "pop");
    expect(clip(controller, "t1")!.clip.animateIn).toEqual({ effect: "pop" });
    act(() => void controller.apply({ op: "update_clip", clip: "t1", set: { animateIn: { effect: "pop", duration: 800 } } }, "Set"));
    choose($<HTMLSelectElement>('select[aria-label="Animate in"]'), "rise");
    expect(clip(controller, "t1")!.clip.animateIn).toEqual({ effect: "rise", duration: 800 });
    choose($<HTMLSelectElement>('select[aria-label="Animate in"]'), "");
    expect(clip(controller, "t1")!.clip.animateIn).toBeUndefined();
    controller.destroy();
  });

  it("offers a direction for push, slide and wipe only", () => {
    const controller = make();
    act(() => root.render(<ClipInspector controller={controller} />));
    act(() => controller.select(["c2"]));
    expect(container.querySelector('select[aria-label="Transition direction"]')).toBeNull();
    choose($<HTMLSelectElement>('select[aria-label="Transition"]'), "push");
    choose($<HTMLSelectElement>('select[aria-label="Transition direction"]'), "up");
    expect(clip(controller, "c2")!.clip.transition).toEqual({ type: "push", duration: 400, direction: "up" });
    choose($<HTMLSelectElement>('select[aria-label="Transition"]'), "iris");
    expect(container.querySelector('select[aria-label="Transition direction"]')).toBeNull();
    controller.destroy();
  });

  it("shapes a transition's sound, storing only a change from the type's default", () => {
    const controller = make();
    act(() => root.render(<ClipInspector controller={controller} />));
    act(() => controller.select(["c2"]));
    const curve = () => $<HTMLSelectElement>('select[aria-label="Transition sound curve"]');
    expect(curve().value).toBe("equal-power");
    choose(curve(), "linear");
    expect(clip(controller, "c2")!.clip.transition).toEqual({ type: "crossfade", duration: 400, audioCurve: "linear" });
    expect(controller.getState().undoLabel).toBe("Change transition sound");
    choose(curve(), "equal-power");
    expect(clip(controller, "c2")!.clip.transition).toEqual({ type: "crossfade", duration: 400 });
    controller.destroy();
  });

  it("shapes a media clip's sound fades once it has them", () => {
    const controller = make();
    act(() => root.render(<ClipInspector controller={controller} />));
    act(() => controller.select(["c1"]));
    expect(container.querySelector('select[aria-label="Fade in curve"]')).toBeNull();
    commit($<HTMLInputElement>('input[aria-label="Fade in"]'), "500");
    expect($<HTMLSelectElement>('select[aria-label="Fade in curve"]').value).toBe("linear");
    expect(container.querySelector('select[aria-label="Fade out curve"]')).toBeNull();
    choose($<HTMLSelectElement>('select[aria-label="Fade in curve"]'), "equal-power");
    expect((clip(controller, "c1")!.clip as any).fadeInCurve).toBe("equal-power");
    expect(controller.getState().undoLabel).toBe("Change fade in curve");
    choose($<HTMLSelectElement>('select[aria-label="Fade in curve"]'), "linear");
    expect((clip(controller, "c1")!.clip as any).fadeInCurve).toBeUndefined();
    controller.destroy();
  });

  it("edits titles and transitions", () => {
    const controller = make();
    act(() => root.render(<ClipInspector controller={controller} />));
    act(() => controller.select(["t1"]));
    commit($<HTMLTextAreaElement>('textarea[aria-label="Text"]'), "Hi there");
    commit($<HTMLInputElement>('input[aria-label="Font size"]'), "48");
    expect(clip(controller, "t1")!.clip).toMatchObject({ text: "Hi there", fontSize: 48 });
    act(() => controller.select(["c2"]));
    expect($<HTMLSelectElement>('select[aria-label="Transition"]').value).toBe("crossfade");
    commit($<HTMLInputElement>('input[aria-label="Transition length"]'), "600");
    expect(clip(controller, "c2")!.clip.transition).toEqual({ type: "crossfade", duration: 600 });
    choose($<HTMLSelectElement>('select[aria-label="Transition"]'), "dip");
    expect(clip(controller, "c2")!.clip.transition).toEqual({ type: "dip", duration: 600 });
    choose($<HTMLSelectElement>('select[aria-label="Transition"]'), "");
    expect(clip(controller, "c2")!.clip.transition).toBeUndefined();
    expect(container.querySelector('input[aria-label="Transition length"]')).toBeNull();
    controller.destroy();
  });
});

describe("ClipInspector keyframes (React)", () => {
  it("adds keys at the playhead, sets the key there by typing, and removes them", () => {
    const controller = make();
    act(() => root.render(<ClipInspector controller={controller} />));
    act(() => controller.select(["c1"]));
    expect([...container.querySelectorAll("[data-keyframe-row]")].map((r) => (r as HTMLElement).dataset.keyframeRow)).toEqual(["opacity", "volume", "x", "y", "scale", "rotation"]);
    act(() => controller.seek(500));
    act(() => $<HTMLButtonElement>('[data-keyframe-toggle="x"]').click());
    expect((clip(controller, "c1")!.clip.transform as any).x).toEqual({ keys: [{ t: 500, v: 0 }] });
    expect(controller.getState().undoLabel).toBe("Add x keyframe");
    expect($('[data-keyframe-toggle="x"]').getAttribute("aria-pressed")).toBe("true");
    act(() => controller.seek(1500));
    commit($<HTMLInputElement>('input[aria-label="X"]'), "200");
    expect((clip(controller, "c1")!.clip.transform as any).x.keys).toEqual([{ t: 500, v: 0 }, { t: 1500, v: 200 }]);
    act(() => controller.seek(1000));
    expect($<HTMLInputElement>('input[aria-label="X"]').value).toBe("100");
    expect($('[data-keyframe-count="x"]').textContent).toBe("2");
    act(() => controller.seek(1500));
    act(() => $<HTMLButtonElement>('[data-keyframe-toggle="x"]').click());
    act(() => controller.seek(500));
    act(() => $<HTMLButtonElement>('[data-keyframe-toggle="x"]').click());
    expect(clip(controller, "c1")!.clip.transform).toBeUndefined();
    controller.destroy();
  });
});

describe("MediaBin (React)", () => {
  it("lists assets and adds one to the end of its track", () => {
    const controller = make();
    act(() => root.render(<MediaBin controller={controller} />));
    expect($('[data-asset="intro"]').textContent).toContain("Intro");
    expect($('[data-asset="music"] [data-asset-kind]').textContent).toBe("audio");
    act(() => $<HTMLButtonElement>('[data-asset="intro"] [data-add-to-timeline]').click());
    const v1 = controller.getProject().tracks[0].clips;
    expect(v1).toHaveLength(3);
    expect(v1[2]).toMatchObject({ type: "media", asset: "intro", start: 4000 });
    expect(controller.getState().selection).toEqual([v1[2].id]);
    act(() => $<HTMLButtonElement>('[data-asset="music"] [data-add-to-timeline]').click());
    expect(controller.getProject().tracks[2].clips).toHaveLength(2);
    controller.destroy();
  });

  it("imports files and URLs as assets", async () => {
    const controller = make();
    const probe = vi.fn(async (_src: string, kind: any) => ({ kind, duration: 3000, width: 320, height: 240 }));
    act(() => root.render(<MediaBin controller={controller} probe={probe} fileToUrl={(f) => `blob:${f.name}`} />));
    const input = $<HTMLInputElement>("[data-import-files]");
    const files = [new File(["x"], "beach.mp4", { type: "video/mp4" }), new File(["x"], "notes.txt", { type: "text/plain" })];
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(probe).toHaveBeenCalledWith("blob:beach.mp4", "video");
    expect(controller.getProject().assets.find((a) => a.src === "blob:beach.mp4")).toMatchObject({ kind: "video", name: "beach.mp4", duration: 3000, width: 320 });
    expect($("[data-media-error]").textContent).toMatch(/notes.txt" is not a video/);

    const url = $<HTMLInputElement>('input[aria-label="Media URL"]');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(url, "https://example.com/song.mp3?x=1");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void $<HTMLButtonElement>("[data-add-url]").click());
    expect(controller.getProject().assets.find((a) => a.name === "song.mp3")).toMatchObject({ kind: "audio", src: "https://example.com/song.mp3?x=1" });
    controller.destroy();
  });
});

describe("VideoPreview (React)", () => {
  it("creates a preview engine on mount and destroys it on unmount", () => {
    const controller = make();
    const destroy = vi.spyOn(VideoPreviewEngine.prototype, "destroy");
    act(() => root.render(<VideoPreview controller={controller} resolution={0.5} />));
    const canvas = $<HTMLCanvasElement>("canvas[data-video-preview]");
    expect(canvas.style.aspectRatio).toBe("640 / 360");
    act(() => controller.seek(1000));
    expect(destroy).not.toHaveBeenCalled();
    act(() => root.render(<span />));
    expect(destroy).toHaveBeenCalledTimes(1);
    controller.destroy();
  });
});

describe("VideoEditor (React)", () => {
  it("composes the panels and lists issues", () => {
    const controller = make();
    act(() => root.render(<VideoEditor controller={controller} pxPerSecond={100} />));
    for (const sel of ["[data-media-bin]", "[data-video-preview]", "[data-video-transport]", "[data-video-timeline]", "[data-clip-inspector]"]) expect(container.querySelector(sel)).not.toBeNull();
    act(() => controller.select(["t1"]));
    expect($("[data-clip-inspector]").getAttribute("data-clip-id")).toBe("t1");
    expect(container.querySelectorAll("[data-video-issues] li").length).toBe(controller.getState().issues.length);
    controller.destroy();
  });

  it("is read-only and hides editing UI when not editable", () => {
    const controller = make();
    act(() => root.render(<VideoEditor controller={controller} editable={false} />));
    expect(controller.getState().readOnly).toBe(true);
    for (const sel of ["[data-media-bin]", "[data-clip-inspector]", "[data-split]", "[data-track-toggle]"]) expect(container.querySelector(sel)).toBeNull();
    expect(container.querySelector("[data-video-preview]")).not.toBeNull();
    act(() => root.render(<span />));
    expect(controller.getState().readOnly).toBe(false);
    controller.destroy();
  });

  it("creates its own controller from options", () => {
    act(() => root.render(<VideoEditor options={{ project: PROJECT, clock: new ManualClock() }} pxPerSecond={100} />));
    expect(container.querySelectorAll("[data-clip]")).toHaveLength(4);
    expect($("[data-timecode]").textContent).toBe("00:00:00:00 / 00:00:04:00");
  });
});

describe("TranscriptPanel (React)", () => {
  const talk = (): VideoEditorController =>
    new VideoEditorController({
      clock: new ManualClock(),
      project: {
        version: 1, width: 640, height: 360, fps: 25,
        assets: [{ id: "talk", kind: "audio", src: "talk.wav", name: "Talk", duration: 4000, transcript: [
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
  const words = () => [...container.querySelectorAll<HTMLElement>("[data-word]")].map((w) => w.textContent);

  it("seeks to a word, cuts a shift-selected run, fillers and pauses, one undo step each", () => {
    const controller = talk();
    act(() => root.render(<TranscriptPanel controller={controller} />));
    expect(words()).toEqual(["So", "um", "I", "think", "we", "ship"]);
    act(() => $<HTMLElement>('[data-word="3"]').click());
    expect(controller.getState().time).toBe(900);
    expect($('[data-word="3"]').hasAttribute("data-current")).toBe(true);
    act(() => void $<HTMLElement>('[data-word="5"]').dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(container.querySelectorAll("[data-selected]")).toHaveLength(3);
    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Delete selected words")!.click());
    expect(words()).toEqual(["So", "um", "I"]);
    expect(controller.getState().undoLabel).toBe("Cut words");
    act(() => void controller.undo());
    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Remove fillers")!.click());
    expect(words()).toEqual(["So", "I", "think", "we", "ship"]);
    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Tighten pauses")!.click());
    expect(controller.getProject().tracks[0].clips.reduce((n, c) => n + c.duration, 0)).toBeLessThan(3000);
    expect(controller.getState().undoLabel).toBe("Tighten pauses");
    controller.destroy();
  });

  it("loads a transcript file for an asset, and says what is wrong with a bad one", async () => {
    const controller = new VideoEditorController({ clock: new ManualClock(), project: PROJECT });
    act(() => root.render(<TranscriptPanel controller={controller} />));
    expect(container.querySelector("[data-transcript-empty]")).not.toBeNull();
    const input = $<HTMLInputElement>('input[aria-label="Load a transcript for Music"]');
    const pick = async (text: string) => {
      Object.defineProperty(input, "files", { value: [new File([text], "t.srt")], configurable: true });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    };
    await pick("nonsense");
    expect($("[data-transcript-error]").textContent).toMatch(/No words found/);
    await pick("1\n00:00:00,000 --> 00:00:01,000\nHello there\n");
    expect(words()).toEqual(["Hello", "there"]);
    expect(controller.getState().undoLabel).toBe("Attach transcript");
    controller.destroy();
  });
});
