import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import {
  DirtyTracker,
  createDirtyTracker,
  defaultIsEqual,
  createEditor,
  createRichTextPreset,
} from "../src";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
});

describe("Dirty Tracking in @pixerate/editor (Core)", () => {
  describe("defaultIsEqual", () => {
    it("compares primitives accurately", () => {
      expect(defaultIsEqual(1, 1)).toBe(true);
      expect(defaultIsEqual("hello", "hello")).toBe(true);
      expect(defaultIsEqual(true, true)).toBe(true);
      expect(defaultIsEqual("a", "b")).toBe(false);
      expect(defaultIsEqual(1, 2)).toBe(false);
    });

    it("compares objects and arrays structurally", () => {
      expect(defaultIsEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBe(
        true,
      );
      expect(defaultIsEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 4] })).toBe(
        false,
      );
      expect(defaultIsEqual([1, 2, { c: 3 }], [1, 2, { c: 3 }])).toBe(true);
      expect(defaultIsEqual([1, 2], [1, 2, 3])).toBe(false);
      expect(defaultIsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });
  });

  describe("DirtyTracker", () => {
    it("tracks baseline and detects changes", () => {
      const tracker = createDirtyTracker({
        title: "Initial",
        tags: ["a", "b"],
      });
      expect(tracker.isDirty({ title: "Initial", tags: ["a", "b"] })).toBe(
        false,
      );

      expect(tracker.isDirty({ title: "Modified", tags: ["a", "b"] })).toBe(
        true,
      );
      expect(tracker.isDirty({ title: "Initial", tags: ["a", "c"] })).toBe(
        true,
      );
    });

    it("supports resetting baseline", () => {
      const tracker = new DirtyTracker("initial text");
      expect(tracker.isDirty("changed text")).toBe(true);

      tracker.reset("changed text");
      expect(tracker.isDirty("changed text")).toBe(false);
      expect(tracker.getBaseline()).toBe("changed text");
    });

    it("supports custom equality comparator", () => {
      const customEqual = (a: { id: string }, b: { id: string }) =>
        a.id === b.id;
      const tracker = createDirtyTracker({ id: "1", note: "abc" }, customEqual);

      // Same id, different note -> not dirty under custom equality
      expect(tracker.isDirty({ id: "1", note: "xyz" })).toBe(false);
      expect(tracker.isDirty({ id: "2", note: "abc" })).toBe(true);
    });
  });

  describe("EditorController dirty tracking", () => {
    it("tracks dirty state in plainTextMode", () => {
      const controller = createEditor({
        content: "Hello world",
        plainTextMode: true,
        extensions: createRichTextPreset(),
      });

      expect(controller.isDirty()).toBe(false);
      expect(controller.getBaselineContent()).toBe("Hello world");

      controller.setPlainText("Hello modified world", false);
      expect(controller.isDirty()).toBe(true);

      controller.resetDirty();
      expect(controller.isDirty()).toBe(false);
      expect(controller.getBaselineContent()).toBe("Hello modified world");

      controller.destroy();
    });
  });
});
