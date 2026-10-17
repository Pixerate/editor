// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import {
  Chart,
  ChartNodeView,
  createRichTextPreset,
  getDocumentCharts,
  getEditorMarkdown,
  isChartEnabled,
  markdownToTipTapHtml,
  sanitizeImportedHtml,
  type ChartNodeViewState,
} from "../src";
import { chartToMermaid, chartToOoxml, createChartSpec, type ChartSpec } from "../src/chart";
import { docxToDocumentImport, insertImportedDocument } from "../src";
import { buildDocx, p } from "./helpers/zip-writer";
import { ToolRegistry } from "../src/tools/registry";
import { createRichTextToolProvider } from "../src/agent/providers";

// Editors left alive keep ProseMirror's DOMObserver timers, which can fire after jsdom is torn down.
const created: Editor[] = [];
class TrackedEditor extends Editor {
  constructor(options?: ConstructorParameters<typeof Editor>[0]) {
    super(options);
    created.push(this);
  }
}
afterEach(() => {
  for (const editor of created.splice(0)) if (!editor.isDestroyed) editor.destroy();
});

const SPEC = createChartSpec({
  type: "bar",
  title: "Revenue",
  categories: ["Q1", "Q2", "Q3"],
  series: [
    { id: "north", name: "North", values: [10, 20, 15], color: "#4472c4" },
    { id: "south", name: "South", values: [5, null, 12] },
  ],
  stacking: "stacked",
});

const make = (content: any = "", options: Record<string, unknown> = {}) =>
  new TrackedEditor({ extensions: createRichTextPreset({ chart: true, markdown: true, ...options }), content });

const chartNodes = (editor: Editor) => getDocumentCharts(editor.state.doc);

describe("chart node", () => {
  it("is opt-in", () => {
    expect(isChartEnabled(new TrackedEditor({ extensions: createRichTextPreset() }))).toBe(false);
    const editor = make();
    expect(isChartEnabled(editor)).toBe(true);
    expect(editor.schema.nodes.sparkline).toBeDefined();
    expect(isChartEnabled(make("", { chart: { sparkline: false } }))).toBe(true);
    expect(make("", { chart: { sparkline: false } }).schema.nodes.sparkline).toBeUndefined();
  });

  it("inserts a chart with a fresh id and a normalized spec", () => {
    const editor = make("<p>Intro</p>");
    editor.commands.setTextSelection(editor.state.doc.content.size);
    expect(editor.commands.insertChart({ spec: { title: "T", categories: ["a"], series: [{ name: "S", values: ["1,200"] }] } })).toBe(true);
    const [chart] = chartNodes(editor);
    expect(chart.id).toMatch(/^chart-/);
    expect(chart.spec.version).toBe(1);
    expect(chart.spec.series[0].values).toEqual([1200]);
    expect(chart.node.attrs.height).toBe(320);
  });

  it("round-trips through HTML with a static SVG", () => {
    const editor = make({ type: "doc", content: [{ type: "chart", attrs: { id: "c1", spec: SPEC, width: 500, height: 300 } }] });
    const html = editor.getHTML();
    expect(html).toMatch(/^<div data-chart-id="c1" data-chart="[^"]+" data-width="500" data-height="300" data-type="chart" class="pixerate-chart"><svg/);
    expect(html).toContain('aria-label="Revenue"');
    expect(html).toContain("<title>Revenue</title>");
    expect(html).toMatch(/<rect[^>]*data-role="bar"/);
    const copy = make(html);
    const [chart] = chartNodes(copy);
    expect(chart).toMatchObject({ id: "c1", spec: SPEC });
    expect(chart.node.attrs).toMatchObject({ width: 500, height: 300 });
  });

  it("survives the import sanitizer (the SVG is dropped, the spec kept)", () => {
    const html = make({ type: "doc", content: [{ type: "chart", attrs: { id: "c1", spec: SPEC } }] }).getHTML();
    const clean = sanitizeImportedHtml(html);
    expect(clean).not.toContain("<svg");
    expect(chartNodes(make(clean))[0].spec).toEqual(SPEC);
  });

  it("keeps the fallback content of a div whose spec is broken", () => {
    const editor = make('<div data-type="chart" data-chart="{oops"><p>Fallback</p></div>');
    expect(chartNodes(editor)).toHaveLength(0);
    expect(editor.getText()).toBe("Fallback");
  });

  it("round-trips through markdown as a mermaid block", () => {
    const editor = make({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Before" }] }, { type: "chart", attrs: { spec: SPEC } }] });
    const md = getEditorMarkdown(editor);
    expect(md).toBe(`Before\n\n\`\`\`mermaid\n${chartToMermaid(SPEC).trimEnd()}\n\`\`\``);
    const back = make(md);
    expect(chartNodes(back)[0].spec).toEqual(SPEC);
    expect(back.state.doc.firstChild!.textContent).toBe("Before");
  });

  it("reads hand-written mermaid charts but leaves other diagrams as code", () => {
    const editor = make("```mermaid\npie title Pets\n    \"Dogs\" : 3\n    \"Cats\" : 2\n```\n\n```mermaid\ngraph TD; A-->B\n```");
    const [chart] = chartNodes(editor);
    expect(chart.spec).toMatchObject({ type: "pie", title: "Pets", categories: ["Dogs", "Cats"] });
    expect(editor.state.doc.child(1).type.name).toBe("codeBlock");
    expect(editor.state.doc.child(1).textContent).toBe("graph TD; A-->B");
  });

  it("lengthens the fence when the chart text contains backticks", () => {
    const spec = createChartSpec({ title: "a ``` b", categories: ["x"], series: [{ name: "S", values: [1] }] });
    const md = getEditorMarkdown(make({ type: "doc", content: [{ type: "chart", attrs: { spec } }] }));
    expect(md.startsWith("````mermaid\n")).toBe(true);
    expect(chartNodes(make(md))[0].spec.title).toBe("a ``` b");
  });

  it("gives copied charts their own ids", () => {
    const editor = make({ type: "doc", content: [{ type: "chart", attrs: { id: "same", spec: SPEC } }, { type: "chart", attrs: { id: "same", spec: SPEC } }] });
    const [a, b] = chartNodes(editor);
    expect(a.id).toBe("same");
    expect(b.id).toMatch(/^chart-/);
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "chart", attrs: { id: "same", spec: SPEC } });
    const ids = chartNodes(editor).map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("updates a chart by id as one undo step", () => {
    const editor = make({ type: "doc", content: [{ type: "chart", attrs: { id: "c1", spec: SPEC } }] });
    expect(editor.commands.updateChart("c1", { spec: { ...SPEC, type: "line" }, height: 200 })).toBe(true);
    expect(chartNodes(editor)[0].spec.type).toBe("line");
    expect(chartNodes(editor)[0].node.attrs.height).toBe(200);
    expect(editor.commands.updateChart("missing", { height: 100 })).toBe(false);
    editor.commands.undo();
    expect(chartNodes(editor)[0].spec.type).toBe("bar");
  });

  it("writes plain text as a caption", () => {
    expect(make({ type: "doc", content: [{ type: "chart", attrs: { spec: SPEC } }] }).getText()).toBe("[Chart: Revenue]");
  });
});

describe("sparkline node", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Sales " }, { type: "sparkline", attrs: { values: [1, 3, null, 2], kind: "column", color: "#f00" } }, { type: "text", text: " up" }] },
    ],
  };

  it("round-trips through HTML and markdown", () => {
    const editor = make(doc);
    const html = editor.getHTML();
    expect(html).toContain('data-values="[1,3,null,2]"');
    expect(html).toContain('data-kind="column"');
    expect(html).toMatch(/<span[^>]*data-type="sparkline"[^>]*><svg[^>]*aria-label="Trend from 1 to 2"/);
    expect(make(html).getJSON()).toEqual(editor.getJSON());
    const md = getEditorMarkdown(editor);
    expect(md).toContain('<span data-type="sparkline" data-values="[1,3,null,2]" data-kind="column"');
    expect(markdownToTipTapHtml(md)).toContain('data-type="sparkline"');
    expect(make(md).getJSON()).toEqual(editor.getJSON());
  });

  it("inserts cleaned values", () => {
    const editor = make("<p>x</p>");
    editor.commands.setTextSelection(2);
    editor.commands.insertSparkline({ values: [1, Number.NaN, 4], kind: "win-loss" as any });
    let node: any;
    editor.state.doc.descendants((n) => {
      if (n.type.name === "sparkline") node = n;
    });
    expect(node.attrs).toMatchObject({ values: [1, null, 4], kind: "win-loss", width: 80, height: 18 });
  });
});

describe("chart node view", () => {
  const mountable = () => {
    const states: ChartNodeViewState[] = [];
    let destroyed = 0;
    const nodeView = (dom: HTMLElement, state: ChartNodeViewState) => {
      states.push(state);
      dom.textContent = "mounted";
      return { update: (s: ChartNodeViewState) => void states.push(s), destroy: () => void destroyed++ };
    };
    return { states, nodeView, destroyed: () => destroyed };
  };

  it("draws the static SVG without a framework view", () => {
    const element = document.createElement("div");
    const editor = new TrackedEditor({ element, extensions: createRichTextPreset({ chart: true }), content: { type: "doc", content: [{ type: "chart", attrs: { id: "c1", spec: SPEC } }] } });
    const dom = element.querySelector(".pixerate-chart-node")!;
    expect(dom.querySelector("svg")?.getAttribute("aria-label")).toBe("Revenue");
    editor.commands.updateChart("c1", { spec: { ...SPEC, title: "Costs" } });
    expect(element.querySelector(".pixerate-chart-node svg")?.getAttribute("aria-label")).toBe("Costs");
    editor.destroy();
  });

  it("keeps the controller and the document in step", () => {
    const { states, nodeView, destroyed } = mountable();
    const element = document.createElement("div");
    const editor = new TrackedEditor({ element, extensions: createRichTextPreset({ chart: { nodeView } }), content: { type: "doc", content: [{ type: "chart", attrs: { id: "c1", spec: SPEC } }] } });
    const first = states[0];
    expect(first).toMatchObject({ id: "c1", editing: false, selected: false, editable: true, width: null, height: 320 });
    expect(first.controller.getSpec()).toEqual(SPEC);

    // Click to edit: selects the node and opens the inspector.
    first.setEditing(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(states.at(-1)).toMatchObject({ editing: true, selected: true });

    // An inspector edit is written back as one document step.
    first.controller.setType("line");
    expect(chartNodes(editor)[0].spec.type).toBe("line");

    // A gesture is written back once it ends.
    first.controller.beginGesture("Drag");
    first.controller.setValue("north", 0, 99);
    expect(chartNodes(editor)[0].spec.series[0].values[0]).toBe(10);
    first.controller.endGesture();
    expect(chartNodes(editor)[0].spec.series[0].values[0]).toBe(99);

    // Undo in the editor loads into the controller.
    editor.commands.undo();
    expect(first.controller.getSpec().series[0].values[0]).toBe(10);
    editor.commands.undo();
    expect(first.controller.getSpec().type).toBe("bar");

    // Moving the selection away closes the inspector; a read-only editor never opens it.
    editor.commands.setTextSelection(0);
    expect(states.at(-1)).toMatchObject({ editing: false, selected: false });
    editor.setEditable(false);
    expect(states.at(-1)!.editable).toBe(false);
    first.setEditing(true);
    expect(states.at(-1)!.editing).toBe(false);

    editor.destroy();
    expect(destroyed()).toBe(1);
  });

  it("lets inspector events through only while editing, and resizes", () => {
    const { states, nodeView } = mountable();
    const element = document.createElement("div");
    const editor = new TrackedEditor({ element, extensions: [...createRichTextPreset({ chart: { nodeView } })], content: { type: "doc", content: [{ type: "chart", attrs: { id: "c1", spec: SPEC } }] } });
    const view = (editor.view as any).docView.children[0].spec as ChartNodeView;
    expect(view).toBeInstanceOf(ChartNodeView);
    expect(view.stopEvent(new Event("keydown"))).toBe(false);
    states[0].setEditing(true);
    expect(view.stopEvent(new Event("keydown"))).toBe(true);
    expect(view.ignoreMutation()).toBe(true);
    states[0].setSize({ height: 240 });
    expect(chartNodes(editor)[0].node.attrs.height).toBe(240);
    expect(states.at(-1)!.height).toBe(240);
    editor.destroy();
  });
});

describe("DOCX charts", () => {
  const docx = async () => {
    const chart = chartToOoxml(createChartSpec({ title: "Revenue", categories: ["Q1", "Q2"], series: [{ name: "North", values: [10, 20] }] })).xml;
    const drawing = `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Chart 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const bytes = await buildDocx({
      body: p(`<w:r><w:t>Before</w:t></w:r>${drawing}`) + p(drawing) + p(`<w:r><w:t>After</w:t></w:r>`),
      rels: '<Relationship Id="rChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/>',
      files: { "word/charts/chart1.xml": chart },
    });
    return docxToDocumentImport(bytes, { DOMParser: window.DOMParser as any });
  };

  it("become chart nodes when the schema has them", async () => {
    const result = await docx();
    const editor = make();
    insertImportedDocument(editor, result, { at: 0 });
    const charts = chartNodes(editor);
    expect(charts).toHaveLength(2);
    expect(charts[0].id).toBe("chart-1");
    // The second anchor of the same chart part gets its own id.
    expect(charts[1].id).not.toBe("chart-1");
    expect(charts[0].spec).toEqual(result.charts![0].spec);
    // (The trailing paragraph is the empty one the editor started with.)
    expect(editor.getText({ blockSeparator: "|" })).toBe("Before|[Chart: Revenue]|[Chart: Revenue]|After|");
    expect(editor.getHTML()).not.toContain("<table");
  });

  it("stay a caption and a data table without the chart node", async () => {
    const result = await docx();
    const editor = make("", { chart: false });
    insertImportedDocument(editor, result, { at: 0 });
    const types: string[] = [];
    editor.state.doc.forEach((n) => void types.push(n.type.name));
    expect(types).toEqual(["paragraph", "paragraph", "table", "paragraph", "table", "paragraph", "paragraph"]);
    expect(editor.state.doc.child(1).textContent).toBe("[Chart: Revenue]");
    expect(editor.state.doc.child(2).textContent).toContain("North");
  });
});

describe("document chart tools", () => {
  const setup = (content: any = "<p>Intro</p><p>Outro</p>", options: Record<string, unknown> = {}) => {
    const editor = make(content, options);
    const registry = new ToolRegistry();
    registry.register(createRichTextToolProvider(editor, { id: "doc" }));
    const call = async (name: string, args: Record<string, unknown>) => registry.callTool(name, args);
    const ok = async (name: string, args: Record<string, unknown>) => {
      const result = await call(name, args);
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      return result.structuredContent as any;
    };
    const error = async (name: string, args: Record<string, unknown>) => {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      return (result.content as any)[0].text as string;
    };
    return { editor, registry, ok, error };
  };
  const names = (registry: ToolRegistry) => registry.listTools().tools.map((t) => t.name);

  it("are listed only when the schema has charts, and only reads while read-only", () => {
    const plain = new ToolRegistry();
    plain.register(createRichTextToolProvider(new TrackedEditor({ extensions: createRichTextPreset() }), { id: "doc" }));
    expect(names(plain)).not.toContain("list_document_charts");
    const { editor, registry } = setup();
    expect(names(registry)).toEqual(expect.arrayContaining(["list_document_charts", "insert_chart", "update_chart_in_document", "insert_sparkline"]));
    editor.setEditable(false);
    expect(names(registry)).toContain("list_document_charts");
    expect(names(registry)).not.toContain("insert_chart");
    expect(names(registry)).not.toContain("update_chart_in_document");
    const noSparkline = setup("", { chart: { sparkline: false } });
    expect(names(noSparkline.registry)).not.toContain("insert_sparkline");
  });

  it("insert_chart → list_document_charts → update_chart_in_document closes the loop", async () => {
    const { editor, ok } = setup();
    const inserted = await ok("insert_chart", {
      at: 7,
      spec: { title: "Sales", categories: ["Jan", "Feb"], series: [{ name: "Online", values: [3, "1,200"], color: null }] },
      height: 240,
    });
    expect(inserted.id).toMatch(/^chart-/);
    expect(inserted.spec.series[0]).toMatchObject({ name: "Online", values: [3, 1200] });
    expect(inserted.height).toBe(240);
    expect(editor.state.doc.nodeAt(inserted.pos)?.type.name).toBe("chart");

    const listed = await ok("list_document_charts", {});
    expect(listed.charts).toEqual([
      expect.objectContaining({ id: inserted.id, pos: inserted.pos, type: "bar", title: "Sales", categories: ["Jan", "Feb"], series: [{ id: inserted.spec.series[0].id, name: "Online" }], width: null, height: 240 }),
    ]);
    expect(listed.charts[0].spec).toBeUndefined();
    expect((await ok("list_document_charts", { includeSpec: true })).charts[0].spec).toEqual(inserted.spec);

    const updated = await ok("update_chart_in_document", { chartId: inserted.id, changes: { type: "line", yAxis: { title: "Units" } }, width: 400 });
    expect(updated.spec).toMatchObject({ type: "line", title: "Sales", yAxis: { title: "Units", gridlines: true } });
    expect(updated.width).toBe(400);
    const byPos = await ok("update_chart_in_document", { pos: inserted.pos, changes: { series: [{ name: "Retail", values: [1, 2] }] } });
    expect(byPos.spec.series.map((s: any) => s.name)).toEqual(["Retail"]);

    // Each write is one undo step.
    editor.commands.undo();
    expect(chartNodes(editor)[0].spec.series[0].name).toBe("Online");
    editor.commands.undo();
    expect(chartNodes(editor)[0].spec.type).toBe("bar");
  });

  it("fails usefully and changes nothing", async () => {
    const { editor, ok, error } = setup();
    expect(await error("insert_chart", { spec: { categories: ["a"], series: [{ name: "S", values: ["lots"] }] } })).toMatch(/not changed.*not a number/i);
    expect(await error("insert_chart", { spec: { categories: [], series: [] }, at: 999 })).toMatch(/outside the document/);
    expect(await error("insert_chart", { spec: { categories: [] } })).toMatch(/series/);
    expect(chartNodes(editor)).toHaveLength(0);
    expect(await error("update_chart_in_document", { changes: { type: "line" } })).toMatch(/Pass chartId or pos.*none; add one with insert_chart/);
    const { id, pos } = await ok("insert_chart", { spec: { categories: ["a"], series: [{ name: "S", values: [1] }] } });
    expect(await error("update_chart_in_document", { chartId: "nope", changes: { type: "line" } })).toContain(`"${id}" at ${pos}`);
    expect(await error("update_chart_in_document", { pos: 0, changes: { type: "line" } })).toMatch(/no chart at position 0/);
    expect(await error("update_chart_in_document", { chartId: id })).toMatch(/Nothing to change/);
    expect(await error("update_chart_in_document", { chartId: id, changes: { innerRadius: 2 } })).toMatch(/maximum|innerRadius/);
    expect(await error("update_chart_in_document", { chartId: id, changes: { bogus: 1 } })).toMatch(/bogus/);
    expect(chartNodes(editor)[0].spec.type).toBe("bar");
  });

  it("insert_sparkline puts a sparkline in the text", async () => {
    const { editor, ok, error } = setup();
    const result = await ok("insert_sparkline", { values: [1, "2", null, 4], kind: "column", at: 3 });
    expect(result).toEqual({ pos: 3, kind: "column", values: [1, 2, null, 4] });
    expect(editor.state.doc.nodeAt(3)?.type.name).toBe("sparkline");
    expect((await ok("list_document_charts", {})).sparklines).toEqual([{ pos: 3, kind: "column", values: [1, 2, null, 4], label: "Trend from 1 to 4" }]);
    expect(await error("insert_sparkline", { values: ["x"] })).toMatch(/values\[0\].*not a number/);
    expect(await error("insert_sparkline", { values: [1], at: 0 })).toMatch(/between blocks/);
  });
});

// Keep the type import used.
export type { ChartSpec };
void Chart;
