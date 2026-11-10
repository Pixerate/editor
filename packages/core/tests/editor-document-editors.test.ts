import { beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { createDocumentToolProvider, createEditorAssetRegistry, toEditorDocumentFile, type EditorDocument } from "../src/persistence";
import { ToolRegistry } from "../src/tools";
import { ChartController, createChartEditorDocument } from "../src/chart";
import { AnimationEditorController, createAnimationEditorDocument, createMotionScene } from "../src/animation-editor";
import { VideoEditorController, createVideoEditorDocument, createVideoProject } from "../src/video-editor";
import { ParametersController, createParametersEditorDocument } from "../src/parameters";
import { VectorEditorController, createVectorEditorDocument } from "../src/vector";
import { SpreadsheetController, createSpreadsheetEditorDocument } from "../src/spreadsheet";
import { TokenStore, createTokensEditorDocument } from "../src/tokens";
import { createRichTextEditorDocument, createRichTextPreset } from "../src";
import {
  CanvasScenesStore,
  applyGraphDifferences,
  calculateGraphDifferences,
  canvasDocumentContentKey,
  createCanvasEditorDocument,
  createCanvasGestureRecorder,
  sanitizeCanvasDocument,
  type CanvasEdge,
  type CanvasNode,
  type CanvasViewport,
} from "../src/canvas";
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

  it("undoes and redoes only what the gesture changed, keeping work added since", () => {
    const history = new HistoryManager();
    const at = (id: string, x: number): CanvasNode => ({ id, position: { x, y: 0 }, data: {} });
    let nodes: CanvasNode[] = [at("a", 0), at("b", 100)];
    let edges: CanvasEdge[] = [{ id: "a-b", source: "a", target: "b" }];
    const recorder = createCanvasGestureRecorder({
      getNodes: () => nodes,
      setNodes: (n) => void (nodes = n),
      getEdges: () => edges,
      setEdges: (e) => void (edges = e),
      history,
    });

    recorder.begin();
    nodes = [at("a", 50), at("b", 100)];
    expect(recorder.end("Move")).toBe(true);

    // A collaborator adds a node, moves b and connects them after the drag.
    nodes = [at("a", 50), at("b", 300), at("c", 200)];
    edges = [...edges, { id: "b-c", source: "b", target: "c" }];
    history.undo();
    expect(nodes.map((n) => [n.id, n.position.x])).toEqual([["a", 0], ["b", 300], ["c", 200]]);
    expect(edges.map((e) => e.id)).toEqual(["a-b", "b-c"]);
    history.redo();
    expect(nodes.map((n) => [n.id, n.position.x])).toEqual([["a", 50], ["b", 300], ["c", 200]]);

    // A gesture that removes a node and its edge puts both back at their places on undo.
    recorder.begin();
    nodes = nodes.filter((n) => n.id !== "a");
    edges = edges.filter((e) => e.id !== "a-b");
    expect(recorder.end("Delete")).toBe(true);
    history.undo();
    expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(edges.map((e) => e.id)).toEqual(["a-b", "b-c"]);

    // Undoing a move does not bring back a node deleted since.
    recorder.begin();
    nodes = nodes.map((n) => (n.id === "c" ? at("c", 250) : n));
    recorder.end("Move");
    nodes = nodes.filter((n) => n.id !== "c");
    history.undo();
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  describe("canvas document options", () => {
    const canvas = (options: Partial<Parameters<typeof createCanvasEditorDocument>[0]> = {}) => {
      const state = {
        nodes: [{ id: "a", position: { x: 0, y: 0 }, data: { label: "A" } }] as CanvasNode[],
        edges: [] as CanvasEdge[],
        viewport: { x: 10, y: 20, zoom: 1.5 } as CanvasViewport,
      };
      const history = new HistoryManager();
      const doc = createCanvasEditorDocument({
        getNodes: () => state.nodes,
        setNodes: (n) => void (state.nodes = n),
        getEdges: () => state.edges,
        setEdges: (e) => void (state.edges = e),
        history,
        ...options,
      });
      return { state, history, doc };
    };

    it("saves and restores the viewport without counting pans as changes", async () => {
      let viewport: CanvasViewport = { x: 10, y: 20, zoom: 1.5 };
      const { doc, history } = canvas({ getViewport: () => viewport, setViewport: (v) => void (viewport = v) });
      expect(doc.getDocument().viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
      const revision = doc.revision();
      viewport = { x: -5, y: 0, zoom: 2 };
      expect(doc.revision()).toBe(revision);

      const result: any = await tools(doc).callTool("load_canvas_document", {
        document: { nodes: [{ id: "b", position: { x: 0, y: 0 }, data: {} }], edges: [], viewport: { x: 1, y: 2, zoom: 0.5 } },
      });
      expect(result.isError, text(result)).toBeFalsy();
      expect(viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });
      history.undo();
      expect(viewport).toEqual({ x: -5, y: 0, zoom: 2 });

      // A document without a viewport leaves the view where it is.
      doc.loadDocument({ nodes: [], edges: [] });
      expect(viewport).toEqual({ x: -5, y: 0, zoom: 2 });
      // Without getViewport, nothing is saved.
      expect(canvas().doc.getDocument()).not.toHaveProperty("viewport");
    });

    it("refuses a bad viewport and changes nothing", async () => {
      const { doc, state } = canvas({ getViewport: () => state.viewport, setViewport: (v) => void (state.viewport = v) });
      const result: any = await tools(doc).callTool("load_canvas_document", {
        document: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0 } },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch("viewport must be { x, y, zoom } with finite numbers and a zoom above 0.");
      expect(state.nodes.map((n) => n.id)).toEqual(["a"]);
      expect(state.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
    });

    it("leaves out the host's own runtime keys", () => {
      const { doc, state } = canvas({ omitNodeKeys: ["draggable"], omitEdgeKeys: ["style", "markerEnd"] });
      state.nodes = [{ ...state.nodes[0], draggable: false, selected: true } as CanvasNode];
      state.nodes.push({ id: "b", position: { x: 1, y: 1 }, data: {} });
      state.edges = [{ id: "e", source: "a", target: "b", style: "stroke: red", markerEnd: "arrow" } as CanvasEdge];
      const saved = doc.getDocument();
      expect(saved.nodes[0]).not.toHaveProperty("draggable");
      expect(saved.nodes[0]).not.toHaveProperty("selected");
      expect(saved.edges[0]).toEqual({ id: "e", source: "a", target: "b" });
      // The bindings' change key ignores the same fields.
      const options = { omitNodeKeys: ["draggable"], omitEdgeKeys: ["style"] };
      const before = canvasDocumentContentKey(state.nodes, state.edges, options);
      const after = canvasDocumentContentKey(
        state.nodes.map((n) => ({ ...n, draggable: true })),
        state.edges.map((e) => ({ ...e, style: "" } as CanvasEdge)),
        options,
      );
      expect(after).toBe(before);
      expect(canvasDocumentContentKey([{ ...state.nodes[0], position: { x: 9, y: 9 } }], [], options)).not.toBe(
        canvasDocumentContentKey([state.nodes[0]], [], options),
      );
    });

    it("runs the host's node check after the built-in ones", async () => {
      const { doc, state } = canvas({
        validateNode: (node) => (node.type && !["box", "image"].includes(node.type) ? `type "${node.type}" is not a node type here; use box or image.` : undefined),
      });
      const result: any = await tools(doc).callTool("load_canvas_document", {
        document: { nodes: [{ id: "x", type: "video", position: { x: 0, y: 0 }, data: {} }], edges: [] },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch('Node "x" (nodes[0]): type "video" is not a node type here; use box or image.');
      expect(state.nodes.map((n) => n.id)).toEqual(["a"]);
      doc.loadDocument({ nodes: [{ id: "y", type: "image", position: { x: 0, y: 0 }, data: {} }], edges: [] });
      expect(state.nodes.map((n) => n.id)).toEqual(["y"]);
    });

    it("normalizes raw documents and migrates files", () => {
      const { doc, state } = canvas({
        formatVersion: 2,
        // Version 1 kept edges under "links".
        migrations: { 1: (d: any) => ({ nodes: d.nodes, edges: d.links }) },
        // Raw documents from an older host shape: { graph: { nodes, edges } }.
        normalize: (d: any) => (d && d.graph ? d.graph : d),
      });
      expect(doc.formatVersion).toBe(2);
      const nodes = [
        { id: "p", position: { x: 0, y: 0 }, data: {} },
        { id: "q", position: { x: 9, y: 0 }, data: {} },
      ];
      doc.loadDocument({ graph: { nodes, edges: [{ id: "e", source: "p", target: "q" }] } });
      expect(state.edges.map((e) => e.id)).toEqual(["e"]);
      const report = doc.loadDocument({
        format: "pixerate.editor-document",
        kind: "canvas",
        formatVersion: 1,
        document: { nodes, links: [{ id: "old", source: "q", target: "p" }] },
      });
      expect(report.migratedFrom).toBe(1);
      expect(state.edges.map((e) => e.id)).toEqual(["old"]);
      // A file from this version round-trips.
      doc.loadDocument(toEditorDocumentFile(doc));
      expect(state.edges.map((e) => e.id)).toEqual(["old"]);
    });

    it("keeps inline images in node data out of the document as assets", async () => {
      const assets = createEditorAssetRegistry();
      const image = `data:image/png;base64,${"A".repeat(2048)}`;
      const { doc, state } = canvas({ assets });
      state.nodes = [{ id: "img", position: { x: 0, y: 0 }, data: { imageUrl: image } }];
      const saved = doc.getDocument() as any;
      expect(saved.nodes[0].data.imageUrl).toMatch(/^pixerate-asset:/);
      expect(doc.assets).toBe(assets);
      state.nodes = [];
      doc.loadDocument(saved);
      expect((state.nodes[0].data as any).imageUrl).toBe(image);
      // A reference whose bytes are not loaded is refused, and nothing changes.
      const result: any = await tools(doc).callTool("load_canvas_document", {
        document: { nodes: [{ id: "z", position: { x: 0, y: 0 }, data: { imageUrl: "pixerate-asset:zz-zz" } }], edges: [] },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch("not loaded");
      expect(state.nodes.map((n) => n.id)).toEqual(["img"]);
    });

    it("sanitizes legacy canvas documents and round-trips companion extras", () => {
      let paintLayer: { strokes: string[] } | undefined = { strokes: ["s1"] };
      const paintListeners = new Set<() => void>();
      const { doc, state } = canvas({
        normalize: (raw) => sanitizeCanvasDocument(raw),
        extras: {
          get: () => ({ paint: paintLayer }),
          load: (raw) => {
            paintLayer = raw.paint as { strokes: string[] } | undefined;
          },
          subscribe: (l) => {
            paintListeners.add(l);
            return () => paintListeners.delete(l);
          },
        },
      });

      expect((doc.getDocument() as any).paint).toEqual({ strokes: ["s1"] });
      const revBefore = doc.revision();
      paintListeners.forEach((l) => l());
      expect(doc.revision()).toBe(revBefore + 1);

      // Legacy graph with child before parent, dangling parentId, duplicate node, and dangling edge:
      doc.loadDocument({
        nodes: [
          { id: "child", parentId: "frame", position: { x: 10, y: 10 }, data: { label: "v1" } },
          { id: "child", parentId: "frame", position: { x: 20, y: 20 }, data: { label: "v2" } },
          { id: "orphan", parentId: "missing-frame", position: { x: 5, y: 5 }, data: {} },
          { id: "frame", position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [
          { id: "ok", source: "frame", target: "child" },
          { id: "dangling", source: "frame", target: "gone" },
        ],
        viewport: { x: 0, y: 0, zoom: -1 },
        paint: { strokes: ["s2"] },
      } as any);

      expect(state.nodes.map((n) => n.id)).toEqual(["frame", "child", "orphan"]);
      expect(state.nodes.find((n) => n.id === "child")?.position).toEqual({ x: 20, y: 20 });
      expect(state.nodes.find((n) => n.id === "orphan")?.parentId).toBeUndefined();
      expect(state.edges.map((e) => e.id)).toEqual(["ok"]);
      expect(paintLayer).toEqual({ strokes: ["s2"] });

      // Diff and patch application preserve local selection:
      const current = [
        { id: "frame", position: { x: 100, y: 0 }, data: {} },
        { id: "added", position: { x: 1, y: 2 }, data: {} },
      ];
      const diff = calculateGraphDifferences({ nodes: current, edges: [] }, { nodes: state.nodes, edges: state.edges });
      const patched = applyGraphDifferences(
        {
          nodes: state.nodes.map((n) => (n.id === "frame" ? { ...n, selected: true } : n)),
          edges: state.edges,
        },
        diff,
      );
      expect(patched.nodes.find((n) => n.id === "frame")).toMatchObject({ position: { x: 100, y: 0 }, selected: true });
      expect(patched.nodes.map((n) => n.id)).toEqual(["frame", "added"]);
      expect(patched.edges).toEqual([]);
    });

    it("sanitizeCanvasDocument breaks a parent cycle at one node and keeps the other links", () => {
      const doc = sanitizeCanvasDocument({
        nodes: [
          { id: "a", parentId: "b", position: { x: 0, y: 0 }, data: {} },
          { id: "b", parentId: "a", position: { x: 0, y: 0 }, data: {} },
          { id: "c", parentId: "a", position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [],
      });
      const parentOf = Object.fromEntries(doc.nodes.map((n) => [n.id, n.parentId]));
      expect(parentOf).toEqual({ a: undefined, b: "a", c: "a" });
      expect(doc.nodes[0].id).toBe("a");
    });
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
