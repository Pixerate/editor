// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ManualClock } from "@pixerate/editor/animation";
import { createFakeEffectProvider, type EffectProvider } from "@pixerate/editor/effects";
import { VideoEditorController, type VideoProject } from "@pixerate/editor/video-editor";
import { EffectParameters, EffectsBrowser, useEffects } from "../src/effects";
import { VideoEditor, VideoEffectsPanel, useVideoEffectsTools } from "../src/video-editor";

const PROJECT: VideoProject = {
  version: 1,
  width: 64,
  height: 36,
  fps: 30,
  assets: [],
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        { id: "a", type: "color", color: "#000000", start: 0, duration: 1000 },
        { id: "b", type: "color", color: "#ffffff", start: 1000, duration: 1000 },
      ],
    },
  ],
};

let container: HTMLDivElement;
let root: any;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const $ = <T extends Element = HTMLElement>(sel: string) => {
  const el = container.querySelector<T>(sel);
  if (!el) throw new Error(`No element for ${sel}`);
  return el;
};
const click = (el: Element) => act(() => void (el as HTMLElement).click());
const buttonByText = (text: string) => {
  const b = [...container.querySelectorAll("button")].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`No button "${text}"`);
  return b;
};
const make = (effects?: EffectProvider) => new VideoEditorController({ project: PROJECT, clock: new ManualClock(), effects });

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("effects (React)", () => {
  it("VideoEditor without a provider is as before: no effects panel, no provider", () => {
    const c = make();
    act(() => root.render(<VideoEditor controller={c} showTranscript={false} />));
    expect(container.querySelector("[data-video-effects]")).toBeNull();
    expect(c.getState().effectsProvider).toBeNull();
  });

  it("VideoEditor registers the provider while mounted and shows the effects panel", () => {
    const c = make();
    const provider = createFakeEffectProvider();
    act(() => root.render(<VideoEditor controller={c} effects={provider} showTranscript={false} />));
    expect(c.effectsProvider).toBe(provider);
    expect(container.querySelector("[data-video-effects]")).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    expect(c.effectsProvider).toBeNull();
  });

  it("useEffects follows the provider prop", () => {
    const c = make();
    const a = createFakeEffectProvider();
    function Probe({ p }: { p: EffectProvider | null }) {
      useEffects(c, p);
      return null;
    }
    act(() => root.render(<Probe p={a} />));
    expect(c.effectsProvider).toBe(a);
    act(() => root.render(<Probe p={null} />));
    expect(c.effectsProvider).toBeNull();
  });

  it("EffectsBrowser lists, filters and picks effects, and says when there is no provider", async () => {
    const onPick = vi.fn();
    act(() => root.render(<EffectsBrowser provider={createFakeEffectProvider()} uses={["filter", "overlay"]} onPick={onPick} thumbnails={false} />));
    await flush();
    const ids = () => [...container.querySelectorAll("[data-effect-id]")].map((b) => b.getAttribute("data-effect-id"));
    expect(ids()).toEqual(["fake.invert", "fake.tint", "fake.bar"]);
    const search = $<HTMLInputElement>('input[type="search"]');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "tint");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(ids()).toEqual(["fake.tint"]);
    await click($('[data-effect-id="fake.tint"]'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "fake.tint" }));
    act(() => root.render(<EffectsBrowser provider={null} onPick={onPick} />));
    expect(container.querySelector("[data-effects-unavailable]")?.textContent).toMatch(/No effects provider/);
  });

  it("EffectParameters builds controls from the JSON Schema and reports changes", async () => {
    const provider = createFakeEffectProvider();
    const description = await provider.describe("fake.crossfade");
    const onChange = vi.fn();
    act(() => root.render(<EffectParameters description={description} values={{ curve: "smooth" }} onChange={onChange} />));
    expect($('[data-effect-control="curve"]')).toBeTruthy();
    await click([...container.querySelectorAll("[role=radiogroup] button")].find((b) => b.textContent?.toLowerCase() === "linear")!);
    expect(onChange).toHaveBeenCalledWith("curve", "linear", null);
    const tint = await provider.describe("fake.tint");
    act(() => root.render(<EffectParameters description={tint} values={{ amount: { keys: [] } }} keyframed={new Set(["amount"])} onChange={onChange} />));
    expect(container.querySelectorAll("[data-effect-control]").length).toBe(2);
    expect($('[data-effect-control="amount"]').textContent).toMatch(/keyframed/);
  });

  it("VideoEffectsPanel adds, turns off, reorders and removes clip effects as undo steps", async () => {
    const c = make(createFakeEffectProvider());
    c.select(["a"]);
    act(() => root.render(<VideoEffectsPanel controller={c} />));
    await click(buttonByText("Add effect…"));
    await flush();
    await click($('[data-effect-id="fake.tint"]'));
    await flush();
    expect(c.getProject().tracks[0].clips[0].effects?.map((e) => e.effect)).toEqual(["fake.tint"]);
    await click(buttonByText("Add effect…"));
    await flush();
    await click($('[data-effect-id="fake.invert"]'));
    await flush();
    await click(container.querySelectorAll('[aria-label="Move up"]')[1]);
    await flush();
    expect(c.getProject().tracks[0].clips[0].effects?.map((e) => e.id)).toEqual(["fx2", "fx1"]);
    await click($<HTMLInputElement>('[aria-label="Tint on"]'));
    await flush();
    expect(c.getProject().tracks[0].clips[0].effects?.[1].enabled).toBe(false);
    await click($('[aria-label="Remove Invert"]'));
    await flush();
    expect(c.getProject().tracks[0].clips[0].effects?.map((e) => e.id)).toEqual(["fx1"]);
    expect(c.history.getState().undoName).toBe("Remove effect Invert");
  });

  it("VideoEffectsPanel sets effect transitions and adds effect clips at the playhead", async () => {
    const c = make(createFakeEffectProvider());
    c.select(["b"]);
    act(() => root.render(<VideoEffectsPanel controller={c} />));
    await click(buttonByText("Effect transition…"));
    await flush();
    await click($('[data-effect-id="fake.crossfade"]'));
    await flush();
    expect(c.getProject().tracks[0].clips[1].transition).toMatchObject({ type: "effect", effect: { effect: "fake.crossfade" } });
    act(() => c.seek(2000));
    await click(buttonByText("Add effect clip"));
    await flush();
    await click($('[data-effect-id="fake.gradient"]'));
    await flush();
    const added = c.getProject().tracks[0].clips[2];
    expect(added).toMatchObject({ type: "effect", effect: "fake.gradient", start: 2000 });
    expect(c.getState().selection).toEqual([added.id]);
  });

  it("useVideoEffectsTools registers the effect tools", async () => {
    const registry = new ToolRegistry();
    const c = make(createFakeEffectProvider());
    function Probe() {
      useVideoEffectsTools(registry, c, { namespace: "fx" });
      return null;
    }
    act(() => root.render(<Probe />));
    expect(registry.listTools().tools.map((t) => t.name)).toContain("fx__apply_effect");
    const r = await act(async () => registry.callTool("fx__apply_effect", { target: "a", effect: "fake.invert" }));
    expect(r.isError).toBeFalsy();
  });
});
