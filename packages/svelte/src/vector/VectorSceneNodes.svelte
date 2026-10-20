<script lang="ts">
  import type { VectorRenderNode } from '@pixerate/editor/vector';
  import Self from './VectorSceneNodes.svelte';
  import VectorPaintPath from './VectorPaintPath.svelte';
  import VectorMaskedNodes from './VectorMaskedNodes.svelte';
  import VectorTextElement from './VectorTextElement.svelte';

  interface Props {
    nodes: readonly VectorRenderNode[];
  }

  let { nodes }: Props = $props();
  const blend = (mode: string | undefined) => (mode ? `mix-blend-mode: ${mode}` : undefined);
</script>

{#each nodes as node (node.id)}
  {#if node.kind === 'text'}
    <VectorTextElement {node} />
  {:else if node.kind === 'group'}
    <g
      data-vector-id={node.id}
      data-vector-mask={node.mask?.type}
      transform={node.transform}
      opacity={node.opacity < 1 ? node.opacity : undefined}
      filter={node.filter}
      style={blend(node.blendMode)}
    >
      {#if node.mask}
        <VectorMaskedNodes mask={node.mask} nodes={node.children} />
      {:else}
        <Self nodes={node.children} />
      {/if}
    </g>
  {:else if node.layers}
    <!-- Fill and stroke stacks: each layer in order, bottom to top. -->
    <g data-vector-id={node.id} transform={node.transform} opacity={node.opacity < 1 ? node.opacity : undefined} filter={node.filter} style={blend(node.blendMode)}>
      {#each node.layers as layer (`${layer.kind}-${layer.index}`)}
        {#if layer.kind === 'brushstroke'}
          <!-- A brushstroke: its rendered brush images over their boxes. -->
          <g data-vector-layer={`brushstroke-${layer.index}`} opacity={layer.opacity < 1 ? layer.opacity : undefined} style={blend(layer.blendMode)}>
            {#each layer.images ?? [] as im, i (i)}<image href={im.href} x={im.x} y={im.y} width={im.width} height={im.height} preserveAspectRatio="none" />{/each}
          </g>
        {:else}
          <VectorPaintPath paint={layer} d={node.d} fillRule={node.fillRule} layer={`${layer.kind}-${layer.index}`} />
        {/if}
      {/each}
    </g>
  {:else}
    <VectorPaintPath paint={node} d={node.d} fillRule={node.fillRule} id={node.id} transform={node.transform} filter={node.filter} blendMode={node.blendMode} />
  {/if}
{/each}
