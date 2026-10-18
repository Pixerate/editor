import { registerFamilyLayout } from "../layout-registry.js";
import type { ArrowHead, DiagramGraph, GraphEdge, GraphGroup, GraphNode } from "../types.js";
import { c4Layout } from "./geometry.js";
import {
  createStatementAdapter,
  dropMetaKeys,
  filterInPlace,
  indentOf,
  slugId,
  splitOutsideQuotes,
  uniqueId,
  unquote,
  type BaseStatement,
  type EditContext,
  type StatementGrammar,
} from "../statements/base.js";

/**
 * C4 adapter (`C4Context`, `C4Container`, `C4Component`, `C4Dynamic`,
 * `C4Deployment`).
 *
 * ```
 * C4Container
 *   title Containers
 *   Person(user, "User")
 *   System_Boundary(sb, "Portal") {
 *     Container(web, "Web app", "React", "The UI")
 *   }
 *   Rel(user, web, "Uses", "HTTPS")
 * ```
 *
 * Canvas model: one node per element (`Person`, `System*`, `Container*`,
 * `Component*`; id = alias, shape `c4-*`, `data = { kind, descr, tech, extra,
 * details }`), one group per boundary block (`*_Boundary`, `Boundary`,
 * `Node*`, `Deployment_Node`; `data = { kind, type, descr }`) and one edge per
 * relation (`Rel`, `BiRel`, `Rel_Back`, `Rel_U`…, `RelIndex`; `data = { kind,
 * tech }`). Named `$…` arguments are kept verbatim and re-emitted after the
 * positional ones. `UpdateRelStyle` / `UpdateElementStyle` lines are kept as
 * written but dropped with the element or relation they style.
 *
 * Mermaid's C4 lexer does not understand `#quot;`, so inner double quotes are
 * written as `'`.
 *
 * For the canvas, `graph.data` carries the diagram type (`c4Type`, e.g.
 * `C4Dynamic` numbers its relations) and `UpdateLayoutConfig` values
 * (`c4ShapeInRow`, `c4BoundaryInRow`); `UpdateElementStyle` colours are
 * mirrored to `node.data.c4Style` (`bgColor`, `fontColor`, `borderColor`) and
 * `UpdateRelStyle` ones to `edge.data.c4Style` (`textColor`, `lineColor`,
 * `offsetX`, `offsetY`). The layout is Mermaid's own (see `./geometry`).
 *
 * @module
 */

/** Positional arguments shared by elements, boundaries and relations. */
interface Args {
  label: string;
  /** Positional values beyond the ones the diagram module models (sprite, tags, link…), unquoted. */
  rest: string[];
  /** Named `$key=value` arguments, verbatim. */
  extra: string[];
}

export type C4Statement =
  | (BaseStatement & { kind: "raw" })
  | (BaseStatement & { kind: "title"; title: string })
  | (BaseStatement &
      Args & { kind: "element"; keyword: string; alias: string; tech?: string; descr?: string })
  | (BaseStatement &
      Args & { kind: "boundary"; keyword: string; alias: string; type?: string; descr?: string })
  | (BaseStatement & { kind: "close" })
  | (BaseStatement &
      Args & {
        kind: "rel";
        keyword: string;
        /** `RelIndex` sequence number. */
        index?: string;
        from: string;
        to: string;
        tech?: string;
      })
  | (BaseStatement & { kind: "relStyle"; from: string; to: string; rest: string[] })
  | (BaseStatement & { kind: "elementStyle"; alias: string });

type ElementStmt = Extract<C4Statement, { kind: "element" }>;
type BoundaryStmt = Extract<C4Statement, { kind: "boundary" }>;
type RelStmt = Extract<C4Statement, { kind: "rel" }>;

type Base = "Person" | "System" | "Container" | "Component";
type Variant = "" | "Db" | "Queue";

interface ElementKind {
  base: Base;
  variant: Variant;
  ext: boolean;
}

const ELEMENT_KIND = /^(Person|System|Container|Component)(Db|Queue)?(_Ext)?$/;
const BOUNDARY_KINDS = new Set([
  "Enterprise_Boundary",
  "System_Boundary",
  "Container_Boundary",
  "Boundary",
  "Node",
  "Node_L",
  "Node_R",
  "Deployment_Node",
]);
/** Boundaries whose second positional argument is a type (and third, for nodes, a description). */
const TYPED_BOUNDARIES = new Set(["Boundary", "Node", "Node_L", "Node_R", "Deployment_Node"]);
const NODE_BOUNDARIES = new Set(["Node", "Node_L", "Node_R", "Deployment_Node"]);
/** Relation keywords Mermaid 12 accepts (`Rel_Back_U`, `BiRel_U` are rejected by its lexer). */
const REL_KINDS = new Set([
  "Rel",
  "BiRel",
  "Rel_Back",
  "Rel_U",
  "Rel_Up",
  "Rel_D",
  "Rel_Down",
  "Rel_L",
  "Rel_Left",
  "Rel_R",
  "Rel_Right",
  "RelIndex",
]);
const CALL = /^([A-Za-z_]+)\s*\((.*)\)\s*(\{)?\s*$/;

function parseKind(keyword: string): ElementKind | undefined {
  const m = ELEMENT_KIND.exec(keyword);
  if (!m) return undefined;
  const base = m[1] as Base;
  const variant = (m[2] ?? "") as Variant;
  if (base === "Person" && variant) return undefined;
  return { base, variant, ext: !!m[3] };
}

function kindKeyword(k: ElementKind): string {
  return `${k.base}${k.variant}${k.ext ? "_Ext" : ""}`;
}

function shapeOf(k: ElementKind): string {
  if (k.variant === "Db") return "c4-db";
  if (k.variant === "Queue") return "c4-queue";
  return `c4-${k.base.toLowerCase()}${k.ext ? "-ext" : ""}`;
}

/** Whether a base carries a technology argument before its description. */
const hasTech = (base: Base) => base === "Container" || base === "Component";

/** The element base a diagram type adds by default (and uses for `c4-db` / `c4-queue`). */
function defaultBase(header: string): Base {
  if (/^\s*C4Context\b/.test(header)) return "System";
  if (/^\s*C4Component\b/.test(header)) return "Component";
  return "Container";
}

/** Element kind for a canvas shape, keeping what it can of `current`. */
function kindForShape(
  shape: string | undefined,
  header: string,
  current?: ElementKind,
): ElementKind | undefined {
  const fallback = current && current.base !== "Person" ? current.base : defaultBase(header);
  const m = /^c4-(person|system|container|component)(-ext)?$/.exec(shape ?? "");
  if (m) {
    const base = (m[1]![0]!.toUpperCase() + m[1]!.slice(1)) as Base;
    return { base, variant: "", ext: !!m[2] };
  }
  if (shape === "c4-db" || shape === "c4-queue")
    return { base: fallback, variant: shape === "c4-db" ? "Db" : "Queue", ext: !!current?.ext };
  if (shape === undefined) return { base: fallback, variant: "", ext: false };
  return undefined;
}

/** Named `$key="value"` arguments of a raw call, as a record. */
function namedArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/\$(\w+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** Quotes a C4 string argument (`"` → `'`, since C4 has no escape for it). */
function q(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}

function splitArgs(text: string): { ids: string[]; positional: string[]; extra: string[] } {
  const parts = splitOutsideQuotes(text, ",").map((p) => p.trim());
  const extra = parts.filter((p) => p.startsWith("$"));
  const values = parts.filter((p) => !p.startsWith("$"));
  return { ids: values, positional: values.map(unquote), extra };
}

/** Joins positional values, dropping trailing empty ones (they are optional). */
function positional(values: (string | undefined)[], rest: string[]): string[] {
  const all = [...values.map((v) => v ?? ""), ...rest];
  while (all.length > 1 && all[all.length - 1] === "") all.pop();
  return all.map(q);
}

function call(indent: string, keyword: string, args: string[], open = false): string {
  return `${indent}${keyword}(${args.join(", ")})${open ? " {" : ""}`;
}

function arrowsOf(keyword: string): { arrowStart: ArrowHead; arrowEnd: ArrowHead } {
  if (keyword === "BiRel") return { arrowStart: "arrow_point", arrowEnd: "arrow_point" };
  if (keyword === "Rel_Back") return { arrowStart: "arrow_point", arrowEnd: "none" };
  return { arrowStart: "none", arrowEnd: "arrow_point" };
}

/** Edge ids `L_<from>_<to>_<n>`, numbered per endpoint pair in document order. */
function relIds(statements: C4Statement[]): Map<RelStmt, string> {
  const counts = new Map<string, number>();
  const ids = new Map<RelStmt, string>();
  for (const s of statements) {
    if (s.kind !== "rel") continue;
    const key = `${s.from}_${s.to}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    ids.set(s, `L_${key}_${n}`);
  }
  return ids;
}

/** Index of the `}` closing the boundary opened at `open` (or the last index if unclosed). */
function blockEnd(statements: C4Statement[], open: number): number {
  if (statements[open]?.kind !== "boundary") return open;
  let depth = 0;
  for (let i = open; i < statements.length; i++) {
    const s = statements[i]!;
    if (s.kind === "boundary") depth++;
    else if (s.kind === "close" && --depth === 0) return i;
  }
  return statements.length - 1;
}

/** Enclosing boundary alias of each statement index. */
function parents(statements: C4Statement[]): (string | undefined)[] {
  const stack: string[] = [];
  return statements.map((s) => {
    const parent = stack.at(-1);
    if (s.kind === "boundary") stack.push(s.alias);
    else if (s.kind === "close") stack.pop();
    return s.kind === "close" ? stack.at(-1) : parent;
  });
}

/** Re-indents statements whose text starts with `from` so it starts with `to`. */
function reindent(block: C4Statement[], from: string, to: string): void {
  if (from === to) return;
  for (const s of block) {
    if (!s.raw.trim() || !s.raw.startsWith(from)) continue;
    s.raw = to + s.raw.slice(from.length);
    s.indent = to + s.indent.slice(from.length);
  }
}

export const c4Grammar: StatementGrammar<C4Statement> = {
  family: "c4",
  titleAsStatement: true,

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    let m: RegExpExecArray | null;
    if (text === "}") return { kind: "close", raw: line, indent };
    if ((m = /^title\s+(.*)$/.exec(text)))
      return { kind: "title", raw: line, indent, title: m[1]!.trim() };
    if (!(m = CALL.exec(text))) return { kind: "raw", raw: line, indent };
    const keyword = m[1]!;
    const opens = !!m[3];
    const { ids, positional: pos, extra } = splitArgs(m[2]!);
    const base = { raw: line, indent, extra };
    const elementKind = parseKind(keyword);
    if (elementKind && !opens && ids.length >= 2) {
      const tech = hasTech(elementKind.base);
      const [label, a, b, ...rest] = pos.slice(1);
      return {
        ...base,
        kind: "element",
        keyword,
        alias: ids[0]!,
        label: label ?? "",
        tech: tech ? a : undefined,
        descr: tech ? b : a,
        rest: tech ? rest : [b, ...rest].filter((v): v is string => v !== undefined),
      };
    }
    if (BOUNDARY_KINDS.has(keyword) && opens && ids.length >= 2) {
      const typed = TYPED_BOUNDARIES.has(keyword);
      const node = NODE_BOUNDARIES.has(keyword);
      const [label, ...more] = pos.slice(1);
      return {
        ...base,
        kind: "boundary",
        keyword,
        alias: ids[0]!,
        label: label ?? "",
        type: typed ? more[0] : undefined,
        descr: node ? more[1] : undefined,
        rest: more.slice(node ? 2 : typed ? 1 : 0),
      };
    }
    if (REL_KINDS.has(keyword) && !opens) {
      const lead = keyword === "RelIndex" ? 1 : 0;
      if (ids.length < lead + 3) return { kind: "raw", raw: line, indent };
      const [label, tech, ...rest] = pos.slice(lead + 2);
      return {
        ...base,
        kind: "rel",
        keyword,
        index: lead ? ids[0] : undefined,
        from: ids[lead]!,
        to: ids[lead + 1]!,
        label: label ?? "",
        tech,
        rest,
      };
    }
    if (keyword === "UpdateRelStyle" && ids.length >= 2)
      return {
        kind: "relStyle",
        raw: line,
        indent,
        from: ids[0]!,
        to: ids[1]!,
        rest: splitOutsideQuotes(m[2]!, ",")
          .slice(2)
          .map((p) => p.trim()),
      };
    if (keyword === "UpdateElementStyle" && ids.length >= 1)
      return { kind: "elementStyle", raw: line, indent, alias: ids[0]! };
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    switch (stmt.kind) {
      case "title":
        return `${stmt.indent}title ${stmt.title}`;
      case "element": {
        const k = parseKind(stmt.keyword);
        const values =
          k && hasTech(k.base) ? [stmt.label, stmt.tech, stmt.descr] : [stmt.label, stmt.descr];
        return call(stmt.indent, stmt.keyword, [
          stmt.alias,
          ...positional(values, stmt.rest),
          ...stmt.extra,
        ]);
      }
      case "boundary": {
        const values = NODE_BOUNDARIES.has(stmt.keyword)
          ? [stmt.label, stmt.type, stmt.descr]
          : TYPED_BOUNDARIES.has(stmt.keyword)
            ? [stmt.label, stmt.type]
            : [stmt.label];
        return call(
          stmt.indent,
          stmt.keyword,
          [stmt.alias, ...positional(values, stmt.rest), ...stmt.extra],
          true,
        );
      }
      case "rel": {
        const ids =
          stmt.index !== undefined ? [stmt.index, stmt.from, stmt.to] : [stmt.from, stmt.to];
        const values = positional([stmt.label, stmt.tech], stmt.rest);
        if (!values.length) values.push(q(""));
        return call(stmt.indent, stmt.keyword, [...ids, ...values, ...stmt.extra]);
      }
      case "relStyle":
        return call(stmt.indent, "UpdateRelStyle", [stmt.from, stmt.to, ...stmt.rest]);
      case "close":
        return `${stmt.indent}}`;
      default:
        return stmt.raw;
    }
  },

  buildGraph(statements, ctx) {
    const nodes: GraphNode[] = [];
    const groups: GraphGroup[] = [];
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const parentOf = parents(statements);
    let title: string | undefined;
    const elementStyles = new Map<string, Record<string, string>>();
    const relStyles = new Map<string, Record<string, string>>();
    const layoutConfig: Record<string, number> = {};
    for (const s of statements) {
      if (s.kind === "elementStyle")
        elementStyles.set(s.alias, { ...elementStyles.get(s.alias), ...namedArgs(s.raw) });
      if (s.kind === "relStyle") {
        const key = `${s.from}\u0000${s.to}`;
        relStyles.set(key, { ...relStyles.get(key), ...namedArgs(s.raw) });
      }
      if (s.kind === "raw" && /^\s*UpdateLayoutConfig\s*\(/.test(s.raw)) {
        const args = namedArgs(s.raw);
        for (const key of ["c4ShapeInRow", "c4BoundaryInRow"]) {
          const n = Number(args[key]);
          if (n >= 1) layoutConfig[key] = n;
        }
      }
    }
    statements.forEach((s, i) => {
      const parentId = parentOf[i];
      if (s.kind === "title") title = s.title;
      if (s.kind === "element" && !seen.has(s.alias)) {
        seen.add(s.alias);
        const k = parseKind(s.keyword)!;
        nodes.push({
          id: s.alias,
          label: s.label,
          shape: shapeOf(k),
          parentId,
          classes: [],
          styles: [],
          data: {
            kind: s.keyword,
            descr: s.descr,
            tech: s.tech,
            extra: s.extra.length ? s.extra.join(", ") : undefined,
            details: [s.tech ? `[${s.tech}]` : undefined, s.descr].filter(Boolean),
            c4Style: elementStyles.get(s.alias),
          },
        });
      }
      if (s.kind === "boundary" && !seen.has(s.alias)) {
        seen.add(s.alias);
        groups.push({
          id: s.alias,
          label: s.label,
          parentId,
          classes: [],
          styles: [],
          data: {
            kind: s.keyword,
            type: s.type,
            descr: s.descr,
            extra: s.extra.length ? s.extra.join(", ") : undefined,
          },
        });
      }
    });
    for (const [s, id] of relIds(statements)) {
      // Relations to undeclared aliases have nothing to attach to on the canvas.
      if (!seen.has(s.from) || !seen.has(s.to)) continue;
      edges.push({
        id,
        source: s.from,
        target: s.to,
        label: s.label,
        pattern: "solid",
        ...arrowsOf(s.keyword),
        length: 1,
        classes: [],
        styles: [],
        userDefinedId: false,
        data: {
          kind: s.keyword,
          tech: s.tech,
          index: s.index,
          c4Style: relStyles.get(`${s.from}\u0000${s.to}`),
        },
      });
    }
    const graph: DiagramGraph = {
      direction: "TB",
      nodes,
      edges,
      groups,
      classDefs: {},
      title: title ?? ctx.frontmatterTitle,
      data: { c4Type: /^\s*(C4\w+)/.exec(ctx.header)?.[1] ?? "C4Context", ...layoutConfig },
    };
    return { graph };
  },

  edit(op, ctx) {
    return editC4(op, ctx);
  },
};

function editC4(
  op: Parameters<StatementGrammar<C4Statement>["edit"]>[0],
  ctx: EditContext<C4Statement>,
) {
  const { statements, doc } = ctx;
  const unit = ctx.indent || "  ";
  const header = doc.header;

  const indexOf = (alias: string) =>
    statements.findIndex(
      (s) => (s.kind === "element" || s.kind === "boundary") && s.alias === alias,
    );
  const element = (alias: string) =>
    statements.find((s): s is ElementStmt => s.kind === "element" && s.alias === alias);
  const boundary = (alias: string) =>
    statements.find((s): s is BoundaryStmt => s.kind === "boundary" && s.alias === alias);
  const relById = () => {
    const map = new Map<string, RelStmt>();
    for (const [s, id] of relIds(statements)) map.set(id, s);
    return map;
  };
  const taken = () =>
    new Set(
      statements.flatMap((s) => (s.kind === "element" || s.kind === "boundary" ? [s.alias] : [])),
    );
  /** Indentation of top-level statements. */
  const baseIndent = () => {
    const p = parents(statements);
    const s = statements.find(
      (st, i) => p[i] === undefined && st.raw.trim() && st.kind !== "close",
    );
    return s ? s.indent : unit;
  };
  /** Where a new top-level element goes: after the last top-level element or boundary block. */
  const topInsertIndex = () => {
    const p = parents(statements);
    let idx = -1;
    statements.forEach((s, i) => {
      if (p[i] === undefined && (s.kind === "element" || s.kind === "close" || s.kind === "title"))
        idx = i;
    });
    if (idx !== -1) return idx + 1;
    const firstRel = statements.findIndex((s) => s.kind === "rel");
    return firstRel === -1 ? statements.length : firstRel;
  };
  /** Moves an element or boundary block into `parent` (top level when undefined). */
  const moveInto = (id: string, parent: string | undefined) => {
    const start = indexOf(id);
    if (start === -1) return false;
    if (parents(statements)[start] === parent) return true;
    const block = statements.splice(start, blockEnd(statements, start) - start + 1);
    const target = parent === undefined ? -1 : indexOf(parent);
    const at = target === -1 ? topInsertIndex() : blockEnd(statements, target);
    const indent = target === -1 ? baseIndent() : statements[target]!.indent + unit;
    reindent(block, block[0]!.indent, indent);
    statements.splice(at, 0, ...block);
    return true;
  };
  /** Removes a boundary's braces, keeping (and dedenting) its content. */
  const unwrap = (alias: string) => {
    const open = statements.findIndex((s) => s.kind === "boundary" && s.alias === alias);
    if (open === -1) return false;
    const close = blockEnd(statements, open);
    const inner = statements.slice(open + 1, close);
    const first = inner.find((s) => s.raw.trim());
    if (first) reindent(inner, first.indent, statements[open]!.indent);
    if (statements[close]?.kind === "close") statements.splice(close, 1);
    statements.splice(open, 1);
    return true;
  };
  /** Drops `UpdateRelStyle` lines whose endpoint pair no longer has a relation. */
  const pruneRelStyles = () => {
    const pairs = new Set(
      statements.flatMap((s) => (s.kind === "rel" ? [`${s.from}\u0000${s.to}`] : [])),
    );
    filterInPlace(statements, (s) => s.kind !== "relStyle" || pairs.has(`${s.from}\u0000${s.to}`));
  };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  switch (op.type) {
    case "addNode": {
      const kind = kindForShape(op.node.shape, header);
      if (!kind) return false;
      const id = uniqueId(slugId(op.node.id, "el"), taken());
      const parent = op.node.parentId && boundary(op.node.parentId) ? op.node.parentId : undefined;
      const target = parent ? indexOf(parent) : -1;
      const at = target === -1 ? topInsertIndex() : blockEnd(statements, target);
      const indent = target === -1 ? baseIndent() : statements[target]!.indent + unit;
      const tech = hasTech(kind.base) ? str(op.node.data?.tech) : undefined;
      statements.splice(at, 0, {
        kind: "element",
        raw: "",
        indent,
        dirty: true,
        keyword: kindKeyword(kind),
        alias: id,
        label: op.node.label ?? id,
        tech,
        descr: str(op.node.data?.descr),
        rest: [],
        extra: [],
      });
      if (op.position) ctx.meta.layout![id] = op.position;
      return true;
    }
    case "renameNode":
    case "renameGroup": {
      const s = element(op.id) ?? boundary(op.id);
      if (!s) return false;
      s.label = op.label;
      s.dirty = true;
      return true;
    }
    case "setNodeShape": {
      const s = element(op.id);
      const current = s && parseKind(s.keyword);
      const next = current && kindForShape(op.shape, header, current);
      if (!s || !next) return false;
      s.keyword = kindKeyword(next);
      // Systems and people have no technology slot; it is dropped with the move.
      if (!hasTech(next.base)) s.tech = undefined;
      s.dirty = true;
      return true;
    }
    case "setNodeData": {
      const s = element(op.id);
      if (!s) return false;
      let changed = false;
      if ("descr" in op.data) {
        s.descr = str(op.data.descr) || undefined;
        changed = true;
      }
      if ("tech" in op.data && hasTech(parseKind(s.keyword)!.base)) {
        s.tech = str(op.data.tech) || undefined;
        changed = true;
      }
      s.dirty ||= changed;
      return changed;
    }
    case "removeNodes": {
      const ids = new Set(op.ids);
      const found = op.ids.some((id) => indexOf(id) !== -1);
      if (!found) return false;
      filterInPlace(statements, (s) => {
        if (s.kind === "element") return !ids.has(s.alias);
        if (s.kind === "rel" || s.kind === "relStyle") return !ids.has(s.from) && !ids.has(s.to);
        if (s.kind === "elementStyle") return !ids.has(s.alias);
        return true;
      });
      // Deleted boundaries keep their content, like flowchart subgraphs.
      for (const id of ids) unwrap(id);
      dropMetaKeys(ctx.meta, ids);
      return true;
    }
    case "addEdge": {
      const ids = taken();
      if (!ids.has(op.edge.source) || !ids.has(op.edge.target)) return false;
      const start = op.edge.arrowStart ?? "none";
      const end = op.edge.arrowEnd ?? "arrow_point";
      const keyword =
        start !== "none" && end !== "none" ? "BiRel" : start !== "none" ? "Rel_Back" : "Rel";
      let last = -1;
      statements.forEach((s, i) => {
        if (s.kind === "rel") last = i;
      });
      if (last === -1)
        statements.forEach((s, i) => {
          if (s.raw.trim()) last = i;
        });
      const prev = statements[last];
      const indent = prev?.kind === "rel" ? prev.indent : baseIndent();
      statements.splice(last + 1, 0, {
        kind: "rel",
        raw: "",
        indent,
        dirty: true,
        keyword,
        from: op.edge.source,
        to: op.edge.target,
        label: op.edge.label ?? "Uses",
        tech: str(op.edge.data?.tech),
        rest: [],
        extra: [],
      });
      return true;
    }
    case "removeEdges": {
      const rels = relById();
      const remove = new Set(op.ids.map((id) => rels.get(id)).filter(Boolean));
      if (!remove.size) return false;
      filterInPlace(statements, (s) => !remove.has(s as RelStmt));
      pruneRelStyles();
      return true;
    }
    case "setEdgeLabel": {
      const s = relById().get(op.id);
      if (!s) return false;
      s.label = op.label;
      s.dirty = true;
      return true;
    }
    case "setEdgeData": {
      const s = relById().get(op.id);
      if (!s || !("tech" in op.data)) return false;
      s.tech = str(op.data.tech) || undefined;
      s.dirty = true;
      return true;
    }
    case "setEdgeStyle": {
      const s = relById().get(op.id);
      if (!s) return false;
      const cur = arrowsOf(s.keyword);
      const start = (op.arrowStart ?? cur.arrowStart) !== "none";
      const end = (op.arrowEnd ?? cur.arrowEnd) !== "none";
      if (!start && !end) return false; // C4 has no plain line.
      const forward = s.keyword !== "BiRel" && s.keyword !== "Rel_Back";
      const keyword = start && end ? "BiRel" : start ? "Rel_Back" : forward ? s.keyword : "Rel";
      if (keyword === s.keyword) return false;
      if (s.index !== undefined) return false; // RelIndex is always forward.
      s.keyword = keyword;
      s.dirty = true;
      return true;
    }
    case "reconnectEdge": {
      const s = relById().get(op.id);
      const ids = taken();
      if (!s || !ids.has(op.source) || !ids.has(op.target)) return false;
      const shared = statements.filter(
        (r) => r.kind === "rel" && r.from === s.from && r.to === s.to,
      ).length;
      // A style line that only belonged to this relation follows it.
      if (shared === 1)
        for (const r of statements)
          if (r.kind === "relStyle" && r.from === s.from && r.to === s.to) {
            r.from = op.source;
            r.to = op.target;
            r.dirty = true;
          }
      s.from = op.source;
      s.to = op.target;
      s.dirty = true;
      pruneRelStyles();
      return true;
    }
    case "groupNodes": {
      const members = op.nodeIds.filter((id) => indexOf(id) !== -1);
      if (!members.length) return false;
      members.sort((a, b) => indexOf(a) - indexOf(b));
      const first = indexOf(members[0]!);
      const parentAt = parents(statements);
      const parent = op.parentId && boundary(op.parentId) ? op.parentId : parentAt[first];
      // The new boundary must not end up inside one of its members.
      if (parent && members.some((m) => isWithin(statements, parent, m))) return false;
      const id = uniqueId(slugId(op.groupId, "boundary"), taken());
      const target = parent === undefined ? -1 : indexOf(parent);
      const at =
        parentAt[first] === parent
          ? first
          : target === -1
            ? topInsertIndex()
            : blockEnd(statements, target);
      const indent = target === -1 ? baseIndent() : statements[target]!.indent + unit;
      const keyword = /^\s*C4Deployment\b/.test(header)
        ? "Deployment_Node"
        : /^\s*C4Container\b/.test(header)
          ? "Container_Boundary"
          : "System_Boundary";
      statements.splice(
        at,
        0,
        {
          kind: "boundary",
          raw: "",
          indent,
          dirty: true,
          keyword,
          alias: id,
          label: op.label,
          type: keyword === "Deployment_Node" ? "node" : undefined,
          rest: [],
          extra: [],
        },
        { kind: "close", raw: `${indent}}`, indent },
      );
      for (const m of members) moveInto(m, id);
      return true;
    }
    case "ungroup": {
      if (!unwrap(op.groupId)) return false;
      dropMetaKeys(ctx.meta, [op.groupId]);
      return true;
    }
    case "setNodeParent": {
      const parent = op.parentId;
      if (parent !== undefined && !boundary(parent)) return false;
      const ids = op.ids.filter((id) => indexOf(id) !== -1);
      if (!ids.length) return false;
      if (parent && ids.some((id) => isWithin(statements, parent, id))) return false;
      for (const id of ids) moveInto(id, parent);
      return true;
    }
    case "setTitle": {
      const idx = statements.findIndex((s) => s.kind === "title");
      if (!op.title) {
        if (idx !== -1) statements.splice(idx, 1);
        return true;
      }
      if (idx !== -1) {
        const s = statements[idx] as Extract<C4Statement, { kind: "title" }>;
        s.title = op.title;
        s.dirty = true;
      } else
        statements.unshift({
          kind: "title",
          raw: "",
          indent: baseIndent(),
          title: op.title,
          dirty: true,
        });
      return true;
    }
    default:
      return false;
  }
}

/** True when boundary/element `id` is `ancestor` or nested inside it. */
function isWithin(statements: C4Statement[], id: string, ancestor: string): boolean {
  const open = statements.findIndex(
    (s) => (s.kind === "boundary" || s.kind === "element") && s.alias === ancestor,
  );
  if (open === -1) return false;
  const end = blockEnd(statements, open);
  return statements
    .slice(open, end + 1)
    .some((s) => (s.kind === "boundary" || s.kind === "element") && s.alias === id);
}

/** C4 adapter (all five C4 diagram types). */
export const c4Adapter = createStatementAdapter(c4Grammar);

/**
 * Mermaid's C4 layout (rows of elements inside each boundary, see
 * `./geometry`), with the positions of elements the user dragged on top.
 */
registerFamilyLayout("c4", (graph, meta) => {
  const { positions, sizes } = c4Layout(graph, meta);
  return { positions, sizes };
});

export {
  C4_METRICS,
  c4ArrowHead,
  c4BoundaryText,
  c4ElementGeometry,
  c4ElementType,
  c4Layout,
  c4RelGeometry,
  c4Stereotype,
} from "./geometry.js";
