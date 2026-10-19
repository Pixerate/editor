<script lang="ts">
  import type { EffectControl, ImageEditorController, LayerEffectKind } from '@pixerate/editor/image-editor';
  import { LAYER_EFFECT_MENU, effectControlChange, layerEffectControls, layerEffectsPanel } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  /**
   * A layer's effects (Photoshop's layer styles): the master switch, Scale Effects, an "Add
   * effect" menu, and each effect with its enabled toggle, remove button and, when expanded, its
   * settings. Every change is one undo step (a slider drag is one step too).
   */
  interface Props {
    controller: ImageEditorController;
    /** The layer whose effects to show (default: the active layer). */
    layerId?: string | null;
    class?: string;
  }

  let { controller, layerId = null, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });

  const view = $derived.by(() => {
    void tick;
    const layer = layerId ? controller.getLayer(layerId) : controller.getActiveLayer();
    const model = layerEffectsPanel(layer);
    const id = layer?.id ?? null;
    const items = id && model.available ? controller.getLayerEffects(id).items : [];
    return { id, model, items, patterns: controller.getDocumentPatterns() };
  });

  let open = $state<string | null>(null);
  let error = $state<string | null>(null);
  /** Whether the next slider change records an undo step (the first of a drag does, the rest replace it). */
  let commitNext = true;

  const button = 'px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 hover:text-white disabled:opacity-40';

  function attempt(fn: () => unknown) {
    try {
      error = null;
      fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function change(effectId: string, control: EffectControl, value: unknown, drag = false) {
    const id = view.id;
    if (!id) return;
    attempt(() => {
      const effect = controller.getLayerEffects(id).items.find((e) => e.id === effectId)!;
      controller.updateLayerEffect(id, effectId, effectControlChange(effect, control.key, value, view.patterns), drag ? commitNext : true);
      if (drag) commitNext = false;
    });
  }

  function add(e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const kind = select.value as LayerEffectKind;
    select.value = '';
    const id = view.id;
    if (!kind || !id) return;
    attempt(() => (open = controller.addLayerEffect(id, kind).effect.id));
  }

  function setScale(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    const id = view.id;
    if (id && v >= 1 && v <= 1000) attempt(() => controller.setLayerEffectsEnabled(id, view.model.enabled, v / 100));
  }

  const k = (c: EffectControl) => (c.type === 'range' && c.percent ? 100 : 1);
  const shown = (c: EffectControl) => (c.type === 'range' ? Math.round(c.value * k(c) * 100) / 100 : 0);
</script>

{#if !view.model.available || !view.id}
  <div class="text-xs text-slate-500 {className}" data-testid="layer-effects">{view.model.reason}</div>
{:else}
  {@const id = view.id}
  <div class="flex flex-col gap-1.5 text-xs text-slate-200 {className}" data-testid="layer-effects" aria-label="Layer effects" role="group">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-semibold text-slate-300">fx Effects</span>
      <label class="flex items-center gap-1 text-slate-300">
        <input
          type="checkbox"
          aria-label="Effects on"
          checked={view.model.enabled}
          disabled={view.model.readOnly}
          onchange={(e) => attempt(() => controller.setLayerEffectsEnabled(id, (e.currentTarget as HTMLInputElement).checked))}
          class="accent-indigo-500"
        />
        On
      </label>
      <label class="flex items-center gap-1 text-slate-400">
        Scale
        <input
          type="number"
          aria-label="Scale effects"
          min="1"
          max="1000"
          step="1"
          value={Math.round(view.model.scale * 100)}
          disabled={view.model.readOnly}
          oninput={setScale}
          class="w-14 bg-slate-800 border border-slate-700 rounded px-1"
        />
        %
      </label>
      <select aria-label="Add effect" value="" disabled={view.model.readOnly} onchange={add} class="bg-slate-800 border border-slate-700 rounded px-1.5 py-1">
        <option value="">Add effect…</option>
        {#each LAYER_EFFECT_MENU as m (m.kind)}
          <option value={m.kind}>{m.label}</option>
        {/each}
      </select>
    </div>
    {#if view.model.readOnly && view.model.reason}<p class="text-slate-500">{view.model.reason}</p>{/if}
    <ul class="flex flex-col gap-1" aria-label="Effects">
      {#each view.model.rows as row (row.id)}
        {@const effect = view.items.find((e) => e.id === row.id)}
        {@const expanded = open === row.id}
        <li data-effect-id={row.id} class="rounded bg-slate-900/60 ring-1 ring-slate-800">
          <div class="flex items-center gap-1.5 px-1.5 py-1">
            <input
              type="checkbox"
              aria-label="{row.label} on"
              checked={row.enabled}
              disabled={view.model.readOnly}
              onchange={(e) => attempt(() => controller.updateLayerEffect(id, row.id, { enabled: (e.currentTarget as HTMLInputElement).checked }))}
              class="accent-indigo-500"
            />
            <button type="button" aria-expanded={expanded} class="flex-1 text-left {row.enabled && view.model.enabled ? '' : 'text-slate-500'}" onclick={() => (open = expanded ? null : row.id)}>
              {row.label}
            </button>
            <button type="button" class={button} aria-label="Remove {row.label}" disabled={view.model.readOnly} onclick={() => attempt(() => controller.removeLayerEffect(id, row.id))}>✕</button>
          </div>
          {#if expanded && effect}
            <div class="grid grid-cols-2 gap-x-2 gap-y-1 px-1.5 pb-1.5" data-testid="effect-settings">
              {#each layerEffectControls(effect, view.patterns) as c (c.key)}
                {#if c.type === 'range'}
                  <label class="flex flex-col gap-0.5">
                    <span class="text-slate-400">{c.label} {shown(c)}{c.unit ?? ''}</span>
                    <input
                      type="range"
                      aria-label={c.label}
                      min={c.min * k(c)}
                      max={c.max * k(c)}
                      step={c.step * k(c)}
                      value={shown(c)}
                      disabled={view.model.readOnly}
                      onpointerdown={() => (commitNext = true)}
                      onpointerup={() => (commitNext = true)}
                      onkeydown={() => (commitNext = true)}
                      oninput={(e) => change(row.id, c, Number((e.currentTarget as HTMLInputElement).value) / k(c), true)}
                      class="accent-indigo-500"
                    />
                  </label>
                {:else if c.type === 'color'}
                  <label class="flex items-center gap-1.5 text-slate-300">
                    <input type="color" aria-label={c.label} value={c.value} disabled={view.model.readOnly} oninput={(e) => change(row.id, c, (e.currentTarget as HTMLInputElement).value)} />
                    {c.label}
                  </label>
                {:else if c.type === 'checkbox'}
                  <label class="flex items-center gap-1.5 text-slate-300">
                    <input type="checkbox" aria-label={c.label} checked={c.value} disabled={view.model.readOnly} onchange={(e) => change(row.id, c, (e.currentTarget as HTMLInputElement).checked)} class="accent-indigo-500" />
                    {c.label}
                  </label>
                {:else}
                  <label class="flex flex-col gap-0.5">
                    <span class="text-slate-400">{c.label}</span>
                    <select aria-label={c.label} value={c.value} disabled={view.model.readOnly} onchange={(e) => change(row.id, c, (e.currentTarget as HTMLSelectElement).value)} class="bg-slate-800 border border-slate-700 rounded px-1.5 py-1">
                      {#each c.options as o (o.value)}
                        <option value={o.value}>{o.label}</option>
                      {/each}
                    </select>
                  </label>
                {/if}
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if error}<p role="alert" class="text-rose-400">{error}</p>{/if}
  </div>
{/if}
