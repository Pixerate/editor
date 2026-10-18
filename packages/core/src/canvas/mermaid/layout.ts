import dagre from "@dagrejs/dagre";
import type { DiagramFamily, DiagramGraph, DiagramMeta, GraphNode, Point } from "../../diagram/types.js";
import { getFamilyLayout } from "../../diagram/layout-registry.js";

/**

 * Automatic layout of a Mermaid diagram graph with dagre, honouring nested groups and per-group
 * direction overrides. Pure functions — no React, no DOM.
 *
 * @module
 */

export interface DiagramSize {
  width: number;
  height: number;
}

export interface DiagramLayoutOptions {
  /** Node size estimator; defaults to {@link estimateDiagramNodeSize}. */
  measure?: (node: GraphNode) => DiagramSize;
  /** Gap between nodes in a rank, in px (default 48). */
  nodeSep?: number;
  /** Gap between ranks, in px (default 72). */
  rankSep?: number;
  /** Padding inside groups around their children (default 24). */
  groupPadding?: number;
  /** Height reserved for a group's title (default 32). */
  groupTitleHeight?: number;
  /**
   * Diagram family. A family that registered its own layout (`registerFamilyLayout`:
   * pie, quadrant, sequence, Gantt…) is laid out from its data instead of with dagre.
   */
  family?: DiagramFamily;
}

export const DEFAULT_DIAGRAM_NODE_WIDTH = 160;
export const DEFAULT_DIAGRAM_NODE_HEIGHT = 56;

/** Rough text-metric size estimate (no DOM). Hosts can supply real measurements. */
export function estimateDiagramNodeSize(node: GraphNode): DiagramSize {
  const lines = String(node.label ?? node.id).split(/<br\s*\/?>|\n/);
  const longest = Math.max(...lines.map((l) => l.replace(/<[^>]+>/g, "").length), 1);
  let width = Math.min(360, Math.max(DEFAULT_DIAGRAM_NODE_WIDTH, longest * 8 + 48));
  let height = Math.max(DEFAULT_DIAGRAM_NODE_HEIGHT, lines.length * 20 + 28);
  const extra = extraLines(node);
  if (extra) height += extra * 18 + 12;
  switch (node.shape) {
    case "actor":
    case "c4-person":
      height = Math.round(height * 1.5);
      break;
    case "point":
      width = Math.max(72, longest * 7 + 36);
      height = 30;
      break;
    case "commit": {
      const d = Math.max(56, Math.min(120, longest * 7 + 24));
      width = d;
      height = d;
      break;
    }
    case "diam":
    case "hex":
    case "trap-b":
    case "trap-t":
    case "lean-r":
    case "lean-l":
      width = Math.round(width * 1.25);
      height = Math.round(height * 1.4);
      break;
    case "circle":
    case "dbl-circ":
    case "sm-circ":
    case "fr-circ":
    case "f-circ":
    case "cross-circ": {
      const d = Math.max(width * 0.75, height * 1.3);
      width = Math.round(d);
      height = Math.round(d);
      break;
    }
    case "stateStart":
    case "stateEnd":
      width = 28;
      height = 28;
      break;
    case "fork":
    case "join":
      width = 120;
      height = 10;
      break;
    case "choice":
      width = 48;
      height = 48;
      break;
    case "cyl":
    case "h-cyl":
    case "lin-cyl":
      height = Math.round(height * 1.3);
      break;
    case "image": {
      // The picture at its w × h (Mermaid's keys), with the label above or below it.
      const picture = diagramImageSize(node);
      const label = String(node.label ?? "").trim() ? IMAGE_LABEL_HEIGHT : 0;
      width = Math.max(picture.width, label ? Math.min(360, longest * 7 + 16) : 0);
      height = picture.height + label;
      break;
    }
    default:
      break;
  }
  return { width, height };
}

/** Height of an image node's label line. */
const IMAGE_LABEL_HEIGHT = 24;

/** An image node's picture size: Mermaid's `w` / `h`, else 96 square (or `w` square). */
export function diagramImageSize(node: GraphNode): DiagramSize {
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
  const w = num(node.data?.w);
  const h = num(node.data?.h);
  return { width: w ?? h ?? 96, height: h ?? w ?? 96 };
}

function extraLines(node: GraphNode): number {
  const data = node.data ?? {};
  const members = Array.isArray(data.members) ? data.members.length : 0;
  const attributes = Array.isArray(data.attributes) ? data.attributes.length : 0;
  const descriptions = Array.isArray(data.descriptions) ? data.descriptions.length : 0;
  const details = Array.isArray(data.details) ? data.details.length : 0;
  return members + attributes + descriptions + details;
}

export interface DiagramLayout {
  /** Top-left positions in absolute canvas coordinates. */
  positions: Record<string, Point>;
  /** Sizes for nodes and groups. */
  sizes: Record<string, DiagramSize>;
}

function rankdir(direction: string): "TB" | "BT" | "LR" | "RL" {
  const d = direction.toUpperCase();
  if (d === "TD") return "TB";
  if (d === "TB" || d === "BT" || d === "LR" || d === "RL") return d;
  return "TB";
}

/**
 * Lays out a graph. Nested groups are laid out recursively: each group's
 * children are arranged with the group's own direction, the group then takes
 * part in its parent's layout as a single box.
 */
export function autoLayoutDiagram(graph: DiagramGraph, options: DiagramLayoutOptions = {}): DiagramLayout {
  const measure = options.measure ?? estimateDiagramNodeSize;
  const custom = getFamilyLayout(options.family);
  if (custom) return custom(graph, { v: 1 }, { ...options, measure });
  const nodeSep = options.nodeSep ?? 48;
  const rankSep = options.rankSep ?? 72;
  const pad = options.groupPadding ?? 24;
  const titleH = options.groupTitleHeight ?? 32;

  const childrenOf = new Map<string | undefined, { id: string; isGroup: boolean }[]>();
  for (const n of graph.nodes) push(childrenOf, n.parentId, { id: n.id, isGroup: false });
  for (const g of graph.groups) push(childrenOf, g.parentId, { id: g.id, isGroup: true });
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const groupById = new Map(graph.groups.map((g) => [g.id, g]));

  const sizes: Record<string, DiagramSize> = {};
  const relative: Record<string, Point> = {}; // position relative to parent

  const layoutScope = (scope: string | undefined, direction: string): DiagramSize => {
    const children = childrenOf.get(scope) ?? [];
    // Lay out groups first so their size is known.
    for (const c of children) {
      if (c.isGroup) {
        const g = groupById.get(c.id)!;
        const inner = layoutScope(c.id, g.direction ?? direction);
        sizes[c.id] = { width: inner.width + pad * 2, height: inner.height + pad * 2 + titleH };
      } else {
        sizes[c.id] = measure(nodeById.get(c.id)!);
      }
    }
    if (!children.length) return { width: 120, height: 40 };

    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({
      rankdir: rankdir(direction),
      nodesep: nodeSep,
      ranksep: rankSep,
      marginx: 0,
      marginy: 0,
    });
    g.setDefaultEdgeLabel(() => ({}));
    const ids = new Set(children.map((c) => c.id));
    for (const c of children)
      g.setNode(c.id, { width: sizes[c.id]!.width, height: sizes[c.id]!.height });

    // Edges between members of this scope (lifting endpoints to the member that contains them).
    const lift = (id: string): string | null => {
      let cur: string | undefined = id;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        if (ids.has(cur)) return cur;
        seen.add(cur);
        cur = nodeById.get(cur)?.parentId ?? groupById.get(cur)?.parentId;
      }
      return null;
    };
    graph.edges.forEach((e, i) => {
      const s = lift(e.source);
      const t = lift(e.target);
      if (s && t && s !== t) g.setEdge(s, t, { minlen: Math.max(1, e.length) }, `e${i}`);
    });
    dagre.layout(g);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of children) {
      const n = g.node(c.id);
      const w = sizes[c.id]!.width;
      const h = sizes[c.id]!.height;
      const x = n.x - w / 2;
      const y = n.y - h / 2;
      relative[c.id] = [x, y];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
    // Normalise so the scope's content starts at (0,0).
    for (const c of children) {
      const [x, y] = relative[c.id]!;
      relative[c.id] = [x - minX, y - minY];
    }
    return { width: maxX - minX, height: maxY - minY };
  };

  layoutScope(undefined, graph.direction);

  // Convert relative → absolute.
  const positions: Record<string, Point> = {};
  const absolute = (id: string): Point => {
    if (positions[id]) return positions[id]!;
    const parentId = nodeById.get(id)?.parentId ?? groupById.get(id)?.parentId;
    const [rx, ry] = relative[id] ?? [0, 0];
    if (!parentId) {
      positions[id] = [rx, ry];
    } else {
      const [px, py] = absolute(parentId);
      positions[id] = [px + pad + rx, py + pad + titleH + ry];
    }
    return positions[id]!;
  };
  for (const n of graph.nodes) absolute(n.id);
  for (const g of graph.groups) absolute(g.id);

  return { positions, sizes };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/**
 * Returns positions for every node/group: stored metadata where available,
 * auto-layout for the rest. New nodes are placed near their neighbours so a
 * partially laid-out diagram does not jump.
 */
export function ensureDiagramLayout(
  graph: DiagramGraph,
  meta: DiagramMeta,
  options?: DiagramLayoutOptions,
): DiagramLayout {
  const measure = options?.measure ?? estimateDiagramNodeSize;
  const custom = getFamilyLayout(options?.family);
  if (custom) return custom(graph, meta, { ...(options ?? {}), measure });
  const stored = meta.layout ?? {};
  const allIds = [...graph.nodes.map((n) => n.id), ...graph.groups.map((g) => g.id)];
  const missing = allIds.filter((id) => !stored[id]);
  const sizes: Record<string, DiagramSize> = {};
  for (const n of graph.nodes)
    sizes[n.id] = meta.sizes?.[n.id]
      ? { width: meta.sizes[n.id]![0], height: meta.sizes[n.id]![1] }
      : measure(n);

  if (!missing.length) {
    const positions: Record<string, Point> = {};
    for (const id of allIds) positions[id] = stored[id]!;
    for (const g of graph.groups) sizes[g.id] = diagramGroupSize(g.id, graph, positions, sizes, meta);
    return { positions, sizes };
  }

  const auto = autoLayoutDiagram(graph, options);
  if (missing.length === allIds.length) return auto;

  // Blend: keep stored positions, place missing ones relative to auto layout
  // by aligning on the centroid of the nodes that have both.
  const both = allIds.filter((id) => stored[id] && auto.positions[id]);
  let dx = 0;
  let dy = 0;
  if (both.length) {
    for (const id of both) {
      dx += stored[id]![0] - auto.positions[id]![0];
      dy += stored[id]![1] - auto.positions[id]![1];
    }
    dx /= both.length;
    dy /= both.length;
  }
  const positions: Record<string, Point> = {};
  for (const id of allIds) {
    positions[id] = stored[id] ?? [auto.positions[id]![0] + dx, auto.positions[id]![1] + dy];
  }
  for (const g of graph.groups) sizes[g.id] = diagramGroupSize(g.id, graph, positions, sizes, meta);
  return { positions, sizes };
}

/** Bounding box of a group's descendants, with padding. */
export function diagramGroupSize(
  groupId: string,
  graph: DiagramGraph,
  positions: Record<string, Point>,
  sizes: Record<string, DiagramSize>,
  meta: DiagramMeta,
  pad = 24,
  titleH = 32,
): DiagramSize {
  if (meta.sizes?.[groupId])
    return { width: meta.sizes[groupId]![0], height: meta.sizes[groupId]![1] };
  const members = [
    ...graph.nodes.filter((n) => n.parentId === groupId).map((n) => n.id),
    ...graph.groups.filter((g) => g.parentId === groupId).map((g) => g.id),
  ];
  if (!members.length) return { width: 200, height: 100 };
  const [gx, gy] = positions[groupId] ?? [0, 0];
  let maxX = 0;
  let maxY = 0;
  for (const id of members) {
    const size =
      sizes[id] ??
      (graph.groups.some((g) => g.id === id)
        ? diagramGroupSize(id, graph, positions, sizes, meta, pad, titleH)
        : { width: DEFAULT_DIAGRAM_NODE_WIDTH, height: DEFAULT_DIAGRAM_NODE_HEIGHT });
    sizes[id] = size;
    const [x, y] = positions[id] ?? [gx, gy];
    maxX = Math.max(maxX, x - gx + size.width);
    maxY = Math.max(maxY, y - gy + size.height);
  }
  return { width: maxX + pad, height: maxY + pad };
}
