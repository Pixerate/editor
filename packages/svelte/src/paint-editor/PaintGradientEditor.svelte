<script lang="ts">
  import { PAINT_GRADIENT_KIT, type PaintGradientSource } from '@pixerate/editor/paint-editor';
  import PaintGradientEditorView from './PaintGradientEditorView.svelte';

  interface Props {
    value: PaintGradientSource;
    onchange: (paint: PaintGradientSource) => void;
    /** What `paint` / `secondary` stops show as (the editor's two colours). */
    colors: { paint: string; secondary: string };
    class?: string;
  }
  let { value, onchange, colors, class: className = '' }: Props = $props();
</script>

<!-- The gradient paint editor (see PaintGradientEditorView). -->
<PaintGradientEditorView {value} {onchange} {colors} class={className} kit={PAINT_GRADIENT_KIT} />
