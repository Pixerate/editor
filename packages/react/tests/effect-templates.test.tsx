// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AnimationEditorController } from "@pixerate/editor/animation-editor";
import { VideoEditorController } from "@pixerate/editor/video-editor";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { EffectTemplates } from "../src/effects";
import { AnimationEffectsPanel } from "../src/animation-editor";
import { VideoEffectsPanel } from "../src/video-editor";

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
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
async function change(el: HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await settle();
}
const provider = createFakeEffectProvider({ templates: true });

describe("EffectTemplates (React)", () => {
  it("builds a form from the slots, checks values as you type and fills", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    act(() => root.render(<EffectTemplates provider={provider} onFill={async (t, v) => (calls.push([t, v]), { ok: true })} />));
    await settle();
    await change($('select[aria-label="Template"]'), "fake.title-sequence");
    expect([...container.querySelectorAll("[data-template-slot]")].map((e) => e.getAttribute("data-template-slot"))).toEqual(["title", "subtitle", "accent", "holdMs"]);
    await change($("#template-slot-holdMs"), "20");
    expect($('[data-template-slot="holdMs"]').textContent).toContain("20 is out of range");
    expect($<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    await change($("#template-slot-holdMs"), "1500");
    await change($("#template-slot-title"), "Launch");
    act(() => $<HTMLFormElement>("form").requestSubmit());
    await settle();
    expect(calls).toEqual([["fake.title-sequence", { title: "Launch", subtitle: "See you soon", accent: "#0ea5e9", holdMs: 1500 }]]);
    expect($("form")).toBeNull();
  });

  it("is hidden without templates", async () => {
    act(() => root.render(<EffectTemplates provider={createFakeEffectProvider()} onFill={async () => ({ ok: true })} />));
    await settle();
    expect($("[data-effect-templates]")).toBeNull();
  });

  it("fills a new animation scene and inserts clips in the video editor", async () => {
    const anim = new AnimationEditorController({ effects: provider, layerHost: null });
    act(() => root.render(<AnimationEffectsPanel controller={anim} />));
    await settle();
    await change($('select[aria-label="Template"]'), "fake.picture-reveal");
    act(() => $<HTMLFormElement>("form").requestSubmit());
    await settle();
    expect(anim.getState().scene.shots.map((s) => s.id)).toEqual(["shot1", "shot2"]);

    const video = new VideoEditorController({ effects: provider });
    act(() => root.render(<VideoEffectsPanel controller={video} />));
    await settle();
    await change($('select[aria-label="Template"]'), "fake.title-sequence");
    act(() => $<HTMLFormElement>("form").requestSubmit());
    await settle();
    expect(video.getState().project.tracks.some((t) => t.id.startsWith("tpl-v"))).toBe(true);
  });
});
