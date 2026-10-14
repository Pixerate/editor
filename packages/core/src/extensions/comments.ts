import { Mark, mergeAttributes, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProsemirrorNode, Mark as ProsemirrorMark } from "@tiptap/pm/model";
import {
  CommentStore,
  createReviewId,
  type CommentAnchor,
  type CommentStoreSnapshot,
  type ReviewAuthor,
} from "./comment-store";

export interface CommentsOptions {
  /**
   * The store holding the threads. Pass your own to share it with UI or to
   * persist it; otherwise one is created and exposed as
   * `editor.storage.comment.store`.
   */
  store: CommentStore | null;
  /** The current user, used as author of new comments. */
  author: ReviewAuthor | (() => ReviewAuthor);
  HTMLAttributes: Record<string, any>;
  /** Class for unresolved comment ranges (applied as a decoration). */
  commentClass: string;
  /** Extra class for the active thread's range. */
  activeClass: string;
  /** Class for resolved comment ranges. Empty hides them. */
  resolvedClass: string;
  /** Make the thread under the caret active when the selection moves. */
  activateOnSelection: boolean;
}

export interface CommentsStorage {
  store: CommentStore;
}

export interface AddCommentOptions {
  body?: string;
  id?: string;
  author?: ReviewAuthor;
}

export interface CommentRange {
  from: number;
  to: number;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    comment: {
      /**
       * Adds a comment thread on the current (non-empty) selection. The new
       * thread becomes active. An empty `body` creates a draft for the UI to
       * fill in.
       */
      addComment: (options?: AddCommentOptions) => ReturnType;
      /** Resolves (or re-opens with `false`) a thread. */
      resolveComment: (id: string, resolved?: boolean) => ReturnType;
      /** Removes the thread's mark from the document and deletes the thread. */
      deleteComment: (id: string) => ReturnType;
      setActiveComment: (id: string | null) => ReturnType;
      /** Selects the thread's text, scrolls to it and makes it active. */
      focusComment: (id: string) => ReturnType;
    };
  }
}

export const commentsPluginKey = new PluginKey("comments");

export const COMMENT_MARK_NAME = "comment";

/**
 * Returns every range covered by a `comment` mark, grouped by thread id and
 * merged where contiguous, in document order.
 */
export function findCommentRanges(doc: ProsemirrorNode): Map<string, CommentRange[]> {
  const result = new Map<string, CommentRange[]>();
  doc.descendants((node, pos) => {
    if (!node.isInline) return;
    node.marks.forEach((mark) => {
      if (mark.type.name !== COMMENT_MARK_NAME) return;
      const id = mark.attrs.commentId;
      if (!id) return;
      const ranges = result.get(id) ?? [];
      const last = ranges[ranges.length - 1];
      const end = pos + node.nodeSize;
      if (last && last.to === pos) {
        last.to = end;
      } else {
        ranges.push({ from: pos, to: end });
      }
      result.set(id, ranges);
    });
  });
  return result;
}

/**
 * Computes one anchor per thread (spanning all of its ranges) from the document.
 */
export function getCommentAnchors(doc: ProsemirrorNode): Map<string, CommentAnchor> {
  const anchors = new Map<string, CommentAnchor>();
  findCommentRanges(doc).forEach((ranges, id) => {
    const from = ranges[0].from;
    const to = ranges[ranges.length - 1].to;
    anchors.set(id, {
      from,
      to,
      quote: ranges.map((r) => doc.textBetween(r.from, r.to, " ", " ")).join(" "),
    });
  });
  return anchors;
}

/** Thread ids of the comment marks at a position (caret or selection start). */
export function getCommentIdsAt(state: EditorState, pos = state.selection.from): string[] {
  const $pos = state.doc.resolve(pos);
  const marks: readonly ProsemirrorMark[] = [
    ...($pos.nodeAfter?.marks ?? []),
    ...($pos.nodeBefore?.marks ?? []),
  ];
  const ids: string[] = [];
  marks.forEach((m) => {
    if (m.type.name === COMMENT_MARK_NAME && m.attrs.commentId && !ids.includes(m.attrs.commentId)) {
      ids.push(m.attrs.commentId);
    }
  });
  return ids;
}

/** Returns the comment store of an editor using the `Comments` extension. */
export function getCommentStore(editor: Editor | null | undefined): CommentStore | null {
  return (editor?.storage as any)?.[COMMENT_MARK_NAME]?.store ?? null;
}

function resolveAuthor(author: CommentsOptions["author"]): ReviewAuthor {
  return typeof author === "function" ? author() : author;
}

/**
 * Comment threads anchored to text with a `comment` mark. Thread content
 * (bodies, replies, resolved state) lives in a headless `CommentStore`; the
 * document only stores thread ids, so overlapping comments are allowed.
 *
 * Threads whose text is deleted are flagged `orphaned` (not removed), so
 * undoing the deletion re-attaches them.
 */
export const Comments = Mark.create<CommentsOptions, CommentsStorage>({
  name: COMMENT_MARK_NAME,

  // Typing at the edge of a comment does not extend it.
  inclusive: false,
  // Allow several comment marks (different threads) on the same text.
  excludes: "",

  addOptions() {
    return {
      store: null,
      author: { id: "anonymous", name: "Anonymous" },
      HTMLAttributes: {},
      commentClass:
        "pixerate-comment bg-amber-100 border-b-2 border-amber-400 dark:bg-amber-500/20 cursor-pointer",
      activeClass: "pixerate-comment-active bg-amber-200 dark:bg-amber-500/40",
      resolvedClass: "",
      activateOnSelection: true,
    };
  },

  addStorage() {
    return {
      store: this.options.store ?? new CommentStore(),
      // tiptap-markdown: comments are not part of the exported markdown.
      markdown: { serialize: { open: "", close: "" }, parse: {} },
    } as CommentsStorage;
  },

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-comment-id"),
        renderHTML: (attrs) =>
          attrs.commentId ? { "data-comment-id": attrs.commentId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addCommands() {
    const store = () => this.storage.store;
    return {
      addComment:
        (options = {}) =>
        ({ state, tr, dispatch }) => {
          const { from, to, empty } = state.selection;
          if (empty) return false;
          if (dispatch) {
            const id = options.id ?? createReviewId("comment");
            tr.addMark(from, to, this.type.create({ commentId: id }));
            tr.setMeta(commentsPluginKey, "refresh");
            store().createThread({
              id,
              body: options.body ?? "",
              author: options.author ?? resolveAuthor(this.options.author),
              anchor: { from, to, quote: state.doc.textBetween(from, to, " ", " ") },
            });
            store().setActiveThread(id);
          }
          return true;
        },

      resolveComment:
        (id, resolved = true) =>
        ({ tr, dispatch }) => {
          if (!store().getThread(id)) return false;
          if (dispatch) {
            store().resolveThread(id, resolved, resolveAuthor(this.options.author));
            tr.setMeta(commentsPluginKey, "refresh");
          }
          return true;
        },

      deleteComment:
        (id) =>
        ({ state, tr, dispatch }) => {
          const ranges = findCommentRanges(state.doc).get(id) ?? [];
          if (ranges.length === 0 && !store().getThread(id)) return false;
          if (dispatch) {
            ranges.forEach(({ from, to }) => {
              state.doc.nodesBetween(from, to, (node, pos) => {
                const mark = node.marks.find(
                  (m) => m.type === this.type && m.attrs.commentId === id,
                );
                if (mark) {
                  tr.removeMark(Math.max(pos, from), Math.min(pos + node.nodeSize, to), mark);
                }
              });
            });
            tr.setMeta(commentsPluginKey, "refresh");
            store().deleteThread(id);
          }
          return true;
        },

      setActiveComment:
        (id) =>
        ({ tr, dispatch }) => {
          if (id !== null && !store().getThread(id)) return false;
          if (dispatch) {
            store().setActiveThread(id);
            tr.setMeta(commentsPluginKey, "refresh");
          }
          return true;
        },

      focusComment:
        (id) =>
        ({ state, tr, dispatch }) => {
          const ranges = findCommentRanges(state.doc).get(id);
          if (!ranges || ranges.length === 0) return false;
          if (dispatch) {
            const from = ranges[0].from;
            const to = ranges[ranges.length - 1].to;
            tr.setSelection(TextSelection.create(tr.doc, from, to)).scrollIntoView();
            store().setActiveThread(id);
            tr.setMeta(commentsPluginKey, "refresh");
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const store = this.storage.store;
    const options = this.options;
    let cache: { doc: ProsemirrorNode; snapshot: CommentStoreSnapshot; set: DecorationSet } | null =
      null;

    const buildDecorations = (doc: ProsemirrorNode): DecorationSet => {
      const snapshot = store.getSnapshot();
      if (cache && cache.doc === doc && cache.snapshot === snapshot) return cache.set;
      const decorations: Decoration[] = [];
      findCommentRanges(doc).forEach((ranges, id) => {
        const thread = store.getThread(id);
        const resolved = thread?.resolved ?? false;
        const active = snapshot.activeThreadId === id;
        const cls = [
          resolved ? options.resolvedClass : options.commentClass,
          active ? options.activeClass : "",
        ]
          .filter(Boolean)
          .join(" ");
        if (!cls) return;
        ranges.forEach(({ from, to }) => {
          decorations.push(Decoration.inline(from, to, { class: cls }));
        });
      });
      const set = DecorationSet.create(doc, decorations);
      cache = { doc, snapshot, set };
      return set;
    };

    return [
      new Plugin({
        key: commentsPluginKey,
        props: {
          decorations: (state) => buildDecorations(state.doc),
        },
        view: (view) => {
          let destroyed = false;
          let scheduled = false;
          const sync = () => store.syncAnchors(getCommentAnchors(view.state.doc));
          sync();

          // Store changes made outside editor commands (UI, `load()`) need a
          // redraw. Deferred, because the store may change in the middle of a
          // command or a view update.
          const unsubscribe = store.subscribe(() => {
            if (scheduled) return;
            scheduled = true;
            queueMicrotask(() => {
              scheduled = false;
              if (destroyed) return;
              sync();
              if (cache?.snapshot !== store.getSnapshot()) {
                view.dispatch(
                  view.state.tr
                    .setMeta(commentsPluginKey, "refresh")
                    .setMeta("addToHistory", false),
                );
              }
            });
          });

          return {
            update(view, prevState) {
              if (!prevState.doc.eq(view.state.doc)) sync();
              if (
                options.activateOnSelection &&
                !prevState.selection.eq(view.state.selection)
              ) {
                const ids = getCommentIdsAt(view.state);
                const active = store.getSnapshot().activeThreadId;
                if (!active || !ids.includes(active)) {
                  store.setActiveThread(ids[0] ?? null);
                }
              }
            },
            destroy() {
              destroyed = true;
              unsubscribe();
            },
          };
        },
      }),
    ];
  },
});

/** The current author configured on an editor's `Comments` extension. */
export function getCommentAuthor(editor: Editor | null | undefined): ReviewAuthor | null {
  const ext = editor?.extensionManager?.extensions.find((e) => e.name === COMMENT_MARK_NAME);
  return ext ? resolveAuthor((ext.options as CommentsOptions).author) : null;
}
