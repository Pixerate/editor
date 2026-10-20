<script lang="ts">
  import type { ToolRegistry } from '@pixerate/editor/tools';
  import type { EffectProvider } from '@pixerate/editor/effects';
  import type { VideoEditorController } from '@pixerate/editor/video-editor';
  import { useEffects } from '../../src/effects';
  import { useVideoEffectsTools } from '../../src/video-editor';

  let { registry, controller, provider }: { registry: ToolRegistry; controller: VideoEditorController; provider: EffectProvider | null } = $props();
  useEffects(() => controller, () => provider);
  // svelte-ignore state_referenced_locally
  useVideoEffectsTools(() => registry, controller, { namespace: 'fx' });
</script>
