import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { Slice, type Node as ProsemirrorNode } from "@tiptap/pm/model";
import { CellSelection } from "@tiptap/pm/tables";
import {
  ALLOW_NESTED_TABLES_META,
  PIXERATE_DOCUMENT_MIME,
  createImportAdapterRegistry,
  createPdfImportAdapter,
  createRichTextPreset,
  getTrackedChanges,
  importFilesIntoEditor,
  insertImportedDocument,
  richClipboardPluginKey,
  serializeRichClipboardPayload,
  type FileLike,
  type PdfJsLike,
  type PdfJsTextItem,
  type RichTextPresetOptions,
} from "../src";
import { buildDocx, p, r } from "./helpers/zip-writer";

let win: any;
beforeAll(() => {
  const dom = new JSDOM();
  win = dom.window;
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).DOMParser = dom.window.DOMParser;
  (globalThis as any).ClipboardEvent = (dom.window as any).ClipboardEvent ?? class extends dom.window.Event {};
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

const TABLE =
  "<table><tbody><tr><th><p>Name</p></th><th><p>Qty</p></th></tr>" +
  "<tr><td><p>Apples</p></td><td><p>3</p></td></tr>" +
  "<tr><td><p>Pears</p></td><td><p>5</p></td></tr></tbody></table><p>after</p>";

const MIXED = "<p>pasted</p><table><tr><td><p>x</p></td><td><p>y</p></td></tr></table>";

function makeEditor(content = TABLE, options: RichTextPresetOptions = {}) {
  return new Editor({ extensions: createRichTextPreset(options), content });
}

function trackedEditor(content = TABLE) {
  let id = 0;
  return makeEditor(content, {
    trackChanges: { enabled: true, author: { id: "alice", name: "Alice" }, generateId: () => `ch-${++id}`, now: () => 42 },
  });
}

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

const at = (editor: Editor, text: string, offset = 1) => {
  editor.commands.setTextSelection(posOf(editor, text, offset));
  return editor;
};

/** Number of tables inside table cells. */
function nestedTables(doc: ProsemirrorNode): number {
  let count = 0;
  const walk = (node: ProsemirrorNode, inCell: boolean) => {
    node.forEach((child) => {
      if (child.type.name === "table" && inCell) count++;
      walk(child, inCell || child.type.name === "tableCell" || child.type.name === "tableHeader");
    });
  };
  walk(doc, false);
  return count;
}

/** Top-level blocks as `table[rows]` or their text. */
function outline(editor: Editor): string[] {
  const blocks: string[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name !== "table") return void blocks.push(node.textContent);
    const rows: string[] = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells.join("|"));
    });
    blocks.push(`table[${rows.join("/")}]`);
  });
  return blocks;
}

const cursorBlock = (editor: Editor) => editor.state.selection.$from.parent.textContent;

/** Dispatches a DOM paste event with `data` on the editor. */
function pasteEvent(editor: Editor, data: Record<string, string>) {
  const event = new win.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => data[type] ?? "", types: Object.keys(data), files: [] },
  });
  editor.view.dom.dispatchEvent(event);
}

const file = (name: string, bytes: Uint8Array | string, type = ""): FileLike => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return { name, type, size: data.length, arrayBuffer: async () => data.slice().buffer };
};

describe("pasting tables into table cells", () => {
  it("HTML with a table pasted into a cell goes after the table, not into the cell", () => {
    const editor = at(makeEditor(), "Apples", 6);
    editor.view.pasteHTML(MIXED);
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "pasted", "table[x|y]", "after"]);
    // The cursor ends after the pasted content.
    expect(cursorBlock(editor)).toBe("y");
    editor.destroy();
  });

  it("a selection inside the cell is replaced (deleted) by the paste", () => {
    const editor = makeEditor();
    editor.commands.setTextSelection({ from: posOf(editor, "Apples"), to: posOf(editor, "Apples", 6) });
    editor.view.pasteHTML(MIXED);
    expect(outline(editor)).toEqual(["table[Name|Qty/|3/Pears|5]", "pasted", "table[x|y]", "after"]);
    editor.destroy();
  });

  it("a pasted table on its own fills the cells from the cursor (prosemirror-tables)", () => {
    const editor = at(makeEditor(), "Apples");
    editor.view.pasteHTML("<table><tr><td><p>A1</p></td><td><p>B1</p></td></tr><tr><td><p>A2</p></td><td><p>B2</p></td></tr></table>");
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/A1|B1/A2|B2]", "after"]);
    editor.destroy();
  });

  it("a pasted table larger than the rest of the table grows it", () => {
    const editor = at(makeEditor(), "Pears");
    editor.view.pasteHTML("<table><tr><td><p>1</p></td><td><p>2</p></td><td><p>3</p></td></tr><tr><td><p>4</p></td><td><p>5</p></td><td><p>6</p></td></tr></table>");
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty|/Apples|3|/1|2|3/4|5|6]", "after"]);
    editor.destroy();
  });

  it("CellSelection paste still fills (and clips to) the selected cells", () => {
    const editor = makeEditor();
    const doc = editor.state.doc;
    const cellPos = (text: string) => doc.resolve(posOf(editor, text)).before(-1 + doc.resolve(posOf(editor, text)).depth);
    editor.view.dispatch(
      editor.state.tr.setSelection(CellSelection.create(doc, cellPos("Apples"), cellPos("3"))),
    );
    editor.view.pasteHTML("<table><tr><td><p>q</p></td><td><p>r</p></td><td><p>s</p></td></tr><tr><td><p>t</p></td></tr></table>");
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/q|r/Pears|5]", "after"]);
    editor.destroy();
  });

  it("pastes without tables are unchanged: text goes into the cell", () => {
    const editor = at(makeEditor(), "Apples", 6);
    editor.view.pasteHTML("<p>-more</p>");
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples-more|3/Pears|5]", "after"]);
    editor.destroy();
  });

  it("pastes outside tables can still contain tables", () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(posOf(editor, "after", 5));
    editor.view.pasteHTML(MIXED);
    // The open slice merges into the paragraph, as before.
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "afterpasted", "table[x|y]"]);
    editor.destroy();
  });

  it("markdown pasted into a cell does not nest its table", () => {
    const editor = at(makeEditor(TABLE, { markdown: true }), "Apples", 6);
    pasteEvent(editor, { "text/plain": "Intro\n\n| h | i |\n|---|---|\n| 1 | 2 |" });
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "Intro", "table[h|i/1|2]", "after"]);

    // A markdown table on its own fills the cells from the cursor.
    at(editor, "Pears");
    pasteEvent(editor, { "text/plain": "| p | q |\n|---|---|\n| 7 | 8 |" });
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)[0]).toBe("table[Name|Qty/Apples|3/p|q/7|8]");
    editor.destroy();
  });

  describe("rich clipboard", () => {
    const clipboardEvent = (data: Record<string, string>) =>
      ({ clipboardData: { getData: (type: string) => data[type] ?? "" }, preventDefault: vi.fn() }) as any;
    const pasteRich = (target: Editor, source: Editor) => {
      const slice = source.state.doc.slice(0, source.state.doc.content.size);
      const payload = serializeRichClipboardPayload(slice, source.schema);
      const plugin = target.state.plugins.find((pl) => (pl as any).key === (richClipboardPluginKey as any).key)!;
      return (plugin.props.handlePaste as any).call(
        plugin,
        target.view,
        clipboardEvent({ [PIXERATE_DOCUMENT_MIME]: payload, "text/html": "<p>html</p>" }),
        Slice.empty,
      );
    };

    it("content with a table goes after the table", () => {
      const source = makeEditor(MIXED, { richClipboard: true });
      const target = at(makeEditor(TABLE, { richClipboard: true }), "Apples", 6);
      expect(pasteRich(target, source)).toBe(true);
      expect(nestedTables(target.state.doc)).toBe(0);
      expect(outline(target)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "pasted", "table[x|y]", "after"]);
      source.destroy();
      target.destroy();
    });

    it("a copied table fills the cells from the cursor, keeping cell attributes", () => {
      const source = makeEditor(
        '<table><tr><td style="background-color: #fde68a"><p>c1</p></td><td><p>c2</p></td></tr></table>',
        { richClipboard: true },
      );
      // Copy just the table (no trailing paragraph).
      const table = source.state.doc.firstChild!;
      const payload = serializeRichClipboardPayload(source.state.doc.slice(0, table.nodeSize), source.schema);
      const target = at(makeEditor(TABLE, { richClipboard: true }), "Pears");
      const plugin = target.state.plugins.find((pl) => (pl as any).key === (richClipboardPluginKey as any).key)!;
      expect(
        (plugin.props.handlePaste as any).call(plugin, target.view, clipboardEvent({ [PIXERATE_DOCUMENT_MIME]: payload }), Slice.empty),
      ).toBe(true);
      expect(nestedTables(target.state.doc)).toBe(0);
      expect(outline(target)).toEqual(["table[Name|Qty/Apples|3/c1|c2]", "after"]);
      expect(target.state.doc.firstChild!.child(2).firstChild!.attrs.backgroundColor).toMatch(/#fde68a|rgb\(253, 230, 138\)/);
      source.destroy();
      target.destroy();
    });
  });
});

describe("importing files into table cells", () => {
  const item = (str: string, x: number, y: number, font = "regular"): PdfJsTextItem => ({
    str,
    transform: [10, 0, 0, 10, x, y],
    width: str.length * 5,
    height: 10,
    fontName: font,
  });
  /** One page: a paragraph, then a ruled 3×3 table with a bold header row (as in table-import.test.ts). */
  const pdfjs = (): PdfJsLike => {
    const rows = [
      ["Structure", "Detected from", "Confidence"],
      ["Headings", "Size and weight", "High"],
      ["Tables", "Rules or gaps", "Medium"],
    ];
    const items: PdfJsTextItem[] = [item("Before the table.", 50, 730)];
    rows.forEach((row, ri) => row.forEach((text, c) => items.push(item(text, 54 + c * 160, 686 - ri * 20, ri === 0 ? "bold" : "regular"))));
    const ops: number[] = [];
    const rects: number[] = [];
    for (let ri = 0; ri < 3; ri++) {
      for (let c = 0; c < 3; c++) {
        rects.push(50 + c * 160, 680 - ri * 20, 160, 20);
        ops.push(19);
      }
    }
    const fonts: Record<string, unknown> = { regular: { name: "Helvetica" }, bold: { name: "Helvetica-Bold", bold: true } };
    return {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          async getPage() {
            return {
              async getTextContent() {
                return { items };
              },
              async getOperatorList() {
                return { fnArray: [91, 20], argsArray: [[ops, rects, null], null] };
              },
              commonObjs: { has: (id: string) => id in fonts, get: (id: string) => fonts[id] },
            };
          },
        }),
      }),
    };
  };

  it("an HTML file with a table goes after the table; the cell keeps its text", async () => {
    const editor = at(makeEditor(), "Apples", 6);
    await importFilesIntoEditor(editor, [
      file("t.html", "<html><body><p>Imported</p><table><tr><td>m</td><td>n</td></tr></table></body></html>", "text/html"),
    ]);
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "Imported", "table[m|n]", "after"]);
    expect(cursorBlock(editor)).toBe("n");
    editor.destroy();
  });

  it("an HTML file that is only a table does not overwrite cells", async () => {
    const editor = at(makeEditor(), "Apples", 6);
    await importFilesIntoEditor(editor, [file("t.html", "<table><tr><td>m</td></tr></table>", "text/html")]);
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "table[m]", "after"]);
    editor.destroy();
  });

  it("a DOCX file with a table goes after the table", async () => {
    const bytes = await buildDocx({
      body:
        p(r("Doc intro")) +
        `<w:tbl><w:tblPr/><w:tblGrid/><w:tr><w:tc>${p(r("d1"))}</w:tc><w:tc>${p(r("d2"))}</w:tc></w:tr></w:tbl>`,
    });
    const editor = at(makeEditor(), "Pears", 5);
    await importFilesIntoEditor(editor, [file("doc.docx", bytes)]);
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "Doc intro", "table[d1|d2]", "after"]);
    editor.destroy();
  });

  it("a PDF file with a table goes after the table", async () => {
    const registry = createImportAdapterRegistry({ builtIns: false });
    registry.register(createPdfImportAdapter(pdfjs()));
    const editor = at(makeEditor(), "Apples", 6);
    await importFilesIntoEditor(editor, [file("t.pdf", new Uint8Array([37, 80, 68, 70]))], { registry });
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual([
      "table[Name|Qty/Apples|3/Pears|5]",
      "Before the table.",
      "table[Structure|Detected from|Confidence/Headings|Size and weight|High/Tables|Rules or gaps|Medium]",
      "after",
    ]);
    editor.destroy();
  });

  it("an `at` position in a cell is honoured the same way", () => {
    const editor = makeEditor();
    const end = insertImportedDocument(editor, { html: MIXED, text: "" } as any, { at: posOf(editor, "Pears") });
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "pasted", "table[x|y]", "after"]);
    expect(editor.state.doc.resolve(end).nodeBefore?.type.name).toBe("table");
    editor.destroy();
  });
});

describe("the nesting guard", () => {
  it("moves a table that insertContent puts into a cell after the table", () => {
    const editor = at(makeEditor(), "Apples", 6);
    editor.commands.insertContent("<table><tr><td><p>g</p></td></tr></table>");
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "table[g]", "after"]);
    // One undo step removes the moved table.
    editor.commands.undo();
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "after"]);
    editor.destroy();
  });

  it("moves several levels of nesting out, and a cell left empty gets a paragraph", () => {
    const editor = makeEditor();
    const cell = editor.state.doc.resolve(posOf(editor, "Apples")).before(-1 + editor.state.doc.resolve(posOf(editor, "Apples")).depth);
    const inner = editor.schema.nodeFromJSON({
      type: "table",
      content: [{ type: "tableRow", content: [{ type: "tableCell", content: [
        { type: "paragraph", content: [{ type: "text", text: "lvl2" }] },
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "lvl3" }] }] }] }] },
      ] }] }],
    });
    const node = editor.state.doc.nodeAt(cell)!;
    editor.view.dispatch(editor.state.tr.replaceWith(cell + 1, cell + node.nodeSize - 1, inner));
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/|3/Pears|5]", "table[lvl2]", "table[lvl3]", "after"]);
    editor.destroy();
  });

  it("documents that already contain nested tables load and stay as they are", () => {
    const nested =
      "<table><tr><td><p>outer</p><table><tr><td><p>inner</p></td></tr></table></td></tr></table><p>end</p>";
    const editor = makeEditor(nested);
    expect(nestedTables(editor.state.doc)).toBe(1);
    // Editing inside the nested table does not move it.
    at(editor, "inner", 5);
    editor.commands.insertContent("!");
    expect(nestedTables(editor.state.doc)).toBe(1);
    expect(editor.state.doc.textContent).toContain("inner!");
    // setContent keeps them too.
    editor.commands.setContent(nested);
    expect(nestedTables(editor.state.doc)).toBe(1);
    editor.destroy();
  });

  it("ALLOW_NESTED_TABLES_META opts a transaction out", () => {
    const editor = makeEditor();
    const pos = posOf(editor, "Apples", 6) + 1;
    const table = editor.schema.nodeFromJSON({
      type: "table",
      content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] }],
    });
    editor.view.dispatch(editor.state.tr.insert(pos, table).setMeta(ALLOW_NESTED_TABLES_META, true));
    expect(nestedTables(editor.state.doc)).toBe(1);
    editor.destroy();
  });
});

describe("tables pasted into cells with tracked changes", () => {
  it("content inserted after the table is tracked as an insertion", () => {
    const editor = at(trackedEditor(), "Apples", 6);
    editor.view.pasteHTML(MIXED);
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "pasted", "table[x|y]", "after"]);
    const changes = getTrackedChanges(editor);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.author.id === "alice")).toBe(true);
    // Rejecting removes the inserted table and text and leaves the original
    // table. The inserted paragraph stays empty: the tracker does not track
    // paragraph boundaries (GOTCHAS "Whole Paragraphs Have No Inline Representation").
    editor.commands.rejectAllChanges();
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "", "after"]);
    editor.destroy();
  });

  it("a table moved out of a cell by the guard keeps its tracked insertion", () => {
    const editor = at(trackedEditor(), "Apples", 6);
    editor.commands.insertContent("<table><tr><td><p>g</p></td></tr></table>");
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "table[g]", "after"]);
    expect(getTrackedChanges(editor).length).toBeGreaterThan(0);
    editor.commands.rejectAllChanges();
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "after"]);
    editor.destroy();
  });

  it("deleting an existing nested table while tracking keeps it in place for review", () => {
    const nested =
      "<table><tr><td><p>outer</p><table><tr><td><p>inner</p></td></tr></table></td></tr></table><p>end</p>";
    const editor = trackedEditor(nested);
    let tablePos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "table" && pos > 0) tablePos = pos;
      return tablePos < 0;
    });
    const table = editor.state.doc.nodeAt(tablePos)!;
    editor.view.dispatch(editor.state.tr.delete(tablePos, tablePos + table.nodeSize));
    // Track Changes puts the table back as a pending deletion; the guard leaves it nested.
    expect(nestedTables(editor.state.doc)).toBe(1);
    expect(getTrackedChanges(editor).some((c) => c.type === "block")).toBe(true);
    editor.commands.acceptAllChanges();
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(editor.state.doc.textContent).toBe("outerend");
    editor.destroy();
  });

  it("an imported file is tracked as an insertion", async () => {
    const editor = at(trackedEditor(), "Apples", 6);
    await importFilesIntoEditor(editor, [file("t.html", MIXED, "text/html")]);
    expect(nestedTables(editor.state.doc)).toBe(0);
    expect(getTrackedChanges(editor).length).toBeGreaterThan(0);
    editor.commands.rejectAllChanges();
    expect(outline(editor)).toEqual(["table[Name|Qty/Apples|3/Pears|5]", "", "after"]);
    editor.destroy();
  });
});
