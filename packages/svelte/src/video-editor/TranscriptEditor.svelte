<script lang="ts">
  import type { VideoDisfluencyKind, VideoEditorController } from '@pixerate/editor/video-editor';
  import { transcriptVideoOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    /** Track whose words to show (default: the first audio track with a transcribed clip, else the first video track with one). */
    track?: string;
    /** Deleting words proposes a plan for review instead of cutting at once (default false). */
    planFirst?: boolean;
    /** Allow cutting by text (default true). */
    editable?: boolean;
    class?: string;
  }

  let { controller, track, planFirst = false, editable = true, class: className = '' }: Props = $props();
  const view = transcriptVideoOf(() => controller, () => ({ track, planFirst }));
  const ts = $derived(view.current);
  const canEdit = $derived(editable && ts.editable);
  let anchor = $state<number | null>(null);
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';
  const CHIP: Record<VideoDisfluencyKind, string> = {
    filler: 'bg-amber-400/30 text-amber-700 dark:text-amber-300',
    pause: 'bg-sky-400/25 text-sky-700 dark:text-sky-300',
    repetition: 'bg-violet-400/25 text-violet-700 dark:text-violet-300'
  };
  const KIND_LABEL: Record<VideoDisfluencyKind, string> = { filler: 'filler', pause: 'pause', repetition: 'repeat' };

  function pick(e: MouseEvent, i: number) {
    const t = view.transcript;
    if (e.shiftKey && anchor !== null) t.select(anchor, i);
    else {
      anchor = i;
      t.select(i);
      t.seekToWord(i);
    }
  }
  function onKey(e: KeyboardEvent) {
    if (canEdit && ts.selection && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      view.transcript.deleteSelection();
    }
  }
</script>

<!--
  Edit by text, with disfluencies marked: the word under the playhead highlighted as it plays,
  fillers, long pauses and stutters marked and listed as chips that cut each one out with a click.
  Click a word to go to it, Shift-click to select a run, Delete to cut it (or propose the cut with
  planFirst). "Plan cleanup" proposes every disfluency as one plan for review (see EditPlanPreview).
-->
{#if !ts.words.length}
  <p class="text-xs text-muted-foreground {className}" data-transcript-editor="" data-transcript-empty="">
    No transcribed media on the timeline. Attach a transcript (Whisper JSON, .srt or .vtt) to edit by text.
  </p>
{:else}
  <div class="flex flex-col gap-2 text-xs {className}" data-transcript-editor="">
    <div class="max-h-56 overflow-y-auto leading-6" role="listbox" aria-label="Transcript" aria-multiselectable="true" tabindex="0" onkeydown={onKey}>
      {#each ts.words as w, i (`${w.clip}:${w.index}`)}
        {@const selected = !!ts.selection && i >= ts.selection[0] && i <= ts.selection[1]}
        {@const kinds = ts.flags[i]}
        <span
          role="option"
          aria-selected={selected}
          tabindex="-1"
          class="cursor-pointer rounded px-0.5 {selected ? 'bg-rose-500/30' : i === ts.current ? 'bg-amber-400/50' : kinds?.length ? CHIP[kinds[0]] : 'hover:bg-muted'}"
          data-word={i}
          data-current={i === ts.current ? '' : undefined}
          data-selected={selected ? '' : undefined}
          data-disfluency={kinds?.join(' ') || undefined}
          title={kinds?.length ? kinds.map((k) => KIND_LABEL[k]).join(', ') : undefined}
          onclick={(e) => pick(e, i)}
          onkeydown={() => {}}>{w.word}</span
        >{#if kinds?.includes('pause')}<span class="mx-0.5 text-sky-500" aria-hidden="true">⏸</span>{:else}{' '}{/if}
      {/each}
    </div>
    {#if canEdit}
      <div class="flex flex-wrap items-center gap-1">
        <button type="button" class={btn} disabled={!ts.selection} onclick={() => view.transcript.deleteSelection()} data-delete-words="">
          {planFirst ? 'Propose deleting words' : 'Delete words'}
        </button>
        <button type="button" class={btn} disabled={!ts.disfluencies.length} onclick={() => view.transcript.planCleanup()} data-plan-cleanup="">
          Plan cleanup ({ts.disfluencies.length})
        </button>
      </div>
    {/if}
    {#if ts.disfluencies.length}
      <ul class="flex flex-wrap gap-1" aria-label="Disfluencies" data-disfluencies="">
        {#each ts.disfluencies as d, i (`${d.kind}:${d.from}`)}
          <li class="flex items-center gap-1 rounded px-1 {CHIP[d.kind]}" data-disfluency-chip={d.kind}>
            <button type="button" class="tabular-nums" title="Go to it" onclick={() => controller.seek(d.from)}>
              {KIND_LABEL[d.kind]}: {d.kind === 'pause' ? `${((d.to - d.from) / 1000).toFixed(1)} s` : d.text}
            </button>
            {#if canEdit}
              <button type="button" aria-label={`Cut ${KIND_LABEL[d.kind]} ${d.text}`} onclick={() => view.transcript.removeDisfluency(i)} data-cut-disfluency={i}>✕</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if ts.error}
      <p class="text-red-500" role="alert" data-transcript-error="">{ts.error}</p>
    {/if}
  </div>
{/if}
