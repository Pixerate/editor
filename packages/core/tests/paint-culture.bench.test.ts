import { describe, expect, it } from 'vitest';
import { PaintEditorController } from '../src/paint-editor';

describe.skip('Biopaint mycelial ink benchmark (#684)', () => {
  it('ticks 500 living tips on a 512x512 canvas within 2 ms/tick budget', () => {
    const c = new PaintEditorController({ width: 512, height: 512 });
    for (let i = 0; i < 6; i++) {
      c.paintStroke({
        brushId: 'mycelial-ink',
        seed: 100 + i,
        brush: { culture: { reach: 40, branching: 0.7 } },
        points: [
          { x: 60, y: 60 + i * 65 },
          { x: 450, y: 60 + i * 65 },
        ],
      });
    }
    c.growCultures({ steps: 20 });
    const t0 = performance.now();
    c.growCultures({ steps: 50 });
    const msPerTick = (performance.now() - t0) / 50;
    expect(msPerTick).toBeLessThan(2);
  });
});
