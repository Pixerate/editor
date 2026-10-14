import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  fullSpreadsheetViewWindow,
  getSpreadsheetScrollToCell,
  getSpreadsheetViewWindow,
  measureSpreadsheetView,
  sameSpreadsheetViewWindow,
  shouldVirtualizeSpreadsheet,
  type CellCoordinate,
  type CellRange,
  type SpreadsheetViewMetrics,
  type SpreadsheetViewModel,
  type SpreadsheetViewport,
  type SpreadsheetViewWindow
} from '@pixerate/editor/spreadsheet';

// Browsers without layout effects on the server: fall back to useEffect there.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface SpreadsheetViewportOptions {
  /** `'auto'` (default): virtualise large views only; `true` / `false` force it. */
  virtualize?: boolean | 'auto';
  /** Merged ranges, rendered whole when they cross the window's edge. */
  merges?: readonly CellRange[];
  /** Scrolled into view when it changes (virtualised views only). */
  activeCell?: CellCoordinate | null;
  overscanRows?: number;
  overscanColumns?: number;
}

export interface SpreadsheetViewportState {
  metrics: SpreadsheetViewMetrics;
  /** What to render; `virtual: false` renders every row and column. */
  window: SpreadsheetViewWindow;
  /** Attach to the scroll container's `onScroll`. */
  onScroll: () => void;
}

/**
 * Virtualised rendering for `SpreadsheetEditor`: tracks the scroll
 * container (`scrollRef`), works out the window of rows and columns to
 * render, and scrolls the active cell into view.
 */
export function useSpreadsheetViewport(
  scrollRef: RefObject<HTMLElement | null>,
  view: SpreadsheetViewModel,
  options: SpreadsheetViewportOptions = {}
): SpreadsheetViewportState {
  const metrics = useMemo(() => measureSpreadsheetView(view), [view]);
  const virtual = shouldVirtualizeSpreadsheet(view, options.virtualize ?? 'auto');
  const [viewport, setViewport] = useState<SpreadsheetViewport>({ scrollTop: 0, scrollLeft: 0, width: 0, height: 0 });
  const windowOptions = useMemo(
    () => ({ merges: options.merges, overscanRows: options.overscanRows, overscanColumns: options.overscanColumns }),
    [options.merges, options.overscanRows, options.overscanColumns]
  );

  const win = useMemo(
    () => (virtual ? getSpreadsheetViewWindow(metrics, viewport, windowOptions) : fullSpreadsheetViewWindow(metrics)),
    [virtual, metrics, viewport, windowOptions]
  );

  // Read by the scroll handler, which must not change identity.
  const latest = useRef({ metrics, viewport, virtual, windowOptions });
  latest.current = { metrics, viewport, virtual, windowOptions };

  const readViewport = useCallback((): SpreadsheetViewport | null => {
    const el = scrollRef.current;
    if (!el) return null;
    return { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, width: el.clientWidth, height: el.clientHeight };
  }, [scrollRef]);

  /** Stores a new viewport, re-rendering only when the window it gives changes. */
  const updateViewport = useCallback((next: SpreadsheetViewport) => {
    setViewport((prev) => {
      const { metrics: m, virtual: v, windowOptions: o } = latest.current;
      if (!v) return prev;
      const same =
        prev.width === next.width &&
        prev.height === next.height &&
        sameSpreadsheetViewWindow(getSpreadsheetViewWindow(m, prev, o), getSpreadsheetViewWindow(m, next, o));
      return same ? prev : next;
    });
  }, []);

  const onScroll = useCallback(() => {
    const next = readViewport();
    if (next) updateViewport(next);
  }, [readViewport, updateViewport]);

  // Measure the container, and again whenever it is resized.
  useIsomorphicLayoutEffect(() => {
    if (!virtual) return;
    onScroll();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => onScroll());
    observer.observe(el);
    return () => observer.disconnect();
  }, [virtual, onScroll, scrollRef]);

  // Keyboard navigation and selection: bring the active cell into view.
  const activeRow = options.activeCell?.row;
  const activeCol = options.activeCell?.col;
  useIsomorphicLayoutEffect(() => {
    if (!virtual || activeRow === undefined || activeCol === undefined) return;
    const el = scrollRef.current;
    const current = latest.current.viewport;
    const measured = readViewport();
    const base: SpreadsheetViewport = measured
      ? { ...measured, scrollTop: Math.max(measured.scrollTop, 0), scrollLeft: Math.max(measured.scrollLeft, 0) }
      : current;
    const target = getSpreadsheetScrollToCell(latest.current.metrics, base, { row: activeRow, col: activeCol });
    if (!target) return;
    const next = { ...base, ...target };
    if (el) {
      if (target.scrollTop !== undefined) el.scrollTop = target.scrollTop;
      if (target.scrollLeft !== undefined) el.scrollLeft = target.scrollLeft;
    }
    // Some environments (jsdom) never fire the scroll event.
    updateViewport(next);
    // Only the active cell and the mode: scrolling away from the active cell
    // (or an edit elsewhere) must not snap back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtual, activeRow, activeCol]);

  return { metrics, window: win, onScroll };
}
