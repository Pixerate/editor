<script lang="ts">
  import { highlightMotionSvg, motionCameraTransform, motionCameraViewAt, motionNodeAtElement, type AnimationEditorController, type MotionFrameOptions, type MotionOnionSkin, type MotionRecordGestureMode } from '@pixerate/editor/animation-editor';
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
    /**
     * While the controller records a take (`startRecording`), what dragging an element does:
     * `move` it, `scale` it about its centre or `rotate` it (default `move`). Each pointer move
     * is a sample of the take.
     */
    recordMode?: MotionRecordGestureMode;
    class?: string;
  }

  let { controller, values, onionSkin, motionPaths, onpick, highlight, recordMode = 'move', class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const recording = $derived(view.current.recording);
  let dragging: number | null = null;
  const point = (e: PointerEvent) => controller.clientToDocument((e.currentTarget as Element).getBoundingClientRect(), e.clientX, e.clientY);
  function onpointerdown(e: PointerEvent) {
    const id = motionNodeAtElement(view.current.scene, e.target as Element, e.currentTarget as Element);
    if (!id || !controller.beginRecordGesture(id, recordMode, point(e))) return;
    dragging = e.pointerId;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  function onpointermove(e: PointerEvent) {
    if (dragging === e.pointerId) controller.updateRecordGesture(point(e));
  }
  function onpointerup(e: PointerEvent) {
    if (dragging !== e.pointerId) return;
    dragging = null;
    controller.endRecordGesture();
  }
  function onpointercancel() {
    dragging = null;
    controller.endRecordGesture();
  }
  // Re-drawn on every state change (a recorded sample changes the frame without moving the playhead).
  const svg = $derived(
    highlightMotionSvg(
      controller
        .toSvg(view.current.time, { pretty: false, idPrefix: 'ae-', values, onionSkin, motionPaths })
        .replace(/<svg ([^>]*?)width="[^"]*" height="[^"]*"/, '<svg $1width="100%" height="100%"'),
      highlight ?? []
    )
  );
  // A camera move's tilt and turn are 3D, so the stage element turns (its roll and blur are in the SVG).
  let stage = $state<HTMLDivElement | null>(null);
  const transform = $derived(motionCameraTransform(motionCameraViewAt(controller.viewScene(), view.current.time, view.current.effectsProvider), stage?.clientWidth || view.current.scene.artwork.width));
  function onclick(event: MouseEvent) {
    onpick?.(motionNodeAtElement(view.current.scene, event.target as Element, event.currentTarget as Element), event);
  }
</script>

<!-- The frame at the playhead as inline SVG (keeping node ids, so a click can pick an element). -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div
  class="relative overflow-hidden {recording ? 'cursor-grab touch-none' : onpick ? 'cursor-crosshair' : ''} {className}"
  bind:this={stage}
  style="aspect-ratio:{view.current.scene.artwork.width} / {view.current.scene.artwork.height}{transform ? `; transform:${transform}` : ''}"
  data-animation-stage=""
  data-recording={recording ? '' : undefined}
  role="img"
  aria-label="{view.current.scene.name} at {(view.current.time / 1000).toFixed(2)} s"
  onclick={onpick ? onclick : undefined}
  onpointerdown={recording ? onpointerdown : undefined}
  onpointermove={recording ? onpointermove : undefined}
  onpointerup={recording ? onpointerup : undefined}
  onpointercancel={recording ? onpointercancel : undefined}
>
  {@html svg}
</div>
