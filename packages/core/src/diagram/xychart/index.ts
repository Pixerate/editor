import { registerFamilyLayout, sharedFrameLayout, XY_CHART_BOX } from "../layout-registry.js";
import type { DiagramGraph, GraphNode } from "../types.js";
import {
  createStatementAdapter,
  dropMetaKeys,
  filterInPlace,
  indentOf,
  quote,
  splitOutsideQuotes,
  unquote,
  type BaseStatement,
  type StatementGrammar,
} from "../statements/base.js";

/**
 * `xychart-beta` adapter.
 *
 * ```
 * xychart-beta
 *   title "Sales revenue"
 *   x-axis [jan, feb, mar]
 *   y-axis "Revenue (in $)" 4000 --> 11000
 *   bar [5000, 6000, 7500]
 *   line "Target" [5500, 6500, 7000]
 * ```
 *
 * Canvas model: one node per series (shape `bar` or `line`, `data.values`
 * in x-axis order), no edges, no groups. Series ids are their kind and
 * ordinal (`bar1`, `bar2`, `line1`), so a rename keeps the id; the label is
 * the series title, or `Bar 1` / `Line 1` when it has none
 * (`data.titled: false`). The axes and orientation are diagram data:
 * `graph.data` holds `categories` (the x-axis bands), `xTitle`, `xMin` /
 * `xMax` (a numeric x-axis), `yTitle`, `yMin` / `yMax` and `horizontal`.
 *
 * Drawn with the chart module (`@pixerate/editor/canvas` family scenes); every series
 * node shares the chart frame.
 *
 * @module
 */

export type XySeriesKind = "bar" | "line";

export type XyStatement =
  | (BaseStatement & { kind: "raw" })
  | (BaseStatement & { kind: "title"; title: string })
  | (BaseStatement & {
      kind: "xaxis";
      title?: string;
      categories?: string[];
      range?: [number, number];
    })
  | (BaseStatement & { kind: "yaxis"; title?: string; range?: [number, number] })
  | (BaseStatement & { kind: "series"; series: XySeriesKind; title?: string; values: number[] });

type Series = Extract<XyStatement, { kind: "series" }>;
type XAxis = Extract<XyStatement, { kind: "xaxis" }>;
type YAxis = Extract<XyStatement, { kind: "yaxis" }>;

const HEADER = /^(\s*)(xychart(?:-beta)?)(?:\s+(horizontal|vertical))?\s*$/i;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const RANGE = /^(-?\d+(?:\.\d+)?)\s*-->\s*(-?\d+(?:\.\d+)?)$/;

function parseHeader(header: string): { keyword: string; horizontal: boolean } {
  const m = HEADER.exec(header);
  return { keyword: m?.[2] ?? "xychart-beta", horizontal: m?.[3]?.toLowerCase() === "horizontal" };
}

function formatHeader(header: string, horizontal: boolean): string {
  const { keyword } = parseHeader(header);
  return `${indentOf(header)}${keyword}${horizontal ? " horizontal" : ""}`;
}

/** Splits a leading axis / series title (`"Revenue"` or one word) from the rest. */
function takeTitle(text: string): { title?: string; rest: string } {
  const t = text.trim();
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1);
    if (end > 0) return { title: t.slice(1, end), rest: t.slice(end + 1).trim() };
  }
  if (!t || t.startsWith("[") || RANGE.test(t) || NUMBER.test(t.split(/\s/)[0]!))
    return { rest: t };
  const m = /^(\S+)\s*(.*)$/.exec(t)!;
  return { title: m[1], rest: m[2]!.trim() };
}

function parseList(text: string): string[] | undefined {
  const m = /^\[(.*)\]$/s.exec(text.trim());
  if (!m) return undefined;
  if (!m[1]!.trim()) return [];
  return splitOutsideQuotes(m[1]!, ",").map((x) => unquote(x.trim()));
}

function parseRange(text: string): [number, number] | undefined {
  const m = RANGE.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/** A category or title as Mermaid's `text`: bare when it is one plain word. */
function formatText(text: string): string {
  return /^[A-Za-z0-9_]+$/.test(text) ? text : quote(text);
}

function formatRange(range: [number, number]): string {
  return `${formatNumber(range[0])} --> ${formatNumber(range[1])}`;
}

function seriesIds(statements: XyStatement[]): Map<Series, string> {
  const counts: Record<XySeriesKind, number> = { bar: 0, line: 0 };
  const ids = new Map<Series, string>();
  for (const s of statements) {
    if (s.kind === "series") ids.set(s, `${s.series}${++counts[s.series]}`);
  }
  return ids;
}

function finiteNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nums = value.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
  return value === undefined || value === null || !Number.isFinite(n) ? undefined : n;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const xyChartGrammar: StatementGrammar<XyStatement> = {
  family: "xychart",
  titleAsStatement: true,
  defaultIndent: "    ",

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.+)$/i.exec(text)))
      return { kind: "title", raw: line, indent, title: unquote(m[1]!.trim()) };
    if ((m = /^x-axis\b(.*)$/i.exec(text))) {
      const { title, rest } = takeTitle(m[1]!);
      const categories = parseList(rest);
      const range = categories ? undefined : parseRange(rest);
      if (rest && !categories && !range) return { kind: "raw", raw: line, indent };
      return { kind: "xaxis", raw: line, indent, title, categories, range };
    }
    if ((m = /^y-axis\b(.*)$/i.exec(text))) {
      const { title, rest } = takeTitle(m[1]!);
      const range = parseRange(rest);
      if (rest && !range) return { kind: "raw", raw: line, indent };
      return { kind: "yaxis", raw: line, indent, title, range };
    }
    if ((m = /^(bar|line)\b(.*)$/i.exec(text))) {
      const { title, rest } = takeTitle(m[2]!);
      const list = parseList(rest);
      const values = list?.map(Number);
      if (!values || values.some((v) => !Number.isFinite(v)))
        return { kind: "raw", raw: line, indent };
      const series = m[1]!.toLowerCase() as XySeriesKind;
      return { kind: "series", raw: line, indent, series, title, values };
    }
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    switch (stmt.kind) {
      case "title":
        return `${stmt.indent}title ${quote(stmt.title)}`;
      case "xaxis": {
        let out = `${stmt.indent}x-axis`;
        if (stmt.title) out += ` ${quote(stmt.title)}`;
        if (stmt.categories) out += ` [${stmt.categories.map(formatText).join(", ")}]`;
        else if (stmt.range) out += ` ${formatRange(stmt.range)}`;
        return out;
      }
      case "yaxis": {
        let out = `${stmt.indent}y-axis`;
        if (stmt.title) out += ` ${quote(stmt.title)}`;
        if (stmt.range) out += ` ${formatRange(stmt.range)}`;
        return out;
      }
      case "series":
        return `${stmt.indent}${stmt.series}${stmt.title ? ` ${quote(stmt.title)}` : ""} [${stmt.values.map(formatNumber).join(", ")}]`;
      default:
        return stmt.raw;
    }
  },

  buildGraph(statements, ctx) {
    const ids = seriesIds(statements);
    const nodes: GraphNode[] = [];
    let title: string | undefined;
    let xAxis: XAxis | undefined;
    let yAxis: YAxis | undefined;
    for (const s of statements) {
      if (s.kind === "title") title = s.title;
      else if (s.kind === "xaxis") xAxis = s;
      else if (s.kind === "yaxis") yAxis = s;
      else if (s.kind === "series") {
        const id = ids.get(s)!;
        const ordinal = id.slice(s.series.length);
        nodes.push({
          id,
          label: s.title ?? `${s.series === "bar" ? "Bar" : "Line"} ${ordinal}`,
          shape: s.series,
          classes: [],
          styles: [],
          data: {
            values: s.values,
            titled: s.title !== undefined,
            details: [s.values.map(formatNumber).join(", ")],
          },
        });
      }
    }
    const graph: DiagramGraph = {
      direction: "LR",
      nodes,
      edges: [],
      groups: [],
      classDefs: {},
      title: title ?? ctx.frontmatterTitle,
      data: {
        categories: xAxis?.categories ?? [],
        xTitle: xAxis?.title,
        xMin: xAxis?.range?.[0],
        xMax: xAxis?.range?.[1],
        yTitle: yAxis?.title,
        yMin: yAxis?.range?.[0],
        yMax: yAxis?.range?.[1],
        horizontal: parseHeader(ctx.header).horizontal,
      },
    };
    return { graph };
  },

  edit(op, ctx) {
    const { statements, doc, indent } = ctx;
    const ids = seriesIds(statements);
    const byId = new Map<string, Series>();
    for (const [s, id] of ids) byId.set(id, s);
    const lastIndex = (pred: (s: XyStatement) => boolean) => {
      let idx = -1;
      statements.forEach((s, i) => {
        if (pred(s)) idx = i;
      });
      return idx;
    };
    /** The x- or y-axis statement, inserted after the title / x-axis when missing. */
    const axis = <K extends "xaxis" | "yaxis">(kind: K) => {
      const found = statements.find((s) => s.kind === kind);
      if (found) return found as Extract<XyStatement, { kind: K }>;
      const after =
        kind === "xaxis"
          ? lastIndex((s) => s.kind === "title")
          : lastIndex((s) => s.kind === "title" || s.kind === "xaxis");
      const stmt = { kind, raw: "", indent, dirty: true } as Extract<XyStatement, { kind: K }>;
      statements.splice(after + 1, 0, stmt);
      return stmt;
    };
    switch (op.type) {
      case "addNode": {
        const series: XySeriesKind = op.node.shape === "line" ? "line" : "bar";
        const existing = [...byId.values()];
        const width =
          (statements.find((s) => s.kind === "xaxis") as XAxis | undefined)?.categories?.length ||
          existing[0]?.values.length ||
          3;
        const all = existing.flatMap((s) => s.values);
        const fill = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 10;
        const values =
          finiteNumbers(op.node.data?.values) ??
          Array.from({ length: width }, () => Math.round(fill));
        const stmt: Series = {
          kind: "series",
          raw: "",
          indent,
          series,
          title: optionalText(op.node.label),
          values,
          dirty: true,
        };
        // Series are drawn from the data; a drop position means nothing.
        statements.splice(lastIndex((s) => s.kind !== "raw") + 1, 0, stmt);
        return true;
      }
      case "removeNodes": {
        const remove = new Set(op.ids.map((id) => byId.get(id)).filter(Boolean));
        if (!remove.size) return false;
        filterInPlace(statements, (s) => !remove.has(s as Series));
        dropMetaKeys(ctx.meta, op.ids);
        return true;
      }
      case "renameNode": {
        const s = byId.get(op.id);
        if (!s) return false;
        s.title = optionalText(op.label);
        s.dirty = true;
        return true;
      }
      case "setNodeShape": {
        const s = byId.get(op.id);
        if (!s || (op.shape !== "bar" && op.shape !== "line")) return false;
        s.series = op.shape;
        s.dirty = true;
        return true;
      }
      case "setNodeData": {
        const s = byId.get(op.id);
        const values = finiteNumbers(op.data.values);
        if (!s || !values) return false;
        s.values = values;
        s.dirty = true;
        return true;
      }
      case "setTitle": {
        const idx = statements.findIndex((s) => s.kind === "title");
        if (op.title === undefined || op.title === "") {
          if (idx !== -1) statements.splice(idx, 1);
          return true;
        }
        if (idx !== -1) {
          const s = statements[idx] as Extract<XyStatement, { kind: "title" }>;
          s.title = op.title;
          s.dirty = true;
        } else statements.unshift({ kind: "title", raw: "", indent, title: op.title, dirty: true });
        return true;
      }
      case "setGraphData": {
        const d = op.data;
        let changed = false;
        if (typeof d.horizontal === "boolean") {
          ctx.setHeader(formatHeader(doc.header, d.horizontal));
          changed = true;
        }
        if ("categories" in d && Array.isArray(d.categories)) {
          const x = axis("xaxis");
          x.categories = d.categories.map(String);
          x.range = undefined;
          x.dirty = true;
          changed = true;
        }
        if ("xTitle" in d) {
          const x = axis("xaxis");
          x.title = optionalText(d.xTitle);
          x.dirty = true;
          changed = true;
        }
        if ("yTitle" in d) {
          const y = axis("yaxis");
          y.title = optionalText(d.yTitle);
          y.dirty = true;
          changed = true;
        }
        if ("yMin" in d || "yMax" in d) {
          const y = axis("yaxis");
          const values = [...byId.values()].flatMap((s) => s.values);
          const min = "yMin" in d ? optionalNumber(d.yMin) : y.range?.[0];
          const max = "yMax" in d ? optionalNumber(d.yMax) : y.range?.[1];
          // Mermaid wants both ends; the other one comes from the data.
          if (min === undefined && max === undefined) y.range = undefined;
          else
            y.range = [
              min ?? Math.min(0, ...values),
              max ?? Math.max(min !== undefined ? min + 1 : 1, ...values),
            ];
          y.dirty = true;
          changed = true;
        }
        // An axis line with nothing left on it is not valid Mermaid.
        filterInPlace(
          statements,
          (s) =>
            !(
              (s.kind === "xaxis" || s.kind === "yaxis") &&
              s.dirty &&
              !s.title &&
              !s.range &&
              !(s.kind === "xaxis" && s.categories)
            ),
        );
        return changed;
      }
      default:
        return false;
    }
  },
};

export const xyChartAdapter = createStatementAdapter(xyChartGrammar);

registerFamilyLayout("xychart", sharedFrameLayout(XY_CHART_BOX));
