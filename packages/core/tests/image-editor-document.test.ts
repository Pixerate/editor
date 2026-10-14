import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPTH_MASK,
  DEFAULT_TRANSFORM,
  IMAGE_EDITOR_STATE_VERSION,
  loadImageEditorDocument,
  normalizeStoredAdjustments,
  type SerializedImageEditorState,
} from "../src/image-editor";
import { hasLoadProblems } from "../src/persistence";

const valid: SerializedImageEditorState = {
  version: 1,
  crop: { x: 10, y: 20, width: 100, height: 50 },
  transform: { rotate: 90, flipH: true, flipV: false },
  // Saved before process versions existed: no `process`, no `tint`.
  adjustments: { brightness: 10, contrast: 0, saturation: -5, exposure: 0, temperature: 3, blur: 0, opacity: 1 },
  depthMask: { enabled: true, maskSource: "data:x", mode: "brightness", depthRange: [10, 200], softness: 4, invert: true },
  annotations: [
    { id: "a", type: "rect", x: 1, y: 2, width: 3, height: 4, strokeColor: "#000", strokeWidth: 2 },
    { id: "b", type: "text", x: 5, y: 6, text: "hi", fontSize: 12, color: "red" },
  ],
};

describe("loadImageEditorDocument", () => {
  it("returns valid state unchanged, without problems", () => {
    for (const input of [valid, JSON.stringify(valid)]) {
      const { state, report, unknown } = loadImageEditorDocument(input);
      expect(state).toEqual(valid);
      expect(hasLoadProblems(report)).toBe(false);
      expect(report.migratedFrom).toBeNull();
      expect(unknown).toEqual({});
    }
    expect(IMAGE_EDITOR_STATE_VERSION).toBe(1);
  });

  it("keeps a missing process legacy (adjustments are passed through as stored)", () => {
    const { state } = loadImageEditorDocument(valid);
    expect(state.adjustments.process).toBeUndefined();
    expect(normalizeStoredAdjustments(state.adjustments).process).toBe(1);
  });

  it("treats a missing version as current and fills missing sections with defaults", () => {
    const { state, report } = loadImageEditorDocument({ crop: null });
    expect(report.readOnly).toBeNull();
    expect(state).toEqual({
      version: 1,
      crop: null,
      transform: DEFAULT_TRANSFORM,
      adjustments: normalizeStoredAdjustments(undefined),
      depthMask: DEFAULT_DEPTH_MASK,
      annotations: [],
    });
  });

  it("falls back per section and keeps the good ones", () => {
    const { state, report } = loadImageEditorDocument({
      ...valid,
      transform: { rotate: "ninety" },
      depthMask: "broken",
    });
    expect(report.problems.map((p) => p.section).sort()).toEqual(["depthMask", "transform"]);
    expect(state.transform).toEqual(DEFAULT_TRANSFORM);
    expect(state.depthMask).toEqual(DEFAULT_DEPTH_MASK);
    expect(state.crop).toEqual(valid.crop);
    expect(state.annotations).toEqual(valid.annotations);
  });

  it("drops invalid annotations one by one", () => {
    const { state, report } = loadImageEditorDocument({
      ...valid,
      annotations: [valid.annotations[0], { id: 3, type: "rect" }, { id: "z", type: "hexagon", x: 0, y: 0 }],
    });
    expect(state.annotations).toEqual([valid.annotations[0]]);
    expect(report.problems).toEqual([{ section: "annotations", message: "2 invalid annotations dropped" }]);
  });

  it("reports a newer version read-only but still loads it, and preserves unknown keys", () => {
    const { state, report, unknown } = loadImageEditorDocument({ ...valid, version: 2, layers: [{ id: "l1" }] });
    expect(report.readOnly).toMatchObject({ kind: "newerVersion", version: 2, supported: 1 });
    expect(state.crop).toEqual(valid.crop);
    expect(unknown).toEqual({ layers: [{ id: "l1" }] });
    expect(report.unknownKeys).toEqual(["layers"]);
  });

  it("reports unparsable input and returns defaults", () => {
    const { state, report } = loadImageEditorDocument("not json");
    expect(report.readOnly?.kind).toBe("invalid");
    expect(state.annotations).toEqual([]);
  });

  it("does not share references with the input", () => {
    const input = structuredClone(valid);
    const { state } = loadImageEditorDocument(input);
    state.annotations[0].x = 999;
    state.depthMask.depthRange[0] = 999;
    expect(input.annotations[0].x).toBe(1);
    expect(input.depthMask.depthRange[0]).toBe(10);
  });
});
