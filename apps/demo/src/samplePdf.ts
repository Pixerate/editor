import { createImportAdapterRegistry, createPdfImportAdapter, type PdfJsLike, type PdfJsTextItem } from "@pixerate/editor";

/**
 * A generated stand-in for pdf.js that serves a two-page "PDF" laid out with
 * a title, two text columns, a bulleted list, a ruled table, running headers
 * and page numbers. It shows what structure detection recovers without
 * shipping a binary PDF or pdf.js in the demo.
 */
const item = (str: string, x: number, y: number, size = 10, font = "regular"): PdfJsTextItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width: str.length * size * 0.5,
  height: size,
  fontName: font,
});

const LOREM =
  "Layout analysis reads positioned text runs and rebuilds the document the way a reader sees it on the page, column by column and block by block.".split(
    " ",
  );

/** Lines of prose 12pt apart filling `width` points. */
function column(x: number, y: number, width: number, repeat: number, hyphenate = false): PdfJsTextItem[] {
  const words = Array.from({ length: repeat }, () => LOREM).flat();
  const perLine = Math.floor(width / 5);
  const out: PdfJsTextItem[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > perLine) {
      out.push(item(line, x, y));
      y -= 12;
      line = word;
    } else line = next;
  }
  if (hyphenate) {
    out.push(item(`${line} recog-`, x, y));
    out.push(item("nises hyphenated words.", x, y - 12));
  } else out.push(item(line.endsWith(".") ? line : `${line}.`, x, y));
  return out;
}

function page1(): PdfJsTextItem[] {
  return [
    item("Sample Report — generated fixture", 50, 780, 8),
    item("Structure from Layout", 50, 740, 22, "bold"),
    ...column(50, 705, 230, 2, true),
    ...column(320, 705, 230, 2),
    item("A full-width line under both columns ends the two-column band before the list.", 50, 585),
    item("Highlights", 50, 560, 14, "bold"),
    item("•", 50, 540),
    item("Reading order across columns", 62, 540),
    item("•", 50, 526),
    item("Headings from font sizes", 62, 526),
    item("•", 62, 512),
    item("Bold body-size headings too", 74, 512),
    item("•", 50, 498),
    item("Lists, tables, headers and footers", 62, 498),
    item("1", 300, 40, 8),
  ];
}

function page2(): PdfJsTextItem[] {
  const cells: PdfJsTextItem[] = [];
  const rows = [
    ["Structure", "Detected from", "Confidence"],
    ["Headings", "Size and weight", "High"],
    ["Tables", "Rules or aligned gaps", "Medium"],
    ["Lists", "Markers and indents", "Medium"],
  ];
  rows.forEach((row, r) =>
    row.forEach((text, c) => cells.push(item(text, 54 + c * 160, 686 - r * 20, 10, r === 0 ? "bold" : "regular"))),
  );
  return [
    item("Sample Report — generated fixture", 50, 780, 8),
    item("Detected structures", 50, 730, 14, "bold"),
    ...cells,
    item("2", 300, 40, 8),
  ];
}

/** Classic pdf.js operator list for page 2: one stroked rectangle per table cell. */
function tableRules() {
  const rects: number[] = [];
  const ops: number[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      rects.push(50 + c * 160, 680 - r * 20, 160, 20);
      ops.push(19);
    }
  }
  return { fnArray: [91, 20], argsArray: [[ops, rects, null], null] };
}

export function createSamplePdfjs(): PdfJsLike {
  const pages = [page1(), page2()];
  const fonts: Record<string, unknown> = { regular: { name: "Helvetica" }, bold: { name: "Helvetica-Bold", bold: true } };
  return {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        async getPage(n: number) {
          return {
            async getTextContent() {
              return { items: pages[n - 1] };
            },
            async getOperatorList() {
              return n === 2 ? tableRules() : { fnArray: [], argsArray: [] };
            },
            commonObjs: { has: (id: string) => id in fonts, get: (id: string) => fonts[id] },
          };
        },
      }),
    }),
  };
}

/** A registry whose only adapter is the PDF adapter over the generated fixture. */
export const samplePdfRegistry = (() => {
  const registry = createImportAdapterRegistry({ builtIns: false });
  registry.register(createPdfImportAdapter(createSamplePdfjs()));
  return registry;
})();

/** A tiny placeholder file: the fake pdf.js ignores the bytes. */
export const samplePdfFile = () => new File([new Uint8Array([37, 80, 68, 70])], "sample-report.pdf", { type: "application/pdf" });
