import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { Editor } from "@tiptap/core";
import { createRichTextPreset, getStyleRegistry } from "@pixerate/editor";
import * as RootExports from "../src";
import { StylesGallery, createParagraphStyles } from "../src";

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

function makeEditor(content = "<p>Hello world</p>") {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createRichTextPreset({ paragraphStyles: true }),
    content,
  });
  cleanups.push(() => editor.destroy());
  return editor;
}

function render(props: Record<string, any>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(StylesGallery, { target, props });
  flushSync();
  cleanups.unshift(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}

function click(el: Element) {
  (el as HTMLElement).click();
  flushSync();
}

const buttonByText = (root: Element, text: string) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.includes(text));

describe("createParagraphStyles", () => {
  it("is exported from the package root", () => {
    expect(RootExports.StylesGallery).toBe(StylesGallery);
    expect(RootExports.createParagraphStyles).toBe(createParagraphStyles);
  });

  it("tracks the current style and applies styles", () => {
    const editor = makeEditor("<p>Body</p><h2>Head</h2>");
    const styles = createParagraphStyles(editor);
    expect(styles.current.currentStyleId).toBe("Normal");
    expect(styles.current.gallery.map((s) => s.id)).toContain("Heading1");
    editor.commands.setTextSelection(8);
    expect(styles.currentStyle?.name).toBe("Heading 2");
    expect(styles.apply("Title")).toBe(true);
    expect(styles.current.currentStyleId).toBe("Title");
    expect(styles.createFromSelection("My Style")).toBe("MyStyle");
    expect(styles.current.currentStyleId).toBe("MyStyle");
    styles.destroy();

    const none = createParagraphStyles(null);
    expect(none.current.styles).toEqual([]);
    expect(none.apply("Title")).toBe(false);
    none.destroy();
  });
});

describe("StylesGallery (Svelte)", () => {
  it("shows the current style, opens the list and applies a style on click", () => {
    const editor = makeEditor();
    const root = render({ editor });
    const toggle = root.querySelector('[aria-haspopup="listbox"]')!;
    expect(toggle.textContent).toContain("Normal");
    expect(root.querySelector('[role="listbox"]')).toBeNull();
    click(toggle);
    const option = root.querySelector('[data-style-id="Heading1"]') as HTMLElement;
    expect(option.getAttribute("aria-selected")).toBe("false");
    expect(option.style.fontWeight).toBe("700");
    click(option);
    expect(editor.getHTML()).toContain("<h1");
    expect(root.querySelector('[aria-haspopup="listbox"]')!.textContent).toContain("Heading 1");
    expect(root.querySelector('[role="listbox"]')).toBeNull();
  });

  it("gallery variant updates the current style to match the selection", () => {
    const editor = makeEditor("<h2><em>Head</em></h2>");
    editor.commands.setTextSelection({ from: 1, to: 5 });
    const changes: string[] = [];
    const root = render({
      editor,
      variant: "gallery",
      onchange: (e: { type: string; id: string }) => changes.push(`${e.type}:${e.id}`),
    });
    expect(root.querySelector('[data-style-id="Heading2"]')!.getAttribute("aria-selected")).toBe("true");
    click(buttonByText(root, "Update Heading 2 to match selection")!);
    expect(getStyleRegistry(editor)!.get("Heading2")!.character?.italic).toBe(true);
    expect(changes).toEqual(["update:Heading2"]);
  });

  it("creates a new style from the selection", () => {
    const editor = makeEditor("<p><strong>Callout</strong></p>");
    editor.commands.setTextSelection({ from: 1, to: 8 });
    const root = render({ editor, variant: "gallery" });
    click(buttonByText(root, "New style from selection")!);
    const input = root.querySelector('input[aria-label="New style name"]') as HTMLInputElement;
    input.value = "Callout";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    input.form!.requestSubmit();
    flushSync();
    expect(getStyleRegistry(editor)!.get("Callout")?.character?.bold).toBe(true);
    expect(root.querySelector('[data-style-id="Callout"]')!.getAttribute("aria-selected")).toBe("true");
  });

  it("hides actions when asked and shows all styles", () => {
    const editor = makeEditor();
    const root = render({ editor, variant: "gallery", showActions: false, showAllStyles: true });
    expect(root.querySelector('[data-style-id="Heading4"]')).not.toBeNull();
    expect(buttonByText(root, "New style from selection")).toBeUndefined();
  });
});
