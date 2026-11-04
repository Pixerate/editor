/**
 * The shared brush library's agent tools for a paint editor (`createPaintBrushLibraryToolProvider`),
 * with `preview_brush` painted by this editor.
 */

import { PAINT_PROFILE } from '../brushes/profiles';
import { resolveBrush } from '../brushes/resolve';
import type { Brush } from '../brushes/types';
import { createBrushLibraryToolProvider, type BrushLibraryToolProviderOptions, type BrushPreviewRenderer } from '../brushes/tools';
import type { AgentToolProvider } from '../tools/registry.js';
import { bytesToBase64, encodePng } from '../raster/png';
import type { PaintEditorController } from './controller';
import { DEFAULT_PAPER, type PaperSettings } from './paper';
import { renderBrushThumbnail } from './thumbnails';

export type PaintBrushLibraryToolProviderOptions = Omit<BrushLibraryToolProviderOptions, 'renderPreview'>;

/**
 * A brush preview renderer (`BrushPreviewRenderer`, as `preview_brush` and `BrushLibraryEditor`
 * take) that paints the test stroke with the paint engine on `paper` (read on every call; default
 * the default paper). Any brush the paint editor renders, so also the image editor's.
 */
export function paintBrushPreviewRenderer(paper: () => PaperSettings = () => DEFAULT_PAPER): BrushPreviewRenderer {
  const render = (brush: Brush, { width, height, color }: { width: number; height: number; color: string }) => {
    const t = renderBrushThumbnail(resolveBrush(brush), { paper: paper(), width, height, color: color.toLowerCase() });
    return { data: bytesToBase64(encodePng(t.width, t.height, t.data)), mimeType: 'image/png' };
  };
  // The paper it paints on, so preview colours are chosen against it.
  return Object.defineProperty(render, 'paper', { get: () => paper().color, enumerable: true }) as BrushPreviewRenderer;
}

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
    renderPreview: paintBrushPreviewRenderer(() => controller.getState().document.paper),
  });
}
