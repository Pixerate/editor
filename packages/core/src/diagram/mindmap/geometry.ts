import type { DiagramGraph, Point } from "../types.js";
import type { MindmapForm } from "./index.js";

/**
 * Geometry of a mind map as Mermaid draws it: the root in the centre, each
 * top-level branch a "section" with its own colour, node shapes sized like
 * Mermaid's mindmap shapes (padding 10, labels wrapped at 200px), and edges
 * whose width shrinks with depth.
 *
 * Mermaid places the nodes with cose-bilkent, a force-directed layout whose
 * result is not reproducible outside a browser; this module uses a
 * deterministic radial tree with the same character: the root in the middle,
 * branches spread all around it, children further out in their branch's
 * sector. Shared by the layout, the editor (dropping a topic on another one
 * re-parents it) and the React canvas, so all agree.
 *
 * @module
 */

export const MINDMAP_METRICS = {
  fontSize: 16,
  lineHeight: 24,
  /** `mindmap.maxNodeWidth`: labels wrap at this width. */
  wrapWidth: 200,
  /** Clear space between rings of the radial tree. */
  ringGap: 44,
  /** Clear space between neighbours on a ring. */
  siblingGap: 14,
  /** Mermaid cycles sections modulo `MAX_SECTIONS - 1`. */
  sections: 11,
} as const;

const M = MINDMAP_METRICS;

export interface MindmapTopicGeometry {
  id: string;
  /** Centre. */
  x: number;
  y: number;
  /** The shape's box (Mermaid's node size); clouds and bangs bulge a little past it. */
  width: number;
  height: number;
  form: MindmapForm;
  depth: number;
  /** Section (colour) index; `-1` for the root. */
  section: number;
  parent?: string;
  /** Label lines as Mermaid wraps them. */
  lines: string[];
}

export interface MindmapEdgeGeometry {
  edgeId: string;
  source: string;
  target: string;
  /** Mermaid's `edge-depth-<n>` stroke width. */
  width: number;
  section: number;
}

export interface MindmapGeometry {
  topics: Map<string, MindmapTopicGeometry>;
  edges: MindmapEdgeGeometry[];
}

/** Rough width of a run of text in Mermaid's default 16px font. */
export function estimateTextWidth(text: string, fontSize: number = M.fontSize): number {
  let em = 0;
  for (const ch of text) {
    if (/[ilj.,:;'|!()[\]{}]/.test(ch)) em += 0.3;
    else if (ch === " ") em += 0.3;
    else if (/[mwMW@%]/.test(ch)) em += 0.85;
    else if (/[A-Z]/.test(ch)) em += 0.65;
    else if (/[0-9]/.test(ch)) em += 0.55;
    else em += 0.52;
  }
  return Math.ceil(em * fontSize);
}

/** Label lines: `<br>` breaks, then word wrap at `mindmap.maxNodeWidth`. */
export function wrapLabel(label: string): string[] {
  const text = label.startsWith("`") && label.endsWith("`") ? label.slice(1, -1) : label;
  const lines: string[] = [];
  for (const part of text.split(/<br\s*\/?>|\n/i)) {
    let line = "";
    for (const word of part.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && estimateTextWidth(next) > M.wrapWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

/** Mermaid's shape size for a label box of `tw` × `th` (see the mindmap shapes). */
export function shapeSize(
  form: MindmapForm,
  tw: number,
  th: number,
): { width: number; height: number } {
  switch (form) {
    case "rounded":
      return { width: tw + 30, height: th + 30 };
    case "square":
      return { width: tw + 40, height: th + 20 };
    case "circle": {
      const d = Math.sqrt(tw * tw + th * th) + 20;
      return { width: d, height: d };
    }
    case "cloud":
      return { width: tw + 10, height: th + 10 };
    case "bang":
      return { width: tw + 50, height: th + 40 };
    case "hexagon": {
      const h = th + 20;
      return { width: tw + h / 2 + 20, height: h };
    }
    default:
      return { width: tw + 40, height: th + 10 };
  }
}

/** The space a shape takes, bulges included (for spacing, not for drawing). */
function extent(form: MindmapForm, w: number, h: number): { width: number; height: number } {
  if (form === "cloud") return { width: w * 1.35, height: h + w * 0.55 };
  if (form === "bang") return { width: w * 1.25, height: h * 1.25 };
  return { width: w, height: h };
}

/** Half the size of a `w` × `h` box along direction `angle`. */
function along(w: number, h: number, angle: number): number {
  return (Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * h) / 2;
}

const FORMS = new Set<MindmapForm>([
  "default",
  "square",
  "rounded",
  "circle",
  "bang",
  "cloud",
  "hexagon",
]);

export function mindmapGeometry(graph: DiagramGraph): MindmapGeometry {
  const children = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const e of graph.edges) {
    if (parentOf.has(e.target)) continue;
    parentOf.set(e.target, e.source);
    const list = children.get(e.source) ?? [];
    list.push(e.target);
    children.set(e.source, list);
  }
  const roots = graph.nodes.filter((n) => !parentOf.has(n.id)).map((n) => n.id);

  const topics = new Map<string, MindmapTopicGeometry>();
  const ext = new Map<string, { width: number; height: number }>();
  for (const n of graph.nodes) {
    const raw = n.data?.form as MindmapForm | undefined;
    const form: MindmapForm = raw && FORMS.has(raw) ? raw : "default";
    const lines = wrapLabel(n.label);
    const tw = Math.max(...lines.map((l) => estimateTextWidth(l)), 8);
    const th = lines.length * M.lineHeight;
    const { width, height } = shapeSize(form, tw, th);
    topics.set(n.id, { id: n.id, x: 0, y: 0, width, height, form, depth: 0, section: -1, lines });
    ext.set(n.id, extent(form, width, height));
  }

  // Leaf counts weight the sectors.
  const weight = new Map<string, number>();
  const weigh = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const kids = children.get(id) ?? [];
    const w = kids.length ? kids.reduce((s, k) => s + weigh(k, seen), 0) : 1;
    weight.set(id, Math.max(1, w));
    return Math.max(1, w);
  };

  let offsetX = 0;
  for (const root of roots) {
    weigh(root, new Set());
    // Angles and depths: each node gets a slice of its parent's sector.
    const angle = new Map<string, number>();
    const byDepth: string[][] = [];
    const visit = (id: string, depth: number, a0: number, a1: number, section: number) => {
      const t = topics.get(id)!;
      t.depth = depth;
      t.section = section;
      angle.set(id, (a0 + a1) / 2);
      (byDepth[depth] ??= []).push(id);
      const kids = (children.get(id) ?? []).filter((k) => topics.get(k)!.depth === 0 && k !== root);
      const total = kids.reduce((s, k) => s + weight.get(k)!, 0);
      let start = a0;
      kids.forEach((k, i) => {
        const span = ((a1 - a0) * weight.get(k)!) / total;
        topics.get(k)!.parent = id;
        visit(k, depth + 1, start, start + span, depth === 0 ? i % M.sections : section);
        start += span;
      });
    };
    // The first branch starts at the top and the others follow clockwise.
    visit(root, 0, -Math.PI / 2, (3 * Math.PI) / 2, -1);

    // Ring radii: clear of the ring inside, and wide enough for neighbours on the ring.
    const radius: number[] = [0];
    const half = (id: string) => {
      const e = ext.get(id)!;
      return along(e.width, e.height, angle.get(id)!);
    };
    for (let d = 1; d < byDepth.length; d++) {
      const ring = byDepth[d]!;
      const inner = Math.max(...byDepth[d - 1]!.map((id) => (d === 1 ? halfRoot(id) : half(id))));
      let r = radius[d - 1]! + inner + Math.max(...ring.map(half)) + M.ringGap;
      const sorted = [...ring].sort((a, b) => angle.get(a)! - angle.get(b)!);
      if (sorted.length > 1) {
        for (let i = 0; i < sorted.length; i++) {
          const a = sorted[i]!;
          const b = sorted[(i + 1) % sorted.length]!;
          let delta = angle.get(b)! - angle.get(a)!;
          if (i === sorted.length - 1) delta += 2 * Math.PI;
          if (delta <= 0 || delta >= Math.PI) continue;
          const ea = ext.get(a)!;
          const eb = ext.get(b)!;
          const tangent = (id: string, e: { width: number; height: number }) =>
            along(e.width, e.height, angle.get(id)! + Math.PI / 2);
          const need = tangent(a, ea) + tangent(b, eb) + M.siblingGap;
          r = Math.max(r, need / (2 * Math.sin(delta / 2)));
        }
      }
      radius[d] = r;
    }
    function halfRoot(id: string): number {
      const e = ext.get(id)!;
      // The root is passed in every direction: use its largest half-size.
      return Math.max(e.width, e.height) / 2;
    }

    // Place, then shift this tree to the right of the previous one.
    let minX = Infinity;
    let maxX = -Infinity;
    byDepth.forEach((ring, d) => {
      for (const id of ring) {
        const t = topics.get(id)!;
        const a = angle.get(id)!;
        t.x = d === 0 ? 0 : radius[d]! * Math.cos(a);
        t.y = d === 0 ? 0 : radius[d]! * Math.sin(a);
        minX = Math.min(minX, t.x - t.width / 2);
        maxX = Math.max(maxX, t.x + t.width / 2);
      }
    });
    const shift = offsetX - (offsetX === 0 ? 0 : minX);
    for (const ring of byDepth) {
      for (const id of ring) {
        const t = topics.get(id)!;
        t.x = Math.round(t.x + shift);
        t.y = Math.round(t.y);
      }
    }
    offsetX = maxX + shift + 80;
  }

  const edges: MindmapEdgeGeometry[] = [];
  for (const e of graph.edges) {
    const s = topics.get(e.source);
    const t = topics.get(e.target);
    if (!s || !t || t.parent !== e.source) continue;
    // `.edge-depth-<n>` is 17 - 3·(n + 1) px; past depth 4 it falls back to `.edge` (3px).
    const n = s.depth + 1;
    const width = 17 - 3 * (n + 1);
    edges.push({
      edgeId: e.id,
      source: e.source,
      target: e.target,
      width: width > 0 ? width : 3,
      section: t.section,
    });
  }
  return { topics, edges };
}

/**
 * The topic a dragged topic was dropped on: the one whose shape contains the
 * dragged topic's centre (never the topic itself or one of its descendants).
 */
export function dropTarget(geo: MindmapGeometry, id: string, centre: Point): string | undefined {
  const isInside = (candidate: string): boolean => {
    let cur: string | undefined = candidate;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === id) return true;
      seen.add(cur);
      cur = geo.topics.get(cur)?.parent;
    }
    return false;
  };
  let best: { id: string; dist: number } | undefined;
  for (const t of geo.topics.values()) {
    if (isInside(t.id)) continue;
    const dx = Math.abs(centre[0] - t.x);
    const dy = Math.abs(centre[1] - t.y);
    if (dx > t.width / 2 + 8 || dy > t.height / 2 + 8) continue;
    const dist = dx * dx + dy * dy;
    if (!best || dist < best.dist) best = { id: t.id, dist };
  }
  return best?.id;
}
