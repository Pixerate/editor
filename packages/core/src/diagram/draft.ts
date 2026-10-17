import { parseMermaid } from "./document.js";
import type { DiagramGraph } from "./types.js";

/** What a frame shows, for telling frames apart and finding what each one adds. */
function signature(graph: DiagramGraph): string {
  return JSON.stringify([
    graph.title ?? "",
    graph.nodes.map((n) => [n.id, n.label, n.parentId ?? "", n.data ?? null]),
    graph.edges.map((e) => [e.source, e.target, e.label ?? ""]),
    graph.groups.map((g) => [g.id, g.label, g.parentId ?? ""]),
    graph.data ?? null,
  ]);
}

const isMeta = (line: string) => /^\s*%%\s*@(?:pixerate|ursula)\b/.test(line);

/** Body lines (after the header), without the layout comment and trailing blanks. */
function bodyLines(lines: string[], headerIndex: number): string[] {
  const body = lines.slice(headerIndex + 1).filter((l) => !isMeta(l));
  while (body.length && !body[body.length - 1]!.trim()) body.pop();
  return body;
}

function headerIndexOf(lines: string[], header: string): number {
  const wanted = header.trim();
  return wanted ? lines.findIndex((l) => l.trim() === wanted) : -1;
}

export interface DraftOptions {
  /** Most frames to play; longer drafts are sampled evenly (default 40). */
  maxFrames?: number;
}

/**
 * Splits writing `target` over `current` into frames that grow the diagram
 * statement by statement, so a whole-diagram write can be played as the
 * diagram being drawn. Each frame is a valid prefix of `target` (it parses
 * as the same family without diagnostics) that shows something new; the last
 * frame is `target` itself.
 *
 * Returns null when `target` does not extend `current` (some existing line
 * changes), when the family changes, or when there is nothing to grow: the
 * write is then committed in one step.
 */
export function draftFrames(
  current: string,
  target: string,
  options: DraftOptions = {},
): string[] | null {
  const maxFrames = Math.max(2, options.maxFrames ?? 40);
  const now = parseMermaid(current);
  const goal = parseMermaid(target);
  if (goal.family !== now.family || goal.diagnostics.length) return null;

  const eol = goal.eol;
  const lines = target.split(/\r?\n/);
  const at = headerIndexOf(lines, goal.header);
  if (at < 0) return null;
  const currentLines = current.split(/\r?\n/);
  const currentAt = headerIndexOf(currentLines, now.header);
  if (currentAt < 0) return null;

  // The target must keep every current body line, in order, as its start.
  const have = bodyLines(currentLines, currentAt);
  const body = lines
    .map((line, index) => ({ line, index }))
    .slice(at + 1)
    .filter(({ line }) => !isMeta(line));
  for (let i = 0; i < have.length; i++) {
    if (body[i]?.line !== have[i]) return null;
  }

  const frames: string[] = [];
  let last = signature(now.graph);
  for (let i = have.length; i < body.length; i++) {
    const end = body[i]!.index;
    const candidate = lines.slice(0, end + 1).join(eol) + eol;
    const doc = parseMermaid(candidate);
    if (doc.family !== goal.family || doc.diagnostics.length) continue;
    const sig = signature(doc.graph);
    if (sig === last) continue;
    frames.push(candidate);
    last = sig;
  }
  if (!frames.length) return null;
  // The last frame is the target exactly (its trailing lines and metadata included).
  if (last === signature(goal.graph)) frames[frames.length - 1] = target;
  else frames.push(target);

  if (frames.length <= maxFrames) return frames;
  const sampled: string[] = [];
  for (let k = 1; k <= maxFrames; k++) {
    sampled.push(frames[Math.round((k * frames.length) / maxFrames) - 1]!);
  }
  return sampled;
}

/** Ids of nodes and groups in `after` that are new or changed since `before`. */
export function changedItems(before: DiagramGraph, after: DiagramGraph): string[] {
  const old = new Map<string, string>();
  for (const n of before.nodes) old.set(n.id, JSON.stringify([n.label, n.parentId, n.data]));
  for (const g of before.groups) old.set(g.id, JSON.stringify([g.label, g.parentId]));
  const out: string[] = [];
  for (const n of after.nodes)
    if (old.get(n.id) !== JSON.stringify([n.label, n.parentId, n.data])) out.push(n.id);
  for (const g of after.groups)
    if (old.get(g.id) !== JSON.stringify([g.label, g.parentId])) out.push(g.id);
  return out;
}
