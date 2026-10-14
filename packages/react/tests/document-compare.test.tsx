// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { TrackChanges, createRichTextPreset, getTrackedChanges } from "@pixerate/editor";
import { ReviewToolbar, useDocumentCompare, type UseDocumentCompareResult } from "../src";

let container: HTMLDivElement;
let root: Root;
let editors: Editor[] = [];

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  editors.forEach((e) => e.destroy());
  editors = [];
});

const reviewer = { id: "rev", name: "Reviewer" };

function makeEditor() {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...createRichTextPreset(), TrackChanges.configure({ author: reviewer })],
    content: "<p>Draft</p>",
  });
  editors.push(editor);
  return editor;
}

const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  )!;

describe("useDocumentCompare", () => {
  it("compares two versions into the editor for review", async () => {
    const editor = makeEditor();
    let api: UseDocumentCompareResult | null = null;
    function Harness() {
      api = useDocumentCompare(editor, { granularity: "word" });
      return (
        <div>
          <span data-testid="summary">{api.summary ? `${api.summary.insertions}/${api.summary.deletions}` : "none"}</span>
          <ReviewToolbar editor={editor} />
        </div>
      );
    }
    await act(async () => root.render(<Harness />));
    expect(container.querySelector("[data-testid=summary]")!.textContent).toBe("none");

    await act(async () => {
      api!.compare("<p>The cat sat.</p><p>Gone</p>", "<p>The dog sat.</p>");
    });
    expect(container.querySelector("[data-testid=summary]")!.textContent).toBe("1/2");
    expect(getTrackedChanges(editor.state.doc).map((c) => c.author.id)).toEqual(["rev", "rev", "rev"]);
    expect(container.textContent).toMatch(/of 3|3 changes/);

    await act(async () => button("Reject all").click());
    expect(editor.getHTML()).toBe("<p>The cat sat.</p><p>Gone</p>");

    await act(async () => api!.clear());
    expect(container.querySelector("[data-testid=summary]")!.textContent).toBe("none");
  });

  it("returns null without an editor", async () => {
    let api: UseDocumentCompareResult | null = null;
    function Harness() {
      api = useDocumentCompare(null);
      return null;
    }
    await act(async () => root.render(<Harness />));
    expect(api!.compare("<p>a</p>", "<p>b</p>")).toBeNull();
  });
});
