/**
 * The settings of the sticker, particle and bristle engines: types, defaults and normalisers, with
 * no rendering code (sticker refs and the stamp list come from the renderer-free `stickers/`), so
 * the brush model (`@pixerate/editor/brushes`) can read and check them without bundling the
 * renderers. `stickers.ts` and `procedural.ts` re-export them.
 */

import { normalizeStickerRef } from '../stickers/helpers';
import { STAMP_KINDS, type StampKind } from '../stickers/stamps';
import type { StickerRef } from '../stickers/types';

const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);

// ---------------------------------------------------------------------------
// Stickers
// ---------------------------------------------------------------------------

export { STAMP_KINDS, type StampKind } from '../stickers/stamps';

/** Sticker spray settings (each 0..1 unless noted). */
export interface StickerSettings {
  /**
   * The stickers to spray (one picked at random per sticker): refs `provider:id`. A bare editor
   * stamp (`"star"`) is read as `editor:star`.
   */
  stamps: StickerRef[];
  /** How closely stickers follow each other: about `density × 4` per tip diameter of travel (0.25 ≈ one per diameter). */
  density: number;
  /** Random size change. */
  sizeJitter: number;
  /** Random turn, as a fraction of ±180°. */
  rotationJitter: number;
  /** How far from the path stickers land, in tip diameters (0..2). */
  scatter: number;
  /** Random colour change (hue and lightness). */
  colorJitter: number;
}

/** At most this many stickers in a sticker brush. */
export const MAX_STICKER_STAMPS = 16;

export const DEFAULT_STICKER: Readonly<StickerSettings> = { stamps: ['editor:star'], density: 0.4, sizeJitter: 0.4, rotationJitter: 1, scatter: 0.5, colorJitter: 0.2 };

export function normalizeStickerSettings(raw: Partial<StickerSettings> = {}, base: StickerSettings = DEFAULT_STICKER): StickerSettings {
  const refs = (list: readonly unknown[]) =>
    list.flatMap((s) => {
      try {
        return [normalizeStickerRef(s as string)];
      } catch {
        return [];
      }
    });
  const stamps = Array.isArray(raw.stamps) ? refs(raw.stamps) : refs(base.stamps);
  return {
    stamps: stamps.length ? [...new Set(stamps)].slice(0, MAX_STICKER_STAMPS) : refs(base.stamps.length ? base.stamps : DEFAULT_STICKER.stamps),
    density: unit(raw.density, base.density),
    sizeJitter: unit(raw.sizeJitter, base.sizeJitter),
    rotationJitter: unit(raw.rotationJitter, base.rotationJitter),
    scatter: typeof raw.scatter === 'number' && Number.isFinite(raw.scatter) ? Math.min(2, Math.max(0, raw.scatter)) : base.scatter,
    colorJitter: unit(raw.colorJitter, base.colorJitter),
  };
}

// ---------------------------------------------------------------------------
// Particle brushes
// ---------------------------------------------------------------------------

export type ParticleKind = 'string' | 'spring' | 'orbit' | 'flow' | 'elastic' | 'fuzzy';
export const PARTICLE_KINDS: readonly ParticleKind[] = ['string', 'spring', 'orbit', 'flow', 'elastic', 'fuzzy'];
export type ParticleRender = 'dot' | 'line' | 'sequence' | 'ribbon';
export const PARTICLE_RENDERS: readonly ParticleRender[] = ['dot', 'line', 'sequence', 'ribbon'];
/** Ribbon: which particles' paths are joined (`adjacent`: each to its neighbour; `first-last`: one band between the outermost two). */
export type RibbonPairs = 'adjacent' | 'first-last';
export const RIBBON_PAIRS: readonly RibbonPairs[] = ['adjacent', 'first-last'];
/** Textured dots: the stamps in turn, or one picked at random (seeded) per dot. */
export type DotTextureOrder = 'sequence' | 'random';
export const DOT_TEXTURE_ORDERS: readonly DotTextureOrder[] = ['sequence', 'random'];
/** Textured dots: turned with the particle's motion, at random, or at the tip angle. */
export type DotRotation = 'follow' | 'random' | 'fixed';
export const DOT_ROTATIONS: readonly DotRotation[] = ['follow', 'random', 'fixed'];
/** Textured dots: at most this many stamps. */
export const MAX_DOT_TEXTURES = 4;

/** Particle engine settings (each 0..1 unless noted). */
export interface ParticleSettings {
  kind: ParticleKind;
  render: ParticleRender;
  /** Particles, 1..64. */
  count: number;
  /** Mark size as a fraction of the tip size. */
  size: number;
  /** How far apart the particles start, as a fraction of the tip size. */
  spread: number;
  /** Spring and string stiffness (stiff follows closely; soft swings wide). */
  stiffness: number;
  /** How quickly motion dies down. */
  damping: number;
  /** Orbit and flow speed. */
  speed: number;
  /** Pull downwards (−1 up .. 1 down). */
  gravity: number;
  /** Flow particles' lifetime. */
  life: number;
  /** Sequence: spacing of the beads along each path. */
  interval: number;
  /** Ribbon: opacity of the fill between the paths, relative to their edges. */
  ribbonFill: number;
  /** Ribbon: which paths are joined. */
  ribbonPairs: RibbonPairs;
  /** Wave: how far each particle's drawn place swings sideways, as a fraction of the tip size (0: no wave). */
  waveAmplitude: number;
  /** Wave: wavelength in px of pen travel, 4..2000. */
  waveLength: number;
  /** Wave: how fast the waves run (0: they stand still on the path; 1: about four a second while the pen moves). */
  waveSpeed: number;
  /** Wave: how far out of step the particles' waves are (0: all in step; 1: random phases). */
  wavePhaseJitter: number;
  /** Dots and beads: up to four sticker stamps drawn instead of round marks (empty: round). */
  dotTextures: StampKind[];
  dotTextureOrder: DotTextureOrder;
  dotRotation: DotRotation;
}

export const DEFAULT_PARTICLE: Readonly<ParticleSettings> = {
  kind: 'spring',
  render: 'line',
  count: 12,
  size: 0.08,
  spread: 0.5,
  stiffness: 0.4,
  damping: 0.25,
  speed: 0.5,
  gravity: 0,
  life: 0.5,
  interval: 0.3,
  ribbonFill: 0.5,
  ribbonPairs: 'adjacent',
  waveAmplitude: 0,
  waveLength: 60,
  waveSpeed: 0,
  wavePhaseJitter: 0,
  dotTextures: [],
  dotTextureOrder: 'sequence',
  dotRotation: 'random',
};


export function normalizeParticle(raw: Partial<ParticleSettings> = {}, base: ParticleSettings = DEFAULT_PARTICLE): ParticleSettings {
  const textures = Array.isArray(raw.dotTextures) ? raw.dotTextures.filter((t): t is StampKind => STAMP_KINDS.includes(t as StampKind)).slice(0, MAX_DOT_TEXTURES) : [...(base.dotTextures ?? [])];
  return {
    kind: oneOf(raw.kind, PARTICLE_KINDS, base.kind),
    render: oneOf(raw.render, PARTICLE_RENDERS, base.render),
    count: typeof raw.count === 'number' && Number.isFinite(raw.count) ? Math.min(64, Math.max(1, Math.round(raw.count))) : base.count,
    size: unit(raw.size, base.size),
    spread: unit(raw.spread, base.spread),
    stiffness: unit(raw.stiffness, base.stiffness),
    damping: unit(raw.damping, base.damping),
    speed: unit(raw.speed, base.speed),
    gravity: typeof raw.gravity === 'number' && Number.isFinite(raw.gravity) ? Math.min(1, Math.max(-1, raw.gravity)) : base.gravity,
    life: unit(raw.life, base.life),
    interval: unit(raw.interval, base.interval),
    ribbonFill: unit(raw.ribbonFill, base.ribbonFill ?? DEFAULT_PARTICLE.ribbonFill),
    ribbonPairs: oneOf(raw.ribbonPairs, RIBBON_PAIRS, base.ribbonPairs ?? DEFAULT_PARTICLE.ribbonPairs),
    waveAmplitude: unit(raw.waveAmplitude, base.waveAmplitude ?? 0),
    waveLength: typeof raw.waveLength === 'number' && Number.isFinite(raw.waveLength) ? Math.min(2000, Math.max(4, raw.waveLength)) : (base.waveLength ?? DEFAULT_PARTICLE.waveLength),
    waveSpeed: unit(raw.waveSpeed, base.waveSpeed ?? 0),
    wavePhaseJitter: unit(raw.wavePhaseJitter, base.wavePhaseJitter ?? 0),
    dotTextures: textures,
    dotTextureOrder: oneOf(raw.dotTextureOrder, DOT_TEXTURE_ORDERS, base.dotTextureOrder ?? DEFAULT_PARTICLE.dotTextureOrder),
    dotRotation: oneOf(raw.dotRotation, DOT_ROTATIONS, base.dotRotation ?? DEFAULT_PARTICLE.dotRotation),
  };
}

// ---------------------------------------------------------------------------
// Bristle brushes
// ---------------------------------------------------------------------------

/** Bristle engine settings (each 0..1 unless noted). */
export interface BristleSettings {
  /** Bristles in the tuft, 3..128. */
  count: number;
  /** Stiff bristles follow the tip; soft ones lag and bend into curves at turns. */
  stiffness: number;
  /** How far pressure spreads the tuft. */
  splay: number;
  /** Width of each bristle's line as a fraction of the tip size. */
  thickness: number;
  /** Paint per bristle: 1 never runs dry; lower, bristles run out along the stroke (dry brush). */
  load: number;
  /** Random variation between bristles (length, paint, position). */
  jitter: number;
}

export const DEFAULT_BRISTLE: Readonly<BristleSettings> = { count: 32, stiffness: 0.5, splay: 0.5, thickness: 0.06, load: 0.6, jitter: 0.4 };

export function normalizeBristle(raw: Partial<BristleSettings> = {}, base: BristleSettings = DEFAULT_BRISTLE): BristleSettings {
  return {
    count: typeof raw.count === 'number' && Number.isFinite(raw.count) ? Math.min(128, Math.max(3, Math.round(raw.count))) : base.count,
    stiffness: unit(raw.stiffness, base.stiffness),
    splay: unit(raw.splay, base.splay),
    thickness: unit(raw.thickness, base.thickness),
    load: unit(raw.load, base.load),
    jitter: unit(raw.jitter, base.jitter),
  };
}
