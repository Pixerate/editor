<script lang="ts">
  import type { AnimationEditorController, MotionFrameOptions } from '@pixerate/editor/animation-editor';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** Control values to preview (`{ accent: "#0ea5e9" }`). */
    values?: MotionFrameOptions['values'];
    class?: string;
  }

  let { controller, values, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const svg = $derived(
    controller
      .toSvg(view.current.time, { pretty: false, idPrefix: 'ae-', values })
      .replace(/<svg ([^>]*?)width="[^"]*" height="[^"]*"/, '<svg $1width="100%" height="100%"')
  );
</script>

<!-- The frame at the playhead, drawn as inline SVG scaled to the stage's width. -->
<div
  class="relative overflow-hidden {className}"
  style="aspect-ratio:{view.current.scene.artwork.width} / {view.current.scene.artwork.height}"
  data-animation-stage=""
  role="img"
  aria-label="{view.current.scene.name} at {(view.current.time / 1000).toFixed(2)} s"
>
  {@html svg}
</div>
