import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { Editor } from "@tiptap/core";
import { createRichTextPreset } from "@pixerate/editor";
import { InsertTableGrid, TableBubbleMenu, TableToolbar, createTableMenu } from "../src/tables";
import * as RootExports from "../src";

let cleanups: (() => void)[] = [];

beforeAll(() => {
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

const TABLE =
  "<table><tr><th><p>Name</p></th><th><p>Qty</p></th></tr><tr><td><p>Apples</p></td><td><p>3</p></td></tr></table><p>after</p>";

function makeEditor(content = TABLE) {
  const editor = new Editor({ element: document.createElement("div"), extensions: createRichTextPreset(), content });
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

const posOf = (editor: Editor, text: string) => {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
    return found < 0;
  });
  return found;
};

function select(editor: Editor, pos: number) {
  editor.commands.setTextSelection(pos);
  flushSync();
}

function click(el: Element | null) {
  (el as HTMLElement).click();
  flushSync();
}

const rowCount = (editor: Editor) => {
  let rows = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "tableRow") rows++;
    return true;
  });
  return rows;
};

describe("createTableMenu", () => {
  it("follows the selection and runs actions", () => {
    const editor = makeEditor();
    const menu = createTableMenu(editor);
    cleanups.unshift(() => menu.destroy());
    select(editor, posOf(editor, "after") + 1);
    expect(menu.current.inTable).toBe(false);
    expect(menu.current.actions.addRowAfter.reason).toBe("Place the cursor in a table first.");
    select(editor, posOf(editor, "Apples") + 1);
    expect(menu.current).toMatchObject({ inTable: true, rows: 2, columns: 2, row: 1, column: 0, headerRow: true });
    expect(menu.run("addRowAfter")).toBe(true);
    expect(menu.current.rows).toBe(3);
    expect(menu.check("insertTable")).toMatch(/cannot be nested/);
  });

  it("is exported from the package root", () => {
    expect(RootExports.createTableMenu).toBe(createTableMenu);
    expect(RootExports.TableToolbar).toBe(TableToolbar);
    expect(RootExports.InsertTableGrid).toBe(InsertTableGrid);
    expect(RootExports.TableBubbleMenu).toBe(TableBubbleMenu);
  });
});

describe("TableToolbar", () => {
  it("renders only inside a table, with reasons for disabled buttons", () => {
    const editor = makeEditor();
    select(editor, posOf(editor, "after") + 1);
    const target = render(TableToolbar, { editor });
    expect(target.querySelector('[role="toolbar"]')).toBeNull();

    select(editor, posOf(editor, "Apples") + 1);
    const toolbar = target.querySelector('[role="toolbar"][aria-label="Table"]')!;
    expect(toolbar).not.toBeNull();
    const merge = toolbar.querySelector('[data-action="mergeCells"]') as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(merge.title).toBe("Merge cells: Select two or more adjacent cells to merge.");
    expect(toolbar.querySelector('[data-action="toggleHeaderRow"]')!.getAttribute("aria-pressed")).toBe("true");

    click(toolbar.querySelector('[data-action="addRowAfter"]'));
    expect(rowCount(editor)).toBe(3);
    click(target.querySelector('[data-action="alignCenter"]'));
    expect(target.querySelector('[data-action="alignCenter"]')!.getAttribute("aria-pressed")).toBe("true");
    click(target.querySelector('[data-action="toggleHeaderRow"]'));
    expect(editor.getHTML()).not.toContain("<th");
    click(target.querySelector('[data-action="deleteTable"]'));
    expect(editor.getHTML()).toBe("<p>after</p>");
    expect(target.querySelector('[role="toolbar"]')).toBeNull();
  });

  it("can stay visible outside tables and use custom items", () => {
    const editor = makeEditor("<p>x</p>");
    const onaction = vi.fn();
    const target = render(TableToolbar, {
      editor,
      showWhenOutside: true,
      onaction,
      items: [{ id: "insert", action: "insertTable", params: { rows: 2, cols: 2 }, label: "Table", title: "Insert table", group: "a" }],
    });
    click(target.querySelector('[data-action="insert"]'));
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(rowCount(editor)).toBe(2);
  });
});

describe("InsertTableGrid", () => {
  it("previews the size on hover and inserts that table", () => {
    const editor = makeEditor("<p>x</p>");
    const oninsert = vi.fn();
    const target = render(InsertTableGrid, { editor, rows: 4, cols: 5, oninsert });
    expect(target.querySelectorAll("[data-rows]").length).toBe(20);
    const cell = target.querySelector('[data-rows="3"][data-cols="2"]')!;
    cell.dispatchEvent(new MouseEvent("mouseenter"));
    flushSync();
    expect(target.querySelector('[data-testid="insert-table-size"]')!.textContent!.trim()).toBe("3 × 2");
    click(cell);
    expect(oninsert).toHaveBeenCalledWith({ rows: 3, cols: 2 });
    expect(rowCount(editor)).toBe(3);
    expect(editor.getHTML()).toContain("<th");
    expect((target.querySelector('[data-rows="1"][data-cols="1"]') as HTMLButtonElement).disabled).toBe(true);
    expect(target.querySelector("[data-insert-table-grid]")!.getAttribute("title")).toMatch(/cannot be nested/);
  });
});

describe("TableBubbleMenu", () => {
  it("registers its own bubble menu plugin with the table toolbar", () => {
    const editor = makeEditor();
    select(editor, posOf(editor, "Apples") + 1);
    render(TableBubbleMenu, { editor });
    expect(editor.state.plugins.some((p) => (p as any).key?.startsWith("tableBubbleMenu"))).toBe(true);
    // The plugin detaches the menu element until tippy shows it.
    const view = (editor.view as any).pluginViews.find((v: any) => v.element?.querySelector?.("[data-table-toolbar]"));
    expect(view.element.querySelector('[data-action="addRowAfter"]')).not.toBeNull();
  });
});
