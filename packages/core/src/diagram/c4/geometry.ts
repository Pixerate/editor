import type { LayoutResult, Size } from "../layout-registry.js";
import type { DiagramGraph, GraphGroup, GraphNode, Point, DiagramMeta } from "../types.js";

/**
 * C4 geometry as Mermaid draws it, shared by the layout (positions), the
 * canvas (shapes and text placement) and the relation renderer.
 *
 * Mermaid lays C4 elements out in rows inside each boundary (four per row by
 * default, `UpdateLayoutConfig` changes it), nested boundaries below their
 * parent's elements (two per row), with 50px margins; every element is 216px
 * wide and as tall as its text. The shapes are Mermaid's unified ones:
 * `person` (a head over a rounded body), rounded rectangles for systems,
 * containers and components, `cylinder` for `*Db` and a horizontal
 * cylinder for `*Queue`. The text is a bold name, a `[Type: technology]`
 * line and the description, each wrapped to the shape's width.
 *
 * Text sizes are estimated (no DOM): close to Mermaid's for the default
 * "Open Sans" font, so the canvas has the same rows, gaps and proportions.
 *
 * @module
 */

/** Mermaid's C4 defaults (`config.c4`). */
export const C4_METRICS = {
  shapeMargin: 50,
  shapePadding: 20,
  width: 216,
  diagramMarginX: 50,
  diagramMarginY: 10,
  shapeInRow: 4,
  boundaryInRow: 2,
  nextLinePaddingX: 0,
  /** Element name size; the type line is 0.75em of it, the description 0.82em. */
  fontSize: 14,
  boundaryFontSize: 14,
  messageFontSize: 12,
  /** Gap between the name, type and description blocks. */
  sectionGap: 3,
  lineHeight: 1.15,
  /** Mermaid wraps against `screen.availWidth`; used when there is no screen. */
  screenWidth: 1920,
  /** Size given to a boundary with nothing in it (Mermaid draws it 0×0). */
  emptyBoundary: { width: 216, height: 100 },
} as const;

const M = C4_METRICS;

// ---------------------------------------------------------------------------
// Text estimates
// ---------------------------------------------------------------------------

/** Approximate advance of one character, in em, for a humanist sans (Open Sans). */
function charEm(ch: string): number {
  if (ch === " ") return 0.26;
  if (/[iljtfI.,:;'!|()[\]]/.test(ch)) return 0.3;
  if (/[mwMW@]/.test(ch)) return 0.86;
  if (/[A-Z]/.test(ch)) return 0.66;
  if (/[0-9]/.test(ch)) return 0.57;
  return 0.54;
}

/** Estimated rendered width of a single line of text. */
export function textWidth(text: string, fontSize: number, bold = false): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * fontSize * 0.97 * (bold ? 1.06 : 1);
}

/** Greedy word wrap of `text` (with `<br>` / newline breaks) at `maxWidth`. */
export function wrapText(text: string, maxWidth: number, fontSize: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of text.split(/<br\s*\/?>|\n/i)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && textWidth(next, fontSize, bold) > maxWidth) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

const lineHeightOf = (fontSize: number) => fontSize * M.lineHeight;

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

export type C4Base = "person" | "system" | "container" | "component";
export type C4ShapeKind = "person" | "rounded" | "cylinder" | "h-cyl";

/** Mermaid's element type (`external_container_db`…) for an element keyword. */
export interface C4ElementType {
  base: C4Base;
  variant: "" | "db" | "queue";
  external: boolean;
  /** `person`, `external_system_db`…, as Mermaid's `typeC4Shape`. */
  type: string;
}

const KEYWORD = /^(Person|System|Container|Component)(Db|Queue)?(_Ext)?$/;
const STEREOTYPE: Record<C4Base, string> = {
  person: "Person",
  system: "Software System",
  container: "Container",
  component: "Component",
};

export function c4ElementType(node: GraphNode): C4ElementType {
  const m = KEYWORD.exec(String(node.data?.kind ?? ""));
  const base = (m?.[1]?.toLowerCase() as C4Base | undefined) ?? fromShape(node.shape);
  const variant =
    (m?.[2]?.toLowerCase() as "db" | "queue" | undefined) ??
    (node.shape === "c4-db" ? "db" : node.shape === "c4-queue" ? "queue" : "");
  const external = m ? !!m[3] : /-ext$/.test(node.shape ?? "");
  const type = `${external ? "external_" : ""}${base}${variant ? `_${variant}` : ""}`;
  return { base, variant, external, type };
}

function fromShape(shape: string | undefined): C4Base {
  const m = /^c4-(person|system|container|component)/.exec(shape ?? "");
  return (m?.[1] as C4Base | undefined) ?? "container";
}

/** Which of the element's text parts a section shows (and edits). */
export type C4TextPart = "label" | "tech" | "descr";

export interface C4TextSection {
  part: C4TextPart;
  /** The text shown (the type line is `[Container: tech]`). */
  text: string;
  lines: string[];
  fontSize: number;
  bold: boolean;
  height: number;
}

export interface C4ElementGeometry {
  type: C4ElementType;
  shape: C4ShapeKind;
  width: number;
  height: number;
  /** Width the text wraps at. */
  wrapWidth: number;
  sections: C4TextSection[];
  textHeight: number;
  /** Centre of the text block, relative to the element's top-left. */
  textCenter: { x: number; y: number };
  /** Person: head radius, where the body starts and its corner radius. */
  person?: { headRadius: number; bodyTop: number; bodyRadius: number };
  /** Cylinders: the end-cap ellipse radii (`rx` along the axis for `h-cyl`). */
  cylinder?: { rx: number; ry: number };
}

/** The `[Type]` / `[Type: technology]` line Mermaid prints under the name. */
export function c4Stereotype(type: C4ElementType, tech?: string): string {
  const name = STEREOTYPE[type.base];
  return tech ? `[${name}: ${tech}]` : `[${name}]`;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Size, shape and text layout of one element, as Mermaid computes them. */
export function c4ElementGeometry(node: GraphNode): C4ElementGeometry {
  const type = c4ElementType(node);
  const shape: C4ShapeKind =
    type.base === "person"
      ? "person"
      : type.variant === "db"
        ? "cylinder"
        : type.variant === "queue"
          ? "h-cyl"
          : "rounded";
  const pad = M.shapePadding;
  // Each shape handler narrows the width before the label is wrapped.
  const wrapWidth =
    shape === "cylinder"
      ? M.width - pad - 2 * pad
      : shape === "h-cyl"
        ? M.width - pad / 2 - 2 * pad
        : M.width - 2 * pad;
  const tech = str(node.data?.tech);
  const descr = str(node.data?.descr);
  const parts: [C4TextPart, string, number, boolean][] = [
    ["label", node.label ?? "", M.fontSize, true],
    ["tech", c4Stereotype(type, tech), M.fontSize * 0.75, false],
  ];
  if (descr) parts.push(["descr", descr, M.fontSize * 0.82, false]);
  const sections: C4TextSection[] = parts
    .filter(([, text]) => text)
    .map(([part, text, fontSize, bold]) => {
      // Mermaid measures for wrapping before the name turns bold.
      const lines = wrapText(text, wrapWidth, fontSize);
      return { part, text, lines, fontSize, bold, height: lines.length * lineHeightOf(fontSize) };
    });
  const textWidthMax = Math.max(
    0,
    ...sections.flatMap((s) => s.lines.map((l) => textWidth(l, s.fontSize, s.bold))),
  );
  const textHeight =
    sections.reduce((h, s) => h + s.height, 0) + M.sectionGap * Math.max(0, sections.length - 1);

  // A line that did not wrap (measured narrower than it renders) widens the shape.
  let width: number =
    shape === "cylinder"
      ? Math.max(M.width - pad, textWidthMax) + pad
      : shape === "h-cyl"
        ? Math.max(M.width - pad / 2, textWidthMax)
        : Math.max(M.width, textWidthMax + 2 * pad);
  let height: number;
  let textCenter: { x: number; y: number };
  let person: C4ElementGeometry["person"];
  let cylinder: C4ElementGeometry["cylinder"];
  switch (shape) {
    case "person": {
      const headRadius = Math.min(Math.max(width * 0.23, 16), 56);
      const overlap = headRadius * 0.27;
      const bodyHeight = textHeight + pad * 2;
      const bodyRadius = Math.min(width * 0.177, bodyHeight * 0.45);
      const bodyTop = 2 * headRadius - overlap;
      height = bodyTop + bodyHeight;
      person = { headRadius, bodyTop, bodyRadius };
      textCenter = { x: width / 2, y: bodyTop + bodyHeight / 2 };
      break;
    }
    case "cylinder": {
      const rx = width / 2;
      const ry = rx / (2.5 + width / 50);
      const body = textHeight + pad + ry;
      height = body + 2 * ry;
      cylinder = { rx, ry };
      textCenter = { x: width / 2, y: height / 2 + pad / 1.5 };
      break;
    }
    case "h-cyl": {
      const h = textHeight + pad / 2;
      const ry = h / 2;
      const rx = ry / (2.5 + h / 50);
      const body = width + pad / 2 + rx;
      width = body + 2 * rx;
      height = h;
      cylinder = { rx, ry };
      textCenter = { x: body / 2, y: h / 2 };
      break;
    }
    default:
      height = textHeight + pad * 2;
      textCenter = { x: width / 2, y: height / 2 };
  }
  return {
    type,
    shape,
    width,
    height,
    wrapWidth,
    sections,
    textHeight,
    textCenter,
    person,
    cylinder,
  };
}

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

export interface C4BoundaryText {
  label: string;
  /** `[system]`, `[node]`… (Mermaid's default type per boundary keyword). */
  type: string;
  descr?: string;
  /** Centre lines of the label, type and description, from the boundary's top. */
  labelY: number;
  typeY: number;
  descrY?: number;
  /** Height the texts take above the boundary (Mermaid's `Y`). */
  height: number;
  /** Deployment nodes are drawn with a solid border. */
  solid: boolean;
}

const BOUNDARY_TYPE: Record<string, string> = {
  Enterprise_Boundary: "ENTERPRISE",
  System_Boundary: "SYSTEM",
  Container_Boundary: "CONTAINER",
  Boundary: "system",
  Node: "node",
  Node_L: "node",
  Node_R: "node",
  Deployment_Node: "node",
};

export function c4BoundaryText(group: Pick<GraphGroup, "label" | "data">): C4BoundaryText {
  const kind = String(group.data?.kind ?? "System_Boundary");
  const typeText = str(group.data?.type) ?? BOUNDARY_TYPE[kind] ?? "system";
  const descr = str(group.data?.descr);
  return boundaryText(group.label, typeText, descr, /^(Node|Deployment_Node)/.test(kind));
}

function boundaryText(label: string, type: string, descr: string | undefined, solid: boolean) {
  const labelH = lineHeightOf(M.boundaryFontSize + 2);
  const typeH = lineHeightOf(M.boundaryFontSize);
  const labelY = 8;
  const typeY = labelY + labelH + 5;
  let height = typeY + typeH;
  let descrY: number | undefined;
  if (descr) {
    descrY = height + 20;
    height = descrY + lineHeightOf(M.boundaryFontSize - 2);
  }
  return { label, type: `[${type}]`, descr, labelY, typeY, descrY, height, solid };
}

// ---------------------------------------------------------------------------
// Layout (Mermaid's c4Renderer `Bounds` algorithm)
// ---------------------------------------------------------------------------

interface Extent {
  startx?: number;
  stopx?: number;
  starty?: number;
  stopy?: number;
}

class Bounds {
  data: Extent & { widthLimit: number } = { widthLimit: 0 };
  next: Extent & { cnt: number } = { cnt: 0 };
  constructor(private readonly shapeInRow: number) {}
  setData(startx: number, stopx: number, starty: number, stopy: number) {
    this.next.startx = this.data.startx = startx;
    this.next.stopx = this.data.stopx = stopx;
    this.next.starty = this.data.starty = starty;
    this.next.stopy = this.data.stopy = stopy;
  }
  private update(
    obj: Extent,
    key: keyof Extent,
    val: number,
    fn: (a: number, b: number) => number,
  ) {
    const cur = obj[key];
    obj[key] = cur === undefined ? val : fn(val, cur);
  }
  insert(box: { x: number; y: number; width: number; height: number }) {
    const margin = M.shapeMargin;
    this.next.cnt += 1;
    let startx =
      this.next.startx === this.next.stopx
        ? this.next.stopx! + margin
        : this.next.stopx! + margin * 2;
    let stopx = startx + box.width;
    let starty = this.next.starty! + margin * 2;
    let stopy = starty + box.height;
    if (
      startx >= this.data.widthLimit ||
      stopx >= this.data.widthLimit ||
      this.next.cnt > this.shapeInRow
    ) {
      startx = this.next.startx! + margin + M.nextLinePaddingX;
      starty = this.next.stopy! + margin * 2;
      this.next.stopx = stopx = startx + box.width;
      this.next.starty = this.next.stopy;
      this.next.stopy = stopy = starty + box.height;
      this.next.cnt = 1;
    }
    box.x = startx;
    box.y = starty;
    for (const o of [this.data, this.next]) {
      this.update(o, "startx", startx, Math.min);
      this.update(o, "starty", starty, Math.min);
      this.update(o, "stopx", stopx, Math.max);
      this.update(o, "stopy", stopy, Math.max);
    }
  }
  bumpLastMargin(margin: number) {
    this.data.stopx! += margin;
    this.data.stopy! += margin;
  }
}

export interface C4Layout extends LayoutResult {
  elements: Map<string, C4ElementGeometry>;
  boundaries: Map<string, C4BoundaryText>;
}

export interface C4LayoutOptions {
  /** Mermaid wraps rows against the screen width (`screen.availWidth`). */
  screenWidth?: number;
}

function screenWidth(): number {
  const avail =
    typeof screen !== "undefined" ? (screen as { availWidth?: number }).availWidth : undefined;
  return avail && avail > 0 ? avail : M.screenWidth;
}

/**
 * Element and boundary boxes as Mermaid's C4 renderer computes them, then
 * stored positions (elements the user dragged) on top; boundaries that
 * contain a moved element are re-fitted around their content with Mermaid's
 * margins.
 */
export function c4Layout(
  graph: DiagramGraph,
  meta: DiagramMeta = { v: 1 },
  options: C4LayoutOptions = {},
): C4Layout {
  const shapeInRow = Number(graph.data?.c4ShapeInRow) || M.shapeInRow;
  const boundaryInRow = Number(graph.data?.c4BoundaryInRow) || M.boundaryInRow;
  const elements = new Map(graph.nodes.map((n) => [n.id, c4ElementGeometry(n)]));
  const texts = new Map(graph.groups.map((g) => [g.id, c4BoundaryText(g)]));
  const groupIds = new Set(graph.groups.map((g) => g.id));
  const parentOf = (p: string | undefined) => (p && groupIds.has(p) ? p : undefined);
  const elementsIn = new Map<string | undefined, GraphNode[]>();
  const boundariesIn = new Map<string | undefined, GraphGroup[]>();
  for (const n of graph.nodes) push(elementsIn, parentOf(n.parentId), n);
  for (const g of graph.groups) push(boundariesIn, parentOf(g.parentId), g);

  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const rects = new Map<string, { x: number; y: number; width: number; height: number }>();
  const global = boundaryText("global", "global", undefined, false);

  const drawInside = (parent: Bounds, list: (GraphGroup | null)[]) => {
    const current = new Bounds(shapeInRow);
    current.data.widthLimit = parent.data.widthLimit / Math.min(boundaryInRow, list.length);
    list.forEach((boundary, i) => {
      const alias = boundary?.id;
      const Y = boundary ? texts.get(boundary.id)!.height : global.height;
      if (i === 0 || i % boundaryInRow === 0) {
        const x = parent.data.startx! + M.diagramMarginX;
        const y = parent.data.stopy! + M.diagramMarginY + Y;
        current.setData(x, x, y, y);
      } else {
        const x =
          current.data.stopx !== current.data.startx
            ? current.data.stopx! + M.diagramMarginX
            : current.data.startx!;
        const y = current.data.starty!;
        current.setData(x, x, y, y);
      }
      const shapes = elementsIn.get(alias) ?? [];
      for (const n of shapes) {
        const g = elements.get(n.id)!;
        const box = { x: 0, y: 0, width: g.width, height: g.height };
        current.insert(box);
        boxes.set(n.id, box);
      }
      if (shapes.length) current.bumpLastMargin(M.shapeMargin);
      const nested = boundariesIn.get(alias) ?? [];
      if (nested.length) drawInside(current, nested);
      if (boundary)
        rects.set(boundary.id, {
          x: current.data.startx!,
          y: current.data.starty!,
          width: current.data.stopx! - current.data.startx!,
          height: current.data.stopy! - current.data.starty!,
        });
      parent.data.stopy = Math.max(current.data.stopy! + M.shapeMargin, parent.data.stopy!);
      parent.data.stopx = Math.max(current.data.stopx! + M.shapeMargin, parent.data.stopx!);
    });
  };
  const screenBounds = new Bounds(shapeInRow);
  screenBounds.setData(M.diagramMarginX, M.diagramMarginX, M.diagramMarginY, M.diagramMarginY);
  screenBounds.data.widthLimit = options.screenWidth ?? screenWidth();
  drawInside(screenBounds, [null]);

  // Stored positions win; boundaries around moved content are re-fitted.
  const stored = meta.layout ?? {};
  const moved = new Set<string>();
  for (const [id, box] of boxes) {
    const p = stored[id];
    if (!p) continue;
    box.x = p[0];
    box.y = p[1];
    moved.add(id);
  }
  const depth = (g: GraphGroup): number => {
    let d = 0;
    let p = parentOf(g.parentId);
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      d++;
      p = parentOf(graph.groups.find((x) => x.id === p)?.parentId);
    }
    return d;
  };
  const deepestFirst = [...graph.groups].sort((a, b) => depth(b) - depth(a));
  for (const g of deepestFirst) {
    const rect = rects.get(g.id)!;
    const els = (elementsIn.get(g.id) ?? []).map((n) => ({ id: n.id, box: boxes.get(n.id)! }));
    const subs = (boundariesIn.get(g.id) ?? []).map((b) => ({ id: b.id, box: rects.get(b.id)! }));
    const touched = [...els, ...subs].some((c) => moved.has(c.id));
    if (!els.length && !subs.length) {
      const p = stored[g.id];
      if (p) {
        rect.x = p[0];
        rect.y = p[1];
        moved.add(g.id);
      }
      rect.width = Math.max(rect.width, M.emptyBoundary.width);
      rect.height = Math.max(rect.height, M.emptyBoundary.height);
      continue;
    }
    if (!touched) continue;
    const all = [...els, ...subs].map((c) => c.box);
    const left = Math.min(...all.map((b) => b.x)) - M.shapeMargin;
    const right = Math.max(...all.map((b) => b.x + b.width)) + M.shapeMargin;
    const bottom = Math.max(...all.map((b) => b.y + b.height)) + M.shapeMargin;
    const tops = [
      ...els.map((c) => c.box.y - M.shapeMargin * 2),
      ...subs.map((c) => c.box.y - M.diagramMarginY - texts.get(c.id)!.height),
    ];
    const top = Math.min(...tops);
    Object.assign(rect, { x: left, y: top, width: right - left, height: bottom - top });
    moved.add(g.id);
  }

  const positions: Record<string, Point> = {};
  const sizes: Record<string, Size> = {};
  for (const [id, b] of [...boxes, ...rects]) {
    positions[id] = [b.x, b.y];
    sizes[id] = { width: b.width, height: b.height };
  }
  return { positions, sizes, elements, boundaries: texts };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the line from the box's centre towards `point` leaves the box. */
export function intersectBox(box: Box, point: { x: number; y: number }): { x: number; y: number } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const w = box.width / 2;
  const h = box.height / 2;
  if (!dx && !dy) return { x: cx, y: cy };
  if (Math.abs(dy) * w > Math.abs(dx) * h) {
    const sy = dy < 0 ? -h : h;
    return { x: cx + (sy * dx) / dy, y: cy + sy };
  }
  const sx = dx < 0 ? -w : w;
  return { x: cx + sx, y: cy + (sx * dy) / dx };
}

export interface C4RelGeometry {
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Quadratic control point: Mermaid draws every relation but the first as a curve. */
  control?: { x: number; y: number };
  /** Left edge of the label block (Mermaid starts the label at the midpoint), vertically centred. */
  label: { x: number; y: number };
}

/**
 * A relation between two element boxes: endpoints where the centre-to-centre
 * line leaves each box, the first relation straight and the others as
 * Mermaid's quadratic curves, the label at the midpoint.
 */
export function c4RelGeometry(from: Box, to: Box, index: number): C4RelGeometry {
  const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const start = intersectBox(from, centre(to));
  const end = intersectBox(to, centre(from));
  const control =
    index === 0
      ? undefined
      : {
          x: start.x + (end.x - start.x) / 2 - (end.x - start.x) / 4,
          y: start.y + (end.y - start.y) / 2,
        };
  const label = {
    x: Math.min(start.x, end.x) + Math.abs(end.x - start.x) / 2,
    y: Math.min(start.y, end.y) + Math.abs(end.y - start.y) / 2,
  };
  return { start, end, control, label };
}

/**
 * Mermaid's C4 arrowhead (a 10×10 triangle, `refX` 9) at `tip`, pointing
 * along the direction from `from` to `tip`; as an SVG `points` list.
 */
export function c4ArrowHead(tip: { x: number; y: number }, from: { x: number; y: number }): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const point = { x: tip.x + ux, y: tip.y + uy };
  const base = { x: tip.x - ux * 9, y: tip.y - uy * 9 };
  const pts = [
    point,
    { x: base.x - uy * 5, y: base.y + ux * 5 },
    { x: base.x + uy * 5, y: base.y - ux * 5 },
  ];
  return pts.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
}

const round = (n: number) => Math.round(n * 100) / 100;
