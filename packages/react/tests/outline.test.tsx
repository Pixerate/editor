// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { createRichTextPreset } from "@pixerate/editor";
import { OutlinePanel, useOutline } from "../src";
import * as ReactEditor from "../src";

let container: HTMLDivElement;
let root: Root;
let editor: Editor;

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
  editor = new Editor({
    extensions: createRichTextPreset({ outline: true }),
    content: '<h1 id="intro">Intro</h1><p>text</p><h2 id="details">Details</h2><p>more</p>',
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  editor.destroy();
});

const buttons = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button[data-heading-id]"));

describe("OutlinePanel", () => {
  it("is exported with useOutline", () => {
    expect(ReactEditor.OutlinePanel).toBeDefined();
    expect(ReactEditor.useOutline).toBeDefined();
  });

  it("lists headings with nesting and updates when headings change", async () => {
    await act(async () => root.render(<OutlinePanel editor={editor} />));
    expect(buttons().map((b) => b.textContent)).toEqual(["Intro", "Details"]);
    expect(buttons()[1].parentElement!.getAttribute("data-level")).toBe("2");

    await act(async () => {
      editor.commands.insertContentAt(editor.state.doc.content.size, "<h2>Appendix</h2>");
    });
    expect(buttons().map((b) => b.textContent)).toEqual(["Intro", "Details", "Appendix"]);
  });

  it("navigates on click and highlights the current section", async () => {
    const onNavigate = vi.fn();
    await act(async () => root.render(<OutlinePanel editor={editor} onNavigate={onNavigate} />));

    await act(async () => buttons()[1].click());
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: "details" }));
    expect(editor.state.selection.$from.parent.textContent).toBe("Details");
    expect(buttons()[1].getAttribute("aria-current")).toBe("location");
    expect(buttons()[0].getAttribute("aria-current")).toBeNull();

    // Moving the selection into the first section moves the highlight.
    await act(async () => {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 8)),
      );
    });
    expect(buttons()[0].getAttribute("aria-current")).toBe("location");
  });

  it("shows an empty state and handles a null editor", async () => {
    await act(async () => root.render(<OutlinePanel editor={null} emptyState="Nothing" />));
    expect(container.textContent).toContain("Nothing");
  });

  it("useOutline re-renders only when the outline or active heading changes", async () => {
    let renders = 0;
    function Probe() {
      useOutline(editor);
      renders++;
      return null;
    }
    await act(async () => root.render(<Probe />));
    const initial = renders;
    // Typing inside the last section changes neither the outline nor the active heading.
    await act(async () => {
      const end = editor.state.doc.content.size - 1;
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));
    });
    const afterSelect = renders;
    await act(async () => {
      editor.commands.insertContent("!");
    });
    expect(renders).toBe(afterSelect);
    expect(afterSelect).toBeGreaterThanOrEqual(initial);
  });
});
