import type { Diagnostic, DiagramGraph, GraphEdge, GraphNode, Point } from "../types.js";
import { registerFamilyLayout, type Size } from "../layout-registry.js";
import {
  createStatementAdapter,
  dropMetaKeys,
  indentOf,
  quote,
  renameMetaKey,
  slugId,
  uniqueId,
  unquote,
  type BaseStatement,
  type StatementGrammar,
} from "../statements/base.js";
import { dropTarget, mindmapGeometry } from "./geometry.js";

/**
 * `mindmap` adapter.
 *
 * ```
 * mindmap
 *   root((Generative Diagrams))
 *     Authoring
 *       Canvas editing
 *     Rendering
 *       ::icon(fa fa-image)
 * ```
 *
 * Canvas model: one node per mindmap line, one solid tree edge (`data.tree`)
 * from each node to each child, no groups. Hierarchy comes from indentation:
 * a node is the child of the nearest shallower node above. Positions are
 * derived (see `./geometry`): the root in the centre, branches around it.
 *
 * The bracket form is kept in `data.form` (`default`, `square`, `rounded`,
 * `circle`, `bang`, `cloud`, `hexagon`) and mapped to a diagram shape
 * (`text` for the default form); a
 * leading Mermaid id (`root((…))`) is kept (`data.explicitId`), otherwise the
 * id is derived from the label (`Canvas editing` → `Canvas_editing`).
 * `::icon(…)` and `:::class` lines decorate the node above them and move or
 * disappear with it.
 *
 * Edits: `addNode` (as last child of `node.parentId`, default the root),
 * `renameNode`, `setNodeShape`, `removeNodes` (with the whole subtree),
 * `addEdge` / `reconnectEdge` (re-parent the target, with its subtree, under
 * the source), `setNodeData` (`icon`). Tree edges cannot be removed on their
 * own; `setTitle` uses the frontmatter. `moveNodes` never stores positions: a
 * topic dropped onto another topic is re-parented under it (`interceptMeta`).
 *
 * @module
 */

/** Bracket forms of a mindmap node. `default` is plain text. */
export type MindmapForm =
  "default" | "square" | "rounded" | "circle" | "bang" | "cloud" | "hexagon";

type NodeStatement = BaseStatement & {
  kind: "node";
  /** The Mermaid id written before the brackets, if any. */
  id?: string;
  label: string;
  form: MindmapForm;
  /** Whether the label was written in double quotes. */
  quoted?: boolean;
};
type IconStatement = BaseStatement & { kind: "icon"; icon: string };
type ClassStatement = BaseStatement & { kind: "class"; classes: string[] };

export type MindmapStatement =
  (BaseStatement & { kind: "raw" }) | NodeStatement | IconStatement | ClassStatement;

/** Delimiters per form; order matters when matching (`((` before `(`). */
const FORMS: { form: Exclude<MindmapForm, "default">; open: string; close: string }[] = [
  { form: "circle", open: "((", close: "))" },
  { form: "bang", open: "))", close: "((" },
  { form: "hexagon", open: "{{", close: "}}" },
  { form: "rounded", open: "(", close: ")" },
  { form: "cloud", open: ")", close: "(" },
  { form: "square", open: "[", close: "]" },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FORM_RES = FORMS.map((f) => ({
  ...f,
  re: new RegExp(`^([^\\s()[\\]{}"]*)${escapeRe(f.open)}(.*)${escapeRe(f.close)}$`),
}));

const FORM_TO_SHAPE: Record<MindmapForm, string> = {
  default: "text",
  square: "rect",
  rounded: "rounded",
  circle: "circle",
  bang: "odd",
  cloud: "stadium",
  hexagon: "hex",
};

const SHAPE_TO_FORM: Partial<Record<string, Exclude<MindmapForm, "default">>> = {
  rect: "square",
  rounded: "rounded",
  circle: "circle",
  odd: "bang",
  stadium: "cloud",
  hex: "hexagon",
};

function parseNodeText(text: string): Omit<NodeStatement, "raw" | "indent" | "kind"> {
  for (const f of FORM_RES) {
    const m = f.re.exec(text);
    if (!m) continue;
    const inner = m[2]!;
    const quoted = /^\s*".*"\s*$/.test(inner);
    return {
      id: m[1] || undefined,
      label: quoted ? unquote(inner) : inner,
      form: f.form,
      ...(quoted ? { quoted } : {}),
    };
  }
  return { label: text, form: "default" };
}

function formatNode(stmt: NodeStatement): string {
  if (stmt.form === "default") return `${stmt.indent}${stmt.label}`;
  const f = FORMS.find((x) => x.form === stmt.form)!;
  // Quote labels that would otherwise close the brackets early.
  const label = stmt.quoted || /[()[\]{}]/.test(stmt.label) ? quote(stmt.label) : stmt.label;
  return `${stmt.indent}${stmt.id ?? ""}${f.open}${label}${f.close}`;
}

/** Ids per node statement: explicit ids first, then label-derived ones. */
function nodeIds(statements: MindmapStatement[]): Map<NodeStatement, string> {
  const taken = new Set<string>();
  const ids = new Map<NodeStatement, string>();
  for (const s of statements) if (s.kind === "node" && s.id) ids.set(s, uniqueId(s.id, taken));
  for (const s of statements)
    if (s.kind === "node" && !s.id) ids.set(s, uniqueId(slugId(s.label, "topic"), taken));
  return ids;
}

/** Index of each node's parent node statement (by nearest shallower indent above). */
function parentIndices(statements: MindmapStatement[]): Map<number, number | undefined> {
  const parents = new Map<number, number | undefined>();
  const stack: number[] = [];
  statements.forEach((s, i) => {
    if (s.kind !== "node") return;
    while (stack.length && statements[stack.at(-1)!]!.indent.length >= s.indent.length) stack.pop();
    parents.set(i, stack.at(-1));
    stack.push(i);
  });
  return parents;
}

/** Last statement index of the subtree rooted at node statement `i` (decorations included). */
function subtreeEnd(statements: MindmapStatement[], i: number): number {
  const depth = statements[i]!.indent.length;
  let last = i;
  for (let j = i + 1; j < statements.length; j++) {
    const s = statements[j]!;
    if (s.kind === "node") {
      if (s.indent.length <= depth) break;
      last = j;
    } else if (s.kind === "icon" || s.kind === "class") last = j;
  }
  return last;
}

/** Indentation unit: the first increase between consecutive node lines, else two spaces. */
function indentUnit(statements: MindmapStatement[]): string {
  let prev: string | undefined;
  for (const s of statements) {
    if (s.kind !== "node") continue;
    if (prev !== undefined && s.indent.length > prev.length)
      return s.indent.startsWith(prev)
        ? s.indent.slice(prev.length)
        : " ".repeat(s.indent.length - prev.length);
    prev = s.indent;
  }
  return "  ";
}

/** Re-indents a moved block so its first line sits at `target`. */
function reindent(block: MindmapStatement[], target: string): void {
  const base = block[0]!.indent;
  for (const s of block) {
    if (!s.raw.trim() && s.kind === "raw") continue;
    const rest = s.indent.startsWith(base) ? s.indent.slice(base.length) : "";
    s.indent = target + rest;
    s.dirty = true;
  }
}

/** Index of the node statement with graph id `id`, or -1. */
function statementIndex(statements: MindmapStatement[], id: string): number {
  for (const [s, sid] of nodeIds(statements)) if (sid === id) return statements.indexOf(s);
  return -1;
}

/** Moves topic `childId` (with its subtree) to be the last child of `parentId`. */
function reparentTopic(statements: MindmapStatement[], parentId: string, childId: string): boolean {
  const ci = statementIndex(statements, childId);
  const pi = statementIndex(statements, parentId);
  if (ci === -1 || pi === -1 || ci === pi) return false;
  const end = subtreeEnd(statements, ci);
  if (pi > ci && pi <= end) return false; // parent inside the child's subtree
  if (parentIndices(statements).get(ci) === pi) return false; // already its child
  const parentStmt = statements[pi]!;
  const unit = indentUnit(statements);
  const block = statements.splice(ci, end - ci + 1);
  reindent(block, parentStmt.indent + unit);
  const at = subtreeEnd(statements, statements.indexOf(parentStmt)) + 1;
  statements.splice(at, 0, ...block);
  return true;
}

export const mindmapGrammar: StatementGrammar<MindmapStatement> = {
  family: "mindmap",

  /**
   * Positions are derived, so moves are never stored; a topic dropped onto
   * another topic moves (with its subtree) under it. Moves that leave a topic
   * where the layout has it (layout pins) change nothing.
   */
  interceptMeta(op, ctx) {
    if (op.type !== "moveNodes") return false;
    const geo = mindmapGeometry(ctx.doc.graph);
    for (const { id, position } of op.moves) {
      const t = geo.topics.get(id);
      if (!t) continue;
      const centre: Point = [position[0] + t.width / 2, position[1] + t.height / 2];
      if (Math.abs(centre[0] - t.x) < 1 && Math.abs(centre[1] - t.y) < 1) continue;
      const target = dropTarget(geo, id, centre);
      if (target && target !== t.parent) reparentTopic(ctx.statements, target, id);
    }
    return true;
  },

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    let m: RegExpExecArray | null;
    if (!text || text.startsWith("%%")) return { kind: "raw", raw: line, indent };
    if ((m = /^::icon\((.*)\)$/.exec(text)))
      return { kind: "icon", raw: line, indent, icon: m[1]!.trim() };
    if ((m = /^:::(.*)$/.exec(text)))
      return { kind: "class", raw: line, indent, classes: m[1]!.trim().split(/\s+/) };
    return { kind: "node", raw: line, indent, ...parseNodeText(text) };
  },

  format(stmt) {
    switch (stmt.kind) {
      case "node":
        return formatNode(stmt);
      case "icon":
        return `${stmt.indent}::icon(${stmt.icon})`;
      case "class":
        return `${stmt.indent}:::${stmt.classes.join(" ")}`;
      default:
        return stmt.raw.trim() ? `${stmt.indent}${stmt.raw.trim()}` : stmt.raw;
    }
  },

  buildGraph(statements) {
    const ids = nodeIds(statements);
    const parents = parentIndices(statements);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const diagnostics: Diagnostic[] = [];
    let current: GraphNode | undefined;
    let roots = 0;
    statements.forEach((s, i) => {
      if (s.kind === "node") {
        const id = ids.get(s)!;
        current = {
          id,
          label: s.label,
          shape: FORM_TO_SHAPE[s.form],
          classes: [],
          styles: [],
          data: { form: s.form, explicitId: !!s.id },
        };
        nodes.push(current);
        const p = parents.get(i);
        if (p === undefined) roots++;
        else {
          const parentId = ids.get(statements[p] as NodeStatement)!;
          edges.push({
            id: `L_${parentId}_${id}_0`,
            source: parentId,
            target: id,
            pattern: "solid",
            arrowStart: "none",
            arrowEnd: "none",
            length: 1,
            classes: [],
            styles: [],
            userDefinedId: false,
            data: { tree: true },
          });
        }
      } else if (s.kind === "icon" && current) {
        current.data = { ...current.data, icon: s.icon, details: [s.icon] };
      } else if (s.kind === "class" && current) {
        current.classes.push(...s.classes.filter(Boolean));
      }
    });
    if (roots > 1)
      diagnostics.push({
        severity: "warning",
        message: `A mindmap has a single root; found ${roots} top-level nodes.`,
        source: "pixerate",
      });
    const graph: DiagramGraph = {
      direction: "LR",
      nodes,
      edges,
      groups: [],
      classDefs: {},
    };
    return { graph, diagnostics };
  },

  edit(op, ctx) {
    const { statements } = ctx;
    const ids = nodeIds(statements);
    const indexOf = (id: string): number => {
      for (const [s, sid] of ids) if (sid === id) return statements.indexOf(s);
      return -1;
    };
    const unit = indentUnit(statements);
    const reparent = (parentId: string, childId: string) =>
      reparentTopic(statements, parentId, childId);

    switch (op.type) {
      case "addNode": {
        const label = op.node.label?.trim() || "New topic";
        const shape = op.node.shape;
        let form: MindmapForm = shape ? (SHAPE_TO_FORM[shape] ?? "default") : "default";
        const taken = new Set(ids.values());
        const slug = slugId(label, "topic");
        let explicit: string | undefined;
        if (taken.has(slug)) {
          // An explicit id keeps existing same-label nodes on their ids; plain text cannot carry one.
          explicit = uniqueId(slug, taken);
          if (form === "default") form = "rounded";
        }
        const parentIdx = op.node.parentId
          ? indexOf(op.node.parentId)
          : statements.findIndex((s) => s.kind === "node");
        let at = statements.length;
        let indent = ctx.indent;
        if (parentIdx !== -1) {
          at = subtreeEnd(statements, parentIdx) + 1;
          indent = statements[parentIdx]!.indent + unit;
        }
        const stmt: NodeStatement = {
          kind: "node",
          raw: "",
          indent,
          label,
          form,
          ...(explicit ? { id: explicit } : {}),
          dirty: true,
        };
        statements.splice(at, 0, stmt);
        return true;
      }
      case "removeNodes": {
        const remove = new Set<number>();
        const removedIds: string[] = [];
        for (const id of op.ids) {
          const i = indexOf(id);
          if (i === -1) continue;
          const end = subtreeEnd(statements, i);
          for (let j = i; j <= end; j++) remove.add(j);
        }
        if (!remove.size) return false;
        for (const i of remove) {
          const s = statements[i]!;
          if (s.kind === "node") removedIds.push(ids.get(s)!);
        }
        const kept = statements.filter((_, i) => !remove.has(i));
        statements.length = 0;
        statements.push(...kept);
        dropMetaKeys(ctx.meta, removedIds);
        return true;
      }
      case "renameNode": {
        const i = indexOf(op.id);
        if (i === -1 || !op.label.trim()) return false;
        const s = statements[i] as NodeStatement;
        s.label = op.label.trim();
        s.dirty = true;
        if (!s.id) {
          const taken = new Set([...ids.values()].filter((id) => id !== op.id));
          renameMetaKey(ctx.meta, op.id, uniqueId(slugId(s.label, "topic"), taken));
        }
        return true;
      }
      case "setNodeShape": {
        const i = indexOf(op.id);
        if (i === -1) return false;
        const s = statements[i] as NodeStatement;
        const form: MindmapForm = SHAPE_TO_FORM[op.shape] ?? "default";
        if (form === s.form) return true;
        s.form = form;
        s.dirty = true;
        if (form === "default" && s.id) {
          // Plain text cannot carry an id: the id becomes label-derived.
          delete s.id;
          const taken = new Set([...ids.values()].filter((id) => id !== op.id));
          renameMetaKey(ctx.meta, op.id, uniqueId(slugId(s.label, "topic"), taken));
        }
        return true;
      }
      case "addEdge":
        return reparent(op.edge.source, op.edge.target);
      case "reconnectEdge":
        return reparent(op.source, op.target);
      case "setNodeData": {
        if (!("icon" in op.data)) return false;
        const i = indexOf(op.id);
        if (i === -1) return false;
        const value = typeof op.data.icon === "string" ? op.data.icon.trim() : "";
        let iconAt = -1;
        for (let j = i + 1; j < statements.length; j++) {
          const s = statements[j]!;
          if (s.kind === "icon") iconAt = j;
          if (s.kind !== "icon" && s.kind !== "class") break;
        }
        if (iconAt !== -1) {
          if (!value) statements.splice(iconAt, 1);
          else {
            const s = statements[iconAt] as IconStatement;
            s.icon = value;
            s.dirty = true;
          }
        } else if (value) {
          statements.splice(i + 1, 0, {
            kind: "icon",
            raw: "",
            indent: statements[i]!.indent + unit,
            icon: value,
            dirty: true,
          });
        }
        return true;
      }
      default:
        return false;
    }
  },
};

export const mindmapAdapter = createStatementAdapter(mindmapGrammar);

/**
 * Mermaid's arrangement (see `./geometry`): positions come from the tree, so
 * stored positions are ignored and the canvas always matches Mermaid.
 */
registerFamilyLayout("mindmap", (graph) => {
  const geo = mindmapGeometry(graph);
  const positions: Record<string, Point> = {};
  const sizes: Record<string, Size> = {};
  for (const t of geo.topics.values()) {
    positions[t.id] = [t.x - t.width / 2, t.y - t.height / 2];
    sizes[t.id] = { width: t.width, height: t.height };
  }
  return { positions, sizes };
});
