import type { FamilyUI } from "./types.js";

const SIDE_OPTIONS = [
  { value: "L", label: "Left" },
  { value: "R", label: "Right" },
  { value: "T", label: "Top" },
  { value: "B", label: "Bottom" },
];

/** Toolbar / inspector vocabulary for `architecture-beta` diagrams. */
export const architectureUI: FamilyUI = {
  family: "architecture",
  title: "Architecture diagram",
  shapes: [
    { value: "arch-service", label: "Service" },
    { value: "sm-circ", label: "Junction" },
  ],
  edgeKinds: [
    { value: "--", label: "Line", arrowStart: "none", arrowEnd: "none", pattern: "solid" },
    { value: "-->", label: "Arrow", arrowStart: "none", arrowEnd: "arrow_point", pattern: "solid" },
    {
      value: "<-->",
      label: "Bidirectional",
      arrowStart: "arrow_point",
      arrowEnd: "arrow_point",
      pattern: "solid",
    },
  ],
  patterns: [{ value: "solid", label: "Solid" }],
  arrowHeads: [
    { value: "none", label: "None" },
    { value: "arrow_point", label: "Arrow" },
  ],
  groups: { supported: true, label: "Group" },
  labels: true,
  nodeNoun: "Service",
  edgeNoun: "Connection",
  nextId: (g) => {
    const taken = new Set([...g.nodes.map((n) => n.id), ...g.groups.map((x) => x.id)]);
    let i = g.nodes.length + 1;
    while (taken.has(`svc${i}`)) i++;
    return `svc${i}`;
  },
  canDetach: true,
  styling: false,
  directions: false,
  // Positions are Mermaid's own layout (plus where the user dragged): "Arrange"
  // would pin a dagre layout Mermaid never draws.
  // "Tidy up" resets dragged positions to Mermaid's own layout (the registered family layout).
  arrange: true,
  preview: false,
  connectable: true,
  nodeFields: [
    {
      key: "icon",
      label: "Icon",
      type: "select",
      options: ["cloud", "database", "disk", "internet", "server"].map((v) => ({
        value: v,
        label: v,
      })),
    },
  ],
  edgeFields: [
    { key: "sourceSide", label: "From side", type: "select", options: SIDE_OPTIONS },
    { key: "targetSide", label: "To side", type: "select", options: SIDE_OPTIONS },
  ],
  newNode: () => ({ label: "New service", data: { icon: "server" } }),
};
