<script lang="ts">
  import type { ImageEditorController, ImageLayer, VectorMaskEdge } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  /**
   * Hybrid mask edges: the soft segments of a layer's vector mask (feather or matte), with their
   * settings, as `set_vector_mask_edge` sets them. Alt+Shift-click a segment with Direct Selection
   * to cycle its mode on the canvas. Every change is one undo step.
   */
  interface Props {
    controller: ImageEditorController;
    /** The layer whose vector mask to edit. */
    layer: ImageLayer;
    class?: string;
  }

  let { controller, layer, class: className = '' }: Props = $props();

  const MODES = ['hard', 'feather', 'matte'] as const;
  const input = 'w-12 bg-background border border-border rounded px-1 py-0.5 text-foreground';
  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  let error = $state<string | null>(null);
  const info = $derived.by(() => {
    void tick;
    return controller.getVectorMask(layer.id);
  });

  function set(e: VectorMaskEdge, mode: VectorMaskEdge['mode'], options: { radius?: number; inner?: number; outer?: number } = {}) {
    error = null;
    try {
      controller.setVectorMaskEdge(layer.id, { component: e.component, subpath: e.subpath, segment: e.segment }, mode, options);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  const value = (ev: Event) => (ev.currentTarget as HTMLInputElement | HTMLSelectElement).value;
</script>

{#if info}
  <div class="flex flex-col gap-1.5 text-xs {className}" data-testid="vector-mask-edges">
    <span class="text-muted-foreground">Vector mask edges</span>
    <p class="text-muted-foreground">Alt+Shift-click a segment with Direct Selection to make it feathered or a hair matte.</p>
    {#if info.edges.length === 0}
      <p class="text-muted-foreground">Every segment is hard.</p>
    {/if}
    <ul class="flex flex-col gap-1">
      {#each info.edges as e (`${e.component}:${e.subpath}:${e.segment}`)}
        <li data-testid="vector-mask-edge" class="flex flex-wrap items-center gap-1.5">
          <span class="font-mono text-muted-foreground">{e.component}/{e.subpath}/{e.segment}</span>
          <select aria-label="Edge mode" value={e.mode} onchange={(ev) => set(e, value(ev) as VectorMaskEdge['mode'])} class="bg-background border border-border rounded px-1 py-0.5 text-foreground">
            {#each MODES as m (m)}
              <option value={m}>{m}</option>
            {/each}
          </select>
          {#if e.mode === 'feather'}
            <label class="flex items-center gap-1 text-muted-foreground">
              radius
              <input type="number" min="0.5" max="250" step="0.5" aria-label="Edge feather radius" value={e.radius} oninput={(ev) => set(e, 'feather', { radius: num(value(ev), 4) })} class={input} />
            </label>
          {/if}
          {#if e.mode === 'matte'}
            <label class="flex items-center gap-1 text-muted-foreground">
              in
              <input type="number" min="0.5" max="200" step="0.5" aria-label="Edge matte inner" value={e.inner} oninput={(ev) => set(e, 'matte', { inner: num(value(ev), 4), outer: e.outer })} class={input} />
            </label>
            <label class="flex items-center gap-1 text-muted-foreground">
              out
              <input type="number" min="0.5" max="200" step="0.5" aria-label="Edge matte outer" value={e.outer} oninput={(ev) => set(e, 'matte', { inner: e.inner, outer: num(value(ev), 8) })} class={input} />
            </label>
          {/if}
        </li>
      {/each}
    </ul>
    {#if error}
      <p role="alert" class="text-destructive">{error}</p>
    {/if}
  </div>
{/if}
