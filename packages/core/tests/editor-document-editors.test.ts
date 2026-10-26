import { describe, expect, it } from "vitest";
import { createDocumentToolProvider, type EditorDocument } from "../src/persistence";
import { ToolRegistry } from "../src/tools";
import { ChartController, createChartEditorDocument } from "../src/chart";
import { AnimationEditorController, createAnimationEditorDocument, createMotionScene } from "../src/animation-editor";
import { VideoEditorController, createVideoEditorDocument, createVideoProject } from "../src/video-editor";
import { ParametersController, createParametersEditorDocument } from "../src/parameters";
import { VectorEditorController, createVectorEditorDocument } from "../src/vector";

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

  it("read-only animation and video refuse agent loads", async () => {
    const animation = new AnimationEditorController({ scene: createMotionScene({ width: 10, height: 10, nodes: [] }), readOnly: true });
    const video = new VideoEditorController({ project: createVideoProject(), readOnly: true });
    for (const doc of [createAnimationEditorDocument(animation), createVideoEditorDocument(video)]) {
      const result: any = await tools(doc).callTool(`load_${doc.kind}_document`, { document: doc.getDocument() });
      expect(text(result)).toMatch(/read-only\. Read tools still work/);
    }
  });
});
