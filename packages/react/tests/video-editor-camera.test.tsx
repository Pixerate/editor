// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { VideoEditorController, findVideoClip, parseVideoProject } from "@pixerate/editor/video-editor";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { ClipCameraMoves } from "../src/video-editor";

const project = () =>
  parseVideoProject({ version: 1, width: 320, height: 180, fps: 25, assets: [], tracks: [{ id: "v1", kind: "video", clips: [{ id: "a", type: "color", color: "#000000", start: 0, duration: 2000 }] }] });

let container: HTMLDivElement;
let root: any;
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
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

const $ = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T;
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
async function change(el: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
const clip = (c: VideoEditorController) => findVideoClip(c.getProject(), "a")!.clip;

describe("ClipCameraMoves (React)", () => {
  it("picks moves by role, bakes them into keys and clears them", async () => {
    const c = new VideoEditorController({ project: project(), effects: createFakeEffectProvider({ camera: true }) });
    act(() => root.render(<ClipCameraMoves controller={c} clip="a" />));
    await settle();
    expect([...$<HTMLSelectElement>('select[aria-label="Move in"]').options].map((o) => o.value)).toEqual(["", "fake.glide", "fake.whip"]);
    await change($<HTMLSelectElement>('select[aria-label="While holding"]'), "fake.drift");
    expect(clip(c).camera?.during).toBe("fake.drift");
    expect((clip(c).transform?.scale as { keys: unknown[] }).keys.length).toBeGreaterThan(10);
    expect($('[data-camera-move-controls="hold"]')).not.toBeNull();
    expect($('input[aria-label="Camera zoom"]')).not.toBeNull();
    await change($<HTMLSelectElement>('select[aria-label="While holding"]'), "");
    expect(clip(c).camera).toBeUndefined();
    expect(clip(c).transform).toBeUndefined();
  });

  it("is hidden without camera moves, saying why when the clip has baked ones", async () => {
    const c = new VideoEditorController({ project: project(), effects: createFakeEffectProvider({ camera: true }) });
    await c.setClipCameraMove("a", "hold", "fake.drift");
    c.setEffectsProvider(createFakeEffectProvider());
    act(() => root.render(<ClipCameraMoves controller={c} clip="a" />));
    await settle();
    expect($("select")).toBeNull();
    expect($('[data-camera-moves="unavailable"]').textContent).toMatch(/baked into its keys/);
  });
});
