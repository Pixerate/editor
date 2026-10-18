import type { FamilyUI } from "./types.js";

/**
 * Mind map vocabulary. Topics form a tree: "Add" attaches the new topic under
 * the selected one (`hierarchy`), and dragging a topic onto another topic
 * moves it (with its subtree) under that topic. The canvas draws Mermaid's own
 * picture (`canvases/mindmap.tsx`) with positions derived from the tree, so
 * there is no "Arrange", direction or connection handle. Branches cannot be
 * deleted on their own; delete the child topic instead.
 */
export const mindmapUI: FamilyUI = {
  family: "mindmap",
  title: "Mind map",
  shapes: [
    { value: "text", label: "Topic" },
    { value: "rounded", label: "Rounded" },
    { value: "rect", label: "Square" },
    { value: "circle", label: "Circle" },
    { value: "odd", label: "Bang" },
    { value: "stadium", label: "Cloud" },
    { value: "hex", label: "Hexagon" },
  ],
  edgeKinds: [
    { value: "branch", label: "Branch", arrowStart: "none", arrowEnd: "none", pattern: "solid" },
  ],
  patterns: [{ value: "solid", label: "Solid" }],
  arrowHeads: [{ value: "none", label: "None" }],
  groups: { supported: false, label: "Group" },
  labels: true,
  nodeNoun: "Topic",
  edgeNoun: "Branch",
  nextId: (g) => `topic${g.nodes.length + 1}`,
  canDetach: false,
  hierarchy: true,
  styling: false,
  connectable: false,
  directions: false,
  arrange: false,
  preview: false,
  nodeFields: [{ key: "icon", label: "Icon", type: "text", placeholder: "fa fa-book" }],
  newNode: () => ({ label: "New topic" }),
};
