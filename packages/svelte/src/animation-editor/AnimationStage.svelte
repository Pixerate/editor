<script lang="ts">
  import type { AnimationEditorController, MotionFrameOptions, MotionOnionSkin } from '@pixerate/editor/animation-editor';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** Control values to preview (`{ accent: "#0ea5e9" }`). */
    values?: MotionFrameOptions['values'];
    /** Faded frames either side of the playhead. */
    onionSkin?: MotionOnionSkin;
    /** Draw where nodes travel: true for every node whose place changes, or a list of ids. */
    motionPaths?: boolean | readonly string[];
    class?: string;
  }

  let { controller, values, onionSkin, motionPaths, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const svg = $derived(
    controller
      .toSvg(view.current.time, { pretty: false, idPrefix: 'ae-', values, onionSkin, motionPaths })
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
