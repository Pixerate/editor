<script lang="ts">
  import type { ParameterField, ParameterValue } from '@pixerate/editor/parameters';
  import ParameterColor from './ParameterColor.svelte';
  import ParameterImage from './ParameterImage.svelte';
  import ParameterSelect from './ParameterSelect.svelte';
  import ParameterSlider from './ParameterSlider.svelte';
  import ParameterText from './ParameterText.svelte';
  import ParameterToggle from './ParameterToggle.svelte';
  import ParameterVector from './ParameterVector.svelte';

  interface Props {
    field: ParameterField;
    value: ParameterValue;
    onchange: (value: ParameterValue) => void;
    ongesturestart?: () => void;
    ongestureend?: () => void;
    resolveFile?: (file: File) => string | Promise<string>;
    disabled?: boolean;
    id?: string;
  }

  let { field, value, onchange, ongesturestart, ongestureend, resolveFile, disabled = false, id }: Props = $props();
  const set = $derived(onchange as (value: any) => void);
</script>

<!-- The control for any field type. -->
{#if field.type === 'number' || field.type === 'int'}
  <ParameterSlider {field} value={value as number} onchange={set} {ongesturestart} {ongestureend} {disabled} {id} />
{:else if field.type === 'boolean'}
  <ParameterToggle {field} value={value as boolean} onchange={set} {disabled} {id} />
{:else if field.type === 'choice'}
  <ParameterSelect {field} value={value as string | number} onchange={set} {disabled} {id} />
{:else if field.type === 'color'}
  <ParameterColor {field} value={value as string} onchange={set} {ongesturestart} {ongestureend} {disabled} {id} />
{:else if field.type === 'vector'}
  <ParameterVector {field} value={value as number[]} onchange={set} {disabled} {id} />
{:else if field.type === 'image'}
  <ParameterImage {field} value={value as string} onchange={set} {resolveFile} {disabled} {id} />
{:else if field.type === 'text'}
  <ParameterText {field} value={value as string} onchange={set} {disabled} {id} />
{/if}
