import { registerFamilyLayout } from "../layout-registry.js";
import type { DiagramGraph, GraphEdge, GraphGroup, GraphNode } from "../types.js";
import { architectureLayout } from "./geometry.js";
import {
  createStatementAdapter,
  dropMetaKeys,
  filterInPlace,
  indentOf,
  slugId,
  uniqueId,
  type BaseStatement,
  type EditContext,
  type StatementGrammar,
} from "../statements/base.js";

/**
 * `architecture-beta` adapter.
 *
 * ```
 * architecture-beta
 *   group api(cloud)[API tier]
 *   service db(database)[Postgres] in api
 *   junction j in api
 *   gateway:R --> L:server
 * ```
 *
 * Canvas model: services are nodes (shape `arch-service`, `data.icon`;
 * `data.untitled` when the declaration has no `[label]`, so the label is the id),
 * junctions are small circles (shape `sm-circ`, `data.junction`), groups are
 * groups (`data.icon`, nested with `in`), and edges carry the sides they
 * attach to (`data.sourceSide` / `targetSide`, `L|R|T|B`) and whether they
 * leave a group boundary (`{group}` → `data.sourceGroup` / `targetGroup`).
 * Arrow tokens map to heads: `--` none, `-->` end, `<--` start, `<-->` both.
 * The optional edge title (`-[label]-`) is the edge label. Icon names
 * (`cloud`, `logos:aws-lambda`…) are kept verbatim.
 *
 * Positions follow Mermaid's arrangement by port sides (see `./geometry`);
 * a new edge drawn on the canvas gets the sides that face each other there.
 *
 * @module
 */

type Side = "L" | "R" | "T" | "B";

export type ArchitectureStatement =
  | (BaseStatement & { kind: "raw" })
  | (BaseStatement & { kind: "title"; title: string })
  | (BaseStatement & {
      kind: "group" | "service";
      id: string;
      icon?: string;
      label?: string;
      parent?: string;
    })
  | (BaseStatement & { kind: "junction"; id: string; parent?: string })
  | (BaseStatement & {
      kind: "edge";
      lhs: string;
      lhsGroup: boolean;
      lhsSide: Side;
      rhs: string;
      rhsGroup: boolean;
      rhsSide: Side;
      arrowStart: boolean;
      arrowEnd: boolean;
      label?: string;
    });

type Decl = Extract<ArchitectureStatement, { kind: "group" | "service" | "junction" }>;
type EdgeStmt = Extract<ArchitectureStatement, { kind: "edge" }>;

const ID = "([\\w-]+)";
const IN = `(?:\\s+in\\s+${ID})?`;
const DECL = new RegExp(
  `^(group|service)\\s+${ID}\\s*(?:\\(([^)]*)\\))?\\s*(?:\\[([^\\]]*)\\])?${IN}\\s*$`,
);
const JUNCTION = new RegExp(`^junction\\s+${ID}${IN}\\s*$`);
const EDGE = new RegExp(
  `^${ID}(\\{group\\})?\\s*:\\s*([LRTB])\\s*(<)?-(?:\\[([^\\]]*)\\])?-(>)?\\s*([LRTB])\\s*:\\s*${ID}(\\{group\\})?\\s*$`,
);
const SIDES = new Set<string>(["L", "R", "T", "B"]);

/** Brackets would end the `[label]` early. */
const cleanLabel = (text: string) => text.replace(/[[\]]/g, "");

function edgeIds(statements: ArchitectureStatement[]): Map<EdgeStmt, string> {
  const counts = new Map<string, number>();
  const ids = new Map<EdgeStmt, string>();
  for (const s of statements) {
    if (s.kind !== "edge") continue;
    const key = `${s.lhs}_${s.rhs}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    ids.set(s, `L_${key}_${n}`);
  }
  return ids;
}

export const architectureGrammar: StatementGrammar<ArchitectureStatement> = {
  family: "architecture",

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.*)$/.exec(text)))
      return { kind: "title", raw: line, indent, title: m[1]!.trim() };
    if ((m = DECL.exec(text)))
      return {
        kind: m[1] as "group" | "service",
        raw: line,
        indent,
        id: m[2]!,
        icon: m[3],
        label: m[4],
        parent: m[5],
      };
    if ((m = JUNCTION.exec(text)))
      return { kind: "junction", raw: line, indent, id: m[1]!, parent: m[2] };
    if ((m = EDGE.exec(text)))
      return {
        kind: "edge",
        raw: line,
        indent,
        lhs: m[1]!,
        lhsGroup: !!m[2],
        lhsSide: m[3] as Side,
        arrowStart: !!m[4],
        label: m[5],
        arrowEnd: !!m[6],
        rhsSide: m[7] as Side,
        rhs: m[8]!,
        rhsGroup: !!m[9],
      };
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    const inClause = (parent?: string) => (parent ? ` in ${parent}` : "");
    switch (stmt.kind) {
      case "title":
        return `${stmt.indent}title ${stmt.title}`;
      case "group":
      case "service":
        return `${stmt.indent}${stmt.kind} ${stmt.id}${stmt.icon ? `(${stmt.icon})` : ""}${
          stmt.label !== undefined ? `[${cleanLabel(stmt.label)}]` : ""
        }${inClause(stmt.parent)}`;
      case "junction":
        return `${stmt.indent}junction ${stmt.id}${inClause(stmt.parent)}`;
      case "edge": {
        const arrow = `${stmt.arrowStart ? "<" : ""}-${stmt.label ? `[${cleanLabel(stmt.label)}]` : ""}-${
          stmt.arrowEnd ? ">" : ""
        }`;
        return `${stmt.indent}${stmt.lhs}${stmt.lhsGroup ? "{group}" : ""}:${stmt.lhsSide} ${arrow} ${
          stmt.rhsSide
        }:${stmt.rhs}${stmt.rhsGroup ? "{group}" : ""}`;
      }
      default:
        return stmt.raw;
    }
  },

  buildGraph(statements, ctx) {
    const groupIds = new Set(statements.flatMap((s) => (s.kind === "group" ? [s.id] : [])));
    const parentOf = (s: { id: string; parent?: string }) =>
      s.parent && s.parent !== s.id && groupIds.has(s.parent) ? s.parent : undefined;
    const nodes: GraphNode[] = [];
    const groups: GraphGroup[] = [];
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    let title: string | undefined;
    for (const s of statements) {
      if (s.kind === "title") title = s.title;
      if (s.kind !== "group" && s.kind !== "service" && s.kind !== "junction") continue;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const base = { id: s.id, parentId: parentOf(s), classes: [], styles: [] };
      // Mermaid draws no label when the declaration has none (`untitled`).
      const untitled = s.kind !== "junction" && s.label === undefined ? true : undefined;
      if (s.kind === "group")
        groups.push({ ...base, label: s.label ?? s.id, data: { icon: s.icon, untitled } });
      else if (s.kind === "service")
        nodes.push({
          ...base,
          label: s.label ?? s.id,
          shape: "arch-service",
          data: { icon: s.icon, details: s.icon ? [s.icon] : [], untitled },
        });
      else nodes.push({ ...base, label: "", shape: "sm-circ", data: { junction: true } });
    }
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const [s, id] of edgeIds(statements)) {
      if (!nodeIds.has(s.lhs) || !nodeIds.has(s.rhs)) continue;
      edges.push({
        id,
        source: s.lhs,
        target: s.rhs,
        label: s.label,
        pattern: "solid",
        arrowStart: s.arrowStart ? "arrow_point" : "none",
        arrowEnd: s.arrowEnd ? "arrow_point" : "none",
        length: 1,
        classes: [],
        styles: [],
        userDefinedId: false,
        data: {
          sourceSide: s.lhsSide,
          targetSide: s.rhsSide,
          sourceGroup: s.lhsGroup,
          targetGroup: s.rhsGroup,
        },
      });
    }
    const graph: DiagramGraph = {
      direction: "LR",
      nodes,
      edges,
      groups,
      classDefs: {},
      title: title ?? ctx.frontmatterTitle,
    };
    return { graph };
  },

  edit(op, ctx) {
    return editArchitecture(op, ctx);
  },
};

/** Sides facing each other given the endpoints' stored positions (`R`/`L` without them). */
function facingSides(
  from: readonly [number, number] | undefined,
  to: readonly [number, number] | undefined,
): [Side, Side] {
  if (!from || !to) return ["R", "L"];
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["R", "L"] : ["L", "R"];
  return dy >= 0 ? ["B", "T"] : ["T", "B"];
}

function editArchitecture(
  op: Parameters<StatementGrammar<ArchitectureStatement>["edit"]>[0],
  ctx: EditContext<ArchitectureStatement>,
): boolean {
  const { statements } = ctx;
  const isDecl = (s: ArchitectureStatement): s is Decl =>
    s.kind === "group" || s.kind === "service" || s.kind === "junction";
  const decl = (id: string) => statements.find((s): s is Decl => isDecl(s) && s.id === id);
  const group = (id: string) => {
    const s = decl(id);
    return s?.kind === "group" ? s : undefined;
  };
  const isNode = (id: string) => {
    const s = decl(id);
    return s?.kind === "service" || s?.kind === "junction";
  };
  const edgesById = () => {
    const map = new Map<string, EdgeStmt>();
    for (const [s, id] of edgeIds(statements)) map.set(id, s);
    return map;
  };
  const taken = () => new Set(statements.flatMap((s) => (isDecl(s) ? [s.id] : [])));
  /** True when group `id` is `ancestor` or nested (through `in`) inside it. */
  const within = (id: string | undefined, ancestor: string) => {
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      if (id === ancestor) return true;
      visited.add(id);
      id = group(id)?.parent;
    }
    return false;
  };
  const lastIndex = (pred: (s: ArchitectureStatement) => boolean) => {
    let idx = -1;
    statements.forEach((s, i) => {
      if (pred(s)) idx = i;
    });
    return idx;
  };
  const declIndent = () => statements.find(isDecl)?.indent ?? ctx.indent;
  /** Members of a removed group move to the group's own parent. */
  const dissolve = (id: string) => {
    const g = group(id);
    if (!g) return false;
    for (const s of statements)
      if (isDecl(s) && s.parent === id) {
        s.parent = g.parent;
        s.dirty = true;
      }
    filterInPlace(statements, (s) => s !== g);
    return true;
  };
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const side = (v: unknown) => (typeof v === "string" && SIDES.has(v) ? (v as Side) : undefined);

  switch (op.type) {
    case "addNode": {
      const id = uniqueId(slugId(op.node.id, "svc"), taken());
      const parent = op.node.parentId && group(op.node.parentId) ? op.node.parentId : undefined;
      const base = { raw: "", indent: declIndent(), dirty: true, id, parent };
      const stmt: ArchitectureStatement =
        op.node.shape === "sm-circ"
          ? { ...base, kind: "junction" }
          : {
              ...base,
              kind: "service",
              icon: str(op.node.data?.icon) ?? "server",
              label: op.node.label ?? id,
            };
      // After the last declaration (or title); else before the first edge; else at the end.
      let at = lastIndex(isDecl);
      if (at === -1) at = lastIndex((s) => s.kind === "title");
      const firstEdge = statements.findIndex((s) => s.kind === "edge");
      statements.splice(
        at !== -1 ? at + 1 : firstEdge !== -1 ? firstEdge : statements.length,
        0,
        stmt,
      );
      if (op.position) ctx.meta.layout![id] = op.position;
      return true;
    }
    case "renameNode":
    case "renameGroup": {
      const s = decl(op.id);
      if (!s || s.kind === "junction") return false;
      s.label = op.label;
      s.dirty = true;
      return true;
    }
    case "setNodeData": {
      const s = decl(op.id);
      if (!s || s.kind === "junction" || !("icon" in op.data)) return false;
      s.icon = str(op.data.icon);
      s.dirty = true;
      return true;
    }
    case "setNodeShape": {
      const i = statements.findIndex((s) => isDecl(s) && s.id === op.id);
      const s = statements[i] as Decl | undefined;
      if (!s || s.kind === "group") return false;
      const base = { raw: "", indent: s.indent, dirty: true, id: s.id, parent: s.parent };
      if (op.shape === "sm-circ" && s.kind === "service")
        statements[i] = { ...base, kind: "junction" };
      else if (op.shape === "arch-service" && s.kind === "junction")
        statements[i] = { ...base, kind: "service", icon: "server", label: s.id };
      else return false;
      return true;
    }
    case "removeNodes": {
      const ids = new Set(op.ids);
      if (!op.ids.some((id) => decl(id))) return false;
      filterInPlace(statements, (s) => {
        if (s.kind === "service" || s.kind === "junction") return !ids.has(s.id);
        if (s.kind === "edge") return !ids.has(s.lhs) && !ids.has(s.rhs);
        return true;
      });
      for (const id of ids) dissolve(id);
      dropMetaKeys(ctx.meta, ids);
      return true;
    }
    case "setNodeParent": {
      const parent = op.parentId;
      if (parent !== undefined && !group(parent)) return false;
      const targets = op.ids.map(decl).filter((s): s is Decl => !!s);
      if (!targets.length) return false;
      if (parent && targets.some((s) => s.kind === "group" && within(parent, s.id))) return false;
      for (const s of targets) {
        s.parent = parent;
        s.dirty = true;
      }
      return true;
    }
    case "addEdge": {
      const { source, target, data } = op.edge;
      if (!isNode(source) || !isNode(target)) return false;
      const placed = architectureLayout(ctx.doc.graph, ctx.meta).positions;
      const [fromSide, toSide] = facingSides(placed[source], placed[target]);
      const last = lastIndex((s) => s.kind === "edge");
      const prev = statements[last];
      const at = last !== -1 ? last + 1 : lastIndex((s) => s.raw.trim() !== "") + 1;
      statements.splice(at, 0, {
        kind: "edge",
        raw: "",
        indent: prev?.indent ?? declIndent(),
        dirty: true,
        lhs: source,
        lhsGroup: false,
        lhsSide: side(data?.sourceSide) ?? fromSide,
        rhs: target,
        rhsGroup: false,
        rhsSide: side(data?.targetSide) ?? toSide,
        arrowStart: (op.edge.arrowStart ?? "none") !== "none",
        arrowEnd: (op.edge.arrowEnd ?? "arrow_point") !== "none",
        label: str(op.edge.label),
      });
      return true;
    }
    case "removeEdges": {
      const edges = edgesById();
      const remove = new Set(op.ids.map((id) => edges.get(id)).filter(Boolean));
      if (!remove.size) return false;
      filterInPlace(statements, (s) => !remove.has(s as EdgeStmt));
      return true;
    }
    case "setEdgeLabel": {
      // Mermaid 12 accepts an edge title written inside the arrow: `a:R -[label]- L:b`.
      const s = edgesById().get(op.id);
      if (!s) return false;
      s.label = str(op.label);
      s.dirty = true;
      return true;
    }
    case "setEdgeStyle": {
      const s = edgesById().get(op.id);
      if (!s || (op.arrowStart === undefined && op.arrowEnd === undefined)) return false;
      if (op.arrowStart !== undefined) s.arrowStart = op.arrowStart !== "none";
      if (op.arrowEnd !== undefined) s.arrowEnd = op.arrowEnd !== "none";
      s.dirty = true;
      return true;
    }
    case "setEdgeData": {
      const s = edgesById().get(op.id);
      if (!s) return false;
      const from = side(op.data.sourceSide);
      const to = side(op.data.targetSide);
      if (!from && !to) return false;
      if (from) s.lhsSide = from;
      if (to) s.rhsSide = to;
      s.dirty = true;
      return true;
    }
    case "reconnectEdge": {
      const s = edgesById().get(op.id);
      if (!s || !isNode(op.source) || !isNode(op.target)) return false;
      // `{group}` is only valid when both ends sit in different groups; drop it on reconnect.
      if (s.lhs !== op.source) s.lhsGroup = false;
      if (s.rhs !== op.target) s.rhsGroup = false;
      s.lhs = op.source;
      s.rhs = op.target;
      s.dirty = true;
      return true;
    }
    case "groupNodes": {
      const members = op.nodeIds.map(decl).filter((s): s is Decl => !!s);
      if (!members.length) return false;
      const first = Math.min(...members.map((m) => statements.indexOf(m)));
      const firstMember = statements[first] as Decl;
      const parent = op.parentId && group(op.parentId) ? op.parentId : firstMember.parent;
      if (parent && members.some((m) => m.kind === "group" && within(parent, m.id))) return false;
      const id = uniqueId(slugId(op.groupId, "group"), taken());
      statements.splice(first, 0, {
        kind: "group",
        raw: "",
        indent: firstMember.indent,
        dirty: true,
        id,
        icon: "cloud",
        label: op.label,
        parent: parent && group(parent) ? parent : undefined,
      });
      for (const m of members) {
        m.parent = id;
        m.dirty = true;
      }
      return true;
    }
    case "ungroup": {
      if (!dissolve(op.groupId)) return false;
      dropMetaKeys(ctx.meta, [op.groupId]);
      return true;
    }
    case "setTitle": {
      // Only an existing `title` statement is edited; otherwise the base writes frontmatter.
      const idx = statements.findIndex((s) => s.kind === "title");
      if (idx === -1) return false;
      if (!op.title) statements.splice(idx, 1);
      else {
        const s = statements[idx] as Extract<ArchitectureStatement, { kind: "title" }>;
        s.title = op.title;
        s.dirty = true;
      }
      return true;
    }
    default:
      return false;
  }
}

/** `architecture-beta` adapter. */
export const architectureAdapter = createStatementAdapter(architectureGrammar);

/** Mermaid's side-driven arrangement (see `./geometry`), with dragged nodes kept where dropped. */
registerFamilyLayout("architecture", (graph, meta) => {
  const { positions, sizes } = architectureLayout(graph, meta);
  return { positions, sizes };
});

export {
  ARCH_METRICS,
  architectureArrow,
  architectureEdgeRoute,
  architectureLayout,
  serviceLabelLines,
  type ArchSide,
} from "./geometry.js";
