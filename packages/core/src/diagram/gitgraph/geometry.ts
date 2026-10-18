import type { DiagramGraph } from "../types.js";

/**
 * Geometry of a git graph as Mermaid draws it (`gitGraphRenderer`, default
 * config: `rotateCommitLabel: true`, `parallelCommits: false`,
 * `showBranches: true`): one lane per branch in `order`, commits in sequence
 * order 50px apart along the lanes, and parent links routed with Mermaid's
 * arcs and lane-finding. Shared by the layout (node boxes), the editor and the
 * React canvas, so all agree with Mermaid's picture.
 *
 * Coordinates are Mermaid's own (commit centres; lanes start at x = 0 for
 * `LR`, y = 30 for `TB`/`BT`).
 *
 * @module
 */

/** Mermaid's gitGraph constants (`COMMIT_STEP`, `LAYOUT_OFFSET`…), in canvas pixels. */
export const GIT_METRICS = {
  /** Distance between consecutive commits (`COMMIT_STEP + LAYOUT_OFFSET`). */
  commitStep: 50,
  layoutOffset: 10,
  /** Lane start for vertical graphs (`defaultPos`). */
  defaultPos: 30,
  /** Lane spacing: 50, + 40 for rotated commit labels (+ half the label width when vertical). */
  laneStep: 90,
  commitRadius: 10,
  /** Size of the selectable commit box centred on the commit. */
  commitBox: 24,
  branchFontSize: 16,
  /** Height of a branch name's text box at 16px. */
  branchTextHeight: 18,
  labelFontSize: 10,
  labelTextHeight: 12,
  colors: 8,
} as const;

const M = GIT_METRICS;

export type GitDirection = "LR" | "TB" | "BT";
export type CommitSymbol = "NORMAL" | "REVERSE" | "HIGHLIGHT" | "MERGE" | "CHERRY_PICK";

export interface GitCommitGeometry {
  id: string;
  /** Centre of the commit bullet. */
  x: number;
  y: number;
  branch: string;
  /** Colour slot (`--mermaid-git<n>`), the branch's lane index modulo 8. */
  color: number;
  seq: number;
  symbol: CommitSymbol;
  /** The commit label Mermaid prints (its id), when it prints one. */
  label?: string;
  tags: string[];
  /** Last commit on its branch (a merge can start from it). */
  tip: boolean;
}

export interface GitLaneGeometry {
  branch: string;
  index: number;
  color: number;
  /** The dashed branch line. */
  line: { x1: number; y1: number; x2: number; y2: number };
  /** The branch name pill. */
  label: { x: number; y: number; width: number; height: number };
}

export interface GitArrowGeometry {
  edgeId: string;
  path: string;
  color: number;
}

export interface GitGeometry {
  direction: GitDirection;
  commits: Map<string, GitCommitGeometry>;
  /** Lanes in Mermaid's branch order. */
  lanes: GitLaneGeometry[];
  arrows: Map<string, GitArrowGeometry>;
  /** End of the lanes along the commit axis. */
  maxPos: number;
}

/** Rough width of a run of text in Mermaid's default font. */
export function estimateTextWidth(text: string, fontSize: number): number {
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

export function gitDirection(graph: DiagramGraph): GitDirection {
  const d = graph.direction.toUpperCase();
  return d === "TB" || d === "TD" ? "TB" : d === "BT" ? "BT" : "LR";
}

/** Branches in Mermaid's order (`getBranchesAsObjArray`): explicit `order`, else `0.<index>`. */
export function branchOrder(graph: DiagramGraph): string[] {
  return graph.groups
    .map((g, i) => {
      const order = g.data?.order;
      // `main` comes first with Mermaid's `mainBranchOrder` (0); 0.<i> for i = 0 is 0 too.
      const value = typeof order === "number" ? order : parseFloat(`0.${i}`);
      return { id: g.id, value };
    })
    .sort((a, b) => a.value - b.value)
    .map((b) => b.id);
}

function symbolOf(data: Record<string, unknown> | undefined): CommitSymbol {
  const type = typeof data?.type === "string" ? data.type.toUpperCase() : "NORMAL";
  if (data?.kind === "cherry-pick") return "CHERRY_PICK";
  if (type === "REVERSE" || type === "HIGHLIGHT") return type;
  return data?.kind === "merge" ? "MERGE" : "NORMAL";
}

/** Computes the whole picture from the graph the adapter builds. */
export function gitGraphGeometry(graph: DiagramGraph): GitGeometry {
  const dir = gitDirection(graph);
  const vertical = dir !== "LR";
  const order = branchOrder(graph);
  const laneIndex = new Map(order.map((b, i) => [b, i]));
  const labelText = new Map(graph.groups.map((g) => [g.id, g.label || g.id]));

  // Lane positions (`setBranchPosition`).
  const lanePos = new Map<string, number>();
  let pos = 0;
  for (const b of order) {
    lanePos.set(b, pos);
    const w = estimateTextWidth(labelText.get(b) ?? b, M.branchFontSize);
    pos += M.laneStep + (vertical ? w / 2 : 0);
  }

  // Commits in sequence order (`drawCommits`).
  const nodes = graph.nodes;
  const n = nodes.length;
  const tipOf = new Map<string, string>();
  for (const node of nodes) tipOf.set(String(node.data?.branch ?? node.parentId ?? ""), node.id);
  const commits = new Map<string, GitCommitGeometry>();
  nodes.forEach((node, seq) => {
    const branch = String(node.data?.branch ?? node.parentId ?? order[0] ?? "main");
    const lane = lanePos.get(branch) ?? 0;
    const slot = dir === "BT" ? n - 1 - seq : seq;
    const along = (vertical ? M.defaultPos : 0) + slot * M.commitStep + M.layoutOffset;
    const symbol = symbolOf(node.data);
    const explicit = node.data?.explicitId !== false;
    const showLabel = symbol !== "CHERRY_PICK" && (node.data?.kind !== "merge" || explicit);
    const tag = typeof node.data?.tag === "string" && node.data.tag ? node.data.tag : undefined;
    const from = typeof node.data?.from === "string" ? node.data.from : undefined;
    const tags = tag
      ? [tag]
      : node.data?.kind === "cherry-pick" && from
        ? [`cherry-pick:${from}`]
        : [];
    commits.set(node.id, {
      id: node.id,
      x: vertical ? lane : along,
      y: vertical ? along : lane - 2,
      branch,
      color: (laneIndex.get(branch) ?? 0) % M.colors,
      seq,
      symbol,
      label: showLabel ? node.label || node.id : undefined,
      tags,
      tip: tipOf.get(branch) === node.id,
    });
  });
  const maxPos = (vertical ? M.defaultPos : 0) + n * M.commitStep;

  // Lanes and branch name pills (`drawBranches`).
  const lanes: GitLaneGeometry[] = order.map((b, index) => {
    const p = lanePos.get(b)!;
    const w = estimateTextWidth(labelText.get(b) ?? b, M.branchFontSize);
    const h = M.branchTextHeight;
    const spine = vertical ? p : p - 2;
    const line = vertical
      ? { x1: p, y1: M.defaultPos, x2: p, y2: maxPos }
      : { x1: 0, y1: spine, x2: maxPos, y2: spine };
    const label = vertical
      ? { x: p - w / 2 - 10, y: dir === "TB" ? 0 : maxPos, width: w + 18, height: h + 4 }
      : { x: -w - 53, y: spine - (h + 4) / 2, width: w + 18, height: h + 4 };
    return { branch: b, index, color: index % M.colors, line, label };
  });

  // Parent links (`drawArrows`), in commit then parent order like Mermaid.
  const usedLanes: number[] = lanes.map((l) => (vertical ? l.line.x1 : l.line.y1));
  const parents = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = parents.get(e.target) ?? [];
    list.push(e.source);
    parents.set(e.target, list);
  }
  const findLane = (y1: number, y2: number, depth = 0): number => {
    const candidate = y1 + Math.abs(y1 - y2) / 2;
    if (depth > 5) return candidate;
    if (usedLanes.every((lane) => Math.abs(lane - candidate) >= 10)) {
      usedLanes.push(candidate);
      return candidate;
    }
    const diff = Math.abs(y1 - y2);
    return findLane(y1, y2 - diff / 5, depth + 1);
  };
  const all = [...commits.values()];
  const arrows = new Map<string, GitArrowGeometry>();
  for (const e of graph.edges) {
    const a = commits.get(e.source);
    const b = commits.get(e.target);
    if (!a || !b) continue;
    const firstParent = parents.get(b.id)?.[0];
    const isMerge = nodes[b.seq]?.data?.kind === "merge";
    arrows.set(e.id, {
      edgeId: e.id,
      ...arrowPath(dir, a, b, isMerge && a.id !== firstParent, all, findLane),
    });
  }
  return { direction: dir, commits, lanes, arrows, maxPos };
}

/** `drawArrow`: the path from parent `a` to child `b` and its colour slot. */
function arrowPath(
  dir: GitDirection,
  a: GitCommitGeometry,
  b: GitCommitGeometry,
  /** `b` is a merge and `a` its merged-in (second) parent. */
  mergedIn: boolean,
  all: GitCommitGeometry[],
  findLane: (y1: number, y2: number) => number,
): { path: string; color: number } {
  const p1 = a;
  const p2 = b;
  const vertical = dir !== "LR";
  const furthest = vertical ? p1.x < p2.x : p1.y < p2.y;
  const curveBranch = furthest ? b.branch : a.branch;
  const reroute = all.some((c) => c.seq > a.seq && c.seq < b.seq && c.branch === curveBranch);
  let color = mergedIn ? a.color : b.color;
  let path = `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;

  if (reroute) {
    const arc = "A 10 10, 0, 0, 0,";
    const arc2 = "A 10 10, 0, 0, 1,";
    const r = 10;
    const lineY = p1.y < p2.y ? findLane(p1.y, p2.y) : findLane(p2.y, p1.y);
    const lineX = p1.x < p2.x ? findLane(p1.x, p2.x) : findLane(p2.x, p1.x);
    if (dir === "TB") {
      if (p1.x < p2.x)
        path = `M ${p1.x} ${p1.y} L ${lineX - r} ${p1.y} ${arc2} ${lineX} ${p1.y + r} L ${lineX} ${p2.y - r} ${arc} ${lineX + r} ${p2.y} L ${p2.x} ${p2.y}`;
      else {
        color = a.color;
        path = `M ${p1.x} ${p1.y} L ${lineX + r} ${p1.y} ${arc} ${lineX} ${p1.y + r} L ${lineX} ${p2.y - r} ${arc2} ${lineX - r} ${p2.y} L ${p2.x} ${p2.y}`;
      }
    } else if (dir === "BT") {
      if (p1.x < p2.x)
        path = `M ${p1.x} ${p1.y} L ${lineX - r} ${p1.y} ${arc} ${lineX} ${p1.y - r} L ${lineX} ${p2.y + r} ${arc2} ${lineX + r} ${p2.y} L ${p2.x} ${p2.y}`;
      else {
        color = a.color;
        path = `M ${p1.x} ${p1.y} L ${lineX + r} ${p1.y} ${arc2} ${lineX} ${p1.y - r} L ${lineX} ${p2.y + r} ${arc} ${lineX - r} ${p2.y} L ${p2.x} ${p2.y}`;
      }
    } else if (p1.y < p2.y) {
      path = `M ${p1.x} ${p1.y} L ${p1.x} ${lineY - r} ${arc} ${p1.x + r} ${lineY} L ${p2.x - r} ${lineY} ${arc2} ${p2.x} ${lineY + r} L ${p2.x} ${p2.y}`;
    } else {
      color = a.color;
      path = `M ${p1.x} ${p1.y} L ${p1.x} ${lineY + r} ${arc2} ${p1.x + r} ${lineY} L ${p2.x - r} ${lineY} ${arc} ${p2.x} ${lineY - r} L ${p2.x} ${p2.y}`;
    }
    return { path, color };
  }

  const arc = "A 20 20, 0, 0, 0,";
  const arc2 = "A 20 20, 0, 0, 1,";
  const r = 20;
  if (dir === "TB") {
    if (p1.x < p2.x)
      path = mergedIn
        ? `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y - r} ${arc} ${p1.x + r} ${p2.y} L ${p2.x} ${p2.y}`
        : `M ${p1.x} ${p1.y} L ${p2.x - r} ${p1.y} ${arc2} ${p2.x} ${p1.y + r} L ${p2.x} ${p2.y}`;
    else if (p1.x > p2.x)
      path = mergedIn
        ? `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y - r} ${arc2} ${p1.x - r} ${p2.y} L ${p2.x} ${p2.y}`
        : `M ${p1.x} ${p1.y} L ${p2.x + r} ${p1.y} ${arc} ${p2.x} ${p1.y + r} L ${p2.x} ${p2.y}`;
  } else if (dir === "BT") {
    if (p1.x < p2.x)
      path = mergedIn
        ? `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y + r} ${arc2} ${p1.x + r} ${p2.y} L ${p2.x} ${p2.y}`
        : `M ${p1.x} ${p1.y} L ${p2.x - r} ${p1.y} ${arc} ${p2.x} ${p1.y - r} L ${p2.x} ${p2.y}`;
    else if (p1.x > p2.x)
      path = mergedIn
        ? `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y + r} ${arc} ${p1.x - r} ${p2.y} L ${p2.x} ${p2.y}`
        : `M ${p1.x} ${p1.y} L ${p2.x + r} ${p1.y} ${arc2} ${p2.x} ${p1.y - r} L ${p2.x} ${p2.y}`;
  } else if (p1.y < p2.y) {
    path = mergedIn
      ? `M ${p1.x} ${p1.y} L ${p2.x - r} ${p1.y} ${arc2} ${p2.x} ${p1.y + r} L ${p2.x} ${p2.y}`
      : `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y - r} ${arc} ${p1.x + r} ${p2.y} L ${p2.x} ${p2.y}`;
  } else if (p1.y > p2.y) {
    path = mergedIn
      ? `M ${p1.x} ${p1.y} L ${p2.x - r} ${p1.y} ${arc} ${p2.x} ${p1.y - r} L ${p2.x} ${p2.y}`
      : `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y + r} ${arc2} ${p1.x + r} ${p2.y} L ${p2.x} ${p2.y}`;
  }
  return { path, color };
}
