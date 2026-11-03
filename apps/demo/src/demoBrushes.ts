import { createBrushLibrary } from '@pixerate/editor/brushes';

/**
 * The demo's one brush library (`@pixerate/editor/brushes`), shared by every tab that paints: a
 * brush saved in the Paint tab's brush editor, or made with the brushes__* tools, shows in all of
 * them. It lives in memory, so a reload starts from the built-in presets.
 */
export const demoBrushLibrary = createBrushLibrary();
