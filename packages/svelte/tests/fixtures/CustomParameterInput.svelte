<script lang="ts">
  let { value, onCommit, ariaLabel }: { value: string; onCommit: (val: string) => void; ariaLabel?: string } = $props();
</script>

<input data-testid="custom-input" aria-label={ariaLabel} {value} onchange={(e) => onCommit((e.target as HTMLInputElement).value)} />
