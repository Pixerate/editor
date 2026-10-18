<script lang="ts">
  import { highlightMotionSvg, motionNodeAtElement, type AnimationEditorController, type MotionFrameOptions, type MotionOnionSkin } from '@pixerate/editor/animation-editor';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** Control values to preview (`{ accent: "#0ea5e9" }`). */
    values?: MotionFrameOptions['values'];
    /** Faded frames either side of the playhead. */
    onionSkin?: MotionOnionSkin;
    /** Draw where nodes travel: true for every node whose place changes, or a list of ids. */
    motionPaths?: boolean | readonly string[];
    /**
     * Called when the stage is clicked, with the id of the artwork node under the pointer (the
     * innermost one; null for the background, ghosts and paths). Makes the stage pickable.
     */
    onpick?: (id: string | null, event: MouseEvent) => void;
    /** Node ids to outline (e.g. the picked element and the selected command's targets). */
    highlight?: readonly string[];
    class?: string;
  }

  let { controller, values, onionSkin, motionPaths, onpick, highlight, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const svg = $derived(
    highlightMotionSvg(
      controller
        .toSvg(view.current.time, { pretty: false, idPrefix: 'ae-', values, onionSkin, motionPaths })
        .replace(/<svg ([^>]*?)width="[^"]*" height="[^"]*"/, '<svg $1width="100%" height="100%"'),
      highlight ?? []
    )
  );
  function onclick(event: MouseEvent) {
    onpick?.(motionNodeAtElement(view.current.scene, event.target as Element, event.currentTarget as Element), event);
  }
</script>

<!-- The frame at the playhead as inline SVG (keeping node ids, so a click can pick an element). -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div
  class="relative overflow-hidden {onpick ? 'cursor-crosshair' : ''} {className}"
  style="aspect-ratio:{view.current.scene.artwork.width} / {view.current.scene.artwork.height}"
  data-animation-stage=""
  role="img"
  aria-label="{view.current.scene.name} at {(view.current.time / 1000).toFixed(2)} s"
  onclick={onpick ? onclick : undefined}
>
  {@html svg}
</div>
