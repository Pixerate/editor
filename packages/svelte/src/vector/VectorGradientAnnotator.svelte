<script lang="ts">
  import { VECTOR_OVERLAY_THEME as THEME, vectorDiamondPath, type VectorRenderGradientAnnotator } from '@pixerate/editor/vector';

  interface Props {
    /** The gradient tool's annotator (screen space) from `getVectorOverlayRenderData`. */
    annotator: VectorRenderGradientAnnotator;
    accentColor?: string;
  }

  let { annotator: g, accentColor = THEME.accent }: Props = $props();
  const r = THEME.handleRadius + 1.5;
</script>

<g data-vector-gradient-annotator={g.type}>
  {#if g.extent}<path data-vector-gradient-extent="" d={g.extent} fill="none" stroke={accentColor} stroke-dasharray="4 3" />{/if}
  <line x1={g.start.x} y1={g.start.y} x2={g.end.x} y2={g.end.y} stroke="#ffffff" stroke-width="3" />
  <line data-vector-gradient-bar="" x1={g.start.x} y1={g.start.y} x2={g.end.x} y2={g.end.y} stroke={accentColor} />
  {#if g.aspect}<line x1={g.start.x} y1={g.start.y} x2={g.aspect.x} y2={g.aspect.y} stroke={accentColor} stroke-dasharray="2 2" />{/if}
  <circle data-vector-gradient-handle="start" cx={g.start.x} cy={g.start.y} r={r + (g.start.hovered ? 1 : 0)} fill={THEME.handleFill} stroke={accentColor} stroke-width={g.start.hovered ? 2 : 1} />
  <rect data-vector-gradient-handle={g.end.handle} x={g.end.x - r} y={g.end.y - r} width={2 * r} height={2 * r} fill={THEME.handleFill} stroke={accentColor} stroke-width={g.end.hovered ? 2 : 1} />
  {#if g.aspect}
    <circle data-vector-gradient-handle="aspect" cx={g.aspect.x} cy={g.aspect.y} r={THEME.handleRadius + (g.aspect.hovered ? 1 : 0)} fill={THEME.handleFill} stroke={accentColor} stroke-width={g.aspect.hovered ? 2 : 1} />
  {/if}
  {#if g.focal}
    <g data-vector-gradient-handle="focal">
      <circle cx={g.focal.x} cy={g.focal.y} r={THEME.handleRadius - 1 + (g.focal.hovered ? 1 : 0)} fill={accentColor} stroke={THEME.handleFill} />
    </g>
  {/if}
  {#each g.midpoints as m (m.index)}
    <path data-vector-gradient-midpoint={m.index} d={vectorDiamondPath(m.x, m.y, 4 + (m.hovered ? 1 : 0))} fill={THEME.handleFill} stroke={accentColor} />
  {/each}
  {#each g.stops as s (s.index)}
    <g data-vector-gradient-stop={s.index} data-selected={s.selected || undefined} opacity={g.removing && s.selected ? 0.35 : 1}>
      <line x1={s.barX} y1={s.barY} x2={s.x} y2={s.y} stroke={accentColor} />
      <rect x={s.x - 5} y={s.y - 5} width="10" height="10" rx="2" fill={s.color} fill-opacity={s.opacity} stroke={s.selected ? accentColor : '#ffffff'} stroke-width={s.selected || s.hovered ? 2 : 1} />
      <rect x={s.x - 6.5} y={s.y - 6.5} width="13" height="13" rx="3" fill="none" stroke={s.selected ? '#ffffff' : accentColor} />
    </g>
  {/each}
</g>
