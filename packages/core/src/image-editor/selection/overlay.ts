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

export interface QuickMaskStyle {
  /** Overlay colour, `[r, g, b]` 0..255 (default Photoshop's rubylith red). */
  color?: readonly [number, number, number];
  /** 0..1 (default 0.5): opacity over fully unselected pixels. */
  opacity?: number;
}

/**
 * Quick Mask view: RGBA pixels (natural image size) tinting the *unselected* area, so the
 * selection shows through clear, as Photoshop's rubylith overlay.
 */
export function quickMaskPixels(mask: SelectionMask, style: QuickMaskStyle = {}): Uint8ClampedArray {
  const [r, g, b] = style.color ?? [255, 0, 0];
  const k = Math.min(1, Math.max(0, style.opacity ?? 0.5));
  const out = new Uint8ClampedArray(mask.data.length * 4);
  for (let i = 0, p = 0; i < mask.data.length; i++, p += 4) {
    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
    out[p + 3] = Math.round((255 - mask.data[i]) * k);
  }
  return out;
}
