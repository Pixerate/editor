import React, { useMemo, useState } from "react";
import {
  useEditor,
  EditorContent,
  BubbleMenu,
  OutlinePanel,
  useFileImport,
  useAgentToolProvider,
  FindReplaceBar,
  StylesGallery,
} from "@pixerate/editor-react";
import { getCrossReferenceTargets } from "@pixerate/editor";
import { createRichTextToolProvider } from "@pixerate/editor/agent";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  CheckSquare,
  Smile,
  Palette,
  ListTree,
  Superscript,
  Bookmark,
  Link2,
  Upload,
  Wand2,
  Search,
} from "lucide-react";
import { demoToolRegistry } from "../agentTools";
import { RichDocumentAutosave } from "./RichDocumentAutosave";
import { samplePdfFile, samplePdfRegistry } from "../samplePdf";

const INITIAL_CONTENT = `
  <h1 id="h-welcome">Welcome to Rich Text Document Editing</h1>
  <nav data-type="table-of-contents" data-title="Contents"></nav>
  <p>This editor demonstrates standard document rich text capabilities shared across React and Svelte packages.<sup data-type="footnote-reference" data-id="fn-demo"></sup></p>
  <h2 id="h-typing">Typing aids</h2>
  <p>Try typing smilies like <code>:)</code> or <code>&lt;3</code> or <code>/shrug</code> to see auto-conversion!</p>
  <p>Hex colors like #ef4444 or #3b82f6 are highlighted automatically in real time.</p>
  <p>Autocorrect is on: type <code>"quotes"</code>, <code>--</code>, <code>(c)</code>, <code>1/2</code> or start a sentence in lower case.</p>
  <h2 id="h-structure">Document structure</h2>
  <p>The <span data-bookmark-id="bm-demo" data-bookmark-name="structure-note">outline panel</span> on the left follows the headings. Insert a table of contents, footnotes, bookmarks and cross-references from the toolbar. This sentence refers back to <a data-type="cross-reference" data-target-type="bookmark" data-target-id="bm-demo"></a>.</p>
  <h3 id="h-lists">Lists</h3>
  <ul>
    <li>Interactive bubble menu on text selection</li>
    <li>Task lists and rich formatting</li>
  </ul>
  <h2 id="h-import">Import and clipboard</h2>
  <p>Drop a <code>.md</code>, <code>.html</code>, <code>.txt</code> or <code>.rtf</code> file onto the editor (it lands at the drop position) or use “Import file”. “Import sample PDF” runs PDF layout analysis (columns, headings, lists, tables, running headers) on a generated fixture; untick “Detect structure” for the plain fallback. Copy and paste keeps footnotes, bookmarks and cross-references intact between editors (rich clipboard).</p>
  <section data-type="footnotes"><ol><li data-type="footnote" data-id="fn-demo"><p>Footnotes are numbered automatically and listed at the end of the document.</p></li></ol></section>
`;

export const RichDocumentTab: React.FC = () => {
  const [corrections, setCorrections] = useState<string[]>([]);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [bookmarkName, setBookmarkName] = useState("");
  const [crossRefTarget, setCrossRefTarget] = useState("");

  const editor = useEditor({
    content: INITIAL_CONTENT,
    richTextOptions: {
      placeholder: "Write something extraordinary...",
      enableSmilies: true,
      enableColorHighlighter: true,
      outline: true,
      tableOfContents: true,
      footnotes: true,
      bookmarks: true,
      crossReferences: true,
      findReplace: true,
      paragraphStyles: true,
      autocorrect: {
        onCorrection: (c) =>
          setCorrections((prev) => [`${c.original} → ${c.replacement}`, ...prev].slice(0, 5)),
      },
    },
    fileImport: {
      onImport: (outcome, file) =>
        setImportMessage(`Imported ${file.name ?? "file"} with the ${outcome.adapterId} adapter.`),
      onImportError: (error, file) =>
        setImportMessage(`Could not import ${file.name ?? "file"}: ${error.message}`),
    },
    richClipboard: true,
    editorProps: {
      attributes: {
        class:
          "pixerate-doc w-full bg-slate-900 border border-slate-800 rounded-lg p-6 font-sans text-sm leading-relaxed text-slate-100 min-h-[220px] focus:outline-none",
      },
    },
  });

  const fileImport = useFileImport(editor, {
    onImport: (outcome, file) =>
      setImportMessage(`Imported ${file.name ?? "file"} with the ${outcome.adapterId} adapter.`),
  });

  // PDF structure detection on a generated two-page fixture (no pdf.js needed).
  const [detectPdfStructure, setDetectPdfStructure] = useState(true);
  const sampleImport = useFileImport(editor, {
    registry: samplePdfRegistry,
    adapterOptions: { pdf: { structure: detectPdfStructure } },
  });
  const pdfSummary = sampleImport.structureSummary;

  const provider = useMemo(
    () => (editor ? createRichTextToolProvider(editor, { id: "document", namespace: "doc" }) : null),
    [editor]
  );
  useAgentToolProvider(demoToolRegistry, provider);

  if (!editor) return null;

  const targets = getCrossReferenceTargets(editor.state.doc);
  const selectedTarget = targets.find((t) => `${t.type}:${t.id}` === crossRefTarget) ?? targets[0];

  const btn = (active = false) =>
    `p-2 rounded hover:bg-slate-800 transition-colors ${
      active ? "bg-rose-500/20 text-rose-300" : "text-slate-400"
    }`;

  return (
    <div className="space-y-4">
      <RichDocumentAutosave editor={editor} />
      {/* Editor Toolbar */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 flex flex-wrap items-center gap-1 shadow-md">
        <StylesGallery
          editor={editor}
          itemClassName="rounded px-2 py-1 text-left text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          activeItemClassName="bg-rose-500/20 text-rose-300"
        />

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <button onClick={() => editor.chain().focus().toggleBold().run()} className={btn(editor.isActive("bold"))} title="Bold">
          <Bold className="w-4 h-4" />
        </button>
        <button onClick={() => editor.chain().focus().toggleItalic().run()} className={btn(editor.isActive("italic"))} title="Italic">
          <Italic className="w-4 h-4" />
        </button>
        <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={btn(editor.isActive("underline"))} title="Underline">
          <UnderlineIcon className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={btn(editor.isActive("heading", { level: 1 }))} title="Heading 1">
          <Heading1 className="w-4 h-4" />
        </button>
        <button onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={btn(editor.isActive("heading", { level: 2 }))} title="Heading 2">
          <Heading2 className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={btn(editor.isActive("bulletList"))} title="Bullet List">
          <List className="w-4 h-4" />
        </button>
        <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={btn(editor.isActive("orderedList"))} title="Ordered List">
          <ListOrdered className="w-4 h-4" />
        </button>
        <button onClick={() => editor.chain().focus().toggleTaskList().run()} className={btn(editor.isActive("taskList"))} title="Task List">
          <CheckSquare className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <button onClick={() => editor.chain().focus().insertTableOfContents().run()} className={btn()} title="Insert table of contents">
          <ListTree className="w-4 h-4" />
        </button>
        <button onClick={() => editor.chain().focus().insertFootnote().run()} className={btn()} title="Insert footnote">
          <Superscript className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <button
          onClick={() => editor.chain().focus().openFindReplace({ mode: "replace" }).run()}
          className={btn()}
          title="Find and replace (Mod+F / Mod+H)"
        >
          <Search className="w-4 h-4" />
        </button>

        <div className="ml-auto flex items-center gap-3 text-xs text-slate-400">
          <span className="flex items-center gap-1">
            <Smile className="w-3.5 h-3.5 text-amber-400" /> Smilies
          </span>
          <span className="flex items-center gap-1">
            <Palette className="w-3.5 h-3.5 text-blue-400" /> Color highlighter
          </span>
          <span className="flex items-center gap-1">
            <Wand2 className="w-3.5 h-3.5 text-emerald-400" /> Autocorrect
          </span>
        </div>
      </div>

      {/* Bookmarks, cross-references and import */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 flex flex-wrap items-center gap-2 text-xs">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!bookmarkName.trim()) return;
            if (editor.chain().focus().setBookmark({ name: bookmarkName.trim() }).run()) {
              setBookmarkName("");
            }
          }}
        >
          <Bookmark className="w-3.5 h-3.5 text-amber-400" />
          <input
            value={bookmarkName}
            onChange={(e) => setBookmarkName(e.target.value)}
            placeholder="Bookmark name"
            aria-label="Bookmark name"
            className="w-36 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 focus:outline-none focus:ring-1 focus:ring-rose-500/50"
          />
          <button type="submit" className="px-2 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200">
            Bookmark selection
          </button>
        </form>

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <div className="flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5 text-sky-400" />
          <select
            value={selectedTarget ? `${selectedTarget.type}:${selectedTarget.id}` : ""}
            onChange={(e) => setCrossRefTarget(e.target.value)}
            aria-label="Cross-reference target"
            className="max-w-[14rem] bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200"
          >
            {targets.length === 0 && <option value="">No headings or bookmarks</option>}
            {targets.map((t) => (
              <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>
                {t.type === "heading" ? `H${t.level}: ${t.text}` : `Bookmark: ${t.name}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!selectedTarget}
            onClick={() =>
              selectedTarget &&
              editor
                .chain()
                .focus()
                .insertCrossReference({ targetType: selectedTarget.type, targetId: selectedTarget.id })
                .run()
            }
            className="px-2 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-50"
          >
            Insert cross-reference
          </button>
        </div>

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <button
          type="button"
          onClick={() => void fileImport.openFilePicker()}
          disabled={fileImport.isImporting}
          className="flex items-center gap-1.5 px-2 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-50"
          title={`Accepts ${fileImport.accept}`}
        >
          <Upload className="w-3.5 h-3.5" /> {fileImport.isImporting ? "Importing…" : "Import file"}
        </button>
        {(importMessage || fileImport.error) && (
          <span className={fileImport.error ? "text-red-400" : "text-emerald-300"} data-testid="import-status">
            {fileImport.error ? fileImport.error.message : importMessage}
          </span>
        )}
        <button
          type="button"
          onClick={() => void sampleImport.importFiles([samplePdfFile()])}
          disabled={sampleImport.isImporting}
          className="flex items-center gap-1.5 px-2 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-50"
          title="Imports a generated two-column PDF fixture through the PDF adapter"
        >
          <Upload className="w-3.5 h-3.5" /> Import sample PDF
        </button>
        <label className="flex items-center gap-1 text-slate-300">
          <input
            type="checkbox"
            checked={detectPdfStructure}
            onChange={(e) => setDetectPdfStructure(e.target.checked)}
          />
          Detect structure
        </label>
        {pdfSummary && (
          <span className="text-emerald-300" data-testid="pdf-structure-summary">
            {pdfSummary.mode === "plain"
              ? `Plain import: ${pdfSummary.paragraphs} paragraphs`
              : `${pdfSummary.headings} headings, ${pdfSummary.lists} lists, ${pdfSummary.tables} tables, ` +
                `${pdfSummary.multiColumnPages} multi-column page(s) · confidence ${Math.round(pdfSummary.confidence * 100)}%`}
          </span>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 h-fit md:sticky md:top-32 space-y-4">
          <OutlinePanel
            editor={editor}
            title={
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Outline
              </span>
            }
            className="flex flex-col gap-1 text-xs text-slate-300"
            itemClassName="w-full truncate rounded px-2 py-1 text-left hover:bg-slate-800"
            activeItemClassName="bg-rose-500/15 text-rose-300 font-semibold"
          />
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
              Autocorrections
            </div>
            {corrections.length === 0 ? (
              <div className="text-xs text-slate-500 italic">None yet</div>
            ) : (
              <ul className="text-xs font-mono text-emerald-300 space-y-0.5" data-testid="autocorrect-log">
                {corrections.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Editor Content Area */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 shadow-xl relative min-w-0">
          <BubbleMenu editor={editor} className="bg-slate-800 text-slate-100 border border-slate-700 shadow-xl rounded-md p-1 flex items-center gap-1">
            <button
              onClick={() => editor.chain().focus().toggleBold().run()}
              className={`px-2 py-1 text-xs rounded hover:bg-slate-700 ${editor.isActive("bold") ? "font-bold text-rose-400" : ""}`}
            >
              Bold
            </button>
            <button
              onClick={() => editor.chain().focus().toggleItalic().run()}
              className={`px-2 py-1 text-xs rounded hover:bg-slate-700 ${editor.isActive("italic") ? "italic text-rose-400" : ""}`}
            >
              Italic
            </button>
            <button
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              className={`px-2 py-1 text-xs rounded hover:bg-slate-700 ${editor.isActive("underline") ? "underline text-rose-400" : ""}`}
            >
              Underline
            </button>
          </BubbleMenu>

          <FindReplaceBar editor={editor} className="mb-3 flex flex-col gap-1 rounded-md border border-border bg-background p-1 text-sm shadow-sm" />
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
};
