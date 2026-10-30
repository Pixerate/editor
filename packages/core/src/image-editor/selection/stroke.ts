import { createSelectionMask, type SelectionMask } from './mask';
import { modifySelection } from './modify';

/**
 * The band Edit › Stroke paints along a selection's edge, `width` pixels wide: `inside` is the
 * selection minus the selection contracted by `width`, `outside` the selection expanded by
 * `width` minus the selection, and `center` straddles the edge by `width / 2` each way. Built
 * from the exact distance transform the Modify commands use, so the band keeps soft edges.
 */
export function selectionRing(sel: SelectionMask, width: number, location: 'inside' | 'center' | 'outside'): SelectionMask {
  const half = location === 'center' ? width / 2 : width;
  const outer = location === 'inside' ? sel : modifySelection(sel, 'expand', half);
  const inner = location === 'outside' ? sel : modifySelection(sel, 'contract', half);
  const out = new Uint8Array(sel.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, outer.data[i] - inner.data[i]);
  return createSelectionMask(sel.width, sel.height, out);
}
