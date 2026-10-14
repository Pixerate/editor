import { plainTextToParagraphHtml, sanitizeImportedHtml } from "../serializers/html";
import { htmlToPlainText } from "../serializers/plain-text";
import type { DocumentImport } from "./adapters";
import type { ImportAdapter } from "./registry";
import {
  analyzePdfLayout,
  pdfLayoutBlocksToHtml,
  type PdfLayoutOptions,
  type PdfLayoutPage,
  type PdfRuleLine,
  type PdfStructureReport,
  type PdfTextRun,
} from "./pdf-layout";

/**
 * PDF import through an injected pdf.js-compatible library. The editor ships
 * no PDF parser; consumers that already bundle `pdfjs-dist` register the
 * adapter themselves:
 *
 * ```ts
 * import * as pdfjs from "pdfjs-dist";
 * registerImportAdapter(createPdfImportAdapter(pdfjs));
 * ```
 *
 * By default the text runs (with positions and fonts) and the page's ruling
 * lines go through `analyzePdfLayout`, which recovers reading order across
 * columns, headings, lists and tables, and drops running headers, footers and
 * page numbers. `structure: false` (at creation, or per import through
 * `adapterOptions: { pdf: { structure: false } }`) falls back to plain
 * paragraphs: items grouped into lines by baseline and lines into paragraphs
 * by vertical gaps. Images, links and character styling are not imported.
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
  /** Font resource id, e.g. `g_d0_f1` (see `PdfJsTextContent.styles` and `page.commonObjs`). */
  fontName?: string;
}

export interface PdfJsTextContent {
  items: ReadonlyArray<PdfJsTextItem | { type: string }>;
  /** Per `fontName`: pdf.js reports the family (sometimes the real font name). */
  styles?: Record<string, { fontFamily?: string } | undefined>;
}

/** pdf.js operator list (`page.getOperatorList()`). */
export interface PdfJsOperatorList {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

export interface PdfJsPage {
  getTextContent(): Promise<PdfJsTextContent>;
  /** Used to read ruling lines (table borders); optional. */
  getOperatorList?(): Promise<PdfJsOperatorList>;
  /** Loaded fonts: `get(fontName)` returns `{ name, bold, black, italic }` once the operator list was read. */
  commonObjs?: { has?(id: string): boolean; get(id: string): unknown };
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
  /** pdf.js operator codes (`pdfjs.OPS`); the classic values are assumed when missing. */
  OPS?: Record<string, number>;
}

export interface PdfTextOptions {
  /**
   * A line gap larger than this multiple of the page's typical line spacing
   * starts a new paragraph (default `1.4`).
   */
  paragraphGap?: number;
}

/** Options that may also be passed per import as `adapterOptions[adapterId]`. */
export interface PdfImportCallOptions extends PdfTextOptions {
  /**
   * Detect headings, lists, tables, columns and running headers (default
   * `true`). `false` imports plain paragraphs, as before structure detection.
   */
  structure?: boolean;
  /** Fine-tuning for `analyzePdfLayout`. */
  layout?: PdfLayoutOptions;
  /** Read the operator list for table rules and font weights (default `true`). */
  rulingLines?: boolean;
}

export interface PdfImportOptions extends PdfImportCallOptions {
  /** Adapter id (default `"pdf"`). */
  id?: string;
  /** Import at most this many pages (default: all). */
  maxPages?: number;
  /** Extra `getDocument` parameters, e.g. `{ disableFontFace: true }`. */
  documentParams?: Record<string, unknown>;
}

/** What the PDF adapter returns: a `DocumentImport` with its structure report. */
export interface PdfDocumentImport extends DocumentImport {
  structure: PdfStructureReport;
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

/** Font details pdf.js exposes for a text item's `fontName`. */
export interface PdfFontInfo {
  name?: string;
  bold?: boolean;
  italic?: boolean;
}

/**
 * Converts pdf.js text items to layout runs. `font` resolves a `fontName` to
 * its real name and weight (the adapter reads `page.commonObjs` and
 * `textContent.styles`).
 */
export function pdfTextItemsToRuns(
  items: ReadonlyArray<PdfJsTextItem | { type: string }>,
  font?: (fontName: string) => PdfFontInfo | undefined,
): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  const cache = new Map<string, PdfFontInfo | undefined>();
  for (const item of items) {
    if (!isTextItem(item) || !item.str.trim()) continue;
    const t = item.transform ?? [];
    const fontSize = Math.hypot(t[2] ?? 0, t[3] ?? 0) || item.height || 10;
    let info: PdfFontInfo | undefined;
    if (item.fontName && font) {
      if (!cache.has(item.fontName)) cache.set(item.fontName, font(item.fontName));
      info = cache.get(item.fontName);
    }
    runs.push({
      text: item.str,
      x: t[4] ?? 0,
      y: t[5] ?? 0,
      width: item.width,
      fontSize,
      fontName: info?.name ?? item.fontName,
      bold: info?.bold,
      italic: info?.italic,
    });
  }
  return runs;
}

/** pdf.js operator codes (stable since pdf.js 2). */
const DEFAULT_OPS: Record<string, number> = {
  save: 10,
  restore: 11,
  transform: 12,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  constructPath: 91,
};
/** Path codes inside a pdf.js 5 `constructPath` buffer. */
const DRAW_OPS = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
const MAX_PAGE_RULES = 5000;

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, c: Matrix): Matrix => [
  m[0] * c[0] + m[1] * c[2],
  m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2],
  m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4],
  m[4] * c[1] + m[5] * c[3] + c[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * Reads straight, axis-aligned strokes and thin filled bars (table rules)
 * from a pdf.js operator list, in PDF user space. Understands the classic
 * `constructPath` arguments (`[ops, args, minMax]`) and the pdf.js 5 form
 * (`[paintOp, [pathData], minMax]`); clipping paths and curves are ignored.
 */
export function pdfOperatorListToRules(list: PdfJsOperatorList, opsTable?: Record<string, number>): PdfRuleLine[] {
  const OPS = { ...DEFAULT_OPS, ...(opsTable ?? {}) };
  const stroking = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const filling = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const rules: PdfRuleLine[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  /** Path pieces waiting for a paint operator. */
  let lines: [number, number, number, number][] = [];
  let rects: [number, number, number, number][] = [];
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : NaN);

  const addLine = (x1: number, y1: number, x2: number, y2: number) => {
    const [a, b] = apply(ctm, x1, y1);
    const [c, d] = apply(ctm, x2, y2);
    lines.push([a, b, c, d]);
  };
  const addRect = (x: number, y: number, w: number, h: number) => {
    const corners = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  };
  const paint = (op: number) => {
    const stroke = stroking.has(op);
    const fill = filling.has(op);
    if (stroke) {
      for (const [x1, y1, x2, y2] of lines) rules.push({ x1, y1, x2, y2 });
      for (const [x0, y0, x1, y1] of rects) {
        rules.push({ x1: x0, y1: y0, x2: x1, y2: y0 }, { x1: x0, y1: y1, x2: x1, y2: y1 });
        rules.push({ x1: x0, y1: y0, x2: x0, y2: y1 }, { x1: x1, y1: y0, x2: x1, y2: y1 });
      }
    } else if (fill) {
      // Thin filled bars are drawn rules; larger fills are shading.
      for (const [x0, y0, x1, y1] of rects) {
        if (y1 - y0 <= 2 && x1 - x0 > 2) rules.push({ x1: x0, y1: (y0 + y1) / 2, x2: x1, y2: (y0 + y1) / 2 });
        else if (x1 - x0 <= 2 && y1 - y0 > 2) rules.push({ x1: (x0 + x1) / 2, y1: y0, x2: (x0 + x1) / 2, y2: y1 });
      }
    }
    lines = [];
    rects = [];
  };
  const readPath = (subOps: ArrayLike<unknown>, subArgs: ArrayLike<unknown>) => {
    let k = 0;
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < subOps.length; i++) {
      const op = subOps[i];
      if (op === OPS.moveTo) {
        cx = sx = num(subArgs[k++]);
        cy = sy = num(subArgs[k++]);
      } else if (op === OPS.lineTo) {
        const x = num(subArgs[k++]);
        const y = num(subArgs[k++]);
        addLine(cx, cy, x, y);
        cx = x;
        cy = y;
      } else if (op === OPS.rectangle) {
        addRect(num(subArgs[k++]), num(subArgs[k++]), num(subArgs[k++]), num(subArgs[k++]));
      } else if (op === OPS.curveTo) {
        k += 4;
        cx = num(subArgs[k++]);
        cy = num(subArgs[k++]);
      } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
        k += 2;
        cx = num(subArgs[k++]);
        cy = num(subArgs[k++]);
      } else if (op === OPS.closePath) {
        if (cx !== sx || cy !== sy) addLine(cx, cy, sx, sy);
        cx = sx;
        cy = sy;
      }
    }
  };
  const readDrawBuffer = (data: ArrayLike<number>) => {
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < data.length; ) {
      const code = data[k++];
      if (code === DRAW_OPS.moveTo) {
        cx = sx = data[k++];
        cy = sy = data[k++];
      } else if (code === DRAW_OPS.lineTo) {
        const x = data[k++];
        const y = data[k++];
        addLine(cx, cy, x, y);
        cx = x;
        cy = y;
      } else if (code === DRAW_OPS.curveTo) {
        k += 4;
        cx = data[k++];
        cy = data[k++];
      } else if (code === DRAW_OPS.quadraticCurveTo) {
        k += 2;
        cx = data[k++];
        cy = data[k++];
      } else if (code === DRAW_OPS.closePath) {
        if (cx !== sx || cy !== sy) addLine(cx, cy, sx, sy);
        cx = sx;
        cy = sy;
      } else break;
    }
  };

  for (let i = 0; i < list.fnArray.length && rules.length < MAX_PAGE_RULES; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] as ArrayLike<unknown> | null | undefined;
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? IDENTITY;
    else if (fn === OPS.transform && args && args.length >= 6) {
      const m = Array.from({ length: 6 }, (_, k) => num(args[k])) as Matrix;
      if (m.every(Number.isFinite)) ctm = multiply(m, ctm);
    } else if (fn === OPS.constructPath && args) {
      const first = args[0];
      if (typeof first === "number") {
        // pdf.js 5: the paint operator comes with the path.
        const buffers = args[1] as ArrayLike<ArrayLike<number> | null> | undefined;
        const data = buffers?.[0];
        if (data && typeof data.length === "number") readDrawBuffer(data);
        paint(first);
      } else if (first && typeof (first as ArrayLike<unknown>).length === "number") {
        readPath(first as ArrayLike<unknown>, (args[1] ?? []) as ArrayLike<unknown>);
      }
    } else if (stroking.has(fn) || filling.has(fn)) paint(fn);
    else if (fn === OPS.endPath) {
      lines = [];
      rects = [];
    }
  }
  return rules.filter((rule) => [rule.x1, rule.y1, rule.x2, rule.y2].every(Number.isFinite));
}

function fontResolver(page: PdfJsPage, content: PdfJsTextContent) {
  return (fontName: string): PdfFontInfo | undefined => {
    let info: PdfFontInfo | undefined;
    try {
      if (page.commonObjs && (!page.commonObjs.has || page.commonObjs.has(fontName))) {
        const font = page.commonObjs.get(fontName) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean } | null;
        if (font && typeof font === "object") {
          info = {
            name: typeof font.name === "string" ? font.name : undefined,
            bold: font.bold || font.black ? true : undefined,
            italic: font.italic ? true : undefined,
          };
        }
      }
    } catch {
      // Not loaded yet: fall back to the family name below.
    }
    const family = content.styles?.[fontName]?.fontFamily;
    if (!info?.name && family) info = { ...info, name: family };
    return info;
  };
}

function plainReport(paragraphs: number, pages: number): PdfStructureReport {
  return {
    mode: "plain",
    pages,
    counts: { headings: 0, lists: 0, tables: 0, paragraphs },
    multiColumnPages: 0,
    confidence: 1,
    items: [],
    removed: { headers: 0, footers: 0, pageNumbers: 0 },
    dehyphenated: 0,
  };
}

/** Creates a PDF `document` adapter backed by an injected pdf.js-compatible library. */
export function createPdfImportAdapter(pdfjs: PdfJsLike, options: PdfImportOptions = {}): ImportAdapter<PdfDocumentImport> {
  return {
    id: options.id ?? "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    extensions: [".pdf"],
    target: "document",
    async import(_input, context): Promise<PdfDocumentImport> {
      const call = (context.options && typeof context.options === "object" ? context.options : {}) as PdfImportCallOptions;
      const opts: PdfImportOptions = { ...options, ...call, layout: { ...options.layout, ...call.layout } };
      const structured = opts.structure !== false;
      // pdf.js may transfer (detach) the buffer it receives, so pass a copy.
      const data = new Uint8Array((await context.readArrayBuffer()).slice(0));
      const doc = await pdfjs.getDocument({ ...opts.documentParams, data }).promise;
      const paragraphs: string[] = [];
      const layoutPages: PdfLayoutPage[] = [];
      let pages = 0;
      try {
        pages = Math.min(doc.numPages, opts.maxPages ?? Infinity);
        for (let n = 1; n <= pages; n++) {
          const page = await doc.getPage(n);
          if (!structured) {
            const content = await page.getTextContent();
            paragraphs.push(...pdfTextItemsToParagraphs(content.items, opts));
          } else {
            let rules: PdfRuleLine[] = [];
            if (opts.rulingLines !== false && typeof page.getOperatorList === "function") {
              try {
                rules = pdfOperatorListToRules(await page.getOperatorList(), pdfjs.OPS);
              } catch {
                rules = [];
              }
            }
            const content = await page.getTextContent();
            layoutPages.push({ runs: pdfTextItemsToRuns(content.items, fontResolver(page, content)), rules });
          }
          page.cleanup?.();
        }
      } finally {
        await doc.destroy?.();
      }
      if (!structured) {
        const text = paragraphs.join("\n");
        return { html: plainTextToParagraphHtml(text), text, structure: plainReport(paragraphs.length, pages) };
      }
      const layout: PdfLayoutOptions = { ...opts.layout };
      if (layout.paragraphGap === undefined && opts.paragraphGap !== undefined) layout.paragraphGap = opts.paragraphGap;
      const { blocks, report } = analyzePdfLayout(layoutPages, layout);
      const html = sanitizeImportedHtml(pdfLayoutBlocksToHtml(blocks));
      return { html, text: htmlToPlainText(html), structure: report };
    },
  };
}
