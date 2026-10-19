// Agent "performances" on the paint canvas, after the chart and diagram directors (see
// `animation/presence.ts`): a director acts each command out with the agent's cursor in document
// pixels, so a stroke is painted live along its path (the canvas updates as the dabs land) and
// commits as one undo step, a fill is rubbed across the sheet, and a replay starts from the strokes
// it copies. The clock is injectable so performances are repeatable in tests.
import {
  PerformanceQueue,
  PresenceStore,
  realPresenceClock,
  tweenPresenceCursor,
  type PresenceActor,
  type PresenceActorInfo,
  type PresenceClock,
  type PresenceState,
} from '../animation/presence';
import type { RasterRect } from '../raster/surface';
import type { FillLayerOptions, PaintEditorController, PaintStrokeInit, ReplayOptions } from './controller';
import type { PenPoint } from './engine';
import type { PaintStrokeResult } from './stroke';

export type PaintPresenceActor = PresenceActor;
export type PaintPresenceState = PresenceState;

/** Cursor positions (document pixels) and notes of agents painting, for an overlay. */
export class PaintPresence extends PresenceStore {}

/** What an agent asks for. Each command that paints commits as one undo step. */
export type PaintAgentCommand =
  | { kind: 'stroke'; stroke: PaintStrokeInit & { points: readonly PenPoint[] }; note?: string }
  | { kind: 'fill'; fill: FillLayerOptions; note?: string }
  | { kind: 'replay'; replay: ReplayOptions; note?: string }
  | { kind: 'point'; at: { x: number; y: number }; note?: string }
  | { kind: 'say'; text: string };

export type PaintPerformanceResult =
  | { ok: true; command: PaintAgentCommand; result?: unknown }
  | { ok: false; command: PaintAgentCommand; message: string };

export interface PaintDirectorOptions {
  clock?: PresenceClock;
  /** 1 = natural speed; 2 = twice as fast. */
  speed?: number;
  /** Hide each actor's cursor this long after its last command (ms, default 1500; 0 keeps it). */
  linger?: number;
  /** Longest a stroke takes to paint at speed 1 (ms, default 1800); longer strokes are sped up. */
  maxStrokeMs?: number;
}

const FRAME = 16;

/** Where along a stroke each point is reached, 0..1: by its time `t` when the points have times, else by distance. */
export function strokeSchedule(points: readonly PenPoint[]): number[] {
  if (points.length < 2) return points.map(() => 1);
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  if (points.every((p) => Number.isFinite(p.t)) && (t1 as number) > (t0 as number)) {
    return points.map((p) => Math.min(1, Math.max(0, ((p.t as number) - (t0 as number)) / ((t1 as number) - (t0 as number)))));
  }
  const acc = [0];
  for (let i = 1; i < points.length; i++) acc.push(acc[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  const total = acc[acc.length - 1]!;
  return total > 0 ? acc.map((d) => d / total) : points.map(() => 1);
}

/** How long a stroke takes to paint at speed 1 (ms): its recorded duration, else ~1.5 px/ms, between 250 ms and `max`. */
export function strokeDuration(points: readonly PenPoint[], max = 1800): number {
  const t0 = points[0]?.t;
  const t1 = points[points.length - 1]?.t;
  let ms: number;
  if (points.every((p) => Number.isFinite(p.t)) && (t1 as number) > (t0 as number)) ms = (t1 as number) - (t0 as number);
  else {
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    ms = length / 1.5;
  }
  return Math.min(max, Math.max(250, ms));
}

/** A zig-zag across `rect` (for a fill rubbed over the sheet), `rows` passes from the top. */
export function sweepPath(rect: RasterRect, rows = 4): Array<{ x: number; y: number }> {
  const inset = Math.min(rect.width, rect.height) * 0.08;
  const left = rect.x + inset;
  const right = rect.x + rect.width - inset;
  const out: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < rows; r++) {
    const y = rect.y + inset + ((rect.height - 2 * inset) * (r + 0.5)) / rows;
    out.push(r % 2 ? { x: right, y } : { x: left, y }, r % 2 ? { x: left, y } : { x: right, y });
  }
  return out;
}

const centre = (r: RasterRect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/**
 * Acts out agent commands on a paint canvas: the actor's cursor glides to the stroke's start and
 * paints it live along its points (paced by their times, or evenly), the stroke committing as
 * one undo step; fills are rubbed across the sheet first; replays start from the strokes they
 * copy and end on what they painted. Commands queue per actor. A command that cannot apply (an
 * unknown or locked layer, a stroke the user is still painting) fails with the controller's
 * sentence before anything is painted.
 */
export class PaintDirector {
  private readonly clock: PresenceClock;
  private readonly queue: PerformanceQueue;

  constructor(
    private readonly controller: PaintEditorController,
    readonly presence: PaintPresence,
    private readonly options: PaintDirectorOptions = {}
  ) {
    this.clock = options.clock ?? realPresenceClock;
    this.queue = new PerformanceQueue(presence, { clock: this.clock, linger: options.linger });
  }

  /** Acts out `commands` in order for `actor`. Resolves with one result per command. */
  perform(actor: PresenceActorInfo, commands: readonly PaintAgentCommand[]): Promise<PaintPerformanceResult[]> {
    return this.queue.run(actor, async () => {
      const results: PaintPerformanceResult[] = [];
      for (const command of commands) {
        try {
          results.push({ ok: true, command, result: await this.performOne(actor.id, command) });
        } catch (error) {
          results.push({ ok: false, command, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return results;
    });
  }

  private ms(n: number): number {
    return Math.round(n / Math.max(0.1, this.options.speed ?? 1));
  }

  private where(id: string) {
    const a = this.presence.get(id);
    return { x: a?.x ?? 0, y: a?.y ?? 0 };
  }

  /** Glides to `to`; an actor that just appeared starts there instead of the corner. */
  private async glide(id: string, to: { x: number; y: number }, ms = 380) {
    const a = this.presence.get(id);
    if (!a || (a.x === 0 && a.y === 0)) {
      this.presence.set({ id, x: to.x, y: to.y });
      return;
    }
    await tweenPresenceCursor(this.presence, this.clock, id, this.where(id), to, this.ms(ms));
  }

  private async say(id: string, text: string | undefined, ms: number) {
    if (!text) return;
    this.presence.set({ id, message: text });
    await this.clock.wait(this.ms(ms));
  }

  private async performOne(id: string, command: PaintAgentCommand): Promise<unknown> {
    const c = this.controller;
    switch (command.kind) {
      case 'say':
        await this.say(id, command.text, 900);
        return undefined;
      case 'point':
        await this.say(id, command.note, 500);
        await this.glide(id, command.at);
        this.presence.set({ id, pressed: true });
        await this.clock.wait(this.ms(110));
        this.presence.set({ id, pressed: false });
        return undefined;
      case 'stroke':
        await this.say(id, command.note, 500);
        return this.stroke(id, command.stroke);
      case 'fill': {
        await this.say(id, command.note, 500);
        const { width, height } = c.getState().document.canvas;
        const path = sweepPath({ x: 0, y: 0, width, height });
        await this.glide(id, path[0]!);
        this.presence.set({ id, pressed: true });
        try {
          for (let i = 1; i < path.length; i++) await tweenPresenceCursor(this.presence, this.clock, id, path[i - 1]!, path[i]!, this.ms(i % 2 ? 260 : 90));
        } finally {
          this.presence.set({ id, pressed: false });
        }
        return c.fillLayer(command.fill);
      }
      case 'replay': {
        await this.say(id, command.note, 500);
        const source = c.getStrokes().filter((s) => command.replay.strokeIds?.includes(s.id));
        const first = source[0]?.points[0];
        if (first) await this.glide(id, first);
        const result = c.replayStrokes(command.replay);
        if (result.bounds) await this.glide(id, centre(result.bounds), 520);
        return result;
      }
    }
  }

  /** Paints a stroke live: begins it, pushes its points frame by frame as the cursor reaches them, then ends it (one undo step). */
  private async stroke(id: string, init: PaintStrokeInit & { points: readonly PenPoint[] }): Promise<PaintStrokeResult> {
    const c = this.controller;
    const points = c.checkPoints(init.points);
    const { points: _points, ...rest } = init;
    // Validate the layer and brush (and that nothing else is painting) before moving at all.
    const session = c.beginStroke({ snapToPerspective: false, start: points[0], ...rest });
    try {
      await this.glide(id, points[0]!);
      this.presence.set({ id, pressed: true });
      const at = strokeSchedule(points);
      const duration = this.ms(strokeDuration(points, this.options.maxStrokeMs));
      let next = 0;
      const frames = Math.max(1, Math.round(duration / FRAME));
      for (let f = 1; f <= frames; f++) {
        const t = f / frames;
        const from = next;
        while (next < points.length && at[next]! <= t + 1e-9) next++;
        if (next > from) {
          session.push(points.slice(from, next));
          const p = points[next - 1]!;
          this.presence.set({ id, x: p.x, y: p.y });
        }
        if (f < frames) await this.clock.wait(duration / frames);
      }
      if (next < points.length) session.push(points.slice(next));
      this.presence.set({ id, pressed: false });
      return session.end();
    } catch (error) {
      if (c.activeStroke === session) session.cancel();
      this.presence.set({ id, pressed: false });
      throw error;
    }
  }
}
