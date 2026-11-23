// Rendering one area of the canvas (`rect` on `compositePixels`, `renderPreview` and the
// `render_preview` tool): a host frames the part being worked on instead of the whole page.
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { decodePng } from '../src/raster/png';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';

const line = (x0: number, y0: number, x1: number, y1: number) =>
  Array.from({ length: 12 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 11, y: y0 + ((y1 - y0) * i) / 11 }));

function painted() {
  const c = new PaintEditorController({ width: 200, height: 120, paper: 'cold-pressed' });
  c.paintStroke({ points: line(20, 30, 180, 90), brushId: 'marker', color: '#d02020' });
  return c;
}

/** `rect` of an RGBA image `width` wide, copied out. */
function crop(data: Uint8ClampedArray, width: number, rect: { x: number; y: number; width: number; height: number }) {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * width + rect.x) * 4;
    out.set(data.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return out;
}

describe('rendering an area of the canvas', () => {
  it('composites exactly that area of the full render', () => {
    const c = painted();
    const full = c.compositePixels();
    const rect = { x: 40, y: 20, width: 90, height: 70 };
    const part = c.compositePixels({ rect });
    expect([part.width, part.height]).toEqual([90, 70]);
    expect(Array.from(part.data)).toEqual(Array.from(crop(full.data, full.width, rect)));
  });

  it('keeps layer, paper and wet options with the area', () => {
    const c = painted();
    const rect = { x: 0, y: 0, width: 50, height: 50 };
    const blank = c.compositePixels({ rect, layerIds: [], paper: false });
    expect(blank.data.every((v) => v === 0)).toBe(true);
    const fullNoPaper = c.compositePixels({ paper: false });
    expect(Array.from(c.compositePixels({ rect, paper: false }).data)).toEqual(Array.from(crop(fullNoPaper.data, fullNoPaper.width, rect)));
  });

  it('scales the area for a preview, longest side at most maxSide', () => {
    const c = painted();
    const img = c.renderPreview({ rect: { x: 10, y: 10, width: 160, height: 80 }, maxSide: 40 });
    expect([img.width, img.height]).toEqual([40, 20]);
    const small = c.renderPreview({ rect: { x: 10, y: 10, width: 30, height: 20 }, maxSide: 512 });
    expect([small.width, small.height]).toEqual([30, 20]);
  });

  it('refuses an area outside the canvas or not in whole pixels, saying what fits', () => {
    const c = painted();
    for (const rect of [
      { x: -1, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 201, height: 10 },
      { x: 150, y: 100, width: 60, height: 30 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0.5, y: 0, width: 10, height: 10 },
    ]) {
      expect(() => c.compositePixels({ rect })).toThrow(/not inside the 200×120 canvas/);
      expect(() => c.renderPreview({ rect })).toThrow(/x \+ width ≤ 200/);
    }
  });

  it('render_preview takes rect, and refuses one off the canvas as an error result', async () => {
    const c = painted();
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c));
    const res = await r.callTool('render_preview', { rect: { x: 20, y: 20, width: 100, height: 50 }, maxSide: 50 });
    expect(res.isError).toBeFalsy();
    expect((res.content[1] as { text: string }).text).toBe('Preview 50×25');
    const png = decodePng(Uint8Array.from(Buffer.from((res.content[0] as { data: string }).data, 'base64')));
    expect([png.width, png.height]).toEqual([50, 25]);
    const off = await r.callTool('render_preview', { rect: { x: 180, y: 0, width: 40, height: 40 } });
    expect(off.isError).toBe(true);
    expect(JSON.stringify(off.content)).toContain('not inside the 200×120 canvas');
  });

  it('takes rect in host coordinates when the document is hosted on a larger canvas', async () => {
    const c = new PaintEditorController({ width: 4000, height: 4000 });
    c.paintStroke({ points: line(1990, 1990, 2010, 2010), brushId: 'marker', color: '#2040d0' });
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c, { origin: { x: -2000, y: -2000 } }));
    const tool = r.listTools().tools.find((t) => t.name.endsWith('render_preview'))!;
    expect(JSON.stringify(tool.inputSchema)).toContain('Canvas x of the left edge');
    // Host (-50, -50) is document (1950, 1950); a negative host x is fine.
    const res = await r.callTool(tool.name, { rect: { x: -50, y: -50, width: 100, height: 100 }, maxSide: 100 });
    expect(res.isError).toBeFalsy();
    const png = decodePng(Uint8Array.from(Buffer.from((res.content[0] as { data: string }).data, 'base64')));
    const direct = c.renderPreview({ rect: { x: 1950, y: 1950, width: 100, height: 100 }, maxSide: 100 });
    expect(Array.from(png.data)).toEqual(Array.from(direct.data));
  });
});
