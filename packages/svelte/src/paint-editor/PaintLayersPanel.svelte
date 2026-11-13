<script lang="ts">
  import { BLEND_MENU_GROUPS, type BlendMode, type PaintEditorController, type PaintLayerInfo } from '@pixerate/editor/paint-editor';
  import { untrack } from 'svelte';
  import { attempt, button, chip, paintEditorState, panel } from './paintEditorRune.svelte.js';
  import LayerEffectsPanel from '../image-editor/LayerEffectsPanel.svelte';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const layers = $derived.by(() => {
    void editor.current;
    return untrack(() => controller.listLayers().filter((l) => !l.temporary));
  });
  const active = $derived(layers.find((l) => l.active) ?? null);
  // Layers whose light / dark paint the colour scheme can't (or can't yet) show in its side.
  const scheme = $derived.by(() => {
    void editor.current;
    return new Map(untrack(() => controller.getState().colorSchemeView.layers.map((v) => [v.layerId, v])));
  });
  const light = $derived.by(() => {
    void editor.current;
    return active?.type === 'pixel' ? untrack(() => controller.lightOf(active.id)) : null;
  });
  let error = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
  const move = (delta: number) => {
    if (!active) return;
    const sibs: PaintLayerInfo[] = layers.filter((x) => x.parentId === active.parentId).reverse();
    const index = sibs.findIndex((x) => x.id === active.id);
    const to = Math.min(sibs.length - 1, Math.max(0, index + delta));
    if (to !== index) run(() => controller.moveLayer(active.id, to));
  };
</script>

<!-- The layer stack, top first, with the active layer's opacity, blend and locks. -->
<div class={`${panel} ${className}`} data-testid="paint-layers-panel">
  <div class="flex flex-wrap gap-1">
    <button type="button" class={button} onclick={() => run(() => controller.addLayer())}>New layer</button>
    <button type="button" class={button} onclick={() => run(() => controller.addLayer({ type: 'group' }))}>New group</button>
    <button type="button" class={button} title="A layer whose strokes stay editable" onclick={() => run(() => controller.addLayer({ type: 'strokes' }))}>New stroke layer</button>
    <button type="button" class={button} disabled={!active} onclick={() => active && run(() => controller.duplicateLayer(active.id))}>Duplicate</button>
    <button type="button" class={button} disabled={!active} aria-label="Move layer up" onclick={() => move(1)}>↑</button>
    <button type="button" class={button} disabled={!active} aria-label="Move layer down" onclick={() => move(-1)}>↓</button>
    <button type="button" class={button} disabled={!active} onclick={() => active && run(() => controller.mergeDown(active.id))}>Merge down</button>
    <button type="button" class={button} disabled={!active || layers.length < 2} onclick={() => active && run(() => controller.removeLayer(active.id))}>Delete</button>
  </div>
  <ul role="tree" aria-label="Layers" class="flex flex-col gap-0.5">
    {#each layers as l (l.id)}
      <li
        role="treeitem"
        aria-selected={l.active}
        class={`flex items-center gap-1.5 rounded px-1.5 py-1 cursor-pointer ${l.active ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'hover:bg-slate-800'}`}
        style={`padding-left: ${6 + l.depth * 12}px`}
        onclick={() => controller.setActiveLayer(l.id)}
        onkeydown={(e) => e.key === 'Enter' && controller.setActiveLayer(l.id)}
      >
        <button
          type="button"
          aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
          class={`w-5 text-[11px] ${l.visible ? 'text-slate-200' : 'text-slate-600'}`}
          onclick={(e) => {
            e.stopPropagation();
            run(() => controller.updateLayer(l.id, { visible: !l.visible }));
          }}>{l.visible ? '●' : '○'}</button
        >
        {#if renaming === l.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            aria-label="Layer name"
            value={l.name}
            class="flex-1 rounded bg-slate-800 px-1"
            onclick={(e) => e.stopPropagation()}
            onblur={(e) => {
              const v = e.currentTarget.value;
              renaming = null;
              if (v.trim() && v !== l.name) run(() => controller.updateLayer(l.id, { name: v }));
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') renaming = null;
            }}
          />
        {:else}
          <span class="flex-1 truncate" role="presentation" ondblclick={() => (renaming = l.id)}>{l.type === 'group' ? '▸ ' : ''}{#if l.liveStrokes !== undefined}<span aria-label="Stroke layer" title={`Stroke layer: ${l.liveStrokes} editable strokes`}>✎ </span>{/if}{l.name}</span>
        {/if}
        {#if scheme.get(l.id)?.view === 'kept'}<span aria-label="Keeps its colours" data-testid="paint-layer-scheme-kept" title={scheme.get(l.id)?.reason}>◐</span>{:else if scheme.get(l.id)?.state === 'building'}<span aria-label="Updating for the colour scheme" data-testid="paint-layer-scheme-building" title="Repainting this layer's light / dark paint for the colour scheme">⟳</span>{/if}
        {#if l.locks.pixels || l.locks.all}<span title="Locked">🔒</span>{/if}
      </li>
    {/each}
  </ul>
  {#if active}
    <div class="flex flex-col gap-1.5">
      <label class="flex items-center gap-2">
        <span class="w-14 text-slate-400">Opacity</span>
        <input type="range" aria-label="Layer opacity" min="0" max="1" step="0.01" value={active.opacity} oninput={(e) => run(() => controller.updateLayer(active.id, { opacity: Number(e.currentTarget.value) }))} class="flex-1 accent-indigo-500" />
      </label>
      <label class="flex items-center gap-2">
        <span class="w-14 text-slate-400">Blend</span>
        <select aria-label="Layer blend" value={active.blend} onchange={(e) => run(() => controller.updateLayer(active.id, { blend: e.currentTarget.value as BlendMode }))} class="flex-1 rounded bg-slate-800 px-1 py-0.5">
          {#if active.type === 'group'}<option value="pass-through">Pass through</option>{/if}
          {#each BLEND_MENU_GROUPS as g (g.label)}
            <optgroup label={g.label}>
              {#each g.modes as m (m.id)}
                <option value={m.id} title={m.description}>{m.label}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      </label>
      <div class="flex gap-1">
        {#each ['pixels', 'transparency'] as const as k (k)}
          <button type="button" aria-pressed={Boolean(active.locks[k])} class={chip(Boolean(active.locks[k]))} onclick={() => run(() => controller.updateLayer(active.id, { locks: { [k]: !active.locks[k] } }))}>{k === 'pixels' ? 'Lock pixels' : 'Lock transparency'}</button>
        {/each}
        <button type="button" aria-pressed={active.clipped} class={chip(active.clipped)} onclick={() => run(() => controller.updateLayer(active.id, { clipped: !active.clipped }))}>Clip</button>
      </div>
      {#if light?.hasLight}
        {@const id = active.id}
        <div class="flex flex-col gap-1.5 border-t border-slate-800 pt-1.5" data-testid="layer-light">
          <div class="flex items-center justify-between">
            <span class="font-medium text-slate-300" title="This layer's paint gives off light">Light</span>
            <button type="button" class={button} onclick={() => run(() => controller.clearLight(id))}>Clear light</button>
          </div>
          <label class="flex items-center gap-2" title="How far the light spills onto the paint and paper around it (0 turns it off)">
            <span class="w-14 text-slate-400">Spill</span>
            <input type="range" aria-label="Light spill radius" min="0" max="120" step="1" value={light.spill.radius} onchange={(e) => run(() => controller.setLightSpill(id, { radius: Number(e.currentTarget.value) }))} class="flex-1 accent-indigo-500" />
          </label>
          <label class="flex items-center gap-2">
            <span class="w-14 text-slate-400">Strength</span>
            <input type="range" aria-label="Light spill strength" min="0" max="2" step="0.05" value={light.spill.strength} onchange={(e) => run(() => controller.setLightSpill(id, { strength: Number(e.currentTarget.value) }))} class="flex-1 accent-indigo-500" />
          </label>
        </div>
      {/if}
      <div class="border-t border-slate-800 pt-1.5" data-testid="paint-layer-effects" title="Live layer styles drawn from this layer's paint: glows, shadows, strokes">
        <LayerEffectsPanel {controller} layerId={active.id} />
      </div>
    </div>
  {/if}
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
