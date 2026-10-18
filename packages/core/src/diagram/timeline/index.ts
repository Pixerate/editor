import type { DiagramGraph, EditOp, GraphNode, Point } from "../types.js";
import { registerFamilyLayout, type FamilyLayout, type Size } from "../layout-registry.js";
import {
  createStatementAdapter,
  indentOf,
  type BaseStatement,
  type EditContext,
  type StatementGrammar,
} from "../statements/base.js";
import {
  buildSectionsModel,
  cleanText,
  editSections,
  formatSectionsLine,
  joinAccDescrBlocks,
  moveSectionItem,
  parseSectionsLine,
  sectionDropTarget,
  sectionGroups,
  sectionsTitle,
  sequenceEdges,
  type RawStatement,
  type SectionStatement,
  type SectionsSpec,
  type TitleStatement,
} from "../statements/sections.js";
import { timelineGeometry } from "./geometry.js";

/**
 * `timeline` adapter.
 *
 * ```
 * timeline
 *   title Platform milestones
 *   2024 : Unified portal launched
 *        : Design system v1
 *   section Later
 *   2025 : AI chat assistant : Generative forms
 * ```
 *
 * Canvas model: one node per period (shape `rounded`, `data.events`),
 * sections as groups and synthetic "next" edges between consecutive periods
 * (not editable; the canvas does not draw them, as Mermaid has no such
 * arrows). Positions derive from the order of the periods (see
 * `./geometry`): moving a period (`moveNodes`) reorders it, possibly into
 * another section, instead of storing a position. A period line and the continuation lines that follow it
 * directly (`     : more`) form ONE statement whose `raw` keeps the original
 * line breaks; when edited it is re-emitted with the colons aligned under the
 * period's colon. Period ids are slugs of the period text (`2024` → `2024`).
 *
 * @module
 */

/** A period with its events (possibly spanning several physical lines). */
export interface TimelinePeriod extends BaseStatement {
  kind: "period";
  period: string;
  events: string[];
}

export type TimelineStatement = RawStatement | TitleStatement | SectionStatement | TimelinePeriod;

/** Keywords and comments that are never periods. */
const NOT_PERIOD = /^(title\b|section\b|accTitle\b|accDescr\b|%%|#|:)/i;
/** A continuation line: `: event`. */
const CONTINUATION = /^\s*:\s/;
/** The timeline lexer reads periods as `[^#:\n]+`. */
const PERIOD_FORBIDDEN = /[#:]/;

function isPeriodLine(line: string): boolean {
  const text = line.trim();
  return !!text && !NOT_PERIOD.test(text);
}

/** Splits `: a : b` into events; `null` when the text is not an event list. */
function splitEvents(text: string): string[] | null {
  if (!text.trim()) return [];
  if (!/^:\s/.test(text) && text.trim() !== ":") return null;
  return text
    .split(/:(?=\s|$)/)
    .slice(1)
    .map((e) => e.trim())
    .filter(Boolean);
}

/** An event may not contain `:` followed by whitespace (it would start a new event). */
function cleanEvent(event: string): string {
  return cleanText(event.replace(/:(?=\s|$)/g, " -"));
}

function cleanEvents(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  return events
    .flatMap((e) => String(e).split(/\r?\n/))
    .map(cleanEvent)
    .filter(Boolean);
}

const spec: SectionsSpec<TimelineStatement, TimelinePeriod> = {
  isItem: (s): s is TimelinePeriod => s.kind === "period",
  itemText: (p) => p.period,
  fallbackId: "period",
  sectionForbidden: /:/,
  createItem(node, { indent }) {
    const period = cleanText(node.label ?? node.id ?? "", PERIOD_FORBIDDEN) || "New period";
    const events = node.data?.events !== undefined ? cleanEvents(node.data.events) : ["Event"];
    return { kind: "period", raw: "", indent, period, events, dirty: true };
  },
  renameItem(p, label) {
    const period = cleanText(label, PERIOD_FORBIDDEN);
    if (!period) return false;
    p.period = period;
    p.dirty = true;
    return true;
  },
};

/** Dragging a period sideways moves it to the column it is dropped on. */
function reorderPeriods(op: EditOp, ctx: EditContext<TimelineStatement>): boolean {
  if (op.type !== "moveNodes") return false;
  const geometry = timelineGeometry(ctx.doc.graph);
  let handled = false;
  for (const { id, position } of op.moves) {
    const period = geometry.periods.get(id);
    if (!period) {
      // Section headers follow their periods.
      if (geometry.sections.has(id)) handled = true;
      continue;
    }
    handled = true;
    const slot = sectionDropTarget(geometry.spans, id, position[0] + period.width / 2);
    if (slot) moveSectionItem(ctx, spec, id, slot);
  }
  return handled;
}

export const timelineGrammar: StatementGrammar<TimelineStatement> = {
  family: "timeline",
  titleAsStatement: true,
  defaultIndent: "  ",
  interceptMeta: reorderPeriods,

  /** A period line absorbs the continuation lines (`: event`) right after it. */
  joinLines(lines) {
    const out: string[] = [];
    let open = false;
    for (const line of joinAccDescrBlocks(lines)) {
      if (open && CONTINUATION.test(line)) {
        out[out.length - 1] += `\n${line}`;
        continue;
      }
      open = !line.includes("\n") && isPeriodLine(line);
      out.push(line);
    }
    return out;
  },

  parseLine(line) {
    const indent = indentOf(line);
    const shared = parseSectionsLine(line, indent);
    if (shared) return shared;
    const [first, ...rest] = line.split("\n");
    if (isPeriodLine(first!)) {
      const text = first!.trim();
      const colon = text.indexOf(":");
      const period = (colon === -1 ? text : text.slice(0, colon)).trim();
      const events = splitEvents(colon === -1 ? "" : text.slice(colon));
      const more = rest.map((l) => splitEvents(l.trim()));
      if (period && events && more.every(Boolean))
        return {
          kind: "period",
          raw: line,
          indent,
          period,
          events: [...events, ...more.flatMap((e) => e!)],
        };
    }
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    if (stmt.kind !== "period") return formatSectionsLine(stmt) ?? stmt.raw;
    const [first, ...rest] = stmt.events;
    if (first === undefined) return `${stmt.indent}${stmt.period}`;
    const pad = `${stmt.indent}${" ".repeat(stmt.period.length)}`;
    return [`${stmt.indent}${stmt.period} : ${first}`, ...rest.map((e) => `${pad} : ${e}`)].join(
      "\n",
    );
  },

  buildGraph(statements, ctx) {
    const model = buildSectionsModel(statements, spec);
    const nodes: GraphNode[] = model.items.map(({ stmt, id, section }) => ({
      id,
      label: stmt.period,
      shape: "rounded",
      parentId: section?.id,
      classes: [],
      styles: [],
      data: { events: stmt.events, details: stmt.events },
    }));
    const graph: DiagramGraph = {
      direction: /\bTD\b/i.test(ctx.header) ? "TB" : "LR",
      nodes,
      edges: sequenceEdges(model),
      groups: sectionGroups(model),
      classDefs: {},
      title: sectionsTitle(statements) ?? ctx.frontmatterTitle,
    };
    return { graph };
  },

  edit(op, ctx) {
    return editSections(op, ctx, spec, (op, model) => {
      if (op.type !== "setNodeData") return undefined;
      const period = model.itemById.get(op.id)?.stmt;
      if (!period || !Array.isArray(op.data.events)) return false;
      period.events = cleanEvents(op.data.events);
      period.dirty = true;
      return true;
    });
  },
};

export const timelineAdapter = createStatementAdapter(timelineGrammar);

/**
 * Mermaid's geometry: periods in one row (in document order) under their
 * section headers; stored positions are ignored.
 */
export const timelineLayout: FamilyLayout = (graph) => {
  const geometry = timelineGeometry(graph);
  const positions: Record<string, Point> = {};
  const sizes: Record<string, Size> = {};
  for (const box of [...geometry.periods.values(), ...geometry.sections.values()]) {
    positions[box.id] = [box.x, box.y];
    sizes[box.id] = { width: box.width, height: box.height };
  }
  return { positions, sizes };
};

registerFamilyLayout("timeline", timelineLayout);
