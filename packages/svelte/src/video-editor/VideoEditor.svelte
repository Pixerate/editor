<script lang="ts">
  import { onDestroy } from 'svelte';
  import { VideoEditorController, type VideoEditorOptions } from '@pixerate/editor/video-editor';
  import ClipInspector from './ClipInspector.svelte';
  import MediaBin from './MediaBin.svelte';
  import VideoPreview from './VideoPreview.svelte';
  import VideoTimeline from './VideoTimeline.svelte';
  import VideoTransport from './VideoTransport.svelte';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    /** The editor to show (default: one made from `options`, destroyed with the component). */
    controller?: VideoEditorController;
    /** Options for the editor made when no `controller` is passed (read once). */
    options?: VideoEditorOptions;
    /**
     * Show the editing panels: the media bin, clip inspector, edit buttons, dragging and edit keys
     * (default true). False shows the preview, transport, timeline (scrub and select) and issues.
     */
    editable?: boolean;
    /** Timeline zoom in pixels per second (default 100). Bindable. */
    pxPerSecond?: number;
    /** List the project's issues under the timeline (default true). */
    showIssues?: boolean;
    class?: string;
  }

  let { controller, options, editable = true, pxPerSecond = $bindable(100), showIssues = true, class: className = '' }: Props = $props();
  let owned: VideoEditorController | null = null;
  // A controller is made only when none is passed, and kept for the component's lifetime.
  const ctl = $derived(controller ?? (owned ??= new VideoEditorController(options)));
  onDestroy(() => owned?.destroy());
  const view = videoEditorStateOf(() => ctl);
  const editor = $derived(view.current);
</script>

{#snippet issueList()}
  {#if showIssues && editor.issues.length > 0}
    <ul class="space-y-0.5 text-xs" aria-label="Video issues" data-video-issues="">
      {#each editor.issues as issue, i (i)}
        <li class={issue.severity === 'error' ? 'text-red-500' : issue.severity === 'warning' ? 'text-amber-500' : 'text-muted-foreground'} data-issue={issue.code}>{issue.message}</li>
      {/each}
    </ul>
  {/if}
{/snippet}

<!--
  A whole video editor: the media bin, the preview, transport, the timeline (drag to move and trim,
  keys to split and delete), the selected clip's inspector and the project's issues. Every edit is
  one undo step.
-->
{#if !editable}
  <div class="flex flex-col gap-2 {className}" data-video-editor="">
    <VideoPreview controller={ctl} class="rounded-md" />
    <VideoTransport controller={ctl} editable={false} />
    <VideoTimeline controller={ctl} bind:pxPerSecond editable={false} />
    {@render issueList()}
  </div>
{:else}
  <div class="grid gap-3 lg:grid-cols-[14rem_minmax(0,1fr)_18rem] {className}" data-video-editor="">
    <MediaBin controller={ctl} class="min-w-0" />
    <div class="flex min-w-0 flex-col gap-2">
      <VideoPreview controller={ctl} class="rounded-md" />
      <VideoTransport controller={ctl} />
    </div>
    <ClipInspector controller={ctl} class="min-w-0" />
    <div class="flex min-w-0 flex-col gap-2 lg:col-span-3">
      <VideoTimeline controller={ctl} bind:pxPerSecond />
      {@render issueList()}
    </div>
  </div>
{/if}
