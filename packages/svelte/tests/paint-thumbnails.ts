import { vi, type MockInstance } from 'vitest';
import { PaintEditorController } from '@pixerate/editor/paint-editor';

/**
 * Swaps brush thumbnails for blank ones of the requested size. The brush panel paints a test
 * stroke for every brush in the library on each render (about 55 brushes, several seconds on a CI
 * runner), so panel tests that render it timed out. They check the panel's wiring; thumbnail
 * pixels are covered by the core tests (`paint-blending.test.ts`). Restore with
 * `vi.restoreAllMocks()` or the returned spy's `mockRestore()`.
 */
export function stubBrushThumbnails(): MockInstance<PaintEditorController['brushThumbnail']> {
  return vi.spyOn(PaintEditorController.prototype, 'brushThumbnail').mockImplementation((_id, options = {}) => {
    const width = options.width ?? 160;
    const height = options.height ?? 48;
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  });
}
