<script lang="ts">
  import {
    findVideoFillers,
    findVideoTranscriptPauses,
    videoRemoveRangesEdits,
    videoTimelineTranscript,
    videoTranscriptEdit,
    videoWordAt,
    videoWordsRange,
    type VideoEditorController,
    type VideoTimelineWord
  } from '@pixerate/editor/video-editor';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    /** Track whose words to show (default: the first audio track with a transcribed clip, else the first video track with one). */
    track?: string;
    /** Allow cutting by text and loading transcripts (default true). */
    editable?: boolean;
    class?: string;
  }

  let { controller, track, editable = true, class: className = '' }: Props = $props();
  const view = videoEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const canEdit = $derived(editable && !editor.readOnly);
  const words: VideoTimelineWord[] = $derived.by(() => {
    try {
      return videoTimelineTranscript(editor.project, { track });
    } catch {
      return [];
    }
  });
  const current = $derived(videoWordAt(words, editor.time));
  let anchor = $state<number | null>(null);
  let focus = $state<number | null>(null);
  let message = $state<string | null>(null);
  const selected = $derived(anchor !== null && focus !== null && anchor < words.length && focus < words.length ? ([Math.min(anchor, focus), Math.max(anchor, focus)] as const) : null);
  const sound = $derived(editor.project.assets.filter((a) => a.kind !== 'image'));
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

  function cut(ranges: { from: number; to: number }[], label: string, none: string) {
    if (!ranges.length) {
      message = none;
      return;
    }
    const r = controller.apply(videoRemoveRangesEdits(ranges), label);
    message = r.ok ? null : r.error;
    anchor = null;
    focus = null;
  }
  function cutSelection() {
    if (selected) cut([videoWordsRange(words, selected[0], selected[1])], 'Cut words', 'Select words to cut.');
  }
  function pick(e: MouseEvent, i: number) {
    if (e.shiftKey && anchor !== null) focus = i;
    else {
      anchor = i;
      focus = i;
      controller.seek(words[i].start);
    }
  }
  async function load(assetId: string, file: File | undefined) {
    if (!file) return;
    try {
      const r = controller.apply(videoTranscriptEdit(assetId, await file.text()), 'Attach transcript');
      message = r.ok ? null : r.error;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<!--
  Edit by text: the words the timeline plays, from its media's transcripts. Click a word to go to it,
  Shift-click to select a run of words, then delete them to cut that stretch out. "Remove fillers"
  and "Tighten pauses" cut every um and long gap at once. Each cut is one undo step.
-->
<div class="flex flex-col gap-2 text-xs {className}" data-transcript-panel="">
  {#if words.length}
    <div
      class="max-h-48 overflow-y-auto leading-6"
      role="listbox"
      aria-label="Transcript"
      aria-multiselectable="true"
      tabindex="0"
      onkeydown={(e) => {
        if (canEdit && selected && (e.key === 'Delete' || e.key === 'Backspace')) {
          e.preventDefault();
          cutSelection();
        }
      }}
    >
      {#each words as w, i (`${w.clip}:${w.index}`)}
        {@const inSelection = selected !== null && i >= selected[0] && i <= selected[1]}
        <span
          role="option"
          aria-selected={inSelection}
          tabindex="-1"
          class="cursor-pointer rounded px-0.5 {inSelection ? 'bg-rose-500/30' : i === current ? 'bg-amber-400/40' : 'hover:bg-muted'}"
          data-word={i}
          data-current={i === current ? '' : undefined}
          data-selected={inSelection ? '' : undefined}
          onclick={(e) => pick(e, i)}
          onkeydown={() => {}}>{w.word}</span
        >{' '}
      {/each}
    </div>
    {#if canEdit}
      <div class="flex flex-wrap gap-1">
        <button type="button" class={btn} disabled={!selected} onclick={cutSelection}>Delete selected words</button>
        <button type="button" class={btn} onclick={() => cut(findVideoFillers(words), 'Remove fillers', 'No filler words found.')}>Remove fillers</button>
        <button type="button" class={btn} onclick={() => cut(findVideoTranscriptPauses(words, { fps: editor.project.fps }), 'Tighten pauses', 'No long pauses found.')}>Tighten pauses</button>
      </div>
    {/if}
  {:else}
    <p class="text-muted-foreground" data-transcript-empty="">No transcribed media on the timeline. Load a transcript (Whisper JSON, .srt or .vtt) for a video or audio asset to edit by text.</p>
  {/if}
  {#if canEdit && sound.length}
    <details>
      <summary class="cursor-pointer text-muted-foreground">Transcripts</summary>
      <ul class="mt-1 space-y-1">
        {#each sound as a (a.id)}
          <li class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate">{a.name ?? a.id} {a.transcript ? `· ${a.transcript.length} words` : ''}</span>
            <input type="file" accept=".json,.srt,.vtt,application/json,text/vtt" aria-label="Load a transcript for {a.name ?? a.id}" class="w-40 text-[10px]" onchange={(e) => void load(a.id, e.currentTarget.files?.[0])} />
          </li>
        {/each}
      </ul>
    </details>
  {/if}
  {#if message}
    <p class="text-red-500" role="alert" data-transcript-error="">{message}</p>
  {/if}
</div>
