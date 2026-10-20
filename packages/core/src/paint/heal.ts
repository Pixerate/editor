// Portions ported from photocraft/crates/algo/src/poisson.rs and inpaint.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Gradient-domain ("Poisson") blending for the Healing Brush and the Spot Healing Brush.
 *
 * Method: P. Pérez, M. Gangnet, A. Blake, *Poisson Image Editing*, SIGGRAPH 2003. Seamless cloning
 * looks for `f` over a region Ω with `f = f*` (the destination) on its boundary and `∇f` as close
 * as possible to the source's `∇g`. The answer is `f = g + h`, where `h` is the membrane: the
 * harmonic function (`Δh = 0`) that equals `f* − g` on the boundary. So healed pixels keep the
 * source's texture while their colour and lighting are pulled to the pixels around the stroke.
 *
 * The Laplace equation is solved on the 4-connected grid by successive over-relaxation, started
 * from a recursively solved half-resolution grid (cascadic multigrid). Harmonic functions are
 * smooth, so the coarse guess is close and a few sweeps per level remove the rest.
 *
 * Buffers are interleaved `w × h × ch` floats in any units (the callers use 0..255). Pure maths:
 * no DOM, no framework.
 */

/** Largest per-sweep update below which a solve has converged. */
const TOL = 2e-3;
/** Sweeps (cap) and relaxation on every level above the coarsest. */
const FINE_ITERS = 30;
const FINE_OMEGA = 1.7;

/**
 * Solves `Δv = 0` on the `unknown` pixels, with the known pixels of `v` as Dirichlet values
 * (neighbours off the grid are ignored: a free boundary). `v` holds the known values on entry and
 * the solution on exit.
 */
export function solveMembrane(w: number, h: number, unknown: ArrayLike<boolean | number>, v: Float32Array): void {
  if (unknown.length !== w * h || v.length !== w * h) throw new RangeError(`solveMembrane: expected ${w * h} cells, got ${unknown.length} and ${v.length}.`);
  const u = new Uint8Array(w * h);
  for (let i = 0; i < u.length; i++) u[i] = unknown[i] ? 1 : 0;
  solveLevel(w, h, u, v, 0);
}

function solveLevel(w: number, h: number, unknown: Uint8Array, v: Float32Array, depth: number): void {
  let nUnknown = 0;
  let knownSum = 0;
  let nKnown = 0;
  for (let i = 0; i < unknown.length; i++) {
    if (unknown[i]) nUnknown++;
    else {
      knownSum += v[i];
      nKnown++;
    }
  }
  if (nUnknown === 0 || nKnown === 0) return;
  if (w >= 8 && h >= 8 && nUnknown > 64 && depth < 16) {
    // Restrict: a coarse cell is known when any of its children is (the mean of those).
    const cw = Math.ceil(w / 2);
    const chh = Math.ceil(h / 2);
    const cu = new Uint8Array(cw * chh).fill(1);
    const cv = new Float32Array(cw * chh);
    for (let cy = 0; cy < chh; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        let s = 0;
        let n = 0;
        for (let k = 0; k < 4; k++) {
          const x = cx * 2 + (k & 1);
          const y = cy * 2 + (k >> 1);
          if (x < w && y < h && !unknown[y * w + x]) {
            s += v[y * w + x];
            n++;
          }
        }
        if (n > 0) {
          cu[cy * cw + cx] = 0;
          cv[cy * cw + cx] = s / n;
        }
      }
    }
    solveLevel(cw, chh, cu, cv, depth + 1);
    // Prolong: a bilinear sample of the coarse solution is the starting guess.
    for (let y = 0; y < h; y++) {
      const fy = Math.min(chh - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(chh - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < w; x++) {
        if (!unknown[y * w + x]) continue;
        const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(cw - 1, x0 + 1);
        const tx = fx - x0;
        const a = cv[y0 * cw + x0] + (cv[y0 * cw + x1] - cv[y0 * cw + x0]) * tx;
        const b = cv[y1 * cw + x0] + (cv[y1 * cw + x1] - cv[y1 * cw + x0]) * tx;
        v[y * w + x] = a + (b - a) * ty;
      }
    }
    sor(w, h, unknown, v, FINE_ITERS, FINE_OMEGA);
  } else {
    const mean = knownSum / nKnown;
    for (let i = 0; i < v.length; i++) if (unknown[i]) v[i] = mean;
    sor(w, h, unknown, v, 2000, 1.85);
  }
}

/** Over-relaxed Gauss-Seidel sweeps over the unknown cells until the largest update is below `TOL`. */
function sor(w: number, h: number, unknown: Uint8Array, v: Float32Array, maxIter: number, omega: number): void {
  let n = 0;
  for (let i = 0; i < unknown.length; i++) if (unknown[i]) n++;
  const cells = new Uint32Array(n);
  const masks = new Uint8Array(n);
  for (let i = 0, k = 0; i < unknown.length; i++) {
    if (!unknown[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    cells[k] = i;
    masks[k++] = (x > 0 ? 1 : 0) | (x + 1 < w ? 2 : 0) | (y > 0 ? 4 : 0) | (y + 1 < h ? 8 : 0);
  }
  for (let it = 0; it < maxIter; it++) {
    let maxD = 0;
    for (let k = 0; k < n; k++) {
      const i = cells[k];
      const m = masks[k];
      let s: number;
      let c: number;
      if (m === 15) {
        s = v[i - 1] + v[i + 1] + v[i - w] + v[i + w];
        c = 4;
      } else {
        s = 0;
        c = 0;
        if (m & 1) (s += v[i - 1]), c++;
        if (m & 2) (s += v[i + 1]), c++;
        if (m & 4) (s += v[i - w]), c++;
        if (m & 8) (s += v[i + w]), c++;
        if (c === 0) continue;
      }
      const d = omega * (s / c - v[i]);
      v[i] += d;
      const ad = d < 0 ? -d : d;
      if (ad > maxD) maxD = ad;
    }
    if (maxD < TOL) break;
  }
}

/**
 * Seamless cloning: `dst` outside `mask`; inside, `src` plus the membrane that removes the
 * mismatch at the mask's edge. So the result keeps the source's texture and takes the
 * destination's colour and light. `src` and `dst` are interleaved `w × h × ch`; leave a one-pixel
 * unmasked margin for a fully fixed boundary.
 */
export function seamlessClone(w: number, h: number, ch: number, src: ArrayLike<number>, dst: ArrayLike<number>, mask: ArrayLike<boolean | number>): Float32Array {
  const n = w * h;
  if (src.length !== n * ch || dst.length !== n * ch || mask.length !== n) throw new RangeError('seamlessClone: src, dst and mask must cover w × h pixels.');
  const out = new Float32Array(n * ch);
  const hv = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    for (let i = 0; i < n; i++) hv[i] = mask[i] ? 0 : dst[i * ch + c] - src[i * ch + c];
    solveMembrane(w, h, mask, hv);
    for (let i = 0; i < n; i++) out[i * ch + c] = mask[i] ? src[i * ch + c] + hv[i] : dst[i * ch + c];
  }
  return out;
}

/** Membrane fill (no source texture): the known pixels interpolated smoothly into `hole`. */
export function membraneFill(w: number, h: number, ch: number, img: ArrayLike<number>, hole: ArrayLike<boolean | number>): Float32Array {
  const n = w * h;
  const out = new Float32Array(n * ch);
  const v = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    for (let i = 0; i < n; i++) v[i] = hole[i] ? 0 : img[i * ch + c];
    solveMembrane(w, h, hole, v);
    for (let i = 0; i < n; i++) out[i * ch + c] = v[i];
  }
  return out;
}

/** A mask grown by `r` pixels (square structuring element). */
export function dilateMask(w: number, h: number, mask: ArrayLike<boolean | number>, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) tmp[y * w + xx] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!tmp[y * w + x]) continue;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) out[yy * w + x] = 1;
    }
  }
  return out;
}

/** A summed-area table over a mask, for "how many masked cells in this window". */
class MaskIntegral {
  private readonly s: Uint32Array;
  constructor(
    private readonly w: number,
    private readonly h: number,
    mask: ArrayLike<boolean | number>
  ) {
    const W = w + 1;
    this.s = new Uint32Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += mask[y * w + x] ? 1 : 0;
        this.s[(y + 1) * W + x + 1] = this.s[y * W + x + 1] + row;
      }
    }
  }
  /** Masked cells in [x0, x1) × [y0, y1) (clipped to the grid). */
  count(x0: number, y0: number, x1: number, y1: number): number {
    const W = this.w + 1;
    const a = Math.max(0, Math.min(this.w, x0));
    const b = Math.max(0, Math.min(this.h, y0));
    const c = Math.max(0, Math.min(this.w, x1));
    const d = Math.max(0, Math.min(this.h, y1));
    if (c <= a || d <= b) return 0;
    return this.s[d * W + c] - this.s[b * W + c] - this.s[d * W + a] + this.s[b * W + a];
  }
}

/** Bounding box [x0, y0, x1, y1) of the set cells, or null. */
export function maskBounds(w: number, h: number, mask: ArrayLike<boolean | number>): [number, number, number, number] | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/**
 * Proximity match: the translation `(dx, dy)` (within `maxRadius`) whose pixels best match the
 * ring of `ring` pixels around the hole (sum of squared differences), so `img[p + (dx, dy)]` can
 * fill `p` in the hole. The source window must lie on the grid and hold no hole pixels. Nearer
 * sources win ties. Returns null when no translation fits.
 */
export function bestOffset(w: number, h: number, ch: number, img: ArrayLike<number>, hole: ArrayLike<boolean | number>, ring: number, maxRadius: number): [number, number] | null {
  const bb = maskBounds(w, h, hole);
  if (!bb) return null;
  const extent = Math.max(w, h);
  const R = Math.max(0, Math.min(extent, Math.floor(maxRadius)));
  if (R === 0) return null;
  const rg = Math.max(1, Math.min(extent, Math.floor(ring)));
  const hs = new MaskIntegral(w, h, hole);
  const x0 = bb[0] - rg;
  const y0 = bb[1] - rg;
  const x1 = bb[2] + rg;
  const y1 = bb[3] + rg;
  // Sample points: the ring around the hole, subsampled to about 2000.
  const pts: number[] = [];
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      if (hole[y * w + x]) continue;
      if (hs.count(x - rg, y - rg, x + rg + 1, y + rg + 1) > 0) pts.push(x, y);
    }
  }
  const stride = Math.max(1, Math.floor(pts.length / 2 / 2000));
  const sx: number[] = [];
  const sy: number[] = [];
  for (let i = 0; i < pts.length; i += 2 * stride) {
    sx.push(pts[i]);
    sy.push(pts[i + 1]);
  }
  const n = Math.max(1, sx.length);
  const evalAt = (dx: number, dy: number, cutoff: number): number | null => {
    if (dx === 0 && dy === 0) return null;
    const hx0 = x0 + dx;
    const hy0 = y0 + dy;
    const hx1 = x1 + dx;
    const hy1 = y1 + dy;
    if (hx0 < 0 || hy0 < 0 || hx1 > w || hy1 > h) return null;
    if (hs.count(hx0, hy0, hx1, hy1) !== 0) return null;
    const penalty = 1 + 1e-3 * (Math.hypot(dx, dy) / R);
    let e = 0;
    for (let i = 0; i < sx.length; i++) {
      const a = (sy[i] * w + sx[i]) * ch;
      const b = ((sy[i] + dy) * w + sx[i] + dx) * ch;
      for (let c = 0; c < ch; c++) {
        const d = img[a + c] - img[b + c];
        e += d * d;
      }
      if ((i & 31) === 31 && (e / n) * penalty >= cutoff) return null;
    }
    return (e / n) * penalty;
  };
  const found: { best: [number, number] | null; e: number } = { best: null, e: Infinity };
  const consider = (dx: number, dy: number) => {
    const e = evalAt(dx, dy, found.e);
    if (e !== null && e < found.e) {
      found.e = e;
      found.best = [dx, dy];
    }
  };
  // A coarse grid over the search window, then every offset around the winner.
  const step = Math.max(1, Math.floor(R / 24));
  for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) consider(dx, dy);
  if (step > 1 && found.best) {
    const [bx, by] = found.best;
    for (let dy = by - step; dy <= by + step; dy++) for (let dx = bx - step; dx <= bx + step; dx++) consider(dx, dy);
  }
  return found.best;
}

// ---------------------------------------------------------------------------
// Content-aware fill (PatchMatch, coarse to fine)
// ---------------------------------------------------------------------------

const PATCH_R = 3;

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Level {
  w: number;
  h: number;
  img: Float32Array;
  hole: Uint8Array;
}

/** Half-size level: known pixels averaged, a block is hole when any of it is. */
function downsample(l: Level, ch: number): Level {
  const w = Math.max(1, l.w >> 1);
  const h = Math.max(1, l.h >> 1);
  const img = new Float32Array(w * h * ch);
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      const o = (y * w + x) * ch;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(l.w - 1, 2 * x + dx);
          const sy = Math.min(l.h - 1, 2 * y + dy);
          const i = sy * l.w + sx;
          if (l.hole[i]) {
            hole[y * w + x] = 1;
            continue;
          }
          for (let c = 0; c < ch; c++) img[o + c] += l.img[i * ch + c];
          n++;
        }
      }
      if (n) for (let c = 0; c < ch; c++) img[o + c] /= n;
    }
  }
  return { w, h, img, hole };
}

/**
 * Fills `hole` in `img` (`w × h × ch` floats) from the rest of the image, so texture and edges
 * continue across it: PatchMatch nearest-neighbour fields over 7 × 7 patches with patch voting
 * (Wexler et al. / Barnes et al.), run coarse to fine from a smooth fill. Deterministic for the
 * same input. Returns the filled image; pixels outside `hole` are unchanged. Falls back to a
 * smooth fill when there is no whole patch to copy from.
 */
export function contentAwareFill(w: number, h: number, ch: number, img: ArrayLike<number>, hole: ArrayLike<boolean | number>, options: { iterations?: number; seed?: number } = {}): Float32Array {
  const iters = options.iterations ?? 4;
  const base: Level = { w, h, img: Float32Array.from(img), hole: Uint8Array.from(hole as ArrayLike<number>, (v) => (v ? 1 : 0)) };
  const levels: Level[] = [base];
  // Coarser levels while the hole is still more than a couple of patches across.
  while (levels.length < 4) {
    const top = levels[levels.length - 1];
    const b = maskBounds(top.w, top.h, top.hole);
    if (!b || Math.max(b[2] - b[0], b[3] - b[1]) < 4 * PATCH_R || top.w < 8 * PATCH_R || top.h < 8 * PATCH_R) break;
    levels.push(downsample(top, ch));
  }
  const random = rng(options.seed ?? w * 73856093 + h * 19349663);
  let prevFill: Float32Array | null = null;
  let prevNnf: Int32Array | null = null;
  let prevW = 0;
  for (let li = levels.length - 1; li >= 0; li--) {
    const { w: W, h: H, hole: holeL } = levels[li];
    const cur = new Float32Array(levels[li].img);
    // Start: the coarser fill scaled up, or a smooth fill at the coarsest level.
    if (prevFill) {
      for (let i = 0; i < W * H; i++) {
        if (!holeL[i]) continue;
        const x = Math.min(prevW - 1, (i % W) >> 1);
        const y = Math.min(Math.floor(prevFill.length / ch / prevW) - 1, Math.floor(i / W) >> 1);
        for (let c = 0; c < ch; c++) cur[i * ch + c] = prevFill[(y * prevW + x) * ch + c];
      }
    } else cur.set(membraneFill(W, H, ch, cur, holeL));
    // Valid sources: whole patches with no hole in them.
    const blocked = dilateMask(W, H, holeL, PATCH_R);
    const valid: number[] = [];
    for (let y = PATCH_R; y < H - PATCH_R; y++) for (let x = PATCH_R; x < W - PATCH_R; x++) if (!blocked[y * W + x]) valid.push(y * W + x);
    if (!valid.length) {
      prevFill = cur;
      prevNnf = null;
      prevW = W;
      continue;
    }
    // Targets: patch centres whose patch touches the hole (kept inside the image).
    const targets: number[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (blocked[y * W + x]) targets.push(y * W + x);
    const nnf = new Int32Array(W * H).fill(-1);
    const cost = new Float64Array(W * H);
    const clampC = (v: number, n: number) => Math.min(n - 1 - PATCH_R, Math.max(PATCH_R, v));
    const dist = (t: number, s: number, limit: number) => {
      const tx = clampC(t % W, W);
      const ty = clampC(Math.floor(t / W), H);
      const sx = s % W;
      const sy = Math.floor(s / W);
      let d = 0;
      for (let dy = -PATCH_R; dy <= PATCH_R; dy++) {
        const tr = (ty + dy) * W;
        const sr = (sy + dy) * W;
        for (let dx = -PATCH_R; dx <= PATCH_R; dx++) {
          const a = (tr + tx + dx) * ch;
          const b = (sr + sx + dx) * ch;
          for (let c = 0; c < ch; c++) {
            const e = cur[a + c] - cur[b + c];
            d += e * e;
          }
        }
        if (d >= limit) return d;
      }
      return d;
    };
    const isValid = (s: number) => {
      const x = s % W;
      const y = Math.floor(s / W);
      return s >= 0 && x >= PATCH_R && y >= PATCH_R && x < W - PATCH_R && y < H - PATCH_R && !blocked[s];
    };
    for (const t of targets) {
      let s = -1;
      if (prevNnf) {
        const px = Math.min(prevW - 1, (t % W) >> 1);
        const py = Math.floor(t / W) >> 1;
        const ps = prevNnf[py * prevW + px];
        if (ps >= 0) {
          const cand = (Math.floor(ps / prevW) * 2 + (Math.floor(t / W) & 1)) * W + (ps % prevW) * 2 + ((t % W) & 1);
          if (isValid(cand)) s = cand;
        }
      }
      if (s < 0) s = valid[Math.floor(random() * valid.length)];
      nnf[t] = s;
    }
    for (let em = 0; em < iters; em++) {
      for (const t of targets) cost[t] = dist(t, nnf[t], Infinity);
      for (let pass = 0; pass < 4; pass++) {
        const fwd = pass % 2 === 0;
        const step = fwd ? 1 : -1;
        for (let k = 0; k < targets.length; k++) {
          const t = targets[fwd ? k : targets.length - 1 - k];
          const tx = t % W;
          const ty = Math.floor(t / W);
          // Propagation: a neighbour's match, shifted by one.
          for (const [nx, ny] of [[tx - step, ty], [tx, ty - step]]) {
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ns = nnf[ny * W + nx];
            if (ns < 0) continue;
            const cand = ns + step * (nx === tx ? W : 1);
            if (!isValid(cand) || cand === nnf[t]) continue;
            const d = dist(t, cand, cost[t]);
            if (d < cost[t]) {
              cost[t] = d;
              nnf[t] = cand;
            }
          }
          // Random search in shrinking windows around the current match.
          const bx = nnf[t] % W;
          const by = Math.floor(nnf[t] / W);
          for (let r = Math.max(W, H); r >= 1; r >>= 1) {
            const cx = Math.round(bx + (random() * 2 - 1) * r);
            const cy = Math.round(by + (random() * 2 - 1) * r);
            const cand = cy * W + cx;
            if (cx < 0 || cy < 0 || cx >= W || cy >= H || !isValid(cand)) continue;
            const d = dist(t, cand, cost[t]);
            if (d < cost[t]) {
              cost[t] = d;
              nnf[t] = cand;
            }
          }
        }
      }
      // Voting: each hole pixel averages what the patches covering it propose.
      const acc = new Float64Array(W * H * ch);
      const wsum = new Float64Array(W * H);
      for (const t of targets) {
        const tx = clampC(t % W, W);
        const ty = clampC(Math.floor(t / W), H);
        const s = nnf[t];
        const sx = s % W;
        const sy = Math.floor(s / W);
        for (let dy = -PATCH_R; dy <= PATCH_R; dy++) {
          for (let dx = -PATCH_R; dx <= PATCH_R; dx++) {
            const q = (ty + dy) * W + tx + dx;
            if (!holeL[q]) continue;
            const src = ((sy + dy) * W + sx + dx) * ch;
            for (let c = 0; c < ch; c++) acc[q * ch + c] += cur[src + c];
            wsum[q] += 1;
          }
        }
      }
      for (let q = 0; q < W * H; q++) if (holeL[q] && wsum[q] > 0) for (let c = 0; c < ch; c++) cur[q * ch + c] = acc[q * ch + c] / wsum[q];
    }
    prevFill = cur;
    prevNnf = nnf;
    prevW = W;
  }
  const out = Float32Array.from(img);
  for (let i = 0; i < w * h; i++) if (base.hole[i]) for (let c = 0; c < ch; c++) out[i * ch + c] = prevFill![i * ch + c];
  return out;
}
