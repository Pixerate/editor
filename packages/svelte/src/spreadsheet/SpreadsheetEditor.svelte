<script lang="ts">
  import type { Snippet } from 'svelte';
  import { indexToColName, type SpreadsheetColumn, type SpreadsheetRow, type CellData } from '@pixerate/editor';
  import FormulaBar from './FormulaBar.svelte';
  import { createReactiveSpreadsheet } from './spreadsheet.svelte';

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
    onColumnResize
  }: Props = $props();

  let isReadOnly = $derived(readOnly || readonly);

  let gridContainer = $state<HTMLDivElement | null>(null);
  let resizingColId = $state<string | null>(null);
  let hoveredColId = $state<string | null>(null);
  let resizeStartX = $state(0);
  let resizeStartWidth = $state(0);



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
        sheetState.cancelEditing();
      } else if (e.key === 'Enter') {
        sheetState.commitEditing();
        sheetState.moveCursor('down');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        sheetState.commitEditing();
        sheetState.moveCursor(e.shiftKey ? 'left' : 'right');
      }
      return;
    }

    if (!sheetState.activeCell) return;

    if (e.key === 'ArrowUp') {
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
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        sheetState.redo();
      } else {
        sheetState.undo();
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      e.preventDefault();
      const tsv = sheetState.exportToTsv();
      navigator.clipboard?.writeText(tsv);
    } else if (!isReadOnly && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Direct typing into cell starts editing
      const col = sheetState.document.columns[sheetState.activeCell.col];
      if (!col?.readOnly) {
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

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!resizingColId) return;
      const delta = moveEvent.clientX - resizeStartX;
      pendingWidth = Math.max(60, resizeStartWidth + delta);

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
      if (resizingColId) {
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

  <!-- Main Scrollable Grid -->
  <div class="relative flex-1 overflow-auto">
    <table class="border-collapse table-fixed w-max min-w-full">
      <!-- Table Header Columns -->
      <thead>
        <tr class="h-7 bg-muted/60 sticky top-0 z-20 border-b border-border shadow-xs">
          <!-- Top Left Corner Cell -->
          <th class="w-12 min-w-[3rem] sticky left-0 z-30 bg-muted/90 border-r border-border text-center text-[10px] text-muted-foreground font-medium">
            #
          </th>
          {#each sheetState.document.columns as col, cIdx (col.id)}
            <th
              class="relative border-r border-border px-2 text-left font-medium text-muted-foreground hover:bg-muted/90 transition-colors group {onColumnHeaderClick ? 'cursor-pointer' : 'cursor-default'}"
              style="width: {col.width || 130}px; min-width: {col.width || 130}px; max-width: {col.width || 130}px;"
              onclick={() => onColumnHeaderClick?.(col)}
            >
              <div class="flex items-center justify-between gap-1 truncate">
                <span class="truncate font-semibold text-foreground text-xs">{col.title}</span>
                <span class="text-[10px] text-muted-foreground/70 font-mono font-normal">({col.key})</span>
              </div>
              <!-- Column Resize Handle -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div
                class="col-resize-handle"
                style="position: absolute; top: 0; bottom: 0; width: 12px; right: -6px; cursor: col-resize !important; z-index: 20; display: flex; justify-content: center; touch-action: none;"
                onmouseenter={() => hoveredColId = col.id}
                onmouseleave={() => { if (hoveredColId === col.id) hoveredColId = null; }}
                onmousedown={(e) => handleResizeStart(col.id, col.width || 130, e)}
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
        {#each sheetState.document.rows as row, rIdx (row.id)}
          <tr class="border-b border-border hover:bg-muted/10 transition-colors" style="height: {row.height || 32}px;">
            <!-- Row Header Index -->
            <td class="w-12 min-w-[3rem] sticky left-0 z-10 bg-muted/50 border-r border-border text-center text-[10px] text-muted-foreground font-mono select-none">
              {rIdx + 1}
            </td>

            <!-- Cells -->
            {#each sheetState.document.columns as col, cIdx (col.id)}
              {@const cell = sheetState.getCell(row.id, col.id)}
              {@const selected = isCellSelected(rIdx, cIdx)}
              {@const active = isActiveCell(rIdx, cIdx)}
              {@const isEditing = sheetState.editingCell?.row === rIdx && sheetState.editingCell?.col === cIdx}

              <td
                class="relative border-r border-border px-2 py-1 truncate text-foreground transition-colors {selected ? 'bg-primary/10' : ''} {active ? 'ring-2 ring-primary ring-inset z-10' : ''}"
                onclick={(e) => handleCellClick(rIdx, cIdx, e)}
                ondblclick={() => handleCellDblClick(rIdx, cIdx)}
              >
                {#if isEditing}
                  <input
                    type="text"
                    class="absolute inset-0 w-full h-full px-2 py-1 bg-background text-foreground outline-none font-sans text-xs border-2 border-primary z-20"
                    bind:value={sheetState.draftValue}
                    onblur={() => sheetState.commitEditing()}
                    
                  />
                {:else if customCellRenderer}
                  {@const cellArg = Object.assign({ row, col, cell }, cell)}
                  {@render (customCellRenderer as any)(cellArg, col, row)}
                {:else}
                  <span class="truncate block {cell.error ? 'text-destructive font-semibold' : ''}">
                    {cell.error || (cell.value ?? '')}
                  </span>
                {/if}
              </td>
            {/each}
            {#if onAddColumnClick}
              <td class="w-10 min-w-[2.5rem] bg-muted/10 border-r border-border"></td>
            {/if}
            <!-- Spacer cell to absorb remaining table width -->
            <td class="border-b border-border bg-transparent p-0"></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

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
</style>
