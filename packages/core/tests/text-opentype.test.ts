import { describe, expect, it } from 'vitest';
import { createMetricTextShaper, createOutlineTextShaper, layoutText, loadOpenTypeFont, parseOpenTypeFont } from '../src/text';
import { cffFont, trueTypeFont } from './helpers/sfnt-font';

const bounds = (cmds: Array<{ x?: number; y?: number }>) => {
  const xs = cmds.filter((c) => c.x !== undefined).map((c) => c.x!);
  const ys = cmds.filter((c) => c.y !== undefined).map((c) => c.y!);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

describe('parseOpenTypeFont', () => {
  it('reads a TrueType font: names, metrics, cmap, advances, kern and outlines', () => {
    const font = parseOpenTypeFont(trueTypeFont('Test Sans', 700));
    expect(font.outlines).toBe('glyf');
    expect(font.family).toBe('Test Sans');
    expect(font.style).toBe('Bold');
    expect(font.postScriptName).toBe('TestSans-Bold');
    expect(font.weight).toBe(700);
    expect(font.italic).toBe(false);
    expect([font.unitsPerEm, font.ascender, font.descender, font.numGlyphs]).toEqual([1000, 800, -200, 3]);
    expect([font.glyphIndex(65), font.glyphIndex(86), font.glyphIndex(66)]).toEqual([1, 2, 0]);
    expect(font.advance(1)).toBe(600);
    expect(font.kerning(1, 2)).toBe(-100);
    expect(font.kerning(2, 1)).toBe(0);
    // 'AV' at 10 px: 6 + 6 − 1 (kerned).
    expect(font.getAdvanceWidth('AV', 10)).toBeCloseTo(11);
    expect(font.getAdvanceWidth('AV', 10, { kerning: false })).toBeCloseTo(12);
    // The box glyph, y flipped onto a baseline at y = 100.
    const box = font.getPath('A', 0, 100, 10).commands;
    expect(box[0].type).toBe('M');
    expect(box.at(-1)!.type).toBe('Z');
    expect(bounds(box)).toEqual({ minX: 0.5, maxX: 5.5, minY: 93, maxY: 100 });
  });

  it('reads a CFF font through charstrings and subroutines, and kerns through GPOS', () => {
    const font = parseOpenTypeFont(cffFont());
    expect(font.outlines).toBe('cff');
    expect(font.family).toBe('Test Serif');
    const a = font.glyphPath(1);
    expect(bounds(a)).toEqual({ minX: 50, maxX: 550, minY: 0, maxY: 700 });
    // V draws through a local subroutine: a triangle from (0, 700) down to (300, 0) and back up.
    const v = font.glyphPath(2);
    expect(v.map((c) => c.type)).toEqual(['M', 'L', 'L', 'Z']);
    expect(bounds(v)).toEqual({ minX: 0, maxX: 600, minY: 0, maxY: 700 });
    expect(font.kerning(1, 2)).toBe(-100);
    expect(font.getAdvanceWidth('AV', 1000)).toBeCloseTo(1100);
  });

  it('refuses files that are not fonts, and WOFF2, with a reason', async () => {
    expect(() => parseOpenTypeFont(new Uint8Array(4))).toThrow(/too short/);
    expect(() => parseOpenTypeFont(new TextEncoder().encode('not a font at all, really'))).toThrow(/not a TrueType or OpenType font/);
    await expect(loadOpenTypeFont(new TextEncoder().encode('wOF2 and then some bytes'))).rejects.toThrow(/WOFF2/);
  });

  it('drives the outline shaper so layout and outlines come from the file', () => {
    const shaper = createOutlineTextShaper([parseOpenTypeFont(trueTypeFont())]);
    expect(shaper.families!()).toEqual(['Test Sans']);
    const font = { family: 'Test Sans', weight: 400, italic: false, size: 20 };
    expect(Array.from(shaper.measure('AV', font))).toEqual([0, 12, 22]);
    expect(shaper.metrics(font)).toEqual({ ascent: 16, descent: 4 });
    const layout = layoutText({ text: 'AV AV', runs: [{ length: 5, style: { fontFamily: 'Test Sans', fontWeight: 400, fontSize: 20, color: '#000' } }], paragraphs: [], frame: { kind: 'point' } }, shaper);
    expect(layout.lines).toHaveLength(1);
    expect(layout.missingFonts).toEqual([]);
  });
});

describe('createMetricTextShaper', () => {
  it('estimates advances per character class and needs no fonts', () => {
    const s = createMetricTextShaper();
    const font = { family: 'Anything', weight: 400, italic: false, size: 10 };
    const w = Array.from(s.measure('ilWW中', font));
    expect(w[1] - w[0]).toBeLessThan(w[4] - w[3]);
    expect(w[5] - w[4]).toBeCloseTo(10);
    expect(s.resolve(font)).toEqual({ family: 'Anything', available: true });
    expect(s.outline).toBeUndefined();
  });
});
