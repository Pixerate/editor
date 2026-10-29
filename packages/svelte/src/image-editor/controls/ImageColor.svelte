<script lang="ts">
  import { getImageEditorControls, type ImageColorProps } from './controls.js';
  import { imageColorInputClass } from '../styles.js';

  let { value, label, alpha = false, disabled = false, oninput, onstart, onend, class: className = '' }: ImageColorProps = $props();
  const Host = getImageEditorControls().Color;
</script>

{#if Host}
  <Host {value} {label} {alpha} {disabled} {oninput} {onstart} {onend} class={className} />
{:else}
  <!-- The native well has no alpha: keep the stored alpha on what it picks. -->
  <input
    type="color"
    aria-label={label}
    value={value.slice(0, 7)}
    {disabled}
    oninput={(e) => oninput((e.currentTarget as HTMLInputElement).value + (alpha ? value.slice(7, 9) : ''))}
    class="{imageColorInputClass} {className}"
  />
{/if}
