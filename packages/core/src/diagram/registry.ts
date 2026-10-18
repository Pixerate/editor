import type { DiagramAdapter, DiagramFamily, SupportTier } from "./types.js";
import { flowchartAdapter } from "./flowchart/index.js";
import { createPassthroughAdapter } from "./passthrough.js";
import { classGrammar, createLineAdapter, erGrammar, stateGrammar } from "./lines-grammar/index.js";
import { pieAdapter } from "./pie/index.js";
import { mindmapAdapter } from "./mindmap/index.js";
import { quadrantAdapter } from "./quadrant/index.js";
import { c4Adapter } from "./c4/index.js";
import { architectureAdapter } from "./architecture/index.js";
import { sequenceAdapter } from "./sequence/index.js";
import { gitGraphAdapter } from "./gitgraph/index.js";
import { ganttAdapter } from "./gantt/index.js";
import { timelineAdapter } from "./timeline/index.js";
import { journeyAdapter } from "./journey/index.js";
import { xyChartAdapter } from "./xychart/index.js";
import { radarAdapter } from "./radar/index.js";

const adapters = new Map<DiagramFamily, DiagramAdapter<unknown>>();

/** Registers (or replaces) the adapter for a family. */
export function registerDiagramAdapter(adapter: DiagramAdapter<unknown>): void {
  adapters.set(adapter.family, adapter);
}

export function getDiagramAdapter(family: DiagramFamily): DiagramAdapter<unknown> {
  return adapters.get(family) ?? adapters.get("unknown")!;
}

/** `editable` for every family with an adapter; `render-only` for sankey, block, packet, kanban, treemap and the rest. */
export function supportTierOf(family: DiagramFamily): SupportTier {
  return getDiagramAdapter(family).tier;
}

registerDiagramAdapter(flowchartAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(createLineAdapter(stateGrammar) as DiagramAdapter<unknown>);
registerDiagramAdapter(createLineAdapter(classGrammar) as DiagramAdapter<unknown>);
registerDiagramAdapter(createLineAdapter(erGrammar) as DiagramAdapter<unknown>);
registerDiagramAdapter(pieAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(mindmapAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(quadrantAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(c4Adapter as DiagramAdapter<unknown>);
registerDiagramAdapter(architectureAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(sequenceAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(gitGraphAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(ganttAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(timelineAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(journeyAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(xyChartAdapter as DiagramAdapter<unknown>);
registerDiagramAdapter(radarAdapter as DiagramAdapter<unknown>);
for (const family of [
  "sankey", "block", "packet", "kanban", "treemap", "info", "requirement", "unknown",
] as DiagramFamily[]) {
  registerDiagramAdapter(createPassthroughAdapter(family) as DiagramAdapter<unknown>);
}
