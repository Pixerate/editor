import type { LayoutResult, Size } from "../layout-registry.js";
import type { DiagramGraph, GraphNode, Point, DiagramMeta } from "../types.js";

/**
 * `architecture-beta` geometry as Mermaid draws it, shared by the layout and
 * the canvas.
 *
 * Mermaid derives a spatial map from the edges' port sides (`a:R --> L:b`
 * puts `b` one cell to the right of `a`, `a:B --> T:b` one cell below) and
 * hands it to cytoscape's fcose layout as alignment and relative-placement
 * constraints. This module builds the same spatial map and turns it into a
 * grid deterministically: cells one icon plus the ideal edge length (120px)
 * apart, more where neighbours sit on either side of a group border; groups
 * wrap their members (labels included) with Mermaid's padding. Measured
 * against Mermaid's own output this puts every icon within a few pixels for
 * typical diagrams. Services are 80px icon squares with the label beneath;
 * junctions are points.
 *
 * @module
 */

export type ArchSide = "L" | "R" | "T" | "B";

/** Mermaid's `config.architecture` defaults plus the drawing constants of its renderer. */
export const ARCH_METRICS = {
  iconSize: 80,
  padding: 40,
  /** A group's frame around its members: the padding plus cytoscape's compound border, as Mermaid draws it. */
  groupPadding: 42.5,
  fontSize: 16,
  /** Service labels wrap at 1.5 × the icon size. */
  labelWidth: 120,
  lineHeight: 17.6,
  /** Gap between neighbouring icons (Mermaid's ideal edge length, 1.5 × the icon). */
  gap: 120,
  /** Junctions are invisible in Mermaid; the canvas draws a small point. */
  junctionSize: 12,
  arrowSize: 80 / 6,
  groupIconSize: 30,
  /** How far `{group}` edges extend past the service, to the group's border. */
  groupEdgeShift: 44,
} as const;

const A = ARCH_METRICS;

const SIDES = new Set<string>(["L", "R", "T", "B"]);
export const isSide = (v: unknown): v is ArchSide => typeof v === "string" && SIDES.has(v);
export const isHorizontal = (s: ArchSide) => s === "L" || s === "R";

/** React Flow handle position for a port side. */
export const SIDE_POSITION: Record<ArchSide, "left" | "right" | "top" | "bottom"> = {
  L: "left",
  R: "right",
  T: "top",
  B: "bottom",
};

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function charEm(ch: string): number {
  if (ch === " ") return 0.26;
  if (/[iljtfI.,:;'!|()[\]]/.test(ch)) return 0.3;
  if (/[mwMW@]/.test(ch)) return 0.86;
  if (/[A-Z]/.test(ch)) return 0.66;
  if (/[0-9]/.test(ch)) return 0.57;
  return 0.54;
}

export function archTextWidth(text: string, fontSize: number = A.fontSize): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * fontSize;
}

/** A service label wrapped as Mermaid wraps it (at 1.5 × the icon size). */
export function serviceLabelLines(label: string): string[] {
  const out: string[] = [];
  for (const para of label.split(/<br\s*\/?>|\n/i)) {
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (line && archTextWidth(next) > A.labelWidth) {
        out.push(line);
        line = w;
      } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

const isJunction = (n: GraphNode) => n.shape === "sm-circ" || !!n.data?.junction;

/** The area a node takes in the layout: its icon plus the label below it. */
function footprint(n: GraphNode): {
  width: number;
  height: number;
  box: { x: number; y: number; width: number; height: number };
} {
  if (isJunction(n)) {
    const off = (A.iconSize - A.junctionSize) / 2;
    return {
      width: A.iconSize,
      height: A.iconSize,
      box: { x: off, y: off, width: A.junctionSize, height: A.junctionSize },
    };
  }
  const lines = n.data?.untitled ? [] : serviceLabelLines(n.label ?? "");
  const labelW = Math.min(A.labelWidth, Math.max(0, ...lines.map((l) => archTextWidth(l))));
  const width = Math.max(A.iconSize, labelW);
  const height = A.iconSize + lines.length * A.lineHeight;
  return {
    width,
    height,
    box: { x: (width - A.iconSize) / 2, y: 0, width: A.iconSize, height: A.iconSize },
  };
}

// ---------------------------------------------------------------------------
// Spatial map
// ---------------------------------------------------------------------------

const VEC: Record<ArchSide, [number, number]> = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };

/**
 * Grid offset of an edge's target from its source (screen axes, y down):
 * the target sits in the direction the source port faces, and for a bend
 * (`a:R --> T:b`) also on the far side of its own port.
 */
export function sideOffset(source: ArchSide, target: ArchSide): [number, number] {
  const [sx, sy] = VEC[source];
  if (isHorizontal(source) === isHorizontal(target)) return [sx, sy];
  const [tx, ty] = VEC[target];
  return [sx - tx, sy - ty];
}

export interface ArchitectureLayout extends LayoutResult {
  /** The spatial map: grid cell of every service and junction (x right, y down). */
  cells: Map<string, Point>;
}

/**
 * Positions and sizes for every service, junction and group, as described
 * in the module docs; nodes the user dragged keep their stored positions and
 * groups are re-fitted around their members.
 */
export function architectureLayout(
  graph: DiagramGraph,
  meta: DiagramMeta = { v: 1 },
): ArchitectureLayout {
  const groupIds = new Set(graph.groups.map((g) => g.id));
  const parentById = new Map<string, string | undefined>();
  for (const n of graph.nodes)
    parentById.set(n.id, n.parentId && groupIds.has(n.parentId) ? n.parentId : undefined);
  for (const g of graph.groups)
    parentById.set(
      g.id,
      g.parentId && groupIds.has(g.parentId) && g.parentId !== g.id ? g.parentId : undefined,
    );
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    let p = parentById.get(id);
    while (p && !out.includes(p)) {
      out.push(p);
      p = parentById.get(p);
    }
    return out;
  };
  /** Group borders a line between two nodes crosses. */
  const borders = (a: string, b: string) => {
    const pa = ancestors(a);
    const pb = ancestors(b);
    const shared = pa.filter((g) => pb.includes(g)).length;
    return pa.length + pb.length - 2 * shared;
  };
  const prints = new Map(graph.nodes.map((n) => [n.id, footprint(n)]));
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  // The spatial map: breadth-first over each connected component, like Mermaid.
  const links = graph.edges.flatMap((e) => {
    const sa = e.data?.sourceSide;
    const sb = e.data?.targetSide;
    if (!isSide(sa) || !isSide(sb) || e.source === e.target) return [];
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) return [];
    return [{ a: e.source, b: e.target, offset: sideOffset(sa, sb) }];
  });
  const cells = new Map<string, Point>();
  let nextX = 0;
  for (const start of graph.nodes) {
    if (cells.has(start.id)) continue;
    const comp = new Map<string, Point>([[start.id, [0, 0]]]);
    const taken = new Set(["0,0"]);
    const queue = [start.id];
    while (queue.length) {
      const id = queue.shift()!;
      const [x, y] = comp.get(id)!;
      for (const l of links) {
        const forward = l.a === id;
        if (!forward && l.b !== id) continue;
        const other = forward ? l.b : l.a;
        if (comp.has(other)) continue;
        const sx = forward ? l.offset[0] : -l.offset[0];
        const sy = forward ? l.offset[1] : -l.offset[1];
        const step: Point = Math.abs(sx) >= Math.abs(sy) ? [Math.sign(sx), 0] : [0, Math.sign(sy)];
        let cell: Point = [x + sx, y + sy];
        while (taken.has(`${cell[0]},${cell[1]}`)) cell = [cell[0] + step[0], cell[1] + step[1]];
        comp.set(other, cell);
        taken.add(`${cell[0]},${cell[1]}`);
        queue.push(other);
      }
    }
    const xs = [...comp.values()].map((c) => c[0]);
    const ys = [...comp.values()].map((c) => c[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    for (const [id, [cx, cy]] of comp) cells.set(id, [cx - minX + nextX, cy - minY]);
    nextX += Math.max(...xs) - minX + 1;
  }

  // Cell centres: one icon plus Mermaid's ideal edge length apart, more where
  // the line between neighbours crosses group borders (their padding, and the
  // label of a node the border passes under).
  const labelOf = (id: string) => prints.get(id)!.height - A.iconSize;
  const axisCentres = (axis: 0 | 1) => {
    const keys = [...new Set([...cells.values()].map((c) => c[axis]))].sort((a, b) => a - b);
    const lines = new Map<number, [number, string][]>();
    for (const [id, c] of cells) {
      const line = c[1 - axis]!;
      const list = lines.get(line) ?? [];
      list.push([c[axis]!, id]);
      lines.set(line, list);
    }
    for (const list of lines.values()) list.sort((a, b) => a[0] - b[0]);
    const centre = new Map<number, number>();
    let prev: number | undefined;
    for (const k of keys) {
      let at = prev === undefined ? 0 : centre.get(prev)! + A.iconSize + A.gap;
      for (const list of lines.values()) {
        const i = list.findIndex(([key]) => key === k);
        if (i <= 0) continue;
        const [pk, pid] = list[i - 1]!;
        const id = list[i]![1];
        const crossed = borders(pid, id);
        // Leaving a group downwards passes under the label inside the frame.
        const leaves = ancestors(pid).some((g) => !ancestors(id).includes(g));
        const extra = crossed * A.groupPadding + (axis === 1 && leaves ? labelOf(pid) : 0);
        at = Math.max(at, centre.get(pk)! + A.iconSize + A.gap + extra);
      }
      centre.set(k, at);
      prev = k;
    }
    return centre;
  };
  const X = axisCentres(0);
  const Y = axisCentres(1);

  const stored = meta.layout ?? {};
  const positions: Record<string, Point> = {};
  const sizes: Record<string, Size> = {};
  /** Extent of each node's footprint (icon and label) and each group, for fitting groups. */
  const extents = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const n of graph.nodes) {
    const fp = prints.get(n.id)!;
    const [cx, cy] = cells.get(n.id)!;
    const box: Point = stored[n.id] ?? [
      X.get(cx)! - A.iconSize / 2 + (fp.box.x - (fp.width - A.iconSize) / 2),
      Y.get(cy)! - A.iconSize / 2 + fp.box.y,
    ];
    positions[n.id] = box;
    sizes[n.id] = { width: fp.box.width, height: fp.box.height };
    extents.set(n.id, {
      x: box[0] - fp.box.x,
      y: box[1] - fp.box.y,
      width: fp.width,
      height: fp.height,
    });
  }
  // Groups wrap their members (deepest first), Mermaid's compound sizing.
  let right = Math.max(0, ...[...extents.values()].map((e) => e.x + e.width));
  const depth = (id: string) => ancestors(id).length;
  for (const g of [...graph.groups].sort((a, b) => depth(b.id) - depth(a.id))) {
    const members = [...parentById.entries()]
      .filter(([id, p]) => p === g.id && extents.has(id))
      .map(([id]) => extents.get(id)!);
    let rect: { x: number; y: number; width: number; height: number };
    if (members.length) {
      const x1 = Math.min(...members.map((m) => m.x)) - A.groupPadding;
      const y1 = Math.min(...members.map((m) => m.y)) - A.groupPadding;
      const x2 = Math.max(...members.map((m) => m.x + m.width)) + A.groupPadding;
      const y2 = Math.max(...members.map((m) => m.y + m.height)) + A.groupPadding;
      rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    } else {
      // An empty group: Mermaid's padding around nothing, beside the diagram.
      const side = A.iconSize + 2 * A.groupPadding;
      const at = stored[g.id] ?? [right + A.gap, 0];
      if (!stored[g.id]) right += A.gap + side;
      rect = { x: at[0], y: at[1], width: side, height: side };
    }
    extents.set(g.id, rect);
    positions[g.id] = [rect.x, rect.y];
    sizes[g.id] = { width: rect.width, height: rect.height };
  }
  return { positions, sizes, cells };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export interface ArchEdgeRoute {
  points: { x: number; y: number }[];
  /** Where Mermaid puts the title: the middle of the line, or the bend. */
  label: { x: number; y: number };
  /** `X`: horizontal text, `Y`: rotated −90°, `XY`: rotated ±45° at the bend. */
  axis: "X" | "Y" | "XY";
  /** Rotation of the title, in degrees. */
  rotate: number;
}

/**
 * The orthogonal line between two ports: straight between aligned ports, an
 * L with one bend for a horizontal-to-vertical pair (Mermaid's `segments`
 * edge, bending at the source's axis), and a Z (or U, for same-side ports)
 * when the ends are no longer aligned after a drag.
 */
export function architectureEdgeRoute(
  s: { x: number; y: number },
  sourceSide: ArchSide,
  t: { x: number; y: number },
  targetSide: ArchSide,
): ArchEdgeRoute {
  const hs = isHorizontal(sourceSide);
  if (hs !== isHorizontal(targetSide)) {
    const corner = hs ? { x: t.x, y: s.y } : { x: s.x, y: t.y };
    const pair = `${sourceSide}${targetSide}`;
    const [fx, fy] =
      pair === "LT" || pair === "TL"
        ? [1, 1]
        : pair === "BL" || pair === "LB"
          ? [1, -1]
          : pair === "BR" || pair === "RB"
            ? [-1, -1]
            : [-1, 1];
    return { points: [s, corner, t], label: corner, axis: "XY", rotate: -fx * fy * 45 };
  }
  const axis = hs ? "X" : "Y";
  const rotate = hs ? 0 : -90;
  const aligned = hs ? Math.abs(s.y - t.y) < 0.5 : Math.abs(s.x - t.x) < 0.5;
  if (aligned)
    return { points: [s, t], label: { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 }, axis, rotate };
  const out = 30;
  const mid =
    sourceSide !== targetSide
      ? hs
        ? (s.x + t.x) / 2
        : (s.y + t.y) / 2
      : sourceSide === "R"
        ? Math.max(s.x, t.x) + out
        : sourceSide === "L"
          ? Math.min(s.x, t.x) - out
          : sourceSide === "B"
            ? Math.max(s.y, t.y) + out
            : Math.min(s.y, t.y) - out;
  const p1 = hs ? { x: mid, y: s.y } : { x: s.x, y: mid };
  const p2 = hs ? { x: mid, y: t.y } : { x: t.x, y: mid };
  return {
    points: [s, p1, p2, t],
    label: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
    axis,
    rotate,
  };
}

/** Mermaid's arrowhead at a port: a triangle pointing into the node, its tip 2px inside. */
export function architectureArrow(point: { x: number; y: number }, side: ArchSide): string {
  const s = A.arrowSize;
  const shapes: Record<ArchSide, [number, number][]> = {
    L: [
      [s, s / 2],
      [0, s],
      [0, 0],
    ],
    R: [
      [0, s / 2],
      [s, 0],
      [s, s],
    ],
    T: [
      [0, 0],
      [s, 0],
      [s / 2, s],
    ],
    B: [
      [s / 2, 0],
      [s, s],
      [0, s],
    ],
  };
  const dx = side === "L" ? point.x - s + 2 : side === "R" ? point.x - 2 : point.x - s / 2;
  const dy = side === "T" ? point.y - s + 2 : side === "B" ? point.y - 2 : point.y - s / 2;
  return shapes[side].map(([x, y]) => `${round(x + dx)},${round(y + dy)}`).join(" ");
}

/**
 * Moves an edge end from its port: `{group}` ends reach out to the group's
 * border (Mermaid's `padding + 4`, plus 18 below for the label), junction
 * ends meet at the junction's centre.
 */
export function shiftEndpoint(
  p: { x: number; y: number },
  side: ArchSide,
  opts: { group?: boolean; junction?: boolean },
): { x: number; y: number } {
  const [vx, vy] = VEC[side];
  if (opts.group) {
    const d = A.groupEdgeShift + (side === "B" ? 18 : 0);
    return { x: p.x + vx * d, y: p.y + vy * d };
  }
  if (opts.junction) {
    const d = A.junctionSize / 2;
    return { x: p.x - vx * d, y: p.y - vy * d };
  }
  return p;
}

const round = (n: number) => Math.round(n * 100) / 100;
