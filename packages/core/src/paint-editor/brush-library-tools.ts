/**
 * The shared brush library's agent tools for a paint editor (`createPaintBrushLibraryToolProvider`),
 * with `preview_brush` painted by this editor.
 */

import { PAINT_PROFILE } from '../brushes/profiles';
import { resolveBrush } from '../brushes/resolve';
import { createBrushLibraryToolProvider, type BrushLibraryToolProviderOptions } from '../brushes/tools';
import type { AgentToolProvider } from '../tools/registry.js';
import { bytesToBase64, encodePng } from '../raster/png';
import type { PaintEditorController } from './controller';
import { renderBrushThumbnail } from './thumbnails';

export type PaintBrushLibraryToolProviderOptions = Omit<BrushLibraryToolProviderOptions, 'renderPreview'>;

/**
 * The brush library tools for a paint editor (`@pixerate/editor/brushes`' provider on the
 * editor's `brushLibrary`, `PAINT_PROFILE`), with `preview_brush` painting the test stroke on the
 * editor's paper. Register it next to `createPaintEditorToolProvider`: it lists, saves, shares and
 * previews the brushes `set_brush` picks.
 */
export function createPaintBrushLibraryToolProvider(controller: PaintEditorController, options: PaintBrushLibraryToolProviderOptions = {}): AgentToolProvider {
  return createBrushLibraryToolProvider(controller.brushLibrary, {
    profile: PAINT_PROFILE,
    stickers: () => controller.stickers.provider,
    ...options,
    renderPreview: (brush, { width, height, color }) => {
      const t = renderBrushThumbnail(resolveBrush(brush), { paper: controller.getState().document.paper, width, height, color: color.toLowerCase() });
      return { data: bytesToBase64(encodePng(t.width, t.height, t.data)), mimeType: 'image/png' };
    },
  });
}
