<script lang="ts">
  import { VECTOR_SYMMETRY_MODES, VECTOR_SYMMETRY_MODE_LABELS, isVectorSymmetryGroup, type VectorEditorController, type VectorSymmetryMode } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Live symmetry: make a symmetry group from the selection (or an empty one to draw into), and
   * for a selected symmetry group its mode, radial copies and mirroring, drawing inside it, and
   * release (keeping the copies with Expand). Each change is one undo step.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const group = $derived(view.selection.map((id) => controller.getNode(id)).find(isVectorSymmetryGroup) ?? null);
  const s = $derived(group?.symmetry);
  const ids = $derived(group ? [group.id] : undefined);
  const drawing = $derived(!!group && view.symmetryTarget === group.id);

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const numberClass = 'h-7 w-12 rounded border border-border bg-background px-1.5 text-xs';
</script>

<div class="space-y-2 {className}" data-vector-symmetry-panel="" aria-label="Symmetry">
  <div class="flex flex-wrap items-center gap-1">
    <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Symmetry</span>
    {#if !group}
      <button type="button" class={buttonClass} data-vector-symmetry-action="make" title="Make Symmetry: the selection (or nothing yet) mirrored live across a vertical axis" onclick={() => controller.makeSymmetry({ mode: 'vertical' })}>Mirror</button>
      <button type="button" class={buttonClass} data-vector-symmetry-action="radial" title="Make Symmetry: the selection repeated round its centre" onclick={() => controller.makeSymmetry({ mode: 'radial', copies: 6 })}>Radial</button>
    {:else if s}
      <select aria-label="Symmetry mode" class={selectClass} value={s.mode} onchange={(e) => controller.setSymmetry({ mode: e.currentTarget.value as VectorSymmetryMode }, { ids })}>
        {#each VECTOR_SYMMETRY_MODES as m (m)}<option value={m}>{VECTOR_SYMMETRY_MODE_LABELS[m]}</option>{/each}
      </select>
      {#if s.mode === 'radial'}
        <input type="number" min="2" max="64" aria-label="Symmetry copies" title="Copies round the circle" class={numberClass} value={s.copies ?? 6} oninput={(e) => controller.setSymmetry({ copies: Math.max(2, Math.min(64, parseInt(e.currentTarget.value, 10) || 2)) }, { ids })} />
        <label class="flex items-center gap-1 text-xs text-foreground" title="Mirror each copy too (kaleidoscope)">
          <input type="checkbox" aria-label="Mirror copies" checked={!!s.mirror} onchange={(e) => controller.setSymmetry({ mirror: e.currentTarget.checked }, { ids })} />
          Mirror
        </label>
      {/if}
    {/if}
  </div>
  {#if group}
    <div class="flex flex-wrap items-center gap-1">
      <span class="w-16"></span>
      <button type="button" class={buttonClass} aria-pressed={drawing} data-vector-symmetry-action="draw" title="Draw inside: new pen, pencil, shape and text art goes into the group, mirrored as you draw (Escape stops)" onclick={() => (drawing ? controller.exitSymmetry() : controller.enterSymmetry(group.id))}>Draw inside</button>
      <button type="button" class={buttonClass} title="Expand: keep the copies as real objects" onclick={() => controller.releaseSymmetry({ ids, expand: true })}>Expand</button>
      <button type="button" class={buttonClass} title="Release: stop repeating (the copies go)" onclick={() => controller.releaseSymmetry({ ids })}>Release</button>
    </div>
  {/if}
</div>
