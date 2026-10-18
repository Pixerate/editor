import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { VideoEditorController, findVideoClip, type VideoProject } from "@pixerate/editor/video-editor";
import { ClipInspector, MediaBin, VideoEditor, VideoPreview, VideoTimeline, VideoTransport, createVideoEditor } from "../src/video-editor";
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
