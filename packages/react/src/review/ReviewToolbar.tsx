import React from "react";
import type { Editor } from "@tiptap/core";
import { useTrackChanges } from "./useReview";

export interface ReviewToolbarProps {
  editor: Editor | null;
  className?: string;
}

const buttonClass =
  "rounded px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * Toolbar for tracked changes: toggle tracking, step through changes, and
 * accept or reject the current change or all changes.
 */
export const ReviewToolbar: React.FC<ReviewToolbarProps> = ({
  editor,
  className = "flex flex-wrap items-center gap-1 rounded-md border border-border bg-background p-1 text-sm",
}) => {
  const review = useTrackChanges(editor);
  const count = review.changes.length;
  const current = review.currentChange;
  const index = current ? review.changes.findIndex((c) => c.id === current.id) + 1 : 0;

  return (
    <div className={className} role="toolbar" aria-label="Review">
      <button
        type="button"
        className={`${buttonClass} ${review.enabled ? "bg-primary/10 text-primary" : ""}`}
        aria-pressed={review.enabled}
        disabled={!editor}
        onClick={review.toggle}
      >
        {review.enabled ? "Tracking on" : "Track changes"}
      </button>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <button
        type="button"
        className={buttonClass}
        aria-label="Previous change"
        disabled={count === 0}
        onClick={review.previous}
      >
        ‹
      </button>
      <span className="min-w-[4rem] text-center text-xs text-muted-foreground" aria-live="polite">
        {count === 0 ? "No changes" : current ? `${index} of ${count}` : `${count} changes`}
      </span>
      <button
        type="button"
        className={buttonClass}
        aria-label="Next change"
        disabled={count === 0}
        onClick={review.next}
      >
        ›
      </button>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <button
        type="button"
        className={buttonClass}
        disabled={!current}
        onClick={() => current && review.accept(current.id)}
      >
        Accept
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={!current}
        onClick={() => current && review.reject(current.id)}
      >
        Reject
      </button>
      <button type="button" className={buttonClass} disabled={count === 0} onClick={review.acceptAll}>
        Accept all
      </button>
      <button type="button" className={buttonClass} disabled={count === 0} onClick={review.rejectAll}>
        Reject all
      </button>
    </div>
  );
};
