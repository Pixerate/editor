import React, { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import {
  indexToColName,
  getSpreadsheetMenuItems,
  normalizeRange,
  rangeContains,
  type SpreadsheetColumn,
  type SpreadsheetRow,
  type CellData,
  type CellRange,
  type SpreadsheetMenuItem,
  type SpreadsheetViewColumn,
  type SpreadsheetViewRow,
  formatCellForDisplay,
  numberFormatColorToCss,
  getConditionalFormatCss,
  getConditionalFormatIcon,
  getDataBarCss,
  type ConditionalCellFormat,
  type SpreadsheetPanelId
} from '@pixerate/editor/spreadsheet';
import { useSpreadsheetEditor } from './useSpreadsheetEditor';
import { SpreadsheetContextMenu } from './SpreadsheetContextMenu';
import { SpreadsheetGroupRow } from './SpreadsheetGroupRow';
import { useFillHandle, useSpreadsheetClipboard } from './useSpreadsheetTableInteractions';
import { SpreadsheetValidationDialog } from './SpreadsheetValidationDialog';
import { SpreadsheetConditionalFormatPanel, SpreadsheetDataValidationPanel } from './SpreadsheetRulePanels';
import { useSpreadsheetViewport } from './useSpreadsheetViewport';

// Sizes of the sticky header row and row-number column, for frozen-pane offsets.
const COLUMN_HEADER_HEIGHT = 28;
const ROW_HEADER_WIDTH = 48;

/** Sticky positioning for cells in frozen rows and/or columns. */
function frozenCellStyle(
  viewRow: Extract<SpreadsheetViewRow, { kind: 'row' }>,
  viewCol: SpreadsheetViewColumn
): React.CSSProperties | undefined {
  if (!viewRow.frozen && !viewCol.frozen) return undefined;
  return {
    position: 'sticky',
    ...(viewRow.frozen ? { top: COLUMN_HEADER_HEIGHT + viewRow.stickyTop } : {}),
    ...(viewCol.frozen ? { left: ROW_HEADER_WIDTH + viewCol.stickyLeft } : {}),
    zIndex: viewRow.frozen && viewCol.frozen ? 14 : viewRow.frozen ? 12 : 11,
    background: 'var(--background, #fff)'
  };
}
import { FormulaHints } from './FormulaHints';
import { SheetTabs } from './SheetTabs';

const coordKey = (cell: { row: number; col: number } | null) => (cell ? `${indexToColName(cell.col)}${cell.row + 1}` : '');

/** Thin border drawn on the outer edges of a dynamic array's spill range. */
function spillBorderStyle(range: CellRange, row: number, col: number): React.CSSProperties {
  const line = '1px solid color-mix(in srgb, var(--primary, #6366f1) 60%, transparent)';
  return {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 5,
    borderTop: row === range.startRow ? line : undefined,
    borderBottom: row === range.endRow ? line : undefined,
    borderLeft: col === range.startCol ? line : undefined,
    borderRight: col === range.endCol ? line : undefined
  };
}

/**
 * A cell's display text: formatted with its number format, numbers
 * right-aligned, `[Red]`-style colours applied. A conditional format adds a
 * data bar and / or an icon, and its font colour wins over the format's.
 */
function CellText({ cell, conditional }: { cell: CellData; conditional?: ConditionalCellFormat }) {
  const shown = formatCellForDisplay(cell);
  const color = conditional?.color ?? (shown.color ? numberFormatColorToCss(shown.color) : undefined);
  const decorated = !!conditional?.dataBar || !!conditional?.icon;
  const text = (
    <span
      className={`truncate block max-w-full ${cell.error ? 'text-destructive font-semibold' : ''}`}
      title={cell.error ? cell.errorMessage ?? cell.error : undefined}
      data-numeric={shown.numeric ? '' : undefined}
      style={
        shown.numeric || color || decorated
          ? {
              ...(decorated ? { position: 'relative' as const } : {}),
              ...(conditional?.icon ? { flex: 1, minWidth: 0 } : {}),
              ...(shown.numeric ? { textAlign: 'right' as const } : {}),
              ...(color ? { color } : {})
            }
          : undefined
      }
    >
      {conditional?.hideValue ? '' : shown.text}
    </span>
  );
  if (!conditional || !decorated) return text;
  const icon = conditional.icon ? getConditionalFormatIcon(conditional.icon.set, conditional.icon.index) : null;
  return (
    <>
      {conditional.dataBar && (
        <span aria-hidden="true" className="spreadsheet-data-bar" style={getDataBarCss(conditional.dataBar) as React.CSSProperties} />
      )}
      {icon ? (
        <span className="flex items-center gap-1 min-w-0" style={{ position: 'relative' }}>
          <span className="spreadsheet-cf-icon shrink-0" role="img" aria-label={icon.label} data-icon={conditional.icon!.id} style={{ color: icon.color }}>
            {icon.glyph}
          </span>
          {text}
        </span>
      ) : (
        text
      )}
    </>
  );
}

export interface SpreadsheetEditorProps {
  state?: ReturnType<typeof useSpreadsheetEditor>;
  readOnly?: boolean;
  customCellRenderer?: (props: { row: SpreadsheetRow; col: SpreadsheetColumn; cell: CellData }) => React.ReactNode;
  onAddColumnClick?: () => void;
  onColumnHeaderClick?: (col: SpreadsheetColumn) => void;
  onColumnResize?: (colId: string, width: number) => void;
  /** Show the sheet tabs bar under the grid (add, switch, rename, reorder, delete sheets). */
  showSheetTabs?: boolean;
  /**
   * Render only the rows and columns in (or near) view. `'auto'` (default)
   * virtualises sheets with more than 200 displayed rows or 60 columns;
   * `true` / `false` force it.
   */
  virtualize?: boolean | 'auto';
}

/** A rendered column, or the space standing for the columns left out. */
type ColumnSlot = { kind: 'col'; viewCol: SpreadsheetViewColumn } | { kind: 'space'; key: string; width: number };
/** A rendered row, or the space standing for the rows left out. */
type RowSlot = { kind: 'row'; viewRow: SpreadsheetViewRow } | { kind: 'space'; key: string; height: number };

export const SpreadsheetEditor: React.FC<SpreadsheetEditorProps> = ({
  state: externalState,
  readOnly = false,
  customCellRenderer,
  onAddColumnClick,
  onColumnHeaderClick,
  onColumnResize,
  showSheetTabs = false,
  virtualize = 'auto'
}) => {
  const defaultState = useSpreadsheetEditor();
  const state = externalState || defaultState;
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const formulaBarRef = useRef<HTMLInputElement>(null);
  const cellInputRef = useRef<HTMLInputElement>(null);

  const [resizingColId, setResizingColId] = useState<string | null>(null);
  const [hoveredColId, setHoveredColId] = useState<string | null>(null);
  const [resizeStartX, setResizeStartX] = useState(0);
  const [resizeStartWidth, setResizeStartWidth] = useState(0);

  // Table operations: render model, clipboard, fill handle and context menu.
  const view = state.viewModel;
  // Virtualised rendering: frozen rows/columns, a spacer, the rows and
  // columns in view, another spacer (everything for small sheets).
  const { window: viewWindow, onScroll: handleGridScroll } = useSpreadsheetViewport(scrollRef, view, {
    virtualize,
    merges: state.document.table?.merges,
    activeCell: state.activeCell
  });
  const columnSlots = useMemo<ColumnSlot[]>(() => {
    const col = (viewCol: SpreadsheetViewColumn): ColumnSlot => ({ kind: 'col', viewCol });
    if (!viewWindow.virtual) return view.columns.map(col);
    const slots = view.columns.slice(0, viewWindow.frozenColumns).map(col);
    if (viewWindow.leftSpace > 0) slots.push({ kind: 'space', key: 'space:left', width: viewWindow.leftSpace });
    for (let i = viewWindow.colStart; i < viewWindow.colEnd; i++) slots.push(col(view.columns[i]));
    if (viewWindow.rightSpace > 0) slots.push({ kind: 'space', key: 'space:right', width: viewWindow.rightSpace });
    return slots;
  }, [view, viewWindow]);
  const renderedColumns = useMemo(
    () => columnSlots.flatMap((slot) => (slot.kind === 'col' ? [slot.viewCol] : [])),
    [columnSlots]
  );
  const rowSlots = useMemo<RowSlot[]>(() => {
    const row = (viewRow: SpreadsheetViewRow): RowSlot => ({ kind: 'row', viewRow });
    if (!viewWindow.virtual) return view.rows.map(row);
    const slots = view.rows.slice(0, viewWindow.frozenRows).map(row);
    if (viewWindow.topSpace > 0) slots.push({ kind: 'space', key: 'space:top', height: viewWindow.topSpace });
    for (let i = viewWindow.rowStart; i < viewWindow.rowEnd; i++) slots.push(row(view.rows[i]));
    if (viewWindow.bottomSpace > 0) slots.push({ kind: 'space', key: 'space:bottom', height: viewWindow.bottomSpace });
    return slots;
  }, [view, viewWindow]);
  const { copyShortcutFallback } = useSpreadsheetClipboard(gridRef, state, readOnly);
  const { fillTarget, startFill, extendFill } = useFillHandle(state);
  const [menu, setMenu] = useState<{ x: number; y: number; items: SpreadsheetMenuItem[] } | null>(null);
  // Conditional formatting / data validation manager, opened from the context menu.
  const [panel, setPanel] = useState<SpreadsheetPanelId | null>(null);
  // List dropdown of a list-validated cell.
  const [listMenu, setListMenu] = useState<{ x: number; y: number; row: number; col: number; values: string[] } | null>(null);
  const overlay = state.conditionalFormatOverlay;
  const filter = state.document.table?.filter;
  const filteredColIds = useMemo(
    () => new Set(filter?.enabled ? filter.rules.map((r) => r.colId) : []),
    [filter]
  );

  const handleCellContextMenu = useCallback((rIdx: number, cIdx: number, e: React.MouseEvent) => {
    if (readOnly) return;
    e.preventDefault();
    if (state.editingCell) state.commitEditing();
    if (!state.selectedRange || !rangeContains(state.selectedRange, rIdx, cIdx)) {
      state.selectCell(rIdx, cIdx);
    }
    setMenu({ x: e.clientX, y: e.clientY, items: getSpreadsheetMenuItems(state.controller, { row: rIdx, col: cIdx }) });
  }, [readOnly, state]);

  // Defined names for formula autocomplete.
  const nameSuggestions = useMemo(
    () => state.controller.getNameSuggestions(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.controller, state.document]
  );

  const activeRawValue = useMemo(() => {
    if (!state.activeCell) return '';
    const row = state.document.rows[state.activeCell.row];
    const col = state.document.columns[state.activeCell.col];
    if (!row || !col) return '';
    return state.getCell(row.id, col.id).raw;
  }, [state.activeCell, state.document]);

  // The dynamic array under the active cell (anchor or spilled cell): it gets
  // a border, and a spilled cell shows the anchor's formula greyed out.
  const activeSpill = useMemo(
    () => (state.activeCell ? state.controller.getSpillAt(state.activeCell.row, state.activeCell.col) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.controller, state.activeCell, state.document]
  );
  const spillFormula = activeSpill && !activeRawValue && activeSpill.key !== coordKey(state.activeCell) ? activeSpill.formula : '';

  const coordLabel = useMemo(() => {
    if (!state.activeCell) return '--';
    const colName = indexToColName(state.activeCell.col);
    return `${colName}${state.activeCell.row + 1}`;
  }, [state.activeCell]);

  // Text typed in the formula bar while no cell editor is open.
  const [formulaDraft, setFormulaDraft] = useState<string | null>(null);
  const activeColumn = state.activeCell ? state.document.columns[state.activeCell.col] : undefined;
  const formulaBarReadOnly = readOnly || !state.activeCell || !!activeColumn?.readOnly;

  useEffect(() => {
    setFormulaDraft(null);
  }, [state.activeCell?.row, state.activeCell?.col]);

  const commitFormulaBar = () => {
    if (state.editingCell) {
      state.commitEditing();
      return;
    }
    if (formulaDraft === null || !state.activeCell) return;
    const row = state.document.rows[state.activeCell.row];
    const col = state.document.columns[state.activeCell.col];
    if (row && col && !formulaBarReadOnly && formulaDraft !== activeRawValue) {
      state.commitCellInput(row.id, col.id, formulaDraft);
    }
    setFormulaDraft(null);
  };

  const handleCellClick = useCallback((rIdx: number, cIdx: number, e: React.MouseEvent) => {
    if (state.editingCell && (state.editingCell.row !== rIdx || state.editingCell.col !== cIdx)) {
      state.commitEditing();
    }
    state.selectCell(rIdx, cIdx, e.shiftKey);
  }, [state]);

  const handleCellDblClick = useCallback((rIdx: number, cIdx: number) => {
    if (readOnly) return;
    const col = state.document.columns[cIdx];
    if (col?.readOnly) return;
    state.startEditing(rIdx, cIdx);
  }, [readOnly, state]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (state.editingCell) {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Invalid input keeps the editor open behind the validation alert.
        if (state.commitEditing().status !== 'committed') return;
        state.moveCursor('down');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        state.cancelEditing();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (state.commitEditing().status !== 'committed') return;
        state.moveCursor(e.shiftKey ? 'left' : 'right');
      } else {
        return;
      }
      // The cell input unmounts; keep focus on the grid so typing continues.
      gridRef.current?.focus();
      return;
    }

    if (!state.activeCell) return;

    if (e.altKey && e.key === 'ArrowDown') {
      // Alt+Down opens the list of a list-validated cell.
      e.preventDefault();
      openListMenu(state.activeCell.row, state.activeCell.col);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.moveCursor('up', e.shiftKey);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.moveCursor('down', e.shiftKey);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      state.moveCursor('left', e.shiftKey);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      state.moveCursor('right', e.shiftKey);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      state.moveCursor(e.shiftKey ? 'left' : 'right');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const col = state.document.columns[state.activeCell.col];
      if (!readOnly && !col?.readOnly) {
        state.startEditing();
      }
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (readOnly) return;
      const row = state.document.rows[state.activeCell.row];
      const col = state.document.columns[state.activeCell.col];
      if (row && col && !col.readOnly) {
        e.preventDefault();
        state.setCellValue(row.id, col.id, '');
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      // With Shift held, e.key is 'Z'.
      e.preventDefault();
      if (e.shiftKey) {
        state.redo();
      } else {
        state.undo();
      }
    } else if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      state.redo();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      // Copy the selection, not the whole sheet. The browser's copy event
      // writes TSV, HTML and the internal format; the fallback writes TSV.
      copyShortcutFallback();
    } else if (!readOnly && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const col = state.document.columns[state.activeCell.col];
      if (!col?.readOnly) {
        // The key becomes the draft; without preventDefault the browser would
        // also type it into the newly focused cell input ("1" -> "11").
        e.preventDefault();
        state.startEditing(state.activeCell.row, state.activeCell.col, e.key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, state, copyShortcutFallback]);

  // --- Data validation: list dropdown, input message, alerts ---

  const activeListValues = useMemo(
    () => (state.activeCell && !readOnly ? state.controller.getValidationListValues(state.activeCell.row, state.activeCell.col) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.controller, state.activeCell, state.document, readOnly]
  );
  const activeRule = useMemo(
    () => (state.activeCell ? state.controller.getDataValidationAt(state.activeCell.row, state.activeCell.col) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.controller, state.activeCell, state.document]
  );
  const inputMessage =
    activeRule && activeRule.showInputMessage !== false && (activeRule.inputTitle || activeRule.inputMessage) ? activeRule : null;

  function openListMenu(row: number, col: number, anchor?: HTMLElement | null) {
    if (readOnly || state.document.columns[col]?.readOnly) return;
    const values = state.controller.getValidationListValues(row, col);
    if (!values) return;
    const td = anchor ?? gridRef.current?.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`);
    const rect = td?.getBoundingClientRect();
    setListMenu({ x: rect ? rect.left : 0, y: rect ? rect.bottom : 0, row, col, values });
  }

  // Close the list on a press outside it (or on its arrow, which toggles it).
  useEffect(() => {
    if (!listMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('[aria-label="Allowed values"], .spreadsheet-list-arrow')) setListMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [listMenu]);

  const chooseListValue = (value: string) => {
    if (!listMenu) return;
    const row = state.document.rows[listMenu.row];
    const col = state.document.columns[listMenu.col];
    setListMenu(null);
    if (row && col) state.commitCellInput(row.id, col.id, value);
    gridRef.current?.focus();
  };

  const resolveValidation = (action: 'accept' | 'retry' | 'cancel') => {
    state.resolveValidationPrompt(action);
    // Back to the cell editor when it is still open (retry), else the grid.
    requestAnimationFrame(() => {
      if (cellInputRef.current) cellInputRef.current.focus();
      else gridRef.current?.focus();
    });
  };
  // The resize effect reads these through refs: re-running it on every width
  // update would reset the in-progress drag (and skip onColumnResize).
  const stateRef = useRef(state);
  stateRef.current = state;
  const onColumnResizeRef = useRef(onColumnResize);
  onColumnResizeRef.current = onColumnResize;

  useEffect(() => {
    if (!resizingColId) return;

    if (typeof document !== 'undefined') {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    let rafId: number | null = null;
    let pendingWidth = resizeStartWidth;
    let hasDragged = false;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizeStartX;
      if (Math.abs(delta) > 2) {
        hasDragged = true;
      }
      pendingWidth = Math.max(30, resizeStartWidth + delta);

      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          stateRef.current.setColumnWidth(resizingColId, pendingWidth);
        });
      }
    };

    const handleMouseUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (hasDragged) {
        stateRef.current.setColumnWidth(resizingColId, pendingWidth);
        onColumnResizeRef.current?.(resizingColId, pendingWidth);
      }
      setResizingColId(null);
      if (typeof document !== 'undefined') {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (typeof document !== 'undefined') {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingColId, resizeStartX, resizeStartWidth]);

  const measureElementContentWidth = useCallback((el: HTMLElement, container: HTMLElement): number => {
    if (typeof document === 'undefined') return 0;

    let maxW = el.scrollWidth || 0;
    const firstChild = el.firstElementChild as HTMLElement | null;
    if (firstChild && firstChild.scrollWidth > maxW) {
      maxW = firstChild.scrollWidth;
    }

    const truncated = el.querySelectorAll<HTMLElement>('.truncate, [title], span, div');
    truncated.forEach((node) => {
      if (node.scrollWidth > maxW) {
        maxW = node.scrollWidth;
      }
    });

    try {
      const clone = (firstChild ? firstChild.cloneNode(true) : el.cloneNode(true)) as HTMLElement;
      clone.style.cssText = `
        position: absolute !important;
        visibility: hidden !important;
        width: max-content !important;
        min-width: max-content !important;
        max-width: none !important;
        overflow: visible !important;
        white-space: nowrap !important;
        pointer-events: none !important;
        top: -9999px !important;
        left: -9999px !important;
      `;

      const allNodes = clone.querySelectorAll<HTMLElement>('*');
      allNodes.forEach((node) => {
        node.style.maxWidth = 'none';
        node.style.overflow = 'visible';
        node.style.textOverflow = 'clip';
        node.style.whiteSpace = 'nowrap';
        if (
          node.classList.contains('truncate') ||
          node.classList.contains('min-w-0') ||
          node.classList.contains('w-full') ||
          node.classList.contains('max-w-0') ||
          node.classList.contains('flex-1')
        ) {
          node.style.width = 'max-content';
          node.style.minWidth = 'max-content';
        }
      });

      container.appendChild(clone);
      const rect = clone.getBoundingClientRect();
      container.removeChild(clone);

      if (rect.width > maxW) {
        maxW = rect.width;
      }
    } catch {
      // Ignore cloning/measuring errors
    }

    return maxW;
  }, []);

  const autoFitColumn = useCallback((colId: string, colIndex: number) => {
    const col = state.document.columns.find((c) => c.id === colId);
    if (!col) return;

    let calculatedWidth = 0;

    if (gridRef.current && typeof document !== 'undefined') {
      const table = gridRef.current.querySelector('table');
      if (table) {
        // Look cells up by column index: hidden columns and merges shift DOM positions.
        const th = table.querySelector(`thead th[data-col="${colIndex}"]`) as HTMLElement | null;
        if (th) {
          const headerInner = (th.firstElementChild as HTMLElement) || th;
          const headerW = measureElementContentWidth(headerInner, gridRef.current);
          calculatedWidth = Math.max(calculatedWidth, headerW + 28);
        }

        const rows = table.querySelectorAll('tbody tr');
        const sampleLimit = Math.min(rows.length, 150);
        for (let r = 0; r < sampleLimit; r++) {
          const tr = rows[r];
          const td = tr.querySelector(`td[data-col="${colIndex}"][colspan="1"]`) as HTMLElement | null;
          if (td) {
            const cellW = measureElementContentWidth(td, gridRef.current);
            calculatedWidth = Math.max(calculatedWidth, cellW + 20);
          }
        }
      }
    }

    if (calculatedWidth > 0) {
      const finalWidth = Math.min(600, Math.max(50, Math.ceil(calculatedWidth)));
      state.setColumnWidth(colId, finalWidth);
    } else {
      state.autoFitColumnWidth?.(colId);
    }

    const updatedCol = state.document.columns.find((c) => c.id === colId);
    if (updatedCol && onColumnResize) {
      onColumnResize(updatedCol.id, updatedCol.width || 130);
    }
  }, [state, measureElementContentWidth, onColumnResize]);

  const handleResizeDblClick = useCallback((colId: string, colIndex: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    autoFitColumn(colId, colIndex);
  }, [autoFitColumn]);

  const handleHeaderDblClick = useCallback((colId: string, colIndex: number, e: React.MouseEvent) => {
    const target = e.currentTarget as HTMLElement | null;
    if (target) {
      const rect = target.getBoundingClientRect();
      if (rect.right - e.clientX <= 12) {
        e.preventDefault();
        e.stopPropagation();
        autoFitColumn(colId, colIndex);
      }
    }
  }, [autoFitColumn]);

  const isCellSelected = (rIdx: number, cIdx: number) => {
    if (!state.selectedRange) return false;
    const minR = Math.min(state.selectedRange.startRow, state.selectedRange.endRow);
    const maxR = Math.max(state.selectedRange.startRow, state.selectedRange.endRow);
    const minC = Math.min(state.selectedRange.startCol, state.selectedRange.endCol);
    const maxC = Math.max(state.selectedRange.startCol, state.selectedRange.endCol);
    return rIdx >= minR && rIdx <= maxR && cIdx >= minC && cIdx <= maxC;
  };

  const isActiveCell = (rIdx: number, cIdx: number) => {
    return state.activeCell?.row === rIdx && state.activeCell?.col === cIdx;
  };

  const grid = (
    <div
      ref={gridRef}
      className="flex flex-col h-full w-full overflow-hidden border border-border bg-background select-none outline-none text-foreground font-sans text-xs"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="grid"
      aria-label="Spreadsheet"
    >
      {/* Formula Bar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-xs font-mono">
        <div className="flex h-6 min-w-[3rem] items-center justify-center rounded border border-border bg-background px-1.5 font-semibold text-foreground">
          {coordLabel}
        </div>
        <div className="flex items-center text-muted-foreground select-none">
          <span className="italic font-serif font-bold text-sm text-primary">fx</span>
        </div>
        <input
          ref={formulaBarRef}
          type="text"
          className="flex-1 bg-transparent px-2 py-0.5 outline-none font-sans text-xs text-foreground placeholder:text-muted-foreground/60 focus:bg-background focus:ring-1 focus:ring-primary rounded"
          placeholder="Enter a value or formula (e.g. =SUM(A1:A5))"
          aria-label="Formula bar"
          readOnly={formulaBarReadOnly}
          data-spill-formula={!state.editingCell && formulaDraft === null && spillFormula ? 'true' : undefined}
          style={!state.editingCell && formulaDraft === null && spillFormula ? { color: 'var(--muted-foreground, #94a3b8)' } : undefined}
          value={state.editingCell ? state.draftValue : formulaDraft ?? (activeRawValue || spillFormula)}
          onFocus={() => {
            if (!state.editingCell) setFormulaDraft(activeRawValue);
          }}
          onChange={(e) => {
            if (state.editingCell) {
              state.setDraftValue(e.target.value);
            } else if (state.activeCell) {
              setFormulaDraft(e.target.value);
            }
          }}
          onBlur={() => commitFormulaBar()}
          onKeyDown={(e) => {
            // Keys typed here must not reach the grid's navigation handler.
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitFormulaBar();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setFormulaDraft(null);
              if (state.editingCell) state.cancelEditing();
            }
          }}
        />
        {!formulaBarReadOnly && (
          <FormulaHints
            inputRef={formulaBarRef}
            value={state.editingCell ? state.draftValue : formulaDraft ?? activeRawValue}
            onAccept={(next) => (state.editingCell ? state.setDraftValue(next) : setFormulaDraft(next))}
            names={nameSuggestions}
          />
        )}
      </div>

      {inputMessage && (
        <div role="note" data-validation-input-message="" className="border-b border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
          {inputMessage.inputTitle && <span className="mr-1 font-semibold text-foreground">{inputMessage.inputTitle}</span>}
          {inputMessage.inputMessage}
        </div>
      )}

      {/* Main Grid */}
      <div ref={scrollRef} className="relative flex-1 overflow-auto" onScroll={handleGridScroll}>
        <table className="border-separate border-spacing-0 table-fixed w-max min-w-full [&>*>tr:not([data-spacer])>*]:border-b [&>*>tr>*]:border-border">
          <thead>
            <tr className="h-7 bg-muted sticky top-0 z-20 border-b border-border shadow-xs">
              <th className="w-12 min-w-[3rem] sticky left-0 z-30 bg-muted border-r border-border text-center text-[10px] text-muted-foreground font-medium">
                #
              </th>
              {columnSlots.map((slot) => slot.kind === 'space' ? (
                <th
                  key={slot.key}
                  aria-hidden="true"
                  data-spacer=""
                  className="p-0"
                  style={{ width: slot.width, minWidth: slot.width, maxWidth: slot.width, padding: 0 }}
                />
              ) : ((({ column: col, index: cIdx, frozen, stickyLeft }) => (
                <th
                  key={col.id}
                  data-col={cIdx}
                  className={`relative border-r border-border px-2 text-left font-medium text-muted-foreground hover:bg-muted/90 transition-colors group overflow-hidden max-w-0 ${
                    onColumnHeaderClick ? 'cursor-pointer' : 'cursor-default'
                  }`}
                  style={{
                    width: col.width || 130,
                    minWidth: col.width || 130,
                    maxWidth: col.width || 130,
                    overflow: 'hidden',
                    ...(frozen ? { position: 'sticky', left: ROW_HEADER_WIDTH + stickyLeft, zIndex: 25, background: 'var(--muted, #f4f4f5)' } : {})
                  }}
                  onClick={() => onColumnHeaderClick?.(col)}
                  onDoubleClick={(e) => handleHeaderDblClick(col.id, cIdx, e)}
                >
                  <div className="flex items-center justify-between gap-1 min-w-0 overflow-hidden truncate">
                    <span className="truncate font-semibold text-foreground text-xs min-w-0">{col.title}</span>
                    {filteredColIds.has(col.id) && (
                      <span className="text-[10px] text-primary shrink-0" title="Filtered" data-filtered="true">⏷</span>
                    )}
                    <span className="text-[10px] text-muted-foreground/70 font-mono font-normal shrink-0">({col.key})</span>
                  </div>
                  {/* Column Resize Handle */}
                  <div
                    className="col-resize-handle"
                    style={{ position: 'absolute', top: 0, bottom: 0, width: 12, right: -6, cursor: 'col-resize', zIndex: 20, display: 'flex', justifyContent: 'center', touchAction: 'none' }}
                    onMouseEnter={() => setHoveredColId(col.id)}
                    onMouseLeave={() => setHoveredColId((cur) => cur === col.id ? null : cur)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setResizingColId(col.id);
                      setResizeStartX(e.clientX);
                      setResizeStartWidth(col.width || 130);
                    }}
                    onDoubleClick={(e) => handleResizeDblClick(col.id, cIdx, e)}
                    role="separator"
                    aria-orientation="vertical"
                  >
                    <div
                      className="col-resize-handle-line"
                      style={{
                        width: 2,
                        height: '100%',
                        pointerEvents: 'none',
                        transition: 'background-color 150ms ease',
                        backgroundColor: resizingColId === col.id ? 'var(--primary, #6366f1)' : hoveredColId === col.id ? 'color-mix(in srgb, var(--primary, #6366f1) 75%, transparent)' : 'transparent'
                      }}
                    />
                  </div>
                </th>
              ))(slot.viewCol)))}
              {onAddColumnClick && (
                <th
                  className="w-10 min-w-[2.5rem] px-1 text-center bg-muted/40 hover:bg-muted cursor-pointer transition-colors"
                  onClick={onAddColumnClick}
                  title="Add Column"
                >
                  <span className="text-xs font-bold text-muted-foreground">+</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rowSlots.map((rowSlot) => {
              if (rowSlot.kind === 'space') {
                return (
                  <tr key={rowSlot.key} aria-hidden="true" data-spacer="" style={{ height: rowSlot.height }}>
                    <td colSpan={columnSlots.length + 2} style={{ padding: 0, border: 0 }} />
                  </tr>
                );
              }
              const viewRow = rowSlot.viewRow;
              if (viewRow.kind === 'group') {
                return (
                  <SpreadsheetGroupRow
                    key={`group:${viewRow.group.key}`}
                    group={viewRow.group}
                    columns={renderedColumns}
                    labelColumns={view.columns}
                    leadingColumns={viewWindow.virtual ? viewWindow.frozenColumns : undefined}
                    leftSpace={viewWindow.leftSpace}
                    rightSpace={viewWindow.rightSpace}
                    groupColId={state.document.table?.grouping?.colId ?? ''}
                    onToggle={state.toggleGroupCollapsed}
                    trailingCell={!!onAddColumnClick}
                  />
                );
              }
              const displayRowIndex = viewRow.index;
              const selection = state.selectedRange ? normalizeRange(state.selectedRange) : null;
              return (
              <tr
                key={viewRow.row.id}
                data-row={displayRowIndex}
                className={`border-b border-border hover:bg-muted/10 transition-colors ${viewRow.section !== 'body' ? 'bg-muted/30 font-semibold' : ''}`}
                style={{ height: viewRow.row.height || 32 }}
              >
                <td
                  className="w-12 min-w-[3rem] sticky left-0 z-10 bg-muted border-r border-border text-center text-[10px] text-muted-foreground font-mono select-none"
                  style={viewRow.frozen ? { top: COLUMN_HEADER_HEIGHT + viewRow.stickyTop, zIndex: 15 } : undefined}
                >
                  {displayRowIndex + 1}
                </td>
                {columnSlots.map((slot) => {
                  if (slot.kind === 'space') return <td key={slot.key} aria-hidden="true" data-spacer="" style={{ padding: 0 }} />;
                  const viewCol = slot.viewCol;
                  // A merged cell renders its top-left cell, spanning the merge.
                  const span = view.getCellSpan(displayRowIndex, viewCol.index);
                  if (!span) return null;
                  const rIdx = span.source.row;
                  const cIdx = span.source.col;
                  const row = state.document.rows[rIdx];
                  const col = state.document.columns[cIdx];
                  const cell = state.getCell(row.id, col.id);
                  const selected = isCellSelected(rIdx, cIdx);
                  const active = isActiveCell(rIdx, cIdx);
                  const isEditing = state.editingCell?.row === rIdx && state.editingCell?.col === cIdx;

                  const conditional = overlay.get(rIdx, cIdx);
                  const conditionalCss = getConditionalFormatCss(conditional);
                  const circled = state.controller.isInvalidDataCircled(rIdx, cIdx);
                  const showListArrow = active && !isEditing && !!activeListValues;
                  const inFillPreview = !!fillTarget && !selected && rangeContains(fillTarget, displayRowIndex, viewCol.index);
                  const showFillHandle =
                    !readOnly &&
                    !isEditing &&
                    !!selection &&
                    (span.merge
                      ? rangeContains(span.merge, selection.endRow, selection.endCol)
                      : selection.endRow === rIdx && selection.endCol === cIdx);

                  return (
                    <td
                      key={viewCol.column.id}
                      data-row={rIdx}
                      data-col={cIdx}
                      rowSpan={span.rowSpan}
                      colSpan={span.colSpan}
                      className={`relative border-r border-border px-2 py-1 truncate max-w-0 text-foreground transition-colors ${
                        selected ? 'bg-primary/10' : ''
                      } ${active ? 'ring-2 ring-primary ring-inset z-10' : ''} ${viewCol.header ? 'font-semibold' : ''}`}
                      style={{
                        maxWidth: 0,
                        overflow: 'hidden',
                        ...frozenCellStyle(viewRow, viewCol),
                        ...conditionalCss,
                        // Keep the selection tint visible over a conditional fill.
                        ...(conditionalCss.background && selected
                          ? { boxShadow: 'inset 0 0 0 9999px color-mix(in srgb, var(--primary, #6366f1) 12%, transparent)' }
                          : {}),
                        ...(inFillPreview ? { outline: '1px dashed var(--primary, #6366f1)', outlineOffset: -1 } : {})
                      }}
                      data-cf-fill={conditional?.fill}
                      onClick={(e) => handleCellClick(rIdx, cIdx, e)}
                      onDoubleClick={() => handleCellDblClick(rIdx, cIdx)}
                      onContextMenu={(e) => handleCellContextMenu(rIdx, cIdx, e)}
                      onMouseOver={() => extendFill(displayRowIndex, viewCol.index)}
                    >
                      {isEditing ? (
                        <>
                          <input
                            ref={cellInputRef}
                            type="text"
                            className="absolute inset-0 w-full h-full px-2 py-1 bg-background text-foreground outline-none font-sans text-xs border-2 border-primary z-20"
                            value={state.draftValue}
                            onChange={(e) => state.setDraftValue(e.target.value)}
                            onBlur={() => state.commitEditing()}
                            onFocus={(e) => {
                              // Caret after the draft (e.g. the key that started editing).
                              const end = e.currentTarget.value.length;
                              e.currentTarget.setSelectionRange(end, end);
                            }}
                            autoFocus
                          />
                          <FormulaHints inputRef={cellInputRef} value={state.draftValue} onAccept={state.setDraftValue} names={nameSuggestions} />
                        </>
                      ) : customCellRenderer ? (
                        customCellRenderer({ row, col, cell })
                      ) : (
                        <CellText cell={cell} conditional={conditional} />
                      )}
                      {circled && (
                        <span
                          className="spreadsheet-invalid-circle"
                          aria-label="Invalid value"
                          style={{ position: 'absolute', inset: '1px 2px', border: '2px solid #e11d48', borderRadius: '50%', pointerEvents: 'none', zIndex: 6 }}
                        />
                      )}
                      {showListArrow && (
                        <button
                          type="button"
                          className="spreadsheet-list-arrow"
                          aria-label="Show allowed values"
                          aria-haspopup="listbox"
                          tabIndex={-1}
                          style={{ position: 'absolute', right: 1, top: 1, bottom: 1, width: 16, zIndex: 24, fontSize: 10, lineHeight: 1, background: 'var(--muted, #f4f4f5)', border: '1px solid var(--border, #e4e4e7)', borderRadius: 2, cursor: 'pointer', padding: 0 }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (listMenu) setListMenu(null);
                            else openListMenu(rIdx, cIdx, e.currentTarget.parentElement);
                          }}
                        >
                          ▾
                        </button>
                      )}
                      {activeSpill && rangeContains(activeSpill.range, rIdx, cIdx) && (
                        <span aria-hidden="true" className="spreadsheet-spill-border" style={spillBorderStyle(activeSpill.range, rIdx, cIdx)} />
                      )}
                      {showFillHandle && (
                        <div
                          className="spreadsheet-fill-handle"
                          aria-label="Fill handle"
                          onMouseDown={startFill}
                          onClick={(e) => e.stopPropagation()}
                          style={{ position: 'absolute', right: 0, bottom: 0, width: 7, height: 7, background: 'var(--primary, #6366f1)', cursor: 'crosshair', zIndex: 25 }}
                        />
                      )}
                    </td>
                  );
                })}
                {onAddColumnClick && <td className="w-10 min-w-[2.5rem] bg-muted/10 border-r border-border" />}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {menu && (
        <SpreadsheetContextMenu
          items={menu.items}
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null);
            gridRef.current?.focus();
          }}
          onOpenPanel={setPanel}
        />
      )}
      {panel === 'conditionalFormatting' && <SpreadsheetConditionalFormatPanel state={state} onClose={() => setPanel(null)} />}
      {panel === 'dataValidation' && <SpreadsheetDataValidationPanel state={state} onClose={() => setPanel(null)} />}
      {listMenu && (
        <div
          role="listbox"
          aria-label="Allowed values"
          className="fixed z-50 max-h-60 min-w-[8rem] overflow-y-auto rounded-md border border-border bg-popover py-1 text-xs text-popover-foreground shadow-lg"
          style={{ left: listMenu.x, top: listMenu.y, background: 'var(--popover, var(--background, #fff))' }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              setListMenu(null);
              gridRef.current?.focus();
            }
          }}
        >
          {listMenu.values.length === 0 && <div className="px-3 py-1 text-muted-foreground">No values</div>}
          {listMenu.values.map((value, i) => (
            <button
              key={`${i}:${value}`}
              type="button"
              role="option"
              aria-selected={false}
              className="block w-full px-3 py-1 text-left hover:bg-muted"
              onClick={() => chooseListValue(value)}
            >
              {value}
            </button>
          ))}
        </div>
      )}
      {state.validationPrompt && <SpreadsheetValidationDialog prompt={state.validationPrompt} onResolve={resolveValidation} />}
      <style>{`
        .col-resize-handle:hover .col-resize-handle-line {
          background-color: var(--primary, #6366f1);
          opacity: 0.75;
        }
        .col-resize-handle.active .col-resize-handle-line {
          background-color: var(--primary, #6366f1);
          opacity: 1;
        }
        table.table-fixed th {
          overflow: hidden;
        }
        table.table-fixed td {
          max-width: 0;
          overflow: hidden;
        }
      `}</style>
    </div>
  );

  if (!showSheetTabs) return grid;
  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">{grid}</div>
      <SheetTabs state={state} readOnly={readOnly} />
    </div>
  );
};
