// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createRichTextPreset, getStyleRegistry } from "@pixerate/editor";
import { StylesGallery, useParagraphStyles } from "../src";

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

function makeEditor(content = "<p>Hello world</p>") {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createRichTextPreset({ paragraphStyles: true }),
    content,
  });
  editors.push(editor);
  return editor;
}

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const buttonByText = (text: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text))!;

describe("useParagraphStyles", () => {
  it("tracks the current style and applies styles", async () => {
    const editor = makeEditor("<p>Body</p><h2>Head</h2>");
    let latest: ReturnType<typeof useParagraphStyles> | null = null;
    let renders = 0;
    function Probe() {
      renders++;
      latest = useParagraphStyles(editor);
      return null;
    }
    await render(<Probe />);
    expect(latest!.currentStyleId).toBe("Normal");
    expect(latest!.gallery.map((s) => s.id)).toContain("Heading1");
    await act(async () => {
      editor.commands.setTextSelection(8);
    });
    expect(latest!.currentStyle?.name).toBe("Heading 2");
    await act(async () => {
      latest!.apply("Title");
    });
    expect(latest!.currentStyleId).toBe("Title");
    let id: string | null = null;
    await act(async () => {
      id = latest!.createFromSelection("My Style");
    });
    expect(id).toBe("MyStyle");
    expect(latest!.currentStyleId).toBe("MyStyle");
    expect(renders).toBeLessThan(12);
  });

  it("handles a null editor", async () => {
    let latest: ReturnType<typeof useParagraphStyles> | null = null;
    function Probe() {
      latest = useParagraphStyles(null);
      return null;
    }
    await render(<Probe />);
    expect(latest!.styles).toEqual([]);
    expect(latest!.apply("Title")).toBe(false);
    expect(latest!.createFromSelection("x")).toBeNull();
  });
});

describe("StylesGallery", () => {
  it("shows the current style, opens the list and applies a style on click", async () => {
    const editor = makeEditor();
    await render(<StylesGallery editor={editor} />);
    const toggle = container.querySelector('[aria-haspopup="listbox"]')!;
    expect(toggle.textContent).toContain("Normal");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await click(toggle);
    const option = container.querySelector('[data-style-id="Heading1"]')!;
    expect(option.getAttribute("aria-selected")).toBe("false");
    expect((option as HTMLElement).style.fontWeight).toBe("700");
    await click(option);
    expect(editor.getHTML()).toContain("<h1");
    expect(container.querySelector('[aria-haspopup="listbox"]')!.textContent).toContain("Heading 1");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("gallery variant updates the current style to match the selection", async () => {
    const editor = makeEditor("<h2><em>Head</em></h2>");
    editor.commands.setTextSelection({ from: 1, to: 5 });
    const changes: string[] = [];
    await render(
      <StylesGallery editor={editor} variant="gallery" onChange={(e) => changes.push(`${e.type}:${e.id}`)} />,
    );
    expect(container.querySelector('[data-style-id="Heading2"]')!.getAttribute("aria-selected")).toBe("true");
    await click(buttonByText("Update Heading 2 to match selection"));
    expect(getStyleRegistry(editor)!.get("Heading2")!.character?.italic).toBe(true);
    expect(changes).toEqual(["update:Heading2"]);
  });

  it("creates a new style from the selection", async () => {
    const editor = makeEditor('<p><strong>Callout</strong></p>');
    editor.commands.setTextSelection({ from: 1, to: 8 });
    await render(<StylesGallery editor={editor} variant="gallery" />);
    await click(buttonByText("New style from selection"));
    const input = container.querySelector('input[aria-label="New style name"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Callout");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.form!.requestSubmit();
    });
    const registry = getStyleRegistry(editor)!;
    expect(registry.get("Callout")?.character?.bold).toBe(true);
    expect(container.querySelector('[data-style-id="Callout"]')!.getAttribute("aria-selected")).toBe("true");
  });

  it("hides actions when asked and shows all styles", async () => {
    const editor = makeEditor();
    await render(<StylesGallery editor={editor} variant="gallery" showActions={false} showAllStyles />);
    expect(container.querySelector('[data-style-id="Heading4"]')).not.toBeNull();
    expect(buttonByText("New style from selection")).toBeUndefined();
  });
});
