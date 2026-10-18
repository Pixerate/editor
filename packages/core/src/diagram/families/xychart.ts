import type { FamilyUI } from "./types.js";

export const xyChartUI: FamilyUI = {
  family: "xychart",
  title: "XY chart",
  shapes: [
    { value: "bar", label: "Bar" },
    { value: "line", label: "Line" },
  ],
  edgeKinds: [],
  patterns: [],
  arrowHeads: [],
  groups: { supported: false, label: "Group" },
  labels: true,
  nodeNoun: "Series",
  nextId: (g) => `series${g.nodes.length + 1}`,
  canDetach: false,
  styling: false,
  connectable: false,
  directions: false,
  arrange: false,
  preview: false,
  nodeFields: [
    { key: "values", label: "Values", type: "numbers", hint: "One per x-axis category" },
  ],
  diagramFields: [
    { key: "categories", label: "X-axis categories", type: "lines", placeholder: "One per line" },
    { key: "xTitle", label: "X-axis title", type: "text" },
    { key: "yTitle", label: "Y-axis title", type: "text" },
    { key: "yMin", label: "Y-axis min", type: "number" },
    { key: "yMax", label: "Y-axis max", type: "number" },
    { key: "horizontal", label: "Horizontal", type: "boolean" },
  ],
  newNode: () => ({ label: "New series", shape: "bar" }),
};
