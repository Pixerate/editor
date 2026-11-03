<script lang="ts">
  import { paintProposalGhost, type PaintProposals, type PaintProposalsState } from '@pixerate/editor/paint-editor';

  interface Props {
    proposals: PaintProposals;
    /** The view's CSS transform (`viewCssTransform`). */
    transform: string;
    zoom: number;
  }
  let { proposals, transform, zoom }: Props = $props();

  let pending = $state.raw<PaintProposalsState>({ proposals: [] });
  $effect(() => {
    pending = proposals.getState();
    return proposals.subscribe((next) => {
      pending = next;
    });
  });

  /** Draws a ghost's pixels into its canvas. */
  function ghost(node: HTMLCanvasElement, data: Uint8ClampedArray) {
    const draw = (d: Uint8ClampedArray) => {
      const ctx = node.getContext('2d');
      if (ctx && typeof ImageData !== 'undefined') ctx.putImageData(new ImageData(new Uint8ClampedArray(d), node.width, node.height), 0, 0);
    };
    draw(data);
    return { update: draw };
  }
</script>

<!-- Pending paint proposals drawn over the canvas: each ghost where its paint would go, translucent with a dashed edge. -->
{#each pending.proposals as p (p.id)}
  {@const g = paintProposalGhost(p)}
  {#if g}
    <canvas
      use:ghost={g.data}
      width={g.width}
      height={g.height}
      data-paint-proposal={p.id}
      title={p.rationale ? `${p.title}: ${p.rationale}` : p.title}
      aria-label={`Suggested: ${p.title}`}
      class="absolute left-0 top-0 pointer-events-none"
      style={`transform: ${transform} translate(${g.x}px, ${g.y}px); transform-origin: 0 0; opacity: 0.7; outline: ${1.5 / zoom}px dashed #a78bfa; outline-offset: ${2 / zoom}px`}
    ></canvas>
  {/if}
{/each}
