<script lang="ts">
  import { untrack } from 'svelte';
  import { formatVideoTimecode, VideoPreviewEngine, type VideoEditorController } from '@pixerate/editor/video-editor';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    /** Canvas pixels per frame pixel (default: the displayed width at the device pixel ratio, at most 1). */
    resolution?: number;
    class?: string;
    style?: string;
  }

  let { controller, resolution, class: className = '', style = '' }: Props = $props();
  const view = videoEditorStateOf(() => controller);
  const project = $derived(view.current.project);
  let canvas: HTMLCanvasElement | undefined = $state();
  // One engine per canvas, controller and resolution: it follows the controller by itself.
  $effect(() => {
    const el = canvas;
    const source = controller;
    const options = { resolution };
    if (!el) return;
    const engine = untrack(() => new VideoPreviewEngine(source, el, options));
    return () => engine.destroy();
  });
</script>

<!-- The frame at the playhead, drawn on a canvas with the project's aspect ratio; media plays in step with the timeline. -->
<canvas
  bind:this={canvas}
  class="block w-full bg-black {className}"
  style="aspect-ratio:{project.width} / {project.height};{style}"
  data-video-preview=""
  aria-label="{project.name ?? 'Video'} at {formatVideoTimecode(view.current.time, project.fps)}"
></canvas>
