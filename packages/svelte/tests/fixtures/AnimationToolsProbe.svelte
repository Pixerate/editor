<script lang="ts">
  import type { ToolRegistry } from '@pixerate/editor/tools';
  import type { AnimationEditorController } from '@pixerate/editor/animation-editor';
  import { useAnimationEditorTools } from '../../src/animation-editor';

  let { registry, controller }: { registry: ToolRegistry; controller: AnimationEditorController } = $props();
  // svelte-ignore state_referenced_locally
  useAnimationEditorTools(() => registry, controller, { namespace: 'anim' });
</script>
