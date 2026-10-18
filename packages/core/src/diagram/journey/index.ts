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
import { journeyGeometry } from "./geometry.js";

/**
 * `journey` (user journey) adapter.
 *
 * ```
 * journey
 *   title Requesting a new laptop
 *   section Discover
 *     Find IT portal: 3: Employee
 *     Read policy: 2: Employee, IT
 * ```
 *
 * Canvas model: one node per task (shape `rect`, `data.score` 1–5,
 * `data.actors`), sections as groups and synthetic "next" edges between
 * consecutive tasks (not editable; the canvas does not draw them, as Mermaid
 * has no such arrows). Positions derive from the order of the tasks (see
 * `./geometry`): moving a task (`moveNodes`) reorders it, possibly into
 * another section, instead of storing a position. Task ids are slugs of the task names
 * (`Find IT portal` → `Find_IT_portal`), made unique with `_2`, `_3`….
 *
 * @module
 */

/** A task line: `Name: score: actor1, actor2`. */
export interface JourneyTask extends BaseStatement {
  kind: "task";
  name: string;
  score: number;
  actors: string[];
}

export type JourneyStatement = RawStatement | TitleStatement | SectionStatement | JourneyTask;

/** Lines Mermaid reads as keywords even though they contain a colon. */
const KEYWORD = /^(accTitle|accDescr|%%|#)/i;
const TASK = /^([^#:;]+?)\s*:\s*(\d+(?:\.\d+)?)\s*(?::([^#;]*))?$/;
/** Characters the journey lexer does not allow in names (`[^#:\n;]+`). */
const NAME_FORBIDDEN = /[#:;]/;

function clampScore(value: number): number {
  return Math.min(5, Math.max(1, Math.round(value)));
}

function details(score: number, actors: string[]): string[] {
  return [`Score ${score}`, actors.join(", ")].filter(Boolean);
}

function cleanActors(actors: unknown): string[] {
  if (!Array.isArray(actors)) return [];
  return actors
    .map((a) => cleanText(String(a), /[#:;,]/))
    .filter((a, i, all) => a && all.indexOf(a) === i);
}

const spec: SectionsSpec<JourneyStatement, JourneyTask> = {
  isItem: (s): s is JourneyTask => s.kind === "task",
  itemText: (t) => t.name,
  fallbackId: "task",
  sectionForbidden: NAME_FORBIDDEN,
  titleForbidden: /[#;]/,
  createItem(node, { indent }) {
    const name = cleanText(node.label ?? node.id ?? "", NAME_FORBIDDEN) || "New task";
    const score = typeof node.data?.score === "number" ? clampScore(node.data.score) : 3;
    return {
      kind: "task",
      raw: "",
      indent,
      name,
      score,
      actors: cleanActors(node.data?.actors),
      dirty: true,
    };
  },
  renameItem(task, label) {
    const name = cleanText(label, NAME_FORBIDDEN);
    if (!name) return false;
    task.name = name;
    task.dirty = true;
    return true;
  },
};

/** Dragging a task sideways moves it to the column it is dropped on. */
function reorderTasks(op: EditOp, ctx: EditContext<JourneyStatement>): boolean {
  if (op.type !== "moveNodes") return false;
  const geometry = journeyGeometry(ctx.doc.graph);
  let handled = false;
  for (const { id, position } of op.moves) {
    const task = geometry.tasks.get(id);
    if (!task) {
      // Section bars follow their tasks.
      if (geometry.sections.has(id)) handled = true;
      continue;
    }
    handled = true;
    const slot = sectionDropTarget(geometry.spans, id, position[0] + task.width / 2);
    if (slot) moveSectionItem(ctx, spec, id, slot);
  }
  return handled;
}

export const journeyGrammar: StatementGrammar<JourneyStatement> = {
  family: "journey",
  titleAsStatement: true,
  defaultIndent: "  ",
  joinLines: joinAccDescrBlocks,
  interceptMeta: reorderTasks,

  parseLine(line) {
    const indent = indentOf(line);
    const text = line.trim();
    const shared = parseSectionsLine(line, indent);
    if (shared) return shared;
    let m: RegExpExecArray | null;
    if (!KEYWORD.test(text) && (m = TASK.exec(text)))
      return {
        kind: "task",
        raw: line,
        indent,
        name: m[1]!.trim(),
        score: Number(m[2]),
        actors: (m[3] ?? "")
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
      };
    return { kind: "raw", raw: line, indent };
  },

  format(stmt) {
    if (stmt.kind === "task")
      return `${stmt.indent}${stmt.name}: ${stmt.score}${stmt.actors.length ? `: ${stmt.actors.join(", ")}` : ""}`;
    return formatSectionsLine(stmt) ?? stmt.raw;
  },

  buildGraph(statements, ctx) {
    const model = buildSectionsModel(statements, spec);
    const nodes: GraphNode[] = model.items.map(({ stmt, id, section }) => ({
      id,
      label: stmt.name,
      shape: "rect",
      parentId: section?.id,
      classes: [],
      styles: [],
      data: { score: stmt.score, actors: stmt.actors, details: details(stmt.score, stmt.actors) },
    }));
    const graph: DiagramGraph = {
      direction: "LR",
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
      const task = model.itemById.get(op.id)?.stmt;
      if (!task) return false;
      let changed = false;
      if (typeof op.data.score === "number" && Number.isFinite(op.data.score)) {
        task.score = clampScore(op.data.score);
        changed = true;
      }
      if (Array.isArray(op.data.actors)) {
        task.actors = cleanActors(op.data.actors);
        changed = true;
      }
      if (changed) task.dirty = true;
      return changed;
    });
  },
};

export const journeyAdapter = createStatementAdapter(journeyGrammar);

/**
 * Mermaid's geometry: tasks in one row (in document order) under their
 * section bars; stored positions are ignored.
 */
export const journeyLayout: FamilyLayout = (graph) => {
  const geometry = journeyGeometry(graph);
  const positions: Record<string, Point> = {};
  const sizes: Record<string, Size> = {};
  for (const box of [...geometry.tasks.values(), ...geometry.sections.values()]) {
    positions[box.id] = [box.x, box.y];
    sizes[box.id] = { width: box.width, height: box.height };
  }
  return { positions, sizes };
};

registerFamilyLayout("journey", journeyLayout);
