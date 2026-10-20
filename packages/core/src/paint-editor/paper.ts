/**
 * Paper: a generated grain height map (0 = valley, 1 = peak) that tiles across the canvas, a paper
 * colour, grain depth, and the three properties wet media will read later (absorption,
 * permeability, roughness). Dry media catch the peaks: a light stroke only marks the high grain, a
 * firm one fills the valleys too. Everything is generated from a pattern and a seed, so a paper is
 * a few numbers in the document, never a bitmap, and no third-party texture is bundled.
 */

import { GRAIN_PATTERNS, PaperGrain, type GrainPattern, type GrainTuning, type PaperTiling } from '../paint/grain';

export { GRAIN_PATTERNS, GRAIN_TILE, grainCatch, grainHeights, PaperGrain, type GrainPattern, type GrainTuning, type PaperGrainSettings, type PaperTiling } from '../paint/grain';

/** Paper families, as a library groups them. */
export type PaperFamily = 'watercolor' | 'drawing' | 'pastel' | 'canvas' | 'panel' | 'smooth';

export const PAPER_FAMILIES: readonly PaperFamily[] = ['watercolor', 'drawing', 'pastel', 'canvas', 'panel', 'smooth'];

export interface PaperSettings {
  /** The library preset this paper started from (`custom` when it matches none). */
  preset: string;
  name: string;
  family: PaperFamily;
  pattern: GrainPattern;
  /** Grain seed: another seed gives another sheet of the same paper. */
  seed: number;
  /** Paper colour #rrggbb. */
  color: string;
  /** Grain scale: 1 is the pattern's natural size, 2 twice as coarse (0.25..8). */
  scale: number;
  /** How the grain tile repeats: `repeat` or `mirror` (alternate tiles flipped, so seams vanish). */
  tiling: PaperTiling;
  /** Grain depth 0..1: how much grain-responsive dry media skip the valleys (0: none). */
  depth: number;
  /** How much the grain shades the paper colour on screen and in exports, 0..1. */
  shading: number;
  /** The height map as dry media read it. */
  dry: GrainTuning;
  /** The height map as wet media will read it (stored now; wet media is a later phase). */
  wet: GrainTuning;
  /** Wet media: how fast the paper takes up water, 0..1. */
  absorption: number;
  /** Wet media: how far water spreads inside the paper, 0..1. */
  permeability: number;
  /** Wet media: how much the grain catches pigment, 0..1. */
  roughness: number;
  /** Metallic paper (gold or silver leaf, pearlescent card): the grain catches the light, 0..1 (default 0). */
  metallic?: number;
}

const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const clampNum = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const HEX = /^#[0-9a-f]{6}$/i;

type PaperPreset = PaperSettings;

const tuning = (contrast = 1, invert = false): GrainTuning => ({ contrast, invert });

function preset(
  id: string,
  name: string,
  family: PaperFamily,
  pattern: GrainPattern,
  color: string,
  o: { depth: number; absorption: number; permeability: number; roughness: number; scale?: number; seed?: number; shading?: number; contrast?: number }
): PaperPreset {
  return {
    preset: id,
    name,
    family,
    pattern,
    seed: o.seed ?? 1,
    color,
    scale: o.scale ?? 1,
    tiling: 'mirror',
    depth: o.depth,
    shading: o.shading ?? 0.5,
    dry: tuning(o.contrast ?? 1),
    wet: tuning(1),
    absorption: o.absorption,
    permeability: o.permeability,
    roughness: o.roughness,
  };
}

/** The built-in paper library: generated papers in families. */
export const PAPER_LIBRARY: readonly PaperPreset[] = [
  preset('cold-pressed', 'Cold pressed watercolour', 'watercolor', 'cold-pressed', '#f7f3ea', { depth: 0.5, absorption: 0.7, permeability: 0.5, roughness: 0.6 }),
  preset('hot-pressed', 'Hot pressed watercolour', 'watercolor', 'hot-pressed', '#f8f6ef', { depth: 0.25, absorption: 0.55, permeability: 0.4, roughness: 0.25 }),
  preset('rough-watercolor', 'Rough watercolour', 'watercolor', 'rough', '#f5f0e4', { depth: 0.75, absorption: 0.8, permeability: 0.6, roughness: 0.85 }),
  preset('cartridge', 'Cartridge', 'drawing', 'vellum', '#fbfaf6', { depth: 0.3, absorption: 0.4, permeability: 0.3, roughness: 0.35 }),
  preset('laid', 'Laid paper', 'drawing', 'laid', '#f3ecdc', { depth: 0.45, absorption: 0.45, permeability: 0.35, roughness: 0.45 }),
  preset('ingres', 'Charcoal paper', 'drawing', 'ingres', '#ede6d6', { depth: 0.6, absorption: 0.4, permeability: 0.3, roughness: 0.65 }),
  preset('sanded-pastel', 'Sanded pastel paper', 'pastel', 'sanded', '#d8cfc0', { depth: 0.7, absorption: 0.3, permeability: 0.2, roughness: 0.9, shading: 0.35 }),
  preset('pastel-card', 'Grey pastel card', 'pastel', 'sanded', '#9c978e', { depth: 0.55, absorption: 0.3, permeability: 0.2, roughness: 0.75, scale: 1.5, shading: 0.3 }),
  preset('cotton-canvas', 'Cotton canvas', 'canvas', 'canvas', '#efe9dc', { depth: 0.55, absorption: 0.35, permeability: 0.25, roughness: 0.6 }),
  preset('fine-linen', 'Fine linen', 'canvas', 'linen', '#e9e2d2', { depth: 0.45, absorption: 0.3, permeability: 0.25, roughness: 0.5 }),
  preset('gesso', 'Gesso panel', 'panel', 'gesso', '#f6f4ef', { depth: 0.35, absorption: 0.2, permeability: 0.15, roughness: 0.4 }),
  preset('smooth', 'Smooth bristol', 'smooth', 'smooth', '#ffffff', { depth: 0, absorption: 0.3, permeability: 0.2, roughness: 0.05, shading: 0 }),
];

export const DEFAULT_PAPER: Readonly<PaperSettings> = PAPER_LIBRARY[0];

/** A paper from the library by id, or `undefined`. */
export function paperPreset(id: string): PaperSettings | undefined {
  const p = PAPER_LIBRARY.find((x) => x.preset === id);
  return p ? clonePaper(p) : undefined;
}

export function clonePaper(p: PaperSettings): PaperSettings {
  return { ...p, dry: { ...p.dry }, wet: { ...p.wet } };
}

function readTuning(raw: unknown, d: GrainTuning): GrainTuning {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { contrast: clampNum(r.contrast, 0, 3, d.contrast), invert: typeof r.invert === 'boolean' ? r.invert : d.invert };
}

/**
 * A paper with every field in range. Missing fields come from `base` (default: the library preset
 * named by `raw.preset`, else cold pressed).
 */
export function normalizePaper(raw: Partial<PaperSettings> | Record<string, unknown> = {}, base?: PaperSettings): PaperSettings {
  const r = raw as Record<string, unknown>;
  const b = base ?? (typeof r.preset === 'string' ? paperPreset(r.preset) : undefined) ?? clonePaper(DEFAULT_PAPER);
  return {
    preset: typeof r.preset === 'string' && r.preset ? r.preset : b.preset,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : b.name,
    family: PAPER_FAMILIES.includes(r.family as PaperFamily) ? (r.family as PaperFamily) : b.family,
    pattern: GRAIN_PATTERNS.includes(r.pattern as GrainPattern) ? (r.pattern as GrainPattern) : b.pattern,
    seed: typeof r.seed === 'number' && Number.isFinite(r.seed) ? Math.round(Math.abs(r.seed)) % 2147483647 : b.seed,
    color: typeof r.color === 'string' && HEX.test(r.color) ? r.color.toLowerCase() : b.color,
    scale: clampNum(r.scale, 0.25, 8, b.scale),
    tiling: r.tiling === 'repeat' || r.tiling === 'mirror' ? r.tiling : b.tiling,
    depth: unit(r.depth, b.depth),
    shading: unit(r.shading, b.shading),
    dry: readTuning(r.dry, b.dry),
    wet: readTuning(r.wet, b.wet),
    absorption: unit(r.absorption, b.absorption),
    permeability: unit(r.permeability, b.permeability),
    roughness: unit(r.roughness, b.roughness),
    ...(unit(r.metallic, b.metallic ?? 0) > 0 ? { metallic: unit(r.metallic, b.metallic ?? 0) } : {}),
  };
}

/** `#rrggbb` → [r, g, b] 0..255. */
export function hexToRgb8(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The paper as opaque RGBA over `rect` (document pixels): its colour, darkened in the valleys by
 * `shading`.
 */
export function renderPaper(
  paper: PaperSettings,
  rect: { x: number; y: number; width: number; height: number },
  grain = new PaperGrain(paper),
  light?: { azimuth: number; elevation: number }
): Uint8ClampedArray {
  const [r, g, b] = hexToRgb8(paper.color);
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  const shade = grain.flat ? 0 : paper.shading * 0.16;
  const metal = light ? (paper.metallic ?? 0) : 0;
  // Metallic paper: a highlight where the grain's slope faces the half-way vector of the light.
  let hx = 0;
  let hy = 0;
  let hz = 1;
  if (metal > 0 && light) {
    const az = (light.azimuth * Math.PI) / 180;
    const el = (light.elevation * Math.PI) / 180;
    const lx = Math.cos(el) * Math.sin(az);
    const ly = -Math.cos(el) * Math.cos(az);
    const lz = Math.sin(el) + 1;
    const n = Math.hypot(lx, ly, lz);
    hx = lx / n;
    hy = ly / n;
    hz = lz / n;
  }
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const i = (y * rect.width + x) * 4;
      const px = rect.x + x + 0.5;
      const py = rect.y + y + 0.5;
      const k = shade ? 1 - shade * (1 - grain.at(px, py)) : 1;
      let spec = 0;
      if (metal > 0) {
        const gx = (grain.at(px + 1, py) - grain.at(px - 1, py)) * 4;
        const gy = (grain.at(px, py + 1) - grain.at(px, py - 1)) * 4;
        const nl = Math.hypot(gx, gy, 1);
        const nh = Math.max(0, (-gx * hx - gy * hy + hz) / nl);
        spec = metal * Math.pow(nh, 24) * 0.9;
      }
      out[i] = Math.min(255, r * k * (1 - 0.25 * metal) + spec * (r * 0.6 + 102));
      out[i + 1] = Math.min(255, g * k * (1 - 0.25 * metal) + spec * (g * 0.6 + 102));
      out[i + 2] = Math.min(255, b * k * (1 - 0.25 * metal) + spec * (b * 0.6 + 102));
      out[i + 3] = 255;
    }
  }
  return out;
}
