import type { PdfJsLike, PdfJsTextItem } from "../../src/import/pdf";

/** A text item at baseline `y`, ~0.5 em per character. */
export const pdfItem = (str: string, x: number, y: number, size = 10, fontName = "regular"): PdfJsTextItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width: str.length * size * 0.5,
  height: size,
  fontName,
});

/**
 * A fake pdf.js serving one page with a title, a short paragraph and an
 * unruled 3×3 table (bold header row). Used by the React and Svelte tests.
 */
export function fakeStructuredPdfjs(): PdfJsLike {
  const row = (y: number, cells: string[], font = "regular") => cells.map((text, c) => pdfItem(text, 50 + c * 120, y, 10, font));
  const items: PdfJsTextItem[] = [
    pdfItem("Imported title", 50, 760, 20),
    pdfItem("A short introduction to the data below, long enough to read as prose.", 50, 730),
    ...row(700, ["Name", "Qty", "Price"], "bold"),
    ...row(686, ["Pens", "4", "2.50"]),
    ...row(672, ["Ink", "2", "9.00"]),
  ];
  const fonts: Record<string, unknown> = { regular: { name: "Times-Roman" }, bold: { name: "Times-Bold", bold: true } };
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
              return { fnArray: [], argsArray: [] };
            },
            commonObjs: { has: (id: string) => id in fonts, get: (id: string) => fonts[id] },
          };
        },
      }),
    }),
  };
}
