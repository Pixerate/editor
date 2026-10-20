<script lang="ts">
  import { vectorPerspectivePlanes, vectorPerspectivePreset, type VectorEditorController, type VectorPerspectivePlane } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Perspective drawing: add a 1-, 2- or 3-point grid, pick the plane new shapes are drawn on, lay
   * the selection onto it, show or hide the grid, or remove it. Grid changes and attaching are one
   * undo step each.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const grid = $derived(view.document.perspective ?? null);
  const planes = $derived(grid ? vectorPerspectivePlanes(grid) : []);
  let attachTo = $state<VectorPerspectivePlane | ''>('');
  const target = $derived((view.perspectivePlane ?? attachTo) || planes[0]);
  const PLANE_LABELS: Record<VectorPerspectivePlane, string> = { floor: 'Floor', left: 'Left wall', right: 'Right wall', side: 'Side wall', front: 'Front' };
  const add = (n: 1 | 2 | 3) => controller.setPerspective(vectorPerspectivePreset(n, view.document.width, view.document.height));

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
</script>

<div class="space-y-2 {className}" data-vector-perspective-panel="" aria-label="Perspective">
  <div class="flex flex-wrap items-center gap-1">
    <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Perspective</span>
    {#each [1, 2, 3] as const as n (n)}
      <button type="button" class={buttonClass} aria-pressed={grid?.vanishingPoints.length === n} data-vector-perspective-preset={n} title={`A ${n}-point perspective grid for the page`} onclick={() => add(n)}>{n}-pt</button>
    {/each}
  </div>
  {#if grid}
    <div class="flex flex-wrap items-center gap-1">
      <span class="w-16"></span>
      <select aria-label="Draw on plane" title="New rectangles, ellipses, polygons and stars are drawn on this plane" class={selectClass} value={view.perspectivePlane ?? ''} onchange={(e) => controller.setPerspectivePlane((e.currentTarget.value || null) as VectorPerspectivePlane | null)}>
        <option value="">Draw flat</option>
        {#each planes as p (p)}<option value={p}>Draw on {PLANE_LABELS[p].toLowerCase()}</option>{/each}
      </select>
    </div>
    <div class="flex flex-wrap items-center gap-1">
      <span class="w-16"></span>
      {#if !view.perspectivePlane}
        <select aria-label="Attach to plane" class="h-7 w-24 rounded border border-border bg-background px-1 text-xs" value={attachTo || planes[0]} onchange={(e) => (attachTo = e.currentTarget.value as VectorPerspectivePlane)}>
          {#each planes as p (p)}<option value={p}>{PLANE_LABELS[p]}</option>{/each}
        </select>
      {/if}
      <button type="button" class={buttonClass} disabled={!view.selection.length} title="Lay the selection onto the plane (read flat from the grid's origin)" onclick={() => controller.attachToPerspective(target)}>Attach</button>
      <label class="flex items-center gap-1 text-xs text-foreground" title="Show the grid on the canvas">
        <input type="checkbox" aria-label="Show perspective grid" checked={grid.visible !== false} onchange={(e) => grid && controller.setPerspective({ ...grid, visible: e.currentTarget.checked })} />
        Show
      </label>
      <button type="button" class={buttonClass} title="Remove the grid (art on it stays)" onclick={() => controller.setPerspective(null)}>Remove</button>
    </div>
  {/if}
</div>
