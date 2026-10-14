import React, { useMemo, useState } from "react";
import { Comments, CommentStore, TrackChanges, getEditorText } from "@pixerate/editor";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  useEditor,
  EditorContent,
  BubbleMenu,
  CommentButton,
  CommentsPanel,
  ReviewToolbar,
  TrackedChangesList,
  useDocumentCompare,
  useTrackChanges,
} from "@pixerate/editor-react";

const reviewer = { id: "demo-user", name: "You" };

const MOVE_EXAMPLE = `<h3>Tracked moves</h3>
<p>First, gather the requirements.</p>
<p>Then ship it to customers.</p>
<p>Next, write the design.</p>
<p>Finally, celebrate.</p>`;

/**
 * Loads a short list and, with tracking on, cuts the "Next" paragraph and
 * pastes it before the third block (the same transactions as Cut and
 * Paste), so it is recorded as one move: green double strike at the
 * source, green double underline at the destination.
 */
function runMoveExample(editor: Editor) {
  editor.commands.setTrackChanges(false);
  editor.commands.setContent(MOVE_EXAMPLE);
  editor.commands.setTrackChanges(true);
  const doc = editor.state.doc;
  const starts: number[] = [];
  doc.forEach((_node, offset) => starts.push(offset + 1));
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(doc, starts[3], starts[4])),
  );
  const slice = editor.state.selection.content();
  const html = (editor.view as any).serializeForClipboard(slice).dom.innerHTML as string;
  editor.view.dispatch(editor.state.tr.deleteSelection().setMeta("uiEvent", "cut"));
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, starts[2])),
  );
  editor.view.pasteHTML(html);
}

const ORIGINAL_VERSION = `<h3>Quarterly plan</h3>
<p>The team will ship the editor in March and review feedback in April.</p>
<ul><li><p>Write the docs</p></li><li><p>Fix the bugs</p></li></ul>
<p>This paragraph was removed.</p>`;

const REVISED_VERSION = `<h2>Quarterly plan</h2>
<p>The team will ship the <strong>new</strong> editor in February and review feedback in April.</p>
<ol><li><p>Write the docs</p></li><li><p>Fix the critical bugs</p></li><li><p>Plan the launch</p></li></ol>`;

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
  const comparison = useDocumentCompare(editor, {
    author: { id: "compare", name: "Compare" },
    detectMoves: true,
  });
  const [comparing, setComparing] = useState(false);
  const [original, setOriginal] = useState(ORIGINAL_VERSION);
  const [revised, setRevised] = useState(REVISED_VERSION);

  if (!editor) return null;

  return (
    <section className="mt-8 space-y-3">
      <ReviewToolbar
        editor={editor}
        className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-800 bg-slate-900/80 p-2 text-slate-200"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <button
          type="button"
          onClick={() => setComparing((open) => !open)}
          className="rounded border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800"
        >
          Compare…
        </button>
        <button
          type="button"
          onClick={() => runMoveExample(editor)}
          className="rounded border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800"
          title="Cut a sentence and paste it elsewhere with tracking on"
        >
          Tracked move example
        </button>
        <span>Cut and paste (or drag) a sentence or paragraph with tracking on to record a move.</span>
        {comparison.summary && (
          <span>
            Compared: {comparison.summary.insertions} insertions, {comparison.summary.deletions} deletions,{" "}
            {comparison.summary.formatChanges} formatting, {comparison.summary.blockChanges} block changes, {comparison.summary.moves} moves
            {comparison.summary.notHonoured.length > 0 && ` (not tracked: ${comparison.summary.notHonoured.join(" ")})`}
          </span>
        )}
      </div>
      {comparing && (
        <div className="grid gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Original (HTML)
            <textarea
              value={original}
              onChange={(e) => setOriginal(e.target.value)}
              rows={6}
              className="rounded border border-slate-700 bg-slate-950 p-2 font-mono text-slate-200"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Revised (HTML)
            <textarea
              value={revised}
              onChange={(e) => setRevised(e.target.value)}
              rows={6}
              className="rounded border border-slate-700 bg-slate-950 p-2 font-mono text-slate-200"
            />
          </label>
          <div className="md:col-span-2">
            <button
              type="button"
              onClick={() => {
                comparison.compare(original, revised);
                setComparing(false);
              }}
              className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500"
            >
              Compare into editor
            </button>
          </div>
        </div>
      )}
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
        <div className="flex flex-col gap-3">
          <TrackedChangesList
            editor={editor}
            className="flex flex-col gap-1 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-200"
          />
          <CommentsPanel
            editor={editor}
            className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-200"
          />
        </div>
      </div>
    </section>
  );
};
