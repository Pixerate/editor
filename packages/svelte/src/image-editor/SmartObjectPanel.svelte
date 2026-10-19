<script lang="ts">
  import type { EffectControl, ImageEditorController } from '@pixerate/editor/image-editor';
  import {
    SMART_CONTENTS_ACCEPT,
    SMART_FILTER_MENU,
    downloadSmartObjectContents,
    replaceSmartObjectContentsFromFile,
    smartFilterControls,
    smartObjectPanel,
  } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  interface Props {
    controller: ImageEditorController;
    /** The smart object to show (default: the active layer). */
    layerId?: string | null;
    class?: string;
  }

  let { controller, layerId = null, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    // `subscribe` calls the listener at once: untracked, or the effect would depend on `tick`.
    return untrack(() => c.subscribe(() => tick++));
  });

  const view = $derived.by(() => {
    void tick;
    const s = controller.getState();
    return { model: smartObjectPanel(controller, layerId), activeLayerId: s.activeLayerId, activeTarget: s.activeTarget, hasSelection: controller.hasSelection };
  });

  let open = $state<string | null>(null);
  let error = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  /** Whether the next slider change records an undo step (the first of a drag does, the rest replace it). */
  let commitNext = true;
  const button = 'px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 hover:text-white disabled:opacity-40';

  function attempt(fn: () => unknown) {
    try {
      error = null;
      const r = fn();
      if (r instanceof Promise) r.catch((err) => (error = err instanceof Error ? err.message : String(err)));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function change(id: string, filterId: string, c: EffectControl, value: unknown, drag = false) {
    attempt(() => {
      controller.updateSmartFilter(id, filterId, { [c.key]: value }, drag ? commitNext : true);
      if (drag) commitNext = false;
    });
  }

  function onFile(e: Event, id: string) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) attempt(() => replaceSmartObjectContentsFromFile(controller, id, file));
  }
</script>

{#if !view.model.available || !view.model.layerId || !view.model.contents}
  <div class="text-xs text-slate-500 {className}" data-testid="smart-object">{view.model.reason}</div>
{:else}
  {@const model = view.model}
  {@const id = model.layerId!}
  {@const c = model.contents!}
  {@const readOnly = !model.editable}
  <div class="flex flex-col gap-1.5 text-xs text-slate-200 {className}" data-testid="smart-object" aria-label="Smart object" role="group">
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="font-semibold text-slate-300">Smart Object</span>
      <span class="text-slate-400" data-testid="smart-contents"
        >{c.name} · {c.width} × {c.height} {c.kind === 'document' ? 'layers' : 'px'}{c.instances > 1 ? ` · ${c.instances} linked` : ''}{c.linkedPath ? ` · linked file ${c.linkedPath}` : ''}{c.decoded ? '' : ' · not decoded here'}</span
      >
    </div>
    <div class="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Smart object actions">
      <button type="button" class={button} disabled={!c.decoded} onclick={() => attempt(() => controller.editSmartObjectContents(id))}>Edit Contents</button>
      <button type="button" class={button} disabled={readOnly} onclick={() => fileInput?.click()}>Replace Contents…</button>
      <button type="button" class={button} onclick={() => attempt(() => downloadSmartObjectContents(controller, id))}>Export Contents</button>
      <button type="button" class={button} disabled={readOnly} onclick={() => attempt(() => controller.copySmartObject(id, false))}>New via Copy</button>
      <button type="button" class={button} disabled={readOnly} onclick={() => attempt(() => controller.rasterizeSmartObject(id))}>Rasterize</button>
      <input
        bind:this={fileInput}
        type="file"
        accept={SMART_CONTENTS_ACCEPT}
        class="hidden"
        data-testid="smart-contents-input"
        aria-label="Replace contents with a file"
        onchange={(e) => onFile(e, id)} />
    </div>

    <div class="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-1.5">
      <span class="font-semibold text-slate-300">Smart Filters</span>
      <label class="flex items-center gap-1 text-slate-300">
        <input
          type="checkbox"
          aria-label="Smart filters on"
          checked={model.filtersEnabled}
          disabled={readOnly || !model.filters.length}
          onchange={(e) => attempt(() => controller.setSmartFiltersEnabled(id, (e.target as HTMLInputElement).checked))}
          class="accent-indigo-500" />
        On
      </label>
      <select
        aria-label="Add smart filter"
        value=""
        disabled={readOnly}
        onchange={(e) => {
          const kind = (e.target as HTMLSelectElement).value;
          (e.target as HTMLSelectElement).value = '';
          if (kind) attempt(() => (open = controller.addSmartFilter(id, { kind }).id));
        }}
        class="bg-slate-800 border border-slate-700 rounded px-1.5 py-1">
        <option value="">Add smart filter…</option>
        {#each SMART_FILTER_MENU as m (m.kind)}
          <option value={m.kind}>{m.label}</option>
        {/each}
      </select>
    </div>

    <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter mask" data-testid="smart-filter-mask">
      <span class="text-slate-400">Filter mask</span>
      {#if model.mask}
        <button
          type="button"
          class={button}
          aria-pressed={view.activeLayerId === id && view.activeTarget === 'filter-mask'}
          onclick={() => attempt(() => controller.setActiveLayer(id, 'filter-mask'))}>Paint</button>
        <label class="flex items-center gap-1 text-slate-300">
          <input type="checkbox" aria-label="Filter mask on" checked={model.mask.enabled} disabled={readOnly} onchange={(e) => attempt(() => controller.setSmartFilterMask(id, 'keep', { enabled: (e.target as HTMLInputElement).checked }))} class="accent-indigo-500" />
          On
        </label>
        <label class="flex items-center gap-1 text-slate-300">
          <input type="checkbox" aria-label="Filter mask linked" checked={model.mask.linked} disabled={readOnly} onchange={(e) => attempt(() => controller.setSmartFilterMask(id, 'keep', { linked: (e.target as HTMLInputElement).checked }))} class="accent-indigo-500" />
          Linked
        </label>
        <button type="button" class={button} disabled={readOnly || !view.hasSelection} onclick={() => attempt(() => controller.setSmartFilterMask(id, 'selection'))}>From Selection</button>
        <button type="button" class={button} aria-label="Remove filter mask" disabled={readOnly} onclick={() => attempt(() => controller.setSmartFilterMask(id, 'none'))}>✕</button>
      {:else}
        <button type="button" class={button} disabled={readOnly} onclick={() => attempt(() => controller.setSmartFilterMask(id, 'reveal-all'))}>Add</button>
        <button type="button" class={button} disabled={readOnly || !view.hasSelection} onclick={() => attempt(() => controller.setSmartFilterMask(id, 'selection'))}>From Selection</button>
      {/if}
    </div>

    <ul class="flex flex-col gap-1" aria-label="Smart filters">
      {#each model.filters as row, i (row.filter.id)}
        {@const expanded = open === row.filter.id}
        <li data-filter-id={row.filter.id} class="rounded bg-slate-900/60 ring-1 ring-slate-800">
          <div class="flex items-center gap-1.5 px-1.5 py-1">
            <input
              type="checkbox"
              aria-label={`${row.label} on`}
              checked={row.filter.enabled}
              disabled={readOnly}
              onchange={(e) => attempt(() => controller.updateSmartFilter(id, row.filter.id, { enabled: (e.target as HTMLInputElement).checked }))}
              class="accent-indigo-500" />
            <button
              type="button"
              aria-expanded={expanded}
              class="flex-1 text-left {row.filter.enabled && model.filtersEnabled ? '' : 'text-slate-500'}"
              title={row.drawn ? undefined : 'A Photoshop filter kept from the file: written back, not drawn here.'}
              onclick={() => (open = expanded ? null : row.filter.id)}>{row.label}{row.drawn ? '' : ' (not drawn)'}</button>
            <button type="button" class={button} aria-label={`Move ${row.label} up`} disabled={readOnly || i === 0} onclick={() => attempt(() => controller.moveSmartFilter(id, row.filter.id, row.index + 1))}>↑</button>
            <button type="button" class={button} aria-label={`Move ${row.label} down`} disabled={readOnly || i === model.filters.length - 1} onclick={() => attempt(() => controller.moveSmartFilter(id, row.filter.id, row.index - 1))}>↓</button>
            <button type="button" class={button} aria-label={`Remove ${row.label}`} disabled={readOnly} onclick={() => attempt(() => controller.removeSmartFilter(id, row.filter.id))}>✕</button>
          </div>
          {#if expanded}
            <div class="grid grid-cols-2 gap-x-2 gap-y-1 px-1.5 pb-1.5" data-testid="smart-filter-settings">
              {#each smartFilterControls(row.filter) as ctl (ctl.key)}
                {#if ctl.type === 'select'}
                  <label class="flex flex-col gap-0.5">
                    <span class="text-slate-400">{ctl.label}</span>
                    <select aria-label={ctl.label} value={ctl.value} disabled={readOnly} onchange={(e) => change(id, row.filter.id, ctl, (e.target as HTMLSelectElement).value)} class="bg-slate-800 border border-slate-700 rounded px-1.5 py-1">
                      {#each ctl.options as o (o.value)}
                        <option value={o.value}>{o.label}</option>
                      {/each}
                    </select>
                  </label>
                {:else if ctl.type === 'range'}
                  {@const k = ctl.percent ? 100 : 1}
                  {@const shown = Math.round(ctl.value * k * 100) / 100}
                  <label class="flex flex-col gap-0.5">
                    <span class="text-slate-400">{ctl.label} {shown}{ctl.unit ?? ''}</span>
                    <input
                      type="range"
                      aria-label={ctl.label}
                      min={ctl.min * k}
                      max={ctl.max * k}
                      step={ctl.step * k}
                      value={shown}
                      disabled={readOnly}
                      onpointerdown={() => (commitNext = true)}
                      onpointerup={() => (commitNext = true)}
                      onkeydown={() => (commitNext = true)}
                      oninput={(e) => change(id, row.filter.id, ctl, Number((e.target as HTMLInputElement).value) / k, true)}
                      class="accent-indigo-500" />
                  </label>
                {/if}
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if error}
      <p role="alert" class="text-rose-400">{error}</p>
    {/if}
  </div>
{/if}
