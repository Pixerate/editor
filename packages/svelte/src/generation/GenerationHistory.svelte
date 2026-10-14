<script lang="ts" module>
  let nextId = 0;
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    DRIFT_TYPE_LABELS,
    recreateRequest,
    referenceRoleLabel,
    variationRequest,
    type AssetLookup,
    type GenerationRecord,
    type ModelCapabilities,
    type RecreateMode,
    type RecreateOptions,
    type RecreateResult
  } from '@pixerate/editor/generation';
  // Not `@pixerate/editor/grammar`: svelte-package keeps type imports in
  // `.svelte` output, which would pull another core entry into this one.
  type Template = NonNullable<RecreateOptions['templates']>[number];

  interface Props {
    records: readonly GenerationRecord[];
    /** Current templates (drift detection, and resolution in `latest` mode). */
    templates?: readonly Template[];
    /** Current models (capability drift and re-planning). */
    capabilities?: ModelCapabilities | readonly ModelCapabilities[];
    /** Current assets (missing / changed asset drift). */
    assets?: AssetLookup;
    /** Recreate mode (bindable); starts at `exact`. */
    mode?: RecreateMode;
    onmodechange?: (mode: RecreateMode) => void;
    /** "Recreate": receives the rebuilt request and drift report. */
    onrecreate?: (result: RecreateResult, record: GenerationRecord) => void;
    /** "Variation": same request with a new seed. */
    onvariation?: (result: RecreateResult, record: GenerationRecord) => void;
    onremove?: (record: GenerationRecord) => void;
    /** Extra content per record (e.g. output thumbnails). */
    preview?: Snippet<[GenerationRecord]>;
    emptyText?: string;
    class?: string;
  }

  let {
    records,
    templates,
    capabilities,
    assets,
    mode = $bindable('exact'),
    onmodechange,
    onrecreate,
    onvariation,
    onremove,
    preview,
    emptyText = 'No generations yet.',
    class: className = ''
  }: Props = $props();

  const groupName = `generation-history-mode-${++nextId}`;
  const options = $derived({ templates, capabilities, assets, mode });
  const results = $derived(records.map((record) => recreateRequest(record, options)));
  const models = $derived(
    capabilities ? (Array.isArray(capabilities) ? capabilities : [capabilities as ModelCapabilities]) : []
  );
  const severityClass = {
    info: 'text-sky-600 dark:text-sky-300',
    warning: 'text-amber-600 dark:text-amber-300',
    error: 'text-red-600 dark:text-red-400'
  } as const;

  const setMode = (next: RecreateMode) => {
    mode = next;
    onmodechange?.(next);
  };
</script>

<!-- Generation history with drift reports and Recreate / Variation actions. -->
<div class="flex flex-col gap-2 text-sm {className}" data-generation-history="">
  <div class="flex items-center gap-2 text-xs" role="radiogroup" aria-label="Recreate mode">
    {#each ['exact', 'latest'] as const as value (value)}
      <label class="inline-flex items-center gap-1">
        <input
          type="radio"
          name={groupName}
          {value}
          checked={mode === value}
          onchange={() => setMode(value)}
          data-mode={value}
        />
        {value === 'exact' ? 'Exact (recorded versions)' : 'Latest templates & settings'}
      </label>
    {/each}
  </div>
  {#if records.length === 0}<p class="text-xs text-muted-foreground">{emptyText}</p>{/if}
  <ul class="flex flex-col gap-2">
    {#each records as record, i (record.id)}
      {@const result = results[i]}
      {@const model = models.find((m) => m.id === record.provenance.modelId)}
      <li class="rounded-md border border-border p-2" data-record={record.id} data-drift={result.drift.length}>
        <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span class="font-medium">{model?.name ?? record.provenance.modelId}</span>
          <span class="text-muted-foreground">
            {#if record.kind !== 'generate'}<span data-kind="">{record.kind} · </span>{/if}<time datetime={record.createdAt}
              >{record.createdAt.replace('T', ' ').slice(0, 16)}</time
            >{#if record.seed !== undefined}&nbsp;· seed {record.seed}{/if}
          </span>
        </div>
        <p class="mt-1 line-clamp-3 break-words text-xs" data-record-prompt="">{record.provenance.resolvedPrompt}</p>
        {#if record.assets.length > 0}
          <div class="mt-1 flex flex-wrap gap-1">
            {#each record.assets as item (`${item.role}:${item.id}`)}
              <span class="rounded-full bg-muted px-2 py-0.5 text-[10px]" data-asset-role={item.role}
                >{item.id} · {referenceRoleLabel(item.role, model)}</span
              >
            {/each}
          </div>
        {/if}
        {#if preview}{@render preview(record)}{/if}
        {#if result.drift.length > 0}
          <ul class="mt-1 flex flex-col gap-0.5 text-[11px]" data-drift-report="">
            {#each result.drift as item, j (j)}
              <li class={severityClass[item.severity]} data-drift-type={item.type}>
                <strong>{DRIFT_TYPE_LABELS[item.type]}:</strong>
                {item.message}
              </li>
            {/each}
          </ul>
        {/if}
        <div class="mt-2 flex gap-2">
          {#if onrecreate}
            <button
              type="button"
              disabled={!result.ok}
              title={!result.ok ? 'This generation cannot be recreated as recorded.' : undefined}
              onclick={() => onrecreate(result, record)}
              class="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
              data-action="recreate">Recreate</button
            >
          {/if}
          {#if onvariation}
            <button
              type="button"
              onclick={() => onvariation(variationRequest(record, {}, options), record)}
              class="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted"
              data-action="variation">Variation</button
            >
          {/if}
          {#if onremove}
            <button
              type="button"
              onclick={() => onremove(record)}
              class="ml-auto rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
              data-action="remove">Remove</button
            >
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</div>
