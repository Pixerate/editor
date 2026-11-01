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
      },
      { say: "The status formula should now say On target.", tool: "sheet__get_range", args: { range: "D7:G7" } },
    ],
  },
];

/** Chart scripts: value drags go through the chart's director, everything else is played on the editor's controls. */
export const CHART_SCRIPTS: AgentScript[] = [
  {
    id: "chart-house-style",
    prompt: "Bring this chart into the house style",
    steps: [
      { say: "Reading the house style for charts.", tool: "style__get_style", args: { domain: "chart" }, as: "style" },
      { say: "Checking the chart against it.", tool: "chart__check_chart_style", args: {}, as: "before" },
      {
        say: "Switching to the house palette and the user's defaults.",
        tool: "chart__update_chart",
        args: (ctx) => {
          const profile = ctx.results.style.profile ?? {};
          if (!profile.palette) throw new Error("The house style has no chart palette.");
          return { palette: profile.palette, ...(profile.defaults ?? {}) };
        },
      },
      { say: "Checking again: it should come back clean.", tool: "chart__check_chart_style", args: {} },
    ],
  },
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
      },
      { say: "A grouped bar chart with titles.", tool: "chart__update_chart", args: { type: "bar", title: "Revenue by quarter", subtitle: "$k, 2026" } },
      {
        say: "Online is the growth story, so it gets a linear trend.",
        tool: "chart__add_chart_trendline",
        args: (ctx) => ({ series: seriesId(ctx.results.data, "Online"), type: "linear", showR2: true }),
      },
      { say: "Colour-blind safe palette, presentation layout.", tool: "chart__apply_chart_preset", args: { layout: "presentation", colors: "okabe-ito" } },
      { say: "Rendering it to check how it reads.", tool: "chart__render_chart", args: { format: "png" } },
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
    id: "canvas-effects-flair",
    prompt: "Fill the star with a Flair gradient, then lay it over the star at 60%",
    steps: [
      { say: "Listing the effects on the canvas: the star carries one.", tool: "canvasfx__list_applied_effects", args: {} },
      { say: "Searching Flair for a gradient to fill a shape with.", tool: "canvasfx__search_effects", args: { query: "gradient", use: "generator" } },
      { say: "A grainy gradient fills the star, clipped to its outline.", tool: "canvasfx__apply_effect", args: { target: "effect-star", effect: "grainy-gradient" } },
      { say: "Laid over the star's whole box instead of inside it.", tool: "canvasfx__set_canvas_effect_mode", args: { node: "effect-star", mode: "overlay" } },
      { say: "At 60%, so the star shows through.", tool: "canvasfx__update_effect", args: { target: "effect-star", effect: "effect", opacity: 0.6 } },
    ],
  },
  {
    id: "canvas-effects",
    prompt: "Fill the star with a sunset gradient, then lay it over the star at 60%",
    steps: [
      { say: "Listing the effects on the canvas: the star carries one.", tool: "canvasfx__list_applied_effects", args: {} },
      { say: "Looking for generators: they fill a shape.", tool: "canvasfx__search_effects", args: { use: "generator" } },
      {
        say: "A sunset gradient fills the star, clipped to its outline.",
        tool: "canvasfx__apply_effect",
        args: { target: "effect-star", effect: "fake.gradient", values: { from: "#fde68a", to: "#db2777", angle: 90, spin: 90 } },
      },
      { say: "Laid over the star's whole box instead of inside it.", tool: "canvasfx__set_canvas_effect_mode", args: { node: "effect-star", mode: "overlay" } },
      { say: "At 60%, so the star shows through.", tool: "canvasfx__update_effect", args: { target: "effect-star", effect: "effect", opacity: 0.6 } },
    ],
  },
  {
    id: "canvas-align",
    prompt: "Line up the main workflow steps and add a QA step",
    steps: [
      { say: "Reading the board.", tool: "canvas__get_editor_state", args: { includeDocument: false }, as: "state" },
      {
        say: "Brief, Research, Review and Ship it are the main path; centring them on one line.",
        ...command("canvas.alignMiddle", { ids: ["brief", "research", "review", "ship"] }),
      },
      {
        say: "Adding a QA step after Review; it connects from Review on its own.",
        tool: "canvas__canvas_add_node",
        args: { node: { id: "qa", type: "box", data: { label: "QA", color: "#22d3ee" } }, nearNodeId: "review", side: "bottom" },
        as: "qa",
      },
      {
        say: "QA passes work on to Ship it.",
        tool: "canvas__canvas_connect",
        args: (ctx) => ({ source: ctx.results.qa.created.nodes[0].id, target: "ship", label: "pass" }),
      },
      { say: "Done. The sticky note and sketches stay where they were.", tool: "canvas__canvas_select", args: { nodeIds: ["brief", "research", "review", "ship", "qa"] } },
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
      { say: "Listing the artwork's shapes.", ...command("vector.list"), as: "doc" },
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
      },
      { say: "Darkening the hill.", ...command("vector.setStyle", { ids: ["hill"], fill: "#14532d", stroke: "#052e16" }) },
      { say: "A few stars in the sky.", ...command("vector.addShape", { kind: "star", x: 360, y: 40, width: 26, height: 26, points: 5, innerRatio: 0.45, fill: "#fde68a", name: "Star" }) },
      { ...command("vector.addShape", { kind: "star", x: 440, y: 120, width: 18, height: 18, points: 5, innerRatio: 0.45, fill: "#fef3c7", name: "Star" }) },
      { ...command("vector.addShape", { kind: "star", x: 520, y: 30, width: 14, height: 14, points: 5, innerRatio: 0.45, fill: "#fef9c3", name: "Star" }) },
    ],
  },
  {
    id: "vector-appearance",
    prompt: "Make the yellow star pop",
    steps: [
      { say: "Reading the star's appearance.", ...command("vector.getAppearance", { id: "star" }) },
      { say: "A warm glow fill multiplied over the yellow.", ...command("vector.addFill", { ids: ["star"], paint: "#fb923c", opacity: 0.6, blendMode: "multiply" }) },
      { say: "A dark outline outside the shape…", ...command("vector.addStroke", { ids: ["star"], paint: "#78350f", strokeWidth: 4, strokeAlign: "outside", strokeLinejoin: "round" }) },
      { say: "…and a thin white one inside it.", ...command("vector.addStroke", { ids: ["star"], paint: "#ffffff", strokeWidth: 1.5, strokeAlign: "inside" }) },
      { say: "A soft drop shadow, lit from above.", ...command("vector.addFilter", { ids: ["star"], type: "dropShadow", params: { opacity: 0.35, offsetY: 3, blur: 6 } }) },
    ],
  },
  {
    id: "vector-mask",
    prompt: "Frame the colour wheel in a rounded window",
    steps: [
      { say: "Drawing the window over the wheel: it becomes the mask, so its colour won't show.", ...command("vector.addShape", { kind: "rect", x: 724, y: 314, width: 44, height: 44, cornerRadius: 10, name: "Window" }), as: "win" },
      { say: "Clipping the wheel to it: the topmost object masks the ones below.", ...commandWith("vector.makeClippingMask", (r) => ({ ids: ["wheel", r("win").id] })), as: "clip" },
      { say: "Turning it into a soft opacity mask instead: a radial fade from white to black.", ...commandWith("vector.setGradient", (r) => ({ ids: [r("win").id], target: "fill", type: "radial", stops: [{ offset: 0.5, color: "#ffffff" }, { offset: 1, color: "#000000" }] })) },
      { ...commandWith("vector.setMaskOptions", (r) => ({ ids: [r("clip").id], type: "luminance" })) },
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
      },
      { say: "Colouring the second word.", ...commandWith("vector.setTextStyle", (r) => ({ id: r("title").id, start: 7, end: 12, fill: "#16a34a" })) },
      { say: "An arc for the caption to follow…", ...command("vector.addPath", { d: "M440 470 C520 400 640 400 720 470", name: "Caption path" }), as: "arc" },
      {
        say: "…and the caption set along it, centred.",
        ...commandWith("vector.typeOnPath", (r) => ({ pathId: r("arc").id, text: "rolling green since forever", font: { fontSize: 18, italic: true }, paragraph: { align: "center" }, fill: "#14532d" })),
      },
    ],
  },
  {
    id: "vector-symbols",
    prompt: "Plant a row of trees and make them autumn",
    steps: [
      { say: "Reading the document's symbols.", ...command("vector.listSymbols") },
      { say: "Placing three more trees along the hill.", ...command("vector.placeSymbol", { symbolId: "tree", x: 470, y: 330, name: "Tree" }) },
      { ...command("vector.placeSymbol", { symbolId: "tree", transform: [1.2, 0, 0, 1.2, 520, 322], name: "Tree" }) },
      { ...command("vector.placeSymbol", { symbolId: "tree", transform: [0.9, 0, 0.1, 0.9, 565, 316], name: "Tree" }) },
      { say: "Editing the symbol once turns every tree orange.", ...command("vector.editSymbol", { id: "tree" }) },
      { ...command("vector.setStyle", { ids: ["crown"], fill: "#ea580c", stroke: "#7c2d12" }) },
      { say: "Back to the whole drawing.", ...command("vector.exitSymbolEdit") },
    ],
  },
  {
    id: "vector-constraints",
    prompt: "Make the card a parametric 2:1 rectangle",
    steps: [
      { say: "Constraining what the card already nearly is: level and upright sides.", ...command("vector.autoConstrain", { ids: ["card"] }) },
      { say: "A named width…", ...command("vector.setConstraintValue", { key: "cardW", value: 240 }) },
      { ...command("vector.addConstraint", { kind: "distance", refs: [{ nodeId: "card", subpath: 0, index: 0, segment: true }], value: "cardW", name: "width" }) },
      { say: "…and a height that follows it: half the width.", ...command("vector.addConstraint", { kind: "distance", refs: [{ nodeId: "card", subpath: 0, index: 1, segment: true }], value: "cardW / 2", name: "height" }) },
      { say: "Changing the width now resizes both.", ...command("vector.setConstraintValue", { key: "cardW", value: 200 }) },
      { say: "Checking what is still free to move.", ...command("vector.listConstraints") },
    ],
  },
  {
    id: "vector-frames",
    prompt: "Make a banner that I can resize",
    steps: [
      { say: "A background bar and a badge for the banner…", ...command("vector.addShape", { kind: "rect", x: 440, y: 300, width: 180, height: 12, cornerRadius: 6, fill: "#38bdf8", name: "Bar" }), as: "bar" },
      { ...command("vector.addShape", { kind: "ellipse", x: 590, y: 250, width: 30, height: 30, fill: "#f43f5e", name: "Badge" }), as: "badge" },
      {
        say: "…framed together with some padding: the frame is the banner.",
        ...commandWith("vector.frameSelection", (r) => ({ ids: [r("bar").id, r("badge").id], padding: 16, fill: "#0f172a", name: "Banner" })),
        as: "banner",
      },
      { say: "The bar stretches with the banner, the badge stays in its corner.", ...commandWith("vector.setResizing", (r) => ({ ids: [r("bar").id], horizontal: "leftRight", vertical: "bottom" })) },
      { ...commandWith("vector.setResizing", (r) => ({ ids: [r("badge").id], horizontal: "right", vertical: "top" })) },
      { say: "Now a wider banner: the contents follow their constraints.", ...commandWith("vector.setFrame", (r) => ({ ids: [r("banner").id], width: 340, height: 120 })) },
    ],
  },
  {
    id: "vector-lottie",
    prompt: "Export the flower as Lottie and bring it back beside it",
    steps: [
      { say: "Exporting the flower: its repeater and trim stay live as Lottie modifiers.", ...command("vector.exportLottie", { ids: ["flower"], frames: 60 }), as: "lottie" },
      { say: "Importing it again as editable shapes.", ...commandWith("vector.importLottie", (r) => ({ lottie: r("lottie").lottie })), as: "back" },
      { say: "Moving the copy beside the original.", ...commandWith("vector.transform", (r) => ({ ids: r("back").ids, dx: 80, dy: 0 })) },
    ],
  },
  {
    id: "vector-contour",
    prompt: "Give the star a contour glow",
    steps: [
      { say: "Four contour steps outside the star, fading to the sky colour.", ...command("vector.addEffect", { ids: ["star"], type: "contour", params: { direction: "outside", steps: 4, offset: 4, fillColor: "#e0f2fe", strokeColor: "#e0f2fe" } }) },
    ],
  },
  {
    id: "vector-block-shadow",
    prompt: "Give the star a long shadow",
    steps: [
      { say: "A block shadow swept down-right from the star, fading out along its length.", ...command("vector.addEffect", { ids: ["star"], type: "blockShadow", params: { angle: 45, distance: 120, color: "#0f172a", opacity: 60, endOpacity: 0 } }) },
    ],
  },
  {
    id: "vector-extrude",
    prompt: "Make the card a 3D block",
    steps: [
      { say: "Extruding the card back and down-right, lit from the top left.", ...command("vector.addEffect", { ids: ["card"], type: "extrude", params: { mode: "parallel", angle: 45, depth: 24, lightAngle: -135, shading: 60 } }) },
    ],
  },
  {
    id: "vector-perspective",
    prompt: "Put a sign on a wall in perspective",
    steps: [
      { say: "A two-point perspective grid: vanishing points beyond the page on the horizon, the origin near the bottom.", ...command("vector.setPerspective", { vanishingPoints: [{ x: -200, y: 140 }, { x: 800, y: 140 }], origin: { x: 300, y: 330 }, gridSize: 20, extent: 10 }) },
      { say: "A flat sign drawn just right of the origin…", ...command("vector.addShape", { kind: "rect", x: 310, y: 240, width: 160, height: 70, fill: "#f97316", stroke: "#7c2d12", strokeWidth: 3, name: "Sign" }), as: "sign" },
      { say: "…laid onto the right wall: it recedes toward the right vanishing point.", ...commandWith("vector.attachToPerspective", (r) => ({ ids: [r("sign").id], plane: "right" })) },
    ],
  },
  {
    id: "vector-bevel",
    prompt: "Bevel the star like a badge",
    steps: [
      { say: "A 4-unit bevel round the star, lit from the top left.", ...command("vector.addEffect", { ids: ["star"], type: "bevel", params: { width: 4, lightAngle: -135, shading: 70 } }) },
    ],
  },
  {
    id: "vector-distort-brush",
    prompt: "Make the sun look hand-made with the distortion brushes",
    steps: [
      { say: "Twirling the sun's top edge…", ...command("vector.twirlBrush", { ids: ["sun"], points: [[630, 72]], radius: 40, strength: 0.8, angle: 30 }) },
      { say: "…pulling a drip down from its bottom…", ...command("vector.smudgeBrush", { ids: ["sun"], points: [[630, 205], [630, 222], [633, 240]], radius: 18, strength: 0.9 }) },
      { say: "…and roughening its left side.", ...command("vector.roughenBrush", { ids: ["sun"], points: [[562, 140]], radius: 25, strength: 0.7, seed: 7 }) },
    ],
  },
  {
    id: "vector-lens",
    prompt: "Hold a magnifying glass over the scene",
    steps: [
      { say: "A round glass over the middle of the scene…", ...command("vector.addShape", { kind: "ellipse", x: 230, y: 150, width: 140, height: 140, fill: "#ffffff", stroke: "#0f172a", strokeWidth: 4, name: "Magnifier" }), as: "glass" },
      { say: "…made a 2× magnifying lens: what is below it shows enlarged, and follows when it moves.", ...commandWith("vector.setLens", (r) => ({ ids: [r("glass").id], type: "magnify", amount: 2 })) },
      { say: "Switching it to a heat map lens.", ...commandWith("vector.setLens", (r) => ({ ids: [r("glass").id], type: "heatMap" })) },
    ],
  },
  {
    id: "vector-generate",
    prompt: "Generate a rocket and a tree from a prompt",
    steps: [
      { say: "Checking which models can make vector art.", tool: "vectorgen__list_vector_art_models", args: {} },
      { say: "Asking the sketcher for a rocket next to a tree, in the lower left.", tool: "vectorgen__generate_vector_art", args: () => ({ prompt: "a rocket next to a tree", model: "demo-sketcher", x: 40, y: 330, width: 220, height: 110, idempotencyKey: `demo-rocket-tree-${Date.now()}` }), as: "art" },
      { say: "Listing what it made: ordinary paths in one group, ready to edit.", ...command("vector.list") },
    ],
  },
  {
    id: "vector-pages",
    prompt: "Make this a two-page document with a numbered footer",
    steps: [
      { say: "The drawing becomes page 1…", ...command("vector.addPage", { name: "Cover" }), as: "p1" },
      { say: "…a second page beside it…", ...command("vector.addPage", { name: "Back" }), as: "p2" },
      { say: "…and a master page both use.", ...command("vector.addMasterPage", { name: "Footer", assignTo: "all" }), as: "m" },
      { say: "A footer bar on the master, pinned to the bottom…", ...commandWith("vector.addShape", (r) => ({ kind: "rect", x: r("m").masters[0].bounds.x, y: r("m").masters[0].bounds.y + r("m").masters[0].bounds.height - 24, width: r("m").masters[0].bounds.width, height: 24, fill: "#0f172a", parentId: r("m").id })), as: "bar" },
      { say: "…and the page number on it: every page shows its own.", ...commandWith("vector.addText", (r) => ({ text: "Page {page} of {pages}", x: r("m").masters[0].bounds.x + 12, y: r("m").masters[0].bounds.y + r("m").masters[0].bounds.height - 8, font: { fontSize: 12 }, fill: "#ffffff", parentId: r("m").id })) },
      { say: "Going to page 2.", ...commandWith("vector.goToPage", (r) => ({ id: r("p2").id })) },
    ],
  },
  {
    id: "vector-brushstroke",
    prompt: "Ink the arrow and sketch the flag outline with real brushes",
    steps: [
      { say: "Which brushes can paint along a path?", ...command("vector.listBrushes") },
      { say: "An ink pen along the arrow, tapering at both ends.", ...command("vector.addBrushstroke", { ids: ["arrow"], brushId: "ink-pen", size: 5, pressure: [0.15, 1, 0.15], color: "#0f172a" }) },
      { say: "A charcoal outline round the flag; the stripes stay editable vectors.", ...command("vector.addBrushstroke", { ids: ["flag-top", "flag-mid", "flag-low"], brushId: "charcoal-stick", size: 6, color: "#1e293b" }) },
    ],
  },
  {
    id: "vector-symmetry",
    prompt: "Draw a mandala in the sky with live symmetry",
    steps: [
      { say: "An empty radial symmetry group with 8 mirrored wedges, centred in the sky…", ...command("vector.makeSymmetry", { ids: [], mode: "radial", copies: 8, mirror: true, center: { x: 470, y: 130 }, name: "Mandala" }), as: "m" },
      { say: "…one petal in a wedge…", ...commandWith("vector.addShape", (r) => ({ kind: "ellipse", x: 478, y: 92, width: 10, height: 26, fill: "#f472b6", name: "Petal", parentId: r("m").id })) },
      { say: "…and a dot: every wedge gets them, mirrored.", ...commandWith("vector.addShape", (r) => ({ kind: "ellipse", x: 488, y: 86, width: 6, height: 6, fill: "#a78bfa", name: "Dot", parentId: r("m").id })) },
      { say: "Changing the symmetry to 12 copies: the drawing follows.", ...commandWith("vector.setSymmetry", (r) => ({ ids: [r("m").id], copies: 12 })) },
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
      },
      { say: "Checking what it made.", ...command("vector.list") },
    ],
  },
  {
    id: "vector-stylize",
    prompt: "Make a halftone and a low-poly version of the badge",
    steps: [
      { say: "Halftone dots in the badge's own colours…", ...commandWith("vector.halftoneImage", () => ({ image: badgePng(), cell: 6, angle: 45, color: null, colors: 4, x: 620, y: 360, width: 120, name: "Badge halftone" })) },
      { say: "…and low-poly triangles beside it.", ...commandWith("vector.lowPolyImage", () => ({ image: badgePng(), cell: 12, seed: 3, colors: 8, x: 490, y: 360, width: 120, name: "Badge low poly" })) },
    ],
  },
  {
    id: "vector-shading",
    prompt: "Shade the card with a mesh and the hill with a freeform gradient",
    steps: [
      {
        say: "A 2 × 2 gradient mesh on the card, blue at the top fading to white…",
        ...command("vector.setMeshGradient", { ids: ["card"], rows: 2, columns: 2, corners: ["#bae6fd", "#38bdf8", "#e0f2fe", "#ffffff"] }),
      },
      { say: "…with its middle point pulled toward the star and brightened.", ...command("vector.setMeshPoint", { id: "card", index: 4, x: 200, y: 120, color: "#fef9c3" }) },
      { say: "Freeform colour points across the hill, darker in the dips.", ...command("vector.setFreeformGradient", { ids: ["hill"], colors: ["#15803d", "#4ade80", "#166534", "#86efac"] }) },
      { say: "Checking the points to fine-tune.", ...command("vector.getShading", { id: "hill" }) },
    ],
  },
  {
    id: "vector-connectors",
    prompt: "Connect the card to the sun and the badge",
    steps: [
      { say: "Where can things attach to the card? Checking its connection sites.", ...command("vector.listConnectionSites", { id: "card" }) },
      {
        say: "An elbow connector from the card to the sun, with rounded bends…",
        ...command("vector.connect", { start: { nodeId: "card" }, end: { nodeId: "sun" }, route: "elbow", radius: 8, stroke: "#0369a1", strokeWidth: 2 }),
        as: "toSun",
      },
      { say: "…and a curved one down to the badge.", ...command("vector.connect", { start: { nodeId: "card", side: "bottom" }, end: { nodeId: "badge" }, route: "curved", stroke: "#7e22ce", strokeWidth: 2 }), as: "toBadge" },
      { say: "Moving the card: both connectors follow it.", ...command("vector.transform", { ids: ["card", "star"], dx: 40, dy: 30 }) },
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
      { say: "Playing the finale.", tool: "animation__seek_animation", args: { shot: "finale", play: true } },
    ],
  },
];

export const IMAGE_SCRIPTS: AgentScript[] = [
  {
    id: "image-effects-flair",
    prompt: "Give the photo a film look with Flair, plus an aurora wash and a vignette",
    steps: [
      { say: "Searching Flair's catalog for a film look.", tool: "imagefx__search_effects", args: { query: "film", use: "filter" } },
      { say: "Reading its controls: tint, grain, halation, vignette.", tool: "imagefx__describe_effect", args: { effect: "film-look" } },
      {
        say: "Film look on the photo as a smart filter, so it stays editable (the layer becomes a smart object in the same undo step).",
        tool: "imagefx__apply_effect",
        args: { target: "background", effect: "film-look", values: { uTint: "#ffe2c0", uGrain: 0.1, uHalation: 0.35 } },
      },
      {
        say: "An aurora on its own layer, soft-light at half strength, to wash the sky.",
        tool: "imagefx__add_effect_layer",
        args: { effect: "aurora", values: { uIntensity: 0.8 }, name: "Aurora wash", blend: "soft-light", opacity: 0.5 },
      },
      { say: "A vignette with grain on top.", tool: "imagefx__add_effect_layer", args: { effect: "vignette-grain", values: { uStrength: 0.5 }, name: "Vignette" } },
      { say: "Checking what is applied.", tool: "imagefx__list_applied_effects", args: {} },
      { say: "Rendering a preview to check it.", tool: "image__render_preview", args: { maxSide: 360 } },
    ],
  },
  {
    id: "image-effects",
    prompt: "Add a colour wash and a lower-third bar from the effects library",
    steps: [
      { say: "Looking for generators in the effects provider.", tool: "imagefx__search_effects", args: { use: "generator" } },
      { say: "Reading the gradient's controls.", tool: "imagefx__describe_effect", args: { effect: "fake.gradient" } },
      {
        say: "A sunset gradient as its own layer, soft-light at half strength, so it washes the photo without hiding it.",
        tool: "imagefx__add_effect_layer",
        args: { effect: "fake.gradient", values: { from: "#f97316", to: "#7c3aed", angle: 45 }, name: "Sunset wash", blend: "soft-light", opacity: 0.5 },
      },
      {
        say: "A lower-third bar on top, fully slid in.",
        tool: "imagefx__add_effect_layer",
        args: { effect: "fake.bar", values: { color: "#0ea5e9", height: 0.1 }, time: 2000, name: "Lower third" },
      },
      { say: "Checking what is applied.", tool: "imagefx__list_applied_effects", args: {} },
      { say: "Rendering a preview to check it.", tool: "image__render_preview", args: { maxSide: 360 } },
    ],
  },
  {
    id: "image-grade",
    prompt: "Give the photo a warm, punchy grade",
    steps: [
      { say: "Reading the current adjustments.", tool: "image__get_adjustments", args: {} },
      {
        say: "Warming it up and adding contrast, as one undo step.",
        tool: "image__set_adjustments",
        args: { values: { temperature: 28, contrast: 22, exposure: 6 }, label: "Warm, punchy grade" },
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
      { say: "Selecting everything to read the image size.", tool: "image__select_all", args: {} },
      { tool: "image__get_selection", args: {}, as: "sel" },
      {
        say: "An ellipse over the centre, feathered, then inverted to get the edges.",
        tool: "image__select_ellipse",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return { x: width * 0.12, y: height * 0.1, width: width * 0.76, height: height * 0.8, feather: Math.round(width / 12) };
        },
      },
      { tool: "image__invert_selection", args: {} },
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
      { say: "Selecting everything to read the image size.", tool: "image__select_all", args: {} },
      { tool: "image__get_selection", args: {}, as: "sel" },
      {
        say: "A rectangle over the centre.",
        tool: "image__select_rect",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return { x: width * 0.3, y: height * 0.3, width: width * 0.4, height: height * 0.4 };
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
      { say: "Reading the document's colour profile.", tool: "image__get_color_profile", args: {} },
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
      { say: "Selecting everything to read the image size.", tool: "image__select_all", args: {} },
      { tool: "image__get_selection", args: {}, as: "sel" },
      { tool: "image__deselect", args: {} },
      { say: "Reading the layers, to find the photo.", tool: "image__list_layers", args: {}, as: "layers" },
      {
        say: "An empty layer for the retouching, so the photo stays untouched.",
        tool: "image__add_pixel_layer",
        args: { name: "Retouch" },
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
      { say: "Selecting everything to read the image size.", tool: "image__select_all", args: {} },
      { tool: "image__get_selection", args: {}, as: "sel" },
      { tool: "image__deselect", args: {} },
      {
        say: "A rounded banner along the bottom, as a live shape layer.",
        tool: "image__add_shape_layer",
        args: (ctx) => {
          const { width, height } = imageSize(ctx.results.sel);
          return { shape: { kind: "rect", x: width * 0.08, y: height * 0.7, width: width * 0.84, height: height * 0.2, radius: height * 0.04 }, fill: "#111827cc", name: "Banner" };
        },
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
      { say: "Rings instead of the orb.", ...command("parameters.set", { values: { shape: "rings" } }) },
      { say: "Twelve thin rings.", ...command("parameters.set", { values: { count: 12, thickness: 0.2 } }) },
      { say: "Faster, with a sharper glow.", ...command("parameters.set", { values: { speed: 2.5, softness: 0.2 } }) },
      { say: "And a caption to match.", ...command("parameters.set", { values: { caption: "Neon" } }) },
    ],
  },
];

/** The timeline block of a clip, for the agent's cursor. */
export const VIDEO_SCRIPTS: AgentScript[] = [
  {
    id: "video-effects-flair",
    prompt: "Give the sunrise a film look with Flair, dissolve into the ocean, and flare the ending",
    steps: [
      { say: "Searching Flair's catalog for a film look.", tool: "videofx__search_effects", args: { query: "film", use: "filter" } },
      { say: "Reading its controls: tint, grain, halation, vignette.", tool: "videofx__describe_effect", args: { effect: "film-look" } },
      {
        say: "Film look on the sunrise shot, warm and grainy.",
        tool: "videofx__apply_effect",
        args: { target: "shot-1", effect: "film-look", values: { uTint: "#ffd9a8", uGrain: 0.12 } },
      },
      {
        say: "Closing the vignette in over the shot with keyframes.",
        tool: "videofx__set_video_effect_keyframes",
        args: { clip: "shot-1", effect: "fx1", control: "uVignette", keys: [{ t: 0, v: 0 }, { t: 3500, v: 0.7, ease: "ease-in" }] },
      },
      {
        say: "A pixel dissolve into the ocean instead of the crossfade.",
        tool: "videofx__set_video_effect_transition",
        args: { clip: "shot-2", effect: "transition-pixel-dissolve", duration: 800, values: { uMaxBlock: 32 } },
      },
      {
        say: "A lens flare over the last two seconds, on the titles track.",
        tool: "videofx__add_video_effect_clip",
        args: { track: "titles", effect: "lens-flare", start: 10000, duration: 2000, name: "Flare" },
      },
      { say: "Listing what is applied now.", tool: "videofx__list_applied_effects", args: {} },
      { say: "Playing the dissolve.", tool: "video__seek_video", args: { time: 3200, play: true } },
    ],
  },
  {
    id: "video-effects",
    prompt: "Give the sunrise a warm tint and use an effect transition into the ocean",
    steps: [
      { say: "Searching the effects provider for filters.", tool: "videofx__search_effects", args: { use: "filter" } },
      { say: "Reading the tint's controls: a colour and an amount from 0 to 1.", tool: "videofx__describe_effect", args: { effect: "fake.tint" } },
      {
        say: "A warm tint on the sunrise shot, at a third.",
        tool: "videofx__apply_effect",
        args: { target: "shot-1", effect: "fake.tint", values: { color: "#ff7a1a", amount: 0.35 } },
      },
      {
        say: "Easing it in over the first two seconds with keyframes.",
        tool: "videofx__set_video_effect_keyframes",
        args: { clip: "shot-1", effect: "fx1", control: "amount", keys: [{ t: 0, v: 0 }, { t: 2000, v: 0.35, ease: "ease-out" }] },
      },
      {
        say: "Swapping the crossfade into the ocean for the provider's crossfade transition.",
        tool: "videofx__set_video_effect_transition",
        args: { clip: "shot-2", effect: "fake.crossfade", duration: 800, values: { curve: "smooth" } },
      },
      { say: "Listing what is applied now.", tool: "videofx__list_applied_effects", args: {} },
      { say: "Playing the transition.", tool: "video__seek_video", args: { time: 3200, play: true } },
    ],
  },
  {
    id: "video-tighten",
    prompt: "Cut the ocean shot to 2 seconds and add an end card",
    steps: [
      { say: "Reading the project: tracks, clips and their times.", tool: "video__get_video_project", args: {} },
      {
        say: "The score is one bed under the whole cut, so it should stay put while the picture ripples: taking it out of sync lock.",
        tool: "video__update_video_track",
        args: { track: "a1", set: { syncLocked: false } },
      },
      {
        say: "Extracting 6–8 s from the picture and titles: the rest of the ocean shot goes, the lower third ends at the cut, and the forest shot moves up with its dip.",
        tool: "video__extract_video_range",
        args: { from: 6000, to: 8000, tracks: ["titles", "v1"] },
      },
      { say: "The Forest marker is now 2 seconds late; moving it to the new cut.", tool: "video__remove_video_marker", args: { marker: "m-forest" } },
      { tool: "video__add_video_marker", args: { time: 6000, label: "Forest" } },
      {
        say: "Ending the music with the picture (its fade out stays).",
        tool: "video__trim_video_clip",
        args: { clip: "score", edge: "end", to: 10000 },
      },
      {
        say: "An end card over the last two seconds.",
        tool: "video__add_video_clip",
        args: { track: "titles", clip: { type: "text", id: "end-card", text: "Thanks for watching", start: 8000, duration: 2000, fontSize: 64, background: "#0f172acc", fadeIn: 400 } },
      },
      { say: "Checking for problems.", tool: "video__check_video_project", args: {} },
      { say: "Playing it from just before the new cut.", tool: "video__seek_video", args: { time: 5000, play: true } },
    ],
  },
  {
    id: "video-night-look",
    prompt: "Give the ocean and forest a night-look vignette, and propose ending on the forest sooner for me to review",
    steps: [
      { say: "Reading the project first.", tool: "video__get_video_project", args: {} },
      {
        say: "One adjustment clip over both shots instead of grading each: it changes every track below it while it plays, titles excluded.",
        tool: "video__add_video_track",
        args: { id: "looks", kind: "video", name: "Looks", at: 1 },
      },
      {
        say: "A cool day-for-night look from 4 s to the end.",
        tool: "video__add_video_adjustment_clip",
        args: { track: "looks", id: "night", start: 4000, duration: 8000, preset: "day-for-night", amount: 0.6, name: "Night look" },
      },
      {
        say: "Limiting the look to the edges with an inverted, feathered ellipse: the middle stays natural and the edges fall off like a vignette.",
        tool: "video__set_video_clip_mask",
        args: { clip: "night", shape: "ellipse", width: 0.8, height: 0.8, feather: 80, inverted: true },
      },
      {
        say: "The score is one bed under the whole cut, so it should stay put when the picture closes up: taking it out of sync lock.",
        tool: "video__update_video_track",
        args: { track: "a1", set: { syncLocked: false } },
      },
      {
        say: "Proposing the trim as a plan rather than doing it: the last second of the ocean shot goes and the forest moves up with its dip.",
        tool: "video__plan_video_edits",
        args: { title: "End on the forest sooner", description: "Shortens the ocean shot by 1 s; the forest and its dip move up with it.", ops: [{ op: "extract_range", from: 7000, to: 8000, tracks: ["titles", "looks", "v1"] }], ranges: [{ from: 7000, to: 8000, reason: "trim" }] },
      },
      { say: "It is waiting for review under the timeline. Listing what is open.", tool: "video__list_video_edit_plans", args: {} },
      { say: "Applying it as one undo step.", tool: "video__apply_video_edit_plan", args: { plan: "plan1" } },
      { say: "Checking for problems.", tool: "video__check_video_project", args: {} },
      { say: "Playing the new look from the ocean shot.", tool: "video__seek_video", args: { time: 4000, play: true } },
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
/** Points around a circle (for petals and rings). */
function ring(cx: number, cy: number, r: number, n = 48) {
  return Array.from({ length: n + 1 }, (_, i) => ({ x: Math.round(cx + r * Math.cos((i / n) * Math.PI * 2)), y: Math.round(cy + r * Math.sin((i / n) * Math.PI * 2)), pressure: 0.9 }));
}

export const PAINT_SCRIPTS: AgentScript[] = [
  {
    id: "paint-effects-flair",
    prompt: "Print the sheet with a Flair gradient, light the hills with Flair and add film grain",
    steps: [
      { say: "Searching Flair for a soft gradient to print the sheet with.", tool: "paintfx__search_effects", args: { query: "gradient", use: "generator" } },
      {
        say: "A grainy gradient as effect paper at 60%: multiplied, so the paper's own grain still shows.",
        tool: "paintfx__set_paper_effect",
        args: { effect: "grainy-gradient", opacity: 0.6 },
      },
      { say: "Hills in pastel, rubbed into the grain.", tool: "paint__add_layer", args: { name: "Hills" }, as: "hills" },
      { tool: "paint__fill_layer", args: (ctx) => ({ layerId: ctx.results.hills.id, color: "#1e3a8a", grain: 0.6, pressure: 0.5 }) },
      { say: "Looking for light that suits dried pastel.", tool: "paintfx__search_effects", args: { query: "light", use: "filter" } },
      {
        say: "A rim light baked onto the dried pastel at 70%.",
        tool: "paintfx__apply_effect",
        args: (ctx) => ({ target: ctx.results.hills.id, effect: "rim-light", opacity: 0.7 }),
      },
      { say: "A ribbon painted with the gradient itself: brushes take each pixel's colour from it.", tool: "paint__add_layer", args: { name: "Ribbon" }, as: "ribbon" },
      { tool: "paintfx__set_effect_paint", args: { effect: "grainy-gradient" } },
      { tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.ribbon.id, brushId: "bristle-flat", brush: { tip: { size: 70 } }, points: wave(260, 60) }) },
      { tool: "paint__set_color", args: { color: "#1f2937" } },
      { say: "Film grain and a vignette on their own effect layer.", tool: "paintfx__add_effect_layer", args: { effect: "vignette-grain", name: "Vignette" } },
      { say: "Checking what is applied.", tool: "paintfx__list_applied_effects", args: {} },
      { say: "Rendering a preview to check it.", tool: "paint__render_preview", args: { maxSide: 420 } },
    ],
  },
  {
    id: "paint-effects",
    prompt: "Print the sheet with a gradient, glaze the hills with warm light and add a caption",
    steps: [
      { say: "Looking for generators in the effects provider.", tool: "paintfx__search_effects", args: { use: "generator" } },
      {
        say: "A pale sunset gradient as effect paper: multiplied over the sheet, so the paper's grain still shows.",
        tool: "paintfx__set_paper_effect",
        args: { effect: "fake.gradient", values: { from: "#fde68a", to: "#fbcfe8", angle: 90 } },
      },
      { say: "Hills in pastel, rubbed into the grain.", tool: "paint__add_layer", args: { name: "Hills" }, as: "hills" },
      { tool: "paint__fill_layer", args: (ctx) => ({ layerId: ctx.results.hills.id, color: "#1e3a8a", grain: 0.6, pressure: 0.5 }) },
      {
        say: "Warm evening light baked onto the dried pastel.",
        tool: "paintfx__apply_effect",
        args: (ctx) => ({ target: ctx.results.hills.id, effect: "fake.tint", values: { color: "#f59e0b", amount: 0.5 }, opacity: 0.8 }),
      },
      { say: "A ribbon painted with a sunset gradient: brushes take each pixel's colour from it, fixed to the canvas.", tool: "paint__add_layer", args: { name: "Ribbon" }, as: "ribbon" },
      { tool: "paintfx__set_effect_paint", args: { effect: "fake.gradient", values: { from: "#f97316", to: "#7c3aed", angle: 0 } } },
      { tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.ribbon.id, brushId: "bristle-flat", brush: { tip: { size: 70 } }, points: wave(260, 60) }) },
      { tool: "paint__set_color", args: { color: "#1f2937" } },
      { say: "A caption bar on its own effect layer.", tool: "paintfx__add_effect_layer", args: { effect: "fake.bar", values: { color: "#0ea5e9", height: 0.08 }, time: 2000, name: "Caption" } },
      { say: "Checking what is applied.", tool: "paintfx__list_applied_effects", args: {} },
      { say: "Rendering a preview to check it.", tool: "paint__render_preview", args: { maxSide: 420 } },
    ],
  },
  {
    id: "paint-landscape",
    prompt: "Block in a sunset landscape in pastel",
    steps: [
      { say: "Rough watercolour paper with plenty of tooth for pastel.", tool: "paint__set_paper", args: { preset: "cold-pressed", depth: 0.7 } },
      { say: "A warm sky first, rubbed into the grain.", tool: "paint__add_layer", args: { name: "Sky" }, as: "sky" },
      { tool: "paint__fill_layer", args: (ctx) => ({ layerId: ctx.results.sky.id, color: "#f2a65a", grain: 0.5, pressure: 0.7 }) },
      { say: "Mixing a muted blue-grey for the far hills, as paint would mix.", tool: "paint__mix_colors", args: { colors: [{ color: "#2f3f9e", weight: 2 }, { color: "#d23a2a", weight: 1 }, { color: "#f7f5ee", weight: 1 }] }, as: "mix" },
      { say: "The first range of hills with a soft pastel.", tool: "paint__add_layer", args: { name: "Hills" }, as: "hills" },
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
      { say: "Eight mirrored segments about the centre: one stroke paints all sixteen copies.", tool: "paint__set_symmetry", args: { mode: "kaleidoscope", segments: 8, center: { x: 600, y: 400 } } },
      { tool: "paint__add_layer", args: { name: "Ornament" } },
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
      { say: "Symmetry off again, so later strokes are single.", tool: "paint__set_symmetry", args: { mode: "off" } },
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
  {
    id: "paint-watercolor",
    prompt: "Paint a watercolour sky over hills",
    steps: [
      { say: "Watercolour wants rough paper: its grain pins the edges and catches granulating pigment.", tool: "paint__set_paper", args: { preset: "rough-watercolor" } },
      { say: "Sky first, wet-in-wet: soak the top of the sheet with clear water.", tool: "paint__add_layer", args: { name: "Sky wash" }, as: "sky" },
      { tool: "paint__wet_paper", args: (ctx) => ({ layerId: ctx.results.sky.id, rect: { x: 0, y: 0, width: 1200, height: 430 } }) },
      {
        say: "A broad wash of blue into the wet paper: it spreads softly, with no hard edge.",
        tool: "paint__paint_stroke",
        args: (ctx) => ({ layerId: ctx.results.sky.id, brushId: "watercolor-wash", brush: { tip: { size: 140 } }, color: "#3b6fc4", points: wave(110, 20) }),
      },
      { tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.sky.id, brushId: "watercolor-wash", brush: { tip: { size: 120 } }, color: "#e9a46b", points: wave(330, 15) }) },
      { say: "Letting it flow for two seconds: the colours bleed where they meet.", tool: "paint__advance_wet_paint", args: { seconds: 2 } },
      {
        say: "Lifting clouds out of the wet sky with a tissue.",
        tool: "paint__paint_stroke",
        args: (ctx) => ({ layerId: ctx.results.sky.id, brushId: "blot", brush: { tip: { size: 90 } }, points: [{ x: 300, y: 140 }, { x: 420, y: 120 }, { x: 520, y: 150 }] }),
      },
      { say: "Drying the sky, so the hills glaze over it instead of mixing in.", tool: "paint__dry_paint", args: {} },
      { say: "Hills on dry paper, with heavy granulating pigment and darker rims as they dry.", tool: "paint__add_layer", args: { name: "Hills" }, as: "hills" },
      { tool: "paint__set_wet_settings", args: (ctx) => ({ layerId: ctx.results.hills.id, granulation: 0.9, edgeDarkening: 0.8 }) },
      {
        tool: "paint__paint_stroke",
        args: (ctx) => ({ layerId: ctx.results.hills.id, brushId: "watercolor-wash", brush: { tip: { size: 150 }, wet: { pigment: 0.6 } }, color: "#3f5f4a", points: wave(560, 45) }),
      },
      { say: "Tilting the board so the wet hills bead and run down a little.", tool: "paint__set_canvas_tilt", args: { angle: 35, direction: 0 } },
      { tool: "paint__advance_wet_paint", args: { seconds: 3 } },
      { tool: "paint__set_canvas_tilt", args: { angle: 0 } },
      { tool: "paint__dry_paint", args: {} },
      { say: "Checking the result.", tool: "paint__render_preview", args: { maxSide: 420 } },
    ],
  },  {
    id: "paint-impasto",
    prompt: "Paint thick oil sunflowers with a palette knife",
    steps: [
      { say: "Canvas for oils, lit low from the top left so the brushwork shows.", tool: "paint__set_paper", args: { preset: "cotton-canvas" } },
      { tool: "paint__set_lighting", args: { azimuth: 315, elevation: 28, relief: 0.8 } },
      { say: "A wet oil ground: wet colours blend where they meet.", tool: "paint__add_layer", args: { name: "Ground" }, as: "ground" },
      { tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.ground.id, brushId: "oil-flat", brush: { tip: { size: 180 } }, color: "#2f6f9f", points: wave(160, 20) }) },
      { tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.ground.id, brushId: "oil-flat", brush: { tip: { size: 180 } }, color: "#d9b44a", points: wave(330, 20) }) },
      { say: "Dry the ground before the thick paint goes on.", tool: "paint__dry_paint", args: {} },
      { say: "Thick petals squeezed from the tube.", tool: "paint__add_layer", args: { name: "Flowers" }, as: "flowers" },
      {
        tool: "paint__paint_stroke",
        args: (ctx) => ({ layerId: ctx.results.flowers.id, brushId: "paint-tube", brush: { tip: { size: 34 } }, color: "#f4c20d", points: ring(400, 260, 90) }),
      },
      { say: "The palette knife drags the petals into ridges.", tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.flowers.id, brushId: "palette-knife", points: ring(400, 260, 70) }) },
      { say: "A glossy, gold-flecked centre.", tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.flowers.id, brushId: "metallic-paint", color: "#7a4a12", points: ring(400, 260, 25) }) },
      { tool: "paint__render_preview", args: { maxSide: 420 } },
    ],
  },
  {
    id: "paint-gradient",
    prompt: "Paint a sunset sky and a rainbow with gradient paint",
    steps: [
      {
        say: "Gradient paint: the colour changes as the stroke is dragged out. Purple to rose to amber over 600 px, mixed like paint.",
        tool: "paint__set_paint",
        args: {
          paint: {
            type: "gradient",
            stops: [
              { offset: 0, color: "#5b21b6" },
              { offset: 0.55, color: "#e11d48" },
              { offset: 1, color: "#f59e0b" },
            ],
            map: { by: "distance", length: 600, repeat: "mirror" },
          },
        },
      },
      { tool: "paint__add_layer", args: { name: "Sky" }, as: "sky" },
      { tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.sky.id, brushId: "soft-pastel", brush: { tip: { size: 90 } }, points: wave(150, 30) }) },
      { tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.sky.id, brushId: "soft-pastel", brush: { tip: { size: 90 } }, points: wave(240, 25) }) },
      { say: "A rainbow: a brush with its own gradient, stripes laid side by side across the tip.", tool: "paint__add_layer", args: { name: "Rainbow" }, as: "rainbow" },
      {
        tool: "paint__paint_stroke",
        args: (ctx) => ({
          layerId: ctx.results.rainbow.id,
          brushId: "ink-pen",
          brush: { tip: { size: 70, hardness: 0.6 } },
          paint: {
            type: "gradient",
            stops: ["#e11d48", "#f59e0b", "#facc15", "#22c55e", "#3b82f6", "#8b5cf6"].map((color, k) => ({ offset: k / 5, color })),
            space: "oklab",
            map: { by: "across-tip" },
          },
          points: ring(600, 560, 330).slice(24),
        }),
      },
      { say: "Pressure maps the gradient too: light pressure lays the second colour, full pressure the paint colour.", tool: "paint__set_color", args: { color: "#1f2937", secondaryColor: "#9ca3af" } },
      { tool: "paint__add_layer", args: { name: "Hills" }, as: "hills" },
      {
        tool: "paint__paint_stroke",
        args: (ctx) => ({ layerId: ctx.results.hills.id, brushId: "pressure-ombre", brush: { tip: { size: 60 } }, points: wave(560, 40).map((p: { x: number; y: number }, i: number) => ({ ...p, pressure: 0.2 + 0.8 * Math.abs(Math.sin(i / 6)) })) }),
      },
      { say: "Keep the sunset as a swatch.", tool: "paint__add_swatch", args: { paint: { type: "gradient", stops: [{ offset: 0, color: "#5b21b6" }, { offset: 0.55, color: "#e11d48" }, { offset: 1, color: "#f59e0b" }] }, name: "Sunset" } },
      { tool: "paint__render_preview", args: { maxSide: 420 } },
    ],
  },
  {
    id: "paint-procedural",
    prompt: "Draw a stencilled moon with hair, curls and stickers",
    steps: [
      { say: "A circle stencil as a mask: everything painted next lands inside it.", tool: "paint__add_stencil", args: { kind: "shape", shape: "ellipse", rect: { x: 420, y: 140, width: 360, height: 360 } }, as: "moon" },
      { tool: "paint__add_layer", args: { name: "Moon" }, as: "moonLayer" },
      { tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.moonLayer.id, brushId: "dry-brush", brush: { tip: { size: 160 } }, color: "#e8e1c8", points: wave(320, 60) }) },
      { tool: "paint__remove_stencils", args: {} },
      { say: "A ruler: the stroke follows it exactly for a straight horizon.", tool: "paint__add_stencil", args: { kind: "ruler", from: { x: 0, y: 600 }, to: { x: 1200, y: 600 } } },
      { tool: "paint__add_layer", args: { name: "Grass" }, as: "grass" },
      { tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.grass.id, brushId: "hair-strands", color: "#2f6b3a", points: wave(605, 10) }) },
      { tool: "paint__remove_stencils", args: {} },
      { say: "Orbit curls for the wind.", tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.grass.id, brushId: "orbit-curls", color: "#8aa4c8", points: wave(180, 40) }) },
      { say: "Stars as stickers: each one stays editable.", tool: "paint__add_layer", args: { name: "Stars" }, as: "stars" },
      { tool: "paint__paint_stroke", args: (ctx) => ({ layerId: ctx.results.stars.id, brushId: "sticker-stars", color: "#f5d76e", points: wave(90, 30) }) },
      { tool: "paint__list_stickers", args: (ctx) => ({ layerId: ctx.results.stars.id }), as: "list" },
      { say: "One star bigger, as the brightest.", tool: "paint__update_sticker", args: (ctx) => ({ layerId: ctx.results.stars.id, id: ctx.results.list.stickers[0].id, size: 70 }) },
      { tool: "paint__render_preview", args: { maxSide: 420 } },
    ],
  },
];
