/**
 * The editor's own sticker stamps: procedural shapes (dot, star, heart, leaf, petal flower,
 * confetti, splat, sparkle, ring) defined by a coverage function over the unit square, so no
 * artwork is bundled. The paint editor's sticker spray draws them directly; `editorStickers()`
 * offers them to every editor as the built-in sticker set (SVG outlines and PNGs).
 */

import { hash2 } from '../paint/rand';

export type StampKind = 'dot' | 'star' | 'heart' | 'leaf' | 'flower' | 'confetti' | 'splat' | 'sparkle' | 'ring';
export const STAMP_KINDS: readonly StampKind[] = ['dot', 'star', 'heart', 'leaf', 'flower', 'confetti', 'splat', 'sparkle', 'ring'];

/**
 * Coverage of a stamp at a point (u, v) of its unit square (−1..1, y down), 0..1, before shading.
 * `t` is the sticker's seed for shapes with random parts (splat, confetti).
 */
export function stampCoverage(kind: StampKind, u: number, v: number, t: number): number {
  const r = Math.hypot(u, v);
  const a = Math.atan2(v, u);
  const edge = (d: number) => Math.min(1, Math.max(0, d * 24 + 0.5));
  switch (kind) {
    case 'dot':
      return edge(0.95 - r);
    case 'ring':
      return edge(Math.min(0.95 - r, r - 0.6));
    case 'star': {
      // Five points, one straight up: the outline radius falls from the points to the notches.
      const f = (((a + Math.PI / 2) * 5) / (2 * Math.PI)) % 1;
      const notch = Math.min(f < 0 ? f + 1 : f, 1 - (f < 0 ? f + 1 : f)) * 2;
      return edge(0.95 - 0.55 * notch - r);
    }
    case 'sparkle': {
      // A four-pointed twinkle (an astroid): |u|^0.6 + |v|^0.6 ≤ 1.
      const q = Math.pow(Math.abs(u) / 0.95, 0.6) + Math.pow(Math.abs(v) / 0.95, 0.6);
      return edge((1 - q) * 0.4);
    }
    case 'heart': {
      const x = u * 1.1;
      const y = -v * 1.1 + 0.15;
      const q = x * x + y * y - 0.55;
      return edge(-(q * q * q - x * x * y * y * y) * 3);
    }
    case 'leaf': {
      // A pointed oval with a midrib.
      const w = 0.42 * Math.sqrt(Math.max(0, 1 - u * u));
      const inside = edge(w - Math.abs(v + 0.15 * u * u));
      const rib = Math.abs(v + 0.15 * u * u) < 0.03 && Math.abs(u) < 0.85 ? 0.65 : 1;
      return inside * rib;
    }
    case 'flower': {
      const petals = 0.6 + 0.35 * Math.abs(Math.cos(2.5 * a));
      const body = edge(petals - r);
      return r < 0.22 ? Math.max(body, 1) * 0.85 : body;
    }
    case 'confetti': {
      // A small turned rectangle.
      return edge(Math.min(0.9 - Math.abs(u), 0.35 - Math.abs(v)));
    }
    case 'splat': {
      // A blob with drops: a bumpy outline plus a few satellites.
      let rr = 0.55;
      for (let k = 1; k <= 3; k++) rr += 0.08 * Math.sin(a * (k + 2) + hash2(k, 1, t) * 6.28) / k;
      let c = edge(rr - r);
      for (let k = 0; k < 4; k++) {
        const ang = hash2(k, 7, t) * Math.PI * 2;
        const dist = 0.72 + 0.2 * hash2(k, 9, t);
        const dx = u - Math.cos(ang) * dist;
        const dy = v - Math.sin(ang) * dist;
        c = Math.max(c, edge(0.08 + 0.06 * hash2(k, 11, t) - Math.hypot(dx, dy)));
      }
      return c;
    }
  }
}
