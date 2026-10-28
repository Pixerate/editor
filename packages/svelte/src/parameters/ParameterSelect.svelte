<script lang="ts">
  import { choiceOptionLabel, getChoiceOptions, parameterLabel, type ChoiceParameterField } from '@pixerate/editor/parameters';
  import { parameterInputClass, parameterSelectStyle } from './styles.js';
  import { resolveParameterComponents, type ParameterComponents } from './controls.js';

  interface Props {
    field: ChoiceParameterField;
    value: string | number;
    onchange: (value: string | number) => void;
    disabled?: boolean;
    id?: string;
    components?: ParameterComponents;
  }

  let { field, value, onchange, disabled = false, id, components }: Props = $props();

  const options = $derived(getChoiceOptions(field));
  const off = $derived(disabled || !!field.readOnly);
  const resolved = $derived(resolveParameterComponents(components));
  const CustomSelect = $derived(resolved.select);
  const label = $derived(parameterLabel(field));
  const mappedOptions = $derived(
    options.map((o) => ({
      value: o.value,
      label: choiceOptionLabel(o),
      description: o.description
    }))
  );
</script>

<!-- A dropdown (or segmented buttons with `control: 'segmented'`) for `choice` fields. -->
{#if field.control === 'segmented'}
  <div role="radiogroup" aria-label={label} class="inline-flex flex-wrap rounded-md border border-input bg-muted p-0.5">
    {#each options as o (o.value)}
      <button
        type="button"
        role="radio"
        aria-checked={o.value === value}
        title={o.description}
        disabled={off}
        onclick={() => onchange(o.value)}
        class="rounded px-2 py-0.5 text-xs disabled:opacity-50 {o.value === value
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'}"
      >
        {choiceOptionLabel(o)}
      </button>
    {/each}
  </div>
{:else if CustomSelect}
  <CustomSelect
    {id}
    aria-label={label}
    {label}
    {value}
    options={mappedOptions}
    disabled={off}
    class={parameterInputClass}
    style={parameterSelectStyle}
    onchange={(v: any) => {
      const found = options.find((o) => String(o.value) === String(v));
      if (found) onchange(found.value);
      else onchange(v);
    }}
  />
{:else}
  <select
    {id}
    aria-label={label}
    value={String(options.findIndex((o) => o.value === value))}
    disabled={off}
    class={parameterInputClass}
    style={parameterSelectStyle}
    onchange={(e) => {
      const option = options[Number(e.currentTarget.value)];
      if (option) onchange(option.value);
    }}
  >
    {#each options as o, i (o.value)}
      <option value={String(i)} title={o.description} style={parameterSelectStyle}>{choiceOptionLabel(o)}</option>
    {/each}
  </select>
{/if}
