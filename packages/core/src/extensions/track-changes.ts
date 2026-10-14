import { Extension, Mark, mergeAttributes, type Editor } from "@tiptap/core";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import {
  Fragment,
  Slice,
  type MarkType,
  type Node as ProsemirrorNode,
  type NodeType,
} from "@tiptap/pm/model";
import { Mapping, ReplaceStep, Transform, type StepMap } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { createReviewId, type ReviewAuthor } from "./comment-store";

export const INSERTION_MARK_NAME = "insertion";
export const DELETION_MARK_NAME = "deletion";

/**
 * Set this transaction meta to `true` to apply a change without tracking it,
 * e.g. `editor.chain().command(({ tr }) => { tr.setMeta(TRACK_CHANGES_SKIP_META, true); return true; }).setContent(…).run()`.
 */
export const TRACK_CHANGES_SKIP_META = "trackChangesSkip";

export type TrackedChangeType = "insertion" | "deletion";

/**
 * How tracked content is rendered by serializers:
 * - `accepted` (default): as if every change were accepted (deleted text is
 *   dropped, inserted text kept).
 * - `original`: as if every change were rejected.
 * - `all`: both inserted and deleted text.
 */
export type TrackedChangesView = "accepted" | "original" | "all";

export interface TrackedChangeAttributes {
  changeId: string;
  authorId: string;
  authorName: string;
  authorColor: string | null;
  createdAt: number;
}

export interface TrackedChange {
  id: string;
  type: TrackedChangeType;
  author: ReviewAuthor;
  createdAt: number;
  /** Start of the first range. */
  from: number;
  /** End of the last range. */
  to: number;
  /** A change can be split into several ranges by other marks or blocks. */
  ranges: { from: number; to: number }[];
  text: string;
}

export interface TrackChangesSnapshot {
  enabled: boolean;
  author: ReviewAuthor;
  /** Changes in document order. */
  changes: readonly TrackedChange[];
  /** The change at the selection, if any. */
  currentChangeId: string | null;
}

export interface TrackChangesOptions {
  /** Whether tracking is on when the editor is created. */
  enabled: boolean;
  author: ReviewAuthor;
  now: () => number;
  generateId: () => string;
  insertionHTMLAttributes: Record<string, any>;
  deletionHTMLAttributes: Record<string, any>;
}

/**
 * External store over the editor's tracked-change state. Snapshots only
 * change when the document, selection or tracking state changes, so they can
 * be used with `useSyncExternalStore`. `subscribe` calls the listener
 * immediately (Svelte store contract).
 */
export class TrackChangesStore {
  private snapshot: TrackChangesSnapshot;
  private listeners = new Set<(snapshot: TrackChangesSnapshot) => void>();

  constructor(initial: TrackChangesSnapshot) {
    this.snapshot = initial;
  }

  subscribe = (listener: (snapshot: TrackChangesSnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TrackChangesSnapshot => this.snapshot;

  /** @internal Called by the extension's plugin view. */
  set(snapshot: TrackChangesSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[TrackChangesStore] Error in listener:", err);
      }
    });
  }
}

export interface TrackChangesStorage {
  store: TrackChangesStore;
}

interface TrackChangesPluginState {
  enabled: boolean;
  author: ReviewAuthor;
}

type TrackChangesMeta =
  | { type: "setEnabled"; enabled: boolean }
  | { type: "setAuthor"; author: ReviewAuthor };

export const trackChangesPluginKey = new PluginKey<TrackChangesPluginState>("trackChanges");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    trackChanges: {
      setTrackChanges: (enabled: boolean) => ReturnType;
      toggleTrackChanges: () => ReturnType;
      setTrackChangesAuthor: (author: ReviewAuthor) => ReturnType;
      /** Accepts one change (single undo step). */
      acceptChange: (id: string) => ReturnType;
      /** Rejects one change (single undo step). */
      rejectChange: (id: string) => ReturnType;
      acceptAllChanges: () => ReturnType;
      rejectAllChanges: () => ReturnType;
      /** Selects the next change after the selection, wrapping around. */
      selectNextChange: () => ReturnType;
      /** Selects the previous change before the selection, wrapping around. */
      selectPreviousChange: () => ReturnType;
    };
  }
}

function changeAttributes(mark: { attrs: Record<string, any> }): TrackedChangeAttributes {
  return mark.attrs as TrackedChangeAttributes;
}

const sharedAttributes = () => ({
  changeId: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-change-id"),
    renderHTML: (attrs: any) => ({ "data-change-id": attrs.changeId }),
  },
  authorId: {
    default: "",
    parseHTML: (el: HTMLElement) => el.getAttribute("data-author-id") ?? "",
    renderHTML: (attrs: any) => ({ "data-author-id": attrs.authorId }),
  },
  authorName: {
    default: "",
    parseHTML: (el: HTMLElement) => el.getAttribute("data-author-name") ?? "",
    renderHTML: (attrs: any) => ({ "data-author-name": attrs.authorName }),
  },
  authorColor: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-author-color"),
    renderHTML: (attrs: any) =>
      attrs.authorColor ? { "data-author-color": attrs.authorColor } : {},
  },
  createdAt: {
    default: 0,
    parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-created-at") ?? 0),
    renderHTML: (attrs: any) => ({ "data-created-at": String(attrs.createdAt) }),
  },
});

/**
 * Text inserted while tracking was on. Rendered as `<ins>`.
 */
export const TrackedInsertion = Mark.create<{ HTMLAttributes: Record<string, any> }>({
  name: INSERTION_MARK_NAME,
  inclusive: false,
  addOptions() {
    return {
      HTMLAttributes: {
        class:
          "pixerate-insertion underline decoration-emerald-500 text-emerald-700 dark:text-emerald-400",
      },
    };
  },
  addStorage() {
    // tiptap-markdown: inserted text is exported as plain text.
    return { markdown: { serialize: { open: "", close: "" }, parse: {} } };
  },
  addAttributes: sharedAttributes,
  parseHTML() {
    return [{ tag: 'ins[data-change-type="insertion"]', priority: 100 }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "ins",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-change-type": "insertion",
      }),
      0,
    ];
  },
});

/**
 * Text deleted while tracking was on. The text stays in the document until
 * the change is accepted. Rendered as `<del>` (struck through).
 */
export const TrackedDeletion = Mark.create<{ HTMLAttributes: Record<string, any> }>({
  name: DELETION_MARK_NAME,
  inclusive: false,
  addOptions() {
    return {
      HTMLAttributes: {
        class:
          "pixerate-deletion line-through decoration-red-500 text-red-600 dark:text-red-400",
      },
    };
  },
  addStorage() {
    // Only reached when serializing a document that still has deletions
    // (`getEditorMarkdown(editor, { trackedChanges: "all" })`).
    return {
      markdown: {
        serialize: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
        parse: {},
      },
    };
  },
  addAttributes: sharedAttributes,
  parseHTML() {
    // Higher priority than Strike, which also parses `<del>`.
    return [{ tag: 'del[data-change-type="deletion"]', priority: 100 }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "del",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-change-type": "deletion",
      }),
      0,
    ];
  },
});

function toDoc(source: any): ProsemirrorNode | null {
  if (!source) return null;
  if (source.state?.doc) return source.state.doc;
  if (source.doc && typeof source.doc.descendants === "function") return source.doc;
  if (typeof source.descendants === "function") return source;
  return null;
}

/**
 * Lists tracked changes in document order. Accepts an editor, an editor
 * state or a ProseMirror document.
 */
export function getTrackedChanges(
  source: Editor | EditorState | ProsemirrorNode | null | undefined,
): TrackedChange[] {
  const doc = toDoc(source);
  if (!doc) return [];
  const byKey = new Map<string, TrackedChange>();
  doc.descendants((node, pos) => {
    if (!node.isInline) return;
    node.marks.forEach((mark) => {
      const type = mark.type.name;
      if (type !== INSERTION_MARK_NAME && type !== DELETION_MARK_NAME) return;
      const attrs = changeAttributes(mark);
      if (!attrs.changeId) return;
      const key = `${type}:${attrs.changeId}`;
      const end = pos + node.nodeSize;
      const text = node.isText ? node.text ?? "" : "";
      let change = byKey.get(key);
      if (!change) {
        change = {
          id: attrs.changeId,
          type: type as TrackedChangeType,
          author: {
            id: attrs.authorId,
            name: attrs.authorName,
            ...(attrs.authorColor ? { color: attrs.authorColor } : {}),
          },
          createdAt: attrs.createdAt,
          from: pos,
          to: end,
          ranges: [],
          text: "",
        };
        byKey.set(key, change);
      }
      const last = change.ranges[change.ranges.length - 1];
      if (last && last.to === pos) {
        last.to = end;
      } else {
        change.ranges.push({ from: pos, to: end });
      }
      change.to = end;
      change.text += text;
    });
  });
  return Array.from(byKey.values()).sort((a, b) => a.from - b.from || a.to - b.to);
}

/** The change containing `pos` (defaults to the selection start). */
export function getTrackedChangeAt(
  state: EditorState,
  pos: number = state.selection.from,
  changes: readonly TrackedChange[] = getTrackedChanges(state.doc),
): TrackedChange | null {
  const { from, to } = state.selection;
  // A selection exactly covering a change (e.g. after selectNextChange).
  const exact = changes.find((c) => c.from === from && c.to === to);
  if (exact) return exact;
  return (
    changes.find((c) => c.ranges.some((r) => r.from < pos && pos < r.to)) ??
    changes.find((c) => c.ranges.some((r) => r.from <= pos && pos <= r.to)) ??
    null
  );
}

export function isTrackChangesEnabled(source: Editor | EditorState | null | undefined): boolean {
  const state: EditorState | undefined = (source as any)?.state ?? (source as any);
  if (!state || typeof (state as any).plugins === "undefined") return false;
  return trackChangesPluginKey.getState(state)?.enabled ?? false;
}

/** Returns the tracked-changes store of an editor using `TrackChanges`. */
export function getTrackChangesStore(editor: Editor | null | undefined): TrackChangesStore | null {
  return (editor?.storage as any)?.trackChanges?.store ?? null;
}

/**
 * Accepts or rejects changes on a transform. Inline marks are removed first,
 * then text is deleted from the end of the document backwards so positions
 * stay valid.
 */
function applyDecision(
  tr: Transform,
  changes: readonly TrackedChange[],
  decision: "accept" | "reject",
): void {
  const schema = tr.doc.type.schema;
  const deletions: { from: number; to: number }[] = [];
  changes.forEach((change) => {
    const markType = schema.marks[change.type];
    if (!markType) return;
    const keep = (change.type === "insertion") === (decision === "accept");
    change.ranges.forEach(({ from, to }) => {
      if (keep) {
        tr.removeMark(from, to, markType);
      } else {
        deletions.push({ from, to });
      }
    });
  });
  deletions
    .sort((a, b) => b.from - a.from)
    .forEach(({ from, to }) => {
      tr.delete(tr.mapping.map(from), tr.mapping.map(to));
    });
}

/**
 * Returns a copy of `doc` with tracked changes resolved for `view`
 * (`accepted` by default). The input document is not modified.
 */
export function resolveTrackedChanges(
  doc: ProsemirrorNode,
  view: TrackedChangesView = "accepted",
): ProsemirrorNode {
  if (view === "all") return doc;
  const changes = getTrackedChanges(doc);
  if (changes.length === 0) return doc;
  const tr = new Transform(doc);
  applyDecision(tr, changes, view === "accepted" ? "accept" : "reject");
  return tr.doc;
}

function hasInlineContent(fragment: Fragment): boolean {
  let found = false;
  fragment.descendants((node) => {
    if (found) return false;
    if (node.isInline) found = true;
    return !found;
  });
  return found;
}

/**
 * Removes deleted text and insertion marks from a slice (used for paste), so
 * pasting tracked content pastes it as if all changes were accepted.
 */
function acceptSlice(slice: Slice, insertion?: MarkType, deletion?: MarkType): Slice {
  if (!insertion && !deletion) return slice;
  const mapFragment = (fragment: Fragment): Fragment => {
    const children: ProsemirrorNode[] = [];
    fragment.forEach((child) => {
      if (child.isInline) {
        if (deletion && deletion.isInSet(child.marks)) return;
        children.push(insertion ? child.mark(insertion.removeFromSet(child.marks)) : child);
      } else {
        children.push(child.copy(mapFragment(child.content)));
      }
    });
    return Fragment.from(children);
  };
  return new Slice(mapFragment(slice.content), slice.openStart, slice.openEnd);
}

interface TrackContext {
  author: ReviewAuthor;
  now: () => number;
  generateId: () => string;
  insertion: MarkType;
  deletion: MarkType;
}

function newAttributes(ctx: TrackContext): TrackedChangeAttributes {
  return {
    changeId: ctx.generateId(),
    authorId: ctx.author.id,
    authorName: ctx.author.name,
    authorColor: ctx.author.color ?? null,
    createdAt: ctx.now(),
  };
}

/**
 * Reuses the attributes of an adjacent change of the same type by the same
 * author, so typing (or backspacing) a word produces one change, not one per
 * character.
 */
function adjacentAttributes(
  doc: ProsemirrorNode,
  from: number,
  to: number,
  type: MarkType,
  ctx: TrackContext,
): TrackedChangeAttributes | null {
  const candidates = [doc.resolve(from).nodeBefore, doc.resolve(to).nodeAfter];
  for (const node of candidates) {
    const mark = node && type.isInSet(node.marks);
    if (mark && mark.attrs.authorId === ctx.author.id && mark.attrs.changeId) {
      return changeAttributes(mark);
    }
  }
  return null;
}

/**
 * Marks deleted content with the deletion mark so it can be put back.
 * Text inserted by the same author (an untracked-in-effect draft) is dropped,
 * i.e. really deleted. Returns `null` if the slice holds content that cannot
 * carry the mark (e.g. code blocks), in which case the deletion is not
 * tracked.
 */
function markDeletedSlice(
  slice: Slice,
  parentType: NodeType,
  attrs: TrackedChangeAttributes,
  ctx: TrackContext,
): { slice: Slice; hasContent: boolean } | null {
  let ok = true;
  let hasContent = false;
  const deletionMark = ctx.deletion.create(attrs);
  const mapFragment = (fragment: Fragment, parent: NodeType): Fragment => {
    const children: ProsemirrorNode[] = [];
    fragment.forEach((child) => {
      if (child.isInline) {
        const insertion = ctx.insertion.isInSet(child.marks);
        if (insertion && insertion.attrs.authorId === ctx.author.id) return;
        hasContent = true;
        if (ctx.deletion.isInSet(child.marks)) {
          children.push(child);
          return;
        }
        if (!parent.allowsMarkType(ctx.deletion)) {
          ok = false;
          children.push(child);
          return;
        }
        children.push(child.mark(deletionMark.addToSet(child.marks)));
      } else {
        children.push(child.copy(mapFragment(child.content, child.type)));
      }
    });
    return Fragment.from(children);
  };
  const content = mapFragment(slice.content, parentType);
  if (!ok) return null;
  return { slice: new Slice(content, slice.openStart, slice.openEnd), hasContent };
}

function shouldSkip(tr: Transaction): boolean {
  return (
    !tr.docChanged ||
    tr.getMeta(TRACK_CHANGES_SKIP_META) === true ||
    !!tr.getMeta(trackChangesPluginKey) ||
    // Undo/redo replays already-tracked history.
    !!tr.getMeta("history$") ||
    // Remote collaborative changes were tracked by their author.
    !!tr.getMeta("y-sync$") ||
    // Housekeeping appended by other plugins (e.g. trailing nodes).
    !!tr.getMeta("appendedTransaction")
  );
}

interface PendingRestore {
  pos: number;
  slice: Slice;
  parentType: NodeType;
  /** Nothing was inserted in place of the deleted content. */
  pureDelete: boolean;
  backspace: boolean;
}

/**
 * Builds a transaction that turns the user's raw edits into tracked changes:
 * inserted content gets the insertion mark, deleted content is put back with
 * the deletion mark. Block structure changes (splitting/joining paragraphs,
 * wrapping, lifting) and formatting changes are not tracked.
 */
function trackTransactions(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  ctx: TrackContext,
): Transaction | null {
  const maps: StepMap[] = [];
  transactions.forEach((t) => maps.push(...(t.mapping.maps as StepMap[])));

  const inserted: { from: number; to: number }[] = [];
  const restores: PendingRestore[] = [];
  let mapIndex = 0;
  const single =
    transactions.length === 1 && transactions[0].steps.length === 1;

  transactions.forEach((t) => {
    const skip = shouldSkip(t);
    t.steps.forEach((step, i) => {
      const index = mapIndex + i;
      if (skip || !(step instanceof ReplaceStep)) return;
      const { from, to, slice } = step as unknown as { from: number; to: number; slice: Slice };
      const rest = new Mapping(maps.slice(index + 1));
      if (slice.size > 0 && hasInlineContent(slice.content)) {
        const start = rest.map(from, 1);
        const end = rest.map(from + slice.size, -1);
        if (end > start) inserted.push({ from: start, to: end });
      }
      if (to > from) {
        const docBefore = t.docs[i];
        const deleted = docBefore.slice(from, to);
        if (!hasInlineContent(deleted.content)) return;
        const $from = docBefore.resolve(from);
        const before = i === 0 ? t.before : null;
        const sel = before === oldState.doc ? oldState.selection : null;
        restores.push({
          pos: rest.map(from, -1),
          slice: deleted,
          parentType: $from.node(Math.max(0, $from.depth - deleted.openStart)).type,
          pureDelete: slice.size === 0,
          backspace:
            single && slice.size === 0 && !!sel && sel.empty && sel.from === to,
        });
      }
    });
    mapIndex += t.steps.length;
  });

  if (inserted.length === 0 && restores.length === 0) return null;

  const tr = newState.tr;
  let changed = false;

  inserted.forEach(({ from, to }) => {
    tr.removeMark(from, to, ctx.deletion);
    tr.removeMark(from, to, ctx.insertion);
    const attrs = adjacentAttributes(tr.doc, from, to, ctx.insertion, ctx) ?? newAttributes(ctx);
    tr.addMark(from, to, ctx.insertion.create(attrs));
    changed = true;
  });

  let cursor: number | null = null;
  restores
    .sort((a, b) => b.pos - a.pos)
    .forEach((restore) => {
      const pos = tr.mapping.map(restore.pos, -1);
      const attrs = adjacentAttributes(tr.doc, pos, pos, ctx.deletion, ctx) ?? newAttributes(ctx);
      const marked = markDeletedSlice(restore.slice, restore.parentType, attrs, ctx);
      if (!marked || !marked.hasContent) return;
      const sizeBefore = tr.doc.content.size;
      try {
        tr.replace(pos, pos, marked.slice);
      } catch {
        return;
      }
      changed = true;
      // Backspace leaves the caret before the struck-through text so the
      // next Backspace continues backwards; Delete leaves it after.
      if (restores.length === 1 && restore.pureDelete && newState.selection.empty) {
        cursor = restore.backspace ? pos : pos + (tr.doc.content.size - sizeBefore);
      }
    });

  if (!changed) return null;
  if (cursor !== null) {
    try {
      tr.setSelection(TextSelection.create(tr.doc, cursor));
    } catch {
      // Keep the mapped selection.
    }
  }
  tr.setMeta(TRACK_CHANGES_SKIP_META, true);
  return tr;
}

function buildSnapshot(state: EditorState, author: ReviewAuthor): TrackChangesSnapshot {
  const plugin = trackChangesPluginKey.getState(state);
  const changes = getTrackedChanges(state.doc);
  return {
    enabled: plugin?.enabled ?? false,
    author: plugin?.author ?? author,
    changes,
    currentChangeId: getTrackedChangeAt(state, state.selection.from, changes)?.id ?? null,
  };
}

/**
 * Suggestion mode / track changes. When enabled, typed and pasted content is
 * marked as an insertion and deleted content is kept but marked as a
 * deletion (struck through) until the change is accepted or rejected.
 *
 * Deleting your own insertion really deletes it. Formatting-only changes and
 * block-structure changes (splitting/joining paragraphs, lists) are not
 * tracked. IME composition is tracked once the composition ends.
 */
export const TrackChanges = Extension.create<TrackChangesOptions, TrackChangesStorage>({
  name: "trackChanges",

  addOptions() {
    return {
      enabled: false,
      author: { id: "anonymous", name: "Anonymous" },
      now: () => Date.now(),
      generateId: () => createReviewId("change"),
      insertionHTMLAttributes: {},
      deletionHTMLAttributes: {},
    };
  },

  addStorage() {
    return {
      store: new TrackChangesStore({
        enabled: this.options.enabled,
        author: this.options.author,
        changes: [],
        currentChangeId: null,
      }),
    };
  },

  addExtensions() {
    const insertionAttrs = this.options?.insertionHTMLAttributes ?? {};
    const deletionAttrs = this.options?.deletionHTMLAttributes ?? {};
    return [
      Object.keys(insertionAttrs).length
        ? TrackedInsertion.configure({ HTMLAttributes: insertionAttrs })
        : TrackedInsertion,
      Object.keys(deletionAttrs).length
        ? TrackedDeletion.configure({ HTMLAttributes: deletionAttrs })
        : TrackedDeletion,
    ];
  },

  addCommands() {
    const decide =
      (decision: "accept" | "reject", id: string | null) =>
      ({ state, tr, dispatch }: { state: EditorState; tr: Transaction; dispatch?: any }) => {
        const all = getTrackedChanges(state.doc);
        const changes = id === null ? all : all.filter((c) => c.id === id);
        if (changes.length === 0) return false;
        if (dispatch) {
          applyDecision(tr, changes, decision);
          tr.setMeta(TRACK_CHANGES_SKIP_META, true);
        }
        return true;
      };

    const select =
      (direction: 1 | -1) =>
      ({ state, tr, dispatch }: { state: EditorState; tr: Transaction; dispatch?: any }) => {
        const changes = getTrackedChanges(state.doc);
        if (changes.length === 0) return false;
        const { from } = state.selection;
        const target =
          direction === 1
            ? changes.find((c) => c.from > from) ?? changes[0]
            : [...changes].reverse().find((c) => c.from < from) ?? changes[changes.length - 1];
        if (dispatch) {
          tr.setSelection(TextSelection.create(tr.doc, target.from, target.to)).scrollIntoView();
        }
        return true;
      };

    return {
      setTrackChanges:
        (enabled) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(trackChangesPluginKey, { type: "setEnabled", enabled });
            tr.setMeta("addToHistory", false);
          }
          return true;
        },
      toggleTrackChanges:
        () =>
        ({ state, commands }) =>
          commands.setTrackChanges(!isTrackChangesEnabled(state)),
      setTrackChangesAuthor:
        (author) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(trackChangesPluginKey, { type: "setAuthor", author });
            tr.setMeta("addToHistory", false);
          }
          return true;
        },
      acceptChange: (id) => decide("accept", id),
      rejectChange: (id) => decide("reject", id),
      acceptAllChanges: () => decide("accept", null),
      rejectAllChanges: () => decide("reject", null),
      selectNextChange: () => select(1),
      selectPreviousChange: () => select(-1),
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const store = this.storage.store;
    let editorView: EditorView | null = null;
    // Transactions applied during IME composition. Changing the document
    // around the composition would break the IME, so they are tracked
    // together once it ends.
    let pending: { oldState: EditorState; transactions: Transaction[] } | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleFlush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const view = editorView;
        if (!view || !pending) return;
        if (view.composing) {
          scheduleFlush();
          return;
        }
        view.dispatch(view.state.tr.setMeta("trackChangesFlush", true));
      }, 0);
    };

    return [
      new Plugin<TrackChangesPluginState>({
        key: trackChangesPluginKey,
        state: {
          init: () => ({ enabled: options.enabled, author: options.author }),
          apply: (tr, value) => {
            const meta = tr.getMeta(trackChangesPluginKey) as TrackChangesMeta | undefined;
            if (!meta) return value;
            if (meta.type === "setEnabled") {
              return meta.enabled === value.enabled ? value : { ...value, enabled: meta.enabled };
            }
            return { ...value, author: meta.author };
          },
        },
        appendTransaction: (transactions, oldState, newState) => {
          const plugin = trackChangesPluginKey.getState(oldState);
          const tracking = !!plugin?.enabled;
          if (!tracking && !pending) return null;

          if (editorView?.composing && transactions.some((t) => t.docChanged)) {
            if (tracking) {
              if (!pending) pending = { oldState, transactions: [] };
              pending.transactions.push(...transactions);
            }
            return null;
          }

          let trs: readonly Transaction[] = transactions;
          let fromState = oldState;
          if (pending) {
            trs = [...pending.transactions, ...transactions];
            fromState = pending.oldState;
            pending = null;
          }
          if (!tracking && trs === transactions) return null;
          const author = plugin?.author ?? options.author;
          return trackTransactions(trs, fromState, newState, {
            author,
            now: options.now,
            generateId: options.generateId,
            insertion: newState.schema.marks[INSERTION_MARK_NAME],
            deletion: newState.schema.marks[DELETION_MARK_NAME],
          });
        },
        props: {
          transformPasted: (slice, view) =>
            acceptSlice(
              slice,
              view.state.schema.marks[INSERTION_MARK_NAME],
              view.state.schema.marks[DELETION_MARK_NAME],
            ),
          handleDOMEvents: {
            compositionend: () => {
              if (pending) scheduleFlush();
              return false;
            },
          },
        },
        view: (view) => {
          editorView = view;
          store.set(buildSnapshot(view.state, options.author));
          return {
            update(view, prevState) {
              if (
                prevState.doc !== view.state.doc ||
                !prevState.selection.eq(view.state.selection) ||
                trackChangesPluginKey.getState(prevState) !==
                  trackChangesPluginKey.getState(view.state)
              ) {
                store.set(buildSnapshot(view.state, options.author));
              }
              if (pending && !view.composing) scheduleFlush();
            },
            destroy() {
              editorView = null;
              pending = null;
              if (flushTimer) clearTimeout(flushTimer);
            },
          };
        },
      }),
    ];
  },
});
