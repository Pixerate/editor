import { describe, it, expect, vi } from 'vitest';
import {
  createEffectAuthoringSession,
  EffectAuthoringSession,
  EffectAuthoringDocument,
  createEffectPixels,
} from '../src/effects/index.js';
import { createFakeEffectProvider } from '../src/effects/fake.js';

describe('createEffectAuthoringSession', () => {
  const provider = createFakeEffectProvider();

  it('opens a session from a known effect id', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    const state = session.getState();
    expect(state.effectId).toBe('fake.invert');
    expect(state.name).toBe('Invert');
    expect(state.values).toHaveProperty('amount');
    expect(state.tracks).toEqual({});
    expect(state.time).toBe(0);
    expect(state.duration).toBe(1000);
    expect(state.playing).toBe(false);
    expect(state.loop).toBe(false);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
  });

  it('throws on unknown effect id', async () => {
    await expect(
      createEffectAuthoringSession({ effectId: 'non-existent' }, { provider })
    ).rejects.toThrow();
  });

  it('opens a session from a preset', async () => {
    const session = await createEffectAuthoringSession(
      { effectId: 'fake.tint', preset: 'Sepia' },
      { provider }
    );
    const state = session.getState();
    expect(state.values.color).toBe('#704214');
  });

  it('throws on unknown preset', async () => {
    await expect(
      createEffectAuthoringSession(
        { effectId: 'fake.tint', preset: 'non-existent-preset' },
        { provider }
      )
    ).rejects.toThrow(/Unknown preset/);
  });

  it('opens a session from an exported document', async () => {
    const original = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    original.setValue('amount', 0.8);
    original.setKeyframe('amount', 500, 0.4);
    original.savePreset('custom');

    const doc = original.exportDocument();
    expect(doc.version).toBe(1);
    expect(doc.effectId).toBe('fake.invert');
    expect(doc.values.amount).toBe(0.4); // at time 0, keyframe at 500 holds 0.4 before it
    expect(doc.tracks.amount).toBeDefined();

    const restored = await createEffectAuthoringSession({ document: doc }, { provider });
    const state = restored.getState();
    expect(state.values.amount).toBe(0.4);
    expect(state.tracks.amount?.length).toBe(1);
    expect(state.tracks.amount?.[0].value).toBe(0.4);
  });

  it('sets single value and supports undo/redo', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    const initialAmount = session.getState().values.amount;

    const res = session.setValue('amount', 0.5);
    expect(res.ok).toBe(true);
    expect(session.getState().values.amount).toBe(0.5);
    expect(session.getState().canUndo).toBe(true);

    const undone = session.undo();
    expect(undone).toBe(true);
    expect(session.getState().values.amount).toBe(initialAmount);
    expect(session.getState().canRedo).toBe(true);

    const redone = session.redo();
    expect(redone).toBe(true);
    expect(session.getState().values.amount).toBe(0.5);
  });

  it('sets multiple values atomically in one undo step', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    const initial = { ...session.getState().values };

    const res = session.setValues({ amount: 0.2 });
    expect(res.ok).toBe(true);
    expect(session.getState().values.amount).toBe(0.2);
    expect(session.getState().canUndo).toBe(true);

    session.undo();
    expect(session.getState().values).toEqual(initial);
  });

  it('rejects unknown parameters in setValue and setValues', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    const s1 = session.getState();
    const r1 = session.setValue('nonexistent', 123);
    expect(r1.ok).toBe(false);
    expect(r1).toHaveProperty('message');
    expect(session.getState()).toBe(s1);

    const r2 = session.setValues({ nonexistent: 123 });
    expect(r2.ok).toBe(false);
    expect(session.getState()).toBe(s1);
  });

  it('validates schema issues', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    const s1 = session.getState();
    // amount max is 1
    const res = session.setValue('amount', 5);
    expect(res.ok).toBe(false);
    expect(session.getState()).toBe(s1);
  });

  it('merges slider gestures into a single undo step', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    session.setValue('amount', 0.2, { gesture: 'amount-drag' });
    session.setValue('amount', 0.4, { gesture: 'amount-drag' });
    session.setValue('amount', 0.6, { gesture: 'amount-drag' });

    expect(session.getState().values.amount).toBe(0.6);

    session.undo();
    // Reverts all gestures under the same gesture key in one step
    expect(session.getState().values.amount).toBe(1); // default is 1
  });

  it('handles keyframe interpolation for numbers and hex colors', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.tint' }, { provider });
    session.setTiming({ duration: 2000 });

    // Keyframe amount (number)
    session.setKeyframe('amount', 0, 0);
    session.setKeyframe('amount', 2000, 1);

    // Keyframe color (hex color: #000000 to #ffffff)
    session.setKeyframe('color', 0, '#000000');
    session.setKeyframe('color', 2000, '#ffffff');

    // Values at time 0
    session.seek(0);
    let values = session.getState().values;
    expect(values.amount).toBe(0);
    expect(values.color).toBe('#000000');

    // Values at midpoint (time = 1000)
    session.seek(1000);
    values = session.getState().values;
    expect(values.amount).toBeCloseTo(0.5);
    expect(values.color).toBe('#808080');

    // Values at end (time = 2000)
    session.seek(2000);
    values = session.getState().values;
    expect(values.amount).toBe(1);
    expect(values.color).toBe('#ffffff');
  });

  it('removes keyframes and cleans up empty tracks', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    session.setKeyframe('amount', 500, 0.2);
    session.setKeyframe('amount', 1500, 0.8);

    expect(session.getState().tracks.amount?.length).toBe(2);

    session.removeKeyframe('amount', 500);
    expect(session.getState().tracks.amount?.length).toBe(1);

    session.removeKeyframe('amount', 1500);
    expect(session.getState().tracks.amount).toBeUndefined();
  });

  it('clears tracks completely', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    session.setKeyframe('amount', 500, 0.5);
    expect(session.getState().tracks.amount).toBeDefined();

    session.clearTrack('amount');
    expect(session.getState().tracks.amount).toBeUndefined();
  });

  it('saves, applies, and roundtrips presets', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    session.setValue('amount', 0.35);
    const saveRes = session.savePreset('custom-inv');
    expect(saveRes.ok).toBe(true);

    expect(session.getState().description.presets.some(p => p.name === 'custom-inv')).toBe(true);

    session.setValue('amount', 0.9);
    const applyRes = session.applyPreset('custom-inv');
    expect(applyRes.ok).toBe(true);
    expect(session.getState().values.amount).toBe(0.35);
  });

  it('controls playback, seeking, and loops', async () => {
    let frameCb: ((now: number) => void) | null = null;
    const mockSchedule = (cb: (now: number) => void) => {
      frameCb = cb;
      return () => {
        frameCb = null;
      };
    };

    const session = await createEffectAuthoringSession(
      { effectId: 'fake.invert' },
      { provider, schedule: mockSchedule }
    );

    session.setTiming({ duration: 4000, loop: true });
    expect(session.getState().duration).toBe(4000);
    expect(session.getState().loop).toBe(true);

    session.seek(1500);
    expect(session.getState().time).toBe(1500);

    session.play();
    expect(session.getState().playing).toBe(true);
    expect(frameCb).not.toBeNull();

    // Advance 1000 ms
    frameCb!(1000); // first tick sets baseline
    frameCb!(2000); // +1000ms
    expect(session.getState().time).toBe(2500);

    // Advance past duration (4000ms) with loop=true: 2500 + 2000 = 4500 -> 500
    frameCb!(4000);
    expect(session.getState().time).toBe(500);

    session.pause();
    expect(session.getState().playing).toBe(false);
  });

  it('subscribes to state updates and cleans up listener on unsubscribe', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    const listener = vi.fn();
    const unsub = session.subscribe(listener);

    session.setValue('amount', 0.7);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    session.setValue('amount', 0.9);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('preserves referential stability of state if unchanged', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    const state1 = session.getState();
    const state2 = session.getState();
    expect(state1).toBe(state2);

    session.setValue('amount', 0.4);
    const state3 = session.getState();
    expect(state3).not.toBe(state1);
  });

  it('creates preview renderer and keyframes values over time', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    session.setKeyframe('amount', 0, 0.1);
    session.setKeyframe('amount', 2000, 0.9);

    const preview = await session.createPreview({ width: 100, height: 100 });
    expect(preview).toBeDefined();

    const sourcePixels = createEffectPixels(100, 100);
    const pixels = await preview.render({
      time: 1000,
      inputs: { source: sourcePixels }
    });
    expect(pixels).toBeDefined();
    expect(session.getState().compiled).toBe(true);
    preview.dispose();
  });

  it('disposes cleanly and refuses calls afterwards', async () => {
    const session = await createEffectAuthoringSession({ effectId: 'fake.invert' }, { provider });
    session.play();
    session.dispose();
    expect(session.getState().playing).toBe(false);

    const res = session.setValue('amount', 0.5);
    expect(res.ok).toBe(false);
    expect(res.message).toBe('the session is closed');
  });
});
