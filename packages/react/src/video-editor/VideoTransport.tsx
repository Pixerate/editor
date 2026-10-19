import React from 'react';
import { formatVideoTimecode, parseVideoPreviewScale, VIDEO_PREVIEW_SCALE_OPTIONS, videoProjectHasProxies, type VideoEditorController } from '@pixerate/editor/video-editor';
import { useVideoEditorState } from './useVideoEditor';

export interface VideoTransportProps {
  controller: VideoEditorController;
  /** Show the editing buttons (split, delete, ripple delete, undo, redo; default true). */
  editable?: boolean;
  className?: string;
}

const btn = 'rounded border border-border px-2 py-0.5 text-xs disabled:opacity-40';

/**
 * Play / pause, a frame back and forward, the playhead and total length as timecode, and the
 * edits that work on the playhead and the selection: split, delete, ripple delete, undo and redo.
 * When any asset has proxies, a preview-size control picks what the preview plays (a view setting).
 */
export function VideoTransport({ controller, editable = true, className = '' }: VideoTransportProps) {
  const state = useVideoEditorState(controller);
  const { time, duration, playing, project, selection, readOnly } = state;
  const canEdit = editable && !readOnly;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-xs ${className}`} data-video-transport="">
      <button type="button" className={btn} onClick={() => controller.step(-1)} aria-label="Previous frame" title="Previous frame (←)" data-step-back="">
        ◀|
      </button>
      <button type="button" className={btn} onClick={() => controller.toggle()} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)" disabled={duration <= 0} data-play="">
        {playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" className={btn} onClick={() => controller.step(1)} aria-label="Next frame" title="Next frame (→)" data-step-forward="">
        |▶
      </button>
      <span className="px-1 tabular-nums text-muted-foreground" data-timecode="">
        {formatVideoTimecode(time, project.fps)} / {formatVideoTimecode(duration, project.fps)}
      </span>
      {videoProjectHasProxies(project) && (
        <select
          className="rounded border border-border bg-transparent px-1 py-0.5 text-xs"
          value={String(state.previewScale)}
          onChange={(e) => controller.setPreviewScale(parseVideoPreviewScale(e.target.value))}
          aria-label="Preview size"
          title="Play proxies in the preview (the export always uses the originals)"
          data-preview-scale=""
        >
          {VIDEO_PREVIEW_SCALE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {editable && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <button type="button" className={btn} onClick={() => controller.splitAtPlayhead()} disabled={!canEdit} title="Split at the playhead (S)" data-split="">
            Split
          </button>
          <button type="button" className={btn} onClick={() => controller.deleteSelection()} disabled={!canEdit || !selection.length} title="Delete the selected clips (Delete)" data-delete="">
            Delete
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => controller.deleteSelection({ ripple: true })}
            disabled={!canEdit || !selection.length}
            title="Delete the selected clips and close the gaps (Shift+Delete)"
            data-ripple-delete=""
          >
            Ripple delete
          </button>
          <button type="button" className={btn} onClick={() => controller.undo()} disabled={!canEdit || !state.canUndo} title={state.canUndo ? `Undo ${state.undoLabel}` : 'Nothing to undo'} data-undo="">
            Undo
          </button>
          <button type="button" className={btn} onClick={() => controller.redo()} disabled={!canEdit || !state.canRedo} title={state.canRedo ? `Redo ${state.redoLabel}` : 'Nothing to redo'} data-redo="">
            Redo
          </button>
        </>
      )}
    </div>
  );
}
