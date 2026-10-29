<script lang="ts">
  import type { ParameterColorProps } from '../../parameters/controls.js';
  import ImageColor from './ImageColor.svelte';

  let { value, label, alpha = false, disabled = false, class: className = '', onchange, ongesturestart, ongestureend }: ParameterColorProps = $props();
</script>

<!-- A parameter colour drawn with the host's image-editor `Color`. -->
<ImageColor {value} {label} {alpha} {disabled} class={className} oninput={onchange} onstart={ongesturestart} onend={ongestureend} />
