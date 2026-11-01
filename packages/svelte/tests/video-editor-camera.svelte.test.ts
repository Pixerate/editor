import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { VideoEditorController, findVideoClip, parseVideoProject } from "@pixerate/editor/video-editor";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { ClipCameraMoves } from "../src/video-editor";

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
  cleanups.push(() => {
    unmount(instance);
    target.remove();
  });
}

const project = () =>
  parseVideoProject({ version: 1, width: 320, height: 180, fps: 25, assets: [], tracks: [{ id: "v1", kind: "video", clips: [{ id: "a", type: "color", color: "#000000", start: 0, duration: 2000 }] }] });
const q = <T extends Element = HTMLElement>(sel: string) => target.querySelector(sel) as T;
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
async function change(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}
const clip = (c: VideoEditorController) => findVideoClip(c.getProject(), "a")!.clip;

describe("ClipCameraMoves (Svelte)", () => {
  it("picks moves by role, bakes them into keys and clears them", async () => {
    const c = new VideoEditorController({ project: project(), effects: createFakeEffectProvider({ camera: true }) });
    render(ClipCameraMoves, { controller: c, clip: "a" });
    await settle();
    expect([...q<HTMLSelectElement>('select[aria-label="Move in"]').options].map((o) => o.value)).toEqual(["", "fake.glide", "fake.whip"]);
    await change(q<HTMLSelectElement>('select[aria-label="While holding"]'), "fake.drift");
    expect(clip(c).camera?.during).toBe("fake.drift");
    expect((clip(c).transform?.scale as { keys: unknown[] }).keys.length).toBeGreaterThan(10);
    expect(q('[data-camera-move-controls="hold"]')).not.toBeNull();
    expect(q('input[aria-label="Camera zoom"]')).not.toBeNull();
    await change(q<HTMLSelectElement>('select[aria-label="While holding"]'), "");
    expect(clip(c).camera).toBeUndefined();
    expect(clip(c).transform).toBeUndefined();
  });

  it("is hidden without camera moves, saying why when the clip has baked ones", async () => {
    const c = new VideoEditorController({ project: project(), effects: createFakeEffectProvider({ camera: true }) });
    await c.setClipCameraMove("a", "hold", "fake.drift");
    c.setEffectsProvider(createFakeEffectProvider());
    render(ClipCameraMoves, { controller: c, clip: "a" });
    await settle();
    expect(q("select")).toBeNull();
    expect(q('[data-camera-moves="unavailable"]').textContent).toMatch(/baked into its keys/);
  });
});
