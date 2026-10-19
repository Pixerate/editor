<script lang="ts">
  import type { ImageEditorController, ImageLayer, LayerMenuAction, LayerPanelRow, PixelBuffer } from '@pixerate/editor/image-editor';
  import { BLEND_MODES, dropPlacement, dropZone, layerBadge, layerMenu, layerPanelRows, runLayerMenuAction } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  interface Props {
    controller: ImageEditorController;
    /** Thumbnail size in px (default 32). */
    thumbnailSize?: number;
    class?: string;
  }

  let { controller, thumbnailSize = 32, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    // `subscribe` calls the listener at once: untracked, or the effect would depend on `tick`.
    return untrack(() => c.subscribe(() => tick++));
  });

  const snapshot = $derived.by(() => {
    void tick;
    const s = controller.getState();
    return {
      layers: s.layers,
      activeLayerId: s.activeLayerId,
      activeTarget: s.activeTarget,
      rows: layerPanelRows(s.layers, s.activeLayerId),
      active: controller.getActiveLayer() ?? null,
      menu: layerMenu(controller),
    };
  });

  let error = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  let menu = $state<{ x: number; y: number } | null>(null);
  let dragId = $state<string | null>(null);
  /** Whether the next slider change records an undo step (the first of a drag does, the rest replace it). */
  let commitNext = true;

  const LOCKS = ['pixels', 'transparency', 'position', 'all'] as const;
  const iconButton = 'px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 hover:text-white disabled:opacity-40';
  const rowClass = (active: boolean) =>
    `flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer select-none ${active ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'hover:bg-slate-800'}`;

  function attempt(fn: () => unknown) {
    try {
      error = null;
      fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function run(action: LayerMenuAction) {
    menu = null;
    error = await runLayerMenuAction(controller, action);
  }

  function prop(key: 'opacity' | 'fillOpacity', value: number) {
    const id = snapshot.active?.id;
    if (!id) return;
    attempt(() => {
      controller.setLayerProperties(id, { [key]: value }, commitNext);
      commitNext = false;
    });
  }

  function onDrop(e: DragEvent, row: LayerPanelRow) {
    e.preventDefault();
    const id = e.dataTransfer?.getData('text/x-pixerate-layer') || dragId;
    dragId = null;
    if (!id) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fraction = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
    const placement = dropPlacement(snapshot.layers, id, row.layer.id, dropZone(fraction, row.layer.type === 'group'));
    if (placement) attempt(() => controller.moveLayer(id, placement));
  }

  const locked = (layer: ImageLayer) => Boolean(layer.locks?.all || layer.locks?.pixels || layer.locks?.position || layer.locks?.transparency);
  const fillOf = (layer: ImageLayer) => (layer.type === 'pixel' ? layer.fillOpacity ?? 1 : 1);

  /** Draws RGBA pixels into a canvas (nothing without a 2D context). */
  function paint(canvas: HTMLCanvasElement, pixels: PixelBuffer | null) {
    const draw = (px: PixelBuffer | null) => {
      const ctx = canvas.getContext('2d');
      if (!ctx || !px || typeof ctx.createImageData !== 'function') return;
      canvas.width = px.width;
      canvas.height = px.height;
      const img = ctx.createImageData(px.width, px.height);
      img.data.set(px.data as ArrayLike<number>);
      ctx.putImageData(img, 0, 0);
    };
    draw(pixels);
    return { update: draw };
  }

  function thumb(layer: ImageLayer): PixelBuffer | null {
    void tick;
    return layer.type === 'pixel' ? controller.getLayerThumbnail(layer.id, { maxSide: 64 }) : null;
  }
  function maskThumb(layer: ImageLayer): PixelBuffer | null {
    void tick;
    return layer.mask && !layer.mask.source ? controller.getLayerThumbnail(layer.id, { maxSide: 64, mask: true }) : null;
  }
  const thumbClass = (selected: boolean) =>
    `shrink-0 rounded bg-slate-800 ${selected ? 'ring-2 ring-white' : 'ring-1 ring-slate-700'}`;
</script>

<svelte:window onclick={() => menu && (menu = null)} />

<div class="flex flex-col gap-2 text-xs text-slate-200 {className}" data-testid="layers-panel">
  <div class="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Layer actions">
    <button type="button" class={iconButton} onclick={() => run('new-layer')}>New Layer</button>
    <button type="button" class={iconButton} onclick={() => run('new-group')}>New Group</button>
    <button type="button" class={iconButton} disabled={!snapshot.active} onclick={() => run('duplicate')}>Duplicate</button>
    <button type="button" class={iconButton} disabled={!snapshot.active} onclick={() => run('add-mask')}>Add Mask</button>
    <button type="button" class={iconButton} disabled={!snapshot.active} onclick={() => run('delete')}>Delete</button>
    <button
      type="button"
      class={iconButton}
      aria-label="Layer menu"
      aria-haspopup="menu"
      onclick={(e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        menu = menu ? null : { x: r.left, y: r.bottom };
      }}>⋯</button>
  </div>

  {#if snapshot.active}
    {@const active = snapshot.active}
    <div class="grid grid-cols-2 gap-x-2 gap-y-1 items-center" data-testid="layer-properties">
      <label class="flex flex-col gap-0.5">
        <span class="text-slate-400">Opacity {Math.round(active.opacity * 100)}%</span>
        <input
          type="range"
          min="0"
          max="100"
          aria-label="Layer opacity"
          value={Math.round(active.opacity * 100)}
          onpointerdown={() => (commitNext = true)}
          onpointerup={() => (commitNext = true)}
          onkeydown={() => (commitNext = true)}
          oninput={(e) => prop('opacity', Number((e.target as HTMLInputElement).value) / 100)}
          class="accent-indigo-500"
        />
      </label>
      <label class="flex flex-col gap-0.5">
        <span class="text-slate-400">Fill {Math.round(fillOf(active) * 100)}%</span>
        <input
          type="range"
          min="0"
          max="100"
          aria-label="Layer fill"
          disabled={active.type !== 'pixel'}
          value={Math.round(fillOf(active) * 100)}
          onpointerdown={() => (commitNext = true)}
          onpointerup={() => (commitNext = true)}
          onkeydown={() => (commitNext = true)}
          oninput={(e) => prop('fillOpacity', Number((e.target as HTMLInputElement).value) / 100)}
          class="accent-indigo-500 disabled:opacity-40"
        />
      </label>
      <select
        aria-label="Layer blend mode"
        class="bg-slate-800 border border-slate-700 rounded px-1.5 py-1"
        value={active.blend}
        onchange={(e) => attempt(() => controller.setLayerProperties(active.id, { blend: (e.target as HTMLSelectElement).value as never }))}
      >
        {#if active.type === 'group'}<option value="pass-through">Pass Through</option>{/if}
        {#each BLEND_MODES as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
      <label class="flex items-center gap-1.5 text-slate-300">
        <input
          type="checkbox"
          aria-label="Clip to layer below"
          checked={Boolean(active.clipped)}
          onchange={(e) => attempt(() => controller.setLayerProperties(active.id, { clipped: (e.target as HTMLInputElement).checked }))}
          class="accent-indigo-500"
        />
        Clip to below
      </label>
      <div class="col-span-2 flex flex-wrap gap-2 text-slate-400" role="group" aria-label="Layer locks">
        {#each LOCKS as k (k)}
          <label class="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={`Lock ${k}`}
              checked={Boolean(active.locks?.[k])}
              onchange={(e) => attempt(() => controller.setLayerProperties(active.id, { locks: { ...active.locks, [k]: (e.target as HTMLInputElement).checked } }))}
              class="accent-indigo-500"
            />
            {k}
          </label>
        {/each}
      </div>
    </div>
  {/if}

  <ul class="flex flex-col gap-0.5" role="tree" aria-label="Layers">
    {#each snapshot.rows as row (row.layer.id)}
      {@const layer = row.layer}
      <li
        role="treeitem"
        aria-selected={row.active}
        aria-level={row.depth + 1}
        data-layer-id={layer.id}
        draggable={!layer.locks?.all}
        ondragstart={(e) => {
          e.dataTransfer?.setData('text/x-pixerate-layer', layer.id);
          dragId = layer.id;
        }}
        ondragover={(e) => e.preventDefault()}
        ondrop={(e) => onDrop(e, row)}
        tabindex="0"
        onclick={() => attempt(() => controller.setActiveLayer(layer.id, 'pixels'))}
        onkeydown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            attempt(() => controller.setActiveLayer(layer.id, 'pixels'));
          }
        }}
        oncontextmenu={(e) => {
          e.preventDefault();
          controller.setActiveLayer(layer.id, snapshot.activeLayerId === layer.id ? snapshot.activeTarget : 'pixels');
          menu = { x: e.clientX, y: e.clientY };
        }}
        class={rowClass(row.active)}
        style="padding-left: {6 + row.depth * 14}px"
      >
        <button
          type="button"
          aria-label={layer.visible ? `Hide ${row.label}` : `Show ${row.label}`}
          aria-pressed={layer.visible}
          class="w-4 text-center text-slate-300"
          onclick={(e) => {
            e.stopPropagation();
            attempt(() => controller.setLayerProperties(layer.id, { visible: !layer.visible }));
          }}>{layer.visible ? '●' : '○'}</button>
        {#if layer.type === 'group'}
          <button
            type="button"
            aria-label={layer.collapsed ? `Expand ${row.label}` : `Collapse ${row.label}`}
            class="w-3 text-slate-400"
            onclick={(e) => {
              e.stopPropagation();
              attempt(() => controller.setLayerProperties(layer.id, { collapsed: !(layer.type === 'group' && layer.collapsed) }));
            }}>{layer.collapsed ? '▸' : '▾'}</button>
        {/if}
        {#if row.clipped}<span class="text-slate-500" aria-label="Clipped">↳</span>{/if}
        {#if layer.type === 'pixel'}
          <canvas
            use:paint={thumb(layer)}
            aria-label={`${row.label} pixels`}
            style="width: {thumbnailSize}px; height: {thumbnailSize}px"
            class={thumbClass(row.active && snapshot.activeTarget === 'pixels' && Boolean(layer.mask))}
          ></canvas>
        {:else}
          <span
            class="shrink-0 grid place-items-center rounded bg-slate-800 text-[9px] text-slate-400 ring-1 ring-slate-700"
            style="width: {thumbnailSize}px; height: {thumbnailSize}px">{layerBadge(layer)}</span>
        {/if}
        {#if layer.mask}
          <canvas
            use:paint={maskThumb(layer)}
            role="button"
            tabindex="0"
            aria-label={`${row.label} mask${layer.mask.enabled === false ? ' (disabled)' : ''}`}
            data-testid="layer-mask-thumbnail"
            style="width: {thumbnailSize}px; height: {thumbnailSize}px"
            class={thumbClass(row.active && snapshot.activeTarget === 'mask')}
            onclick={(e) => {
              e.stopPropagation();
              if (e.shiftKey) attempt(() => controller.setLayerMaskProps(layer.id, { enabled: layer.mask!.enabled === false }));
              else attempt(() => controller.setActiveLayer(layer.id, 'mask'));
            }}
          ></canvas>
        {/if}
        {#if renaming === layer.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            aria-label="Layer name"
            value={layer.name || row.label}
            class="flex-1 min-w-0 bg-slate-900 border border-slate-600 rounded px-1"
            onclick={(e) => e.stopPropagation()}
            onblur={(e) => {
              const v = (e.target as HTMLInputElement).value;
              renaming = null;
              if (v.trim() && v !== layer.name) attempt(() => controller.setLayerProperties(layer.id, { name: v }));
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') renaming = null;
            }}
          />
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="flex-1 min-w-0 truncate {layer.visible ? '' : 'text-slate-500'}"
            ondblclick={(e) => {
              e.stopPropagation();
              renaming = layer.id;
            }}>{row.label}</span>
        {/if}
        {#if locked(layer)}<span aria-label="Locked" class="text-slate-400">🔒</span>{/if}
        {#if layer.blend !== 'normal' && layer.blend !== 'pass-through'}<span class="text-[9px] text-slate-500">{layer.blend}</span>{/if}
      </li>
    {/each}
  </ul>

  {#if error}
    <p role="alert" class="text-rose-400">{error}</p>
  {/if}

  {#if menu}
    <div
      role="menu"
      tabindex="-1"
      aria-label="Layer menu"
      class="fixed z-50 min-w-44 rounded border border-slate-700 bg-slate-900 py-1 shadow-xl"
      style="left: {menu.x}px; top: {menu.y}px"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && (menu = null)}
    >
      {#each snapshot.menu as item (item.action)}
        <button
          type="button"
          role="menuitem"
          disabled={!item.enabled}
          class="block w-full px-3 py-1 text-left hover:bg-slate-800 disabled:opacity-40"
          onclick={() => run(item.action)}>{item.label}</button>
      {/each}
    </div>
  {/if}
</div>
