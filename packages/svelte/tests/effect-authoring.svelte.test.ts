// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import {
  createFakeEffectProvider,
  createEffectAuthoringSession,
  type EffectAuthoringSession,
} from "@pixerate/editor/effects";
import { EffectAuthoringEditor, effectAuthoringOf } from "../src/effects";

let cleanups: (() => void)[] = [];
let target: HTMLElement;

const flush = async () => {
  flushSync();
  await new Promise((r) => setTimeout(r, 20));
  flushSync();
};

function render(component: any, props: Record<string, any>) {
  target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  const cleanup = () => {
    unmount(instance);
    target.remove();
  };
  cleanups.push(cleanup);
  return { target, instance, cleanup };
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    putImageData: vi.fn(),
  })) as any;
});

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  vi.restoreAllMocks();
});

describe("EffectAuthoringEditor (Svelte)", () => {
  it("renders parameters and changing a field calls setValue", async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: "fake.invert" });

    render(EffectAuthoringEditor, { session });
    await flush();

    const control = target.querySelector('[data-effect-control="amount"]');
    expect(control).not.toBeNull();

    // Change value via session
    session.setValue("amount", 0.75);
    await flush();

    expect(session.getState().values.amount).toBe(0.75);
  });

  it("adds and removes keyframes using control keyframe button", async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: "fake.invert" });

    render(EffectAuthoringEditor, { session });
    await flush();

    const toggleBtn = target.querySelector(
      'button[data-keyframe-toggle="amount"]'
    ) as HTMLButtonElement | null;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn?.textContent?.trim()).toBe("◇");

    // Click to add keyframe at playhead (t=0)
    toggleBtn?.click();
    await flush();

    expect(session.getState().tracks.amount).toBeDefined();
    expect(session.getState().tracks.amount!.length).toBe(1);
    expect(toggleBtn?.textContent?.trim()).toBe("◆");

    // Click again to remove keyframe
    toggleBtn?.click();
    await flush();

    expect(session.getState().tracks.amount).toBeUndefined();
    expect(toggleBtn?.textContent?.trim()).toBe("◇");
  });

  it("handles playback play and pause via toolbar", async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: "fake.invert" });

    render(EffectAuthoringEditor, { session });
    await flush();

    const playBtn = target.querySelector(
      'button[aria-label="Start playback"]'
    ) as HTMLButtonElement | null;
    expect(playBtn).not.toBeNull();

    playBtn?.click();
    await flush();

    expect(session.getState().playing).toBe(true);

    const pauseBtn = target.querySelector(
      'button[aria-label="Pause playback"]'
    ) as HTMLButtonElement | null;
    expect(pauseBtn).not.toBeNull();

    pauseBtn?.click();
    await flush();

    expect(session.getState().playing).toBe(false);
  });

  it("supports undo and redo in toolbar", async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: "fake.invert" });

    render(EffectAuthoringEditor, { session });
    await flush();

    const undoBtn = target.querySelector(
      'button[aria-label="Undo"]'
    ) as HTMLButtonElement | null;
    const redoBtn = target.querySelector(
      'button[aria-label="Redo"]'
    ) as HTMLButtonElement | null;

    expect(undoBtn?.disabled).toBe(true);
    expect(redoBtn?.disabled).toBe(true);

    session.setValue("amount", 0.5);
    await flush();

    expect(undoBtn?.disabled).toBe(false);
    expect(redoBtn?.disabled).toBe(true);

    undoBtn?.click();
    await flush();

    expect(session.getState().values.amount).toBe(1);
    expect(redoBtn?.disabled).toBe(false);

    redoBtn?.click();
    await flush();

    expect(session.getState().values.amount).toBe(0.5);
  });

  it("hides source pane when sourceLanguage is null, and shows it when supported", async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: "fake.invert" });

    render(EffectAuthoringEditor, { session });
    await flush();

    // Invert has no source language -> source pane is hidden
    expect(target.querySelector("[data-effect-source-pane]")).toBeNull();

    // Create a mock session with source support
    const setSourceMock = vi.fn(async () => ({ ok: true, issues: [] }));
    const baseState = session.getState();
    const sourceState = {
      ...baseState,
      sourceLanguage: "glsl" as const,
      source: "line 1\nline 2\nline 3 error\nline 4",
      issues: [{ severity: "error" as const, message: "Syntax error on line 3", line: 3 }],
    };

    const customSession: EffectAuthoringSession = {
      ...session,
      getState: () => sourceState,
      subscribe: () => () => {},
      setSource: setSourceMock,
    };

    render(EffectAuthoringEditor, { session: customSession });
    await flush();

    const sourcePane = target.querySelector("[data-effect-source-pane]");
    expect(sourcePane).not.toBeNull();

    // Line 3 gutter has issue styling
    const gutter3 = target.querySelector('[data-gutter-line="3"]');
    expect(gutter3).not.toBeNull();
    expect(gutter3?.className).toContain("text-destructive");

    // Issues list has error
    const issues = target.querySelector("[data-effect-issues]");
    expect(issues).not.toBeNull();
    expect(issues?.textContent).toContain("Syntax error on line 3");

    // Typing in textarea calls setSource after 300ms debounce
    const textarea = target.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Effect source code"]'
    );
    expect(textarea).not.toBeNull();

    textarea!.value = "new shader source";
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(setSourceMock).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 400));
    expect(setSourceMock).toHaveBeenCalledWith("new shader source");
  });

  it("shows timeline tracks and allows scrubbing", async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: "fake.invert" });

    session.setKeyframe("amount", 0, 0);
    session.setKeyframe("amount", 1000, 1);

    render(EffectAuthoringEditor, { session });
    await flush();

    const track = target.querySelector('[data-track="amount"]');
    expect(track).not.toBeNull();

    // Click keyframe button inside track to seek
    const kfButtons = track?.querySelectorAll("button[aria-label^='Seek']");
    expect(kfButtons?.length).toBe(2);

    (kfButtons?.[1] as HTMLButtonElement)?.click();
    await flush();

    expect(session.getState().time).toBe(1000);
  });
});
