import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { AnimationEditorController, type MotionScene } from "@pixerate/editor/animation-editor";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { ShotLayers, ShotTransition } from "../src/animation-editor";

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

const SCENE: MotionScene = {
  version: 1,
  name: "demo",
  artwork: { width: 200, height: 100, nodes: [] },
  shots: [
    { id: "intro", run: [], hold: 500 },
    { id: "away", run: [], hold: 500 },
  ],
};

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
async function click(el: HTMLElement) {
  el.click();
  await settle();
}

describe("ShotLayers (Svelte)", () => {
  it("adds layer effects, opens their controls, restacks and removes them", async () => {
    const c = new AnimationEditorController({ scene: SCENE, effects: createFakeEffectProvider(), layerHost: null });
    render(ShotLayers, { controller: c, shot: "intro" });
    await settle();
    const add = q<HTMLSelectElement>('select[aria-label="Add a layer"]');
    expect([...add.options].map((o) => o.value)).toEqual(["", ":picture", ":words", "fake.invert", "fake.tint", "fake.gradient", "fake.bar", "fake.badge", "fake.trail", "fake.route"]);
    await change(add, "fake.gradient");
    expect(c.getState().scene.shots[0].layers).toEqual([{ id: "layer1", effect: "fake.gradient", provider: "fake", name: "Gradient" }]);
    expect(q('[data-shot-layer-controls="layer1"]')).not.toBeNull();
    await change(q<HTMLSelectElement>('select[aria-label="Layer role"]'), "overlay");
    expect(c.getState().scene.shots[0].layers![0].role).toBe("overlay");
    await change(q<HTMLSelectElement>('select[aria-label="Add a layer"]'), "fake.tint");
    expect(c.getState().scene.shots[0].layers![1]).toMatchObject({ id: "layer2", effect: "fake.tint", subject: { slot: "picture" } });
    await click(q('button[aria-label="Move layer2 down"]'));
    expect(c.getState().scene.shots[0].layers!.map((l) => l.id)).toEqual(["layer2", "layer1"]);
    await click(q('button[aria-label="Remove layer1"]'));
    expect(c.getState().scene.shots[0].layers!.map((l) => l.id)).toEqual(["layer2"]);
  });

  it("adds bare words without a provider", async () => {
    const c = new AnimationEditorController({ scene: SCENE, layerHost: null });
    render(ShotLayers, { controller: c, shot: "intro" });
    await settle();
    await change(q<HTMLSelectElement>('select[aria-label="Add a layer"]'), ":words");
    expect(c.getState().scene.shots[0].layers).toEqual([{ id: "layer1", subject: { text: "Title" }, role: "overlay" }]);
  });
});

describe("ShotTransition (Svelte)", () => {
  it("picks a transition into a later shot and clears it; hidden on the first shot", async () => {
    const c = new AnimationEditorController({ scene: SCENE, effects: createFakeEffectProvider(), layerHost: null });
    render(ShotTransition, { controller: c, shot: "intro" });
    await settle();
    expect(q("select")).toBeNull();
    render(ShotTransition, { controller: c, shot: "away" });
    await settle();
    const pick = q<HTMLSelectElement>('select[aria-label="Transition in"]');
    expect([...pick.options].map((o) => o.value)).toEqual(["", "fake.crossfade"]);
    await change(pick, "fake.crossfade");
    expect(c.getState().scene.shots[1].transition).toEqual({ effect: "fake.crossfade", ms: 800, provider: "fake", name: "Crossfade" });
    expect(q("[data-shot-transition-controls]")).not.toBeNull();
    await change(q<HTMLSelectElement>('select[aria-label="Transition in"]'), "");
    expect(c.getState().scene.shots[1].transition).toBeUndefined();
  });
});
