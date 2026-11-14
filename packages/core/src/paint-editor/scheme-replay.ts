/**
 * Pixel layers in the viewer's colour scheme, rebuilt from the stroke log (#720).
 *
 * A pixel layer keeps the side of a dual colour (`RecordedStroke.dualColor`) it was painted in:
 * wet paint can't be redrawn one stroke at a time, because every stroke mixes with what the
 * simulation did before it. The scheme's view of such a layer is a replay instead: every recorded
 * stroke and event repainted into a headless editor (`createReplayTarget`), each dual-colour stroke
 * in the scheme's side, so the simulation mixes the dark sides the way it mixed the light ones.
 *
 * - **Built lazily, off the drawing path.** The replay runs one item at a time with the host let in
 *   between (and every few wet steps); until it has caught up, the layer shows its own pixels.
 * - **Kept current, not rebuilt.** Once built it follows the document: new strokes and events are
 *   repainted as they are logged, a live stroke is mirrored point by point at the clocks it was
 *   applied at (wet ones), and the simulation is stepped to the editor's clock. A full replay is only
 *   needed on load or a scheme switch.
 * - **Undo** rolls the replay back to a checkpoint (the replay editor's document and wet simulation
 *   after an item) and repaints from there, so undo / redo never shows the other scheme's pixels.
 * - **View only.** Nothing here changes the document, the history or what is saved.
 * - **Also a check.** Frozen (`{ frozen: true }`) and fed the document as it was opened, with every
 *   stroke as recorded, it repaints the log once so the editor can compare the result with the
 *   pixels that were opened (`checkedLayer`): a layer they don't match holds pixels the log doesn't
 *   have (documents saved before the editor kept those marks, #720).
 */

import type { ColorScheme } from '../color/dual';
import { TILE, tileCoord, translateSurface, type RasterRect, type TiledSurface } from '../raster/surface';
import { findLayer } from '../raster/layers';
import type { PaintDocumentState, PaintPixelLayer } from './document';
import type { PaintEditorController, ReplayCheckpoint } from './controller';
import type { PenPoint } from './engine';
import type { PaintStrokeSession } from './stroke';
import type { RecordedStroke } from './strokes';
import { advanceReplayClock, finishReplayStroke, replayItem, replayItems, replayStrokeInit, type ReplayItem, type ReplayItemOptions } from './replay';

/** What a scheme replay reads from the editor it shows. */
export interface SchemeReplayHost {
  /** The editor's document. */
  document(): PaintDocumentState;
  /** The editor's wet clock (steps). */
  clock(): number;
  /** The stroke being painted as recorded so far (a wet stroke: the points applied, with their clocks), or `null` when there is none or it can't be followed live. */
  liveStroke(): { stroke: RecordedStroke; wet: boolean; follow: boolean } | null;
  /** A stroke as the scheme shows it (a dual-colour stroke in the scheme's side). */
  inScheme(stroke: RecordedStroke): RecordedStroke;
  /** A fresh, empty replay editor for the document as it is now. */
  createTarget(): PaintEditorController;
  /** The editor's pixel layers that are missing from `target` are added to it, empty. */
  addMissingLayers(target: PaintEditorController): void;
  /** Whether `target` was made for another canvas or paper than the editor has now. */
  stale(target: PaintEditorController): boolean;
  /** The view changed in `rects` (only called while the view is shown). */
  changed(rects: RasterRect[] | 'all'): void;
  /** Bytes of wet simulation snapshots the checkpoints may keep. */
  memory(): number;
}

export type SchemeReplayState = 'building' | 'ready' | 'failed';

/** Steps of catch-up (or of a replayed stroke) between two looks at the host. */
const STEP_CHUNK = 2;
/** Points of a replayed wet stroke between two looks at the host. */
const POINT_CHUNK = 8;
/** Checkpoints kept at most (the oldest go first). */
const MAX_CHECKPOINTS = 64;

const itemKey = (item: ReplayItem): object => (item.kind === 'stroke' ? item.stroke : item.event);
const strokeKey = (st: RecordedStroke): string => `${st.layerId}|${st.seed}|${st.brush.id}|${st.points[0]?.x},${st.points[0]?.y}`;
/** The clock an item happens at (`null`: it doesn't depend on the clock). */
const itemClock = (item: ReplayItem): number | null => (item.kind === 'wet' ? item.event.clock : item.kind === 'stroke' && item.stroke.brush.engine === 'wet' && item.stroke.steps?.length ? item.stroke.steps[0] : null);
const yieldToHost = () => new Promise<void>((r) => setTimeout(r, 0));

export class SchemeReplay {
  state: SchemeReplayState = 'building';
  /** Why the replay failed (`state: 'failed'`). */
  error: string | null = null;
  private target: PaintEditorController;
  private unsubscribe: () => void = () => {};
  /** The strokes and events repainted so far (the objects of the log, in order). */
  private applied: object[] = [];
  private checkpoints: Array<{ count: number; cp: ReplayCheckpoint }> = [];
  private live: { key: string; session: PaintStrokeSession; wet: boolean; pushed: number } | null = null;
  /** A live stroke that could not be followed (the view shows it when it is logged). */
  private skipKey: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private disposed = false;
  private readonly options: ReplayItemOptions;
  /** A one-off replay of a document that doesn't change: no checkpoints, and nothing to roll back to. */
  private readonly frozen: boolean;

  constructor(readonly scheme: ColorScheme, private readonly host: SchemeReplayHost, options: { frozen?: boolean } = {}) {
    this.frozen = Boolean(options.frozen);
    this.options = { wetChunk: STEP_CHUNK, onWetSteps: () => yieldToHost(), pointChunk: POINT_CHUNK, onPoints: () => yieldToHost() };
    this.target = this.fresh();
  }

  /** How far the replay is: items repainted and items in the log. */
  get progress(): { items: number; total: number } {
    const d = this.host.document();
    return { items: this.applied.length, total: d.strokes.length + (d.paintEvents?.length ?? 0) + (d.wetEvents?.length ?? 0) };
  }

  /** The layer as the scheme shows it (with a mirrored live stroke), or `null` before it is ready. */
  surface(layerId: string): TiledSurface | null {
    return this.state === 'ready' ? this.target.viewLayerSurface(layerId) : null;
  }

  /** The layer as the scheme shows it with its wet paint dried (what exports see), or `null` before it is ready. */
  bakedSurface(layerId: string): TiledSurface | null {
    if (this.state !== 'ready') return null;
    const baked = this.target.wet.busy || this.live ? null : this.target.wet.bakedSurface(layerId);
    return baked ?? this.target.viewLayerSurface(layerId);
  }

  /**
   * A layer of a ready replay as document pixels (its offset applied, wet paint dried) and the
   * rectangle of its paint still wet or drying (`null` when none), where letting it flow on could
   * still change it; `null` before the replay is ready or when it has no such pixel layer.
   */
  checkedLayer(layerId: string): { surface: TiledSurface; flowing: RasterRect | null } | null {
    const surface = this.bakedSurface(layerId);
    const found = findLayer(this.target.document.layers, layerId)?.layer;
    if (!surface || found?.type !== 'pixel') return null;
    const l = found as PaintPixelLayer;
    const flowing = this.target.wet.activeBounds(layerId);
    const shift = (r: RasterRect): RasterRect => ({ ...r, x: r.x + l.offset.x, y: r.y + l.offset.y });
    return { surface: translateSurface(surface, l.offset.x, l.offset.y), flowing: flowing ? shift(flowing) : null };
  }

  /** Looks at the editor again (call after every change): repaints what is new, in the background. */
  kick(): void {
    if (this.disposed || this.state === 'failed') return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.again = false;
    const run = this.run();
    this.running = run;
    void run.finally(() => {
      if (this.running === run) this.running = null;
      if (this.again) this.kick();
    });
  }

  /** Resolves when the replay has nothing left to do (caught up with the editor, or failed). */
  async whenIdle(): Promise<void> {
    while (this.running && !this.disposed) await this.running;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  private fresh(): PaintEditorController {
    const t = this.host.createTarget();
    const off = t.subscribe(() => {
      const dirty = t.takeDirty();
      if (this.state === 'ready' && !this.disposed && this.target === t) this.host.changed(dirty);
    });
    this.unsubscribe = () => {
      off();
      t.dispose();
    };
    return t;
  }

  private async run(): Promise<void> {
    // Never inside the change that kicked it.
    await Promise.resolve();
    try {
      while (!this.disposed) {
        this.again = false;
        if (!(await this.step())) return;
        await yieldToHost();
      }
    } catch (e) {
      if (this.disposed) return;
      this.state = 'failed';
      this.error = e instanceof Error ? e.message : String(e);
      this.host.changed('all');
    }
  }

  /** One piece of work (an item, a stretch of steps, a few live points). `false` when caught up. */
  private async step(): Promise<boolean> {
    if (this.host.stale(this.target)) {
      await this.restart();
      return true;
    }
    const items = replayItems(this.host.document());
    let p = 0;
    while (p < this.applied.length && p < items.length && itemKey(items[p]) === this.applied[p]) p++;
    // Undone or edited: back to the last checkpoint the log still agrees with.
    if (p < this.applied.length) {
      await this.rollback(p, Infinity);
      return true;
    }
    if (p < items.length) {
      const item = items[p];
      const live = this.live;
      if (live) {
        if (item.kind === 'stroke' && live.key === strokeKey(item.stroke)) {
          if (live.wet) {
            await this.finishLive(this.host.inScheme(item.stroke));
            this.applied.push(itemKey(item));
            this.checkpoint();
            return true;
          }
          // A dry stroke is painted again as recorded (one change, so the view never shows it missing).
          this.live = null;
          live.session.cancel();
        } else {
          await this.cancelLive();
          return true;
        }
      }
      const at = itemClock(item);
      if (at !== null && this.clock() > at) {
        await this.rollback(p, at);
        return true;
      }
      await this.apply(item);
      return true;
    }
    const now = this.host.liveStroke();
    if (await this.followLive(now)) return true;
    const clock = this.host.clock();
    // A wet stroke holds the clock at its last point (a replay ends it there; one that isn't
    // followed replays from its first point once it is logged).
    if (this.clock() < clock && !this.live?.wet && !(now?.wet && !now.follow)) {
      if ((await advanceReplayClock(this.target, Math.min(clock, this.clock() + STEP_CHUNK))) > 0) return true;
    }
    if (this.state === 'building') {
      this.state = 'ready';
      this.host.changed('all');
    }
    return false;
  }

  private clock(): number {
    return this.target.getState().wet.clock;
  }

  private async apply(item: ReplayItem): Promise<void> {
    this.host.addMissingLayers(this.target);
    let it = item;
    if (item.kind === 'stroke') {
      const st = this.host.inScheme(item.stroke);
      if (st.paint?.type === 'effect' && st.paint.map?.by !== 'path') await this.target.prepareEffectPaints([st.paint]);
      it = { kind: 'stroke', stroke: st };
    } else if (item.kind === 'paint' && item.event.kind === 'live-strokes') {
      // A stroke layer in the replay holds its strokes in the scheme's side (what it rasterizes to).
      const d = item.event.data as { strokes?: RecordedStroke[] } | undefined;
      if (d?.strokes) it = { kind: 'paint', event: { ...item.event, data: { ...d, strokes: d.strokes.map((st) => this.host.inScheme(st)) } } };
    }
    await replayItem(this.target, it, this.options);
    this.applied.push(itemKey(item));
    this.checkpoint();
  }

  private checkpoint(): void {
    this.target.forgetHistory();
    if (this.frozen) return;
    this.checkpoints.push({ count: this.applied.length, cp: this.target.replayCheckpoint() });
    if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift();
    // Within the memory budget, newest first: older checkpoints lose their wet snapshots.
    let bytes = 0;
    const budget = this.host.memory();
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      const cp = this.checkpoints[i].cp;
      if (cp.lost) continue;
      bytes += cp.wet?.bytes ?? 0;
      if (bytes > budget) {
        // A lost checkpoint is never restored: let its snapshot go so the budget holds.
        cp.lost = true;
        cp.wet = null;
      }
    }
  }

  /** Back to the newest checkpoint at or before item `count` and clock `clock`; a fresh replay when there is none. */
  private async rollback(count: number, clock: number): Promise<void> {
    // Nothing changes under a frozen replay, so only a log whose clocks go back can get here.
    if (this.frozen) throw new Error(`item ${count + 1} of the stroke log happens at an earlier wet clock than the item before it, so the log can't be replayed in order`);
    if (this.live) await this.cancelLive();
    await this.target.wetIdle();
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      const c = this.checkpoints[i];
      if (c.count > count || c.cp.clock > clock || c.cp.lost) continue;
      if (!this.target.restoreReplayCheckpoint(c.cp)) break;
      this.applied.length = c.count;
      this.checkpoints.length = i + 1;
      if (this.state === 'ready') this.host.changed('all');
      return;
    }
    await this.restart();
  }

  /** Starts over in a fresh replay editor; the layers show their own pixels until it has caught up. */
  private async restart(): Promise<void> {
    if (this.live) await this.cancelLive();
    const wasReady = this.state === 'ready';
    this.state = 'building';
    this.unsubscribe();
    this.applied = [];
    this.checkpoints = [];
    this.skipKey = null;
    this.target = this.fresh();
    if (wasReady) this.host.changed('all');
  }

  /** Mirrors the stroke being painted: begins it, then pushes the points applied since the last look. */
  private async followLive(now: ReturnType<SchemeReplayHost['liveStroke']>): Promise<boolean> {
    if (this.live && (!now || strokeKey(now.stroke) !== this.live.key)) {
      // Cancelled (a stroke that ended is logged, and `step` finishes it first).
      await this.cancelLive();
      return true;
    }
    if (!now || !now.follow || !now.stroke.points.length) return false;
    const key = strokeKey(now.stroke);
    if (key === this.skipKey) return false;
    const st = this.host.inScheme(now.stroke);
    const target = this.target;
    if (!this.live) {
      if (now.wet) {
        // Not applied yet: the simulation may still step up to the editor's clock (points land later).
        if (!st.steps?.length) return false;
        if (this.clock() > st.steps[0]) {
          await this.rollback(this.applied.length, st.steps[0]);
          return true;
        }
        await target.wetIdle();
        await advanceReplayClock(target, st.steps[0], this.options);
        await target.wetIdle();
      }
      this.host.addMissingLayers(target);
      try {
        const session = target.beginStroke({ ...replayStrokeInit(st), start: st.points[0] });
        this.live = { key, session, wet: now.wet, pushed: 0 };
      } catch {
        this.skipKey = key;
        return false;
      }
      return true;
    }
    return this.pushLive(st);
  }

  /** Pushes the points of `st` the mirrored stroke hasn't had (a wet stroke's at their clocks). */
  private async pushLive(st: RecordedStroke): Promise<boolean> {
    const live = this.live!;
    const n = live.wet ? Math.min(st.steps?.length ?? 0, st.points.length) : st.points.length;
    if (live.pushed >= n) return false;
    if (live.wet) {
      for (let i = live.pushed; i < n; i++) {
        await advanceReplayClock(this.target, st.steps![i], this.options);
        await this.target.wetIdle();
        if (this.live !== live) return true;
        live.session.push([st.points[i] as PenPoint]);
        live.pushed = i + 1;
      }
    } else {
      live.session.push(st.points.slice(live.pushed, n) as PenPoint[]);
      live.pushed = n;
    }
    return true;
  }

  /** The editor's stroke was logged: the mirrored wet stroke takes its last points and ends. */
  private async finishLive(st: RecordedStroke): Promise<void> {
    const live = this.live!;
    await this.pushLive(st);
    this.live = null;
    await finishReplayStroke(this.target, live.session);
  }

  private async cancelLive(): Promise<void> {
    const live = this.live;
    if (!live) return;
    this.live = null;
    await this.target.wetIdle();
    if (live.session.open) live.session.cancel();
    else if (live.session.pendingEnd) await finishReplayStroke(this.target, live.session);
  }
}

/**
 * The largest difference in a channel (premultiplied by alpha, out of 255) at which a check of
 * opened pixels against a replay of the stroke log still counts a pixel as the same. Above the
 * rounding a PNG round trip or another implementation of the engines gives (conformance allows 2),
 * well below anything an import, merge or move leaves behind.
 */
export const CHECK_TOLERANCE = 8;

const ZERO_TILE = new Uint8ClampedArray(TILE * TILE * 4);

/**
 * Whether two RGBA surfaces (document pixels, transparent by default) hold the same pixels within
 * `tolerance` (premultiplied, so the colour of nearly transparent pixels doesn't count), leaving out
 * the pixels in `skip`.
 */
export function pixelsMatch(a: TiledSurface, b: TiledSurface, skip: RasterRect | null = null, tolerance = CHECK_TOLERANCE): boolean {
  const keys = new Set([...a.tiles.keys(), ...b.tiles.keys()]);
  const far = tolerance * 255;
  for (const key of keys) {
    const ta = a.tiles.get(key);
    const tb = b.tiles.get(key);
    if (ta === tb) continue;
    const da = ta?.data ?? ZERO_TILE;
    const db = tb?.data ?? ZERO_TILE;
    const { tx, ty } = tileCoord(key);
    const x0 = tx * TILE;
    const y0 = ty * TILE;
    for (let y = 0; y < TILE; y++) {
      const gy = y0 + y;
      const sx0 = skip !== null && gy >= skip.y && gy < skip.y + skip.height ? skip.x - x0 : TILE;
      const sx1 = skip !== null ? skip.x + skip.width - x0 : 0;
      for (let x = 0; x < TILE; x++) {
        if (x >= sx0 && x < sx1) continue;
        const i = (y * TILE + x) * 4;
        const aa = da[i + 3];
        const ab = db[i + 3];
        if (Math.abs(aa - ab) > tolerance) return false;
        if (Math.abs(da[i] * aa - db[i] * ab) > far || Math.abs(da[i + 1] * aa - db[i + 1] * ab) > far || Math.abs(da[i + 2] * aa - db[i + 2] * ab) > far) return false;
      }
    }
  }
  return true;
}
