/**
 * The page kit (#814): core's dependency-free 2-D helpers (labels, isometric projection,
 * connectors and helices, path lengths and trims, fitting text, contrast and ink, scales and
 * number formats) plus a thin page layer (SVG elements, theme, resize, the motion contract), for
 * sandboxed, model-written pages that load nothing from the network.
 *
 * This entry exports strings only and imports nothing: inline `PAGE_KIT` in a page (it sets
 * `window.pixerateKit`) and give `PAGE_KIT_GUIDE` to the model writing the page. With
 * `@pixerate/genui-core`'s `assemblePage`, pass `PAGE_KIT_FILES` as `kits` and fill a slot with
 * `kit:kit.js`.
 */
import { PAGE_KIT, PAGE_KIT_GUIDE, PAGE_KIT_HASH, PAGE_KIT_VERSION } from './bundle.generated.js';

export { PAGE_KIT, PAGE_KIT_GUIDE, PAGE_KIT_HASH, PAGE_KIT_VERSION };

/** The kit as files for a host or `assemblePage({ kits })`: `kit.js` (the script) and `kit.md` (the guide). */
export const PAGE_KIT_FILES: Readonly<Record<'kit.js' | 'kit.md', string>> = Object.freeze({ 'kit.js': PAGE_KIT, 'kit.md': PAGE_KIT_GUIDE });
