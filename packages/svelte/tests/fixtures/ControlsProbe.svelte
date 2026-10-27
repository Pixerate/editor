<script lang="ts">
  import type { ImageEditorController, SelectionToolOptions } from '@pixerate/editor/image-editor';
  import { SelectionOptionsBar, setImageEditorControls, type ImageEditorControls } from '../../src/image-editor';

  let {
    controller,
    controls,
    options,
    onOptionsChange,
  }: {
    controller: ImageEditorController;
    controls: ImageEditorControls;
    options: SelectionToolOptions;
    onOptionsChange: (o: SelectionToolOptions) => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  setImageEditorControls(controls);
</script>

<SelectionOptionsBar {controller} {options} {onOptionsChange} />
