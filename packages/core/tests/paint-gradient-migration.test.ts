import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PaintEditorController, normalizePaintBrush, multiColorToPaint, paintToMultiColor, BUILTIN_BRUSHES } from '../src/paint-editor';

/**
 * Multi-colour brushes became gradient paint. These hashes are the layer pixels the same strokes
 * gave before (with `behavior.multicolor`, on main at bc9dc7d2): migrated brushes and presets must
 * paint exactly the same.
 */
const BEFORE: Record<string, string> = {
  'multicolor-flat': '721e77b72416f2dcace082a5',
  'palette-dabber': '4c189cd00f773a016b70cc9a',
  'dab-random': '14d594ed54e6b816cbcbb747',
  'mixer-tip': '7781818f79f7574f4ad27dfd',
  'dab-sequence': '7eae664df7ce9e0f4a06d631',
};
const CASES: [string, Record<string, unknown>][] = [
  ['multicolor-flat', { brushId: 'multicolor-flat' }],
  ['palette-dabber', { brushId: 'palette-dabber' }],
  ['dab-random', { brushId: 'brush-pen', brush: { engine: 'dab', behavior: { multicolor: { mode: 'dab', order: 'random', length: 3, colors: ['#e11d48', '#22c55e', '#3b82f6'] } } } }],
  ['mixer-tip', { brushId: 'mixer-brush', brush: { behavior: { mixing: 'rgb', multicolor: { mode: 'tip', softness: 0.5, colors: ['#e11d48', '#22c55e', '#3b82f6'] } } } }],
  ['dab-sequence', { brushId: 'brush-pen', brush: { engine: 'dab', behavior: { mixing: 'rgb', multicolor: { mode: 'dab', order: 'sequence', length: 5, softness: 1, colors: ['#e11d48', '#22c55e', '#3b82f6', '#111111'] } } } }],
];

function render(init: Record<string, unknown>): string {
  const c = new PaintEditorController({ width: 400, height: 260, paper: 'smooth' });
  c.setColor('#1d4ed8');
  c.setSecondaryColor('#facc15');
  c.paintStroke({ points: Array.from({ length: 60 }, (_, i) => ({ x: 20 + i * 6, y: 130 + Math.sin(i / 5) * 60, pressure: 0.5 + 0.5 * Math.sin(i / 9) })), seed: 42, ...init } as never);
  const h = createHash('sha256');
  const s = (c.getActiveLayer() as { surface: { tiles: Map<number, { data: Uint8ClampedArray }> } }).surface;
  for (const [k, t] of [...s.tiles].sort((a, b) => a[0] - b[0])) {
    h.update(String(k));
    h.update(t.data);
  }
  return h.digest('hex').slice(0, 24);
}

describe('multi-colour brushes became gradient paint', () => {
  for (const [name, init] of CASES) it(`${name} paints the same pixels as before`, () => expect(render(init)).toBe(BEFORE[name]));

  it('old multi-colour input is still read, and reported back, as gradient paint', () => {
    const b = normalizePaintBrush({ behavior: { multicolor: { mode: 'dab', order: 'sequence', length: 4, colors: ['#ff0000', '#00ff00', '#0000ff'] } } });
    expect(b.paint).toEqual({ type: 'gradient', stops: [0, 1, 2, 3].map((k) => ({ offset: k / 3, color: ['#ff0000', '#00ff00', '#0000ff', '#ff0000'][k] })), space: 'pigment', map: { by: 'distance', length: 12, repeat: 'repeat', unit: 'dabs' } });
    expect(b.behavior.multicolor).toMatchObject({ mode: 'dab', order: 'sequence', length: 4, colors: ['#ff0000', '#00ff00', '#0000ff'] });
    // A partial old update merges into what the brush paints now.
    const dabber = BUILTIN_BRUSHES.find((x) => x.id === 'palette-dabber')!;
    const recoloured = normalizePaintBrush({ behavior: { multicolor: { colors: ['#ff0000', '#00ff00'] } } }, dabber);
    expect(recoloured.paint?.stops.map((s) => s.color)).toEqual(['#ff0000', '#00ff00', '#ff0000']);
    expect(recoloured.paint?.map).toEqual({ by: 'distance', length: 12, repeat: 'repeat', unit: 'dabs' });
    expect(normalizePaintBrush({ behavior: { multicolor: { mode: 'off' } } }, dabber).paint).toBeNull();
    // Every multi-colour setting survives the round trip.
    for (const mc of [
      { mode: 'tip' as const, colors: [], order: 'sequence' as const, length: 12, softness: 0.7 },
      { mode: 'dab' as const, colors: ['#111111', '#222222'], order: 'random' as const, length: 3, softness: 1 },
      { mode: 'dab' as const, colors: [], order: 'sequence' as const, length: 6, softness: 0.4 },
    ])
      expect(paintToMultiColor(multiColorToPaint(mc, 'pigment'))).toEqual(mc);
    // A gradient with no multi-colour equivalent reports multi-colour off.
    expect(BUILTIN_BRUSHES.find((x) => x.id === 'rainbow-marker')!.behavior.multicolor.mode).toBe('off');
  });
});
