<script lang="ts">
  import type { ParameterSliderProps } from '../../parameters/controls.js';
  import ImageRange from './ImageRange.svelte';

  let { value, min, max, step, label, disabled = false, class: className = '', oninput, ongesturestart, ongestureend }: ParameterSliderProps = $props();
</script>

<!-- A parameter slider drawn with the host's image-editor `Range`. -->
<ImageRange {value} {min} {max} {step} {label} {disabled} class={className} {oninput} onstart={ongesturestart} onend={ongestureend} />
