import type { CaptureRenderRequest, CaptureSurface } from '../tools/capture.js';
import type { ImageEditorController } from './controller';
import type { SelectionMask } from './selection/mask';

const NO_CANVAS = 'Rendering is not available in this environment.';

/** Darkens what is outside the selection (natural pixels), so its coverage reads at a glance. */
function selectionShade(selection: SelectionMask, doc: Document): HTMLCanvasElement | null {
  const canvas = doc.createElement('canvas');
  canvas.width = selection.width;
  canvas.height = selection.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const pixels = context.createImageData(selection.width, selection.height);
  for (let i = 0; i < selection.data.length; i++) {
    pixels.data[i * 4 + 3] = Math.round(150 * (1 - selection.data[i] / 255));
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/** Draws a region of the image editor's source view for `capture_view`. */
async function renderImageRegion(controller: ImageEditorController, request: CaptureRenderRequest): Promise<string> {
  const state = controller.getState();
  // Never render above natural size; small regions are enlarged when drawn.
  const k = Math.min(1, request.scale);
  const view = await controller.renderSourceView({ scale: k });
  if (!view) throw new Error('No image is loaded, so there is nothing to capture.');
  if (typeof document === 'undefined') throw new Error(NO_CANVAS);
  const out = document.createElement('canvas');
  out.width = request.width;
  out.height = request.height;
  const context = out.getContext('2d');
  if (!context) throw new Error(NO_CANVAS);
  const { rect } = request;
  // Upscaled regions keep hard pixel edges, so the agent sees real pixels.
  context.imageSmoothingEnabled = request.scale < 1;
  if (request.format === 'jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, out.width, out.height);
  }
  const kx = view.width / state.imageDimensions.width;
  const ky = view.height / state.imageDimensions.height;
  context.drawImage(view, rect.x * kx, rect.y * ky, rect.width * kx, rect.height * ky, 0, 0, out.width, out.height);
  if (request.includeOverlays) {
    const s = request.scale;
    const selection = state.selection;
    if (selection?.bounds && selection.width === state.imageDimensions.width && selection.height === state.imageDimensions.height) {
      const shade = selectionShade(selection, document);
      if (shade) context.drawImage(shade, rect.x, rect.y, rect.width, rect.height, 0, 0, out.width, out.height);
    }
    if (state.crop) {
      context.save();
      context.strokeStyle = '#ffd400';
      context.lineWidth = 2;
      context.setLineDash([6, 4]);
      context.strokeRect((state.crop.x - rect.x) * s, (state.crop.y - rect.y) * s, state.crop.width * s, state.crop.height * s);
      context.restore();
    }
  }
  const url = out.toDataURL(request.format === 'jpeg' ? 'image/jpeg' : 'image/png', request.quality);
  if (!url.startsWith('data:image/') || url.indexOf(',') === url.length - 1) throw new Error(NO_CANVAS);
  return url;
}

/**
 * The image editor as a capture surface. Units are natural pixels of the source image,
 * the same space as `get_selection` and `select_region`: crop, rotation and flips are not
 * applied (use `render_preview` for the final framing), adjustments, layers and annotations
 * are. Regions: the whole image, the selection's bounds, or a rect. Small regions are
 * enlarged up to 8× with hard pixel edges for close inspection.
 */
export function createImageCaptureSurface(controller: ImageEditorController): CaptureSurface {
  const whole = () => {
    const { width, height } = controller.getState().imageDimensions;
    return width > 0 && height > 0 ? { x: 0, y: 0, width, height } : null;
  };
  return {
    units: 'image pixels',
    content: whole,
    selection: () => ({ rect: controller.getState().selection?.bounds ?? null }),
    overlays: 'a shade over unselected pixels and the crop box outline',
    maxScale: 8,
    render: (request) => renderImageRegion(controller, request),
  };
}
