/**
 * Max-flow / min-cut on a 4-connected pixel grid (Boykov & Kolmogorov, "An Experimental
 * Comparison of Min-Cut/Max-Flow Algorithms for Energy Minimization in Vision", 2004): two search
 * trees grown from the source and the sink, reused between augmentations. The graph segmentations
 * (Quick Selection, Object Selection) label each pixel by the side of the cut it ends up on.
 */

const TERMINAL = -2;
const NONE = -1;
const FREE = 0;
const SOURCE = 1;
const SINK = 2;

/**
 * A `width × height` grid graph. Each node has an edge to its right, lower, left and upper
 * neighbour (directions 0..3; the reverse of `d` is `d ^ 2`) and a terminal capacity. Use whole
 * numbers for capacities: with fractions, rounding leaves residuals a hair above zero and the
 * search slows to a crawl on near-empty paths.
 */
export class GridGraph {
  readonly width: number;
  readonly height: number;
  /** Residual capacity of the edge leaving node `p` in direction `d`, at `p * 4 + d`. */
  readonly cap: Float64Array;
  /** Net terminal capacity: above 0 to the source, below 0 to the sink. */
  readonly tr: Float64Array;
  private readonly tree: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.cap = new Float64Array(n * 4);
    this.tr = new Float64Array(n);
    this.tree = new Uint8Array(n);
  }

  /** Sets the capacity of the edge between `p` and its neighbour in direction `d`, both ways. */
  setEdge(p: number, d: 0 | 1, capacity: number): void {
    const q = d === 0 ? p + 1 : p + this.width;
    this.cap[p * 4 + d] = capacity;
    this.cap[q * 4 + (d ^ 2)] = capacity;
  }

  /** Adds `source` (cost of putting `p` on the sink side) and `sink` (the other way) to `p`. */
  addTerminal(p: number, source: number, sink: number): void {
    this.tr[p] += source - sink;
  }

  /** Whether `p` is on the source side of the minimum cut (after {@link maxflow}). */
  inSource(p: number): boolean {
    return this.tree[p] === SOURCE;
  }

  /** Runs max-flow and returns the flow (the cut's cost, less the constant terminal parts). */
  maxflow(): number {
    const { width: w, height: h, cap, tr, tree } = this;
    const n = w * h;
    const nb = (p: number, d: number): number => {
      const x = p % w;
      if (d === 0) return x < w - 1 ? p + 1 : -1;
      if (d === 1) return p + w < n ? p + w : -1;
      if (d === 2) return x > 0 ? p - 1 : -1;
      return p - w >= 0 ? p - w : -1;
    };
    const parent = new Int8Array(n).fill(NONE);
    const ts = new Int32Array(n);
    const dist = new Int32Array(n);
    const queue = new Int32Array(n + 1);
    const queued = new Uint8Array(n);
    let qHead = 0;
    let qTail = 0;
    const activate = (p: number) => {
      if (queued[p]) return;
      queued[p] = 1;
      queue[qTail] = p;
      qTail = qTail === n ? 0 : qTail + 1;
    };
    const nextActive = (): number => {
      while (qHead !== qTail) {
        const p = queue[qHead];
        qHead = qHead === n ? 0 : qHead + 1;
        queued[p] = 0;
        if (tree[p] !== FREE) return p;
      }
      return -1;
    };
    let orphans = new Int32Array(64);
    let orphanCount = 0;
    const orphan = (p: number) => {
      parent[p] = NONE;
      if (orphanCount === orphans.length) {
        const grown = new Int32Array(orphans.length * 2);
        grown.set(orphans);
        orphans = grown;
      }
      orphans[orphanCount++] = p;
    };

    tree.fill(FREE);
    for (let p = 0; p < n; p++) {
      if (tr[p] > 0) tree[p] = SOURCE;
      else if (tr[p] < 0) tree[p] = SINK;
      else continue;
      parent[p] = TERMINAL;
      dist[p] = 1;
      activate(p);
    }

    let flow = 0;
    let time = 0;
    let current = -1;
    for (;;) {
      if (current < 0 || tree[current] === FREE) {
        current = nextActive();
        if (current < 0) break;
      }
      const p = current;
      const side = tree[p];
      // Grow the tree from p until it meets the other tree.
      let s = -1;
      let t = -1;
      let dir = 0;
      for (let d = 0; d < 4; d++) {
        const q = nb(p, d);
        if (q < 0) continue;
        if (side === SOURCE ? cap[p * 4 + d] <= 0 : cap[q * 4 + (d ^ 2)] <= 0) continue;
        if (tree[q] === FREE) {
          tree[q] = side;
          parent[q] = d ^ 2;
          ts[q] = ts[p];
          dist[q] = dist[p] + 1;
          activate(q);
        } else if (tree[q] !== side) {
          if (side === SOURCE) {
            s = p;
            t = q;
            dir = d;
          } else {
            s = q;
            t = p;
            dir = d ^ 2;
          }
          break;
        } else if (ts[q] <= ts[p] && dist[q] > dist[p]) {
          parent[q] = d ^ 2;
          ts[q] = ts[p];
          dist[q] = dist[p] + 1;
        }
      }
      if (s < 0) {
        current = -1;
        continue;
      }
      time++;

      // Augment along source → s → t → sink by the bottleneck.
      let f = cap[s * 4 + dir];
      for (let x = s; ; ) {
        const a = parent[x];
        if (a === TERMINAL) {
          f = Math.min(f, tr[x]);
          break;
        }
        const up = nb(x, a);
        f = Math.min(f, cap[up * 4 + (a ^ 2)]);
        x = up;
      }
      for (let x = t; ; ) {
        const a = parent[x];
        if (a === TERMINAL) {
          f = Math.min(f, -tr[x]);
          break;
        }
        f = Math.min(f, cap[x * 4 + a]);
        x = nb(x, a);
      }
      cap[s * 4 + dir] -= f;
      cap[t * 4 + (dir ^ 2)] += f;
      for (let x = s; ; ) {
        const a = parent[x];
        if (a === TERMINAL) {
          tr[x] -= f;
          if (tr[x] <= 0) orphan(x);
          break;
        }
        const up = nb(x, a);
        cap[up * 4 + (a ^ 2)] -= f;
        cap[x * 4 + a] += f;
        if (cap[up * 4 + (a ^ 2)] <= 0) orphan(x);
        x = up;
      }
      for (let x = t; ; ) {
        const a = parent[x];
        if (a === TERMINAL) {
          tr[x] += f;
          if (tr[x] >= 0) orphan(x);
          break;
        }
        const up = nb(x, a);
        cap[x * 4 + a] -= f;
        cap[up * 4 + (a ^ 2)] += f;
        if (cap[x * 4 + a] <= 0) orphan(x);
        x = up;
      }
      flow += f;

      // Adopt the orphans: a new parent in the same tree that still reaches its terminal, or free them.
      while (orphanCount) {
        const o = orphans[--orphanCount];
        const oSide = tree[o];
        let best = NONE;
        let bestDist = Infinity;
        for (let d = 0; d < 4; d++) {
          const q = nb(o, d);
          if (q < 0 || tree[q] !== oSide) continue;
          if (oSide === SOURCE ? cap[q * 4 + (d ^ 2)] <= 0 : cap[o * 4 + d] <= 0) continue;
          let k = 0;
          let x = q;
          for (;;) {
            if (ts[x] === time) {
              k += dist[x];
              break;
            }
            const a = parent[x];
            k++;
            if (a === TERMINAL) {
              ts[x] = time;
              dist[x] = 1;
              break;
            }
            if (a === NONE) {
              k = Infinity;
              break;
            }
            x = nb(x, a);
          }
          if (k === Infinity) continue;
          if (k < bestDist) {
            bestDist = k;
            best = d;
          }
          // Mark the path so later searches stop early.
          for (let y = q, dd = k; ts[y] !== time; y = nb(y, parent[y]), dd--) {
            ts[y] = time;
            dist[y] = dd;
          }
        }
        if (best !== NONE) {
          parent[o] = best;
          ts[o] = time;
          dist[o] = bestDist + 1;
          continue;
        }
        for (let d = 0; d < 4; d++) {
          const q = nb(o, d);
          if (q < 0 || tree[q] !== oSide) continue;
          if (oSide === SOURCE ? cap[q * 4 + (d ^ 2)] > 0 : cap[o * 4 + d] > 0) activate(q);
          const a = parent[q];
          if (a !== TERMINAL && a !== NONE && nb(q, a) === o) orphan(q);
        }
        tree[o] = FREE;
      }
    }
    return flow;
  }
}
