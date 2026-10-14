import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor, getSchema } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { NodeSelection } from "@tiptap/pm/state";
import {
  createRichTextPreset,
  createTableCommands,
  createTableStore,
  getEditorMarkdown,
  getEditorText,
  getTableActionState,
  getTableState,
  getTrackedChanges,
  getCommentAnchors,
  getFindReplaceState,
  isGfmTable,
  isSelectionInTable,
  isTableEnabled,
  markdownToTipTapHtml,
  compareDocuments,
  resolveTrackedChanges,
  runTableAction,
  normalizeTableCellColor,
  parseRichClipboardPayload,
  serializeRichClipboardPayload,
  TABLE_ACTIONS,
  DEFAULT_TABLE_TOOLBAR,
  shouldShowTableBubbleMenu,
  type RichTextPresetOptions,
} from "../src";
import { CommandRegistry } from "../src/commands";
import { ToolRegistry } from "../src/agent/registry";
import { createRichTextToolProvider } from "../src/agent/providers";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).DOMParser = dom.window.DOMParser;
  (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
});

const alice = { id: "alice", name: "Alice" };
const bob = { id: "bob", name: "Bob" };

const TABLE =
  "<table><tbody><tr><th><p>Name</p></th><th><p>Qty</p></th></tr>" +
  "<tr><td><p>Apples</p></td><td><p>3</p></td></tr>" +
  "<tr><td><p>Pears</p></td><td><p>5</p></td></tr></tbody></table><p>after</p>";

function makeEditor(content = TABLE, options: RichTextPresetOptions = {}) {
  return new Editor({ extensions: createRichTextPreset(options), content });
}

function trackedEditor(content = TABLE, author = alice) {
  let id = 0;
  return makeEditor(content, {
    trackChanges: { enabled: true, author, generateId: () => `ch-${++id}`, now: () => 42 },
  });
}

/** Document position of `text` (plus `offset`) in the editor. */
function posOf(editor: Editor, text: string, offset = 0): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text) + offset;
    return true;
  });
  if (found < 0) throw new Error(`"${text}" not found`);
  return found;
}

const at = (editor: Editor, text: string) => {
  editor.commands.setTextSelection(posOf(editor, text, 1));
  return editor;
};

/** Rows of cell texts, `th:` marking header cells. */
function grid(editor: Editor): string[][] {
  const rows: string[][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "tableRow") {
      const row: string[] = [];
      node.forEach((cell) => row.push(`${cell.type.name === "tableHeader" ? "th:" : ""}${cell.textContent}`));
      rows.push(row);
      return false;
    }
    return true;
  });
  return rows;
}

const htmlWithoutChrome = (editor: Editor) =>
  editor
    .getHTML()
    .replace(/<colgroup>.*?<\/colgroup>/g, "")
    .replace(/ style="min-width: [^"]*"/g, "")
    .replace(/ class="pixerate-table"/g, "");

describe("createRichTextPreset({ table })", () => {
  it("adds the TipTap table nodes by default", () => {
    const editor = makeEditor();
    expect(Object.keys(editor.schema.nodes)).toEqual(
      expect.arrayContaining(["table", "tableRow", "tableHeader", "tableCell"]),
    );
    expect(isTableEnabled(editor)).toBe(true);
    expect(grid(editor)).toEqual([["th:Name", "th:Qty"], ["Apples", "3"], ["Pears", "5"]]);
    editor.destroy();
  });

  it("table: false keeps the old flattening", () => {
    const editor = makeEditor(TABLE, { table: false });
    expect(editor.schema.nodes.table).toBeUndefined();
    expect(isTableEnabled(editor)).toBe(false);
    expect(editor.getHTML()).toBe(
      "<p>Name</p><p>Qty</p><p>Apples</p><p>3</p><p>Pears</p><p>5</p><p>after</p>",
    );
    expect(getTableActionState(editor, "insertTable")).toBe("Tables are not enabled in this editor.");
    expect(createRichTextToolProvider(editor, { id: "d" }).tools).toBeTypeOf("function");
    editor.destroy();
  });

  it("configures resizing, node selection and HTML attributes", () => {
    const resizable = makeEditor();
    expect(resizable.state.plugins.some((p) => (p as any).key?.startsWith("tableColumnResizing"))).toBe(true);
    expect(resizable.getHTML()).toContain('class="pixerate-table"');
    resizable.commands.setNodeSelection(0);
    expect(resizable.state.selection).toBeInstanceOf(NodeSelection);
    resizable.destroy();

    const fixed = makeEditor(TABLE, {
      table: { resizable: false, HTMLAttributes: { class: "my-table" }, cellHTMLAttributes: { class: "c" } },
    });
    expect(fixed.state.plugins.some((p) => (p as any).key?.startsWith("tableColumnResizing"))).toBe(false);
    expect(fixed.getHTML()).toContain('class="my-table"');
    expect(fixed.getHTML()).toContain('<td class="c" colspan="1" rowspan="1">');
    fixed.destroy();
  });
});

describe("table HTML", () => {
  it("round-trips headers, spans, column widths, alignment and background", () => {
    const html =
      '<table><tbody><tr><th colspan="2" style="text-align: center"><p>Group</p></th><th rowspan="2"><p>Tall</p></th></tr>' +
      '<tr><td colwidth="120" style="background-color: #fde68a"><p>a</p></td><td align="right"><p>b</p></td></tr></tbody></table>';
    const editor = makeEditor(html);
    const cells: any[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "tableCell" || node.type.name === "tableHeader") cells.push({ type: node.type.name, ...node.attrs });
      return true;
    });
    expect(cells).toEqual([
      { type: "tableHeader", colspan: 2, rowspan: 1, colwidth: null, align: "center", backgroundColor: null },
      { type: "tableHeader", colspan: 1, rowspan: 2, colwidth: null, align: null, backgroundColor: null },
      { type: "tableCell", colspan: 1, rowspan: 1, colwidth: [120], align: null, backgroundColor: expect.stringMatching(/^(#fde68a|rgb\(253, 230, 138\))$/) },
      { type: "tableCell", colspan: 1, rowspan: 1, colwidth: null, align: "right", backgroundColor: null },
    ]);
    const out = editor.getHTML();
    expect(out).toMatch(/<th colspan="2" rowspan="1" style="text-align: center;?">/);
    expect(out).toContain('<th colspan="1" rowspan="2">');
    expect(out).toContain('data-background-color=');
    // Serialized HTML parses back to the same document.
    const again = makeEditor(out);
    expect(again.state.doc.toJSON()).toEqual(editor.state.doc.toJSON());
    editor.destroy();
    again.destroy();
  });

  it("rejects unsafe cell styles", () => {
    expect(normalizeTableCellColor("url(javascript:alert(1))")).toBeNull();
    expect(normalizeTableCellColor("red; position: fixed")).toBeNull();
    expect(normalizeTableCellColor("#abc")).toBe("#abc");
    expect(normalizeTableCellColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    const editor = makeEditor('<table><tr><td data-background-color="red;top:0" align="middle"><p>x</p></td></tr></table>');
    const cell = editor.state.doc.firstChild!.firstChild!.firstChild!;
    expect(cell.attrs.backgroundColor).toBeNull();
    expect(cell.attrs.align).toBeNull();
    editor.destroy();
  });
});

describe("table actions and state", () => {
  it("explains why actions are disabled outside a table, in read-only editors and when nested", () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(posOf(editor, "after", 1));
    expect(isSelectionInTable(editor.state)).toBe(false);
    expect(getTableActionState(editor, "addRowAfter")).toBe("Place the cursor in a table first.");
    expect(getTableActionState(editor, "insertTable")).toBe(true);
    expect(getTableActionState(editor, "insertTable", { rows: 0 })).toMatch(/Rows must be/);
    expect(getTableActionState(editor, "insertTable", { cols: 51 })).toMatch(/Columns must be/);
    at(editor, "Apples");
    expect(getTableActionState(editor, "insertTable")).toMatch(/cannot be nested/);
    expect(getTableActionState(editor, "mergeCells")).toBe("Select two or more adjacent cells to merge.");
    expect(getTableActionState(editor, "splitCell")).toBe("Only a merged cell can be split.");
    expect(getTableActionState(editor, "setCellAlignment", { align: "middle" as any })).toMatch(/Alignment must be/);
    expect(getTableActionState(editor, "setCellBackground", { color: "url(x)" })).toMatch(/Color must be/);
    editor.setEditable(false);
    expect(getTableActionState(editor, "addRowAfter")).toBe("The editor is read-only.");
    editor.destroy();
    expect(getTableActionState(editor, "addRowAfter")).toBe("The editor is not available.");
    expect(getTableActionState(null, "insertTable")).toBe("The editor is not available.");
  });

  it("reports the table, the cell and header state", () => {
    const editor = makeEditor();
    at(editor, "3");
    const state = getTableState(editor);
    expect(state).toMatchObject({
      enabled: true,
      inTable: true,
      cellSelection: false,
      rows: 3,
      columns: 2,
      row: 1,
      column: 1,
      headerRow: true,
      headerColumn: false,
      headerCell: false,
    });
    expect(state.actions.addRowAfter).toEqual({ enabled: true });
    expect(state.actions.goToNextCell).toEqual({ enabled: true });
    expect(state.actions.mergeCells.enabled).toBe(false);
    editor.commands.setTextSelection(posOf(editor, "after", 1));
    expect(getTableState(editor)).toMatchObject({ inTable: false, row: -1, rows: 0 });
    editor.destroy();
  });

  it("the store notifies only when the table state changes", () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(posOf(editor, "after", 1));
    const store = createTableStore(editor);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.getSnapshot();
    expect(before.inTable).toBe(false);
    at(editor, "Apples");
    expect(listener).toHaveBeenCalledTimes(1);
    const inside = store.getSnapshot();
    expect(inside.inTable).toBe(true);
    // Moving within the same cell does not change the state.
    editor.commands.setTextSelection(posOf(editor, "Apples", 3));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(inside);
    unsubscribe();
    store.destroy();
    editor.destroy();
  });

  it("runs every action", () => {
    const editor = makeEditor("<p>start</p>");
    editor.commands.setTextSelection(1);
    expect(runTableAction(editor, "insertTable", { rows: 2, cols: 2, withHeaderRow: false })).toBe(true);
    expect(grid(editor)).toEqual([["", ""], ["", ""]]);
    expect(runTableAction(editor, "insertTable")).toBe(false); // nested

    editor.commands.setContent(TABLE);
    at(editor, "Apples");
    expect(runTableAction(editor, "addRowBefore")).toBe(true);
    expect(grid(editor).length).toBe(4);
    expect(grid(editor)[1]).toEqual(["", ""]);
    at(editor, "Apples");
    expect(runTableAction(editor, "addRowAfter")).toBe(true);
    expect(grid(editor).map((r) => r[0])).toEqual(["th:Name", "", "Apples", "", "Pears"]);
    at(editor, "Apples");
    expect(runTableAction(editor, "addColumnBefore")).toBe(true);
    at(editor, "Apples");
    expect(runTableAction(editor, "addColumnAfter")).toBe(true);
    expect(grid(editor)[2]).toEqual(["", "Apples", "", "3"]);
    at(editor, "Apples");
    expect(runTableAction(editor, "deleteColumn")).toBe(true);
    expect(grid(editor)[2]).toEqual(["", "", "3"]);
    expect(grid(editor).flat()).not.toContain("Pears");
    at(editor, "5");
    expect(runTableAction(editor, "deleteRow")).toBe(true);
    expect(grid(editor).length).toBe(4);

    editor.commands.setContent(TABLE);
    at(editor, "Apples");
    expect(runTableAction(editor, "toggleHeaderColumn")).toBe(true);
    expect(grid(editor).map((r) => r[0])).toEqual(["th:Name", "th:Apples", "th:Pears"]);
    expect(getTableState(editor).headerColumn).toBe(true);
    expect(runTableAction(editor, "toggleHeaderRow")).toBe(true);
    expect(grid(editor)[0]).toEqual(["th:Name", "Qty"]);
    expect(getTableState(editor).headerRow).toBe(false);
    at(editor, "3");
    expect(runTableAction(editor, "toggleHeaderCell")).toBe(true);
    expect(grid(editor)[1][1]).toBe("th:3");
    expect(getTableState(editor).headerCell).toBe(true);

    at(editor, "3");
    expect(runTableAction(editor, "setCellAlignment", { align: "right" })).toBe(true);
    expect(runTableAction(editor, "setCellBackground", { color: "#fde68a" })).toBe(true);
    expect(getTableState(editor)).toMatchObject({ cellAlignment: "right", cellBackground: "#fde68a" });
    expect(editor.getHTML()).toMatch(/style="text-align: right; background-color: [^"]+" data-background-color="#fde68a"/);
    expect(runTableAction(editor, "setCellBackground", { color: null })).toBe(true);
    expect(getTableState(editor).cellBackground).toBeNull();

    // Navigation.
    at(editor, "Apples");
    expect(runTableAction(editor, "goToNextCell")).toBe(true);
    expect(getTableState(editor)).toMatchObject({ row: 1, column: 1 });
    expect(runTableAction(editor, "goToPreviousCell")).toBe(true);
    expect(getTableState(editor)).toMatchObject({ row: 1, column: 0 });
    at(editor, "Name");
    expect(getTableActionState(editor, "goToPreviousCell")).toBe("This is the first cell.");
    at(editor, "5");
    expect(getTableActionState(editor, "goToNextCell")).toBe("This is the last cell.");

    // Merge and split.
    const apples = posOf(editor, "Apples") - 2;
    const three = posOf(editor, "3") - 2;
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, apples, three)));
    expect(getTableState(editor).cellSelection).toBe(true);
    expect(getTableActionState(editor, "mergeCells")).toBe(true);
    expect(runTableAction(editor, "mergeCells")).toBe(true);
    expect(grid(editor)[1]).toEqual(["th:Apples3"]);
    expect(editor.getHTML()).toContain('colspan="2"');
    at(editor, "Apples");
    expect(runTableAction(editor, "splitCell")).toBe(true);
    expect(grid(editor)[1].length).toBe(2);

    at(editor, "Apples");
    expect(runTableAction(editor, "deleteTable")).toBe(true);
    expect(editor.getHTML()).toBe("<p>after</p>");
    editor.destroy();
  });

  it("shows the table bubble menu only in editable tables, and the default toolbar covers the actions", () => {
    const editor = makeEditor();
    at(editor, "Apples");
    expect(shouldShowTableBubbleMenu({ editor, state: editor.state })).toBe(true);
    editor.commands.setTextSelection(posOf(editor, "after", 1));
    expect(shouldShowTableBubbleMenu({ editor, state: editor.state })).toBe(false);
    at(editor, "Apples");
    editor.setEditable(false);
    expect(shouldShowTableBubbleMenu({ editor, state: editor.state })).toBe(false);
    const toolbarActions = new Set(DEFAULT_TABLE_TOOLBAR.map((item) => item.action));
    expect(TABLE_ACTIONS.filter((a) => !toolbarActions.has(a.action)).map((a) => a.action)).toEqual([
      "insertTable",
      "goToNextCell",
      "goToPreviousCell",
      "setCellBackground",
    ]);
    expect(new Set(DEFAULT_TABLE_TOOLBAR.map((item) => item.id)).size).toBe(DEFAULT_TABLE_TOOLBAR.length);
    editor.destroy();
  });

  it("deleting every row or column is refused with a reason", () => {
    const editor = makeEditor("<table><tr><td><p>only</p></td></tr></table>");
    at(editor, "only");
    expect(getTableActionState(editor, "deleteRow")).toMatch(/delete the table instead/);
    expect(getTableActionState(editor, "deleteColumn")).toMatch(/delete the table instead/);
    editor.destroy();
  });
});

describe("createTableCommands", () => {
  it("registers every table action with params, enablement and results", () => {
    const editor = makeEditor();
    const registry = new CommandRegistry();
    registry.register(createTableCommands(editor));
    const ids = registry.list({ includeHidden: true }).map((c) => c.id);
    expect(ids).toEqual(TABLE_ACTIONS.map((a) => `table.${a.action}`));

    editor.commands.setTextSelection(posOf(editor, "after", 1));
    const entry = registry.list().find((c) => c.id === "table.addRowAfter")!;
    expect(entry).toMatchObject({ enabled: false, disabledReason: "Place the cursor in a table first.", group: "Table" });
    expect(registry.execute("table.addRowAfter")).toMatchObject({ ok: false, code: "disabled" });
    expect(registry.execute("table.insertTable", { rows: 0 })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(registry.execute("table.insertTable", { rows: 2, cols: 4 })).toMatchObject({
      ok: true,
      result: { done: true, table: { rows: 2, columns: 4 } },
    });
    expect(registry.execute("table.insertTable")).toMatchObject({ ok: false, code: "disabled" });
    expect(registry.execute("table.setCellAlignment", { align: "center" })).toMatchObject({ ok: true });
    expect(registry.execute("table.setCellBackground", { color: "teal" })).toMatchObject({ ok: true });
    expect(getTableState(editor)).toMatchObject({ cellAlignment: "center", cellBackground: "teal" });
    expect(registry.execute("table.deleteTable")).toMatchObject({ ok: true, result: { table: null } });
    editor.destroy();
  });

  it("supports a prefix, group and scope", () => {
    const editor = makeEditor();
    const commands = createTableCommands(editor, { prefix: "doc.table.", group: "Tables", scope: "doc" });
    expect(commands[0]).toMatchObject({ id: "doc.table.insertTable", group: "Tables", scope: "doc" });
    editor.destroy();
  });
});

describe("edit_table agent tool", () => {
  it("inserts and edits tables, and reports disabled operations", async () => {
    const editor = makeEditor("<p>intro</p>");
    const registry = new ToolRegistry();
    registry.register(createRichTextToolProvider(editor, { id: "doc" }));
    const inserted = await registry.callTool("edit_table", { operation: "insertTable", rows: 2, cols: 2, at: 1 });
    expect(inserted.structuredContent).toMatchObject({ operation: "insertTable", table: { rows: 2, columns: 2 } });
    const added = await registry.callTool("edit_table", { operation: "addColumnAfter" });
    expect((added.structuredContent as any).table.columns).toBe(3);
    const outside = await registry.callTool("edit_table", { operation: "deleteRow", at: editor.state.doc.content.size - 1 });
    expect(outside.isError).toBe(true);
    expect((outside.structuredContent as any).error.message).toBe("Place the cursor in a table first.");
    const text = await registry.callTool("get_text", {});
    expect((text.structuredContent as any).content).toContain("\t\t");
    editor.setEditable(false);
    expect(registry.listTools().tools.map((t) => t.name)).toEqual(["get_text"]);
    editor.destroy();
  });
});

describe("table serialization", () => {
  it("plain text: cells are tab-separated and rows are lines", () => {
    const editor = makeEditor(
      '<p>Intro</p><table><tr><th><p>A</p></th><th><p>B</p></th><th><p>C</p></th></tr>' +
        '<tr><td colspan="2"><p>wide</p><p>two</p></td><td><p>c</p></td></tr></table><p>Outro</p>',
    );
    expect(getEditorText(editor)).toBe("Intro\nA\tB\tC\nwide two\t\tc\nOutro");
    editor.destroy();
  });

  it("markdown: GFM tables with alignment and escaped pipes", () => {
    const editor = makeEditor(
      '<table><tr><th><p>Name</p></th><th style="text-align: right"><p>Qty</p></th></tr>' +
        "<tr><td><p><strong>A|B</strong></p></td><td><p>3</p></td></tr><tr><td><p></p></td><td><p>5</p></td></tr></table>",
      { markdown: true },
    );
    expect(isGfmTable(editor.state.doc.firstChild!)).toBe(true);
    const markdown = getEditorMarkdown(editor);
    expect(markdown).toBe("| Name | Qty |\n| --- | ---: |\n| **A\\|B** | 3 |\n|  | 5 |");
    // And back: the same table.
    const again = makeEditor("", { markdown: true });
    again.commands.setContent(markdown);
    expect(grid(again)).toEqual([["th:Name", "th:Qty"], ["A|B", "3"], ["", "5"]]);
    expect(again.state.doc.firstChild!.child(0).child(1).attrs.align).toBe("right");
    editor.destroy();
    again.destroy();
  });

  it("markdown: tables GFM cannot express are written as HTML that parses back", () => {
    const html =
      '<table><tr><th colspan="2"><p>Group</p></th></tr><tr><td><p>a</p></td><td><p>b</p><p>c</p></td></tr></table>';
    const editor = makeEditor(html, { markdown: true });
    expect(isGfmTable(editor.state.doc.firstChild!)).toBe(false);
    const markdown = getEditorMarkdown(editor);
    expect(markdown).toMatch(/^<table/);
    const again = makeEditor("", { markdown: true });
    again.commands.setContent(markdown);
    expect(grid(again)).toEqual([["th:Group"], ["a", "bc"]]);
    expect(again.getHTML()).toContain('colspan="2"');
    // markdownToTipTapHtml keeps the table (colgroup/col are allowed through the sanitizer).
    const rendered = markdownToTipTapHtml(markdown);
    expect(rendered).toContain("<colgroup>");
    expect(rendered).not.toContain("&lt;col");
    const fromRendered = makeEditor(rendered);
    expect(grid(fromRendered)).toEqual([["th:Group"], ["a", "bc"]]);
    editor.destroy();
    again.destroy();
    fromRendered.destroy();
  });

  it("markdown import: GFM pipe tables become tables", () => {
    const html = markdownToTipTapHtml("| a | b |\n| :-- | :-: |\n| 1 | 2 |");
    const editor = makeEditor(html);
    expect(grid(editor)).toEqual([["th:a", "th:b"], ["1", "2"]]);
    expect(editor.state.doc.firstChild!.child(1).child(1).attrs.align).toBe("center");
    editor.destroy();
  });
});

describe("tables with tracked changes", () => {
  it("tracks typing and deleting inside a cell", () => {
    const editor = trackedEditor();
    editor.commands.setTextSelection(posOf(editor, "Apples", 6));
    editor.view.dispatch(editor.state.tr.insertText(" ripe"));
    const from = posOf(editor, "3");
    editor.view.dispatch(editor.state.tr.delete(from, from + 1));
    const changes = getTrackedChanges(editor);
    expect(changes.map((c) => [c.type, c.text])).toEqual([
      ["insertion", " ripe"],
      ["deletion", "3"],
    ]);
    expect(getEditorText(editor)).toContain("Apples ripe\t\n");
    editor.commands.rejectAllChanges();
    expect(grid(editor)[1]).toEqual(["Apples", "3"]);
    editor.destroy();
  });

  it("tracks inserted rows as whole blocks: reject removes them, accept keeps them", () => {
    const editor = trackedEditor();
    at(editor, "Apples");
    runTableAction(editor, "addRowAfter");
    expect(grid(editor).length).toBe(4);
    const [change] = getTrackedChanges(editor);
    expect(change).toMatchObject({ type: "block", description: "Inserted 2 table cells", block: { operation: "insert" } });
    editor.commands.rejectChange(change.id);
    expect(grid(editor)).toEqual([["th:Name", "th:Qty"], ["Apples", "3"], ["Pears", "5"]]);

    at(editor, "Apples");
    runTableAction(editor, "addRowBefore");
    editor.commands.acceptAllChanges();
    expect(grid(editor).length).toBe(4);
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("tracks deleted rows: the row stays until the deletion is accepted", () => {
    const editor = trackedEditor();
    at(editor, "Pears");
    runTableAction(editor, "deleteRow");
    expect(grid(editor).length).toBe(3);
    const [change] = getTrackedChanges(editor);
    expect(change).toMatchObject({ type: "block", block: { operation: "delete" }, author: { id: "alice" } });
    expect(getEditorText(editor)).toBe("Name\tQty\nApples\t3\nafter");
    expect(getEditorText(editor, { trackedChanges: "original" })).toContain("Pears\t5");
    editor.commands.rejectAllChanges();
    expect(grid(editor).length).toBe(3);
    expect(getTrackedChanges(editor)).toEqual([]);

    at(editor, "Pears");
    runTableAction(editor, "deleteRow");
    editor.commands.acceptAllChanges();
    expect(grid(editor)).toEqual([["th:Name", "th:Qty"], ["Apples", "3"]]);
    editor.destroy();
  });

  it("tracks inserted and deleted columns", () => {
    const editor = trackedEditor();
    at(editor, "Apples");
    runTableAction(editor, "addColumnAfter");
    expect(getTrackedChanges(editor)[0].description).toBe("Inserted 3 table cells");
    editor.commands.rejectAllChanges();
    expect(grid(editor)[1]).toEqual(["Apples", "3"]);

    at(editor, "3");
    runTableAction(editor, "deleteColumn");
    expect(grid(editor)[1]).toEqual(["Apples", "3"]);
    expect(getTrackedChanges(editor)[0]).toMatchObject({ block: { operation: "delete" } });
    editor.commands.acceptAllChanges();
    expect(grid(editor)).toEqual([["th:Name"], ["Apples"], ["Pears"]]);
    editor.destroy();
  });

  it("tracks inserted and deleted tables; deleting your own inserted table removes it", () => {
    const editor = trackedEditor("<p>intro</p>");
    editor.commands.setTextSelection(1);
    runTableAction(editor, "insertTable", { rows: 2, cols: 2 });
    expect(getTrackedChanges(editor)[0]).toMatchObject({ block: { operation: "insert" } });
    editor.commands.insertContent("typed");
    runTableAction(editor, "deleteTable");
    expect(editor.state.doc.childCount).toBe(1);
    expect(getTrackedChanges(editor)).toEqual([]);

    const other = trackedEditor(TABLE, bob);
    at(other, "Apples");
    runTableAction(other, "deleteTable");
    expect(grid(other).length).toBe(3);
    const change = getTrackedChanges(other)[0];
    expect(change).toMatchObject({ description: "Deleted 6 table cells", block: { operation: "delete" } });
    expect(resolveTrackedChanges(other.state.doc).textContent).toBe("after");
    other.commands.acceptChange(change.id);
    expect(other.getHTML()).toBe("<p>after</p>");
    editor.destroy();
    other.destroy();
  });

  it("a single undo removes a tracked row insertion", () => {
    const editor = trackedEditor();
    at(editor, "Apples");
    runTableAction(editor, "addRowAfter");
    editor.commands.undo();
    expect(grid(editor).length).toBe(3);
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("header toggles are tracked as block changes that rejecting reverts", () => {
    const editor = trackedEditor();
    at(editor, "Apples");
    runTableAction(editor, "toggleHeaderRow");
    expect(grid(editor)[0]).toEqual(["Name", "Qty"]);
    expect(getTrackedChanges(editor)[0].description).toMatch(/Table header/);
    editor.commands.rejectAllChanges();
    expect(grid(editor)[0]).toEqual(["th:Name", "th:Qty"]);
    editor.destroy();
  });

  it("refuses merging and splitting while tracking", () => {
    const editor = trackedEditor();
    at(editor, "Apples");
    expect(getTableActionState(editor, "mergeCells")).toMatch(/turn off Track Changes/);
    expect(getTableActionState(editor, "splitCell")).toMatch(/turn off Track Changes/);
    editor.destroy();
  });
});

describe("tables with comments and find & replace", () => {
  it("comments anchor to text in cells", () => {
    const editor = makeEditor(TABLE, { comments: true });
    const from = posOf(editor, "Apples");
    editor.commands.setTextSelection({ from, to: from + 6 });
    expect(editor.commands.addComment({ body: "fruit", id: "c1" })).toBe(true);
    expect(getCommentAnchors(editor.state.doc).get("c1")).toMatchObject({ from, to: from + 6 });
    editor.destroy();
  });

  it("find & replace searches and replaces cell text", () => {
    const editor = makeEditor(TABLE, { findReplace: true });
    editor.commands.setSearch({ query: "Pears", replacement: "Plums" });
    expect(getFindReplaceState(editor)!.matches.length).toBe(1);
    editor.commands.replaceAll();
    expect(grid(editor)[2]).toEqual(["Plums", "5"]);
    editor.destroy();
  });
});

describe("tables with the rich clipboard and paragraph styles", () => {
  it("a copied table pastes losslessly into another editor", () => {
    const source = makeEditor(
      '<table><tr><th colspan="2" style="text-align: center"><p>Group</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></table>',
    );
    const target = makeEditor("<p>x</p>");
    const payload = serializeRichClipboardPayload(source.state.doc.slice(0, source.state.doc.content.size), source.schema);
    const slice = parseRichClipboardPayload(payload, target.schema)!;
    expect(slice).not.toBeNull();
    target.view.dispatch(target.state.tr.replaceWith(0, target.state.doc.content.size, slice.content));
    expect(grid(target)).toEqual([["th:Group"], ["a", "b"]]);
    expect(target.state.doc.firstChild!.firstChild!.firstChild!.attrs).toMatchObject({ colspan: 2, align: "center" });
    source.destroy();
    target.destroy();
  });

  it("paragraph styles apply to paragraphs in cells", () => {
    const editor = makeEditor(TABLE, { paragraphStyles: true });
    at(editor, "Apples");
    expect(editor.commands.setParagraphStyle("Heading2")).toBe(true);
    expect(editor.getHTML()).toMatch(/<td colspan="1" rowspan="1"><h2[^>]*>Apples<\/h2><\/td>/);
    editor.destroy();
  });
});

describe("compareDocuments with tables", () => {
  const schema = getSchema(createRichTextPreset({ trackChanges: true }));
  const doc = (html: string) => {
    const editor = new Editor({ extensions: createRichTextPreset({ trackChanges: true }), content: html });
    const node = editor.state.doc;
    editor.destroy();
    return node;
  };

  it("diffs cell text and added/removed rows; accept-all and reject-all reproduce both versions", () => {
    const original = doc(TABLE);
    const revised = doc(
      "<table><tbody><tr><th><p>Name</p></th><th><p>Qty</p></th></tr>" +
        "<tr><td><p>Apples</p></td><td><p>4</p></td></tr>" +
        "<tr><td><p>Kiwis</p></td><td><p>9</p></td></tr>" +
        "<tr><td><p>Pears</p></td><td><p>5</p></td></tr></tbody></table><p>after</p>",
    );
    let id = 0;
    const result = compareDocuments(original, revised, { schema, author: alice, date: 1, generateId: () => `c${++id}` });
    expect(result.summary.insertions).toBeGreaterThan(0);
    const changes = getTrackedChanges(result.doc);
    expect(changes.some((c) => c.type === "insertion" && c.text === "4")).toBe(true);
    expect(changes.some((c) => c.type === "block" && c.block?.operation === "insert")).toBe(true);
    expect(resolveTrackedChanges(result.doc, "accepted").toJSON()).toEqual(revised.toJSON());
    expect(resolveTrackedChanges(result.doc, "original").textContent).toBe(original.textContent);
  });

  it("does not crash on tables that change shape (spans, columns, removed table)", () => {
    const original = doc(TABLE);
    const revisions = [
      '<table><tr><th colspan="2"><p>Name</p></th></tr><tr><td><p>Apples</p></td><td><p>3</p></td></tr></table><p>after</p>',
      "<table><tr><th><p>Name</p></th><th><p>Qty</p></th><th><p>Price</p></th></tr>" +
        "<tr><td><p>Apples</p></td><td><p>3</p></td><td><p>1.00</p></td></tr></table><p>after</p>",
      "<p>after</p>",
    ];
    for (const html of revisions) {
      const revised = doc(html);
      const result = compareDocuments(original, revised, { schema, author: alice, date: 1 });
      expect(() => result.doc.check()).not.toThrow();
      expect(resolveTrackedChanges(result.doc, "accepted").textContent).toBe(revised.textContent);
      expect(resolveTrackedChanges(result.doc, "original").textContent).toBe(original.textContent);
    }
  });
});
