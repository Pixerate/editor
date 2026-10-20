import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { ManualClock } from "@pixerate/editor/animation";
import { AnimationEditorController } from "@pixerate/editor/animation-editor";
import { VectorEditorController, rectSubpath, type VectorGroupNode } from "@pixerate/editor/vector";
import { AnimationEditor, AnimationEffectsPanel } from "../src/animation-editor";
import { EffectThumbnail } from "../src/effects";
import { VectorProviderEffectsPanel } from "../src/vector";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});
beforeAll(() => {
  window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
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
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};
const click = async (el: Element) => {
  (el as HTMLElement).click();
  flushSync();
  await settle();
};
const button = (text: string) => [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const q = (sel: string) => target.querySelector(sel)!;
const artwork = { width: 200, height: 100, background: "#fff", nodes: [{ id: "box", type: "path" as const, fill: "#f00", subpaths: [rectSubpath({ x: 10, y: 10, width: 30, height: 30 })] }] };
const anim = (effects: ReturnType<typeof createFakeEffectProvider> | null = createFakeEffectProvider()) =>
  new AnimationEditorController({ scene: { version: 1, name: "t", artwork, shots: [] }, clock: new ManualClock(), effects });

describe("motion effects (Svelte)", () => {
  it("EffectThumbnail settles on No preview when the provider cannot draw the effect", async () => {
    const provider = createFakeEffectProvider();
    const effect = (await provider.list()).find((e) => e.id === "fake.badge")!;
    render(EffectThumbnail, { provider, effect });
    await settle();
    expect(target.textContent).toMatch(/No preview/);
  });

  it("AnimationEditor shows the effects panel only with a provider", () => {
    render(AnimationEditor, { controller: anim(null) });
    expect(target.querySelector("[data-animation-effects]")).toBeNull();
    const c = anim(null);
    const provider = createFakeEffectProvider();
    render(AnimationEditor, { controller: c, effects: provider });
    expect(c.effectsProvider).toBe(provider);
    expect(target.querySelector("[data-animation-effects]")).not.toBeNull();
  });

  it("AnimationEffectsPanel animates a node, adds a vector effect and removes them", async () => {
    const c = anim();
    render(AnimationEffectsPanel, { controller: c, node: "box" });
    await click(button("Animate…"));
    await click(q('[data-effect-id="fake.fade-in"]'));
    expect(c.appliedEffects().map((e) => [e.instance, e.kind, e.targets])).toEqual([["fx1", "motion", ["box"]]]);
    await click(button("Vector effect…"));
    await click(q('[data-effect-id="fake.badge"]'));
    expect(c.appliedEffects().map((e) => e.kind)).toEqual(["motion", "vector"]);
    await click(q('[aria-label="Remove Fade in"]'));
    expect(c.appliedEffects().map((e) => e.instance)).toEqual(["fx2"]);
  });

  it("VectorProviderEffectsPanel adds a vector effect group and detaches it", async () => {
    const c = new VectorEditorController({ document: artwork });
    c.setEffectsProvider(createFakeEffectProvider());
    render(VectorProviderEffectsPanel, { controller: c });
    await click(button("Add effect…"));
    expect([...target.querySelectorAll("[data-effect-id]")].map((b) => b.getAttribute("data-effect-id"))).toEqual(["fake.badge"]);
    await click(q('[data-effect-id="fake.badge"]'));
    const g = c.vectorEffectGroups()[0] as VectorGroupNode;
    expect(g.providerEffect?.effect).toBe("fake.badge");
    await click(button("Detach"));
    expect(c.vectorEffectGroups()).toEqual([]);
  });
});
