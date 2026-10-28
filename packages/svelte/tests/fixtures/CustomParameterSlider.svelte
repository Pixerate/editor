<script lang="ts">
  import type { ParameterSliderProps } from '../../src/parameters';

  let { value, min, max, step, label, oninput, ongesturestart, ongestureend }: ParameterSliderProps = $props();
</script>

<input
  type="range"
  data-testid="custom-slider"
  aria-label={label}
  {value}
  {min}
  {max}
  {step}
  onpointerdown={() => ongesturestart?.()}
  onpointerup={() => ongestureend?.()}
  oninput={(e) => oninput(Number(e.currentTarget.value))}
/>
