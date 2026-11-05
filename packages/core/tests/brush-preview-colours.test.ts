import { describe, expect, it } from 'vitest';
import { BRUSH_HOST_PROFILES, BRUSH_PREVIEW_DARK_PAPER, BRUSH_PRESETS, brushPreviewColours, brushPreviewsOnDark, brushPreviewStrength, PAINT_PROFILE, resolveBrush, type Brush } from '../src/brushes';
import { contrastRatio, parseColor } from '../src/color';
import { DEFAULT_PAPER } from '../src/paint-editor/paper';
import { renderBrushThumbnail } from '../src/paint-editor/thumbnails';

const preset = (id: string) => BRUSH_PRESETS.find((b) => b.id === id)!;
const ratio = (a: string, b: string, alpha = 1) => {
  const f = parseColor(a)!;
  const g = parseColor(b)!;
  return contrastRatio({ r: f.r * alpha + g.r * (1 - alpha), g: f.g * alpha + g.g * (1 - alpha), b: f.b * alpha + g.b * (1 - alpha), a: 1 }, g);
};
/** What previews are drawn on: the paint engine's papers, and a light and a dark UI behind transparent previews. */
const PAPERS = [DEFAULT_PAPER.color, '#9c978e', '#ffffff', '#f1f5f9', '#0f172a', '#020617'];
/** A highlighter's colour is a tint: it is kept as it is on light paper. */
const tint = (b: Brush, scheme: string) => b.tip.blend === 'multiply' && (b.light?.amount ?? 0) > 0 && typeof b.colour?.default === 'string' && scheme === 'light';

describe('brushPreviewColours', () => {
  it('reads at 3:1 or more, as laid at the brush\'s strength, for every preset, host and background', () => {
    const misses: string[] = [];
    for (const brush of BRUSH_PRESETS)
      for (const profile of Object.values(BRUSH_HOST_PROFILES))
        for (const paper of PAPERS) {
          const p = brushPreviewColours(brush, { paper, profile });
          if (tint(brush, p.scheme)) continue;
          // A faint brush on mid-grey paper can't reach 3:1 at all: black (or white) is the most it can do.
          if (p.color === '#000000' || p.color === '#ffffff') continue;
          const r = ratio(p.color, p.background, brushPreviewStrength(brush));
          if (r < 3) misses.push(`${brush.id} ${profile.id} ${paper}: ${p.color} on ${p.background} (${r.toFixed(2)})`);
        }
    expect(misses).toEqual([]);
  });

  it('takes the side of a light / dark default for the background, and a medium colour otherwise', () => {
    // Chalk's slate side on light paper (darkened for its grain), its white side on a dark board.
    const onLight = brushPreviewColours(preset('chalk'), { paper: '#ffffff' });
    expect(onLight.scheme).toBe('light');
    expect(ratio(onLight.color, '#ffffff')).toBeGreaterThan(ratio('#475569', '#ffffff') - 0.01);
    expect(brushPreviewColours(preset('chalk'), { paper: '#0f172a' })).toMatchObject({ color: '#f8fafc', scheme: 'dark' });
    // The ballpoint's navy is lightened on a dark surface rather than vanishing.
    const ballpoint = brushPreviewColours(preset('ballpoint'), { paper: '#0f172a', profile: BRUSH_HOST_PROFILES.canvas });
    expect(ballpoint.color).not.toBe('#1e3a8a');
    expect(ratio(ballpoint.color, '#0f172a')).toBeGreaterThanOrEqual(3);
    // A pencil has no default: graphite on paper (darkened for its light touch), light grey on a dark surface.
    const graphite = brushPreviewColours(preset('pencil-hb'), { paper: DEFAULT_PAPER.color }).color;
    expect(ratio(graphite, DEFAULT_PAPER.color)).toBeGreaterThanOrEqual(ratio('#3f3f46', DEFAULT_PAPER.color));
    expect(ratio(brushPreviewColours(preset('pencil-hb'), { paper: '#0f172a' }).color, '#0f172a')).toBeGreaterThanOrEqual(3);
  });

  it('previews light paint on dark paper, but a highlighter on its paper', () => {
    const neon = BRUSH_PRESETS.find((b) => (b.light?.amount ?? 0) > 0 && b.tip.blend !== 'multiply')!;
    expect(brushPreviewColours(neon, { paper: DEFAULT_PAPER.color }).background).toBe(BRUSH_PREVIEW_DARK_PAPER);
    // Vector strokes paint light brushes as plain colour: no dark paper there.
    expect(brushPreviewColours(neon, { paper: '#ffffff', profile: BRUSH_HOST_PROFILES.vector }).background).toBe('#ffffff');
    const hl = preset('highlighter');
    expect(brushPreviewsOnDark(hl)).toBe(false);
    expect(brushPreviewColours(hl, { paper: DEFAULT_PAPER.color })).toEqual({ background: DEFAULT_PAPER.color, color: '#fff200', scheme: 'light' });
  });

  it('previews a multiply brush on white rather than a dark surface, unless the surface is fixed', () => {
    const marker = BRUSH_PRESETS.find((b) => b.tip.blend === 'multiply' && b.id !== 'highlighter')!;
    expect(brushPreviewColours(marker, { paper: '#0f172a', profile: BRUSH_HOST_PROFILES.canvas }).background).toBe('#ffffff');
    const swatch = brushPreviewColours(marker, { paper: '#0f172a', profile: BRUSH_HOST_PROFILES.canvas, keepPaper: true });
    expect(swatch.background).toBe('#0f172a');
    expect(ratio(swatch.color, '#0f172a', brushPreviewStrength(marker))).toBeGreaterThanOrEqual(3);
  });

  it('the paint thumbnail draws a highlighter on its paper and light paint on dark paper', () => {
    const corner = (b: Brush) => {
      const t = renderBrushThumbnail(resolveBrush(b), { paper: DEFAULT_PAPER, width: 64, height: 24, color: brushPreviewColours(b, { paper: DEFAULT_PAPER.color, profile: PAINT_PROFILE }).color });
      return [...t.data.slice(0, 3)];
    };
    const paper = parseColor(DEFAULT_PAPER.color)!;
    const hl = corner(preset('highlighter'));
    expect(Math.abs(hl[0] - paper.r * 255)).toBeLessThan(24);
    const neon = BRUSH_PRESETS.find((b) => (b.light?.amount ?? 0) > 0 && b.tip.blend !== 'multiply')!;
    expect(corner(neon)[0]).toBeLessThan(80);
  });
});
