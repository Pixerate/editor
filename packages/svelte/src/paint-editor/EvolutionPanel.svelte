<script lang="ts">
  import { untrack } from 'svelte';
  import {
    EVOLUTION_SLIDERS,
    exportProposalContactSheetPng,
    liveStrokeRefusal,
    normalizeMutationRates,
    paintProposalGhost,
    proposalGenomeStrokes,
    type EvolutionMutationRates,
    type PaintEditorController,
    type PaintProposals,
    type PaintProposalsState,
  } from '@pixerate/editor/paint-editor';
  import PaintSlider from './PaintSlider.svelte';
  import { attempt, button, chip, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    /** Optional proposals store (defaults to `controller.proposals`). */
    proposals?: PaintProposals;
    class?: string;
  }
  let { controller, proposals, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const store = $derived(proposals ?? controller.proposals);

  let proposalState = $state.raw<PaintProposalsState>({ proposals: [] });
  $effect(() => {
    const s = store;
    return untrack(() => {
      proposalState = s.getState();
      return s.subscribe((next) => {
        proposalState = next;
      });
    });
  });

  let selectedStrokes = $state<string[]>([]);
  let selectedProposals = $state<string[]>([]);
  let count = $state(4);
  let seed = $state(1);
  let mutation = $state<Required<EvolutionMutationRates>>(normalizeMutationRates());
  let contactSheetUrl = $state<string | null>(null);
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));

  const eligibleStrokes = $derived(editor.current.document.strokes.filter((s) => !liveStrokeRefusal(s.brush)));
  const activeStrokeIds = $derived(selectedStrokes.filter((id) => eligibleStrokes.some((s) => s.id === id)));
  const effectiveStrokeIds = $derived(
    activeStrokeIds.length > 0
      ? activeStrokeIds
      : editor.current.selectedStroke && eligibleStrokes.some((s) => s.id === editor.current.selectedStroke)
        ? [editor.current.selectedStroke]
        : eligibleStrokes.length > 0
          ? [eligibleStrokes[eligibleStrokes.length - 1]!.id]
          : []
  );
  const variants = $derived(proposalState.proposals.filter((p) => proposalGenomeStrokes(p).length > 0));
  const activeProposalIds = $derived(selectedProposals.filter((id) => variants.some((v) => v.id === id)));

  function toggleStroke(id: string) {
    selectedStrokes = selectedStrokes.includes(id) ? selectedStrokes.filter((x) => x !== id) : [...selectedStrokes.slice(-15), id];
  }

  function toggleProposal(id: string) {
    selectedProposals = selectedProposals.includes(id) ? selectedProposals.filter((x) => x !== id) : [...selectedProposals.slice(-1), id];
  }

  function drawPixels(node: HTMLCanvasElement, data: Uint8ClampedArray) {
    const draw = (d: Uint8ClampedArray) => {
      const ctx = node.getContext('2d');
      if (ctx && typeof ImageData !== 'undefined') ctx.putImageData(new ImageData(new Uint8ClampedArray(d), node.width, node.height), 0, 0);
    };
    draw(data);
    return { update: draw };
  }
</script>

<!-- Evolutionary strokes: pick recorded dry strokes, adjust mutation rates, and breed a grid of mutated stroke proposals. -->
<div class={`${panel} ${className}`} data-testid="evolution-panel">
  <div class="flex items-center justify-between">
    <span class="font-medium text-slate-300">Evolution ({eligibleStrokes.length})</span>
    <label class="flex items-center gap-1 text-[11px] text-slate-400">
      <span>Count</span>
      <input
        type="number"
        aria-label="Variant count"
        min="2"
        max="12"
        value={count}
        onchange={(e) => {
          count = Math.max(2, Math.min(12, Number(e.currentTarget.value) || 4));
        }}
        class="w-11 rounded bg-slate-800 px-1 py-0.5 text-right font-mono text-slate-200"
      />
    </label>
  </div>

  {#if eligibleStrokes.length > 0}
    <div class="flex max-h-20 flex-wrap gap-1 overflow-y-auto" role="listbox" aria-label="Parent strokes">
      {#each eligibleStrokes as s, i (s.id)}
        {@const on = effectiveStrokeIds.includes(s.id)}
        <button
          type="button"
          role="option"
          aria-selected={on}
          title={`${i + 1}. ${s.brush.name} (${s.id})`}
          class={`h-5 w-5 rounded ring-1 ${on ? 'ring-indigo-400' : 'ring-slate-700'}`}
          style={`background: ${s.color}`}
          onclick={() => toggleStroke(s.id)}
        ></button>
      {/each}
    </div>
  {/if}

  {#each EVOLUTION_SLIDERS as c (c.path)}
    {@const key = c.path as keyof EvolutionMutationRates}
    <PaintSlider control={c} value={mutation[key]} onchange={(v) => (mutation = { ...mutation, [key]: v })} />
  {/each}

  <div class="flex flex-wrap gap-1">
    <button
      type="button"
      class={button}
      disabled={effectiveStrokeIds.length === 0 || editor.current.stroking}
      onclick={() =>
        run(() => {
          controller.breedStrokes({ strokeIds: effectiveStrokeIds, count, mutation, seed });
          seed += 1;
        })}
    >
      Breed strokes
    </button>
    {#if activeProposalIds.length === 2}
      <button
        type="button"
        class={button}
        disabled={editor.current.stroking}
        onclick={() =>
          run(() => {
            controller.breedProposal({ proposalIds: activeProposalIds, count, mutation, seed });
            seed += 1;
          })}
      >
        Cross over (2)
      </button>
    {/if}
    {#if variants.length > 0}
      <button
        type="button"
        class={button}
        onclick={() =>
          run(() => {
            const sheet = exportProposalContactSheetPng(controller, variants);
            contactSheetUrl = `data:image/png;base64,${sheet.base64}`;
          })}
      >
        Contact sheet
      </button>
    {/if}
  </div>

  {#if variants.length > 0}
    <div class="grid grid-cols-2 gap-1.5" data-testid="evolution-grid">
      {#each variants as p (p.id)}
        {@const g = paintProposalGhost(p)}
        {@const picked = activeProposalIds.includes(p.id)}
        <div
          data-testid={`evolution-variant-${p.id}`}
          class={`flex flex-col gap-1 rounded border p-1.5 ${picked ? 'border-indigo-500 bg-slate-800/90' : 'border-slate-800 bg-slate-950/60'}`}
        >
          <div class="flex items-center justify-between gap-1">
            <button type="button" aria-pressed={picked} class={chip(picked)} onclick={() => toggleProposal(p.id)}>{p.title}</button>
          </div>
          {#if g}
            <div class="flex h-16 items-center justify-center overflow-hidden rounded bg-slate-900/80 p-1">
              <canvas use:drawPixels={g.data} width={g.width} height={g.height} role="img" aria-label={p.title} class="max-h-full max-w-full object-contain"></canvas>
            </div>
          {/if}
          {#if p.rationale}
            <span class="line-clamp-2 text-[10px] text-slate-400" title={p.rationale}>{p.rationale}</span>
          {/if}
          <div class="flex flex-wrap gap-1">
            <button
              type="button"
              class={button}
              disabled={editor.current.stroking}
              onclick={() =>
                run(() => {
                  controller.breedProposal({ proposalIds: [p.id], count, mutation, seed });
                  seed += 1;
                })}
            >
              Breed from
            </button>
            <button type="button" class={button} onclick={() => run(() => store.accept(p.id))}>Accept</button>
            <button type="button" class={button} onclick={() => run(() => store.reject(p.id))}>Dismiss</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if contactSheetUrl}
    <img src={contactSheetUrl} alt="Variant contact sheet" class="w-full rounded border border-slate-800" data-testid="evolution-contact-sheet" />
  {/if}

  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
