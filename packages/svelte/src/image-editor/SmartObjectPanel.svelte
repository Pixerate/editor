<script lang="ts">
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import ImageRange from './controls/ImageRange.svelte';
  import ImageSelect from './controls/ImageSelect.svelte';
  import { imageIconButtonClass } from './styles.js';
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

  /**
   * A smart object's contents and smart filters: Edit Contents, Replace Contents…, Export Contents,
   * New Smart Object via Copy and Rasterize; the smart filter stack (add Develop or Blur, the
   * stack's switch, each filter's eye, order, remove and, when expanded, blend mode, opacity and
   * settings); and the filter mask (add, enable, link, paint it, remove). Every change is one undo
   * step (a slider drag is one step too).
   */
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
  const button = imageIconButtonClass;

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
  <div class="text-xs text-muted-foreground {className}" data-testid="smart-object">{view.model.reason}</div>
{:else}
  {@const model = view.model}
  {@const id = model.layerId!}
  {@const c = model.contents!}
  {@const readOnly = !model.editable}
  <div class="flex flex-col gap-1.5 text-xs text-foreground {className}" data-testid="smart-object" aria-label="Smart object" role="group">
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="font-semibold text-foreground">Smart Object</span>
      <span class="text-muted-foreground" data-testid="smart-contents"
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

    <div class="flex flex-wrap items-center gap-2 border-t border-border pt-1.5">
      <span class="font-semibold text-foreground">Smart Filters</span>
      <label class="flex items-center gap-1 text-foreground">
        <ImageCheckbox label="Smart filters on" checked={model.filtersEnabled} disabled={readOnly || !model.filters.length} onchange={(on) => attempt(() => controller.setSmartFiltersEnabled(id, on))} />
        On
      </label>
      <ImageSelect
        label="Add smart filter"
        value=""
        placeholder="Add smart filter…"
        disabled={readOnly}
        options={SMART_FILTER_MENU.map((m) => ({ value: m.kind, label: m.label }))}
        onchange={(kind) => {
          if (kind) attempt(() => (open = controller.addSmartFilter(id, { kind }).id));
        }}
      />
    </div>

    <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter mask" data-testid="smart-filter-mask">
      <span class="text-muted-foreground">Filter mask</span>
      {#if model.mask}
        <button
          type="button"
          class={button}
          aria-pressed={view.activeLayerId === id && view.activeTarget === 'filter-mask'}
          onclick={() => attempt(() => controller.setActiveLayer(id, 'filter-mask'))}>Paint</button>
        <label class="flex items-center gap-1 text-foreground">
          <ImageCheckbox label="Filter mask on" checked={model.mask.enabled} disabled={readOnly} onchange={(on) => attempt(() => controller.setSmartFilterMask(id, 'keep', { enabled: on }))} />
          On
        </label>
        <label class="flex items-center gap-1 text-foreground">
          <ImageCheckbox label="Filter mask linked" checked={model.mask.linked} disabled={readOnly} onchange={(on) => attempt(() => controller.setSmartFilterMask(id, 'keep', { linked: on }))} />
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
        <li data-filter-id={row.filter.id} class="rounded bg-background/60 ring-1 ring-border">
          <div class="flex items-center gap-1.5 px-1.5 py-1">
            <ImageCheckbox label={`${row.label} on`} checked={row.filter.enabled} disabled={readOnly} onchange={(on) => attempt(() => controller.updateSmartFilter(id, row.filter.id, { enabled: on }))} />
            <button
              type="button"
              aria-expanded={expanded}
              class="flex-1 text-left {row.filter.enabled && model.filtersEnabled ? '' : 'text-muted-foreground'}"
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
                    <span class="text-muted-foreground">{ctl.label}</span>
                    <ImageSelect label={ctl.label} value={ctl.value} disabled={readOnly} options={ctl.options} onchange={(v) => change(id, row.filter.id, ctl, v)} />
                  </label>
                {:else if ctl.type === 'range'}
                  {@const k = ctl.percent ? 100 : 1}
                  {@const shown = Math.round(ctl.value * k * 100) / 100}
                  <label class="flex flex-col gap-0.5">
                    <span class="text-muted-foreground">{ctl.label} {shown}{ctl.unit ?? ''}</span>
                    <ImageRange
                      label={ctl.label}
                      min={ctl.min * k}
                      max={ctl.max * k}
                      step={ctl.step * k}
                      value={shown}
                      disabled={readOnly}
                      onstart={() => (commitNext = true)}
                      onend={() => (commitNext = true)}
                      oninput={(v) => change(id, row.filter.id, ctl, v / k, true)}
                    />
                  </label>
                {/if}
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if error}
      <p role="alert" class="text-destructive">{error}</p>
    {/if}
  </div>
{/if}
