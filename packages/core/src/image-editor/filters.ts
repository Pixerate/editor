import type { DepthMaskOptions, ImageAdjustments } from './types';
import {
  LUMA_709,
  LATEST_PROCESS_VERSION,
  TONE_LUT_SIZE,
  buildToneLut,
  linearToSrgb,
  normalizeProcessVersion,
  srgbToLinear,
  whiteBalanceMatrix,
} from './color';

function clamp(value: number, min = 0, max = 255): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Applies color and tone adjustments (brightness, contrast, saturation, exposure, temperature, tint,
 * opacity, blur) directly to the pixel data of an ImageData buffer.
 *
 * `adjustments.process` selects the rendering: `2` is the linear-light pipeline
 * ({@link applyProcess2Adjustments}); anything else (including a missing value, as in edits saved
 * before process versions existed) is the frozen legacy rendering ({@link applyLegacyAdjustments}).
 */
export function applyAdjustments(imageData: ImageData, adjustments: ImageAdjustments): void {
  if (normalizeProcessVersion(adjustments.process) === LATEST_PROCESS_VERSION) {
    applyProcess2Adjustments(imageData, adjustments);
  } else {
    applyLegacyAdjustments(imageData, adjustments);
  }

  // Apply blur if requested
  if (adjustments.blur > 0) {
    applyFastBoxBlur(imageData, Math.min(Math.round(adjustments.blur), 40));
  }
}

/**
 * Process 1: the original 8-bit gamma-space rendering, clamping after every step. Frozen so
 * that edits saved without a `process` look exactly as they always have. `tint` is ignored.
 */
export function applyLegacyAdjustments(imageData: ImageData, adjustments: ImageAdjustments): void {
  const { brightness, contrast, saturation, exposure, temperature, opacity } = adjustments;
  const data = imageData.data;
  const len = data.length;

  const hasBrightness = brightness !== 0;
  const hasContrast = contrast !== 0;
  const hasSaturation = saturation !== 0;
  const hasExposure = exposure !== 0;
  const hasTemperature = temperature !== 0;
  const hasOpacity = opacity < 1;

  // Pre-calculate contrast factor
  const contrastFactor = hasContrast
    ? (259 * (contrast + 255)) / (255 * (259 - contrast))
    : 1;

  // Pre-calculate exposure multiplier
  const exposureMultiplier = hasExposure ? Math.pow(2, exposure / 50) : 1;

  // Pre-calculate saturation multiplier
  const satMultiplier = hasSaturation ? 1 + saturation / 100 : 1;

  // Pre-calculate temperature offsets
  const tempOffset = hasTemperature ? temperature * 0.8 : 0;

  if (hasBrightness || hasContrast || hasSaturation || hasExposure || hasTemperature || hasOpacity) {
    for (let i = 0; i < len; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];
      let a = data[i + 3];

      // Exposure
      if (hasExposure) {
        r = clamp(r * exposureMultiplier);
        g = clamp(g * exposureMultiplier);
        b = clamp(b * exposureMultiplier);
      }

      // Brightness
      if (hasBrightness) {
        const bOffset = brightness * 2.55;
        r = clamp(r + bOffset);
        g = clamp(g + bOffset);
        b = clamp(b + bOffset);
      }

      // Contrast
      if (hasContrast) {
        r = clamp(contrastFactor * (r - 128) + 128);
        g = clamp(contrastFactor * (g - 128) + 128);
        b = clamp(contrastFactor * (b - 128) + 128);
      }

      // Saturation
      if (hasSaturation) {
        const luminance = 0.2989 * r + 0.587 * g + 0.114 * b;
        r = clamp(luminance + (r - luminance) * satMultiplier);
        g = clamp(luminance + (g - luminance) * satMultiplier);
        b = clamp(luminance + (b - luminance) * satMultiplier);
      }

      // Temperature / Warmth
      if (hasTemperature) {
        r = clamp(r + tempOffset);
        b = clamp(b - tempOffset);
      }

      // Opacity
      if (hasOpacity) {
        a = clamp(a * opacity);
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
}

/** sRGB byte → linear light (exact; shared by every process 2 render). */
const DECODE_LUT: Float32Array = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  return lut;
})();

/** Intervals of the linear → sRGB byte encode table over [0, 1]. */
const ENCODE_LUT_SIZE = 65535;
let encodeLut: Uint8Array | null = null;
function getEncodeLut(): Uint8Array {
  if (!encodeLut) {
    encodeLut = new Uint8Array(ENCODE_LUT_SIZE + 1);
    for (let i = 0; i <= ENCODE_LUT_SIZE; i++) {
      encodeLut[i] = Math.round(linearToSrgb(i / ENCODE_LUT_SIZE) * 255);
    }
  }
  return encodeLut;
}

interface Process2Plan {
  key: string;
  /** Exposure gain folded into the white-balance matrix (row-major). */
  m: Float64Array;
  /** Per-channel tone LUTs over [0, headroom[c]]. */
  luts: [Float32Array, Float32Array, Float32Array];
  /** LUT index scale per channel: TONE_LUT_SIZE / headroom[c]. */
  scale: [number, number, number];
  saturation: number;
}

let cachedPlan: Process2Plan | null = null;

/**
 * Precomputes everything per parameter change: the 3×3 colour matrix (exposure gain × white
 * balance) and one tone LUT per channel whose domain is that channel's largest possible value,
 * so the highlight shoulder absorbs it instead of clipping.
 */
function getProcess2Plan(adjustments: ImageAdjustments): Process2Plan {
  const exposure = adjustments.exposure || 0;
  const temperature = adjustments.temperature || 0;
  const tint = adjustments.tint || 0;
  const contrast = adjustments.contrast || 0;
  const brightness = adjustments.brightness || 0;
  const saturation = 1 + (adjustments.saturation || 0) / 100;
  const key = `${exposure},${temperature},${tint},${contrast},${brightness},${saturation}`;
  if (cachedPlan && cachedPlan.key === key) return cachedPlan;

  const gain = Math.pow(2, exposure / 50);
  const wb = whiteBalanceMatrix(temperature, tint);
  const m = new Float64Array(9);
  for (let i = 0; i < 9; i++) m[i] = wb[i] * gain;
  const luts = [] as unknown as [Float32Array, Float32Array, Float32Array];
  const scale = [0, 0, 0] as [number, number, number];
  for (let c = 0; c < 3; c++) {
    // Largest value this channel can reach from inputs in [0, 1].
    let reach = 0;
    for (let k = 0; k < 3; k++) reach += Math.max(0, m[c * 3 + k]);
    const headroom = Math.max(1, reach);
    luts[c] = buildToneLut(contrast, brightness, headroom);
    scale[c] = TONE_LUT_SIZE / headroom;
  }
  cachedPlan = { key, m, luts, scale, saturation };
  return cachedPlan;
}

/**
 * Process 2: decode sRGB to linear float once; apply exposure (gain) and white balance (a
 * Bradford matrix relative to as-shot) in linear light; a per-channel tone LUT for the
 * highlight shoulder, contrast and brightness; luminance-preserving saturation in linear light;
 * then encode back to sRGB through a LUT. Nothing is clamped between stages, only at the final
 * encode. Neutral settings are the identity.
 */
export function applyProcess2Adjustments(imageData: ImageData, adjustments: ImageAdjustments): void {
  const data = imageData.data;
  const len = data.length;
  const opacity = adjustments.opacity ?? 1;
  const hasOpacity = opacity < 1;
  const hasColor =
    !!adjustments.brightness ||
    !!adjustments.contrast ||
    !!adjustments.saturation ||
    !!adjustments.exposure ||
    !!adjustments.temperature ||
    !!adjustments.tint;

  if (!hasColor) {
    if (hasOpacity) {
      for (let i = 3; i < len; i += 4) data[i] = clamp(data[i] * opacity);
    }
    return;
  }

  const plan = getProcess2Plan(adjustments);
  const dec = DECODE_LUT;
  const enc = getEncodeLut();
  const { m, luts, scale, saturation } = plan;
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
  const lutR = luts[0], lutG = luts[1], lutB = luts[2];
  const sR = scale[0], sG = scale[1], sB = scale[2];
  const N = TONE_LUT_SIZE;
  const hasSaturation = saturation !== 1;
  const wr = LUMA_709[0], wg = LUMA_709[1], wb = LUMA_709[2];

  for (let i = 0; i < len; i += 4) {
    const r0 = dec[data[i]];
    const g0 = dec[data[i + 1]];
    const b0 = dec[data[i + 2]];

    // Exposure × white balance (linear light, unclamped).
    let r = m0 * r0 + m1 * g0 + m2 * b0;
    let g = m3 * r0 + m4 * g0 + m5 * b0;
    let b = m6 * r0 + m7 * g0 + m8 * b0;

    // Tone LUTs (linear interpolation).
    let f: number;
    let k: number;
    if (r <= 0) r = lutR[0];
    else if ((f = r * sR) >= N) r = lutR[N];
    else { k = f | 0; r = lutR[k] + (lutR[k + 1] - lutR[k]) * (f - k); }
    if (g <= 0) g = lutG[0];
    else if ((f = g * sG) >= N) g = lutG[N];
    else { k = f | 0; g = lutG[k] + (lutG[k + 1] - lutG[k]) * (f - k); }
    if (b <= 0) b = lutB[0];
    else if ((f = b * sB) >= N) b = lutB[N];
    else { k = f | 0; b = lutB[k] + (lutB[k + 1] - lutB[k]) * (f - k); }

    // Luminance-preserving saturation in linear light.
    if (hasSaturation) {
      const y = wr * r + wg * g + wb * b;
      r = y + (r - y) * saturation;
      g = y + (g - y) * saturation;
      b = y + (b - y) * saturation;
    }

    // Encode (the only clamp).
    data[i] = enc[r <= 0 ? 0 : r >= 1 ? ENCODE_LUT_SIZE : (r * ENCODE_LUT_SIZE + 0.5) | 0];
    data[i + 1] = enc[g <= 0 ? 0 : g >= 1 ? ENCODE_LUT_SIZE : (g * ENCODE_LUT_SIZE + 0.5) | 0];
    data[i + 2] = enc[b <= 0 ? 0 : b >= 1 ? ENCODE_LUT_SIZE : (b * ENCODE_LUT_SIZE + 0.5) | 0];
    if (hasOpacity) data[i + 3] = clamp(data[i + 3] * opacity);
  }
}

/**
 * Fast separable box blur running horizontally and vertically.
 */
function applyFastBoxBlur(imageData: ImageData, radius: number): void {
  if (radius < 1) return;
  const w = imageData.width;
  const h = imageData.height;
  const src = imageData.data;
  const temp = new Uint8ClampedArray(src.length);

  // Horizontal blur pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      let count = 0;
      for (let k = -radius; k <= radius; k++) {
        const px = Math.min(w - 1, Math.max(0, x + k));
        const idx = (y * w + px) * 4;
        r += src[idx];
        g += src[idx + 1];
        b += src[idx + 2];
        a += src[idx + 3];
        count++;
      }
      const dstIdx = (y * w + x) * 4;
      temp[dstIdx] = Math.round(r / count);
      temp[dstIdx + 1] = Math.round(g / count);
      temp[dstIdx + 2] = Math.round(b / count);
      temp[dstIdx + 3] = Math.round(a / count);
    }
  }

  // Vertical blur pass back into src
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let r = 0, g = 0, b = 0, a = 0;
      let count = 0;
      for (let k = -radius; k <= radius; k++) {
        const py = Math.min(h - 1, Math.max(0, y + k));
        const idx = (py * w + x) * 4;
        r += temp[idx];
        g += temp[idx + 1];
        b += temp[idx + 2];
        a += temp[idx + 3];
        count++;
      }
      const dstIdx = (y * w + x) * 4;
      src[dstIdx] = Math.round(r / count);
      src[dstIdx + 1] = Math.round(g / count);
      src[dstIdx + 2] = Math.round(b / count);
      src[dstIdx + 3] = Math.round(a / count);
    }
  }
}

/**
 * Blends a depth/alpha mask into the main image data based on Gleamforge depth masking.
 * Supports threshold range with softness gradation, brightness mode, and optional inversion.
 */
export function applyDepthMask(
  mainImageData: ImageData,
  maskImageData: ImageData,
  options: DepthMaskOptions
): void {
  const { mode, depthRange, softness, invert } = options;
  const mainData = mainImageData.data;
  const maskData = maskImageData.data;
  const len = Math.min(mainData.length, maskData.length);
  const effectiveSoftness = Math.max(1, softness || 10);
  const minDepth = depthRange[0];
  const maxDepth = depthRange[1];

  for (let i = 0; i < len; i += 4) {
    let maskValue = maskData[i]; // Use red channel of mask (or grayscale)
    if (invert) {
      maskValue = 255 - maskValue;
    }

    let alphaValue: number;

    if (mode === 'threshold') {
      if (maskValue >= maxDepth + effectiveSoftness) {
        alphaValue = 0;
      } else if (maskValue > maxDepth) {
        alphaValue = Math.round(((maxDepth + effectiveSoftness - maskValue) / effectiveSoftness) * 255);
      } else if (maskValue >= minDepth) {
        alphaValue = 255;
      } else if (maskValue < minDepth - effectiveSoftness) {
        alphaValue = 0;
      } else {
        alphaValue = Math.round(((maskValue - (minDepth - effectiveSoftness)) / effectiveSoftness) * 255);
      }
    } else {
      // Brightness mode
      alphaValue = clamp(maskValue + minDepth);
    }

    // Multiply existing alpha with mask alpha
    mainData[i + 3] = clamp((mainData[i + 3] * alphaValue) / 255);
  }
}

/**
 * Removes alpha channel by setting all alpha bytes to 255 (completely opaque).
 * From Gleamforge image-filters.ts.
 */
export function removeAlpha(imageData: ImageData): void {
  const data = imageData.data;
  const len = data.length;
  for (let i = 3; i < len; i += 4) {
    data[i] = 255;
  }
}
