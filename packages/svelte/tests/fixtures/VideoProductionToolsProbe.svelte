<script lang="ts">
  import type { ToolRegistry } from '@pixerate/editor/tools';
  import type { VideoEditorController } from '@pixerate/editor/video-editor';
  import { useVideoDialogueTools, useVideoMusicTools, transcriptVideoOf } from '../../src/video-editor';

  let { registry, controller }: { registry: ToolRegistry; controller: VideoEditorController } = $props();
  // svelte-ignore state_referenced_locally
  useVideoDialogueTools(() => registry, controller, { namespace: 'dialogue' });
  // svelte-ignore state_referenced_locally
  useVideoMusicTools(() => registry, controller, { namespace: 'music' });
  const view = transcriptVideoOf(() => controller);
</script>

<span data-word-count={view.current.words.length}></span>
