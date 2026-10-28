<script lang="ts">
  import type { ParameterInputProps } from '../../src/parameters';

  let { value, label, oncommit }: ParameterInputProps = $props();
</script>

<input data-testid="custom-input" aria-label={label} {value} onchange={(e) => oncommit(e.currentTarget.value, e.currentTarget)} />
