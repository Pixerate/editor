<script lang="ts">
  import { getImageEditorControls, type ImageCheckboxProps } from './controls.js';

  let { checked, label, disabled = false, onchange, class: className = '' }: ImageCheckboxProps = $props();
  const Host = getImageEditorControls().Checkbox;
</script>

{#if Host}
  <Host {checked} {label} {disabled} {onchange} class={className} />
{:else}
  <input
    type="checkbox"
    aria-label={label}
    {checked}
    {disabled}
    onchange={(e) => onchange((e.currentTarget as HTMLInputElement).checked)}
    class="accent-primary {className}"
  />
{/if}
