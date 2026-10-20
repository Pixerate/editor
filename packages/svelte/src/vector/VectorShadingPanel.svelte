<script lang="ts">
  import { isVectorFreeformGradient, isVectorMeshGradient, vectorPaintToHex, type VectorEditorController, type VectorPathNode } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Gradient meshes and freeform gradients of the selected path: make a rows × columns mesh or a
   * freeform gradient, and edit the point picked with the Gradient tool (colour, opacity, and a
   * freeform point's spread, or remove it). Each change is one undo step.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  let rows = $state(2);
  let columns = $state(2);
  const path = $derived(view.selection.map((id) => controller.getNode(id)).find((n): n is VectorPathNode => n?.type === 'path') ?? null);
  const mesh = $derived(path && isVectorMeshGradient(path.fill) ? path.fill : null);
  const free = $derived(path && isVectorFreeformGradient(path.fill) ? path.fill : null);
  const sel = $derived(path && view.shadingPoint?.nodeId === path.id ? view.shadingPoint : null);
  const color = $derived(sel ? (mesh ? mesh.colors[sel.index] : free?.points[sel.index]?.color) : undefined);
  const opacity = $derived(sel ? (mesh ? (mesh.opacities?.[sel.index] ?? 1) : (free?.points[sel.index]?.opacity ?? 1)) : 1);
  const spread = $derived(sel && free ? (free.points[sel.index]?.spread ?? 0) : 0);

  function edit(patch: { color?: string; opacity?: number; spread?: number }, merge?: string) {
    if (!sel || !path) return;
    if (mesh) controller.setMeshPoint(path.id, sel.index, patch, merge ? { merge } : {});
    else controller.setFreeformPoint(path.id, sel.index, patch, merge ? { merge } : {});
  }

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
  const numberClass = 'h-7 w-12 rounded border border-border bg-background px-1.5 text-xs';
  const clamp = (v: string) => Math.max(1, Math.min(32, parseInt(v, 10) || 1));
</script>

{#if path}
  <div class="space-y-2 {className}" data-vector-shading-panel={path.id} aria-label="Mesh and freeform gradient">
    <div class="flex flex-wrap items-center gap-1">
      <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Shading</span>
      <input type="number" min="1" max="32" aria-label="Mesh rows" title="Mesh rows" class={numberClass} value={rows} oninput={(e) => (rows = clamp(e.currentTarget.value))} />
      <span class="text-xs text-muted-foreground">×</span>
      <input type="number" min="1" max="32" aria-label="Mesh columns" title="Mesh columns" class={numberClass} value={columns} oninput={(e) => (columns = clamp(e.currentTarget.value))} />
      <button type="button" class={buttonClass} data-vector-shading-action="mesh" title="Create Gradient Mesh: smooth patches whose points blend colours (edit them with the Gradient tool)" onclick={() => controller.setMeshGradient({ rows, columns }, { ids: [path.id] })}>Mesh</button>
      <button type="button" class={buttonClass} data-vector-shading-action="freeform" title="Freeform Gradient: colour points blended across the shape (click inside with the Gradient tool to add one)" onclick={() => controller.setFreeformGradient({}, { ids: [path.id] })}>Freeform</button>
    </div>
    {#if (mesh || free) && !sel}
      <p class="text-[11px] text-muted-foreground">Gradient tool (G): drag points; {free ? 'click inside to add one, Alt-click to remove.' : 'pick one to colour it.'}</p>
    {/if}
    {#if sel}
      <div class="flex flex-wrap items-center gap-2" data-vector-shading-point={sel.index}>
        <span class="w-16 text-xs text-foreground">Point {sel.index}</span>
        <input type="color" aria-label="Point colour" class="h-7 w-10 cursor-pointer rounded border border-border bg-background" value={vectorPaintToHex(color ?? '#000000') ?? '#000000'} oninput={(e) => edit({ color: e.currentTarget.value }, 'shading-color')} />
        <input type="range" min="0" max="1" step="0.05" aria-label="Point opacity" title="Opacity" class="h-4 w-20 accent-primary" value={opacity} oninput={(e) => edit({ opacity: parseFloat(e.currentTarget.value) }, 'shading-opacity')} />
        {#if free}
          <input type="range" min="0" max="1" step="0.05" aria-label="Point spread" title="Spread: pure colour round the point" class="h-4 w-20 accent-primary" value={spread} oninput={(e) => edit({ spread: parseFloat(e.currentTarget.value) }, 'shading-spread')} />
          <button type="button" class={buttonClass} aria-label="Remove point" onclick={() => controller.removeFreeformPoint(path.id, sel.index)}>Remove</button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
