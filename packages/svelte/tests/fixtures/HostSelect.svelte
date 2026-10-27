<script lang="ts">
  import type { ImageSelectProps } from '../../src/image-editor';
  let { value, options, label, onchange }: ImageSelectProps = $props();
</script>

<button type="button" data-host="select" aria-label={label} data-value={value} onclick={() => onchange(options.at(-1)!.value)}>{label}</button>
