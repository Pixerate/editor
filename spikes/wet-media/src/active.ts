import { TILE } from './model';

/** Width of the band along a tile edge that, when wet, activates the neighbouring tile. */
export const STRIP = 64;

/** Per-tile wet flag bits written by every implementation's step. */
export const FLAG_WET = 1;
export const FLAG_LEFT = 2;
export const FLAG_RIGHT = 4;
export const FLAG_TOP = 8;
export const FLAG_BOTTOM = 16;

export function edgeBits(lx: number, ly: number): number {
  let b = FLAG_WET;
  if (lx < STRIP) b |= FLAG_LEFT;
  if (lx >= TILE - STRIP) b |= FLAG_RIGHT;
  if (ly < STRIP) b |= FLAG_TOP;
  if (ly >= TILE - STRIP) b |= FLAG_BOTTOM;
  return b;
}

/**
 * Which tiles are dispatched. Grow-only: a dry tile computes to exactly its previous (zero)
 * state, so activating a tile early never changes results, and every implementation gives the
 * same answer however late its flags arrive (the GPU reads them back asynchronously).
 */
export class ActiveSet {
  readonly tilesX: number;
  readonly tilesY: number;
  readonly active: Uint8Array;
  private list: number[] = [];
  private dirty = true;
  /** Bumped whenever a tile is added, so dependents can re-upload their tile lists. */
  version = 0;

  constructor(width: number, height: number) {
    this.tilesX = Math.ceil(width / TILE);
    this.tilesY = Math.ceil(height / TILE);
    this.active = new Uint8Array(this.tilesX * this.tilesY);
  }

  add(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.tilesX || ty >= this.tilesY) return false;
    const i = ty * this.tilesX + tx;
    if (this.active[i]) return false;
    this.active[i] = 1;
    this.dirty = true;
    this.version++;
    return true;
  }

  /** Activate every tile within STRIP of a pixel rect. Returns the tiles that were newly added. */
  markRect(x0: number, y0: number, x1: number, y1: number): number[] {
    const added: number[] = [];
    const tx0 = Math.floor((x0 - STRIP) / TILE);
    const ty0 = Math.floor((y0 - STRIP) / TILE);
    const tx1 = Math.floor((x1 + STRIP) / TILE);
    const ty1 = Math.floor((y1 + STRIP) / TILE);
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) if (this.add(tx, ty)) added.push(ty * this.tilesX + tx);
    return added;
  }

  /** Apply per-tile flag words (indexed by tile). Returns the tiles that were newly added. */
  applyFlags(flags: Uint32Array): number[] {
    const added: number[] = [];
    const push = (tx: number, ty: number) => {
      if (this.add(tx, ty)) added.push(ty * this.tilesX + tx);
    };
    for (let ty = 0; ty < this.tilesY; ty++) {
      for (let tx = 0; tx < this.tilesX; tx++) {
        const f = flags[ty * this.tilesX + tx];
        if (!(f & FLAG_WET)) continue;
        const l = f & FLAG_LEFT, r = f & FLAG_RIGHT, t = f & FLAG_TOP, b = f & FLAG_BOTTOM;
        if (l) push(tx - 1, ty);
        if (r) push(tx + 1, ty);
        if (t) push(tx, ty - 1);
        if (b) push(tx, ty + 1);
        if (l && t) push(tx - 1, ty - 1);
        if (r && t) push(tx + 1, ty - 1);
        if (l && b) push(tx - 1, ty + 1);
        if (r && b) push(tx + 1, ty + 1);
      }
    }
    return added;
  }

  tiles(): number[] {
    if (this.dirty) {
      this.list = [];
      for (let i = 0; i < this.active.length; i++) if (this.active[i]) this.list.push(i);
      this.dirty = false;
    }
    return this.list;
  }
}
