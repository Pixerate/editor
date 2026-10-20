<script lang="ts">
  import { getVectorSymbolsPanel, vectorPaintToHex, type VectorEditorController } from '@pixerate/editor/vector';
  import VectorGradientDefs from './VectorGradientDefs.svelte';
  import VectorFilterDefs from './VectorFilterDefs.svelte';
  import VectorSceneNodes from './VectorSceneNodes.svelte';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Symbols of the document with previews: New Symbol from the selection, Place, Edit (isolation
   * mode) and Delete per symbol; for a selected instance, Replace, Scale strokes, a fill tint and
   * Detach. Each change is one undo step.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const prefix = `vsym${Math.random().toString(36).slice(2, 8)}-`;
  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const panel = $derived(getVectorSymbolsPanel(view, { idPrefix: prefix }));
  const inst = $derived(panel.instance);
  let error: string | null = $state(null);
  const report = (r: { ok: boolean; message?: string }) => {
    error = r.ok ? null : (r.message ?? null);
  };

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const labelClass = 'w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
</script>

<div class="space-y-2 {className}" data-vector-symbols-panel="" aria-label="Symbols">
  <div class="flex items-center gap-1">
    <span class={labelClass}>Symbols</span>
    <button type="button" class={buttonClass} data-vector-symbol-action="make" disabled={!panel.canMake} title="New Symbol from the selection (F8)" onclick={() => report(controller.makeSymbol())}>New</button>
    {#if panel.editing}
      <button type="button" class={buttonClass} data-vector-symbol-action="exit" title="Leave the symbol (Escape)" onclick={() => controller.exitSymbolEdit()}>Done</button>
    {/if}
  </div>
  {#if panel.symbols.length}
    <ul class="space-y-1">
      {#each panel.symbols as s (s.id)}
        <li data-vector-symbol={s.id} data-editing={s.editing || undefined} class="flex items-center gap-1">
          <svg viewBox={s.viewBox} width="28" height="28" class="shrink-0 rounded border border-border bg-background" aria-hidden="true">
            <VectorGradientDefs defs={s.scene.defs} />
            <VectorFilterDefs filters={s.scene.filters} />
            <VectorSceneNodes nodes={s.scene.nodes} />
          </svg>
          <span class="min-w-0 flex-1 truncate text-xs text-foreground" title="{s.name} · {s.instances} instance{s.instances === 1 ? '' : 's'}">{s.name} <span class="text-muted-foreground">· {s.instances}</span></span>
          <button type="button" class={buttonClass} aria-label="Place {s.name}" title="Place an instance" onclick={() => report(controller.placeSymbol(s.id))}>+</button>
          <button type="button" class={buttonClass} aria-label="Edit {s.name}" aria-pressed={s.editing} title="Edit Symbol (isolation mode)" onclick={() => report(controller.editSymbol(s.id))}>✎</button>
          <button type="button" class={buttonClass} aria-label="Delete {s.name}" title="Delete the symbol (its instances become groups)" onclick={() => report(controller.deleteSymbol(s.id, { detach: true }))}>×</button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if inst}
    <div class="space-y-1" data-vector-instance={inst.id}>
      <div class="flex items-center gap-1">
        <select aria-label="Instance symbol" class={selectClass} value={inst.symbolId} onchange={(e) => report(controller.replaceSymbol((e.currentTarget as HTMLSelectElement).value, { ids: [inst.id] }))}>
          {#each panel.symbols as s (s.id)}
            <option value={s.id}>{s.name}</option>
          {/each}
        </select>
        <button type="button" class={buttonClass} title="Break Link to Symbol: a plain group of its art" onclick={() => report(controller.detachInstances({ ids: [inst.id] }))}>Detach</button>
      </div>
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1 text-xs text-foreground">
          <input type="checkbox" aria-label="Scale strokes" checked={inst.scaleStrokes} onchange={(e) => report(controller.setInstanceOptions({ scaleStrokes: (e.currentTarget as HTMLInputElement).checked }, { ids: [inst.id] }))} />
          Scale strokes
        </label>
        <label class="flex items-center gap-1 text-xs text-foreground" title="Paint every fill of the art in this instance">
          Tint
          <input
            type="color"
            aria-label="Instance fill"
            class="h-6 w-8 rounded border border-border"
            value={vectorPaintToHex(inst.fill ?? undefined) ?? '#000000'}
            onchange={(e) => report(controller.setInstanceOptions({ fill: (e.currentTarget as HTMLInputElement).value }, { ids: [inst.id] }))}
          />
        </label>
        {#if inst.fill !== null}
          <button type="button" class={buttonClass} aria-label="Clear tint" onclick={() => report(controller.setInstanceOptions({ fill: null }, { ids: [inst.id] }))}>×</button>
        {/if}
      </div>
    </div>
  {/if}
  {#if error}<p class="text-[11px] text-destructive">{error}</p>{/if}
</div>
