import type { FamilyUI } from "./types.js";

/**
 * Quadrant chart vocabulary. The canvas draws Mermaid's chart; points sit
 * where their coordinates put them (dragging one rewrites its `[x, y]`, and
 * its quadrant follows), the four quadrants are fixed (renamable on the
 * canvas, not movable) and there are no edges.
 */
export const quadrantUI: FamilyUI = {
  family: "quadrant",
  title: "Quadrant chart",
  shapes: [{ value: "point", label: "Point" }],
  edgeKinds: [],
  patterns: [],
  arrowHeads: [],
  groups: { supported: false, label: "Quadrant" },
  labels: true,
  nodeNoun: "Point",
  nextId: (g) => `point${g.nodes.length + 1}`,
  canDetach: false,
  styling: false,
  connectable: false,
  directions: false,
  arrange: false,
  preview: false,
  nodeFields: [
    { key: "x", label: "X", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "y", label: "Y", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "radius", label: "Radius", type: "number", min: 1 },
    { key: "color", label: "Colour", type: "text", placeholder: "#ff9900" },
  ],
  diagramFields: [
    { key: "xAxisLeft", label: "X axis (left)", type: "text" },
    { key: "xAxisRight", label: "X axis (right)", type: "text" },
    { key: "yAxisBottom", label: "Y axis (bottom)", type: "text" },
    { key: "yAxisTop", label: "Y axis (top)", type: "text" },
  ],
  newNode: () => ({ label: "New point", data: { x: 0.5, y: 0.5 } }),
};
