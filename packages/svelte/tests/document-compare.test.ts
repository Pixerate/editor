import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { Editor } from "@tiptap/core";
import { TrackChanges, createRichTextPreset, getTrackedChanges } from "@pixerate/editor";
import { ReviewToolbar, createDocumentCompare } from "../src/review";
import * as RootExports from "../src";

const reviewer = { id: "rev", name: "Reviewer" };
let cleanups: (() => void)[] = [];

beforeAll(() => {
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function makeEditor() {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...createRichTextPreset(), TrackChanges.configure({ author: reviewer })],
    content: "<p>Draft</p>",
  });
  cleanups.push(() => editor.destroy());
  return editor;
}

describe("createDocumentCompare", () => {
  it("is exported from the package root", () => {
    expect(RootExports.createDocumentCompare).toBe(createDocumentCompare);
  });

  it("compares two versions into the editor for review", () => {
    const editor = makeEditor();
    const compare = createDocumentCompare(editor, { granularity: "word" });
    expect(compare.summary).toBeNull();
    const summary = compare.compare("<p>The cat sat.</p><p>Gone</p>", "<p>The dog sat.</p>");
    expect(summary).toMatchObject({ insertions: 1, deletions: 2 });
    expect(compare.summary).toBe(summary);
    expect(getTrackedChanges(editor.state.doc).map((c) => c.author.id)).toEqual(["rev", "rev", "rev"]);

    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = mount(ReviewToolbar, { target, props: { editor } });
    flushSync();
    cleanups.unshift(() => {
      unmount(instance);
      target.remove();
    });
    expect(target.textContent).toMatch(/of 3|3 changes/);
    const rejectAll = Array.from(target.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Reject all",
    )!;
    rejectAll.click();
    flushSync();
    expect(editor.getHTML()).toBe("<p>The cat sat.</p><p>Gone</p>");

    compare.clear();
    expect(compare.summary).toBeNull();
  });

  it("returns null without an editor", () => {
    expect(createDocumentCompare(null).compare("<p>a</p>", "<p>b</p>")).toBeNull();
  });
});
