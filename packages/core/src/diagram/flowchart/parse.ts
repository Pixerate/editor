import type {
  AdapterParseContext,
  Diagnostic,
  DiagramGraph,
  GraphEdge,
  GraphGroup,
  GraphNode,
  MermaidDocument,
} from "../types.js";
import { splitStatements } from "../source/lines.js";
import { joinLogicalLines, parseStatement, type FlowStatement, type NodeRef } from "./statements.js";
import { DEFAULT_SHAPE } from "./shapes.js";

/** Body model of a flowchart document. */
export interface FlowchartBody {
  statements: FlowStatement[];
}

export type FlowchartDocument = MermaidDocument<FlowchartBody>;

/** Mermaid's auto edge id scheme. */
export function autoEdgeId(source: string, target: string, ordinal: number): string {
  return `L_${source}_${target}_${ordinal}`;
}

const HEADER_DIRECTION = /^\s*(?:flowchart|graph)(?:-elk)?\s*(TB|TD|BT|LR|RL)?\s*;?\s*$/i;

export function headerDirection(header: string): string {
  const m = HEADER_DIRECTION.exec(header);
  return (m?.[1] ?? "TB").toUpperCase();
}

/** Tokenises body lines into statements (one per logical line or `;` segment). */
export function tokenizeBody(bodyLines: string[]): FlowStatement[] {
  const statements: FlowStatement[] = [];
  for (const logical of joinLogicalLines(bodyLines)) {
    // `;` separated statements on one line are kept as separate statements
    // but we remember they shared a line through a trailing marker so the
    // serializer can join them back. Simpler: only split when it is unambiguous
    // (no `@{`), otherwise keep the whole line.
    if (logical.includes("@{") || !logical.includes(";")) {
      statements.push(parseStatement(logical));
      continue;
    }
    const segments = splitStatements(logical);
    const nonEmpty = segments.filter((s) => s.trim() !== "");
    if (nonEmpty.length <= 1) {
      // A single statement, possibly with a trailing `;` — keep the line intact.
      const stmt = parseStatement(nonEmpty[0] ?? logical);
      stmt.raw = logical;
      statements.push(stmt);
      continue;
    }
    // Keep `;`-joined statements as one raw-ish compound: parse each segment
    // so the graph is right, but mark the group so re-emission stays on a line.
    const parsed = nonEmpty.map((seg, i) => parseStatement(i === 0 ? seg : seg.trimStart()));
    // Attach the original for lossless output when untouched.
    statements.push(...withCompoundMarker(parsed, logical));
  }
  return statements;
}

/**
 * Compound (`a; b`) handling: the first statement carries the full raw line
 * and the rest carry an empty raw so that serialising untouched output
 * reproduces the single line. When any member becomes dirty, each member is
 * emitted on its own line — a semantics-preserving normalisation.
 */
const COMPOUND = Symbol("compound");
export interface CompoundMarked {
  [COMPOUND]?: { members: FlowStatement[]; raw: string };
}

function withCompoundMarker(parsed: FlowStatement[], raw: string): FlowStatement[] {
  parsed.forEach((stmt, i) => markCompound(stmt, parsed, i === 0 ? raw : ""));
  return parsed;
}

/** Attaches compound membership to a statement (used when cloning). */
export function markCompound(stmt: FlowStatement, members: FlowStatement[], raw: string): void {
  (stmt as CompoundMarked)[COMPOUND] = { members, raw };
}

export function compoundInfo(
  stmt: FlowStatement,
): { members: FlowStatement[]; raw: string } | undefined {
  return (stmt as CompoundMarked)[COMPOUND];
}

/**
 * Builds the normalised graph from statements. Follows Mermaid's rules:
 * a node belongs to the innermost subgraph in which it is mentioned; when it
 * is mentioned in several, the one declared last wins (Mermaid's `makeUniq`).
 */
export function buildGraph(
  statements: FlowStatement[],
  direction: string,
  title?: string,
): {
  graph: DiagramGraph;
  diagnostics: Diagnostic[];
} {
  const nodes = new Map<string, GraphNode>();
  const groups = new Map<string, GraphGroup>();
  const edges: GraphEdge[] = [];
  const classDefs: Record<string, string[]> = {};
  const diagnostics: Diagnostic[] = [];
  const stack: string[] = [];
  /** Mentions per subgraph, in declaration order. */
  const membership = new Map<string, Set<string>>();
  const classAssignments: { ids: string[]; className: string }[] = [];
  const styleAssignments: { id: string; styles: string[] }[] = [];
  const clicks: { id: string; rest: string }[] = [];
  const linkStyles: { targets: number[] | "default"; styles: string[] }[] = [];
  const dataOnly: { id: string; data: Record<string, string> }[] = [];
  let ordinal = 0;

  const touch = (ref: NodeRef): GraphNode => {
    let node = nodes.get(ref.id);
    if (!node) {
      node = { id: ref.id, label: ref.id, shape: DEFAULT_SHAPE, classes: [], styles: [] };
      nodes.set(ref.id, node);
    }
    if (ref.label !== undefined) node.label = ref.label;
    if (ref.shape) node.shape = ref.shape;
    for (const cls of ref.classes) if (!node.classes.includes(cls)) node.classes.push(cls);
    if (ref.data && Object.keys(ref.data).length) {
      node.data = { ...(node.data ?? {}), ...stripQuotes(ref.data) };
    }
    const current = stack[stack.length - 1];
    if (current) membership.get(current)!.add(ref.id);
    return node;
  };

  statements.forEach((stmt, index) => {
    switch (stmt.kind) {
      case "subgraph": {
        const parent = stack[stack.length - 1];
        if (groups.has(stmt.id)) {
          diagnostics.push({
            severity: "warning",
            message: `Duplicate subgraph id "${stmt.id}"`,
            line: index + 1,
            source: "pixerate",
          });
        }
        groups.set(stmt.id, {
          id: stmt.id,
          label: stmt.title ?? stmt.id,
          parentId: parent,
          classes: [],
          styles: [],
        });
        membership.set(stmt.id, new Set());
        if (parent) membership.get(parent)!.add(stmt.id);
        stack.push(stmt.id);
        break;
      }
      case "end":
        if (!stack.length) {
          diagnostics.push({
            severity: "warning",
            message: "Stray `end` without a subgraph",
            line: index + 1,
            source: "pixerate",
          });
        }
        stack.pop();
        break;
      case "direction": {
        const current = stack[stack.length - 1];
        if (current) groups.get(current)!.direction = stmt.direction;
        break;
      }
      case "chain": {
        const { groups: ngroups, links } = stmt.chain;
        // A lone `id@{ animate: true }` targets an edge, not a node — resolve later.
        if (ngroups.length === 1 && ngroups[0]!.length === 1 && links.length === 0) {
          const ref = ngroups[0]!;
          const only = ref[0]!;
          if (
            only.form === "data" &&
            only.data &&
            !only.shape &&
            only.label === undefined &&
            ("animate" in only.data || "animation" in only.data)
          ) {
            dataOnly.push({ id: only.id, data: only.data });
            break;
          }
        }
        for (const group of ngroups) for (const ref of group) touch(ref);
        links.forEach((link, i) => {
          const from = ngroups[i]!;
          const to = ngroups[i + 1]!;
          for (const s of from) {
            for (const t of to) {
              const id = link.id ?? autoEdgeId(s.id, t.id, ordinal);
              edges.push({
                id,
                source: s.id,
                target: t.id,
                label: link.label,
                pattern: link.pattern,
                arrowStart: link.arrowStart,
                arrowEnd: link.arrowEnd,
                length: link.length,
                classes: [],
                styles: [],
                userDefinedId: !!link.id,
              });
              ordinal++;
            }
          }
        });
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
      case "linkStyle":
        linkStyles.push({ targets: stmt.targets, styles: stmt.styles });
        break;
      case "click":
        clicks.push({ id: stmt.id, rest: stmt.rest });
        break;
      default:
        break;
    }
  });

  if (stack.length) {
    diagnostics.push({
      severity: "warning",
      message: `${stack.length} subgraph(s) missing \`end\``,
      source: "pixerate",
    });
  }

  // Resolve group membership: last mention wins.
  const parentOf = new Map<string, string>();
  for (const [groupId, members] of membership) {
    for (const member of members) parentOf.set(member, groupId);
  }
  for (const node of nodes.values()) {
    const parent = parentOf.get(node.id);
    if (parent && groups.has(parent)) node.parentId = parent;
  }
  for (const group of groups.values()) {
    const parent = parentOf.get(group.id);
    if (parent && parent !== group.id && groups.has(parent)) group.parentId = parent;
  }

  for (const { ids, className } of classAssignments) {
    for (const id of ids) {
      const node = nodes.get(id);
      const group = groups.get(id);
      const target = node ?? group;
      if (target && !target.classes.includes(className)) target.classes.push(className);
    }
  }
  for (const { id, styles } of styleAssignments) {
    const target = nodes.get(id) ?? groups.get(id);
    if (target) target.styles.push(...styles);
  }
  for (const { id, rest } of clicks) {
    const node = nodes.get(id);
    if (!node) continue;
    const parsed = parseClick(rest);
    if (parsed.href) {
      node.link = parsed.href;
      node.linkTarget = parsed.target;
    }
    if (parsed.tooltip) node.tooltip = parsed.tooltip;
    if (parsed.callback) node.data = { ...(node.data ?? {}), callback: parsed.callback };
  }
  for (const { targets, styles } of linkStyles) {
    if (targets === "default") {
      for (const edge of edges) edge.styles.push(...styles);
    } else {
      for (const idx of targets) {
        const edge = edges[idx];
        if (edge) edge.styles.push(...styles);
        else
          diagnostics.push({
            severity: "warning",
            message: `linkStyle index ${idx} has no edge`,
            source: "pixerate",
          });
      }
    }
  }
  for (const { id, data } of dataOnly) {
    const edge = edges.find((e) => e.id === id);
    if (edge) {
      if (data.animate !== undefined) edge.animate = data.animate.trim() === "true";
      if (data.animation !== undefined) {
        const a = data.animation.trim();
        if (a === "fast" || a === "slow") edge.animation = a;
      }
    } else {
      // Not an edge after all: treat as a node with data.
      const node: GraphNode = {
        id,
        label: id,
        shape: DEFAULT_SHAPE,
        classes: [],
        styles: [],
        data: stripQuotes(data),
      };
      nodes.set(id, node);
    }
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

function stripQuotes(data: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const t = v.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
      out[k] = t.slice(1, -1);
    else if (t === "true" || t === "false") out[k] = t === "true";
    else if (/^-?\d+(\.\d+)?$/.test(t)) out[k] = Number(t);
    else out[k] = t;
  }
  return out;
}

export interface ParsedClick {
  href?: string;
  target?: string;
  tooltip?: string;
  callback?: string;
}

/** Parses the tail of a `click` statement. */
export function parseClick(rest: string): ParsedClick {
  const out: ParsedClick = {};
  const strings = [...rest.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const words = rest
    .replace(/"[^"]*"/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const targetWord = words.find((w) => /^_(blank|self|parent|top)$/.test(w));
  if (targetWord) out.target = targetWord;
  if (words[0] === "href") {
    out.href = strings[0];
    out.tooltip = strings[1];
  } else if (words[0] === "call" || words[0] === "callback") {
    out.callback =
      words[0] === "callback"
        ? words[1]
        : rest
            .replace(/^call\s+/, "")
            .replace(/"[^"]*"/g, "")
            .trim();
    out.tooltip = strings[0];
  } else if (strings.length && /^https?:|^\/|^#|^mailto:/.test(strings[0]!)) {
    out.href = strings[0];
    out.tooltip = strings[1];
  } else if (words.length) {
    out.callback = words[0];
    out.tooltip = strings[0];
  }
  return out;
}

/** Parses a flowchart body into a document. */
export function parseFlowchart(_source: string, ctx: AdapterParseContext): FlowchartDocument {
  const statements = tokenizeBody(ctx.bodyLines);
  const direction = headerDirection(ctx.header);
  const title =
    typeof ctx.preamble.frontmatter?.title === "string"
      ? ctx.preamble.frontmatter.title
      : undefined;
  const { graph, diagnostics } = buildGraph(statements, direction, title);
  return {
    family: "flowchart",
    tier: "editable",
    source: ctx.source,
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
