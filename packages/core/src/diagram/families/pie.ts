import type { FamilyUI } from "./types.js";

export const pieUI: FamilyUI = {
  family: "pie",
  title: "Pie chart",
  shapes: [{ value: "slice", label: "Slice" }],
  edgeKinds: [],
  patterns: [],
  arrowHeads: [],
  groups: { supported: false, label: "Group" },
  labels: true,
  nodeNoun: "Slice",
  nextId: (g) => `slice${g.nodes.length + 1}`,
  canDetach: false,
  styling: false,
  connectable: false,
  directions: false,
  arrange: false,
  preview: false,
  nodeFields: [{ key: "value", label: "Value", type: "number", min: 0 }],
  diagramFields: [{ key: "showData", label: "Show values in legend", type: "boolean" }],
  newNode: () => ({ label: "New slice", data: { value: 10 } }),
};
