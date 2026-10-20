import { describe, expect, it } from 'vitest';
import { emptySurface, readPixel } from '../src/raster/surface';
import { paintPathStroke, pathStrokeDabs, type PathSample } from '../src/paint';

const curve = (n = 30): PathSample[] => Array.from({ length: n }, (_, i) => ({ x: 20 + i * 8, y: 100 + Math.sin(i / 5) * 30, pressure: i / (n - 1) }));

describe('brushstrokes along a path', () => {
  it('walks the path at the brush spacing with pressure interpolated between samples', () => {
    const dabs = pathStrokeDabs([{ x: 0, y: 0, pressure: 0 }, { x: 100, y: 0, pressure: 1 }], { brush: { size: 10, spacing: 0.1 } });
    expect(dabs.length).toBeGreaterThan(30);
    expect(dabs[0].radius).toBeLessThan(dabs.at(-1)!.radius);
    expect(dabs.every((d, i) => i === 0 || d.x > dabs[i - 1].x)).toBe(true);
  });

  it('tilt widens and flattens the tip; followPath turns it with the curve', () => {
    const upright = pathStrokeDabs([{ x: 0, y: 0 }, { x: 50, y: 0 }], { brush: { size: 10 }, tilt: { size: 1, roundness: 1 } });
    const flat = pathStrokeDabs([{ x: 0, y: 0, altitude: 0.2, azimuth: 0 }, { x: 50, y: 0, altitude: 0.2, azimuth: 0 }], { brush: { size: 10 }, tilt: { size: 1, roundness: 1 } });
    expect(flat[3].radius).toBeGreaterThan(upright[3].radius * 1.5);
    expect(flat[3].roundness).toBeLessThan(upright[3].roundness);
    const turned = pathStrokeDabs([{ x: 0, y: 0 }, { x: 0, y: 50 }], { brush: { size: 10, roundness: 0.3 }, followPath: true });
    expect(Math.abs(turned[2].angle)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('paints onto a surface deterministically and leaves the input alone', () => {
    const s = emptySurface(4);
    const a = paintPathStroke(s, curve(), { brush: { size: 12, hardness: 0.6 }, color: [200, 30, 40, 255] });
    const b = paintPathStroke(s, curve(), { brush: { size: 12, hardness: 0.6 }, color: [200, 30, 40, 255] });
    expect(s.tiles.size).toBe(0);
    expect(a.bounds).not.toBeNull();
    expect(readPixel(a.surface, 20 + 15 * 8, Math.round(100 + Math.sin(3) * 30))[3]).toBeGreaterThan(0);
    for (const [k, t] of a.surface.tiles) expect(Buffer.from(t.data).equals(Buffer.from(b.surface.tiles.get(k)!.data))).toBe(true);
    const erased = paintPathStroke(a.surface, curve(), { brush: { size: 20 }, color: [0, 0, 0, 255], mode: 'erase' });
    expect(readPixel(erased.surface, 20 + 15 * 8, Math.round(100 + Math.sin(3) * 30))[3]).toBe(0);
  });
});
