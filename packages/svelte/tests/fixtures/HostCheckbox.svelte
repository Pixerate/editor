<script lang="ts">
  import type { ImageCheckboxProps } from '../../src/image-editor';
  let { checked, label, onchange }: ImageCheckboxProps = $props();
</script>

<button type="button" data-host="checkbox" aria-label={label} aria-pressed={checked} onclick={() => onchange(!checked)}>{label}</button>
