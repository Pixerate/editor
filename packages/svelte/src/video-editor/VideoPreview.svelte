<script lang="ts">
  import { untrack } from 'svelte';
  import { formatVideoTimecode, VideoPathGesture, VideoPreviewEngine, type VideoEditorController } from '@pixerate/editor/video-editor';
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
  // Drawing a path for an effect (the effects panel's Draw path): the preview takes the pointer.
  const pathDrawing = $derived(view.current.pathDrawing);
  const gesture = $derived(new VideoPathGesture({ width: project.width, height: project.height }));
  let drawn = $state<number[]>([]);
  $effect(() => {
    if (!pathDrawing) return;
    const c = controller;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && c.cancelPathDrawing();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<!-- The frame at the playhead, drawn on a canvas with the project's aspect ratio; media plays in step with the timeline. -->
<div style="position: relative">
  <canvas
    bind:this={canvas}
    class="block w-full bg-black {className}"
    style="aspect-ratio:{project.width} / {project.height};{style}"
    data-video-preview=""
    aria-label="{project.name ?? 'Video'} at {formatVideoTimecode(view.current.time, project.fps)}"
  ></canvas>
  {#if pathDrawing}
    <svg
      viewBox="0 0 {project.width} {project.height}"
      style="position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none"
      role="application"
      aria-label="Draw the effect's path"
      data-video-path-drawing=""
      onpointerdown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        gesture.down(e, e.currentTarget.getBoundingClientRect());
        drawn = [...gesture.points];
      }}
      onpointermove={(e) => {
        if (gesture.move(e, e.currentTarget.getBoundingClientRect())) drawn = [...gesture.points];
      }}
      onpointerup={() => {
        const points = gesture.up();
        drawn = [];
        if (points) void controller.finishPathDrawing(points);
      }}
    >
      <polyline points={drawn.join(' ')} fill="none" stroke="#22d3ee" stroke-width={Math.max(2, project.width / 300)} stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  {/if}
</div>
