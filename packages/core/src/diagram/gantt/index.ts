import type { DiagramGraph, EditOp, GraphEdge, GraphNode, Point } from "../types.js";
import { registerFamilyLayout, type Size } from "../layout-registry.js";
import { DAY_MS as GEO_DAY_MS, GANTT_METRICS, ganttGeometry, rowAtY, timeAtX } from "./geometry.js";
import {
  createStatementAdapter,
  type EditContext,
  indentOf,
  type BaseStatement,
  type StatementGrammar,
} from "../statements/base.js";
import {
  buildSectionsModel,
  cleanText,
  editSections,
  formatSectionsLine,
  joinAccDescrBlocks,
  parseSectionsLine,
  sectionGroups,
  sectionsTitle,
  type RawStatement,
  type SectionStatement,
  type SectionsModel,
  type SectionsSpec,
  type TitleStatement,
} from "../statements/sections.js";

/**
 * `gantt` adapter.
 *
 * ```
 * gantt
 *   title Q4 delivery roadmap
 *   dateFormat YYYY-MM-DD
 *   section Platform
 *     Design system v9 rollout :done, ds, 2026-10-01, 14d
 *     Observability upgrade    :ob, after ds, 14d
 * ```
 *
 * Canvas model: one node per task (shape `task`, or `milestone` when tagged
 * so), sections as groups, and one dependency edge `X → task` per id in a
 * task's `after X Y` start (`data.dependency: true`). Task ids are the
 * explicit Mermaid ids, or slugs of the task names for tasks without one.
 * Task data: `tags`, `start`, `end` (as written), `explicitId`, plus the
 * resolved `startTime` / `endTime` (UTC epoch ms, when computable) that the
 * time-axis layout uses. Config lines (`dateFormat`, `axisFormat`,
 * `excludes`, `tickInterval`, `todayMarker`) are exposed as `graph.data`.
 *
 * @module
 */

/** Task tags Mermaid recognises before the id/start/end parts. */
export const GANTT_TAGS = ["done", "active", "crit", "milestone", "vert"] as const;

/** Diagram-level settings edited with `setGraphData`. */
export const GANTT_CONFIG_KEYS = [
  "dateFormat",
  "axisFormat",
  "excludes",
  "tickInterval",
  "todayMarker",
] as const;
type ConfigKey = (typeof GANTT_CONFIG_KEYS)[number];

/** A task line: `Name :tags, id, start, end`. */
export interface GanttTask extends BaseStatement {
  kind: "task";
  name: string;
  tags: string[];
  id?: string;
  start?: string;
  end: string;
  /** Text after the task data that Mermaid ignores (`; …`, `# …`), kept on format. */
  suffix: string;
}

/** One of the {@link GANTT_CONFIG_KEYS} lines. */
export interface GanttConfig extends BaseStatement {
  kind: "config";
  key: ConfigKey;
  value: string;
}

export type GanttStatement =
  RawStatement | TitleStatement | SectionStatement | GanttConfig | GanttTask;

/** Lines Mermaid reads as keywords; never tasks even when they contain a colon. */
const KEYWORD =
  /^(?:(?:dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|weekend|inclusiveEndDates|topAxis|click|accTitle|accDescr|accDescription|displayMode)\b|%%|#)/i;
const CONFIG = new RegExp(`^(${GANTT_CONFIG_KEYS.join("|")})\\s+(.*)$`, "i");
/** A 2-part task whose first part looks like a start (date, `after`, `until`, number). */
const START_LIKE = /^(after|until)\s|^\d{4}-\d{2}-\d{2}$|^\d+$|^\d[\d\-/.: T]*\d$/i;
const DURATION = /^(\d+(?:\.\d+)?)(ms|[Mdhmswy])$/;
const AFTER = /^after\s+(.+)$/i;
const UNTIL = /^until\s+(.+)$/i;
const DAY_MS = 86_400_000;
const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";

const isTag = (part: string): boolean => (GANTT_TAGS as readonly string[]).includes(part);

/** `after a b` → `["a", "b"]`; `[]` for any other start. */
export function afterIds(start: string | undefined): string[] {
  const m = start ? AFTER.exec(start.trim()) : null;
  return m ? m[1]!.trim().split(/\s+/) : [];
}

function untilIds(end: string | undefined): string[] {
  const m = end ? UNTIL.exec(end.trim()) : null;
  return m ? m[1]!.trim().split(/\s+/) : [];
}

function parseTaskData(data: string): Omit<GanttTask, "raw" | "indent" | "kind" | "name"> | null {
  const cut = data.search(/[#;]/);
  const body = cut === -1 ? data : data.slice(0, cut);
  const suffix = cut === -1 ? "" : data.slice(cut);
  const parts = body.split(",").map((p) => p.trim());
  const tags: string[] = [];
  // Like Mermaid: every leading part that is a tag is a tag, in any order.
  while (parts.length && isTag(parts[0]!)) tags.push(parts.shift()!);
  if (parts.some((p) => !p) || parts.length === 0 || parts.length > 3) return null;
  if (parts.length === 3) return { tags, id: parts[0], start: parts[1], end: parts[2]!, suffix };
  if (parts.length === 2) {
    if (START_LIKE.test(parts[0]!)) return { tags, start: parts[0], end: parts[1]!, suffix };
    return { tags, id: parts[0], end: parts[1]!, suffix };
  }
  return { tags, end: parts[0]!, suffix };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** dayjs tokens are runs of one letter; only these runs are understood. */
const TOKENS = /([A-Za-z])\1*/g;
const SUPPORTED = new Set([
  "YYYY",
  "YY",
  "MM",
  "M",
  "DD",
  "D",
  "HH",
  "H",
  "mm",
  "m",
  "ss",
  "s",
  "SSS",
]);
const supported = (fmt: string): boolean =>
  !/[[\]]/.test(fmt) && (fmt.match(TOKENS) ?? []).every((t) => SUPPORTED.has(t));

/**
 * Parses a date written in a dayjs-style `dateFormat` (`YYYY`, `MM`, `DD`,
 * `HH`, `mm`, `ss`… plus `x` / `X` timestamps). Falls back to ISO / `Date`
 * parsing like Mermaid does. Returns UTC epoch milliseconds.
 */
export function parseGanttDate(text: string, format = DEFAULT_DATE_FORMAT): number | undefined {
  const t = text.trim();
  const fmt = format.trim();
  if (fmt === "x" && /^\d+$/.test(t)) return Number(t);
  if (fmt === "X" && /^\d+$/.test(t)) return Number(t) * 1000;
  if (supported(fmt)) {
    const fields: string[] = [];
    const pattern = fmt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(TOKENS, (tok) => {
      fields.push(tok);
      return tok.length === 1 ? "(\\d{1,2})" : `(\\d{${tok.length}})`;
    });
    const m = new RegExp(`^${pattern}$`).exec(t);
    if (m) {
      const v: Record<string, number> = {};
      fields.forEach((f, i) => (v[f[0]!] = Number(m[i + 1])));
      const year = fields.includes("YY") ? 2000 + v.Y! : (v.Y ?? 1970);
      return Date.UTC(year, (v.M ?? 1) - 1, v.D ?? 1, v.H ?? 0, v.m ?? 0, v.s ?? 0, v.S ?? 0);
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Date.parse(`${t}T00:00:00Z`);
  if (!/^\d/.test(t)) return undefined;
  const d = Date.parse(t);
  return Number.isFinite(d) ? d : undefined;
}

/** Formats UTC epoch ms with a `dateFormat`; unsupported formats fall back to `YYYY-MM-DD`. */
export function formatGanttDate(ms: number, format = DEFAULT_DATE_FORMAT): string {
  let fmt = format.trim();
  if (fmt === "x") return String(ms);
  if (fmt === "X") return String(Math.floor(ms / 1000));
  if (!supported(fmt)) fmt = DEFAULT_DATE_FORMAT;
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const values: Record<string, string> = {
    YYYY: pad(d.getUTCFullYear(), 4),
    YY: pad(d.getUTCFullYear() % 100),
    MM: pad(d.getUTCMonth() + 1),
    M: String(d.getUTCMonth() + 1),
    DD: pad(d.getUTCDate()),
    D: String(d.getUTCDate()),
    HH: pad(d.getUTCHours()),
    H: String(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    m: String(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
    s: String(d.getUTCSeconds()),
    SSS: pad(d.getUTCMilliseconds(), 3),
  };
  return fmt.replace(TOKENS, (tok) => values[tok]!);
}

function addDuration(start: number, text: string): number | undefined {
  const m = DURATION.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!;
  const fixed: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: DAY_MS,
    w: 7 * DAY_MS,
  };
  if (fixed[unit]) return start + n * fixed[unit]!;
  const d = new Date(start);
  if (unit === "M") d.setUTCMonth(d.getUTCMonth() + n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.getTime();
}

interface Schedule {
  start?: number;
  end?: number;
}

/**
 * Resolves start/end times the way Mermaid does (a task without a start
 * follows the previous task; `after` takes the latest end of its ids;
 * `until` the earliest start), iterating until stable so forward references
 * resolve. `excludes` / `inclusiveEndDates` are ignored.
 */
function resolveSchedule(
  items: { id: string; task: GanttTask }[],
  format: string,
): Map<string, Schedule> {
  const out = new Map<string, Schedule>(items.map((i) => [i.id, {}]));
  for (let pass = 0; pass <= items.length; pass++) {
    let changed = false;
    items.forEach(({ id, task }, index) => {
      const cur = out.get(id)!;
      let start: number | undefined;
      if (!task.start) start = index > 0 ? out.get(items[index - 1]!.id)!.end : undefined;
      else if (AFTER.test(task.start)) {
        const ends = afterIds(task.start).map((d) => out.get(d)?.end);
        start = ends.every((e) => e !== undefined) && ends.length ? Math.max(...ends) : undefined;
      } else start = parseGanttDate(task.start, format);
      let end: number | undefined;
      const until = untilIds(task.end);
      if (until.length) {
        const starts = until.map((d) => out.get(d)?.start);
        end = starts.every((s) => s !== undefined) ? Math.min(...(starts as number[])) : undefined;
      } else if (start !== undefined && DURATION.test(task.end)) end = addDuration(start, task.end);
      else end = parseGanttDate(task.end, format);
      if (start !== cur.start || end !== cur.end) {
        out.set(id, { start, end });
        changed = true;
      }
    });
    if (!changed) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

function cleanName(text: string): string {
  return cleanText(text, /[:#;]/);
}

function cleanId(text: string): string {
  return text.trim().replace(/[^\w-]+/g, "_");
}

const spec: SectionsSpec<GanttStatement, GanttTask> = {
  isItem: (s): s is GanttTask => s.kind === "task",
  itemText: (t) => t.name,
  explicitId: (t) => t.id,
  fallbackId: "task",
  titleForbidden: /[#;]/,
  createItem(node, { indent, statements, model }) {
    const name = cleanName(node.label ?? node.id ?? "") || "New task";
    const data = node.data ?? {};
    const tags = Array.isArray(data.tags) ? data.tags.map(String).filter(isTag) : [];
    if (node.shape === "milestone" && !tags.includes("milestone")) tags.push("milestone");
    const id = typeof data.id === "string" && data.id.trim() ? cleanId(data.id) : undefined;
    if (id && model.itemById.has(id)) return null;
    let start = typeof data.start === "string" && data.start.trim() ? data.start.trim() : undefined;
    const end = typeof data.end === "string" && data.end.trim() ? data.end.trim() : "7d";
    // An explicit id needs the 3-part form, which needs a start.
    if (id && !start) start = defaultStart(statements, model);
    return { kind: "task", raw: "", indent, name, tags, id, start, end, suffix: "", dirty: true };
  },
  renameItem(task, label) {
    const name = cleanName(label);
    if (!name) return false;
    task.name = name;
    task.dirty = true;
    return true;
  },
};

function dateFormatOf(statements: GanttStatement[]): string {
  const c = statements.find((s): s is GanttConfig => s.kind === "config" && s.key === "dateFormat");
  return c?.value.trim() || DEFAULT_DATE_FORMAT;
}

function scheduleOf(
  statements: GanttStatement[],
  model: SectionsModel<GanttTask>,
): Map<string, Schedule> {
  return resolveSchedule(
    model.items.map((i) => ({ id: i.id, task: i.stmt })),
    dateFormatOf(statements),
  );
}

/** Earliest written/resolved start date, formatted (`2026-01-01` when there is none). */
function defaultStart(statements: GanttStatement[], model: SectionsModel<GanttTask>): string {
  const starts = [...scheduleOf(statements, model).values()]
    .map((s) => s.start)
    .filter((s): s is number => s !== undefined);
  return starts.length
    ? formatGanttDate(Math.min(...starts), dateFormatOf(statements))
    : "2026-01-01";
}

/** The resolved start of a task as a date in the diagram's format (fallback: earliest start). */
function startDateOf(
  id: string,
  statements: GanttStatement[],
  model: SectionsModel<GanttTask>,
): string {
  const start = scheduleOf(statements, model).get(id)?.start;
  return start !== undefined
    ? formatGanttDate(start, dateFormatOf(statements))
    : defaultStart(statements, model);
}

function dependencyEdges(model: SectionsModel<GanttTask>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const { stmt, id } of model.items) {
    for (const dep of afterIds(stmt.start)) {
      const edgeId = `L_${dep}_${id}_0`;
      if (!model.itemById.has(dep) || dep === id || seen.has(edgeId)) continue;
      seen.add(edgeId);
      edges.push({
        id: edgeId,
        source: dep,
        target: id,
        pattern: "solid",
        arrowStart: "none",
        arrowEnd: "arrow_point",
        length: 1,
        classes: [],
        styles: [],
        userDefinedId: false,
        data: { dependency: true },
      });
    }
  }
  return edges;
}

export const ganttGrammar: StatementGrammar<GanttStatement> = {
  family: "gantt",
  titleAsStatement: true,
  defaultIndent: "  ",
  joinLines: joinAccDescrBlocks,

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    const shared = parseSectionsLine(line, indent);
    if (shared) return shared;
    let m: RegExpExecArray | null;
    if ((m = CONFIG.exec(text))) {
      const key = GANTT_CONFIG_KEYS.find((k) => k.toLowerCase() === m![1]!.toLowerCase())!;
      return { kind: "config", raw: line, indent, key, value: m[2]!.trim() };
    }
    const colon = text.indexOf(":");
    if (!KEYWORD.test(text) && colon > 0) {
      const name = text.slice(0, colon).trim();
      const data = parseTaskData(text.slice(colon + 1));
      if (name && data) return { kind: "task", raw: line, indent, name, ...data };
    }
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    if (stmt.kind === "config") return `${stmt.indent}${stmt.key} ${stmt.value}`;
    if (stmt.kind === "task") {
      const parts = [...stmt.tags, stmt.id, stmt.start, stmt.end].filter(Boolean);
      return `${stmt.indent}${stmt.name} :${parts.join(", ")}${stmt.suffix}`;
    }
    return formatSectionsLine(stmt) ?? stmt.raw;
  },

  buildGraph(statements, ctx) {
    const model = buildSectionsModel(statements, spec);
    const schedule = scheduleOf(statements, model);
    const nodes: GraphNode[] = model.items.map(({ stmt, id, section }) => ({
      id,
      label: stmt.name,
      shape: stmt.tags.includes("milestone") ? "milestone" : "task",
      parentId: section?.id,
      classes: [],
      styles: [],
      data: {
        tags: stmt.tags,
        start: stmt.start,
        end: stmt.end,
        explicitId: !!stmt.id,
        details: [stmt.start, stmt.end].filter(Boolean),
        startTime: schedule.get(id)?.start,
        endTime: schedule.get(id)?.end,
      },
    }));
    const data: Record<string, unknown> = {};
    for (const key of GANTT_CONFIG_KEYS) data[key] = undefined;
    for (const s of statements) if (s.kind === "config") data[s.key] = s.value;
    const graph: DiagramGraph = {
      direction: "LR",
      nodes,
      edges: dependencyEdges(model),
      groups: sectionGroups(model),
      classDefs: {},
      title: sectionsTitle(statements) ?? ctx.frontmatterTitle,
      data,
    };
    return { graph };
  },

  interceptMeta: (op, ctx) => dragTask(op, ctx),

  edit(op, ctx) {
    const { statements } = ctx;
    return editSections(op, ctx, spec, (op, model) => {
      const task = (id: string) => model.itemById.get(id)?.stmt;
      /** Gives a task an explicit id (= its node id) so others can depend on it. */
      const ensureId = (id: string) => {
        const t = task(id)!;
        if (t.id) return;
        if (!t.start) t.start = startDateOf(id, statements, model);
        t.id = id;
        t.dirty = true;
      };
      /** Drops `dep` from `id`'s `after` list, pinning the start date when it empties. */
      const removeDependency = (dep: string, id: string): boolean => {
        const t = task(id);
        const deps = afterIds(t?.start);
        if (!t || !deps.includes(dep)) return false;
        const rest = deps.filter((d) => d !== dep);
        t.start = rest.length ? `after ${rest.join(" ")}` : startDateOf(id, statements, model);
        t.dirty = true;
        return true;
      };
      /** Whether `to` is reachable from `from` along dependency edges. */
      const reaches = (from: string, to: string): boolean => {
        const edges = dependencyEdges(model);
        const stack = [from];
        const seen = new Set<string>();
        while (stack.length) {
          const cur = stack.pop()!;
          if (cur === to) return true;
          if (seen.has(cur)) continue;
          seen.add(cur);
          for (const e of edges) if (e.source === cur) stack.push(e.target);
        }
        return false;
      };
      const addDependency = (dep: string, id: string): boolean => {
        const t = task(id);
        if (!t || !task(dep) || dep === id || reaches(id, dep)) return false;
        const deps = afterIds(t.start);
        if (deps.includes(dep)) return true;
        ensureId(dep);
        t.start = `after ${[...deps, dep].join(" ")}`;
        t.dirty = true;
        return true;
      };
      const edgeById = (edgeId: string) => dependencyEdges(model).find((e) => e.id === edgeId);

      switch (op.type) {
        case "removeNodes": {
          // Drop references to the removed tasks first; the shared code removes the lines.
          const removed = op.ids.filter((id) => model.itemById.has(id));
          for (const { id } of model.items) {
            if (removed.includes(id)) continue;
            for (const dep of afterIds(task(id)!.start))
              if (removed.includes(dep)) removeDependency(dep, id);
            const t = task(id)!;
            const until = untilIds(t.end);
            if (until.some((d) => removed.includes(d))) {
              const rest = until.filter((d) => !removed.includes(d));
              const end = scheduleOf(statements, model).get(id)?.end;
              t.end = rest.length
                ? `until ${rest.join(" ")}`
                : end !== undefined
                  ? formatGanttDate(end, dateFormatOf(statements))
                  : "1d";
              t.dirty = true;
            }
          }
          return undefined;
        }
        case "setNodeShape": {
          const t = task(op.id);
          if (!t || (op.shape !== "task" && op.shape !== "milestone")) return false;
          const has = t.tags.includes("milestone");
          if (has === (op.shape === "milestone")) return true;
          t.tags = has ? t.tags.filter((g) => g !== "milestone") : [...t.tags, "milestone"];
          t.dirty = true;
          return true;
        }
        case "setNodeData": {
          const t = task(op.id);
          if (!t) return false;
          let changed = false;
          const { start, end, tags, id } = op.data;
          if (Array.isArray(tags)) {
            t.tags = tags.map(String).filter((g, i, all) => isTag(g) && all.indexOf(g) === i);
            changed = true;
          }
          if (typeof end === "string") {
            t.end = cleanText(end, /[,#;]/) || "1d";
            changed = true;
          }
          if (typeof id === "string") {
            const next = id.trim() ? cleanId(id) : undefined;
            const referenced = model.items.some(
              (i) => afterIds(i.stmt.start).includes(op.id) || untilIds(i.stmt.end).includes(op.id),
            );
            if (next !== t.id) {
              if (!next && referenced) return false;
              if (next && model.itemById.has(next) && next !== op.id) return false;
              // Point dependants at the new id.
              if (next)
                for (const i of model.items) {
                  const deps = afterIds(i.stmt.start);
                  if (deps.includes(op.id)) {
                    i.stmt.start = `after ${deps.map((d) => (d === op.id ? next : d)).join(" ")}`;
                    i.stmt.dirty = true;
                  }
                  const until = untilIds(i.stmt.end);
                  if (until.includes(op.id)) {
                    i.stmt.end = `until ${until.map((d) => (d === op.id ? next : d)).join(" ")}`;
                    i.stmt.dirty = true;
                  }
                }
              if (next && !t.start) t.start = startDateOf(op.id, statements, model);
              t.id = next;
              changed = true;
            }
          }
          if (typeof start === "string") {
            const value = cleanText(start, /[,#;]/);
            t.start = value || (t.id ? startDateOf(op.id, statements, model) : undefined);
            changed = true;
          }
          if (changed) t.dirty = true;
          return changed;
        }
        case "addEdge":
          return addDependency(op.edge.source, op.edge.target);
        case "removeEdges": {
          let changed = false;
          for (const edgeId of op.ids) {
            const e = edgeById(edgeId);
            if (e && removeDependency(e.source, e.target)) changed = true;
          }
          return changed;
        }
        case "reconnectEdge": {
          const e = edgeById(op.id);
          if (!e) return false;
          if (e.source === op.source && e.target === op.target) return true;
          if (!task(op.source) || !task(op.target) || op.source === op.target) return false;
          if (e.target === op.target) {
            // Same dependant: swap the id in place.
            if (reaches(op.target, op.source)) return false;
            ensureId(op.source);
            const t = task(op.target)!;
            const deps = afterIds(t.start).map((d) => (d === e.source ? op.source : d));
            t.start = `after ${deps.filter((d, i) => deps.indexOf(d) === i).join(" ")}`;
            t.dirty = true;
            return true;
          }
          // Moving to another dependant: check the new link first so a refused
          // reconnect leaves the old dependency in place.
          if (afterIds(task(op.target)!.start).includes(op.source))
            return removeDependency(e.source, e.target);
          if (reaches(op.target, op.source)) return false;
          removeDependency(e.source, e.target);
          return addDependency(op.source, op.target);
        }
        case "setGraphData": {
          let changed = false;
          for (const key of GANTT_CONFIG_KEYS) {
            if (!(key in op.data)) continue;
            const raw = op.data[key];
            const value = raw === undefined || raw === null ? "" : cleanText(String(raw), /[#;]/);
            const idx = statements.findIndex((s) => s.kind === "config" && s.key === key);
            if (!value) {
              if (idx !== -1) statements.splice(idx, 1);
            } else if (idx !== -1) {
              const s = statements[idx] as GanttConfig;
              s.value = value;
              s.dirty = true;
            } else {
              let at = -1;
              statements.forEach((s, i) => {
                if (s.kind === "config") at = i;
              });
              if (at === -1) at = statements.findIndex((s) => s.kind === "title");
              const indent = (at !== -1 ? statements[at]!.indent : undefined) ?? ctx.indent;
              statements.splice(at + 1, 0, {
                kind: "config",
                raw: "",
                indent,
                key,
                value,
                dirty: true,
              });
            }
            changed = true;
          }
          return changed;
        }
        case "setEdgeLabel":
        case "setEdgeStyle":
        case "setEdgeData":
          return false;
        default:
          return undefined;
      }
    });
  },
};

export const ganttAdapter = createStatementAdapter(ganttGrammar);

// ---------------------------------------------------------------------------
// Direct manipulation
// ---------------------------------------------------------------------------

/**
 * Bars are positioned from their dates, so drags and resizes become date
 * edits instead of stored positions: dragging a bar sideways moves its start
 * (snapped to days; an explicit end date moves with it, a duration is kept,
 * an `after …` start is replaced by the date it was dropped on); dragging it
 * up or down moves the task line to that row, and so into that row's section;
 * resizing a bar sets its duration in days.
 */
function dragTask(op: EditOp, ctx: EditContext<GanttStatement>): boolean {
  if (op.type !== "moveNodes" && op.type !== "resizeNode") return false;
  const geo = ganttGeometry(ctx.doc.graph);
  const model = buildSectionsModel(ctx.statements, spec);
  const format = dateFormatOf(ctx.statements);
  if (op.type === "resizeNode") {
    const row = geo.rowById.get(op.id);
    const task = model.itemById.get(op.id)?.stmt;
    if (!row || !task || row.milestone || !op.size) return true;
    const days = Math.max(1, Math.round(op.size[0] / geo.pxPerDay));
    const endIsDate = parseGanttDate(task.end, format) !== undefined;
    const next =
      endIsDate && row.start !== undefined
        ? formatGanttDate(row.start + days * GEO_DAY_MS, format)
        : `${days}d`;
    if (next !== task.end) {
      task.end = next;
      task.dirty = true;
    }
    return true;
  }
  for (const { id, position } of op.moves) {
    const row = geo.rowById.get(id);
    const task = model.itemById.get(id)?.stmt;
    if (!row || !task) continue; // section bands are not moved
    const left = position[0] + (row.milestone ? GANTT_METRICS.milestoneSize / 2 : 0);
    const start = timeAtX(geo, left);
    if (row.start !== undefined && start !== row.start) {
      const delta = start - row.start;
      const end = parseGanttDate(task.end, format);
      task.start = formatGanttDate(start, format);
      if (end !== undefined) task.end = formatGanttDate(end + delta, format);
      task.dirty = true;
    }
    const from = geo.rows.indexOf(row);
    const to = rowAtY(geo, position[1] + row.height / 2);
    if (to !== from) {
      const anchor = model.itemById.get(geo.rows[to]!.id)?.stmt;
      if (!anchor) continue;
      ctx.statements.splice(ctx.statements.indexOf(task), 1);
      const at = ctx.statements.indexOf(anchor);
      ctx.statements.splice(to > from ? at + 1 : at, 0, task);
      if (task.indent !== anchor.indent) {
        task.indent = anchor.indent;
        task.dirty = true;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Mermaid's Gantt geometry (see {@link ganttGeometry}): a row per task, bars
 * on a shared time scale, sections as full-width bands with a label column on
 * the left. Positions always come from the dates and document order.
 */
registerFamilyLayout("gantt", (graph) => {
  const geo = ganttGeometry(graph);
  const positions: Record<string, Point> = {};
  const sizes: Record<string, Size> = {};
  for (const r of geo.rows) {
    positions[r.id] = [r.x, r.y];
    sizes[r.id] = { width: r.width, height: r.height };
  }
  for (const band of geo.bands) {
    if (!band.id) continue;
    positions[band.id] = [geo.chartX - GANTT_METRICS.labelWidth, band.y];
    sizes[band.id] = {
      width: GANTT_METRICS.labelWidth + geo.chartWidth + GANTT_METRICS.rightPadding,
      height: band.height,
    };
  }
  return { positions, sizes };
});

export { ganttGeometry, GANTT_METRICS, formatAxis } from "./geometry.js";
