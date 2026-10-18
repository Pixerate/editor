<script lang="ts">
  import { MOTION_EASE_CHOICES, motionEaseKey, motionEasingCurve, motionEasingGuides, motionEasingPath, type MotionCommandBase } from '@pixerate/editor/animation-editor';

  /** An easing (a preset name or a curve), as commands take it. */
  type AnimationEasing = NonNullable<MotionCommandBase['ease']>;

  interface Props {
    /** The easing (undefined: the command type's default). */
    value: AnimationEasing | undefined;
    /** Called with the picked preset, or undefined for the default. */
    onchange: (ease: AnimationEasing | undefined) => void;
    disabled?: boolean;
    class?: string;
  }

  let { value, onchange, disabled = false, class: className = '' }: Props = $props();
  const W = 72;
  const H = 44;
  const key = $derived(motionEaseKey(value));
  const curve = $derived(motionEasingCurve(value ?? 'ease-out'));
  const guides = $derived(motionEasingGuides(curve, H));
  const spring = $derived(typeof value === 'string' ? value.startsWith('spring') : value?.type === 'spring');
</script>

<!-- Picks an easing preset (springs included) and previews its curve, sampled with evaluateEasing. -->
<div class="flex items-center gap-2 {className}" data-ease-picker="">
  <select
    class="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5 text-xs"
    aria-label="Ease"
    value={key}
    {disabled}
    onchange={(e) => {
      const v = e.currentTarget.value;
      if (v === 'custom') return;
      onchange(v ? (v as AnimationEasing) : undefined);
    }}
  >
    {#each MOTION_EASE_CHOICES as c (c.value)}
      <option value={c.value}>{c.label}</option>
    {/each}
    {#if key === 'custom'}<option value="custom">Custom</option>{/if}
  </select>
  <svg width={W} height={H} viewBox="0 0 {W} {H}" class="shrink-0 rounded border border-border" data-ease-curve={key || 'default'} aria-hidden="true">
    <line x1={0} x2={W} y1={guides.zero} y2={guides.zero} stroke="currentColor" stroke-opacity={0.2} />
    <line x1={0} x2={W} y1={guides.one} y2={guides.one} stroke="currentColor" stroke-opacity={0.2} stroke-dasharray="2 2" />
    <path d={motionEasingPath(curve, W, H)} fill="none" stroke="#f43f5e" stroke-width={1.5} />
  </svg>
  {#if spring}<span class="text-[10px] tabular-nums text-muted-foreground">{Math.round(curve.durationMs)} ms</span>{/if}
</div>
