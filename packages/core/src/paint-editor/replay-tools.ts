/**
 * Agent tools for replaying a painting from its data: a time-lapse (frames, a video project of the
 * frames and the ffmpeg command that renders it) and a high-resolution export repainted from the
 * recorded strokes.
 */

import { bytesToBase64, decodePng, encodePng } from '../raster/png';
import type { AgentTool } from '../tools/registry.js';
import type { PaintEditorController } from './controller';
import { contactSheet } from './replay';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function createPaintReplayTools(c: PaintEditorController): AgentTool[] {
  return [
    {
      name: 'export_time_lapse',
      title: 'Export a time-lapse',
      description:
        'Repaints the painting from its recorded strokes and events (fills, clears, wet-media events at their clock) in a fresh editor and returns a time-lapse: frame count, fps, size, duration, a video project of the frames as stills (assets frame-0001.png…), and the ffmpeg command that renders it to timelapse.mp4 from the frame files (the video editor export path). Shows a contact sheet of a few frames. With includeFrames the frames come back as base64 PNGs too. Changes nothing. Layers with pixels that were not painted with recorded strokes (imported images, merges) start empty in the replay.',
      inputSchema: {
        type: 'object',
        properties: {
          frames: { type: 'integer', minimum: 2, maximum: 600, description: 'About how many frames (default 120); one after every few strokes.' },
          fps: { type: 'number', minimum: 1, maximum: 60, description: 'Frames per second of the video (default 12).' },
          maxSide: { type: 'integer', minimum: 32, maximum: 4096, description: 'Longest side of each frame in pixels (default 720).' },
          wetStepsPerFrame: { type: 'integer', minimum: 0, maximum: 10000, description: 'While wet paint flows between strokes, a frame every this many simulation steps (default 60; 0 none).' },
          holdMs: { type: 'number', minimum: 0, maximum: 10000, description: 'Hold the finished painting this long at the end, ms (default 1500).' },
          includeFrames: { type: 'boolean', description: 'Also return every frame as base64 PNG (large; default false).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Export a time-lapse', ...READ },
      handler: async (a) => {
        await c.wetIdle();
        const tl = await c.timeLapse({ frames: a.frames, fps: a.fps, maxSide: a.maxSide, wetStepsPerFrame: a.wetStepsPerFrame, holdMs: a.holdMs });
        const pick = [0, Math.floor(tl.frames.length / 3), Math.floor((2 * tl.frames.length) / 3), tl.frames.length - 1].filter((v, i, arr) => arr.indexOf(v) === i);
        const sheet = contactSheet(pick.map((i) => decodePng(tl.frames[i])), pick.length, 160);
        const info = {
          frames: tl.frames.length,
          fps: tl.fps,
          width: tl.width,
          height: tl.height,
          durationMs: tl.durationMs,
          ffmpeg: tl.ffmpeg.command,
          video: tl.video,
          ...(a.includeFrames ? { framesPng: tl.frames.map((f) => bytesToBase64(f)) } : {}),
        };
        return { content: [{ type: 'image', data: bytesToBase64(encodePng(sheet.width, sheet.height, sheet.data)), mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(info) }] };
      },
    },
    {
      name: 'export_high_res',
      title: 'Export at a higher resolution',
      description:
        'Repaints the painting from its recorded strokes at scale (2..8) times the size, with brush sizes, paper grain, fills and wet events scaled, so the export has real detail instead of upscaled pixels; wet paint is dried. Returns a PNG as base64 with its size. Changes nothing. Layers with pixels that were not painted with recorded strokes come out empty; the canvas may be at most 16384 px per side.',
      inputSchema: {
        type: 'object',
        properties: {
          scale: { type: 'number', minimum: 1, maximum: 8, description: 'How many times larger (e.g. 2 doubles width and height).' },
          paper: { type: 'boolean', description: 'Include the paper (default true).' },
        },
        required: ['scale'],
        additionalProperties: false,
      },
      annotations: { title: 'Export at a higher resolution', ...READ },
      handler: async ({ scale, paper }) => {
        await c.wetIdle();
        const img = await c.renderHighRes({ scale, paper });
        const bytes = encodePng(img.width, img.height, img.data);
        return { mimeType: 'image/png', width: img.width, height: img.height, bytes: bytes.length, data: bytesToBase64(bytes) };
      },
    },
  ];
}
