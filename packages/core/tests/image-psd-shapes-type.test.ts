import { describe, expect, it } from 'vitest';
import {
  ImageEditorController,
  createOutlineTextShaper,
  importPsd,
  readPsd,
  type ShapeLayer,
  type TypeLayer,
} from '../src/image-editor';
import { componentsFromVectorBlock, readPathRecords, vectorBlockForComponents, writePathRecords } from '../src/image-editor/psd/paths';
import { E, eGet, ePath, parseEngineData, writeEngineData } from '../src/image-editor/psd/engine-data';
import { fontFromPostScript, parseTySh, tyShForLayer, typeFromTySh, writeTySh } from '../src/image-editor/psd/type';
import { paintFromVscg, shapeFromBlocks, strokeFromVstk, vscgBytes, vstkBytes, liveShapesFromVogk, vogkBytes } from '../src/image-editor/psd/shapes';
import { liveComponent } from '../src/image-editor/layers/shape';
import { boxFont } from './helpers/box-font';

const W = 120;
const H = 80;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, textShaper: createOutlineTextShaper([boxFont('Box'), boxFont('Box', 700)]) });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  return c;
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('path records', () => {
  it('round-trip byte for byte, with operations, open subpaths and the initial fill', () => {
    const path = {
      initialFill: true,
      subpaths: [
        { closed: true, operation: 1, knots: [{ linked: false, pre: { x: 0.25, y: 0.25 }, anchor: { x: 0.25, y: 0.25 }, post: { x: 0.25, y: 0.25 } }, { linked: true, pre: { x: 0.625, y: 0.125 }, anchor: { x: 0.75, y: 0.25 }, post: { x: 0.875, y: 0.375 } }] },
        { closed: false, operation: 2, knots: [{ linked: false, pre: { x: -0.5, y: 1.5 }, anchor: { x: 0, y: 1 }, post: { x: 0.0625, y: 0.9375 } }] },
      ],
    };
    const bytes = writePathRecords(path);
    expect(bytes.length).toBe((2 + 2 + 3) * 26);
    const back = readPathRecords(bytes);
    expect(back).toEqual(path);
    expect(writePathRecords(back)).toEqual(bytes);
  });

  it('map shape components both ways: path operations, joined subpaths and Photoshop’s leading subtract', () => {
    const a = liveComponent({ kind: 'rect', x: 12, y: 8, width: 48, height: 32 });
    const b = { op: 'exclude' as const, subpaths: [...liveComponent({ kind: 'ellipse', x: 30, y: 20, width: 40, height: 40 }).subpaths, { closed: true, anchors: [{ x: 40, y: 30 }, { x: 50, y: 30 }, { x: 45, y: 40 }] }] };
    const block = vectorBlockForComponents([a, b], false, W, H);
    const back = componentsFromVectorBlock(block, W, H)!;
    expect(back.inverted).toBe(false);
    expect(back.components.map((c) => [c.op, c.subpaths.length])).toEqual([
      ['combine', 1],
      ['exclude', 2],
    ]);
    // Points survive to within the 8.24 fixed-point step.
    expect(back.components[0].subpaths[0].anchors[1].x).toBeCloseTo(60, 4);
    // Inverted shapes keep their flag; a stored leading subtract reads as inverted with dual operations.
    expect(componentsFromVectorBlock(vectorBlockForComponents([a], true, W, H), W, H)!.inverted).toBe(true);
    const lead = readPathRecords(writePathRecords({ initialFill: false, subpaths: [{ closed: true, operation: 2, knots: [] }] }));
    expect(lead.subpaths[0].operation).toBe(2);
  });
});

describe('fill, stroke and live shape descriptors', () => {
  it('round-trip colour, gradient and pattern fills and the stroke settings', () => {
    const notes = new Set<string>();
    expect(paintFromVscg(vscgBytes({ type: 'color', color: '#336699' }), notes)).toEqual({ type: 'color', color: '#336699' });
    const grad = { type: 'gradient' as const, gradient: { stops: [{ position: 0, color: '#ff0000' }, { position: 1, color: '#0000ff' }], style: 'radial' as const, angle: 30, scale: 1, reverse: true, align: true, offset: { x: 0, y: 0 } } };
    expect(paintFromVscg(vscgBytes(grad), notes)).toMatchObject({ type: 'gradient', gradient: { style: 'radial', angle: 30, reverse: true, stops: [{ color: '#ff0000' }, { color: '#0000ff' }] } });
    expect(paintFromVscg(vscgBytes({ type: 'pattern', patternId: 'abc', name: 'Dots', scale: 0.5, angle: 15 }), notes)).toEqual({ type: 'pattern', patternId: 'abc', name: 'Dots', scale: 0.5, angle: 15 });
    const stroke = { width: 4, paint: { type: 'color' as const, color: '#00ff00', opacity: 0.5 }, align: 'outside' as const, cap: 'round' as const, join: 'bevel' as const, dashes: [2, 1], dashOffset: 1 };
    expect(strokeFromVstk(vstkBytes(stroke, false, 72), 72, notes)).toEqual({ stroke, fillEnabled: false });
    expect(strokeFromVstk(vstkBytes(null, true, 72), 72, notes)).toEqual({ stroke: null, fillEnabled: true });
    expect(notes.size).toBe(0);
  });

  it('round-trip live rectangles, rounded rectangles, ellipses and lines with arrowheads by component', () => {
    const comps = [
      liveComponent({ kind: 'rect', x: 1, y: 2, width: 30, height: 20 }),
      liveComponent({ kind: 'rect', x: 1, y: 2, width: 30, height: 20, radii: [4, 4, 2, 2] }, 'subtract'),
      liveComponent({ kind: 'polygon', x: 0, y: 0, width: 10, height: 10, sides: 5 }),
      liveComponent({ kind: 'ellipse', x: 5, y: 5, width: 10, height: 6, transform: [0, 1, -1, 0, 20, 0] }),
      liveComponent({ kind: 'line', x1: 0, y1: 0, x2: 50, y2: 10, weight: 2, endArrow: { width: 10, length: 20, concavity: 0.25 } }),
    ];
    const live = liveShapesFromVogk(vogkBytes(comps, 72)!);
    expect([...live.keys()]).toEqual([0, 1, 3, 4]);
    expect(live.get(0)).toEqual(comps[0].live);
    expect(live.get(1)).toEqual(comps[1].live);
    expect(live.get(3)).toEqual(comps[3].live);
    expect(live.get(4)).toEqual(comps[4].live);
  });

  it('reads a shape from its blocks with the live shapes attached', () => {
    const comps = [liveComponent({ kind: 'ellipse', x: 10, y: 10, width: 40, height: 30 })];
    const blocks = [
      { key: 'vsms', data: vectorBlockForComponents(comps, false, W, H) },
      { key: 'vscg', data: vscgBytes({ type: 'color', color: '#ff8800' }) },
      { key: 'vstk', data: vstkBytes({ width: 2, paint: { type: 'color', color: '#000000' } }, true, 72) },
      { key: 'vogk', data: vogkBytes(comps, 72)! },
    ];
    const s = shapeFromBlocks(blocks, W, H, 72, new Set())!;
    expect(s.fill).toEqual({ type: 'color', color: '#ff8800' });
    expect(s.stroke).toEqual({ width: 2, paint: { type: 'color', color: '#000000' } });
    expect(s.components[0].live).toEqual(comps[0].live);
  });
});

describe('EngineData', () => {
  it('parses dictionaries, arrays, UTF-16 strings with escapes, numbers, booleans and names, and writes them back', () => {
    const src = '\n\n<<\n\t/EngineDict\n\t<<\n\t\t/Editor\n\t\t<<\n\t\t\t/Text (þÿ\u0000H\u0000i\u0000\\(\u0000\r)\n\t\t>>\n\t\t/Runs [ 1 2.5 .25 -3 ]\n\t\t/On true\n\t\t/Kind /Roman\n\t>>\n>>\n';
    const bytes = Uint8Array.from([...src].map((c) => c.charCodeAt(0)));
    const v = parseEngineData(bytes);
    expect((ePath(v, ['EngineDict', 'Editor', 'Text']) as { value: string }).value).toBe('Hi(\r');
    expect(ePath(v, ['EngineDict', 'Runs'])).toEqual(E.array([E.int(1), E.real(2.5), E.real(0.25), E.int(-3)]));
    expect(ePath(v, ['EngineDict', 'On'])).toEqual(E.bool(true));
    expect(ePath(v, ['EngineDict', 'Kind'])).toEqual({ t: 'name', value: 'Roman' });
    const again = parseEngineData(writeEngineData(v));
    expect(again).toEqual(v);
    // Txt2 style: a bare list of keys.
    expect(eGet(parseEngineData(Uint8Array.from([...'/A 1 /B [ 2 ]'].map((c) => c.charCodeAt(0)))), 'B')).toEqual(E.array([E.int(2)]));
    expect(() => parseEngineData(Uint8Array.from([...'<< /A (open'].map((c) => c.charCodeAt(0))))).toThrow(/unterminated string/);
  });

  it('guesses families, weights and styles from PostScript names', () => {
    expect(fontFromPostScript('ArialMT')).toEqual({ family: 'Arial', weight: 400, italic: false });
    expect(fontFromPostScript('Arial-BoldItalicMT')).toEqual({ family: 'Arial', weight: 700, italic: true });
    expect(fontFromPostScript('TimesNewRomanPSMT')).toEqual({ family: 'Times New Roman', weight: 400, italic: false });
    expect(fontFromPostScript('MyriadPro-Semibold')).toEqual({ family: 'Myriad Pro', weight: 600, italic: false });
    expect(fontFromPostScript('Inter-Light-Italic')).toEqual({ family: 'Inter', weight: 300, italic: true });
  });
});

describe('type layers ⇄ TySh', () => {
  it('writes text, runs, paragraphs, frame and transform that read back the same', () => {
    const c = setup();
    const id = c.addTextLayer({ text: 'Hello\nWorld', x: 20, y: 30, style: { fontFamily: 'Box', fontSize: 14, color: '#ff0000', tracking: 50 }, paragraph: { align: 'center', spaceAfter: 3 }, rotation: 15 });
    c.setTextStyle(id, { fontWeight: 700, underline: true, color: '#0000ff', leading: 20 }, { start: 6, end: 11 });
    const layer = c.getLayer(id) as TypeLayer;
    const notes = new Set<string>();
    const back = typeFromTySh(tyShForLayer(layer), notes)!;
    expect(notes.size).toBe(0);
    expect(back.text).toBe(layer.text);
    expect(back.frame).toEqual({ kind: 'point' });
    back.transform.forEach((v, i) => expect(v).toBeCloseTo(layer.transform![i], 9));
    expect(back.paragraphs).toEqual(layer.paragraphs);
    expect(back.runs.map((r) => [r.length, r.style.fontFamily, r.style.fontWeight, r.style.color, r.style.tracking, r.style.underline, r.style.leading])).toEqual([
      [6, 'Box', 400, '#ff0000', 50, undefined, undefined],
      [5, 'Box', 700, '#0000ff', 50, true, 20],
    ]);
  });

  it('keeps paragraph boxes and patches a file’s TySh, keeping what it does not model', () => {
    const c = setup();
    const id = c.addTextLayer({ text: 'Wrap me please', x: 10, y: 10, box: { width: 50, height: 40 }, style: { fontFamily: 'Box', fontSize: 10 } });
    const layer = c.getLayer(id) as TypeLayer;
    const first = tyShForLayer(layer);
    const parsed = parseTySh(first)!;
    // Add a key Photoshop would have, then edit the text through it.
    parsed.text.items.push(['Custom', { type: 'long', value: 42 }]);
    const patched = { ...layer, text: 'Wrapped', runs: [{ length: 7, style: layer.runs[0].style }], paragraphs: [{ length: 7, style: {} }], psd: { tySh: writeTySh(parsed), signature: 'stale' } } as TypeLayer;
    const out = parseTySh(tyShForLayer(patched))!;
    expect(out.text.items.find(([k]) => k === 'Custom')).toBeTruthy();
    const back = typeFromTySh(tyShForLayer(patched), new Set())!;
    expect(back.text).toBe('Wrapped');
    expect(back.frame).toEqual({ kind: 'box', width: 50, height: 40 });
  });
});

describe('PSD round trips through the controller', () => {
  it('exports shape and type layers as Photoshop shape and type layers and reads them back', async () => {
    const c = setup();
    const shape = c.addShapeLayer({
      components: [{ shape: { kind: 'rect', x: 10, y: 10, width: 50, height: 30, radius: 6 } }, { shape: { kind: 'ellipse', x: 40, y: 20, width: 30, height: 30 }, op: 'subtract' }],
      fill: '#3366cc',
      stroke: { width: 3, paint: '#000000', align: 'inside', dashes: [3, 2] },
    });
    c.setLayerProperties(shape, { fillOpacity: 0.8 });
    c.addLayerEffect(shape, 'drop-shadow', { distance: 3 });
    const text = c.addTextLayer({ text: 'Title', x: 20, y: 70, style: { fontFamily: 'Box', fontSize: 12, color: '#ff0000' } });
    const before = c.compositePixels().data;
    const { bytes, warnings } = await c.toPsd();
    expect(warnings.join(' ')).not.toMatch(/pixel layers/);
    const file = readPsd(bytes);
    const keys = file.layers.map((l) => l.blocks.map((b) => b.key));
    expect(keys.some((k) => k.includes('vsms') && k.includes('vscg') && k.includes('vstk') && k.includes('vogk'))).toBe(true);
    expect(keys.some((k) => k.includes('TySh'))).toBe(true);

    const d = setup();
    const res = d.loadPsd(bytes);
    expect(res.summary.map((x) => x.type)).toEqual(['pixel', 'shape', 'type']);
    expect(res.summary.filter((x) => x.type !== 'pixel').every((x) => x.status === 'mapped')).toBe(true);
    const [, sid, tid] = res.layerIds;
    const s = d.getShapeLayer(sid);
    const orig = c.getShapeLayer(shape);
    expect(s.components.map((x) => [x.op, x.live?.kind])).toEqual(orig.components.map((x) => [x.op, x.live?.kind]));
    expect(s.components[0].live).toEqual(orig.components[0].live);
    expect(s.fill).toEqual(orig.fill);
    expect(s.stroke).toEqual(orig.stroke);
    expect((d.getLayer(sid) as ShapeLayer).fillOpacity).toBeCloseTo(0.8, 2);
    expect(d.getLayerEffects(sid).items.map((e) => e.kind)).toEqual(['drop-shadow']);
    const t = d.getTextLayer(tid);
    expect(t).toMatchObject({ text: 'Title', rendering: 'stored', frame: { kind: 'point' } });
    expect(t.runs[0].style).toMatchObject({ fontFamily: 'Box', fontSize: 12, color: '#ff0000' });
    // Photoshop's pixels (ours, here) come back; the shape is drawn again from its path.
    expect(maxDiff(d.compositePixels().data, before)).toBeLessThanOrEqual(2);

    // Unchanged layers write their blocks back byte for byte.
    const again = await d.toPsd();
    const blocksOf = (b: Uint8Array) => readPsd(b).layers.flatMap((l) => l.blocks.filter((x) => ['vsms', 'vscg', 'vstk', 'vogk', 'TySh'].includes(x.key)).map((x) => [x.key, Array.from(x.data)]));
    expect(blocksOf(again.bytes)).toEqual(blocksOf(bytes));

    // An edit draws the text again (fonts available here) and writes a new TySh.
    d.setText(tid, 'Subtitle');
    expect(d.getTextLayer(tid).rendering).toBe('live');
    const edited = importPsd((await d.toPsd()).bytes);
    expect((edited.layers.find((l) => l.type === 'type') as TypeLayer).text).toBe('Subtitle');
  });

  it('warns about fonts the shaper lacks and keeps Photoshop’s pixels', async () => {
    const c = setup();
    c.addTextLayer({ text: 'Fancy', x: 10, y: 40, style: { fontFamily: 'Box', fontSize: 20 } });
    const { bytes } = await c.toPsd();
    const d = new ImageEditorController({ textShaper: createOutlineTextShaper([{ face: boxFont('Other'), family: 'Other' }]) });
    const res = d.loadPsd(bytes);
    expect(res.warnings.join(' ')).toMatch(/The font "Box" is missing here/);
    const id = res.layerIds[1];
    expect(d.getTextLayer(id)).toMatchObject({ rendering: 'stored', missingFonts: ['Box'] });
    expect(maxDiff(d.compositePixels().data, c.compositePixels().data)).toBe(0);
  });
});
