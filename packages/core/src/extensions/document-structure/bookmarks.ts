import { Mark } from "@tiptap/core";
import { safeMergeAttributes } from "../safe-merge-attributes";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { generateStructureId, scrollDomAtPos } from "./utils";

/**
 * A bookmark as listed by `getBookmarks`.
 */
export interface BookmarkInfo {
  id: string;
  name: string;
  /** Bookmarked text (all ranges carrying the bookmark, in document order). */
  text: string;
  /** Start of the first bookmarked range. */
  from: number;
  /** End of the last bookmarked range. */
  to: number;
}

export interface BookmarkOptions {
  HTMLAttributes: Record<string, any>;
  /** Generates ids for new bookmarks. */
  generateId: () => string;
}

export interface SetBookmarkOptions {
  /** Display name. Setting a name that already exists moves that bookmark. */
  name: string;
  /** Explicit id; generated (or reused from a same-named bookmark) when omitted. */
  id?: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    bookmark: {
      /**
       * Bookmarks the selected text (or the word at the caret when the
       * selection is empty).
       */
      setBookmark: (options: SetBookmarkOptions) => ReturnType;
      /** Removes a bookmark (the text stays). */
      removeBookmark: (id: string) => ReturnType;
      /** Renames a bookmark. */
      renameBookmark: (id: string, name: string) => ReturnType;
      /** Selects a bookmark's text and scrolls to it. */
      goToBookmark: (id: string) => ReturnType;
    };
  }
}

const BOOKMARK = "bookmark";

/**
 * Lists the bookmarks in a document, merging the text nodes that carry each
 * bookmark into one entry.
 */
export function getBookmarks(doc: ProsemirrorNode): BookmarkInfo[] {
  const byId = new Map<string, BookmarkInfo>();
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== BOOKMARK || !mark.attrs.id) continue;
      const end = pos + node.nodeSize;
      const existing = byId.get(mark.attrs.id);
      if (existing) {
        // Separate ranges (e.g. split by an inline node) are joined by a space.
        existing.text += (existing.to === pos ? "" : " ") + node.text;
        existing.to = end;
      } else {
        byId.set(mark.attrs.id, {
          id: mark.attrs.id,
          name: mark.attrs.name ?? mark.attrs.id,
          text: node.text ?? "",
          from: pos,
          to: end,
        });
      }
    }
    return false;
  });
  return Array.from(byId.values());
}

function forEachBookmarkRange(
  doc: ProsemirrorNode,
  id: string,
  fn: (from: number, to: number, mark: any) => void,
) {
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find(
      (m) => m.type.name === BOOKMARK && m.attrs.id === id,
    );
    if (mark) fn(pos, pos + node.nodeSize, mark);
    return false;
  });
}

/**
 * Word-style bookmark: a named, non-inclusive mark over a text range. Several
 * bookmarks may overlap. Cross-references (`CrossReference`) can point to a
 * bookmark by id and display its current text.
 */
export const Bookmark = Mark.create<BookmarkOptions>({
  name: BOOKMARK,
  inclusive: false,
  excludes: "",
  spanning: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      generateId: () => generateStructureId("bm"),
    };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-bookmark-id"),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.id ? { "data-bookmark-id": attributes.id } : {},
      },
      name: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-bookmark-name"),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.name ? { "data-bookmark-name": attributes.name } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-bookmark-id]", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      safeMergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: "pixerate-bookmark",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setBookmark:
        ({ name, id }) =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.marks[BOOKMARK];
          if (!type || !name) return false;
          let { from, to } = state.selection;
          if (from === to) {
            // Expand an empty selection to the word around the caret.
            const { $from } = state.selection;
            const text = $from.parent.textBetween(0, $from.parent.content.size, undefined, "￼");
            let start = $from.parentOffset;
            let end = $from.parentOffset;
            while (start > 0 && /[\p{L}\p{N}_'-]/u.test(text[start - 1])) start--;
            while (end < text.length && /[\p{L}\p{N}_'-]/u.test(text[end])) end++;
            if (start === end) return false;
            from = $from.start() + start;
            to = $from.start() + end;
          }
          if (!dispatch) return true;

          // Reuse the id of an existing bookmark with this name, so moving a
          // bookmark keeps cross-references pointing at it.
          const sameName = getBookmarks(state.doc).find((b) => b.name === name);
          const bookmarkId = id ?? sameName?.id ?? this.options.generateId();
          if (sameName) {
            forEachBookmarkRange(tr.doc, sameName.id, (f, t, mark) =>
              tr.removeMark(f, t, mark),
            );
          }
          tr.addMark(from, to, type.create({ id: bookmarkId, name }));
          return true;
        },

      removeBookmark:
        (id) =>
        ({ state, tr, dispatch }) => {
          let found = false;
          forEachBookmarkRange(state.doc, id, (from, to, mark) => {
            found = true;
            if (dispatch) tr.removeMark(from, to, mark);
          });
          return found;
        },

      renameBookmark:
        (id, name) =>
        ({ state, tr, dispatch }) => {
          let found = false;
          forEachBookmarkRange(state.doc, id, (from, to, mark) => {
            found = true;
            if (dispatch) {
              tr.removeMark(from, to, mark);
              tr.addMark(from, to, mark.type.create({ ...mark.attrs, name }));
            }
          });
          return found;
        },

      goToBookmark:
        (id) =>
        ({ state, tr, dispatch, view }) => {
          const bookmark = getBookmarks(state.doc).find((b) => b.id === id);
          if (!bookmark) return false;
          if (dispatch) {
            tr.setSelection(TextSelection.create(tr.doc, bookmark.from, bookmark.to));
            tr.scrollIntoView();
            const domPos = state.doc.resolve(bookmark.from);
            scrollDomAtPos(view, domPos.before(domPos.depth));
          }
          return true;
        },
    };
  },
});
