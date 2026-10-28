<script lang="ts">
  let {
    value,
    min,
    max,
    step,
    onChange,
  }: {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (val: number) => void;
  } = $props();
</script>

<input
  type="range"
  data-testid="custom-slider"
  {value}
  {min}
  {max}
  {step}
  oninput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
/>
