/**
 * Colour management for the image editor, on `@pixerate/editor/cms`:
 *
 * - The document has a colour profile (its working space): the colours its RGB pixels mean.
 *   Missing means sRGB. Assign Profile changes that meaning and keeps the numbers; Convert to
 *   Profile changes the numbers so the colours stay (with a rendering intent and black point
 *   compensation).
 * - The viewport assumes an sRGB display: a document in another space is converted for display,
 *   and Proof Setup shows it as it would print or display through another profile (soft
 *   proofing), optionally with a gamut warning.
 * - Profiles travel with files: PSD image resource 1039, PNG `iCCP`, JPEG APP2.
 */

import {
  BUILTIN_PROFILES,
  CmsError,
  GamutCheck,
  Transform,
  builtinProfile,
  builtinProfileId,
  encodeProfile,
  parseProfile,
  sameColors,
  srgbProfile,
  type BuiltinProfileId,
  type Intent,
  type Profile,
} from '../cms';
import { base64ToBytes, bytesToBase64 } from '../raster/png';
import { TiledSurface, finishTile, type Tile } from '../raster/surface';
import { deepTile, srgbDecode, srgbEncode } from '../raster/deep';

/** A document's colour profile: a built-in one by id, or embedded ICC bytes. */
export interface DocumentColorProfile {
  /** A built-in profile (see `BUILTIN_PROFILES`). */
  builtin?: BuiltinProfileId;
  /** The profile's description. */
  name: string;
  /** ICC bytes of a profile that is not built in. */
  icc?: Uint8Array;
}

/** View › Proof Setup (view state). */
export interface ProofSetup {
  profile: DocumentColorProfile;
  /** Rendering intent from the document to the proof profile (default relative). */
  intent: Intent;
  /** Black point compensation (default true). */
  bpc: boolean;
  /** Show the proof's paper white and ink black (absolute colorimetric to the display). */
  simulatePaper: boolean;
  /** Grey out colours the proof profile cannot reproduce (Gamut Warning). */
  gamutWarning: boolean;
}

export const DEFAULT_PROOF: Omit<ProofSetup, 'profile'> = { intent: 'relative', bpc: true, simulatePaper: false, gamutWarning: false };

/**
 * Image › Mode beyond RGB. The document is still edited as RGB in its working space; the mode is
 * what it is for: the viewport soft-proofs through the CMYK profile (unless Proof Setup says
 * otherwise) and PSD export writes CMYK or Lab channels.
 */
export type DocumentColorMode = { mode: 'cmyk'; profile: DocumentColorProfile; intent: Intent } | { mode: 'lab' };

export interface SerializedColorMode {
  mode: 'cmyk' | 'lab';
  profile?: SerializedColorProfile;
  intent?: Intent;
}

export function serializeColorMode(m: DocumentColorMode): SerializedColorMode {
  return m.mode === 'cmyk' ? { mode: 'cmyk', profile: serializeColorProfile(m.profile), intent: m.intent } : { mode: 'lab' };
}

export function deserializeColorMode(raw: unknown, problems: string[]): DocumentColorMode | null {
  const r = raw as SerializedColorMode;
  if (!r || typeof r !== 'object') return null;
  if (r.mode === 'lab') return { mode: 'lab' };
  if (r.mode !== 'cmyk') return null;
  const profile = (r.profile && deserializeColorProfile(r.profile, problems)) || documentProfile('coated-cmyk');
  const intent = (['perceptual', 'relative', 'saturation', 'absolute'] as const).includes(r.intent as Intent) ? (r.intent as Intent) : 'relative';
  return { mode: 'cmyk', profile, intent };
}

/** The proof the viewport shows: Proof Setup, else a CMYK document's own profile. */
export function effectiveProof(proof: ProofSetup | null | undefined, mode: DocumentColorMode | null | undefined): ProofSetup | null {
  if (proof) return proof;
  if (mode?.mode === 'cmyk') return { ...DEFAULT_PROOF, profile: mode.profile, intent: mode.intent };
  return null;
}

/**
 * RGBA pixels (in the document profile `doc`) as the channel planes of `mode`, for a PSD:
 * CMYK as Photoshop stores it (255 = no ink), Lab with L 0..255 for 0..100 and a, b offset by 128.
 */
export function colorModePlanes(doc: DocumentColorProfile | null | undefined, mode: DocumentColorMode): (rgba: Uint8ClampedArray, n: number) => Uint8Array[] {
  const src = resolveProfile(doc);
  if (mode.mode === 'cmyk') {
    const t = Transform.create(src, resolveProfile(mode.profile), { intent: mode.intent, bpc: true });
    return (rgba, n) => {
      const ink = new Uint8Array(n * 4);
      t.convert8(rgba, 4, ink, 4, false);
      const planes = [0, 1, 2, 3].map(() => new Uint8Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) planes[c][i] = 255 - ink[i * 4 + c];
      return planes;
    };
  }
  const t = Transform.create(src, builtinProfile('lab-d50'), { intent: 'relative', bpc: false });
  return (rgba, n) => {
    const lab = new Uint8Array(n * 4);
    t.convert8(rgba, 4, lab, 4, false);
    const planes = [0, 1, 2].map(() => new Uint8Array(n));
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) planes[c][i] = lab[i * 4 + c];
    return planes;
  };
}

/** `colorModePlanes` at 16 bits: 16-bit sRGB-encoded RGBA in, the mode's 16-bit planes out (CMYK 65535 = no ink). */
export function colorModePlanes16(doc: DocumentColorProfile | null | undefined, mode: DocumentColorMode): (rgba: Uint16Array, n: number) => Uint16Array[] {
  const src = resolveProfile(doc);
  const cmyk = mode.mode === 'cmyk';
  const t = cmyk
    ? Transform.create(src, resolveProfile(mode.profile), { intent: mode.intent, bpc: true })
    : Transform.create(src, builtinProfile('lab-d50'), { intent: 'relative', bpc: false });
  const k = cmyk ? 4 : 3;
  return (rgba, n) => {
    const out = new Uint16Array(n * 4);
    t.convert16(rgba, 4, out, 4, false);
    const planes = Array.from({ length: k }, () => new Uint16Array(n));
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) planes[c][i] = cmyk ? 65535 - out[i * 4 + c] : out[i * 4 + c];
    return planes;
  };
}

const resolved = new WeakMap<object, Profile>();
const fromBytes = new Map<string, Profile>();

/** The profile a document profile names (sRGB when missing). Throws `CmsError` for unreadable ICC bytes. */
export function resolveProfile(doc: DocumentColorProfile | null | undefined): Profile {
  if (!doc) return srgbProfile();
  const hit = resolved.get(doc);
  if (hit) return hit;
  let p: Profile;
  if (doc.builtin) p = builtinProfile(doc.builtin);
  else if (doc.icc) {
    const key = bytesToBase64(doc.icc);
    p = fromBytes.get(key) ?? parseProfile(doc.icc);
    if (fromBytes.size > 32) fromBytes.clear();
    fromBytes.set(key, p);
  } else p = srgbProfile();
  resolved.set(doc, p);
  return p;
}

/** The ICC bytes to embed for a document profile. */
export function profileBytes(doc: DocumentColorProfile | null | undefined): Uint8Array {
  if (doc?.icc) return doc.icc;
  const p = resolveProfile(doc);
  return p.bytes ?? encodeProfile(p);
}

/**
 * A document profile from what a user or agent gives: a built-in id or alias ("srgb",
 * "display-p3", "Adobe RGB (1998)", "coated-cmyk", …) or ICC bytes. Throws with the choices.
 */
export function documentProfile(input: string | Uint8Array): DocumentColorProfile {
  if (typeof input === 'string') {
    const id = builtinProfileId(input);
    if (!id) throw new CmsError(`Unknown colour profile "${input}"; use one of ${BUILTIN_PROFILES.map((b) => b.id).join(', ')}, or ICC bytes.`);
    return { builtin: id, name: BUILTIN_PROFILES.find((b) => b.id === id)!.description };
  }
  const p = parseProfile(input);
  // A copy of a built-in profile (Photoshop's own sRGB, say) is stored as the built-in one.
  return { name: p.description || 'Embedded profile', icc: input.slice() };
}

/** Whether a document profile means sRGB (so the display needs no conversion). */
export function isSrgb(doc: DocumentColorProfile | null | undefined): boolean {
  if (!doc || doc.builtin === 'srgb') return true;
  try {
    return sameColors(resolveProfile(doc), srgbProfile(), builtinProfile('lab-d50'));
  } catch {
    return false;
  }
}

/** JSON form of a document profile. */
export interface SerializedColorProfile {
  builtin?: BuiltinProfileId;
  name: string;
  /** ICC bytes, base64. */
  icc?: string;
}

export function serializeColorProfile(doc: DocumentColorProfile): SerializedColorProfile {
  return doc.builtin ? { builtin: doc.builtin, name: doc.name } : { name: doc.name, icc: bytesToBase64(doc.icc ?? new Uint8Array(0)) };
}

/** A document profile from JSON, or `null` (with a problem noted) when it cannot be read. */
export function deserializeColorProfile(raw: unknown, problems: string[]): DocumentColorProfile | null {
  const r = raw as SerializedColorProfile;
  if (!r || typeof r !== 'object') return null;
  try {
    if (r.builtin) {
      const id = builtinProfileId(r.builtin);
      if (!id) throw new CmsError(`unknown built-in profile "${r.builtin}"`);
      return documentProfile(id);
    }
    if (typeof r.icc === 'string') {
      const icc = base64ToBytes(r.icc);
      parseProfile(icc);
      return { name: typeof r.name === 'string' ? r.name : 'Embedded profile', icc };
    }
  } catch (e) {
    problems.push(`The colour profile could not be read (${e instanceof Error ? e.message : String(e)}); the document is treated as sRGB`);
  }
  return null;
}

/** Applies a colour transform to 8-bit RGBA in place (alpha kept). */
export type PixelTransform = (rgba: Uint8ClampedArray) => void;

/**
 * What the viewport applies to the composite before showing it on an sRGB display: nothing for
 * an sRGB document without proofing; the document → sRGB conversion; or the proof chain
 * document → proof → sRGB, with out-of-gamut colours greyed when asked.
 */
export function displayTransform(doc: DocumentColorProfile | null | undefined, proof: ProofSetup | null | undefined): PixelTransform | null {
  const src = resolveProfile(doc);
  const display = srgbProfile();
  let t: Transform | null = null;
  let gamut: GamutCheck | null = null;
  if (proof) {
    const p = resolveProfile(proof.profile);
    t = Transform.proof(src, p, display, proof.intent, proof.bpc, proof.simulatePaper);
    if (proof.gamutWarning) gamut = new GamutCheck(src, p, builtinProfile('lab-d50'));
  } else if (!isSrgb(doc)) t = Transform.create(src, display, { intent: 'relative', bpc: true });
  if (!t) return null;
  const tr = t;
  const g = gamut;
  return (rgba) => {
    if (g) {
      const px = [0, 0, 0];
      const flags = new Uint8Array(rgba.length >> 2);
      for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
        if (rgba[i + 3] === 0) continue;
        px[0] = rgba[i] / 255;
        px[1] = rgba[i + 1] / 255;
        px[2] = rgba[i + 2] / 255;
        if (g.outOfGamut(px)) flags[p] = 1;
      }
      tr.convert8(rgba, 4, rgba, 4);
      for (let i = 0, p = 0; i < rgba.length; i += 4, p++) if (flags[p]) rgba[i] = rgba[i + 1] = rgba[i + 2] = 128;
      return;
    }
    tr.convert8(rgba, 4, rgba, 4);
  };
}

/** A `#rrggbb` colour converted between two profiles. */
export function convertHex(hex: string, from: Profile, to: Profile, intent: Intent = 'relative', bpc = true): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const out = new Float32Array(4);
  Transform.create(from, to, { intent, bpc }).eval([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], out);
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(out[0])}${c(out[1])}${c(out[2])}`;
}

/**
 * A layer surface with every pixel's colour converted through `t` (an RGB → RGB transform):
 * 8-bit tiles through its tables, 16-bit tiles at 16 bits, 32-bit (linear) tiles through the
 * float path. Alpha is kept.
 */
export function convertSurfaceColors(surface: TiledSurface, t: Transform): TiledSurface {
  if (surface.channels !== 4 || t.inputs !== 3 || t.outputs !== 3) return surface;
  const tiles = new Map<number, Tile>();
  const memo = new Map<Tile, Tile | null>();
  for (const [key, tile] of surface.tiles) {
    let next = memo.get(tile);
    if (next === undefined) {
      if (tile.deep instanceof Uint16Array) {
        const out = new Uint16Array(tile.deep.length);
        t.convert16(tile.deep, 4, out, 4);
        next = deepTile(out, 4, surface.defaultValue);
      } else if (tile.deep instanceof Float32Array) {
        const enc = new Float32Array(tile.deep.length);
        for (let i = 0; i < enc.length; i += 4) {
          for (let c = 0; c < 3; c++) enc[i + c] = srgbEncode(tile.deep[i + c]);
          enc[i + 3] = tile.deep[i + 3];
        }
        t.convertFloat(enc, 4, enc, 4);
        for (let i = 0; i < enc.length; i += 4) for (let c = 0; c < 3; c++) enc[i + c] = srgbDecode(enc[i + c]);
        next = deepTile(enc, 4, surface.defaultValue);
      } else {
        const out = new Uint8ClampedArray(tile.data.length);
        t.convert8(tile.data, 4, out, 4);
        next = finishTile(out, 4, surface.defaultValue);
      }
      memo.set(tile, next);
    }
    if (next) tiles.set(key, next);
  }
  return new TiledSurface(4, tiles, surface.defaultValue);
}
