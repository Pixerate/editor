<script lang="ts">
  import { indexToColName } from '@pixerate/editor/spreadsheet';
  import type { createReactiveSpreadsheet } from './spreadsheet.svelte.js';
  import FormulaHints from './FormulaHints.svelte';

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

  // Defined names for formula autocomplete.
  let nameSuggestions = $derived.by(() => {
    if (!sheetState) return [];
    void sheetState.document;
    return sheetState.controller.getNameSuggestions();
  });

  // A spilled cell shows its anchor's formula greyed out (it has no formula of its own).
  let spillFormula = $derived.by(() => {
    if (!sheetState || sheetState.editingCell || !sheetState.activeCell || effectiveValue) return '';
    void sheetState.document;
    const { row, col } = sheetState.activeCell;
    const spill = sheetState.controller.getSpillAt(row, col);
    return spill && (spill.anchor.row !== row || spill.anchor.col !== col) ? spill.formula : '';
  });

  function handleKeyDown(e: KeyboardEvent) {
    // Keys typed here must not reach the grid's navigation handler.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (sheetState && sheetState.activeCell) {
        const row = sheetState.document.rows[sheetState.activeCell.row];
        const col = sheetState.document.columns[sheetState.activeCell.col];
        // Committed with data validation: invalid input waits for the alert.
        if (sheetState.editingCell) {
          sheetState.commitEditing(effectiveValue);
        } else if (row && col) {
          sheetState.commitCellInput(row.id, col.id, effectiveValue);
        }
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
    setValue((e.target as HTMLInputElement).value);
  }

  function setValue(next: string) {
    if (sheetState) {
      sheetState.draftValue = next;
      if (sheetState.activeCell && !sheetState.editingCell) {
        sheetState.startEditing(sheetState.activeCell.row, sheetState.activeCell.col, next);
      }
    } else {
      value = next;
    }
    onChange?.(next);
  }

  let inputEl = $state<HTMLInputElement | null>(null);
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
    aria-label="Formula bar"
    bind:this={inputEl}
    data-spill-formula={spillFormula ? 'true' : undefined}
    style={spillFormula ? 'color: var(--muted-foreground, #94a3b8);' : undefined}
    value={effectiveValue || spillFormula}
    oninput={handleInput}
    onkeydown={handleKeyDown}
  />
  <FormulaHints input={inputEl} value={effectiveValue} onAccept={setValue} names={nameSuggestions} />
</div>
