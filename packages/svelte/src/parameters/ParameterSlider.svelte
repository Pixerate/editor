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
  import { parameterRangeClass, parameterRangeStyle } from './styles.js';
  import { getParameterComponents, resolveParameterComponents, type ParameterComponents } from './controls.js';

  interface Props {
    field: NumberParameterField;
    value: number;
    onchange: (value: number) => void;
    /** A drag started: merge changes into one undo step until `ongestureend`. */
    ongesturestart?: () => void;
    ongestureend?: () => void;
    disabled?: boolean;
    id?: string;
    components?: ParameterComponents;
  }

  let { field, value, onchange, ongesturestart, ongestureend, disabled = false, id, components }: Props = $props();

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

  const context = getParameterComponents();
  const CustomSlider = $derived(resolveParameterComponents(components, context).slider);
  const step = $derived(parameterStep(field));
  const label = $derived(parameterLabel(field));
  const valuetext = $derived(formatParameterNumber(field, value));
</script>

<!-- A slider plus number box for `number` / `int` fields (number box only for `control: 'input'` or unbounded fields). -->
{#if isSliderField(field)}
  <div class="flex items-center gap-2">
    {#if CustomSlider}
      <CustomSlider
        id={id ? `${id}-slider` : undefined}
        aria-label={label}
        {label}
        aria-valuetext={valuetext}
        min={field.min ?? 0}
        max={field.max ?? 100}
        {step}
        {value}
        disabled={disabled || field.readOnly}
        class={parameterRangeClass}
        style={parameterRangeStyle}
        ongesturestart={start}
        ongestureend={end}
        oninput={(v) => onchange(clampParameterNumber(field, v))}
      />
    {:else}
      <input
        type="range"
        aria-label={label}
        aria-valuetext={valuetext}
        min={field.min ?? 0}
        max={field.max ?? 100}
        {step}
        {value}
        disabled={disabled || field.readOnly}
        class={parameterRangeClass}
        style={parameterRangeStyle}
        onpointerdown={start}
        onpointerup={end}
        onpointercancel={end}
        onblur={end}
        oninput={(e) => onchange(clampParameterNumber(field, Number(e.currentTarget.value)))}
      />
    {/if}
    <div class="w-20 shrink-0">
      <ParameterNumberInput {field} {value} {onchange} {disabled} {id} aria-label="{label} value" {components} />
    </div>
  </div>
{:else}
  <ParameterNumberInput {field} {value} {onchange} {disabled} {id} {components} />
{/if}
