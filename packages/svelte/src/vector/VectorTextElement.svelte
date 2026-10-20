<script lang="ts">
  import type { VectorRenderText } from '@pixerate/editor/vector';

  interface Props {
    node: VectorRenderText;
  }

  /**
   * Text drawn as SVG text: one `<text>` per paint layer, every span a `<tspan>` placed character by
   * character (the layout is the editor's, not the browser's).
   */
  let { node }: Props = $props();
  const blend = (mode: string | undefined) => (mode ? `mix-blend-mode: ${mode}` : undefined);
</script>

<g data-vector-id={node.id} data-vector-text="" transform={node.transform} opacity={node.opacity < 1 ? node.opacity : undefined} filter={node.filter} style={blend(node.blendMode)}>
  {#each node.layers as layer, i (i)}
    <text
      data-vector-layer={layer.kind}
      xml:space="preserve"
      fill={layer.fill}
      stroke={layer.stroke}
      stroke-width={layer.stroke === 'none' ? undefined : layer.strokeWidth}
      stroke-linejoin={layer.strokeLinejoin as "miter" | "round" | "bevel" | undefined}
      stroke-dasharray={layer.strokeDasharray}
      opacity={layer.opacity < 1 ? layer.opacity : undefined}
      style="white-space:pre;{blend(layer.blendMode) ?? ''}"
      >{#each node.spans as sp, k (k)}<tspan
          x={sp.x}
          y={sp.y}
          rotate={sp.rotate}
          font-family={sp.fontFamily}
          font-size={sp.fontSize}
          font-weight={sp.fontWeight}
          font-style={sp.fontStyle}
          text-decoration={sp.textDecoration}
          fill={layer.runFills && sp.fill ? sp.fill : undefined}>{sp.text}</tspan
        >{/each}</text
    >
  {/each}
</g>
