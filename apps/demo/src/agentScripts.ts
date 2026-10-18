import type { AgentScript, AgentScriptContext } from "./agentScript";

// One or two scripted requests per editor. Every step is a real tool call through the demo's
// ToolRegistry (the same tools listed in "Agent tools for this editor"); later steps take ids and
// positions from earlier results, as a model would.

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
        target: { text: "photorealistic portrait" },
      },
      { say: "Adding lighting after the composition, leaving the variables alone.", tool: "prompt__find_text", args: { query: "composition" }, as: "composition" },
      {
        tool: "prompt__insert_text",
        args: (ctx) => ({ at: firstMatch(ctx, "composition").to, text: ", low-key lighting, neon signs reflected in wet asphalt" }),
        target: { text: "composition" },
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
        target: { text: "standard document rich text capabilities" },
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
      { say: "Saying so in the title.", tool: "chart__update_chart", args: (ctx) => ({ title: `${(ctx.results.chart.spec ?? ctx.results.chart).title || "Chart"} (+15%)` }) },
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

export const VECTOR_SCRIPTS: AgentScript[] = [
  {
    id: "vector-night",
    prompt: "Turn the scene into night",
    steps: [
      { say: "Listing the artwork's shapes.", ...command("vector.list") },
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
        target: { selector: '[data-node-id="sun"]' },
      },
      { say: "Darkening the hill.", ...command("vector.setStyle", { ids: ["hill"], fill: "#14532d", stroke: "#052e16" }), target: { selector: '[data-node-id="hill"]' } },
      { say: "A few stars in the sky.", ...command("vector.addShape", { kind: "star", x: 360, y: 40, width: 26, height: 26, points: 5, innerRatio: 0.45, fill: "#fde68a", name: "Star" }) },
      { ...command("vector.addShape", { kind: "star", x: 440, y: 120, width: 18, height: 18, points: 5, innerRatio: 0.45, fill: "#fef3c7", name: "Star" }) },
      { ...command("vector.addShape", { kind: "star", x: 520, y: 30, width: 14, height: 14, points: 5, innerRatio: 0.45, fill: "#fef9c3", name: "Star" }) },
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
        say: "Then the check gives a little shake.",
        tool: "animation__add_commands",
        args: { shot: "finale", commands: [{ type: "shake", targets: ["check"], count: 3 }] },
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
