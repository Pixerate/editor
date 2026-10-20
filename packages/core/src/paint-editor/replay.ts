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
import { writeZip } from '../export/zip-writer';
import { emptySurface } from '../raster/surface';
import { mapLayer, flattenLayers } from '../raster/layers';
import type { VideoAsset, VideoClip, VideoProject } from '../video-editor/types';
import { toVideoFfmpeg, type VideoFfmpegExport } from '../video-editor/export';
import type { PaintDocumentState, PaintLayer, PaintPixelLayer } from './document';
import type { PaintEditorController, PixelImage } from './controller';
import type { PenPoint } from './engine';
import { IDENTITY_AFFINE, varyStroke, type Affine, type RecordedStroke } from './strokes';
import type { WetEvent } from './wet';
import type { WetFlowSpec } from '../paint/wet/flow';
import type { WetParams, WetTilt } from '../paint/wet/model';
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

type Item = { kind: 'stroke'; stroke: RecordedStroke } | { kind: 'wet'; event: WetEvent } | { kind: 'paint'; event: NonNullable<PaintDocumentState['paintEvents']>[number] };

/** Strokes and events in the order they happened. */
export function replayItems(doc: PaintDocumentState): Item[] {
  const items: Array<Item & { at: number; order: number }> = [];
  let order = 0;
  doc.strokes.forEach((stroke, i) => items.push({ kind: 'stroke', stroke, at: i + 0.5, order: order++ }));
  for (const event of doc.paintEvents ?? []) items.push({ kind: 'paint', event, at: event.at, order: order++ });
  for (const event of doc.wetEvents ?? []) items.push({ kind: 'wet', event, at: event.at ?? 0, order: order++ });
  items.sort((a, b) => a.at - b.at || a.order - b.order);
  return items.map(({ at: _a, order: _o, ...item }) => item as Item);
}

/** The layer tree with every pixel layer empty (what a replay paints into). */
function emptiedLayers(layers: readonly PaintLayer[]): PaintLayer[] {
  let out = [...layers] as PaintLayer[];
  for (const l of flattenLayers(layers)) if (l.type === 'pixel') out = mapLayer(out, l.id, () => ({ ...(l as PaintPixelLayer), surface: emptySurface(4), offset: { x: 0, y: 0 } }));
  return out;
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
  const chunk = Math.max(1, options.wetChunk ?? 0) || Infinity;
  let strokes = 0;
  const advanceTo = async (clock: number) => {
    const now = target.getState().wet.clock;
    let left = clock - now;
    while (left > 0) {
      const n = Math.min(left, chunk);
      await target.advanceWet({ steps: n });
      left -= n;
      if (Number.isFinite(chunk)) await options.onWetSteps?.(target.getState().wet.clock);
    }
  };
  const sr = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s });
  for (const item of items) {
    if (strokes >= maxStrokes && item.kind === 'stroke') break;
    if (item.kind === 'paint') {
      const e = item.event;
      if (!target.getLayer(e.layerId)) continue;
      if (e.kind === 'fill') target.fillLayer({ layerId: e.layerId, ...(e.data as object) });
      else if (e.kind === 'clear') target.clearLayer(e.layerId);
      else target.flattenRelief(e.layerId);
      continue;
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
        }
      } catch {
        // An event that no longer applies (its layer went away) is skipped.
      }
      continue;
    }
    const st = s === 1 ? item.stroke : varyStroke(item.stroke, scaleM, { scale: s });
    strokes++;
    if (!target.getLayer(st.layerId)) continue;
    const init = { layerId: st.layerId, color: st.color, brush: st.brush, seed: st.seed, copies: (st.copies ?? []) as Affine[], ...(st.load ? { load: st.load } : {}), snapToPerspective: false };
    if (st.brush.engine === 'wet' && st.steps?.length === st.points.length) {
      // Each point at the clock it was recorded at, the simulation stepped in between.
      await target.wetIdle();
      await advanceTo(st.steps[0]);
      const session = target.beginStroke({ ...init, start: st.points[0] });
      for (let i = 0; i < st.points.length; i++) {
        await advanceTo(st.steps[i]);
        await target.wetIdle();
        session.push([st.points[i] as PenPoint]);
      }
      await target.wetIdle();
      session.end();
      while (session.pendingEnd) {
        await target.wetIdle();
        session.completeWetEnd();
        if (session.pendingEnd) await new Promise((r) => setTimeout(r, 0));
      }
    } else {
      await target.wetIdle();
      target.paintStroke({ ...init, points: st.points });
    }
    await options.onStroke?.(strokes);
  }
  void IDENTITY_AFFINE;
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
