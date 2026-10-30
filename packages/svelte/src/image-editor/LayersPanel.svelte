<script lang="ts">
  import { imageIconButtonClass, imageSelectClass } from './styles.js';
  import type { ImageEditorController, ImageLayer, LayerMenuAction, LayerPanelRow, PixelBuffer } from '@pixerate/editor/image-editor';
  import {
    BIT_DEPTH_OPTIONS,
    BLEND_MODES,
    PSD_FILE_ACCEPT,
    downloadPsd,
    dropPlacement,
    dropZone,
    maskThumbnailClick,
    layerThumbnailClick,
    layerBadge,
    layerEffectsBadge,
    layerHasThumbnail,
    layerWarning,
    layerMenu,
    layerPanelRows,
    openPsdFile,
    runLayerMenuAction,
  } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';
  import LayerEffectsPanel from './LayerEffectsPanel.svelte';

  interface Props {
    controller: ImageEditorController;
    /** Thumbnail size in px (default 32). */
    thumbnailSize?: number;
    /** Show Open PSD / Export PSD (default true). */
    psd?: boolean;
    /** Base name of exported PSD files (default `image`). */
    psdFileName?: string;
    /** Show the active layer's effects section (default true). */
    effects?: boolean;
    class?: string;
  }

  let { controller, thumbnailSize = 32, psd = true, psdFileName = 'image', effects = true, class: className = '' }: Props = $props();

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
      maskView: controller.getMaskView(),
      rows: layerPanelRows(s.layers, s.activeLayerId),
      active: controller.getActiveLayer() ?? null,
      menu: layerMenu(controller),
      bitDepth: controller.bitDepth,
    };
  });

  let error = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  let menu = $state<{ x: number; y: number } | null>(null);
  let dragId = $state<string | null>(null);
  /** Warnings of the last PSD open or export. */
  let psdNotes = $state<string[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);

  async function psdTask(fn: () => Promise<string[]>) {
    try {
      error = null;
      psdNotes = await fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function onPsdFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) psdTask(() => openPsdFile(controller, file));
  }
  /** Whether the next slider change records an undo step (the first of a drag does, the rest replace it). */
  let commitNext = true;

  const LOCKS = ['pixels', 'transparency', 'position', 'all'] as const;
  const rowClass = (active: boolean) =>
    `flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer select-none ${active ? 'bg-primary/30 ring-1 ring-primary' : 'hover:bg-muted'}`;

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
    return layerHasThumbnail(layer) ? controller.getLayerThumbnail(layer.id, { maxSide: 64 }) : null;
  }
  function maskThumb(layer: ImageLayer): PixelBuffer | null {
    void tick;
    return layer.mask && !layer.mask.source ? controller.getLayerThumbnail(layer.id, { maxSide: 64, mask: true }) : null;
  }
  const thumbClass = (selected: boolean) =>
    `shrink-0 rounded bg-muted ${selected ? 'ring-2 ring-foreground' : 'ring-1 ring-border'}`;
</script>

<svelte:window onclick={() => menu && (menu = null)} />

<div class="flex flex-col gap-2 text-xs text-foreground {className}" data-testid="layers-panel">
  <div class="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Layer actions">
    <button type="button" class={imageIconButtonClass} onclick={() => run('new-layer')}>New Layer</button>
    <button type="button" class={imageIconButtonClass} onclick={() => run('new-group')}>New Group</button>
    <button type="button" class={imageIconButtonClass} disabled={!snapshot.active} onclick={() => run('duplicate')}>Duplicate</button>
    <button type="button" class={imageIconButtonClass} disabled={!snapshot.active} onclick={() => run('add-mask')}>Add Mask</button>
    <button type="button" class={imageIconButtonClass} disabled={!snapshot.active} onclick={() => run('delete')}>Delete</button>
    <button
      type="button"
      class={imageIconButtonClass}
      aria-label="Layer menu"
      aria-haspopup="menu"
      onclick={(e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        menu = menu ? null : { x: r.left, y: r.bottom };
      }}>⋯</button>
    <select
      aria-label="Bits per channel"
      title="Image › Mode: bits per channel"
      class="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground"
      value={snapshot.bitDepth}
      onchange={(e) => attempt(() => controller.setBitDepth(Number((e.target as HTMLSelectElement).value) as 8 | 16 | 32))}>
      {#each BIT_DEPTH_OPTIONS as o (o.depth)}
        <option value={o.depth} title={o.title}>{o.label}</option>
      {/each}
    </select>
    {#if psd}
      <button type="button" class={imageIconButtonClass} onclick={() => fileInput?.click()}>Open PSD…</button>
      <button type="button" class={imageIconButtonClass} onclick={() => psdTask(async () => (await downloadPsd(controller, psdFileName)).warnings)}>Export PSD</button>
      <input
        bind:this={fileInput}
        type="file"
        accept={PSD_FILE_ACCEPT}
        class="hidden"
        data-testid="psd-file-input"
        aria-label="Open a PSD file"
        onchange={onPsdFile} />
    {/if}
  </div>
  {#if psdNotes.length > 0}
    <ul class="rounded bg-amber-500/10 text-amber-600 px-2 py-1 space-y-0.5" data-testid="psd-warnings" aria-label="PSD warnings">
      {#each psdNotes as n (n)}
        <li>{n}</li>
      {/each}
      <li><button type="button" class="underline" onclick={() => (psdNotes = [])}>Dismiss</button></li>
    </ul>
  {/if}

  {#if snapshot.active}
    {@const active = snapshot.active}
    <div class="grid grid-cols-2 gap-x-2 gap-y-1 items-center" data-testid="layer-properties">
      <label class="flex flex-col gap-0.5">
        <span class="text-muted-foreground">Opacity {Math.round(active.opacity * 100)}%</span>
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
          class="accent-primary"
        />
      </label>
      <label class="flex flex-col gap-0.5">
        <span class="text-muted-foreground">Fill {Math.round(fillOf(active) * 100)}%</span>
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
          class="accent-primary disabled:opacity-40"
        />
      </label>
      <select
        aria-label="Layer blend mode"
        class={imageSelectClass}
        value={active.blend}
        onchange={(e) => attempt(() => controller.setLayerProperties(active.id, { blend: (e.target as HTMLSelectElement).value as never }))}
      >
        {#if active.type === 'group'}<option value="pass-through">Pass Through</option>{/if}
        {#each BLEND_MODES as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
      <label class="flex items-center gap-1.5 text-foreground">
        <input
          type="checkbox"
          aria-label="Clip to layer below"
          checked={Boolean(active.clipped)}
          onchange={(e) => attempt(() => controller.setLayerProperties(active.id, { clipped: (e.target as HTMLInputElement).checked }))}
          class="accent-primary"
        />
        Clip to below
      </label>
      <div class="col-span-2 flex flex-wrap gap-2 text-muted-foreground" role="group" aria-label="Layer locks">
        {#each LOCKS as k (k)}
          <label class="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={`Lock ${k}`}
              checked={Boolean(active.locks?.[k])}
              onchange={(e) => attempt(() => controller.setLayerProperties(active.id, { locks: { ...active.locks, [k]: (e.target as HTMLInputElement).checked } }))}
              class="accent-primary"
            />
            {k}
          </label>
        {/each}
      </div>
    </div>
  {/if}

  {#if effects && snapshot.active && snapshot.active.type !== 'adjustment'}
    <LayerEffectsPanel {controller} class="border-t border-border pt-1.5" />
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
          class="w-4 text-center text-foreground"
          onclick={(e) => {
            e.stopPropagation();
            attempt(() => controller.setLayerProperties(layer.id, { visible: !layer.visible }));
          }}>{layer.visible ? '●' : '○'}</button>
        {#if layer.type === 'group'}
          <button
            type="button"
            aria-label={layer.collapsed ? `Expand ${row.label}` : `Collapse ${row.label}`}
            class="w-3 text-muted-foreground"
            onclick={(e) => {
              e.stopPropagation();
              attempt(() => controller.setLayerProperties(layer.id, { collapsed: !(layer.type === 'group' && layer.collapsed) }));
            }}>{layer.collapsed ? '▸' : '▾'}</button>
        {/if}
        {#if row.clipped}<span class="text-muted-foreground" aria-label="Clipped">↳</span>{/if}
        {#if layerHasThumbnail(layer)}
          <span class="relative shrink-0">
            <canvas
              use:paint={thumb(layer)}
              aria-label={`${row.label} pixels`}
              data-testid="layer-thumbnail"
              onclick={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  e.stopPropagation();
                  attempt(() => layerThumbnailClick(controller, layer, e));
                }
              }}
              style="width: {thumbnailSize}px; height: {thumbnailSize}px"
              class={thumbClass(row.active && snapshot.activeTarget === 'pixels' && Boolean(layer.mask))}
            ></canvas>
            {#if layer.type !== 'pixel'}
              <span
                data-testid="layer-kind-badge"
                class="absolute -bottom-1 -right-1 rounded bg-accent px-0.5 text-[8px] font-bold leading-tight text-foreground ring-1 ring-background">{layerBadge(layer)}</span>
            {/if}
          </span>
        {:else}
          <span
            class="shrink-0 grid place-items-center rounded bg-muted text-[9px] text-muted-foreground ring-1 ring-border"
            style="width: {thumbnailSize}px; height: {thumbnailSize}px">{layerBadge(layer)}</span>
        {/if}
        {#if layer.mask && !layer.mask.source && layer.type === 'pixel'}
          <button
            type="button"
            aria-label={`${layer.mask.linked === false ? 'Link' : 'Unlink'} ${row.label} mask`}
            aria-pressed={layer.mask.linked !== false}
            title={layer.mask.linked === false ? 'Mask unlinked: it stays put when the layer moves or transforms. Click to link.' : 'Mask linked: it moves with the layer. Click to unlink.'}
            data-testid="layer-mask-link"
            class="shrink-0 text-[10px] leading-none {layer.mask.linked === false ? 'text-muted-foreground/70' : 'text-foreground'}"
            onclick={(e) => {
              e.stopPropagation();
              attempt(() => controller.setLayerMaskProps(layer.id, { linked: layer.mask!.linked === false }));
            }}>{layer.mask.linked === false ? '⛓︎̸' : '⛓︎'}</button>
        {/if}
        {#if layer.mask}
          <canvas
            use:paint={maskThumb(layer)}
            role="button"
            tabindex="0"
            aria-label={`${row.label} mask${layer.mask.enabled === false ? ' (disabled)' : ''}${snapshot.maskView?.layerId === layer.id ? ' (shown)' : ''}`}
            title="Alt-click: show the mask alone · Alt+Shift-click: as an overlay"
            data-testid="layer-mask-thumbnail"
            style="width: {thumbnailSize}px; height: {thumbnailSize}px"
            class={thumbClass(row.active && snapshot.activeTarget === 'mask')}
            onclick={(e) => {
              e.stopPropagation();
              attempt(() => maskThumbnailClick(controller, layer, e));
            }}
          ></canvas>
        {/if}
        {#if renaming === layer.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            aria-label="Layer name"
            value={layer.name || row.label}
            class="flex-1 min-w-0 bg-background border border-border rounded px-1"
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
            class="flex-1 min-w-0 truncate {layer.visible ? '' : 'text-muted-foreground'}"
            ondblclick={(e) => {
              e.stopPropagation();
              renaming = layer.id;
            }}>{row.label}</span>
        {/if}
        {#if layerWarning(layer)}
          <span role="img" data-testid="layer-warning" aria-label={layerWarning(layer)} title={layerWarning(layer)} class="text-[10px] text-amber-600">⚠</span>
        {/if}
        {#if layerEffectsBadge(layer)}
          {@const fxOn = layerEffectsBadge(layer) === 'on'}
          <button
            type="button"
            data-testid="layer-fx-badge"
            aria-label={fxOn ? `Turn effects off for ${row.label}` : `Turn effects on for ${row.label}`}
            aria-pressed={fxOn}
            class="text-[9px] italic font-semibold {fxOn ? 'text-primary' : 'text-muted-foreground/70 line-through'}"
            onclick={(e) => {
              e.stopPropagation();
              attempt(() => controller.setLayerEffectsEnabled(layer.id, !fxOn));
            }}>fx</button
          >
        {/if}
        {#if locked(layer)}<span aria-label="Locked" class="text-muted-foreground">🔒</span>{/if}
        {#if layer.blend !== 'normal' && layer.blend !== 'pass-through'}<span class="text-[9px] text-muted-foreground">{layer.blend}</span>{/if}
      </li>
    {/each}
  </ul>

  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}

  {#if menu}
    <div
      role="menu"
      tabindex="-1"
      aria-label="Layer menu"
      class="fixed z-50 min-w-44 rounded border border-border bg-background py-1 shadow-xl"
      style="left: {menu.x}px; top: {menu.y}px"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && (menu = null)}
    >
      {#each snapshot.menu as item (item.action)}
        <button
          type="button"
          role="menuitem"
          disabled={!item.enabled}
          class="block w-full px-3 py-1 text-left hover:bg-muted disabled:opacity-40"
          onclick={() => run(item.action)}>{item.label}</button>
      {/each}
    </div>
  {/if}
</div>
