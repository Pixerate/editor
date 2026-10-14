import type { SpreadsheetClipboardData, SpreadsheetClipboardSource, CellRange } from '@pixerate/editor/spreadsheet';

/** The parts of the reactive spreadsheet the clipboard handlers need. */
export interface SpreadsheetClipboardTarget {
  readonly editingCell: unknown;
  readonly selectedRange: CellRange | null;
  copyToClipboardData(range?: CellRange | null): SpreadsheetClipboardData;
  pasteClipboardData(source: SpreadsheetClipboardSource): boolean;
  exportToTsv(range?: CellRange | null): string;
}

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
 * grid keep native copy/paste. Call `destroy()` to remove the listeners.
 */
export function attachSpreadsheetClipboard(
  getGrid: () => HTMLElement | null,
  sheet: SpreadsheetClipboardTarget,
  isReadOnly: () => boolean
) {
  // Set when a copy event wrote the selection, so the keyboard fallback is skipped.
  let copied = false;

  const handleCopy = (e: ClipboardEvent) => {
    if (!gridHasFocus(getGrid()) || sheet.editingCell || !e.clipboardData || !sheet.selectedRange) return;
    for (const [type, data] of Object.entries(sheet.copyToClipboardData(sheet.selectedRange))) {
      e.clipboardData.setData(type, data);
    }
    copied = true;
    e.preventDefault();
  };
  const handlePaste = (e: ClipboardEvent) => {
    if (isReadOnly() || !gridHasFocus(getGrid()) || sheet.editingCell || !e.clipboardData) return;
    if (sheet.pasteClipboardData(e.clipboardData)) e.preventDefault();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('copy', handleCopy);
    document.addEventListener('paste', handlePaste);
  }

  return {
    /**
     * Call on Mod+C (without preventing default). The browser normally
     * follows with a `copy` event; where it doesn't (no selection in some
     * browsers), the selection is written as plain TSV instead.
     */
    copyShortcutFallback() {
      copied = false;
      setTimeout(() => {
        // Rejected when clipboard access is denied; nothing else to fall back to.
        if (!copied) Promise.resolve(navigator.clipboard?.writeText(sheet.exportToTsv(sheet.selectedRange))).catch(() => {});
      }, 0);
    },
    destroy() {
      if (typeof document === 'undefined') return;
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('paste', handlePaste);
    }
  };
}
