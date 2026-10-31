import React, { useRef, useState } from 'react';
import type { ImageEditorController, SelectionMask } from '@pixerate/editor/image-editor';

export interface SeparateSubjectPanelProps {
  controller: ImageEditorController;
  /** The current selection (`state.selection`): the subject to separate. */
  selection?: SelectionMask | null;
  className?: string;
}

const button =
  'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';

/**
 * Separate Subject: the selected subject onto its own masked layer over a background plate with
 * the subject's area filled, in one undo step, as the `separate_subject` tool does. Shows progress
 * while the fill runs and can be cancelled.
 */
export const SeparateSubjectPanel: React.FC<SeparateSubjectPanelProps> = ({ controller, selection, className = '' }) => {
  const sel = selection === undefined ? controller.getSelection() : selection;
  const [dilate, setDilate] = useState(8);
  const [fill, setFill] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const run = async () => {
    setError(null);
    abort.current = new AbortController();
    setProgress('Starting');
    try {
      await controller.separateSubject({
        dilate,
        fill: fill ? 'content-aware' : 'none',
        signal: abort.current.signal,
        onProgress: (fraction, stage) => setProgress(`${stage ?? 'Filling'} ${Math.round(fraction * 100)}%`),
      });
    } catch (err) {
      if (!abort.current.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };
  return (
    <div data-testid="separate-subject" className={`flex flex-col gap-1.5 text-xs ${className}`}>
      <span className="font-semibold text-foreground uppercase tracking-wider text-[11px]">Separate Subject</span>
      <p className="text-muted-foreground">The selection onto its own masked layer, over the background with the subject filled out.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-muted-foreground">
          Grow
          <input
            type="number"
            min={0}
            max={200}
            aria-label="Separate grow"
            value={dilate}
            onChange={(e) => setDilate(Math.min(200, Math.max(0, Number(e.target.value) || 0)))}
            className="w-12 bg-background border border-border rounded px-1 py-0.5 text-foreground"
          />
          px
        </label>
        <label className="flex items-center gap-1 text-foreground">
          <input type="checkbox" aria-label="Fill the background" checked={fill} onChange={(e) => setFill(e.target.checked)} />
          Fill the background
        </label>
      </div>
      <div className="flex gap-1">
        <button type="button" className={button} disabled={!sel || progress !== null} onClick={run}>
          Separate Subject
        </button>
        {progress !== null && (
          <button type="button" className={button} onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
      </div>
      {progress !== null && (
        <p role="status" className="text-muted-foreground">
          {progress}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
