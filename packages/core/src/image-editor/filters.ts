import type { DepthMaskOptions, ImageAdjustments } from './types';

function clamp(value: number, min = 0, max = 255): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Applies color and tone adjustments (brightness, contrast, saturation, exposure, temperature, opacity, blur)
 * directly to the pixel data of an ImageData buffer.
 */
export function applyAdjustments(imageData: ImageData, adjustments: ImageAdjustments): void {
  const { brightness, contrast, saturation, exposure, temperature, opacity, blur } = adjustments;
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

  // Apply blur if requested
  if (blur > 0) {
    applyFastBoxBlur(imageData, Math.min(Math.round(blur), 40));
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
