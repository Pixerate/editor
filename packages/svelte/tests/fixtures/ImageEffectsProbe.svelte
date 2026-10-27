<script lang="ts">
  import type { ToolRegistry } from '@pixerate/editor/tools';
  import type { ImageEditorController, ImageEffectsToolProviderOptions } from '@pixerate/editor/image-editor';
  import { useImageEffectsTools } from '../../src/image-editor';

  let { registry, controller, options = { namespace: 'imgfx' } }: { registry: ToolRegistry; controller: ImageEditorController; options?: ImageEffectsToolProviderOptions } = $props();
  // svelte-ignore state_referenced_locally
  useImageEffectsTools(() => registry, controller, options);
</script>
