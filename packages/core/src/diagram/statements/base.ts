import type {
  AdapterParseContext,
  Diagnostic,
  DiagramAdapter,
  DiagramFamily,
  DiagramGraph,
  EditOp,
  MermaidDocument,
  Point,
} from "../types.js";
import { assembleDocument } from "../flowchart/serialize.js";
import { setFrontmatterTitle } from "../lines-grammar/engine.js";
import { splitSource } from "../source/lines.js";
import {
  defaultCarrierFor,
  emptyMeta,
  extractMetaFromBody,
  extractMetaFromFrontmatter,
  mergeMeta,
} from "../source/metadata.js";

/**
 * Shared scaffolding for statement-based adapters whose semantics do not fit
 * the flowchart-like line-grammar engine (sequence, gantt, pie, mindmap,
 * timeline, journey, gitGraph, architecture, quadrant…).
 *
 * A grammar turns body lines into typed statements that always keep their
 * `raw` text. Serialisation emits `raw` for untouched statements and
 * `format(stmt)` for dirty ones, so untouched documents round-trip
 * byte-for-byte. Edits mutate a shallow copy of the statement list, then the
 * document is serialised and re-parsed so `graph` always matches `source`.
 *
 * The base handles metadata ops (`moveNodes`, `resizeNode`, `setViewport`,
 * `setMetaExt`), `replaceSource` and a frontmatter fallback for `setTitle`;
 * everything else is delegated to `grammar.edit`.
 *
 * @module
 */

/** Minimum shape of a statement: raw text plus a dirty flag. */
export interface BaseStatement {
  raw: string;
  indent: string;
  /** When true, {@link StatementGrammar.format} regenerates the text. */
  dirty?: boolean;
}

export interface StatementBody<S extends BaseStatement> {
  statements: S[];
}

export type StatementDocument<S extends BaseStatement> = MermaidDocument<StatementBody<S>>;

export interface GraphBuildContext {
  header: string;
  /** `title` from the frontmatter, if any. */
  frontmatterTitle?: string;
  meta: AdapterParseContext["meta"];
}

export interface EditContext<S extends BaseStatement> {
  /** The document the edit is applied to (read-only; `statements` is the working copy). */
  doc: StatementDocument<S>;
  /** Mutable working copy of the statement list. */
  statements: S[];
  /** Mutable copy of the metadata (layout/sizes already cloned). */
  meta: AdapterParseContext["meta"];
  /** Indentation unit detected in the document (or the grammar default). */
  indent: string;
  /** Replaces the header line (families that encode settings in it). */
  setHeader(header: string): void;
  /** Replaces the preamble lines (frontmatter edits). */
  setPreambleLines(lines: string[]): void;
}

export interface StatementGrammar<S extends BaseStatement> {
  family: DiagramFamily;
  /** Groups physical lines into logical statements (default: one per line). */
  joinLines?(lines: string[]): string[];
  parseLine(line: string, index: number, all: string[]): S;
  /** Regenerates the text of a dirty statement (may return several lines joined by `\n`). */
  format(stmt: S): string;
  buildGraph(
    statements: S[],
    ctx: GraphBuildContext,
  ): { graph: DiagramGraph; diagnostics?: Diagnostic[] };
  /**
   * Applies a structural edit by mutating `ctx.statements` (and/or header,
   * preamble, meta). Return `false` for ops the family does not support; the
   * document is then returned unchanged.
   */
  edit(op: EditOp, ctx: EditContext<S>): boolean;
  /**
   * Optional hook for families whose positions are data rather than layout
   * metadata (quadrant points: moving a point rewrites its coordinates). Called
   * before the base's own handling of `moveNodes`, `resizeNode`, `setViewport`
   * and `setMetaExt`; return `true` when the op was handled (the document is
   * then serialised and re-parsed), `false` to fall back to the default.
   */
  interceptMeta?(op: EditOp, ctx: EditContext<S>): boolean;
  /** Indentation unit used when the document has none. */
  defaultIndent?: string;
  /**
   * Whether `setTitle` is handled by `edit` (a `title` statement) rather than
   * by the frontmatter fallback. Default false.
   */
  titleAsStatement?: boolean;
}

function detectIndent(statements: BaseStatement[], fallback: string): string {
  for (const s of statements) if (s.indent) return s.indent;
  return fallback;
}

export function parseStatementDocument<S extends BaseStatement>(
  grammar: StatementGrammar<S>,
  source: string,
  ctx: AdapterParseContext,
): StatementDocument<S> {
  const logical = grammar.joinLines ? grammar.joinLines(ctx.bodyLines) : ctx.bodyLines;
  const statements = logical.map((line, i) => grammar.parseLine(line, i, logical));
  const frontmatterTitle =
    typeof ctx.preamble.frontmatter?.title === "string"
      ? ctx.preamble.frontmatter.title
      : undefined;
  const { graph, diagnostics } = grammar.buildGraph(statements, {
    header: ctx.header,
    frontmatterTitle,
    meta: ctx.meta,
  });
  if (graph.title === undefined && frontmatterTitle !== undefined) graph.title = frontmatterTitle;
  return {
    family: grammar.family,
    tier: "editable",
    source,
    preamble: ctx.preamble,
    header: ctx.header,
    trailing: ctx.trailing,
    eol: ctx.eol,
    graph,
    meta: ctx.meta,
    metaCarrier: ctx.metaCarrier,
    body: { statements },
    diagnostics: diagnostics ?? [],
    dirty: false,
  };
}

export function serializeStatementDocument<S extends BaseStatement>(
  grammar: StatementGrammar<S>,
  doc: StatementDocument<S>,
): string {
  const lines: string[] = [];
  for (const stmt of doc.body.statements) {
    const text = stmt.dirty ? grammar.format(stmt) : stmt.raw;
    lines.push(...text.split("\n"));
  }
  return assembleDocument(
    doc,
    lines,
    detectIndent(doc.body.statements, grammar.defaultIndent ?? "  "),
  );
}

function parseFull<S extends BaseStatement>(
  grammar: StatementGrammar<S>,
  source: string,
  carrier?: MermaidDocument["metaCarrier"],
): StatementDocument<S> {
  const split = splitSource(source);
  const fromBody = extractMetaFromBody(split.bodyLines);
  const fromFm = extractMetaFromFrontmatter(split.preamble);
  let meta = emptyMeta();
  if (fromFm) meta = mergeMeta(meta, fromFm);
  if (fromBody.meta) meta = mergeMeta(meta, fromBody.meta);
  return parseStatementDocument(grammar, source, {
    source,
    eol: split.eol,
    preamble: split.preamble,
    header: split.header,
    bodyLines: fromBody.bodyLines,
    trailing: split.trailing,
    meta,
    metaCarrier:
      carrier ?? (fromFm && !fromBody.meta ? "frontmatter" : defaultCarrierFor(grammar.family)),
    family: grammar.family,
  });
}

export function applyStatementEdit<S extends BaseStatement>(
  grammar: StatementGrammar<S>,
  doc: StatementDocument<S>,
  op: EditOp,
): StatementDocument<S> {
  const statements = doc.body.statements.map((s) => ({ ...s })) as S[];
  const work: StatementDocument<S> = {
    ...doc,
    body: { statements },
    meta: { ...doc.meta, layout: { ...doc.meta.layout }, sizes: { ...doc.meta.sizes } },
  };
  const reparse = (structural: boolean): StatementDocument<S> => {
    const text = serializeStatementDocument(grammar, work);
    const next = parseFull(grammar, text, work.metaCarrier);
    next.dirty = doc.dirty || structural;
    return next;
  };

  const makeContext = (): EditContext<S> => ({
    doc,
    statements,
    meta: work.meta,
    indent: detectIndent(statements, grammar.defaultIndent ?? "  "),
    setHeader: (h) => {
      work.header = h;
    },
    setPreambleLines: (lines) => {
      work.preamble = { ...work.preamble, lines };
    },
  });
  const metaOp =
    op.type === "moveNodes" ||
    op.type === "resizeNode" ||
    op.type === "setViewport" ||
    op.type === "setMetaExt";
  if (metaOp && grammar.interceptMeta?.(op, makeContext())) return reparse(true);

  switch (op.type) {
    case "moveNodes":
      for (const { id, position } of op.moves) work.meta.layout![id] = position as Point;
      break;
    case "resizeNode":
      if (op.size) work.meta.sizes![op.id] = op.size;
      else delete work.meta.sizes![op.id];
      break;
    case "setViewport":
      work.meta.viewport = op.viewport;
      break;
    case "setMetaExt":
      work.meta.ext = { ...(work.meta.ext ?? {}), [op.key]: op.value };
      if (op.value === undefined) delete work.meta.ext[op.key];
      break;
    case "replaceSource":
      return parseFull(grammar, op.source, work.metaCarrier);
    default: {
      let handled = grammar.edit(op, makeContext());
      if (!handled && op.type === "setTitle" && !grammar.titleAsStatement) {
        work.preamble = {
          ...work.preamble,
          lines: setFrontmatterTitle(work.preamble.lines, op.title),
        };
        handled = true;
      }
      if (!handled) return doc;
      return reparse(true);
    }
  }
  return reparse(false);
}

/** Creates a full adapter from a statement grammar. */
export function createStatementAdapter<S extends BaseStatement>(
  grammar: StatementGrammar<S>,
): DiagramAdapter<StatementBody<S>> {
  return {
    family: grammar.family,
    tier: "editable",
    parse: (source, ctx) => parseStatementDocument(grammar, source, ctx),
    serialize: (doc) => serializeStatementDocument(grammar, doc),
    apply: (doc, op) => applyStatementEdit(grammar, doc, op),
  };
}

// ---------------------------------------------------------------------------
// Helpers shared by grammars
// ---------------------------------------------------------------------------

/** Leading whitespace of a line. */
export function indentOf(line: string): string {
  return line.match(/^\s*/)![0];
}

/** Lower-case, `_`-joined identifier derived from free text; `fallback` when empty. */
export function slugId(text: string, fallback = "item"): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

/** Returns `base`, or `base_2`, `base_3`… until unused in `taken` (which is updated). */
export function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

/** Removes the elements for which `keep` is false, in place. */
export function filterInPlace<T>(arr: T[], keep: (item: T, index: number) => boolean): void {
  let j = 0;
  for (let i = 0; i < arr.length; i++) if (keep(arr[i]!, i)) arr[j++] = arr[i]!;
  arr.length = j;
}

/** Moves metadata (layout, size) from one id to another, e.g. after a rename. */
export function renameMetaKey(meta: AdapterParseContext["meta"], from: string, to: string): void {
  if (from === to) return;
  if (meta.layout?.[from]) {
    meta.layout[to] = meta.layout[from]!;
    delete meta.layout[from];
  }
  if (meta.sizes?.[from]) {
    meta.sizes[to] = meta.sizes[from]!;
    delete meta.sizes[from];
  }
}

/** Removes metadata for ids that no longer exist. */
export function dropMetaKeys(meta: AdapterParseContext["meta"], ids: Iterable<string>): void {
  for (const id of ids) {
    delete meta.layout?.[id];
    delete meta.sizes?.[id];
  }
}

/** Wraps text in double quotes, escaping inner quotes Mermaid-style. */
export function quote(text: string): string {
  return `"${text.replace(/"/g, "#quot;")}"`;
}

/** Strips one layer of matching double quotes. */
export function unquote(text: string): string {
  const t = text.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/** Splits on a separator outside quotes/brackets. */
export function splitOutsideQuotes(text: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoteCh: string | null = null;
  let depth = 0;
  for (const ch of text) {
    if (quoteCh) {
      cur += ch;
      if (ch === quoteCh) quoteCh = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteCh = ch;
      cur += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
