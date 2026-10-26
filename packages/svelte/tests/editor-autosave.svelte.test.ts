import { describe, it, expect, afterEach } from "vitest";
import { DiagramController, createDiagramEditorDocument } from "@pixerate/editor/diagram";
import { createMemoryStorage, toEditorDocumentFile } from "@pixerate/editor/persistence";
import { createEditorAutosave } from "../src/persistence";
import { createCanvasDocument, createMermaidDiagram } from "../src/canvas";
import { HistoryManager } from "@pixerate/editor/history";
import { flushSync } from "svelte";
import { createChartEditor } from "../src/chart";
import { createAnimationEditor } from "../src/animation-editor";
import { createVideoEditor } from "../src/video-editor";
import { createParameters } from "../src/parameters";
import { createVectorEditor } from "../src/vector";
import { createReactiveImageEditor } from "../src/image-editor";
import { createReactivePaintEditor } from "../src/paint-editor";
import { createReactiveSpreadsheet } from "../src/spreadsheet";
import { createTokens } from "../src/tokens";
import { TokenStore } from "@pixerate/editor/tokens";

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const source = "flowchart TD\n  A --> B\n";

describe("createEditorAutosave", () => {
  it("snapshots an editor document and restores it into a new editor", async () => {
    const storage = createMemoryStorage();
    const first = new DiagramController({ source });
    const doc = createDiagramEditorDocument(first);
    const autosave = createEditorAutosave(doc, { storage, debounceMs: 5, interval: 20 });
    cleanup.push(() => autosave.destroy());
    await autosave.checked;
    first.load("flowchart LR\n  X --> Y\n");
    await wait(40);
    expect(JSON.parse(storage.entries.get("diagram")!)).toEqual(toEditorDocumentFile(doc));
    expect(autosave.status.status).toBe("saved");
    autosave.destroy();

    const second = new DiagramController({ source });
    const again = createEditorAutosave(createDiagramEditorDocument(second), { storage });
    cleanup.push(() => again.destroy());
    await again.checked;
    expect(again.pendingRecovery).toBe(true);
    expect(again.recovery?.snapshot?.kind).toBe("diagram");
    const report = again.restore();
    expect(report?.readOnly).toBeNull();
    expect(second.getSource()).toBe("flowchart LR\n  X --> Y\n");
    expect(again.pendingRecovery).toBe(false);
  });
});

describe("createMermaidDiagram().editorDocument", () => {
  it("is the diagram's document contract", () => {
    const diagram = createMermaidDiagram({ source });
    cleanup.push(() => diagram.destroy());
    expect(diagram.editorDocument.kind).toBe("diagram");
    diagram.editorDocument.loadDocument({ source: "flowchart LR\n  Q\n" }, { history: "record" });
    expect(diagram.source).toBe("flowchart LR\n  Q\n");
    diagram.undo();
    expect(diagram.source).toBe(source);
  });
});

describe("editor runes expose editorDocument", () => {
  it("chart, animation, video, parameters and vector", () => {
    const editors = {
      chart: createChartEditor(),
      animation: createAnimationEditor(),
      video: createVideoEditor(),
      parameters: createParameters({ schema: { fields: [{ id: "speed", type: "number", min: 0, max: 4, default: 1 }] } }),
      vector: createVectorEditor(),
    };
    for (const [kind, editor] of Object.entries(editors)) {
      cleanup.push(() => editor.destroy());
      expect(editor.editorDocument.kind).toBe(kind);
    }
    const doc = editors.parameters.editorDocument;
    const before = doc.getDocument();
    doc.loadDocument({ values: { speed: 3 } }, { history: "record" });
    expect(editors.parameters.values.speed).toBe(3);
    editors.parameters.undo();
    expect(doc.getDocument()).toEqual(before);
  });
});

describe("phase 3 runes expose editorDocument", () => {
  it("spreadsheet and tokens", () => {
    const sheet = createReactiveSpreadsheet();
    const tokens = createTokens(new TokenStore());
    cleanup.push(() => tokens.destroy());
    expect(sheet.editorDocument.kind).toBe("spreadsheet");
    expect(tokens.editorDocument.kind).toBe("tokens");
    const workbook = sheet.editorDocument.getDocument();
    sheet.editorDocument.loadDocument(workbook, { history: "record" });
    expect(sheet.editorDocument.history.getState().canUndo).toBe(true);
    expect(sheet.editorDocument.history.undo()).toBe(true);
  });
});

describe("createCanvasDocument", () => {
  it("counts finished moves, not selection or drag frames", () => {
    let nodes = $state<any[]>([{ id: "a", position: { x: 0, y: 0 }, data: {} }]);
    const history = new HistoryManager();
    const doc = createCanvasDocument({
      getNodes: () => nodes,
      setNodes: (next) => void (nodes = next),
      getEdges: () => [],
      setEdges: () => {},
      history,
    });
    cleanup.push(() => doc.destroy());
    flushSync();
    let changes = 0;
    doc.subscribe(() => changes++);
    nodes = [{ ...nodes[0], selected: true }];
    flushSync();
    nodes = [{ id: "a", position: { x: 5, y: 0 }, data: {}, dragging: true }];
    flushSync();
    expect(changes).toBe(0);
    nodes = [{ id: "a", position: { x: 9, y: 0 }, data: {} }];
    flushSync();
    expect(changes).toBe(1);
    doc.loadDocument({ nodes: [{ id: "b", position: { x: 1, y: 1 }, data: {} }], edges: [] }, { history: "record" });
    expect(nodes.map((n) => n.id)).toEqual(["b"]);
    history.undo();
    expect(nodes.map((n) => n.id)).toEqual(["a"]);
  });
});

describe("image and paint runes", () => {
  it("expose editorDocument, and autosave writes their assets with the snapshot", async () => {
    const storage = createMemoryStorage();
    const image = createReactiveImageEditor();
    const painter = createReactivePaintEditor({ width: 120, height: 60, paper: "smooth" });
    cleanup.push(() => image.destroy(), () => painter.destroy());
    expect(image.editorDocument.kind).toBe("image");
    const autosave = createEditorAutosave(painter.editorDocument, { storage, debounceMs: 5, interval: 20 });
    cleanup.push(() => autosave.destroy());
    await autosave.checked;
    const points = Array.from({ length: 20 }, (_, i) => ({ x: 5 + i * 5, y: 30 + (i % 3) * 4, pressure: 0.7 }));
    painter.controller.paintStroke({ points, brushId: "ink-pen", color: "#000000" });
    await wait(60);
    expect(storage.entries.get("paint")).toContain("pixerate-asset:");
    expect([...storage.entries.keys()].some((k) => k.startsWith("pixerate.assets:"))).toBe(true);
  });
});
