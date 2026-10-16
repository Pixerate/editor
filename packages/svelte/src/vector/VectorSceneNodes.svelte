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
  {:else if node.strokeParts}
    {@const sp = node.strokeParts}
    <!-- An aligned stroke (double width, clipped or masked by the shape) or one with arrowheads. -->
    <g data-vector-id={node.id} data-vector-stroke-align={sp.align} transform={node.transform} opacity={node.opacity < 1 ? node.opacity : undefined}>
      {#if sp.clip}
        <defs>
          {#if sp.clip.kind === 'clip'}
            <clipPath id={sp.clip.id}><path d={node.d} clip-rule={node.fillRule} /></clipPath>
          {:else}
            <mask id={sp.clip.id} maskUnits="userSpaceOnUse" x={sp.clip.bounds.x} y={sp.clip.bounds.y} width={sp.clip.bounds.width} height={sp.clip.bounds.height}>
              <rect x={sp.clip.bounds.x} y={sp.clip.bounds.y} width={sp.clip.bounds.width} height={sp.clip.bounds.height} fill="#fff" />
              <path d={node.d} fill="#000" fill-rule={node.fillRule} />
            </mask>
          {/if}
        </defs>
      {/if}
      <path data-vector-part="fill" d={node.d} fill={node.fill} fill-rule={node.fillRule} stroke="none" />
      <path
        data-vector-part="stroke"
        d={sp.d}
        fill="none"
        stroke={node.stroke}
        stroke-width={sp.width}
        stroke-linecap={node.strokeLinecap as any}
        stroke-linejoin={node.strokeLinejoin as any}
        stroke-dasharray={node.strokeDasharray}
        clip-path={sp.clip?.kind === 'clip' ? `url(#${sp.clip.id})` : undefined}
        mask={sp.clip?.kind === 'mask' ? `url(#${sp.clip.id})` : undefined}
      />
      {#each sp.heads as head, i (i)}
        <path data-vector-part="head" d={head} fill={node.stroke} />
      {/each}
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
