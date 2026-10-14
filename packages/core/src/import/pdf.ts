import { plainTextToParagraphHtml } from "../serializers/html";
import type { DocumentImportAdapter } from "./adapters";

/**
 * PDF text import through an injected pdf.js-compatible library. The editor
 * ships no PDF parser; consumers that already bundle `pdfjs-dist` register
 * the adapter themselves:
 *
 * ```ts
 * import * as pdfjs from "pdfjs-dist";
 * registerImportAdapter(createPdfImportAdapter(pdfjs));
 * ```
 *
 * Text items are grouped into lines by baseline (`transform[5]`) and lines
 * into paragraphs by vertical gaps larger than the page's typical line
 * spacing (or blank `hasEOL` lines). Only text is imported: no images,
 * tables, links or styling.
 */

/** A text item from `page.getTextContent()` (marked-content items have no `str`). */
export interface PdfJsTextItem {
  str: string;
  /** `[a, b, c, d, x, y]` transform; `x` / `y` are the baseline origin. */
  transform?: readonly number[];
  width?: number;
  height?: number;
  /** pdf.js sets this when a line break follows the item. */
  hasEOL?: boolean;
}

export interface PdfJsTextContent {
  items: ReadonlyArray<PdfJsTextItem | { type: string }>;
}

export interface PdfJsPage {
  getTextContent(): Promise<PdfJsTextContent>;
  cleanup?(): unknown;
}

export interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  destroy?(): unknown;
}

/** The subset of the pdf.js API the adapter uses (`pdfjs-dist` satisfies it). */
export interface PdfJsLike {
  getDocument(source: { data: Uint8Array; [option: string]: unknown }): { promise: Promise<PdfJsDocument> };
}

export interface PdfTextOptions {
  /**
   * A line gap larger than this multiple of the page's typical line spacing
   * starts a new paragraph (default `1.4`).
   */
  paragraphGap?: number;
}

export interface PdfImportOptions extends PdfTextOptions {
  /** Adapter id (default `"pdf"`). */
  id?: string;
  /** Import at most this many pages (default: all). */
  maxPages?: number;
  /** Extra `getDocument` parameters, e.g. `{ disableFontFace: true }`. */
  documentParams?: Record<string, unknown>;
}

interface Line {
  text: string;
  y: number;
  height: number;
  /** A blank line (empty `hasEOL` item) follows this one. */
  blankAfter: boolean;
}

const isTextItem = (item: PdfJsTextItem | { type: string }): item is PdfJsTextItem =>
  typeof (item as PdfJsTextItem).str === "string";

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function groupLines(items: ReadonlyArray<PdfJsTextItem | { type: string }>): Line[] {
  const lines: Line[] = [];
  let current: (Line & { endX?: number }) | null = null;
  let breakNext = false;
  for (const item of items) {
    if (!isTextItem(item)) continue;
    const x = item.transform?.[4] ?? 0;
    const y: number = item.transform?.[5] ?? (current?.y ?? 0);
    const height: number = item.height || Math.abs(item.transform?.[3] ?? 0) || current?.height || 10;
    const tolerance = Math.max(1, height * 0.5);
    if (!item.str) {
      // Empty items mark line ends; two in a row mean a blank line.
      if (item.hasEOL) {
        if (breakNext && current) current.blankAfter = true;
        breakNext = true;
      }
      continue;
    }
    if (!current || breakNext || Math.abs(y - current.y) > tolerance) {
      current = { text: "", y, height, blankAfter: false };
      lines.push(current);
    } else if (current.endX !== undefined && x - current.endX > height * 0.15) {
      // A horizontal gap without an explicit space item.
      if (!/\s$/.test(current.text) && !/^\s/.test(item.str)) current.text += " ";
    }
    current.text += item.str;
    current.height = Math.max(current.height, height);
    current.endX = item.width !== undefined ? x + item.width : undefined;
    breakNext = !!item.hasEOL;
  }
  return lines;
}

/**
 * Groups one page's pdf.js text items into paragraphs. Exposed for custom
 * adapters and tests.
 */
export function pdfTextItemsToParagraphs(
  items: ReadonlyArray<PdfJsTextItem | { type: string }>,
  options: PdfTextOptions = {},
): string[] {
  const lines = groupLines(items).filter((line) => line.text.trim() || line.blankAfter);
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  const typical = median(gaps);
  const factor = options.paragraphGap ?? 1.4;

  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
    current = [];
  };
  lines.forEach((line, i) => {
    if (i > 0) {
      const prev = lines[i - 1];
      const gap = prev.y - line.y;
      const bigGap = typical > 0 ? gap > typical * factor : gap > prev.height * 1.8;
      // A line above the previous one (gap < 0) starts a new column or block.
      if (prev.blankAfter || bigGap || gap < -prev.height * 0.5) flush();
    }
    const text = line.text.trim();
    if (!text) return;
    if (current.length && /\w-$/.test(current[current.length - 1]) && /^[a-z]/.test(text)) {
      // Re-join words hyphenated across lines.
      current[current.length - 1] = current[current.length - 1].slice(0, -1) + text;
    } else {
      current.push(text);
    }
  });
  flush();
  return paragraphs;
}

/** Creates a PDF `document` adapter backed by an injected pdf.js-compatible library. */
export function createPdfImportAdapter(pdfjs: PdfJsLike, options: PdfImportOptions = {}): DocumentImportAdapter {
  return {
    id: options.id ?? "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    extensions: [".pdf"],
    target: "document",
    async import(_input, context) {
      // pdf.js may transfer (detach) the buffer it receives, so pass a copy.
      const data = new Uint8Array((await context.readArrayBuffer()).slice(0));
      const doc = await pdfjs.getDocument({ ...options.documentParams, data }).promise;
      const paragraphs: string[] = [];
      try {
        const pages = Math.min(doc.numPages, options.maxPages ?? Infinity);
        for (let n = 1; n <= pages; n++) {
          const page = await doc.getPage(n);
          const content = await page.getTextContent();
          paragraphs.push(...pdfTextItemsToParagraphs(content.items, options));
          page.cleanup?.();
        }
      } finally {
        await doc.destroy?.();
      }
      const text = paragraphs.join("\n");
      return { html: plainTextToParagraphHtml(text), text };
    },
  };
}
