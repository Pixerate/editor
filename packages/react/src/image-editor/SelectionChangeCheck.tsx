import React, { useState } from 'react';
import type { ImageEditorController, SelectionDiff, SelectionMask } from '@pixerate/editor/image-editor';

export interface SelectionChangeCheckProps {
  controller: ImageEditorController;
  /** The current selection (`state.selection`): the summary clears when it changes. */
  selection?: SelectionMask | null;
  className?: string;
}

const button =
  'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';

/**
 * Show Last Change: what the last step did to the selection, as the `compare_selections` tool
 * reports it, with the added area tinted green and the removed red on the canvas until the
 * selection changes again.
 */
export const SelectionChangeCheck: React.FC<SelectionChangeCheckProps> = ({ controller, selection, className = '' }) => {
  const sel = selection === undefined ? controller.getSelection() : selection;
  const [result, setResult] = useState<{ diff: SelectionDiff; for: SelectionMask | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const diff = result && result.for === sel ? result.diff : null;
  const show = () => {
    setError(null);
    try {
      setResult({ diff: controller.compareSelections(), for: sel });
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div data-testid="selection-change-check" className={`flex flex-col gap-1 text-xs ${className}`}>
      <button type="button" className={`${button} self-start`} onClick={show}>
        Show Last Change
      </button>
      {diff && (
        <p data-testid="selection-change-summary" className="text-foreground">
          {diff.identical ? (
            'The last step did not change the selection.'
          ) : (
            <>
              <span className="text-green-600">+{diff.added.area} px</span> <span className="text-destructive">−{diff.removed.area} px</span>, overlap {Math.round(diff.iou * 100)}%
            </>
          )}
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
