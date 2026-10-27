import React, { useState } from 'react';
import type { VideoDisfluencyKind, VideoEditorController } from '@pixerate/editor/video-editor';
import { useTranscriptVideoController, useTranscriptVideoState } from './useTranscriptVideo';

export interface TranscriptEditorProps {
  controller: VideoEditorController;
  /** Track whose words to show (default: the first audio track with a transcribed clip, else the first video track with one). */
  track?: string;
  /** Deleting words proposes a plan for review instead of cutting at once (default false). */
  planFirst?: boolean;
  /** Allow cutting by text (default true). */
  editable?: boolean;
  className?: string;
}

const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';
const CHIP: Record<VideoDisfluencyKind, string> = {
  filler: 'bg-amber-400/30 text-amber-700 dark:text-amber-300',
  pause: 'bg-sky-400/25 text-sky-700 dark:text-sky-300',
  repetition: 'bg-violet-400/25 text-violet-700 dark:text-violet-300',
};
const KIND_LABEL: Record<VideoDisfluencyKind, string> = { filler: 'filler', pause: 'pause', repetition: 'repeat' };

/**
 * Edit by text, with disfluencies marked: the words the timeline plays, the word under the
 * playhead highlighted as it plays, fillers, long pauses and stutters marked in the text and
 * listed as chips that cut each one out with a click. Click a word to go to it, Shift-click to
 * select a run, Delete to cut it (or propose the cut with `planFirst`). "Plan cleanup" proposes
 * every disfluency as one plan for review (see `EditPlanPreview`). Each cut is one undo step.
 */
export function TranscriptEditor({ controller, track, planFirst = false, editable = true, className = '' }: TranscriptEditorProps) {
  const transcript = useTranscriptVideoController(controller, { track, planFirst });
  const state = useTranscriptVideoState(transcript);
  const [anchor, setAnchor] = useState<number | null>(null);
  const canEdit = editable && state.editable;
  const { words, current, selection, disfluencies, flags } = state;

  if (!words.length)
    return (
      <p className={`text-xs text-muted-foreground ${className}`} data-transcript-editor="" data-transcript-empty="">
        No transcribed media on the timeline. Attach a transcript (Whisper JSON, .srt or .vtt) to edit by text.
      </p>
    );

  return (
    <div className={`flex flex-col gap-2 text-xs ${className}`} data-transcript-editor="">
      <div
        className="max-h-56 overflow-y-auto leading-6"
        role="listbox"
        aria-label="Transcript"
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={(e) => {
          if (canEdit && selection && (e.key === 'Delete' || e.key === 'Backspace')) {
            e.preventDefault();
            transcript.deleteSelection();
          }
        }}
      >
        {words.map((w, i) => {
          const selected = !!selection && i >= selection[0] && i <= selection[1];
          const kinds = flags[i];
          return (
            <React.Fragment key={`${w.clip}:${w.index}`}>
              <span
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                className={`cursor-pointer rounded px-0.5 ${selected ? 'bg-rose-500/30' : i === current ? 'bg-amber-400/50' : kinds?.length ? CHIP[kinds[0]] : 'hover:bg-muted'}`}
                data-word={i}
                data-current={i === current ? '' : undefined}
                data-selected={selected ? '' : undefined}
                data-disfluency={kinds?.join(' ') || undefined}
                title={kinds?.length ? kinds.map((k) => KIND_LABEL[k]).join(', ') : undefined}
                onClick={(e) => {
                  if (e.shiftKey && anchor !== null) transcript.select(anchor, i);
                  else {
                    setAnchor(i);
                    transcript.select(i);
                    transcript.seekToWord(i);
                  }
                }}
              >
                {w.word}
              </span>
              {kinds?.includes('pause') ? <span className="mx-0.5 text-sky-500" aria-hidden="true">⏸</span> : ' '}
            </React.Fragment>
          );
        })}
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={btn} disabled={!selection} onClick={() => transcript.deleteSelection()} data-delete-words="">
            {planFirst ? 'Propose deleting words' : 'Delete words'}
          </button>
          <button type="button" className={btn} disabled={!disfluencies.length} onClick={() => transcript.planCleanup()} data-plan-cleanup="">
            Plan cleanup ({disfluencies.length})
          </button>
        </div>
      )}
      {disfluencies.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Disfluencies" data-disfluencies="">
          {disfluencies.map((d, i) => (
            <li key={`${d.kind}:${d.from}`} className={`flex items-center gap-1 rounded px-1 ${CHIP[d.kind]}`} data-disfluency-chip={d.kind}>
              <button type="button" className="tabular-nums" title="Go to it" onClick={() => controller.seek(d.from)}>
                {KIND_LABEL[d.kind]}: {d.kind === 'pause' ? `${((d.to - d.from) / 1000).toFixed(1)} s` : d.text}
              </button>
              {canEdit && (
                <button type="button" aria-label={`Cut ${KIND_LABEL[d.kind]} ${d.text}`} onClick={() => transcript.removeDisfluency(i)} data-cut-disfluency={i}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.error && (
        <p className="text-red-500" role="alert" data-transcript-error="">
          {state.error}
        </p>
      )}
    </div>
  );
}
