<script lang="ts">
  import type { ToolRegistry } from '@pixerate/editor/tools';
  import type { VideoEditorController } from '@pixerate/editor/video-editor';
  import { useVideoEditorTools } from '../../src/video-editor';

  let { registry, controller }: { registry: ToolRegistry; controller: VideoEditorController } = $props();
  // svelte-ignore state_referenced_locally
  useVideoEditorTools(() => registry, controller, { namespace: 'video' });
</script>
