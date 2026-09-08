<script lang="ts">
  import { indexToColName } from '@pixerate/editor';
  import type { createReactiveSpreadsheet } from './spreadsheet.svelte';

  interface Props {
    sheetState?: ReturnType<typeof createReactiveSpreadsheet>;
    activeCoord?: { row: number; col: number } | null;
    value?: string;
    onChange?: (val: string) => void;
    onCommit?: (val: string) => void;
    onCancel?: () => void;
    class?: string;
  }

  let {
    sheetState,
    activeCoord = null,
    value = $bindable(''),
    onChange,
    onCommit,
    onCancel,
    class: className = ''
  }: Props = $props();

  let effectiveCoord = $derived.by(() => {
    if (sheetState) return sheetState.activeCell;
    return activeCoord;
  });

  let coordLabel = $derived.by(() => {
    if (!effectiveCoord) return '--';
    const colName = indexToColName(effectiveCoord.col);
    return `${colName}${effectiveCoord.row + 1}`;
  });

  let effectiveValue = $derived.by(() => {
    if (sheetState) {
      if (sheetState.editingCell) return sheetState.draftValue;
      if (!sheetState.activeCell) return '';
      const row = sheetState.document.rows[sheetState.activeCell.row];
      const col = sheetState.document.columns[sheetState.activeCell.col];
      if (!row || !col) return '';
      return sheetState.getCell(row.id, col.id).raw || '';
    }
    return value;
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (sheetState && sheetState.activeCell) {
        const row = sheetState.document.rows[sheetState.activeCell.row];
        const col = sheetState.document.columns[sheetState.activeCell.col];
        if (row && col) {
          sheetState.setCellValue(row.id, col.id, effectiveValue);
        }
        sheetState.commitEditing();
      }
      onCommit?.(effectiveValue);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (sheetState) {
        sheetState.cancelEditing();
      }
      onCancel?.();
    }
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    if (sheetState) {
      sheetState.draftValue = target.value;
      if (sheetState.activeCell && !sheetState.editingCell) {
        sheetState.startEditing(sheetState.activeCell.row, sheetState.activeCell.col, target.value);
      }
    } else {
      value = target.value;
    }
    onChange?.(target.value);
  }
</script>

<div class="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-xs font-mono {className}">
  <div class="flex h-6 min-w-[3rem] items-center justify-center rounded border border-border bg-background px-1.5 font-semibold text-foreground">
    {coordLabel}
  </div>
  <div class="flex items-center text-muted-foreground select-none">
    <span class="italic font-serif font-bold text-sm text-primary">fx</span>
  </div>
  <input
    type="text"
    class="flex-1 bg-transparent px-2 py-0.5 outline-none font-sans text-xs text-foreground placeholder:text-muted-foreground/60 focus:bg-background focus:ring-1 focus:ring-primary rounded"
    placeholder="Enter a value or formula (e.g. =SUM(A1:A5))"
    value={effectiveValue}
    oninput={handleInput}
    onkeydown={handleKeyDown}
  />
</div>
