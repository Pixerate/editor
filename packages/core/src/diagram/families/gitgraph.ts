import type { DiagramGraph } from "../types.js";
import type { FamilyUI } from "./types.js";

/** Suggests `commit1`, `commit2`… skipping ids already in use. */
function nextCommitId(graph: DiagramGraph): string {
  const taken = new Set([...graph.nodes.map((n) => n.id), ...graph.groups.map((g) => g.id)]);
  let i = graph.nodes.length + 1;
  while (taken.has(`commit${i}`)) i++;
  return `commit${i}`;
}

/**
 * Toolbar / inspector vocabulary for `gitGraph`. Branches are groups: "Group"
 * starts a new branch at the end of the history (selected commits are not
 * moved), and connecting two branch tips appends a `merge`. The canvas draws
 * Mermaid's own picture (`canvases/gitgraph.tsx`): positions follow the commit
 * order, so there is no "Arrange"; the direction is the header's `LR`/`TB`/`BT`.
 */
export const gitGraphUI: FamilyUI = {
  family: "gitGraph",
  title: "Git graph",
  shapes: [{ value: "commit", label: "Commit" }],
  edgeKinds: [
    {
      value: "parent",
      label: "Parent",
      arrowStart: "none",
      arrowEnd: "arrow_point",
      pattern: "solid",
    },
  ],
  patterns: [{ value: "solid", label: "Solid" }],
  arrowHeads: [{ value: "arrow_point", label: "Arrow" }],
  groups: { supported: true, label: "Branch" },
  labels: true,
  nodeNoun: "Commit",
  edgeNoun: "Parent link",
  nextId: nextCommitId,
  canDetach: false,
  styling: false,
  connectable: true,
  directions: true,
  groupDirections: false,
  arrange: false,
  preview: false,
  nodeFields: [
    { key: "tag", label: "Tag", type: "text" },
    {
      key: "type",
      label: "Type",
      type: "select",
      options: [
        { value: "NORMAL", label: "Normal" },
        { value: "REVERSE", label: "Reverse" },
        { value: "HIGHLIGHT", label: "Highlight" },
      ],
    },
    { key: "msg", label: "Message", type: "text" },
  ],
  newNode: () => ({ label: "New commit" }),
};
