/**
 * Object Selection quality without a model (GrabCut): IoU against the true mask, the edge report
 * of `inspect_mask_edge`, and time, for every case in fixtures/object-selection-scenes.ts. Not
 * part of `pnpm test` (the regression floors are in image-editor-object-selection-quality.test.ts).
 * Run it with
 *
 *   pnpm --filter @pixerate/editor exec vitest run --config vitest.eval.config.ts --disableConsoleIntercept tests/evals/object-selection.eval.ts
 *
 * Env: OBJECT_EVAL_OUT (write the JSON report there), OBJECT_EVAL_PNG (a folder for overlays:
 * red where the selection took background, blue where it missed the object).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { it } from 'vitest';
import { inspectMaskEdge, selectObjectIn, selectionValueAt } from '../../src/image-editor';
import { OBJECT_SELECTION_CASES, scoreSelection, type Scene } from '../fixtures/object-selection-scenes';

function png(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function overlay(scene: Scene, value: (x: number, y: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(scene.data);
  for (let y = 0; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++) {
      const p = y * scene.width + x;
      const t = scene.truth[p] >= 0.5;
      const s = value(x, y) >= 0.5;
      if (t === s) continue;
      out[p * 4] = s ? 255 : 0;
      out[p * 4 + 1] = 0;
      out[p * 4 + 2] = s ? 0 : 255;
    }
  }
  return out;
}

it('measures Object Selection without a model', () => {
  const rows: Array<Record<string, unknown>> = [];
  const pngDir = process.env.OBJECT_EVAL_PNG;
  if (pngDir) mkdirSync(pngDir, { recursive: true });
  // OBJECT_EVAL_JITTER=1: each box moved and resized a little four ways, the scores averaged.
  const jitter = process.env.OBJECT_EVAL_JITTER === '1';
  for (const c of OBJECT_SELECTION_CASES) {
    const scene = c.scene();
    if (jitter) {
      const shifts = [[-0.04, -0.03, 0.05], [0.03, 0.04, -0.03], [0.02, -0.04, 0.08], [-0.03, 0.02, -0.05]];
      let sum = 0;
      let ms = 0;
      for (const [dx, dy, grow] of shifts) {
        let target = c.target;
        if ('rect' in target) {
          const r = target.rect;
          const gw = r.width * grow;
          const gh = r.height * grow;
          target = { rect: { x: r.x + dx * r.width - gw / 2, y: r.y + dy * r.height - gh / 2, width: r.width + gw, height: r.height + gh } };
        } else target = { point: { x: target.point.x + dx * 300, y: target.point.y + dy * 300 } };
        const t0 = performance.now();
        const mask = selectObjectIn(scene, target);
        ms += performance.now() - t0;
        sum += scoreSelection(scene, (x, y) => selectionValueAt(mask, x, y)).iou;
      }
      rows.push({ case: c.label, iou: +(sum / shifts.length).toFixed(3), ms: Math.round(ms / shifts.length) });
      continue;
    }
    selectObjectIn(scene, c.target); // warm up (work image, JIT)
    const t0 = performance.now();
    const mask = selectObjectIn(scene, c.target);
    const ms = performance.now() - t0;
    const value = (x: number, y: number) => selectionValueAt(mask, x, y);
    const score = scoreSelection(scene, value);
    let edge: { halo: number; alignment: number; jagged: number } | null = null;
    if (mask.bounds) {
      const r = inspectMaskEdge(mask, { ...scene, x: 0, y: 0 });
      edge = { halo: r.haloScore, alignment: r.edgeAlignment, jagged: r.jaggedness };
    }
    rows.push({ case: c.label, iou: +score.iou.toFixed(3), missed: +score.missed.toFixed(3), extra: +score.extra.toFixed(3), ...edge, ms: Math.round(ms) });
    if (pngDir) writeFileSync(`${pngDir}/${c.label.replace(/[^a-z0-9]+/gi, '-')}.png`, png(scene.width, scene.height, overlay(scene, value)));
  }
  console.table(rows);
  const mean = rows.reduce((s, r) => s + (r.iou as number), 0) / rows.length;
  console.log(`mean IoU ${mean.toFixed(3)}`);
  if (process.env.OBJECT_EVAL_OUT) writeFileSync(process.env.OBJECT_EVAL_OUT, JSON.stringify(rows, null, 2));
});
