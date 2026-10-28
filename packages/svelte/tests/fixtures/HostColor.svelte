<script lang="ts">
  import type { ImageColorProps } from '../../src/image-editor';
  let { value, label, alpha = false, disabled = false, oninput }: ImageColorProps = $props();
</script>

<button type="button" data-host="color" aria-label={label} data-value={value} data-alpha={alpha} {disabled} onclick={() => oninput('#123456')}>{label}</button>
