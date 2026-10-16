<script lang="ts">
  import type { VectorRenderNode } from '@pixerate/editor/vector';
  import Self from './VectorSceneNodes.svelte';

  interface Props {
    nodes: readonly VectorRenderNode[];
  }

  let { nodes }: Props = $props();
</script>

{#each nodes as node (node.id)}
  {#if node.kind === 'group'}
    <g data-vector-id={node.id} transform={node.transform} opacity={node.opacity < 1 ? node.opacity : undefined}>
      <Self nodes={node.children} />
    </g>
  {:else}
    <path
      data-vector-id={node.id}
      transform={node.transform}
      d={node.d}
      fill={node.fill}
      fill-rule={node.fillRule}
      stroke={node.stroke}
      stroke-width={node.stroke === 'none' ? undefined : node.strokeWidth}
      stroke-linecap={node.strokeLinecap as any}
      stroke-linejoin={node.strokeLinejoin as any}
      stroke-dasharray={node.strokeDasharray}
      opacity={node.opacity < 1 ? node.opacity : undefined}
    />
  {/if}
{/each}
