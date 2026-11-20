import { describe, expect, it } from 'vitest';
import { PaintEditorController } from '../src/paint-editor';
import type { PaintAssetStore, SerializedPaintDocument } from '../src/paint-editor/serialize';

/**
 * The wet clock of a painting, as the colour-scheme view and the other replays see it (#720):
 * a wet stroke ends at the clock its pen lifted (`endStep`), paint that flowed on after the last
 * logged item is replayed after a reload (`wet.clock`), and a document painted across several
 * sessions keeps its clocks in order (the clock goes on when it is reopened, and its log ends with
 * the dry the save did). In every case the scheme's view after a reload matches the painting done
 * fresh in that scheme.
 */

const W = 160;
const H = 120;
const editor = (scheme: 'light' | 'dark' = 'light') => new PaintEditorController({ width: W, height: H, paper: 'cold-pressed', colorScheme: scheme, wet: { kernel: 'wasm', threads: 0 } });
const wave = (y: number, n = 16, x0 = 20, x1 = 140) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y + Math.sin(i / 3) * 8, pressure: 0.7 }));
const BLUE = { light: '#1d4ed8', dark: '#93c5fd' };
const RED = { light: '#b91c1c', dark: '#fca5a5' };
const dried = (c: PaintEditorController) => Buffer.from(c.compositePixels({ wet: 'dried' }).data);
const display = (c: PaintEditorController) => Buffer.from(c.compositePixels({ wet: 'display' }).data);

type Color = string | { light: string; dark: string };
type Step =
  | { kind: 'stroke'; y: number; color: Color; seed: number }
  /** A pointer stroke with the simulation running between its points and `hold` steps between the last point and pen-up. */
  | { kind: 'live'; y: number; color: Color; seed: number; hold: number }
  | { kind: 'wait'; steps: number }
  /** Saved and opened again (in a fresh editor); painting goes on there. */
  | { kind: 'reload' };

/** Paints `steps` on `c`, the same way every time; returns the editor painting ended on (a reload opens a new one). */
async function paint(c: PaintEditorController, steps: readonly Step[], scheme: 'light' | 'dark' = 'light'): Promise<PaintEditorController> {
  let e = c;
  for (const s of steps) {
    if (s.kind === 'wait') await e.advanceWet({ steps: s.steps });
    else if (s.kind === 'stroke') {
      await e.wetIdle();
      e.paintStroke({ points: wave(s.y), brushId: 'watercolor-round', color: s.color, seed: s.seed });
    } else if (s.kind === 'live') {
      await e.wetIdle();
      const st = e.beginStroke({ brushId: 'watercolor-round', color: s.color, seed: s.seed });
      for (const [i, p] of wave(s.y).entries()) {
        st.push([p]);
        if (i % 4 === 3 && i < 15) await e.advanceWet({ steps: 2 });
      }
      if (s.hold) await e.advanceWet({ steps: s.hold });
      st.end();
      await e.wetIdle();
    } else {
      const json = e.toJSON();
      const next = editor(scheme);
      await next.wetReady();
      expect(next.loadJSON(json)).toEqual([]);
      e.dispose();
      e = next;
    }
  }
  return e;
}

const sided = (steps: readonly Step[], side: 'light' | 'dark'): Step[] => steps.map((s) => ('color' in s && typeof s.color === 'object' ? { ...s, color: s.color[side] } : s));

/** `steps` painted fresh in `side` (no dual colours), then saved and opened again: the pixels a viewer of that side should see. */
async function fresh(steps: readonly Step[], side: 'light' | 'dark'): Promise<Buffer> {
  const d = editor();
  await d.wetReady();
  const e = await paint(d, [...sided(steps, side), { kind: 'reload' }]);
  const out = dried(e);
  e.dispose();
  return out;
}

/** `steps` painted with dual colours in the light scheme, saved, and opened in the dark scheme: the replayed view. */
async function reopenedDark(steps: readonly Step[], json?: (doc: SerializedPaintDocument) => unknown): Promise<{ view: Buffer; editor: PaintEditorController; saved: SerializedPaintDocument }> {
  const c = editor();
  await c.wetReady();
  const e = await paint(c, steps);
  const saved = e.toJSON();
  e.dispose();
  const d = editor('dark');
  await d.wetReady();
  expect(d.loadJSON(json ? json(saved) : saved)).toEqual([]);
  const view = await d.colorSchemeViewReady();
  expect(view.replay.state).toBe('ready');
  return { view: dried(d), editor: d, saved };
}

function memoryStore(): PaintAssetStore {
  const blobs = new Map<string, Blob>();
  return {
    async put(blob) {
      const ref = `mem://${blobs.size + 1}`;
      blobs.set(ref, blob);
      return ref;
    },
    async get(ref) {
      const b = blobs.get(ref);
      if (!b) throw new Error(`no asset ${ref}`);
      return b;
    },
  };
}

describe('the clock a wet stroke ends at (pen-up)', () => {
  const steps: Step[] = [{ kind: 'stroke', y: 40, color: BLUE, seed: 3 }, { kind: 'live', y: 52, color: RED, seed: 4, hold: 9 }];

  it('is recorded when the simulation ran between the last point and pen-up, and saved', async () => {
    const c = editor();
    await c.wetReady();
    await paint(c, steps);
    const st = c.document.strokes[1];
    expect(st.endStep).toBe(st.steps![st.steps!.length - 1] + 9);
    // A stroke ended right after its last point records none.
    expect(c.document.strokes[0].endStep).toBeUndefined();
    const saved = c.toJSON().strokes as Array<{ endStep?: number }>;
    expect(saved[1].endStep).toBe(st.endStep);
    const d = editor();
    d.loadJSON(c.toJSON());
    expect(d.document.strokes[1].endStep).toBe(st.endStep);
    // Not a whole number, or not after the last point: read as missing.
    const bad = c.toJSON() as unknown as { strokes: Array<Record<string, unknown>> };
    bad.strokes[1].endStep = 1.5;
    d.loadJSON(bad);
    expect(d.document.strokes[1].endStep).toBeUndefined();
    bad.strokes[1].endStep = st.steps![0];
    d.loadJSON(bad);
    expect(d.document.strokes[1].endStep).toBeUndefined();
    c.dispose();
    d.dispose();
  }, 60000);

  it('is where the replayed dark view ends the stroke, live and after a reload', async () => {
    const dark = await fresh(steps, 'dark');
    // Live: the view follows the stroke and ends it at its pen-up clock.
    const c = editor();
    await c.wetReady();
    c.setColorScheme('dark');
    await paint(c, steps);
    await c.colorSchemeViewReady();
    expect(dried(c).equals(dark)).toBe(true);
    c.dispose();
    // Reopened.
    const { view, editor: d } = await reopenedDark(steps);
    expect(view.equals(dark)).toBe(true);
    d.dispose();
    // Without it (as an older document has it) the stroke ends early, and the view is not the same.
    const old = await reopenedDark(steps, (doc) => ({ ...doc, strokes: (doc.strokes as Array<Record<string, unknown>>).map(({ endStep: _e, ...st }) => st) }));
    expect(old.view.equals(dark)).toBe(false);
    old.editor.dispose();
  }, 60000);

  it('is honoured by renderHighRes', async () => {
    const c = editor();
    await c.wetReady();
    await paint(c, steps);
    const img = await c.renderHighRes({ scale: 1 });
    expect(Buffer.from(img.data).equals(dried(c))).toBe(true);
    c.dispose();
  }, 60000);
});

describe('wet flow after the last logged item', () => {
  const steps: Step[] = [{ kind: 'stroke', y: 40, color: BLUE, seed: 3 }, { kind: 'wait', steps: 6 }, { kind: 'stroke', y: 56, color: RED, seed: 5 }, { kind: 'wait', steps: 37 }];

  it('saves the clock the paint was dried at whenever the log has wet paint', async () => {
    const c = editor();
    await c.wetReady();
    await paint(c, steps.slice(0, 3));
    // Ending on a logged item: the clock is the log's latest, and still written, so the check of an opened document can rely on it (#883).
    const before = c.toJSON() as { wet?: { clock?: number } };
    expect(before.wet?.clock).toBe(c.getState().wet.clock);
    await c.advanceWet({ steps: 37 });
    const clock = c.getState().wet.clock;
    expect((c.toJSON() as { wet?: { clock?: number } }).wet).toEqual({ ...before.wet, clock });
    // The asset-store path saves it too.
    const store = memoryStore();
    const ext = await c.toJSONExternal(store);
    expect((ext as { wet?: { clock?: number } }).wet?.clock).toBe(clock);
    const d = editor();
    expect(await d.loadJSONAsync(ext, store)).toEqual([]);
    expect(d.getState().wet.clock).toBe(clock);
    // Saved the same in either scheme, and again after reopening.
    c.setColorScheme('dark');
    await c.colorSchemeViewReady();
    expect(JSON.stringify(c.toJSON())).toBe(JSON.stringify(d.toJSON()));
    const e = editor('dark');
    e.loadJSON(d.toJSON());
    expect(JSON.stringify(e.toJSON())).toBe(JSON.stringify(d.toJSON()));
    // A clock that isn't a whole number of steps is reported, and the log's is used.
    const bad = { ...d.toJSON(), wet: { ...before.wet, clock: -3 } };
    expect(e.loadJSON(bad)).toEqual(['wet.clock -3 is not a whole number of steps from 0 to 2147483647; the clock the log ends at is used.']);
    expect(e.getState().wet.clock).toBe(c.document.strokes[1].steps![0]);
    for (const x of [c, d, e]) x.dispose();
  }, 60000);

  it('is replayed after a reload, so the dark view matches a fresh dark painting', async () => {
    const dark = await fresh(steps, 'dark');
    const { view, editor: d, saved } = await reopenedDark(steps);
    expect(view.equals(dark)).toBe(true);
    // The opened log ends with the dry the save did, at the saved clock.
    expect(d.document.wetEvents?.at(-1)).toEqual({ clock: (saved.wet as { clock: number }).clock, at: 2, kind: 'dry' });
    d.dispose();
    // An older document (no saved clock) stops at its last item, as before.
    const atLast = await fresh(steps.slice(0, 3), 'dark');
    const old = await reopenedDark(steps, ({ wet: _w, ...doc }) => doc);
    expect(old.view.equals(atLast)).toBe(true);
    old.editor.dispose();
  }, 60000);

  it('is in the time-lapse and the high-resolution export of the live painting', async () => {
    const c = editor();
    await c.wetReady();
    await paint(c, steps);
    const img = await c.renderHighRes({ scale: 1 });
    expect(Buffer.from(img.data).equals(dried(c))).toBe(true);
    const tl = await c.timeLapse({ wetStepsPerFrame: 0 });
    const frames = tl.frames.length;
    const flowing = await c.timeLapse({ wetStepsPerFrame: 10 });
    // Frames while the paint flowed after the last stroke too.
    expect(flowing.frames.length).toBeGreaterThan(frames + 3);
    c.dispose();
  }, 60000);
});

describe('documents painted across several sessions', () => {
  const steps: Step[] = [
    { kind: 'stroke', y: 36, color: BLUE, seed: 1 },
    { kind: 'wait', steps: 21 },
    { kind: 'stroke', y: 50, color: RED, seed: 2 },
    { kind: 'wait', steps: 9 },
    { kind: 'reload' },
    { kind: 'stroke', y: 44, color: RED, seed: 3 },
    { kind: 'wait', steps: 5 },
    { kind: 'live', y: 64, color: BLUE, seed: 4, hold: 3 },
    { kind: 'wait', steps: 4 },
    { kind: 'reload' },
    { kind: 'stroke', y: 80, color: BLUE, seed: 5 },
  ];

  it('go on with the clock they were saved at, so the log stays in order', async () => {
    const c = editor();
    await c.wetReady();
    const e = await paint(c, steps);
    const clocks = e.document.strokes.map((s) => s.steps![0]);
    expect(clocks).toEqual([...clocks].sort((a, b) => a - b));
    expect(clocks[2]).toBeGreaterThanOrEqual(30);
    // Each reopening is logged as a dry of everything at its clock.
    expect(e.document.wetEvents?.filter((x) => x.kind === 'dry')).toEqual([
      { clock: 30, at: 2, kind: 'dry' },
      { clock: e.document.strokes[3].endStep! + 4, at: 4, kind: 'dry' },
    ]);
    e.dispose();
  }, 60000);

  it('show the dark side in the scheme view, live and after a reload, as painted fresh in dark', async () => {
    const dark = await fresh(steps, 'dark');
    // In the session that painted the last part.
    const c = editor();
    await c.wetReady();
    const e = await paint(c, steps);
    e.setColorScheme('dark');
    expect((await e.colorSchemeViewReady()).replay.state).toBe('ready');
    const live = editor();
    await live.wetReady();
    const l = await paint(live, sided(steps, 'dark'));
    expect(display(e).equals(display(l))).toBe(true);
    for (const x of [e, l]) x.dispose();
    // Reopened.
    const { view, editor: d } = await reopenedDark(steps);
    expect(view.equals(dark)).toBe(true);
    d.dispose();
  }, 120000);

  it('older documents, whose clocks start again at 0 in each session, replay in order instead of looping', async () => {
    // Session 1 ends on a stroke at clock 21; session 2 starts at 32 here, at 0 in an older document.
    const first: Step[] = [{ kind: 'stroke', y: 36, color: BLUE, seed: 1 }, { kind: 'wait', steps: 21 }, { kind: 'stroke', y: 50, color: RED, seed: 2 }, { kind: 'reload' }];
    const second: Step[] = [{ kind: 'stroke', y: 44, color: RED, seed: 3 }, { kind: 'wait', steps: 5 }, { kind: 'live', y: 64, color: BLUE, seed: 4, hold: 3 }];
    const twoSessions = async (side: 'light' | 'dark' | null): Promise<PaintEditorController> => {
      const c = editor();
      await c.wetReady();
      const s1 = await paint(c, side ? sided(first, side) : first);
      expect(s1.wet.setClock(32)).toBe(true);
      return paint(s1, side ? sided(second, side) : second);
    };
    // What such a document looks like saved before the clock went on: the second session's clocks from 0, no saved clock, no dry.
    const asOlder = (doc: SerializedPaintDocument): SerializedPaintDocument => {
      const { wet: _w, wetEvents: events, ...rest } = doc as SerializedPaintDocument & { wet?: unknown; wetEvents?: Array<{ kind: string }> };
      const strokes = (rest.strokes as Array<{ steps: number[]; endStep?: number }>).map((st, i) => (i < 2 ? st : { ...st, steps: st.steps.map((v) => v - 32), ...(st.endStep !== undefined ? { endStep: st.endStep - 32 } : {}) }));
      const wetEvents = events?.filter((x) => x.kind !== 'dry') ?? [];
      return { ...rest, strokes, ...(wetEvents.length ? { wetEvents } : {}) } as SerializedPaintDocument & { wetEvents?: unknown };
    };
    const e = await twoSessions(null);
    const json = asOlder(e.toJSON());
    expect((json.strokes as Array<{ steps: number[] }>).map((s) => s.steps[0])).toEqual([0, 21, 0, 5]);
    const d = editor('dark');
    await d.wetReady();
    expect(d.loadJSON(json)).toEqual([]);
    expect((await d.colorSchemeViewReady()).replay.state).toBe('ready');
    // Its clocks go on in order (the second session from 32), each session break a dry of everything.
    expect(d.document.strokes.map((s) => s.steps![0])).toEqual([0, 21, 32, 37]);
    const end = e.document.strokes[3].endStep!;
    expect(d.document.wetEvents?.map((x) => [x.kind, x.clock, x.at])).toEqual([
      ['dry', 21, 2],
      ['dry', end, 4],
    ]);
    expect(d.getState().wet.clock).toBe(end);
    // The same painting done fresh in dark.
    const f = await twoSessions('dark');
    const g = await paint(f, [{ kind: 'reload' }]);
    expect(dried(d).equals(dried(g))).toBe(true);
    for (const x of [e, d, g]) x.dispose();
  }, 120000);
});
