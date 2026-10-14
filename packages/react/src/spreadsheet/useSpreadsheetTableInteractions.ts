import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  computeFillTarget,
  normalizeRange,
  type CellRange
} from '@pixerate/editor/spreadsheet';
import type { useSpreadsheetEditor } from './useSpreadsheetEditor';

type SpreadsheetState = ReturnType<typeof useSpreadsheetEditor>;

/** True when focus is in the grid itself, not in a text input (cell editor, formula bar). */
function gridHasFocus(grid: HTMLElement | null): boolean {
  if (!grid || typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active || !grid.contains(active)) return false;
  return !(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement);
}

/**
 * Copy and paste for the grid. Copy writes TSV, an HTML table and the
 * lossless `application/x.pixerate.spreadsheet+json` format; paste prefers
 * that format, then HTML, then TSV.
 *
 * The listeners are on `document`: with no text selection the browser fires
 * `copy`/`paste` at `<body>`, not at the focused grid. Text inputs inside the
 * grid keep native copy/paste.
 */
export function useSpreadsheetClipboard(
  gridRef: RefObject<HTMLElement | null>,
  state: SpreadsheetState,
  readOnly: boolean
) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // Set when a copy event wrote the selection, so the keyboard fallback is skipped.
  const copiedRef = useRef(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleCopy = (e: ClipboardEvent) => {
      const s = stateRef.current;
      if (!gridHasFocus(gridRef.current) || s.editingCell || !e.clipboardData || !s.selectedRange) return;
      for (const [type, data] of Object.entries(s.copyToClipboardData(s.selectedRange))) {
        e.clipboardData.setData(type, data);
      }
      copiedRef.current = true;
      e.preventDefault();
    };
    const handlePaste = (e: ClipboardEvent) => {
      const s = stateRef.current;
      if (readOnlyRef.current || !gridHasFocus(gridRef.current) || s.editingCell || !e.clipboardData) return;
      if (s.pasteClipboardData(e.clipboardData)) e.preventDefault();
    };
    document.addEventListener('copy', handleCopy);
    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('paste', handlePaste);
    };
  }, [gridRef]);

  /**
   * Call on Mod+C (without preventing default). The browser normally follows
   * with a `copy` event; where it doesn't (no selection in some browsers),
   * the selection is written as plain TSV instead.
   */
  const copyShortcutFallback = useCallback(() => {
    copiedRef.current = false;
    setTimeout(() => {
      if (copiedRef.current) return;
      const s = stateRef.current;
      navigator.clipboard?.writeText(s.exportToTsv(s.selectedRange));
    }, 0);
  }, []);

  return { copyShortcutFallback };
}

/**
 * Fill handle dragging: press on the handle, move over cells, release to
 * autofill from the selection into the dragged range (one undo step).
 */
export function useFillHandle(state: SpreadsheetState) {
  const [drag, setDrag] = useState<{ source: CellRange; target: CellRange | null } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const stateRef = useRef(state);
  stateRef.current = state;
  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;
    const handleMouseUp = () => {
      const current = dragRef.current;
      setDrag(null);
      if (current?.target) stateRef.current.autofill(current.source, current.target);
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [dragging]);

  const startFill = useCallback((e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
    const range = stateRef.current.selectedRange;
    if (range) setDrag({ source: normalizeRange(range), target: null });
  }, []);

  const extendFill = useCallback((row: number, col: number) => {
    const current = dragRef.current;
    if (!current) return;
    setDrag({ source: current.source, target: computeFillTarget(current.source, { row, col }) });
  }, []);

  return { fillTarget: drag?.target ?? null, isFilling: dragging, startFill, extendFill };
}
