<script lang="ts">
  import type { AgentPlayback } from '@pixerate/editor/tools';
  import { onDestroy } from 'svelte';
  import { VideoEditorController, type VideoEditorOptions } from '@pixerate/editor/video-editor';
  import ClipInspector from './ClipInspector.svelte';
  import MediaBin from './MediaBin.svelte';
  import TranscriptPanel from './TranscriptPanel.svelte';
  import TranscriptEditor from './TranscriptEditor.svelte';
  import EditPlanPreview from './EditPlanPreview.svelte';
  import VideoPreview from './VideoPreview.svelte';
  import VideoScopes from './VideoScopes.svelte';
  import VideoTimeline from './VideoTimeline.svelte';
  import VideoTransport from './VideoTransport.svelte';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';
  import type { EffectProvider } from '@pixerate/editor/effects';
  import { useEffects } from '../effects/effects.svelte.js';
  import VideoEffectsPanel from './VideoEffectsPanel.svelte';

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
    /** Show the transcript panel for editing by text (default true). */
    showTranscript?: boolean;
    /**
     * How the transcript is shown: `panel` (default) is `TranscriptPanel`, which also loads
     * transcript files; `editor` marks fillers, pauses and stutters and plans cleanups for review
     * (`TranscriptEditor`).
     */
    transcriptMode?: 'editor' | 'panel';
    /** Show colour scopes (histogram, luma waveform, vectorscope) of the preview under it (default false). */
    showScopes?: boolean;
    /**
     * An effects provider (see `@pixerate/editor/effects`), registered with the controller while
     * mounted: clip effects, effect transitions and effect clips, with the effects panel. Optional:
     * without one the editor is as before (effects in a project show as placeholders).
     */
    effects?: EffectProvider | null;
    /** Show the effects panel (default: when a provider is given or the project has effects). */
    showEffects?: boolean;
    class?: string;
    /** Agent playback on the timeline (see `<VideoTimeline playback>`; default: `setAgentPlayback` above). */
    playback?: AgentPlayback | null;
    /** Bring the editor on screen (switch to its tab) before the agent acts. */
    onplaybackreveal?: () => void | Promise<void>;
  }

  let { controller, options, editable = true, pxPerSecond = $bindable(100), showIssues = true, showTranscript = true, transcriptMode = 'panel', showScopes = false, effects, showEffects, class: className = '', playback, onplaybackreveal }: Props = $props();
  let owned: VideoEditorController | null = null;
  // A controller is made only when none is passed, and kept for the component's lifetime.
  const ctl = $derived(controller ?? (owned ??= new VideoEditorController(options)));
  onDestroy(() => owned?.destroy());
  const view = videoEditorStateOf(() => ctl);
  const editor = $derived(view.current);
  useEffects(() => ctl, () => effects);
  const effectsShown = $derived(showEffects ?? !!(editor.effectsProvider || editor.project.tracks.some((t) => t.clips.some((c) => c.type === 'effect' || c.type === 'adjustment' || c.effects?.length || c.transition?.type === 'effect'))));
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
    {#if showScopes}<VideoScopes controller={ctl} />{/if}
    <VideoTimeline controller={ctl} bind:pxPerSecond editable={false} {playback} {onplaybackreveal} />
    <EditPlanPreview controller={ctl} editable={false} />
    {#if showTranscript}{#if transcriptMode === 'editor'}<TranscriptEditor controller={ctl} editable={false} />{:else}<TranscriptPanel controller={ctl} editable={false} />{/if}{/if}
    {@render issueList()}
  </div>
{:else}
  <div class="grid gap-3 lg:grid-cols-[14rem_minmax(0,1fr)_18rem] {className}" data-video-editor="">
    <MediaBin controller={ctl} class="min-w-0" />
    <div class="flex min-w-0 flex-col gap-2">
      <VideoPreview controller={ctl} class="rounded-md" />
      <VideoTransport controller={ctl} />
      {#if showScopes}<VideoScopes controller={ctl} />{/if}
    </div>
    <div class="flex min-w-0 flex-col gap-3">
      <ClipInspector controller={ctl} class="min-w-0" />
      {#if effectsShown}<VideoEffectsPanel controller={ctl} class="min-w-0" />{/if}
    </div>
    <div class="flex min-w-0 flex-col gap-2 lg:col-span-3">
      <VideoTimeline controller={ctl} bind:pxPerSecond {playback} {onplaybackreveal} />
      <EditPlanPreview controller={ctl} />
      {#if showTranscript}{#if transcriptMode === 'editor'}<TranscriptEditor controller={ctl} />{:else}<TranscriptPanel controller={ctl} />{/if}{/if}
      {@render issueList()}
    </div>
  </div>
{/if}
