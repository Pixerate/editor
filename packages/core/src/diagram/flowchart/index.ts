import type { DiagramAdapter } from "../types.js";
import { applyFlowchartEdit } from "./edit.js";
import { parseFlowchart, type FlowchartBody } from "./parse.js";
import { serializeFlowchart } from "./serialize.js";

export const flowchartAdapter: DiagramAdapter<FlowchartBody> = {
  family: "flowchart",
  tier: "editable",
  parse: parseFlowchart,
  serialize: serializeFlowchart,
  apply: applyFlowchartEdit,
};

export type { FlowchartBody, FlowchartDocument } from "./parse.js";
export { parseFlowchartSource } from "./edit.js";
export { FLOWCHART_SHAPES, resolveShape, canonicalShape, type ShapeDef } from "./shapes.js";
export { parseLink, formatLink, quoteLabelIfNeeded, type LinkSpec } from "./edges.js";
export {
  parseChain,
  parseStatement,
  formatChain,
  formatNode,
  type FlowStatement,
  type Chain,
  type NodeRef,
  type LinkRef,
} from "./statements.js";
