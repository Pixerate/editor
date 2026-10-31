/**
 * Hybrid vector masks: a vector mask whose segments each have an edge mode. Hard segments are
 * the path's own anti-aliased edge; feather segments blur across the curve; matte segments solve
 * a corridor between two rails (inside by `inner`, outside by `outer`) from the layer's pixels
 * with the colour-guided filter, so hair and fur keep their detail while the rest stays sharp.
 * Where modes meet, they blend over a few pixels so there is no seam. Rendered on demand from
 * the path and the pixels, and cached with the layer like any vector mask.
 */

import type { ShapeComponent, VectorMask, VectorMaskEdge } from './model';
import { gaussianBlur } from '../../raster/blur';
import { segmentPoint } from '../../canvas/pathops/bezier';
import { subpathSegment, subpathSegmentCount } from '../../vector/geometry';
import { guidedFilterColor } from '../selection/refine';

export type VectorMaskEdgeMode = 'hard' | 'feather' | 'matte';

/** Defaults for a segment switched to a soft mode. */
export const VECTOR_MASK_EDGE_DEFAULTS = { radius: 4, inner: 4, outer: 8 } as const;

/** Pixels over which edge modes blend where they meet. */
const JOIN_SIGMA = 2;

/** The segments of a vector mask's path as `{ component, subpath, segment }` triples. */
export function vectorMaskSegments(components: readonly ShapeComponent[]): Array<{ component: number; subpath: number; segment: number }> {
  const out: Array<{ component: number; subpath: number; segment: number }> = [];
  components.forEach((c, ci) => c.subpaths.forEach((sp, si) => {
    for (let k = 0; k < subpathSegmentCount(sp); k++) out.push({ component: ci, subpath: si, segment: k });
  }));
  return out;
}

/** Edges whose segment still exists in `components` (after the path was edited). */
export function validVectorMaskEdges(edges: readonly VectorMaskEdge[] | undefined, components: readonly ShapeComponent[]): VectorMaskEdge[] {
  if (!edges?.length) return [];
  return edges.filter((e) => {
    const sp = components[e.component]?.subpaths[e.subpath];
    return Boolean(sp) && e.segment >= 0 && e.segment < subpathSegmentCount(sp!);
  });
}

/** How far (px) an edge reaches from its segment. */
function reach(e: VectorMaskEdge): number {
  return e.mode === 'feather' ? 3 * (e.radius ?? VECTOR_MASK_EDGE_DEFAULTS.radius) : Math.max(e.inner ?? VECTOR_MASK_EDGE_DEFAULTS.inner, e.outer ?? VECTOR_MASK_EDGE_DEFAULTS.outer);
}

/**
 * The hybrid coverage (0..1, `width × height`) from the path's hard coverage `hard` (as
 * `componentsCoverage` gives it, before the mask's own feather and density) and the soft
 * `edges`. `guide` is the layer's RGBA over the canvas, for matte corridors; without one a matte
 * segment is feathered instead. Returns `hard` itself when no edge is soft.
 */
export function hybridVectorMaskCoverage(vm: Pick<VectorMask, 'components' | 'edges'>, hard: Float32Array, width: number, height: number, guide: ArrayLike<number> | null): Float32Array {
  const edges = validVectorMaskEdges(vm.edges, vm.components).filter((e) => e.mode !== 'hard');
  if (!edges.length) return hard;
  // Classes: 0 hard, then one per distinct soft setting.
  const classKey = (e: VectorMaskEdge) => (e.mode === 'feather' ? `f:${e.radius ?? VECTOR_MASK_EDGE_DEFAULTS.radius}` : `m:${e.inner ?? VECTOR_MASK_EDGE_DEFAULTS.inner}:${e.outer ?? VECTOR_MASK_EDGE_DEFAULTS.outer}`);
  const classes: Array<{ key: string; edge: VectorMaskEdge | null }> = [{ key: 'hard', edge: null }];
  const classOfEdge = new Map<string, number>();
  for (const e of edges) {
    const k = classKey(e);
    if (!classes.some((c) => c.key === k)) classes.push({ key: k, edge: e });
    classOfEdge.set(`${e.component}:${e.subpath}:${e.segment}`, classes.findIndex((c) => c.key === k));
  }
  const maxReach = Math.max(...edges.map(reach)) + 3 * JOIN_SIGMA + 2;
  // Seeds: points every half pixel along every segment, labelled with the segment's class.
  const seedX: number[] = [];
  const seedY: number[] = [];
  const seedClass: number[] = [];
  vm.components.forEach((c, ci) =>
    c.subpaths.forEach((sp, si) => {
      for (let k = 0; k < subpathSegmentCount(sp); k++) {
        const seg = subpathSegment(sp, k);
        let len = 0;
        for (let i = 1; i < seg.length; i++) len += Math.hypot(seg[i][0] - seg[i - 1][0], seg[i][1] - seg[i - 1][1]);
        const steps = Math.max(2, Math.ceil(len * 2));
        const cls = classOfEdge.get(`${ci}:${si}:${k}`) ?? 0;
        for (let s = 0; s <= steps; s++) {
          const [x, y] = segmentPoint(seg, s / steps);
          seedX.push(x);
          seedY.push(y);
          seedClass.push(cls);
        }
      }
    })
  );
  if (!seedX.length) return hard;
  // Work in the band around the path (a loop: long paths have too many seeds to spread).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < seedX.length; i++) {
    if (seedX[i] < minX) minX = seedX[i];
    if (seedX[i] > maxX) maxX = seedX[i];
    if (seedY[i] < minY) minY = seedY[i];
    if (seedY[i] > maxY) maxY = seedY[i];
  }
  const x0 = Math.max(0, Math.floor(minX - maxReach));
  const y0 = Math.max(0, Math.floor(minY - maxReach));
  const x1 = Math.min(width, Math.ceil(maxX + maxReach) + 1);
  const y1 = Math.min(height, Math.ceil(maxY + maxReach) + 1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 1 || h < 1) return hard;
  const n = w * h;
  // Chamfer distance to the path, carrying the nearest seed's class.
  const dist = new Float32Array(n).fill(Infinity);
  const cls = new Int16Array(n);
  for (let i = 0; i < seedX.length; i++) {
    const x = Math.round(seedX[i]) - x0;
    const y = Math.round(seedY[i]) - y0;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const k = y * w + x;
    const d = Math.hypot(seedX[i] - (x + x0), seedY[i] - (y + y0));
    if (d < dist[k]) {
      dist[k] = d;
      cls[k] = seedClass[i];
    }
  }
  const D = Math.SQRT2;
  const relax = (k: number, j: number, step: number) => {
    const d = dist[j] + step;
    if (d < dist[k]) {
      dist[k] = d;
      cls[k] = cls[j];
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (x > 0) relax(k, k - 1, 1);
      if (y > 0) {
        relax(k, k - w, 1);
        if (x > 0) relax(k, k - w - 1, D);
        if (x < w - 1) relax(k, k - w + 1, D);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const k = y * w + x;
      if (x < w - 1) relax(k, k + 1, 1);
      if (y < h - 1) {
        relax(k, k + w, 1);
        if (x < w - 1) relax(k, k + w + 1, D);
        if (x > 0) relax(k, k + w - 1, D);
      }
    }
  }
  // Solve tile by tile, only where the band is: blurs and the guided filter are the cost, and the
  // band is a thin ribbon along the path however large its bounds. Each tile is padded by what
  // its filters read, so tiles join without seams.
  const out = Float32Array.from(hard);
  const pad = maxReach + 3 * JOIN_SIGMA + 2;
  const T = 128;
  for (let ty = 0; ty < h; ty += T) {
    for (let tx = 0; tx < w; tx += T) {
      const tw = Math.min(T, w - tx);
      const th = Math.min(T, h - ty);
      let active = false;
      for (let y = ty; y < ty + th && !active; y++) for (let x = tx; x < tx + tw; x++) if (dist[y * w + x] <= maxReach) { active = true; break; }
      if (!active) continue;
      const px0 = Math.max(0, tx - pad);
      const py0 = Math.max(0, ty - pad);
      const px1 = Math.min(w, tx + tw + pad);
      const py1 = Math.min(h, ty + th + pad);
      const result = solveTile(px0, py0, px1 - px0, py1 - py0);
      for (let y = ty; y < ty + th; y++) {
        for (let x = tx; x < tx + tw; x++) {
          const k = y * w + x;
          if (dist[k] > maxReach + 3 * JOIN_SIGMA) continue;
          const v = result[(y - py0) * (px1 - px0) + (x - px0)];
          if (!Number.isNaN(v)) out[(y + y0) * width + x + x0] = v;
        }
      }
    }
  }
  return out;

  /** Hybrid coverage over the band-space rectangle (`bx`, `by`, `bw` × `bh`); NaN where no class weighs in. */
  function solveTile(bx: number, by: number, bw: number, bh: number): Float32Array {
    const m = bw * bh;
    const at = (x: number, y: number) => (by + y) * w + bx + x;
    const Ht = new Float32Array(m);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) Ht[y * bw + x] = hard[(by + y + y0) * width + bx + x + x0];
    const total = new Float32Array(m);
    const blended = new Float32Array(m);
    let guidePlanes: [Float32Array, Float32Array, Float32Array] | null = null;
    const planes = (): [Float32Array, Float32Array, Float32Array] => {
      if (guidePlanes) return guidePlanes;
      const p: [Float32Array, Float32Array, Float32Array] = [new Float32Array(m), new Float32Array(m), new Float32Array(m)];
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const s = ((by + y + y0) * width + bx + x + x0) * 4;
          const a = guide![s + 3] / 255;
          for (let c = 0; c < 3; c++) p[c][y * bw + x] = (guide![s + c] / 255) * a;
        }
      }
      return (guidePlanes = p);
    };
    for (let c = 0; c < classes.length; c++) {
      let weight: Float32Array = new Float32Array(m);
      let any = false;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const k = at(x, y);
          // Beyond every soft edge's reach the path is hard.
          const mine = dist[k] <= maxReach ? cls[k] === c : c === 0;
          if (mine) {
            weight[y * bw + x] = 1;
            any = true;
          }
        }
      }
      if (!any) continue;
      weight = gaussianBlur(weight, bw, bh, JOIN_SIGMA, 'clamp') as Float32Array;
      const e = classes[c].edge;
      let cov: Float32Array;
      if (!e) cov = Ht;
      else if (e.mode === 'feather' || !guide) {
        const sigma = e.mode === 'feather' ? (e.radius ?? VECTOR_MASK_EDGE_DEFAULTS.radius) : ((e.inner ?? VECTOR_MASK_EDGE_DEFAULTS.inner) + (e.outer ?? VECTOR_MASK_EDGE_DEFAULTS.outer)) / 3;
        cov = gaussianBlur(Ht, bw, bh, sigma, 'clamp') as Float32Array;
      } else {
        // Matte: inside `inner` and outside `outer` are sure; between them the guided filter
        // estimates coverage from the colours, so the edge follows the image's own detail.
        const inner = e.inner ?? VECTOR_MASK_EDGE_DEFAULTS.inner;
        const outer = e.outer ?? VECTOR_MASK_EDGE_DEFAULTS.outer;
        const r = Math.max(2, Math.round((inner + outer) / 2));
        const q = guidedFilterColor(planes(), Ht, bw, bh, r);
        cov = new Float32Array(m);
        for (let y = 0; y < bh; y++) {
          for (let x = 0; x < bw; x++) {
            const i = y * bw + x;
            const inside = Ht[i] >= 0.5;
            const d = dist[at(x, y)];
            const unknown = inside ? d <= inner : d <= outer;
            cov[i] = unknown ? Math.min(1, Math.max(0, q[i])) : inside ? 1 : 0;
          }
        }
      }
      for (let i = 0; i < m; i++) {
        total[i] += weight[i];
        blended[i] += weight[i] * cov[i];
      }
    }
    const res = new Float32Array(m);
    for (let i = 0; i < m; i++) res[i] = total[i] > 0 ? blended[i] / total[i] : NaN;
    return res;
  }
}
