import React from "react";
import {
  useEditor,
  EditorContent,
  BubbleMenu,
} from "@pixerate/editor-react";
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
} from "lucide-react";

export const RichDocumentTab: React.FC = () => {
  const editor = useEditor({
    content: `
      <h2>Welcome to Rich Text Document Editing</h2>
      <p>This editor demonstrates standard document rich text capabilities shared across React and Svelte packages.</p>
      <p>Try typing smilies like <code>:)</code> or <code>&lt;3</code> or <code>/shrug</code> to see auto-conversion!</p>
      <p>Hex colors like #ef4444 or #3b82f6 are highlighted automatically in real time.</p>
      <ul>
        <li>Interactive bubble menu on text selection</li>
        <li>Task lists and rich formatting</li>
      </ul>
    `,
    richTextOptions: {
      placeholder: "Write something extraordinary...",
      enableSmilies: true,
      enableColorHighlighter: true,
    },
    editorProps: {
      attributes: {
        class:
          "w-full bg-slate-900 border border-slate-800 rounded-lg p-6 font-sans text-sm leading-relaxed text-slate-100 min-h-[220px] focus:outline-none",
      },
    },
  });

  if (!editor) return null;

  return (
    <div className="space-y-4">
      {/* Editor Toolbar */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 flex flex-wrap items-center gap-1 shadow-md">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`p-2 rounded hover:bg-slate-800 transition-colors ${
            editor.isActive("bold") ? "bg-rose-500/20 text-rose-300" : "text-slate-400"
          }`}
          title="Bold"
        >
          <Bold className="w-4 h-4" />
        </button>

        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`p-2 rounded hover:bg-slate-800 transition-colors ${
            editor.isActive("italic") ? "bg-rose-500/20 text-rose-300" : "text-slate-400"
          }`}
          title="Italic"
        >
          <Italic className="w-4 h-4" />
        </button>

        <button
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={`p-2 rounded hover:bg-slate-800 transition-colors ${
            editor.isActive("underline") ? "bg-rose-500/20 text-rose-300" : "text-slate-400"
          }`}
          title="Underline"
        >
          <UnderlineIcon className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className={`p-2 rounded hover:bg-slate-800 transition-colors ${
            editor.isActive("heading", { level: 1 })
              ? "bg-rose-500/20 text-rose-300"
              : "text-slate-400"
          }`}
          title="Heading 1"
        >
          <Heading1 className="w-4 h-4" />
        </button>

        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={`p-2 rounded hover:bg-slate-800 transition-colors ${
            editor.isActive("heading", { level: 2 })
              ? "bg-rose-500/20 text-rose-300"
              : "text-slate-400"
          }`}
          title="Heading 2"
        >
          <Heading2 className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={`p-2 rounded hover:bg-slate-800 transition-colors ${
            editor.isActive("bulletList") ? "bg-rose-500/20 text-rose-300" : "text-slate-400"
          }`}
          title="Bullet List"
        >
          <List className="w-4 h-4" />
        </button>

        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={`p-2 rounded hover:bg-slate-800 transition-colors ${
            editor.isActive("orderedList") ? "bg-rose-500/20 text-rose-300" : "text-slate-400"
          }`}
          title="Ordered List"
        >
          <ListOrdered className="w-4 h-4" />
        </button>

        <button
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          className={`p-2 rounded hover:bg-slate-800 transition-colors ${
            editor.isActive("taskList") ? "bg-rose-500/20 text-rose-300" : "text-slate-400"
          }`}
          title="Task List"
        >
          <CheckSquare className="w-4 h-4" />
        </button>

        <div className="ml-auto flex items-center gap-3 text-xs text-slate-400">
          <span className="flex items-center gap-1">
            <Smile className="w-3.5 h-3.5 text-amber-400" /> Smilies active
          </span>
          <span className="flex items-center gap-1">
            <Palette className="w-3.5 h-3.5 text-blue-400" /> Color highlighter active
          </span>
        </div>
      </div>

      {/* Editor Content Area */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 shadow-xl relative">
        <BubbleMenu editor={editor} className="bg-slate-800 text-slate-100 border border-slate-700 shadow-xl rounded-md p-1 flex items-center gap-1">
          <button
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={`px-2 py-1 text-xs rounded hover:bg-slate-700 ${
              editor.isActive("bold") ? "font-bold text-rose-400" : ""
            }`}
          >
            Bold
          </button>
          <button
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={`px-2 py-1 text-xs rounded hover:bg-slate-700 ${
              editor.isActive("italic") ? "italic text-rose-400" : ""
            }`}
          >
            Italic
          </button>
          <button
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            className={`px-2 py-1 text-xs rounded hover:bg-slate-700 ${
              editor.isActive("underline") ? "underline text-rose-400" : ""
            }`}
          >
            Underline
          </button>
        </BubbleMenu>

        <EditorContent editor={editor} />
      </div>
    </div>
  );
};
