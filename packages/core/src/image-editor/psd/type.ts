// Portions ported from photocraft/crates/text/src/psd.rs, photocraft/crates/text/src/fonts.rs (`guess_from_postscript`) and photocraft/crates/io/src/text_import.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Type layers ⇄ PSD `TySh`: a version, the text-space → document transform (six doubles), the
 * text descriptor (`TxLr`: `Txt `, anti-aliasing, bounds, and `EngineData`, Photoshop's text
 * engine data with the runs, paragraphs, fonts and frame), the warp descriptor and four trailing
 * values.
 *
 * EngineData sizes are text-space units, which the transform maps to document pixels, so they are
 * our pixels as they are. Runs count UTF-16 code units, as ours do; the engine text ends with an
 * extra paragraph break that the last runs cover.
 *
 * Export writes the block read from the file back unchanged while the layer is unchanged
 * (`typeSignature`); otherwise it patches the text, runs, paragraphs, fonts, frame and transform
 * into it (so Photoshop-only settings survive), or builds a new one.
 */

import { PsdReader, PsdWriter } from './binary';
import { descGet, descNumber, descObject, descriptor, readVersionedDescriptor, writeVersionedDescriptor, type DescValue, type Descriptor } from './descriptor';
import { E, eArray, eBool, eClone, eGet, eNum, ePath, eSet, eStr, parseEngineData, writeEngineData, type EngineValue } from './engine-data';
import { contentBounds } from '../../raster/surface';
import { invertMatrix, multiplyMatrices, applyMatrix } from '../../geom/affine';
import type { AffineMatrix } from '../../geom/types';
import { DEFAULT_TEXT_STYLE, fitParagraphRuns, fitRuns, textMatrix } from '../layers/text';
import type { ParagraphRun, ParagraphStyle, TextAlign, TextRun, TextStyle, TypeLayer } from '../layers/model';

export interface PsdTySh {
  transform: AffineMatrix;
  text: Descriptor;
  warp: Descriptor | null;
  /** The bytes after the warp descriptor (four values Photoshop writes), kept as they are. */
  tail: Uint8Array;
}

/** Parses a `TySh` block, or `null` when it is malformed. */
export function parseTySh(data: Uint8Array): PsdTySh | null {
  try {
    const r = new PsdReader(data);
    r.u16();
    const m: number[] = [];
    for (let k = 0; k < 6; k++) m.push(r.f64());
    r.u16();
    const text = readVersionedDescriptor(r);
    let warp: Descriptor | null = null;
    if (r.remaining >= 6) {
      const at = r.pos;
      try {
        r.u16();
        warp = readVersionedDescriptor(r);
      } catch {
        r.pos = at;
      }
    }
    return { transform: m as unknown as AffineMatrix, text, warp, tail: r.rest() };
  } catch {
    return null;
  }
}

function defaultWarp(): Descriptor {
  return descriptor('warp', [
    ['warpStyle', { type: 'enum', typeId: 'warpStyle', value: 'warpNone' }],
    ['warpValue', { type: 'doub', value: 0 }],
    ['warpPerspective', { type: 'doub', value: 0 }],
    ['warpPerspectiveOther', { type: 'doub', value: 0 }],
    ['warpRotate', { type: 'enum', typeId: 'Ornt', value: 'Hrzn' }],
  ]);
}

export function writeTySh(t: PsdTySh): Uint8Array {
  const w = new PsdWriter();
  w.u16(1);
  for (const v of t.transform) w.f64(v);
  w.u16(50);
  writeVersionedDescriptor(w, t.text);
  w.u16(1);
  writeVersionedDescriptor(w, t.warp ?? defaultWarp());
  if (t.tail.length >= 16) w.bytes(t.tail);
  else w.zeros(16);
  return w.result();
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

const WEIGHTS: Array<[RegExp, number]> = [
  [/thin|hairline/, 100],
  [/extralight|ultralight/, 200],
  [/semibold|demibold|demi/, 600],
  [/extrabold|ultrabold/, 800],
  [/black|heavy/, 900],
  [/bold/, 700],
  [/medium/, 500],
  [/light/, 300],
];

/** Family, weight and italic guessed from a PostScript name (`TimesNewRomanPS-BoldItalicMT` → Times New Roman, 700, italic). */
export function fontFromPostScript(ps: string): { family: string; weight: number; italic: boolean } {
  let pro = ps;
  let style = '';
  const dash = ps.lastIndexOf('-');
  if (dash > 0) {
    pro = ps.slice(0, dash);
    style = ps.slice(dash + 1);
    const prev = pro.lastIndexOf('-');
    if (/^(it|italic|oblique)$/i.test(style) && prev > 0 && /^(thin|hairline|extralight|ultralight|light|regular|roman|book|medium|semibold|demibold|demi|bold|extrabold|ultrabold|heavy|black)$/i.test(pro.slice(prev + 1))) {
      style = ps.slice(prev + 1);
      pro = ps.slice(0, prev);
    }
  } else {
    const m = /^(.*?)(Bold|Italic|Light|Medium|Black|Regular|Oblique)+$/.exec(ps);
    if (m && m[1]) {
      pro = m[1];
      style = ps.slice(m[1].length);
    }
  }
  let suffix = '';
  if (pro.endsWith('Pro')) suffix = ' Pro';
  else if (pro.endsWith('Std')) suffix = ' Std';
  const fam = pro.replace(/(MT|PS|Std|Pro)+$/, '');
  let family = '';
  for (let i = 0; i < fam.length; i++) {
    const c = fam[i];
    const upper = c >= 'A' && c <= 'Z';
    const prevLower = i > 0 && fam[i - 1] >= 'a' && fam[i - 1] <= 'z';
    const prevUpper = i > 0 && fam[i - 1] >= 'A' && fam[i - 1] <= 'Z';
    const nextLower = i + 1 < fam.length && fam[i + 1] >= 'a' && fam[i + 1] <= 'z';
    if (i > 0 && upper && (prevLower || (prevUpper && nextLower))) family += ' ';
    family += c;
  }
  family += suffix;
  const s = style.toLowerCase();
  const weight = WEIGHTS.find(([re]) => re.test(s))?.[1] ?? 400;
  return { family: family || ps, weight, italic: /italic|oblique|it$/.test(s) };
}

const STYLE_NAMES: Array<[number, string]> = [
  [100, 'Thin'],
  [200, 'ExtraLight'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'SemiBold'],
  [700, 'Bold'],
  [800, 'ExtraBold'],
  [900, 'Black'],
];

/** The PostScript name to write for a style (its own, when it came from a file). */
export function postScriptFor(s: TextStyle): string {
  if (s.postScriptName) return s.postScriptName;
  const base = s.fontFamily.replace(/["',]/g, '').replace(/\s+/g, '');
  const weight = STYLE_NAMES.reduce((best, w) => (Math.abs(w[0] - s.fontWeight) < Math.abs(best[0] - s.fontWeight) ? w : best))[1];
  if (weight === 'Regular' && !s.italic) return base;
  return `${base}-${weight === 'Regular' ? '' : weight}${s.italic ? 'Italic' : ''}`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0');

/** A dictionary merging `levels`: a key comes from the first level that has it. */
function merged(levels: Array<EngineValue | undefined>): EngineValue {
  const items: Array<[string, EngineValue]> = [];
  for (const l of levels) {
    if (l?.t !== 'dict') continue;
    for (const [k, v] of l.items) if (!items.some(([o]) => o === k)) items.push([k, v]);
  }
  return E.dict(items);
}

function charStyle(d: EngineValue, fonts: string[], notes: Set<string>): TextStyle {
  const n = (k: string) => eNum(eGet(d, k));
  const flag = (k: string) => eBool(eGet(d, k));
  const s: TextStyle = { ...DEFAULT_TEXT_STYLE };
  const fi = n('Font');
  const ps = fi !== undefined ? fonts[fi] : undefined;
  if (ps) {
    const f = fontFromPostScript(ps);
    s.fontFamily = f.family;
    s.fontWeight = f.weight;
    if (f.italic) s.italic = true;
    s.postScriptName = ps;
  }
  const size = n('FontSize');
  if (size !== undefined && size > 0) s.fontSize = size;
  if (flag('AutoLeading') === false) {
    const lead = n('Leading');
    if (lead !== undefined && lead > 0) s.leading = lead;
  }
  const tracking = n('Tracking');
  if (tracking) s.tracking = tracking;
  const shift = n('BaselineShift');
  if (shift) s.baselineShift = shift;
  if (flag('Underline')) s.underline = true;
  if (flag('Strikethrough')) s.strikethrough = true;
  if (flag('FauxBold')) notes.add('faux bold is drawn as the regular weight');
  if (flag('FauxItalic')) notes.add('faux italic is drawn upright');
  if ((n('HorizontalScale') ?? 1) !== 1 || (n('VerticalScale') ?? 1) !== 1) notes.add('horizontal and vertical character scaling is drawn at 100 %');
  if ((n('FontCaps') ?? 0) !== 0) notes.add('small caps and all caps are drawn as typed');
  const color = eGet(d, 'FillColor');
  const values = eArray(eGet(color, 'Values')).map((v) => eNum(v) ?? 0);
  if (values.length === 4) {
    s.color = `#${hex2(values[1])}${hex2(values[2])}${hex2(values[3])}`;
    if (values[0] < 1) s.opacity = Math.max(0, values[0]);
  } else if (values.length === 2) {
    const g = hex2(values[1]);
    s.color = `#${g}${g}${g}`;
  } else if (values.length === 5) {
    const [c, m, y, k] = values.slice(1);
    s.color = `#${hex2((1 - c) * (1 - k))}${hex2((1 - m) * (1 - k))}${hex2((1 - y) * (1 - k))}`;
    notes.add('CMYK text colours were converted to RGB');
  }
  return s;
}

function paraStyle(d: EngineValue): ParagraphStyle {
  const n = (k: string) => eNum(eGet(d, k));
  const out: ParagraphStyle = {};
  const j = n('Justification');
  const align: TextAlign = j === 1 ? 'right' : j === 2 ? 'center' : j !== undefined && j >= 3 ? 'justify' : 'left';
  if (align !== 'left') out.align = align;
  const set = (k: keyof ParagraphStyle, v: number | undefined) => {
    if (v) (out as Record<string, number>)[k] = v;
  };
  set('firstLineIndent', n('FirstLineIndent'));
  set('startIndent', n('StartIndent'));
  set('endIndent', n('EndIndent'));
  set('spaceBefore', n('SpaceBefore'));
  set('spaceAfter', n('SpaceAfter'));
  const auto = n('AutoLeading');
  if (auto !== undefined && auto > 0 && Math.abs(auto - 1.2) > 1e-6) out.autoLeading = auto;
  return out;
}

export interface PsdTypeData {
  text: string;
  runs: TextRun[];
  paragraphs: ParagraphRun[];
  frame: TypeLayer['frame'];
  transform: AffineMatrix;
  antiAlias: boolean;
  /** PostScript names the text uses. */
  fonts: string[];
}

/** A type layer's data from a `TySh` block, or `null` when the block can't be read. `notes` collects approximations. */
export function typeFromTySh(data: Uint8Array, notes: Set<string>): PsdTypeData | null {
  const t = parseTySh(data);
  if (!t) return null;
  const txtV = descGet(t.text, 'Txt ');
  const txt = txtV?.type === 'TEXT' ? txtV.value.replace(/\0+$/, '') : undefined;
  const ed = descGet(t.text, 'EngineData');
  let engine: EngineValue | null = null;
  if (ed?.type === 'tdta') {
    try {
      engine = parseEngineData(ed.data);
    } catch {
      notes.add('the text engine data could not be read; the text came in in one style');
    }
  }
  const anti = descGet(t.text, 'AntA');
  const antiAlias = !(anti?.type === 'enum' && (anti.value === 'Anno' || anti.value === 'antiAliasNone'));
  const ornt = descGet(t.text, 'Ornt');
  if (ornt?.type === 'enum' && ornt.value === 'Vrtc') notes.add('vertical type is laid out horizontally');
  if (t.warp) {
    const style = descGet(t.warp, 'warpStyle');
    if (style?.type === 'enum' && style.value !== 'warpNone') notes.add('warped text is drawn without its warp when edited');
  }
  const edText = eStr(ePath(engine ?? undefined, ['EngineDict', 'Editor', 'Text'])) ?? '';
  const text = (txt ?? edText.replace(/\r$/, '')).replace(/\r\n?/g, '\n');
  let runs: TextRun[] = [{ length: text.length, style: { ...DEFAULT_TEXT_STYLE } }];
  let paragraphs: ParagraphRun[] = [{ length: text.length, style: {} }];
  let frame: TypeLayer['frame'] = { kind: 'point' };
  let transform = t.transform;
  const fonts: string[] = [];
  if (engine) {
    const res = eGet(engine, 'ResourceDict') ?? eGet(engine, 'DocumentResources');
    for (const f of eArray(eGet(res, 'FontSet'))) fonts.push(eStr(eGet(f, 'Name')) ?? '');
    const styleSet = eArray(eGet(res, 'StyleSheetSet'));
    const paraSet = eArray(eGet(res, 'ParagraphSheetSet'));
    const normalStyle = styleSet[eNum(eGet(res, 'TheNormalStyleSheet')) ?? 0] ?? styleSet[0];
    const normalPara = paraSet[eNum(eGet(res, 'TheNormalParagraphSheet')) ?? 0] ?? paraSet[0];
    const named = (set: EngineValue[], sheet: EngineValue | undefined): EngineValue | undefined => {
      const parent = eNum(eGet(sheet, 'Parent'));
      if (parent !== undefined && set[parent]) return set[parent];
      const name = eStr(eGet(sheet, 'Name'));
      return name ? set.find((s) => eStr(eGet(s, 'Name')) === name) : undefined;
    };
    const prun = ePath(engine, ['EngineDict', 'ParagraphRun']);
    const psheets = eArray(eGet(prun, 'RunArray')).map((x) => eGet(x, 'ParagraphSheet'));
    const plens = eArray(eGet(prun, 'RunLengthArray')).map((v) => eNum(v) ?? 0);
    const paraBases = psheets.map((sheet) => {
      const own = named(paraSet, sheet);
      const base = merged([eGet(own, 'Properties'), eGet(normalPara, 'Properties')]);
      const di = eNum(eGet(sheet, 'DefaultStyleSheet')) ?? eNum(eGet(own, 'DefaultStyleSheet'));
      return { base, charDefault: di !== undefined ? styleSet[di] : undefined };
    });
    if (psheets.length) {
      paragraphs = psheets.map((sheet, i) => ({ length: plens[i] ?? 0, style: paraStyle(merged([eGet(sheet, 'Properties'), paraBases[i].base])) }));
    }
    const srun = ePath(engine, ['EngineDict', 'StyleRun']);
    const ssheets = eArray(eGet(srun, 'RunArray')).map((x) => eGet(x, 'StyleSheet'));
    const slens = eArray(eGet(srun, 'RunLengthArray')).map((v) => eNum(v) ?? 0);
    const paraAt = (at: number) => {
      let end = 0;
      for (let i = 0; i < plens.length; i++) {
        end += plens[i];
        if (at < end) return i;
      }
      return plens.length - 1;
    };
    if (ssheets.length) {
      let at = 0;
      runs = ssheets.map((sheet, i) => {
        const own = named(styleSet, sheet);
        const paraDefault = paraBases[paraAt(at)]?.charDefault;
        at += slens[i] ?? 0;
        const d = merged([eGet(sheet, 'StyleSheetData'), eGet(own, 'StyleSheetData'), eGet(paraDefault, 'StyleSheetData'), eGet(normalStyle, 'StyleSheetData')]);
        return { length: slens[i] ?? 0, style: charStyle(d, fonts, notes) };
      });
    }
    const shape = eArray(ePath(engine, ['EngineDict', 'Rendered', 'Shapes', 'Children']))[0];
    if (eNum(eGet(shape, 'ShapeType')) === 1) {
      const b = eArray(ePath(shape, ['Cookie', 'Photoshop', 'BoxBounds'])).map((v) => eNum(v) ?? 0);
      if (b.length === 4 && b[2] > b[0] && b[3] > b[1]) {
        frame = { kind: 'box', width: b[2] - b[0], height: b[3] - b[1] };
        // Our box starts at text-space (0, 0): fold its top-left into the transform.
        transform = multiplyMatrices([1, 0, 0, 1, b[0], b[1]], t.transform);
      }
    }
  }
  return {
    text,
    runs: fitRuns(runs, text.length, DEFAULT_TEXT_STYLE),
    paragraphs: fitParagraphRuns(paragraphs, text),
    frame,
    transform,
    antiAlias,
    fonts: [...new Set(fonts.filter(Boolean))],
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** What a type layer says, for deciding whether a `TySh` read from a file still describes it. */
export function typeSignature(layer: Pick<TypeLayer, 'text' | 'runs' | 'paragraphs' | 'frame' | 'transform' | 'antiAlias'>): string {
  return JSON.stringify([layer.text, layer.runs, layer.paragraphs, layer.frame, layer.transform ?? null, layer.antiAlias ?? true]);
}

function styleSheetData(s: TextStyle, font: number): EngineValue {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(s.color.slice(i, i + 2), 16) / 255);
  return E.dict([
    ['Font', E.int(font)],
    ['FontSize', E.real(s.fontSize)],
    ['FauxBold', E.bool(false)],
    ['FauxItalic', E.bool(false)],
    ['AutoLeading', E.bool(s.leading === undefined)],
    ['Leading', E.real(s.leading ?? 0)],
    ['HorizontalScale', E.real(1)],
    ['VerticalScale', E.real(1)],
    ['Tracking', E.int(Math.round(s.tracking ?? 0))],
    ['AutoKerning', E.bool(true)],
    ['Kerning', E.int(0)],
    ['BaselineShift', E.real(s.baselineShift ?? 0)],
    ['FontCaps', E.int(0)],
    ['Underline', E.bool(Boolean(s.underline))],
    ['Strikethrough', E.bool(Boolean(s.strikethrough))],
    ['Ligatures', E.bool(true)],
    ['DLigatures', E.bool(false)],
    ['FillFlag', E.bool(true)],
    [
      'FillColor',
      E.dict([
        ['Type', E.int(1)],
        ['Values', E.array([E.real(s.opacity ?? 1), E.real(r), E.real(g), E.real(b)])],
      ]),
    ],
  ]);
}

function paragraphProperties(p: ParagraphStyle): EngineValue {
  const j = p.align === 'right' ? 1 : p.align === 'center' ? 2 : p.align === 'justify' ? 3 : 0;
  return E.dict([
    ['Justification', E.int(j)],
    ['FirstLineIndent', E.real(p.firstLineIndent ?? 0)],
    ['StartIndent', E.real(p.startIndent ?? 0)],
    ['EndIndent', E.real(p.endIndent ?? 0)],
    ['SpaceBefore', E.real(p.spaceBefore ?? 0)],
    ['SpaceAfter', E.real(p.spaceAfter ?? 0)],
    ['AutoHyphenate', E.bool(false)],
    ['AutoLeading', E.real(p.autoLeading ?? 1.2)],
    ['LeadingType', E.int(0)],
  ]);
}

const fontEntry = (name: string) =>
  E.dict([
    ['Name', E.str(name)],
    ['Script', E.int(0)],
    ['FontType', E.int(1)],
    ['Synthetic', E.int(0)],
  ]);

/** EngineData for a layer, patched into `template` (from the file) when there is one. */
export function buildEngineData(layer: TypeLayer, template: EngineValue | null): EngineValue {
  const e: EngineValue = template?.t === 'dict' ? eClone(template) : E.dict([['EngineDict', E.dict()], ['ResourceDict', E.dict()]]);
  if (eGet(e, 'EngineDict')?.t !== 'dict') eSet(e, 'EngineDict', E.dict());
  const dict = eGet(e, 'EngineDict')!;
  const text = layer.text.replace(/\n/g, '\r');
  const edText = `${text}\r`;
  const res0 = eGet(e, 'ResourceDict') ?? eGet(e, 'DocumentResources');
  const fonts: string[] = eArray(eGet(res0, 'FontSet')).map((f) => eStr(eGet(f, 'Name')) ?? '');
  const fontIndex = (ps: string) => {
    const at = fonts.indexOf(ps);
    if (at >= 0) return at;
    fonts.push(ps);
    return fonts.length - 1;
  };
  const runs = fitRuns(layer.runs, layer.text.length, DEFAULT_TEXT_STYLE);
  const sruns: EngineValue[] = [];
  const slens: EngineValue[] = [];
  runs.forEach((r, i) => {
    sruns.push(E.dict([['StyleSheet', E.dict([['StyleSheetData', styleSheetData(r.style, fontIndex(postScriptFor(r.style)))]])]]));
    slens.push(E.int(r.length + (i === runs.length - 1 ? 1 : 0)));
  });
  if (!runs.length) {
    sruns.push(E.dict([['StyleSheet', E.dict([['StyleSheetData', styleSheetData(DEFAULT_TEXT_STYLE, fontIndex(postScriptFor(DEFAULT_TEXT_STYLE)))]])]]));
    slens.push(E.int(1));
  }
  const paras = fitParagraphRuns(layer.paragraphs, layer.text);
  const pruns: EngineValue[] = [];
  const plens: EngineValue[] = [];
  paras.forEach((p, i) => {
    pruns.push(E.dict([['ParagraphSheet', E.dict([['DefaultStyleSheet', E.int(0)], ['Properties', paragraphProperties(p.style)]])]]));
    plens.push(E.int(p.length + (i === paras.length - 1 ? 1 : 0)));
  });
  const editor = eGet(dict, 'Editor') ?? E.dict();
  eSet(editor, 'Text', E.str(edText));
  eSet(dict, 'Editor', editor);
  const pr = eGet(dict, 'ParagraphRun') ?? E.dict();
  eSet(pr, 'RunArray', E.array(pruns));
  eSet(pr, 'RunLengthArray', E.array(plens));
  if (!eGet(pr, 'IsJoinable')) eSet(pr, 'IsJoinable', E.int(1));
  eSet(dict, 'ParagraphRun', pr);
  const sr = eGet(dict, 'StyleRun') ?? E.dict();
  eSet(sr, 'RunArray', E.array(sruns));
  eSet(sr, 'RunLengthArray', E.array(slens));
  if (!eGet(sr, 'IsJoinable')) eSet(sr, 'IsJoinable', E.int(2));
  eSet(dict, 'StyleRun', sr);
  eSet(dict, 'AntiAlias', E.int(layer.antiAlias === false ? 0 : 3));
  if (!eGet(dict, 'UseFractionalGlyphWidths')) eSet(dict, 'UseFractionalGlyphWidths', E.bool(true));
  const box = layer.frame.kind === 'box' ? layer.frame : null;
  const shapeType = box ? 1 : 0;
  const photoshop = E.dict([['ShapeType', E.int(shapeType)]]);
  if (box) eSet(photoshop, 'BoxBounds', E.array([E.real(0), E.real(0), E.real(box.width), E.real(box.height)]));
  else eSet(photoshop, 'PointBase', E.array([E.real(0), E.real(0)]));
  eSet(
    photoshop,
    'Base',
    E.dict([
      ['ShapeType', E.int(shapeType)],
      ['TransformPoint0', E.array([E.real(1), E.real(0)])],
      ['TransformPoint1', E.array([E.real(0), E.real(1)])],
      ['TransformPoint2', E.array([E.real(0), E.real(0)])],
    ])
  );
  const child = E.dict([
    ['ShapeType', E.int(shapeType)],
    ['Procession', E.int(0)],
    ['Lines', E.dict([['WritingDirection', E.int(0)], ['Children', E.array([])]])],
    ['Cookie', E.dict([['Photoshop', photoshop]])],
  ]);
  eSet(dict, 'Rendered', E.dict([['Version', E.int(1)], ['Shapes', E.dict([['WritingDirection', E.int(0)], ['Children', E.array([child])]])]]));
  const fontSet = E.array(fonts.map(fontEntry));
  for (const key of ['ResourceDict', 'DocumentResources']) {
    let rd = eGet(e, key);
    if (!rd) {
      if (key === 'DocumentResources') {
        eSet(e, key, eClone(eGet(e, 'ResourceDict') ?? E.dict()));
        continue;
      }
      rd = E.dict();
      eSet(e, key, rd);
    }
    eSet(rd, 'FontSet', fontSet);
    if (!eGet(rd, 'StyleSheetSet')) eSet(rd, 'StyleSheetSet', E.array([E.dict([['Name', E.str('Normal RGB')], ['StyleSheetData', styleSheetData(runs[0]?.style ?? DEFAULT_TEXT_STYLE, 0)]])]));
    if (!eGet(rd, 'ParagraphSheetSet')) eSet(rd, 'ParagraphSheetSet', E.array([E.dict([['Name', E.str('Normal RGB')], ['DefaultStyleSheet', E.int(0)], ['Properties', paragraphProperties({})]])]));
    if (!eGet(rd, 'TheNormalStyleSheet')) eSet(rd, 'TheNormalStyleSheet', E.int(0));
    if (!eGet(rd, 'TheNormalParagraphSheet')) eSet(rd, 'TheNormalParagraphSheet', E.int(0));
  }
  return e;
}

/** Text-space bounds of the layer's pixels (from its rendered surface), for the descriptor's `bounds`. */
function inkBounds(layer: TypeLayer): [number, number, number, number] {
  if (layer.frame.kind === 'box') return [0, 0, layer.frame.width, layer.frame.height];
  const b = contentBounds(layer.surface);
  if (!b) return [0, 0, 0, 0];
  const inv = invertMatrix(textMatrix(layer));
  const pts = [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height },
  ].map((p) => applyMatrix(inv, p));
  return [Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y))];
}

/** The `TySh` block for a type layer: the one read while unchanged, else patched or built. */
export function tyShForLayer(layer: TypeLayer): Uint8Array {
  const raw = layer.psd?.tySh;
  if (raw && layer.psd?.signature === typeSignature(layer)) return raw;
  const old = raw ? parseTySh(raw) : null;
  const oldEd = old ? descGet(old.text, 'EngineData') : undefined;
  let template: EngineValue | null = null;
  if (oldEd?.type === 'tdta') {
    try {
      template = parseEngineData(oldEd.data);
    } catch {
      template = null;
    }
  }
  const engine = buildEngineData(layer, template);
  const text: Descriptor = old ? { ...old.text, items: [...old.text.items] } : descriptor('TxLr');
  const set = (key: string, v: DescValue) => {
    const at = text.items.findIndex(([k]) => k === key);
    if (at >= 0) text.items[at] = [key, v];
    else text.items.push([key, v]);
  };
  set('Txt ', { type: 'TEXT', value: layer.text.replace(/\n/g, '\r') });
  if (!descGet(text, 'textGridding')) set('textGridding', { type: 'enum', typeId: 'textGridding', value: 'None' });
  set('Ornt', { type: 'enum', typeId: 'Ornt', value: 'Hrzn' });
  set('AntA', { type: 'enum', typeId: 'Annt', value: layer.antiAlias === false ? 'Anno' : 'AnSm' });
  const [l, t, r, b] = inkBounds(layer);
  const rect = (cls: string): DescValue => ({
    type: 'Objc',
    value: descriptor(cls, [
      ['Left', { type: 'UntF', unit: '#Pnt', value: l }],
      ['Top ', { type: 'UntF', unit: '#Pnt', value: t }],
      ['Rght', { type: 'UntF', unit: '#Pnt', value: r }],
      ['Btom', { type: 'UntF', unit: '#Pnt', value: b }],
    ]),
  });
  set('bounds', rect('bounds'));
  set('boundingBox', rect('boundingBox'));
  if (!descGet(text, 'TextIndex')) set('TextIndex', { type: 'long', value: 0 });
  set('EngineData', { type: 'tdta', data: writeEngineData(engine) });
  // An unchanged warp stays; a warp we cannot draw is dropped once the text is edited.
  const warpStyle = old?.warp ? descGet(old.warp, 'warpStyle') : undefined;
  const warp = old?.warp && warpStyle?.type === 'enum' && warpStyle.value === 'warpNone' ? old.warp : null;
  return writeTySh({ transform: textMatrix(layer), text, warp, tail: new Uint8Array(16) });
}

/** The text-space bounds rectangle of a `TySh`'s descriptor (for tests and inspection). */
export function tyShBounds(t: PsdTySh): [number, number, number, number] | null {
  const b = descObject(t.text, 'bounds');
  if (!b) return null;
  const v = ['Left', 'Top ', 'Rght', 'Btom'].map((k) => descNumber(b, k));
  return v.every((x) => x !== undefined) ? (v as [number, number, number, number]) : null;
}
