<script lang="ts">
  import { getNameManagerRows, parseFormula, type SpreadsheetNameRow } from '@pixerate/editor/spreadsheet';
  import type { createReactiveSpreadsheet } from './spreadsheet.svelte.js';

  interface Props {
    sheetState: ReturnType<typeof createReactiveSpreadsheet>;
    readOnly?: boolean;
    onClose?: () => void;
    class?: string;
  }

  let { sheetState, readOnly = false, onClose, class: className = '' }: Props = $props();

  interface Draft {
    /** The name being edited (null for a new one). */
    original: { name: string; sheetId?: string } | null;
    name: string;
    refersTo: string;
    /** Sheet id, or '' for workbook scope. */
    scope: string;
    comment: string;
  }

  const EMPTY_DRAFT: Draft = { original: null, name: '', refersTo: '=', scope: '', comment: '' };

  let draft = $state<Draft>({ ...EMPTY_DRAFT });
  let error = $state<string | null>(null);

  const rows = $derived.by(() => {
    void sheetState.document;
    void sheetState.names;
    return getNameManagerRows(sheetState.controller);
  });

  function edit(row: SpreadsheetNameRow) {
    error = null;
    draft = {
      original: { name: row.name, sheetId: row.sheetId },
      name: row.name,
      refersTo: row.refersTo,
      scope: row.sheetId ?? '',
      comment: row.comment ?? ''
    };
  }

  function save(e: SubmitEvent) {
    e.preventDefault();
    const scope = draft.scope ? { sheet: draft.scope } : {};
    try {
      // Check before changing anything, so a failed edit keeps the old name.
      const invalid = sheetState.controller.validateDefinedName(draft.name.trim());
      if (invalid) throw new Error(invalid);
      const formula = draft.refersTo.trim().startsWith('=') ? draft.refersTo.trim() : `=${draft.refersTo.trim()}`;
      try {
        parseFormula(formula);
      } catch (err: any) {
        throw new Error(`There's a problem with this formula: ${err?.message ?? formula}`);
      }
      const original = draft.original;
      if (original) {
        const originalScope = original.sheetId ? { sheet: original.sheetId } : {};
        if ((original.sheetId ?? '') !== draft.scope) {
          sheetState.deleteName(original.name, originalScope);
        } else if (original.name !== draft.name.trim()) {
          sheetState.renameName(original.name, draft.name.trim(), originalScope);
        }
      }
      sheetState.defineName(draft.name.trim(), draft.refersTo, { ...scope, comment: draft.comment || undefined });
      draft = { ...EMPTY_DRAFT };
      error = null;
    } catch (err: any) {
      error = err?.message ?? String(err);
    }
  }

  function remove(row: SpreadsheetNameRow) {
    sheetState.deleteName(row.name, row.sheetId ? { sheet: row.sheetId } : {});
    if (draft.original?.name === row.name && (draft.original.sheetId ?? '') === (row.sheetId ?? '')) draft = { ...EMPTY_DRAFT };
  }
</script>

<!--
  A simple Name Manager: lists defined names (name, current value, formula,
  scope) and adds, edits, renames and deletes them. Renaming a name rewrites
  the formulas that use it; deleting one leaves them showing #NAME?.
-->
<section aria-label="Name Manager" class="flex flex-col gap-2 text-xs {className}" data-name-manager="">
  <div class="flex items-center justify-between">
    <h3 class="m-0 text-sm font-semibold">Name Manager</h3>
    {#if onClose}
      <button type="button" aria-label="Close Name Manager" class="rounded px-2 hover:bg-muted" onclick={onClose}>×</button>
    {/if}
  </div>
  <table class="w-full border-collapse">
    <thead>
      <tr class="text-left text-muted-foreground">
        <th class="px-1 font-medium">Name</th>
        <th class="px-1 font-medium">Value</th>
        <th class="px-1 font-medium">Refers to</th>
        <th class="px-1 font-medium">Scope</th>
        {#if !readOnly}<th class="px-1"></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#if rows.length === 0}
        <tr><td colspan="5" class="px-1 py-2 text-muted-foreground">No names yet.</td></tr>
      {/if}
      {#each rows as row (`${row.sheetId ?? ''}!${row.name}`)}
        <tr data-name={row.name} class="border-t border-border" title={row.comment}>
          <td class="px-1 py-0.5 font-mono font-semibold">{row.name}</td>
          <td class="px-1 py-0.5">{row.value}</td>
          <td class="px-1 py-0.5 font-mono">{row.refersTo}</td>
          <td class="px-1 py-0.5">{row.scopeLabel}</td>
          {#if !readOnly}
            <td class="whitespace-nowrap px-1 py-0.5 text-right">
              <button type="button" aria-label="Edit {row.name}" class="rounded px-1 hover:bg-muted" onclick={() => edit(row)}>Edit</button>
              <button type="button" aria-label="Delete {row.name}" class="rounded px-1 text-destructive hover:bg-muted" onclick={() => remove(row)}>
                Delete
              </button>
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
  {#if !readOnly}
    <form
      class="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1"
      onsubmit={save}
      aria-label={draft.original ? `Edit name ${draft.original.name}` : 'New name'}
    >
      <label for="pixerate-name-manager-name">Name</label>
      <input id="pixerate-name-manager-name" class="rounded border border-border bg-background px-1 py-0.5" bind:value={draft.name} />
      <label for="pixerate-name-manager-refers">Refers to</label>
      <input id="pixerate-name-manager-refers" class="rounded border border-border bg-background px-1 py-0.5 font-mono" bind:value={draft.refersTo} />
      <label for="pixerate-name-manager-scope">Scope</label>
      <select id="pixerate-name-manager-scope" class="rounded border border-border bg-background px-1 py-0.5" bind:value={draft.scope}>
        <option value="">Workbook</option>
        {#each sheetState.sheets as sheet (sheet.id)}
          <option value={sheet.id}>{sheet.name}</option>
        {/each}
      </select>
      <label for="pixerate-name-manager-comment">Comment</label>
      <input id="pixerate-name-manager-comment" class="rounded border border-border bg-background px-1 py-0.5" bind:value={draft.comment} />
      <div class="col-span-2 flex gap-2">
        <button type="submit" class="rounded bg-primary px-2 py-0.5 text-primary-foreground">{draft.original ? 'Save' : 'Add name'}</button>
        {#if draft.original}
          <button
            type="button"
            class="rounded px-2 py-0.5 hover:bg-muted"
            onclick={() => {
              draft = { ...EMPTY_DRAFT };
              error = null;
            }}
          >
            Cancel
          </button>
        {/if}
      </div>
    </form>
  {/if}
  {#if error}
    <div role="alert" class="text-destructive">{error}</div>
  {/if}
</section>
