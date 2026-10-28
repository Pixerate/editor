<script lang="ts">
  let {
    value,
    options,
    onChange,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (val: string) => void;
  } = $props();
</script>

<select data-testid="custom-select" {value} onchange={(e) => onChange((e.target as HTMLSelectElement).value)}>
  {#each options as opt}
    <option value={opt.value}>{opt.label}</option>
  {/each}
</select>
