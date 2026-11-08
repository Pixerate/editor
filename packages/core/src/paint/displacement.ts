import {
  TiledSurface,
  readRegion,
  tileKey,
  tilesInRect,
  writeRegion,
  type RasterRect,
  type TileKey,
} from '../raster/surface';

export interface DisplacementSelectionMask {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/**
 * A 2D vector field defined on a regular coarse grid (`step` pixels between samples) covering
 * `rect`. Used both for forward velocity fields `(vx, vy)` and integrated backward displacement
 * fields `(dx, dy)` where destination pixel `(x, y)` samples the source at `(x + dx, y + dy)`.
 */
export interface DisplacementField {
  readonly rect: RasterRect;
  readonly step: number;
  readonly cols: number;
  readonly rows: number;
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  readonly maxDisplacement: number;
}

/** A 2D velocity field on a coarse grid (`step` pixels between samples) covering `rect`. */
export interface VelocityGridField {
  readonly rect: RasterRect;
  readonly step: number;
  readonly cols: number;
  readonly rows: number;
  /** Forward velocity X in pixels per unit time (normalized so peak spin is ~1). */
  readonly vx: Float32Array;
  /** Forward velocity Y in pixels per unit time. */
  readonly vy: Float32Array;
  readonly maxSpeed: number;
}

/** Creates an empty `DisplacementField` covering `rect` at spacing `step` (1..4 px). */
export function createDisplacementField(rect: RasterRect, step: number): DisplacementField {
  const s = Math.max(1, Math.min(4, Math.round(step)));
  const cols = Math.max(2, Math.ceil(rect.width / s) + 1);
  const rows = Math.max(2, Math.ceil(rect.height / s) + 1);
  return {
    rect: { x: rect.x, y: rect.y, width: (cols - 1) * s, height: (rows - 1) * s },
    step: s,
    cols,
    rows,
    dx: new Float32Array(cols * rows),
    dy: new Float32Array(cols * rows),
    maxDisplacement: 0,
  };
}

/**
 * Bilinearly samples `(dx, dy)` from `field` at document coordinate `(x, y)`.
 * Outside `field.rect`, returns `{ dx: 0, dy: 0 }`.
 */
export function sampleDisplacement(
  field: DisplacementField,
  x: number,
  y: number
): { dx: number; dy: number } {
  const gx = (x - field.rect.x) / field.step;
  const gy = (y - field.rect.y) / field.step;
  const maxCol = field.cols - 1;
  const maxRow = field.rows - 1;
  if (gx <= 0 || gy <= 0 || gx >= maxCol || gy >= maxRow) {
    return { dx: 0, dy: 0 };
  }
  const c0 = Math.floor(gx);
  const r0 = Math.floor(gy);
  const c1 = Math.min(maxCol, c0 + 1);
  const r1 = Math.min(maxRow, r0 + 1);
  const tx = gx - c0;
  const ty = gy - r0;
  const omtX = 1 - tx;
  const omtY = 1 - ty;
  const i00 = r0 * field.cols + c0;
  const i10 = r0 * field.cols + c1;
  const i01 = r1 * field.cols + c0;
  const i11 = r1 * field.cols + c1;
  const w00 = omtX * omtY;
  const w10 = tx * omtY;
  const w01 = omtX * ty;
  const w11 = tx * ty;
  return {
    dx:
      field.dx[i00]! * w00 +
      field.dx[i10]! * w10 +
      field.dx[i01]! * w01 +
      field.dx[i11]! * w11,
    dy:
      field.dy[i00]! * w00 +
      field.dy[i10]! * w10 +
      field.dy[i01]! * w01 +
      field.dy[i11]! * w11,
  };
}

function sampleGridPair(
  arrX: Float32Array,
  arrY: Float32Array,
  cols: number,
  rows: number,
  gx: number,
  gy: number,
  out: [number, number]
): void {
  const maxCol = cols - 1;
  const maxRow = rows - 1;
  if (gx <= 0 || gy <= 0 || gx >= maxCol || gy >= maxRow) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  const c0 = gx | 0;
  const r0 = gy | 0;
  const c1 = c0 < maxCol ? c0 + 1 : maxCol;
  const r1 = r0 < maxRow ? r0 + 1 : maxRow;
  const tx = gx - c0;
  const ty = gy - r0;
  const omtX = 1 - tx;
  const omtY = 1 - ty;
  const i00 = r0 * cols + c0;
  const i10 = i00 + (c1 - c0);
  const i01 = r1 * cols + c0;
  const i11 = i01 + (c1 - c0);
  const w00 = omtX * omtY;
  const w10 = tx * omtY;
  const w01 = omtX * ty;
  const w11 = tx * ty;
  out[0] = arrX[i00]! * w00 + arrX[i10]! * w10 + arrX[i01]! * w01 + arrX[i11]! * w11;
  out[1] = arrY[i00]! * w00 + arrY[i10]! * w10 + arrY[i01]! * w01 + arrY[i11]! * w11;
}

/**
 * Integrates a forward velocity field `vel` over `totalTravel` pixels into a single backward
 * displacement field `D` in fixed sub-steps `D'(x) = D(x + v(x)) + v(x)` (using midpoint velocity
 * `v` with backward direction `-vel` so the warp is diffeomorphic and pure rotation preserves
 * radius). Each sub-step's displacement is capped at `maxSubStepPx` so the warp cannot fold.
 */
export function integrateVelocityField(
  vel: VelocityGridField,
  totalTravel: number,
  maxSubStepPx = Math.max(0.5, vel.step * 0.45)
): DisplacementField {
  const { rect, step, cols, rows, vx, vy, maxSpeed } = vel;
  const count = cols * rows;
  let dx = new Float32Array(count);
  let dy = new Float32Array(count);
  if (totalTravel <= 1e-5 || maxSpeed <= 1e-6) {
    return { rect, step, cols, rows, dx, dy, maxDisplacement: 0 };
  }

  const totalPeakDisp = totalTravel * maxSpeed;
  const steps = Math.max(4, Math.min(240, Math.ceil(totalPeakDisp / maxSubStepPx)));
  const dt = totalTravel / steps;
  const stepCap = maxSubStepPx;
  const invStep = 1 / step;

  // Precompute backward midpoint step vectors (in pixels and in grid units) per cell.
  const stepX = new Float32Array(count);
  const stepY = new Float32Array(count);
  const tmp: [number, number] = [0, 0];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      // Backward trace uses -vel so pixels arriving at (c, r) are fetched from upstream.
      let bx = -vx[idx]! * dt;
      let by = -vy[idx]! * dt;
      const mag0 = Math.hypot(bx, by);
      if (mag0 > 1e-6) {
        if (mag0 > stepCap) {
          const s = stepCap / mag0;
          bx *= s;
          by *= s;
        }
        // Midpoint evaluation in grid space preserves constant-radius streamlines on pure spin.
        const midC = c + bx * 0.5 * invStep;
        const midR = r + by * 0.5 * invStep;
        sampleGridPair(vx, vy, cols, rows, midC, midR, tmp);
        bx = -tmp[0] * dt;
        by = -tmp[1] * dt;
        const mag1 = Math.hypot(bx, by);
        if (mag1 > stepCap) {
          const s = stepCap / mag1;
          bx *= s;
          by *= s;
        }
      }
      stepX[idx] = bx;
      stepY[idx] = by;
    }
  }

  let nextDx = new Float32Array(count);
  let nextDy = new Float32Array(count);

  for (let s = 0; s < steps; s++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const sx = stepX[idx]!;
        const sy = stepY[idx]!;
        if (sx === 0 && sy === 0) {
          nextDx[idx] = dx[idx]!;
          nextDy[idx] = dy[idx]!;
          continue;
        }
        const qc = c + sx * invStep;
        const qr = r + sy * invStep;
        sampleGridPair(dx, dy, cols, rows, qc, qr, tmp);
        nextDx[idx] = tmp[0] + sx;
        nextDy[idx] = tmp[1] + sy;
      }
    }
    const swapX = dx;
    const swapY = dy;
    dx = nextDx;
    dy = nextDy;
    nextDx = swapX;
    nextDy = swapY;
  }

  let maxDisplacement = 0;
  for (let i = 0; i < count; i++) {
    const m = Math.hypot(dx[i]!, dy[i]!);
    if (m > maxDisplacement) maxDisplacement = m;
  }

  return { rect, step, cols, rows, dx, dy, maxDisplacement };
}

/**
 * Composes two backward displacement fields `first` followed by `second` onto a grid covering their
 * union: `D(x) = first(x + second(x)) + second(x)`.
 */
export function composeDisplacementFields(
  first: DisplacementField,
  second: DisplacementField
): DisplacementField {
  const step = Math.min(first.step, second.step);
  const x0 = Math.min(first.rect.x, second.rect.x);
  const y0 = Math.min(first.rect.y, second.rect.y);
  const x1 = Math.max(first.rect.x + first.rect.width, second.rect.x + second.rect.width);
  const y1 = Math.max(first.rect.y + first.rect.height, second.rect.y + second.rect.height);
  const out = createDisplacementField({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, step);
  let maxDisp = 0;
  for (let r = 0; r < out.rows; r++) {
    const y = out.rect.y + r * out.step;
    for (let c = 0; c < out.cols; c++) {
      const x = out.rect.x + c * out.step;
      const idx = r * out.cols + c;
      const s2 = sampleDisplacement(second, x, y);
      const s1 = sampleDisplacement(first, x + s2.dx, y + s2.dy);
      const dx = s1.dx + s2.dx;
      const dy = s1.dy + s2.dy;
      out.dx[idx] = dx;
      out.dy[idx] = dy;
      const m = Math.hypot(dx, dy);
      if (m > maxDisp) maxDisp = m;
    }
  }
  return { ...out, maxDisplacement: maxDisp };
}

export interface WarpSurfaceOptions {
  /** Scale factor applied to the displacement (`0..1`, default `1`, used for winding frames). */
  scale?: number;
  /** Layer offset in document space (`(x, y)` in document space corresponds to `(x - offset.x, y - offset.y)` in surface space). */
  offset?: { x: number; y: number };
  /** Optional canvas clip bounds `{ width, height }`. */
  clip?: { width: number; height: number };
  /** Optional selection mask (document space). */
  selection?: DisplacementSelectionMask | null;
  /** Preserve each pixel's pre-warp alpha channel. */
  lockTransparency?: boolean;
}

/**
 * Samples straight-alpha RGBA from `src` (`srcW × srcH`) at `(sx, sy)` (relative to `srcX, srcY`)
 * using premultiplied bilinear interpolation so transparent neighbours never bleed dark fringes.
 */
export function sampleRgbaPremultiplied(
  src: Uint8ClampedArray,
  srcX: number,
  srcY: number,
  srcW: number,
  srcH: number,
  sx: number,
  sy: number,
  out: [number, number, number, number]
): void {
  const lx = sx - srcX;
  const ly = sy - srcY;
  if (lx < 0 || ly < 0 || lx > srcW - 1 || ly > srcH - 1) {
    const cx = Math.max(0, Math.min(srcW - 1, Math.round(lx)));
    const cy = Math.max(0, Math.min(srcH - 1, Math.round(ly)));
    if (lx < -0.5 || ly < -0.5 || lx > srcW - 0.5 || ly > srcH - 0.5) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      return;
    }
    const idx = (cy * srcW + cx) * 4;
    out[0] = src[idx]!;
    out[1] = src[idx + 1]!;
    out[2] = src[idx + 2]!;
    out[3] = src[idx + 3]!;
    return;
  }
  const x0 = lx | 0;
  const y0 = ly | 0;
  const x1 = x0 < srcW - 1 ? x0 + 1 : x0;
  const y1 = y0 < srcH - 1 ? y0 + 1 : y0;
  const tx = lx - x0;
  const ty = ly - y0;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  const i00 = (y0 * srcW + x0) * 4;
  const i10 = (y0 * srcW + x1) * 4;
  const i01 = (y1 * srcW + x0) * 4;
  const i11 = (y1 * srcW + x1) * 4;

  const a00 = src[i00 + 3]! * w00;
  const a10 = src[i10 + 3]! * w10;
  const a01 = src[i01 + 3]! * w01;
  const a11 = src[i11 + 3]! * w11;
  const aSum = a00 + a10 + a01 + a11;
  if (aSum <= 0.001) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    return;
  }
  const invA = 1 / aSum;
  out[0] = Math.round(
    (src[i00]! * a00 + src[i10]! * a10 + src[i01]! * a01 + src[i11]! * a11) * invA
  );
  out[1] = Math.round(
    (src[i00 + 1]! * a00 + src[i10 + 1]! * a10 + src[i01 + 1]! * a01 + src[i11 + 1]! * a11) * invA
  );
  out[2] = Math.round(
    (src[i00 + 2]! * a00 + src[i10 + 2]! * a10 + src[i01 + 2]! * a01 + src[i11 + 2]! * a11) * invA
  );
  out[3] = Math.round(aSum);
}

/**
 * Resamples an RGBA `TiledSurface` once through `field` using premultiplied bilinear sampling.
 * Returns `{ surface, touchedKeys, changedPixels, bounds }`.
 */
export function warpTiledSurfaceRgba(
  source: TiledSurface,
  field: DisplacementField,
  options: WarpSurfaceOptions = {}
): { surface: TiledSurface; touchedKeys: TileKey[]; changedPixels: number; bounds: RasterRect | null } {
  const scale = options.scale ?? 1;
  if (field.maxDisplacement * Math.abs(scale) <= 1e-4) {
    return { surface: source, touchedKeys: [], changedPixels: 0, bounds: null };
  }
  const offX = options.offset?.x ?? 0;
  const offY = options.offset?.y ?? 0;
  const clip = options.clip;
  const dstX0 = Math.max(clip ? 0 : -Infinity, Math.floor(field.rect.x));
  const dstY0 = Math.max(clip ? 0 : -Infinity, Math.floor(field.rect.y));
  const dstX1 = Math.min(clip ? clip.width : Infinity, Math.ceil(field.rect.x + field.rect.width));
  const dstY1 = Math.min(clip ? clip.height : Infinity, Math.ceil(field.rect.y + field.rect.height));
  if (dstX1 <= dstX0 || dstY1 <= dstY0) {
    return { surface: source, touchedKeys: [], changedPixels: 0, bounds: null };
  }
  const dstRect: RasterRect = { x: dstX0, y: dstY0, width: dstX1 - dstX0, height: dstY1 - dstY0 };
  const pad = Math.ceil(field.maxDisplacement * Math.abs(scale)) + 2;
  const srcX0 = dstX0 - pad;
  const srcY0 = dstY0 - pad;
  const srcW = dstRect.width + pad * 2;
  const srcH = dstRect.height + pad * 2;
  const srcBuf = readRegion(source, { x: srcX0 - offX, y: srcY0 - offY, width: srcW, height: srcH });

  // Fast exit if the entire source window is completely transparent.
  let anyOpaque = false;
  for (let i = 3; i < srcBuf.length; i += 4) {
    if (srcBuf[i]! > 0) {
      anyOpaque = true;
      break;
    }
  }
  if (!anyOpaque) {
    return { surface: source, touchedKeys: [], changedPixels: 0, bounds: null };
  }

  const dstBuf = new Uint8ClampedArray(dstRect.width * dstRect.height * 4);
  const rgba: [number, number, number, number] = [0, 0, 0, 0];
  const sel = options.selection ?? null;
  const lockAlpha = options.lockTransparency ?? false;
  let changedPixels = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let row = 0; row < dstRect.height; row++) {
    const y = dstY0 + row;
    const srcRowOff = (y - srcY0) * srcW;
    const dstRowOff = row * dstRect.width;
    for (let col = 0; col < dstRect.width; col++) {
      const x = dstX0 + col;
      const origIdx = (srcRowOff + (x - srcX0)) * 4;
      const dstIdx = (dstRowOff + col) * 4;
      const r0 = srcBuf[origIdx]!;
      const g0 = srcBuf[origIdx + 1]!;
      const b0 = srcBuf[origIdx + 2]!;
      const a0 = srcBuf[origIdx + 3]!;

      let selWeight = 1;
      if (sel) {
        if (x < 0 || y < 0 || x >= sel.width || y >= sel.height) {
          selWeight = 0;
        } else {
          selWeight = sel.data[y * sel.width + x]! / 255;
        }
      }
      if (selWeight <= 0) {
        dstBuf[dstIdx] = r0;
        dstBuf[dstIdx + 1] = g0;
        dstBuf[dstIdx + 2] = b0;
        dstBuf[dstIdx + 3] = a0;
        continue;
      }

      const d = sampleDisplacement(field, x, y);
      const dx = d.dx * scale;
      const dy = d.dy * scale;
      if (Math.abs(dx) <= 1e-4 && Math.abs(dy) <= 1e-4) {
        dstBuf[dstIdx] = r0;
        dstBuf[dstIdx + 1] = g0;
        dstBuf[dstIdx + 2] = b0;
        dstBuf[dstIdx + 3] = a0;
        continue;
      }

      sampleRgbaPremultiplied(srcBuf, srcX0, srcY0, srcW, srcH, x + dx, y + dy, rgba);
      let r1 = rgba[0];
      let g1 = rgba[1];
      let b1 = rgba[2];
      let a1 = lockAlpha ? a0 : rgba[3];
      if (lockAlpha && rgba[3] === 0) {
        r1 = r0;
        g1 = g0;
        b1 = b0;
      }
      if (selWeight < 1) {
        r1 = Math.round(r0 + (r1 - r0) * selWeight);
        g1 = Math.round(g0 + (g1 - g0) * selWeight);
        b1 = Math.round(b0 + (b1 - b0) * selWeight);
        a1 = Math.round(a0 + (a1 - a0) * selWeight);
      }
      dstBuf[dstIdx] = r1;
      dstBuf[dstIdx + 1] = g1;
      dstBuf[dstIdx + 2] = b1;
      dstBuf[dstIdx + 3] = a1;
      if (r1 !== r0 || g1 !== g0 || b1 !== b0 || a1 !== a0) {
        changedPixels++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (changedPixels === 0) {
    return { surface: source, touchedKeys: [], changedPixels: 0, bounds: null };
  }

  const localDstRect: RasterRect = { x: dstRect.x - offX, y: dstRect.y - offY, width: dstRect.width, height: dstRect.height };
  const nextSurface = writeRegion(source, localDstRect, dstBuf);
  const touchedKeys: TileKey[] = [];
  for (const { tx, ty } of tilesInRect(localDstRect)) {
    touchedKeys.push(tileKey(tx, ty));
  }
  const bounds: RasterRect = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return { surface: nextSurface, touchedKeys, changedPixels, bounds };
}

/**
 * Resamples a single-channel (`channels === 1`) `TiledSurface` (such as impasto `height`, `light`,
 * or `ferro`) once through `field` using bilinear sampling.
 */
export function warpTiledSurfaceChannel(
  source: TiledSurface,
  field: DisplacementField,
  options: WarpSurfaceOptions = {}
): { surface: TiledSurface; touchedKeys: TileKey[]; bounds: RasterRect | null } {
  const scale = options.scale ?? 1;
  if (source.tileCount === 0 || field.maxDisplacement * Math.abs(scale) <= 1e-4) {
    return { surface: source, touchedKeys: [], bounds: null };
  }
  const offX = options.offset?.x ?? 0;
  const offY = options.offset?.y ?? 0;
  const clip = options.clip;
  const dstX0 = Math.max(clip ? 0 : -Infinity, Math.floor(field.rect.x));
  const dstY0 = Math.max(clip ? 0 : -Infinity, Math.floor(field.rect.y));
  const dstX1 = Math.min(clip ? clip.width : Infinity, Math.ceil(field.rect.x + field.rect.width));
  const dstY1 = Math.min(clip ? clip.height : Infinity, Math.ceil(field.rect.y + field.rect.height));
  if (dstX1 <= dstX0 || dstY1 <= dstY0) return { surface: source, touchedKeys: [], bounds: null };
  const dstRect: RasterRect = { x: dstX0, y: dstY0, width: dstX1 - dstX0, height: dstY1 - dstY0 };
  const pad = Math.ceil(field.maxDisplacement * Math.abs(scale)) + 2;
  const srcX0 = dstX0 - pad;
  const srcY0 = dstY0 - pad;
  const srcW = dstRect.width + pad * 2;
  const srcH = dstRect.height + pad * 2;
  const srcBuf = readRegion(source, { x: srcX0 - offX, y: srcY0 - offY, width: srcW, height: srcH });
  const dstBuf = new Uint8ClampedArray(dstRect.width * dstRect.height);
  const sel = options.selection ?? null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let row = 0; row < dstRect.height; row++) {
    const y = dstY0 + row;
    for (let col = 0; col < dstRect.width; col++) {
      const x = dstX0 + col;
      const v0 = srcBuf[(y - srcY0) * srcW + (x - srcX0)]!;
      const dstIdx = row * dstRect.width + col;
      if (sel && (x < 0 || y < 0 || x >= sel.width || y >= sel.height || sel.data[y * sel.width + x]! === 0)) {
        dstBuf[dstIdx] = v0;
        continue;
      }
      const d = sampleDisplacement(field, x, y);
      const sx = x + d.dx * scale - srcX0;
      const sy = y + d.dy * scale - srcY0;
      let v1 = 0;
      if (sx >= 0 && sy >= 0 && sx < srcW - 1 && sy < srcH - 1) {
        const x0 = sx | 0;
        const y0 = sy | 0;
        const tx = sx - x0;
        const ty = sy - y0;
        const i00 = y0 * srcW + x0;
        const v =
          srcBuf[i00]! * (1 - tx) * (1 - ty) +
          srcBuf[i00 + 1]! * tx * (1 - ty) +
          srcBuf[i00 + srcW]! * (1 - tx) * ty +
          srcBuf[i00 + srcW + 1]! * tx * ty;
        v1 = Math.round(v);
      }
      dstBuf[dstIdx] = v1;
      if (v1 !== v0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX === Infinity) return { surface: source, touchedKeys: [], bounds: null };
  const localDstRect: RasterRect = { x: dstRect.x - offX, y: dstRect.y - offY, width: dstRect.width, height: dstRect.height };
  const nextSurface = writeRegion(source, localDstRect, dstBuf);
  const touchedKeys: TileKey[] = [];
  for (const { tx, ty } of tilesInRect(localDstRect)) touchedKeys.push(tileKey(tx, ty));
  return { surface: nextSurface, touchedKeys, bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}

/**
 * Resamples an RGBA `TiledSurface` where bytes encode discrete or un-premultiplied packed state
 * (such as impasto `material` where `A = 0` means "no material", or `film`) using nearest-neighbour
 * sampling so empty cells never average with populated cells.
 */
export function warpTiledSurfaceNearest(
  source: TiledSurface,
  field: DisplacementField,
  options: WarpSurfaceOptions = {}
): { surface: TiledSurface; touchedKeys: TileKey[]; bounds: RasterRect | null } {
  const scale = options.scale ?? 1;
  if (source.tileCount === 0 || field.maxDisplacement * Math.abs(scale) <= 1e-4) {
    return { surface: source, touchedKeys: [], bounds: null };
  }
  const offX = options.offset?.x ?? 0;
  const offY = options.offset?.y ?? 0;
  const clip = options.clip;
  const dstX0 = Math.max(clip ? 0 : -Infinity, Math.floor(field.rect.x));
  const dstY0 = Math.max(clip ? 0 : -Infinity, Math.floor(field.rect.y));
  const dstX1 = Math.min(clip ? clip.width : Infinity, Math.ceil(field.rect.x + field.rect.width));
  const dstY1 = Math.min(clip ? clip.height : Infinity, Math.ceil(field.rect.y + field.rect.height));
  if (dstX1 <= dstX0 || dstY1 <= dstY0) return { surface: source, touchedKeys: [], bounds: null };
  const dstRect: RasterRect = { x: dstX0, y: dstY0, width: dstX1 - dstX0, height: dstY1 - dstY0 };
  const pad = Math.ceil(field.maxDisplacement * Math.abs(scale)) + 2;
  const srcX0 = dstX0 - pad;
  const srcY0 = dstY0 - pad;
  const srcW = dstRect.width + pad * 2;
  const srcH = dstRect.height + pad * 2;
  const srcBuf = readRegion(source, { x: srcX0 - offX, y: srcY0 - offY, width: srcW, height: srcH });
  const dstBuf = new Uint8ClampedArray(dstRect.width * dstRect.height * 4);
  const sel = options.selection ?? null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let row = 0; row < dstRect.height; row++) {
    const y = dstY0 + row;
    for (let col = 0; col < dstRect.width; col++) {
      const x = dstX0 + col;
      const origIdx = ((y - srcY0) * srcW + (x - srcX0)) * 4;
      const dstIdx = (row * dstRect.width + col) * 4;
      const r0 = srcBuf[origIdx]!;
      const g0 = srcBuf[origIdx + 1]!;
      const b0 = srcBuf[origIdx + 2]!;
      const a0 = srcBuf[origIdx + 3]!;
      if (sel && (x < 0 || y < 0 || x >= sel.width || y >= sel.height || sel.data[y * sel.width + x]! === 0)) {
        dstBuf[dstIdx] = r0;
        dstBuf[dstIdx + 1] = g0;
        dstBuf[dstIdx + 2] = b0;
        dstBuf[dstIdx + 3] = a0;
        continue;
      }
      const d = sampleDisplacement(field, x, y);
      const sx = Math.round(x + d.dx * scale - srcX0);
      const sy = Math.round(y + d.dy * scale - srcY0);
      let r1 = 0;
      let g1 = 0;
      let b1 = 0;
      let a1 = 0;
      if (sx >= 0 && sy >= 0 && sx < srcW && sy < srcH) {
        const sIdx = (sy * srcW + sx) * 4;
        r1 = srcBuf[sIdx]!;
        g1 = srcBuf[sIdx + 1]!;
        b1 = srcBuf[sIdx + 2]!;
        a1 = srcBuf[sIdx + 3]!;
      }
      dstBuf[dstIdx] = r1;
      dstBuf[dstIdx + 1] = g1;
      dstBuf[dstIdx + 2] = b1;
      dstBuf[dstIdx + 3] = a1;
      if (r1 !== r0 || g1 !== g0 || b1 !== b0 || a1 !== a0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX === Infinity) return { surface: source, touchedKeys: [], bounds: null };
  const localDstRect: RasterRect = { x: dstRect.x - offX, y: dstRect.y - offY, width: dstRect.width, height: dstRect.height };
  const nextSurface = writeRegion(source, localDstRect, dstBuf);
  const touchedKeys: TileKey[] = [];
  for (const { tx, ty } of tilesInRect(localDstRect)) touchedKeys.push(tileKey(tx, ty));
  return { surface: nextSurface, touchedKeys, bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}
