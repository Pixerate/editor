<script lang="ts">
  import type { SvgGradientDef, VectorPaintDef } from '@pixerate/editor/vector';

  interface Props {
    /** Paint servers: gradient descriptors and patterns of gradient tiles (conic, diamond, stroke modes). */
    defs: readonly VectorPaintDef[];
  }

  let { defs }: Props = $props();
</script>

{#snippet gradient(def: SvgGradientDef)}
  {#if def.type === 'radial'}
    <radialGradient id={def.id} {...def.attrs}>
      {#each def.stops as s, i (i)}<stop offset={s.offset} stop-color={s.stopColor} stop-opacity={s.stopOpacity} />{/each}
    </radialGradient>
  {:else}
    <linearGradient id={def.id} {...def.attrs}>
      {#each def.stops as s, i (i)}<stop offset={s.offset} stop-color={s.stopColor} stop-opacity={s.stopOpacity} />{/each}
    </linearGradient>
  {/if}
{/snippet}

{#if defs.length}
  <defs>
    {#each defs as def (def.id)}
      {#if def.type === 'pattern'}
        <pattern id={def.id} {...def.attrs}>
          {#each def.gradients as g (g.id)}{@render gradient(g)}{/each}
          {#each def.tiles as t, i (i)}<path d={t.d} fill={t.fill} />{/each}
        </pattern>
      {:else}
        {@render gradient(def)}
      {/if}
    {/each}
  </defs>
{/if}
