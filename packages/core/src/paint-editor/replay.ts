/**
 * Replaying a painting from its data: every recorded stroke, and the changes recorded between them
 * (fills, clears, flattened relief, and wet-media events at the simulation clock they happened at),
 * repainted into a fresh, headless editor.
 *
 * - **Time-lapse**: frames of the painting as it is repainted (after strokes, and while wet paint
 *   flows between them), as PNGs and as a `VideoProject` of stills that the video editor's export
 *   path (`toVideoFfmpeg`) turns into an MP4.
 * - **High-resolution export**: the same replay at a larger scale (points, brush sizes, paper grain
 *   and rectangles scaled), so the picture is painted again with more pixels instead of upscaled.
 *
 * Strokes paint exactly as recorded: same seed, load and symmetry copies, and wet strokes apply
 * each point at the clock it was recorded at, with the simulation stepped in between, so wet paint
 * flows as it did. What was not recorded as data (imported pixels, merges, transforms of layers,
 * changes made before strokes were recorded) is not repeated: those layers start empty.
 */

import { encodePng } from '../raster/png';
import type { BlendMode } from '../raster/blend';
import { writeZip } from '../export/zip-writer';
import { emptySurface } from '../raster/surface';
import { mapLayer, flattenLayers } from '../raster/layers';
import type { VideoAsset, VideoClip, VideoProject } from '../video-editor/types';
import { toVideoFfmpeg, type VideoFfmpegExport } from '../video-editor/export';
import type { PaintDocumentState, PaintLayer, PaintPixelLayer } from './document';
import type { PaintEditorController, PixelImage } from './controller';
import type { PenPoint } from './engine';
import { varyStroke, type Affine, type RecordedStroke } from './strokes';
import type { PaintStrokeSession } from './stroke';
import type { WetEvent } from './wet';
import { scaleStencil } from './stencils';
import type { Sticker } from './stickers';
import type { PaintMagnet } from './ferro';
import type { CultureGrowEventData } from '../paint/culture';
import type { WetFlowSpec } from '../paint/wet/flow';
import type { WetParams, WetTilt } from '../paint/wet/model';
import type { LivePatternsInput, LivePatternsSettings } from '../paint/live-patterns';
import { downsampleRgba } from './render';

export interface PaintReplayOptions {
  /** Paint at this many times the size (1 for a time-lapse; 1..8 for a high-resolution export). */
  scale?: number;
  /** Stop after this many strokes (default all). */
  strokes?: number;
}

/** One frame of a replay. */
export interface ReplayFrame extends PixelImage {
  /** Strokes painted so far. */
  stroke: number;
  /** Wet-media clock (steps). */
  clock: number;
}

export interface TimeLapseOptions {
  /** Longest side of each frame in pixels (default 720). */
  maxSide?: number;
  /** A frame after every this many strokes (default: about `frames` frames over the whole painting). */
  strokesPerFrame?: number;
  /** About how many frames in all (default 120). */
  frames?: number;
  /** While wet paint flows between strokes, a frame every this many steps (default 60; 0: none). */
  wetStepsPerFrame?: number;
  /** Frames per second of the video (default 12). */
  fps?: number;
  /** Hold the finished painting this long at the end (ms, default 1500). */
  holdMs?: number;
  /** Called after each frame with how far along the replay is (0..1). */
  onProgress?: (done: number) => void;
}

export interface TimeLapse {
  fps: number;
  width: number;
  height: number;
  /** Each frame as PNG bytes. */
  frames: Uint8Array[];
  /** The frames as stills on a timeline (assets `frame-0001.png`…; `src` is that file name). */
  video: VideoProject;
  /** The ffmpeg command that renders `video` to `timelapse.mp4` from the frame files. */
  ffmpeg: VideoFfmpegExport;
  durationMs: number;
}

/** One thing a replay repeats: a recorded stroke, a wet event or a paint event. */
export type ReplayItem = { kind: 'stroke'; stroke: RecordedStroke } | { kind: 'wet'; event: WetEvent } | { kind: 'paint'; event: NonNullable<PaintDocumentState['paintEvents']>[number] };

/** Strokes and events in the order they happened. */
export function replayItems(doc: PaintDocumentState): ReplayItem[] {
  const items: Array<ReplayItem & { at: number; order: number }> = [];
  let order = 0;
  doc.strokes.forEach((stroke, i) => items.push({ kind: 'stroke', stroke, at: i + 0.5, order: order++ }));
  for (const event of doc.paintEvents ?? []) items.push({ kind: 'paint', event, at: event.at, order: order++ });
  for (const event of doc.wetEvents ?? []) items.push({ kind: 'wet', event, at: event.at ?? 0, order: order++ });
  items.sort((a, b) => a.at - b.at || a.order - b.order);
  return items.map(({ at: _a, order: _o, ...item }) => item as ReplayItem);
}

/** The layer tree with every pixel layer empty (what a replay paints into). */
function emptiedLayers(layers: readonly PaintLayer[]): PaintLayer[] {
  let out = [...layers] as PaintLayer[];
  for (const l of flattenLayers(layers)) if (l.type === 'pixel') out = mapLayer(out, l.id, () => ({ ...(l as PaintPixelLayer), surface: emptySurface(4), offset: { x: 0, y: 0 } }));
  return out;
}

/** How a replay paints: at what scale, and where it lets the host in while wet paint flows. */
export interface ReplayItemOptions {
  /** Paint at this many times the size (default 1). */
  scale?: number;
  /** Step the simulation at most this many steps at a time (default: all at once). */
  wetChunk?: number;
  /** Called after each chunk of wet steps (with `wetChunk`). */
  onWetSteps?: (clock: number) => Promise<void> | void;
  /** A wet stroke takes at most this many points at a time (default: all those applied at one clock). */
  pointChunk?: number;
  /** Called between two chunks of a wet stroke's points (with `pointChunk`). */
  onPoints?: () => Promise<void> | void;
}

/**
 * Steps `target`'s wet simulation up to `clock` (in chunks of `wetChunk`). Returns the steps run:
 * fewer when there is no simulation to step yet (its clock can't move).
 */
export async function advanceReplayClock(target: PaintEditorController, clock: number, options: ReplayItemOptions = {}): Promise<number> {
  const chunk = Math.max(1, options.wetChunk ?? 0) || Infinity;
  const start = target.getState().wet.clock;
  let left = clock - start;
  while (left > 0) {
    const n = Math.min(left, chunk);
    const ran = (await target.advanceWet({ steps: n })).steps;
    if (Number.isFinite(chunk)) await options.onWetSteps?.(target.getState().wet.clock);
    if (ran <= 0) break;
    left -= ran;
  }
  return target.getState().wet.clock - start;
}

/** What a recorded stroke replays with (`beginStroke` / `paintStroke` options without the points), at `scale`. */
export function replayStrokeInit(st: RecordedStroke, scale = 1) {
  return {
    layerId: st.layerId,
    color: st.color,
    brush: st.brush,
    seed: st.seed,
    copies: (st.copies ?? []) as Affine[],
    ...(st.load ? { load: st.load } : {}),
    ...(st.paint ? { paint: st.paint } : {}),
    ...(st.targets ? { targets: st.targets } : {}),
    snapToPerspective: false,
    stencils: false,
    maskStencils: (st.stencils ?? []).map((x) => (scale === 1 ? x : scaleStencil(x, scale))),
    ...(st.scrapeLayerIds ? { scrapeLayerIds: st.scrapeLayerIds } : {}),
  };
}

/** Ends a replayed wet stroke and waits until the simulation has applied all of it. */
export async function finishReplayStroke(target: PaintEditorController, session: PaintStrokeSession): Promise<void> {
  await target.wetIdle();
  session.end();
  while (session.pendingEnd) {
    await target.wetIdle();
    session.completeWetEnd();
    if (session.pendingEnd) await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Repeats one recorded stroke or event (`replayItems`) on `target`: strokes paint exactly as
 * recorded (wet ones point by point, each at its clock), events change what they changed. A
 * stroke's effect paint must already be prepared (`prepareEffectPaints`), except a path-mapped
 * one, which is prepared here.
 */
export async function replayItem(target: PaintEditorController, item: ReplayItem, options: ReplayItemOptions = {}): Promise<void> {
  const s = options.scale ?? 1;
  const scaleM: Affine = [s, 0, 0, s, 0, 0];
  const advanceTo = (clock: number) => advanceReplayClock(target, clock, options);
  const sr = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s });
  if (item.kind === 'paint') {
    const e = item.event;
    if (e.kind === 'magnets') {
      const d = e.data as { magnets?: PaintMagnet[]; advect?: boolean } | undefined;
      const list = (d?.magnets ?? []).map((m) => (s === 1 ? m : { ...m, x: m.x * s, y: m.y * s, radius: Math.min(2000, Math.max(8, m.radius * s)) }));
      target.replaceMagnets(list, Boolean(d?.advect));
      return;
    }
    if (!target.getLayer(e.layerId)) return;
    if (e.kind === 'fill') target.fillLayer({ layerId: e.layerId, ...(e.data as object) });
    else if (e.kind === 'fill-region') {
      const d = (e.data ?? {}) as {
        points?: Array<{ x: number; y: number }>;
        x?: number;
        y?: number;
        reference?: string;
        color?: string;
        opacity?: number;
        blend?: BlendMode;
        tolerance?: number;
        closeGap?: number;
        expand?: number;
        antialias?: boolean;
        grain?: number;
        pressure?: number;
        wet?: boolean;
      };
      if (d.wet) await target.wetIdle();
      const pts = d.points ? d.points.map((p) => ({ x: p.x * s, y: p.y * s })) : d.x !== undefined && d.y !== undefined ? [{ x: d.x * s, y: d.y * s }] : [];
      target.fillRegion({
        ...d,
        layerId: e.layerId,
        points: pts,
        ...(d.closeGap !== undefined ? { closeGap: Math.min(32, d.closeGap * s) } : {}),
        ...(d.expand !== undefined ? { expand: Math.max(-16, Math.min(16, d.expand * s)) } : {}),
      });
    } else if (e.kind === 'clear') target.clearLayer(e.layerId);
    else if (e.kind === 'cure-ferrofluid') target.cureFerrofluid(e.layerId);
    else if (e.kind === 'culture-grow') target.replayCultureGrow(e.layerId, e.data as unknown as CultureGrowEventData, s);
    else if (e.kind === 'live-strokes') {
      const d = e.data as { strokes?: RecordedStroke[]; rasterized?: boolean } | undefined;
      if (d?.rasterized) target.replaceLiveStrokes(e.layerId, null);
      else {
        const list = (d?.strokes ?? []).map((st) => (s === 1 ? st : { ...varyStroke(st, scaleM, { scale: s }), ...(st.stencils ? { stencils: st.stencils.map((x) => scaleStencil(x, s)) } : {}) }));
        await target.prepareEffectPaints(list.flatMap((st) => (st.paint?.type === 'effect' ? [st.paint] : [])));
        target.replaceLiveStrokes(e.layerId, list);
      }
    } else if (e.kind === 'stickers') {
      const list = ((e.data as { stickers?: Sticker[] })?.stickers ?? []).map((x) => (s === 1 ? x : { ...x, x: x.x * s, y: x.y * s, size: x.size * s }));
      target.replaceStickers(e.layerId, list);
    } else target.flattenRelief(e.layerId);
    return;
  }
  if (item.kind === 'wet') {
    const e = item.event;
    await target.wetIdle();
    await advanceTo(e.clock);
    try {
      switch (e.kind) {
        case 'dry': {
          const rect = e.data as { x: number; y: number; width: number; height: number } | undefined;
          const ids = e.layerId?.split(',').filter(Boolean);
          if (ids?.length) for (const id of ids) target.dryPaint({ layerId: id, rect: rect ? sr(rect) : undefined });
          else target.dryPaint({ rect: rect ? sr(rect) : undefined });
          break;
        }
        case 'tilt':
          target.setCanvasTilt(e.data as WetTilt);
          break;
        case 'params':
          if (e.layerId && target.getLayer(e.layerId)) target.setWetParams(e.layerId, e.data as WetParams);
          break;
        case 'flow': {
          const f = { ...(e.data as WetFlowSpec) };
          if (f.center) f.center = { x: f.center.x * s, y: f.center.y * s };
          if (f.scale) f.scale = Math.min(1024, f.scale * s);
          if (e.layerId && target.getLayer(e.layerId)) target.setFlowMap(e.layerId, f);
          break;
        }
        case 'wet-paper': {
          const d = e.data as { rect: { x: number; y: number; width: number; height: number }; amount: number };
          if (e.layerId && target.getLayer(e.layerId)) target.wetPaper({ layerId: e.layerId, rect: sr(d.rect), amount: d.amount });
          break;
        }
        case 'live-patterns': {
          const d = e.data as LivePatternsSettings | null;
          if (e.layerId && target.getLayer(e.layerId)) {
            target.setLivePatterns(e.layerId, d ? { ...d, scale: Math.min(4, d.scale * s), enabled: true } : { enabled: false });
          }
          break;
        }
        case 'seed-live-patterns': {
          const d = e.data as {
            points: Array<{ x: number; y: number; strength?: number }>;
            radius: number;
            seed: number;
            settings?: LivePatternsInput;
          };
          if (e.layerId && target.getLayer(e.layerId) && Array.isArray(d.points)) {
            target.seedLivePatterns({
              layerId: e.layerId,
              points: d.points.map((p) => ({ ...p, x: p.x * s, y: p.y * s })),
              radius: Math.min(512, d.radius * s),
              seed: d.seed,
              ...(d.settings ? { ...d.settings, ...(d.settings.scale ? { scale: Math.min(4, d.settings.scale * s) } : {}) } : {}),
            });
          }
          break;
        }
        case 'ghost-release': {
          const d = e.data as { linger?: number } | undefined;
          if (e.layerId && target.getLayer(e.layerId)) target.wet.releaseGhost(e.layerId, d?.linger);
          break;
        }
        case 'ghost-keep': {
          if (e.layerId && target.getLayer(e.layerId)) target.wet.keepGhost(e.layerId);
          break;
        }
      }
    } catch {
      // An event that no longer applies (its layer went away) is skipped.
    }
    return;
  }
  const st = s === 1 ? item.stroke : varyStroke(item.stroke, scaleM, { scale: s });
  if (!target.getLayer(st.layerId)) return;
  if (st.paint?.type === 'effect' && st.paint.map?.by === 'path') await target.prepareEffectPaints([st.paint]);
  const init = replayStrokeInit(st, s);
  if (st.brush.engine === 'wet' && st.steps?.length === st.points.length) {
    // Each point at the clock it was recorded at, the simulation stepped in between.
    await target.wetIdle();
    await advanceTo(st.steps[0]);
    const session = target.beginStroke({ ...init, start: st.points[0] });
    // Points applied at the same clock go in together (the same dabs as one by one, without a display update each).
    for (let i = 0; i < st.points.length; ) {
      let j = i + 1;
      while (j < st.points.length && st.steps[j] === st.steps[i] && j - i < (options.pointChunk ?? Infinity)) j++;
      await advanceTo(st.steps[i]);
      await target.wetIdle();
      session.push(st.points.slice(i, j) as PenPoint[]);
      if (options.pointChunk && j < st.points.length) await options.onPoints?.();
      i = j;
    }
    await finishReplayStroke(target, session);
  } else {
    await target.wetIdle();
    target.paintStroke({ ...init, points: st.points });
  }
}

/**
 * Replays a controller's painting into `target` (a fresh controller the caller made at the scaled
 * size; see `PaintEditorController.createReplayTarget`), calling `onFrame` where frames are due.
 */
export async function replayPainting(
  source: PaintDocumentState,
  target: PaintEditorController,
  options: PaintReplayOptions & { onStroke?: (index: number) => Promise<void> | void; onWetSteps?: (clock: number) => Promise<void> | void; wetChunk?: number } = {}
): Promise<void> {
  const s = options.scale ?? 1;
  const scaleM: Affine = [s, 0, 0, s, 0, 0];
  const items = replayItems(source);
  const maxStrokes = options.strokes ?? source.strokes.length;
  // Strokes are synchronous: render their effect paint first (throws naming an effect that cannot be),
  // as the scaled strokes ask for it (scaling a stroke-mapped effect scales its map length).
  // A path-mapped stroke has a canvas-sized render of its own: those are rendered one at a time.
  const scaled = source.strokes.slice(0, maxStrokes).map((st) => (s === 1 ? st : varyStroke(st, scaleM, { scale: s })));
  await target.prepareEffectPaints(scaled.flatMap((st) => (st.paint?.type === 'effect' && st.paint.map?.by !== 'path' ? [st.paint] : [])));
  const itemOptions: ReplayItemOptions = { scale: s, wetChunk: options.wetChunk, onWetSteps: options.onWetSteps };
  let strokes = 0;
  for (const item of items) {
    if (item.kind === 'stroke') {
      if (strokes >= maxStrokes) break;
      strokes++;
      if (!target.getLayer(item.stroke.layerId)) continue;
    }
    await replayItem(target, item, itemOptions);
    if (item.kind === 'stroke') await options.onStroke?.(strokes);
  }
}

/** A frame of `target` at most `maxSide` pixels on its longest side. */
export function replayFrame(target: PaintEditorController, maxSide: number, stroke: number): ReplayFrame {
  const img = target.renderPreview({ maxSide, wet: 'display' });
  return { ...img, stroke, clock: target.getState().wet.clock };
}

/** Frames as stills on a video timeline, `1 / fps` each, with the last held for `holdMs`. */
export function timeLapseVideo(frameCount: number, width: number, height: number, fps: number, holdMs: number, name = 'Time-lapse'): { video: VideoProject; ffmpeg: VideoFfmpegExport; durationMs: number } {
  const w = Math.max(2, 2 * Math.round(width / 2));
  const h = Math.max(2, 2 * Math.round(height / 2));
  const frameMs = 1000 / fps;
  const assets: VideoAsset[] = [];
  const clips: VideoClip[] = [];
  for (let i = 0; i < frameCount; i++) {
    const id = `frame-${String(i + 1).padStart(4, '0')}`;
    assets.push({ id, kind: 'image', src: `${id}.png`, name: `${id}.png`, width, height });
    const start = Math.round(i * frameMs * 1000) / 1000;
    const end = i === frameCount - 1 ? start + frameMs + holdMs : Math.round((i + 1) * frameMs * 1000) / 1000;
    clips.push({ id: `clip-${i + 1}`, type: 'media', asset: id, start, duration: end - start } as VideoClip);
  }
  const video: VideoProject = { version: 1, name, width: w, height: h, fps, background: '#000000', assets, tracks: [{ id: 'v1', kind: 'video', clips } as VideoProject['tracks'][number]] };
  const durationMs = frameCount ? clips[clips.length - 1].start + clips[clips.length - 1].duration : 0;
  return { video, ffmpeg: toVideoFfmpeg(video, { output: 'timelapse.mp4' }), durationMs };
}

/** Builds the time-lapse of a painting (see `PaintEditorController.timeLapse`). */
export async function buildTimeLapse(source: PaintDocumentState, target: PaintEditorController, options: TimeLapseOptions = {}): Promise<TimeLapse> {
  const maxSide = Math.max(32, Math.min(4096, Math.round(options.maxSide ?? 720)));
  const total = source.strokes.length;
  const perFrame = Math.max(1, options.strokesPerFrame ?? Math.ceil(total / Math.max(1, options.frames ?? 120)));
  const wetEvery = options.wetStepsPerFrame ?? 60;
  const fps = Math.max(1, Math.min(60, options.fps ?? 12));
  const frames: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  const shoot = (stroke: number) => {
    const f = replayFrame(target, maxSide, stroke);
    width = f.width;
    height = f.height;
    frames.push(encodePng(f.width, f.height, f.data));
  };
  shoot(0);
  await replayPainting(source, target, {
    wetChunk: wetEvery > 0 ? wetEvery : 0,
    onStroke: (i) => {
      if (i % perFrame === 0 || i === total) shoot(i);
      options.onProgress?.(total ? i / total : 1);
    },
    onWetSteps: wetEvery > 0 ? () => shoot(-1) : undefined,
  });
  // Let the last wet paint settle on screen.
  const { video, ffmpeg, durationMs } = timeLapseVideo(frames.length, width, height, fps, options.holdMs ?? 1500);
  return { fps, width, height, frames, video, ffmpeg, durationMs };
}

/** A contact sheet: up to `count` frames side by side, for a quick look. */
export function contactSheet(frames: readonly PixelImage[], columns = 3, cell = 200): PixelImage {
  const n = frames.length;
  const rows = Math.ceil(n / columns);
  if (n) cell = Math.min(cell, frames[0].width);
  const ar = n ? frames[0].height / frames[0].width : 1;
  const ch = Math.max(1, Math.round(cell * ar));
  const out = new Uint8ClampedArray(columns * cell * rows * ch * 4).fill(255);
  const W = columns * cell;
  frames.forEach((f, i) => {
    const small = downsampleRgba(f.data, f.width, f.height, cell, ch);
    const ox = (i % columns) * cell;
    const oy = Math.floor(i / columns) * ch;
    for (let y = 0; y < ch; y++) out.set(small.subarray(y * cell * 4, (y + 1) * cell * 4), ((oy + y) * W + ox) * 4);
  });
  return { width: W, height: rows * ch, data: out };
}

export { emptiedLayers };

/**
 * A time-lapse as one ZIP: the frames (`frame-0001.png`…), the video project (`timelapse.json`,
 * which the video editor opens), and `render.sh` with the ffmpeg command that turns them into
 * `timelapse.mp4`.
 */
export async function timeLapseZip(tl: TimeLapse): Promise<Uint8Array> {
  const entries = tl.frames.map((data, i) => ({ name: `frame-${String(i + 1).padStart(4, '0')}.png`, data }));
  entries.push({ name: 'timelapse.json', data: new TextEncoder().encode(JSON.stringify(tl.video, null, 2)) });
  entries.push({ name: 'render.sh', data: new TextEncoder().encode(`#!/bin/sh\n# Renders the time-lapse with ffmpeg (run in this folder).\n${tl.ffmpeg.command}\n`) });
  return writeZip(entries, { compression: 'store' });
}
