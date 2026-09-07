import React from "react";
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react";
import type { Editor } from "@tiptap/core";

export interface BubbleMenuProps {
  editor: Editor | null;
  className?: string;
  children: React.ReactNode;
}

export const BubbleMenu: React.FC<BubbleMenuProps> = ({
  editor,
  className = "flex items-center gap-1 bg-popover text-popover-foreground border shadow-md rounded-md p-1",
  children,
}) => {
  if (!editor) return null;

  return (
    <TipTapBubbleMenu
      editor={editor}
      tippyOptions={{ duration: 100 }}
      className={className}
    >
      {children}
    </TipTapBubbleMenu>
  );
};
