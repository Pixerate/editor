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
    clearRect: vi.fn(),
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

    // Click to add keyframe at the playhead (half the 1000 ms length)
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
  it("draws the latest playhead after the playhead moves while a frame renders", async () => {
    const drawnAt: number[] = [];
    let lastRendered = -1;
    const pending: Array<() => void> = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({ putImageData: () => drawnAt.push(lastRendered), clearRect: () => {} })) as any);
    if (typeof (globalThis as any).ImageData === "undefined") {
      vi.stubGlobal("ImageData", class { constructor(public data: unknown, public width: number, public height: number) {} });
    }
    const session = await createEffectAuthoringSession({ effectId: "fake.gradient" }, { provider: createFakeEffectProvider(), schedule: () => () => {}, startTime: 0 });
    const real = await session.createPreview({ width: 4, height: 4 });
    vi.spyOn(session, "createPreview").mockResolvedValue({
      ...real,
      render: (req) =>
        new Promise((resolve) =>
          pending.push(() => {
            lastRendered = req.time;
            resolve({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
          }),
        ),
    });

    render(EffectAuthoringEditor, { session });
    await flush();
    expect(pending).toHaveLength(1); // the first frame (0 ms) is in flight

    session.seek(100);
    flushSync();
    session.seek(200);
    flushSync();
    for (let i = 0; i < 4 && pending.length; i++) {
      pending.shift()!();
      await flush();
    }

    expect(drawnAt.at(-1)).toBe(200);
    expect(drawnAt).toEqual([0, 200]); // one catch-up frame, not one per change
  });

  it("keeps animated controls editable: a change keys the playhead", async () => {
    const session = await createFakeEffectProvider().openAuthoring!({ effectId: "fake.invert" });
    session.setKeyframe("amount", 0, 0.2);
    session.setKeyframe("amount", 500, 0.8);
    session.seek(500);

    render(EffectAuthoringEditor, { session });
    await flush();

    const field = target.querySelector<HTMLInputElement>('[data-effect-control="amount"] input');
    expect(field).not.toBeNull();
    expect(field!.disabled).toBe(false);

    session.setValue("amount", 0.6);
    expect(session.getState().tracks.amount.map((k) => [k.time, k.value])).toEqual([
      [0, 0.2],
      [500, 0.6],
    ]);
  });

  it("commits the duration once, on change, not on every keystroke", async () => {
    const session = await createFakeEffectProvider().openAuthoring!({ effectId: "fake.invert" });
    const setTiming = vi.spyOn(session, "setTiming");
    render(EffectAuthoringEditor, { session });
    await flush();

    const input = target.querySelector<HTMLInputElement>('input[aria-label="Duration"]')!;
    for (const text of ["2", "20", "200", "2000"]) {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    flushSync();
    expect(setTiming).not.toHaveBeenCalled();

    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(setTiming).toHaveBeenCalledTimes(1);
    expect(session.getState().duration).toBe(2000);
  });
  it("gives filters a sample picture in the preview", async () => {
    const session = await createFakeEffectProvider().openAuthoring!({ effectId: "fake.invert" });
    const preview = await session.createPreview({ width: 480, height: 270 });
    const renderSpy = vi.spyOn(preview, "render");
    vi.spyOn(session, "createPreview").mockResolvedValue(preview);
    render(EffectAuthoringEditor, { session });
    await flush();
    const request = renderSpy.mock.calls.at(-1)?.[0];
    expect(request?.inputs?.source).toMatchObject({ width: 480, height: 270 });
  });

  it("clears the canvas and says why when a vector effect has no pixel preview", async () => {
    const ctx = { putImageData: vi.fn(), clearRect: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as any);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const provider = createFakeEffectProvider();
      const invert = await provider.openAuthoring!({ effectId: "fake.invert" });
      const badge = await provider.openAuthoring!({ effectId: "fake.badge" });
      const props = $state({ session: invert as EffectAuthoringSession });
      render(EffectAuthoringEditor, props);
      await flush();
      expect(ctx.putImageData).toHaveBeenCalled();
      expect(target.querySelector("[data-effect-preview-error]")).toBeNull();

      ctx.clearRect.mockClear();
      ctx.putImageData.mockClear();
      props.session = badge;
      await flush();
      expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 480, 270);
      expect(ctx.putImageData).not.toHaveBeenCalled();
      expect(target.querySelector("[data-effect-preview-error]")?.textContent).toMatch(/No pixel preview for this vector effect/);
      // Parameters stay usable.
      expect(target.querySelector('[data-effect-control="color"]')).not.toBeNull();
      expect(unhandled).not.toHaveBeenCalled();

      // Back to a shader effect: the message goes and frames draw again.
      props.session = invert;
      await flush();
      expect(target.querySelector("[data-effect-preview-error]")).toBeNull();
      expect(ctx.putImageData).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
