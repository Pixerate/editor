<script lang="ts">
  import type { ParameterColorProps } from '../../src/parameters';

  let { value, label, alpha = false, swatches, onchange }: ParameterColorProps = $props();
</script>

<button type="button" data-testid="custom-color" aria-label={label} data-value={value} data-alpha={alpha} data-swatches={swatches?.join(',')} onclick={() => onchange('#abcdef')}>{label}</button>
