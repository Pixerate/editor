import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { Editor } from "@tiptap/core";
import { TrackChanges, createRichTextPreset, getTrackedChanges } from "@pixerate/editor";
import { FindReplaceBar, createFindReplace } from "../src/find-replace";
import * as RootExports from "../src";

let cleanups: (() => void)[] = [];

beforeAll(() => {
  // ProseMirror measures layout; jsdom does not implement these.
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
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
  cleanups.push(() => editor.destroy());
  return editor;
}

function render(component: any, props: Record<string, any>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanups.unshift(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}

const byLabel = (root: Element, label: string) =>
  root.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const buttonText = (root: Element, text: string) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)!;
const status = (root: Element) => root.querySelector('[data-testid="find-status"]')?.textContent?.trim();

function click(el: Element) {
  (el as HTMLElement).click();
  flushSync();
}

function typeInto(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function keyDown(el: Element, init: KeyboardEventInit) {
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  flushSync();
}

describe("createFindReplace", () => {
  it("tracks the find state and exposes commands", () => {
    const editor = makeEditor();
    const find = createFindReplace(editor);
    cleanups.push(() => find.destroy());
    expect(find.available).toBe(true);
    find.setQuery("red");
    expect(find.matchCount).toBe(2);
    expect(find.currentIndex).toBe(0);
    find.next();
    find.next();
    expect(find.currentIndex).toBe(1);
    find.setReplacement("blue");
    find.replaceAll();
    expect(editor.getText()).toBe("blue green blue");
    expect(find.lastReplaceCount).toBe(2);

    const values: number[] = [];
    const stop = find.subscribe((s) => values.push(s.matches.length));
    stop();
    expect(values).toEqual([0]);
  });

  it("is a no-op without the extension and is exported from the root", () => {
    const find = createFindReplace(null);
    expect(find.available).toBe(false);
    expect(() => find.next()).not.toThrow();
    expect(RootExports.FindReplaceBar).toBe(FindReplaceBar);
    expect(RootExports.createFindReplace).toBe(createFindReplace);
  });
});

describe("FindReplaceBar (Svelte)", () => {
  it("stays hidden until opened, then focuses the find field", () => {
    const editor = makeEditor();
    const root = render(FindReplaceBar, { editor });
    expect(root.querySelector('[role="search"]')).toBeNull();
    editor.commands.openFindReplace();
    flushSync();
    const input = byLabel(root, "Find") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("finds, steps with buttons and Enter, and shows '1 of 2'", () => {
    const editor = makeEditor();
    const root = render(FindReplaceBar, { editor, alwaysOpen: true });
    const input = byLabel(root, "Find") as HTMLInputElement;
    typeInto(input, "red");
    expect(status(root)).toBe("1 of 2");
    expect(editor.view.dom.querySelectorAll(".pixerate-find-match")).toHaveLength(2);
    click(byLabel(root, "Next match")!);
    click(byLabel(root, "Next match")!);
    expect(status(root)).toBe("2 of 2");
    keyDown(input, { key: "Enter", shiftKey: true });
    expect(status(root)).toBe("1 of 2");
    keyDown(input, { key: "Enter" });
    expect(status(root)).toBe("2 of 2");
    typeInto(input, "blue");
    expect(status(root)).toBe("No results");
    expect((byLabel(root, "Next match") as HTMLButtonElement).disabled).toBe(true);
  });

  it("toggles options and shows pattern errors", () => {
    const editor = makeEditor("<p>Red red</p>");
    const root = render(FindReplaceBar, { editor, alwaysOpen: true });
    typeInto(byLabel(root, "Find") as HTMLInputElement, "red");
    expect(status(root)).toBe("1 of 2");
    const matchCase = byLabel(root, "Match case")!;
    click(matchCase);
    expect(matchCase.getAttribute("aria-pressed")).toBe("true");
    expect(status(root)).toBe("1 of 1");
    click(byLabel(root, "Use wildcards")!);
    typeInto(byLabel(root, "Find") as HTMLInputElement, "[z-a]");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("ascending");
    click(byLabel(root, "More options")!);
    expect(root.querySelectorAll('input[type="checkbox"]').length).toBe(5);
  });

  it("replaces the current match and all matches (tracked when tracking is on)", () => {
    const editor = makeEditor("<p>red green red red</p>", true);
    const root = render(FindReplaceBar, { editor, alwaysOpen: true });
    click(byLabel(root, "Toggle replace")!);
    typeInto(byLabel(root, "Find") as HTMLInputElement, "red");
    typeInto(byLabel(root, "Replace") as HTMLInputElement, "blue");
    click(buttonText(root, "Replace"));
    expect(status(root)).toBe("1 of 2");
    keyDown(byLabel(root, "Replace")!, { key: "Enter", ctrlKey: true });
    expect(status(root)).toBe("No results");
    expect(root.textContent).toContain("2 replaced");
    expect(getTrackedChanges(editor).filter((c) => c.type === "insertion")).toHaveLength(3);
    editor.commands.acceptAllChanges();
    expect(editor.getText()).toBe("blue green blue blue");
  });

  it("closes on Escape and removes the highlights", () => {
    const editor = makeEditor();
    let closed = 0;
    const root = render(FindReplaceBar, { editor, onclose: () => closed++ });
    editor.commands.openFindReplace({ mode: "replace", query: "red" });
    flushSync();
    expect(byLabel(root, "Replace")).not.toBeNull();
    expect(editor.view.dom.querySelectorAll(".pixerate-find-match")).toHaveLength(2);
    keyDown(byLabel(root, "Find")!, { key: "Escape" });
    expect(root.querySelector('[role="search"]')).toBeNull();
    expect(closed).toBe(1);
    expect(editor.view.dom.querySelectorAll(".pixerate-find-match")).toHaveLength(0);
  });
});
