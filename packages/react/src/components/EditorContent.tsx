import React from "react";
import {
  EditorContent as TipTapEditorContent,
  EditorContentProps as TipTapEditorContentProps,
} from "@tiptap/react";

export interface EditorContentProps extends TipTapEditorContentProps {
  className?: string;
}

export const EditorContent: React.FC<EditorContentProps> = ({
  className,
  editor,
  ...props
}) => {
  return (
    <div className={className}>
      <TipTapEditorContent editor={editor} {...props} />
    </div>
  );
};
