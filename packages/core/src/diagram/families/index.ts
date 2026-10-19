import { FLOWCHART_SHAPES } from "../flowchart/shapes.js";
import { CLASS_RELATIONS } from "../lines-grammar/class.js";
import { ER_CARDINALITIES } from "../lines-grammar/er.js";
import type { ArrowHead, DiagramFamily, DiagramGraph } from "../types.js";
import type { FamilyUI, FieldSpec } from "./types.js";
import { pieUI } from "./pie.js";
import { mindmapUI } from "./mindmap.js";
import { quadrantUI } from "./quadrant.js";
import { c4UI } from "./c4.js";
import { architectureUI } from "./architecture.js";
import { sequenceUI } from "./sequence.js";
import { gitGraphUI } from "./gitgraph.js";
import { ganttUI } from "./gantt.js";
import { timelineUI } from "./timeline.js";
import { journeyUI } from "./journey.js";
import { xyChartUI } from "./xychart.js";
import { radarUI } from "./radar.js";

/**
 * Per-family vocabulary: the shapes, edge kinds and data fields each family offers, its
 * starter sources and titles. Inspectors and toolbars build on it, and the diagram agent
 * tools check `setNodeData` / `setEdgeData` / `setGraphData` keys against its fields.
 * Framework-free data; ported from Ursula's `src/react/families.ts`.
 *
 * @module
 */

export * from "./types.js";
export { pieUI, mindmapUI, quadrantUI, c4UI, architectureUI, sequenceUI, gitGraphUI, ganttUI, timelineUI, journeyUI, xyChartUI, radarUI };

function counterId(prefix: string, graph: DiagramGraph): string {
  const taken = new Set([...graph.nodes.map((n) => n.id), ...graph.groups.map((g) => g.id)]);
  let i = graph.nodes.length + 1;
  while (taken.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

const FLOW_HEADS: { value: ArrowHead; label: string }[] = [
  { value: "none", label: "None" },
  { value: "arrow_point", label: "Arrow" },
  { value: "arrow_circle", label: "Circle" },
  { value: "arrow_cross", label: "Cross" },
];

/** Mermaid's image-node keys (`A@{ img: "…", pos, w, h, constraint }`), on image nodes only. */
const IMAGE_FIELDS: FieldSpec[] = [
  {
    key: "img",
    label: "Image URL",
    type: "text",
    placeholder: "https://…/picture.png",
    shapes: ["image"],
  },
  {
    key: "pos",
    label: "Label",
    type: "select",
    options: [
      { value: "b", label: "Below" },
      { value: "t", label: "Above" },
    ],
    shapes: ["image"],
  },
  { key: "w", label: "Width", type: "number", min: 8, step: 1, shapes: ["image"] },
  { key: "h", label: "Height", type: "number", min: 8, step: 1, shapes: ["image"] },
  {
    key: "constraint",
    label: "Keep aspect ratio",
    type: "select",
    options: [
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ],
    shapes: ["image"],
  },
];

export const flowchartUI: FamilyUI = {
  family: "flowchart",
  nodeFields: IMAGE_FIELDS,
  title: "Flowchart",
  shapes: FLOWCHART_SHAPES.map((s) => ({ value: s.name, label: s.title, category: s.category })),
  edgeKinds: [
    {
      value: "arrow",
      label: "Arrow",
      arrowStart: "none",
      arrowEnd: "arrow_point",
      pattern: "solid",
    },
    { value: "open", label: "Line", arrowStart: "none", arrowEnd: "none", pattern: "solid" },
    {
      value: "dotted",
      label: "Dotted arrow",
      arrowStart: "none",
      arrowEnd: "arrow_point",
      pattern: "dotted",
    },
    {
      value: "thick",
      label: "Thick arrow",
      arrowStart: "none",
      arrowEnd: "arrow_point",
      pattern: "thick",
    },
    {
      value: "bidir",
      label: "Bidirectional",
      arrowStart: "arrow_point",
      arrowEnd: "arrow_point",
      pattern: "solid",
    },
    {
      value: "invisible",
      label: "Invisible (layout)",
      arrowStart: "none",
      arrowEnd: "none",
      pattern: "invisible",
    },
  ],
  patterns: [
    { value: "solid", label: "Solid" },
    { value: "dotted", label: "Dotted" },
    { value: "thick", label: "Thick" },
    { value: "invisible", label: "Invisible" },
  ],
  arrowHeads: FLOW_HEADS,
  groups: { supported: true, label: "Subgraph" },
  labels: true,
  nodeNoun: "Node",
  nextId: (g) => counterId("n", g),
  canDetach: false,
};

export const stateUI: FamilyUI = {
  family: "state",
  title: "State diagram",
  shapes: [
    { value: "rect", label: "State" },
    { value: "choice", label: "Choice" },
    { value: "fork", label: "Fork" },
    { value: "join", label: "Join" },
  ],
  edgeKinds: [
    {
      value: "transition",
      label: "Transition",
      arrowStart: "none",
      arrowEnd: "arrow_barb",
      pattern: "solid",
    },
  ],
  patterns: [{ value: "solid", label: "Solid" }],
  arrowHeads: [{ value: "arrow_barb", label: "Arrow" }],
  groups: { supported: true, label: "Composite state" },
  labels: true,
  nodeNoun: "State",
  nextId: (g) => counterId("State", g),
  canDetach: true,
};

export const classUI: FamilyUI = {
  family: "class",
  title: "Class diagram",
  shapes: [{ value: "classBox", label: "Class" }],
  edgeKinds: CLASS_RELATIONS.filter((r) => !r.title.includes("reversed")).map((r) => ({
    value: r.token,
    label: r.title,
    arrowStart: r.arrowStart,
    arrowEnd: r.arrowEnd,
    pattern: r.pattern,
  })),
  patterns: [
    { value: "solid", label: "Solid" },
    { value: "dotted", label: "Dashed" },
  ],
  arrowHeads: [
    { value: "none", label: "None" },
    { value: "extension", label: "Inheritance" },
    { value: "composition", label: "Composition" },
    { value: "aggregation", label: "Aggregation" },
    { value: "dependency", label: "Arrow" },
    { value: "lollipop", label: "Lollipop" },
  ],
  groups: { supported: true, label: "Namespace" },
  labels: true,
  nodeNoun: "Class",
  nextId: (g) => counterId("Class", g),
  canDetach: true,
};

export const erUI: FamilyUI = {
  family: "er",
  title: "Entity relationship",
  shapes: [{ value: "erBox", label: "Entity" }],
  edgeKinds: [
    {
      value: "one-many",
      label: "One to many",
      arrowStart: "only_one",
      arrowEnd: "zero_or_more",
      pattern: "solid",
    },
    {
      value: "one-one",
      label: "One to one",
      arrowStart: "only_one",
      arrowEnd: "only_one",
      pattern: "solid",
    },
    {
      value: "many-many",
      label: "Many to many",
      arrowStart: "zero_or_more",
      arrowEnd: "zero_or_more",
      pattern: "solid",
    },
    {
      value: "one-many-ni",
      label: "One to many (non-identifying)",
      arrowStart: "only_one",
      arrowEnd: "zero_or_more",
      pattern: "dotted",
    },
  ],
  patterns: [
    { value: "solid", label: "Identifying" },
    { value: "dotted", label: "Non-identifying" },
  ],
  arrowHeads: Array.from(
    new Map(ER_CARDINALITIES.map((c) => [c.head, { value: c.head, label: c.title }])).values(),
  ),
  groups: { supported: false, label: "Group" },
  labels: true,
  nodeNoun: "Entity",
  nextId: (g) => counterId("ENTITY_", g),
  canDetach: true,
};

const FAMILY_UI: Partial<Record<DiagramFamily, FamilyUI>> = {
  flowchart: flowchartUI,
  state: stateUI,
  class: classUI,
  er: erUI,
  pie: pieUI,
  mindmap: mindmapUI,
  quadrant: quadrantUI,
  c4: c4UI,
  architecture: architectureUI,
  sequence: sequenceUI,
  gitGraph: gitGraphUI,
  gantt: ganttUI,
  timeline: timelineUI,
  journey: journeyUI,
  xychart: xyChartUI,
  radar: radarUI,
};

export function familyUI(family: DiagramFamily): FamilyUI | null {
  return FAMILY_UI[family] ?? null;
}

export const FAMILY_TITLES: Record<DiagramFamily, string> = {
  flowchart: "Flowchart",
  state: "State diagram",
  class: "Class diagram",
  er: "Entity relationship",
  requirement: "Requirement diagram",
  mindmap: "Mind map",
  sequence: "Sequence diagram",
  gantt: "Gantt chart",
  pie: "Pie chart",
  journey: "User journey",
  timeline: "Timeline",
  gitGraph: "Git graph",
  c4: "C4 diagram",
  quadrant: "Quadrant chart",
  sankey: "Sankey diagram",
  xychart: "XY chart",
  block: "Block diagram",
  architecture: "Architecture diagram",
  packet: "Packet diagram",
  kanban: "Kanban board",
  radar: "Radar chart",
  treemap: "Treemap",
  info: "Info",
  unknown: "Unknown diagram",
};

/** Starter sources for new documents, by family. */
export const FAMILY_TEMPLATES: Partial<Record<DiagramFamily, string>> = {
  flowchart:
    "flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]\n  C --> E[End]\n  D --> E\n",
  state:
    "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Active : start\n  Active --> Idle : stop\n  Active --> [*] : finish\n",
  class:
    'classDiagram\n  class Account {\n    +String id\n    +deposit(amount)\n  }\n  class Customer\n  Customer "1" --> "*" Account : owns\n',
  er: "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains\n  CUSTOMER {\n    string name PK\n    string email\n  }\n",
  sequence:
    "sequenceDiagram\n  participant U as User\n  participant S as Service\n  U->>S: Request\n  S-->>U: Response\n",
  pie: 'pie showData\n  title Share by segment\n  "Segment A" : 40\n  "Segment B" : 35\n  "Segment C" : 25\n',
  mindmap: "mindmap\n  root((Central idea))\n    Topic A\n      Detail\n    Topic B\n    Topic C\n",
  timeline:
    "timeline\n  title Milestones\n  2024 : First release\n  2025 : Second release\n       : Expansion\n  2026 : Next chapter\n",
  journey:
    "journey\n  title Customer journey\n  section Discover\n    Find the product: 3: Customer\n  section Buy\n    Check out: 4: Customer\n    Confirm order: 5: Customer, Support\n",
  gantt:
    "gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Phase 1\n    Research :a1, 2026-01-05, 10d\n    Design :a2, after a1, 7d\n  section Phase 2\n    Build :a3, after a2, 14d\n",
  gitGraph:
    'gitGraph\n  commit id: "init"\n  branch develop\n  checkout develop\n  commit id: "feature"\n  checkout main\n  merge develop tag: "v1.0"\n',
  c4: 'C4Context\n  title System context\n  Person(user, "User", "Uses the system")\n  System(sys, "System", "Does the work")\n  System_Ext(ext, "External service", "Provides data")\n  Rel(user, sys, "Uses")\n  Rel(sys, ext, "Calls")\n',
  architecture:
    "architecture-beta\n  group app(cloud)[Application]\n  service web(server)[Web] in app\n  service db(database)[Database] in app\n  service edge(internet)[Edge]\n  edge:R --> L:web\n  web:B --> T:db\n",
  quadrant:
    "quadrantChart\n  title Prioritisation\n  x-axis Low effort --> High effort\n  y-axis Low value --> High value\n  quadrant-1 Plan\n  quadrant-2 Do first\n  quadrant-3 Drop\n  quadrant-4 Fill-ins\n  Idea A: [0.3, 0.8]\n  Idea B: [0.7, 0.6]\n  Idea C: [0.2, 0.3]\n",
  xychart:
    'xychart-beta\n  title "Monthly sales"\n  x-axis [Jan, Feb, Mar, Apr]\n  y-axis "Units" 0 --> 100\n  bar [42, 58, 71, 64]\n  line "Target" [50, 55, 60, 65]\n',
  radar:
    'radar-beta\n  title Option comparison\n  axis cost["Cost"], speed["Speed"], quality["Quality"], risk["Risk"]\n  curve a["Option A"]{80, 60, 90, 40}\n  curve b["Option B"]{50, 90, 60, 70}\n  max 100\n',
};

/**
 * The smallest source for each family in {@link FAMILY_TEMPLATES}: an empty
 * canvas Mermaid still accepts (class diagrams need a statement, C4 a title).
 * For "start blank" flows where the user or an agent fills the diagram in.
 */
export const FAMILY_BLANKS: Partial<Record<DiagramFamily, string>> = {
  flowchart: "flowchart TD\n",
  state: "stateDiagram-v2\n",
  class: "classDiagram\n  direction TB\n",
  er: "erDiagram\n",
  sequence: "sequenceDiagram\n",
  pie: "pie\n",
  mindmap: "mindmap\n",
  timeline: "timeline\n",
  journey: "journey\n",
  gantt: "gantt\n  dateFormat YYYY-MM-DD\n",
  gitGraph: "gitGraph\n",
  c4: "C4Context\n  title System context\n",
  architecture: "architecture-beta\n",
  quadrant: "quadrantChart\n",
  xychart: "xychart-beta\n",
  radar: "radar-beta\n",
};

/** One line on what each family in {@link FAMILY_TEMPLATES} is for, for type pickers. */
export const FAMILY_DESCRIPTIONS: Partial<Record<DiagramFamily, string>> = {
  flowchart: "Steps, decisions and the paths between them.",
  state: "The states something moves through and what triggers each change.",
  class: "Types with their fields and methods, and how they relate.",
  er: "Entities, their attributes and the relationships between them.",
  sequence: "Messages exchanged between participants over time.",
  pie: "Parts of a whole as slices.",
  mindmap: "Ideas branching out from a central topic.",
  timeline: "Events grouped by period, in order.",
  journey: "A user's tasks, section by section, scored by how they feel.",
  gantt: "Tasks on a calendar with durations and dependencies.",
  gitGraph: "Branches, commits and merges of a repository.",
  c4: "People and software systems, and how they interact.",
  architecture: "Services and infrastructure grouped by where they run.",
  quadrant: "Items placed on two axes in four quadrants.",
  xychart: "Bars and lines over categories or a numeric axis.",
  radar: "Scores across several axes, one curve per item compared.",
};
export * from "./fields.js";
