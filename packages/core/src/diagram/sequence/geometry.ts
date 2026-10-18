import type { DiagramGraph, GraphNode } from "../types.js";

/**
 * Geometry of a sequence diagram as Mermaid draws it: participants in a row
 * of equal-height boxes, a lifeline under each, and one row per message,
 * note or fragment boundary, top to bottom in document order. Shared by the
 * layout (participant boxes), the editor (dragging a participant reorders the
 * columns) and the React canvas (lifelines, message rows, notes, fragments
 * and activation bars), so all three agree.
 *
 * @module
 */

/** Ordered things that take vertical space, exposed as `graph.data.events`. */
export type SequenceEvent =
  | { kind: "message"; edgeId: string; from: string; to: string; mod: "" | "+" | "-" }
  | { kind: "note"; placement: "over" | "left" | "right"; targets: string[]; text: string }
  | { kind: "open"; keyword: string; text: string }
  | { kind: "else"; keyword: string; text: string }
  | { kind: "end" }
  | { kind: "activate" | "deactivate"; target: string };

/** Mermaid's sequence defaults (actor width 150, height 65, margin 50…), in canvas pixels. */
export const SEQUENCE_METRICS = {
  actorWidth: 150,
  actorHeight: 65,
  actorGap: 50,
  boxPad: 12,
  boxTitle: 26,
  firstRow: 34,
  messageRow: 46,
  selfMessageRow: 64,
  noteRow: 48,
  openRow: 36,
  elseRow: 32,
  endRow: 18,
  bottomGap: 24,
  activationWidth: 10,
} as const;

export interface SequenceColumn {
  id: string;
  x: number;
  width: number;
  center: number;
}

export interface SequenceMessageRow {
  edgeId: string;
  /** y of the arrow line. */
  y: number;
  self: boolean;
}

export interface SequenceNoteBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SequenceFragment {
  keyword: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `else` / `and` / `option` dividers. */
  dividers: { y: number; text: string }[];
  depth: number;
}

export interface SequenceActivation {
  participant: string;
  x: number;
  top: number;
  bottom: number;
}

export interface SequenceGeometry {
  columns: Map<string, SequenceColumn>;
  order: string[];
  messages: SequenceMessageRow[];
  notes: SequenceNoteBox[];
  fragments: SequenceFragment[];
  activations: SequenceActivation[];
  /** Box (group) frames, spanning the full height. */
  boxes: Map<string, { x: number; y: number; width: number; height: number }>;
  lifelineTop: number;
  lifelineBottom: number;
  /** Total width and height (bottom of the mirrored participants). */
  width: number;
  height: number;
}

/** Width Mermaid gives a participant: at least 150px, wider for long names. */
export function participantWidth(node: GraphNode): number {
  const longest = Math.max(
    ...String(node.label || node.id)
      .split(/<br\s*\/?>|\n/)
      .map((l) => l.length),
    1,
  );
  return Math.max(SEQUENCE_METRICS.actorWidth, Math.round(longest * 8.2 + 32));
}

function estimateTextWidth(text: string): number {
  return Math.round(text.length * 7.4 + 24);
}

export function sequenceGeometry(graph: DiagramGraph): SequenceGeometry {
  const M = SEQUENCE_METRICS;
  const columns = new Map<string, SequenceColumn>();
  const order: string[] = [];
  let x = 0;
  let prevBox: string | undefined;
  for (const n of graph.nodes) {
    if (n.parentId !== prevBox && (n.parentId || prevBox) && order.length) x += M.boxPad * 2;
    prevBox = n.parentId;
    const width = participantWidth(n);
    columns.set(n.id, { id: n.id, x, width, center: x + width / 2 });
    order.push(n.id);
    x += width + M.actorGap;
  }
  const width = Math.max(0, x - M.actorGap);
  const centerOf = (id: string) => columns.get(id)?.center ?? 0;

  const events: SequenceEvent[] =
    (graph.data?.events as SequenceEvent[] | undefined) ??
    graph.edges.map((e) => ({
      kind: "message" as const,
      edgeId: e.id,
      from: e.source,
      to: e.target,
      mod: "" as const,
    }));

  const messages: SequenceMessageRow[] = [];
  const notes: SequenceNoteBox[] = [];
  const fragments: SequenceFragment[] = [];
  const activations: SequenceActivation[] = [];
  const open: { frag: SequenceFragment; members: Set<string> }[] = [];
  const active = new Map<string, number[]>();

  const startActivation = (id: string, at: number) => {
    const stack = active.get(id) ?? [];
    stack.push(at);
    active.set(id, stack);
  };
  const endActivation = (id: string, at: number) => {
    const stack = active.get(id);
    const top = stack?.pop();
    if (top === undefined) return;
    const depth = stack!.length;
    activations.push({
      participant: id,
      x: centerOf(id) - M.activationWidth / 2 + depth * (M.activationWidth / 2),
      top,
      bottom: at,
    });
  };
  const touch = (...ids: string[]) => {
    for (const f of open) for (const id of ids) f.members.add(id);
  };

  let y = M.actorHeight + M.firstRow;
  for (const ev of events) {
    switch (ev.kind) {
      case "message": {
        const self = ev.from === ev.to;
        const rowHeight = self ? M.selfMessageRow : M.messageRow;
        const lineY = y + (self ? 26 : rowHeight - 14);
        messages.push({ edgeId: ev.edgeId, y: lineY, self });
        touch(ev.from, ev.to);
        if (ev.mod === "+") startActivation(ev.to, lineY);
        if (ev.mod === "-") endActivation(ev.from, lineY);
        y += rowHeight;
        break;
      }
      case "note": {
        const centers = ev.targets.map(centerOf);
        const textWidth = estimateTextWidth(ev.text);
        let left: number;
        let noteWidth: number;
        if (ev.placement === "over") {
          const min = Math.min(...centers);
          const max = Math.max(...centers);
          noteWidth = Math.max(textWidth, max - min + 50);
          left = (min + max) / 2 - noteWidth / 2;
        } else if (ev.placement === "left") {
          noteWidth = Math.max(textWidth, 100);
          left = centers[0]! - 12 - noteWidth;
        } else {
          noteWidth = Math.max(textWidth, 100);
          left = centers[0]! + 12;
        }
        notes.push({ text: ev.text, x: left, y: y + 6, width: noteWidth, height: M.noteRow - 12 });
        touch(...ev.targets);
        y += M.noteRow;
        break;
      }
      case "open": {
        const frag: SequenceFragment = {
          keyword: ev.keyword,
          text: ev.text,
          x: 0,
          y,
          width: 0,
          height: 0,
          dividers: [],
          depth: open.length,
        };
        open.push({ frag, members: new Set() });
        y += M.openRow;
        break;
      }
      case "else": {
        const top = open[open.length - 1];
        if (top) top.frag.dividers.push({ y: y + 4, text: ev.text });
        y += M.elseRow;
        break;
      }
      case "end": {
        const top = open.pop();
        if (top) {
          const members = top.members.size ? [...top.members] : order;
          const xs = members.map(centerOf);
          const pad = 24 + (open.length + 1) * 6;
          top.frag.x = Math.min(...xs) - pad - top.frag.depth * 6;
          top.frag.width = Math.max(...xs) - Math.min(...xs) + pad * 2 + top.frag.depth * 12;
          top.frag.width = Math.max(top.frag.width, 160);
          top.frag.height = y + 6 - top.frag.y;
          fragments.push(top.frag);
          // Parent fragments span their children's participants too.
          for (const f of open) for (const id of top.members) f.members.add(id);
        }
        y += M.endRow;
        break;
      }
      case "activate":
        startActivation(ev.target, y);
        break;
      case "deactivate":
        endActivation(ev.target, y);
        break;
    }
  }
  const lifelineBottom = y + M.bottomGap;
  for (const [id, stack] of active)
    while (stack.length) {
      const top = stack.pop()!;
      activations.push({
        participant: id,
        x: centerOf(id) - M.activationWidth / 2 + stack.length * (M.activationWidth / 2),
        top,
        bottom: lifelineBottom,
      });
    }

  const height = lifelineBottom + M.actorHeight;
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const g of graph.groups) {
    const cols = graph.nodes.filter((n) => n.parentId === g.id).map((n) => columns.get(n.id)!);
    if (!cols.length) {
      boxes.set(g.id, { x: width + M.actorGap, y: -M.boxTitle - M.boxPad, width: 200, height });
      continue;
    }
    const minX = Math.min(...cols.map((c) => c.x));
    const maxX = Math.max(...cols.map((c) => c.x + c.width));
    boxes.set(g.id, {
      x: minX - M.boxPad,
      y: -M.boxTitle - M.boxPad,
      width: maxX - minX + M.boxPad * 2,
      height: height + M.boxTitle + M.boxPad * 2,
    });
  }

  return {
    columns,
    order,
    messages,
    notes,
    fragments,
    activations,
    boxes,
    lifelineTop: M.actorHeight,
    lifelineBottom,
    width,
    height,
  };
}

/** Index in `order` that a participant dropped with its box centre at `x` moves to. */
export function dropIndex(geometry: SequenceGeometry, id: string, centerX: number): number {
  const others = geometry.order.filter((o) => o !== id);
  let index = 0;
  for (const o of others) if (geometry.columns.get(o)!.center < centerX) index++;
  return index;
}
