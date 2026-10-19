// Layer compositor benchmark. Not a CI assertion: it only runs with IMAGE_LAYERS_BENCH=1 and
// prints a table (or writes it to IMAGE_LAYERS_BENCH_OUT). Run it with
//
//   IMAGE_LAYERS_BENCH=1 pnpm vitest run packages/core/tests/image-layers.bench.test.ts
//
// The budget from docs/image-editor-layers.md: under 16 ms per pointer event for a 100 px brush
// on a 4000 × 3000, 10-layer document. A pointer event is modelled as a 100 px dab written into
// one layer's surface (copy-on-write) followed by recompositing the canvas; only the tiles the dab
// touched are recomputed, from the edited layer up.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LayerCompositor,
  TILE,
  createAdjustmentLayer,
  surfaceFromPixels,
  writeRegion,
  type AdjustmentLayerNode,
  type ImageLayer,
  type PixelLayer,
} from '../src/image-editor';

const W = Number(process.env.IMAGE_LAYERS_BENCH_W ?? 4000);
const H = Number(process.env.IMAGE_LAYERS_BENCH_H ?? 3000);

function photo(w: number, h: number, seed: number, alpha = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < data.length; i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const p = i >> 2;
    data[i] = ((p % w) * 255) / w + (s & 15);
    data[i + 1] = (Math.floor(p / w) * 255) / h + ((s >> 4) & 15);
    data[i + 2] = (s >> 8) & 255;
    data[i + 3] = alpha;
  }
  return { width: w, height: h, data };
}

function pixel(id: string, seed: number, extra: Partial<PixelLayer> = {}, size = { w: W, h: H }, alpha = 255): PixelLayer {
  return {
    type: 'pixel',
    id,
    name: id,
    visible: true,
    opacity: 1,
    blend: 'normal',
    surface: surfaceFromPixels(photo(size.w, size.h, seed, alpha), 4),
    offset: { x: 0, y: 0 },
    ...extra,
  };
}

function adjustment(kind: Parameters<typeof createAdjustmentLayer>[0], params: object, extra: Partial<AdjustmentLayerNode> = {}): AdjustmentLayerNode {
  const l = createAdjustmentLayer(kind, { params: params as never });
  return { type: 'adjustment', id: l.id, name: '', visible: true, opacity: 1, blend: 'normal', kind: l.kind, params: l.params, ...extra } as AdjustmentLayerNode;
}

/** Ten layers: a full photo with a develop filter, painted layers in blend modes, adjustments with masks. */
function tenLayers(heavy: boolean): ImageLayer[] {
  return [
    pixel('background', 1, { filters: [{ id: 'd', kind: 'develop', enabled: true, brightness: 10, contrast: 15, saturation: 5, exposure: 0, temperature: 4, tint: 0, process: 2 }] }),
    pixel('paint1', 2, { blend: 'multiply', opacity: 0.8 }, { w: W, h: H }, 160),
    adjustment('curves', { master: [{ input: 0, output: 10 }, { input: 128, output: 140 }, { input: 255, output: 245 }] }),
    pixel('paint2', 3, { blend: 'screen', opacity: 0.6 }, { w: W, h: H }, 120),
    heavy ? adjustment('hueSaturation', { hue: 12, saturation: 10 }, { opacity: 0.7 }) : adjustment('colorBalance', { midtones: [10, 0, -5] }, { opacity: 0.7 }),
    pixel('paint3', 4, { blend: 'overlay' }, { w: W, h: H }, 90),
    pixel('paint4', 5, { blend: 'soft-light', fillOpacity: 0.5 }, { w: W, h: H }, 200),
    heavy ? adjustment('vibrance', { vibrance: 25 }) : adjustment('curves', { red: [{ input: 0, output: 5 }, { input: 255, output: 250 }] }),
    pixel('paint5', 6, { blend: 'normal', opacity: 0.5 }, { w: W, h: H }, 60),
    adjustment('levels', { master: { inBlack: 5, inWhite: 250, gamma: 1.1, outBlack: 0, outWhite: 255 } }),
  ];
}

const time = (fn: () => void) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe.runIf(process.env.IMAGE_LAYERS_BENCH)('image layer compositor benchmark', () => {
  for (const heavy of [false, true]) it(`composites a ${W} × ${H}, 10-layer document and recomposites per brush dab (${heavy ? 'Vibrance and Hue/Saturation' : 'LUT adjustments'})`, () => {
    const report: Record<string, string> = { scenario: heavy ? 'Vibrance + Hue/Saturation above the painted layer' : 'tone-curve (LUT) adjustments only' };
    const sources = { width: W, height: H };
    const rect = { x: 0, y: 0, width: W, height: H };
    let layers = tenLayers(heavy);
    const c = new LayerCompositor({ maxCacheBytes: 2 * 1024 * 1024 * 1024 });
    const consume = () => {};
    // The layer being painted is the active one: the compositor keeps a checkpoint below it.
    const hint = { checkpointLayerId: 'paint3' };
    report['first full composite'] = `${time(() => c.compositeTiles(layers, rect, sources, consume, hint)).toFixed(0)} ms (${c.lastStats.tiles} tiles)`;
    report['unchanged re-render'] = `${time(() => c.compositeTiles(layers, rect, sources, consume)).toFixed(1)} ms`;

    // Pointer events: a 100 px dab on the 4th layer (index 5), moving across the canvas.
    const target = 5;
    const dab = new Uint8ClampedArray(100 * 100 * 4).fill(180);
    const samples: number[] = [];
    for (let k = 0; k < 40; k++) {
      const x = 500 + k * 37;
      const y = 800 + ((k * 53) % 900);
      samples.push(
        time(() => {
          const l = layers[target] as PixelLayer;
          const next = { ...l, surface: writeRegion(l.surface, { x, y, width: 100, height: 100 }, dab) };
          layers = layers.map((v, i) => (i === target ? next : v));
          c.compositeTiles(layers, rect, sources, consume, { ...hint, dirty: [{ x, y, width: 100, height: 100 }] });
        })
      );
    }
    samples.sort((a, b) => a - b);
    report['brush dab, median'] = `${samples[samples.length >> 1].toFixed(2)} ms`;
    report['brush dab, p95'] = `${samples[Math.floor(samples.length * 0.95)].toFixed(2)} ms`;
    report['brush dab, tiles recomposited (last)'] = `${c.lastStats.tiles - c.lastStats.cached} of ${c.lastStats.tiles}`;

    // A slider drag on the top adjustment layer: every tile, from the prefix checkpoint up.
    const drag: number[] = [];
    for (let k = 0; k < 4; k++) {
      const top = layers[9] as AdjustmentLayerNode;
      const next = { ...top, opacity: 0.5 + k * 0.1 } as AdjustmentLayerNode;
      layers = layers.map((v, i) => (i === 9 ? next : v));
      drag.push(time(() => c.compositeTiles(layers, rect, sources, consume)));
    }
    report['slider drag on top layer (after first)'] = `${Math.min(...drag.slice(1)).toFixed(0)} ms per frame`;
    report['tile size'] = `${TILE}`;

    const text = Object.entries(report).map(([k, v]) => `${k.padEnd(42)} ${v}`).join('\n');
    if (process.env.IMAGE_LAYERS_BENCH_OUT) writeFileSync(process.env.IMAGE_LAYERS_BENCH_OUT, text + '\n\n', { flag: 'a' });
    else console.log(text);
    expect(samples.length).toBe(40);
  }, 600_000);
});
