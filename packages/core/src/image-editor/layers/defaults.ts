import { LATEST_PROCESS_VERSION } from '../color';
import type { DepthMaskOptions, ImageAdjustments, ImageTransform } from '../types';

/** Neutral base adjustments, latest process (re-exported as `DEFAULT_ADJUSTMENTS`). */
export const DEFAULT_ADJUSTMENTS_VALUES: ImageAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  blur: 0,
  opacity: 1,
  process: LATEST_PROCESS_VERSION,
};

export const DEFAULT_TRANSFORM_VALUES: ImageTransform = {
  rotate: 0,
  flipH: false,
  flipV: false,
};

export const DEFAULT_DEPTH_MASK_VALUES: DepthMaskOptions = {
  enabled: false,
  maskSource: null,
  mode: 'threshold',
  depthRange: [0, 255],
  softness: 10,
  invert: false,
};
