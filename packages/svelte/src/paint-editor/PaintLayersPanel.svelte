<script lang="ts">
  import { BLEND_MENU_GROUPS, type BlendMode, type PaintEditorController, type PaintLayerInfo } from '@pixerate/editor/paint-editor';
  import { untrack } from 'svelte';
  import { attempt, button, chip, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const layers = $derived.by(() => {
    void editor.current;
    return untrack(() => controller.listLayers());
  });
  const active = $derived(layers.find((l) => l.active) ?? null);
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
          <span class="flex-1 truncate" role="presentation" ondblclick={() => (renaming = l.id)}>{l.type === 'group' ? '▸ ' : ''}{l.name}</span>
        {/if}
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
    </div>
  {/if}
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
