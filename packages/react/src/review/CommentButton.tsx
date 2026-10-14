import React from "react";
import type { Editor } from "@tiptap/core";

export interface CommentButtonProps {
  editor: Editor | null;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Adds a draft comment on the selection; drop it into a `BubbleMenu`. The
 * draft is completed in `CommentsPanel`.
 */
export const CommentButton: React.FC<CommentButtonProps> = ({
  editor,
  className = "rounded px-2 py-1 text-xs text-popover-foreground hover:bg-muted",
  children = "Comment",
}) => (
  <button
    type="button"
    className={className}
    disabled={!editor}
    onClick={() => editor?.chain().focus().addComment().run()}
  >
    {children}
  </button>
);
