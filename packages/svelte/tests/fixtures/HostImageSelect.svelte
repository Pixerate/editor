<script lang="ts">
  import type { ImageSelectProps } from '../../src/image-editor/controls/controls';

  let { value, options, label, onchange }: ImageSelectProps = $props();
</script>

<select data-testid="host-select" aria-label={label} {value} onchange={(e) => onchange(e.currentTarget.value)}>
  {#each options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
</select>
