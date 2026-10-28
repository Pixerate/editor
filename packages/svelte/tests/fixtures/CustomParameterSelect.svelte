<script lang="ts">
  import type { ParameterSelectProps } from '../../src/parameters';

  let { value, options, label, onchange }: ParameterSelectProps = $props();
</script>

<!-- A string-only select, like most host dropdowns. -->
<select data-testid="custom-select" aria-label={label} value={String(value)} onchange={(e) => onchange(e.currentTarget.value)}>
  {#each options as opt (opt.value)}
    <option value={String(opt.value)}>{opt.label}</option>
  {/each}
</select>
