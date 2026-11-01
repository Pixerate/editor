// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AnimationEditorController, type MotionScene } from "@pixerate/editor/animation-editor";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { AnimationStage, ShotCameraMoves } from "../src/animation-editor";

const square = (x: number) => [{ closed: true, anchors: [{ x, y: 10 }, { x: x + 40, y: 10 }, { x: x + 40, y: 50 }, { x, y: 50 }] }];
const SCENE: MotionScene = {
  version: 1,
  name: "demo",
  artwork: { width: 200, height: 100, nodes: [{ id: "box", type: "path", fill: "#ef4444", subpaths: square(10) }, { id: "dot", type: "path", fill: "#0ea5e9", subpaths: square(120) }] },
  shots: [
    { id: "intro", camera: { x: 0, y: 0, width: 100, height: 50 }, run: [], hold: 500 },
    { id: "away", camera: { x: 100, y: 50, width: 100, height: 50 }, run: [], hold: 500 },
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

describe("ShotCameraMoves (React)", () => {
  it("picks moves by role, shows their controls and clears them", async () => {
    const c = new AnimationEditorController({ scene: SCENE, effects: createFakeEffectProvider({ camera: true }) });
    act(() => root.render(<ShotCameraMoves controller={c} shot="away" />));
    await settle();
    const moveIn = $<HTMLSelectElement>('select[aria-label="Move in"]');
    expect([...moveIn.options].map((o) => o.value)).toEqual(["", "fake.glide", "fake.whip"]);
    expect([...$<HTMLSelectElement>('select[aria-label="While holding"]').options].map((o) => o.value)).toEqual(["", "fake.drift"]);
    await change(moveIn, "fake.whip");
    expect(c.getState().scene.shots[1].camera).toMatchObject({ in: { move: "fake.whip", ms: 400 } });
    expect($('[data-camera-move-controls="transition"]')).not.toBeNull();
    await change($<HTMLSelectElement>('select[aria-label="While holding"]'), "fake.drift");
    expect(c.getState().scene.shots[1].camera?.during).toBe("fake.drift");
    await change($<HTMLSelectElement>('select[aria-label="Move in"]'), "");
    expect(c.getState().scene.shots[1].camera).toEqual({ x: 100, y: 50, width: 100, height: 50, during: "fake.drift" });
  });

  it("is hidden without camera moves, saying why when the shot names some", async () => {
    const c = new AnimationEditorController({ scene: { ...SCENE, shots: [SCENE.shots[0], { ...SCENE.shots[1], camera: { ...SCENE.shots[1].camera!, in: "fake.whip" } as never }] }, effects: createFakeEffectProvider() });
    act(() => root.render(<ShotCameraMoves controller={c} shot="away" />));
    await settle();
    expect($("select")).toBeNull();
    expect($('[data-camera-moves="unavailable"]').textContent).toMatch(/has none, so the camera eases instead/);
  });

  it("the stage plays the move", async () => {
    const c = new AnimationEditorController({ scene: { ...SCENE, shots: [SCENE.shots[0], { ...SCENE.shots[1], camera: { ...SCENE.shots[1].camera!, in: { move: "fake.whip", ms: 400 } } as never }] }, effects: createFakeEffectProvider({ camera: true }) });
    c.seek(600);
    act(() => root.render(<AnimationStage controller={c} />));
    const r = (n: number) => Math.round(n * 1000) / 1000;
    expect($("[data-animation-stage] svg").getAttribute("viewBox")).toBe(`${r(c.frame(600).camera.x)} ${r(c.frame(600).camera.y)} 100 50`);
    expect($("[data-animation-stage] svg").innerHTML).toContain("camera-blur");
  });
});
