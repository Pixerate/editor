<script lang="ts">
  import {
    clampParameterNumber,
    formatParameterNumber,
    parameterLabel,
    parameterStep,
    parseParameterNumberInput,
    type NumberParameterField
  } from '@pixerate/editor/parameters';
  import ParameterCommitInput from './ParameterCommitInput.svelte';
  import { parameterInputClass } from './styles.js';

  interface Props {
    field: NumberParameterField;
    value: number;
    onchange: (value: number) => void;
    disabled?: boolean;
    id?: string;
    'aria-label'?: string;
  }

  let { field, value, onchange, disabled = false, id, 'aria-label': ariaLabel }: Props = $props();

  const text = $derived(formatParameterNumber({ ...field, unit: undefined }, value));

  function keydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = parameterStep(field) * (e.shiftKey ? 10 : 1);
    onchange(clampParameterNumber(field, value + (e.key === 'ArrowUp' ? step : -step)));
  }
</script>

<!-- A number box: type a value (units allowed), or step with the arrow keys (Shift ×10). -->
<div class="relative min-w-0 flex-1">
  <ParameterCommitInput
    {id}
    inputmode="decimal"
    aria-label={ariaLabel ?? parameterLabel(field)}
    value={text}
    disabled={disabled || field.readOnly}
    class="{parameterInputClass} {field.unit ? 'pr-6' : ''}"
    onkeydown={keydown}
    oncommit={(t, input) => {
      const n = parseParameterNumberInput(field, t);
      // Show the stored value again when the text was not a number or clamps to it.
      if (n === null || n === value) input.value = text;
      else onchange(n);
    }}
  />
  {#if field.unit}
    <span class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">{field.unit}</span>
  {/if}
</div>
