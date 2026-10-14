<script lang="ts">
  import { getSheetTabMenuItems, sheetDropIndex, type SpreadsheetMenuItem } from '@pixerate/editor/spreadsheet';
  import type { createReactiveSpreadsheet } from './spreadsheet.svelte.js';
  import SpreadsheetContextMenu from './SpreadsheetContextMenu.svelte';

  interface Props {
    sheetState: ReturnType<typeof createReactiveSpreadsheet>;
    readOnly?: boolean;
    class?: string;
  }

  let { sheetState, readOnly = false, class: className = '' }: Props = $props();

  let renaming = $state<{ id: string; draft: string } | null>(null);
  let error = $state<string | null>(null);
  let menu = $state<{ x: number; y: number; items: SpreadsheetMenuItem[] } | null>(null);
  let dragFrom: number | null = null;
  let dropTarget = $state<{ index: number; after: boolean } | null>(null);
  let renameInput = $state<HTMLInputElement | null>(null);

  // Focus and select the name when the rename field opens.
  $effect(() => {
    if (!renameInput) return;
    renameInput.focus();
    renameInput.select();
  });

  function commitRename(cancelOnError: boolean) {
    if (!renaming) return;
    const current = renaming;
    const sheet = sheetState.sheets.find((s) => s.id === current.id);
    const name = current.draft.trim();
    if (!sheet || !name || name === sheet.name) {
      renaming = null;
      error = null;
      return;
    }
    try {
      sheetState.renameSheet(current.id, name);
      renaming = null;
      error = null;
    } catch (err: any) {
      error = err?.message ?? String(err);
      if (cancelOnError) renaming = null;
    }
  }

  function dropAfter(e: DragEvent): boolean {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX > rect.left + rect.width / 2;
  }
</script>

<!--
  The workbook's sheet tabs: click to switch, double-click to rename, drag to
  reorder, right-click for insert / rename / duplicate / move / delete
  (delete asks to confirm), and a `+` button to add a sheet.
-->
<div class="flex flex-col {className}" data-sheet-tabs="">
  <div role="tablist" aria-label="Sheets" class="flex items-center gap-0.5 overflow-x-auto border-t border-border bg-muted px-1 py-1 text-xs">
    {#each sheetState.sheets as sheet, index (sheet.id)}
      {#if renaming?.id === sheet.id}
        <input
          bind:this={renameInput}
          aria-label="Sheet name"
          class="w-32 rounded border border-primary bg-background px-2 py-0.5 text-xs outline-none"
          value={renaming.draft}
          oninput={(e) => {
            if (renaming) renaming = { id: renaming.id, draft: e.currentTarget.value };
          }}
          onkeydown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitRename(false);
            else if (e.key === 'Escape') {
              renaming = null;
              error = null;
            }
          }}
          onblur={() => commitRename(true)}
        />
      {:else}
        <button
          type="button"
          role="tab"
          aria-selected={sheet.active}
          data-sheet-id={sheet.id}
          draggable={!readOnly}
          title={readOnly ? sheet.name : `${sheet.name} — double-click to rename, drag to move`}
          class="whitespace-nowrap rounded px-3 py-0.5 {sheet.active
            ? 'bg-background font-semibold text-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-background/60'} {dropTarget?.index === index
            ? dropTarget.after
              ? 'border-r-2 border-primary'
              : 'border-l-2 border-primary'
            : ''}"
          onclick={() => sheetState.setActiveSheet(sheet.id)}
          ondblclick={() => {
            if (readOnly) return;
            error = null;
            renaming = { id: sheet.id, draft: sheet.name };
          }}
          oncontextmenu={(e) => {
            if (readOnly) return;
            e.preventDefault();
            menu = {
              x: e.clientX,
              y: e.clientY,
              items: getSheetTabMenuItems(sheetState.controller, sheet.id, { onError: (message) => (error = message) })
            };
          }}
          ondragstart={(e) => {
            dragFrom = index;
            e.dataTransfer?.setData('text/plain', sheet.id);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          }}
          ondragover={(e) => {
            if (dragFrom === null) return;
            e.preventDefault();
            const after = dropAfter(e);
            if (dropTarget?.index !== index || dropTarget.after !== after) dropTarget = { index, after };
          }}
          ondragleave={() => (dropTarget = null)}
          ondrop={(e) => {
            e.preventDefault();
            const from = dragFrom;
            dragFrom = null;
            dropTarget = null;
            if (from === null) return;
            sheetState.moveSheet(sheetState.sheets[from].id, sheetDropIndex(from, index, dropAfter(e)));
          }}
          ondragend={() => {
            dragFrom = null;
            dropTarget = null;
          }}
        >
          {sheet.name}
        </button>
      {/if}
    {/each}
    {#if !readOnly}
      <button
        type="button"
        aria-label="Add sheet"
        title="Add sheet"
        class="rounded px-2 py-0.5 text-muted-foreground hover:bg-background/60"
        onclick={() => {
          error = null;
          sheetState.addSheet();
        }}
      >
        +
      </button>
    {/if}
  </div>
  {#if error}
    <div role="alert" class="px-2 py-1 text-xs text-destructive">{error}</div>
  {/if}
  {#if menu}
    <SpreadsheetContextMenu items={menu.items} x={menu.x} y={menu.y} ariaLabel="Sheet actions" onClose={() => (menu = null)} />
  {/if}
</div>
