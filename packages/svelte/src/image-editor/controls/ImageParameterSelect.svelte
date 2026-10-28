<script lang="ts">
  import { matchParameterOptionValue } from '@pixerate/editor/parameters';
  import type { ParameterSelectProps } from '../../parameters/controls.js';
  import ImageSelect from './ImageSelect.svelte';

  let { value, options, label, disabled = false, class: className = '', onchange }: ParameterSelectProps = $props();
  const imageOptions = $derived(options.map((o) => ({ value: String(o.value), label: o.label })));
</script>

<!-- A parameter select drawn with the host's image-editor `Select` (string values mapped back to the options' own). -->
<ImageSelect value={String(value)} options={imageOptions} {label} {disabled} class={className} onchange={(v) => onchange(matchParameterOptionValue(options, v))} />
