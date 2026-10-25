// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createFakeEffectProvider,
  createEffectAuthoringSession,
  type EffectAuthoringSession
} from '@pixerate/editor/effects';
import { EffectAuthoringEditor, useEffectAuthoring } from '../src/effects';

let container: HTMLDivElement;
let root: any;

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLCanvasElement.prototype.getContext = (() => ({
    putImageData: vi.fn(),
  })) as any;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    if (root) root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe('EffectAuthoringEditor (React)', () => {
  it('renders parameters and changing a field calls setValue', async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: 'fake.invert' });

    act(() => {
      root.render(<EffectAuthoringEditor session={session} />);
    });
    await flush();

    // Verify parameter is displayed
    const control = container.querySelector('[data-effect-control="amount"]');
    expect(control).not.toBeNull();

    // Change amount via session.setValue directly or input
    act(() => {
      session.setValue('amount', 0.25);
    });
    await flush();

    expect(session.getState().values.amount).toBe(0.25);
  });

  it('enables undo button after a change and undoes it', async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: 'fake.invert' });

    act(() => {
      root.render(<EffectAuthoringEditor session={session} />);
    });
    await flush();

    const undoBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]');
    expect(undoBtn?.disabled).toBe(true);

    act(() => {
      session.setValue('amount', 0.5);
    });
    await flush();

    expect(undoBtn?.disabled).toBe(false);

    act(() => {
      undoBtn?.click();
    });
    await flush();

    expect(session.getState().values.amount).toBe(1);
    expect(undoBtn?.disabled).toBe(true);
  });

  it('hides source pane when sourceLanguage is null, and shows it when supported', async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: 'fake.invert' });

    act(() => {
      root.render(<EffectAuthoringEditor session={session} />);
    });
    await flush();

    // Invert has no source language -> source pane is hidden
    expect(container.querySelector('[data-effect-source-pane]')).toBeNull();

    // Create a mock session with source support
    const setSourceMock = vi.fn(async () => ({ ok: true, issues: [] }));
    const baseState = session.getState();
    const sourceState = {
      ...baseState,
      sourceLanguage: 'glsl' as const,
      source: 'line 1\nline 2\nline 3 error\nline 4',
      issues: [{ severity: 'error' as const, message: 'Syntax error on line 3', line: 3 }]
    };

    const customSession: EffectAuthoringSession = {
      ...session,
      getState: () => sourceState,
      subscribe: () => () => {},
      setSource: setSourceMock
    };

    act(() => {
      root.render(<EffectAuthoringEditor session={customSession} />);
    });
    await flush();

    const sourcePane = container.querySelector('[data-effect-source-pane]');
    expect(sourcePane).not.toBeNull();

    // Line 3 gutter has issue styling
    const gutter3 = container.querySelector('[data-gutter-line="3"]');
    expect(gutter3).not.toBeNull();
    expect(gutter3?.className).toContain('text-destructive');

    // Typing in textarea calls setSource after 300ms debounce
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Effect source code"]');
    expect(textarea).not.toBeNull();

    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      nativeSetter.call(textarea, 'new shader source');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
      textarea!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(setSourceMock).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    expect(setSourceMock).toHaveBeenCalledWith('new shader source');
  });

  it('adds and removes keyframe at the playhead with keyframe diamond', async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: 'fake.invert' });

    act(() => {
      root.render(<EffectAuthoringEditor session={session} />);
    });
    await flush();

    const diamondBtn = container.querySelector<HTMLButtonElement>('button[data-keyframe-toggle="amount"]');
    expect(diamondBtn).not.toBeNull();
    expect(diamondBtn?.textContent).toBe('◇');
    expect(session.getState().tracks.amount).toBeUndefined();

    // Click to add keyframe at playhead (0ms)
    act(() => {
      diamondBtn?.click();
    });
    await flush();

    expect(session.getState().tracks.amount).toHaveLength(1);
    expect(session.getState().tracks.amount[0].time).toBe(0);
    expect(diamondBtn?.textContent).toBe('◆');

    // Click again to remove keyframe at playhead
    act(() => {
      diamondBtn?.click();
    });
    await flush();

    expect(session.getState().tracks.amount).toBeUndefined();
    expect(diamondBtn?.textContent).toBe('◇');
  });

  it('seeks playhead with scrubber', async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: 'fake.invert' });

    act(() => {
      root.render(<EffectAuthoringEditor session={session} />);
    });
    await flush();

    const scrubber = container.querySelector<HTMLInputElement>('input[aria-label="Timeline scrubber"]');
    expect(scrubber).not.toBeNull();

    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      nativeSetter.call(scrubber, '450');
      scrubber!.dispatchEvent(new Event('input', { bubbles: true }));
      scrubber!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(session.getState().time).toBe(450);
    const readout = container.querySelector('[data-time-readout]');
    expect(readout?.textContent).toContain('450ms');
  });

  it('disposes the preview renderer on unmount', async () => {
    const provider = createFakeEffectProvider();
    const session = await provider.openAuthoring!({ effectId: 'fake.invert' });

    const preview = await session.createPreview({ width: 100, height: 100 });
    const disposeSpy = vi.spyOn(preview, 'dispose');
    vi.spyOn(session, 'createPreview').mockResolvedValue(preview);

    act(() => {
      root.render(<EffectAuthoringEditor session={session} />);
    });
    await flush();

    expect(disposeSpy).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
      root = null;
    });

    expect(disposeSpy).toHaveBeenCalled();
  });
  it('draws the latest playhead after the playhead moves while a frame renders', async () => {
    const drawnAt: number[] = [];
    let lastRendered = -1;
    const pending: Array<() => void> = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ putImageData: () => drawnAt.push(lastRendered) })) as any);
    if (typeof (globalThis as any).ImageData === 'undefined') {
      vi.stubGlobal('ImageData', class { constructor(public data: unknown, public width: number, public height: number) {} });
    }
    const session = await createEffectAuthoringSession({ effectId: 'fake.gradient' }, { provider: createFakeEffectProvider(), schedule: () => () => {} });
    const real = await session.createPreview({ width: 4, height: 4 });
    vi.spyOn(session, 'createPreview').mockResolvedValue({
      ...real,
      render: (req) =>
        new Promise((resolve) =>
          pending.push(() => {
            lastRendered = req.time;
            resolve({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
          })
        )
    });

    act(() => {
      root.render(<EffectAuthoringEditor session={session} />);
    });
    await flush();
    expect(pending).toHaveLength(1); // the first frame (0 ms) is in flight

    act(() => session.seek(100));
    act(() => session.seek(200));
    for (let i = 0; i < 4 && pending.length; i++) {
      const next = pending.shift()!;
      await act(async () => {
        next();
        await new Promise((r) => setTimeout(r, 5));
      });
    }

    expect(drawnAt.at(-1)).toBe(200);
    expect(drawnAt).toEqual([0, 200]); // one catch-up frame, not one per change
  });

  it('keeps animated controls editable: a change keys the playhead', async () => {
    const session = await createFakeEffectProvider().openAuthoring!({ effectId: 'fake.invert' });
    session.setKeyframe('amount', 0, 0.2);
    session.setKeyframe('amount', 500, 0.8);
    session.seek(500);

    act(() => {
      root.render(<EffectAuthoringEditor session={session} />);
    });
    await flush();

    const field = container.querySelector<HTMLInputElement>('[data-effect-control="amount"] input');
    expect(field).not.toBeNull();
    expect(field!.disabled).toBe(false);

    act(() => {
      session.setValue('amount', 0.6);
    });
    expect(session.getState().tracks.amount.map((k) => [k.time, k.value])).toEqual([
      [0, 0.2],
      [500, 0.6]
    ]);
  });

  it('commits the duration once, on blur, not on every keystroke', async () => {
    const session = await createFakeEffectProvider().openAuthoring!({ effectId: 'fake.invert' });
    const setTiming = vi.spyOn(session, 'setTiming');
    act(() => {
      root.render(<EffectAuthoringEditor session={session} />);
    });
    await flush();

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Duration"]')!;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    for (const text of ['2', '20', '200', '2000']) {
      act(() => {
        setValue.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    expect(setTiming).not.toHaveBeenCalled();

    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(setTiming).toHaveBeenCalledTimes(1);
    expect(setTiming).toHaveBeenCalledWith({ duration: 2000 });
    expect(session.getState().duration).toBe(2000);
  });
});
