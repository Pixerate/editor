<script lang="ts">
  import type { VectorFilterPrimitive, VectorRenderFilter } from '@pixerate/editor/vector';

  interface Props {
    /** Node filters (shadows, glows, blurs, feather) from `getVectorSceneRenderData(...).filters`. */
    filters: readonly VectorRenderFilter[];
  }

  let { filters }: Props = $props();
</script>

{#snippet primitive(p: VectorFilterPrimitive)}
  <svelte:element this={p.tag} {...p.attrs}>
    {#each p.children ?? [] as child, i (i)}{@render primitive(child)}{/each}
  </svelte:element>
{/snippet}

{#if filters.length}
  <defs>
    {#each filters as f (f.id)}
      <filter id={f.id} filterUnits="userSpaceOnUse" x={f.x} y={f.y} width={f.width} height={f.height} color-interpolation-filters="sRGB">
        {#each f.primitives as p, i (i)}{@render primitive(p)}{/each}
      </filter>
    {/each}
  </defs>
{/if}
