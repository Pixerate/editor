<script lang="ts">
  import type { VectorRenderPaintLayer, VectorRenderPath } from '@pixerate/editor/vector';

  /**
   * One paint of a path: a node's fill and stroke, or one layer of its stacks. A stroke aligned
   * inside / outside (double width, clipped or masked by the shape) or with arrowheads draws in
   * parts inside a group.
   */
  interface Props {
    paint: VectorRenderPaintLayer | VectorRenderPath;
    d: string;
    fillRule: 'nonzero' | 'evenodd';
    id?: string;
    transform?: string;
    filter?: string;
    /** A node's blend mode (a layer carries its own). */
    blendMode?: string;
    /** `fill-0`, `stroke-1`, … for a layer of a stack. */
    layer?: string;
  }

  let { paint, d, fillRule, id, transform, filter, blendMode, layer }: Props = $props();
  const opacity = $derived(paint.opacity < 1 ? paint.opacity : undefined);
  const blend = $derived(blendMode ?? (layer ? paint.blendMode : undefined));
  const style = $derived(blend ? `mix-blend-mode: ${blend}` : undefined);
  const sp = $derived(paint.strokeParts);
</script>

{#if sp}
  <g data-vector-id={id} data-vector-layer={layer} data-vector-stroke-align={sp.align} {transform} {opacity} {filter} {style}>
    {#if sp.clip}
      <defs>
        {#if sp.clip.kind === 'clip'}
          <clipPath id={sp.clip.id}><path {d} clip-rule={fillRule} /></clipPath>
        {:else}
          <mask id={sp.clip.id} maskUnits="userSpaceOnUse" x={sp.clip.bounds.x} y={sp.clip.bounds.y} width={sp.clip.bounds.width} height={sp.clip.bounds.height}>
            <rect x={sp.clip.bounds.x} y={sp.clip.bounds.y} width={sp.clip.bounds.width} height={sp.clip.bounds.height} fill="#fff" />
            <path {d} fill="#000" fill-rule={fillRule} />
          </mask>
        {/if}
      </defs>
    {/if}
    <path data-vector-part="fill" {d} fill={paint.fill} fill-rule={fillRule} stroke="none" />
    {#if sp.outline !== undefined}
      <!-- A variable-width stroke: its outline, filled. -->
      <path
        data-vector-part="stroke-outline"
        d={sp.outline}
        fill={paint.stroke}
        clip-path={sp.clip?.kind === 'clip' ? `url(#${sp.clip.id})` : undefined}
        mask={sp.clip?.kind === 'mask' ? `url(#${sp.clip.id})` : undefined}
      />
    {:else}
      <path
        data-vector-part="stroke"
        d={sp.d}
        fill="none"
        stroke={paint.stroke}
        stroke-width={sp.width}
        stroke-linecap={paint.strokeLinecap as any}
        stroke-linejoin={paint.strokeLinejoin as any}
        stroke-dasharray={paint.strokeDasharray}
        clip-path={sp.clip?.kind === 'clip' ? `url(#${sp.clip.id})` : undefined}
        mask={sp.clip?.kind === 'mask' ? `url(#${sp.clip.id})` : undefined}
      />
    {/if}
    {#each sp.heads as head, i (i)}
      <path data-vector-part="head" d={head} fill={paint.stroke} />
    {/each}
  </g>
{:else}
  <path
    data-vector-id={id}
    data-vector-layer={layer}
    {transform}
    {d}
    fill={paint.fill}
    fill-rule={fillRule}
    stroke={paint.stroke}
    stroke-width={paint.stroke === 'none' ? undefined : paint.strokeWidth}
    stroke-linecap={paint.strokeLinecap as any}
    stroke-linejoin={paint.strokeLinejoin as any}
    stroke-dasharray={paint.strokeDasharray}
    {opacity}
    {filter}
    {style}
  />
{/if}
