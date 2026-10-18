import type { FamilyUI } from "./types.js";

export const radarUI: FamilyUI = {
  family: "radar",
  title: "Radar chart",
  shapes: [{ value: "curve", label: "Curve" }],
  edgeKinds: [],
  patterns: [],
  arrowHeads: [],
  groups: { supported: false, label: "Group" },
  labels: true,
  nodeNoun: "Curve",
  nextId: (g) => {
    const taken = new Set(g.nodes.map((n) => n.id));
    let i = g.nodes.length + 1;
    while (taken.has(`curve${i}`)) i++;
    return `curve${i}`;
  },
  canDetach: false,
  styling: false,
  connectable: false,
  directions: false,
  arrange: false,
  preview: false,
  nodeFields: [{ key: "values", label: "Values", type: "numbers", hint: "One per axis" }],
  diagramFields: [
    { key: "axes", label: "Axes", type: "lines", placeholder: "One per line" },
    { key: "max", label: "Max", type: "number" },
    { key: "min", label: "Min", type: "number" },
    { key: "ticks", label: "Ticks", type: "number", min: 1 },
    {
      key: "graticule",
      label: "Grid",
      type: "select",
      options: [
        { value: "circle", label: "Circles" },
        { value: "polygon", label: "Polygons" },
      ],
    },
    { key: "showLegend", label: "Show legend", type: "boolean" },
  ],
  newNode: () => ({ label: "New curve" }),
};
