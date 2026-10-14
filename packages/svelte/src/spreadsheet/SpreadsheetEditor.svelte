<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    indexToColName,
    computeFillTarget,
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
    conditionalFormatStyleString,
    type SpreadsheetPanelId,
    type SpreadsheetValidationAction
  } from '@pixerate/editor/spreadsheet';
  import FormulaBar from './FormulaBar.svelte';
  import SpreadsheetValidationDialog from './SpreadsheetValidationDialog.svelte';
  import SpreadsheetConditionalFormatPanel from './SpreadsheetConditionalFormatPanel.svelte';
  import SpreadsheetDataValidationPanel from './SpreadsheetDataValidationPanel.svelte';
  import SpreadsheetContextMenu from './SpreadsheetContextMenu.svelte';
  import SpreadsheetGroupRow from './SpreadsheetGroupRow.svelte';
  import FormulaHints from './FormulaHints.svelte';
  import SheetTabs from './SheetTabs.svelte';
  import { createReactiveSpreadsheet } from './spreadsheet.svelte.js';
  import { attachSpreadsheetClipboard } from './tableInteractions.js';
  import { createSpreadsheetViewport } from './viewport.svelte.js';

  interface Props {
    sheetState?: ReturnType<typeof createReactiveSpreadsheet>;
    readOnly?: boolean;
    readonly?: boolean;
    showFormulaBar?: boolean;
    class?: string;
    customCellRenderer?:
      | Snippet<[CellData, SpreadsheetColumn, SpreadsheetRow]>
      | Snippet<[{ row: SpreadsheetRow; col: SpreadsheetColumn; cell: CellData }]>;
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

  let {
    sheetState = createReactiveSpreadsheet(),
    readOnly = false,
    readonly = false,
    showFormulaBar = true,
    class: className = '',
    customCellRenderer,
    onAddColumnClick,
    onColumnHeaderClick,
    onColumnResize,
    showSheetTabs = false,
    virtualize = 'auto'
  }: Props = $props();

  // Virtualised rendering: frozen rows/columns, a spacer, the rows and
  // columns in view, another spacer (everything for small sheets).
  type ColumnSlot = { kind: 'col'; key: string; viewCol: SpreadsheetViewColumn } | { kind: 'space'; key: string; width: number };
  type RowSlot = { kind: 'row'; key: string; viewRow: SpreadsheetViewRow } | { kind: 'space'; key: string; height: number };
  let scrollContainer = $state<HTMLDivElement | null>(null);
  const viewportState = createSpreadsheetViewport({
    view: () => sheetState.viewModel,
    virtualize: () => virtualize,
    merges: () => sheetState.document.table?.merges,
    activeCell: () => sheetState.activeCell
  });
  $effect(() => viewportState.attach(scrollContainer));
  let viewWindow = $derived(viewportState.window);
  let columnSlots = $derived.by<ColumnSlot[]>(() => {
    const view = sheetState.viewModel;
    const win = viewWindow;
    const col = (viewCol: SpreadsheetViewColumn): ColumnSlot => ({ kind: 'col', key: viewCol.column.id, viewCol });
    if (!win.virtual) return view.columns.map(col);
    const slots = view.columns.slice(0, win.frozenColumns).map(col);
    if (win.leftSpace > 0) slots.push({ kind: 'space', key: 'space:left', width: win.leftSpace });
    for (let i = win.colStart; i < win.colEnd; i++) slots.push(col(view.columns[i]));
    if (win.rightSpace > 0) slots.push({ kind: 'space', key: 'space:right', width: win.rightSpace });
    return slots;
  });
  let renderedColumns = $derived(columnSlots.flatMap((slot) => (slot.kind === 'col' ? [slot.viewCol] : [])));
  let rowSlots = $derived.by<RowSlot[]>(() => {
    const view = sheetState.viewModel;
    const win = viewWindow;
    const row = (viewRow: SpreadsheetViewRow): RowSlot => ({
      kind: 'row',
      key: viewRow.kind === 'group' ? `group:${viewRow.group.key}` : viewRow.row.id,
      viewRow
    });
    if (!win.virtual) return view.rows.map(row);
    const slots = view.rows.slice(0, win.frozenRows).map(row);
    if (win.topSpace > 0) slots.push({ kind: 'space', key: 'space:top', height: win.topSpace });
    for (let i = win.rowStart; i < win.rowEnd; i++) slots.push(row(view.rows[i]));
    if (win.bottomSpace > 0) slots.push({ kind: 'space', key: 'space:bottom', height: win.bottomSpace });
    return slots;
  });

  // Defined names for formula autocomplete in the cell editor.
  let nameSuggestions = $derived.by(() => {
    void sheetState.document;
    return sheetState.controller.getNameSuggestions();
  });

  let isReadOnly = $derived(readOnly || readonly);

  let gridContainer = $state<HTMLDivElement | null>(null);
  let cellInput = $state<HTMLInputElement | null>(null);

  // Focus the cell editor when it opens, with the caret after the draft
  // (e.g. the key that started editing), so typing goes into the cell.
  $effect(() => {
    if (!cellInput) return;
    // Editing started from the formula bar keeps focus there.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active instanceof HTMLInputElement && active !== cellInput) return;
    cellInput.focus();
    const end = cellInput.value.length;
    cellInput.setSelectionRange(end, end);
  });
  let resizingColId = $state<string | null>(null);
  let hoveredColId = $state<string | null>(null);
  let resizeStartX = $state(0);
  let resizeStartWidth = $state(0);

  // --- Table operations: clipboard, fill handle, context menu, frozen panes ---

  // Sizes of the sticky header row and row-number column, for frozen-pane offsets.
  const COLUMN_HEADER_HEIGHT = 28;
  const ROW_HEADER_WIDTH = 48;

  let copyShortcutFallback: () => void = () => {};
  $effect(() => {
    const clipboard = attachSpreadsheetClipboard(() => gridContainer, sheetState, () => isReadOnly);
    copyShortcutFallback = clipboard.copyShortcutFallback;
    return () => clipboard.destroy();
  });

  let fillDrag = $state.raw<{ source: CellRange; target: CellRange | null } | null>(null);
  let menu = $state.raw<{ x: number; y: number; items: SpreadsheetMenuItem[] } | null>(null);
  // Conditional formatting / data validation manager, opened from the context menu.
  let panel = $state<SpreadsheetPanelId | null>(null);
  // List dropdown of a list-validated cell.
  let listMenu = $state.raw<{ x: number; y: number; row: number; col: number; values: string[] } | null>(null);

  // --- Data validation: list dropdown, input message, alerts ---
  let activeListValues = $derived.by(() => {
    void sheetState.document;
    const cell = sheetState.activeCell;
    return cell && !isReadOnly ? sheetState.controller.getValidationListValues(cell.row, cell.col) : null;
  });
  let inputMessage = $derived.by(() => {
    void sheetState.document;
    const cell = sheetState.activeCell;
    const rule = cell ? sheetState.controller.getDataValidationAt(cell.row, cell.col) : undefined;
    return rule && rule.showInputMessage !== false && (rule.inputTitle || rule.inputMessage) ? rule : null;
  });

  // "Circle invalid data": recomputed when the document (or the toggle) changes.
  let invalidCircles = $derived.by(() => {
    void sheetState.document;
    if (!sheetState.controller.getInvalidDataCircles()) return null;
    return new Set(sheetState.controller.findInvalidCells().map((c) => `${c.row}:${c.col}`));
  });

  function openListMenu(row: number, col: number, anchor?: HTMLElement | null) {
    if (isReadOnly || sheetState.document.columns[col]?.readOnly) return;
    const values = sheetState.controller.getValidationListValues(row, col);
    if (!values) return;
    const td = anchor ?? gridContainer?.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`);
    const rect = td?.getBoundingClientRect();
    listMenu = { x: rect ? rect.left : 0, y: rect ? rect.bottom : 0, row, col, values };
  }

  // Close the list on a press outside it (or on its arrow, which toggles it).
  $effect(() => {
    if (!listMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('[aria-label="Allowed values"], .spreadsheet-list-arrow')) listMenu = null;
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  });

  function chooseListValue(value: string) {
    if (!listMenu) return;
    const row = sheetState.document.rows[listMenu.row];
    const col = sheetState.document.columns[listMenu.col];
    listMenu = null;
    if (row && col) sheetState.commitCellInput(row.id, col.id, value);
    gridContainer?.focus();
  }

  function resolveValidation(action: SpreadsheetValidationAction) {
    sheetState.resolveValidationPrompt(action);
    // Back to the cell editor when it is still open (retry), else the grid.
    requestAnimationFrame(() => {
      if (cellInput) cellInput.focus();
      else gridContainer?.focus();
    });
  }

  /** Inline style of a cell's conditional look (fill, font), keeping the selection tint visible. */
  function conditionalStyle(fill: string | undefined, css: string, selected: boolean): string {
    if (!css) return '';
    return ` ${css}${fill && selected ? ' box-shadow: inset 0 0 0 9999px color-mix(in srgb, var(--primary, #6366f1) 12%, transparent);' : ''}`;
  }
  let filteredColIds = $derived.by(() => {
    const filter = sheetState.document.table?.filter;
    return new Set(filter?.enabled ? filter.rules.map((r) => r.colId) : []);
  });
  let selection = $derived(sheetState.selectedRange ? normalizeRange(sheetState.selectedRange) : null);
  // The dynamic array under the active cell (anchor or spilled cell) gets a border.
  let activeSpill = $derived.by(() => {
    void sheetState.document;
    const cell = sheetState.activeCell;
    return cell ? sheetState.controller.getSpillAt(cell.row, cell.col) : null;
  });

  /** Thin border drawn on the outer edges of a dynamic array's spill range. */
  function spillBorderStyle(range: CellRange, row: number, col: number): string {
    const line = '1px solid color-mix(in srgb, var(--primary, #6366f1) 60%, transparent)';
    return (
      'position: absolute; inset: 0; pointer-events: none; z-index: 5;' +
      (row === range.startRow ? ` border-top: ${line};` : '') +
      (row === range.endRow ? ` border-bottom: ${line};` : '') +
      (col === range.startCol ? ` border-left: ${line};` : '') +
      (col === range.endCol ? ` border-right: ${line};` : '')
    );
  }

  /** Fill handle: press, move over cells, release to autofill (one undo step). */
  function startFill(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const range = sheetState.selectedRange;
    if (!range) return;
    fillDrag = { source: normalizeRange(range), target: null };
    const finish = () => {
      const current = fillDrag;
      fillDrag = null;
      if (current?.target) sheetState.autofill(current.source, current.target);
    };
    window.addEventListener('mouseup', finish, { once: true });
  }

  function extendFill(row: number, col: number) {
    if (!fillDrag) return;
    fillDrag = { source: fillDrag.source, target: computeFillTarget(fillDrag.source, { row, col }) };
  }

  function handleCellContextMenu(rIdx: number, cIdx: number, e: MouseEvent) {
    if (isReadOnly) return;
    e.preventDefault();
    if (sheetState.editingCell) sheetState.commitEditing();
    if (!sheetState.selectedRange || !rangeContains(sheetState.selectedRange, rIdx, cIdx)) {
      sheetState.selectCell(rIdx, cIdx);
    }
    menu = { x: e.clientX, y: e.clientY, items: getSpreadsheetMenuItems(sheetState.controller, { row: rIdx, col: cIdx }) };
  }

  /** Sticky positioning for cells in frozen rows and/or columns. */
  function frozenCellStyle(viewRow: Extract<SpreadsheetViewRow, { kind: 'row' }>, viewCol: SpreadsheetViewColumn): string {
    if (!viewRow.frozen && !viewCol.frozen) return '';
    const zIndex = viewRow.frozen && viewCol.frozen ? 14 : viewRow.frozen ? 12 : 11;
    return (
      'position: sticky;' +
      (viewRow.frozen ? ` top: ${COLUMN_HEADER_HEIGHT + viewRow.stickyTop}px;` : '') +
      (viewCol.frozen ? ` left: ${ROW_HEADER_WIDTH + viewCol.stickyLeft}px;` : '') +
      ` z-index: ${zIndex}; background: var(--background, #fff);`
    );
  }



  function handleCellClick(rIdx: number, cIdx: number, e: MouseEvent) {
    if (sheetState.editingCell && (sheetState.editingCell.row !== rIdx || sheetState.editingCell.col !== cIdx)) {
      sheetState.commitEditing();
    }
    sheetState.selectCell(rIdx, cIdx, e.shiftKey);
  }

  function handleCellDblClick(rIdx: number, cIdx: number) {
    if (isReadOnly) return;
    const col = sheetState.document.columns[cIdx];
    if (col?.readOnly) return;
    sheetState.startEditing(rIdx, cIdx);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (sheetState.editingCell) {
      if (e.key === 'Escape') {
        e.preventDefault();
        sheetState.cancelEditing();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // Invalid input keeps the editor open behind the validation alert.
        if (sheetState.commitEditing().status !== 'committed') return;
        sheetState.moveCursor('down');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (sheetState.commitEditing().status !== 'committed') return;
        sheetState.moveCursor(e.shiftKey ? 'left' : 'right');
      } else {
        return;
      }
      // The cell input unmounts; keep focus on the grid so typing continues.
      gridContainer?.focus();
      return;
    }

    if (!sheetState.activeCell) return;

    if (e.altKey && e.key === 'ArrowDown') {
      // Alt+Down opens the list of a list-validated cell.
      e.preventDefault();
      openListMenu(sheetState.activeCell.row, sheetState.activeCell.col);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      sheetState.moveCursor('up', e.shiftKey);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      sheetState.moveCursor('down', e.shiftKey);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      sheetState.moveCursor('left', e.shiftKey);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      sheetState.moveCursor('right', e.shiftKey);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      sheetState.moveCursor(e.shiftKey ? 'left' : 'right');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const col = sheetState.document.columns[sheetState.activeCell.col];
      if (!isReadOnly && !col?.readOnly) {
        sheetState.startEditing();
      }
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (isReadOnly) return;
      const row = sheetState.document.rows[sheetState.activeCell.row];
      const col = sheetState.document.columns[sheetState.activeCell.col];
      if (row && col && !col.readOnly) {
        e.preventDefault();
        sheetState.setCellValue(row.id, col.id, '');
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      // With Shift held, e.key is 'Z'.
      e.preventDefault();
      if (e.shiftKey) {
        sheetState.redo();
      } else {
        sheetState.undo();
      }
    } else if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      sheetState.redo();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      // Copy the selection, not the whole sheet. The browser's copy event
      // writes TSV, HTML and the internal format; the fallback writes TSV.
      copyShortcutFallback();
    } else if (!isReadOnly && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Direct typing into cell starts editing
      const col = sheetState.document.columns[sheetState.activeCell.col];
      if (!col?.readOnly) {
        // The key becomes the draft; without preventDefault the browser would
        // also type it into the newly focused cell input ("1" -> "11").
        e.preventDefault();
        sheetState.startEditing(sheetState.activeCell.row, sheetState.activeCell.col, e.key);
      }
    }
  }

  function handleResizeStart(colId: string, width: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizingColId = colId;
    resizeStartX = e.clientX;
    resizeStartWidth = width;

    if (typeof document !== 'undefined') {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    let rafId: number | null = null;
    let pendingWidth = width;
    let hasDragged = false;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!resizingColId) return;
      const delta = moveEvent.clientX - resizeStartX;
      if (Math.abs(delta) > 2) {
        hasDragged = true;
      }
      pendingWidth = Math.max(30, resizeStartWidth + delta);

      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (resizingColId) {
            sheetState.setColumnWidth(resizingColId, pendingWidth);
          }
        });
      }
    };

    const handleMouseUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (resizingColId && hasDragged) {
        sheetState.setColumnWidth(resizingColId, pendingWidth);
        const col = sheetState.document.columns.find((c) => c.id === resizingColId);
        if (col && onColumnResize) {
          onColumnResize(col.id, col.width || pendingWidth);
        }
      }
      resizingColId = null;
      if (typeof document !== 'undefined') {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }

  function measureElementContentWidth(el: HTMLElement, container: HTMLElement): number {
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
  }

  function autoFitColumn(colId: string, colIndex: number) {
    const col = sheetState.document.columns.find((c) => c.id === colId);
    if (!col) return;

    let calculatedWidth = 0;

    if (gridContainer && typeof document !== 'undefined') {
      const table = gridContainer.querySelector('table');
      if (table) {
        // Look cells up by column index: hidden columns and merges shift DOM positions.
        const th = table.querySelector(`thead th[data-col="${colIndex}"]`) as HTMLElement | null;
        if (th) {
          const headerInner = (th.firstElementChild as HTMLElement) || th;
          const headerW = measureElementContentWidth(headerInner, gridContainer);
          calculatedWidth = Math.max(calculatedWidth, headerW + 28);
        }

        const rows = table.querySelectorAll('tbody tr');
        const sampleLimit = Math.min(rows.length, 150);
        for (let r = 0; r < sampleLimit; r++) {
          const tr = rows[r];
          const td = tr.querySelector(`td[data-col="${colIndex}"][colspan="1"]`) as HTMLElement | null;
          if (td) {
            const cellW = measureElementContentWidth(td, gridContainer);
            calculatedWidth = Math.max(calculatedWidth, cellW + 20);
          }
        }
      }
    }

    if (calculatedWidth > 0) {
      const finalWidth = Math.min(600, Math.max(50, Math.ceil(calculatedWidth)));
      sheetState.setColumnWidth(colId, finalWidth);
    } else {
      sheetState.autoFitColumnWidth(colId);
    }

    const updatedCol = sheetState.document.columns.find((c) => c.id === colId);
    if (updatedCol && onColumnResize) {
      onColumnResize(updatedCol.id, updatedCol.width || 130);
    }
  }

  function handleResizeDblClick(colId: string, colIndex: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    autoFitColumn(colId, colIndex);
  }

  function handleHeaderDblClick(colId: string, colIndex: number, e: MouseEvent) {
    const target = e.currentTarget as HTMLElement | null;
    if (target) {
      const rect = target.getBoundingClientRect();
      if (rect.right - e.clientX <= 12) {
        e.preventDefault();
        e.stopPropagation();
        autoFitColumn(colId, colIndex);
      }
    }
  }

  function isCellSelected(rIdx: number, cIdx: number): boolean {
    if (!sheetState.selectedRange) return false;
    const minR = Math.min(sheetState.selectedRange.startRow, sheetState.selectedRange.endRow);
    const maxR = Math.max(sheetState.selectedRange.startRow, sheetState.selectedRange.endRow);
    const minC = Math.min(sheetState.selectedRange.startCol, sheetState.selectedRange.endCol);
    const maxC = Math.max(sheetState.selectedRange.startCol, sheetState.selectedRange.endCol);
    return rIdx >= minR && rIdx <= maxR && cIdx >= minC && cIdx <= maxC;
  }

  function isActiveCell(rIdx: number, cIdx: number): boolean {
    return sheetState.activeCell?.row === rIdx && sheetState.activeCell?.col === cIdx;
  }
</script>

{#snippet grid()}
<div
  bind:this={gridContainer}
  class="flex flex-col h-full w-full overflow-hidden border border-border bg-background select-none outline-none text-foreground font-sans text-xs {className}"
  tabindex="0"
  onkeydown={handleKeyDown}
  role="grid"
  aria-label="Spreadsheet"
>
  <!-- Formula Bar -->
  {#if showFormulaBar}
    <FormulaBar {sheetState} />
  {/if}
  {#if inputMessage}
    <div role="note" data-validation-input-message="" class="border-b border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
      {#if inputMessage.inputTitle}<span class="mr-1 font-semibold text-foreground">{inputMessage.inputTitle}</span>{/if}{inputMessage.inputMessage ?? ''}
    </div>
  {/if}

  <!-- Main Scrollable Grid -->
  <div bind:this={scrollContainer} class="relative flex-1 overflow-auto" onscroll={viewportState.onScroll}>
    <table class="border-separate border-spacing-0 table-fixed w-max min-w-full [&>*>tr:not([data-spacer])>*]:border-b [&>*>tr>*]:border-border">
      <!-- Table Header Columns -->
      <thead>
        <tr class="h-7 bg-muted sticky top-0 z-20 border-b border-border shadow-xs">
          <!-- Top Left Corner Cell -->
          <th class="w-12 min-w-[3rem] sticky left-0 z-30 bg-muted border-r border-border text-center text-[10px] text-muted-foreground font-medium">
            #
          </th>
          {#each columnSlots as slot (slot.key)}
            {#if slot.kind === 'space'}
              <th aria-hidden="true" data-spacer="" class="p-0" style="width: {slot.width}px; min-width: {slot.width}px; max-width: {slot.width}px; padding: 0;"></th>
            {:else}
            {@const viewCol = slot.viewCol}
            {@const col = viewCol.column}
            {@const cIdx = viewCol.index}
            <th
              data-col={cIdx}
              class="relative border-r border-border px-2 text-left font-medium text-muted-foreground hover:bg-muted/90 transition-colors group overflow-hidden max-w-0 {onColumnHeaderClick ? 'cursor-pointer' : 'cursor-default'}"
              style="width: {col.width || 130}px; min-width: {col.width || 130}px; max-width: {col.width || 130}px; overflow: hidden;{viewCol.frozen ? ` position: sticky; left: ${ROW_HEADER_WIDTH + viewCol.stickyLeft}px; z-index: 25; background: var(--muted, #f4f4f5);` : ''}"
              onclick={() => onColumnHeaderClick?.(col)}
              ondblclick={(e) => handleHeaderDblClick(col.id, cIdx, e)}
            >
              <div class="flex items-center justify-between gap-1 min-w-0 overflow-hidden truncate">
                <span class="truncate font-semibold text-foreground text-xs min-w-0">{col.title}</span>
                {#if filteredColIds.has(col.id)}
                  <span class="text-[10px] text-primary shrink-0" title="Filtered" data-filtered="true">⏷</span>
                {/if}
                <span class="text-[10px] text-muted-foreground/70 font-mono font-normal shrink-0">({col.key})</span>
              </div>
              <!-- Column Resize Handle -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div
                class="col-resize-handle"
                style="position: absolute; top: 0; bottom: 0; width: 12px; right: -6px; cursor: col-resize !important; z-index: 20; display: flex; justify-content: center; touch-action: none;"
                onmouseenter={() => hoveredColId = col.id}
                onmouseleave={() => { if (hoveredColId === col.id) hoveredColId = null; }}
                onmousedown={(e) => handleResizeStart(col.id, col.width || 130, e)}
                ondblclick={(e) => handleResizeDblClick(col.id, cIdx, e)}
                role="separator"
                aria-orientation="vertical"
                tabindex="-1"
              >
                <div
                  class="col-resize-handle-line"
                  style="width: 2px; height: 100%; pointer-events: none; transition: background-color 150ms ease; background-color: {resizingColId === col.id ? 'var(--primary, #6366f1)' : hoveredColId === col.id ? 'color-mix(in srgb, var(--primary, #6366f1) 75%, transparent)' : 'transparent'};"
                ></div>
              </div>
            </th>
            {/if}
          {/each}
          {#if onAddColumnClick}
            <th class="w-10 min-w-[2.5rem] px-1 text-center bg-muted/40 hover:bg-muted cursor-pointer transition-colors" onclick={onAddColumnClick} title="Add Column">
              <span class="text-xs font-bold text-muted-foreground">+</span>
            </th>
          {/if}
          <!-- Spacer column to absorb remaining table width without stretching explicitly sized columns -->
          <th class="border-b border-border bg-transparent p-0 font-normal"></th>
        </tr>
      </thead>

      <!-- Table Body Rows -->
      <tbody>
        {#each rowSlots as rowSlot (rowSlot.key)}
          {#if rowSlot.kind === 'space'}
            <tr aria-hidden="true" data-spacer="" style="height: {rowSlot.height}px;">
              <td colspan={columnSlots.length + 3} style="padding: 0; border: 0;"></td>
            </tr>
          {:else}
          {@const viewRow = rowSlot.viewRow}
          {#if viewRow.kind === 'group'}
            <SpreadsheetGroupRow
              group={viewRow.group}
              columns={renderedColumns}
              labelColumns={sheetState.viewModel.columns}
              leadingColumns={viewWindow.virtual ? viewWindow.frozenColumns : undefined}
              leftSpace={viewWindow.leftSpace}
              rightSpace={viewWindow.rightSpace}
              groupColId={sheetState.document.table?.grouping?.colId ?? ''}
              onToggle={sheetState.toggleGroupCollapsed}
              trailingCell={!!onAddColumnClick}
            />
          {:else}
          {@const displayRowIndex = viewRow.index}
          <tr
            data-row={displayRowIndex}
            class="border-b border-border hover:bg-muted/10 transition-colors {viewRow.section !== 'body' ? 'bg-muted/30 font-semibold' : ''}"
            style="height: {viewRow.row.height || 32}px;"
          >
            <!-- Row Header Index -->
            <td
              class="w-12 min-w-[3rem] sticky left-0 z-10 bg-muted border-r border-border text-center text-[10px] text-muted-foreground font-mono select-none"
              style={viewRow.frozen ? `top: ${COLUMN_HEADER_HEIGHT + viewRow.stickyTop}px; z-index: 15;` : undefined}
            >
              {displayRowIndex + 1}
            </td>

            <!-- Cells (a merged cell renders its top-left cell, spanning the merge) -->
            {#each columnSlots as slot (slot.key)}
              {#if slot.kind === 'space'}
                <td aria-hidden="true" data-spacer="" style="padding: 0;"></td>
              {:else}
              {@const viewCol = slot.viewCol}
              {@const span = sheetState.viewModel.getCellSpan(displayRowIndex, viewCol.index)}
              {#if span}
              {@const rIdx = span.source.row}
              {@const cIdx = span.source.col}
              {@const row = sheetState.document.rows[rIdx]}
              {@const col = sheetState.document.columns[cIdx]}
              {@const cell = sheetState.getCell(row.id, col.id)}
              {@const selected = isCellSelected(rIdx, cIdx)}
              {@const active = isActiveCell(rIdx, cIdx)}
              {@const isEditing = sheetState.editingCell?.row === rIdx && sheetState.editingCell?.col === cIdx}

              {@const conditional = sheetState.conditionalFormatOverlay.get(rIdx, cIdx)}
              {@const conditionalCss = conditionalFormatStyleString(getConditionalFormatCss(conditional))}
              {@const circled = !!invalidCircles?.has(`${rIdx}:${cIdx}`)}
              {@const showListArrow = active && !isEditing && !!activeListValues}
              {@const inFillPreview = !!fillDrag?.target && !selected && rangeContains(fillDrag.target, displayRowIndex, viewCol.index)}
              {@const showFillHandle =
                !isReadOnly &&
                !isEditing &&
                !!selection &&
                (span.merge
                  ? rangeContains(span.merge, selection.endRow, selection.endCol)
                  : selection.endRow === rIdx && selection.endCol === cIdx)}

              <!-- svelte-ignore a11y_mouse_events_have_key_events -->
              <td
                data-row={rIdx}
                data-col={cIdx}
                rowspan={span.rowSpan}
                colspan={span.colSpan}
                class="relative border-r border-border px-2 py-1 truncate max-w-0 text-foreground transition-colors {selected ? 'bg-primary/10' : ''} {active ? 'ring-2 ring-primary ring-inset z-10' : ''} {viewCol.header ? 'font-semibold' : ''}"
                style="max-width: 0; overflow: hidden; {frozenCellStyle(viewRow, viewCol)}{conditionalStyle(conditional?.fill, conditionalCss, selected)}{inFillPreview ? ' outline: 1px dashed var(--primary, #6366f1); outline-offset: -1px;' : ''}"
                data-cf-fill={conditional?.fill}
                onclick={(e) => handleCellClick(rIdx, cIdx, e)}
                ondblclick={() => handleCellDblClick(rIdx, cIdx)}
                oncontextmenu={(e) => handleCellContextMenu(rIdx, cIdx, e)}
                onmouseover={() => extendFill(displayRowIndex, viewCol.index)}
              >
                {#if isEditing}
                  <input
                    type="text"
                    class="absolute inset-0 w-full h-full px-2 py-1 bg-background text-foreground outline-none font-sans text-xs border-2 border-primary z-20"
                    bind:this={cellInput}
                    bind:value={sheetState.draftValue}
                    onblur={() => sheetState.commitEditing()}
                  />
                  <FormulaHints input={cellInput} value={sheetState.draftValue} onAccept={(next) => (sheetState.draftValue = next)} names={nameSuggestions} />
                {:else if customCellRenderer}
                  {@const cellArg = Object.assign({ row, col, cell }, cell)}
                  {@render (customCellRenderer as any)(cellArg, col, row)}
                {:else}
                  {@const shown = formatCellForDisplay(cell)}
                  {@const textColor = conditional?.color ?? (shown.color ? numberFormatColorToCss(shown.color) : undefined)}
                  {@const icon = conditional?.icon ? getConditionalFormatIcon(conditional.icon.set, conditional.icon.index) : null}
                  {#if conditional?.dataBar}
                    <span aria-hidden="true" class="spreadsheet-data-bar" style={conditionalFormatStyleString(getDataBarCss(conditional.dataBar))}></span>
                  {/if}
                  {#snippet cellText()}
                    <span
                      class="truncate block max-w-full {cell.error ? 'text-destructive font-semibold' : ''}"
                      title={cell.error ? (cell.errorMessage ?? cell.error) : undefined}
                      data-numeric={shown.numeric ? '' : undefined}
                      style="{conditional?.dataBar || icon ? 'position: relative;' : ''}{icon ? ' flex: 1; min-width: 0;' : ''}{shown.numeric ? ' text-align: right;' : ''}{textColor ? ` color: ${textColor};` : ''}"
                    >
                      {conditional?.hideValue ? '' : shown.text}
                    </span>
                  {/snippet}
                  {#if icon && conditional?.icon}
                    <span class="flex items-center gap-1 min-w-0" style="position: relative;">
                      <span class="spreadsheet-cf-icon shrink-0" role="img" aria-label={icon.label} data-icon={conditional.icon.id} style="color: {icon.color};">{icon.glyph}</span>
                      {@render cellText()}
                    </span>
                  {:else}
                    {@render cellText()}
                  {/if}
                {/if}
                {#if circled}
                  <span
                    class="spreadsheet-invalid-circle"
                    aria-label="Invalid value"
                    style="position: absolute; inset: 1px 2px; border: 2px solid #e11d48; border-radius: 50%; pointer-events: none; z-index: 6;"
                  ></span>
                {/if}
                {#if showListArrow}
                  <button
                    type="button"
                    class="spreadsheet-list-arrow"
                    aria-label="Show allowed values"
                    aria-haspopup="listbox"
                    tabindex="-1"
                    style="position: absolute; right: 1px; top: 1px; bottom: 1px; width: 16px; z-index: 24; font-size: 10px; line-height: 1; background: var(--muted, #f4f4f5); border: 1px solid var(--border, #e4e4e7); border-radius: 2px; cursor: pointer; padding: 0;"
                    onmousedown={(e) => e.stopPropagation()}
                    onclick={(e) => {
                      e.stopPropagation();
                      if (listMenu) listMenu = null;
                      else openListMenu(rIdx, cIdx, (e.currentTarget as HTMLElement).parentElement);
                    }}>▾</button
                  >
                {/if}
                {#if activeSpill && rangeContains(activeSpill.range, rIdx, cIdx)}
                  <span aria-hidden="true" class="spreadsheet-spill-border" style={spillBorderStyle(activeSpill.range, rIdx, cIdx)}></span>
                {/if}
                {#if showFillHandle}
                  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                  <div
                    class="spreadsheet-fill-handle"
                    aria-label="Fill handle"
                    onmousedown={startFill}
                    onclick={(e) => e.stopPropagation()}
                    style="position: absolute; right: 0; bottom: 0; width: 7px; height: 7px; background: var(--primary, #6366f1); cursor: crosshair; z-index: 25;"
                  ></div>
                {/if}
              </td>
              {/if}
              {/if}
            {/each}
            {#if onAddColumnClick}
              <td class="w-10 min-w-[2.5rem] bg-muted/10 border-r border-border"></td>
            {/if}
            <!-- Spacer cell to absorb remaining table width -->
            <td class="border-b border-border bg-transparent p-0"></td>
          </tr>
          {/if}
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
  {#if menu}
    <SpreadsheetContextMenu
      items={menu.items}
      x={menu.x}
      y={menu.y}
      onClose={() => {
        menu = null;
        gridContainer?.focus();
      }}
      onOpenPanel={(next) => (panel = next)}
    />
  {/if}
  {#if panel === 'conditionalFormatting'}
    <SpreadsheetConditionalFormatPanel {sheetState} onClose={() => (panel = null)} />
  {:else if panel === 'dataValidation'}
    <SpreadsheetDataValidationPanel {sheetState} onClose={() => (panel = null)} />
  {/if}
  {#if listMenu}
    <div
      role="listbox"
      aria-label="Allowed values"
      tabindex="-1"
      class="fixed z-50 max-h-60 min-w-[8rem] overflow-y-auto rounded-md border border-border bg-popover py-1 text-xs text-popover-foreground shadow-lg"
      style="left: {listMenu.x}px; top: {listMenu.y}px; background: var(--popover, var(--background, #fff));"
      onkeydown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          listMenu = null;
          gridContainer?.focus();
        }
      }}
    >
      {#if listMenu.values.length === 0}
        <div class="px-3 py-1 text-muted-foreground">No values</div>
      {/if}
      {#each listMenu.values as value, i (`${i}:${value}`)}
        <button type="button" role="option" aria-selected="false" class="block w-full px-3 py-1 text-left hover:bg-muted" onclick={() => chooseListValue(value)}
          >{value}</button
        >
      {/each}
    </div>
  {/if}
  {#if sheetState.validationPrompt}
    <SpreadsheetValidationDialog prompt={sheetState.validationPrompt} onResolve={resolveValidation} />
  {/if}
</div>
{/snippet}

{#if showSheetTabs}
  <div class="flex h-full w-full flex-col">
    <div class="min-h-0 flex-1">{@render grid()}</div>
    <SheetTabs {sheetState} readOnly={isReadOnly} />
  </div>
{:else}
  {@render grid()}
{/if}

<style>
  .col-resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 12px;
    right: -6px;
    cursor: col-resize !important;
    z-index: 20;
    display: flex;
    justify-content: center;
    touch-action: none;
  }
  .col-resize-handle-line {
    width: 2px;
    height: 100%;
    transition: background-color 150ms ease;
    background-color: transparent;
    pointer-events: none;
  }
  .col-resize-handle:hover .col-resize-handle-line {
    background-color: var(--primary, #6366f1);
    opacity: 0.75;
  }
  .col-resize-handle-line.active,
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
</style>
