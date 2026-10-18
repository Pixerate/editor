import type { DiagramGraph, GraphGroup, GraphNode, Point } from "../types.js";
import { registerFamilyLayout, type Size } from "../layout-registry.js";
import {
  createStatementAdapter,
  dropMetaKeys,
  filterInPlace,
  indentOf,
  quote,
  renameMetaKey,
  slugId,
  uniqueId,
  unquote,
  type BaseStatement,
  type EditContext,
  type StatementGrammar,
} from "../statements/base.js";
import {
  POINT_BOX,
  pointPosition,
  positionToData,
  quadrantGeometry,
  quadrantSpace,
  spaceInput,
} from "./geometry.js";

export {
  POINT_BOX,
  QUADRANT_METRICS,
  pointCentre,
  pointPosition,
  positionToData,
  quadrantGeometry,
  quadrantSpace,
  spaceInput,
} from "./geometry.js";
export type { QuadrantGeometry, QuadrantSpace } from "./geometry.js";

/**
 * `quadrantChart` adapter.
 *
 * ```
 * quadrantChart
 *   title Feature prioritisation
 *   x-axis Low effort --> High effort
 *   y-axis Low impact --> High impact
 *   quadrant-1 Plan carefully
 *   Dark mode: [0.3, 0.45] radius: 8, color: #ff9900
 * ```
 *
 * Canvas model: one node per point (shape `point`, `data.x` / `data.y` in
 * 0–1, optional `radius` / `color`), the four quadrants as locked groups
 * (`quadrant-1` top-right, `quadrant-2` top-left, `quadrant-3` bottom-left,
 * `quadrant-4` bottom-right) with each point inside the quadrant it falls in.
 * Axis labels live in `graph.data` (`xAxisLeft`, `xAxisRight`, `yAxisBottom`,
 * `yAxisTop`). Point ids are derived from labels like pie slices.
 *
 * Positions are data: the registered layout places points from their
 * coordinates on Mermaid's 500×500 chart (see `./geometry`), and dragging a
 * point (`moveNodes`) rewrites its `[x, y]` instead of storing layout
 * metadata. A quadrant without a `quadrant-N` statement is labelled
 * `Quadrant N` with `data.placeholder` (Mermaid draws no label for it).
 *
 * @module
 */

type PointStatement = BaseStatement & {
  kind: "point";
  label: string;
  quoted?: boolean;
  className?: string;
  x: number;
  y: number;
  /** Trailing styling, e.g. `radius: 10, color: #ff0000`. */
  styles: string;
};
type AxisStatement = BaseStatement & { kind: "axis"; axis: "x" | "y"; from: string; to?: string };
type QuadrantStatement = BaseStatement & { kind: "quadrant"; n: 1 | 2 | 3 | 4; label: string };

export type QuadrantChartStatement =
  | (BaseStatement & { kind: "raw" })
  | (BaseStatement & { kind: "title"; title: string })
  | (BaseStatement & { kind: "classDef"; name: string; styles: string })
  | AxisStatement
  | QuadrantStatement
  | PointStatement;

const NUM = "(\\d*\\.?\\d+)";
const POINT = new RegExp(
  `^(?:"([^"]*)"|([^:"]+?))\\s*(?::::([A-Za-z0-9_-]+))?\\s*:\\s*\\[\\s*${NUM}\\s*,\\s*${NUM}\\s*\\]\\s*(.*)$`,
);
const AXIS = /^([xy])-axis\s+(.*?)(?:\s*--+>\s*(.*))?$/i;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/** The chart area of `graph` with `pointCount` points (the x axis moves once there are any). */
const spaceOf = (graph: DiagramGraph, pointCount = graph.nodes.length) =>
  quadrantSpace(spaceInput(graph, pointCount));

/** Mermaid accepts `0`, `1` and `0.xx` only. */
function formatCoord(v: number): string {
  return String(round(clamp01(v), 3));
}

/** `radius: 10, color: #f00` → ordered key/value pairs. */
function parseStyles(text: string): [string, string][] {
  return text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(":");
      return i === -1 ? [p, ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    });
}

function setStyle(text: string, key: string, value: string | undefined): string {
  const pairs = parseStyles(text);
  const i = pairs.findIndex(([k]) => k === key);
  if (value === undefined) {
    if (i !== -1) pairs.splice(i, 1);
  } else if (i !== -1) pairs[i]![1] = value;
  else pairs.push([key, value]);
  return pairs.map(([k, v]) => `${k}: ${v}`).join(", ");
}

function pointIds(statements: QuadrantChartStatement[]): Map<PointStatement, string> {
  const taken = new Set<string>();
  const ids = new Map<PointStatement, string>();
  for (const s of statements)
    if (s.kind === "point") ids.set(s, uniqueId(slugId(s.label, "point"), taken));
  return ids;
}

/** Quadrant a coordinate falls in (Mermaid numbering). */
function quadrantOf(x: number, y: number): 1 | 2 | 3 | 4 {
  if (y >= 0.5) return x >= 0.5 ? 1 : 2;
  return x >= 0.5 ? 4 : 3;
}

function formatPoint(s: PointStatement): string {
  const label = s.quoted || /[:"[\],]/.test(s.label) ? quote(s.label.replace(/"/g, "'")) : s.label;
  const cls = s.className ? `:::${s.className}` : "";
  const styles = s.styles.trim() ? ` ${s.styles.trim()}` : "";
  return `${s.indent}${label}${cls}: [${formatCoord(s.x)}, ${formatCoord(s.y)}]${styles}`;
}

/** Index after the last "header" statement (title, axes, quadrant labels), or 0. */
function settingsEnd(statements: QuadrantChartStatement[]): number {
  let at = 0;
  statements.forEach((s, i) => {
    if (s.kind === "title" || s.kind === "axis" || s.kind === "quadrant") at = i + 1;
  });
  return at;
}

export const quadrantGrammar: StatementGrammar<QuadrantChartStatement> = {
  family: "quadrant",
  titleAsStatement: true,

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    let m: RegExpExecArray | null;
    if (!text || text.startsWith("%%") || /^acc(Title|Descr)\b/.test(text))
      return { kind: "raw", raw: line, indent };
    if ((m = /^title\s+(.*)$/i.exec(text)))
      return { kind: "title", raw: line, indent, title: m[1]!.trim() };
    if ((m = AXIS.exec(text)))
      return {
        kind: "axis",
        raw: line,
        indent,
        axis: m[1]!.toLowerCase() as "x" | "y",
        from: m[2]!.trim(),
        ...(m[3] !== undefined ? { to: m[3].trim() } : {}),
      };
    if ((m = /^quadrant-([1-4])\s+(.*)$/i.exec(text)))
      return {
        kind: "quadrant",
        raw: line,
        indent,
        n: Number(m[1]) as 1 | 2 | 3 | 4,
        label: m[2]!.trim(),
      };
    if ((m = /^classDef\s+(\S+)\s*(.*)$/.exec(text)))
      return { kind: "classDef", raw: line, indent, name: m[1]!, styles: m[2]!.trim() };
    if ((m = POINT.exec(text)))
      return {
        kind: "point",
        raw: line,
        indent,
        label: m[1] !== undefined ? m[1] : m[2]!.trim(),
        ...(m[1] !== undefined ? { quoted: true } : {}),
        ...(m[3] ? { className: m[3] } : {}),
        x: Number(m[4]),
        y: Number(m[5]),
        styles: m[6]!.trim(),
      };
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    switch (stmt.kind) {
      case "title":
        return `${stmt.indent}title ${stmt.title}`;
      case "axis":
        return `${stmt.indent}${stmt.axis}-axis ${stmt.from}${stmt.to ? ` --> ${stmt.to}` : ""}`;
      case "quadrant":
        return `${stmt.indent}quadrant-${stmt.n} ${stmt.label}`;
      case "point":
        return formatPoint(stmt);
      case "classDef":
        return `${stmt.indent}classDef ${stmt.name} ${stmt.styles}`;
      default:
        return stmt.raw;
    }
  },

  buildGraph(statements, ctx) {
    const ids = pointIds(statements);
    const quadrantLabels: Record<number, string> = {};
    const data = { xAxisLeft: "", xAxisRight: "", yAxisBottom: "", yAxisTop: "" };
    const classDefs: Record<string, string[]> = {};
    const nodes: GraphNode[] = [];
    let title: string | undefined;
    for (const s of statements) {
      if (s.kind === "title") title = s.title;
      else if (s.kind === "quadrant") quadrantLabels[s.n] = unquote(s.label);
      else if (s.kind === "classDef")
        classDefs[s.name] = parseStyles(s.styles).map(([k, v]) => `${k}: ${v}`);
      else if (s.kind === "axis") {
        if (s.axis === "x") {
          data.xAxisLeft = unquote(s.from);
          data.xAxisRight = s.to ? unquote(s.to) : "";
        } else {
          data.yAxisBottom = unquote(s.from);
          data.yAxisTop = s.to ? unquote(s.to) : "";
        }
      } else if (s.kind === "point") {
        const styles = Object.fromEntries(parseStyles(s.styles));
        const radius = styles.radius !== undefined ? Number(styles.radius) : undefined;
        nodes.push({
          id: ids.get(s)!,
          label: s.label,
          shape: "point",
          parentId: `quadrant-${quadrantOf(s.x, s.y)}`,
          classes: s.className ? [s.className] : [],
          styles: [],
          data: {
            x: s.x,
            y: s.y,
            ...(radius !== undefined && Number.isFinite(radius) ? { radius } : {}),
            ...(styles.color ? { color: styles.color } : {}),
            ...(styles["stroke-color"] ? { strokeColor: styles["stroke-color"] } : {}),
            ...(styles["stroke-width"] ? { strokeWidth: styles["stroke-width"] } : {}),
            details: [`${s.x}, ${s.y}`],
          },
        });
      }
    }
    const groups: GraphGroup[] = ([1, 2, 3, 4] as const).map((n) => ({
      id: `quadrant-${n}`,
      label: quadrantLabels[n] ?? `Quadrant ${n}`,
      classes: [],
      styles: [],
      data: { locked: true, quadrant: n, ...(n in quadrantLabels ? {} : { placeholder: true }) },
    }));
    const graph: DiagramGraph = {
      direction: "TB",
      nodes,
      edges: [],
      groups,
      classDefs,
      title: title ?? ctx.frontmatterTitle,
      data,
    };
    return { graph };
  },

  interceptMeta(op, ctx) {
    if (op.type !== "moveNodes") return false;
    const ids = pointIds(ctx.statements);
    const byId = new Map([...ids].map(([s, id]) => [id, s]));
    const space = spaceOf(ctx.doc.graph);
    for (const { id, position } of op.moves) {
      const s = byId.get(id);
      if (!s) continue; // quadrants are fixed
      // Positions that already match the data (layout pins) leave the text alone.
      const [ex, ey] = pointPosition(s.x, s.y, space);
      if (Math.abs(ex - position[0]) < 1 && Math.abs(ey - position[1]) < 1) continue;
      const { x, y } = positionToData(position, space);
      if (x === s.x && y === s.y) continue;
      s.x = x;
      s.y = y;
      s.dirty = true;
    }
    return true;
  },

  edit(op, ctx) {
    const { statements, indent } = ctx;
    const ids = pointIds(statements);
    const byId = new Map<string, PointStatement>();
    for (const [s, id] of ids) byId.set(id, s);
    switch (op.type) {
      case "addNode": {
        const label = op.node.label?.trim() || "New point";
        const d = op.node.data ?? {};
        let x = typeof d.x === "number" ? clamp01(d.x) : 0.5;
        let y = typeof d.y === "number" ? clamp01(d.y) : 0.5;
        if (op.position)
          ({ x, y } = positionToData(op.position, spaceOf(ctx.doc.graph, ids.size + 1)));
        let styles = "";
        if (typeof d.radius === "number" && d.radius > 0)
          styles = setStyle(styles, "radius", String(d.radius));
        if (typeof d.color === "string" && HEX.test(d.color))
          styles = setStyle(styles, "color", d.color);
        let at = statements.length;
        statements.forEach((s, i) => {
          if (s.kind === "point") at = i + 1;
        });
        statements.splice(at, 0, {
          kind: "point",
          raw: "",
          indent,
          label,
          x,
          y,
          styles,
          dirty: true,
        });
        return true;
      }
      case "removeNodes": {
        const remove = new Set(op.ids.map((id) => byId.get(id)).filter(Boolean));
        if (!remove.size) return false;
        filterInPlace(statements, (s) => !remove.has(s as PointStatement));
        dropMetaKeys(ctx.meta, op.ids);
        return true;
      }
      case "renameNode": {
        const s = byId.get(op.id);
        if (!s || !op.label.trim()) return false;
        s.label = op.label.trim();
        s.dirty = true;
        const taken = new Set([...ids.values()].filter((id) => id !== op.id));
        renameMetaKey(ctx.meta, op.id, uniqueId(slugId(s.label, "point"), taken));
        return true;
      }
      case "setNodeData":
        return setPointData(byId.get(op.id), op.data);
      case "setNodeParent":
        // The quadrant follows from the coordinates the accompanying move wrote.
        return op.ids.some((id) => byId.has(id));
      case "renameGroup": {
        const m = /^quadrant-([1-4])$/.exec(op.id);
        if (!m) return false;
        const n = Number(m[1]) as 1 | 2 | 3 | 4;
        const label = op.label.trim();
        const idx = statements.findIndex((s) => s.kind === "quadrant" && s.n === n);
        if (!label) {
          if (idx !== -1) statements.splice(idx, 1);
          return true;
        }
        if (idx !== -1) {
          const s = statements[idx] as QuadrantStatement;
          s.label = label;
          s.dirty = true;
        } else
          statements.splice(settingsEnd(statements), 0, {
            kind: "quadrant",
            raw: "",
            indent,
            n,
            label,
            dirty: true,
          });
        return true;
      }
      case "setTitle": {
        const idx = statements.findIndex((s) => s.kind === "title");
        if (!op.title) {
          if (idx !== -1) statements.splice(idx, 1);
          return true;
        }
        if (idx !== -1) {
          const s = statements[idx] as Extract<QuadrantChartStatement, { kind: "title" }>;
          s.title = op.title;
          s.dirty = true;
        } else statements.unshift({ kind: "title", raw: "", indent, title: op.title, dirty: true });
        return true;
      }
      case "setGraphData":
        return setAxes(ctx, op.data);
      default:
        return false;
    }
  },
};

function setPointData(s: PointStatement | undefined, data: Record<string, unknown>): boolean {
  if (!s) return false;
  let handled = false;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  if ("x" in data && num(data.x) !== undefined) {
    s.x = round(clamp01(num(data.x)!), 3);
    handled = true;
  }
  if ("y" in data && num(data.y) !== undefined) {
    s.y = round(clamp01(num(data.y)!), 3);
    handled = true;
  }
  if ("radius" in data) {
    const r = num(data.radius);
    if (r !== undefined && r <= 0) return false;
    s.styles = setStyle(s.styles, "radius", r === undefined ? undefined : String(r));
    handled = true;
  }
  if ("color" in data) {
    const c = typeof data.color === "string" ? data.color.trim() : "";
    if (c && !HEX.test(c)) return false; // Mermaid only accepts hex colours
    s.styles = setStyle(s.styles, "color", c || undefined);
    handled = true;
  }
  if (handled) s.dirty = true;
  return handled;
}

const AXIS_KEYS = ["xAxisLeft", "xAxisRight", "yAxisBottom", "yAxisTop"] as const;

function setAxes(ctx: EditContext<QuadrantChartStatement>, data: Record<string, unknown>): boolean {
  if (!AXIS_KEYS.some((k) => k in data)) return false;
  const { statements } = ctx;
  for (const axis of ["x", "y"] as const) {
    const [fromKey, toKey] = axis === "x" ? AXIS_KEYS.slice(0, 2) : AXIS_KEYS.slice(2);
    if (!(fromKey! in data) && !(toKey! in data)) continue;
    const idx = statements.findIndex((s) => s.kind === "axis" && s.axis === axis);
    const current = idx !== -1 ? (statements[idx] as AxisStatement) : undefined;
    const text = (key: string, fallback: string | undefined) =>
      key in data
        ? typeof data[key] === "string"
          ? (data[key] as string).trim()
          : ""
        : (fallback ?? "");
    const from = text(fromKey!, current?.from);
    const to = text(toKey!, current?.to);
    if (!from && !to) {
      if (idx !== -1) statements.splice(idx, 1);
      continue;
    }
    // Mermaid needs a start label; an end-only axis keeps the end text as the start.
    const next: AxisStatement = {
      kind: "axis",
      raw: "",
      indent: current?.indent ?? ctx.indent,
      axis,
      from: from || to,
      ...(from && to ? { to } : {}),
      dirty: true,
    };
    if (idx !== -1) statements[idx] = next;
    else {
      const xAt = statements.findIndex((s) => s.kind === "axis" && s.axis === "x");
      const titleAt = statements.findIndex((s) => s.kind === "title");
      statements.splice(axis === "y" && xAt !== -1 ? xAt + 1 : titleAt + 1, 0, next);
    }
  }
  return true;
}

export const quadrantAdapter = createStatementAdapter(quadrantGrammar);

/**
 * Positions come from the data, never from `meta.layout`: Mermaid's chart
 * area split into four quadrants, each point's box centred on its coordinates.
 */
registerFamilyLayout("quadrant", (graph) => {
  const geo = quadrantGeometry(graph);
  const positions: Record<string, Point> = {};
  const sizes: Record<string, Size> = {};
  for (const q of geo.quadrants) {
    positions[q.id] = [q.x, q.y];
    sizes[q.id] = { width: q.width, height: q.height };
  }
  for (const p of geo.points) {
    positions[p.id] = [p.cx - POINT_BOX / 2, p.cy - POINT_BOX / 2];
    sizes[p.id] = { width: POINT_BOX, height: POINT_BOX };
  }
  return { positions, sizes };
});
