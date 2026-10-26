import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { DiagramController, createDiagramEditorDocument } from "@pixerate/editor/diagram";
import { createMemoryStorage, toEditorDocumentFile, type EditorDocument, type MemoryStorage } from "@pixerate/editor/persistence";
import { useEditorAutosave, type UseEditorAutosaveResult } from "../src/persistence";
import { useMermaidDiagram, type UseMermaidDiagramResult } from "../src/canvas";
import { useChartEditor } from "../src/chart";
import { useAnimationEditor } from "../src/animation-editor";
import { useVideoEditor } from "../src/video-editor";
import { useParameters } from "../src/parameters";
import { useVectorEditor } from "../src/vector";

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

function Harness(props: { storage: MemoryStorage; doc: EditorDocument; onResult: (r: UseEditorAutosaveResult) => void }) {
  const autosave = useEditorAutosave(props.doc, { storage: props.storage, debounceMs: 5, interval: 20 });
  props.onResult(autosave);
  return <span data-status>{autosave.status.status}</span>;
}

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
