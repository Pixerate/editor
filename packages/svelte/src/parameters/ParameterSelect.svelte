<script lang="ts">
  import { choiceOptionLabel, getChoiceOptions, parameterLabel, type ChoiceParameterField } from '@pixerate/editor/parameters';
  import { parameterInputClass } from './styles.js';

  interface Props {
    field: ChoiceParameterField;
    value: string | number;
    onchange: (value: string | number) => void;
    disabled?: boolean;
    id?: string;
  }

  let { field, value, onchange, disabled = false, id }: Props = $props();

  const options = $derived(getChoiceOptions(field));
  const off = $derived(disabled || !!field.readOnly);
</script>

<!-- A dropdown (or segmented buttons with `control: 'segmented'`) for `choice` fields. -->
{#if field.control === 'segmented'}
  <div role="radiogroup" aria-label={parameterLabel(field)} class="inline-flex flex-wrap rounded-md border border-input bg-muted p-0.5">
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
{:else}
  <select
    {id}
    aria-label={parameterLabel(field)}
    value={String(options.findIndex((o) => o.value === value))}
    disabled={off}
    class={parameterInputClass}
    onchange={(e) => {
      const option = options[Number(e.currentTarget.value)];
      if (option) onchange(option.value);
    }}
  >
    {#each options as o, i (o.value)}
      <option value={String(i)} title={o.description}>{choiceOptionLabel(o)}</option>
    {/each}
  </select>
{/if}
