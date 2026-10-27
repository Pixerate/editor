<script lang="ts">
  import { imageSelectClass } from '../styles.js';
  import { getImageEditorControls, type ImageSelectProps } from './controls.js';

  let { value, options, label, placeholder, disabled = false, onchange, class: className = '' }: ImageSelectProps = $props();
  const Host = getImageEditorControls().Select;
</script>

{#if Host}
  <Host {value} {options} {label} {placeholder} {disabled} {onchange} class={className} />
{:else}
  <select
    aria-label={label}
    {value}
    {disabled}
    onchange={(e) => {
      const select = e.currentTarget as HTMLSelectElement;
      onchange(select.value);
      // A placeholder select (an action menu) shows its placeholder again.
      if (placeholder !== undefined) select.value = value;
    }}
    class="{imageSelectClass} {className}"
  >
    {#if placeholder !== undefined}<option value="">{placeholder}</option>{/if}
    {#each options as o (o.value)}
      <option value={o.value}>{o.label}</option>
    {/each}
  </select>
{/if}
