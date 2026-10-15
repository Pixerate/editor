<script lang="ts">
  import { parameterLabel, vectorComponentField, vectorSize, type VectorParameterField } from '@pixerate/editor/parameters';
  import ParameterNumberInput from './ParameterNumberInput.svelte';

  interface Props {
    field: VectorParameterField;
    value: number[];
    onchange: (value: number[]) => void;
    disabled?: boolean;
    id?: string;
  }

  let { field, value, onchange, disabled = false, id }: Props = $props();

  const size = $derived(vectorSize(field));
  const components = $derived(Array.from({ length: size }, (_, i) => vectorComponentField(field, i)));
</script>

<!-- One number box per component for `vector` fields. -->
<div class="grid gap-1.5" style:grid-template-columns="repeat({size}, minmax(0, 1fr))">
  {#each components as component, i (i)}
    <label class="flex min-w-0 items-center gap-1">
      <span class="w-3 shrink-0 text-[10px] uppercase text-muted-foreground">{component.label}</span>
      <ParameterNumberInput
        field={component}
        value={value[i] ?? 0}
        id={i === 0 ? id : undefined}
        aria-label="{parameterLabel(field)} {component.label}"
        disabled={disabled || field.readOnly}
        onchange={(n) => onchange(Array.from({ length: size }, (_, j) => (j === i ? n : (value[j] ?? 0))))}
      />
    </label>
  {/each}
</div>
