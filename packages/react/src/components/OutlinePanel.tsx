import React from "react";
import type { Editor } from "@tiptap/core";
import { navigateToHeading, type OutlineHeading } from "@pixerate/editor";
import { useOutline } from "../hooks/useOutline";

export interface OutlinePanelProps {
  editor: Editor | null;
  /** Heading shown above the list. Pass `null` to hide it. */
  title?: React.ReactNode;
  /** Content shown when the document has no headings. */
  emptyState?: React.ReactNode;
  /** Deepest heading level listed. Defaults to 6. */
  maxLevel?: number;
  /** Whether clicking an entry focuses the editor. Defaults to `true`. */
  focusOnNavigate?: boolean;
  /** Custom class name for the wrapper. */
  className?: string;
  /** Class name for each entry button. */
  itemClassName?: string;
  /** Class name added to the entry of the section containing the selection. */
  activeItemClassName?: string;
  /** Called after navigating to a heading. */
  onNavigate?: (heading: OutlineHeading) => void;
}

/**
 * Navigation sidebar listing the document's headings (Word's Navigation pane).
 * Clicking an entry moves the caret to that heading; the entry for the
 * section containing the selection is highlighted.
 */
export const OutlinePanel: React.FC<OutlinePanelProps> = ({
  editor,
  title = "Outline",
  emptyState = "Add headings to see the outline.",
  maxLevel = 6,
  focusOnNavigate = true,
  className = "flex flex-col gap-1 text-sm",
  itemClassName = "w-full truncate rounded px-2 py-1 text-left hover:bg-black/5",
  activeItemClassName = "font-semibold bg-black/5",
  onNavigate,
}) => {
  const { headings, activeId } = useOutline(editor);
  const visible = headings.filter((h) => h.level <= maxLevel);

  return (
    <nav className={className} aria-label="Document outline" data-outline-panel="">
      {title != null && <div className="pixerate-outline-title">{title}</div>}
      {visible.length === 0 ? (
        <div className="pixerate-outline-empty">{emptyState}</div>
      ) : (
        <ul role="list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {visible.map((heading) => {
            const active = heading.id === activeId;
            return (
              <li key={heading.id} data-level={heading.level}>
                <button
                  type="button"
                  className={active ? `${itemClassName} ${activeItemClassName}` : itemClassName}
                  style={{ paddingLeft: `${0.5 + heading.depth * 0.75}rem` }}
                  aria-current={active ? "location" : undefined}
                  data-heading-id={heading.id}
                  onClick={() => {
                    if (!editor) return;
                    if (navigateToHeading(editor, heading, { focus: focusOnNavigate })) {
                      onNavigate?.(heading);
                    }
                  }}
                >
                  {heading.text || "Untitled"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
};
