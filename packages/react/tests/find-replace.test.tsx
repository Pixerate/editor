// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { TrackChanges, createRichTextPreset, getTrackedChanges } from "@pixerate/editor";
import { FindReplaceBar, useFindReplace, type UseFindReplaceResult } from "../src";

let container: HTMLDivElement;
let root: Root;
let editors: Editor[] = [];

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // ProseMirror measures layout; jsdom does not implement these.
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

function makeEditor(content = "<p>red green red</p>", tracking = false) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...createRichTextPreset({ findReplace: true }),
      TrackChanges.configure({ enabled: tracking, author: { id: "a", name: "A" } }),
    ],
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

const byLabel = (label: string) =>
  container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const buttonText = (text: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text)!;
const status = () => container.querySelector('[data-testid="find-status"]')?.textContent;

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function typeInto(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function keyDown(el: Element, init: KeyboardEventInit) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

describe("useFindReplace", () => {
  it("tracks the find state and exposes commands", async () => {
    const editor = makeEditor();
    let latest: UseFindReplaceResult | null = null;
    const Probe = () => {
      latest = useFindReplace(editor);
      return null;
    };
    await render(<Probe />);
    expect(latest!.available).toBe(true);
    expect(latest!.matchCount).toBe(0);
    await act(async () => latest!.setQuery("red"));
    expect(latest!.matchCount).toBe(2);
    expect(latest!.currentIndex).toBe(0);
    await act(async () => latest!.next());
    await act(async () => latest!.next());
    expect(latest!.currentIndex).toBe(1);
    await act(async () => latest!.setReplacement("blue"));
    await act(async () => latest!.replaceAll());
    expect(editor.getText()).toBe("blue green blue");
    expect(latest!.lastReplaceCount).toBe(2);
  });

  it("reports unavailable without the extension", async () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: createRichTextPreset() });
    editors.push(editor);
    let latest: UseFindReplaceResult | null = null;
    const Probe = () => {
      latest = useFindReplace(editor);
      return null;
    };
    await render(<Probe />);
    expect(latest!.available).toBe(false);
    expect(() => latest!.next()).not.toThrow();
  });
});

describe("FindReplaceBar", () => {
  it("stays hidden until opened, then focuses the find field", async () => {
    const editor = makeEditor();
    await render(<FindReplaceBar editor={editor} />);
    expect(container.querySelector('[role="search"]')).toBeNull();
    await act(async () => {
      editor.commands.openFindReplace();
    });
    const input = byLabel("Find") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("finds, steps with buttons and Enter, and shows '1 of 2'", async () => {
    const editor = makeEditor();
    await render(<FindReplaceBar editor={editor} alwaysOpen />);
    const input = byLabel("Find") as HTMLInputElement;
    await typeInto(input, "red");
    expect(status()).toBe("1 of 2");
    expect(editor.view.dom.querySelectorAll(".pixerate-find-match")).toHaveLength(2);
    await click(byLabel("Next match")!);
    await click(byLabel("Next match")!);
    expect(status()).toBe("2 of 2");
    await keyDown(input, { key: "Enter", shiftKey: true });
    expect(status()).toBe("1 of 2");
    await keyDown(input, { key: "Enter" });
    expect(status()).toBe("2 of 2");
    await typeInto(input, "blue");
    expect(status()).toBe("No results");
    expect((byLabel("Next match") as HTMLButtonElement).disabled).toBe(true);
  });

  it("toggles options and shows pattern errors", async () => {
    const editor = makeEditor("<p>Red red</p>");
    await render(<FindReplaceBar editor={editor} alwaysOpen />);
    await typeInto(byLabel("Find") as HTMLInputElement, "red");
    expect(status()).toBe("1 of 2");
    const matchCase = byLabel("Match case")!;
    await click(matchCase);
    expect(matchCase.getAttribute("aria-pressed")).toBe("true");
    expect(status()).toBe("1 of 1");
    await click(byLabel("Use wildcards")!);
    await typeInto(byLabel("Find") as HTMLInputElement, "[z-a]");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("ascending");
    await click(byLabel("More options")!);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(5);
  });

  it("replaces the current match and all matches (tracked when tracking is on)", async () => {
    const editor = makeEditor("<p>red green red red</p>", true);
    await render(<FindReplaceBar editor={editor} alwaysOpen />);
    await click(byLabel("Toggle replace")!);
    await typeInto(byLabel("Find") as HTMLInputElement, "red");
    await typeInto(byLabel("Replace") as HTMLInputElement, "blue");
    await click(buttonText("Replace"));
    expect(status()).toBe("1 of 2");
    await keyDown(byLabel("Replace")!, { key: "Enter", ctrlKey: true });
    expect(status()).toBe("No results");
    expect(container.textContent).toContain("2 replaced");
    expect(getTrackedChanges(editor).filter((c) => c.type === "insertion")).toHaveLength(3);
    editor.commands.acceptAllChanges();
    expect(editor.getText()).toBe("blue green blue blue");
  });

  it("closes on Escape and removes the highlights", async () => {
    const editor = makeEditor();
    let closed = 0;
    await render(<FindReplaceBar editor={editor} onClose={() => closed++} />);
    await act(async () => {
      editor.commands.openFindReplace({ mode: "replace", query: "red" });
    });
    expect(byLabel("Replace")).not.toBeNull();
    expect(editor.view.dom.querySelectorAll(".pixerate-find-match")).toHaveLength(2);
    await keyDown(byLabel("Find")!, { key: "Escape" });
    expect(container.querySelector('[role="search"]')).toBeNull();
    expect(closed).toBe(1);
    expect(editor.view.dom.querySelectorAll(".pixerate-find-match")).toHaveLength(0);
  });
});
