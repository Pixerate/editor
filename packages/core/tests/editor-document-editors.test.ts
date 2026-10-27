import { beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { createDocumentToolProvider, type EditorDocument } from "../src/persistence";
import { ToolRegistry } from "../src/tools";
import { ChartController, createChartEditorDocument } from "../src/chart";
import { AnimationEditorController, createAnimationEditorDocument, createMotionScene } from "../src/animation-editor";
import { VideoEditorController, createVideoEditorDocument, createVideoProject } from "../src/video-editor";
import { ParametersController, createParametersEditorDocument } from "../src/parameters";
import { VectorEditorController, createVectorEditorDocument } from "../src/vector";
import { SpreadsheetController, createSpreadsheetEditorDocument } from "../src/spreadsheet";
import { TokenStore, createTokensEditorDocument } from "../src/tokens";
import { createRichTextEditorDocument, createRichTextPreset } from "../src";
import { CanvasScenesStore, createCanvasEditorDocument, createCanvasGestureRecorder, type CanvasEdge, type CanvasNode } from "../src/canvas";
import { HistoryManager } from "../src/history";

beforeAll(() => {
  const dom = new JSDOM("", { pretendToBeVisual: true });
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

const text = (result: any) => result.content?.[0]?.text as string;

function tools(doc: EditorDocument, history = false) {
  const registry = new ToolRegistry();
  registry.register(createDocumentToolProvider(doc, { namespace: "", history }));
  return registry;
}

/** The checks every editor's document must pass. */
async function contract<T>(options: {
  doc: EditorDocument<T>;
  current: () => unknown;
  undo: () => void;
  next: T;
  invalid: unknown;
  invalidMessage: RegExp | string;
  viewChange: () => void;
}) {
  const { doc } = options;
  const registry = tools(doc);
  const start = doc.getDocument();
  // Round trip: opening its own snapshot changes nothing.
  doc.loadDocument(doc.getDocument());
  expect(doc.getDocument()).toEqual(start);
  const revision = doc.revision();
  // Selection, playhead and view changes are not document changes.
  options.viewChange();
  expect(doc.revision()).toBe(revision);
  // Agents' loads are one undo step.
  const loaded: any = await registry.callTool(`load_${doc.kind}_document`, { document: options.next });
  expect(loaded.isError, text(loaded)).toBeFalsy();
  expect(loaded.structuredContent.undoable).toBe(true);
  expect(doc.revision()).toBeGreaterThan(revision);
  const got: any = await registry.callTool(`get_${doc.kind}_document`, {});
  expect(got.structuredContent.kind).toBe(doc.kind);
  options.undo();
  expect(doc.getDocument()).toEqual(start);
  // Bad documents are refused and change nothing.
  const bad: any = await registry.callTool(`load_${doc.kind}_document`, { document: options.invalid });
  expect(bad.isError).toBe(true);
  expect(text(bad)).toMatch(options.invalidMessage);
  expect(doc.getDocument()).toEqual(start);
  // Opening a file resets the history.
  doc.loadDocument(options.next);
  expect(doc.history.getState().canUndo).toBe(false);
}

describe("editor documents", () => {
  it("chart", async () => {
    const controller = new ChartController({ spec: { type: "bar", categories: ["a", "b"], series: [{ id: "s", name: "S", values: [1, 2] }] } });
    const doc = createChartEditorDocument(controller);
    await contract({
      doc,
      current: () => controller.toJSON(),
      undo: () => controller.undo(),
      next: { ...controller.toJSON(), type: "line", title: "Sales" },
      invalid: { type: "doughnut-ish", series: 3 },
      invalidMessage: /series must be an array/,
      viewChange: () => controller.select({ kind: "series", seriesId: "s" }),
    });
  });

  it("chart files with problems open with defaults and report them", () => {
    const controller = new ChartController();
    const report = createChartEditorDocument(controller).loadDocument({ type: "bar", series: 3 });
    expect(report.problems.map((p) => p.message)).toContain("series must be an array.");
    expect(controller.toJSON().type).toBe("bar");
  });

  it("animation", async () => {
    const controller = new AnimationEditorController({ scene: createMotionScene({ width: 10, height: 10, nodes: [] }, { name: "a" }) });
    const doc = createAnimationEditorDocument(controller);
    await contract({
      doc,
      current: () => controller.getScene(),
      undo: () => controller.undo(),
      next: createMotionScene({ width: 20, height: 20, nodes: [] }, { name: "b" }),
      invalid: { version: 1, shots: "x" },
      invalidMessage: '"shots" must be a list.',
      viewChange: () => controller.seek(5),
    });
  });

  it("video", async () => {
    const controller = new VideoEditorController({ project: createVideoProject({ name: "a" }) });
    const doc = createVideoEditorDocument(controller);
    await contract({
      doc,
      current: () => controller.getProject(),
      undo: () => controller.undo(),
      next: createVideoProject({ name: "b" }),
      invalid: { version: 1, tracks: 4 },
      invalidMessage: "tracks must be an array.",
      viewChange: () => controller.seek(100),
    });
  });

  it("parameters", async () => {
    const controller = new ParametersController({
      schema: { fields: [{ id: "speed", type: "number", min: 0, max: 4, default: 1 }, { id: "label", type: "text", default: "x" }] },
    });
    const doc = createParametersEditorDocument(controller);
    await contract({
      doc,
      current: () => controller.toJSON(),
      undo: () => controller.undo(),
      next: { values: { speed: 2, label: "y" }, presets: [] },
      invalid: { values: { speed: 2, nope: 1 } },
      invalidMessage: /nope/,
      viewChange: () => controller.setTime(5),
    });
    // Missing values take their defaults.
    doc.loadDocument({ values: { speed: 3 } }, { history: "record" });
    expect(controller.toJSON().values).toEqual({ speed: 3, label: "x" });
  });

  it("vector", async () => {
    const controller = new VectorEditorController();
    const doc = createVectorEditorDocument(controller);
    const tools2 = tools(doc, true);
    await contract({
      doc,
      current: () => controller.toJSON(),
      undo: () => controller.undo(),
      next: { ...controller.toJSON(), width: 320, height: 200, nodes: [] },
      invalid: { width: -1, nodes: [] },
      invalidMessage: "width must be a positive number.",
      viewChange: () => controller.setTool("pen"),
    });
    expect(text(await tools2.callTool("undo_vector", {}))).toBe("Nothing to undo.");
  });

  it("spreadsheet", async () => {
    const sheet = () => ({
      columns: [{ id: "c0", key: "A", title: "A", type: "freeform" as const }],
      rows: [{ id: "r0", index: 0, type: "freeform" as const }],
    });
    const controller = new SpreadsheetController({ document: sheet() });
    const doc = createSpreadsheetEditorDocument(controller);
    const next = controller.getWorkbook();
    next.sheets[0].cells = { r0: { c0: { raw: "=1+2" } } } as any;
    await contract({
      doc,
      current: () => controller.getWorkbook(),
      undo: () => controller.undo(),
      next,
      invalid: { sheets: [{ columns: [], rows: "x", cells: {} }] },
      invalidMessage: "sheets[0].rows must be an array.",
      viewChange: () => controller.selectCell(0, 0),
    });
    expect(controller.getCell("r0", "c0").raw).toBe("=1+2");
  });

  it("tokens", async () => {
    const store = new TokenStore();
    const doc = createTokensEditorDocument(store);
    const other = new TokenStore();
    const collection = other.createCollection("Colours", ["Light", "Dark"]);
    other.createVariable({ collectionId: collection.id, name: "brand", type: "color", values: { [collection.modes[0].id]: "#ff0000" } } as any);
    await contract({
      doc,
      current: () => store.toJSON(),
      undo: () => store.undo(),
      next: other.toJSON(),
      invalid: { collections: [{ id: "x" }], variables: [{ id: "v", collectionId: "missing" }] },
      invalidMessage: "Dropped an invalid collection. Dropped an invalid variable (v). A tokens document is",
      viewChange: () => store.resolve("nope"),
    });
  });

  it("tokens refuse broken aliases from agents", async () => {
    const store = new TokenStore();
    const doc = createTokensEditorDocument(store);
    const other = new TokenStore();
    const c = other.createCollection("Colours");
    const v = other.createVariable({ collectionId: c.id, name: "button", type: "color" } as any);
    const broken = other.toJSON();
    const bad = { ...broken, variables: broken.variables.map((x) => (x.id === v.id ? { ...x, valuesByMode: { [c.modes[0].id]: { alias: "nope" } } } : x)) };
    const result: any = await tools(doc).callTool("load_tokens_document", { document: bad });
    expect(text(result)).toMatch("`button` aliased a missing or mistyped variable");
    // A cycle between two variables is refused too.
    const w = other.createVariable({ collectionId: c.id, name: "link", type: "color" } as any);
    const mode = c.modes[0].id;
    const state = other.toJSON();
    const cycle = {
      ...state,
      variables: state.variables.map((x) => ({ ...x, valuesByMode: { [mode]: { alias: x.id === v.id ? w.id : v.id } } })),
    };
    const looped: any = await tools(doc).callTool("load_tokens_document", { document: cycle });
    expect(looped.isError).toBe(true);
    expect(text(looped)).toMatch(/cycle|loop|itself/i);
    expect(store.toJSON().variables).toEqual([]);
  });

  it("rich text", async () => {
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p>Hello</p>" });
    const doc = createRichTextEditorDocument(editor);
    await contract({
      doc,
      current: () => editor.getJSON(),
      undo: () => editor.commands.undo(),
      next: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Goodbye" }] }] },
      invalid: { type: "doc", content: [{ type: "nonsense" }] },
      invalidMessage: /Unknown node type: nonsense/,
      viewChange: () => editor.commands.setTextSelection(2),
    });
    editor.setEditable(false);
    const result: any = await tools(doc).callTool("load_rich_text_document", { document: doc.getDocument() });
    expect(text(result)).toMatch("The document is read-only.");
    editor.destroy();
  });

  it("canvas", async () => {
    let nodes: CanvasNode[] = [
      { id: "a", position: { x: 0, y: 0 }, data: { label: "A" } },
      { id: "b", position: { x: 100, y: 0 }, data: { label: "B" }, selected: true },
    ];
    let edges: CanvasEdge[] = [{ id: "e", source: "a", target: "b" }];
    const history = new HistoryManager();
    const scenes = new CanvasScenesStore();
    const doc = createCanvasEditorDocument({
      getNodes: () => nodes,
      setNodes: (n) => void (nodes = n),
      getEdges: () => edges,
      setEdges: (e) => void (edges = e),
      history,
      scenes,
    });
    expect(doc.getDocument().nodes[1]).not.toHaveProperty("selected");
    await contract({
      doc,
      current: () => doc.getDocument(),
      undo: () => history.undo(),
      next: { nodes: [{ id: "c", position: { x: 5, y: 5 }, data: {} }], edges: [], scenes: [] },
      invalid: { nodes: [{ id: "c", position: { x: 0, y: 0 }, data: {} }], edges: [{ id: "x", source: "c", target: "gone" }] },
      invalidMessage: 'Edge "x" connects to "gone", which is not a node in the document.',
      viewChange: () => void (nodes = nodes.map((n) => ({ ...n, selected: !n.selected }))),
    });
  });

  it("canvas gestures become one undo step", () => {
    let nodes: CanvasNode[] = [{ id: "a", position: { x: 0, y: 0 }, data: {} }];
    const history = new HistoryManager();
    const recorder = createCanvasGestureRecorder({ getNodes: () => nodes, setNodes: (n) => void (nodes = n), history });
    recorder.begin();
    nodes = [{ ...nodes[0], position: { x: 10, y: 0 }, selected: true }];
    nodes = [{ ...nodes[0], position: { x: 40, y: 20 }, dragging: true } as CanvasNode];
    expect(recorder.end("Move")).toBe(true);
    expect(history.getState().undoName).toBe("Move");
    history.undo();
    expect(nodes[0].position).toEqual({ x: 0, y: 0 });
    history.redo();
    expect(nodes[0].position).toEqual({ x: 40, y: 20 });
    // Selecting without moving records nothing.
    recorder.begin();
    nodes = [{ ...nodes[0], selected: false }];
    expect(recorder.end()).toBe(false);
  });

  it("read-only animation and video refuse agent loads", async () => {
    const animation = new AnimationEditorController({ scene: createMotionScene({ width: 10, height: 10, nodes: [] }), readOnly: true });
    const video = new VideoEditorController({ project: createVideoProject(), readOnly: true });
    for (const doc of [createAnimationEditorDocument(animation), createVideoEditorDocument(video)]) {
      const result: any = await tools(doc).callTool(`load_${doc.kind}_document`, { document: doc.getDocument() });
      expect(text(result)).toMatch(/read-only\. Read tools still work/);
    }
  });
});
