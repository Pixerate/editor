// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AnimationEditorController, type MotionScene } from "@pixerate/editor/animation-editor";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { AnimationStage, ShotLayers, ShotTransition } from "../src/animation-editor";

const SCENE: MotionScene = {
  version: 1,
  name: "demo",
  artwork: { width: 200, height: 100, nodes: [] },
  shots: [
    { id: "intro", run: [], hold: 500 },
    { id: "away", run: [], hold: 500 },
  ],
};

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
async function click(el: HTMLElement) {
  act(() => el.click());
  await settle();
}

describe("ShotLayers (React)", () => {
  it("adds layer effects, opens their controls, restacks and removes them", async () => {
    const c = new AnimationEditorController({ scene: SCENE, effects: createFakeEffectProvider(), layerHost: null });
    act(() => root.render(<ShotLayers controller={c} shot="intro" />));
    await settle();
    const add = $<HTMLSelectElement>('select[aria-label="Add a layer"]');
    expect([...add.options].map((o) => o.value)).toEqual(["", ":picture", ":words", "fake.invert", "fake.tint", "fake.gradient", "fake.bar", "fake.badge"]);
    await change(add, "fake.gradient");
    expect(c.getState().scene.shots[0].layers).toEqual([{ id: "layer1", effect: "fake.gradient", provider: "fake", name: "Gradient" }]);
    expect($('[data-shot-layer-controls="layer1"]')).not.toBeNull();
    await change($<HTMLSelectElement>('select[aria-label="Layer role"]'), "overlay");
    expect(c.getState().scene.shots[0].layers![0].role).toBe("overlay");
    await change($<HTMLSelectElement>('select[aria-label="Add a layer"]'), "fake.tint");
    expect(c.getState().scene.shots[0].layers![1]).toMatchObject({ id: "layer2", effect: "fake.tint", subject: { slot: "picture" } });
    await click($('button[aria-label="Move layer2 down"]'));
    expect(c.getState().scene.shots[0].layers!.map((l) => l.id)).toEqual(["layer2", "layer1"]);
    await click($('button[aria-label="Remove layer1"]'));
    expect(c.getState().scene.shots[0].layers!.map((l) => l.id)).toEqual(["layer2"]);
  });

  it("adds bare words without a provider", async () => {
    const c = new AnimationEditorController({ scene: SCENE, layerHost: null });
    act(() => root.render(<ShotLayers controller={c} shot="intro" />));
    await settle();
    await change($<HTMLSelectElement>('select[aria-label="Add a layer"]'), ":words");
    expect(c.getState().scene.shots[0].layers).toEqual([{ id: "layer1", subject: { text: "Title" }, role: "overlay" }]);
  });
});

describe("ShotTransition (React)", () => {
  it("picks a transition into a later shot and clears it; hidden on the first shot", async () => {
    const c = new AnimationEditorController({ scene: SCENE, effects: createFakeEffectProvider(), layerHost: null });
    act(() => root.render(<ShotTransition controller={c} shot="intro" />));
    await settle();
    expect($("select")).toBeNull();
    act(() => root.render(<ShotTransition controller={c} shot="away" />));
    await settle();
    const pick = $<HTMLSelectElement>('select[aria-label="Transition in"]');
    expect([...pick.options].map((o) => o.value)).toEqual(["", "fake.crossfade"]);
    await change(pick, "fake.crossfade");
    expect(c.getState().scene.shots[1].transition).toEqual({ effect: "fake.crossfade", ms: 800, provider: "fake", name: "Crossfade" });
    expect($("[data-shot-transition-controls]")).not.toBeNull();
    await change($<HTMLSelectElement>('select[aria-label="Transition in"]'), "");
    expect(c.getState().scene.shots[1].transition).toBeUndefined();
  });
});

describe("AnimationStage (React) with shot layers", () => {
  it("draws a layer's picture once the engine has rendered it", async () => {
    const host = {
      rasterize: async (_svg: string, width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      encode: () => "data:image/png;base64,PICTURE",
      loadImage: async (url: string) => url,
    };
    const scene: MotionScene = { ...SCENE, shots: [{ id: "intro", run: [], hold: 500, layers: [{ id: "sky", effect: "fake.gradient" }] }] };
    const c = new AnimationEditorController({ scene, effects: createFakeEffectProvider(), layerHost: host });
    act(() => root.render(<AnimationStage controller={c} />));
    await act(async () => {
      await c.layers.idle();
    });
    await settle();
    expect(container.innerHTML).toContain('data-layer="sky"');
  });
});
