import type { FamilyUI } from "./types.js";

/** Toolbar / inspector vocabulary for C4 diagrams (all five C4 types). */
export const c4UI: FamilyUI = {
  family: "c4",
  title: "C4 diagram",
  shapes: [
    { value: "c4-person", label: "Person" },
    { value: "c4-person-ext", label: "External person" },
    { value: "c4-system", label: "System" },
    { value: "c4-system-ext", label: "External system" },
    { value: "c4-container", label: "Container" },
    { value: "c4-container-ext", label: "External container" },
    { value: "c4-component", label: "Component" },
    { value: "c4-component-ext", label: "External component" },
    { value: "c4-db", label: "Database" },
    { value: "c4-queue", label: "Queue" },
  ],
  edgeKinds: [
    {
      value: "Rel",
      label: "Relation",
      arrowStart: "none",
      arrowEnd: "arrow_point",
      pattern: "solid",
    },
    {
      value: "BiRel",
      label: "Bidirectional",
      arrowStart: "arrow_point",
      arrowEnd: "arrow_point",
      pattern: "solid",
    },
    {
      value: "Rel_Back",
      label: "Reverse",
      arrowStart: "arrow_point",
      arrowEnd: "none",
      pattern: "solid",
    },
  ],
  patterns: [{ value: "solid", label: "Solid" }],
  arrowHeads: [
    { value: "none", label: "None" },
    { value: "arrow_point", label: "Arrow" },
  ],
  groups: { supported: true, label: "Boundary" },
  labels: true,
  nodeNoun: "Element",
  edgeNoun: "Relation",
  nextId: (g) => {
    const taken = new Set([...g.nodes.map((n) => n.id), ...g.groups.map((x) => x.id)]);
    let i = g.nodes.length + 1;
    while (taken.has(`el${i}`)) i++;
    return `el${i}`;
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
    { key: "tech", label: "Technology", type: "text" },
    { key: "descr", label: "Description", type: "text" },
  ],
  edgeFields: [{ key: "tech", label: "Technology", type: "text" }],
  newNode: () => ({ label: "New element" }),
};
