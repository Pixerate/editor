import type { AgentScript, AgentScriptContext } from "./agentScript";
import { pngDataUrl } from "@pixerate/editor/raster";

// One or two scripted requests per editor. Every step is a real tool call through the demo's
// ToolRegistry (the same tools listed in "Agent tools for this editor"); later steps take ids and
// positions from earlier results, as a model would. Text edits need no pointer target: the text
// tools draw the agent's caret inline and type replacements out.

/** The first match of a `find_text` result. */
const firstMatch = (ctx: AgentScriptContext, key: string) => {
  const match = ctx.results[key]?.matches?.[0];
  if (!match) throw new Error(`find_text found nothing for "${key}"; the text was edited since the demo loaded.`);
  return match as { from: number; to: number; text: string };
};

/** Runs a command through the command tools (`commands__run_command`). */
const command = (id: string, params?: Record<string, unknown>) => ({
  tool: "commands__run_command",
  args: params ? { id, params } : { id },
});

/** A command whose params use an earlier step's result (`ctx.results[as].result`). */
const commandWith = (id: string, params: (result: (key: string) => any) => Record<string, unknown>) => ({
  tool: "commands__run_command",
  args: (ctx: AgentScriptContext) => ({ id, params: params((key) => ctx.results[key]?.result) }),
});

export const PROMPT_SCRIPTS: AgentScript[] = [
  {
    id: "prompt-noir",
    prompt: "Make this a moody film-noir shot",
    steps: [
      { say: "Reading the prompt and its fields first.", tool: "prompt__get_text", args: { format: "text" } },
      { say: "Swapping the style for film noir.", tool: "prompt__find_text", args: { query: "photorealistic portrait" }, as: "style" },
      {
        tool: "prompt__replace_range",
        args: (ctx) => ({ ...pick(firstMatch(ctx, "style")), text: "rain-soaked film-noir portrait" }),
      },
      { say: "Adding lighting after the composition, leaving the variables alone.", tool: "prompt__find_text", args: { query: "composition" }, as: "composition" },
      {
        tool: "prompt__insert_text",
        args: (ctx) => ({ at: firstMatch(ctx, "composition").to, text: ", low-key lighting, neon signs reflected in wet asphalt" }),
      },
      { say: "Checking the result.", tool: "prompt__get_text", args: { format: "text" } },
    ],
  },
];

const pick = (m: { from: number; to: number }) => ({ from: m.from, to: m.to });

export const DOCUMENT_SCRIPTS: AgentScript[] = [
  {
    id: "doc-chart",
    prompt: "Tighten the intro and chart the features per package",
    steps: [
      { say: "Reading the document.", tool: "doc__get_text", args: { format: "text" } },
      { say: "The intro sentence is vague; making it concrete.", tool: "doc__find_text", args: { query: "standard document rich text capabilities" }, as: "intro" },
      {
        tool: "doc__replace_range",
        args: (ctx) => ({ ...pick(firstMatch(ctx, "intro")), text: "tables, charts, footnotes, review and Word import" }),
      },
      { say: "Now a chart, placed just before the Charts paragraph.", tool: "doc__find_text", args: { query: "Charts are live document nodes" }, as: "charts" },
      {
        tool: "doc__insert_chart",
        args: (ctx) => ({
          at: firstMatch(ctx, "charts").from - 1,
          spec: {
            type: "bar",
            title: "Editor features by package",
            categories: ["Text", "Tables", "Charts", "Review"],
            series: [
              { name: "React", values: [14, 9, 13, 6] },
              { name: "Svelte", values: [14, 9, 13, 6] },
            ],
          },
        }),
        target: { text: "Charts are live document nodes" },
      },
      { say: "Confirming the chart is in the document.", tool: "doc__list_document_charts", args: {} },
    ],
  },
];

/** Spreadsheet rows (1-based) of the sales table: the rows after the header with a Revenue formula. */
function salesRows(ctx: AgentScriptContext): number[] {
  const raw = ctx.results.data.raw as string[][];
  const rows: number[] = [];
  for (let i = 1; i < raw.length && String(raw[i][5] ?? "").startsWith("="); i++) rows.push(i + 1);
  if (!rows.length) throw new Error("No sales rows found: column F has no Revenue formulas.");
  return rows;
}

export const SHEET_SCRIPTS: AgentScript[] = [
  {
    id: "sheet-commission",
    prompt: "Add a 5% commission column and its total",
    steps: [
      { say: "Reading the sheet to find where the sales rows end.", tool: "sheet__get_range", args: { range: "A1:H19" }, as: "data" },
      {
        say: "Revenue is in column F, so commission goes in H as a formula per sales row.",
        tool: "sheet__set_range",
        args: (ctx) => ({
          start: "H1",
          values: [["Commission"], ...salesRows(ctx).map((row) => [`=F${row}*0.05`])],
        }),
        target: { text: "Status" },
      },
      {
        say: "The total goes on the Total revenue row, beside the other totals.",
        tool: "sheet__set_range",
        args: (ctx) => {
          const rows = salesRows(ctx);
          const totalRow = (ctx.results.data.values as unknown[][]).findIndex((r) => r[0] === "Total revenue") + 1;
          if (totalRow < 1) throw new Error("There is no Total revenue row to put the total on.");
          return { start: `G${totalRow}`, values: [["Total commission", `=SUM(H${rows[0]}:H${rows[rows.length - 1]})`]] };
        },
        target: { text: "Total revenue" },
      },
      { say: "Checking what the formulas computed.", tool: "sheet__get_range", args: { range: "F1:H12" } },
    ],
  },
  {
    id: "sheet-target",
    prompt: "How many units does Fay need to hit target?",
    steps: [
      { say: "Looking up Fay's row.", tool: "sheet__get_range", args: { range: "A7:G7" }, as: "fay" },
      {
        say: "The target is $1,000 at $42 a unit: 24 units. Trying it.",
        tool: "sheet__set_cell",
        args: { cell: "D7", value: 24 },
        target: { text: "Fay" },
      },
      { say: "The status formula should now say On target.", tool: "sheet__get_range", args: { range: "D7:G7" } },
    ],
  },
];

/**
 * A control in the chart inspector, scrolled into view first: the inspector scrolls on its own, so
 * the control may be outside it. Value drags have no target, since the chart's director draws them.
 */
function inspectorControl(selector: string) {
  return (stage: HTMLElement) => {
    const el = stage.querySelector(`[data-chart-inspector] ${selector}`);
    el?.scrollIntoView({ block: "nearest" });
    return el;
  };
}

export const CHART_SCRIPTS: AgentScript[] = [
  {
    id: "chart-compose",
    prompt: "Compose a quarterly revenue chart with a trend",
    steps: [
      {
        say: "Starting from the data: two channels over four quarters.",
        tool: "chart__set_chart_data",
        args: {
          categories: ["Q1", "Q2", "Q3", "Q4"],
          series: [
            { name: "Online", values: [42, 51, 58, 73] },
            { name: "Retail", values: [38, 36, 40, 39] },
          ],
        },
        as: "data",
        target: { selector: "[data-chart-grid]" },
      },
      { say: "A grouped bar chart with titles.", tool: "chart__update_chart", args: { type: "bar", title: "Revenue by quarter", subtitle: "$k, 2026" }, target: inspectorControl('[data-chart-type="bar"]') },
      {
        say: "Online is the growth story, so it gets a linear trend.",
        tool: "chart__add_chart_trendline",
        args: (ctx) => ({ series: seriesId(ctx.results.data, "Online"), type: "linear", showR2: true }),
        target: { selector: "[data-chart-canvas]" },
      },
      { say: "Colour-blind safe palette, presentation layout.", tool: "chart__apply_chart_preset", args: { layout: "presentation", colors: "okabe-ito" }, target: inspectorControl('[data-option="preset.colors"]') },
      { say: "Rendering it to check how it reads.", tool: "chart__render_chart", args: { format: "png" }, target: { selector: '[data-action="download-png"]' } },
    ],
  },
  {
    id: "chart-bump",
    prompt: "Raise the first three values by 15%",
    steps: [
      { say: "Reading the chart.", tool: "chart__get_chart", args: {}, as: "chart" },
      {
        say: "Dragging each value into place.",
        tool: "chart__set_chart_values",
        args: (ctx) => {
          const spec = ctx.results.chart.spec ?? ctx.results.chart;
          const series = (spec.series as any[]).find((s) => !s.hidden && s.axis !== "secondary");
          if (!series) throw new Error("There is no visible series to change.");
          return {
            cells: (series.values as (number | null)[]).slice(0, 3).map((v, category) => ({ series: series.id, category, value: Math.round((v ?? 0) * 1.15) })),
          };
        },
      },
      {
        say: "Saying so in the title.",
        tool: "chart__update_chart",
        args: (ctx) => ({ title: `${(ctx.results.chart.spec ?? ctx.results.chart).title || "Chart"} (+15%)` }),
        target: inspectorControl('[data-option="title"]'),
      },
    ],
  },
];

/** A series id from a `set_chart_data` / `get_chart` result, by name. */
function seriesId(result: any, name: string): string {
  const list: any[] = result?.series ?? result?.spec?.series ?? [];
  const found = list.find((s) => s.name === name) ?? list[0];
  if (!found) throw new Error(`No series named ${name}.`);
  return found.id;
}

export const CANVAS_SCRIPTS: AgentScript[] = [
  {
    id: "canvas-align",
    prompt: "Line up the main workflow steps",
    steps: [
      { say: "Listing the nodes on the board.", tool: "canvas__list_nodes", args: {}, as: "nodes" },
      {
        say: "Brief, Research, Review and Ship it are the main path; centring them on one line.",
        tool: "canvas__align_nodes",
        args: { edge: "middle", ids: ["brief", "research", "review", "ship"] },
        target: { selector: '.react-flow__node[data-id="research"]' },
      },
      { say: "Done. The sticky note and sketches stay where they were.", tool: "canvas__list_nodes", args: {} },
    ],
  },
];

export const DIAGRAM_SCRIPTS: AgentScript[] = [
  {
    id: "diagram-returns",
    prompt: "Add a returns path to the order flow",
    steps: [
      { say: "Reading the diagram.", tool: "diagram__get_diagram", args: {}, as: "diagram" },
      {
        say: "Returns start after the customer is notified.",
        tool: "diagram__add_diagram_node",
        args: (ctx) => {
          const nodes: any[] = ctx.results.diagram.nodes ?? [];
          const from = nodes.find((n) => n.id === "F")?.id ?? nodes[nodes.length - 1]?.id;
          if (!from) throw new Error("The diagram has no nodes to continue from.");
          return { label: "Return requested", from, edgeLabel: "if unhappy" };
        },
        as: "returned",
      },
      {
        say: "Highlighting it as an exception path.",
        tool: "diagram__set_diagram_node_style",
        args: (ctx) => ({ id: ctx.results.returned.node.id, styles: ["fill:#fde68a", "stroke:#b45309"] }),
      },
      {
        say: "Returned stock goes back to inventory.",
        tool: "diagram__connect_diagram_nodes",
        args: (ctx) => {
          const inventory = (ctx.results.diagram.nodes as any[]).find((n) => n.id === "E")?.id;
          if (!inventory) throw new Error("This diagram has no Inventory node; load the Flowchart sample.");
          return { source: ctx.results.returned.node.id, target: inventory, label: "restock" };
        },
      },
      { tool: "diagram__set_diagram_title", args: { title: "Order flow with returns" } },
    ],
  },
];

/**
 * A box in artwork coordinates, on screen: the artboard is drawn at the document's size, so its
 * rectangle maps document units to the viewport (for shapes that don't exist until the call).
 */
function artboardBox(x: number, y: number, width: number, height: number) {
  return (stage: HTMLElement, ctx: AgentScriptContext) => {
    const board = stage.querySelector("[data-vector-artboard]")?.getBoundingClientRect();
    const doc = ctx.results.doc?.result;
    if (!board || !(doc?.width > 0 && doc?.height > 0)) return null;
    const sx = board.width / doc.width;
    const sy = board.height / doc.height;
    return new DOMRect(board.left + x * sx, board.top + y * sy, width * sx, height * sy);
  };
}

/** A small two-colour "P" badge as a PNG data URL, for the tracing script. */
function badgePng(): string {
  const w = 96;
  const h = 96;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x + 0.5 - 48, y + 0.5 - 48);
      const inBowl = Math.hypot(x + 0.5 - 52, y + 0.5 - 38) <= 16 && Math.hypot(x + 0.5 - 52, y + 0.5 - 38) >= 7;
      const inStem = x >= 30 && x < 40 && y >= 22 && y < 74;
      const inBar = x >= 30 && x < 52 && ((y >= 22 && y < 29) || (y >= 47 && y < 54));
      const c = r > 44 ? [0, 0, 0, 0] : inBowl || inStem || inBar ? [255, 255, 255, 255] : [139, 92, 246, 255];
      data.set(c, (y * w + x) * 4);
    }
  }
  return pngDataUrl(w, h, data);
}

export const VECTOR_SCRIPTS: AgentScript[] = [
  {
    id: "vector-night",
    prompt: "Turn the scene into night",
    steps: [
      { say: "Listing the artwork's shapes.", ...command("vector.list"), as: "doc", target: { selector: "[data-vector-artboard]" } },
      {
        say: "The sun becomes a pale moon: same radial gradient, cooler stops.",
        ...command("vector.setGradient", {
          ids: ["sun"],
          target: "fill",
          type: "radial",
          stops: [
            { offset: 0, color: "#f8fafc" },
            { offset: 0.6, color: "#e2e8f0" },
            { offset: 1, color: "#64748b" },
          ],
        }),
        target: { selector: '[data-vector-id="sun"]' },
      },
      { say: "Darkening the hill.", ...command("vector.setStyle", { ids: ["hill"], fill: "#14532d", stroke: "#052e16" }), target: { selector: '[data-vector-id="hill"]' } },
      { say: "A few stars in the sky.", ...command("vector.addShape", { kind: "star", x: 360, y: 40, width: 26, height: 26, points: 5, innerRatio: 0.45, fill: "#fde68a", name: "Star" }), target: artboardBox(360, 40, 26, 26) },
      { ...command("vector.addShape", { kind: "star", x: 440, y: 120, width: 18, height: 18, points: 5, innerRatio: 0.45, fill: "#fef3c7", name: "Star" }), target: artboardBox(440, 120, 18, 18) },
      { ...command("vector.addShape", { kind: "star", x: 520, y: 30, width: 14, height: 14, points: 5, innerRatio: 0.45, fill: "#fef9c3", name: "Star" }), target: artboardBox(520, 30, 14, 14) },
    ],
  },
  {
    id: "vector-appearance",
    prompt: "Make the yellow star pop",
    steps: [
      { say: "Reading the star's appearance.", ...command("vector.getAppearance", { id: "star" }), target: { selector: '[data-vector-id="star"]' } },
      { say: "A warm glow fill multiplied over the yellow.", ...command("vector.addFill", { ids: ["star"], paint: "#fb923c", opacity: 0.6, blendMode: "multiply" }), target: { selector: '[data-vector-id="star"]' } },
      { say: "A dark outline outside the shape…", ...command("vector.addStroke", { ids: ["star"], paint: "#78350f", strokeWidth: 4, strokeAlign: "outside", strokeLinejoin: "round" }), target: { selector: '[data-vector-id="star"]' } },
      { say: "…and a thin white one inside it.", ...command("vector.addStroke", { ids: ["star"], paint: "#ffffff", strokeWidth: 1.5, strokeAlign: "inside" }), target: { selector: '[data-vector-id="star"]' } },
      { say: "A soft drop shadow, lit from above.", ...command("vector.addFilter", { ids: ["star"], type: "dropShadow", params: { opacity: 0.35, offsetY: 3, blur: 6 } }), target: { selector: '[data-vector-id="star"]' } },
    ],
  },
  {
    id: "vector-mask",
    prompt: "Frame the colour wheel in a rounded window",
    steps: [
      { say: "Drawing the window over the wheel: it becomes the mask, so its colour won't show.", ...command("vector.addShape", { kind: "rect", x: 724, y: 314, width: 44, height: 44, cornerRadius: 10, name: "Window" }), as: "win", target: artboardBox(724, 314, 44, 44) },
      { say: "Clipping the wheel to it: the topmost object masks the ones below.", ...commandWith("vector.makeClippingMask", (r) => ({ ids: ["wheel", r("win").id] })), as: "clip", target: { selector: '[data-vector-id="wheel"]' } },
      { say: "Turning it into a soft opacity mask instead: a radial fade from white to black.", ...commandWith("vector.setGradient", (r) => ({ ids: [r("win").id], target: "fill", type: "radial", stops: [{ offset: 0.5, color: "#ffffff" }, { offset: 1, color: "#000000" }] })), target: artboardBox(724, 314, 44, 44) },
      { ...commandWith("vector.setMaskOptions", (r) => ({ ids: [r("clip").id], type: "luminance" })), target: artboardBox(716, 306, 60, 60) },
    ],
  },
  {
    id: "vector-text",
    prompt: "Add a title and a curved caption",
    steps: [
      { say: "Checking which fonts the shaper has.", ...command("vector.listFonts") },
      {
        say: "A bold title, centred over the card.",
        ...command("vector.addText", { text: "Hello, hills", x: 190, y: 250, font: { fontFamily: "sans-serif", fontWeight: 700, fontSize: 36 }, paragraph: { align: "center" }, fill: "#0f172a", name: "Title" }),
        as: "title",
        target: artboardBox(80, 215, 220, 45),
      },
      { say: "Colouring the second word.", ...commandWith("vector.setTextStyle", (r) => ({ id: r("title").id, start: 7, end: 12, fill: "#16a34a" })), target: artboardBox(80, 215, 220, 45) },
      { say: "An arc for the caption to follow…", ...command("vector.addPath", { d: "M440 470 C520 400 640 400 720 470", name: "Caption path" }), as: "arc", target: artboardBox(440, 400, 280, 70) },
      {
        say: "…and the caption set along it, centred.",
        ...commandWith("vector.typeOnPath", (r) => ({ pathId: r("arc").id, text: "rolling green since forever", font: { fontSize: 18, italic: true }, paragraph: { align: "center" }, fill: "#14532d" })),
        target: artboardBox(440, 400, 280, 70),
      },
    ],
  },
  {
    id: "vector-symbols",
    prompt: "Plant a row of trees and make them autumn",
    steps: [
      { say: "Reading the document's symbols.", ...command("vector.listSymbols") },
      { say: "Placing three more trees along the hill.", ...command("vector.placeSymbol", { symbolId: "tree", x: 470, y: 330, name: "Tree" }), target: artboardBox(455, 300, 30, 50) },
      { ...command("vector.placeSymbol", { symbolId: "tree", transform: [1.2, 0, 0, 1.2, 520, 322], name: "Tree" }), target: artboardBox(500, 290, 36, 56) },
      { ...command("vector.placeSymbol", { symbolId: "tree", transform: [0.9, 0, 0.1, 0.9, 565, 316], name: "Tree" }), target: artboardBox(550, 290, 30, 46) },
      { say: "Editing the symbol once turns every tree orange.", ...command("vector.editSymbol", { id: "tree" }) },
      { ...command("vector.setStyle", { ids: ["crown"], fill: "#ea580c", stroke: "#7c2d12" }) },
      { say: "Back to the whole drawing.", ...command("vector.exitSymbolEdit"), target: artboardBox(455, 260, 300, 90) },
    ],
  },
  {
    id: "vector-constraints",
    prompt: "Make the card a parametric 2:1 rectangle",
    steps: [
      { say: "Constraining what the card already nearly is: level and upright sides.", ...command("vector.autoConstrain", { ids: ["card"] }), target: { selector: '[data-vector-id="card"]' } },
      { say: "A named width…", ...command("vector.setConstraintValue", { key: "cardW", value: 240 }) },
      { ...command("vector.addConstraint", { kind: "distance", refs: [{ nodeId: "card", subpath: 0, index: 0, segment: true }], value: "cardW", name: "width" }), target: { selector: '[data-vector-id="card"]' } },
      { say: "…and a height that follows it: half the width.", ...command("vector.addConstraint", { kind: "distance", refs: [{ nodeId: "card", subpath: 0, index: 1, segment: true }], value: "cardW / 2", name: "height" }), target: { selector: '[data-vector-id="card"]' } },
      { say: "Changing the width now resizes both.", ...command("vector.setConstraintValue", { key: "cardW", value: 200 }), target: { selector: '[data-vector-id="card"]' } },
      { say: "Checking what is still free to move.", ...command("vector.listConstraints") },
    ],
  },
  {
    id: "vector-frames",
    prompt: "Make a banner that I can resize",
    steps: [
      { say: "A background bar and a badge for the banner…", ...command("vector.addShape", { kind: "rect", x: 440, y: 300, width: 180, height: 12, cornerRadius: 6, fill: "#38bdf8", name: "Bar" }), as: "bar", target: artboardBox(440, 300, 180, 12) },
      { ...command("vector.addShape", { kind: "ellipse", x: 590, y: 250, width: 30, height: 30, fill: "#f43f5e", name: "Badge" }), as: "badge", target: artboardBox(590, 250, 30, 30) },
      {
        say: "…framed together with some padding: the frame is the banner.",
        ...commandWith("vector.frameSelection", (r) => ({ ids: [r("bar").id, r("badge").id], padding: 16, fill: "#0f172a", name: "Banner" })),
        as: "banner",
        target: artboardBox(424, 234, 212, 94),
      },
      { say: "The bar stretches with the banner, the badge stays in its corner.", ...commandWith("vector.setResizing", (r) => ({ ids: [r("bar").id], horizontal: "leftRight", vertical: "bottom" })) },
      { ...commandWith("vector.setResizing", (r) => ({ ids: [r("badge").id], horizontal: "right", vertical: "top" })) },
      { say: "Now a wider banner: the contents follow their constraints.", ...commandWith("vector.setFrame", (r) => ({ ids: [r("banner").id], width: 340, height: 120 })), target: artboardBox(424, 234, 340, 120) },
    ],
  },
  {
    id: "vector-trace",
    prompt: "Trace this badge image into vectors",
    steps: [
      {
        say: "Tracing the badge in colour: a stacked path per colour, smooth curves.",
        ...commandWith("vector.traceImage", () => ({ image: badgePng(), mode: "color", colors: 3, cornerRoundness: 0.8, x: 620, y: 360, width: 120, name: "Badge trace" })),
        as: "trace",
        target: artboardBox(620, 360, 120, 120),
      },
      { say: "Checking what it made.", ...command("vector.list") },
    ],
  },
  {
    id: "vector-shading",
    prompt: "Shade the card with a mesh and the hill with a freeform gradient",
    steps: [
      {
        say: "A 2 × 2 gradient mesh on the card, blue at the top fading to white…",
        ...command("vector.setMeshGradient", { ids: ["card"], rows: 2, columns: 2, corners: ["#bae6fd", "#38bdf8", "#e0f2fe", "#ffffff"] }),
        target: { selector: '[data-vector-id="card"]' },
      },
      { say: "…with its middle point pulled toward the star and brightened.", ...command("vector.setMeshPoint", { id: "card", index: 4, x: 200, y: 120, color: "#fef9c3" }), target: { selector: '[data-vector-id="card"]' } },
      { say: "Freeform colour points across the hill, darker in the dips.", ...command("vector.setFreeformGradient", { ids: ["hill"], colors: ["#15803d", "#4ade80", "#166534", "#86efac"] }), target: { selector: '[data-vector-id="hill"]' } },
      { say: "Checking the points to fine-tune.", ...command("vector.getShading", { id: "hill" }) },
    ],
  },
  {
    id: "vector-connectors",
    prompt: "Connect the card to the sun and the badge",
    steps: [
      { say: "Where can things attach to the card? Checking its connection sites.", ...command("vector.listConnectionSites", { id: "card" }), target: { selector: '[data-vector-id="card"]' } },
      {
        say: "An elbow connector from the card to the sun, with rounded bends…",
        ...command("vector.connect", { start: { nodeId: "card" }, end: { nodeId: "sun" }, route: "elbow", radius: 8, stroke: "#0369a1", strokeWidth: 2 }),
        as: "toSun",
      },
      { say: "…and a curved one down to the badge.", ...command("vector.connect", { start: { nodeId: "card", side: "bottom" }, end: { nodeId: "badge" }, route: "curved", stroke: "#7e22ce", strokeWidth: 2 }), as: "toBadge" },
      { say: "Moving the card: both connectors follow it.", ...command("vector.transform", { ids: ["card", "star"], dx: 40, dy: 30 }), target: { selector: '[data-vector-id="card"]' } },
    ],
  },
];

export const ANIMATION_SCRIPTS: AgentScript[] = [
  {
    id: "animation-finale",
    prompt: "Add a finale where the badge celebrates",
    steps: [
      { say: "Reading the animation: shots, elements and timing.", tool: "animation__get_animation", args: {}, as: "anim" },
      {
        say: "A new shot at the end: the badge pulses twice while the ring turns.",
        tool: "animation__insert_shots",
        args: {
          shots: [
            {
              id: "finale",
              label: "Finale",
              run: [
                { type: "pulse", targets: ["badge"], count: 2, amount: 0.12 },
                { type: "rotate", targets: ["ring"], by: 180, with: "previous", duration: 900 },
              ],
            },
          ],
        },
      },
      {
        say: "Then the check teeters, rocking and settling (Flair's emphasis.teeter).",
        tool: "animation__add_commands",
        args: { shot: "finale", commands: [{ type: "teeter", targets: ["check"], count: 3, angle: 10 }] },
      },
      {
        say: "Moving the teeter first, so the check reacts before the badge celebrates.",
        tool: "animation__move_command",
        args: { shot: "finale", command: 2, to: 0 },
      },
      { say: "Checking for problems before playing it.", tool: "animation__check_animation", args: {} },
      { say: "Playing the finale.", tool: "animation__seek_animation", args: { shot: "finale", play: true }, target: { text: "Finale" } },
    ],
  },
];

export const IMAGE_SCRIPTS: AgentScript[] = [
  {
    id: "image-grade",
    prompt: "Give the photo a warm, punchy grade",
    steps: [
      { say: "Reading the current adjustments.", tool: "image__get_adjustments", args: {} },
      {
        say: "Warming it up and adding contrast, as one undo step.",
        tool: "image__set_adjustments",
        args: { values: { temperature: 28, contrast: 22, exposure: 6 }, label: "Warm, punchy grade" },
        open: "Adjustments",
        target: { text: "Contrast" },
      },
      {
        say: "Vibrance on its own layer, so it can be dialled back later.",
        tool: "image__add_adjustment_layer",
        args: { kind: "vibrance", params: { vibrance: 35 }, name: "Vibrance boost" },
      },
      { say: "Rendering a preview to check it.", tool: "image__render_preview", args: { maxSide: 360 } },
    ],
  },
  {
    id: "image-vignette",
    prompt: "Darken the edges around the centre",
    steps: [
      { say: "Selecting everything to read the image size.", tool: "image__select_region", args: { shape: "all" }, open: "Select & Mask" },
      { tool: "image__get_selection", args: {}, as: "sel" },
      {
        say: "An ellipse over the centre, feathered, then inverted to get the edges.",
        tool: "image__select_region",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return { shape: "ellipse", x: width * 0.12, y: height * 0.1, width: width * 0.76, height: height * 0.8, feather: Math.round(width / 12) };
        },
      },
      { tool: "image__select_region", args: { shape: "invert" } },
      {
        say: "A Hue/Saturation layer masked to the edges darkens them without touching the pixels.",
        tool: "image__apply_selection_as_mask",
        args: { kind: "hueSaturation", params: { lightness: -35 } },
      },
      { say: "Rendering a preview.", tool: "image__render_preview", args: { maxSide: 360 } },
    ],
  },
  {
    id: "image-transform",
    prompt: "Copy the centre onto its own layer and tilt it like a postcard",
    steps: [
      { say: "Selecting everything to read the image size.", tool: "image__select_region", args: { shape: "all" }, open: "Select & Mask" },
      { tool: "image__get_selection", args: {}, as: "sel" },
      {
        say: "A rectangle over the centre.",
        tool: "image__select_region",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return { shape: "rect", x: width * 0.3, y: height * 0.3, width: width * 0.4, height: height * 0.4 };
        },
      },
      {
        say: "Layer via Copy, then scale and rotate the copy in one resample (one undo step).",
        tool: "image__transform_layer",
        args: { content: "selection-copy", scaleX: 80, scaleY: 80, rotate: -8 },
        as: "copy",
      },
      {
        say: "A drop shadow on the copy follows its new shape.",
        tool: "image__add_layer_effect",
        args: (ctx) => ({ layerId: ctx.results.copy.layerId, kind: "drop-shadow", settings: { distance: 8, size: 12, opacity: 0.5 } }),
      },
      { say: "Rendering a preview.", tool: "image__render_preview", args: { maxSide: 360 } },
    ],
  },
  {
    id: "image-color",
    prompt: "Check how this prints on a coated press and give me the CMYK of the brand blue",
    steps: [
      { say: "Reading the document's colour profile.", tool: "image__get_color_profile", args: {}, open: "Layers" },
      {
        say: "Soft-proofing through the coated CMYK profile, with a gamut warning on the colours the press cannot hit.",
        tool: "image__set_proof_setup",
        args: { profile: "coated-cmyk", intent: "relative", gamutWarning: true },
      },
      { say: "Rendering a preview of the proof.", tool: "image__render_preview", args: { maxSide: 360 } },
      {
        say: "The CMYK values for the brand blue and a neutral grey.",
        tool: "image__convert_colors",
        args: { colors: ["#1e40af", "#808080"], to: "coated-cmyk" },
      },
      { say: "Proofing off again; the pixels never changed.", tool: "image__set_proof_setup", args: { off: true } },
    ],
  },
  {
    id: "image-retouch",
    prompt: "Clean up a spot, clone over a patch and lift the midtones",
    steps: [
      { say: "Selecting everything to read the image size.", tool: "image__select_region", args: { shape: "all" } },
      { tool: "image__get_selection", args: {}, as: "sel" },
      { tool: "image__select_region", args: { shape: "none" } },
      { say: "Reading the layers, to find the photo.", tool: "image__list_layers", args: {}, as: "layers" },
      {
        say: "An empty layer for the retouching, so the photo stays untouched.",
        tool: "image__add_pixel_layer",
        args: { name: "Retouch" },
        open: "Paint",
      },
      {
        say: "Spot Healing in the centre, sampling every layer below onto the new one.",
        tool: "image__spot_heal",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return { points: [{ x: width / 2, y: height / 2 }], sample: "all", brush: { size: Math.max(8, Math.round(width / 20)), hardness: 0.5 } };
        },
      },
      {
        say: "The Clone Stamp source: a point on the left, then a short soft stroke on the right.",
        tool: "image__set_clone_source",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return { x: Math.round(width * 0.25), y: Math.round(height * 0.5) };
        },
      },
      {
        tool: "image__clone_stamp",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return {
            points: [{ x: width * 0.62, y: height * 0.45 }, { x: width * 0.72, y: height * 0.5 }],
            sample: "current-below",
            brush: { size: Math.max(10, Math.round(width / 14)), hardness: 0.4 },
          };
        },
      },
      {
        say: "Dodging the midtones of the photo a little, in one gentle stroke.",
        tool: "image__dodge",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return {
            layerId: ctx.results.layers.layers[0].id,
            points: [{ x: width * 0.3, y: height * 0.3 }, { x: width * 0.7, y: height * 0.3 }],
            range: "midtones",
            exposure: 0.25,
            brush: { size: Math.max(16, Math.round(width / 8)), hardness: 0 },
          };
        },
      },
      { say: "Rendering a preview.", tool: "image__render_preview", args: { maxSide: 360 } },
    ],
  },
  {
    id: "image-poster",
    prompt: "Turn the photo into a sale poster with a badge and a headline",
    steps: [
      { say: "Selecting everything to read the image size.", tool: "image__select_region", args: { shape: "all" } },
      { tool: "image__get_selection", args: {}, as: "sel" },
      { tool: "image__select_region", args: { shape: "none" } },
      {
        say: "A rounded banner along the bottom, as a live shape layer.",
        tool: "image__add_shape_layer",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return { shape: { kind: "rect", x: width * 0.08, y: height * 0.7, width: width * 0.84, height: height * 0.2, radius: height * 0.04 }, fill: "#111827cc", name: "Banner" };
        },
        open: "Annotations",
        as: "banner",
      },
      {
        say: "A star badge in the top corner, filled and outlined.",
        tool: "image__add_shape_layer",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          const r = Math.min(width, height) * 0.16;
          return { shape: { kind: "star", x: width - r * 2.3, y: r * 0.3, width: r * 2, height: r * 2, points: 12, innerRatio: 0.78 }, fill: "#f59e0b", stroke: { width: 4, paint: "#ffffff" }, name: "Badge" };
        },
        as: "badge",
      },
      {
        say: "The headline as live text, centred in the banner.",
        tool: "image__add_text_layer",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return { text: "Summer Sale", x: width / 2, y: height * 0.835, style: { fontFamily: "sans-serif", fontWeight: 700, fontSize: Math.round(height * 0.09), color: "#ffffff" }, paragraph: { align: "center" } };
        },
        as: "headline",
      },
      {
        say: "The second word in amber, by range.",
        tool: "image__set_text_style",
        args: (ctx) => ({ layerId: ctx.results.headline.layer.id, start: 7, end: 11, color: "#f59e0b" }),
      },
      {
        say: "A soft shadow under the badge.",
        tool: "image__add_layer_effect",
        args: (ctx) => ({ layerId: ctx.results.badge.layer.id, kind: "drop-shadow", settings: { distance: 6, size: 10, opacity: 0.45 } }),
      },
      { say: "Rendering a preview.", tool: "image__render_preview", args: { maxSide: 360 } },
    ],
  },
];

function imageSize(result: any): { width: number; height: number } {
  const size = result?.bounds;
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!(width > 0 && height > 0)) throw new Error("Nothing is selected; the image may not have loaded yet.");
  return { width, height };
}

export const PARAMETER_SCRIPTS: AgentScript[] = [
  {
    id: "params-neon",
    prompt: "Make it a fast neon ring",
    steps: [
      { say: "Listing the parameters and their ranges.", ...command("parameters.list") },
      { say: "Rings instead of the orb.", ...command("parameters.set", { values: { shape: "rings" } }), target: { text: "Shape" } },
      { say: "Twelve thin rings.", ...command("parameters.set", { values: { count: 12, thickness: 0.2 } }), target: { text: "Rings / bars" } },
      { say: "Faster, with a sharper glow.", ...command("parameters.set", { values: { speed: 2.5, softness: 0.2 } }), target: { text: "Speed" } },
      { say: "And a caption to match.", ...command("parameters.set", { values: { caption: "Neon" } }) },
    ],
  },
];

/** The timeline block of a clip, for the agent's cursor. */
const clipTarget = (id: string) => ({ selector: `[data-clip="${id}"]` });

export const VIDEO_SCRIPTS: AgentScript[] = [
  {
    id: "video-tighten",
    prompt: "Cut the ocean shot to 2 seconds and add an end card",
    steps: [
      { say: "Reading the project: tracks, clips and their times.", tool: "video__get_video_project", args: {} },
      {
        say: "The score is one bed under the whole cut, so it should stay put while the picture ripples: taking it out of sync lock.",
        tool: "video__update_video_track",
        args: { track: "a1", set: { syncLocked: false } },
        target: clipTarget("score"),
      },
      {
        say: "Extracting 6–8 s from the picture and titles: the rest of the ocean shot goes, the lower third ends at the cut, and the forest shot moves up with its dip.",
        tool: "video__extract_video_range",
        args: { from: 6000, to: 8000, tracks: ["titles", "v1"] },
        target: clipTarget("shot-2"),
      },
      { say: "The Forest marker is now 2 seconds late; moving it to the new cut.", tool: "video__remove_video_marker", args: { marker: "m-forest" } },
      { tool: "video__add_video_marker", args: { time: 6000, label: "Forest" } },
      {
        say: "Ending the music with the picture (its fade out stays).",
        tool: "video__trim_video_clip",
        args: { clip: "score", edge: "end", to: 10000 },
        target: clipTarget("score"),
      },
      {
        say: "An end card over the last two seconds.",
        tool: "video__add_video_clip",
        args: { track: "titles", clip: { type: "text", id: "end-card", text: "Thanks for watching", start: 8000, duration: 2000, fontSize: 64, background: "#0f172acc", fadeIn: 400 } },
      },
      { say: "Checking for problems.", tool: "video__check_video_project", args: {} },
      { say: "Playing it from just before the new cut.", tool: "video__seek_video", args: { time: 5000, play: true }, target: clipTarget("end-card") },
    ],
  },
  {
    id: "video-vertical",
    prompt: "Make a vertical 9:16 version for social",
    steps: [
      { say: "Reading the project first.", tool: "video__get_video_project", args: {} },
      { say: "Switching the frame to 1080 × 1920.", tool: "video__set_video_settings", args: { width: 1080, height: 1920, name: "Pixerate reel (vertical)" } },
      {
        say: "Filling the tall frame: the shots crop to cover it, and the titles get bigger and move up out of the way, as one undo step.",
        tool: "video__edit_video",
        args: {
          ops: [
            { op: "update_clip", clip: "shot-1", set: { fit: "cover" } },
            { op: "update_clip", clip: "shot-2", set: { fit: "cover" } },
            { op: "update_clip", clip: "shot-3", set: { fit: "cover" } },
            { op: "update_clip", clip: "title", set: { fontSize: 88 } },
            { op: "update_clip", clip: "lower-third", set: { fontSize: 44, transform: { y: 600 } } },
          ],
        },
      },
      { say: "Rendering three moments to check the framing.", tool: "video__render_video_frame", args: { times: [1000, 5000, 9000], columns: 3 } },
      { say: "Playing it from the start.", tool: "video__seek_video", args: { time: 0, play: true } },
    ],
  },
];

/** A wavy line across the paint canvas, `n` samples with a pressure swell and times for velocity. */
const wave = (y: number, amp: number, n = 48, x0 = 40, x1 = 1160) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return { x: Math.round(x0 + (x1 - x0) * t), y: Math.round(y + Math.sin(t * Math.PI * 2.4) * amp), pressure: Math.round((0.35 + 0.6 * Math.sin(t * Math.PI)) * 100) / 100, t: i * 14 };
  });

/**
 * Strokes, fills and replays have no target: the paint director's cursor paints them on the canvas
 * itself. Panel steps open the panel the change shows in.
 */
export const PAINT_SCRIPTS: AgentScript[] = [
  {
    id: "paint-landscape",
    prompt: "Block in a sunset landscape in pastel",
    steps: [
      { say: "Rough watercolour paper with plenty of tooth for pastel.", tool: "paint__set_paper", args: { preset: "cold-pressed", depth: 0.7 }, open: "Paper", target: { selector: '[data-testid="paper-panel"] [aria-selected="true"]' } },
      { say: "A warm sky first, rubbed into the grain.", tool: "paint__add_layer", args: { name: "Sky" }, as: "sky", open: "Layers", target: { selector: '[aria-label="Layers"]' } },
      { tool: "paint__fill_layer", args: (ctx) => ({ layerId: ctx.results.sky.id, color: "#f2a65a", grain: 0.5, pressure: 0.7 }) },
      { say: "Mixing a muted blue-grey for the far hills, as paint would mix.", tool: "paint__mix_colors", args: { colors: [{ color: "#2f3f9e", weight: 2 }, { color: "#d23a2a", weight: 1 }, { color: "#f7f5ee", weight: 1 }] }, as: "mix", open: "Colour", target: { selector: '[data-testid="mixing-pad"]' } },
      { say: "The first range of hills with a soft pastel.", tool: "paint__add_layer", args: { name: "Hills" }, as: "hills", open: "Layers", target: { selector: '[aria-label="Layers"]' } },
      {
        tool: "paint__paint_stroke",
        args: (ctx) => ({ layerId: ctx.results.hills.id, brushId: "soft-pastel", brush: { tip: { size: 90 } }, color: ctx.results.mix.mixed, points: wave(520, 50) }),
        as: "stroke",
      },
      {
        say: "Repeating that stroke lower and darker instead of drawing each range.",
        tool: "paint__replay_strokes",
        args: (ctx) => ({ strokeIds: [ctx.results.stroke.strokeId], dy: 70, repeat: 3, color: "#3b2f5c", pressureScale: 1.2 }),
      },
      { say: "Checking the result.", tool: "paint__render_preview", args: { maxSide: 420 } },
    ],
  },
  {
    id: "paint-kaleidoscope",
    prompt: "Draw a kaleidoscope ornament",
    steps: [
      { say: "Eight mirrored segments about the centre: one stroke paints all sixteen copies.", tool: "paint__set_symmetry", args: { mode: "kaleidoscope", segments: 8, center: { x: 600, y: 400 } }, target: { selector: '[aria-label="Symmetry"]' } },
      { tool: "paint__add_layer", args: { name: "Ornament" }, open: "Layers", target: { selector: '[aria-label="Layers"]' } },
      {
        say: "One petal with the ink pen.",
        tool: "paint__paint_stroke",
        args: {
          brushId: "ink-pen",
          brush: { tip: { size: 7 } },
          color: "#1d3b8f",
          points: Array.from({ length: 41 }, (_, i) => {
            const t = i / 40;
            return { x: Math.round(600 + 300 * t), y: Math.round(400 - Math.sin(t * Math.PI) * 70), pressure: Math.round((0.3 + 0.7 * Math.sin(t * Math.PI)) * 100) / 100, t: i * 16 };
          }),
        },
      },
      { say: "Symmetry off again, so later strokes are single.", tool: "paint__set_symmetry", args: { mode: "off" }, target: { selector: '[aria-label="Symmetry"]' } },
      { tool: "paint__render_preview", args: { maxSide: 420 } },
    ],
  },
  {
    id: "paint-blend-glaze",
    prompt: "Blend a sky into a meadow, then glaze it",
    steps: [
      { say: "Mixing a meadow green on the pad from ultramarine and yellow, one part to two.", tool: "paint__mix_on_pad", args: { paints: [{ color: "#1e40af", parts: 1 }, { color: "#facc15", parts: 2 }] }, as: "green" },
      { say: "Underpainting: a warm yellow ground.", tool: "paint__add_layer", args: { name: "Underpainting" }, as: "under" },
      { tool: "paint__fill_layer", args: (ctx) => ({ layerId: ctx.results.under.id, color: "#f4d27a" }) },
      {
        say: "A broad band of sky blue across the top half.",
        tool: "paint__paint_stroke",
        args: (ctx) => ({ layerId: ctx.results.under.id, brushId: "oil-pastel", brush: { tip: { size: 260, blend: "normal" } }, color: "#3d6fd1", points: [{ x: 0, y: 200 }, { x: 1200, y: 200 }] }),
      },
      {
        say: "The meadow, painted with a dirty brush so it drags some sky and ground along.",
        tool: "paint__paint_stroke",
        args: (ctx) => ({ layerId: ctx.results.under.id, brushId: "dirty-round", brush: { tip: { size: 160 } }, color: ctx.results.green.color, points: wave(620, 40) }),
      },
      {
        say: "Blending the horizon: the blender mixes neighbouring colours like paint, so blue into yellow goes green, not grey.",
        tool: "paint__paint_stroke",
        args: (ctx) => ({ layerId: ctx.results.under.id, brushId: "blender", brush: { tip: { size: 120 }, blender: { strength: 0.6, distance: 0.4 } }, points: wave(330, 25) }),
      },
      {
        say: "A two-colour ribbon of light along the hills with the multi-colour flat.",
        tool: "paint__paint_stroke",
        args: (ctx) => ({ layerId: ctx.results.under.id, brushId: "multicolor-flat", brush: { tip: { size: 70 }, behavior: { multicolor: { colors: ["#fff2b3", "#f29e4c"] } } }, points: wave(450, 30) }),
      },
      { say: "An evening glaze on its own layer, in watercolour mode: it darkens like a transparent wash.", tool: "paint__add_layer", args: { name: "Glaze" }, as: "glaze" },
      { tool: "paint__fill_layer", args: (ctx) => ({ layerId: ctx.results.glaze.id, color: "#9a7fd1" }) },
      { tool: "paint__update_layer", args: (ctx) => ({ layerId: ctx.results.glaze.id, blend: "watercolor", opacity: 0.45 }) },
      { tool: "paint__render_preview", args: { maxSide: 420 } },
    ],
  },
];
