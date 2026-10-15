<script lang="ts">
  import {
    clampParameterNumber,
    formatParameterNumber,
    isSliderField,
    parameterLabel,
    parameterStep,
    type NumberParameterField
  } from '@pixerate/editor/parameters';
  import ParameterNumberInput from './ParameterNumberInput.svelte';
  import { parameterRangeClass } from './styles.js';

  interface Props {
    field: NumberParameterField;
    value: number;
    onchange: (value: number) => void;
    /** A drag started: merge changes into one undo step until `ongestureend`. */
    ongesturestart?: () => void;
    ongestureend?: () => void;
    disabled?: boolean;
    id?: string;
  }

  let { field, value, onchange, ongesturestart, ongestureend, disabled = false, id }: Props = $props();

  let dragging = false;
  function start() {
    if (dragging) return;
    dragging = true;
    ongesturestart?.();
  }
  function end() {
    if (!dragging) return;
    dragging = false;
    ongestureend?.();
  }
</script>

<!-- A slider plus number box for `number` / `int` fields (number box only for `control: 'input'` or unbounded fields). -->
{#if isSliderField(field)}
  <div class="flex items-center gap-2">
    <input
      type="range"
      aria-label={parameterLabel(field)}
      aria-valuetext={formatParameterNumber(field, value)}
      min={field.min}
      max={field.max}
      step={parameterStep(field)}
      {value}
      disabled={disabled || field.readOnly}
      class={parameterRangeClass}
      onpointerdown={start}
      onpointerup={end}
      onpointercancel={end}
      onblur={end}
      oninput={(e) => onchange(clampParameterNumber(field, Number(e.currentTarget.value)))}
    />
    <div class="w-20 shrink-0">
      <ParameterNumberInput {field} {value} {onchange} {disabled} {id} aria-label="{parameterLabel(field)} value" />
    </div>
  </div>
{:else}
  <ParameterNumberInput {field} {value} {onchange} {disabled} {id} />
{/if}
