<script lang="ts">
  import { imageSectionTitleClass } from './styles.js';
  import type { AlphaChannel, ImageEditorController } from '@pixerate/editor/image-editor';
  import { channelThumbnail, selectionModeFromModifiers } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  interface Props {
    controller: ImageEditorController;
    /** Thumbnail size in CSS pixels (default 32). */
    thumbnailSize?: number;
    class?: string;
  }

  let { controller, thumbnailSize = 32, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  const snapshot = $derived.by(() => {
    void tick;
    return {
      channels: controller.getChannels(),
      hasSelection: Boolean(controller.getSelection()),
      quickMask: controller.quickMaskEditing,
    };
  });
  let activeId = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  let error = $state<string | null>(null);
  const active = $derived(snapshot.channels.find((c) => c.id === activeId) ?? null);

  function attempt(fn: () => unknown) {
    error = null;
    try {
      fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  /** Draws a channel's thumbnail (nothing without a 2D context). */
  function thumb(canvas: HTMLCanvasElement, channel: AlphaChannel) {
    const draw = (c: AlphaChannel) => {
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof ctx.createImageData !== 'function') return;
      const px = channelThumbnail(c, 64);
      canvas.width = px.width;
      canvas.height = px.height;
      const img = ctx.createImageData(px.width, px.height);
      img.data.set(px.data);
      ctx.putImageData(img, 0, 0);
    };
    draw(channel);
    return { update: draw };
  }

  const btn = (on = false) =>
    `px-2 py-1 rounded-md border text-[11px] transition-colors disabled:opacity-40 ${
      on ? 'bg-primary border-primary text-primary-foreground' : 'bg-background border-border text-foreground hover:bg-accent hover:text-accent-foreground'
    }`;
</script>

<!--
  The Channels panel: alpha channels (saved selections) with thumbnails, an eye to show each as a
  tint, click to load it as the selection (Shift adds, Alt subtracts, both intersect), double-click
  to rename; Save Selection, Add to Channel, Duplicate and Delete; and the Quick Mask mode switch.
-->
<div data-testid="channels-panel" class="flex flex-col gap-2 text-xs {className}">
  <div class="flex items-center justify-between">
    <span class={imageSectionTitleClass}>Channels</span>
    <button type="button" aria-pressed={snapshot.quickMask} class={btn(snapshot.quickMask)} title="Paint the selection: white selects, black deselects (Q)" onclick={() => controller.setQuickMaskMode(!snapshot.quickMask)}>Quick Mask</button>
  </div>
  {#if snapshot.channels.length === 0}
    <p class="text-muted-foreground">No channels. Save a selection to keep it.</p>
  {/if}
  <ul role="list" class="flex flex-col gap-0.5">
    {#each snapshot.channels as c (c.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <li
        data-testid="channel-row"
        aria-current={c.id === activeId ? "true" : undefined}
        class="flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer select-none {c.id === activeId ? 'bg-primary/30 ring-1 ring-primary' : 'hover:bg-muted'}"
        onclick={(e) => {
          activeId = c.id;
          attempt(() => controller.loadSelectionFromChannel(c.id, { mode: selectionModeFromModifiers(e, 'replace') }));
        }}
        ondblclick={() => (renaming = c.id)}
      >
        <button
          type="button"
          aria-label={`${c.visible ? 'Hide' : 'Show'} ${c.name}`}
          aria-pressed={c.visible}
          class="w-4 text-muted-foreground"
          onclick={(e) => {
            e.stopPropagation();
            attempt(() => controller.setChannelProperties(c.id, { visible: !c.visible }));
          }}>{c.visible ? '●' : '○'}</button>
        <canvas use:thumb={c} aria-hidden="true" style="width: {thumbnailSize}px; height: {thumbnailSize}px" class="shrink-0 rounded object-contain ring-1 ring-border bg-black"></canvas>
        {#if renaming === c.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            aria-label="Channel name"
            value={c.name}
            class="min-w-0 flex-1 bg-background border border-border rounded px-1 py-0.5 text-foreground"
            onclick={(e) => e.stopPropagation()}
            onblur={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              renaming = null;
              if (v.trim() && v !== c.name) attempt(() => controller.setChannelProperties(c.id, { name: v }));
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
              if (e.key === 'Escape') renaming = null;
            }}
          />
        {:else}
          <span class="min-w-0 flex-1 truncate">{c.name}</span>
        {/if}
      </li>
    {/each}
  </ul>
  <div class="flex flex-wrap gap-1">
    <button type="button" class={btn()} disabled={!snapshot.hasSelection} onclick={() => attempt(() => (activeId = controller.saveSelection().id))}>Save Selection</button>
    <button type="button" class={btn()} disabled={!active || !snapshot.hasSelection} title="Add the selection to the channel" onclick={() => attempt(() => controller.saveSelection({ channelId: active!.id, mode: 'add' }))}>Add to Channel</button>
    <button type="button" class={btn()} disabled={!active} onclick={() => attempt(() => (activeId = controller.duplicateChannel(active!.id).id))}>Duplicate</button>
    <button
      type="button"
      class={btn()}
      disabled={!active}
      onclick={() =>
        attempt(() => {
          controller.deleteChannel(active!.id);
          activeId = null;
        })}>Delete</button>
  </div>
  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}
</div>
