// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createRichTextPreset } from "@pixerate/editor";
import { InsertTableGrid, TableBubbleMenu, TableToolbar, useTableMenu } from "../src";

let container: HTMLDivElement;
let root: Root;
let editors: Editor[] = [];

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
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

const TABLE =
  "<table><tr><th><p>Name</p></th><th><p>Qty</p></th></tr><tr><td><p>Apples</p></td><td><p>3</p></td></tr></table><p>after</p>";

function makeEditor(content = TABLE, options: Parameters<typeof createRichTextPreset>[0] = {}) {
  const editor = new Editor({ element: document.createElement("div"), extensions: createRichTextPreset(options), content });
  editors.push(editor);
  return editor;
}

const posOf = (editor: Editor, text: string) => {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
    return found < 0;
  });
  return found;
};

async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
}

async function click(el: Element | null) {
  await act(async () => (el as HTMLElement).click());
}

async function select(editor: Editor, pos: number) {
  await act(async () => {
    editor.commands.setTextSelection(pos);
  });
}

const rowCount = (editor: Editor) => {
  let rows = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "tableRow") rows++;
    return true;
  });
  return rows;
};

describe("useTableMenu", () => {
  it("follows the selection and runs actions", async () => {
    const editor = makeEditor();
    let latest: ReturnType<typeof useTableMenu> | null = null;
    function Probe() {
      latest = useTableMenu(editor);
      return null;
    }
    await render(<Probe />);
    await select(editor, posOf(editor, "after") + 1);
    expect(latest!.inTable).toBe(false);
    expect(latest!.actions.addRowAfter.reason).toBe("Place the cursor in a table first.");
    await select(editor, posOf(editor, "Apples") + 1);
    expect(latest!).toMatchObject({ inTable: true, rows: 2, columns: 2, row: 1, column: 0, headerRow: true });
    await act(async () => {
      expect(latest!.run("addRowAfter")).toBe(true);
    });
    expect(latest!.rows).toBe(3);
    expect(latest!.check("insertTable")).toMatch(/cannot be nested/);
  });
});

describe("TableToolbar", () => {
  it("renders only inside a table, with reasons for disabled buttons", async () => {
    const editor = makeEditor();
    await select(editor, posOf(editor, "after") + 1);
    await render(<TableToolbar editor={editor} />);
    expect(container.querySelector('[role="toolbar"]')).toBeNull();

    await select(editor, posOf(editor, "Apples") + 1);
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Table"]')!;
    expect(toolbar).not.toBeNull();
    const merge = toolbar.querySelector('[data-action="mergeCells"]') as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(merge.title).toBe("Merge cells: Select two or more adjacent cells to merge.");
    const headerRow = toolbar.querySelector('[data-action="toggleHeaderRow"]')!;
    expect(headerRow.getAttribute("aria-pressed")).toBe("true");

    await click(toolbar.querySelector('[data-action="addRowAfter"]'));
    expect(rowCount(editor)).toBe(3);
    await click(container.querySelector('[data-action="alignCenter"]'));
    expect(container.querySelector('[data-action="alignCenter"]')!.getAttribute("aria-pressed")).toBe("true");
    await click(container.querySelector('[data-action="toggleHeaderRow"]'));
    expect(editor.getHTML()).not.toContain("<th");
    await click(container.querySelector('[data-action="deleteTable"]'));
    expect(editor.getHTML()).toBe("<p>after</p>");
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });

  it("can stay visible outside tables and use custom items", async () => {
    const editor = makeEditor("<p>x</p>");
    const onAction = vi.fn();
    await render(
      <TableToolbar
        editor={editor}
        showWhenOutside
        onAction={onAction}
        items={[{ id: "insert", action: "insertTable", params: { rows: 2, cols: 2 }, label: "Table", title: "Insert table", group: "a" }]}
      />,
    );
    await click(container.querySelector('[data-action="insert"]'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(rowCount(editor)).toBe(2);
  });
});

describe("InsertTableGrid", () => {
  it("previews the size on hover and inserts that table", async () => {
    const editor = makeEditor("<p>x</p>");
    const onInsert = vi.fn();
    await render(<InsertTableGrid editor={editor} rows={4} cols={5} onInsert={onInsert} />);
    const cells = container.querySelectorAll("[data-rows]");
    expect(cells.length).toBe(20);
    const target = container.querySelector('[data-rows="3"][data-cols="2"]')!;
    await act(async () => {
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="insert-table-size"]')!.textContent).toBe("3 × 2");
    await click(target);
    expect(onInsert).toHaveBeenCalledWith({ rows: 3, cols: 2 });
    expect(rowCount(editor)).toBe(3);
    expect(editor.getHTML()).toContain("<th");
    // The cursor is now in the table: nested tables are not allowed.
    const button = container.querySelector('[data-rows="1"][data-cols="1"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.querySelector('[data-insert-table-grid]')!.getAttribute("title")).toMatch(/cannot be nested/);
  });
});

describe("TableBubbleMenu", () => {
  it("registers its own bubble menu plugin with the table toolbar", async () => {
    const editor = makeEditor();
    await select(editor, posOf(editor, "Apples") + 1);
    let toolbar: HTMLElement | null = null;
    await render(
      <TableBubbleMenu editor={editor}>
        <TableToolbar editor={editor} className="t" />
        <span ref={(el) => (toolbar = el?.parentElement ?? null)} />
      </TableBubbleMenu>,
    );
    expect(editor.state.plugins.some((p) => (p as any).key?.startsWith("tableBubbleMenu"))).toBe(true);
    // The menu element (portal target) holds the toolbar until tippy shows it.
    expect(toolbar!.querySelector('[data-table-toolbar] [data-action="addRowAfter"]')).not.toBeNull();
  });

  it("renders the default table toolbar", async () => {
    const editor = makeEditor();
    await select(editor, posOf(editor, "Apples") + 1);
    await render(<TableBubbleMenu editor={editor} toolbarProps={{ className: "bubble-toolbar" }} />);
    expect(editor.state.plugins.some((p) => (p as any).key?.startsWith("tableBubbleMenu"))).toBe(true);
    const view = (editor.view as any).pluginViews.find((v: any) => v.element?.querySelector?.("[data-table-toolbar]"));
    expect(view.element.querySelector('.bubble-toolbar [data-action="addRowAfter"]')).not.toBeNull();
  });
});
