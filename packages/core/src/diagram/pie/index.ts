import type { DiagramGraph, GraphNode } from "../types.js";
import { registerFamilyLayout } from "../layout-registry.js";
import { pieGeometry } from "./geometry.js";
import {
  createStatementAdapter,
  dropMetaKeys,
  filterInPlace,
  indentOf,
  quote,
  renameMetaKey,
  slugId,
  uniqueId,
  type BaseStatement,
  type StatementGrammar,
} from "../statements/base.js";

/**
 * `pie` adapter.
 *
 * ```
 * pie showData
 *   title Pets adopted
 *   "Dogs" : 386
 *   "Cats" : 85
 * ```
 *
 * Canvas model: one node per slice (shape `slice`, `data.value`), no edges,
 * no groups. `graph.data.showData` mirrors the header flag; the title comes
 * from a `title` statement (or the header's `title …` suffix). Slice ids are
 * derived from their labels (`Dogs` → `Dogs`, `Hot dogs` → `Hot_dogs`), made
 * unique with `_2`, `_3`… and kept stable through edits other than renames.
 *
 * Positions are data: the registered layout puts every slice on the pie's
 * bounding square (see `./geometry`), and drop positions are ignored.
 *
 * @module
 */

export type PieStatement =
  | (BaseStatement & { kind: "raw" })
  | (BaseStatement & { kind: "title"; title: string })
  | (BaseStatement & { kind: "slice"; label: string; value: number });

const SLICE = /^"((?:[^"\\]|\\.)*)"\s*:\s*(-?\d+(?:\.\d+)?)\s*$/;
const HEADER = /^(\s*pie)(\s+showData)?(?:\s+title\s+(.*))?\s*$/i;

function parseHeader(header: string): { showData: boolean; title?: string } {
  const m = HEADER.exec(header);
  if (!m) return { showData: /\bshowData\b/.test(header) };
  return { showData: !!m[2], title: m[3]?.trim() || undefined };
}

function formatHeader(indent: string, showData: boolean, title: string | undefined): string {
  return `${indent}pie${showData ? " showData" : ""}${title ? ` title ${title}` : ""}`;
}

function sliceIds(statements: PieStatement[]): Map<PieStatement, string> {
  const taken = new Set<string>();
  const ids = new Map<PieStatement, string>();
  for (const s of statements) {
    if (s.kind === "slice") ids.set(s, uniqueId(slugId(s.label, "slice"), taken));
  }
  return ids;
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

export const pieGrammar: StatementGrammar<PieStatement> = {
  family: "pie",
  titleAsStatement: true,

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.*)$/i.exec(text)))
      return { kind: "title", raw: line, indent, title: m[1]!.trim() };
    if ((m = SLICE.exec(text)))
      return {
        kind: "slice",
        raw: line,
        indent,
        label: m[1]!.replace(/\\"/g, '"'),
        value: Number(m[2]),
      };
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    switch (stmt.kind) {
      case "title":
        return `${stmt.indent}title ${stmt.title}`;
      case "slice":
        return `${stmt.indent}${quote(stmt.label)} : ${formatValue(stmt.value)}`;
      default:
        return stmt.raw;
    }
  },

  buildGraph(statements, ctx) {
    const header = parseHeader(ctx.header);
    const ids = sliceIds(statements);
    const nodes: GraphNode[] = [];
    let title = header.title;
    for (const s of statements) {
      if (s.kind === "title") title = s.title;
      if (s.kind === "slice")
        nodes.push({
          id: ids.get(s)!,
          label: s.label,
          shape: "slice",
          classes: [],
          styles: [],
          data: { value: s.value, details: [formatValue(s.value)] },
        });
    }
    const graph: DiagramGraph = {
      direction: "TB",
      nodes,
      edges: [],
      groups: [],
      classDefs: {},
      title: title ?? ctx.frontmatterTitle,
      data: { showData: header.showData },
    };
    return { graph };
  },

  edit(op, ctx) {
    const { statements, doc, indent } = ctx;
    const ids = sliceIds(statements);
    const byId = new Map<string, Extract<PieStatement, { kind: "slice" }>>();
    for (const [s, id] of ids) byId.set(id, s as Extract<PieStatement, { kind: "slice" }>);
    const lastSlice = () => {
      let idx = -1;
      statements.forEach((s, i) => {
        if (s.kind === "slice") idx = i;
      });
      return idx;
    };
    switch (op.type) {
      case "addNode": {
        const label = op.node.label ?? op.node.id;
        const value = typeof op.node.data?.value === "number" ? op.node.data.value : 10;
        const stmt: PieStatement = { kind: "slice", raw: "", indent, label, value, dirty: true };
        // Wedges are placed from the data; a drop position means nothing.
        statements.splice(lastSlice() + 1, 0, stmt);
        return true;
      }
      case "removeNodes": {
        const remove = new Set(op.ids.map((id) => byId.get(id)).filter(Boolean));
        if (!remove.size) return false;
        filterInPlace(statements, (s) => !remove.has(s as never));
        dropMetaKeys(ctx.meta, op.ids);
        return true;
      }
      case "renameNode": {
        const s = byId.get(op.id);
        if (!s) return false;
        s.label = op.label;
        s.dirty = true;
        const taken = new Set([...ids.values()].filter((id) => id !== op.id));
        renameMetaKey(ctx.meta, op.id, uniqueId(slugId(op.label, "slice"), taken));
        return true;
      }
      case "setNodeData": {
        const s = byId.get(op.id);
        if (!s) return false;
        if (typeof op.data.value === "number" && Number.isFinite(op.data.value)) {
          s.value = op.data.value;
          s.dirty = true;
          return true;
        }
        return false;
      }
      case "setTitle": {
        const header = parseHeader(doc.header);
        if (header.title !== undefined) {
          ctx.setHeader(formatHeader(indentOf(doc.header), header.showData, op.title));
          return true;
        }
        const idx = statements.findIndex((s) => s.kind === "title");
        if (op.title === undefined || op.title === "") {
          if (idx !== -1) statements.splice(idx, 1);
          return true;
        }
        if (idx !== -1) {
          const s = statements[idx] as Extract<PieStatement, { kind: "title" }>;
          s.title = op.title;
          s.dirty = true;
        } else statements.unshift({ kind: "title", raw: "", indent, title: op.title, dirty: true });
        return true;
      }
      case "setGraphData": {
        if (typeof op.data.showData !== "boolean") return false;
        const header = parseHeader(doc.header);
        ctx.setHeader(formatHeader(indentOf(doc.header), op.data.showData, header.title));
        return true;
      }
      default:
        return false;
    }
  },
};

export const pieAdapter = createStatementAdapter(pieGrammar);

/**
 * Positions come from the data: every slice node shares the pie's bounding
 * square (each draws only its own wedge), as Mermaid lays the chart out.
 */
registerFamilyLayout("pie", (graph) => {
  const { box } = pieGeometry(graph);
  const positions: Record<string, readonly [number, number]> = {};
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const n of graph.nodes) {
    positions[n.id] = [box.x, box.y];
    sizes[n.id] = { width: box.width, height: box.height };
  }
  return { positions, sizes };
});
