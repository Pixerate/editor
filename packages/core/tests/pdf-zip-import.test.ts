import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import {
  createImportAdapterRegistry,
  createPdfImportAdapter,
  createRichTextPreset,
  createZipImportAdapter,
  defaultImportRegistry,
  getImportAccept,
  importFilesIntoEditor,
  pdfTextItemsToParagraphs,
  sortZipEntryNames,
  zipEntryTitle,
  zipImportAdapter,
  type FileLike,
  type PdfJsLike,
  type PdfJsTextItem,
  type PdfDocumentImport,
  summarizeImportStructure,
  type ZipDocumentImport,
} from "../src";
import { buildDocx, buildZip, p, r } from "./helpers/zip-writer";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).DOMParser = dom.window.DOMParser;
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

const binaryFile = (name: string, bytes: Uint8Array, type = ""): FileLike => ({
  name,
  type,
  size: bytes.length,
  arrayBuffer: async () => bytes.slice().buffer,
});

/** A text item at baseline `y`, `x`, 10pt high, ~5pt per character. */
const item = (str: string, x: number, y: number, extra: Partial<PdfJsTextItem> = {}): PdfJsTextItem => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width: str.length * 5,
  height: 10,
  hasEOL: false,
  ...extra,
});

function fakePdfjs(pages: PdfJsTextItem[][]) {
  const destroy = vi.fn();
  const cleanup = vi.fn();
  const received: Uint8Array[] = [];
  const pdfjs: PdfJsLike = {
    getDocument(source) {
      received.push(source.data);
      return {
        promise: Promise.resolve({
          numPages: pages.length,
          destroy,
          async getPage(n: number) {
            return { cleanup, async getTextContent() { return { items: [{ type: "beginMarkedContent" }, ...pages[n - 1]] }; } };
          },
        }),
      };
    },
  };
  return { pdfjs, destroy, cleanup, received };
}

describe("PDF import with an injected pdf.js", () => {
  it("groups items into lines by baseline and lines into paragraphs by vertical gaps", () => {
    const paragraphs = pdfTextItemsToParagraphs([
      item("First", 50, 700),
      item("line", 80, 700), // horizontal gap → space
      item(" continues", 100, 700.5), // same baseline within tolerance
      item("second line of the", 50, 686),
      item("same paragraph", 50, 672),
      item("New paragraph after a gap", 50, 640),
      item("still in it", 50, 626),
    ]);
    expect(paragraphs).toEqual([
      "First line continues second line of the same paragraph",
      "New paragraph after a gap still in it",
    ]);
  });

  it("uses hasEOL line ends, blank EOL lines, hyphenation and column jumps", () => {
    const paragraphs = pdfTextItemsToParagraphs([
      item("Alpha ", 50, 700),
      item("beta", 80, 700, { hasEOL: true }),
      item("gamma", 50, 700, { hasEOL: true }), // same y but after EOL → new line, same paragraph
      item("", 0, 0, { hasEOL: true }), // blank line → paragraph break
      item("hyphen-", 50, 686),
      item("ated word", 50, 672),
      item("Column two", 300, 700), // jumps back up → new paragraph
    ]);
    expect(paragraphs).toEqual(["Alpha beta gamma", "hyphenated word", "Column two"]);
  });

  it("imports every page as escaped paragraphs and releases pdf.js resources", async () => {
    const { pdfjs, destroy, cleanup, received } = fakePdfjs([
      [item("Page one <b>", 50, 700), item("text", 50, 686)],
      [item("Page two", 50, 700)],
      [item("Page three", 50, 700)],
    ]);
    const registry = createImportAdapterRegistry();
    registry.register(createPdfImportAdapter(pdfjs, { maxPages: 2 }));
    const bytes = new TextEncoder().encode("%PDF-1.7 fake");
    const outcome = await registry.importFile<{ html: string; text: string }>(binaryFile("doc.pdf", bytes));
    expect(outcome.adapterId).toBe("pdf");
    expect(outcome.result.html).toBe("<p>Page one &lt;b&gt; text</p><p>Page two</p>");
    expect(outcome.result.text).toBe("Page one <b> text\nPage two");
    expect(received[0]).toEqual(bytes);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("is not registered by default", () => {
    expect(defaultImportRegistry.find({ fileName: "a.pdf" })).toBeUndefined();
    expect(getImportAccept("document")).not.toContain(".pdf");
  });

  it("destroys the document and reports adapter_failed when pdf.js throws", async () => {
    const destroy = vi.fn();
    const pdfjs: PdfJsLike = {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          destroy,
          getPage: async () => {
            throw new Error("bad xref");
          },
        }),
      }),
    };
    const registry = createImportAdapterRegistry({ builtIns: false });
    registry.register(createPdfImportAdapter(pdfjs));
    await expect(registry.importFile(binaryFile("x.pdf", new Uint8Array(1)))).rejects.toMatchObject({
      code: "adapter_failed",
      message: expect.stringContaining("bad xref"),
    });
    expect(destroy).toHaveBeenCalled();
  });
});

describe("PDF import with structure detection", () => {
  /** A two-page fake PDF: title, list and a ruled table, with running headers and page numbers. */
  function structuredPdfjs() {
    const t = (str: string, x: number, y: number, size = 10, fontName = "f1"): PdfJsTextItem => ({
      str,
      transform: [size, 0, 0, size, x, y],
      width: str.length * size * 0.5,
      height: size,
      fontName,
    });
    const header = t("Quarterly Report", 50, 780, 8);
    const pages: PdfJsTextItem[][] = [
      [
        header,
        t("Results <2026>", 50, 740, 20),
        t("The figures below were collected over the whole quarter and checked twice.", 50, 715),
        t("Highlights", 50, 690, 10, "f2"),
        t("•", 50, 675),
        t("Revenue grew", 60, 675),
        t("•", 50, 661),
        t("Costs fell", 60, 661),
        t("1", 300, 40, 8),
      ],
      [
        header,
        t("Region", 54, 686, 10, "f2"),
        t("Sales", 204, 686, 10, "f2"),
        t("North", 54, 666),
        t("120", 204, 666),
        t("South", 54, 646),
        t("95", 204, 646),
        t("2", 300, 40, 8),
      ],
    ];
    // Page 2's table grid as a classic operator list: a stroked rectangle per cell.
    const rects: number[] = [];
    for (const y of [680, 660, 640]) for (const x of [50, 200]) rects.push(x, y, 150, 20);
    const operatorLists = [
      { fnArray: [], argsArray: [] },
      { fnArray: [91, 20], argsArray: [[Array(6).fill(19), rects, null], null] },
    ];
    const fonts: Record<string, unknown> = { f1: { name: "Helvetica" }, f2: { name: "Helvetica-Bold", bold: true } };
    const destroy = vi.fn();
    const pdfjs: PdfJsLike = {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: pages.length,
          destroy,
          async getPage(n: number) {
            return {
              async getTextContent() {
                return { items: pages[n - 1], styles: {} };
              },
              async getOperatorList() {
                return operatorLists[n - 1];
              },
              commonObjs: { has: (id: string) => id in fonts, get: (id: string) => fonts[id] },
            };
          },
        }),
      }),
    };
    return { pdfjs, destroy };
  }

  it("imports headings, lists and ruled tables and reports them", async () => {
    const { pdfjs, destroy } = structuredPdfjs();
    const registry = createImportAdapterRegistry({ builtIns: false });
    registry.register(createPdfImportAdapter(pdfjs));
    const outcome = await registry.importFile<PdfDocumentImport>(binaryFile("report.pdf", new Uint8Array(4)));
    const { html, text, structure } = outcome.result;
    expect(html).toBe(
      "<h1>Results &lt;2026&gt;</h1>" +
        "<p>The figures below were collected over the whole quarter and checked twice.</p>" +
        "<h2>Highlights</h2>" +
        "<ul><li><p>Revenue grew</p></li><li><p>Costs fell</p></li></ul>" +
        "<table><tbody><tr><th><p>Region</p></th><th><p>Sales</p></th></tr>" +
        "<tr><td><p>North</p></td><td><p>120</p></td></tr>" +
        "<tr><td><p>South</p></td><td><p>95</p></td></tr></tbody></table>",
    );
    expect(text).toContain("Results <2026>");
    expect(text).not.toContain("Quarterly Report");
    expect(structure.mode).toBe("structured");
    expect(structure.counts).toEqual({ headings: 2, lists: 1, tables: 1, paragraphs: 1 });
    expect(structure.removed).toEqual({ headers: 2, footers: 0, pageNumbers: 2 });
    expect(structure.items.map((i) => i.type)).toEqual(["heading", "heading", "list", "table"]);
    expect(destroy).toHaveBeenCalledTimes(1);

    const summary = summarizeImportStructure([outcome]);
    expect(summary).toMatchObject({ files: 1, mode: "structured", headings: 2, lists: 1, tables: 1 });
    expect(summarizeImportStructure([])).toBeNull();
  });

  it("falls back to plain paragraphs per import through adapterOptions", async () => {
    const { pdfjs } = structuredPdfjs();
    const registry = createImportAdapterRegistry({ builtIns: false });
    registry.register(createPdfImportAdapter(pdfjs));
    const outcome = await registry.importFile<PdfDocumentImport>(binaryFile("report.pdf", new Uint8Array(4)), {
      adapterOptions: { pdf: { structure: false } },
    });
    expect(outcome.result.html).not.toMatch(/<h1|<ul|<table/);
    expect(outcome.result.html).toContain("<p>Quarterly Report</p>");
    expect(outcome.result.structure.mode).toBe("plain");
    expect(outcome.result.structure.counts.headings).toBe(0);
    // And at creation time.
    const plain = createImportAdapterRegistry({ builtIns: false });
    plain.register(createPdfImportAdapter(pdfjs, { structure: false }));
    const again = await plain.importFile<PdfDocumentImport>(binaryFile("report.pdf", new Uint8Array(4)));
    expect(again.result.html).toBe(outcome.result.html);
  });

  it("inserts the structured document into an editor", async () => {
    const { pdfjs } = structuredPdfjs();
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p></p>" });
    const registry = createImportAdapterRegistry({ builtIns: false });
    registry.register(createPdfImportAdapter(pdfjs));
    const outcomes = await importFilesIntoEditor(editor, [binaryFile("report.pdf", new Uint8Array(4))], { registry, at: 0 });
    expect(outcomes).toHaveLength(1);
    const html = editor.getHTML();
    expect(html).toContain("<h1");
    expect(html).toMatch(/<ul[ >]/);
    expect(html).toContain("Revenue grew");
    expect(summarizeImportStructure(outcomes)?.tables).toBe(1);
    // adapterOptions pass through importFilesIntoEditor too.
    const plain = await importFilesIntoEditor(editor, [binaryFile("report.pdf", new Uint8Array(4))], {
      registry,
      adapterOptions: { pdf: { structure: false } },
    });
    expect(summarizeImportStructure([...outcomes, ...plain])?.mode).toBe("mixed");
    editor.destroy();
  });
});

describe("Zipped export import", () => {
  it("orders index/README files first, then naturally by path", () => {
    expect(
      sortZipEntryNames(["b/page 10.md", "b/page 2.md", "a.md", "docs/README.md", "index.html", "Zeta.txt"]),
    ).toEqual(["index.html", "docs/README.md", "a.md", "b/page 2.md", "b/page 10.md", "Zeta.txt"]);
    expect(zipEntryTitle("Export/My Page 0123456789abcdef0123456789abcdef.md")).toBe("My Page");
    expect(zipEntryTitle("docs/getting_started.html")).toBe("getting started");
  });

  it("imports supported entries with headings and reports skipped ones", async () => {
    const docx = await buildDocx({ body: p(r("From Word", "<w:b/>")) });
    const bytes = await buildZip([
      { name: "export/", data: "", method: 0 },
      { name: "export/Notes 0123456789abcdef0123456789abcdef.md", data: "# Title\n\n*notes*" },
      { name: "export/index.html", data: "<h1>Home</h1><script>alert(1)</script>" },
      { name: "export/report.docx", data: docx, method: 0 },
      { name: "export/image.png", data: new Uint8Array([1, 2, 3]) },
      { name: "export/nested.zip", data: await buildZip([{ name: "x.md", data: "x" }]) },
      { name: "__MACOSX/export/._index.html", data: "junk" },
      { name: "export/.DS_Store", data: "junk" },
      { name: "export/plain.txt", data: "plain <text>" },
    ]);
    const registry = createImportAdapterRegistry();
    registry.register(zipImportAdapter);
    const outcome = await registry.importFile<ZipDocumentImport>(binaryFile("export.zip", bytes));
    const { html, text, files, skipped } = outcome.result;
    expect(files).toEqual([
      { name: "export/index.html", adapterId: "html" },
      { name: "export/Notes 0123456789abcdef0123456789abcdef.md", adapterId: "markdown" },
      { name: "export/plain.txt", adapterId: "text" },
      { name: "export/report.docx", adapterId: "docx" },
    ]);
    expect(skipped).toEqual([
      { name: "export/image.png", reason: "unsupported type" },
      { name: "export/nested.zip", reason: "nested archive" },
    ]);
    expect(html.replace(/\n/g, "")).toBe(
      "<h2>index</h2><h1>Home</h1>" +
        "<h2>Notes</h2><h1>Title</h1><p><em>notes</em></p>" +
        "<h2>plain</h2><p>plain &lt;text&gt;</p>" +
        "<h2>report</h2><p><strong>From Word</strong></p>",
    );
    expect(html).not.toContain("script");
    expect(text.split("\n")).toEqual(expect.arrayContaining(["index", "Home", "Notes", "plain <text>", "From Word"]));
  });

  it("supports headings: false, maxFiles and reports failing entries", async () => {
    const bytes = await buildZip([
      { name: "a.md", data: "A" },
      { name: "b.docx", data: "not a zip" },
      { name: "c.md", data: "C" },
      { name: "d.md", data: "D" },
    ]);
    const registry = createImportAdapterRegistry();
    registry.register(createZipImportAdapter({ headings: false, maxFiles: 2 }));
    const { result } = await registry.importFile<ZipDocumentImport>(binaryFile("a.zip", bytes));
    expect(result.html).toBe("<p>A</p><p>C</p>");
    expect(result.text).toBe("A\nC");
    expect(result.skipped.map((s) => s.name)).toEqual(["b.docx", "d.md"]);
    expect(result.skipped[0].reason).toMatch(/not a ZIP package/);
    expect(result.skipped[1].reason).toBe("file limit reached");
  });

  it("fails with invalid_file when nothing is importable, and enforces archive caps", async () => {
    const registry = createImportAdapterRegistry();
    registry.register(createZipImportAdapter({ zip: { maxTotalSize: 1000 } }));
    const images = await buildZip([{ name: "a.png", data: new Uint8Array(10) }]);
    await expect(registry.importFile(binaryFile("images.zip", images))).rejects.toMatchObject({
      code: "invalid_file",
      fileName: "images.zip",
    });
    const bomb = await buildZip([{ name: "big.md", data: "x".repeat(5000) }]);
    await expect(registry.importFile(binaryFile("bomb.zip", bomb))).rejects.toMatchObject({
      code: "adapter_failed",
      cause: expect.objectContaining({ code: "too_large" }),
    });
    const traversal = await buildZip([{ name: "../../etc/x.md", data: "x" }]);
    await expect(registry.importFile(binaryFile("evil.zip", traversal))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "unsafe_path" }),
    });
  });

  it("is opt-in: not in the default registry until registered", async () => {
    expect(defaultImportRegistry.find({ fileName: "a.zip" })).toBeUndefined();
    expect(getImportAccept("document")).not.toContain(".zip");
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p></p>" });
    const registry = createImportAdapterRegistry();
    registry.register(zipImportAdapter);
    const bytes = await buildZip([{ name: "README.md", data: "Hello **zip**" }]);
    const outcomes = await importFilesIntoEditor(editor, [binaryFile("docs.zip", bytes)], { registry, at: 0 });
    expect(outcomes).toHaveLength(1);
    expect(editor.getHTML()).toContain("<strong>zip</strong>");
    editor.destroy();
  });
});
