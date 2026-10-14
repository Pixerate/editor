import type { Editor } from "@tiptap/core";
import type { CrossReferenceTargetType } from "./cross-reference";

export interface DocumentStructureCommandArgs {
  /** Range to delete first, e.g. the `/toc` text matched by `SlashCommands`. */
  range?: { from: number; to: number };
  /** Bookmark name (bookmark item). */
  name?: string;
  /** Footnote text (footnote item). */
  content?: string;
  /** Cross-reference target (cross-reference item). */
  targetType?: CrossReferenceTargetType;
  targetId?: string;
}

/**
 * A framework-agnostic menu entry for slash menus and toolbars.
 */
export interface DocumentStructureCommandItem {
  id: "table-of-contents" | "footnote" | "bookmark" | "cross-reference";
  title: string;
  description: string;
  keywords: string[];
  /** Name of the extension that must be installed for the item to work. */
  extension: string;
  /**
   * Input the host UI must collect before calling `run`: a bookmark name, or
   * a cross-reference target (see `getCrossReferenceTargets`).
   */
  requires?: "name" | "target";
  run: (editor: Editor, args?: DocumentStructureCommandArgs) => boolean;
}

const start = (editor: Editor, args?: DocumentStructureCommandArgs) => {
  const chain = editor.chain().focus();
  return args?.range ? chain.deleteRange(args.range) : chain;
};

/**
 * Menu entries for the document-structure commands.
 */
export const documentStructureCommandItems: DocumentStructureCommandItem[] = [
  {
    id: "table-of-contents",
    title: "Table of contents",
    description: "Insert a linked list of the document's headings",
    keywords: ["toc", "contents", "outline", "index"],
    extension: "tableOfContents",
    run: (editor, args) => start(editor, args).insertTableOfContents().run(),
  },
  {
    id: "footnote",
    title: "Footnote",
    description: "Insert a numbered footnote",
    keywords: ["footnote", "note", "fn", "citation"],
    extension: "footnoteReference",
    run: (editor, args) =>
      start(editor, args).insertFootnote({ content: args?.content }).run(),
  },
  {
    id: "bookmark",
    title: "Bookmark",
    description: "Name the selected text or word so it can be referenced",
    keywords: ["bookmark", "anchor", "name"],
    extension: "bookmark",
    requires: "name",
    run: (editor, args) =>
      !!args?.name && start(editor, args).setBookmark({ name: args.name }).run(),
  },
  {
    id: "cross-reference",
    title: "Cross-reference",
    description: "Insert a live reference to a heading or bookmark",
    keywords: ["cross", "reference", "xref", "link", "ref"],
    extension: "crossReference",
    requires: "target",
    run: (editor, args) =>
      !!args?.targetType &&
      !!args.targetId &&
      start(editor, args)
        .insertCrossReference({ targetType: args.targetType, targetId: args.targetId })
        .run(),
  },
];

/**
 * Returns the document-structure items whose extension is installed in the
 * editor, optionally filtered by a slash-command query.
 */
export function getDocumentStructureCommandItems(
  editor: Editor | null | undefined,
  query = "",
): DocumentStructureCommandItem[] {
  if (!editor) return [];
  const installed = new Set(
    editor.extensionManager.extensions.map((extension) => extension.name),
  );
  const q = query.trim().toLowerCase();
  return documentStructureCommandItems.filter(
    (item) =>
      installed.has(item.extension) &&
      (!q ||
        item.title.toLowerCase().includes(q) ||
        item.keywords.some((k) => k.startsWith(q))),
  );
}
