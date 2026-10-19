import type { DiagramGraph } from "../types.js";
import type { EdgeKindOption, FamilyUI } from "./types.js";

/** Suggests `P1`, `P2`… skipping ids already used by participants or boxes. */
function nextParticipantId(graph: DiagramGraph): string {
  const taken = new Set([...graph.nodes.map((n) => n.id), ...graph.groups.map((g) => g.id)]);
  let i = 1;
  while (taken.has(`P${i}`)) i++;
  return `P${i}`;
}

const kind = (
  value: string,
  label: string,
  pattern: EdgeKindOption["pattern"],
  arrowEnd: EdgeKindOption["arrowEnd"],
  arrowStart: EdgeKindOption["arrowStart"] = "none",
): EdgeKindOption => ({ value, label, pattern, arrowStart, arrowEnd });

/** Toolbar / inspector vocabulary for `sequenceDiagram`. */
export const sequenceUI: FamilyUI = {
  family: "sequence",
  title: "Sequence diagram",
  shapes: [
    { value: "rect", label: "Participant" },
    { value: "actor", label: "Actor" },
  ],
  edgeKinds: [
    kind("->>", "Sync", "solid", "arrow_point"),
    kind("-->>", "Reply", "dotted", "arrow_point"),
    kind("->", "Line", "solid", "none"),
    kind("-->", "Dotted line", "dotted", "none"),
    kind("-x", "Lost", "solid", "arrow_cross"),
    kind("--x", "Dotted lost", "dotted", "arrow_cross"),
    kind("-)", "Async", "solid", "arrow_open"),
    kind("--)", "Dotted async", "dotted", "arrow_open"),
    kind("<<->>", "Bidirectional", "solid", "arrow_point", "arrow_point"),
  ],
  patterns: [
    { value: "solid", label: "Solid" },
    { value: "dotted", label: "Dotted" },
  ],
  arrowHeads: [
    { value: "none", label: "None" },
    { value: "arrow_point", label: "Arrow" },
    { value: "arrow_cross", label: "Cross" },
    { value: "arrow_open", label: "Open" },
  ],
  groups: { supported: true, label: "Box" },
  labels: true,
  nodeNoun: "Participant",
  edgeNoun: "Message",
  nextId: nextParticipantId,
  canDetach: true,
  styling: false,
  directions: false,
  arrange: false,
  endpoints: true,
  preview: false,
  edgeFields: [
    { key: "activate", label: "Activate target", type: "boolean" },
    { key: "deactivate", label: "Deactivate source", type: "boolean" },
    { key: "index", label: "Position (0 = first)", type: "number", min: 0 },
  ],
  diagramFields: [{ key: "autonumber", label: "Number messages", type: "boolean" }],
  newNode: () => ({ label: "New participant" }),
};
