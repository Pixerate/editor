import { describe, expect, it } from 'vitest';
import {
  caretAt,
  createMetricTextShaper,
  createOutlineTextShaper,
  layoutText,
  parseOpenTypeFont,
  textArrowStep,
  textDecorations,
  textFragmentOutline,
  textIndexAt,
  textLineMove,
  textSelectionQuads,
  verticalOrientationOf,
  type TextBlock,
  type TextStyle,
} from '../src/text';
import { trueTypeFont } from './helpers/sfnt-font';

const style = (over: Partial<TextStyle> = {}): TextStyle => ({ fontFamily: 'sans-serif', fontWeight: 400, fontSize: 20, color: '#000000', ...over });
const block = (text: string, over: Partial<TextBlock> = {}, s: Partial<TextStyle> = {}): TextBlock => ({ text, runs: [{ length: text.length, style: style(s) }], paragraphs: [], frame: { kind: 'point' }, orientation: 'vertical', ...over });
const glyphs = (layout: ReturnType<typeof layoutText>) => layout.lines.flatMap((l) => l.fragments.flatMap((f) => f.glyphs ?? []));

describe('vertical orientation of characters', () => {
  it('sets CJK upright, Latin sideways, and brackets and corner punctuation by their vertical forms', () => {
    expect(['中', 'か', 'カ', '한', '０', '😀'].map((c) => verticalOrientationOf(c.codePointAt(0)!))).toEqual(['U', 'U', 'U', 'U', 'U', 'U']);
    expect(['a', 'Z', '1', ' ', 'é'].map((c) => verticalOrientationOf(c.codePointAt(0)!))).toEqual(['R', 'R', 'R', 'R', 'R']);
    expect(['「', '」', 'ー', '（', '…'].map((c) => verticalOrientationOf(c.codePointAt(0)!))).toEqual(['Tr', 'Tr', 'Tr', 'Tr', 'Tr']);
    expect(['、', '。', 'っ', 'ャ'].map((c) => verticalOrientationOf(c.codePointAt(0)!))).toEqual(['Tu', 'Tu', 'Tu', 'Tu']);
  });
});

describe('vertical layout (metric shaper: 1 em CJK cells, ascent 0.8 em, descent 0.2 em)', () => {
  const shaper = createMetricTextShaper();

  it('runs a column down from the origin: CJK upright and centred, Latin turned sideways', () => {
    const layout = layoutText(block('中文ab'), shaper);
    expect(layout.orientation).toBe('vertical');
    expect(layout.lines).toHaveLength(1);
    const [zh, wen, a, b] = glyphs(layout);
    // Upright: centred on x = 0 (advance 20), the cell's top at y = 0, the baseline 16 below it.
    expect(zh).toMatchObject({ index: 0, angle: 0, x: -10, y: 16, advance: 20 });
    expect(wen).toMatchObject({ index: 1, angle: 0, x: -10, y: 36 });
    // Sideways: turned clockwise, its em box centred on the column (baseline 6 left of it).
    expect(a).toMatchObject({ index: 2, angle: 90, x: -6, y: 40 });
    expect(b.y).toBeCloseTo(40 + 0.54 * 20);
    // Bounds in text space: one em wide, the column long.
    expect(layout.bounds.x).toBeCloseTo(-10);
    expect(layout.bounds.width).toBeCloseTo(20);
    expect(layout.bounds.y).toBeCloseTo(0);
    expect(layout.bounds.height).toBeCloseTo(40 + 2 * 0.54 * 20);
  });

  it('stacks paragraphs as columns right to left, a leading apart', () => {
    const layout = layoutText(block('一\n二'), shaper);
    expect(layout.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    const [one, two] = glyphs(layout);
    expect(one.x).toBeCloseTo(-10);
    expect(two.x).toBeCloseTo(-24 - 10);
    expect(two.y).toBeCloseTo(16);
  });

  it('wraps a box at its height and fills it from the right edge', () => {
    const layout = layoutText(block('一二三四五', { frame: { kind: 'box', width: 100, height: 45 } }), shaper);
    expect(layout.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 2],
      [2, 4],
      [4, 5],
    ]);
    const gs = glyphs(layout);
    // First column's right edge at the box's right edge (centre 90), the next 24 to the left.
    expect(gs[0].x).toBeCloseTo(80);
    expect(gs[2].x).toBeCloseTo(56);
    expect(gs[1].y).toBeCloseTo(36);
    expect(layout.bounds).toEqual({ x: 0, y: 0, width: 100, height: 45 });
  });

  it('centres and bottom-aligns columns with the paragraph alignment', () => {
    const centre = glyphs(layoutText(block('一二', { paragraphs: [{ length: 2, style: { align: 'center' } }] }), shaper));
    expect(centre[0].y).toBeCloseTo(-20 + 16);
    const end = glyphs(layoutText(block('一二', { paragraphs: [{ length: 2, style: { align: 'right' } }] }), shaper));
    expect(end[1].y).toBeCloseTo(-20 + 16);
  });

  it('sets Latin upright when the style says so, and keeps spaces sideways', () => {
    const gs = glyphs(layoutText(block('ab c', {}, { upright: true }), shaper));
    expect(gs.map((g) => g.angle)).toEqual([0, 0, 90, 0]);
    // Upright Latin takes the font's ascent + descent as its advance.
    expect(gs[1].y - gs[0].y).toBeCloseTo(20);
  });

  it('turns brackets sideways and moves 、。 to the upper right when the font has no vertical forms', () => {
    const gs = glyphs(layoutText(block('「中」。'), shaper));
    expect(gs.map((g) => g.angle)).toEqual([90, 0, 90, 0]);
    const maru = gs[3];
    // Centred like 中 but nudged 0.55 em right and up.
    expect(maru.x).toBeCloseTo(-10 + 11);
    expect(maru.vert).toBe(false);
  });

  it('keeps surrogate pairs together as one upright glyph', () => {
    const layout = layoutText(block('𠀋中'), shaper);
    const gs = glyphs(layout);
    expect(gs.map((g) => [g.index, g.length])).toEqual([
      [0, 2],
      [2, 1],
    ]);
  });

  it('hit-tests, places the caret and selects down the column', () => {
    const layout = layoutText(block('中文\n字'), shaper);
    // A click 25 px down the first column (x = 0) lands after 中.
    expect(textIndexAt(layout, { x: 0, y: 25 })).toBe(1);
    // In the second column (centre x = −24).
    expect(textIndexAt(layout, { x: -24, y: 2 })).toBe(3);
    const c = caretAt(layout, 1);
    expect(c.line).toBe(0);
    // A horizontal bar across the column at y = 20, from its right edge to its left.
    expect(c.from).toEqual({ x: 10, y: 20 });
    expect(c.to).toEqual({ x: -10, y: 20 });
    const quads = textSelectionQuads(layout, 0, 4);
    expect(quads).toHaveLength(2);
    expect(quads[0]).toEqual([
      { x: 10, y: 0 },
      { x: 10, y: 40 },
      { x: -10, y: 40 },
      { x: -10, y: 0 },
    ]);
  });

  it('maps arrow keys onto columns and moves between them', () => {
    expect(textArrowStep('vertical', 'ArrowDown')).toBe('next');
    expect(textArrowStep('vertical', 'ArrowUp')).toBe('previous');
    expect(textArrowStep('vertical', 'ArrowLeft')).toBe('line-after');
    expect(textArrowStep('vertical', 'ArrowRight')).toBe('line-before');
    expect(textArrowStep('horizontal', 'ArrowLeft')).toBe('previous');
    expect(textArrowStep(undefined, 'ArrowDown')).toBe('line-after');
    const layout = layoutText(block('中文\n字体'), shaper);
    expect(textLineMove(layout, 1, 1, 5)).toBe(4);
    expect(textLineMove(layout, 4, -1, 5)).toBe(1);
    expect(textLineMove(layout, 4, 1, 5)).toBe(5);
  });

  it('underlines on the right of the column and strikes through its centre', () => {
    const layout = layoutText(block('中文', {}, { underline: true, strikethrough: true }), shaper);
    const l = layout.lines[0];
    const [under, strike] = textDecorations(l.fragments[0], l);
    expect(under.x).toBeCloseTo(10 - Math.max(1, 20 / 15));
    expect(under.height).toBeCloseTo(40);
    expect(strike.x + strike.width / 2).toBeCloseTo(0);
  });

  it('leaves horizontal text as it was', () => {
    const layout = layoutText(block('ab', { orientation: undefined }), shaper);
    expect(layout.orientation).toBe('horizontal');
    expect(layout.matrix).toBeUndefined();
    expect(layout.lines[0].fragments[0].glyphs).toBeUndefined();
    expect(caretAt(layout, 1).from).toEqual({ x: layout.lines[0].chars[1].x, y: -16 });
  });
});

describe('vertical metrics and alternates from the font', () => {
  const font = parseOpenTypeFont(trueTypeFont('Test Sans', 400, { vertical: true }));

  it('reads vhea, vmtx and the vert substitution', () => {
    expect(font.hasVerticalMetrics).toBe(true);
    expect(font.verticalGlyph(1)).toBe(2);
    expect(font.verticalGlyph(2)).toBe(2);
    // A has a vertical form (V): V's advance 900, origin yMax 700 + tsb 50.
    expect(font.getVerticalMetrics('A')).toEqual({ advance: 900, originY: 750, alternate: true });
    expect(font.getVerticalMetrics('一')).toEqual({ advance: 900, originY: 750, alternate: false });
    // vertical: true draws the alternate: 'A' becomes the V triangle.
    expect(font.getPath('A', 0, 0, 1000, { vertical: true }).commands.map((c) => c.type)).toEqual(['M', 'L', 'L', 'Z']);
    expect(font.getPath('A', 0, 0, 1000).commands.map((c) => c.type)).toEqual(['M', 'L', 'L', 'L', 'Z']);
  });

  it('falls back to the ascender and descender without vertical tables', () => {
    const plain = parseOpenTypeFont(trueTypeFont());
    expect(plain.hasVerticalMetrics).toBe(false);
    expect(plain.getVerticalMetrics('A')).toEqual({ advance: 1000, originY: 800, alternate: false });
  });

  it('lays brackets out upright in their vertical form through the outline shaper', () => {
    const shaper = createOutlineTextShaper([font]);
    expect(shaper.vertical!('「', { family: 'Test Sans', weight: 400, italic: false, size: 10 })).toEqual({ advance: 9, originY: 7.5, alternate: true });
    const layout = layoutText(block('「一', {}, { fontFamily: 'Test Sans', fontSize: 10 }), shaper);
    const gs = glyphs(layout);
    expect(gs.map((g) => [g.angle, g.vert])).toEqual([
      [0, true],
      [0, false],
    ]);
    expect(gs[1].y - gs[0].y).toBeCloseTo(9);
    // Both draw V's triangle, centred on the column (advance 6: x from −3).
    const f = layout.lines[0].fragments[0];
    const path = textFragmentOutline(shaper, '「一', f);
    expect(path.filter((c) => c.type === 'M')).toHaveLength(2);
    const xs = path.filter((c) => c.type !== 'Z').map((c) => (c as { x: number }).x);
    expect(Math.min(...xs)).toBeCloseTo(-3);
    expect(Math.max(...xs)).toBeCloseTo(3);
  });

  it('turns sideways glyph outlines clockwise', () => {
    const shaper = createOutlineTextShaper([parseOpenTypeFont(trueTypeFont())]);
    const layout = layoutText(block('A', {}, { fontFamily: 'Test Sans', fontSize: 10 }), shaper);
    const path = textFragmentOutline(shaper, 'A', layout.lines[0].fragments[0]);
    const pts = path.filter((c) => c.type !== 'Z') as Array<{ x: number; y: number }>;
    // The box (0.5..5.5 wide, 7 tall) lies along the column: y from 0.5 to 5.5, its top to the right.
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(0.5);
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(5.5);
    // Baseline 3 left of the centre (ascent 8, descent 2); the glyph rises 7 to its right.
    expect(Math.min(...pts.map((p) => p.x))).toBeCloseTo(-3);
    expect(Math.max(...pts.map((p) => p.x))).toBeCloseTo(4);
  });
});
