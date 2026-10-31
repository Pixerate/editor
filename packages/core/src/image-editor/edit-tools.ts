import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import type { BlendMode } from './blend';
import { BLEND_MODES, isBlendMode } from './blend';
import { getRotatedSize, normalizeAngle } from './geometry';
import { computeHistogram, type ImageHistogram } from './histogram';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const LAYER_ID = { type: 'string', description: 'Adjustment layer id from get_adjustments (e.g. "adj_1").' } as const;

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Mean and the 1st / 99th percentiles of a 256-bin histogram. */
function binStats(bins: ArrayLike<number>, samples: number) {
  if (!samples) return { mean: null, p1: null, p99: null };
  let sum = 0;
  let seen = 0;
  let p1: number | null = null;
  let p99: number | null = null;
  for (let i = 0; i < bins.length; i++) {
    sum += i * bins[i];
    seen += bins[i];
    if (p1 === null && seen >= samples * 0.01) p1 = i;
    if (p99 === null && seen >= samples * 0.99) p99 = i;
  }
  return { mean: round(sum / samples, 1), p1, p99 };
}

/** Sums 256 bins into `count` equal buckets. */
function rebin(bins: ArrayLike<number>, count: number): number[] {
  const out = new Array<number>(count).fill(0);
  const width = bins.length / count;
  for (let i = 0; i < bins.length; i++) out[Math.floor(i / width)] += bins[i];
  return out;
}

function histogramSummary(h: ImageHistogram, bins: number | undefined) {
  const pct = (n: number) => (h.samples ? round((n / h.samples) * 100) : 0);
  const channels = { red: h.red, green: h.green, blue: h.blue, luminance: h.luminance };
  return {
    samples: h.samples,
    transparent: h.transparent,
    clipping: {
      shadowsPercent: { red: pct(h.shadows[0]), green: pct(h.shadows[1]), blue: pct(h.shadows[2]) },
      highlightsPercent: { red: pct(h.highlights[0]), green: pct(h.highlights[1]), blue: pct(h.highlights[2]) }
    },
    stats: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, binStats(v, h.samples)])),
    ...(bins ? { bins: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, rebin(v, bins)])) } : {})
  };
}

/**
 * Agent tools for the image editor's layers, geometry and history: `get_image_info`,
 * `get_histogram`, `measure_region`, `update_adjustment_layer`, `remove_adjustment_layer`,
 * `move_adjustment_layer`, `set_crop`, `reset_crop`, `set_rotation`, `flip_image`,
 * `set_bit_depth`, `undo_image` and `redo_image`. Each write is one undo step and returns what changed.
 */
export function createImageEditTools(controller: ImageEditorController): AgentTool[] {
  const layerOrThrow = (id: string) => {
    const layers = controller.getAdjustmentLayers();
    const index = layers.findIndex((l) => l.id === id);
    if (index === -1) {
      const ids = layers.map((l) => l.id);
      throw new Error(`Unknown adjustment layer "${id}". ${ids.length ? `Layers: ${ids.join(', ')}.` : 'There are no adjustment layers.'}`);
    }
    return { layer: layers[index], index };
  };
  const layerJson = (id: string) => JSON.parse(JSON.stringify(controller.getAdjustmentLayer(id)));
  const geometry = () => {
    const s = controller.getState();
    const region = s.crop ?? { x: 0, y: 0, ...s.imageDimensions };
    const out = getRotatedSize(region.width, region.height, s.transform);
    return {
      image: { ...s.imageDimensions },
      crop: s.crop ? { ...s.crop } : null,
      rotation: normalizeAngle(s.transform.rotate),
      flipH: s.transform.flipH,
      flipV: s.transform.flipV,
      output: { width: Math.round(out.width), height: Math.round(out.height) }
    };
  };
  const history = () => ({ canUndo: controller.canUndo, canRedo: controller.canRedo });
  const requireImage = () => {
    const { width, height } = controller.getState().imageDimensions;
    if (!width || !height) throw new Error('No image is loaded. Ask the user to open one first.');
    return { width, height };
  };

  const getImageInfo: AgentTool = {
    name: 'get_image_info',
    title: 'Read image geometry',
    description:
      'Returns the source image size in pixels, the crop box (natural image pixels, or null for the whole image), rotation in degrees, flips, the output size after crop and rotation, the bits per channel (bitDepth 8, 16 or 32), the number of adjustment layers and whether undo / redo are available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Read image geometry', ...READ },
    handler: () => ({ ...geometry(), bitDepth: controller.bitDepth, layers: controller.getAdjustmentLayers().length, ...history() })
  };

  const setBitDepth: AgentTool = {
    name: 'set_bit_depth',
    title: 'Set the bit depth',
    description:
      "Image › Mode › 8 / 16 / 32 Bits/Channel. 16-bit keeps smooth gradients and survives strong adjustments without banding; 32-bit holds linear-light float values (HDR, colour above 1). Going up costs nothing and changes no pixels; going down rounds every pixel layer's extra precision away (32 → 16 also clips colour above 1). The viewport always shows an 8-bit rendering. One undo step. Returns the bitDepth and changedLayerIds (the layers whose samples were rounded).",
    inputSchema: {
      type: 'object',
      properties: { depth: { type: 'number', enum: [8, 16, 32], description: 'Bits per channel: 8, 16 or 32 (float, linear light).' } },
      required: ['depth'],
      additionalProperties: false,
    },
    annotations: { title: 'Set the bit depth', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: (args) => ({ ...controller.setBitDepth(args.depth as 8 | 16 | 32), ...history() }),
  };

  const getHistogram: AgentTool = {
    name: 'get_histogram',
    title: 'Read the histogram',
    description:
      'Returns the histogram of the last rendered preview (after adjustments and layers): per channel and luminance mean and 1st / 99th percentiles (0-255), and the percentage of pixels clipped to pure black or white per channel. ' +
      'Use it to judge exposure and clipping numerically. Pass bins for the counts themselves. Fails before the first render: call render_preview first.',
    inputSchema: {
      type: 'object',
      properties: {
        bins: { type: 'integer', enum: [16, 32, 64, 256], description: 'Also return the counts in this many buckets per channel (default: no counts).' }
      },
      additionalProperties: false
    },
    annotations: { title: 'Read the histogram', ...READ },
    handler: ({ bins }) => {
      const h = controller.getHistogram();
      if (!h) throw new Error('No histogram yet: it comes from the rendered preview. Call render_preview, then try again, or measure_region, which needs no render.');
      return histogramSummary(h, bins);
    }
  };

  const measureRegion: AgentTool = {
    name: 'measure_region',
    title: 'Measure part of the image',
    description:
      'Measures the composited image (every layer and adjustment, before crop, rotation and output opacity) in a rectangle, without rendering: the histogram summary of get_histogram (per channel and luminance mean, 1st / 99th percentiles 0-255, clipping percentages) plus the mean colour as hex and a cast (red minus blue, green minus the red-blue average, in levels; near 0 is neutral). ' +
      'Use it to check a correction in numbers: a known-neutral area (a white wall, a grey card) should have a cast within about ±4; skin, sky or a product colour should land where you aim. Works where render_preview cannot. Annotation layers are left out.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer', minimum: 0, description: 'Left edge in natural image pixels (default: the crop, else the whole image).' },
        y: { type: 'integer', minimum: 0, description: 'Top edge in natural image pixels.' },
        width: { type: 'integer', minimum: 1, description: 'Width in pixels.' },
        height: { type: 'integer', minimum: 1, description: 'Height in pixels.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Measure part of the image', ...READ },
    handler: ({ x, y, width, height }) => {
      const given = [x, y, width, height].filter((v) => v !== undefined).length;
      if (given !== 0 && given !== 4) throw new Error('Give x, y, width and height together, or none to measure the crop (or the whole image).');
      const { width: W, height: H } = controller.getState().imageDimensions;
      const rect = given ? { x: x as number, y: y as number, width: width as number, height: height as number } : controller.getState().crop ?? { x: 0, y: 0, width: W, height: H };
      if (rect.x + rect.width > W || rect.y + rect.height > H) throw new Error(`The rectangle runs past the image (${W} × ${H} px); keep x + width ≤ ${W} and y + height ≤ ${H}.`);
      const h = computeHistogram(controller.compositePixels(rect));
      const summary = histogramSummary(h, undefined);
      const mean = (bins: ArrayLike<number>) => {
        let sum = 0;
        for (let i = 0; i < bins.length; i++) sum += i * bins[i];
        return h.samples ? sum / h.samples : 0;
      };
      const [r, g, b] = [mean(h.red), mean(h.green), mean(h.blue)];
      const hex = '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
      return { rect, ...summary, meanColor: h.samples ? hex : null, cast: { redBlue: round(r - b, 1), greenMagenta: round(g - (r + b) / 2, 1) } };
    },
  };

  const updateLayer: AgentTool = {
    name: 'update_adjustment_layer',
    title: 'Change an adjustment layer',
    description:
      'Shows or hides a layer, renames it, or changes its blend mode or opacity, as one undo step. Change its parameters with set_adjustments ("layers.<id>.<control>"). Returns the updated layer.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: LAYER_ID,
        enabled: { type: 'boolean', description: 'false hides the layer without deleting it.' },
        blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Blend mode (see list_controls).' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Layer opacity 0-1.' },
        name: { type: 'string', description: 'Layer name shown in the layers panel.' }
      },
      required: ['layer'],
      additionalProperties: false
    },
    annotations: { title: 'Change an adjustment layer', ...WRITE_IDEMPOTENT },
    handler: ({ layer, enabled, blend, opacity, name }) => {
      layerOrThrow(layer);
      if (enabled === undefined && blend === undefined && opacity === undefined && name === undefined) {
        throw new Error('Nothing to change. Pass enabled, blend, opacity or name.');
      }
      if (blend !== undefined && !isBlendMode(blend)) throw new Error(`Unknown blend mode "${blend}".`);
      controller.updateAdjustmentLayer(layer, { enabled, blend: blend as BlendMode | undefined, opacity, name });
      return { layer: layerJson(layer) };
    }
  };

  const removeLayer: AgentTool = {
    name: 'remove_adjustment_layer',
    title: 'Delete an adjustment layer',
    description: 'Deletes an adjustment layer and its mask as one undo step. To hide it instead, use update_adjustment_layer with enabled false. Returns the remaining layer ids, bottom to top.',
    inputSchema: { type: 'object', properties: { layer: LAYER_ID }, required: ['layer'], additionalProperties: false },
    annotations: { title: 'Delete an adjustment layer', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: ({ layer }) => {
      layerOrThrow(layer);
      controller.removeAdjustmentLayer(layer);
      return { removed: layer, layers: controller.getAdjustmentLayers().map((l) => l.id) };
    }
  };

  const moveLayer: AgentTool = {
    name: 'move_adjustment_layer',
    title: 'Reorder an adjustment layer',
    description:
      'Moves an adjustment layer to a position in the stack (0 = bottom, applied first) as one undo step. Layers apply bottom to top, so order changes the result. Returns the layer ids, bottom to top.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: LAYER_ID,
        to: { type: 'integer', minimum: 0, description: 'New index, 0 = bottom; past the top means the top.' }
      },
      required: ['layer', 'to'],
      additionalProperties: false
    },
    annotations: { title: 'Reorder an adjustment layer', ...WRITE_IDEMPOTENT },
    handler: ({ layer, to }) => {
      const { index } = layerOrThrow(layer);
      const top = controller.getAdjustmentLayers().length - 1;
      const target = Math.min(to, top);
      if (target === index) throw new Error(`Layer "${layer}" is already at index ${index} (0 = bottom, ${top} = top).`);
      controller.moveAdjustmentLayer(layer, target);
      return { layer, index: target, layers: controller.getAdjustmentLayers().map((l) => l.id) };
    }
  };

  const setCrop: AgentTool = {
    name: 'set_crop',
    title: 'Crop the image',
    description:
      'Sets the crop box in natural image pixels of the un-rotated source (origin top-left; see get_image_info for the size) as one undo step. Non-destructive: reset_crop restores the whole image. Returns the new geometry and output size.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', minimum: 0, description: 'Left edge in source pixels.' },
        y: { type: 'number', minimum: 0, description: 'Top edge in source pixels.' },
        width: { type: 'number', exclusiveMinimum: 0, description: 'Width in source pixels.' },
        height: { type: 'number', exclusiveMinimum: 0, description: 'Height in source pixels.' }
      },
      required: ['x', 'y', 'width', 'height'],
      additionalProperties: false
    },
    annotations: { title: 'Crop the image', ...WRITE_IDEMPOTENT },
    handler: ({ x, y, width, height }) => {
      const image = requireImage();
      if (x + width > image.width + 0.5 || y + height > image.height + 0.5) {
        throw new Error(`The crop box (${x}, ${y}, ${width} × ${height}) goes outside the ${image.width} × ${image.height} image.`);
      }
      controller.setCrop({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
      return geometry();
    }
  };

  const resetCrop: AgentTool = {
    name: 'reset_crop',
    title: 'Remove the crop',
    description: 'Removes the crop so the whole image shows again, as one undo step. Returns the new geometry.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Remove the crop', ...WRITE_IDEMPOTENT },
    handler: () => {
      if (!controller.getState().crop) throw new Error('The image is not cropped.');
      controller.resetCrop();
      return geometry();
    }
  };

  const setRotation: AgentTool = {
    name: 'set_rotation',
    title: 'Rotate the image',
    description:
      'Sets the image rotation in degrees clockwise, as one undo step. Quarter turns (90, 180, 270) keep every pixel; other angles straighten the image inside a larger frame with transparent corners, so crop afterwards. Returns the new geometry.',
    inputSchema: {
      type: 'object',
      properties: { degrees: { type: 'number', minimum: -360, maximum: 360, description: 'Absolute rotation in degrees clockwise (0 = upright).' } },
      required: ['degrees'],
      additionalProperties: false
    },
    annotations: { title: 'Rotate the image', ...WRITE_IDEMPOTENT },
    handler: ({ degrees }) => {
      requireImage();
      controller.setRotation(degrees);
      return geometry();
    }
  };

  const flipImage: AgentTool = {
    name: 'flip_image',
    title: 'Flip the image',
    description: 'Mirrors the image horizontally (left-right) or vertically (top-bottom), as one undo step. Flipping twice restores it. Returns the new geometry.',
    inputSchema: {
      type: 'object',
      properties: { axis: { type: 'string', enum: ['horizontal', 'vertical'], description: 'horizontal mirrors left-right; vertical mirrors top-bottom.' } },
      required: ['axis'],
      additionalProperties: false
    },
    annotations: { title: 'Flip the image', ...WRITE },
    handler: ({ axis }) => {
      requireImage();
      if (axis === 'horizontal') controller.flipHorizontal();
      else controller.flipVertical();
      return geometry();
    }
  };

  const undo: AgentTool = {
    name: 'undo_image',
    title: 'Undo an image edit',
    description: 'Undoes the last image edit (one tool call is one step). Returns whether undo and redo are still available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Undo an image edit', ...WRITE },
    handler: () => {
      if (!controller.undo()) throw new Error('Nothing to undo.');
      return history();
    }
  };

  const redo: AgentTool = {
    name: 'redo_image',
    title: 'Redo an image edit',
    description: 'Redoes the last undone image edit. Returns whether undo and redo are still available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Redo an image edit', ...WRITE },
    handler: () => {
      if (!controller.redo()) throw new Error('Nothing to redo.');
      return history();
    }
  };

  return [getImageInfo, getHistogram, measureRegion, updateLayer, removeLayer, moveLayer, setCrop, resetCrop, setRotation, flipImage, setBitDepth, undo, redo];
}
