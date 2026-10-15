<script lang="ts">
  import { parameterLabel, type TextParameterField } from '@pixerate/editor/parameters';
  import ParameterCommitInput from './ParameterCommitInput.svelte';

  interface Props {
    field: TextParameterField;
    value: string;
    onchange: (value: string) => void;
    disabled?: boolean;
    id?: string;
  }

  let { field, value, onchange, disabled = false, id }: Props = $props();
</script>

<!-- A text box (or textarea with `multiline`) that commits on blur or Enter. -->
<ParameterCommitInput
  {id}
  aria-label={parameterLabel(field)}
  multiline={field.multiline}
  placeholder={field.placeholder}
  maxlength={field.maxLength}
  {value}
  disabled={disabled || field.readOnly}
  oncommit={onchange}
/>
