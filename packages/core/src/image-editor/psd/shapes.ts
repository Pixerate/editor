// Portions ported from photocraft/crates/io/src/vector_map.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Shape layers ⇄ PSD: the vector block (`vsms`, or `vmsk` in older files) holds the path, `vscg`
 * (or a `SoCo` / `GdFl` / `PtFl` block) the fill, `vstk` the stroke and whether the fill is on,
 * and `vogk` the live shapes (rectangle, rounded rectangle, ellipse, line) by component.
 *
 * Export writes the blocks read from the file back unchanged while the shape is still what was
 * read (compared by `shapeSignature`); otherwise it writes all of them from the model.
 */

import { descBool, descGet, descNumber, descObject, descriptor, parseVersionedDescriptor, versionedDescriptorBytes, type DescValue, type Descriptor } from './descriptor';
import { colorDesc, colorOf, gradientItems, gradientOf, patternRefDesc, patternRefOf, placementItems, placementOf } from './effects';
import { componentsFromVectorBlock, vectorBlockForComponents } from './paths';
import { liveShapeSubpaths } from '../layers/shape';
import type { LiveShape, ShapeComponent, ShapeLayer, ShapePaint, ShapeStroke } from '../layers/model';
import type { AffineMatrix } from '../../geom/types';

export const SHAPE_PSD_KEYS = ['vsms', 'vmsk', 'vscg', 'vstk', 'vogk', 'SoCo', 'GdFl', 'PtFl'];

const unit = (u: string, value: number): DescValue => ({ type: 'UntF', unit: u, value });
const dbl = (value: number): DescValue => ({ type: 'doub', value });
const long = (value: number): DescValue => ({ type: 'long', value: Math.round(value) });
const boolV = (value: boolean): DescValue => ({ type: 'bool', value });
const enumV = (typeId: string, value: string): DescValue => ({ type: 'enum', typeId, value });
const obj = (d: Descriptor): DescValue => ({ type: 'Objc', value: d });
const enumOf = (d: Descriptor, key: string) => {
  const v = descGet(d, key);
  return v?.type === 'enum' ? v.value : undefined;
};

function read(data: Uint8Array): Descriptor | null {
  try {
    return parseVersionedDescriptor(data);
  } catch {
    return null;
  }
}

/** A length in pixels from a unit float (points and millimetres at `dpi`). */
function px(v: DescValue | undefined, dpi: number): number | undefined {
  if (!v) return undefined;
  if (v.type === 'UntF') {
    if (v.unit === '#Pnt') return (v.value * dpi) / 72;
    if (v.unit === '#Mlm') return (v.value * dpi) / 25.4;
    return v.value;
  }
  if (v.type === 'doub' || v.type === 'long') return v.value;
  return undefined;
}

// ---------------------------------------------------------------------------
// Fill content
// ---------------------------------------------------------------------------

/** A fill content descriptor (`SoCo`, `GdFl`, `PtFl`) as a paint. */
export function paintFromContent(key: string, d: Descriptor, notes: Set<string>): ShapePaint | null {
  if (key === 'SoCo') return { type: 'color', color: colorOf(descObject(d, 'Clr ')) };
  if (key === 'GdFl') return { type: 'gradient', gradient: gradientOf(d, notes) };
  if (key === 'PtFl') {
    const ref = patternRefOf(d);
    const place = placementOf(d);
    const scale = (descNumber(d, 'Scl ') ?? 100) / 100;
    const p: ShapePaint = { type: 'pattern', patternId: ref.patternId, name: ref.name, scale: Math.max(0.01, Math.min(10, scale)) };
    if (place.angle) p.angle = place.angle;
    if (!place.link) p.link = false;
    if (place.phase.x || place.phase.y) p.phase = place.phase;
    return p;
  }
  return null;
}

/** The content key and descriptor of a paint. */
export function contentOfPaint(p: ShapePaint): { key: 'SoCo' | 'GdFl' | 'PtFl'; desc: Descriptor } {
  if (p.type === 'color') return { key: 'SoCo', desc: descriptor('null', [['Clr ', obj(colorDesc(p.color))]]) };
  if (p.type === 'gradient') return { key: 'GdFl', desc: descriptor('null', gradientItems(p.gradient)) };
  return {
    key: 'PtFl',
    desc: descriptor('null', [['Ptrn', patternRefDesc(p.patternId, p.name)], ['Scl ', unit('#Prc', p.scale * 100)], ...placementItems(p.angle ?? 0, p.link ?? true, p.phase ?? { x: 0, y: 0 })]),
  };
}

/** `vscg`: a content key then a versioned descriptor. */
export function paintFromVscg(data: Uint8Array, notes: Set<string>): ShapePaint | null {
  if (data.length < 8) return null;
  const key = String.fromCharCode(...data.subarray(0, 4));
  const d = read(data.subarray(4));
  return d ? paintFromContent(key, d, notes) : null;
}

export function vscgBytes(p: ShapePaint): Uint8Array {
  const { key, desc } = contentOfPaint(p);
  const body = versionedDescriptorBytes(desc);
  const out = new Uint8Array(4 + body.length);
  for (let i = 0; i < 4; i++) out[i] = key.charCodeAt(i);
  out.set(body, 4);
  return out;
}

function classOfContent(d: Descriptor): 'SoCo' | 'GdFl' | 'PtFl' {
  if (d.classId === 'solidColorLayer' || descGet(d, 'Clr ')) return 'SoCo';
  if (d.classId === 'gradientLayer' || descGet(d, 'Grad')) return 'GdFl';
  return 'PtFl';
}

// ---------------------------------------------------------------------------
// vstk (stroke)
// ---------------------------------------------------------------------------

/** `vstk` → the stroke (or `null` when off) and whether the fill is on. */
export function strokeFromVstk(data: Uint8Array, dpi: number, notes: Set<string>): { stroke: ShapeStroke | null; fillEnabled: boolean } | null {
  const d = read(data);
  if (!d) return null;
  const fillEnabled = descBool(d, 'fillEnabled') !== false;
  if (descBool(d, 'strokeEnabled') !== true) return { stroke: null, fillEnabled };
  const content = descObject(d, 'strokeStyleContent');
  const paint = (content ? paintFromContent(classOfContent(content), content, notes) : null) ?? { type: 'color', color: '#000000' };
  const opacity = (descNumber(d, 'strokeStyleOpacity') ?? 100) / 100;
  const stroke: ShapeStroke = { width: px(descGet(d, 'strokeStyleLineWidth'), dpi) ?? 1, paint: opacity < 1 ? { ...paint, opacity } : paint };
  const cap = enumOf(d, 'strokeStyleLineCapType');
  if (cap === 'strokeStyleRoundCap') stroke.cap = 'round';
  else if (cap === 'strokeStyleSquareCap') stroke.cap = 'square';
  const join = enumOf(d, 'strokeStyleLineJoinType');
  if (join === 'strokeStyleRoundJoin') stroke.join = 'round';
  else if (join === 'strokeStyleBevelJoin') stroke.join = 'bevel';
  const align = enumOf(d, 'strokeStyleLineAlignment');
  if (align === 'strokeStyleAlignInside') stroke.align = 'inside';
  else if (align === 'strokeStyleAlignOutside') stroke.align = 'outside';
  const miter = descNumber(d, 'strokeStyleMiterLimit');
  if (miter !== undefined && miter !== 100) stroke.miterLimit = Math.max(1, Math.min(500, miter));
  const dashes = descGet(d, 'strokeStyleLineDashSet');
  if (dashes?.type === 'VlLs') {
    const list = dashes.items.map((v) => (v.type === 'UntF' || v.type === 'doub' || v.type === 'long' ? v.value : NaN)).filter((v) => Number.isFinite(v) && v >= 0);
    if (list.length && list.some((v) => v > 0)) stroke.dashes = list;
  }
  const offset = descNumber(d, 'strokeStyleLineDashOffset');
  if (offset) stroke.dashOffset = offset;
  if (enumOf(d, 'strokeStyleBlendMode') && enumOf(d, 'strokeStyleBlendMode') !== 'Nrml' && enumOf(d, 'strokeStyleBlendMode') !== 'normal') notes.add('a shape stroke blend mode other than Normal became Normal');
  return { stroke, fillEnabled };
}

export function vstkBytes(stroke: ShapeStroke | null, fillEnabled: boolean, dpi: number): Uint8Array {
  const s = stroke ?? { width: 3, paint: { type: 'color', color: '#000000' } };
  const { key, desc } = contentOfPaint(s.paint);
  const content = { ...desc, classId: key === 'SoCo' ? 'solidColorLayer' : key === 'GdFl' ? 'gradientLayer' : 'patternLayer' };
  const d = descriptor('strokeStyle', [
    ['strokeStyleVersion', long(2)],
    ['strokeEnabled', boolV(Boolean(stroke))],
    ['fillEnabled', boolV(fillEnabled)],
    ['strokeStyleLineWidth', unit('#Pxl', s.width)],
    ['strokeStyleLineDashOffset', unit('#Pnt', s.dashOffset ?? 0)],
    ['strokeStyleMiterLimit', dbl(s.miterLimit ?? 100)],
    ['strokeStyleLineCapType', enumV('strokeStyleLineCapType', s.cap === 'round' ? 'strokeStyleRoundCap' : s.cap === 'square' ? 'strokeStyleSquareCap' : 'strokeStyleButtCap')],
    ['strokeStyleLineJoinType', enumV('strokeStyleLineJoinType', s.join === 'round' ? 'strokeStyleRoundJoin' : s.join === 'bevel' ? 'strokeStyleBevelJoin' : 'strokeStyleMiterJoin')],
    ['strokeStyleLineAlignment', enumV('strokeStyleLineAlignment', s.align === 'inside' ? 'strokeStyleAlignInside' : s.align === 'outside' ? 'strokeStyleAlignOutside' : 'strokeStyleAlignCenter')],
    ['strokeStyleScaleLock', boolV(false)],
    ['strokeStyleStrokeAdjust', boolV(false)],
    ['strokeStyleLineDashSet', { type: 'VlLs', items: (s.dashes ?? []).map((v) => unit('#Nne', v)) }],
    ['strokeStyleBlendMode', enumV('BlnM', 'Nrml')],
    ['strokeStyleOpacity', unit('#Prc', (s.paint.opacity ?? 1) * 100)],
    ['strokeStyleContent', obj(content)],
    ['strokeStyleResolution', dbl(dpi)],
  ]);
  return versionedDescriptorBytes(d);
}

// ---------------------------------------------------------------------------
// vogk (live shapes)
// ---------------------------------------------------------------------------

function rectOf(o: Descriptor): { x: number; y: number; width: number; height: number } | null {
  const b = descObject(o, 'keyOriginShapeBBox');
  if (!b) return null;
  const t = descNumber(b, 'Top ');
  const l = descNumber(b, 'Left');
  const bt = descNumber(b, 'Btom');
  const r = descNumber(b, 'Rght');
  if ([t, l, bt, r].some((v) => v === undefined || !Number.isFinite(v))) return null;
  return { x: l!, y: t!, width: r! - l!, height: bt! - t! };
}

function pointOf(o: Descriptor, key: string): { x: number; y: number } | null {
  const p = descObject(o, key);
  const x = p && descNumber(p, 'Hrzn');
  const y = p && descNumber(p, 'Vrtc');
  return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? { x: x!, y: y! } : null;
}

/** The live shapes of a `vogk` block by component index (rectangles, rounded rectangles, ellipses, lines). */
export function liveShapesFromVogk(data: Uint8Array): Map<number, LiveShape> {
  const out = new Map<number, LiveShape>();
  if (data.length < 8) return out;
  const d = read(data.subarray(4));
  const list = d && descGet(d, 'keyDescriptorList');
  if (!list || list.type !== 'VlLs') return out;
  list.items.forEach((item, i) => {
    if (item.type !== 'Objc') return;
    const o = item.value;
    if (descBool(o, 'keyShapeInvalidated') === true) return;
    const index = descNumber(o, 'keyOriginIndex') ?? i;
    let transform: AffineMatrix | undefined;
    const t = descObject(o, 'Trnf');
    if (t) {
      const g = (k: string, dv: number) => descNumber(t, k) ?? dv;
      const m: AffineMatrix = [g('xx', 1), g('xy', 0), g('yx', 0), g('yy', 1), g('tx', 0), g('ty', 0)];
      if (!(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0)) transform = m;
    }
    const tt = transform ? { transform } : {};
    const type = descNumber(o, 'keyOriginType');
    let live: LiveShape | null = null;
    const r = rectOf(o);
    if ((type === 1 || type === 2) && r) {
      const rr = type === 2 ? descObject(o, 'keyOriginRRectRadii') : undefined;
      const g = (k: string) => (rr ? descNumber(rr, k) ?? 0 : 0);
      const radii: [number, number, number, number] = [g('topLeft'), g('topRight'), g('bottomRight'), g('bottomLeft')];
      live = { kind: 'rect', ...r, ...(radii.some((v) => v > 0) ? { radii } : {}), ...tt };
    } else if (type === 5 && r) live = { kind: 'ellipse', ...r, ...tt };
    else if (type === 4) {
      const a = pointOf(o, 'keyOriginLineStart');
      const b = pointOf(o, 'keyOriginLineEnd');
      if (a && b) {
        const weight = descNumber(o, 'keyOriginLineWeight') ?? 1;
        const line: LiveShape = { kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, weight, ...tt };
        const head = () => {
          const w = ((descNumber(o, 'keyOriginLineArrWdth') ?? 500) / 100) * weight;
          const l = ((descNumber(o, 'keyOriginLineArrLngth') ?? 1000) / 100) * weight;
          const c = (descNumber(o, 'keyOriginLineArrConc') ?? 0) / 100;
          return c ? { width: w, length: l, concavity: Math.max(-0.5, Math.min(0.5, c)) } : { width: w, length: l };
        };
        if (descBool(o, 'keyOriginLineArrowSt') === true) line.startArrow = head();
        if (descBool(o, 'keyOriginLineArrowEnd') === true) line.endArrow = head();
        live = line;
      }
    }
    if (live) out.set(index, live);
  });
  return out;
}

/** A `vogk` block for the components' live shapes (polygons and stars are not written), or `null`. */
export function vogkBytes(components: readonly ShapeComponent[], dpi: number): Uint8Array | null {
  const bbox = (r: { x: number; y: number; width: number; height: number }) =>
    obj(
      descriptor('unitRect', [
        ['unitValueQuadVersion', long(1)],
        ['Top ', unit('#Pxl', r.y)],
        ['Left', unit('#Pxl', r.x)],
        ['Btom', unit('#Pxl', r.y + r.height)],
        ['Rght', unit('#Pxl', r.x + r.width)],
      ])
    );
  const items: DescValue[] = [];
  components.forEach((c, index) => {
    const live = c.live;
    if (!live || live.kind === 'polygon' || live.kind === 'star') return;
    const base = (type: number): Array<[string, DescValue]> => [
      ['keyOriginType', long(type)],
      ['keyOriginResolution', dbl(dpi)],
    ];
    let o: Array<[string, DescValue]>;
    if (live.kind === 'rect') {
      const radii = live.radii ?? [0, 0, 0, 0];
      if (radii.every((v) => v === 0)) o = [...base(1), ['keyOriginShapeBBox', bbox(live)]];
      else
        o = [
          ...base(2),
          [
            'keyOriginRRectRadii',
            obj(
              descriptor('radii', [
                ['unitValueQuadVersion', long(1)],
                ['topRight', unit('#Pxl', radii[1])],
                ['topLeft', unit('#Pxl', radii[0])],
                ['bottomLeft', unit('#Pxl', radii[3])],
                ['bottomRight', unit('#Pxl', radii[2])],
              ])
            ),
          ],
          ['keyOriginShapeBBox', bbox(live)],
        ];
    } else if (live.kind === 'ellipse') o = [...base(5), ['keyOriginShapeBBox', bbox(live)]];
    else {
      const pnt = (x: number, y: number) => obj(descriptor('Pnt ', [['Hrzn', dbl(x)], ['Vrtc', dbl(y)]]));
      const head = live.endArrow ?? live.startArrow;
      const w = live.weight || 1;
      o = [
        ...base(4),
        ['keyOriginShapeBBox', bbox({ x: Math.min(live.x1, live.x2), y: Math.min(live.y1, live.y2), width: Math.abs(live.x2 - live.x1), height: Math.abs(live.y2 - live.y1) })],
        ['keyOriginLineEnd', pnt(live.x2, live.y2)],
        ['keyOriginLineStart', pnt(live.x1, live.y1)],
        ['keyOriginLineWeight', dbl(live.weight)],
        ['keyOriginLineArrowSt', boolV(Boolean(live.startArrow))],
        ['keyOriginLineArrowEnd', boolV(Boolean(live.endArrow))],
        ['keyOriginLineArrWdth', dbl(head ? (head.width / w) * 100 : 0)],
        ['keyOriginLineArrLngth', dbl(head ? (head.length / w) * 100 : 0)],
        ['keyOriginLineArrConc', long(head?.concavity ? head.concavity * 100 : 0)],
      ];
    }
    const m = live.transform;
    if (m) {
      o.push([
        'Trnf',
        obj(
          descriptor('Trnf', [
            ['xx', dbl(m[0])],
            ['xy', dbl(m[1])],
            ['yx', dbl(m[2])],
            ['yy', dbl(m[3])],
            ['tx', dbl(m[4])],
            ['ty', dbl(m[5])],
          ])
        ),
      ]);
    }
    o.push(['keyOriginIndex', long(index)]);
    items.push(obj(descriptor('null', o)));
  });
  if (!items.length) return null;
  const body = versionedDescriptorBytes(descriptor('null', [['keyDescriptorList', { type: 'VlLs', items }]]));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, 1);
  out.set(body, 4);
  return out;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** What a shape layer looks like, for deciding whether blocks read from a file still describe it. */
export function shapeSignature(layer: Pick<ShapeLayer, 'components' | 'fill' | 'stroke' | 'fillRule' | 'inverted'>): string {
  return JSON.stringify([layer.components, layer.fill, layer.stroke, layer.fillRule ?? 'nonzero', Boolean(layer.inverted)]);
}

export interface PsdShapeData {
  components: ShapeComponent[];
  inverted: boolean;
  fill: ShapePaint | null;
  stroke: ShapeStroke | null;
}

/**
 * A shape from a layer's blocks, or `null` when it has no readable path. Live shapes from `vogk`
 * are attached to their components (the path keeps Photoshop's exact geometry). `notes` collects
 * what is approximated.
 */
export function shapeFromBlocks(blocks: ReadonlyArray<{ key: string; data: Uint8Array }>, width: number, height: number, dpi: number, notes: Set<string>): PsdShapeData | null {
  const block = (k: string) => blocks.find((b) => b.key === k)?.data;
  const vector = block('vsms') ?? block('vmsk');
  const path = vector ? componentsFromVectorBlock(vector, width, height) : null;
  if (!path) return null;
  let fill: ShapePaint | null = null;
  const vscg = block('vscg');
  if (vscg) fill = paintFromVscg(vscg, notes);
  for (const key of ['SoCo', 'GdFl', 'PtFl']) {
    if (fill) break;
    const data = block(key);
    const d = data && (() => {
      try {
        return parseVersionedDescriptor(data);
      } catch {
        return null;
      }
    })();
    if (d) fill = paintFromContent(key, d, notes);
  }
  let stroke: ShapeStroke | null = null;
  const vstk = block('vstk');
  if (vstk) {
    const s = strokeFromVstk(vstk, dpi, notes);
    if (s) {
      stroke = s.stroke;
      if (!s.fillEnabled) fill = null;
    }
  }
  const vogk = block('vogk');
  const live = vogk ? liveShapesFromVogk(vogk) : new Map<number, LiveShape>();
  const components = path.components.map((c, i) => {
    const l = live.get(i);
    // A live shape the path no longer matches in size (edited by hand) is dropped.
    return l && sameExtent(liveShapeSubpaths(l), c) ? { ...c, live: l } : c;
  });
  return { components, inverted: path.inverted, fill, stroke };
}

function sameExtent(sub: ReturnType<typeof liveShapeSubpaths>, c: ShapeComponent): boolean {
  const ext = (list: ReturnType<typeof liveShapeSubpaths>) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const sp of list) for (const a of sp.anchors) {
      x0 = Math.min(x0, a.x);
      y0 = Math.min(y0, a.y);
      x1 = Math.max(x1, a.x);
      y1 = Math.max(y1, a.y);
    }
    return [x0, y0, x1, y1];
  };
  const a = ext(sub);
  const b = ext(c.subpaths);
  return a.every((v, i) => Math.abs(v - b[i]) < 1);
}

/** The PSD blocks of a shape layer: the blocks read while unchanged, else new ones (plus notes on losses). */
export function shapeBlocks(layer: ShapeLayer, width: number, height: number, dpi: number, notes: Set<string>): Array<{ key: string; data: Uint8Array }> {
  const kept = layer.psd?.blocks;
  if (kept?.length && layer.psd?.signature === shapeSignature(layer)) return kept.map((b) => ({ key: b.key, data: b.data }));
  const out: Array<{ key: string; data: Uint8Array }> = [];
  out.push({ key: 'vsms', data: vectorBlockForComponents(layer.components, Boolean(layer.inverted), width, height) });
  if (layer.fillRule === 'evenodd' && layer.components.some((c) => c.subpaths.length > 1)) notes.add('Even-odd fill rules were written as nonzero (Photoshop fills shapes nonzero)');
  const fill = layer.fill ?? { type: 'color' as const, color: '#000000' };
  if (layer.fill?.opacity !== undefined && layer.fill.opacity < 1) notes.add('Shape fill opacity has no PSD equivalent and was written as 100 % (use the layer fill opacity)');
  out.push({ key: 'vscg', data: vscgBytes(fill) });
  if (layer.stroke || !layer.fill) out.push({ key: 'vstk', data: vstkBytes(layer.stroke, Boolean(layer.fill), dpi) });
  const vogk = vogkBytes(layer.components, dpi);
  if (vogk) out.push({ key: 'vogk', data: vogk });
  if (layer.components.some((c) => c.live?.kind === 'line' && ((c.live.startArrow && c.live.endArrow && JSON.stringify(c.live.startArrow) !== JSON.stringify(c.live.endArrow)) || false))) {
    notes.add('Lines with different start and end arrowheads were written with one arrowhead size (Photoshop has one)');
  }
  return out;
}
