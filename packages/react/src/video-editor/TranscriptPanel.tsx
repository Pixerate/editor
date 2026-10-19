import React, { useMemo, useState } from 'react';
import {
  findVideoFillers,
  findVideoTranscriptPauses,
  videoRemoveRangesEdits,
  videoTimelineTranscript,
  videoTranscriptEdit,
  videoWordAt,
  videoWordsRange,
  type VideoEditorController,
} from '@pixerate/editor/video-editor';
import { useVideoEditorState } from './useVideoEditor';

export interface TranscriptPanelProps {
  controller: VideoEditorController;
  /** Track whose words to show (default: the first audio track with a transcribed clip, else the first video track with one). */
  track?: string;
  /** Allow cutting by text and loading transcripts (default true). */
  editable?: boolean;
  className?: string;
}

const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

/**
 * Edit by text: the words the timeline plays, from its media's transcripts. Click a word to go to
 * it, Shift-click to select a run of words, then delete them to cut that stretch out (closing it up
 * on every sync-locked track). "Remove fillers" and "Tighten pauses" cut every um and every long gap
 * at once. Each cut is one undo step. Transcripts (Whisper JSON, .srt, .vtt) load per asset below.
 */
export function TranscriptPanel({ controller, track, editable = true, className = '' }: TranscriptPanelProps) {
  const state = useVideoEditorState(controller);
  const { project, time, readOnly } = state;
  const canEdit = editable && !readOnly;
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const words = useMemo(() => {
    try {
      return videoTimelineTranscript(project, { track });
    } catch {
      return [];
    }
  }, [project, track]);
  const current = videoWordAt(words, time);
  const selected = anchor !== null && focus !== null && anchor < words.length && focus < words.length ? ([Math.min(anchor, focus), Math.max(anchor, focus)] as const) : null;
  const sound = project.assets.filter((a) => a.kind !== 'image');

  const cut = (ranges: { from: number; to: number }[], label: string, none: string) => {
    if (!ranges.length) return setMessage(none);
    const r = controller.apply(videoRemoveRangesEdits(ranges), label);
    setMessage(r.ok ? null : r.error);
    setAnchor(null);
    setFocus(null);
  };
  const load = async (assetId: string, file: File | undefined) => {
    if (!file) return;
    try {
      const r = controller.apply(videoTranscriptEdit(assetId, await file.text()), 'Attach transcript');
      setMessage(r.ok ? null : r.error);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={`flex flex-col gap-2 text-xs ${className}`} data-transcript-panel="">
      {words.length > 0 ? (
        <>
          <div
            className="max-h-48 overflow-y-auto leading-6"
            role="listbox"
            aria-label="Transcript"
            aria-multiselectable="true"
            tabIndex={0}
            onKeyDown={(e) => {
              if (canEdit && selected && (e.key === 'Delete' || e.key === 'Backspace')) {
                e.preventDefault();
                cut([videoWordsRange(words, selected[0], selected[1])], 'Cut words', 'Select words to cut.');
              }
            }}
          >
            {words.map((w, i) => {
              const inSelection = selected !== null && i >= selected[0] && i <= selected[1];
              return (
                <React.Fragment key={`${w.clip}:${w.index}`}>
                  <span
                    role="option"
                    aria-selected={inSelection}
                    tabIndex={-1}
                    className={`cursor-pointer rounded px-0.5 ${inSelection ? 'bg-rose-500/30' : i === current ? 'bg-amber-400/40' : 'hover:bg-muted'}`}
                    data-word={i}
                    data-current={i === current ? '' : undefined}
                    data-selected={inSelection ? '' : undefined}
                    onClick={(e) => {
                      if (e.shiftKey && anchor !== null) setFocus(i);
                      else {
                        setAnchor(i);
                        setFocus(i);
                        controller.seek(w.start);
                      }
                    }}
                  >
                    {w.word}
                  </span>{' '}
                </React.Fragment>
              );
            })}
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-1">
              <button type="button" className={btn} disabled={!selected} onClick={() => selected && cut([videoWordsRange(words, selected[0], selected[1])], 'Cut words', 'Select words to cut.')}>
                Delete selected words
              </button>
              <button type="button" className={btn} onClick={() => cut(findVideoFillers(words), 'Remove fillers', 'No filler words found.')}>
                Remove fillers
              </button>
              <button type="button" className={btn} onClick={() => cut(findVideoTranscriptPauses(words, { fps: project.fps }), 'Tighten pauses', 'No long pauses found.')}>
                Tighten pauses
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="text-muted-foreground" data-transcript-empty="">
          No transcribed media on the timeline. Load a transcript (Whisper JSON, .srt or .vtt) for a video or audio asset to edit by text.
        </p>
      )}
      {canEdit && sound.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Transcripts</summary>
          <ul className="mt-1 space-y-1">
            {sound.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {a.name ?? a.id} {a.transcript ? `· ${a.transcript.length} words` : ''}
                </span>
                <input type="file" accept=".json,.srt,.vtt,application/json,text/vtt" aria-label={`Load a transcript for ${a.name ?? a.id}`} className="w-40 text-[10px]" onChange={(e) => void load(a.id, e.target.files?.[0])} />
              </li>
            ))}
          </ul>
        </details>
      )}
      {message && (
        <p className="text-red-500" role="alert" data-transcript-error="">
          {message}
        </p>
      )}
    </div>
  );
}
