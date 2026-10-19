// Portions ported from photocraft/crates/psd/src/path.rs and photocraft/crates/io/src/vector_map.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * PSD path records (Adobe's "Path resource format") and the layer vector blocks built on them
 * (`vmsk` / `vsms`): a path is a list of 26-byte records, each a 2-byte selector and 24 data
 * bytes. Knots hold three points (the control point before, the anchor, the control point after)
 * as signed 8.24 fixed-point fractions of the document height and width, vertical first. Bytes
 * 2–3 of a subpath length record hold the subpath's path operation (undocumented, as psd-tools
 * found): 1 or -1 combine, 2 subtract, 3 intersect, 0 exclude, and -1 after a component's first
 * subpath means "part of the same component".
 */

import { PsdReader, PsdWriter } from './binary';
import { expandVectorCorners } from '../../vector/corners';
import type { VectorAnchor, VectorSubpath } from '../../vector/types';
import type { ShapeComponent, ShapeOperation } from '../layers/model';

const RECORD = 26;

export interface PsdKnot {
  linked: boolean;
  /** Fractions of the document (`x` of the width, `y` of the height). */
  pre: { x: number; y: number };
  anchor: { x: number; y: number };
  post: { x: number; y: number };
}

export interface PsdSubpath {
  closed: boolean;
  /** The length record's operation (see the module comment). */
  operation: number;
  knots: PsdKnot[];
}

export interface PsdPath {
  subpaths: PsdSubpath[];
  /** Initial fill record: the path starts with everything filled. */
  initialFill: boolean;
}

const fixed = (v: number) => v / 16777216;
const toFixed = (v: number) => Math.max(-2147483648, Math.min(2147483647, Math.round(v * 16777216)));

/** Path records → subpaths (lenient: knots without a length record still form a subpath). */
export function readPathRecords(data: Uint8Array): PsdPath {
  const r = new PsdReader(data);
  const subpaths: PsdSubpath[] = [];
  let initialFill = false;
  let remaining = 0;
  while (r.remaining >= RECORD) {
    const selector = r.u16();
    const body = r.sub(24);
    if (selector === 0 || selector === 3) {
      remaining = body.u16();
      subpaths.push({ closed: selector === 0, operation: body.i16(), knots: [] });
    } else if (selector === 1 || selector === 2 || selector === 4 || selector === 5) {
      const closed = selector <= 2;
      const last = subpaths[subpaths.length - 1];
      if (remaining === 0 && (!last || last.closed !== closed)) subpaths.push({ closed, operation: -1, knots: [] });
      remaining = Math.max(0, remaining - 1);
      const pt = () => {
        const y = fixed(body.i32());
        const x = fixed(body.i32());
        return { x, y };
      };
      const pre = pt();
      const anchor = pt();
      const post = pt();
      subpaths[subpaths.length - 1].knots.push({ linked: selector === 1 || selector === 4, pre, anchor, post });
    } else if (selector === 8) {
      initialFill = body.u16() !== 0;
    }
  }
  return { subpaths, initialFill };
}

/** Subpaths → path records (fill rule and initial fill records first, as Photoshop writes them). */
export function writePathRecords(path: PsdPath): Uint8Array {
  const w = new PsdWriter();
  w.u16(6);
  w.zeros(24);
  w.u16(8);
  w.u16(path.initialFill ? 1 : 0);
  w.zeros(22);
  for (const s of path.subpaths) {
    w.u16(s.closed ? 0 : 3);
    w.u16(Math.min(s.knots.length, 65535));
    w.i16(s.operation);
    // Photoshop writes 1 here (meaning unknown).
    w.u16(1);
    w.zeros(18);
    for (const k of s.knots.slice(0, 65535)) {
      w.u16(s.closed ? (k.linked ? 1 : 2) : k.linked ? 4 : 5);
      for (const p of [k.pre, k.anchor, k.post]) {
        w.i32(toFixed(p.y));
        w.i32(toFixed(p.x));
      }
    }
  }
  return w.result();
}

export const VMSK_INVERT = 1;
export const VMSK_NOT_LINKED = 2;
export const VMSK_DISABLED = 4;

/** A `vmsk` / `vsms` block: version, flags, path records. */
export function readVectorBlock(data: Uint8Array): { version: number; flags: number; path: PsdPath } | null {
  if (data.length < 8) return null;
  const r = new PsdReader(data);
  const version = r.u32();
  const flags = r.u32();
  return { version, flags, path: readPathRecords(data.subarray(8)) };
}

export function writeVectorBlock(path: PsdPath, flags = 0): Uint8Array {
  const body = writePathRecords(path);
  const w = new PsdWriter();
  w.u32(3);
  w.u32(flags);
  w.bytes(body);
  return w.result();
}

const OP_TO_PSD: Record<ShapeOperation, number> = { combine: 1, subtract: 2, intersect: 3, exclude: 0 };
const OP_FROM_PSD = (v: number): ShapeOperation => (v === 0 ? 'exclude' : v === 2 ? 'subtract' : v === 3 ? 'intersect' : 'combine');

/**
 * Shape components from a layer's vector block, in document pixels of a `width × height` canvas,
 * with Photoshop's reading of them: a subpath with operation -1 joins the component before it; a
 * first component that subtracts starts from a full canvas, so the shape is `inverted` with the
 * later operations swapped for their duals (combine ↔ subtract; exclude is its own dual). The
 * block's invert flag inverts it again.
 */
export function componentsFromVectorBlock(data: Uint8Array, width: number, height: number): { components: ShapeComponent[]; inverted: boolean; flags: number } | null {
  const block = readVectorBlock(data);
  if (!block) return null;
  const pt = (p: { x: number; y: number }) => ({ x: p.x * width, y: p.y * height });
  const comps: Array<{ op: number; subpaths: VectorSubpath[] }> = [];
  for (const s of block.path.subpaths) {
    if (!s.knots.length) continue;
    const anchors: VectorAnchor[] = s.knots.map((k) => {
      const a = pt(k.anchor);
      const pre = pt(k.pre);
      const post = pt(k.post);
      const out: VectorAnchor = { x: a.x, y: a.y };
      if (pre.x !== a.x || pre.y !== a.y) out.in = pre;
      if (post.x !== a.x || post.y !== a.y) out.out = post;
      if (k.linked && (out.in || out.out)) out.type = 'smooth';
      return out;
    });
    const sp: VectorSubpath = { closed: s.closed, anchors };
    if (s.operation === -1 && comps.length) comps[comps.length - 1].subpaths.push(sp);
    else comps.push({ op: s.operation, subpaths: [sp] });
  }
  let inverted = comps.length ? comps[0].op === 2 : block.path.initialFill;
  const components: ShapeComponent[] = comps.map((c, i) => {
    let op = i === 0 ? 'combine' : OP_FROM_PSD(c.op);
    if (inverted && i > 0) op = op === 'combine' ? 'subtract' : op === 'subtract' ? 'combine' : op;
    return { op, subpaths: c.subpaths };
  });
  if (block.flags & VMSK_INVERT) inverted = !inverted;
  return { components, inverted, flags: block.flags };
}

/** A layer vector block for shape components (live corners cut; `inverted` as the invert flag). */
export function vectorBlockForComponents(components: readonly ShapeComponent[], inverted: boolean, width: number, height: number, flags = 0): Uint8Array {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const fr = (p: { x: number; y: number }) => ({ x: p.x / w, y: p.y / h });
  const subpaths: PsdSubpath[] = [];
  components.forEach((c, ci) => {
    expandVectorCorners(c.subpaths).forEach((sp, si) => {
      if (!sp.anchors.length) return;
      subpaths.push({
        closed: sp.closed,
        operation: si > 0 ? -1 : ci === 0 ? 1 : OP_TO_PSD[c.op],
        knots: sp.anchors.map((a) => ({
          linked: a.type === 'smooth' || a.type === 'symmetric',
          pre: fr(a.in ?? a),
          anchor: fr(a),
          post: fr(a.out ?? a),
        })),
      });
    });
  });
  return writeVectorBlock({ subpaths, initialFill: subpaths.length === 0 && inverted }, (flags & ~VMSK_INVERT) | (inverted && subpaths.length ? VMSK_INVERT : 0));
}
