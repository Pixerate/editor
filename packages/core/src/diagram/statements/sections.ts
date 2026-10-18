import type { GraphEdge, GraphGroup, GraphNode, Point, DiagramMeta } from "../types.js";
import type { FamilyLayout, LayoutResult, Size } from "../layout-registry.js";
import { filterInPlace, slugId, uniqueId, type BaseStatement, type EditContext } from "./base.js";
import type { EditOp } from "../types.js";

/**
 * Shared machinery for "sections of items" families (gantt, timeline,
 * journey). Their documents share one shape:
 *
 * ```
 * <header>
 *   title Some title
 *   item before any section
 *   section First
 *     item
 *     item
 *   section Second
 *     item
 * ```
 *
 * - `section X` starts a group; every following item belongs to it until the
 *   next `section` line. Items before the first section have no group.
 * - Groups get ids `uniqueId(slugId(label))`; items get ids from the family
 *   (explicit ids first, then slugs of their text). Explicit ids are reserved
 *   first, then item slugs, then section slugs, so that structural edits on
 *   sections (ungroup, rename) never change item ids.
 * - {@link editSections} implements the shared edits (title, add/remove/rename
 *   items, grouping, re-parenting) and re-keys layout metadata by statement
 *   identity after every edit, so any id change (rename, explicit id edit)
 *   carries the stored position along.
 *
 * Families plug in with a {@link SectionsSpec}: how to recognise and create
 * items, how to rename them, and which characters their grammar forbids.
 *
 * @module
 */

/** `title …` statement. */
export interface TitleStatement extends BaseStatement {
  kind: "title";
  title: string;
}

/** `section …` statement (starts a group). */
export interface SectionStatement extends BaseStatement {
  kind: "section";
  label: string;
}

/** A statement the diagram module does not model; always emitted verbatim. */
export interface RawStatement extends BaseStatement {
  kind: "raw";
}

/** Any statement of a sections family: the shared kinds plus family-specific ones. */
export type SectionsStatementBase = BaseStatement & { kind: string };

/** An item (node) with its resolved id and enclosing section. */
export interface SectionItem<I> {
  stmt: I;
  id: string;
  section?: SectionEntry;
}

/** A section (group) with its resolved id. */
export interface SectionEntry {
  stmt: SectionStatement;
  id: string;
}

/** Ids of every item and section in a statement list, in document order. */
export interface SectionsModel<I> {
  items: SectionItem<I>[];
  sections: SectionEntry[];
  itemById: Map<string, SectionItem<I>>;
  sectionById: Map<string, SectionEntry>;
  /** Statement → id, for items and sections (used to re-key metadata). */
  ids: Map<BaseStatement, string>;
}

/** Hooks a family provides to reuse the shared model and edits. */
export interface SectionsSpec<S extends SectionsStatementBase, I extends S> {
  /** Whether a statement is an item (a node). */
  isItem(stmt: S): stmt is I;
  /** Text the derived id is slugged from (task name, period…). */
  itemText(item: I): string;
  /** Explicit id written in the source (gantt task ids), reserved before slugs. */
  explicitId?(item: I): string | undefined;
  /** Slug fallback when the text has no usable characters. */
  fallbackId: string;
  /** Builds a dirty item statement for `addNode`; `null` refuses the op. */
  createItem(
    node: Partial<GraphNode>,
    ctx: { indent: string; statements: S[]; model: SectionsModel<I> },
  ): I | null;
  /** Applies a new label to an item (mark it dirty); false refuses. */
  renameItem(item: I, label: string): boolean;
  /** Characters the family's grammar does not allow in section labels. */
  sectionForbidden?: RegExp;
  /** Characters the family's grammar does not allow in titles. */
  titleForbidden?: RegExp;
  /**
   * Where a missing `title` statement is inserted (index in `statements`).
   * Default: right after the header (index 0).
   */
  titleIndex?(statements: S[]): number;
}

/** Parses the shared `title` / `section` lines; `null` for anything else. */
export function parseSectionsLine(
  line: string,
  indent: string,
): TitleStatement | SectionStatement | null {
  const text = line.trim();
  let m: RegExpExecArray | null;
  if ((m = /^title(?:\s+(.*))?$/i.exec(text)) && !/^title\s*:/i.test(text))
    return { kind: "title", raw: line, indent, title: (m[1] ?? "").trim() };
  if ((m = /^section(?:\s+(.*))?$/i.exec(text)))
    return { kind: "section", raw: line, indent, label: (m[1] ?? "").trim() };
  return null;
}

/** Formats a dirty `title` / `section` statement; `undefined` for other kinds. */
export function formatSectionsLine(stmt: SectionsStatementBase): string | undefined {
  if (stmt.kind === "title") return `${stmt.indent}title ${(stmt as TitleStatement).title}`;
  if (stmt.kind === "section") return `${stmt.indent}section ${(stmt as SectionStatement).label}`;
  return undefined;
}

/**
 * Groups multi-line `accDescr { … }` blocks into one logical statement so
 * their inner lines are never mistaken for items. Use as (part of) a
 * grammar's `joinLines`.
 */
export function joinAccDescrBlocks(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*accDescr\s*\{/.test(line) && !line.includes("}")) {
      const block = [line];
      while (i + 1 < lines.length) {
        const next = lines[++i]!;
        block.push(next);
        if (next.includes("}")) break;
      }
      out.push(block.join("\n"));
    } else out.push(line);
  }
  return out;
}

/** Resolves ids for every item and section of a statement list. */
export function buildSectionsModel<S extends SectionsStatementBase, I extends S>(
  statements: S[],
  spec: SectionsSpec<S, I>,
): SectionsModel<I> {
  const taken = new Set<string>();
  const ids = new Map<BaseStatement, string>();
  for (const s of statements) {
    const explicit = spec.isItem(s) ? spec.explicitId?.(s) : undefined;
    if (explicit && !taken.has(explicit)) {
      taken.add(explicit);
      ids.set(s, explicit);
    }
  }
  for (const s of statements)
    if (spec.isItem(s) && !ids.has(s))
      ids.set(s, uniqueId(slugId(spec.itemText(s), spec.fallbackId), taken));
  for (const s of statements)
    if (s.kind === "section")
      ids.set(s, uniqueId(slugId((s as unknown as SectionStatement).label, "section"), taken));

  const model: SectionsModel<I> = {
    items: [],
    sections: [],
    itemById: new Map(),
    sectionById: new Map(),
    ids,
  };
  let current: SectionEntry | undefined;
  for (const s of statements) {
    if (s.kind === "section") {
      current = { stmt: s as unknown as SectionStatement, id: ids.get(s)! };
      model.sections.push(current);
      model.sectionById.set(current.id, current);
    } else if (spec.isItem(s)) {
      const item: SectionItem<I> = { stmt: s, id: ids.get(s)!, section: current };
      model.items.push(item);
      model.itemById.set(item.id, item);
    }
  }
  return model;
}

/** Text of the last `title` statement, if any. */
export function sectionsTitle(statements: SectionsStatementBase[]): string | undefined {
  let title: string | undefined;
  for (const s of statements) if (s.kind === "title") title = (s as TitleStatement).title;
  return title;
}

/** One {@link GraphGroup} per section, in document order. */
export function sectionGroups<I>(model: SectionsModel<I>): GraphGroup[] {
  return model.sections.map((s) => ({ id: s.id, label: s.stmt.label, classes: [], styles: [] }));
}

/**
 * Synthetic solid edges between consecutive items so the canvas reads as a
 * sequence. They carry `data.synthetic: true` and cannot be edited.
 */
export function sequenceEdges<I>(model: SectionsModel<I>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 1; i < model.items.length; i++) {
    const a = model.items[i - 1]!.id;
    const b = model.items[i]!.id;
    edges.push({
      id: `L_${a}_${b}_0`,
      source: a,
      target: b,
      pattern: "solid",
      arrowStart: "none",
      arrowEnd: "none",
      length: 1,
      classes: [],
      styles: [],
      userDefinedId: false,
      data: { synthetic: true },
    });
  }
  return edges;
}

/** Removes forbidden characters and newlines, collapsing whitespace. */
export function cleanText(text: string, forbidden?: RegExp): string {
  let t = text.replace(/[\r\n]+/g, " ");
  if (forbidden) t = t.replace(new RegExp(forbidden.source, "g"), "");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Re-indents a (possibly multi-line) statement: the first line gets `indent`,
 * continuation lines keep their offset relative to the old indentation.
 */
export function reindent(stmt: BaseStatement, indent: string): void {
  if (stmt.indent === indent) return;
  const old = stmt.indent;
  stmt.raw = stmt.raw
    .split("\n")
    .map((line, i) => {
      if (i === 0) return indent + line.slice(old.length);
      if (line.startsWith(old)) return indent + line.slice(old.length);
      return line;
    })
    .join("\n");
  stmt.indent = indent;
}

/**
 * Re-keys layout/size metadata after an edit: statements whose id changed
 * carry their entries to the new id; removed statements lose theirs.
 */
export function remapMeta(
  meta: DiagramMeta,
  before: Map<BaseStatement, string>,
  after: Map<BaseStatement, string>,
): void {
  const moved: { to?: string; layout?: Point; size?: readonly [number, number] }[] = [];
  for (const [stmt, from] of before) {
    const to = after.get(stmt);
    if (to === from) continue;
    moved.push({ to, layout: meta.layout?.[from], size: meta.sizes?.[from] });
    delete meta.layout?.[from];
    delete meta.sizes?.[from];
  }
  for (const m of moved) {
    if (!m.to) continue;
    if (m.layout && meta.layout) meta.layout[m.to] = m.layout;
    if (m.size && meta.sizes) meta.sizes[m.to] = m.size;
  }
}

/** Indentation for an item placed in `section` (or outside any section). */
function itemIndent<I extends BaseStatement>(
  model: SectionsModel<I>,
  section: SectionEntry | undefined,
  unit: string,
): string {
  const peers = model.items.filter((i) => i.section === section);
  if (peers.length) return peers.at(-1)!.stmt.indent;
  if (section) {
    const nested = model.items.find((i) => i.section);
    return nested ? nested.stmt.indent : section.stmt.indent + unit;
  }
  return model.sections[0]?.stmt.indent ?? unit;
}

/** Index right after the last item of `section` (or after its header line). */
function endOfSection<S extends SectionsStatementBase, I extends S>(
  statements: S[],
  section: SectionStatement,
  spec: SectionsSpec<S, I>,
): number {
  const start = statements.indexOf(section as unknown as S);
  let at = start + 1;
  for (let i = start + 1; i < statements.length; i++) {
    const s = statements[i]!;
    if (s.kind === "section") break;
    if (spec.isItem(s)) at = i + 1;
  }
  return at;
}

function makeSection<S>(label: string, indent: string): S {
  const stmt: SectionStatement = { kind: "section", raw: "", indent, label, dirty: true };
  return stmt as unknown as S;
}

/**
 * Applies an edit to a sections family. `custom` runs first and handles the
 * family-specific ops (node data, shapes, edges…): it returns `true`/`false`
 * when it handled/refused the op and `undefined` to fall through to the
 * shared implementation of `setTitle`, `addNode`, `removeNodes`,
 * `renameNode`, `groupNodes`, `ungroup`, `renameGroup` and `setNodeParent`.
 * Every other op is refused. Metadata is re-keyed afterwards (see
 * {@link remapMeta}).
 */
export function editSections<S extends SectionsStatementBase, I extends S>(
  op: EditOp,
  ctx: EditContext<S>,
  spec: SectionsSpec<S, I>,
  custom?: (op: EditOp, model: SectionsModel<I>) => boolean | undefined,
): boolean {
  const before = buildSectionsModel(ctx.statements, spec);
  let added: I | null = null;
  let handled = custom?.(op, before);
  if (handled === undefined) {
    const result = sharedEdit(op, ctx, spec, before);
    handled = result.handled;
    added = result.added;
  }
  if (!handled) return false;
  const after = buildSectionsModel(ctx.statements, spec);
  remapMeta(ctx.meta, before.ids, after.ids);
  if (added && op.type === "addNode" && op.position) {
    const id = after.ids.get(added);
    if (id) ctx.meta.layout![id] = op.position;
  }
  return true;
}

function sharedEdit<S extends SectionsStatementBase, I extends S>(
  op: EditOp,
  ctx: EditContext<S>,
  spec: SectionsSpec<S, I>,
  model: SectionsModel<I>,
): { handled: boolean; added: I | null } {
  const { statements } = ctx;
  const no = { handled: false, added: null };
  const yes = { handled: true, added: null };
  switch (op.type) {
    case "setTitle": {
      const idx = statements.findIndex((s) => s.kind === "title");
      const title = op.title === undefined ? "" : cleanText(op.title, spec.titleForbidden);
      if (!title) {
        if (idx !== -1) statements.splice(idx, 1);
        return yes;
      }
      if (idx !== -1) {
        const s = statements[idx] as unknown as TitleStatement;
        s.title = title;
        s.dirty = true;
        return yes;
      }
      const stmt: TitleStatement = {
        kind: "title",
        raw: "",
        indent: model.sections[0]?.stmt.indent ?? ctx.indent,
        title,
        dirty: true,
      };
      statements.splice(spec.titleIndex?.(statements) ?? 0, 0, stmt as unknown as S);
      return yes;
    }
    case "addNode": {
      const section = op.node.parentId ? model.sectionById.get(op.node.parentId) : undefined;
      // Without a parent the item is appended at the end: it joins whatever
      // section is open there.
      const effective =
        section ?? (model.items.length ? model.items.at(-1)!.section : model.sections.at(-1));
      const indent = itemIndent(model, effective, ctx.indent);
      const stmt = spec.createItem(op.node, { indent, statements, model });
      if (!stmt) return no;
      let at: number;
      if (section) at = endOfSection(statements, section.stmt, spec);
      else if (model.items.length) at = statements.indexOf(model.items.at(-1)!.stmt) + 1;
      else at = statements.length;
      statements.splice(at, 0, stmt);
      return { handled: true, added: stmt };
    }
    case "removeNodes": {
      const remove = new Set<BaseStatement>(
        op.ids.map((id) => model.itemById.get(id)?.stmt).filter((s): s is I => !!s),
      );
      if (!remove.size) return no;
      filterInPlace(statements, (s) => !remove.has(s));
      return yes;
    }
    case "renameNode": {
      const item = model.itemById.get(op.id);
      if (!item) return no;
      return spec.renameItem(item.stmt, op.label) ? yes : no;
    }
    case "renameGroup": {
      const section = model.sectionById.get(op.id);
      const label = cleanText(op.label, spec.sectionForbidden);
      if (!section || !label) return no;
      section.stmt.label = label;
      section.stmt.dirty = true;
      return yes;
    }
    case "ungroup": {
      const section = model.sectionById.get(op.groupId);
      if (!section) return no;
      filterInPlace(statements, (s) => s !== (section.stmt as unknown as S));
      return yes;
    }
    case "groupNodes": {
      const selected = model.items.filter((i) => op.nodeIds.includes(i.id));
      if (!selected.length) return no;
      const label = cleanText(op.label, spec.sectionForbidden) || "Section";
      const first = selected[0]!;
      const previous = first.section;
      const chosen = new Set<BaseStatement>(selected.map((i) => i.stmt));
      // Items of the previous section that stay behind after the moved block.
      const firstIdx = statements.indexOf(first.stmt);
      const stays = (i: SectionItem<I>) => i.section === previous && !chosen.has(i.stmt);
      const leaders =
        !!previous && model.items.some((i) => stays(i) && statements.indexOf(i.stmt) < firstIdx);
      const followers =
        !!previous && model.items.some((i) => stays(i) && statements.indexOf(i.stmt) > firstIdx);
      const sectionIndent = model.sections[0]?.stmt.indent ?? ctx.indent;
      const indent = previous
        ? first.stmt.indent
        : (model.items.find((i) => i.section)?.stmt.indent ?? sectionIndent + ctx.indent);
      filterInPlace(statements, (s) => !chosen.has(s));
      let at: number;
      // When nothing of the previous section precedes the selection, the new
      // section goes before its header, which then keeps the followers.
      if (previous && !leaders) at = statements.indexOf(previous.stmt as unknown as S);
      else if (previous) at = firstIdx;
      else {
        // Outside any section: place the new section after the unsectioned
        // items so they keep having no section.
        const firstSection = statements.findIndex((s) => s.kind === "section");
        at = firstSection === -1 ? statements.length : firstSection;
      }
      const block: S[] = [makeSection<S>(label, sectionIndent)];
      for (const item of selected) {
        reindent(item.stmt, indent);
        block.push(item.stmt);
      }
      if (followers && leaders && previous)
        block.push(makeSection<S>(previous.stmt.label, previous.stmt.indent));
      statements.splice(at, 0, ...block);
      return yes;
    }
    case "setNodeParent": {
      const moving = model.items.filter((i) => op.ids.includes(i.id));
      if (!moving.length) return no;
      const target = op.parentId ? model.sectionById.get(op.parentId) : undefined;
      if (op.parentId && !target) return no;
      if (!target && !model.sections.length) return no;
      if (moving.every((i) => i.section === target)) return yes;
      const indent = itemIndent(model, target, ctx.indent);
      const set = new Set<BaseStatement>(moving.map((i) => i.stmt));
      filterInPlace(statements, (s) => !set.has(s));
      const at = target
        ? endOfSection(statements, target.stmt, spec)
        : statements.findIndex((s) => s.kind === "section");
      for (const item of moving) reindent(item.stmt, indent);
      statements.splice(at, 0, ...moving.map((i) => i.stmt));
      return yes;
    }
    default:
      return no;
  }
}

// ---------------------------------------------------------------------------
// Reordering (families drawn as one row of items: timeline, journey)
// ---------------------------------------------------------------------------

/** Where an item goes: a section (`undefined` = before any section) and an index among its items. */
export interface SectionSlot {
  section?: string;
  index: number;
}

/** A section's horizontal span on a canvas that draws all items in one row. */
export interface SectionSpan {
  /** Section id; `undefined` for the items before the first section. */
  section?: string;
  x0: number;
  x1: number;
  /** The section's items in order, with the x of their centres. */
  items: { id: string; centre: number }[];
}

/**
 * The slot an item dropped with its centre at `x` moves to: the section
 * whose span holds `x` (clamped to the first / last span) and the number of
 * that section's other items left of `x`. `null` when there are no spans.
 */
export function sectionDropTarget(spans: SectionSpan[], id: string, x: number): SectionSlot | null {
  if (!spans.length) return null;
  const span =
    spans.find((s) => x >= s.x0 && x < s.x1) ?? (x < spans[0]!.x0 ? spans[0]! : spans.at(-1)!);
  const index = span.items.filter((i) => i.id !== id && i.centre < x).length;
  return { section: span.section, index };
}

/**
 * Moves an item to a slot: into `slot.section` (or before the first section)
 * at `slot.index` among that section's other items, re-indented like its new
 * peers. Returns false when the item is unknown, the section does not exist or
 * the item is already there. Layout metadata is re-keyed (ids derived from
 * text may change when duplicates swap places).
 */
export function moveSectionItem<S extends SectionsStatementBase, I extends S>(
  ctx: Pick<EditContext<S>, "statements" | "meta" | "indent">,
  spec: SectionsSpec<S, I>,
  id: string,
  slot: SectionSlot,
): boolean {
  const { statements } = ctx;
  const model = buildSectionsModel(statements, spec);
  const item = model.itemById.get(id);
  if (!item) return false;
  const section = slot.section !== undefined ? model.sectionById.get(slot.section) : undefined;
  if (slot.section !== undefined && !section) return false;
  const peers = model.items.filter((i) => i.section === section && i !== item);
  const index = Math.max(0, Math.min(slot.index, peers.length));
  if (item.section === section) {
    const current = model.items.filter((i) => i.section === section).indexOf(item);
    if (current === index) return false;
  }
  const indent = peers[0]?.stmt.indent ?? itemIndent(model, section, ctx.indent);
  filterInPlace(statements, (s) => s !== item.stmt);
  let at: number;
  if (index < peers.length) at = statements.indexOf(peers[index]!.stmt);
  else if (peers.length) at = statements.indexOf(peers.at(-1)!.stmt) + 1;
  else if (section) at = endOfSection(statements, section.stmt, spec);
  else {
    const first = statements.findIndex((s) => s.kind === "section");
    at = first === -1 ? statements.length : first;
  }
  reindent(item.stmt, indent);
  statements.splice(at, 0, item.stmt);
  remapMeta(ctx.meta, model.ids, buildSectionsModel(statements, spec).ids);
  return true;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const PAD = 24;
const TITLE_H = 32;
const GAP = 12;
const COLUMN_GAP = 48;

/**
 * Column layout shared by timeline and journey: sections become columns from
 * left to right (each a group box with 24px padding and a 32px title band),
 * items inside a section stack top to bottom in document order with 12px
 * gaps; items without a section form the first column. Stored positions
 * (`meta.layout`) win for nodes and groups the user dragged; items without
 * one are stacked below their predecessors inside their (possibly moved)
 * group.
 */
export const sectionColumnsLayout: FamilyLayout = (graph, meta, { measure }) => {
  const stored = meta.layout ?? {};
  const positions: Record<string, Point> = {};
  const sizes: Record<string, Size> = {};
  const sizeOf = (n: GraphNode, width: number): Size =>
    meta.sizes?.[n.id]
      ? { width: meta.sizes[n.id]![0], height: meta.sizes[n.id]![1] }
      : { width, height: measure(n).height };

  const columns: { group?: GraphGroup; nodes: GraphNode[] }[] = [];
  const loose = graph.nodes.filter(
    (n) => !n.parentId || !graph.groups.some((g) => g.id === n.parentId),
  );
  if (loose.length) columns.push({ nodes: loose });
  for (const g of graph.groups)
    columns.push({ group: g, nodes: graph.nodes.filter((n) => n.parentId === g.id) });

  let x = 0;
  for (const col of columns) {
    const width = Math.max(160, ...col.nodes.map((n) => measure(n).width));
    let origin: Point = [x, 0];
    if (col.group) {
      const own = stored[col.group.id];
      const pinned = col.nodes.filter((n) => stored[n.id]);
      if (own) origin = own;
      else if (pinned.length && pinned.length === col.nodes.length)
        origin = [
          Math.min(...pinned.map((n) => stored[n.id]![0])) - PAD,
          Math.min(...pinned.map((n) => stored[n.id]![1])) - PAD - TITLE_H,
        ];
    }
    const innerX = col.group ? origin[0] + PAD : x;
    let y = origin[1] + PAD + TITLE_H;
    for (const n of col.nodes) {
      const size = sizeOf(n, width);
      const pos = stored[n.id] ?? ([innerX, y] as Point);
      positions[n.id] = pos;
      sizes[n.id] = size;
      y = pos[1] + size.height + GAP;
    }
    let right = x + width;
    if (col.group) {
      positions[col.group.id] = origin;
      const box = boundingSize(origin, col.nodes, positions, sizes, width);
      sizes[col.group.id] = meta.sizes?.[col.group.id]
        ? { width: meta.sizes[col.group.id]![0], height: meta.sizes[col.group.id]![1] }
        : box;
      right = Math.max(x + width + PAD * 2, origin[0] + sizes[col.group.id]!.width);
    }
    x = right + COLUMN_GAP;
  }
  return { positions, sizes } satisfies LayoutResult;
};

/** Group box from its origin to the far edge of its children, plus padding. */
export function boundingSize(
  origin: Point,
  nodes: GraphNode[],
  positions: Record<string, Point>,
  sizes: Record<string, Size>,
  minInnerWidth = 152,
): Size {
  if (!nodes.length) return { width: Math.max(200, minInnerWidth + PAD * 2), height: 100 };
  let maxX = origin[0] + PAD + minInnerWidth;
  let maxY = origin[1] + PAD + TITLE_H;
  for (const n of nodes) {
    const [px, py] = positions[n.id]!;
    maxX = Math.max(maxX, px + sizes[n.id]!.width);
    maxY = Math.max(maxY, py + sizes[n.id]!.height);
  }
  return { width: maxX - origin[0] + PAD, height: maxY - origin[1] + PAD };
}

/** Layout constants shared with families that build their own layout. */
export const SECTION_LAYOUT = { pad: PAD, titleHeight: TITLE_H, gap: GAP } as const;
