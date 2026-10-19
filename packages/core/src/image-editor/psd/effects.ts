// Portions ported from photocraft-main/crates/io/src/effects_map.rs and blocks.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Layer effects ↔ PSD: the object-based effects descriptor (`lfx2`, `lfxs` on groups, `lmfx` with
 * several instances per kind) both ways, and the legacy `lrFX` block on read. Key names follow the
 * descriptors Photoshop writes (documented by reverse-engineering in psd-tools and ag-psd, MIT).
 *
 * Reading reports what it could not represent exactly (`notes`), so import warns only for that.
 */

import type { BlendMode } from '../blend';
import {
  defaultLayerEffect,
  effectColorHex,
  effectsScale,
  scaleLayerEffect,
  newEffectId,
  parseEffectColor,
  type ContourPoint,
  type EffectContour,
  type EffectFill,
  type EffectGradient,
  type GradientStyle,
  type LayerEffect,
  type LayerEffectKind,
  type LayerEffects,
} from '../../raster/effects/model';
import { PsdReader, PsdWriter } from './binary';
import { descBool, descGet, descNumber, descObject, descriptor, parseVersionedDescriptor, versionedDescriptorBytes, type DescValue, type Descriptor } from './descriptor';
import { decodePsdColor } from './adjust';
import { PSD_BLEND_KEYS } from './import';

/** Descriptor blend ids (four-character codes) → our modes. */
const BLEND_CODES: Array<[BlendMode, string]> = [
  ['normal', 'Nrml'],
  ['darken', 'Drkn'],
  ['multiply', 'Mltp'],
  ['color-burn', 'CBrn'],
  ['linear-burn', 'linearBurn'],
  ['darker-color', 'darkerColor'],
  ['lighten', 'Lghn'],
  ['screen', 'Scrn'],
  ['color-dodge', 'CDdg'],
  ['linear-dodge', 'linearDodge'],
  ['lighter-color', 'lighterColor'],
  ['overlay', 'Ovrl'],
  ['soft-light', 'SftL'],
  ['hard-light', 'HrdL'],
  ['vivid-light', 'vividLight'],
  ['linear-light', 'linearLight'],
  ['pin-light', 'pinLight'],
  ['hard-mix', 'hardMix'],
  ['difference', 'Dfrn'],
  ['exclusion', 'Xclu'],
  ['subtract', 'blendSubtraction'],
  ['divide', 'blendDivide'],
  ['hue', 'H   '],
  ['saturation', 'Strt'],
  ['color', 'Clr '],
  ['luminosity', 'Lmns'],
];

/** Long string ids some writers use instead of the four-character codes. */
const BLEND_LONG: Array<[BlendMode, string]> = [
  ['normal', 'normal'],
  ['darken', 'darken'],
  ['multiply', 'multiply'],
  ['color-burn', 'colorBurn'],
  ['lighten', 'lighten'],
  ['screen', 'screen'],
  ['color-dodge', 'colorDodge'],
  ['overlay', 'overlay'],
  ['soft-light', 'softLight'],
  ['hard-light', 'hardLight'],
  ['difference', 'difference'],
  ['exclusion', 'exclusion'],
  ['hue', 'hue'],
  ['saturation', 'saturation'],
  ['color', 'color'],
  ['luminosity', 'luminosity'],
];

const BLEND_OF = new Map<string, BlendMode>([...BLEND_CODES, ...BLEND_LONG].map(([m, id]) => [id, m]));
const BLEND_ID = new Map<BlendMode, string>(BLEND_CODES);

/** A descriptor blend id (`Mltp`, or a long id like `linearBurn`) as our blend mode, or `undefined`. */
export function blendFromPsdId(id: string): BlendMode | undefined {
  return BLEND_OF.get(id);
}

/** Our blend mode as the descriptor's four-character id (`Nrml` for modes without one). */
export function psdBlendId(mode: BlendMode): string {
  return BLEND_ID.get(mode) ?? 'Nrml';
}

/** What reading met that our model cannot hold exactly (one short phrase each). */
type Notes = Set<string>;

// ---------------------------------------------------------------------------
// Descriptor helpers
// ---------------------------------------------------------------------------

const num = (d: Descriptor, key: string, fallback: number) => descNumber(d, key) ?? fallback;
const pct = (d: Descriptor, key: string, fallback: number) => num(d, key, fallback * 100) / 100;
const bool = (d: Descriptor, key: string) => descBool(d, key) === true;
const enumOf = (d: Descriptor, key: string): string | undefined => {
  const v = descGet(d, key);
  return v?.type === 'enum' ? v.value : undefined;
};
const text = (d: Descriptor | undefined, key: string): string => {
  const v = d ? descGet(d, key) : undefined;
  return v?.type === 'TEXT' ? v.value : '';
};
const list = (d: Descriptor, key: string): Descriptor[] => {
  const v = descGet(d, key);
  if (v?.type !== 'VlLs') return [];
  return v.items.flatMap((it) => (it.type === 'Objc' || it.type === 'GlbO' ? [it.value] : []));
};
const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

const unit = (u: string, value: number): DescValue => ({ type: 'UntF', unit: u, value });
const dbl = (value: number): DescValue => ({ type: 'doub', value });
const long = (value: number): DescValue => ({ type: 'long', value: Math.round(value) });
const boolV = (value: boolean): DescValue => ({ type: 'bool', value });
const enumV = (typeId: string, value: string): DescValue => ({ type: 'enum', typeId, value });
const textV = (value: string): DescValue => ({ type: 'TEXT', value });
const obj = (d: Descriptor): DescValue => ({ type: 'Objc', value: d });

function blendOf(d: Descriptor, key: string, fallback: BlendMode, notes: Notes): BlendMode {
  const id = enumOf(d, key);
  if (id === undefined) return fallback;
  const m = BLEND_OF.get(id);
  if (m) return m;
  notes.add(id === 'Dslv' || id === 'dissolve' ? 'Dissolve became Normal' : `an unknown blend mode "${id}" became Normal`);
  return 'normal';
}

/** A descriptor colour (RGB, HSB, CMYK, Lab, grayscale, or 0..1 floats) as `#rrggbb`. */
export function colorOf(d: Descriptor | undefined, fallback = '#000000'): string {
  if (!d) return fallback;
  const g = (k: string) => descNumber(d, k);
  if (g('redFloat') !== undefined) return effectColorHex([g('redFloat')!, g('greenFloat') ?? 0, g('blueFloat') ?? 0]);
  switch (d.classId) {
    case 'HSBC': {
      const rgb = decodePsdColor(1, [((g('H   ') ?? 0) / 360) * 65535, ((g('Strt') ?? 0) / 100) * 65535, ((g('Brgh') ?? 0) / 100) * 65535]);
      return rgb ? effectColorHex(rgb) : fallback;
    }
    case 'CMYC': {
      const inv = (k: string) => (1 - (g(k) ?? 0) / 100) * 65535;
      const rgb = decodePsdColor(2, [inv('Cyn '), inv('Mgnt'), inv('Ylw '), inv('Blck')]);
      return rgb ? effectColorHex(rgb) : fallback;
    }
    case 'LbCl': {
      const rgb = decodePsdColor(7, [(g('Lmnc') ?? 0) * 100, Math.round((g('A   ') ?? 0) * 100) & 0xffff, Math.round((g('B   ') ?? 0) * 100) & 0xffff]);
      return rgb ? effectColorHex(rgb) : fallback;
    }
    case 'Grsc': {
      const v = 1 - (g('Gry ') ?? 0) / 100;
      return effectColorHex([v, v, v]);
    }
  }
  const r = g('Rd  ');
  const gr = g('Grn ');
  const b = g('Bl  ');
  if (r === undefined || gr === undefined || b === undefined) return fallback;
  return effectColorHex([r / 255, gr / 255, b / 255]);
}

export function colorDesc(hex: string): Descriptor {
  const [r, g, b] = parseEffectColor(hex) ?? [0, 0, 0];
  return descriptor('RGBC', [
    ['Rd  ', dbl(r * 255)],
    ['Grn ', dbl(g * 255)],
    ['Bl  ', dbl(b * 255)],
  ]);
}

function contourOf(d: Descriptor, key: string): EffectContour | undefined {
  const c = descObject(d, key);
  if (!c) return undefined;
  const name = text(c, 'Nm  ');
  const points: ContourPoint[] = list(c, 'Crv ').map((p) => {
    const out: ContourPoint = { input: clamp(num(p, 'Hrzn', 0) / 255, 0, 1), output: clamp(num(p, 'Vrtc', 0) / 255, 0, 1) };
    // `Cnty` (continuity) false marks a corner; absent means smooth.
    if (descBool(p, 'Cnty') === false) out.corner = true;
    return out;
  });
  const linear = points.length === 2 && points[0].input === 0 && points[0].output === 0 && points[1].input === 1 && points[1].output === 1 && !points.some((p) => p.corner);
  if (points.length < 2 || (linear && (!name || name === 'Linear'))) return undefined;
  return { name, points };
}

function contourDesc(c: EffectContour | undefined): DescValue {
  const name = c?.name ?? 'Linear';
  const points = c?.points ?? [
    { input: 0, output: 0 },
    { input: 1, output: 1 },
  ];
  const pts: DescValue = {
    type: 'VlLs',
    items: points.map((p) => {
      const items: Array<[string, DescValue]> = [
        ['Hrzn', dbl(p.input * 255)],
        ['Vrtc', dbl(p.output * 255)],
      ];
      if (p.corner) items.push(['Cnty', boolV(false)]);
      return obj(descriptor('CrPt', items));
    }),
  };
  return obj(
    descriptor('ShpC', [
      ['Nm  ', textV(name)],
      ['Crv ', pts],
    ])
  );
}

const GRADIENT_STYLES: Array<[GradientStyle, string]> = [
  ['linear', 'Lnr '],
  ['radial', 'Rdl '],
  ['angle', 'Angl'],
  ['reflected', 'Rflc'],
  ['diamond', 'Dmnd'],
];

/** A `Grad` descriptor's stops: midpoints become an extra stop each; smoothness is drawn linearly. */
export function gradientOf(d: Descriptor, notes: Notes): EffectGradient {
  const g: EffectGradient = {
    stops: [
      { position: 0, color: '#000000' },
      { position: 1, color: '#ffffff' },
    ],
    style: (GRADIENT_STYLES.find(([, id]) => id === enumOf(d, 'Type'))?.[0] ?? 'linear') as GradientStyle,
    angle: clamp(num(d, 'Angl', 90), -360, 360),
    scale: clamp(pct(d, 'Scl ', 1), 0.1, 1.5),
    reverse: bool(d, 'Rvrs'),
    align: descBool(d, 'Algn') !== false,
    offset: { x: 0, y: 0 },
  };
  const off = descObject(d, 'Ofst');
  if (off) g.offset = { x: clamp(pct(off, 'Hrzn', 0), -1, 1), y: clamp(pct(off, 'Vrtc', 0), -1, 1) };
  const grad = descObject(d, 'Grad');
  if (!grad) return g;
  if (enumOf(grad, 'GrdF') === 'ClNs') {
    notes.add('noise gradients became black to white');
    return g;
  }
  const raw = list(grad, 'Clrs')
    .map((s) => {
      const type = enumOf(s, 'Type');
      if (type === 'FrgC' || type === 'BckC') notes.add('foreground / background gradient stops became black / white');
      const color = type === 'BckC' ? '#ffffff' : colorOf(descObject(s, 'Clr '));
      return { position: clamp(num(s, 'Lctn', 0) / 4096, 0, 1), color, mid: clamp(num(s, 'Mdpn', 50) / 100, 0.05, 0.95) };
    })
    .sort((a, b) => a.position - b.position);
  if (raw.length) {
    const stops: EffectGradient['stops'] = [];
    raw.forEach((s, i) => {
      // A midpoint (stored on the stop that ends its segment) becomes an even mix at that point.
      if (i > 0 && Math.abs(s.mid - 0.5) > 1e-3) {
        const a = raw[i - 1];
        const ca = parseEffectColor(a.color)!;
        const cb = parseEffectColor(s.color)!;
        stops.push({ position: a.position + (s.position - a.position) * s.mid, color: effectColorHex(ca.map((v, k) => (v + cb[k]) / 2)) });
        notes.add('gradient midpoints are drawn as straight segments');
      }
      stops.push({ position: s.position, color: s.color });
    });
    g.stops = stops;
  }
  const opacity = list(grad, 'Trns')
    .map((s) => ({ position: clamp(num(s, 'Lctn', 0) / 4096, 0, 1), opacity: clamp(num(s, 'Opct', 100) / 100, 0, 1) }))
    .sort((a, b) => a.position - b.position);
  if (opacity.some((o) => o.opacity < 1)) g.opacityStops = opacity;
  if (num(grad, 'Intr', 0) > 0) notes.add('gradient smoothness is drawn as straight segments');
  return g;
}

export function gradientItems(g: EffectGradient): Array<[string, DescValue]> {
  const clrs: DescValue = {
    type: 'VlLs',
    items: g.stops.map((s) =>
      obj(
        descriptor('Clrt', [
          ['Clr ', obj(colorDesc(s.color))],
          ['Type', enumV('Clry', 'UsrS')],
          ['Lctn', long(s.position * 4096)],
          ['Mdpn', long(50)],
        ])
      )
    ),
  };
  const op = g.opacityStops?.length ? g.opacityStops : g.stops.map((s) => ({ position: s.position, opacity: 1 }));
  const trns: DescValue = {
    type: 'VlLs',
    items: op.map((s) =>
      obj(
        descriptor('TrnS', [
          ['Opct', unit('#Prc', s.opacity * 100)],
          ['Lctn', long(s.position * 4096)],
          ['Mdpn', long(50)],
        ])
      )
    ),
  };
  const grad = descriptor('Grdn', [
    ['Nm  ', textV('Custom')],
    ['GrdF', enumV('GrdF', 'CstS')],
    ['Intr', dbl(0)],
    ['Clrs', clrs],
    ['Trns', trns],
  ]);
  return [
    ['Grad', obj(grad)],
    ['Angl', unit('#Ang', g.angle)],
    ['Type', enumV('GrdT', GRADIENT_STYLES.find(([s]) => s === g.style)![1])],
    ['Rvrs', boolV(g.reverse)],
    ['Algn', boolV(g.align)],
    ['Scl ', unit('#Prc', g.scale * 100)],
    [
      'Ofst',
      obj(
        descriptor('Pnt ', [
          ['Hrzn', unit('#Prc', g.offset.x * 100)],
          ['Vrtc', unit('#Prc', g.offset.y * 100)],
        ])
      ),
    ],
  ];
}

export function patternRefOf(d: Descriptor): { patternId: string; name: string } {
  const p = descObject(d, 'Ptrn');
  return { patternId: text(p, 'Idnt') || text(p, 'Nm  '), name: text(p, 'Nm  ') };
}

export function patternRefDesc(patternId: string, name: string | undefined): DescValue {
  return obj(
    descriptor('Ptrn', [
      ['Nm  ', textV(name ?? patternId)],
      ['Idnt', textV(patternId)],
    ])
  );
}

export function placementOf(d: Descriptor): { angle: number; link: boolean; phase: { x: number; y: number } } {
  const phase = descObject(d, 'phase');
  return {
    angle: clamp(num(d, 'Angl', 0), -360, 360),
    link: descBool(d, 'Algn') !== false,
    phase: phase ? { x: num(phase, 'Hrzn', 0), y: num(phase, 'Vrtc', 0) } : { x: 0, y: 0 },
  };
}

export function placementItems(angle: number, link: boolean, phase: { x: number; y: number }): Array<[string, DescValue]> {
  const out: Array<[string, DescValue]> = [];
  if (angle) out.push(['Angl', unit('#Ang', angle)]);
  out.push(['Algn', boolV(link)]);
  out.push([
    'phase',
    obj(
      descriptor('Pnt ', [
        ['Hrzn', dbl(phase.x)],
        ['Vrtc', dbl(phase.y)],
      ])
    ),
  ]);
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Single-instance key and multi-instance list key per kind, in Photoshop's order. */
const KINDS: Array<[string, string, LayerEffectKind]> = [
  ['DrSh', 'dropShadowMulti', 'drop-shadow'],
  ['IrSh', 'innerShadowMulti', 'inner-shadow'],
  ['OrGl', '', 'outer-glow'],
  ['IrGl', '', 'inner-glow'],
  ['ebbl', '', 'bevel-emboss'],
  ['ChFX', '', 'satin'],
  ['SoFi', 'solidFillMulti', 'color-overlay'],
  ['GrFl', 'gradientFillMulti', 'gradient-overlay'],
  ['patternFill', '', 'pattern-overlay'],
  ['FrFX', 'frameFXMulti', 'stroke'],
];

function common(d: Descriptor, kind: LayerEffectKind, notes: Notes) {
  const def = defaultLayerEffect(kind, 'x') as { blend: BlendMode; opacity: number };
  return { id: newEffectId(), enabled: descBool(d, 'enab') !== false, blend: blendOf(d, 'Md  ', def.blend, notes), opacity: clamp(pct(d, 'Opct', def.opacity), 0, 1) };
}

function readOne(kind: LayerEffectKind, d: Descriptor, notes: Notes): LayerEffect {
  const size = (key: string, fallback: number) => clamp(num(d, key, fallback), 0, 250);
  switch (kind) {
    case 'drop-shadow':
    case 'inner-shadow': {
      const base = {
        ...common(d, kind, notes),
        color: colorOf(descObject(d, 'Clr ')),
        angle: clamp(num(d, 'lagl', 120), -360, 360),
        useGlobalLight: descBool(d, 'uglg') !== false,
        distance: clamp(num(d, 'Dstn', 5), 0, 30000),
        size: size('blur', 5),
        contour: contourOf(d, 'TrnS'),
        antiAlias: bool(d, 'AntA'),
        noise: clamp(pct(d, 'Nose', 0), 0, 1),
      };
      const spread = clamp(pct(d, 'Ckmt', 0), 0, 1);
      return kind === 'drop-shadow'
        ? { ...base, kind, spread, knocksOut: descBool(d, 'layerConceals') !== false }
        : { ...base, kind, choke: spread };
    }
    case 'outer-glow':
    case 'inner-glow': {
      const fill: EffectFill = descGet(d, 'Grad') ? { type: 'gradient', gradient: gradientOf(d, notes) } : { type: 'color', color: colorOf(descObject(d, 'Clr '), '#ffffbe') };
      const jitter = clamp(pct(d, 'ShdN', 0), 0, 1);
      if (jitter > 0) notes.add('glow jitter is not drawn');
      const base = {
        ...common(d, kind, notes),
        fill: fill as Extract<EffectFill, { type: 'color' | 'gradient' }>,
        technique: enumOf(d, 'GlwT') === 'PrBL' ? ('precise' as const) : ('softer' as const),
        size: size('blur', 5),
        contour: contourOf(d, 'TrnS'),
        antiAlias: bool(d, 'AntA'),
        range: clamp(pct(d, 'Inpr', 0.5), 0.01, 1),
        jitter,
        noise: clamp(pct(d, 'Nose', 0), 0, 1),
      };
      const spread = clamp(pct(d, 'Ckmt', 0), 0, 1);
      return kind === 'outer-glow' ? { ...base, kind, spread } : { ...base, kind, choke: spread, source: enumOf(d, 'glwS') === 'SrcC' ? 'center' : 'edge' };
    }
    case 'bevel-emboss': {
      const styles: Record<string, 'inner-bevel' | 'outer-bevel' | 'emboss' | 'pillow-emboss' | 'stroke-emboss'> = { OtrB: 'outer-bevel', InrB: 'inner-bevel', Embs: 'emboss', PlEb: 'pillow-emboss', strokeEmboss: 'stroke-emboss' };
      const out: LayerEffect = {
        id: newEffectId(),
        enabled: descBool(d, 'enab') !== false,
        kind,
        style: styles[enumOf(d, 'bvlS') ?? ''] ?? 'inner-bevel',
        technique: enumOf(d, 'bvlT') === 'PrBL' ? 'chisel-hard' : enumOf(d, 'bvlT') === 'Slmt' ? 'chisel-soft' : 'smooth',
        depth: clamp(pct(d, 'srgR', 1), 0, 10),
        direction: enumOf(d, 'bvlD') === 'Out ' ? 'down' : 'up',
        size: size('blur', 5),
        soften: clamp(num(d, 'Sftn', 0), 0, 16),
        angle: clamp(num(d, 'lagl', 120), -360, 360),
        altitude: clamp(num(d, 'Lald', 30), 0, 90),
        useGlobalLight: descBool(d, 'uglg') !== false,
        glossContour: contourOf(d, 'TrnS'),
        highlightColor: colorOf(descObject(d, 'hglC'), '#ffffff'),
        highlightBlend: blendOf(d, 'hglM', 'screen', notes),
        highlightOpacity: clamp(pct(d, 'hglO', 0.75), 0, 1),
        shadowColor: colorOf(descObject(d, 'sdwC')),
        shadowBlend: blendOf(d, 'sdwM', 'multiply', notes),
        shadowOpacity: clamp(pct(d, 'sdwO', 0.75), 0, 1),
      };
      if (bool(d, 'useShape')) out.contourElement = { contour: contourOf(d, 'MpgS') ?? { name: 'Linear', points: [{ input: 0, output: 0 }, { input: 1, output: 1 }] }, range: clamp(pct(d, 'Inpr', 0.5), 0, 1), antiAlias: bool(d, 'AntA') };
      if (bool(d, 'useTexture')) {
        const ref = patternRefOf(d);
        const place = placementOf(d);
        out.texture = { patternId: ref.patternId, name: ref.name, scale: clamp(pct(d, 'Scl ', 1), 0.01, 10), depth: clamp(pct(d, 'textureDepth', 1), -10, 10), invert: bool(d, 'InvT'), link: place.link, phase: place.phase };
      }
      return out;
    }
    case 'satin':
      return {
        ...common(d, kind, notes),
        kind,
        color: colorOf(descObject(d, 'Clr ')),
        angle: clamp(num(d, 'lagl', 19), -360, 360),
        distance: size('Dstn', 11),
        size: size('blur', 14),
        contour: contourOf(d, 'MpgS'),
        antiAlias: bool(d, 'AntA'),
        invert: bool(d, 'Invr'),
      };
    case 'color-overlay':
      return { ...common(d, kind, notes), kind, color: colorOf(descObject(d, 'Clr ')) };
    case 'gradient-overlay':
      return { ...common(d, kind, notes), kind, gradient: gradientOf(d, notes), dither: bool(d, 'Dthr') };
    case 'pattern-overlay': {
      const ref = patternRefOf(d);
      const place = placementOf(d);
      return { ...common(d, kind, notes), kind, patternId: ref.patternId, name: ref.name, scale: clamp(pct(d, 'Scl ', 1), 0.01, 10), angle: place.angle, link: place.link, phase: place.phase };
    }
    case 'stroke': {
      const paint = enumOf(d, 'PntT');
      let fill: EffectFill;
      if (paint === 'GrFl') fill = { type: 'gradient', gradient: gradientOf(d, notes) };
      else if (paint === 'Ptrn') {
        const ref = patternRefOf(d);
        fill = { type: 'pattern', patternId: ref.patternId, name: ref.name, scale: clamp(pct(d, 'Scl ', 1), 0.01, 10) };
      } else fill = { type: 'color', color: colorOf(descObject(d, 'Clr ')) };
      const pos = enumOf(d, 'Styl');
      return { ...common(d, kind, notes), kind, size: size('Sz  ', 3), position: pos === 'InsF' ? 'inside' : pos === 'CtrF' ? 'center' : 'outside', fill };
    }
  }
}

export interface ParsedLayerEffects {
  effects: LayerEffects;
  /** What could not be held exactly (empty when the mapping is exact). */
  notes: string[];
}

/**
 * Parses `lfx2` / `lfxs` / `lmfx` block data (u32 version 0, then a versioned descriptor).
 * Effects marked `present: false` are left out. Returns `null` when the data is not a descriptor.
 */
export function parseLfx2(data: Uint8Array): ParsedLayerEffects | null {
  let d: Descriptor;
  try {
    d = parseVersionedDescriptor(data.subarray(4));
  } catch {
    return null;
  }
  const notes: Notes = new Set();
  const items: LayerEffect[] = [];
  for (const [single, multi, kind] of KINDS) {
    const many = multi ? list(d, multi) : [];
    const one = descObject(d, single);
    for (const x of many.length ? many : one ? [one] : []) {
      if (descBool(x, 'present') === false) continue;
      items.push(readOne(kind, x, notes));
    }
  }
  // `Scl ` is not a live multiplier: Photoshop stores the sizes in pixels already, and the scale
  // only records the document's resolution relative to 72 ppi (208.33 % at 150 ppi).
  const effects: LayerEffects = { enabled: descBool(d, 'masterFXSwitch') !== false, items };
  return { effects, notes: [...notes] };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function commonItems(e: { enabled: boolean; blend: BlendMode; opacity: number }): Array<[string, DescValue]> {
  return [
    ['enab', boolV(e.enabled)],
    ['present', boolV(true)],
    ['showInDialog', boolV(true)],
    ['Md  ', enumV('BlnM', BLEND_ID.get(e.blend) ?? 'Nrml')],
    ['Opct', unit('#Prc', e.opacity * 100)],
  ];
}

function writeOne(e: LayerEffect): Descriptor {
  switch (e.kind) {
    case 'drop-shadow':
    case 'inner-shadow': {
      const inner = e.kind === 'inner-shadow';
      const items: Array<[string, DescValue]> = [
        ...commonItems(e),
        ['Clr ', obj(colorDesc(e.color))],
        ['uglg', boolV(e.useGlobalLight)],
        ['lagl', unit('#Ang', e.angle)],
        ['Dstn', unit('#Pxl', e.distance)],
        ['Ckmt', unit('#Pxl', (inner ? e.choke : e.spread) * 100)],
        ['blur', unit('#Pxl', e.size)],
        ['Nose', unit('#Prc', e.noise * 100)],
        ['AntA', boolV(e.antiAlias)],
        ['TrnS', contourDesc(e.contour)],
      ];
      if (e.kind === 'drop-shadow') items.push(['layerConceals', boolV(e.knocksOut)]);
      return descriptor(inner ? 'IrSh' : 'DrSh', items);
    }
    case 'outer-glow':
    case 'inner-glow': {
      const inner = e.kind === 'inner-glow';
      const items: Array<[string, DescValue]> = [...commonItems(e)];
      if (e.fill.type === 'gradient') items.push(...gradientItems(e.fill.gradient));
      else items.push(['Clr ', obj(colorDesc(e.fill.color))]);
      items.push(
        ['GlwT', enumV('BETE', e.technique === 'precise' ? 'PrBL' : 'SfBL')],
        ['Ckmt', unit('#Pxl', (inner ? e.choke : e.spread) * 100)],
        ['blur', unit('#Pxl', e.size)],
        ['Nose', unit('#Prc', e.noise * 100)],
        ['ShdN', unit('#Prc', e.jitter * 100)],
        ['AntA', boolV(e.antiAlias)],
        ['TrnS', contourDesc(e.contour)],
        ['Inpr', unit('#Prc', e.range * 100)]
      );
      if (e.kind === 'inner-glow') items.push(['glwS', enumV('IGSr', e.source === 'center' ? 'SrcC' : 'SrcE')]);
      return descriptor(inner ? 'IrGl' : 'OrGl', items);
    }
    case 'bevel-emboss': {
      const style = { 'outer-bevel': 'OtrB', 'inner-bevel': 'InrB', emboss: 'Embs', 'pillow-emboss': 'PlEb', 'stroke-emboss': 'strokeEmboss' }[e.style];
      const tech = { smooth: 'SfBL', 'chisel-hard': 'PrBL', 'chisel-soft': 'Slmt' }[e.technique];
      const items: Array<[string, DescValue]> = [
        ['enab', boolV(e.enabled)],
        ['present', boolV(true)],
        ['showInDialog', boolV(true)],
        ['hglM', enumV('BlnM', BLEND_ID.get(e.highlightBlend) ?? 'Scrn')],
        ['hglC', obj(colorDesc(e.highlightColor))],
        ['hglO', unit('#Prc', e.highlightOpacity * 100)],
        ['sdwM', enumV('BlnM', BLEND_ID.get(e.shadowBlend) ?? 'Mltp')],
        ['sdwC', obj(colorDesc(e.shadowColor))],
        ['sdwO', unit('#Prc', e.shadowOpacity * 100)],
        ['bvlT', enumV('bvlT', tech)],
        ['bvlS', enumV('BESl', style)],
        ['uglg', boolV(e.useGlobalLight)],
        ['lagl', unit('#Ang', e.angle)],
        ['Lald', unit('#Ang', e.altitude)],
        ['srgR', unit('#Prc', e.depth * 100)],
        ['blur', unit('#Pxl', e.size)],
        ['bvlD', enumV('BESs', e.direction === 'up' ? 'In  ' : 'Out ')],
        ['TrnS', contourDesc(e.glossContour)],
        ['Sftn', unit('#Pxl', e.soften)],
      ];
      if (e.contourElement) {
        items.push(['useShape', boolV(true)], ['MpgS', contourDesc(e.contourElement.contour)], ['AntA', boolV(e.contourElement.antiAlias)], ['Inpr', unit('#Prc', e.contourElement.range * 100)]);
      } else items.push(['useShape', boolV(false)]);
      if (e.texture) {
        const t = e.texture;
        items.push(
          ['useTexture', boolV(true)],
          ['InvT', boolV(t.invert)],
          ['Scl ', unit('#Prc', t.scale * 100)],
          ['textureDepth', unit('#Prc', t.depth * 100)],
          ['Ptrn', patternRefDesc(t.patternId, t.name)],
          ...placementItems(0, t.link ?? true, t.phase ?? { x: 0, y: 0 })
        );
      } else items.push(['useTexture', boolV(false)]);
      return descriptor('ebbl', items);
    }
    case 'satin':
      return descriptor('ChFX', [
        ...commonItems(e),
        ['Clr ', obj(colorDesc(e.color))],
        ['AntA', boolV(e.antiAlias)],
        ['Invr', boolV(e.invert)],
        ['lagl', unit('#Ang', e.angle)],
        ['Dstn', unit('#Pxl', e.distance)],
        ['blur', unit('#Pxl', e.size)],
        ['MpgS', contourDesc(e.contour)],
      ]);
    case 'color-overlay':
      return descriptor('SoFi', [...commonItems(e), ['Clr ', obj(colorDesc(e.color))]]);
    case 'gradient-overlay':
      return descriptor('GrFl', [...commonItems(e), ...gradientItems(e.gradient), ['Dthr', boolV(e.dither)]]);
    case 'pattern-overlay':
      return descriptor('patternFill', [
        ...commonItems(e),
        ['Ptrn', patternRefDesc(e.patternId, e.name)],
        ['Scl ', unit('#Prc', e.scale * 100)],
        ...placementItems(e.angle ?? 0, e.link ?? true, e.phase ?? { x: 0, y: 0 }),
      ]);
    case 'stroke': {
      const items: Array<[string, DescValue]> = [
        ...commonItems(e),
        ['Styl', enumV('FStl', e.position === 'inside' ? 'InsF' : e.position === 'center' ? 'CtrF' : 'OutF')],
        ['Sz  ', unit('#Pxl', e.size)],
      ];
      const f = e.fill;
      if (f.type === 'color') items.push(['PntT', enumV('FrFl', 'SClr')], ['Clr ', obj(colorDesc(f.color))]);
      else if (f.type === 'gradient') items.push(['PntT', enumV('FrFl', 'GrFl')], ...gradientItems(f.gradient));
      else items.push(['PntT', enumV('FrFl', 'Ptrn')], ['Ptrn', patternRefDesc(f.patternId, f.name)], ['Scl ', unit('#Prc', f.scale * 100)]);
      return descriptor('FrFX', items);
    }
  }
}

/**
 * Writes effects as `lfx2` block data, Scale Effects baked into the sizes (Photoshop's `Scl ` is
 * written as 100 %). Several instances of one kind go into its multi key
 * (`dropShadowMulti`, `frameFXMulti` …); kinds without one keep only the first instance.
 * Returns the data and how many instances had to be left out.
 */
export function writeLfx2(effects: LayerEffects): { data: Uint8Array; dropped: number } {
  const items: Array<[string, DescValue]> = [
    ['Scl ', unit('#Prc', 100)],
    ['masterFXSwitch', boolV(effects.enabled)],
  ];
  // Scale Effects is baked into the sizes: Photoshop reads them as pixels.
  const scale = effectsScale(effects);
  let dropped = 0;
  for (const [single, multi, kind] of KINDS) {
    const of = effects.items.filter((e) => e.kind === kind).map((e) => writeOne(scaleLayerEffect(e, scale)));
    if (!of.length) continue;
    if (of.length === 1) items.push([single, obj(of[0])]);
    else if (multi) items.push([multi, { type: 'VlLs', items: of.map(obj) }]);
    else {
      items.push([single, obj(of[0])]);
      dropped += of.length - 1;
    }
  }
  const body = versionedDescriptorBytes(descriptor('null', items));
  const w = new PsdWriter();
  w.u32(0);
  w.bytes(body);
  // Layer blocks keep their pad byte inside the length, as Photoshop writes them.
  if (w.length % 2) w.u8(0);
  return { data: w.result(), dropped };
}

// ---------------------------------------------------------------------------
// Legacy effects (`lrFX`, Photoshop 5)
// ---------------------------------------------------------------------------

/** Parses legacy `lrFX` effects: drop / inner shadows, outer / inner glows and solid fill. Bevels are skipped. */
export function parseLrfx(data: Uint8Array): ParsedLayerEffects | null {
  try {
    const r = new PsdReader(data);
    r.u16();
    const count = r.u16();
    const items: LayerEffect[] = [];
    const notes: Notes = new Set();
    const fixed = (v: number) => (v | 0) / 65536;
    for (let i = 0; i < count; i++) {
      if (new TextDecoder().decode(r.bytes(4)) !== '8BIM') return null;
      const key = new TextDecoder().decode(r.bytes(4));
      const size = r.u32();
      const b = new PsdReader(r.bytes(size));
      const colorAt = (rd: PsdReader) => {
        rd.u16();
        const c = [rd.u16(), rd.u16(), rd.u16(), rd.u16()];
        return effectColorHex([c[0] >> 8, c[1] >> 8, c[2] >> 8].map((v) => v / 255));
      };
      const blendAt = (rd: PsdReader) => {
        rd.skip(4);
        const k = new TextDecoder().decode(rd.bytes(4));
        const m = PSD_BLEND_KEYS[k];
        return (m && m !== 'pass-through' ? m : 'normal') as BlendMode;
      };
      if (key === 'dsdw' || key === 'isdw') {
        b.u32();
        const blur = fixed(b.u32());
        b.u32();
        const angle = fixed(b.u32());
        const distance = fixed(b.u32());
        const color = colorAt(b);
        const blend = blendAt(b);
        const enabled = b.u8() !== 0;
        const useGlobalLight = b.u8() !== 0;
        const opacity = b.u8() / 255;
        const base = { id: newEffectId(), enabled, blend, opacity, color, angle, useGlobalLight, distance: clamp(distance, 0, 30000), size: clamp(blur, 0, 250), antiAlias: false, noise: 0 };
        items.push(key === 'dsdw' ? { ...base, kind: 'drop-shadow', spread: 0, knocksOut: true } : { ...base, kind: 'inner-shadow', choke: 0 });
      } else if (key === 'oglw' || key === 'iglw') {
        b.u32();
        const blur = fixed(b.u32());
        b.u32();
        const color = colorAt(b);
        const blend = blendAt(b);
        const enabled = b.u8() !== 0;
        const opacity = b.u8() / 255;
        const base = { id: newEffectId(), enabled, blend, opacity, fill: { type: 'color' as const, color }, technique: 'softer' as const, size: clamp(blur, 0, 250), antiAlias: false, range: 0.5, jitter: 0, noise: 0 };
        items.push(key === 'oglw' ? { ...base, kind: 'outer-glow', spread: 0 } : { ...base, kind: 'inner-glow', choke: 0, source: 'edge' });
      } else if (key === 'sofi') {
        b.u32();
        const blend = blendAt(b);
        const color = colorAt(b);
        const opacity = b.u8() / 255;
        const enabled = b.u8() !== 0;
        items.push({ id: newEffectId(), kind: 'color-overlay', enabled, blend, opacity, color });
      } else if (key === 'bevl') notes.add('legacy bevels are not read');
    }
    return { effects: { enabled: true, items }, notes: [...notes] };
  } catch {
    return null;
  }
}
