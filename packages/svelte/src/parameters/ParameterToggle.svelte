<script lang="ts">
  import { parameterLabel, type BooleanParameterField } from '@pixerate/editor/parameters';

  interface Props {
    field: BooleanParameterField;
    value: boolean;
    onchange: (value: boolean) => void;
    disabled?: boolean;
    id?: string;
  }

  let { field, value, onchange, disabled = false, id }: Props = $props();
</script>

<!-- An on/off switch for `boolean` fields. -->
<button
  type="button"
  role="switch"
  {id}
  aria-checked={value}
  aria-label={parameterLabel(field)}
  disabled={disabled || field.readOnly}
  onclick={() => onchange(!value)}
  class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50 {value
    ? 'bg-primary'
    : 'bg-muted'}"
>
  <span
    class="pointer-events-none block h-4 w-4 rounded-full bg-background shadow transition-transform {value ? 'translate-x-4' : 'translate-x-0.5'}"
  ></span>
</button>
