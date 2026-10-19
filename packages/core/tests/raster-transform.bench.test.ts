// Free Transform resampling benchmark. Not a CI assertion: it only runs with
// RASTER_TRANSFORM_BENCH=1 and prints a table (or writes it to RASTER_TRANSFORM_BENCH_OUT):
//
//   RASTER_TRANSFORM_BENCH=1 pnpm vitest run packages/core/tests/raster-transform.bench.test.ts
//
// A 4000 × 3000 opaque layer through the transforms Free Transform commits (bicubic) and the
// previews it shows while dragging (at 25 % zoom: a source reduced 4× once per session, then
// nearest or bilinear at a 4 px step).
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { surfaceFromPixels, transformSurface, warpSurface, contentBounds, reduceSurface, type Interpolation } from '../src/raster';
import { evalWarpMesh, homographyFromAffine, multiplyHomographies, rectToQuad, rotateMatrix, scaleMatrix, warpPresetMesh, type Homography } from '../src/geom';

const W = Number(process.env.RASTER_TRANSFORM_BENCH_W ?? 4000);
const H = Number(process.env.RASTER_TRANSFORM_BENCH_H ?? 3000);
const run = process.env.RASTER_TRANSFORM_BENCH === '1';

function photo(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 1;
  for (let i = 0; i < data.length; i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const p = i >> 2;
    data[i] = ((p % w) * 255) / w + (s & 15);
    data[i + 1] = (Math.floor(p / w) * 255) / h + ((s >> 4) & 15);
    data[i + 2] = (s >> 8) & 255;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe.runIf(run)('Free Transform resampling, 4000 × 3000', () => {
  it('prints timings', () => {
    const src = surfaceFromPixels(photo(W, H), 4);
    const box = { x: 0, y: 0, width: W, height: H };
    const c = { x: W / 2, y: H / 2 };
    const cases: Array<[string, Homography | 'warp', Interpolation, number]> = [
      ['rotate 15°', homographyFromAffine(rotateMatrix(15, c)), 'bicubic', 1],
      ['scale 150 %', homographyFromAffine(scaleMatrix(1.5, 1.5, c)), 'bicubic', 1],
      ['scale 50 %', homographyFromAffine(scaleMatrix(0.5, 0.5, c)), 'bicubic', 1],
      ['scale 10 %', homographyFromAffine(scaleMatrix(0.1, 0.1, c)), 'bicubic', 1],
      ['perspective', rectToQuad(box, [{ x: 300, y: 0 }, { x: W - 300, y: 0 }, { x: W, y: H }, { x: 0, y: H }])!, 'bicubic', 1],
      ['rotate 15° bilinear', homographyFromAffine(rotateMatrix(15, c)), 'bilinear', 1],
      ['warp arc 30 %', 'warp', 'bicubic', 1],
    ];
    const mesh = warpPresetMesh({ style: 'arc', bend: 30 }, box)!;
    const rows: string[] = ['| case | ms |', '| --- | ---: |'];
    for (const [name, h, interpolation, step] of cases) {
      const t0 = performance.now();
      const out =
        h === 'warp'
          ? warpSurface(src, (p) => evalWarpMesh(mesh, p.x / W, p.y / H), { interpolation, step, source: box })
          : transformSurface(src, h, { interpolation, step, source: box });
      const ms = performance.now() - t0;
      expect(contentBounds(out)).not.toBeNull();
      rows.push(`| ${name} | ${ms.toFixed(0)} |`);
    }
    // Previews: the source reduced once per session, then each drag update.
    let t0 = performance.now();
    const small = reduceSurface(src, 4);
    rows.push(`| preview source (reduce 4×, once) | ${(performance.now() - t0).toFixed(0)} |`);
    const up: Homography = [4, 0, 0, 0, 4, 0, 0, 0, 1];
    const previews: Array<[string, Homography | 'warp', Interpolation]> = [
      ['preview rotate (bilinear, step 4)', homographyFromAffine(rotateMatrix(15, c)), 'bilinear'],
      ['preview perspective (bilinear, step 4)', rectToQuad(box, [{ x: 300, y: 0 }, { x: W - 300, y: 0 }, { x: W, y: H }, { x: 0, y: H }])!, 'bilinear'],
      ['preview warp (bilinear, step 4)', 'warp', 'bilinear'],
    ];
    for (const [name, h, interpolation] of previews) {
      t0 = performance.now();
      const out =
        h === 'warp'
          ? warpSurface(small, (p) => evalWarpMesh(mesh, (p.x * 4) / W, (p.y * 4) / H), { interpolation, step: 4 })
          : transformSurface(small, multiplyHomographies(up, h), { interpolation, step: 4 });
      expect(contentBounds(out)).not.toBeNull();
      rows.push(`| ${name} | ${(performance.now() - t0).toFixed(0)} |`);
    }
    const table = rows.join('\n');
    if (process.env.RASTER_TRANSFORM_BENCH_OUT) writeFileSync(process.env.RASTER_TRANSFORM_BENCH_OUT, table);
    console.log(table);
  }, 600_000);
});
