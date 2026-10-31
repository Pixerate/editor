import type { SelectionMask } from './mask';

/**
 * The selection's outline at `threshold` (0..255, default 128) as axis-aligned segments on pixel
 * boundaries, `[x0, y0, x1, y1, …]` in natural image pixels, with collinear neighbours merged.
 * This is what marching ants are drawn from. Linear in the pixel count.
 */
export function selectionOutline(mask: SelectionMask, threshold = 128): Float32Array {
  const { width: w, height: h, data } = mask;
  const segs: number[] = [];
  if (!mask.bounds) return new Float32Array(0);
  const b = mask.bounds;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] >= threshold;
  // Horizontal boundaries: the line y separates rows y − 1 and y.
  for (let y = b.y; y <= b.y + b.height; y++) {
    let start = -1;
    for (let x = b.x; x <= b.x + b.width; x++) {
      const edge = x < b.x + b.width && inside(x, y - 1) !== inside(x, y);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        segs.push(start, y, x, y);
        start = -1;
      }
    }
  }
  // Vertical boundaries: the line x separates columns x − 1 and x.
  for (let x = b.x; x <= b.x + b.width; x++) {
    let start = -1;
    for (let y = b.y; y <= b.y + b.height; y++) {
      const edge = y < b.y + b.height && inside(x - 1, y) !== inside(x, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) {
        segs.push(x, start, x, y);
        start = -1;
      }
    }
  }
  return Float32Array.from(segs);
}

/**
 * The selection's outline (`selectionOutline`) joined into polylines, `[x0, y0, x1, y1, …]` each,
 * closed loops ending where they start. Marching ants are stroked from these, so the dash runs on
 * along a staircase edge instead of restarting at every one-pixel step (which made diagonal edges
 * flash rather than march). A loop may break where two pixels touch only at a corner.
 */
export function selectionOutlinePaths(mask: SelectionMask, threshold = 128): Float32Array[] {
  const segs = selectionOutline(mask, threshold);
  const n = segs.length / 4;
  if (!n) return [];
  const stride = mask.width + 1;
  const key = (x: number, y: number) => y * stride + x;
  const at = new Map<number, number[]>();
  for (let s = 0; s < n; s++) {
    for (const k of [key(segs[s * 4], segs[s * 4 + 1]), key(segs[s * 4 + 2], segs[s * 4 + 3])]) {
      const list = at.get(k);
      if (list) list.push(s);
      else at.set(k, [s]);
    }
  }
  const used = new Uint8Array(n);
  const paths: Float32Array[] = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const pts: number[] = [segs[s0 * 4], segs[s0 * 4 + 1], segs[s0 * 4 + 2], segs[s0 * 4 + 3]];
    // Walk on from the end, then back from the start, so an open run is joined whole.
    for (const forward of [true, false]) {
      for (;;) {
        const x = forward ? pts[pts.length - 2] : pts[0];
        const y = forward ? pts[pts.length - 1] : pts[1];
        const next = at.get(key(x, y))?.find((t) => !used[t]);
        if (next === undefined) break;
        used[next] = 1;
        const a = [segs[next * 4], segs[next * 4 + 1]];
        const b = [segs[next * 4 + 2], segs[next * 4 + 3]];
        const far = a[0] === x && a[1] === y ? b : a;
        if (forward) pts.push(far[0], far[1]);
        else pts.unshift(far[0], far[1]);
      }
    }
    paths.push(Float32Array.from(pts));
  }
  return paths;
}

export interface QuickMaskStyle {
  /** Overlay colour, `[r, g, b]` 0..255 (default Photoshop's rubylith red). */
  color?: readonly [number, number, number];
  /** 0..1 (default 0.5): opacity over fully unselected pixels. */
  opacity?: number;
  /** Tint the unselected area (`masked`, default) or the selected area (`selected`). */
  indicates?: 'masked' | 'selected';
}

/**
 * Quick Mask view: RGBA pixels (natural image size) tinting the *unselected* area, so the
 * selection shows through clear, as Photoshop's rubylith overlay.
 */
export function quickMaskPixels(mask: SelectionMask, style: QuickMaskStyle = {}): Uint8ClampedArray {
  const [r, g, b] = style.color ?? [255, 0, 0];
  const k = Math.min(1, Math.max(0, style.opacity ?? 0.5));
  const selected = style.indicates === 'selected';
  const out = new Uint8ClampedArray(mask.data.length * 4);
  for (let i = 0, p = 0; i < mask.data.length; i++, p += 4) {
    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
    out[p + 3] = Math.round((selected ? mask.data[i] : 255 - mask.data[i]) * k);
  }
  return out;
}

/** How often marching ants step (ms); each step moves the dashes one screen pixel. */
export const MARCHING_ANTS_STEP_MS = 100;

/** Whether the viewer asked for reduced motion (`prefers-reduced-motion: reduce`). */
function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Marches the ants: calls `tick` with the next `RenderOptions.antsOffset` every `stepMs` until the
 * returned stop function is called. Hosts run it while a selection is shown and render on each
 * tick. With reduced motion requested the ants stand still and `tick` is never called.
 */
export function startMarchingAnts(tick: (offset: number) => void, stepMs = MARCHING_ANTS_STEP_MS): () => void {
  if (prefersReducedMotion()) return () => {};
  let offset = 0;
  const id = setInterval(() => {
    // The dash pattern repeats every 8 screen pixels (4 on, 4 off).
    offset = (offset + 1) % 8;
    tick(offset);
  }, stepMs);
  return () => clearInterval(id);
}
