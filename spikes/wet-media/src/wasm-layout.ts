/**
 * Shared-memory layout for the wasm SIMD path, used by the main thread and the workers.
 *
 * Bytes:
 *   0     control block (Int32): barrier, work counters, parity, slot count
 *   1024  params (16 x f32, see packParams)
 *   4096  tile -> slot table (Int32, -1 = inactive), max 4096 tiles
 *   20480 active tile list (Int32), length in CTL_ACTIVE_COUNT
 *   36864 per-tile flags (Uint32)
 *   1 MiB paper height map (dense, width*height f32), then flow map (2*width*height f32) if any
 *   then tile slots of SLOT_BYTES each, allocated in order and never freed (grow-only set)
 */
import { STRIP, FLAG_BOTTOM, FLAG_LEFT, FLAG_RIGHT, FLAG_TOP, FLAG_WET } from './active';

export const S = 258;
export const PLANE = S * S; // floats
export const PLANE_BYTES = PLANE * 4;
export const PLANES = 31;
export const SLOT_BYTES = PLANES * PLANE_BYTES;
export const SET_PLANES = 13;
export const P_RHO = 9, P_UX = 10, P_UY = 11, P_P = 12, P_D = 26, P_S = 27, P_H = 28, P_FX = 29, P_FY = 30;

export const CTL_BAR_COUNT = 0;
export const CTL_BAR_GEN = 1;
export const CTL_WORK = 2;
export const CTL_PARITY = 3;
export const CTL_ACTIVE_COUNT = 4;
export const CTL_SLOTS_USED = 5;
export const CTL_SLOTS_CAP = 6;
export const CTL_DONE = 7;
export const CTL_OVERFLOW = 8;

export const PARAMS_ADDR = 1024;
export const TABLE_ADDR = 4096;
export const ACTIVE_ADDR = 20480;
export const FLAGS_ADDR = 36864;
export const PAPER_ADDR = 1 << 20;

export interface Layout {
  width: number;
  height: number;
  tilesX: number;
  tilesY: number;
  hasFlow: boolean;
  flowAddr: number;
  slotsAddr: number;
}

export function makeLayout(width: number, height: number, hasFlow: boolean): Layout {
  const n = width * height;
  const flowAddr = PAPER_ADDR + n * 4;
  const end = flowAddr + (hasFlow ? n * 8 : 0);
  const slotsAddr = Math.ceil(end / 65536) * 65536;
  return { width, height, tilesX: Math.ceil(width / 256), tilesY: Math.ceil(height / 256), hasFlow, flowAddr, slotsAddr };
}

export function bytesFor(l: Layout, slots: number): number {
  return l.slotsAddr + slots * SLOT_BYTES;
}

/** Views over shared memory. Recreate after memory.grow. */
export class Views {
  ctl: Int32Array;
  table: Int32Array;
  list: Int32Array;
  flags: Uint32Array;
  f32: Float32Array;
  constructor(buf: ArrayBufferLike) {
    this.ctl = new Int32Array(buf, 0, 256);
    this.table = new Int32Array(buf, TABLE_ADDR, 4096);
    this.list = new Int32Array(buf, ACTIVE_ADDR, 4096);
    this.flags = new Uint32Array(buf, FLAGS_ADDR, 4096);
    this.f32 = new Float32Array(buf);
  }
}

export function slotBase(l: Layout, slot: number): number {
  return l.slotsAddr + slot * SLOT_BYTES;
}

/** Float index of (plane, x, y) in slot; x, y in padded coordinates (0..257). */
export function idx(l: Layout, slot: number, plane: number, x: number, y: number): number {
  return (slotBase(l, slot) >> 2) + plane * PLANE + y * S + x;
}

/**
 * Activate a tile: take the next slot (fresh memory is zero), copy paper height (with
 * -1 for off-canvas halo cells) and the flow map. Returns false if no slot is free.
 */
export function activate(l: Layout, v: Views, tile: number): boolean {
  if (v.table[tile] >= 0) return true;
  const used = v.ctl[CTL_SLOTS_USED];
  if (used >= v.ctl[CTL_SLOTS_CAP]) {
    v.ctl[CTL_OVERFLOW] = 1;
    return false;
  }
  v.ctl[CTL_SLOTS_USED] = used + 1;
  const slot = used;
  const tx = tile % l.tilesX, ty = (tile / l.tilesX) | 0;
  const f = v.f32;
  const paper = PAPER_ADDR >> 2;
  const hBase = idx(l, slot, P_H, 0, 0);
  for (let y = 0; y < S; y++) {
    const gy = ty * 256 + y - 1;
    for (let x = 0; x < S; x++) {
      const gx = tx * 256 + x - 1;
      f[hBase + y * S + x] = gx < 0 || gy < 0 || gx >= l.width || gy >= l.height ? -1 : f[paper + gy * l.width + gx];
    }
  }
  if (l.hasFlow) {
    const flow = l.flowAddr >> 2;
    const fx = idx(l, slot, P_FX, 0, 0), fy = idx(l, slot, P_FY, 0, 0);
    for (let y = 1; y <= 256; y++) {
      for (let x = 1; x <= 256; x++) {
        const g = (ty * 256 + y - 1) * l.width + tx * 256 + x - 1;
        f[fx + y * S + x] = f[flow + 2 * g];
        f[fy + y * S + x] = f[flow + 2 * g + 1];
      }
    }
  }
  v.table[tile] = slot;
  const count = v.ctl[CTL_ACTIVE_COUNT];
  v.list[count] = tile;
  v.ctl[CTL_ACTIVE_COUNT] = count + 1;
  return true;
}

/** Leader-only: grow the active set from the flags of the last step, then clear the flags. */
export function applyFlags(l: Layout, v: Views): void {
  const count = v.ctl[CTL_ACTIVE_COUNT];
  for (let a = 0; a < count; a++) {
    const t = v.list[a];
    const fl = v.flags[t];
    v.flags[t] = 0;
    if (!(fl & FLAG_WET)) continue;
    const tx = t % l.tilesX, ty = (t / l.tilesX) | 0;
    const L = fl & FLAG_LEFT, R = fl & FLAG_RIGHT, T = fl & FLAG_TOP, B = fl & FLAG_BOTTOM;
    const add = (x: number, y: number) => {
      if (x >= 0 && y >= 0 && x < l.tilesX && y < l.tilesY) activate(l, v, y * l.tilesX + x);
    };
    if (L) add(tx - 1, ty);
    if (R) add(tx + 1, ty);
    if (T) add(tx, ty - 1);
    if (B) add(tx, ty + 1);
    if (L && T) add(tx - 1, ty - 1);
    if (R && T) add(tx + 1, ty - 1);
    if (L && B) add(tx - 1, ty + 1);
    if (R && B) add(tx + 1, ty + 1);
  }
}

/** Every tile within STRIP of a pixel rect (same rule as ActiveSet.markRect). */
export function tilesNearRect(l: Layout, x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  const tx0 = Math.max(0, Math.floor((x0 - STRIP) / 256)), ty0 = Math.max(0, Math.floor((y0 - STRIP) / 256));
  const tx1 = Math.min(l.tilesX - 1, Math.floor((x1 + STRIP) / 256)), ty1 = Math.min(l.tilesY - 1, Math.floor((y1 + STRIP) / 256));
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push(ty * l.tilesX + tx);
  return out;
}

/**
 * Fill the halo of one tile's planes in set `set` (0 or 1) from its active neighbours'
 * interiors. Inactive or off-canvas neighbours stay zero (a dry tile is all zeros).
 */
export function fillHalo(l: Layout, v: Views, tile: number, set: number): void {
  const slot = v.table[tile];
  const tx = tile % l.tilesX, ty = (tile / l.tilesX) | 0;
  const f = v.f32;
  const nb = (dx: number, dy: number) => {
    const x = tx + dx, y = ty + dy;
    if (x < 0 || y < 0 || x >= l.tilesX || y >= l.tilesY) return -1;
    return v.table[y * l.tilesX + x];
  };
  const n = nb(0, -1), s = nb(0, 1), w = nb(-1, 0), e = nb(1, 0);
  const nw = nb(-1, -1), ne = nb(1, -1), sw = nb(-1, 1), se = nb(1, 1);
  for (let k = 0; k < SET_PLANES; k++) {
    const plane = set * SET_PLANES + k;
    const me = idx(l, slot, plane, 0, 0);
    if (n >= 0) { const o = idx(l, n, plane, 1, 256); f.copyWithin(me + 1, o, o + 256); }
    if (s >= 0) { const o = idx(l, s, plane, 1, 1); f.copyWithin(me + 257 * S + 1, o, o + 256); }
    if (w >= 0) { const o = idx(l, w, plane, 256, 0); for (let y = 1; y <= 256; y++) f[me + y * S] = f[o + y * S]; }
    if (e >= 0) { const o = idx(l, e, plane, 1, 0); for (let y = 1; y <= 256; y++) f[me + y * S + 257] = f[o + y * S]; }
    if (nw >= 0) f[me] = f[idx(l, nw, plane, 256, 256)];
    if (ne >= 0) f[me + 257] = f[idx(l, ne, plane, 1, 256)];
    if (sw >= 0) f[me + 257 * S] = f[idx(l, sw, plane, 256, 1)];
    if (se >= 0) f[me + 257 * S + 257] = f[idx(l, se, plane, 1, 1)];
  }
}
