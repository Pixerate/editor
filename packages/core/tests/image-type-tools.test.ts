import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  ImageEditorRenderer,
  annotationLayerFor,
  createCanvasTextShaper,
  createImageEditorToolProvider,
  createOutlineTextShaper,
  cssFont,
  renderText,
  type TextAnnotation,
  type TypeLayer,
} from '../src/image-editor';
import { boxFont } from './helpers/box-font';

const W = 160;
const H = 100;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, textShaper: createOutlineTextShaper([boxFont('Box'), boxFont('Box', 700)]) });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, registry };
}

const out = (res: { structuredContent?: unknown }) => res.structuredContent as Record<string, any>;
const errorText = (res: { content?: Array<{ type: string; text?: string }> }) => res.content?.map((p) => p.text ?? '').join(' ') ?? '';
const steps = (c: ImageEditorController) => (c as unknown as { undoStack: unknown[] }).undoStack.length;

describe('type layer agent tools', () => {
  it('lists fonts, adds text and reads it back', async () => {
    const { c, registry } = setup();
    expect(out(await registry.callTool('list_fonts', {}))).toEqual({ families: ['Box'], shaper: expect.stringContaining('outline') });
    const n = steps(c);
    const r = out(await registry.callTool('add_text_layer', { text: 'Sale\nToday', x: 80, y: 30, style: { fontFamily: 'Box', fontSize: 12, color: '#cc0000' }, paragraph: { align: 'center' } }));
    expect(steps(c)).toBe(n + 1);
    expect(r.layer).toMatchObject({ type: 'type', name: 'Sale', active: true });
    expect(r.text).toMatchObject({ text: 'Sale\nToday', frame: { kind: 'point' }, missingFonts: [], rendering: 'live' });
    expect(r.text.lines.map((l: any) => [l.start, l.end])).toEqual([
      [0, 4],
      [5, 10],
    ]);
    const got = out(await registry.callTool('get_text_layer', { layerId: r.layer.id }));
    expect(got.paragraphs).toEqual([{ start: 0, end: 10, style: { align: 'center' } }]);
  });

  it('edits text, styles ranges and paragraphs, changes the frame and converts to a shape, one undo step each', async () => {
    const { c, registry } = setup();
    const id = out(await registry.callTool('add_text_layer', { text: 'Big sale', x: 10, y: 40, style: { fontFamily: 'Box', fontSize: 10 } })).layer.id;
    const n = steps(c);
    let r = out(await registry.callTool('set_text', { layerId: id, text: 'huge', start: 0, end: 3 }));
    expect(r.text).toBe('huge sale');
    r = out(await registry.callTool('set_text_style', { layerId: id, start: 0, end: 4, fontWeight: 700, color: '#0000ff', tracking: 100, underline: true }));
    expect(r.runs).toEqual([
      { start: 0, end: 4, style: { fontFamily: 'Box', fontWeight: 700, fontSize: 10, color: '#0000ff', tracking: 100, underline: true } },
      { start: 4, end: 9, style: { fontFamily: 'Box', fontWeight: 400, fontSize: 10, color: '#000000' } },
    ]);
    r = out(await registry.callTool('set_text_style', { layerId: id, start: 0, end: 4, tracking: null }));
    expect(r.runs[0].style.tracking).toBeUndefined();
    r = out(await registry.callTool('set_paragraph_style', { layerId: id, align: 'right', spaceAfter: 4 }));
    expect(r.paragraphs[0].style).toEqual({ align: 'right', spaceAfter: 4 });
    r = out(await registry.callTool('set_text_frame', { layerId: id, kind: 'box', width: 40, height: 50 }));
    expect(r.frame).toEqual({ kind: 'box', width: 40, height: 50 });
    expect(r.lines).toHaveLength(2);
    r = out(await registry.callTool('convert_text_to_shape', { layerId: id }));
    expect(r.layer).toMatchObject({ id, type: 'shape' });
    expect(r.warnings).toEqual(['The text had several colours; the shape takes the first one.']);
    expect(steps(c)).toBe(n + 6);
  });

  it('refuses bad arguments with messages that say what to fix, and changes nothing', async () => {
    const { c, registry } = setup();
    const id = out(await registry.callTool('add_text_layer', { text: 'abc', x: 0, y: 20 })).layer.id;
    const n = steps(c);
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['add_text_layer', { text: 'x', x: 0 }, /y/],
      ['add_text_layer', { text: 'x', x: 0, y: 0, box: { width: 0, height: 5 } }, /width/],
      ['set_text', { layerId: id, text: 'x', start: 4 }, /0 ≤ start ≤ end ≤ 3/],
      ['set_text_style', { layerId: id }, /Give at least one style field/],
      ['set_text_style', { layerId: id, fontSize: 0 }, /fontSize/],
      ['set_paragraph_style', { layerId: id, align: 'middle' }, /align/],
      ['set_text_frame', { layerId: id, kind: 'box' }, /needs width and height/],
      ['set_text', { layerId: 'background', text: 'x' }, /not a type layer/],
      ['get_text_layer', { layerId: 'ghost' }, /Unknown layer "ghost"/],
    ];
    for (const [tool, args, message] of cases) {
      const res = await registry.callTool(tool, args);
      expect(res.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(errorText(res)).toMatch(message);
    }
    expect(steps(c)).toBe(n);
  });

  it('convert_text_to_shape needs outlines, which the canvas shaper cannot give', async () => {
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake, textShaper: null });
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c));
    const res = await registry.callTool('add_text_layer', { text: 'x', x: 0, y: 20 });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toMatch(/need a text shaper/);
  });
});

/** A 2D context that records what is drawn, with fixed metrics. */
function recordingCanvas() {
  const calls: Array<{ op: string; font?: string; baseline?: string; args: unknown[]; transform?: number[] }> = [];
  let transform = [1, 0, 0, 1, 0, 0];
  const ctx = {
    font: '',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    fillStyle: '#000',
    globalAlpha: 1,
    // Georgia is "installed": it measures differently from the generic families.
    measureText: (text: string) => ({ width: text.length * (ctx.font.includes('Georgia') ? 8 : 7), emHeightAscent: 9, emHeightDescent: 3 }),
    setTransform: (...m: number[]) => {
      transform = m;
    },
    translate: (x: number, y: number) => {
      transform = [transform[0], transform[1], transform[2], transform[3], transform[4] + x, transform[5] + y];
    },
    rotate: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    fillText: (...args: unknown[]) => calls.push({ op: 'fillText', font: ctx.font, baseline: ctx.textBaseline, args, transform: [...transform] }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  const canvas = { width: 1, height: 1, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, ctx, calls };
}

describe('text annotations migrate to type layers drawn the same way', () => {
  it('draws the same text, font and position as the old annotation renderer (Canvas 2D shaper)', () => {
    const annotation: TextAnnotation = { id: 't1', type: 'text', x: 12, y: 30, text: 'Caption', fontSize: 18, fontFamily: 'Georgia', fontWeight: 'bold', color: '#ff0000' };
    const old = recordingCanvas();
    new ImageEditorRenderer().drawAnnotationShape(old.ctx as unknown as CanvasRenderingContext2D, annotation, null);
    const now = recordingCanvas();
    const shaper = createCanvasTextShaper({ createCanvas: () => now.canvas })!;
    const layer = annotationLayerFor(annotation, { width: W, height: H, shaper, createCanvas: () => now.canvas }) as TypeLayer;
    expect(layer.type).toBe('type');
    now.calls.length = 0;
    expect(renderText(layer, { width: W, height: H, shaper, createCanvas: () => now.canvas })).not.toBeNull();
    expect(old.calls).toHaveLength(1);
    expect(now.calls).toHaveLength(1);
    const [o] = old.calls;
    const [n] = now.calls;
    // Old: 'bold 18px Georgia', top baseline at (12, 30). New: the same font, the alphabetic
    // baseline one em ascent lower, through a matrix that puts the origin at (12, 30).
    expect(o).toMatchObject({ font: 'bold 18px Georgia', baseline: 'top', args: ['Caption', 12, 30] });
    expect(n.font).toBe(cssFont({ family: 'Georgia', weight: 700, italic: false, size: 18 }));
    expect(n.font).toBe('700 18px Georgia');
    expect(n.baseline).toBe('alphabetic');
    expect(n.args).toEqual(['Caption', 0, 9]);
    // The canvas covers the ink bounds from (3, 21) (half an em of padding), so the matrix puts
    // text space (0, 0) at canvas (9, 9) = document (12, 30).
    expect(n.transform).toEqual([1, 0, 0, 1, 9, 9]);
    expect(layer.missingFonts).toBeUndefined();
  });
});
