import type { DiagramGraph } from "../../src/diagram";
import { canonicalShape } from "../../src/diagram";

/**
 * Loads Mermaid lazily inside tests (jsdom environment). Mermaid's renderer
 * needs a real browser, but parsing and `getData()` work in jsdom.
 */
export async function loadMermaid() {
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
  return mermaid;
}

export interface MermaidGraphSummary {
  nodes: { id: string; label: string; shape: string; parentId?: string; isGroup: boolean }[];
  edges: {
    source: string;
    target: string;
    label: string;
    pattern: string;
    arrowStart: string;
    arrowEnd: string;
  }[];
}

/** Parses with Mermaid itself and summarises `getData()` for comparison. */
export async function mermaidSummary(source: string): Promise<MermaidGraphSummary> {
  const mermaid = await loadMermaid();
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  const db = diagram.db as unknown as {
    getData: () => { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
  };
  const data = db.getData();
  return {
    nodes: data.nodes.map((n) => ({
      id: String(n.id),
      label: String(n.label ?? ""),
      shape: canonicalShape(String(n.shape ?? "rect")),
      parentId: (n.parentId as string | undefined) ?? undefined,
      isGroup: Boolean(n.isGroup),
    })),
    edges: data.edges.map((e) => ({
      source: String(e.start),
      target: String(e.end),
      label: String(e.label ?? ""),
      pattern: String(e.pattern ?? e.thickness ?? "normal"),
      arrowStart: String(e.arrowTypeStart ?? "none"),
      arrowEnd: String(e.arrowTypeEnd ?? "none"),
    })),
  };
}

/** Summarises a diagram graph with the same shape as {@link mermaidSummary}. */
export function diagramSummary(graph: DiagramGraph): MermaidGraphSummary {
  const patternMap: Record<string, string> = {
    solid: "normal",
    dotted: "dotted",
    thick: "thick",
    invisible: "invisible",
  };
  return {
    nodes: [
      ...graph.groups.map((g) => ({
        id: g.id,
        label: g.label,
        shape: "rect",
        parentId: g.parentId,
        isGroup: true,
      })),
      ...graph.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        shape: canonicalShape(n.shape),
        parentId: n.parentId,
        isGroup: false,
      })),
    ],
    edges: graph.edges.map((e) => ({
      source: e.source,
      target: e.target,
      label: e.label ?? "",
      pattern: patternMap[e.pattern] ?? e.pattern,
      arrowStart: e.arrowStart,
      arrowEnd: e.arrowEnd,
    })),
  };
}

const sortNodes = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

/** Sorted, label-normalised view for deep-equality assertions. */
export function normaliseSummary(s: MermaidGraphSummary): MermaidGraphSummary {
  return {
    nodes: [...s.nodes]
      .sort(sortNodes)
      .map((n) => ({ ...n, label: n.label.trim(), parentId: n.parentId ?? undefined })),
    edges: [...s.edges].sort((a, b) =>
      `${a.source}>${a.target}:${a.label}`.localeCompare(`${b.source}>${b.target}:${b.label}`),
    ),
  };
}

/** Throws (with Mermaid's message) when Mermaid rejects the source. */
export async function expectValidMermaid(source: string): Promise<void> {
  const mermaid = await loadMermaid();
  await mermaid.parse(source);
}

/** Mermaid's own db for a source, for family-specific cross-checks (`getTasks()`, `getCommits()`…). */
export async function mermaidDb<T = Record<string, (...args: unknown[]) => unknown>>(
  source: string,
): Promise<T> {
  const mermaid = await loadMermaid();
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  return diagram.db as unknown as T;
}
