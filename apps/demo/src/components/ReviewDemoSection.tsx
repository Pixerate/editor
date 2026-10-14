import React, { useMemo } from "react";
import { Comments, CommentStore, TrackChanges, getEditorText } from "@pixerate/editor";
import {
  useEditor,
  EditorContent,
  BubbleMenu,
  CommentButton,
  CommentsPanel,
  ReviewToolbar,
  useTrackChanges,
} from "@pixerate/editor-react";

const reviewer = { id: "demo-user", name: "You" };

/**
 * Comments and tracked changes (suggestion mode) on a rich-text document.
 */
export const ReviewDemoSection: React.FC = () => {
  const store = useMemo(() => new CommentStore(), []);
  const editor = useEditor({
    content: `
      <h3>Review mode</h3>
      <p>Select text and use the bubble menu to add a comment. Turn on tracking and edit this paragraph: insertions are underlined, deletions struck through until accepted or rejected.</p>
    `,
    extensions: [
      Comments.configure({ store, author: reviewer }),
      TrackChanges.configure({ author: reviewer }),
    ],
    editorProps: {
      attributes: {
        class:
          "w-full bg-slate-900 border border-slate-800 rounded-lg p-6 font-sans text-sm leading-relaxed text-slate-100 min-h-[160px] focus:outline-none",
      },
    },
  });
  const review = useTrackChanges(editor);

  if (!editor) return null;

  return (
    <section className="mt-8 space-y-3">
      <ReviewToolbar
        editor={editor}
        className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-800 bg-slate-900/80 p-2 text-slate-200"
      />
      <div className="grid gap-4 md:grid-cols-[1fr_18rem]">
        <div>
          <BubbleMenu
            editor={editor}
            pluginKey="reviewBubbleMenu"
            className="flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 p-1 text-slate-200 shadow-md"
          >
            <CommentButton editor={editor} className="rounded px-2 py-1 text-xs hover:bg-slate-700" />
          </BubbleMenu>
          <EditorContent editor={editor} />
          <p className="mt-2 text-xs text-slate-500">
            Exported text (changes accepted, {review.changes.length} pending):{" "}
            <span className="text-slate-300">{getEditorText(editor)}</span>
          </p>
        </div>
        <CommentsPanel
          editor={editor}
          className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-200"
        />
      </div>
    </section>
  );
};
