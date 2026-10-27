<script lang="ts">
  import type { ImageRangeProps } from '../../src/image-editor';
  let { value, max, label, oninput }: ImageRangeProps = $props();
</script>

<button type="button" data-host="range" aria-label={label} data-value={value} onclick={() => oninput(max)}>{label}</button>
