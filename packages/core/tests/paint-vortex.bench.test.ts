import { describe, expect, it } from 'vitest';
import { PaintEditorController, type PenPoint } from '../src/paint-editor';

describe.skip('Vortex paint benchmark (#683)', () => {
  it('benchmarks closed-loop vortex displacement and single-pass RGBA resampling on 512x512', () => {
    const c = new PaintEditorController({ width: 512, height: 512 });
    c.setBrush({ id: 'ink-pen', tip: { size: 48, opacity: 1 } });
    c.setColor('#2563eb');
    c.paintStroke({ points: [{ x: 64, y: 200 }, { x: 448, y: 200 }] });
    c.setColor('#f97316');
    c.paintStroke({ points: [{ x: 64, y: 312 }, { x: 448, y: 312 }] });

    const loop: PenPoint[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      loop.push({ x: 256 + Math.cos(a) * 90, y: 256 + Math.sin(a) * 90, pressure: 0.85 });
    }

    const t0 = performance.now();
    const res = c.paintStroke({
      brushId: 'vortex',
      brush: { tip: { size: 32 }, marks: { kind: 'vortex', reach: 3, turns: 2, duration: 0 } },
      points: loop,
    });
    const elapsed = performance.now() - t0;
    expect(res.vortex?.shape).toBe('closed');
    expect(elapsed).toBeLessThan(1000);
  });
});
