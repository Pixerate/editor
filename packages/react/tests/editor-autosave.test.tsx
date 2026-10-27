import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { DiagramController, createDiagramEditorDocument } from "@pixerate/editor/diagram";
import { createEditorAssetRegistry, createMemoryStorage, defineEditorDocument, toEditorDocumentFile, type EditorDocument, type MemoryStorage } from "@pixerate/editor/persistence";
import { useEditorAutosave, type UseEditorAutosaveResult } from "../src/persistence";
import { useCanvasEditorDocument, useMermaidDiagram, type UseMermaidDiagramResult } from "../src/canvas";
import { HistoryManager } from "@pixerate/editor/history";
import type { CanvasNode } from "@pixerate/editor/canvas";
import { useChartEditor } from "../src/chart";
import { useAnimationEditor } from "../src/animation-editor";
import { useVideoEditor } from "../src/video-editor";
import { useParameters } from "../src/parameters";
import { useVectorEditor } from "../src/vector";
import { useSpreadsheetEditor } from "../src/spreadsheet";
import { useTokens, useTokenStore } from "../src/tokens";
import { useEditor, useRichTextEditorDocument } from "../src";
import { useImageEditor } from "../src/image-editor";
import { usePaintEditor } from "../src/paint-editor";

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "https://example.com/editor" });
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const source = "flowchart TD\n  A --> B\n";

function Harness(props: { storage: MemoryStorage; doc: EditorDocument; onResult: (r: UseEditorAutosaveResult) => void; collectAssetGarbage?: boolean }) {
  const autosave = useEditorAutosave(props.doc, { storage: props.storage, debounceMs: 5, interval: 20, collectAssetGarbage: props.collectAssetGarbage });
  props.onResult(autosave);
  return <span data-status>{autosave.status.status}</span>;
}

describe("useEditorAutosave asset garbage collection", () => {
  const big = (seed: number) => `data:image/png;base64,${Array.from({ length: 800 }, (_, i) => "ABCDEFGHIJKLMNOP"[(i * seed) % 16]).join("")}`;
  const assetKey = (data: string) => `pixerate.assets:${createEditorAssetRegistry().put(data).slice("pixerate-asset:".length)}`;
  const assetKeys = (storage: MemoryStorage) => [...storage.entries.keys()].filter((k) => /^pixerate\.assets:[0-9a-z]+-/.test(k));

  function pictureDoc() {
    const history = new HistoryManager();
    return defineEditorDocument<{ png: string }>({
      kind: "picture",
      assets: createEditorAssetRegistry(),
      get: () => ({ png: big(3) }),
      load: () => {},
      subscribe: () => () => {},
      history: { undo: () => history.undo(), redo: () => history.redo(), getState: () => history.getState() },
    });
  }

  /** An earlier session's dirty snapshot whose only asset nothing else refers to. */
  async function seed() {
    const storage = createMemoryStorage();
    const ref = createEditorAssetRegistry().put(big(5));
    await storage.set(assetKey(big(5)), big(5));
    await storage.set("picture", JSON.stringify({ format: "pixerate-editor-document", kind: "picture", formatVersion: 1, document: { png: ref } }));
    await storage.set("picture:meta", JSON.stringify({ dirty: true, time: 1 }));
    return storage;
  }

  it("collects assets left behind when a snapshot is discarded or retired, unless turned off", async () => {
    const kept = await seed();
    let result!: UseEditorAutosaveResult;
    await act(async () => root.render(<Harness storage={kept} doc={pictureDoc()} collectAssetGarbage={false} onResult={(r) => (result = r)} />));
    await act(async () => void (await wait(5)));
    expect(result.pendingRecovery).toBe(true);
    await act(async () => result.discard());
    expect(kept.entries.has("picture")).toBe(false);
    expect(assetKeys(kept)).toHaveLength(1);
    await act(async () => root.unmount());

    root = createRoot(container);
    const storage = await seed();
    await act(async () => root.render(<Harness storage={storage} doc={pictureDoc()} onResult={(r) => (result = r)} />));
    await act(async () => void (await wait(5)));
    await act(async () => result.discard());
    expect(assetKeys(storage)).toHaveLength(0);
    // markClean collects too.
    await storage.set(assetKey(big(7)), big(7));
    await act(async () => result.markClean());
    expect(assetKeys(storage)).toHaveLength(0);
  });
});

describe("useEditorAutosave", () => {
  it("snapshots an editor document and restores it into a new editor", async () => {
    const storage = createMemoryStorage();
    const first = new DiagramController({ source });
    const doc = createDiagramEditorDocument(first);
    let result!: UseEditorAutosaveResult;
    await act(async () => root.render(<Harness storage={storage} doc={doc} onResult={(r) => (result = r)} />));
    await act(async () => void (await wait(5)));
    expect(result.pendingRecovery).toBe(false);

    await act(async () => void first.load("flowchart LR\n  X --> Y\n"));
    await act(async () => void (await wait(40)));
    expect(JSON.parse(storage.entries.get("diagram")!)).toEqual(toEditorDocumentFile(doc));
    await act(async () => root.unmount());

    // A new session finds the snapshot; restore loads it straight into the editor.
    root = createRoot(container);
    const second = new DiagramController({ source });
    const doc2 = createDiagramEditorDocument(second);
    await act(async () => root.render(<Harness storage={storage} doc={doc2} onResult={(r) => (result = r)} />));
    await act(async () => void (await wait(5)));
    expect(result.recovery?.snapshot?.kind).toBe("diagram");
    let report: ReturnType<UseEditorAutosaveResult["restore"]>;
    await act(async () => void (report = result.restore()));
    expect(report!.readOnly).toBeNull();
    expect(second.getSource()).toBe("flowchart LR\n  X --> Y\n");
    expect(second.getState().canUndo).toBe(false);
  });
});

describe("useMermaidDiagram().editorDocument", () => {
  it("keeps counting changes after a StrictMode remount", async () => {
    const controller = new DiagramController({ source });
    let diagram!: UseMermaidDiagramResult;
    const Probe = () => {
      diagram = useMermaidDiagram(controller);
      return null;
    };
    await act(async () => root.render(<React.StrictMode><Probe /></React.StrictMode>));
    const doc = diagram.editorDocument;
    const seen: number[] = [];
    const off = doc.subscribe(() => seen.push(doc.revision()));
    await act(async () => void controller.load("flowchart LR\n  Q\n"));
    expect(seen.length).toBe(1);
    expect(doc.getDocument()).toEqual({ source: controller.getSource() });
    off();
  });
});

describe("editor hooks expose editorDocument", () => {
  it("chart, animation, video, parameters and vector", async () => {
    const docs: Record<string, EditorDocument> = {};
    const Probe = () => {
      docs.chart = useChartEditor().editorDocument;
      docs.animation = useAnimationEditor().editorDocument;
      docs.video = useVideoEditor().editorDocument;
      docs.parameters = useParameters({ schema: { fields: [{ id: "speed", type: "number", min: 0, max: 4, default: 1 }] } }).editorDocument;
      docs.vector = useVectorEditor().editorDocument;
      return null;
    };
    await act(async () => root.render(<React.StrictMode><Probe /></React.StrictMode>));
    for (const [kind, doc] of Object.entries(docs)) {
      expect(doc.kind).toBe(kind);
      const seen: number[] = [];
      const off = doc.subscribe(() => seen.push(doc.revision()));
      const start = doc.getDocument();
      await act(async () => void doc.loadDocument(start, { history: "record" }));
      expect(doc.getDocument()).toEqual(start);
      off();
    }
    // A recorded load of a changed document is one undo step.
    const before = docs.parameters.getDocument();
    await act(async () => void docs.parameters.loadDocument({ values: { speed: 3 } }, { history: "record" }));
    expect((docs.parameters.getDocument() as any).values.speed).toBe(3);
    await act(async () => void docs.parameters.history.undo());
    expect(docs.parameters.getDocument()).toEqual(before);
  });
});

describe("phase 3 hooks expose editorDocument", () => {
  it("spreadsheet, tokens and rich text", async () => {
    const docs: Record<string, EditorDocument | null> = {};
    const Probe = () => {
      docs.spreadsheet = useSpreadsheetEditor().editorDocument;
      docs.tokens = useTokens(useTokenStore()).editorDocument;
      docs.rich_text = useRichTextEditorDocument(useEditor({ content: "<p>Hi</p>", immediatelyRender: false }));
      return null;
    };
    await act(async () => root.render(<React.StrictMode><Probe /></React.StrictMode>));
    for (const [kind, doc] of Object.entries(docs)) {
      expect(doc?.kind).toBe(kind);
    }
    const doc = docs.rich_text!;
    const seen: number[] = [];
    const off = doc.subscribe(() => seen.push(doc.revision()));
    await act(async () => void doc.loadDocument({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Bye" }] }] }, { history: "record" }));
    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.stringify(doc.getDocument())).toContain("Bye");
    off();
  });
});

describe("useCanvasEditorDocument", () => {
  it("counts finished moves, not selection or drag frames", async () => {
    const history = new HistoryManager();
    let setNodes!: (nodes: CanvasNode[]) => void;
    let doc!: EditorDocument;
    const Probe = () => {
      const [nodes, set] = React.useState<CanvasNode[]>([{ id: "a", position: { x: 0, y: 0 }, data: {} }]);
      setNodes = set;
      doc = useCanvasEditorDocument({ nodes, edges: [], setNodes: set, setEdges: () => {}, history });
      return null;
    };
    await act(async () => root.render(<React.StrictMode><Probe /></React.StrictMode>));
    let changes = 0;
    const off = doc.subscribe(() => changes++);
    await act(async () => setNodes([{ id: "a", position: { x: 0, y: 0 }, data: {}, selected: true }]));
    await act(async () => setNodes([{ id: "a", position: { x: 5, y: 0 }, data: {}, dragging: true } as CanvasNode]));
    expect(changes).toBe(0);
    await act(async () => setNodes([{ id: "a", position: { x: 9, y: 0 }, data: {} }]));
    expect(changes).toBe(1);
    expect((doc.getDocument() as any).nodes[0].position).toEqual({ x: 9, y: 0 });
    // A recorded load goes through the shared history and lands in React state.
    await act(async () => void doc.loadDocument({ nodes: [{ id: "b", position: { x: 1, y: 1 }, data: {} }], edges: [] }, { history: "record" }));
    expect((doc.getDocument() as any).nodes.map((n: any) => n.id)).toEqual(["b"]);
    await act(async () => void history.undo());
    expect((doc.getDocument() as any).nodes.map((n: any) => n.id)).toEqual(["a"]);
    off();
  });
});

describe("image and paint hooks", () => {
  it("expose editorDocument, and autosave writes their assets with the snapshot", async () => {
    const storage = createMemoryStorage();
    let image!: EditorDocument;
    let painter!: ReturnType<typeof usePaintEditor>;
    const Probe = () => {
      painter = usePaintEditor({ width: 120, height: 60, paper: "smooth" });
      image = useImageEditor().editorDocument;
      useEditorAutosave(painter.editorDocument, { storage, debounceMs: 5, interval: 20 });
      return null;
    };
    await act(async () => root.render(<React.StrictMode><Probe /></React.StrictMode>));
    await act(async () => void (await wait(5)));
    expect(image.kind).toBe("image");
    expect(painter.editorDocument.kind).toBe("paint");
    const points = Array.from({ length: 20 }, (_, i) => ({ x: 5 + i * 5, y: 30 + (i % 3) * 4, pressure: 0.7 }));
    await act(async () => void painter.controller.paintStroke({ points, brushId: "ink-pen", color: "#000000" }));
    await act(async () => void (await wait(60)));
    const snapshot = storage.entries.get("paint");
    expect(snapshot).toBeDefined();
    expect(snapshot).toContain("pixerate-asset:");
    expect([...storage.entries.keys()].some((k) => k.startsWith("pixerate.assets:"))).toBe(true);
  });
});
