// Portions ported from wordcraft/crates/engine/src/cmd/moves.rs and wordcraft/crates/engine/src/cmd/review.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { Extension, Mark, type Editor } from "@tiptap/core";
import { safeMergeAttributes } from "./safe-merge-attributes";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import {
  Fragment,
  Mark as ProsemirrorMark,
  NodeRange,
  Slice,
  type ResolvedPos,
  type MarkType,
  type Node as ProsemirrorNode,
  type NodeType,
  type Schema,
} from "@tiptap/pm/model";
import {
  AddMarkStep,
  AttrStep,
  Mapping,
  RemoveMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  Transform,
  canJoin,
  liftTarget,
  type StepMap,
} from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { createReviewId, type ReviewAuthor } from "./comment-store";

export const INSERTION_MARK_NAME = "insertion";
export const DELETION_MARK_NAME = "deletion";
/** Mark recording a tracked formatting change (mark added/removed on existing text). */
export const FORMAT_CHANGE_MARK_NAME = "formatChange";
/** Node attribute recording a tracked block change (type, attributes or wrapping). */
export const BLOCK_CHANGE_ATTRIBUTE = "blockChange";
/**
 * Attribute of the insertion and deletion marks linking the two ends of a
 * tracked move: the deletion is where the text moved from, the insertion
 * where it moved to. Serialized as `data-move-id`.
 */
export const MOVE_ID_ATTRIBUTE = "moveId";

/**
 * Marks that are never treated as formatting: the review marks themselves,
 * comments (`comment`) and bookmarks (`bookmark`). Names are used instead of
 * imports to avoid module cycles.
 */
const REVIEW_MARK_NAMES = new Set([
  INSERTION_MARK_NAME,
  DELETION_MARK_NAME,
  FORMAT_CHANGE_MARK_NAME,
  "comment",
  "bookmark",
]);

/**
 * Set this transaction meta to `true` to apply a change without tracking it,
 * e.g. `editor.chain().command(({ tr }) => { tr.setMeta(TRACK_CHANGES_SKIP_META, true); return true; }).setContent(…).run()`.
 */
export const TRACK_CHANGES_SKIP_META = "trackChangesSkip";

export type TrackedChangeType = "insertion" | "deletion" | "format" | "block" | "move";

/**
 * How tracked content is rendered by serializers:
 * - `accepted` (default): as if every change were accepted (deleted text is
 *   dropped, inserted text kept, new formatting and block types kept).
 * - `original`: as if every change were rejected.
 * - `all`: both inserted and deleted text, current formatting and blocks.
 */
export type TrackedChangesView = "accepted" | "original" | "all";

export interface TrackedChangeAttributes {
  changeId: string;
  authorId: string;
  authorName: string;
  authorColor: string | null;
  createdAt: number;
  /**
   * Insertion/deletion marks only: links a deletion (moved from) and an
   * insertion (moved to) into one tracked move.
   */
  moveId?: string | null;
}

/** A serializable mark (`mark.toJSON()`). */
export interface TrackedMark {
  type: string;
  attrs?: Record<string, any>;
}

/** Attributes of the `formatChange` mark. */
export interface TrackedFormatChangeAttributes extends TrackedChangeAttributes {
  /** Formatting marks before the change. */
  before: TrackedMark[];
  /** Formatting marks after the change. */
  after: TrackedMark[];
}

/** A textblock's type, attributes and enclosing wrappers (lists, quotes). */
export interface TrackedBlockSnapshot {
  type: string;
  attrs: Record<string, any>;
  /** Ancestors from the outermost (below the document) to the parent. */
  wrappers: { type: string; attrs: Record<string, any> }[];
}

/**
 * Whole-block operation of a `blockChange` record: the block was inserted
 * (rejecting removes it) or deleted (accepting removes it). Produced by
 * `compareDocuments`; absent for type/attribute/wrapping changes.
 */
export type TrackedBlockOperation = "insert" | "delete";

/** Value of the `blockChange` node attribute. */
export interface TrackedBlockChangeAttributes extends TrackedChangeAttributes {
  previous: TrackedBlockSnapshot;
  operation?: TrackedBlockOperation;
}

export interface TrackedFormatSummary {
  /** Labels of added formatting, e.g. `["Bold"]`. */
  added: string[];
  /** Labels of removed formatting. */
  removed: string[];
  /** Labels of changed formatting (same mark, different attributes), e.g. `["Font size"]`. */
  changed: string[];
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
  /**
   * A change can be split into several ranges by other marks or blocks.
   * Block changes cover whole textblock nodes.
   */
  ranges: { from: number; to: number }[];
  text: string;
  /** Human-readable summary, e.g. `Formatted: Bold` or `Changed Paragraph to Heading 2`. */
  description: string;
  /** Formatting changes (`type: "format"`). */
  format?: TrackedFormatSummary;
  /**
   * Block changes (`type: "block"`): the first block's previous and current
   * state, and the whole-block operation for inserted/deleted blocks.
   */
  block?: {
    previous: TrackedBlockSnapshot;
    current: TrackedBlockSnapshot;
    operation?: TrackedBlockOperation;
  };
  /**
   * Moves (`type: "move"`): where the text was moved from (struck through
   * until accepted) and where it was moved to. `ranges` holds both.
   */
  move?: {
    from: { from: number; to: number }[];
    to: { from: number; to: number }[];
    /** The moved text at its source. */
    fromText: string;
    /** The moved text at its destination. */
    toText: string;
  };
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
  /** HTML attributes (e.g. `class`) of tracked formatting. Replaces the default dotted underline. */
  formatChangeHTMLAttributes: Record<string, any>;
  /** Class added to blocks with a tracked block change (margin bar by default). */
  blockChangeClass: string;
  /** Extra class of wholly inserted blocks (`blockChange.operation: "insert"`, from comparisons). */
  blockInsertedClass: string;
  /** Extra class of wholly deleted blocks (`blockChange.operation: "delete"`, from comparisons). */
  blockDeletedClass: string;
  /** Track mark changes (bold, links, font size, …) on existing text. Default `true`. */
  trackFormatting: boolean;
  /** Track textblock type/attribute and wrapping (list, quote) changes. Default `true`. */
  trackBlocks: boolean;
  /**
   * Track insertions and deletions inside code blocks by allowing the
   * insertion/deletion marks there. Default `true`.
   */
  trackCodeBlocks: boolean;
  /** Textblock node types that can record block changes. */
  blockTypes: string[];
  /** Extra mark names not tracked as formatting. */
  ignoredMarks: string[];
  /** Node attributes ignored when comparing blocks (e.g. generated ids). */
  ignoredBlockAttributes: string[];
  /**
   * Record a cut and paste (or a drag) of the same text as one tracked move
   * instead of a deletion and an insertion. Default `true`.
   */
  trackMoves: boolean;
  /**
   * Decides whether moved text is big enough to be a move. Default
   * `isMoveSized` (a paragraph, or at least a sentence of two words, as in
   * Word); pass `() => true` to record every cut/paste or drag as a move.
   */
  isMove: (text: string) => boolean;
  /** HTML attributes (e.g. `class`) of moved text, at both ends. Replaces the default green double line. */
  moveHTMLAttributes: Record<string, any>;
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
      /** Accepts a tracked move: removes the source, keeps the destination. */
      acceptMove: (id: string) => ReturnType;
      /** Rejects a tracked move: restores the source, removes the destination. */
      rejectMove: (id: string) => ReturnType;
      rejectAllChanges: () => ReturnType;
      /** Selects the next change after the selection, wrapping around. */
      selectNextChange: () => ReturnType;
      /** Selects the previous change before the selection, wrapping around. */
      selectPreviousChange: () => ReturnType;
      /** Selects a change (a move's destination, a block change's content). */
      selectChange: (id: string) => ReturnType;
    };
  }
}

function changeAttributes(mark: { attrs: Record<string, any> }): TrackedChangeAttributes {
  return mark.attrs as TrackedChangeAttributes;
}

function parseJSON<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
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

const moveAttribute = () => ({
  [MOVE_ID_ATTRIBUTE]: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-move-id"),
    renderHTML: (attrs: any) =>
      attrs[MOVE_ID_ATTRIBUTE] ? { "data-move-id": attrs[MOVE_ID_ATTRIBUTE] } : {},
  },
});

interface TrackedMarkOptions {
  HTMLAttributes: Record<string, any>;
  /** Attributes used instead of `HTMLAttributes` when the mark is one end of a move. */
  moveHTMLAttributes: Record<string, any>;
}

/** Default classes of moved text: green double underline (destination) / strike (source), as in Word. */
export const MOVE_TO_CLASS =
  "pixerate-move-to underline decoration-double decoration-emerald-600 text-emerald-700 dark:text-emerald-400";
export const MOVE_FROM_CLASS =
  "pixerate-move-from line-through decoration-double decoration-emerald-600 text-emerald-700 dark:text-emerald-400";

/**
 * Text inserted while tracking was on. Rendered as `<ins>`. With a `moveId`
 * it is the destination of a tracked move.
 */
export const TrackedInsertion = Mark.create<TrackedMarkOptions>({
  name: INSERTION_MARK_NAME,
  inclusive: false,
  addOptions() {
    return {
      HTMLAttributes: {
        class:
          "pixerate-insertion underline decoration-emerald-500 text-emerald-700 dark:text-emerald-400",
      },
      moveHTMLAttributes: { class: MOVE_TO_CLASS },
    };
  },
  addStorage() {
    // tiptap-markdown: inserted text is exported as plain text.
    return { markdown: { serialize: { open: "", close: "" }, parse: {} } };
  },
  addAttributes: () => ({ ...sharedAttributes(), ...moveAttribute() }),
  parseHTML() {
    return [{ tag: 'ins[data-change-type="insertion"]', priority: 100 }];
  },
  renderHTML({ mark, HTMLAttributes }) {
    const base = mark.attrs[MOVE_ID_ATTRIBUTE]
      ? this.options.moveHTMLAttributes
      : this.options.HTMLAttributes;
    return [
      "ins",
      safeMergeAttributes(base, HTMLAttributes, {
        "data-change-type": "insertion",
      }),
      0,
    ];
  },
});

/**
 * Text deleted while tracking was on. The text stays in the document until
 * the change is accepted. Rendered as `<del>` (struck through). With a
 * `moveId` it is the source of a tracked move.
 */
export const TrackedDeletion = Mark.create<TrackedMarkOptions>({
  name: DELETION_MARK_NAME,
  inclusive: false,
  addOptions() {
    return {
      HTMLAttributes: {
        class:
          "pixerate-deletion line-through decoration-red-500 text-red-600 dark:text-red-400",
      },
      moveHTMLAttributes: { class: MOVE_FROM_CLASS },
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
  addAttributes: () => ({ ...sharedAttributes(), ...moveAttribute() }),
  parseHTML() {
    // Higher priority than Strike, which also parses `<del>`.
    return [{ tag: 'del[data-change-type="deletion"]', priority: 100 }];
  },
  renderHTML({ mark, HTMLAttributes }) {
    const base = mark.attrs[MOVE_ID_ATTRIBUTE]
      ? this.options.moveHTMLAttributes
      : this.options.HTMLAttributes;
    return [
      "del",
      safeMergeAttributes(base, HTMLAttributes, {
        "data-change-type": "deletion",
      }),
      0,
    ];
  },
});

/**
 * Existing text whose formatting changed while tracking was on. Stores the
 * formatting before and after the change, rendered as
 * `<span data-change-type="format">` (dotted underline by default).
 */
export const TrackedFormatChange = Mark.create<{ HTMLAttributes: Record<string, any> }>({
  name: FORMAT_CHANGE_MARK_NAME,
  inclusive: false,
  addOptions() {
    return {
      HTMLAttributes: {
        class:
          "pixerate-format-change underline decoration-dotted decoration-2 decoration-sky-500 underline-offset-4",
      },
    };
  },
  addStorage() {
    return { markdown: { serialize: { open: "", close: "" }, parse: {} } };
  },
  addAttributes() {
    return {
      ...sharedAttributes(),
      before: {
        default: [],
        parseHTML: (el: HTMLElement) => parseJSON(el.getAttribute("data-format-before"), []),
        renderHTML: (attrs: any) => ({ "data-format-before": JSON.stringify(attrs.before ?? []) }),
      },
      after: {
        default: [],
        parseHTML: (el: HTMLElement) => parseJSON(el.getAttribute("data-format-after"), []),
        renderHTML: (attrs: any) => ({ "data-format-after": JSON.stringify(attrs.after ?? []) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-change-type="format"]', priority: 100 }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      safeMergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-change-type": "format",
      }),
      0,
    ];
  },
});

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

const MARK_LABELS: Record<string, string> = {
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  strike: "Strikethrough",
  code: "Code",
  link: "Link",
  highlight: "Highlight",
  subscript: "Subscript",
  superscript: "Superscript",
  textStyle: "Text style",
};

const TEXT_STYLE_LABELS: Record<string, string> = {
  fontSize: "Font size",
  fontFamily: "Font",
  color: "Color",
  backgroundColor: "Background color",
  lineHeight: "Line height",
};

const BLOCK_LABELS: Record<string, string> = {
  paragraph: "Paragraph",
  codeBlock: "Code block",
  blockquote: "Quote",
  bulletList: "Bulleted list",
  orderedList: "Numbered list",
  taskList: "Task list",
  listItem: "List item",
  taskItem: "Task item",
};

function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

const sameValue = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

function markLabels(mark: TrackedMark, other?: TrackedMark): string[] {
  if (mark.type === "textStyle") {
    const attrs = mark.attrs ?? {};
    const otherAttrs = other?.attrs ?? {};
    const keys = Array.from(new Set([...Object.keys(attrs), ...Object.keys(otherAttrs)])).filter(
      (key) => (other ? !sameValue(attrs[key], otherAttrs[key]) : attrs[key] != null),
    );
    return keys.length ? keys.map((key) => TEXT_STYLE_LABELS[key] ?? humanize(key)) : ["Text style"];
  }
  return [MARK_LABELS[mark.type] ?? humanize(mark.type)];
}

function diffFormatting(before: TrackedMark[], after: TrackedMark[]): TrackedFormatSummary {
  const summary: TrackedFormatSummary = { added: [], removed: [], changed: [] };
  const push = (list: string[], labels: string[]) =>
    labels.forEach((label) => {
      if (!list.includes(label)) list.push(label);
    });
  after.forEach((mark) => {
    const old = before.find((m) => m.type === mark.type);
    if (!old) push(summary.added, markLabels(mark));
    else if (!sameValue(old.attrs ?? {}, mark.attrs ?? {})) push(summary.changed, markLabels(mark, old));
  });
  before.forEach((mark) => {
    if (!after.some((m) => m.type === mark.type)) push(summary.removed, markLabels(mark));
  });
  return summary;
}

function mergeSummary(target: TrackedFormatSummary, source: TrackedFormatSummary): void {
  (["added", "removed", "changed"] as const).forEach((key) =>
    source[key].forEach((label) => {
      if (!target[key].includes(label)) target[key].push(label);
    }),
  );
}

/** Describes a formatting change, e.g. `Formatted: Bold; Removed formatting: Italic`. */
export function describeFormatChange(summary: TrackedFormatSummary): string {
  const parts: string[] = [];
  if (summary.added.length) parts.push(`Formatted: ${summary.added.join(", ")}`);
  if (summary.removed.length) parts.push(`Removed formatting: ${summary.removed.join(", ")}`);
  if (summary.changed.length) parts.push(`Changed formatting: ${summary.changed.join(", ")}`);
  return parts.join("; ") || "Formatted";
}

function blockLabel(type: string, attrs?: Record<string, any>): string {
  if (type === "heading" && attrs?.level) return `Heading ${attrs.level}`;
  return BLOCK_LABELS[type] ?? humanize(type);
}

const containerLabels = (wrappers: TrackedBlockSnapshot["wrappers"]) =>
  wrappers
    .filter((w) => w.type !== "listItem" && w.type !== "taskItem")
    .map((w) => blockLabel(w.type, w.attrs));

const isPrefix = (a: string[], b: string[]) => a.every((label, i) => b[i] === label);

/** Describes a block change, e.g. `Changed Paragraph to Heading 2`. */
export function describeBlockChange(
  previous: TrackedBlockSnapshot,
  current: TrackedBlockSnapshot,
  ignoredAttributes: readonly string[] = ["id"],
): string {
  const parts: string[] = [];
  const before = blockLabel(previous.type, previous.attrs);
  const after = blockLabel(current.type, current.attrs);
  if (before !== after) {
    parts.push(`Changed ${before} to ${after}`);
  } else {
    const keys = Array.from(
      new Set([...Object.keys(previous.attrs ?? {}), ...Object.keys(current.attrs ?? {})]),
    ).filter(
      (key) =>
        key !== BLOCK_CHANGE_ATTRIBUTE &&
        !ignoredAttributes.includes(key) &&
        !(current.type === "heading" && key === "level") &&
        !sameValue(previous.attrs?.[key], current.attrs?.[key]),
    );
    keys.forEach((key) => {
      if (key === "textAlign") {
        parts.push(`Changed alignment to ${humanize(String(current.attrs?.textAlign ?? "default"))}`);
      } else if (key === "styleId") {
        // Paragraph styles (`ParagraphStyles`): no id means the block's default style.
        parts.push(`Changed style to ${current.attrs?.styleId ?? "default"}`);
      } else {
        parts.push(`Changed ${humanize(key).toLowerCase()} of ${after}`);
      }
    });
  }
  const oldTypes = previous.wrappers.map((w) => w.type).join("/");
  const newTypes = current.wrappers.map((w) => w.type).join("/");
  if (oldTypes !== newTypes) {
    const was = containerLabels(previous.wrappers);
    const now = containerLabels(current.wrappers);
    const last = (list: string[]) => list[list.length - 1];
    if (was.length === 0 && now.length > 0) parts.push(`Wrapped in ${last(now)}`);
    else if (now.length === 0 && was.length > 0) parts.push(`Removed from ${last(was)}`);
    else if (now.length > was.length && isPrefix(was, now)) parts.push(`Indented in ${last(now)}`);
    else if (now.length < was.length && isPrefix(now, was)) parts.push(`Outdented from ${last(was)}`);
    else if (was.length && now.length) parts.push(`Changed ${last(was)} to ${last(now)}`);
    else parts.push("Changed nesting");
  }
  return parts.join("; ") || `Changed ${after}`;
}

/** Short label of a change's type for review UIs (`Moved` for a move). */
export function trackedChangeLabel(change: Pick<TrackedChange, "type">): string {
  switch (change.type) {
    case "insertion":
      return "Inserted";
    case "deletion":
      return "Deleted";
    case "format":
      return "Formatted";
    case "move":
      return "Moved";
    default:
      return "Changed";
  }
}

function truncate(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Reading changes
// ---------------------------------------------------------------------------

function toDoc(source: any): ProsemirrorNode | null {
  if (!source) return null;
  if (source.state?.doc) return source.state.doc;
  if (source.doc && typeof source.doc.descendants === "function") return source.doc;
  if (typeof source.descendants === "function") return source;
  return null;
}

function stripBlockChange(attrs: Record<string, any>): Record<string, any> {
  const copy = { ...attrs };
  delete copy[BLOCK_CHANGE_ATTRIBUTE];
  return copy;
}

/** Snapshot of the textblock at `pos` (position before the node). */
function blockSnapshot(doc: ProsemirrorNode, pos: number): TrackedBlockSnapshot {
  const $pos = doc.resolve(pos);
  const node = $pos.nodeAfter!;
  const wrappers: TrackedBlockSnapshot["wrappers"] = [];
  for (let depth = 1; depth <= $pos.depth; depth++) {
    const wrapper = $pos.node(depth);
    wrappers.push({ type: wrapper.type.name, attrs: stripBlockChange(wrapper.attrs) });
  }
  return { type: node.type.name, attrs: stripBlockChange(node.attrs), wrappers };
}

function sameBlock(
  a: TrackedBlockSnapshot,
  b: TrackedBlockSnapshot,
  ignored: ReadonlySet<string>,
): boolean {
  if (a.type !== b.type) return false;
  const filter = (attrs: Record<string, any>) =>
    Object.fromEntries(
      Object.entries(attrs ?? {}).filter(
        ([key]) => key !== BLOCK_CHANGE_ATTRIBUTE && !ignored.has(key),
      ),
    );
  if (!sameValue(filter(a.attrs), filter(b.attrs))) return false;
  if (a.wrappers.length !== b.wrappers.length) return false;
  return a.wrappers.every((w, i) => w.type === b.wrappers[i].type);
}

const isMarkChange = (type: string) =>
  type === INSERTION_MARK_NAME || type === DELETION_MARK_NAME || type === FORMAT_CHANGE_MARK_NAME;

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

  const add = (
    key: string,
    type: TrackedChangeType,
    attrs: TrackedChangeAttributes,
    from: number,
    to: number,
    text: string,
  ): TrackedChange => {
    let change = byKey.get(key);
    if (!change) {
      change = {
        id: attrs.changeId,
        type,
        author: {
          id: attrs.authorId,
          name: attrs.authorName,
          ...(attrs.authorColor ? { color: attrs.authorColor } : {}),
        },
        createdAt: attrs.createdAt,
        from,
        to,
        ranges: [],
        text: "",
        description: "",
      };
      byKey.set(key, change);
    }
    const last = change.ranges[change.ranges.length - 1];
    if (last && last.to === from) {
      last.to = to;
    } else {
      change.ranges.push({ from, to });
    }
    change.to = to;
    change.text += text;
    return change;
  };

  const blockCounts = new Map<string, number>();
  // Table cells holding each whole-block change (null once a block is outside a table).
  const blockCells = new Map<string, Set<number> | null>();
  doc.descendants((node, pos) => {
    const block = node.attrs?.[BLOCK_CHANGE_ATTRIBUTE] as TrackedBlockChangeAttributes | null;
    if (block?.changeId && node.isTextblock) {
      blockCounts.set(block.changeId, (blockCounts.get(block.changeId) ?? 0) + 1);
      if (block.operation && blockCells.get(block.changeId) !== null) {
        const $pos = doc.resolve(pos);
        let cell = -1;
        for (let depth = $pos.depth; depth > 0 && cell < 0; depth--) {
          const role = $pos.node(depth).type.spec.tableRole;
          if (role === "cell" || role === "header_cell") cell = $pos.before(depth);
        }
        const cells = blockCells.get(block.changeId) ?? new Set<number>();
        if (cell < 0) blockCells.set(block.changeId, null);
        else blockCells.set(block.changeId, cells.add(cell));
      }
      const change = add(
        `block:${block.changeId}`,
        "block",
        block,
        pos,
        pos + node.nodeSize,
        node.textContent,
      );
      if (!change.block) {
        change.block = {
          previous: block.previous,
          current: blockSnapshot(doc, pos),
          ...(block.operation ? { operation: block.operation } : {}),
        };
      }
    }
    if (!node.isInline) return;
    node.marks.forEach((mark) => {
      const markType = mark.type.name;
      if (!isMarkChange(markType)) return;
      const attrs = changeAttributes(mark);
      if (!attrs.changeId) return;
      const text = node.isText ? node.text ?? "" : "";
      const moveId = markType !== FORMAT_CHANGE_MARK_NAME ? attrs[MOVE_ID_ATTRIBUTE] : null;
      if (moveId) {
        const change = add(`move:${moveId}`, "move", { ...attrs, changeId: moveId }, pos, pos + node.nodeSize, text);
        if (!change.move) change.move = { from: [], to: [], fromText: "", toText: "" };
        const source = markType === DELETION_MARK_NAME;
        const list = source ? change.move.from : change.move.to;
        const last = list[list.length - 1];
        if (last && last.to === pos) last.to = pos + node.nodeSize;
        else list.push({ from: pos, to: pos + node.nodeSize });
        if (source) change.move.fromText += text;
        else change.move.toText += text;
        return;
      }
      const type: TrackedChangeType = markType === FORMAT_CHANGE_MARK_NAME ? "format" : (markType as TrackedChangeType);
      const change = add(
        `${type}:${attrs.changeId}`,
        type,
        attrs,
        pos,
        pos + node.nodeSize,
        text,
      );
      if (type === "format") {
        const summary = diffFormatting(mark.attrs.before ?? [], mark.attrs.after ?? []);
        if (!change.format) change.format = { added: [], removed: [], changed: [] };
        mergeSummary(change.format, summary);
      }
    });
  });

  const changes = Array.from(byKey.values());
  changes.forEach((change) => {
    switch (change.type) {
      case "insertion":
        change.description = change.text ? `Inserted "${truncate(change.text)}"` : "Inserted content";
        break;
      case "deletion":
        change.description = change.text ? `Deleted "${truncate(change.text)}"` : "Deleted content";
        break;
      case "format":
        change.description = describeFormatChange(change.format!);
        break;
      case "move": {
        const move = change.move!;
        change.text = move.toText || move.fromText;
        change.description = change.text ? `Moved "${truncate(change.text)}"` : "Moved content";
        break;
      }
      case "block": {
        const { previous, current, operation } = change.block!;
        if (operation) {
          const count = blockCounts.get(change.id) ?? 1;
          const verb = operation === "insert" ? "Inserted" : "Deleted";
          const cells = blockCells.get(change.id)?.size;
          change.description = cells
            ? `${verb} ${cells === 1 ? "a table cell" : `${cells} table cells`}`
            : count > 1
              ? `${verb} ${count} blocks`
              : `${verb} ${blockLabel(current.type, current.attrs)}`;
        } else {
          change.description = describeBlockChange(previous, current);
        }
        break;
      }
    }
  });
  return changes.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** The change containing `pos` (defaults to the selection start). Inline changes win over block changes. */
export function getTrackedChangeAt(
  state: EditorState,
  pos: number = state.selection.from,
  changes: readonly TrackedChange[] = getTrackedChanges(state.doc),
): TrackedChange | null {
  const { from, to } = state.selection;
  // A selection exactly covering a change (e.g. after selectNextChange).
  const exact = changes.find((c) => {
    const [start, end] = selectionRange(c);
    return start === from && end === to;
  });
  if (exact) return exact;
  const inline = changes.filter((c) => c.type !== "block");
  const blocks = changes.filter((c) => c.type === "block");
  return (
    inline.find((c) => c.ranges.some((r) => r.from < pos && pos < r.to)) ??
    inline.find((c) => c.ranges.some((r) => r.from <= pos && pos <= r.to)) ??
    blocks.find((c) => c.ranges.some((r) => r.from < pos && pos < r.to)) ??
    null
  );
}

/**
 * Text positions selected for a change (block changes select their content,
 * moves their destination).
 */
function selectionRange(change: TrackedChange): [number, number] {
  if (change.type === "block") return [change.from + 1, change.to - 1];
  if (change.type === "move" && change.move) {
    const ranges = change.move.to.length ? change.move.to : change.move.from;
    if (ranges.length) return [ranges[0].from, ranges[ranges.length - 1].to];
  }
  return [change.from, change.to];
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

// ---------------------------------------------------------------------------
// Accept / reject
// ---------------------------------------------------------------------------

function marksFromJSON(schema: Schema, marks: TrackedMark[] | undefined): ProsemirrorMark[] {
  const result: ProsemirrorMark[] = [];
  (marks ?? []).forEach((json) => {
    try {
      if (schema.marks[json.type]) result.push(schema.markFromJSON(json));
    } catch {
      // Unknown or invalid mark: skip.
    }
  });
  return result;
}

function decideFormat(
  tr: Transform,
  changes: readonly TrackedChange[],
  decision: "accept" | "reject",
): void {
  const schema = tr.doc.type.schema;
  const formatType = schema.marks[FORMAT_CHANGE_MARK_NAME];
  if (!formatType) return;
  const ids = new Set(changes.map((c) => c.id));
  const segments: { from: number; to: number; node: ProsemirrorNode; mark: ProsemirrorMark }[] = [];
  changes.forEach((change) =>
    change.ranges.forEach(({ from, to }) =>
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isInline) return true;
        const mark = formatType.isInSet(node.marks);
        if (mark && ids.has(mark.attrs.changeId)) {
          segments.push({ from: Math.max(pos, from), to: Math.min(pos + node.nodeSize, to), node, mark });
        }
        return false;
      }),
    ),
  );
  segments.forEach(({ from, to, node, mark }) => {
    tr.removeMark(from, to, formatType);
    if (decision === "accept") return;
    const before: TrackedMark[] = mark.attrs.before ?? [];
    const after: TrackedMark[] = mark.attrs.after ?? [];
    const involved = new Set([...before, ...after].map((m) => m.type));
    node.marks.forEach((current) => {
      if (involved.has(current.type.name)) tr.removeMark(from, to, current);
    });
    marksFromJSON(schema, before).forEach((restored) => tr.addMark(from, to, restored));
  });
}

const LIST_ITEM_TYPES = new Set(["listItem", "taskItem"]);

/**
 * The textblock at `contentPos` when it is the first child of a list item:
 * its resolved position and the item's depth.
 */
function listItemAt(
  tr: Transform,
  contentPos: number,
): { $pos: ResolvedPos; itemDepth: number } | null {
  const $pos = tr.doc.resolve(contentPos);
  const itemDepth = $pos.depth - 1;
  if (itemDepth < 2) return null;
  if (!LIST_ITEM_TYPES.has($pos.node(itemDepth).type.name) || $pos.index(itemDepth) !== 0) {
    return null;
  }
  return { $pos, itemDepth };
}

/** Nests a list item into its previous sibling (prosemirror-schema-list `sinkListItem`). */
function sinkItem(tr: Transform, contentPos: number): boolean {
  const info = listItemAt(tr, contentPos);
  if (!info) return false;
  const { $pos, itemDepth } = info;
  const list = $pos.node(itemDepth - 1);
  const index = $pos.index(itemDepth - 1);
  const itemType = $pos.node(itemDepth).type;
  if (index === 0 || list.child(index - 1).type !== itemType) return false;
  const nodeBefore = list.child(index - 1);
  const nestedBefore = nodeBefore.lastChild?.type === list.type;
  const inner = Fragment.from(nestedBefore ? itemType.create() : null);
  const slice = new Slice(
    Fragment.from(itemType.create(null, Fragment.from(list.type.create(null, inner)))),
    nestedBefore ? 3 : 1,
    0,
  );
  const before = $pos.before(itemDepth);
  const after = $pos.after(itemDepth);
  tr.step(
    new ReplaceAroundStep(before - (nestedBefore ? 3 : 1), after, before, after, slice, 1, true),
  );
  return true;
}

/**
 * Moves a nested list item out to the enclosing list (prosemirror-schema-list
 * `liftToOuterList`); following siblings become its children.
 */
function outdentItem(tr: Transform, contentPos: number): boolean {
  const info = listItemAt(tr, contentPos);
  if (!info) return false;
  const { $pos, itemDepth } = info;
  const listDepth = itemDepth - 1;
  if (listDepth < 2 || !LIST_ITEM_TYPES.has($pos.node(listDepth - 1).type.name)) return false;
  const itemType = $pos.node(itemDepth).type;
  let range = new NodeRange(
    tr.doc.resolve($pos.before(itemDepth)),
    tr.doc.resolve($pos.after(itemDepth)),
    listDepth,
  );
  const end = range.end;
  const endOfList = range.$to.end(range.depth);
  if (end < endOfList) {
    tr.step(
      new ReplaceAroundStep(
        end - 1,
        endOfList,
        end,
        endOfList,
        new Slice(Fragment.from(itemType.create(null, range.parent.copy())), 1, 0),
        1,
        true,
      ),
    );
    range = new NodeRange(tr.doc.resolve(range.$from.pos), tr.doc.resolve(endOfList), range.depth);
  }
  const target = liftTarget(range);
  if (target == null) return false;
  tr.lift(range, target);
  return true;
}

/** Lifts/wraps the textblock whose content starts at `contentPos` to match `wrappers`. */
function restoreWrappers(
  tr: Transform,
  contentPos: number,
  wrappers: TrackedBlockSnapshot["wrappers"],
): void {
  const schema = tr.doc.type.schema;
  /** Runs `fn`, maps `contentPos` and reports whether it added steps. */
  const step = (fn: () => unknown): boolean => {
    const index = tr.steps.length;
    const result = fn();
    contentPos = tr.mapping.slice(index).map(contentPos);
    return result !== false && tr.steps.length > index;
  };
  const chain = () => {
    const $pos = tr.doc.resolve(contentPos);
    const types: string[] = [];
    for (let depth = 1; depth < $pos.depth; depth++) types.push($pos.node(depth).type.name);
    return types;
  };
  const target = wrappers.map((w) => w.type);

  for (let guard = 0; guard < 24; guard++) {
    const current = chain();
    if (current.join("/") === target.join("/")) return;

    // Same nesting, different wrapper types (e.g. bulleted → numbered list).
    if (current.length === target.length) {
      const index = current.findIndex((type, i) => type !== target[i]);
      const type = schema.nodes[target[index]];
      if (type && LIST_ITEM_TYPES.has(type.name) === LIST_ITEM_TYPES.has(current[index])) {
        const $pos = tr.doc.resolve(contentPos);
        if (step(() => tr.setNodeMarkup($pos.before(index + 1), type, wrappers[index].attrs))) {
          continue;
        }
      }
    }

    let common = 0;
    while (common < current.length && common < target.length && current[common] === target[common]) {
      common++;
    }

    if (current.length > common) {
      // Leave wrappers that were not there before: list items move to the
      // outer list, anything else is lifted.
      if (step(() => outdentItem(tr, contentPos))) continue;
      const $from = tr.doc.resolve(contentPos);
      const range = $from.blockRange(tr.doc.resolve($from.end()));
      const lift = range ? liftTarget(range) : null;
      if (!range || lift == null || !step(() => tr.lift(range, lift))) return;
      continue;
    }

    // Enter the wrappers that were removed: a list item nests into its
    // previous sibling, anything else is wrapped.
    const missing = wrappers.slice(current.length);
    if (
      missing.length >= 2 &&
      LIST_ITEM_TYPES.has(missing[1].type) &&
      step(() => sinkItem(tr, contentPos))
    ) {
      continue;
    }
    const types = missing.map((w) => ({ type: schema.nodes[w.type], attrs: w.attrs }));
    if (types.some((t) => !t.type)) return;
    const $from = tr.doc.resolve(contentPos);
    const range = $from.blockRange(tr.doc.resolve($from.end()));
    if (!range) return;
    const start = range.start;
    step(() => tr.wrap(range, types as { type: NodeType; attrs: Record<string, any> }[]));
    // Re-join with neighbouring wrappers of the same type (restoring one list).
    const wrapper = tr.doc.nodeAt(start);
    if (!wrapper) return;
    const end = start + wrapper.nodeSize;
    if (tr.doc.resolve(end).nodeAfter?.type === wrapper.type && canJoin(tr.doc, end)) {
      step(() => tr.join(end));
    }
    if (tr.doc.resolve(start).nodeBefore?.type === wrapper.type && canJoin(tr.doc, start)) {
      step(() => tr.join(start));
    }
    return;
  }
}

/**
 * Removes the blocks of whole-block operations that the decision drops
 * (accepted deletions, rejected insertions). Containers whose textblocks are
 * all removed (list items, lists, quotes, table rows) are removed with them.
 */
function removeBlocks(tr: Transform, ids: ReadonlySet<string>, decision: "accept" | "reject"): void {
  const removed: TrackedBlockOperation = decision === "accept" ? "delete" : "insert";
  const memo = new Map<ProsemirrorNode, boolean>();
  const removable = (node: ProsemirrorNode): boolean => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (node.isTextblock) {
      const record = node.attrs?.[BLOCK_CHANGE_ATTRIBUTE] as TrackedBlockChangeAttributes | null;
      result = !!record?.changeId && record.operation === removed && ids.has(record.changeId);
    } else if (node.isLeaf || node.childCount === 0) {
      result = false;
    } else {
      result = true;
      for (let i = 0; i < node.childCount && result; i++) result = removable(node.child(i));
    }
    memo.set(node, result);
    return result;
  };

  const doc = tr.doc;
  if (removable(doc)) {
    const filler = doc.type.contentMatch.defaultType?.createAndFill();
    if (filler) tr.replaceWith(0, doc.content.size, filler);
    return;
  }
  const ranges: { from: number; to: number }[] = [];
  const visit = (node: ProsemirrorNode, contentStart: number) => {
    node.forEach((child, offset) => {
      const from = contentStart + offset;
      if (removable(child)) {
        ranges.push({ from, to: from + child.nodeSize });
      } else if (!child.isTextblock && !child.isLeaf) {
        visit(child, from + 1);
      }
    });
  };
  visit(doc, 0);
  if (ranges.length === 0) return;
  const startIndex = tr.steps.length;
  ranges.reverse().forEach(({ from, to }) => {
    const mapping = tr.mapping.slice(startIndex);
    try {
      tr.delete(mapping.map(from, 1), mapping.map(to, -1));
    } catch {
      // The parent cannot lose this block (e.g. a list item's first paragraph): keep it.
    }
  });
}

function decideBlocks(
  tr: Transform,
  changes: readonly TrackedChange[],
  decision: "accept" | "reject",
): void {
  const ids = new Set(changes.map((c) => c.id));
  removeBlocks(tr, ids, decision);
  const items: { contentPos: number; record: TrackedBlockChangeAttributes }[] = [];
  tr.doc.descendants((node, pos) => {
    const record = node.attrs?.[BLOCK_CHANGE_ATTRIBUTE] as TrackedBlockChangeAttributes | null;
    if (node.isTextblock && record?.changeId && ids.has(record.changeId)) {
      items.push({ contentPos: pos + 1, record });
    }
    return !node.isTextblock;
  });
  const schema = tr.doc.type.schema;
  const startIndex = tr.steps.length;
  // Last block first, so structural changes do not shift earlier blocks.
  items.reverse().forEach(({ contentPos: original, record }) => {
    const contentPos = tr.mapping.slice(startIndex).map(original);
    const $pos = tr.doc.resolve(contentPos);
    if (!$pos.parent.isTextblock || $pos.parentOffset !== 0) return;
    const pos = $pos.before();
    if (decision === "accept" || record.operation) {
      tr.setNodeAttribute(pos, BLOCK_CHANGE_ATTRIBUTE, null);
      return;
    }
    const previous = record.previous;
    const type = previous && schema.nodes[previous.type];
    if (!type) {
      tr.setNodeAttribute(pos, BLOCK_CHANGE_ATTRIBUTE, null);
      return;
    }
    const attrs = { ...previous.attrs, [BLOCK_CHANGE_ATTRIBUTE]: null };
    try {
      tr.setNodeMarkup(pos, type, attrs);
    } catch {
      // The content does not fit the previous type (e.g. marks in a code
      // block): convert while dropping incompatible content.
      try {
        tr.setBlockType(pos + 1, pos + 1, type, attrs);
      } catch {
        tr.setNodeAttribute(pos, BLOCK_CHANGE_ATTRIBUTE, null);
      }
    }
    try {
      restoreWrappers(tr, tr.mapping.slice(startIndex).map(original), previous.wrappers ?? []);
    } catch {
      // Best effort: the block keeps its current wrappers.
    }
  });
}

/**
 * Moved text that fills a whole top-level textblock takes the block with it
 * when it is removed, so moving a paragraph and accepting (or rejecting) the
 * move leaves no empty paragraph behind. Returns `false` when the range is
 * not such a block or the block cannot be removed.
 */
function deleteWholeBlock(tr: Transform, from: number, to: number): boolean {
  const $from = tr.doc.resolve(from);
  const block = $from.parent;
  if (
    $from.depth !== 1 ||
    !block.isTextblock ||
    from !== $from.start() ||
    to !== $from.end() ||
    tr.doc.childCount < 2
  ) {
    return false;
  }
  try {
    tr.delete($from.before(), $from.after());
    return true;
  } catch {
    return false;
  }
}

/**
 * Accepts or rejects changes on a transform. Formatting is resolved first,
 * then inline marks are removed and text is deleted from the end of the
 * document backwards so positions stay valid; block changes come last.
 */
function applyDecision(
  tr: Transform,
  changes: readonly TrackedChange[],
  decision: "accept" | "reject",
): void {
  const schema = tr.doc.type.schema;
  const format = changes.filter((c) => c.type === "format");
  if (format.length) decideFormat(tr, format, decision);

  const deletions: { from: number; to: number; wholeBlocks?: boolean }[] = [];
  changes.forEach((change) => {
    if (change.type === "move" && change.move) {
      // Accepting keeps the destination and removes the source; rejecting
      // restores the source and removes the destination.
      const accept = decision === "accept";
      const keepType = schema.marks[accept ? INSERTION_MARK_NAME : DELETION_MARK_NAME];
      (accept ? change.move.to : change.move.from).forEach(({ from, to }) => {
        if (keepType) tr.removeMark(from, to, keepType);
      });
      (accept ? change.move.from : change.move.to).forEach(({ from, to }) =>
        deletions.push({ from, to, wholeBlocks: true }),
      );
      return;
    }
    if (change.type !== "insertion" && change.type !== "deletion") return;
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
    .forEach(({ from, to, wholeBlocks }) => {
      const start = tr.mapping.map(from);
      const end = tr.mapping.map(to);
      if (wholeBlocks && deleteWholeBlock(tr, start, end)) return;
      tr.delete(start, end);
    });

  const blocks = changes.filter((c) => c.type === "block");
  if (blocks.length) decideBlocks(tr, blocks, decision);
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

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

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
 * Removes deleted text and review marks/attributes from a slice (used for
 * paste), so pasting tracked content pastes it as if all changes were
 * accepted.
 */
function acceptSlice(slice: Slice, schema: Schema): Slice {
  const insertion = schema.marks[INSERTION_MARK_NAME];
  const deletion = schema.marks[DELETION_MARK_NAME];
  const format = schema.marks[FORMAT_CHANGE_MARK_NAME];
  const mapFragment = (fragment: Fragment): Fragment => {
    const children: ProsemirrorNode[] = [];
    fragment.forEach((child) => {
      if (child.isInline) {
        if (deletion && deletion.isInSet(child.marks)) return;
        let marks = child.marks;
        if (insertion) marks = insertion.removeFromSet(marks);
        if (format) marks = format.removeFromSet(marks);
        children.push(marks === child.marks ? child : child.mark(marks));
      } else if (child.attrs?.[BLOCK_CHANGE_ATTRIBUTE]) {
        children.push(
          child.type.create(
            { ...child.attrs, [BLOCK_CHANGE_ATTRIBUTE]: null },
            mapFragment(child.content),
            child.marks,
          ),
        );
      } else {
        children.push(child.copy(mapFragment(child.content)));
      }
    });
    return Fragment.from(children);
  };
  return new Slice(mapFragment(slice.content), slice.openStart, slice.openEnd);
}

/** Copy of `fragment` without inline marks (adjacent text is merged). */
function stripMarks(fragment: Fragment): Fragment {
  const children: ProsemirrorNode[] = [];
  fragment.forEach((child) => {
    children.push(child.isInline ? child.mark(ProsemirrorMark.none) : child.copy(stripMarks(child.content)));
  });
  return Fragment.fromArray(children);
}

interface TrackContext {
  author: ReviewAuthor;
  now: () => number;
  generateId: () => string;
  insertion: MarkType;
  deletion: MarkType;
  /** Present when formatting is tracked. */
  format?: MarkType;
  trackBlocks: boolean;
  ignoredMarks: ReadonlySet<string>;
  ignoredAttributes: ReadonlySet<string>;
  /** Move detection for this batch of transactions, when moves are tracked. */
  moves?: MoveContext;
}

/** A tracked cut that the next paste can turn into the source of a move. */
interface PendingMove {
  /** Change id of the cut's deletion (becomes the move id). */
  id: string;
  /** The cut text (normalized). */
  text: string;
  authorId: string;
}

interface MoveContext {
  /** The user action of the batch (`uiEvent` meta). */
  event: "cut" | "paste" | "drop" | null;
  /** The last tracked cut, for a paste. */
  pending: PendingMove | null;
  isMove: (text: string) => boolean;
  /** Set by `trackTransactions` when the batch is a cut that can become a move. */
  cut?: PendingMove;
}

const SENTENCE_END = /[.!?…]$/;
const TRAILING_CLOSERS = /["'”’)]+$/;
const TRAILING_SPACES = /[  ]+$/;

/**
 * Whether moved text is big enough to be recorded as a move rather than a
 * deletion and an insertion, as in Word: a paragraph (the text holds a
 * paragraph break) or at least a sentence of two or more words.
 */
export function isMoveSized(text: string): boolean {
  const trimmed = text.replace(TRAILING_SPACES, "");
  if (trimmed.includes("\n")) return true;
  const sentence = trimmed.replace(TRAILING_CLOSERS, "");
  return SENTENCE_END.test(sentence) && sentence.trim().split(/\s+/).length >= 2;
}

/**
 * Drops white space so moved text can be compared across block boundaries
 * and mark splits.
 */
const normalizeMoveText = (text: string) => text.replace(/\s+/g, "");

/**
 * The text of a deleted slice that the deletion mark will record: neither
 * the author's own insertions (really deleted) nor text deleted before.
 * Blocks are separated by `\n`.
 */
function deletedText(slice: Slice, ctx: TrackContext): string {
  let text = "";
  let blocks = 0;
  slice.content.descendants((node) => {
    if (node.isTextblock) {
      if (blocks++ > 0) text += "\n";
      return true;
    }
    if (!node.isText) return true;
    const insertion = ctx.insertion.isInSet(node.marks);
    if (insertion && insertion.attrs.authorId === ctx.author.id) return false;
    if (ctx.deletion.isInSet(node.marks)) return false;
    text += node.text ?? "";
    return false;
  });
  return text;
}

/** Text of a document range with blocks separated by `\n`. */
const rangeText = (doc: ProsemirrorNode, from: number, to: number) =>
  doc.textBetween(from, to, "\n", "");

/**
 * Adds the move id to the source deletion of a pending cut. Returns `false`
 * when that deletion is no longer in the document.
 */
function linkMoveSource(tr: Transform, pending: PendingMove, ctx: TrackContext): boolean {
  const segments: { from: number; to: number; mark: ProsemirrorMark }[] = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const mark = ctx.deletion.isInSet(node.marks);
    if (mark && mark.attrs.changeId === pending.id && !mark.attrs[MOVE_ID_ATTRIBUTE]) {
      segments.push({ from: pos, to: pos + node.nodeSize, mark });
    }
    return false;
  });
  if (segments.length === 0) return false;
  const text = segments.map((s) => rangeText(tr.doc, s.from, s.to)).join("");
  if (normalizeMoveText(text) !== pending.text) return false;
  segments.forEach(({ from, to, mark }) =>
    tr.addMark(from, to, ctx.deletion.create({ ...mark.attrs, [MOVE_ID_ATTRIBUTE]: pending.id })),
  );
  return true;
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

function baseAttributes(attrs: TrackedChangeAttributes): TrackedChangeAttributes {
  return {
    changeId: attrs.changeId,
    authorId: attrs.authorId,
    authorName: attrs.authorName,
    authorColor: attrs.authorColor ?? null,
    createdAt: attrs.createdAt,
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
    // Typing next to moved text is not part of the move.
    if (
      mark &&
      mark.attrs.authorId === ctx.author.id &&
      mark.attrs.changeId &&
      !mark.attrs[MOVE_ID_ATTRIBUTE]
    ) {
      return changeAttributes(mark);
    }
  }
  return null;
}

/**
 * Marks deleted content with the deletion mark so it can be put back.
 * Text inserted by the same author (an untracked-in-effect draft) is dropped,
 * i.e. really deleted. Returns `null` if the slice holds content that cannot
 * carry the mark, in which case the deletion is not tracked.
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
  /** The slice is whole table rows, cells or tables (tracked as whole blocks). */
  wholeTable: boolean;
}

interface PendingBlock {
  previous: TrackedBlockSnapshot;
  existing: TrackedBlockChangeAttributes | null;
}

/** Formatting marks of a node, as JSON (review and ignored marks excluded). */
function formattingOf(marks: readonly ProsemirrorMark[], ctx: TrackContext): TrackedMark[] {
  return marks
    .filter((m) => !REVIEW_MARK_NAMES.has(m.type.name) && !ctx.ignoredMarks.has(m.type.name))
    .map((m) => m.toJSON() as TrackedMark);
}

function mergeRanges(ranges: { from: number; to: number }[]): { from: number; to: number }[] {
  const sorted = ranges.filter((r) => r.to > r.from).sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  sorted.forEach((range) => {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  });
  return merged;
}

/**
 * Records formatting changes on `ranges` (final-document positions) by
 * comparing each piece of text with the same text in `oldDoc`.
 */
function trackFormatting(
  tr: Transaction,
  ranges: { from: number; to: number }[],
  oldDoc: ProsemirrorNode,
  back: Mapping,
  inserted: { from: number; to: number }[],
  ctx: TrackContext,
): boolean {
  const format = ctx.format!;
  const doc = tr.doc;
  let changed = false;
  let batch: TrackedChangeAttributes | null = null;

  mergeRanges(ranges).forEach(({ from: a, to: b }) => {
    const segments: { from: number; to: number; oldNode: ProsemirrorNode; node: ProsemirrorNode }[] = [];
    doc.nodesBetween(a, b, (node, pos, parent) => {
      if (!node.isInline) return true;
      const s = Math.max(a, pos);
      const e = Math.min(b, pos + node.nodeSize);
      if (e <= s || !parent || !parent.type.allowsMarkType(format)) return false;
      // Formatting a tracked insertion is part of the insertion.
      if (ctx.insertion.isInSet(node.marks)) return false;
      if (inserted.some((r) => s < r.to && e > r.from)) return false;
      const os = back.map(s, 1);
      const oe = back.map(e, -1);
      if (oe - os !== e - s) return false;
      oldDoc.nodesBetween(os, oe, (oldNode, oldPos) => {
        if (!oldNode.isInline) return true;
        const ss = Math.max(os, oldPos);
        const ee = Math.min(oe, oldPos + oldNode.nodeSize);
        if (ee > ss && !ctx.insertion.isInSet(oldNode.marks)) {
          segments.push({ from: s + (ss - os), to: s + (ee - os), oldNode, node });
        }
        return false;
      });
      return false;
    });

    segments.forEach(({ from, to, oldNode, node }) => {
      const existing = format.isInSet(oldNode.marks);
      const original: TrackedMark[] = existing
        ? (existing.attrs.before as TrackedMark[]) ?? []
        : formattingOf(oldNode.marks, ctx);
      const current = formattingOf(node.marks, ctx);
      if (sameValue(original, current)) {
        if (existing || format.isInSet(node.marks)) {
          tr.removeMark(from, to, format);
          changed = true;
        }
        return;
      }
      let attrs: TrackedChangeAttributes;
      if (existing && existing.attrs.authorId === ctx.author.id && existing.attrs.changeId) {
        attrs = baseAttributes(changeAttributes(existing));
      } else {
        if (!batch) {
          const description = describeFormatChange(diffFormatting(original, current));
          const neighbours = [doc.resolve(from).nodeBefore, doc.resolve(to).nodeAfter];
          for (const neighbour of neighbours) {
            const mark = neighbour && format.isInSet(neighbour.marks);
            if (
              mark &&
              mark.attrs.authorId === ctx.author.id &&
              mark.attrs.changeId &&
              describeFormatChange(diffFormatting(mark.attrs.before ?? [], mark.attrs.after ?? [])) ===
                description
            ) {
              batch = baseAttributes(changeAttributes(mark));
              break;
            }
          }
          batch = batch ?? newAttributes(ctx);
        }
        attrs = batch;
      }
      tr.addMark(from, to, format.create({ ...attrs, before: original, after: current }));
      changed = true;
    });
  });
  return changed;
}

function trackBlocks(
  tr: Transaction,
  pending: Map<number, PendingBlock>,
  ctx: TrackContext,
): boolean {
  let changed = false;
  let batch: TrackedChangeAttributes | null = null;
  pending.forEach(({ previous, existing }, contentPos) => {
    if (contentPos < 0 || contentPos > tr.doc.content.size) return;
    const $pos = tr.doc.resolve(contentPos);
    const node = $pos.parent;
    if (!node.isTextblock || $pos.parentOffset !== 0 || $pos.depth === 0) return;
    if (!node.type.spec.attrs || !(BLOCK_CHANGE_ATTRIBUTE in node.type.spec.attrs)) return;
    const pos = $pos.before();
    // Inserted/deleted blocks (from a comparison) keep their record.
    if (existing?.operation || node.attrs[BLOCK_CHANGE_ATTRIBUTE]?.operation) return;
    const original = existing?.previous ?? previous;
    const current = blockSnapshot(tr.doc, pos);
    if (sameBlock(original, current, ctx.ignoredAttributes)) {
      if (node.attrs[BLOCK_CHANGE_ATTRIBUTE]) {
        tr.setNodeAttribute(pos, BLOCK_CHANGE_ATTRIBUTE, null);
        changed = true;
      }
      return;
    }
    const base =
      existing && existing.authorId === ctx.author.id && existing.changeId
        ? baseAttributes(existing)
        : (batch = batch ?? newAttributes(ctx));
    const value: TrackedBlockChangeAttributes = { ...base, previous: original };
    if (!sameValue(node.attrs[BLOCK_CHANGE_ATTRIBUTE], value)) {
      tr.setNodeAttribute(pos, BLOCK_CHANGE_ATTRIBUTE, value);
      changed = true;
    }
  });
  return changed;
}

/** Records textblocks whose type, attributes or wrappers changed in a step. */
function collectBlockChanges(
  step: ReplaceAroundStep | AttrStep,
  docBefore: ProsemirrorNode,
  docAfter: ProsemirrorNode,
  rest: Mapping,
  pending: Map<number, PendingBlock>,
  ctx: TrackContext,
): void {
  const record = (oldPos: number, newPos: number) => {
    const key = rest.map(newPos + 1);
    if (pending.has(key)) return;
    const oldNode = docBefore.nodeAt(oldPos)!;
    const previous = blockSnapshot(docBefore, oldPos);
    if (sameBlock(previous, blockSnapshot(docAfter, newPos), ctx.ignoredAttributes)) return;
    pending.set(key, {
      previous,
      existing: (oldNode.attrs[BLOCK_CHANGE_ATTRIBUTE] as TrackedBlockChangeAttributes) ?? null,
    });
  };

  if (step instanceof AttrStep) {
    const node = docBefore.nodeAt(step.pos);
    if (
      node?.isTextblock &&
      step.attr !== BLOCK_CHANGE_ATTRIBUTE &&
      !ctx.ignoredAttributes.has(step.attr)
    ) {
      record(step.pos, step.pos);
    }
    return;
  }

  const map = step.getMap();
  const back = map.invert();
  const start = map.map(step.from, -1);
  const end = map.map(step.to, 1);
  docAfter.nodesBetween(start, end, (node, pos) => {
    if (!node.isTextblock) return true;
    const oldContent = back.map(pos + 1);
    if (oldContent < 1 || oldContent > docBefore.content.size) return false;
    const $old = docBefore.resolve(oldContent);
    if (
      $old.parent.isTextblock &&
      $old.parentOffset === 0 &&
      $old.parent.content.size === node.content.size
    ) {
      record($old.before(), pos);
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Table structure
// ---------------------------------------------------------------------------

/** `tableRole` of table nodes (set by TipTap's table extensions / prosemirror-tables). */
const TABLE_ROLES = new Set(["table", "row", "cell", "header_cell"]);

const isTableStructure = (node: ProsemirrorNode) => TABLE_ROLES.has(node.type.spec.tableRole as string);

const supportsBlockChange = (node: ProsemirrorNode) =>
  !!node.type.spec.attrs && BLOCK_CHANGE_ATTRIBUTE in node.type.spec.attrs;

/** A closed slice of whole tables, rows or cells (e.g. Delete Row / Column / Table). */
function isWholeTableSlice(slice: Slice): boolean {
  if (slice.openStart !== 0 || slice.openEnd !== 0 || slice.content.childCount === 0) return false;
  let whole = true;
  slice.content.forEach((child) => {
    if (!isTableStructure(child)) whole = false;
  });
  return whole;
}

/** Every textblock inside can carry a `blockChange` record. */
function canMarkTableBlocks(slice: Slice): boolean {
  let ok = true;
  let any = false;
  slice.content.descendants((node) => {
    if (!ok) return false;
    if (node.isTextblock) {
      any = true;
      if (!supportsBlockChange(node)) ok = false;
      return false;
    }
    return true;
  });
  return ok && any;
}

/** All textblocks are whole-block insertions by the current author. */
function isOwnTableInsertion(slice: Slice, ctx: TrackContext): boolean {
  let own = true;
  slice.content.descendants((node) => {
    if (!own) return false;
    if (node.isTextblock) {
      const record = node.attrs[BLOCK_CHANGE_ATTRIBUTE] as TrackedBlockChangeAttributes | null;
      if (record?.operation !== "insert" || record.authorId !== ctx.author.id) own = false;
      return false;
    }
    return true;
  });
  return own;
}

/**
 * Records whole tables, rows and cells inserted by a `ReplaceStep` (final
 * document ranges). Open (partial) table nodes at the slice edges are
 * skipped: they merge into existing ones.
 */
function collectInsertedTableNodes(
  slice: Slice,
  from: number,
  rest: Mapping,
  out: { from: number; to: number }[],
): void {
  slice.content.descendants((node, offset) => {
    if (!isTableStructure(node)) return !node.isTextblock;
    const pos = from - slice.openStart + offset;
    if (pos < from) return true; // An open node at the start: look inside.
    const start = rest.map(pos, 1);
    const end = rest.map(pos + node.nodeSize, -1);
    if (end - start === node.nodeSize) out.push({ from: start, to: end });
    return false;
  });
}

/**
 * Gives every textblock in `from..to` a whole-block `blockChange` record
 * (`operation: "insert" | "delete"`, one change id), so accepting a deletion
 * or rejecting an insertion removes the rows/cells/table around them.
 */
function markTableBlocks(
  tr: Transform,
  from: number,
  to: number,
  operation: TrackedBlockOperation,
  attrs: TrackedChangeAttributes,
): boolean {
  const positions: number[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (pos >= from && pos + node.nodeSize <= to && supportsBlockChange(node)) positions.push(pos);
    return false;
  });
  positions.forEach((pos) => {
    const record: TrackedBlockChangeAttributes = {
      ...baseAttributes(attrs),
      previous: blockSnapshot(tr.doc, pos),
      operation,
    };
    tr.setNodeAttribute(pos, BLOCK_CHANGE_ATTRIBUTE, record);
  });
  return positions.length > 0;
}

/**
 * Builds a transaction that turns the user's raw edits into tracked changes:
 * inserted content gets the insertion mark, deleted content is put back with
 * the deletion mark, formatting changes on existing text get the
 * `formatChange` mark and textblock type/wrapping changes get the
 * `blockChange` attribute. Paragraph splits and joins are not tracked.
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
  const tableInserts: { from: number; to: number }[] = [];
  const formatRanges: { from: number; to: number }[] = [];
  const blocks = new Map<number, PendingBlock>();
  let mapIndex = 0;
  const single =
    transactions.length === 1 && transactions[0].steps.length === 1;

  transactions.forEach((t) => {
    const skip = shouldSkip(t);
    t.steps.forEach((step, i) => {
      const index = mapIndex + i;
      if (skip) return;
      const rest = new Mapping(maps.slice(index + 1));
      const docBefore = t.docs[i];

      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        const name = step.mark.type.name;
        if (ctx.format && !REVIEW_MARK_NAMES.has(name) && !ctx.ignoredMarks.has(name)) {
          formatRanges.push({ from: rest.map(step.from, 1), to: rest.map(step.to, -1) });
        }
        return;
      }
      if (step instanceof ReplaceAroundStep || step instanceof AttrStep) {
        if (ctx.trackBlocks) {
          const docAfter = t.docs[i + 1] ?? t.doc;
          collectBlockChanges(step, docBefore, docAfter, rest, blocks, ctx);
        }
        return;
      }
      if (!(step instanceof ReplaceStep)) return;
      const { from, to, slice } = step as unknown as { from: number; to: number; slice: Slice };

      // Replacing content with the same content: only marks may differ.
      if (to > from && slice.size === to - from) {
        const deleted = docBefore.slice(from, to);
        if (
          slice.openStart === deleted.openStart &&
          slice.openEnd === deleted.openEnd &&
          stripMarks(slice.content).eq(stripMarks(deleted.content))
        ) {
          if (ctx.format && !slice.content.eq(deleted.content)) {
            formatRanges.push({ from: rest.map(from, 1), to: rest.map(to, -1) });
          }
          return;
        }
      }

      if (ctx.trackBlocks && slice.size > 0) {
        collectInsertedTableNodes(slice, from, rest, tableInserts);
      }
      if (slice.size > 0 && hasInlineContent(slice.content)) {
        const start = rest.map(from, 1);
        const end = rest.map(from + slice.size, -1);
        if (end > start) inserted.push({ from: start, to: end });
      }
      if (to > from) {
        const deleted = docBefore.slice(from, to);
        const wholeTable = ctx.trackBlocks && isWholeTableSlice(deleted);
        if (!wholeTable && !hasInlineContent(deleted.content)) return;
        const $from = docBefore.resolve(from);
        const before = i === 0 ? t.before : null;
        const sel = before === oldState.doc ? oldState.selection : null;
        restores.push({
          pos: rest.map(from, -1),
          slice: deleted,
          parentType: $from.node(Math.max(0, $from.depth - deleted.openStart)).type,
          pureDelete: slice.size === 0,
          wholeTable,
          backspace:
            single && slice.size === 0 && !!sel && sel.empty && sel.from === to,
        });
      }
    });
    mapIndex += t.steps.length;
  });

  if (
    inserted.length === 0 &&
    tableInserts.length === 0 &&
    restores.length === 0 &&
    formatRanges.length === 0 &&
    blocks.size === 0
  ) {
    return null;
  }

  const tr = newState.tr;
  let changed = false;

  // Formatting and block attributes first: they do not move positions.
  if (formatRanges.length && ctx.format) {
    const back = new Mapping(maps).invert();
    changed = trackFormatting(tr, formatRanges, oldState.doc, back, inserted, ctx) || changed;
  }
  if (blocks.size) {
    changed = trackBlocks(tr, blocks, ctx) || changed;
  }

  // Moves: a paste of the text the last tracked cut deleted, or a drag of a
  // range within the document, links the deletion and the insertion.
  const moves = ctx.moves;
  let insertAttrs: TrackedChangeAttributes | null = null;
  let deleteAttrs: TrackedChangeAttributes | null = null;
  const moveAttrs = (id: string): TrackedChangeAttributes => ({
    changeId: id,
    authorId: ctx.author.id,
    authorName: ctx.author.name,
    authorColor: ctx.author.color ?? null,
    createdAt: ctx.now(),
    [MOVE_ID_ATTRIBUTE]: id,
  });
  if (moves && inserted.length) {
    const insertedText = normalizeMoveText(
      inserted.map((r) => rangeText(tr.doc, r.from, r.to)).join(""),
    );
    const pending = moves.pending;
    if (
      moves.event === "paste" &&
      pending &&
      pending.authorId === ctx.author.id &&
      insertedText === pending.text &&
      linkMoveSource(tr, pending, ctx)
    ) {
      insertAttrs = moveAttrs(pending.id);
    } else if (moves.event === "drop" && restores.length) {
      const raw = restores.map((r) => deletedText(r.slice, ctx)).join("\n");
      if (insertedText && normalizeMoveText(raw) === insertedText && moves.isMove(raw)) {
        insertAttrs = deleteAttrs = moveAttrs(ctx.generateId());
      }
    }
  }
  if (moves?.event === "cut" && restores.length) {
    // A cut gets a change of its own, so the paste after it moves exactly it.
    deleteAttrs = newAttributes(ctx);
    const raw = restores.map((r) => deletedText(r.slice, ctx)).join("\n");
    if (normalizeMoveText(raw) && moves.isMove(raw)) {
      moves.cut = { id: deleteAttrs.changeId, text: normalizeMoveText(raw), authorId: ctx.author.id };
    }
  }

  inserted.forEach(({ from, to }) => {
    tr.removeMark(from, to, ctx.deletion);
    tr.removeMark(from, to, ctx.insertion);
    if (ctx.format) tr.removeMark(from, to, ctx.format);
    const attrs =
      insertAttrs ?? adjacentAttributes(tr.doc, from, to, ctx.insertion, ctx) ?? newAttributes(ctx);
    tr.addMark(from, to, ctx.insertion.create(attrs));
    changed = true;
  });
  if (insertAttrs) changed = true;

  // Inserted rows, columns (cells) and tables are whole-block insertions:
  // rejecting removes them. Their text is part of the block change.
  if (tableInserts.length) {
    const attrs = newAttributes(ctx);
    tableInserts.forEach(({ from, to }) => {
      const start = tr.mapping.map(from, 1);
      const end = tr.mapping.map(to, -1);
      const node = tr.doc.nodeAt(start);
      if (end <= start || !node || !isTableStructure(node) || node.nodeSize !== end - start) return;
      tr.removeMark(start, end, ctx.insertion);
      changed = markTableBlocks(tr, start, end, "insert", attrs) || changed;
    });
  }
  let tableDeleteAttrs: TrackedChangeAttributes | null = null;

  let cursor: number | null = null;
  restores
    .sort((a, b) => b.pos - a.pos)
    .forEach((restore) => {
      const pos = tr.mapping.map(restore.pos, -1);
      const attrs =
        deleteAttrs ?? adjacentAttributes(tr.doc, pos, pos, ctx.deletion, ctx) ?? newAttributes(ctx);
      if (restore.wholeTable && canMarkTableBlocks(restore.slice)) {
        // Rows/cells/tables the same author inserted are really deleted.
        if (isOwnTableInsertion(restore.slice, ctx)) return;
        tableDeleteAttrs = tableDeleteAttrs ?? deleteAttrs ?? newAttributes(ctx);
        const sizeBefore = tr.doc.content.size;
        try {
          tr.replace(pos, pos, restore.slice);
        } catch {
          return;
        }
        const end = pos + (tr.doc.content.size - sizeBefore);
        markTableBlocks(tr, pos, end, "delete", tableDeleteAttrs);
        changed = true;
        return;
      }
      if (!hasInlineContent(restore.slice.content)) return;
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
 * Lets code blocks (`marks: ""`) carry the insertion and deletion marks.
 * The node's own `marks` spec wins over `extendNodeSchema`, so the allowed
 * mark set of the built schema is extended instead.
 */
function allowTrackingInCodeBlocks(schema: Schema): void {
  const marks = [schema.marks[INSERTION_MARK_NAME], schema.marks[DELETION_MARK_NAME]].filter(
    Boolean,
  ) as MarkType[];
  Object.values(schema.nodes).forEach((type) => {
    const markSet = type.markSet;
    if (!type.isTextblock || !type.spec.code || markSet === null) return;
    const missing = marks.filter((mark) => !markSet.includes(mark));
    if (missing.length) {
      (type as { markSet: readonly MarkType[] | null }).markSet = [...markSet, ...missing];
    }
  });
}

/**
 * Suggestion mode / track changes. When enabled, typed and pasted content is
 * marked as an insertion and deleted content is kept but marked as a
 * deletion (struck through) until the change is accepted or rejected.
 * Formatting changes on existing text are recorded with the `formatChange`
 * mark, and textblock type/attribute/wrapping changes with the `blockChange`
 * node attribute. A cut and paste (or a drag) of a sentence or paragraph is
 * recorded as a move: a deletion and an insertion linked by `moveId`, listed
 * as one change and accepted or rejected together.
 *
 * Deleting your own insertion really deletes it. Paragraph splits and joins
 * are not tracked. IME composition is tracked once the composition ends.
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
      formatChangeHTMLAttributes: {},
      blockChangeClass: "pixerate-block-change border-l-2 border-amber-400 pl-2 dark:border-amber-500",
      blockInsertedClass:
        "pixerate-block-inserted underline decoration-emerald-500 text-emerald-700 dark:text-emerald-400",
      blockDeletedClass:
        "pixerate-block-deleted line-through decoration-red-500 text-red-600 dark:text-red-400",
      trackFormatting: true,
      trackBlocks: true,
      trackCodeBlocks: true,
      blockTypes: ["paragraph", "heading", "codeBlock"],
      ignoredMarks: [],
      ignoredBlockAttributes: ["id"],
      trackMoves: true,
      isMove: isMoveSized,
      moveHTMLAttributes: {},
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

  addGlobalAttributes() {
    if (this.options?.trackBlocks === false) return [];
    const blockClass = this.options?.blockChangeClass ?? "";
    const insertedClass = this.options?.blockInsertedClass ?? "";
    const deletedClass = this.options?.blockDeletedClass ?? "";
    return [
      {
        types: this.options?.blockTypes ?? ["paragraph", "heading", "codeBlock"],
        attributes: {
          [BLOCK_CHANGE_ATTRIBUTE]: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => parseJSON(el.getAttribute("data-block-change"), null),
            renderHTML: (attrs: Record<string, any>) => {
              const value = attrs[BLOCK_CHANGE_ATTRIBUTE];
              if (!value) return {};
              const operation = (value as TrackedBlockChangeAttributes).operation;
              const extra = operation === "insert" ? insertedClass : operation === "delete" ? deletedClass : "";
              const className = [blockClass, extra].filter(Boolean).join(" ");
              return {
                "data-block-change": JSON.stringify(value),
                ...(operation ? { "data-block-operation": operation } : {}),
                ...(className ? { class: className } : {}),
              };
            },
          },
        },
      },
    ];
  },

  addExtensions() {
    const insertionAttrs = this.options?.insertionHTMLAttributes ?? {};
    const deletionAttrs = this.options?.deletionHTMLAttributes ?? {};
    const formatAttrs = this.options?.formatChangeHTMLAttributes ?? {};
    const moveAttrs = this.options?.moveHTMLAttributes ?? {};
    const markOptions = (attrs: Record<string, any>) => ({
      ...(Object.keys(attrs).length ? { HTMLAttributes: attrs } : {}),
      ...(Object.keys(moveAttrs).length ? { moveHTMLAttributes: moveAttrs } : {}),
    });
    const configured = <T extends typeof TrackedInsertion>(mark: T, attrs: Record<string, any>) => {
      const options = markOptions(attrs);
      return Object.keys(options).length ? mark.configure(options) : mark;
    };
    return [
      configured(TrackedInsertion, insertionAttrs),
      configured(TrackedDeletion, deletionAttrs),
      Object.keys(formatAttrs).length
        ? TrackedFormatChange.configure({ HTMLAttributes: formatAttrs })
        : TrackedFormatChange,
    ];
  },

  onBeforeCreate() {
    if (this.options.trackCodeBlocks) allowTrackingInCodeBlocks(this.editor.schema);
  },

  addCommands() {
    const decide =
      (decision: "accept" | "reject", id: string | null, onlyMoves = false) =>
      ({ state, tr, dispatch }: { state: EditorState; tr: Transaction; dispatch?: any }) => {
        const all = getTrackedChanges(state.doc);
        const changes =
          id === null ? all : all.filter((c) => c.id === id && (!onlyMoves || c.type === "move"));
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
        const start = (c: TrackedChange) => selectionRange(c)[0];
        const target =
          direction === 1
            ? changes.find((c) => start(c) > from) ?? changes[0]
            : [...changes].reverse().find((c) => start(c) < from) ?? changes[changes.length - 1];
        if (dispatch) {
          const [anchor, head] = selectionRange(target);
          tr.setSelection(TextSelection.create(tr.doc, anchor, head)).scrollIntoView();
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
      acceptMove: (id) => decide("accept", id, true),
      rejectMove: (id) => decide("reject", id, true),
      rejectChange: (id) => decide("reject", id),
      acceptAllChanges: () => decide("accept", null),
      rejectAllChanges: () => decide("reject", null),
      selectNextChange: () => select(1),
      selectPreviousChange: () => select(-1),
      selectChange:
        (id) =>
        ({ state, tr, dispatch }) => {
          const change = getTrackedChanges(state.doc).find((c) => c.id === id);
          if (!change) return false;
          if (dispatch) {
            const [anchor, head] = selectionRange(change);
            tr.setSelection(TextSelection.create(tr.doc, anchor, head)).scrollIntoView();
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const store = this.storage.store;
    const ignoredMarks = new Set(options.ignoredMarks ?? []);
    const ignoredAttributes = new Set(options.ignoredBlockAttributes ?? []);
    let editorView: EditorView | null = null;
    // Transactions applied during IME composition. Changing the document
    // around the composition would break the IME, so they are tracked
    // together once it ends.
    let pending: { oldState: EditorState; transactions: Transaction[] } | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    // The last tracked cut, which the paste right after it turns into a move.
    let pendingMove: PendingMove | null = null;
    const isMove = options.isMove ?? isMoveSized;

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
          if (!tracking && !pending) {
            if (transactions.some((t) => t.docChanged)) pendingMove = null;
            return null;
          }

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
          const userTransactions = trs.filter((t) => !shouldSkip(t));
          let moves: MoveContext | undefined;
          if (userTransactions.length) {
            const uiEvent =
              userTransactions.length === 1 ? userTransactions[0].getMeta("uiEvent") : null;
            const event = uiEvent === "cut" || uiEvent === "paste" || uiEvent === "drop" ? uiEvent : null;
            if (options.trackMoves !== false) {
              moves = { event, pending: event === "paste" ? pendingMove : null, isMove };
            }
            // Any other edit ends the cut-and-paste sequence.
            pendingMove = null;
          }
          const result = trackTransactions(trs, fromState, newState, {
            author,
            now: options.now,
            generateId: options.generateId,
            insertion: newState.schema.marks[INSERTION_MARK_NAME],
            deletion: newState.schema.marks[DELETION_MARK_NAME],
            format:
              options.trackFormatting !== false
                ? newState.schema.marks[FORMAT_CHANGE_MARK_NAME]
                : undefined,
            trackBlocks: options.trackBlocks !== false,
            ignoredMarks,
            ignoredAttributes,
            moves,
          });
          if (moves?.cut) pendingMove = moves.cut;
          return result;
        },
        props: {
          transformPasted: (slice, view) => acceptSlice(slice, view.state.schema),
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
