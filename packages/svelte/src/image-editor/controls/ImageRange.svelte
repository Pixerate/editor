<script lang="ts">
  import { getImageEditorControls, type ImageRangeProps } from './controls.js';

  let { value, min, max, step, label, disabled = false, oninput, onstart, onend, class: className = '' }: ImageRangeProps = $props();
  const Host = getImageEditorControls().Range;
</script>

{#if Host}
  <Host {value} {min} {max} {step} {label} {disabled} {oninput} {onstart} {onend} class={className} />
{:else}
  <input
    type="range"
    aria-label={label}
    {min}
    {max}
    {step}
    {value}
    {disabled}
    onpointerdown={() => onstart?.()}
    onpointerup={() => onend?.()}
    onkeydown={() => onstart?.()}
    onkeyup={() => onend?.()}
    oninput={(e) => oninput(Number((e.currentTarget as HTMLInputElement).value))}
    class="w-full accent-primary disabled:opacity-40 {className}"
  />
{/if}
