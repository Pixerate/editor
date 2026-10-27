// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { VideoEditorController, findVideoClip, videoProjectDuration, type VideoProject } from "@pixerate/editor/video-editor";
import { ClipInspector, EditPlanPreview, TranscriptEditor, VideoEffectsPanel, VideoTransport, useVideoDialogueTools, useVideoMusicTools, useTranscriptVideoController, useTranscriptVideoState } from "../src/video-editor";

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

let container: HTMLDivElement;
let root: any;
const make = () => new VideoEditorController({ project: PROJECT, clock: new ManualClock() });
const $ = <T extends Element = HTMLElement>(sel: string) => {
  const el = container.querySelector<T>(sel);
  if (!el) throw new Error(`No element for ${sel}`);
  return el;
};
const click = (el: Element, init: MouseEventInit = {}) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })));
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
const commit = (input: HTMLInputElement, value: string) =>
  act(() => {
    input.value = value;
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TranscriptEditor (React)", () => {
  it("marks disfluencies, follows the playhead and cuts a chip as one undo step", () => {
    const controller = make();
    act(() => root.render(<TranscriptEditor controller={controller} />));
    expect(container.querySelectorAll("[data-word]").length).toBe(7);
    expect($("[data-word='1']").dataset.disfluency).toBe("filler");
    expect($("[data-word='2']").dataset.disfluency).toBe("repetition");
    expect([...container.querySelectorAll("[data-disfluency-chip]")].map((c) => (c as HTMLElement).dataset.disfluencyChip)).toEqual(["filler", "repetition", "pause"]);
    act(() => controller.seek(1200));
    expect($("[data-current]").textContent).toBe("think");
    click($("[data-cut-disfluency='0']"));
    expect(controller.getState().undoLabel).toBe('Remove "um"');
    expect(container.querySelectorAll("[data-word]").length).toBe(6);
  });

  it("selects words, deletes them, and with planFirst proposes the cut instead", () => {
    const controller = make();
    act(() => root.render(<TranscriptEditor controller={controller} planFirst />));
    click($("[data-word='5']"));
    click($("[data-word='6']"), { shiftKey: true });
    expect(container.querySelectorAll("[data-selected]").length).toBe(2);
    click($("[data-delete-words]"));
    expect(controller.getState().plans.map((p) => p.title)).toEqual(["Delete 2 words"]);
    expect(videoProjectDuration(controller.getProject())).toBe(5000);
    click($("[data-plan-cleanup]"));
    expect(controller.getState().plans.length).toBe(2);
  });

  it("the hooks expose the controller's state", () => {
    const controller = make();
    let words = 0;
    function Probe() {
      const t = useTranscriptVideoController(controller);
      words = useTranscriptVideoState(t).words.length;
      return null;
    }
    act(() => root.render(<Probe />));
    expect(words).toBe(7);
  });
});

describe("EditPlanPreview (React)", () => {
  it("shows open plans with their effect, and accepts or discards them", () => {
    const controller = make();
    act(() => root.render(<EditPlanPreview controller={controller} />));
    expect(container.querySelector("[data-edit-plans]")).toBeNull();
    act(() => void controller.proposePlan({ title: "Cut the pause", edits: [{ op: "extract_range", from: 1500, to: 2800 }], ranges: [{ from: 1500, to: 2800, reason: "pause" }] }));
    expect($("[data-edit-plan='plan1'] h3").textContent).toBe("Cut the pause");
    expect($("[data-plan-delta]").textContent).toContain("1.30 s");
    expect(container.querySelectorAll("[data-plan-strip] button").length).toBe(1);
    click($("[data-plan-strip] button"));
    expect(controller.getState().time).toBe(1500);
    click($("[data-accept-plan]"));
    expect(videoProjectDuration(controller.getProject())).toBe(3700);
    expect(container.querySelector("[data-edit-plans]")).toBeNull();
    act(() => void controller.proposePlan({ title: "Fade", edits: [{ op: "update_clip", clip: "c1", set: { fadeIn: 200 } }] }));
    click($("[data-discard-plan]"));
    expect(controller.getState().plans).toEqual([]);
  });
});

describe("adjustment clips, masks and skin protection (React)", () => {
  it("the transport adds an adjustment clip over everything and selects it; the inspector sets its scope", () => {
    const controller = make();
    act(() => root.render(<><VideoTransport controller={controller} /><ClipInspector controller={controller} /></>));
    click($("[data-add-adjustment]"));
    const id = controller.getState().selection[0];
    const at = findVideoClip(controller.getProject(), id)!;
    expect(at.clip.type).toBe("adjustment");
    expect(controller.getProject().tracks[0].id).toBe("adj");
    expect($("[data-clip-inspector] span.font-medium").textContent).toBe("Adjustment clip");
    choose($<HTMLSelectElement>("[aria-label='Adjustment scope']"), "track");
    expect(findVideoClip(controller.getProject(), id)!.clip).toMatchObject({ scope: "track", targetTrack: "v1" });
    choose($<HTMLSelectElement>("[aria-label='Adjustment scope']"), "all");
    expect(findVideoClip(controller.getProject(), id)!.clip).toMatchObject({ scope: "all" });
    expect((findVideoClip(controller.getProject(), id)!.clip as any).targetTrack).toBeUndefined();
  });

  it("the inspector masks a clip and protects skin under a LUT", () => {
    const controller = make();
    act(() => void controller.apply({ op: "update_clip", clip: "c1", set: { grade: { lut: { src: "look.cube" } } } }));
    act(() => controller.select(["c1"]));
    act(() => root.render(<ClipInspector controller={controller} />));
    choose($<HTMLSelectElement>("[aria-label='Mask shape']"), "ellipse");
    expect(findVideoClip(controller.getProject(), "c1")!.clip.mask).toEqual({ shape: "ellipse" });
    commit($<HTMLInputElement>("[aria-label='Feather (px)']"), "40");
    expect(findVideoClip(controller.getProject(), "c1")!.clip.mask).toEqual({ shape: "ellipse", feather: 40 });
    act(() => void $<HTMLInputElement>("[aria-label='Invert mask']").click());
    expect(findVideoClip(controller.getProject(), "c1")!.clip.mask!.inverted).toBe(true);
    commit($<HTMLInputElement>("[aria-label='Protect skin tones']"), "0.6");
    expect(findVideoClip(controller.getProject(), "c1")!.clip.grade!.lut!.preserveSkinTones).toBe(0.6);
    choose($<HTMLSelectElement>("[aria-label='Mask shape']"), "");
    expect(findVideoClip(controller.getProject(), "c1")!.clip.mask).toBeUndefined();
  });

  it("opens a clip effect in the effect authoring editor and applies it back", async () => {
    const controller = new VideoEditorController({ project: PROJECT, clock: new ManualClock(), effects: createFakeEffectProvider() });
    await act(async () => void (await controller.applyClipEffect("c1", "fake.invert")));
    act(() => controller.select(["c1"]));
    act(() => root.render(<VideoEffectsPanel controller={controller} />));
    await act(async () => {
      $("[data-author-effect]").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector("[data-effect-authoring]")).not.toBeNull();
    await act(async () => {
      $("[data-apply-authoring]").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector("[data-effect-authoring]")).toBeNull();
  });
});

describe("dialogue and music tool hooks (React)", () => {
  it("register the providers while mounted", () => {
    const registry = new ToolRegistry();
    const controller = make();
    function Probe() {
      useVideoDialogueTools(registry, controller, { namespace: "dialogue" });
      useVideoMusicTools(registry, controller, { namespace: "music" });
      return null;
    }
    act(() => root.render(<Probe />));
    const names = registry.listTools().tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["dialogue__find_video_disfluencies", "dialogue__plan_video_dialogue_cleanup", "music__duck_video_music", "music__find_video_beats"]));
    act(() => root.unmount());
    expect(registry.listTools().tools).toEqual([]);
    root = createRoot(container);
  });
});
