<script lang="ts">
  import type { ControlSpec } from '@pixerate/editor/image-editor';
  import { controlTrackBackground, formatControlValue } from '@pixerate/editor/image-editor';

  interface Props {
    spec: ControlSpec;
    value: number;
    onchange: (value: number) => void;
    disabled?: boolean;
    /** Overrides `spec.label` (also the accessible name). */
    label?: string;
    /** Extra classes on the root element. */
    class?: string;
  }

  let { spec, value, onchange, disabled = false, label, class: className = '' }: Props = $props();

  const name = $derived(label ?? spec.label);
  const track = $derived(controlTrackBackground(spec));
</script>

<div data-control-id={spec.id} class={className || undefined}>
  <div class="flex justify-between text-muted-foreground mb-1">
    <span>{name}</span>
    <span class="font-mono">{formatControlValue(spec, value)}</span>
  </div>
  <input
    type="range"
    min={spec.min}
    max={spec.max}
    step={spec.step}
    aria-label={name}
    {disabled}
    {value}
    oninput={(e) => onchange(Number((e.target as HTMLInputElement).value))}
    class="w-full accent-primary disabled:opacity-40"
  />
  {#if track}
    <div class="h-0.5 rounded-full opacity-70" style="background: {track}"></div>
  {/if}
</div>
