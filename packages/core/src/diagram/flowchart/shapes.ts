/**
 * Flowchart shape vocabulary.
 *
 * Mermaid has two ways to express a shape: classic bracket syntax (`A[text]`)
 * and the `@{ shape: … }` data syntax introduced in v11. the diagram module normalises
 * both to the *short name* used by the data syntax (`rect`, `diam`, `cyl`…),
 * which is also what Mermaid's `getData()` reports for data-syntax nodes.
 *
 * @module
 */

export interface BracketForm {
  open: string;
  close: string;
}

export interface ShapeDef {
  /** Canonical short name (what `@{ shape: … }` expects). */
  name: string;
  /** Human-readable name for UIs. */
  title: string;
  /** Alternative names accepted by Mermaid's data syntax. */
  aliases: string[];
  /** Classic bracket syntax when one exists. */
  bracket?: BracketForm;
  /** Broad visual category, handy for toolbars. */
  category: "basic" | "process" | "data" | "control" | "misc";
}

export const FLOWCHART_SHAPES: ShapeDef[] = [
  {
    name: "rect",
    title: "Rectangle",
    aliases: ["rectangle", "proc", "process", "squareRect", "square"],
    bracket: { open: "[", close: "]" },
    category: "basic",
  },
  {
    name: "rounded",
    title: "Rounded rectangle",
    aliases: ["rounded-rectangle", "event", "roundedRect", "round"],
    bracket: { open: "(", close: ")" },
    category: "basic",
  },
  {
    name: "stadium",
    title: "Stadium",
    aliases: ["pill", "terminal"],
    bracket: { open: "([", close: "])" },
    category: "basic",
  },
  {
    name: "subproc",
    title: "Subprocess",
    aliases: ["subprocess", "subroutine", "framed-rectangle", "fr-rect"],
    bracket: { open: "[[", close: "]]" },
    category: "process",
  },
  {
    name: "cyl",
    title: "Cylinder (database)",
    aliases: ["cylinder", "database", "db"],
    bracket: { open: "[(", close: ")]" },
    category: "data",
  },
  {
    name: "circle",
    title: "Circle",
    aliases: ["circ"],
    bracket: { open: "((", close: "))" },
    category: "basic",
  },
  {
    name: "odd",
    title: "Asymmetric",
    aliases: ["asymmetric", "rect_left_inv_arrow"],
    bracket: { open: ">", close: "]" },
    category: "misc",
  },
  {
    name: "diam",
    title: "Diamond (decision)",
    aliases: ["diamond", "decision", "question"],
    bracket: { open: "{", close: "}" },
    category: "control",
  },
  {
    name: "hex",
    title: "Hexagon (prepare)",
    aliases: ["hexagon", "prepare"],
    bracket: { open: "{{", close: "}}" },
    category: "process",
  },
  {
    name: "lean-r",
    title: "Parallelogram (lean right)",
    aliases: ["lean-right", "in-out", "lean_right"],
    bracket: { open: "[/", close: "/]" },
    category: "data",
  },
  {
    name: "lean-l",
    title: "Parallelogram (lean left)",
    aliases: ["lean-left", "out-in", "lean_left"],
    bracket: { open: "[\\", close: "\\]" },
    category: "data",
  },
  {
    name: "trap-b",
    title: "Trapezoid (base bottom)",
    aliases: ["trapezoid-bottom", "priority", "trapezoid"],
    bracket: { open: "[/", close: "\\]" },
    category: "process",
  },
  {
    name: "trap-t",
    title: "Trapezoid (base top)",
    aliases: ["trapezoid-top", "manual", "inv_trapezoid"],
    bracket: { open: "[\\", close: "/]" },
    category: "process",
  },
  {
    name: "dbl-circ",
    title: "Double circle",
    aliases: ["double-circle", "doublecircle"],
    bracket: { open: "(((", close: ")))" },
    category: "basic",
  },
  // Data-syntax-only shapes
  { name: "text", title: "Text", aliases: [], category: "misc" },
  {
    name: "card",
    title: "Card (notched rectangle)",
    aliases: ["notched-rectangle", "notch-rect"],
    category: "misc",
  },
  {
    name: "lin-rect",
    title: "Lined rectangle (shaded process)",
    aliases: ["lined-rectangle", "lin-proc", "lined-process", "shaded-process"],
    category: "process",
  },
  {
    name: "sm-circ",
    title: "Small circle (start)",
    aliases: ["small-circle", "start"],
    category: "control",
  },
  {
    name: "fr-circ",
    title: "Framed circle (stop)",
    aliases: ["framed-circle", "stop"],
    category: "control",
  },
  { name: "fork", title: "Fork / join", aliases: ["join"], category: "control" },
  { name: "hourglass", title: "Hourglass (collate)", aliases: ["collate"], category: "process" },
  {
    name: "brace",
    title: "Comment (left brace)",
    aliases: ["brace-l", "comment"],
    category: "misc",
  },
  { name: "brace-r", title: "Comment (right brace)", aliases: [], category: "misc" },
  { name: "braces", title: "Comment (both braces)", aliases: [], category: "misc" },
  {
    name: "bolt",
    title: "Lightning bolt (com link)",
    aliases: ["com-link", "lightning-bolt"],
    category: "misc",
  },
  { name: "doc", title: "Document", aliases: ["document"], category: "data" },
  {
    name: "delay",
    title: "Delay (half-rounded rectangle)",
    aliases: ["half-rounded-rectangle"],
    category: "process",
  },
  {
    name: "h-cyl",
    title: "Horizontal cylinder (direct access)",
    aliases: ["das", "horizontal-cylinder"],
    category: "data",
  },
  {
    name: "lin-cyl",
    title: "Lined cylinder (disk storage)",
    aliases: ["disk", "lined-cylinder"],
    category: "data",
  },
  {
    name: "curv-trap",
    title: "Curved trapezoid (display)",
    aliases: ["curved-trapezoid", "display"],
    category: "misc",
  },
  {
    name: "div-rect",
    title: "Divided rectangle",
    aliases: ["div-proc", "divided-process", "divided-rectangle"],
    category: "process",
  },
  {
    name: "tri",
    title: "Triangle (extract)",
    aliases: ["extract", "triangle"],
    category: "process",
  },
  {
    name: "win-pane",
    title: "Window pane (internal storage)",
    aliases: ["internal-storage", "window-pane"],
    category: "data",
  },
  {
    name: "f-circ",
    title: "Filled circle (junction)",
    aliases: ["filled-circle", "junction"],
    category: "control",
  },
  { name: "lin-doc", title: "Lined document", aliases: ["lined-document"], category: "data" },
  { name: "notch-rect", title: "Notched rectangle (card)", aliases: [], category: "misc" },
  { name: "flag", title: "Flag (paper tape)", aliases: ["paper-tape"], category: "data" },
  {
    name: "docs",
    title: "Stacked documents",
    aliases: ["documents", "st-doc", "stacked-document"],
    category: "data",
  },
  {
    name: "st-rect",
    title: "Stacked rectangles",
    aliases: ["processes", "procs", "stacked-rectangle"],
    category: "process",
  },
  {
    name: "bow-rect",
    title: "Bow-tie rectangle (stored data)",
    aliases: ["bow-tie-rectangle", "stored-data"],
    category: "data",
  },
  {
    name: "cross-circ",
    title: "Crossed circle (summary)",
    aliases: ["crossed-circle", "summary"],
    category: "process",
  },
  { name: "tag-doc", title: "Tagged document", aliases: ["tagged-document"], category: "data" },
  {
    name: "tag-rect",
    title: "Tagged rectangle",
    aliases: ["tag-proc", "tagged-process", "tagged-rectangle"],
    category: "process",
  },
  {
    name: "notch-pent",
    title: "Notched pentagon (loop limit)",
    aliases: ["loop-limit", "notched-pentagon"],
    category: "control",
  },
  {
    name: "flip-tri",
    title: "Flipped triangle (manual file)",
    aliases: ["flipped-triangle", "manual-file"],
    category: "data",
  },
  {
    name: "sl-rect",
    title: "Sloped rectangle (manual input)",
    aliases: ["manual-input", "sloped-rectangle"],
    category: "data",
  },
  { name: "icon", title: "Icon", aliases: [], category: "misc" },
  { name: "image", title: "Image", aliases: ["img"], category: "misc" },
  { name: "anchor", title: "Anchor (invisible)", aliases: [], category: "misc" },
];

const BY_NAME = new Map<string, ShapeDef>();
for (const def of FLOWCHART_SHAPES) {
  BY_NAME.set(def.name, def);
  for (const alias of def.aliases) BY_NAME.set(alias, def);
}

/** Resolves any accepted shape name/alias (or Mermaid `getData()` id) to its definition. */
export function resolveShape(name: string | undefined): ShapeDef | undefined {
  if (!name) return undefined;
  return BY_NAME.get(name) ?? BY_NAME.get(name.toLowerCase());
}

/** Canonical short name for any alias; unknown names pass through unchanged. */
export function canonicalShape(name: string | undefined): string {
  if (!name) return "rect";
  return resolveShape(name)?.name ?? name;
}

/**
 * Bracket openers ordered longest-first so that greedy matching finds
 * `(((` before `((` before `(`.
 */
export const BRACKET_OPENERS: string[] = Array.from(
  new Set(FLOWCHART_SHAPES.filter((s) => s.bracket).map((s) => s.bracket!.open)),
).sort((a, b) => b.length - a.length);

/** Closers that can follow a given opener (e.g. `[/` may close with `/]` or `\]`). */
export function closersFor(open: string): string[] {
  return FLOWCHART_SHAPES.filter((s) => s.bracket?.open === open)
    .map((s) => s.bracket!.close)
    .sort((a, b) => b.length - a.length);
}

export function shapeForBracket(open: string, close: string): ShapeDef | undefined {
  return FLOWCHART_SHAPES.find((s) => s.bracket?.open === open && s.bracket.close === close);
}

/** Default label Mermaid shows for a node declared without text: the id itself. */
export const DEFAULT_SHAPE = "rect";
