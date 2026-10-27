import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { VideoEditorController, findVideoClip, videoProjectDuration, type VideoProject } from "@pixerate/editor/video-editor";
import { ClipInspector, EditPlanPreview, TranscriptEditor, VideoEffectsPanel, VideoTransport } from "../src/video-editor";
import ToolsProbe from "./fixtures/VideoProductionToolsProbe.svelte";

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
  width: 640,
  height: 360,
  fps: 25,
  assets: [
    {
      id: "talk",
      kind: "video",
      src: "talk.mp4",
      duration: 5000,
      transcript: [
        { word: "So", start: 0, end: 300 },
        { word: "um", start: 400, end: 700 },
        { word: "I", start: 800, end: 900 },
        { word: "I", start: 950, end: 1050 },
        { word: "think", start: 1100, end: 1400 },
        { word: "we", start: 3000, end: 3200 },
        { word: "ship", start: 3200, end: 3500 },
      ],
    },
  ],
  tracks: [
    { id: "v1", kind: "video", clips: [{ id: "c1", type: "media", asset: "talk", start: 0, duration: 5000 }] },
    { id: "a1", kind: "audio", clips: [] },
  ],
};

const make = (effects = false) => new VideoEditorController({ project: PROJECT, clock: new ManualClock(), ...(effects ? { effects: createFakeEffectProvider() } : {}) });
const q = <T extends Element = HTMLElement>(sel: string) => target.querySelector(sel) as T;
const qa = (sel: string) => [...target.querySelectorAll(sel)] as HTMLElement[];
const act = (fn: () => void) => {
  fn();
  flushSync();
};
const click = (el: Element, init: MouseEventInit = {}) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })));
function change(el: HTMLSelectElement | HTMLInputElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const clipOf = (c: VideoEditorController, id: string) => findVideoClip(c.getState().project, id)?.clip;

describe("TranscriptEditor (Svelte)", () => {
  it("marks disfluencies, follows the playhead and cuts a chip as one undo step", () => {
    const controller = make();
    render(TranscriptEditor, { controller });
    expect(qa("[data-word]").length).toBe(7);
    expect(q("[data-word='1']").dataset.disfluency).toBe("filler");
    expect(qa("[data-disfluency-chip]").map((c) => c.dataset.disfluencyChip)).toEqual(["filler", "repetition", "pause"]);
    act(() => controller.seek(1200));
    expect(q("[data-current]").textContent).toBe("think");
    click(q("[data-cut-disfluency='0']"));
    expect(controller.getState().undoLabel).toBe('Remove "um"');
    expect(qa("[data-word]").length).toBe(6);
  });

  it("selects words and, with planFirst, proposes deleting them", () => {
    const controller = make();
    render(TranscriptEditor, { controller, planFirst: true });
    click(q("[data-word='5']"));
    click(q("[data-word='6']"), { shiftKey: true });
    expect(qa("[data-selected]").length).toBe(2);
    click(q("[data-delete-words]"));
    expect(controller.getState().plans.map((p) => p.title)).toEqual(["Delete 2 words"]);
    expect(videoProjectDuration(controller.getProject())).toBe(5000);
  });
});

describe("EditPlanPreview (Svelte)", () => {
  it("shows open plans and accepts or discards them", () => {
    const controller = make();
    render(EditPlanPreview, { controller });
    expect(q("[data-edit-plans]")).toBeNull();
    act(() => void controller.proposePlan({ title: "Cut the pause", edits: [{ op: "extract_range", from: 1500, to: 2800 }], ranges: [{ from: 1500, to: 2800, reason: "pause" }] }));
    expect(q("[data-edit-plan='plan1'] h3").textContent).toBe("Cut the pause");
    click(q("[data-plan-strip] button"));
    expect(controller.getState().time).toBe(1500);
    click(q("[data-accept-plan]"));
    expect(videoProjectDuration(controller.getProject())).toBe(3700);
    expect(q("[data-edit-plans]")).toBeNull();
    act(() => void controller.proposePlan({ title: "Fade", edits: [{ op: "update_clip", clip: "c1", set: { fadeIn: 200 } }] }));
    click(q("[data-discard-plan]"));
    expect(controller.getState().plans).toEqual([]);
  });
});

describe("adjustment clips, masks and skin protection (Svelte)", () => {
  it("the transport adds an adjustment clip and the inspector sets its scope", () => {
    const controller = make();
    render(VideoTransport, { controller });
    click(q("[data-add-adjustment]"));
    const id = controller.getState().selection[0];
    expect(clipOf(controller, id)!.type).toBe("adjustment");
    render(ClipInspector, { controller });
    expect(q("[data-clip-inspector] .font-medium").textContent).toBe("Adjustment clip");
    change(q<HTMLSelectElement>("[aria-label='Adjustment scope']"), "track");
    expect(clipOf(controller, id)).toMatchObject({ scope: "track", targetTrack: "v1" });
    change(q<HTMLSelectElement>("[aria-label='Adjustment scope']"), "underneath");
    expect((clipOf(controller, id) as any).scope).toBeUndefined();
  });

  it("the inspector masks a clip and protects skin under a LUT", () => {
    const controller = make();
    controller.apply({ op: "update_clip", clip: "c1", set: { grade: { lut: { src: "look.cube" } } } });
    controller.select(["c1"]);
    render(ClipInspector, { controller });
    change(q<HTMLSelectElement>("[aria-label='Mask shape']"), "rectangle");
    expect(clipOf(controller, "c1")!.mask).toEqual({ shape: "rectangle" });
    change(q<HTMLInputElement>("[aria-label='Feather (px)']"), "25");
    expect(clipOf(controller, "c1")!.mask).toEqual({ shape: "rectangle", feather: 25 });
    act(() => q<HTMLInputElement>("[aria-label='Invert mask']").click());
    expect(clipOf(controller, "c1")!.mask!.inverted).toBe(true);
    change(q<HTMLInputElement>("[aria-label='Protect skin tones']"), "0.6");
    expect(clipOf(controller, "c1")!.grade!.lut!.preserveSkinTones).toBe(0.6);
  });

  it("opens a clip effect in the effect authoring editor and applies it back", async () => {
    const controller = make(true);
    await controller.applyClipEffect("c1", "fake.invert");
    controller.select(["c1"]);
    render(VideoEffectsPanel, { controller });
    click(q("[data-author-effect]"));
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(q("[data-effect-authoring]")).not.toBeNull();
    click(q("[data-apply-authoring]"));
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(q("[data-effect-authoring]")).toBeNull();
  });
});

describe("dialogue and music tools and the transcript rune (Svelte)", () => {
  it("register the providers while mounted", () => {
    const registry = new ToolRegistry();
    const controller = make();
    const { cleanup } = render(ToolsProbe, { registry, controller });
    expect(q("[data-word-count]").dataset.wordCount).toBe("7");
    const names = registry.listTools().tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["dialogue__find_video_disfluencies", "dialogue__plan_video_dialogue_cleanup", "music__duck_video_music", "music__find_video_beats"]));
    act(() => void controller.apply({ op: "extract_range", from: 0, to: 750 }));
    expect(q("[data-word-count]").dataset.wordCount).toBe("5");
    cleanup();
    cleanups = [];
    expect(registry.listTools().tools).toEqual([]);
  });
});
