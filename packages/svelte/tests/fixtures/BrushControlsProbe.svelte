<script lang="ts">
  import type { ImageEditorController } from '@pixerate/editor/image-editor';
  import { BrushOptionsBar, setImageEditorControls, type ImageEditorControls } from '../../src/image-editor';

  let { controller, controls }: { controller: ImageEditorController; controls: ImageEditorControls } = $props();
  // svelte-ignore state_referenced_locally
  setImageEditorControls(controls);
</script>

<BrushOptionsBar {controller} />
