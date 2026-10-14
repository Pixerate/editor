// Portions ported from wordcraft/crates/engine/src/cmd/tools.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import { createDocument } from "@tiptap/core";
import {
  Fragment,
  Mark as ProsemirrorMark,
  type MarkType,
  type Node as ProsemirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import {
  BLOCK_CHANGE_ATTRIBUTE,
  DELETION_MARK_NAME,
  FORMAT_CHANGE_MARK_NAME,
  INSERTION_MARK_NAME,
  getTrackedChanges,
  resolveTrackedChanges,
  type TrackedBlockChangeAttributes,
  type TrackedBlockOperation,
  type TrackedBlockSnapshot,
  type TrackedChangeAttributes,
  type TrackedMark,
} from "../extensions/track-changes";
import { createReviewId, type ReviewAuthor } from "../extensions/comment-store";
import { diffSequences } from "./diff";

/** A document to compare: a ProseMirror node, its JSON, or HTML (needs a DOM). */
export type CompareSource = ProsemirrorNode | Record<string, any> | string;

export interface CompareDocumentsOptions {
  /** Schema of the documents. Required unless both sources are ProseMirror nodes. */
  schema?: Schema;
  /** Author recorded on every change. Default `{ id: "compare", name: "Compare" }`. */
  author?: ReviewAuthor;
  /** Time recorded on every change (`createdAt`). Default now. */
  date?: number | Date | string;
  /** Compare changed paragraphs word by word (default) or character by character. */
  granularity?: "word" | "char";
  /** Treat text differing only in case as equal (the revised text is kept). */
  ignoreCase?: boolean;
  /** Treat runs of white space as equal (the revised text is kept). */
  ignoreWhitespace?: boolean;
  /** Record formatting differences of equal text as `formatChange` marks. Default `true`. */
  formatting?: boolean;
  /** Change id generator. */
  generateId?: () => string;
  /** Marks not compared as formatting (in addition to review marks, comments and bookmarks). */
  ignoredMarks?: string[];
  /** Node attributes ignored when comparing blocks. Default `["id"]`. */
  ignoredBlockAttributes?: string[];
  /**
   * Paragraphs longer than this (in characters) are compared by words even
   * at `granularity: "char"`. Default 2000.
   */
  maxCharDiff?: number;
}

export interface CompareSummary {
  /** Inserted text runs and inserted block runs. */
  insertions: number;
  /** Deleted text runs and deleted block runs. */
  deletions: number;
  /** Formatting changes of equal text. */
  formatChanges: number;
  /** Block type, attribute and wrapping changes. */
  blockChanges: number;
  /** Differences the result could not represent as tracked changes. */
  notHonoured: string[];
}

export interface CompareDocumentsResult {
  /**
   * The revised document with the differences as tracked changes: accepting
   * all changes yields the revised document, rejecting all the original.
   */
  doc: ProsemirrorNode;
  summary: CompareSummary;
}

/** Marks that are never compared as formatting. */
const REVIEW_MARK_NAMES = new Set([
  INSERTION_MARK_NAME,
  DELETION_MARK_NAME,
  FORMAT_CHANGE_MARK_NAME,
  "comment",
  "bookmark",
]);

/** Container types that pair with each other (a list whose type changed). */
const LIST_TYPES = new Set(["bulletList", "orderedList"]);

const OBJECT_REPLACEMENT = "￼";

type Wrapper = TrackedBlockSnapshot["wrappers"][number];

interface Unit {
  /** One code point, or "" for an inline leaf node. */
  text: string;
  node: ProsemirrorNode | null;
  marks: readonly ProsemirrorMark[];
}

interface Context {
  schema: Schema;
  author: ReviewAuthor;
  createdAt: number;
  generateId: () => string;
  granularity: "word" | "char";
  ignoreCase: boolean;
  ignoreWhitespace: boolean;
  formatting: boolean;
  maxCharDiff: number;
  ignoredMarks: Set<string>;
  ignoredAttributes: Set<string>;
  insertion?: MarkType;
  deletion?: MarkType;
  format?: MarkType;
  notes: Set<string>;
  keys: Map<ProsemirrorNode, string>;
  /** Shared change of the textblocks inside a container whose type changed. */
  wrapperChange: (() => TrackedChangeAttributes) | null;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as any)[key])}`)
    .join(",")}}`;
}

function toTime(date: CompareDocumentsOptions["date"]): number {
  if (date instanceof Date) return date.getTime();
  if (typeof date === "string") {
    const time = Date.parse(date);
    return Number.isNaN(time) ? Date.now() : time;
  }
  return typeof date === "number" ? date : Date.now();
}

function toNode(source: CompareSource, schema: Schema): ProsemirrorNode {
  if (typeof source === "string") return createDocument(source, schema);
  if (typeof (source as ProsemirrorNode).descendants === "function") {
    const node = source as ProsemirrorNode;
    return node.type.schema === schema ? node : schema.nodeFromJSON(node.toJSON());
  }
  return schema.nodeFromJSON(source);
}

function newAttributes(ctx: Context): TrackedChangeAttributes {
  return {
    changeId: ctx.generateId(),
    authorId: ctx.author.id,
    authorName: ctx.author.name,
    authorColor: ctx.author.color ?? null,
    createdAt: ctx.createdAt,
  };
}

/** Lazily created attributes shared by one run of changes. */
function lazyAttributes(ctx: Context): () => TrackedChangeAttributes {
  let attrs: TrackedChangeAttributes | null = null;
  return () => (attrs = attrs ?? newAttributes(ctx));
}

function stripBlockChange(attrs: Record<string, any>): Record<string, any> {
  const copy = { ...attrs };
  delete copy[BLOCK_CHANGE_ATTRIBUTE];
  return copy;
}

function wrapperOf(node: ProsemirrorNode): Wrapper {
  return { type: node.type.name, attrs: stripBlockChange(node.attrs) };
}

function snapshot(node: ProsemirrorNode, wrappers: Wrapper[]): TrackedBlockSnapshot {
  return { type: node.type.name, attrs: stripBlockChange(node.attrs), wrappers };
}

function filteredAttributes(attrs: Record<string, any>, ctx: Context): string {
  return stableStringify(
    Object.fromEntries(
      Object.entries(attrs ?? {}).filter(
        ([key]) => key !== BLOCK_CHANGE_ATTRIBUTE && !ctx.ignoredAttributes.has(key),
      ),
    ),
  );
}

/** Mirrors the tracker's block comparison: type, attributes and wrapper types. */
function sameBlock(a: TrackedBlockSnapshot, b: TrackedBlockSnapshot, ctx: Context): boolean {
  if (a.type !== b.type) return false;
  if (filteredAttributes(a.attrs, ctx) !== filteredAttributes(b.attrs, ctx)) return false;
  if (a.wrappers.length !== b.wrappers.length) return false;
  return a.wrappers.every((w, i) => w.type === b.wrappers[i].type);
}

const hasBlockChange = (node: ProsemirrorNode) =>
  !!node.type.spec.attrs && BLOCK_CHANGE_ATTRIBUTE in node.type.spec.attrs;

const label = (node: ProsemirrorNode) => node.type.name;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function normalize(text: string, ctx: Context): string {
  let result = ctx.ignoreWhitespace ? text.replace(/\s+/g, " ") : text;
  if (ctx.ignoreCase) result = result.toLowerCase();
  return result;
}

function leafKey(node: ProsemirrorNode): string {
  return `${node.type.name}${stableStringify(stripBlockChange(node.attrs))}`;
}

function group(node: ProsemirrorNode): string {
  return LIST_TYPES.has(node.type.name) ? "list" : node.type.name;
}

/** Block key: textblocks by their (normalized) text only, so type changes pair up. */
function blockKey(node: ProsemirrorNode, ctx: Context): string {
  const cached = ctx.keys.get(node);
  if (cached !== undefined) return cached;
  let key: string;
  if (node.isTextblock) {
    let text = "";
    node.forEach((child) => {
      text += child.isText ? child.text : `${OBJECT_REPLACEMENT}${leafKey(child)}${OBJECT_REPLACEMENT}`;
    });
    text = normalize(text, ctx);
    key = `T\u0000${ctx.ignoreWhitespace ? text.trim() : text}`;
  } else if (node.isLeaf) {
    key = `A\u0000${leafKey(node)}`;
  } else {
    const parts: string[] = [];
    node.forEach((child) => parts.push(blockKey(child, ctx)));
    key = `C\u0000${group(node)}\u0000${parts.join("\u0001")}\u0002`;
  }
  ctx.keys.set(node, key);
  return key;
}

function compatible(a: ProsemirrorNode, b: ProsemirrorNode): boolean {
  if (a.isTextblock || b.isTextblock) return a.isTextblock && b.isTextblock;
  if (a.isLeaf || b.isLeaf) return a.isLeaf && b.isLeaf && a.type === b.type;
  return group(a) === group(b);
}

// ---------------------------------------------------------------------------
// Whole blocks
// ---------------------------------------------------------------------------

function markInline(
  content: Fragment,
  mark: ProsemirrorMark,
): Fragment {
  const nodes: ProsemirrorNode[] = [];
  content.forEach((child) => nodes.push(child.mark(mark.addToSet(child.marks))));
  return Fragment.from(nodes);
}

/**
 * A block deleted or inserted as a whole: every textblock inside gets a
 * `blockChange` record with the operation (one change id per run).
 */
function wholeBlock(
  node: ProsemirrorNode,
  operation: TrackedBlockOperation,
  wrappers: Wrapper[],
  attrs: () => TrackedChangeAttributes,
  ctx: Context,
): ProsemirrorNode[] {
  const verb = operation === "insert" ? "Inserted" : "Deleted";
  if (node.isTextblock) {
    if (hasBlockChange(node)) {
      const record: TrackedBlockChangeAttributes = {
        ...attrs(),
        previous: snapshot(node, wrappers),
        operation,
      };
      return [node.type.create({ ...node.attrs, [BLOCK_CHANGE_ATTRIBUTE]: record }, node.content, node.marks)];
    }
    // No block record: fall back to marking the text.
    const markType = operation === "insert" ? ctx.insertion : ctx.deletion;
    if (markType && node.type.allowsMarkType(markType) && node.content.size > 0) {
      ctx.notes.add(
        `${verb} ${label(node)} blocks have no "${BLOCK_CHANGE_ATTRIBUTE}" attribute: only their text is tracked, so an empty block remains when the change is ${operation === "insert" ? "rejected" : "accepted"}.`,
      );
      return [node.type.create(node.attrs, markInline(node.content, markType.create(attrs())), node.marks)];
    }
    ctx.notes.add(`${verb} ${label(node)} blocks cannot be tracked.`);
    return operation === "insert" ? [node] : [];
  }
  if (node.isLeaf) {
    ctx.notes.add(`${verb} ${label(node)} blocks cannot be tracked.`);
    return operation === "insert" ? [node] : [];
  }
  const inner = [...wrappers, wrapperOf(node)];
  const children: ProsemirrorNode[] = [];
  node.forEach((child) => children.push(...wholeBlock(child, operation, inner, attrs, ctx)));
  try {
    return [node.type.createChecked(node.attrs, children, node.marks)];
  } catch {
    ctx.notes.add(`${verb} ${label(node)} blocks cannot be tracked.`);
    return operation === "insert" ? [node] : [];
  }
}

// ---------------------------------------------------------------------------
// Inline comparison
// ---------------------------------------------------------------------------

function units(node: ProsemirrorNode): Unit[] {
  const result: Unit[] = [];
  node.forEach((child) => {
    if (child.isText) {
      for (const ch of child.text ?? "") result.push({ text: ch, node: null, marks: child.marks });
    } else {
      result.push({ text: "", node: child, marks: child.marks });
    }
  });
  return result;
}

const SPACE = /\s/u;
const WORD = /[\p{L}\p{N}\p{M}_]/u;

const isSpace = (u: Unit) => !u.node && SPACE.test(u.text);
const isWord = (u: Unit) => !u.node && WORD.test(u.text);

/** Token ranges: words, white space runs and single symbols, or characters. */
function tokenize(list: Unit[], chars: boolean): [number, number][] {
  const tokens: [number, number][] = [];
  if (chars) {
    for (let i = 0; i < list.length; i++) tokens.push([i, i + 1]);
    return tokens;
  }
  let i = 0;
  while (i < list.length) {
    const start = i;
    const unit = list[i];
    if (isSpace(unit)) {
      while (i < list.length && isSpace(list[i])) i++;
    } else if (isWord(unit)) {
      while (i < list.length && isWord(list[i])) i++;
    } else {
      i++;
    }
    tokens.push([start, i]);
  }
  return tokens;
}

type Stretch =
  | { type: "equal"; aIndex: number; bIndex: number; length: number }
  | { type: "change"; aFrom: number; aTo: number; bFrom: number; bTo: number };

/**
 * Groups token runs into equal stretches and changes. White space alone
 * between two changes joins them, so "a b" → "x y" reads as one
 * replacement instead of alternating deletions and insertions.
 */
function stretches(runs: ReturnType<typeof diffSequences>, list: Unit[], tokens: [number, number][]): Stretch[] {
  const spaceOnly = (bIndex: number, length: number) => {
    for (let t = bIndex; t < bIndex + length; t++) {
      const [from, to] = tokens[t];
      for (let k = from; k < to; k++) if (!isSpace(list[k])) return false;
    }
    return true;
  };
  const result: Stretch[] = [];
  runs.forEach((run, index) => {
    const prev = runs[index - 1];
    const next = runs[index + 1];
    const absorbed =
      run.type === "equal" &&
      prev &&
      next &&
      prev.type !== "equal" &&
      next.type !== "equal" &&
      spaceOnly(run.bIndex, run.length);
    if (run.type === "equal" && !absorbed) {
      result.push({ type: "equal", aIndex: run.aIndex, bIndex: run.bIndex, length: run.length });
      return;
    }
    let last = result[result.length - 1];
    if (!last || last.type !== "change") {
      last = { type: "change", aFrom: run.aIndex, aTo: run.aIndex, bFrom: run.bIndex, bTo: run.bIndex };
      result.push(last);
    }
    if (run.type !== "insert") last.aTo = run.aIndex + run.length;
    if (run.type !== "delete") last.bTo = run.bIndex + run.length;
  });
  return result;
}

function tokenKey(list: Unit[], [from, to]: [number, number], ctx: Context): string {
  let text = "";
  for (let i = from; i < to; i++) {
    const unit = list[i];
    text += unit.node ? `${OBJECT_REPLACEMENT}${leafKey(unit.node)}${OBJECT_REPLACEMENT}` : unit.text;
  }
  return normalize(text, ctx);
}

function formattingOf(marks: readonly ProsemirrorMark[], ctx: Context): ProsemirrorMark[] {
  return marks.filter(
    (mark) => !REVIEW_MARK_NAMES.has(mark.type.name) && !ctx.ignoredMarks.has(mark.type.name),
  );
}

function withoutReviewMarks(marks: readonly ProsemirrorMark[]): readonly ProsemirrorMark[] {
  return marks.filter(
    (mark) =>
      mark.type.name !== INSERTION_MARK_NAME &&
      mark.type.name !== DELETION_MARK_NAME &&
      mark.type.name !== FORMAT_CHANGE_MARK_NAME,
  );
}

/**
 * Merges the inline content of two paired textblocks: equal tokens keep the
 * revised text (with `formatChange` where formatting differs), deleted
 * tokens are re-inserted with the `deletion` mark before inserted tokens.
 */
function mergeInline(
  original: ProsemirrorNode,
  revised: ProsemirrorNode,
  parentType: ProsemirrorNode["type"],
  ctx: Context,
): Fragment {
  const a = units(original);
  const b = units(revised);
  let chars = ctx.granularity === "char";
  if (chars && Math.max(a.length, b.length) > ctx.maxCharDiff) {
    chars = false;
    ctx.notes.add(
      `Paragraphs longer than ${ctx.maxCharDiff} characters were compared by words instead of characters.`,
    );
  }
  const ta = tokenize(a, chars);
  const tb = tokenize(b, chars);
  const runs = diffSequences(
    ta.map((t) => tokenKey(a, t, ctx)),
    tb.map((t) => tokenKey(b, t, ctx)),
  );

  const format = ctx.formatting && ctx.format && parentType.allowsMarkType(ctx.format) ? ctx.format : null;
  const out: Unit[] = [];
  let formatRun: { attrs: TrackedChangeAttributes; key: string } | null = null;

  const emit = (
    source: Unit[],
    tokens: [number, number][],
    from: number,
    to: number,
    markType: MarkType,
  ) => {
    if (to <= from) return;
    const mark = markType.create(newAttributes(ctx));
    for (let k = tokens[from][0]; k < tokens[to - 1][1]; k++) {
      const unit = source[k];
      out.push({ ...unit, marks: mark.addToSet(withoutReviewMarks(unit.marks)) });
    }
  };

  for (const run of stretches(runs, b, tb)) {
    if (run.type === "equal") {
      for (let t = 0; t < run.length; t++) {
        const [aFrom, aTo] = ta[run.aIndex + t];
        const [bFrom, bTo] = tb[run.bIndex + t];
        for (let k = bFrom; k < bTo; k++) {
          const unit = b[k];
          const before = a[Math.min(aFrom + (k - bFrom), aTo - 1)];
          const marks = withoutReviewMarks(unit.marks);
          if (!format) {
            formatRun = null;
            out.push({ ...unit, marks });
            continue;
          }
          const oldFormat = formattingOf(before.marks, ctx);
          const newFormat = formattingOf(unit.marks, ctx);
          if (ProsemirrorMark.sameSet(oldFormat, newFormat)) {
            formatRun = null;
            out.push({ ...unit, marks });
            continue;
          }
          const beforeJSON = oldFormat.map((m) => m.toJSON() as TrackedMark);
          const afterJSON = newFormat.map((m) => m.toJSON() as TrackedMark);
          const key = stableStringify([beforeJSON, afterJSON]);
          if (!formatRun || formatRun.key !== key) formatRun = { attrs: newAttributes(ctx), key };
          const mark = format.create({ ...formatRun.attrs, before: beforeJSON, after: afterJSON });
          out.push({ ...unit, marks: mark.addToSet(marks) });
        }
      }
      continue;
    }
    formatRun = null;
    emit(a, ta, run.aFrom, run.aTo, ctx.deletion!);
    emit(b, tb, run.bFrom, run.bTo, ctx.insertion!);
  }

  const nodes: ProsemirrorNode[] = [];
  let i = 0;
  while (i < out.length) {
    const unit = out[i];
    if (unit.node) {
      nodes.push(unit.node.mark(unit.marks));
      i++;
      continue;
    }
    let text = unit.text;
    let j = i + 1;
    while (j < out.length && !out[j].node && ProsemirrorMark.sameSet(out[j].marks, unit.marks)) {
      text += out[j].text;
      j++;
    }
    nodes.push(ctx.schema.text(text, unit.marks));
    i = j;
  }
  return Fragment.from(nodes);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function mergeTextblocks(
  original: ProsemirrorNode,
  revised: ProsemirrorNode,
  oPath: Wrapper[],
  rPath: Wrapper[],
  ctx: Context,
): ProsemirrorNode[] {
  const replaceWhole = () => [
    ...wholeBlock(original, "delete", rPath, lazyAttributes(ctx), ctx),
    ...wholeBlock(revised, "insert", rPath, lazyAttributes(ctx), ctx),
  ];

  let attrs: Record<string, any> = { ...revised.attrs };
  const previous = snapshot(original, oPath);
  if (!sameBlock(previous, snapshot(revised, rPath), ctx)) {
    if (hasBlockChange(revised)) {
      // Only the wrappers changed (e.g. bulleted → numbered list): one change per container.
      const onlyWrappers =
        ctx.wrapperChange &&
        sameBlock(previous, { ...snapshot(revised, rPath), wrappers: previous.wrappers }, ctx);
      const base = onlyWrappers ? ctx.wrapperChange!() : newAttributes(ctx);
      attrs = { ...attrs, [BLOCK_CHANGE_ATTRIBUTE]: { ...base, previous } };
    } else {
      ctx.notes.add(`Block changes to ${label(revised)} blocks cannot be tracked.`);
    }
  } else if (BLOCK_CHANGE_ATTRIBUTE in attrs) {
    attrs[BLOCK_CHANGE_ATTRIBUTE] = null;
  }

  const type = revised.type;
  const inlineTracking =
    !!ctx.insertion &&
    !!ctx.deletion &&
    type.allowsMarkType(ctx.insertion) &&
    type.allowsMarkType(ctx.deletion);
  if (!inlineTracking) {
    // e.g. code blocks in a headless schema: equal text keeps the block,
    // anything else is replaced whole.
    if (!original.content.eq(revised.content)) return replaceWhole();
    return [type.create(attrs, revised.content, revised.marks)];
  }
  const content = mergeInline(original, revised, type, ctx);
  if (!type.validContent(content)) {
    ctx.notes.add(`Changes between ${label(original)} and ${label(revised)} blocks were tracked as whole-block replacements.`);
    return replaceWhole();
  }
  return [type.create(attrs, content, revised.marks)];
}

function mergePair(
  original: ProsemirrorNode,
  revised: ProsemirrorNode,
  oPath: Wrapper[],
  rPath: Wrapper[],
  ctx: Context,
): ProsemirrorNode[] {
  if (original.isTextblock) return mergeTextblocks(original, revised, oPath, rPath, ctx);
  const replaceWhole = () => [
    ...wholeBlock(original, "delete", rPath, lazyAttributes(ctx), ctx),
    ...wholeBlock(revised, "insert", rPath, lazyAttributes(ctx), ctx),
  ];
  if (original.isLeaf) {
    return original.eq(revised) ? [revised] : replaceWhole();
  }
  if (
    original.type === revised.type &&
    filteredAttributes(original.attrs, ctx) !== filteredAttributes(revised.attrs, ctx)
  ) {
    ctx.notes.add(`Attribute changes of ${label(revised)} nodes are not tracked.`);
  }
  const outer = ctx.wrapperChange;
  if (original.type !== revised.type) ctx.wrapperChange = lazyAttributes(ctx);
  let children: ProsemirrorNode[];
  try {
    children = compareChildren(
      original,
      revised,
      [...oPath, wrapperOf(original)],
      [...rPath, wrapperOf(revised)],
      ctx,
    );
  } finally {
    ctx.wrapperChange = outer;
  }
  try {
    return [revised.type.createChecked(revised.attrs, children, revised.marks)];
  } catch {
    ctx.notes.add(`Changes inside ${label(revised)} nodes were tracked as whole-block replacements.`);
    return replaceWhole();
  }
}

function compareChildren(
  original: ProsemirrorNode,
  revised: ProsemirrorNode,
  oPath: Wrapper[],
  rPath: Wrapper[],
  ctx: Context,
): ProsemirrorNode[] {
  const a: ProsemirrorNode[] = [];
  const b: ProsemirrorNode[] = [];
  original.forEach((child) => a.push(child));
  revised.forEach((child) => b.push(child));
  const runs = diffSequences(a, b, { hash: (node) => blockKey(node, ctx) });
  const out: ProsemirrorNode[] = [];

  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    if (run.type === "equal") {
      for (let t = 0; t < run.length; t++) {
        out.push(...mergePair(a[run.aIndex + t], b[run.bIndex + t], oPath, rPath, ctx));
      }
      continue;
    }
    // A run of deletions and insertions: the i-th deleted block pairs with
    // the i-th inserted one when they are alike; the rest are whole.
    let dels: ProsemirrorNode[] = [];
    let inss: ProsemirrorNode[] = [];
    if (run.type === "delete") {
      dels = a.slice(run.aIndex, run.aIndex + run.length);
      const next = runs[r + 1];
      if (next?.type === "insert") {
        inss = b.slice(next.bIndex, next.bIndex + next.length);
        r++;
      }
    } else {
      inss = b.slice(run.bIndex, run.bIndex + run.length);
    }
    const deleted = lazyAttributes(ctx);
    const inserted = lazyAttributes(ctx);
    for (let x = 0; x < Math.max(dels.length, inss.length); x++) {
      const del = dels[x];
      const ins = inss[x];
      if (del && ins && compatible(del, ins)) {
        out.push(...mergePair(del, ins, oPath, rPath, ctx));
        continue;
      }
      if (del) out.push(...wholeBlock(del, "delete", rPath, deleted, ctx));
      if (ins) out.push(...wholeBlock(ins, "insert", rPath, inserted, ctx));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function summarize(doc: ProsemirrorNode, notes: Set<string>): CompareSummary {
  const summary: CompareSummary = {
    insertions: 0,
    deletions: 0,
    formatChanges: 0,
    blockChanges: 0,
    notHonoured: [...notes],
  };
  getTrackedChanges(doc).forEach((change) => {
    if (change.type === "insertion" || change.block?.operation === "insert") summary.insertions++;
    else if (change.type === "deletion" || change.block?.operation === "delete") summary.deletions++;
    else if (change.type === "format") summary.formatChanges++;
    else summary.blockChanges++;
  });
  return summary;
}

/**
 * Compares two documents and returns the revised document with the
 * differences as tracked changes (`insertion`/`deletion`/`formatChange`
 * marks and `blockChange` records), plus a summary.
 *
 * Blocks are matched by their text (Myers diff with patience anchors); in a
 * run of changed blocks the i-th deleted block is paired with the i-th
 * inserted one and compared word by word (or by character), while unpaired
 * blocks are recorded as whole-block insertions/deletions. Equal text is
 * compared for formatting, and type/attribute/wrapping changes become
 * `blockChange` records. Without ignore options, accepting all changes
 * yields the revised document and rejecting all yields the original.
 *
 * The schema needs the `TrackChanges` extension (marks and the
 * `blockChange` attribute). Existing tracked changes in either document are
 * accepted first.
 */
export function compareDocuments(
  original: CompareSource,
  revised: CompareSource,
  options: CompareDocumentsOptions = {},
): CompareDocumentsResult {
  const schema =
    options.schema ??
    (typeof (original as ProsemirrorNode)?.descendants === "function"
      ? (original as ProsemirrorNode).type.schema
      : typeof (revised as ProsemirrorNode)?.descendants === "function"
        ? (revised as ProsemirrorNode).type.schema
        : null);
  if (!schema) throw new Error("compareDocuments: `schema` is required for JSON or HTML sources.");

  const ctx: Context = {
    schema,
    author: options.author ?? { id: "compare", name: "Compare" },
    createdAt: toTime(options.date),
    generateId: options.generateId ?? (() => createReviewId("change")),
    granularity: options.granularity ?? "word",
    ignoreCase: !!options.ignoreCase,
    ignoreWhitespace: !!options.ignoreWhitespace,
    formatting: options.formatting !== false,
    maxCharDiff: options.maxCharDiff ?? 2000,
    ignoredMarks: new Set(options.ignoredMarks ?? []),
    ignoredAttributes: new Set(options.ignoredBlockAttributes ?? ["id"]),
    insertion: schema.marks[INSERTION_MARK_NAME],
    deletion: schema.marks[DELETION_MARK_NAME],
    format: schema.marks[FORMAT_CHANGE_MARK_NAME],
    notes: new Set(),
    keys: new Map(),
    wrapperChange: null,
  };
  if (!ctx.insertion || !ctx.deletion) {
    throw new Error("compareDocuments: the schema needs the TrackChanges extension (insertion/deletion marks).");
  }
  if (ctx.formatting && !ctx.format) {
    ctx.notes.add("Formatting differences cannot be tracked: the schema has no formatChange mark.");
  }

  const prepare = (source: CompareSource) => {
    const doc = toNode(source, schema);
    if (getTrackedChanges(doc).length === 0) return doc;
    ctx.notes.add("Tracked changes already in the documents were accepted before comparing.");
    return resolveTrackedChanges(doc, "accepted");
  };
  const a = prepare(original);
  const b = prepare(revised);

  const children = compareChildren(a, b, [], [], ctx);
  let doc: ProsemirrorNode;
  try {
    doc = b.type.createChecked(b.attrs, children, b.marks);
  } catch {
    doc = b.type.createAndFill(b.attrs, children, b.marks) ?? b;
    ctx.notes.add("The compared document had to be repaired to fit the schema.");
  }
  return { doc, summary: summarize(doc, ctx.notes) };
}

/** `compareDocuments` for two HTML strings (needs a DOM, like `setContent`). */
export function compareHtml(
  originalHtml: string,
  revisedHtml: string,
  options: CompareDocumentsOptions & { schema: Schema },
): CompareDocumentsResult {
  return compareDocuments(originalHtml, revisedHtml, options);
}
