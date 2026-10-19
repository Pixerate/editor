<script lang="ts">
  import type { VectorRenderMask, VectorRenderNode } from '@pixerate/editor/vector';
  import VectorSceneNodes from './VectorSceneNodes.svelte';

  /**
   * A mask group's contents under its mask: the `<clipPath>` (clip) or `<mask>` (alpha, luminance;
   * the mask drawn inside, through the inverting filter when inverted), and an inner `<g>` that
   * references it. The group's own transform, opacity, blend mode and filter are on the outer `<g>`.
   */
  interface Props {
    mask: VectorRenderMask;
    nodes: readonly VectorRenderNode[];
  }

  let { mask, nodes }: Props = $props();
</script>

<defs>
  {#if mask.clip}
    <clipPath id={mask.id}>
      {#each mask.clip as c, i (i)}
        <path d={c.d} clip-rule={c.clipRule} />
      {/each}
    </clipPath>
  {:else if mask.bounds}
    <mask
      id={mask.id}
      maskUnits="userSpaceOnUse"
      x={mask.bounds.x}
      y={mask.bounds.y}
      width={mask.bounds.width}
      height={mask.bounds.height}
      style={mask.type === 'alpha' ? 'mask-type: alpha' : undefined}
    >
      {#if mask.filter}
        <g filter={mask.filter}><VectorSceneNodes nodes={mask.nodes ?? []} /></g>
      {:else}
        <VectorSceneNodes nodes={mask.nodes ?? []} />
      {/if}
    </mask>
  {/if}
</defs>
<g data-vector-masked="" clip-path={mask.clip ? `url(#${mask.id})` : undefined} mask={mask.clip ? undefined : `url(#${mask.id})`}>
  <VectorSceneNodes {nodes} />
</g>
