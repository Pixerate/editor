import React from "react";
import type { Editor } from "@tiptap/core";
import { trackedChangeLabel } from "@pixerate/editor";
import { useTrackChanges } from "./useReview";

export interface TrackedChangesListProps {
  editor: Editor | null;
  className?: string;
  itemClassName?: string;
  activeItemClassName?: string;
  /** Content shown when there are no changes. */
  emptyState?: React.ReactNode;
}

const buttonClass =
  "rounded px-1.5 py-0.5 text-xs text-foreground hover:bg-muted disabled:opacity-40";

/**
 * Lists the document's tracked changes (insertions, deletions, moves,
 * formatting and block changes) with their author and description, and
 * accepts or rejects each one. A move is one entry: accepting or rejecting
 * it resolves both its source and its destination. Clicking an entry
 * selects the change in the editor.
 */
export const TrackedChangesList: React.FC<TrackedChangesListProps> = ({
  editor,
  className = "flex flex-col gap-1 text-sm",
  itemClassName = "flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/50",
  activeItemClassName = "bg-primary/10",
  emptyState = "No tracked changes.",
}) => {
  const review = useTrackChanges(editor);

  if (review.changes.length === 0) {
    return (
      <div className={className} data-tracked-changes-list="">
        <div className="pixerate-changes-empty text-xs text-muted-foreground">{emptyState}</div>
      </div>
    );
  }

  return (
    <ul className={className} role="list" aria-label="Tracked changes" data-tracked-changes-list="">
      {review.changes.map((change) => {
        const active = change.id === review.currentChangeId;
        return (
          <li
            key={`${change.type}:${change.id}`}
            className={active ? `${itemClassName} ${activeItemClassName}` : itemClassName}
            data-change-type={change.type}
            data-change-id={change.id}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-xs"
              title={`${change.author.name}: ${change.description}`}
              onClick={() => review.select(change.id)}
            >
              <span className="font-medium">{trackedChangeLabel(change)}</span>
              {change.author.name ? ` · ${change.author.name}` : ""}
              <span className="block truncate text-muted-foreground">{change.description}</span>
            </button>
            <button type="button" className={buttonClass} onClick={() => review.accept(change.id)}>
              Accept
            </button>
            <button type="button" className={buttonClass} onClick={() => review.reject(change.id)}>
              Reject
            </button>
          </li>
        );
      })}
    </ul>
  );
};
