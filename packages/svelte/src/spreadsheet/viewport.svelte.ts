import { untrack } from 'svelte';
import {
  fullSpreadsheetViewWindow,
  getSpreadsheetScrollToCell,
  getSpreadsheetViewWindow,
  measureSpreadsheetView,
  sameSpreadsheetViewWindow,
  shouldVirtualizeSpreadsheet,
  type CellCoordinate,
  type CellRange,
  type SpreadsheetViewModel,
  type SpreadsheetViewport,
  type SpreadsheetViewWindowOptions
} from '@pixerate/editor/spreadsheet';

export interface SpreadsheetViewportSource {
  view: () => SpreadsheetViewModel;
  /** `'auto'` (default): virtualise large views only; `true` / `false` force it. */
  virtualize?: () => boolean | 'auto' | undefined;
  /** Merged ranges, rendered whole when they cross the window's edge. */
  merges?: () => readonly CellRange[] | undefined;
  /** Scrolled into view when it changes (virtualised views only). */
  activeCell?: () => CellCoordinate | null | undefined;
  overscanRows?: number;
  overscanColumns?: number;
}

/**
 * Virtualised rendering for `SpreadsheetEditor` (the Svelte counterpart of
 * React's `useSpreadsheetViewport`): tracks the scroll container passed to
 * `attach`, works out the window of rows and columns to render, and scrolls
 * the active cell into view. Call it while a component initialises.
 */
export function createSpreadsheetViewport(source: SpreadsheetViewportSource) {
  let viewport = $state.raw<SpreadsheetViewport>({ scrollTop: 0, scrollLeft: 0, width: 0, height: 0 });
  let element: HTMLElement | null = null;

  const metrics = $derived(measureSpreadsheetView(source.view()));
  const virtual = $derived(shouldVirtualizeSpreadsheet(source.view(), source.virtualize?.() ?? 'auto'));
  const windowOptions = $derived<SpreadsheetViewWindowOptions>({
    merges: source.merges?.(),
    overscanRows: source.overscanRows,
    overscanColumns: source.overscanColumns
  });
  const win = $derived(virtual ? getSpreadsheetViewWindow(metrics, viewport, windowOptions) : fullSpreadsheetViewWindow(metrics));

  const read = (el: HTMLElement): SpreadsheetViewport => ({
    scrollTop: el.scrollTop,
    scrollLeft: el.scrollLeft,
    width: el.clientWidth,
    height: el.clientHeight
  });

  /** Stores a new viewport, re-rendering only when the window it gives changes. */
  function update(next: SpreadsheetViewport) {
    if (!virtual) return;
    const prev = viewport;
    const same =
      prev.width === next.width &&
      prev.height === next.height &&
      sameSpreadsheetViewWindow(getSpreadsheetViewWindow(metrics, prev, windowOptions), getSpreadsheetViewWindow(metrics, next, windowOptions));
    if (!same) viewport = next;
  }

  function onScroll() {
    if (element) update(read(element));
  }

  /** Tracks `el` (the scroll container); returns a cleanup function. */
  function attach(el: HTMLElement | null): () => void {
    element = el;
    if (!el) return () => {};
    onScroll();
    if (typeof ResizeObserver === 'undefined') return () => {};
    const observer = new ResizeObserver(() => onScroll());
    observer.observe(el);
    return () => observer.disconnect();
  }

  // Measure once virtualisation turns on (the element may already be attached).
  $effect(() => {
    if (virtual) untrack(onScroll);
  });

  // Keyboard navigation and selection: bring the active cell into view.
  // Only the active cell and the mode re-run it: scrolling away from the
  // active cell (or an edit elsewhere) must not snap back.
  $effect(() => {
    const cell = source.activeCell?.();
    const row = cell?.row;
    const col = cell?.col;
    if (!virtual || row === undefined || col === undefined) return;
    untrack(() => {
      const base = element ? read(element) : viewport;
      const target = getSpreadsheetScrollToCell(metrics, base, { row, col });
      if (!target) return;
      if (element) {
        if (target.scrollTop !== undefined) element.scrollTop = target.scrollTop;
        if (target.scrollLeft !== undefined) element.scrollLeft = target.scrollLeft;
      }
      // Some environments (jsdom) never fire the scroll event.
      update({ ...base, ...target });
    });
  });

  return {
    get metrics() {
      return metrics;
    },
    /** What to render; `virtual: false` renders every row and column. */
    get window() {
      return win;
    },
    onScroll,
    attach
  };
}
