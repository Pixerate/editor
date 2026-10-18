import { registerFamilyLayout, sharedFrameLayout, RADAR_CHART_BOX } from "../layout-registry.js";
import type { DiagramGraph, GraphNode } from "../types.js";
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
  type StatementGrammar,
} from "../statements/base.js";

/**
 * `radar-beta` adapter.
 *
 * ```
 * radar-beta
 *   title Skills
 *   axis m["Math"], s["Science"], e["English"]
 *   curve alice["Alice"]{85, 90, 80}
 *   curve bob["Bob"]{ e: 70, m: 75, s: 85 }
 *   max 100
 * ```
 *
 * Canvas model: one node per curve (shape `curve`, `data.values` in axis
 * order; keyed entries are resolved and missing axes read 0), no edges, no
 * groups. Node ids are the curve ids and labels their `["…"]` labels (or the
 * id). The axes and options are diagram data: `graph.data` holds `axes`
 * (labels), `axisIds`, `max`, `min`, `ticks`, `graticule` and `showLegend`.
 * Edited curves are written positionally; editing the axes rewrites them as
 * one `axis` line and every curve to the new axis count.
 *
 * Drawn with the chart module (`@pixerate/editor/canvas` family scenes); every series
 * node shares the chart frame.
 *
 * @module
 */

interface AxisEntry {
  id: string;
  label?: string;
}

interface CurveEntry {
  axis?: string;
  value: number;
}

const OPTIONS = ["max", "min", "ticks", "graticule", "showLegend"] as const;
type OptionName = (typeof OPTIONS)[number];

export type RadarStatement =
  | (BaseStatement & { kind: "raw" })
  | (BaseStatement & { kind: "title"; title: string })
  | (BaseStatement & { kind: "axis"; axes: AxisEntry[] })
  | (BaseStatement & { kind: "curve"; id: string; label?: string; entries: CurveEntry[] })
  | (BaseStatement & { kind: "option"; name: OptionName; value: string });

type Curve = Extract<RadarStatement, { kind: "curve" }>;
type AxisStmt = Extract<RadarStatement, { kind: "axis" }>;
type OptionStmt = Extract<RadarStatement, { kind: "option" }>;

const ID = "[A-Za-z_][\\w-]*";
const NAMED = new RegExp(`^(${ID})\\s*(?:\\[\\s*("(?:[^"\\\\]|\\\\.)*")\\s*\\])?$`);
const CURVE = new RegExp(
  `^curve\\s+(${ID})\\s*(?:\\[\\s*("(?:[^"\\\\]|\\\\.)*")\\s*\\])?\\s*\\{(.*)\\}\\s*$`,
);
const NUMBER = /^-?\d+(?:\.\d+)?$/;

function parseNamed(text: string): AxisEntry | undefined {
  const m = NAMED.exec(text.trim());
  if (!m) return undefined;
  return { id: m[1]!, label: m[2] ? unquote(m[2]) : undefined };
}

function parseEntries(text: string): CurveEntry[] | undefined {
  if (!text.trim()) return [];
  const out: CurveEntry[] = [];
  for (const part of splitOutsideQuotes(text, ",")) {
    const t = part.trim();
    const keyed = new RegExp(`^(${ID})\\s*:\\s*(-?\\d+(?:\\.\\d+)?)$`).exec(t);
    if (keyed) out.push({ axis: keyed[1], value: Number(keyed[2]) });
    else if (NUMBER.test(t)) out.push({ value: Number(t) });
    else return undefined;
  }
  return out;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

function formatNamed(id: string, label?: string): string {
  return label !== undefined && label !== id ? `${id}["${label.replace(/"/g, "'")}"]` : id;
}

/** The curve's value for each axis, in axis order. */
function valuesFor(curve: Curve, axisIds: string[]): number[] {
  if (curve.entries.every((e) => e.axis === undefined))
    return axisIds.map((_, i) => curve.entries[i]?.value ?? 0);
  const byAxis = new Map(curve.entries.map((e) => [e.axis, e.value]));
  return axisIds.map((id) => byAxis.get(id) ?? 0);
}

/** A valid, unused identifier derived from a label. */
function identifier(label: string, fallback: string, taken: Set<string>): string {
  const slug = slugId(label, fallback);
  return uniqueId(/^[A-Za-z_]/.test(slug) ? slug : `${fallback}_${slug}`, taken);
}

function finiteNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nums = value.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : undefined;
}

function optionValue(name: OptionName, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (name === "showLegend") return typeof value === "boolean" ? String(value) : undefined;
  if (name === "graticule") return value === "circle" || value === "polygon" ? value : undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return name === "ticks" ? String(Math.max(1, Math.round(n))) : formatNumber(n);
}

function readOption(stmt: OptionStmt | undefined): unknown {
  if (!stmt) return undefined;
  if (stmt.name === "showLegend") return stmt.value === "true";
  if (stmt.name === "graticule") return stmt.value;
  return Number(stmt.value);
}

export const radarGrammar: StatementGrammar<RadarStatement> = {
  family: "radar",
  titleAsStatement: true,

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.+)$/.exec(text)))
      return { kind: "title", raw: line, indent, title: m[1]!.trim() };
    if ((m = /^axis\s+(.+)$/.exec(text))) {
      const axes = splitOutsideQuotes(m[1]!, ",").map(parseNamed);
      if (axes.every(Boolean))
        return { kind: "axis", raw: line, indent, axes: axes as AxisEntry[] };
    }
    if ((m = CURVE.exec(text))) {
      const entries = parseEntries(m[3]!);
      if (entries)
        return {
          kind: "curve",
          raw: line,
          indent,
          id: m[1]!,
          label: m[2] ? unquote(m[2]) : undefined,
          entries,
        };
    }
    if ((m = /^(max|min|ticks|graticule|showLegend)\s+(\S+)$/.exec(text)))
      return { kind: "option", raw: line, indent, name: m[1] as OptionName, value: m[2]! };
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    switch (stmt.kind) {
      case "title":
        return `${stmt.indent}title ${stmt.title}`;
      case "axis":
        return `${stmt.indent}axis ${stmt.axes.map((a) => formatNamed(a.id, a.label)).join(", ")}`;
      case "curve": {
        const values = stmt.entries
          .map((e) => (e.axis ? `${e.axis}: ${formatNumber(e.value)}` : formatNumber(e.value)))
          .join(", ");
        return `${stmt.indent}curve ${formatNamed(stmt.id, stmt.label)}{${values}}`;
      }
      case "option":
        return `${stmt.indent}${stmt.name} ${stmt.value}`;
      default:
        return stmt.raw;
    }
  },

  buildGraph(statements, ctx) {
    const axes = statements.flatMap((s) => (s.kind === "axis" ? s.axes : []));
    const axisIds = axes.map((a) => a.id);
    const options = new Map<OptionName, OptionStmt>();
    const nodes: GraphNode[] = [];
    let title: string | undefined;
    for (const s of statements) {
      if (s.kind === "title") title = s.title;
      else if (s.kind === "option") options.set(s.name, s);
      else if (s.kind === "curve") {
        const values = valuesFor(s, axisIds);
        nodes.push({
          id: s.id,
          label: s.label ?? s.id,
          shape: "curve",
          classes: [],
          styles: [],
          data: { values, details: [values.map(formatNumber).join(", ")] },
        });
      }
    }
    const data: Record<string, unknown> = {
      axes: axes.map((a) => a.label ?? a.id),
      axisIds,
    };
    for (const name of OPTIONS) data[name] = readOption(options.get(name));
    const graph: DiagramGraph = {
      direction: "TB",
      nodes,
      edges: [],
      groups: [],
      classDefs: {},
      title: title ?? ctx.frontmatterTitle,
      data,
    };
    return { graph };
  },

  edit(op, ctx) {
    const { statements, indent } = ctx;
    const curves = statements.filter((s): s is Curve => s.kind === "curve");
    const byId = new Map(curves.map((c) => [c.id, c]));
    const axisIds = statements.flatMap((s) => (s.kind === "axis" ? s.axes.map((a) => a.id) : []));
    const lastIndex = (pred: (s: RadarStatement) => boolean) => {
      let idx = -1;
      statements.forEach((s, i) => {
        if (pred(s)) idx = i;
      });
      return idx;
    };
    const writePositional = (curve: Curve, values: number[]) => {
      curve.entries = values.map((value) => ({ value }));
      curve.dirty = true;
    };
    switch (op.type) {
      case "addNode": {
        const taken = new Set([...byId.keys(), ...axisIds]);
        const label = op.node.label?.trim() || undefined;
        const id = identifier(op.node.id || label || "curve", "curve", taken);
        const all = curves.flatMap((c) => valuesFor(c, axisIds));
        const fill = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 50;
        const values = finiteNumbers(op.node.data?.values) ?? axisIds.map(() => Math.round(fill));
        const stmt: Curve = { kind: "curve", raw: "", indent, id, label, entries: [], dirty: true };
        writePositional(stmt, values);
        // Curves are drawn from the data; a drop position means nothing.
        const after = lastIndex(
          (s) => s.kind === "curve" || s.kind === "axis" || s.kind === "title",
        );
        statements.splice(after + 1, 0, stmt);
        return true;
      }
      case "removeNodes": {
        const remove = new Set(op.ids.map((id) => byId.get(id)).filter(Boolean));
        if (!remove.size) return false;
        filterInPlace(statements, (s) => !remove.has(s as Curve));
        dropMetaKeys(ctx.meta, op.ids);
        return true;
      }
      case "renameNode": {
        const c = byId.get(op.id);
        if (!c) return false;
        c.label = op.label.trim() || undefined;
        c.dirty = true;
        return true;
      }
      case "setNodeData": {
        const c = byId.get(op.id);
        const values = finiteNumbers(op.data.values);
        if (!c || !values) return false;
        writePositional(c, values);
        return true;
      }
      case "setTitle": {
        const idx = statements.findIndex((s) => s.kind === "title");
        if (op.title === undefined || op.title === "") {
          if (idx !== -1) statements.splice(idx, 1);
          return true;
        }
        if (idx !== -1) {
          const s = statements[idx] as Extract<RadarStatement, { kind: "title" }>;
          s.title = op.title;
          s.dirty = true;
        } else statements.unshift({ kind: "title", raw: "", indent, title: op.title, dirty: true });
        return true;
      }
      case "setGraphData": {
        const d = op.data;
        let changed = false;
        if (Array.isArray(d.axes)) {
          const labels = d.axes.map((a) => String(a).trim()).filter(Boolean);
          const old = statements.flatMap((s) => (s.kind === "axis" ? s.axes : []));
          const taken = new Set<string>(curves.map((c) => c.id));
          // Axes keep their ids by position; new ones get one from their label.
          const axes: AxisEntry[] = labels.map((label, i) => {
            const keep = old[i];
            const id = keep && !taken.has(keep.id) ? keep.id : identifier(label, "axis", taken);
            taken.add(id);
            return { id, label };
          });
          // Values follow their axis id; positional curves follow position.
          for (const c of curves) {
            const before = valuesFor(
              c,
              old.map((a) => a.id),
            );
            const keyed = c.entries.some((e) => e.axis !== undefined);
            const byOld = new Map(old.map((a, i) => [a.id, before[i]!]));
            writePositional(
              c,
              axes.map((a, i) => (keyed ? (byOld.get(a.id) ?? 0) : (before[i] ?? 0))),
            );
          }
          const first = statements.findIndex((s) => s.kind === "axis");
          filterInPlace(statements, (s) => s.kind !== "axis");
          if (axes.length) {
            const stmt: AxisStmt = { kind: "axis", raw: "", indent, axes, dirty: true };
            const at = first !== -1 ? first : lastIndex((s) => s.kind === "title") + 1;
            statements.splice(at, 0, stmt);
          }
          changed = true;
        }
        for (const name of OPTIONS) {
          if (!(name in d)) continue;
          const value = optionValue(name, d[name]);
          const idx = statements.findIndex((s) => s.kind === "option" && s.name === name);
          if (value === undefined) {
            if (idx !== -1) statements.splice(idx, 1);
          } else if (idx !== -1) {
            const s = statements[idx] as OptionStmt;
            s.value = value;
            s.dirty = true;
          } else {
            statements.push({ kind: "option", raw: "", indent, name, value, dirty: true });
          }
          changed = true;
        }
        return changed;
      }
      default:
        return false;
    }
  },
};

export const radarAdapter = createStatementAdapter(radarGrammar);

registerFamilyLayout("radar", sharedFrameLayout(RADAR_CHART_BOX));
