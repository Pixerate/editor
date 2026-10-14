import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import {
  createImportAdapterRegistry,
  createPdfImportAdapter,
  createRichTextPreset,
  getEditorText,
  importFilesIntoEditor,
  type FileLike,
  type PdfJsLike,
  type PdfJsTextItem,
} from "../src";
import { buildDocx, p, r } from "./helpers/zip-writer";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).DOMParser = dom.window.DOMParser;
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

const file = (name: string, bytes: Uint8Array): FileLike => ({
  name,
  type: "",
  size: bytes.length,
  arrayBuffer: async () => bytes.slice().buffer,
});

/** Cells as `[type, text, colspan, rowspan]`, per row. */
function cells(editor: Editor) {
  const rows: [string, string, number, number][][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "tableRow") return true;
    const row: [string, string, number, number][] = [];
    node.forEach((cell) => row.push([cell.type.name === "tableHeader" ? "th" : "td", cell.textContent, cell.attrs.colspan, cell.attrs.rowspan]));
    rows.push(row);
    return false;
  });
  return rows;
}

const item = (str: string, x: number, y: number, font = "regular"): PdfJsTextItem => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width: str.length * 5,
  height: 10,
  fontName: font,
});

/** One page: a heading-less ruled 3×3 table with a bold header row (as in the demo's sample PDF). */
function rulesPdfjs(): PdfJsLike {
  const rows = [
    ["Structure", "Detected from", "Confidence"],
    ["Headings", "Size and weight", "High"],
    ["Tables", "Rules or gaps", "Medium"],
  ];
  const items: PdfJsTextItem[] = [item("Before the table.", 50, 730)];
  rows.forEach((row, ri) => row.forEach((text, c) => items.push(item(text, 54 + c * 160, 686 - ri * 20, ri === 0 ? "bold" : "regular"))));
  items.push(item("After the table.", 50, 600));
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
}

describe("import → editor: tables survive", () => {
  it("PDF tables become table nodes with a header row", async () => {
    const registry = createImportAdapterRegistry({ builtIns: false });
    registry.register(createPdfImportAdapter(rulesPdfjs()));
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p></p>" });
    const outcomes = await importFilesIntoEditor(editor, [file("report.pdf", new Uint8Array([37, 80, 68, 70]))], { registry });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result.html).toContain("<table>");
    expect(cells(editor)).toEqual([
      [["th", "Structure", 1, 1], ["th", "Detected from", 1, 1], ["th", "Confidence", 1, 1]],
      [["td", "Headings", 1, 1], ["td", "Size and weight", 1, 1], ["td", "High", 1, 1]],
      [["td", "Tables", 1, 1], ["td", "Rules or gaps", 1, 1], ["td", "Medium", 1, 1]],
    ]);
    expect(getEditorText(editor)).toContain("Structure\tDetected from\tConfidence\nHeadings\tSize and weight\tHigh");
    editor.destroy();
  });

  it("DOCX tables keep header rows, gridSpan and vMerge as colspan / rowspan", async () => {
    const tc = (content: string, tcPr = "") => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${content}</w:tc>`;
    const bytes = await buildDocx({
      body:
        p(r("before")) +
        `<w:tbl><w:tblPr/><w:tblGrid/>` +
        `<w:tr><w:trPr><w:tblHeader/></w:trPr>${tc(p(r("H1")))}${tc(p(r("H2")))}${tc(p(r("H3")))}</w:tr>` +
        `<w:tr>${tc(p(r("tall")), '<w:vMerge w:val="restart"/>')}${tc(p(r("wide")), '<w:gridSpan w:val="2"/>')}</w:tr>` +
        `<w:tr>${tc(p(""), "<w:vMerge/>")}${tc(p(r("x")))}${tc(p(r("y")))}</w:tr>` +
        `</w:tbl>` +
        p(r("after")),
    });
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p></p>" });
    await importFilesIntoEditor(editor, [file("doc.docx", bytes)]);
    expect(cells(editor)).toEqual([
      [["th", "H1", 1, 1], ["th", "H2", 1, 1], ["th", "H3", 1, 1]],
      [["td", "tall", 1, 2], ["td", "wide", 2, 1]],
      [["td", "x", 1, 1], ["td", "y", 1, 1]],
    ]);
    // The serialized document keeps the spans.
    expect(editor.getHTML()).toContain('<td colspan="1" rowspan="2"><p>tall</p></td><td colspan="2" rowspan="1"><p>wide</p></td>');
    editor.destroy();
  });

  it("with table: false, imported tables are flattened into paragraphs", async () => {
    const bytes = await buildDocx({
      body: `<w:tbl><w:tr><w:tc>${p(r("a"))}</w:tc><w:tc>${p(r("b"))}</w:tc></w:tr></w:tbl>`,
    });
    const editor = new Editor({ extensions: createRichTextPreset({ table: false }), content: "<p></p>" });
    await importFilesIntoEditor(editor, [file("doc.docx", bytes)]);
    expect(cells(editor)).toEqual([]);
    expect(editor.getHTML()).toContain("<p>a</p><p>b</p>");
    editor.destroy();
  });
});
