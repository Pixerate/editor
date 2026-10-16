<script lang="ts">
  import type { SvgGradientDef } from '@pixerate/editor/vector';

  interface Props {
    defs: readonly SvgGradientDef[];
  }

  let { defs }: Props = $props();
</script>

{#if defs.length}
  <defs>
    {#each defs as def (def.id)}
      {#if def.type === 'radial'}
        <radialGradient id={def.id} {...def.attrs}>
          {#each def.stops as s, i (i)}<stop offset={s.offset} stop-color={s.stopColor} stop-opacity={s.stopOpacity} />{/each}
        </radialGradient>
      {:else}
        <linearGradient id={def.id} {...def.attrs}>
          {#each def.stops as s, i (i)}<stop offset={s.offset} stop-color={s.stopColor} stop-opacity={s.stopOpacity} />{/each}
        </linearGradient>
      {/if}
    {/each}
  </defs>
{/if}
