import type { DiagramAdapter, DiagramFamily, SupportTier } from "./types.js";
import { flowchartAdapter } from "./flowchart/index.js";
import { createPassthroughAdapter } from "./passthrough.js";
import { classGrammar, createLineAdapter, erGrammar, stateGrammar } from "./lines-grammar/index.js";

const adapters = new Map<DiagramFamily, DiagramAdapter<unknown>>();

/** Registers (or replaces) the adapter for a family. */
export function registerDiagramAdapter(adapter: DiagramAdapter<unknown>): void {
  adapters.set(adapter.family, adapter);
}

export function getDiagramAdapter(family: DiagramFamily): DiagramAdapter<unknown> {
  return adapters.get(family) ?? adapters.get("unknown")!;
}

/** `editable` for flowchart, state, class and ER diagrams; `render-only` otherwise. */
export function supportTierOf(family: DiagramFamily): SupportTier {
  return getDiagramAdapter(family).tier;
}

registerDiagramAdapter(flowchartAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(createLineAdapter(stateGrammar) as DiagramAdapter<unknown>);
registerDiagramAdapter(createLineAdapter(classGrammar) as DiagramAdapter<unknown>);
registerDiagramAdapter(createLineAdapter(erGrammar) as DiagramAdapter<unknown>);
for (const family of [
  "requirement", "mindmap", "sequence", "gantt", "pie", "journey", "timeline", "gitGraph", "c4",
  "quadrant", "sankey", "xychart", "block", "architecture", "packet", "kanban", "radar", "treemap",
  "info", "unknown",
] as DiagramFamily[]) {
  registerDiagramAdapter(createPassthroughAdapter(family) as DiagramAdapter<unknown>);
}
