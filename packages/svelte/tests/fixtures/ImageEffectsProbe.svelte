<script lang="ts">
  import type { ToolRegistry } from '@pixerate/editor/tools';
  import type { ImageEditorController } from '@pixerate/editor/image-editor';
  import { useImageEffectsTools } from '../../src/image-editor';

  let { registry, controller }: { registry: ToolRegistry; controller: ImageEditorController } = $props();
  // svelte-ignore state_referenced_locally
  useImageEffectsTools(() => registry, controller, { namespace: 'imgfx' });
</script>
