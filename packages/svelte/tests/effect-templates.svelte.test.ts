import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { AnimationEditorController } from "@pixerate/editor/animation-editor";
import { VideoEditorController } from "@pixerate/editor/video-editor";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { EffectTemplates } from "../src/effects";
import { AnimationEffectsPanel } from "../src/animation-editor";
import { VideoEffectsPanel } from "../src/video-editor";

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
const q = <T extends Element = HTMLElement>(sel: string) => target.querySelector(sel) as T;
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
async function change(el: HTMLSelectElement | HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  await settle();
}
const provider = createFakeEffectProvider({ templates: true });

describe("EffectTemplates (Svelte)", () => {
  it("builds a form from the slots, checks values as you type and fills", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    render(EffectTemplates, { provider, onfill: async (t: string, v: Record<string, unknown>) => (calls.push([t, v]), { ok: true }) });
    await settle();
    await change(q('select[aria-label="Template"]'), "fake.title-sequence");
    expect([...target.querySelectorAll("[data-template-slot]")].map((e) => e.getAttribute("data-template-slot"))).toEqual(["title", "subtitle", "accent", "holdMs"]);
    await change(q("#template-slot-holdMs"), "20");
    expect(q('[data-template-slot="holdMs"]').textContent).toContain("20 is out of range");
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    await change(q("#template-slot-holdMs"), "1500");
    await change(q("#template-slot-title"), "Launch");
    q<HTMLFormElement>("form").requestSubmit();
    await settle();
    expect(calls).toEqual([["fake.title-sequence", { title: "Launch", subtitle: "See you soon", accent: "#0ea5e9", holdMs: 1500 }]]);
    expect(q("form")).toBeNull();
  });

  it("is hidden without templates", async () => {
    render(EffectTemplates, { provider: createFakeEffectProvider(), onfill: async () => ({ ok: true }) });
    await settle();
    expect(q("[data-effect-templates]")).toBeNull();
  });

  it("fills a new animation scene and inserts clips in the video editor", async () => {
    const anim = new AnimationEditorController({ effects: provider, layerHost: null });
    render(AnimationEffectsPanel, { controller: anim });
    await settle();
    await change(q('select[aria-label="Template"]'), "fake.picture-reveal");
    q<HTMLFormElement>("form").requestSubmit();
    await settle();
    expect(anim.getState().scene.shots.map((s) => s.id)).toEqual(["shot1", "shot2"]);

    const video = new VideoEditorController({ effects: provider });
    render(VideoEffectsPanel, { controller: video });
    await settle();
    await change(q('select[aria-label="Template"]'), "fake.title-sequence");
    q<HTMLFormElement>("form").requestSubmit();
    await settle();
    expect(video.getState().project.tracks.some((t) => t.id.startsWith("tpl-v"))).toBe(true);
  });
});
