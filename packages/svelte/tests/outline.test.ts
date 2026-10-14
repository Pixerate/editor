import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { createRichTextPreset } from "@pixerate/editor";
import * as SvelteEditor from "../src";
import { OutlinePanel, createOutline } from "../src";

let target: HTMLDivElement;
let editor: Editor;

beforeAll(() => {
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

beforeEach(() => {
  target = document.createElement("div");
  document.body.appendChild(target);
  editor = new Editor({
    extensions: createRichTextPreset({ outline: true }),
    content: '<h1 id="intro">Intro</h1><p>text</p><h2 id="details">Details</h2><p>more</p>',
  });
});

afterEach(() => {
  target.remove();
  editor.destroy();
});

const buttons = () =>
  Array.from(target.querySelectorAll<HTMLButtonElement>("button[data-heading-id]"));

describe("Svelte OutlinePanel", () => {
  it("is exported with createOutline", () => {
    expect(SvelteEditor.OutlinePanel).toBeDefined();
    expect(SvelteEditor.createOutline).toBeDefined();
  });

  it("lists headings and updates when headings change", () => {
    const component = mount(OutlinePanel, { target, props: { editor } });
    flushSync();
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(["Intro", "Details"]);
    expect(buttons()[1].parentElement!.getAttribute("data-level")).toBe("2");

    editor.commands.insertContentAt(editor.state.doc.content.size, "<h2>Appendix</h2>");
    flushSync();
    expect(buttons().map((b) => b.textContent?.trim())).toEqual([
      "Intro",
      "Details",
      "Appendix",
    ]);
    unmount(component);
  });

  it("navigates on click and highlights the current section", () => {
    const onNavigate = vi.fn();
    const component = mount(OutlinePanel, { target, props: { editor, onNavigate } });
    flushSync();

    buttons()[1].click();
    flushSync();
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: "details" }));
    expect(editor.state.selection.$from.parent.textContent).toBe("Details");
    expect(buttons()[1].getAttribute("aria-current")).toBe("location");
    expect(buttons()[0].getAttribute("aria-current")).toBeNull();

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 8)),
    );
    flushSync();
    expect(buttons()[0].getAttribute("aria-current")).toBe("location");
    unmount(component);
  });

  it("shows the empty state without an editor", () => {
    const component = mount(OutlinePanel, { target, props: { editor: null, emptyText: "Nothing" } });
    flushSync();
    expect(target.textContent).toContain("Nothing");
    unmount(component);
  });

  it("createOutline tracks the outline and stops after destroy", () => {
    const outline = createOutline(editor);
    expect(outline.current.headings.map((h) => h.id)).toEqual(["intro", "details"]);
    const before = outline.current;
    editor.commands.focusHeading("details");
    expect(outline.current).not.toBe(before);
    expect(outline.current.activeId).toBe("details");
    outline.destroy();
    editor.commands.focusHeading("intro");
    expect(outline.current.activeId).toBe("details");
  });
});
