import type {
  AdapterParseContext,
  ArrowHead,
  Diagnostic,
  DiagramAdapter,
  DiagramFamily,
  DiagramGraph,
  EditOp,
  GraphEdge,
  GraphGroup,
  GraphNode,
  MermaidDocument,
  Point,
} from "../types.js";
import { assembleDocument } from "../flowchart/serialize.js";
import { splitSource } from "../source/lines.js";
import {
  defaultCarrierFor,
  emptyMeta,
  extractMetaFromBody,
  extractMetaFromFrontmatter,
  mergeMeta,
} from "../source/metadata.js";

/**
 * A small engine for "one statement per line" Mermaid grammars
 * (stateDiagram, classDiagram, erDiagram). A grammar classifies each logical
 * line into a typed statement; the engine builds the graph, applies edits and
 * re-emits untouched statements verbatim.
 *
 * @module
 */

export interface NodeDecl {
  id: string;
  label?: string;
  shape?: string;
  classes: string[];
  /** Family-specific data (members, attributes, descriptions…). */
  data?: Record<string, unknown>;
}

export type LineStatement =
  | { kind: "raw"; raw: string; indent: string }
  | {
      kind: "node";
      raw: string;
      indent: string;
      decl: NodeDecl;
      /** Multi-line body `{ … }` kept verbatim. */ body?: string[];
      dirty?: boolean;
    }
  | {
      kind: "edge";
      raw: string;
      indent: string;
      source: NodeDecl;
      target: NodeDecl;
      label?: string;
      arrowStart: ArrowHead;
      arrowEnd: ArrowHead;
      pattern: GraphEdge["pattern"];
      /** Family-specific data (cardinalities…). */
      data?: Record<string, unknown>;
      dirty?: boolean;
    }
  | { kind: "groupOpen"; raw: string; indent: string; id: string; label?: string; dirty?: boolean }
  | { kind: "groupClose"; raw: string; indent: string }
  | { kind: "direction"; raw: string; indent: string; direction: string; dirty?: boolean }
  | {
      kind: "classDef";
      raw: string;
      indent: string;
      names: string[];
      styles: string[];
      dirty?: boolean;
    }
  | {
      kind: "class";
      raw: string;
      indent: string;
      ids: string[];
      className: string;
      dirty?: boolean;
    }
  | { kind: "style"; raw: string; indent: string; id: string; styles: string[]; dirty?: boolean };

export interface EdgeSpec {
  label?: string;
  arrowStart: ArrowHead;
  arrowEnd: ArrowHead;
  pattern: GraphEdge["pattern"];
  data?: Record<string, unknown>;
}

export interface LineGrammar {
  family: DiagramFamily;
  defaultShape: string;
  /** Groups logical statements from physical lines (brace blocks, `end note`, …). */
  joinLines(lines: string[]): string[];
  parseLine(line: string): LineStatement;
  formatStatement(stmt: LineStatement): string;
  /** Builds a node statement for a new node. */
  nodeStatement(decl: NodeDecl, indent: string): LineStatement;
  /** Builds an edge statement. */
  edgeStatement(source: string, target: string, spec: EdgeSpec, indent: string): LineStatement;
  /** Builds the open/close statements of a group. */
  groupStatements(
    id: string,
    label: string | undefined,
    indent: string,
  ): { open: LineStatement; close: LineStatement };
  /** Reads the header direction. */
  headerDirection(header: string, statements: LineStatement[]): string;
  /** Optional: pseudo-node ids such as `[*]` that need special graph handling. */
  resolveEndpoint?(
    id: string,
    groupStack: string[],
    role: "source" | "target",
  ): { id: string; shape: string; label: string; synthetic: true } | null;
  /** Default edge spec when the UI connects two nodes. */
  defaultEdge: EdgeSpec;
  /** Whether `setDirection` writes a `direction` statement (true) or the header. */
  directionAsStatement: boolean;
  /** False when the family has no grouping construct (ER). Group ops become no-ops. */
  supportsGroups?: boolean;
}

export interface LineBody {
  statements: LineStatement[];
}

export type LineDocument = MermaidDocument<LineBody>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function buildLineGraph(
  grammar: LineGrammar,
  statements: LineStatement[],
  direction: string,
  title?: string,
): { graph: DiagramGraph; diagnostics: Diagnostic[] } {
  const nodes = new Map<string, GraphNode>();
  const groups = new Map<string, GraphGroup>();
  const edges: GraphEdge[] = [];
  const classDefs: Record<string, string[]> = {};
  const diagnostics: Diagnostic[] = [];
  const stack: string[] = [];
  const classAssignments: { ids: string[]; className: string }[] = [];
  const styleAssignments: { id: string; styles: string[] }[] = [];
  let ordinal = 0;

  const touch = (decl: NodeDecl, role: "source" | "target" | "decl"): string => {
    if (role !== "decl" && grammar.resolveEndpoint) {
      const resolved = grammar.resolveEndpoint(decl.id, stack, role);
      if (resolved) {
        if (!nodes.has(resolved.id)) {
          nodes.set(resolved.id, {
            id: resolved.id,
            label: resolved.label,
            shape: resolved.shape,
            parentId: stack[stack.length - 1],
            classes: [],
            styles: [],
            data: { synthetic: true },
          });
        }
        return resolved.id;
      }
    }
    let node = nodes.get(decl.id);
    if (!node) {
      node = { id: decl.id, label: decl.id, shape: grammar.defaultShape, classes: [], styles: [] };
      nodes.set(decl.id, node);
    }
    // Mermaid: a mention inside a group claims the node, whatever the order;
    // root-level mentions never un-claim it.
    const parent = stack[stack.length - 1];
    if (parent) node.parentId = parent;
    if (decl.label !== undefined) node.label = decl.label;
    if (decl.shape) node.shape = decl.shape;
    for (const cls of decl.classes) if (!node.classes.includes(cls)) node.classes.push(cls);
    if (decl.data) node.data = mergeData(node.data, decl.data);
    return node.id;
  };

  for (const stmt of statements) {
    switch (stmt.kind) {
      case "groupOpen": {
        const parent = stack[stack.length - 1];
        // A group may have been referenced as a node earlier (state X then state X { }).
        const existing = nodes.get(stmt.id);
        if (existing) nodes.delete(stmt.id);
        groups.set(stmt.id, {
          id: stmt.id,
          label: stmt.label ?? existing?.label ?? stmt.id,
          parentId: parent,
          classes: existing?.classes ?? [],
          styles: existing?.styles ?? [],
          data: existing?.data,
        });
        stack.push(stmt.id);
        break;
      }
      case "groupClose":
        if (!stack.length)
          diagnostics.push({
            severity: "warning",
            message: "Unbalanced closing brace",
            source: "pixerate",
          });
        stack.pop();
        break;
      case "direction": {
        const current = stack[stack.length - 1];
        if (current) groups.get(current)!.direction = stmt.direction;
        break;
      }
      case "node":
        touch(stmt.decl, "decl");
        break;
      case "edge": {
        const s = touch(stmt.source, "source");
        const t = touch(stmt.target, "target");
        edges.push({
          id: `L_${s}_${t}_${ordinal}`,
          source: s,
          target: t,
          label: stmt.label,
          pattern: stmt.pattern,
          arrowStart: stmt.arrowStart,
          arrowEnd: stmt.arrowEnd,
          length: 1,
          classes: [],
          styles: [],
          userDefinedId: false,
          data: stmt.data,
        });
        ordinal++;
        break;
      }
      case "classDef":
        for (const name of stmt.names) classDefs[name] = [...stmt.styles];
        break;
      case "class":
        classAssignments.push({ ids: stmt.ids, className: stmt.className });
        break;
      case "style":
        styleAssignments.push({ id: stmt.id, styles: stmt.styles });
        break;
      default:
        break;
    }
  }
  if (stack.length)
    diagnostics.push({
      severity: "warning",
      message: `${stack.length} block(s) not closed`,
      source: "pixerate",
    });

  // Edges may reference a group id (e.g. transitions to a composite state).
  for (const edge of edges) {
    for (const end of ["source", "target"] as const) {
      const id = edge[end];
      if (groups.has(id) && nodes.has(id)) nodes.delete(id);
    }
  }
  for (const { ids, className } of classAssignments) {
    for (const id of ids) {
      const target = nodes.get(id) ?? groups.get(id);
      if (target && !target.classes.includes(className)) target.classes.push(className);
    }
  }
  for (const { id, styles } of styleAssignments) {
    const target = nodes.get(id) ?? groups.get(id);
    if (target) target.styles.push(...styles);
  }

  return {
    graph: {
      direction,
      nodes: [...nodes.values()],
      edges,
      groups: [...groups.values()],
      classDefs,
      title,
    },
    diagnostics,
  };
}

function mergeData(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v) && Array.isArray(out[k])) out[k] = [...(out[k] as unknown[]), ...v];
    else out[k] = v;
  }
  return out;
}

export function parseLineDocument(
  grammar: LineGrammar,
  source: string,
  ctx: AdapterParseContext,
): LineDocument {
  const statements = grammar.joinLines(ctx.bodyLines).map((line) => grammar.parseLine(line));
  const direction = grammar.headerDirection(ctx.header, statements);
  const title =
    typeof ctx.preamble.frontmatter?.title === "string"
      ? ctx.preamble.frontmatter.title
      : undefined;
  const { graph, diagnostics } = buildLineGraph(grammar, statements, direction, title);
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
    diagnostics,
    dirty: false,
  };
}

export function serializeLineDocument(grammar: LineGrammar, doc: LineDocument): string {
  const lines: string[] = [];
  for (const stmt of doc.body.statements) {
    if (stmt.kind === "raw") {
      lines.push(stmt.raw);
      continue;
    }
    if (!("dirty" in stmt) || !stmt.dirty) {
      lines.push(stmt.raw);
      if (stmt.kind === "node" && stmt.body) lines.push(...stmt.body);
      continue;
    }
    lines.push(grammar.formatStatement(stmt));
    if (stmt.kind === "node" && stmt.body) lines.push(...stmt.body);
  }
  const indent = detectIndent(doc.body.statements);
  return assembleDocument(doc, lines, indent);
}

export function detectIndent(statements: LineStatement[]): string {
  for (const s of statements) if (s.indent) return s.indent;
  return "  ";
}

function parseFull(
  grammar: LineGrammar,
  source: string,
  carrier?: LineDocument["metaCarrier"],
): LineDocument {
  const split = splitSource(source);
  const fromBody = extractMetaFromBody(split.bodyLines);
  const fromFm = extractMetaFromFrontmatter(split.preamble);
  let meta = emptyMeta();
  if (fromFm) meta = mergeMeta(meta, fromFm);
  if (fromBody.meta) meta = mergeMeta(meta, fromBody.meta);
  return parseLineDocument(grammar, source, {
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

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export function applyLineEdit(grammar: LineGrammar, doc: LineDocument, op: EditOp): LineDocument {
  const statements = doc.body.statements.map((s) => ({
    ...s,
    ...("decl" in s
      ? {
          decl: {
            ...s.decl,
            classes: [...s.decl.classes],
            data: s.decl.data ? { ...s.decl.data } : undefined,
          },
        }
      : {}),
    ...("source" in s
      ? {
          source: { ...s.source, classes: [...s.source.classes] },
          target: { ...s.target, classes: [...s.target.classes] },
        }
      : {}),
  })) as LineStatement[];
  const work: LineDocument = {
    ...doc,
    body: { statements },
    meta: { ...doc.meta, layout: { ...doc.meta.layout }, sizes: { ...doc.meta.sizes } },
  };
  const indent = detectIndent(statements);
  const reparse = (structural: boolean): LineDocument => {
    const text = serializeLineDocument(grammar, work);
    const next = parseFull(grammar, text, work.metaCarrier);
    next.dirty = doc.dirty || structural;
    return next;
  };

  switch (op.type) {
    case "moveNodes":
      for (const { id, position } of op.moves) work.meta.layout![id] = position as Point;
      return reparse(false);
    case "resizeNode":
      if (op.size) work.meta.sizes![op.id] = op.size;
      else delete work.meta.sizes![op.id];
      return reparse(false);
    case "setViewport":
      work.meta.viewport = op.viewport;
      return reparse(false);
    case "setMetaExt":
      work.meta.ext = { ...(work.meta.ext ?? {}), [op.key]: op.value };
      if (op.value === undefined) delete work.meta.ext[op.key];
      return reparse(false);
    case "replaceSource":
      return parseFull(grammar, op.source, work.metaCarrier);
    case "setTitle": {
      const lines = [...work.preamble.lines];
      work.preamble = { ...work.preamble, lines: setTitle(lines, op.title) };
      return reparse(true);
    }
    case "setDirection": {
      if (grammar.directionAsStatement) {
        const idx = statements.findIndex(
          (s, i) => s.kind === "direction" && depthAt(statements, i) === 0,
        );
        if (idx !== -1) {
          const s = statements[idx] as Extract<LineStatement, { kind: "direction" }>;
          s.direction = op.direction;
          s.dirty = true;
        } else {
          statements.unshift({
            kind: "direction",
            raw: "",
            indent,
            direction: op.direction,
            dirty: true,
          });
        }
      } else {
        work.header = work.header.replace(/\s+(TB|TD|BT|LR|RL)\s*$/i, "") + ` ${op.direction}`;
      }
      return reparse(true);
    }
    case "addNode": {
      const decl: NodeDecl = {
        id: op.node.id,
        label: op.node.label,
        shape: op.node.shape,
        classes: [...(op.node.classes ?? [])],
        data: op.node.data,
      };
      insertIntoGroup(statements, [grammar.nodeStatement(decl, indent)], op.node.parentId, indent);
      if (op.position) work.meta.layout![op.node.id] = op.position;
      return reparse(true);
    }
    case "removeNodes": {
      const ids = new Set(op.ids);
      filterInPlace(statements, (s) => {
        if (s.kind === "node") return !ids.has(s.decl.id);
        if (s.kind === "edge") return !(ids.has(s.source.id) || ids.has(s.target.id));
        if (s.kind === "style") return !ids.has(s.id);
        if (s.kind === "class") {
          s.ids = s.ids.filter((id) => !ids.has(id));
          s.dirty = true;
          return s.ids.length > 0;
        }
        return true;
      });
      // Remove groups whose id was deleted (keep their content).
      for (const id of ids) {
        const range = groupRange(statements, id);
        if (range) {
          statements.splice(range.end, 1);
          statements.splice(range.start, 1);
        }
        delete work.meta.layout![id];
        delete work.meta.sizes![id];
      }
      return reparse(true);
    }
    case "renameNode":
    case "setNodeShape":
    case "setNodeClasses":
    case "setNodeData": {
      const id = op.id;
      let decl = findDecl(statements, id);
      if (!decl) {
        // Create a declaration statement right after the first mention.
        const node = doc.graph.nodes.find((n) => n.id === id);
        const stmt = grammar.nodeStatement(
          {
            id,
            label: node?.label !== id ? node?.label : undefined,
            shape: node?.shape !== grammar.defaultShape ? node?.shape : undefined,
            classes: [],
          },
          indent,
        );
        const first = statements.findIndex(
          (s) => s.kind === "edge" && (s.source.id === id || s.target.id === id),
        );
        statements.splice(first === -1 ? statements.length : first, 0, stmt);
        decl = findDecl(statements, id)!;
      }
      const target = decl.stmt;
      if (op.type === "renameNode") decl.decl.label = op.label;
      if (op.type === "setNodeShape") decl.decl.shape = op.shape;
      if (op.type === "setNodeClasses") {
        decl.decl.classes = [...op.classes];
        filterInPlace(statements, (s) => {
          if (s.kind !== "class" || !s.ids.includes(id)) return true;
          s.ids = s.ids.filter((x) => x !== id);
          s.dirty = true;
          return s.ids.length > 0;
        });
      }
      if (op.type === "setNodeData") {
        decl.decl.data = { ...(decl.decl.data ?? {}), ...op.data };
        // Body-bearing data (class members, ER attributes) lives in the `{ … }`
        // block: regenerate it from the grammar so the text follows the data.
        if (target.kind === "node" && ("members" in op.data || "attributes" in op.data)) {
          const fresh = grammar.nodeStatement(decl.decl, target.indent);
          target.body = fresh.kind === "node" ? fresh.body : undefined;
        }
      }
      (target as { dirty?: boolean }).dirty = true;
      return reparse(true);
    }
    case "setNodeStyles": {
      filterInPlace(statements, (s) => !(s.kind === "style" && s.id === op.id));
      if (op.styles.length)
        statements.push({
          kind: "style",
          raw: "",
          indent,
          id: op.id,
          styles: [...op.styles],
          dirty: true,
        });
      return reparse(true);
    }
    case "addEdge": {
      const spec: EdgeSpec = {
        ...grammar.defaultEdge,
        ...(op.edge.pattern ? { pattern: op.edge.pattern } : {}),
        ...(op.edge.arrowStart ? { arrowStart: op.edge.arrowStart } : {}),
        ...(op.edge.arrowEnd ? { arrowEnd: op.edge.arrowEnd } : {}),
        label: op.edge.label,
        data: {
          ...(op.edge.data ?? {}),
          synthetic: {
            source: isSyntheticEndpoint(doc, op.edge.source),
            target: isSyntheticEndpoint(doc, op.edge.target),
          },
        },
      };
      const stmt = grammar.edgeStatement(op.edge.source, op.edge.target, spec, indent);
      // Place inside the common parent group when both ends share one.
      const sp = parentOf(doc, op.edge.source);
      const tp = parentOf(doc, op.edge.target);
      insertIntoGroup(statements, [stmt], sp && sp === tp ? sp : undefined, indent);
      return reparse(true);
    }
    case "removeEdges": {
      const targets = new Set(op.ids.map((id) => edgeOrdinal(doc, id)).filter((n) => n >= 0));
      let ordinal = 0;
      filterInPlace(statements, (s) => {
        if (s.kind !== "edge") return true;
        const keep = !targets.has(ordinal);
        ordinal++;
        return keep;
      });
      return reparse(true);
    }
    case "setEdgeLabel":
    case "setEdgeStyle":
    case "reconnectEdge": {
      const stmt = edgeStatementFor(statements, doc, op.id);
      if (!stmt) return doc;
      if (op.type === "setEdgeLabel") stmt.label = op.label || undefined;
      if (op.type === "setEdgeStyle") {
        if (op.pattern) stmt.pattern = op.pattern;
        if (op.arrowStart) stmt.arrowStart = op.arrowStart;
        if (op.arrowEnd) stmt.arrowEnd = op.arrowEnd;
      }
      if (op.type === "reconnectEdge") {
        stmt.source = { id: op.source, classes: [] };
        stmt.target = { id: op.target, classes: [] };
      }
      stmt.dirty = true;
      return reparse(true);
    }
    case "groupNodes": {
      if (grammar.supportsGroups === false) return doc;
      const { open, close } = grammar.groupStatements(op.groupId, op.label, indent);
      const moved: LineStatement[] = [];
      // Move node declarations (and edges fully inside the set) into the group.
      const set = new Set(op.nodeIds);
      filterInPlace(statements, (s) => {
        if (s.kind === "node" && set.has(s.decl.id)) {
          moved.push(reindent(s, indent + indent));
          return false;
        }
        if (s.kind === "edge" && set.has(s.source.id) && set.has(s.target.id)) {
          moved.push(reindent(s, indent + indent));
          return false;
        }
        return true;
      });
      for (const id of op.nodeIds) {
        if (!moved.some((s) => s.kind === "node" && s.decl.id === id)) {
          moved.push(grammar.nodeStatement({ id, classes: [] }, indent + indent));
        }
      }
      insertIntoGroup(statements, [open, ...moved, close], op.parentId, indent);
      return reparse(true);
    }
    case "ungroup": {
      const range = groupRange(statements, op.groupId);
      if (!range) return doc;
      const inner = statements
        .slice(range.start + 1, range.end)
        .map((s) => reindent(s, (statements[range.start] as { indent: string }).indent));
      statements.splice(
        range.start,
        range.end - range.start + 1,
        ...inner.filter((s) => s.kind !== "direction"),
      );
      delete work.meta.layout![op.groupId];
      return reparse(true);
    }
    case "renameGroup": {
      const range = groupRange(statements, op.id);
      if (!range) return doc;
      const open = statements[range.start] as Extract<LineStatement, { kind: "groupOpen" }>;
      open.label = op.label;
      open.dirty = true;
      return reparse(true);
    }
    case "setGroupDirection": {
      const range = groupRange(statements, op.id);
      if (!range) return doc;
      const idx = statements.findIndex(
        (s, i) =>
          i > range.start &&
          i < range.end &&
          s.kind === "direction" &&
          depthAt(statements, i) === depthAt(statements, range.start) + 1,
      );
      if (op.direction) {
        if (idx !== -1) {
          const s = statements[idx] as Extract<LineStatement, { kind: "direction" }>;
          s.direction = op.direction;
          s.dirty = true;
        } else {
          const inner = (statements[range.start] as { indent: string }).indent + indent;
          statements.splice(range.start + 1, 0, {
            kind: "direction",
            raw: "",
            indent: inner,
            direction: op.direction,
            dirty: true,
          });
        }
      } else if (idx !== -1) statements.splice(idx, 1);
      return reparse(true);
    }
    case "setNodeParent": {
      for (const id of op.ids) {
        const found = findDecl(statements, id);
        let stmt: LineStatement;
        if (found) {
          statements.splice(statements.indexOf(found.stmt), 1);
          stmt = found.stmt;
        } else {
          stmt = grammar.nodeStatement({ id, classes: [] }, indent);
        }
        insertIntoGroup(statements, [stmt], op.parentId, indent);
      }
      return reparse(true);
    }
    case "setClassDef": {
      let found = false;
      for (const s of statements) {
        if (s.kind !== "classDef") continue;
        if (s.names.length === 1 && s.names[0] === op.name) {
          found = true;
          if (op.styles) {
            s.styles = [...op.styles];
            s.dirty = true;
          }
        }
      }
      if (!op.styles)
        filterInPlace(
          statements,
          (s) => !(s.kind === "classDef" && s.names.length === 1 && s.names[0] === op.name),
        );
      else if (!found)
        statements.push({
          kind: "classDef",
          raw: "",
          indent,
          names: [op.name],
          styles: [...op.styles],
          dirty: true,
        });
      return reparse(true);
    }
    default:
      return doc;
  }
}

/**
 * A node is a synthetic endpoint (`[*]`) when the graph says so, or when it is
 * unknown but named like one — the UI may offer "connect to end" for a scope
 * that has no end pseudo-state yet.
 */
function isSyntheticEndpoint(doc: LineDocument, id: string): boolean {
  const node = doc.graph.nodes.find((n) => n.id === id);
  if (node) return !!node.data?.synthetic;
  // Unknown id: only `root_start|end` or `<existing group>_start|end` count as `[*]`.
  const m = /^(.+)_(start|end)$/.exec(id);
  if (!m) return false;
  return m[1] === "root" || doc.graph.groups.some((g) => g.id === m[1]);
}

function reindent(s: LineStatement, indent: string): LineStatement {
  const next = { ...s, indent } as LineStatement;
  if (s.kind === "raw") return s;
  (next as { dirty?: boolean }).dirty = true;
  if (s.kind === "node" && s.body) {
    const delta = indent.length - s.indent.length;
    (next as { body?: string[] }).body = s.body.map((l) =>
      delta >= 0
        ? " ".repeat(delta) + l
        : l.slice(Math.min(-delta, l.length - l.trimStart().length)),
    );
  }
  return next;
}

function findDecl(
  statements: LineStatement[],
  id: string,
): { stmt: LineStatement; decl: NodeDecl } | null {
  for (const s of statements) {
    if (s.kind === "node" && s.decl.id === id) return { stmt: s, decl: s.decl };
  }
  for (const s of statements) {
    if (s.kind === "edge") {
      if (
        s.source.id === id &&
        (s.source.label !== undefined || s.source.shape || s.source.classes.length)
      )
        return { stmt: s, decl: s.source };
      if (
        s.target.id === id &&
        (s.target.label !== undefined || s.target.shape || s.target.classes.length)
      )
        return { stmt: s, decl: s.target };
    }
  }
  return null;
}

function parentOf(doc: LineDocument, id: string): string | undefined {
  return (
    doc.graph.nodes.find((n) => n.id === id)?.parentId ??
    doc.graph.groups.find((g) => g.id === id)?.parentId
  );
}

function edgeOrdinal(doc: LineDocument, edgeId: string): number {
  return doc.graph.edges.findIndex((e) => e.id === edgeId);
}

function edgeStatementFor(
  statements: LineStatement[],
  doc: LineDocument,
  edgeId: string,
): Extract<LineStatement, { kind: "edge" }> | null {
  const ordinal = edgeOrdinal(doc, edgeId);
  if (ordinal < 0) return null;
  let n = 0;
  for (const s of statements) {
    if (s.kind !== "edge") continue;
    if (n === ordinal) return s;
    n++;
  }
  return null;
}

function depthAt(statements: LineStatement[], index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const s = statements[i]!;
    if (s.kind === "groupOpen") depth++;
    else if (s.kind === "groupClose") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function groupRange(
  statements: LineStatement[],
  groupId: string,
): { start: number; end: number } | null {
  const start = statements.findIndex((s) => s.kind === "groupOpen" && s.id === groupId);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < statements.length; i++) {
    const s = statements[i]!;
    if (s.kind === "groupOpen") depth++;
    else if (s.kind === "groupClose") {
      depth--;
      if (depth === 0) return { start, end: i };
    }
  }
  return { start, end: statements.length };
}

function insertIntoGroup(
  statements: LineStatement[],
  block: LineStatement[],
  groupId: string | undefined,
  indent: string,
): void {
  const range = groupId ? groupRange(statements, groupId) : null;
  if (!range) {
    statements.push(...block);
    return;
  }
  const open = statements[range.start] as { indent: string };
  const inner = open.indent + indent;
  const adjusted = block.map((s) =>
    s.kind === "raw" ? s : reindent(s, inner + s.indent.slice(indent.length)),
  );
  statements.splice(range.end, 0, ...adjusted);
}

function filterInPlace<T>(arr: T[], keep: (item: T) => boolean): void {
  let j = 0;
  for (let i = 0; i < arr.length; i++) if (keep(arr[i]!)) arr[j++] = arr[i]!;
  arr.length = j;
}

function setTitle(lines: string[], title: string | undefined): string[] {
  const out = [...lines];
  const hasFm = out[0] !== undefined && /^---\s*$/.test(out[0]);
  if (!hasFm) return title === undefined ? out : ["---", `title: ${title}`, "---", ...out];
  const close = out.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
  const end = close === -1 ? out.length : close;
  const idx = out.findIndex((l, i) => i > 0 && i < end && /^title\s*:/.test(l));
  if (title === undefined) {
    if (idx !== -1) out.splice(idx, 1);
    if (out.length >= 2 && /^---\s*$/.test(out[1]!)) out.splice(0, 2);
    return out;
  }
  if (idx !== -1) out[idx] = `title: ${title}`;
  else out.splice(end, 0, `title: ${title}`);
  return out;
}

/** Sets or removes the frontmatter `title`. Shared with the passthrough adapter. */
export function setFrontmatterTitle(lines: string[], title: string | undefined): string[] {
  return setTitle(lines, title);
}

/** Creates a full adapter from a grammar. */
export function createLineAdapter(grammar: LineGrammar): DiagramAdapter<LineBody> {
  return {
    family: grammar.family,
    tier: "editable",
    parse: (source, ctx) => parseLineDocument(grammar, source, ctx),
    serialize: (doc) => serializeLineDocument(grammar, doc),
    apply: (doc, op) => applyLineEdit(grammar, doc, op),
  };
}

/** Joins lines into logical statements by matching `{ … }` across lines. */
export function joinBraceBlocks(
  lines: string[],
  extraBlock?: { open: RegExp; close: RegExp },
): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (extraBlock && extraBlock.open.test(line)) {
      let cur = line;
      let j = i + 1;
      while (j < lines.length && !extraBlock.close.test(lines[j]!)) {
        cur += "\n" + lines[j];
        j++;
      }
      if (j < lines.length) {
        cur += "\n" + lines[j];
        j++;
      }
      out.push(cur);
      i = j;
      continue;
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (opens > closes && /\{\s*$/.test(line)) {
      // Peek: a block whose content is attribute lines (no nested statements)
      // is kept with its opener as one "node with body" statement. The group
      // grammars decide via parseLine; here we just gather until the matching `}`.
      let depth = opens - closes;
      let j = i + 1;
      const body: string[] = [];
      let isSimpleBody = true;
      while (j < lines.length && depth > 0) {
        const l = lines[j]!;
        depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        if (depth > 0) body.push(l);
        if (
          /-->|<\|--|\*--|o--|\.\.>|--\|>|\|\|--|\}o--|\}\|--|^\s*(state|class|namespace|note|direction)\b/.test(
            l,
          ) &&
          depth > 0
        )
          isSimpleBody = false;
        j++;
      }
      if (isSimpleBody && depth === 0) {
        out.push([line, ...body, lines[j - 1]!].join("\n"));
        i = j;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out;
}
