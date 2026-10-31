<script lang="ts">
  import { imageSectionTitleClass } from './styles.js';
  import type { ImageEditorController } from '@pixerate/editor/image-editor';
  import { pathSvgData, selectionModeFromModifiers } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  /**
   * The Paths panel: the document's saved paths and its Work Path (in italics) with outline
   * thumbnails. Click selects a path, double-click renames it (renaming the Work Path saves it).
   * Load as Selection (Shift adds, Alt subtracts), Make Work Path from the selection, Fill and
   * Stroke on the active layer with a colour and width, Add Vector Mask to the active layer,
   * Duplicate and Delete. Clicking empty space deselects the path. Every change is one undo step on
   * the controller.
   */
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
  let renaming = $state<string | null>(null);
  let color = $state('#000000');
  let width = $state(2);
  let error = $state<string | null>(null);
  const paths = $derived.by(() => {
    void tick;
    return controller.getPaths();
  });
  const activeId = $derived.by(() => {
    void tick;
    return controller.getState().activePathId ?? null;
  });
  const active = $derived(paths.find((p) => p.id === activeId) ?? null);
  const hasSelection = $derived.by(() => {
    void tick;
    return Boolean(controller.getSelection());
  });
  const size = $derived.by(() => {
    void tick;
    return controller.getState().imageDimensions;
  });

  function attempt(fn: () => unknown) {
    error = null;
    try {
      fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const btn = (on = false) =>
    `px-2 py-1 rounded-md border text-[11px] transition-colors disabled:opacity-40 ${
      on ? 'bg-primary border-primary text-primary-foreground' : 'bg-background border-border text-foreground hover:bg-accent hover:text-accent-foreground'
    }`;
</script>

<!-- Clicking the panel's empty space deselects the path (the path tools then edit the active layer). -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div data-testid="paths-panel" class="flex flex-col gap-2 text-xs {className}" onclick={(e) => e.target === e.currentTarget && attempt(() => controller.setActivePath(null))}>
  <span class={imageSectionTitleClass}>Paths</span>
  {#if paths.length === 0}
    <p class="text-muted-foreground">No paths. Make a work path from a selection.</p>
  {/if}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <ul role="list" class="flex flex-col gap-0.5 min-h-4" onclick={(e) => e.target === e.currentTarget && attempt(() => controller.setActivePath(null))}>
    {#each paths as p (p.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <li
        data-testid="path-row"
        aria-current={p.id === activeId ? 'true' : undefined}
        class="flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer select-none {p.id === activeId ? 'bg-primary/30 ring-1 ring-primary' : 'hover:bg-muted'}"
        onclick={() => attempt(() => controller.setActivePath(p.id))}
        ondblclick={() => (renaming = p.id)}
      >
        <svg aria-hidden="true" viewBox="0 0 {size.width || 1} {size.height || 1}" style:width="{thumbnailSize}px" style:height="{thumbnailSize}px" class="shrink-0 rounded ring-1 ring-border bg-background">
          <path d={pathSvgData(p)} fill="currentColor" fill-opacity="0.25" stroke="currentColor" stroke-width={Math.max(size.width, size.height) / 64} fill-rule={p.fillRule ?? 'nonzero'} />
        </svg>
        {#if renaming === p.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            aria-label="Path name"
            value={p.work ? '' : p.name}
            placeholder="Path name"
            class="min-w-0 flex-1 bg-background border border-border rounded px-1 py-0.5 text-foreground"
            onclick={(e) => e.stopPropagation()}
            onblur={(e) => {
              renaming = null;
              const name = (e.currentTarget as HTMLInputElement).value.trim();
              if (name && name !== p.name) attempt(() => controller.renamePath(p.id, name));
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
              if (e.key === 'Escape') renaming = null;
            }}
          />
        {:else}
          <span class="min-w-0 flex-1 truncate {p.work ? 'italic' : ''}">{p.name}</span>
        {/if}
      </li>
    {/each}
  </ul>
  <div class="flex flex-wrap gap-1">
    <button
      type="button"
      class={btn()}
      disabled={!active}
      title="Load the path as the selection (Shift adds, Alt subtracts)"
      onclick={(e) => attempt(() => controller.loadPathAsSelection(active!.id, { mode: selectionModeFromModifiers(e, 'replace') }))}
    >
      Load as Selection
    </button>
    <button type="button" class={btn()} disabled={!hasSelection} onclick={() => attempt(() => controller.makeWorkPath())}>Make Work Path</button>
    {#if active?.work}
      <button type="button" class={btn()} onclick={() => (renaming = active.id)}>Save Path</button>
    {/if}
    <button type="button" class={btn()} disabled={!active} onclick={() => attempt(() => controller.addVectorMaskFromPath(active!.id))}>Add Vector Mask</button>
  </div>
  <div class="flex flex-wrap items-center gap-1">
    <input type="color" aria-label="Path paint colour" bind:value={color} class="h-6 w-8 bg-background border border-border rounded" />
    <button type="button" class={btn()} disabled={!active} onclick={() => attempt(() => controller.fillPath(active!.id, { color }))}>Fill Path</button>
    <label class="flex items-center gap-1 text-muted-foreground">
      <input
        type="number"
        min="0.5"
        max="250"
        step="0.5"
        aria-label="Stroke width"
        value={width}
        oninput={(e) => (width = Math.min(250, Math.max(0.5, Number((e.currentTarget as HTMLInputElement).value) || 1)))}
        class="w-12 bg-background border border-border rounded px-1 py-0.5 text-foreground"
      />
      px
    </label>
    <button type="button" class={btn()} disabled={!active} onclick={() => attempt(() => controller.strokePath(active!.id, { width, color }))}>Stroke Path</button>
  </div>
  <div class="flex flex-wrap gap-1">
    <button type="button" class={btn()} disabled={!active} onclick={() => attempt(() => controller.duplicatePath(active!.id))}>Duplicate</button>
    <button type="button" class={btn()} disabled={!active} onclick={() => attempt(() => controller.deletePath(active!.id))}>Delete</button>
  </div>
  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}
</div>
