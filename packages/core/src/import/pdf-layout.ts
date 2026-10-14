/**
 * Layout analysis for PDF import: turns positioned text runs into headings,
 * paragraphs, lists and tables in reading order.
 *
 * Portions ported from pdfcraft/crates/export/src/lib.rs (`body_size`, `level`,
 * `tables`: body size by character count, heading levels relative to it,
 * column grids from aligned cell edges with spanning header and totals rows,
 * the 63-column cap) and pdfcraft/crates/edit/src/text_regions.rs
 * (`group_layout`: joining runs on a baseline, rows into blocks, hyphens at line
 * ends) (MIT OR Apache-2.0, © ArtCraft Team and contributors).
 * See THIRD_PARTY_NOTICES.md.
 *
 * The module is pure: it never touches pdf.js or the DOM, so custom
 * extractors (another PDF library, OCR output) can feed it runs directly.
 *
 * Coordinates are PDF user space: points, `y` grows upwards and is the
 * baseline of the run. Every step sorts or sweeps, so the analysis stays near
 * O(N log N) in the number of runs.
 */
import { escapeHtml } from "../serializers/plain-text";

/** A positioned piece of text, e.g. a pdf.js text item. */
export interface PdfTextRun {
  text: string;
  /** Left edge (points). */
  x: number;
  /** Baseline, y up (points). */
  y: number;
  /** Advance width (points). Estimated from the text length when missing. */
  width?: number;
  /** Font size (points). Falls back to `height`, then 10. */
  fontSize?: number;
  height?: number;
  /** Font name; `Bold` / `Italic` / `Oblique` in it set the style when `bold` / `italic` are absent. */
  fontName?: string;
  bold?: boolean;
  italic?: boolean;
}

/** A stroked line or thin filled rectangle on a page (table rules). */
export interface PdfRuleLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PdfLayoutPage {
  runs: readonly PdfTextRun[];
  /** Ruling lines, when the extractor can read the page's vector graphics. */
  rules?: readonly PdfRuleLine[];
}

export interface PdfLayoutOptions {
  /**
   * A baseline gap larger than this multiple of the typical line pitch starts
   * a new paragraph (default `1.4`).
   */
  paragraphGap?: number;
  /** Remove running headers, footers and page numbers repeated across pages (default `true`). */
  removeHeadersAndFooters?: boolean;
  /** Read multi-column pages column by column (default `true`). */
  detectColumns?: boolean;
  /** Detect headings from font size and weight (default `true`). */
  detectHeadings?: boolean;
  /** Detect bulleted and numbered lists (default `true`). */
  detectLists?: boolean;
  /** Detect tables from ruling lines and aligned columns (default `true`). */
  detectTables?: boolean;
  /** Re-join words hyphenated across line ends (default `true`). */
  dehyphenate?: boolean;
}

export interface PdfTableCell {
  text: string;
  colSpan: number;
  rowSpan: number;
  header: boolean;
}

export type PdfLayoutBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; page: number; confidence: number }
  | { type: "paragraph"; text: string; page: number }
  | {
      type: "list";
      page: number;
      confidence: number;
      /** Items in order; `depth` 0 is the outermost level and grows by at most one per item. */
      items: { text: string; depth: number; ordered: boolean; start?: number }[];
    }
  | {
      type: "table";
      page: number;
      confidence: number;
      /** `true` when the grid came from ruling lines. */
      ruled: boolean;
      /** Rows of cells; cells covered by a span are left out. */
      rows: PdfTableCell[][];
      columns: number;
      headerRows: number;
    };

/** One detected structure, for import reports. */
export interface ImportStructureItem {
  type: "heading" | "list" | "table" | "columns";
  /** 1-based page. */
  page: number;
  /** 0–1. */
  confidence: number;
  /** Short human-readable description, e.g. `H2 "Results"` or `3×4 table`. */
  detail: string;
}

/**
 * What a structure-aware importer recognised. Adapters attach it to
 * `DocumentImport.structure`; `summarizeImportStructure` aggregates it.
 */
export interface ImportStructureReport {
  /** `"plain"` when structure detection was off (paragraphs only). */
  mode: "structured" | "plain";
  counts: { headings: number; lists: number; tables: number; paragraphs: number };
  /** Pages read as several columns. */
  multiColumnPages: number;
  /** Mean confidence of the detected structures (1 when nothing was detected). */
  confidence: number;
  items: ImportStructureItem[];
}

export interface PdfStructureReport extends ImportStructureReport {
  pages: number;
  removed: { headers: number; footers: number; pageNumbers: number };
  /** Words re-joined across a line-end hyphen. */
  dehyphenated: number;
}

export interface PdfLayoutResult {
  blocks: PdfLayoutBlock[];
  report: PdfStructureReport;
}

// ---------------------------------------------------------------------------
// Internal shapes

interface Frag {
  text: string;
  x0: number;
  x1: number;
  /** Baseline. */
  y: number;
  top: number;
  bottom: number;
  size: number;
  bold: boolean;
  italic: boolean;
  words: number;
  /** A ruled table placed in the flow as one atom. */
  table?: PdfLayoutBlock & { type: "table" };
}

type Segment = { kind: "flow"; items: Frag[] } | { kind: "grid"; items: Frag[] };

/** Most grid columns a table may have (Word cannot open 64). */
const MAX_COLS = 63;
const MAX_TABLE_ROWS = 2000;
/** Rule segments read per page; more are ignored (decorative patterns). */
const MAX_RULES = 2000;
const MAX_DEPTH = 4;

const BULLET_GLYPH_RE = /^[•◦▪▫●○■□‣⁃∙·➢►▶✓✔❖]\s*/;
const BULLET_DASH_RE = /^[-–—*]\s+/;
const ORDERED_RE = /^(?:\((\d{1,3}|[a-zA-Z]|[ivxlcIVXLC]{1,6})\)|(\d{1,3}|[a-zA-Z]|[ivxlcIVXLC]{1,6})[.)])\s+/;
const MARKER_ONLY_RE = /^(?:[•◦▪▫●○■□‣⁃∙·➢►▶✓✔❖]|\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcIVXLC]{1,6})[.)])$/;
const PAGE_NUMBER_RE = /^(?:page\s+)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?$/i;
const DASHED_PAGE_NUMBER_RE = /^[-–—]\s*\d{1,4}\s*[-–—]$/;
const SENTENCE_END_RE = /[.!?:;]["'”’)\]]?$/;

const BOLD_FONT_RE = /bold|black|heavy|semibold|demi/i;
const ITALIC_FONT_RE = /italic|oblique/i;

function minOf<T>(list: readonly T[], fn: (item: T) => number): number {
  let min = Infinity;
  for (const item of list) min = Math.min(min, fn(item));
  return min;
}

function maxOf<T>(list: readonly T[], fn: (item: T) => number): number {
  let max = -Infinity;
  for (const item of list) max = Math.max(max, fn(item));
  return max;
}

/** First index in ascending `values` whose value is `>= target`. */
function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const countWords = (text: string) => {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const space = text.charCodeAt(i) <= 32;
    if (!space && !inWord) words++;
    inWord = !space;
  }
  return words;
};

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Runs → fragments (runs on one baseline separated by less than a gutter)

function runSize(run: PdfTextRun): number {
  if (run.fontSize && run.fontSize > 0) return run.fontSize;
  if (run.height && run.height > 0) return run.height;
  return 10;
}

/**
 * Groups a page's runs into fragments: runs on the same baseline whose gap is
 * smaller than about one em. Wider gaps (column gutters, table cells) keep the
 * runs apart; a lone list marker always joins the text after it.
 */
function buildFragments(runs: readonly PdfTextRun[]): Frag[] {
  const items = runs
    .filter((run) => typeof run.text === "string" && run.text.trim() !== "" && Number.isFinite(run.x) && Number.isFinite(run.y))
    .map((run) => {
      const size = runSize(run);
      const width = run.width !== undefined && run.width >= 0 ? run.width : run.text.length * size * 0.5;
      return {
        text: run.text,
        x0: run.x,
        x1: run.x + width,
        y: run.y,
        size,
        bold: run.bold ?? BOLD_FONT_RE.test(run.fontName ?? ""),
        italic: run.italic ?? ITALIC_FONT_RE.test(run.fontName ?? ""),
      };
    });
  items.sort((a, b) => b.y - a.y || a.x0 - b.x0);

  const frags: Frag[] = [];
  let i = 0;
  while (i < items.length) {
    // One baseline: everything within half the first run's size.
    const anchor = items[i];
    let j = i + 1;
    while (j < items.length && anchor.y - items[j].y <= Math.max(1, Math.min(anchor.size, items[j].size) * 0.5)) j++;
    const row = items.slice(i, j).sort((a, b) => a.x0 - b.x0);
    i = j;
    let current: (Frag & { styleChars: Map<string, number> }) | null = null;
    const finish = () => {
      if (!current) return;
      let best = "";
      let bestChars = -1;
      current.styleChars.forEach((chars, key) => {
        if (chars > bestChars) {
          best = key;
          bestChars = chars;
        }
      });
      const [size, bold, italic] = best.split("|");
      current.size = Number(size);
      current.bold = bold === "1";
      current.italic = italic === "1";
      current.text = collapse(current.text);
      current.words = countWords(current.text);
      current.top = current.y + current.size * 0.8;
      current.bottom = current.y - current.size * 0.2;
      if (current.text) frags.push(current);
      current = null;
    };
    for (const item of row) {
      if (current) {
        const gap = item.x0 - current.x1;
        const em = Math.max(current.size, item.size);
        const markerOnly = MARKER_ONLY_RE.test(collapse(current.text));
        if (gap > em * (markerOnly ? 6 : 1)) finish();
      }
      if (!current) {
        current = {
          text: item.text,
          x0: item.x0,
          x1: item.x1,
          y: item.y,
          top: 0,
          bottom: 0,
          size: item.size,
          bold: item.bold,
          italic: item.italic,
          words: 0,
          styleChars: new Map(),
        };
      } else {
        const gap = item.x0 - current.x1;
        if (gap > Math.max(current.size, item.size) * 0.15 && !/\s$/.test(current.text) && !/^\s/.test(item.text)) {
          current.text += " ";
        }
        current.text += item.text;
        current.x1 = Math.max(current.x1, item.x1);
      }
      const key = `${Math.round(item.size * 2) / 2}|${item.bold ? 1 : 0}|${item.italic ? 1 : 0}`;
      current.styleChars.set(key, (current.styleChars.get(key) ?? 0) + item.text.trim().length);
    }
    finish();
  }
  return frags;
}

// ---------------------------------------------------------------------------
// Running headers, footers and page numbers

interface EdgeRemoval {
  headers: number;
  footers: number;
  pageNumbers: number;
}

/** Baseline rows of a page's fragments (already sorted top to bottom). */
function baselineRows(frags: Frag[]): Frag[][] {
  const rows: Frag[][] = [];
  for (const frag of frags) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - frag.y) <= Math.max(1, Math.min(row[0].size, frag.size) * 0.5)) row.push(frag);
    else rows.push([frag]);
  }
  return rows;
}

const edgeKey = (row: Frag[]) =>
  collapse(row.map((f) => f.text).join(" "))
    .toLowerCase()
    .replace(/\d+/g, "#");

function removeHeadersAndFooters(pages: Frag[][]): EdgeRemoval {
  const removed: EdgeRemoval = { headers: 0, footers: 0, pageNumbers: 0 };
  const pageRows = pages.map((frags) => baselineRows([...frags].sort((a, b) => b.y - a.y || a.x0 - b.x0)));
  // Candidates: the first and last two rows of each page.
  const counts = new Map<string, Set<number>>();
  const candidates: { page: number; row: Frag[]; edge: "top" | "bottom"; extreme: boolean; gap: number }[] = [];
  pageRows.forEach((rows, page) => {
    const n = rows.length;
    const picks: [number, "top" | "bottom"][] = [];
    for (let k = 0; k < Math.min(2, n); k++) picks.push([k, "top"]);
    for (let k = Math.max(Math.min(2, n), n - 2); k < n; k++) picks.push([k, "bottom"]);
    for (const [index, edge] of picks) {
      const row = rows[index];
      const extreme = edge === "top" ? index === 0 : index === n - 1;
      const neighbour = edge === "top" ? rows[index + 1] : rows[index - 1];
      const gap = neighbour ? Math.abs(row[0].y - neighbour[0].y) / row[0].size : Infinity;
      candidates.push({ page, row, edge, extreme, gap });
      const key = `${edge}:${edgeKey(row)}`;
      if (!counts.has(key)) counts.set(key, new Set());
      counts.get(key)!.add(page);
    }
  });
  const minPages = Math.max(2, Math.ceil(pages.length * 0.5));
  const drop = new Set<Frag>();
  for (const candidate of candidates) {
    const text = collapse(candidate.row.map((f) => f.text).join(" "));
    const isPageNumber = candidate.extreme && (PAGE_NUMBER_RE.test(text) || DASHED_PAGE_NUMBER_RE.test(text));
    const repeated = (counts.get(`${candidate.edge}:${edgeKey(candidate.row)}`)?.size ?? 0) >= minPages;
    let kind: keyof EdgeRemoval | null = null;
    if (isPageNumber && (pages.length > 1 || candidate.gap > 2.5)) kind = "pageNumbers";
    else if (repeated && pages.length > 1) kind = candidate.edge === "top" ? "headers" : "footers";
    if (!kind || candidate.row.some((f) => drop.has(f))) continue;
    candidate.row.forEach((f) => drop.add(f));
    removed[kind]++;
  }
  if (drop.size) {
    pages.forEach((frags, index) => {
      pages[index] = frags.filter((f) => !drop.has(f));
    });
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Ruled tables

interface HSeg {
  y: number;
  x0: number;
  x1: number;
}
interface VSeg {
  x: number;
  y0: number;
  y1: number;
}

function splitRules(rules: readonly PdfRuleLine[]): { h: HSeg[]; v: VSeg[] } {
  const h: HSeg[] = [];
  const v: VSeg[] = [];
  for (const rule of rules.slice(0, MAX_RULES)) {
    const { x1, y1, x2, y2 } = rule;
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    if (dy <= 1.5 && dx >= 6) h.push({ y: (y1 + y2) / 2, x0: Math.min(x1, x2), x1: Math.max(x1, x2) });
    else if (dx <= 1.5 && dy >= 6) v.push({ x: (x1 + x2) / 2, y0: Math.min(y1, y2), y1: Math.max(y1, y2) });
  }
  return { h, v };
}

/** Clusters sorted-ascending values within `tol`; returns the cluster means. */
function clusterValues(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: { sum: number; n: number; last: number }[] = [];
  for (const value of sorted) {
    const cluster = out[out.length - 1];
    if (cluster && value - cluster.last <= tol) {
      cluster.sum += value;
      cluster.n++;
      cluster.last = value;
    } else out.push({ sum: value, n: 1, last: value });
  }
  return out.map((c) => c.sum / c.n);
}

function find(parent: number[], i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

const cellText = (frags: Frag[], dehyphenate: boolean, stats: { dehyphenated: number }) => {
  const sorted = [...frags].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  let text = "";
  let lastY = Infinity;
  for (const frag of sorted) {
    if (!text) text = frag.text;
    else if (Math.abs(lastY - frag.y) > frag.size * 0.5) text = joinLines(text, frag.text, dehyphenate, stats);
    else text += ` ${frag.text}`;
    lastY = frag.y;
  }
  return collapse(text);
};

const NUMERIC_RE = /^[-+−(]?[$€£¥]?\s?\d[\d,.\s]*%?\)?$/;

/** Marks a header row: bold over non-bold rows, or labels over numeric data. */
function headerRowCount(rowFrags: Frag[][][]): number {
  if (rowFrags.length < 2) return 0;
  const cells = (row: Frag[][]) => row.filter((cell) => cell.length > 0);
  const first = cells(rowFrags[0]);
  if (!first.length) return 0;
  const rest = rowFrags.slice(1).flatMap(cells);
  const allBold = (list: Frag[][]) => list.length > 0 && list.every((cell) => cell.every((f) => f.bold));
  if (allBold(first) && !allBold(rest)) return 1;
  const numeric = (cell: Frag[]) => NUMERIC_RE.test(collapse(cell.map((f) => f.text).join(" ")));
  if (first.every((cell) => !numeric(cell))) {
    // A label above a column of numbers.
    const columns = rowFrags[0].length;
    for (let c = 0; c < columns; c++) {
      const body = rowFrags.slice(1).map((row) => row[c]).filter((cell) => cell && cell.length > 0);
      if (rowFrags[0][c].length && body.length >= 2 && body.every(numeric)) return 1;
    }
  }
  const firstSize = maxOf(first.flat(), (f) => f.size);
  const restSize = median(rest.flat().map((f) => f.size));
  if (restSize > 0 && firstSize >= restSize * 1.1) return 1;
  return 0;
}

/**
 * Tables drawn with ruling lines. Connected horizontal and vertical rules form
 * a grid; stacked horizontal rules alone (booktabs) bound a region whose
 * columns come from aligned gaps. Returns the tables as flow atoms and the
 * fragments they consumed.
 */
function ruledTables(
  frags: Frag[],
  rules: readonly PdfRuleLine[],
  page: number,
  dehyphenate: boolean,
  stats: { dehyphenated: number },
): { atoms: Frag[]; consumed: Set<Frag> } {
  const consumed = new Set<Frag>();
  const atoms: Frag[] = [];
  const { h, v } = splitRules(rules);
  if (h.length < 2) return { atoms, consumed };
  const n = h.length + v.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const union = (a: number, b: number) => {
    const ra = find(parent, a);
    const rb = find(parent, b);
    if (ra !== rb) parent[ra] = rb;
  };
  const tol = 2;
  // Horizontal ↔ vertical intersections: sweep verticals sorted by x against horizontals.
  const vOrder = v.map((_, i) => i).sort((a, b) => v[a].x - v[b].x);
  const vxs = vOrder.map((i) => v[i].x);
  h.forEach((seg, hi) => {
    let lo = 0;
    let hiIdx = vxs.length;
    while (lo < hiIdx) {
      const mid = (lo + hiIdx) >> 1;
      if (vxs[mid] < seg.x0 - tol) lo = mid + 1;
      else hiIdx = mid;
    }
    for (let k = lo; k < vxs.length && vxs[k] <= seg.x1 + tol; k++) {
      const vs = v[vOrder[k]];
      if (seg.y >= vs.y0 - tol && seg.y <= vs.y1 + tol) union(hi, h.length + vOrder[k]);
    }
  });
  // Stacked horizontal rules with the same extent (booktabs-style tables).
  const hOrder = h.map((_, i) => i).sort((a, b) => h[a].x0 - h[b].x0 || h[a].x1 - h[b].x1 || h[b].y - h[a].y);
  for (let k = 1; k < hOrder.length; k++) {
    const a = h[hOrder[k - 1]];
    const b = h[hOrder[k]];
    if (Math.abs(a.x0 - b.x0) <= 4 && Math.abs(a.x1 - b.x1) <= 4) union(hOrder[k - 1], hOrder[k]);
  }
  const groups = new Map<number, { h: HSeg[]; v: VSeg[] }>();
  h.forEach((seg, i) => {
    const root = find(parent, i);
    if (!groups.has(root)) groups.set(root, { h: [], v: [] });
    groups.get(root)!.h.push(seg);
  });
  v.forEach((seg, i) => {
    const root = find(parent, h.length + i);
    groups.get(root)?.v.push(seg);
  });

  // Fragments sorted by baseline for range lookups.
  const byY = [...frags].sort((a, b) => a.y - b.y);
  const ys = byY.map((f) => f.y);
  const inRange = (y0: number, y1: number) => {
    let lo = 0;
    let hi = ys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ys[mid] < y0) lo = mid + 1;
      else hi = mid;
    }
    const out: Frag[] = [];
    for (let k = lo; k < ys.length && ys[k] <= y1; k++) out.push(byY[k]);
    return out;
  };

  groups.forEach((group) => {
    const hys = clusterValues(group.h.map((s) => s.y), 1.5).sort((a, b) => b - a);
    if (hys.length < 2) return;
    const x0 = Math.min(...group.h.map((s) => s.x0), ...group.v.map((s) => s.x));
    const x1 = Math.max(...group.h.map((s) => s.x1), ...group.v.map((s) => s.x));
    const top = Math.max(hys[0], ...group.v.map((s) => s.y1));
    const bottom = Math.min(hys[hys.length - 1], ...group.v.map((s) => s.y0));
    const inside = inRange(bottom, top).filter((f) => {
      if (consumed.has(f)) return false;
      const cx = (f.x0 + f.x1) / 2;
      return cx >= x0 - 1 && cx <= x1 + 1;
    });
    if (inside.length < 2) return;
    const vxsGroup = clusterValues(group.v.map((s) => s.x), 1.5);
    let table: (PdfLayoutBlock & { type: "table" }) | null = null;
    if (vxsGroup.length >= 3 || (vxsGroup.length >= 2 && hys.length >= 3 && vxsGroup.some((x) => x > x0 + 4 && x < x1 - 4))) {
      table = gridTable(inside, group, hys, vxsGroup, x0, x1, top, bottom, page, dehyphenate, stats);
    }
    if (!table) {
      // Rules bound the table; columns come from aligned gaps (booktabs).
      const result = alignedTable(inside, page, 2, dehyphenate, stats, hys.length >= 3 ? hys[1] : undefined);
      if (result && !result.leftover.length && !result.before.length) table = { ...result.table, ruled: true, confidence: 0.85 };
    }
    if (!table) return;
    inside.forEach((f) => consumed.add(f));
    atoms.push({
      text: "",
      x0,
      x1,
      y: bottom,
      top,
      bottom,
      size: median(inside.map((f) => f.size)),
      bold: false,
      italic: false,
      words: 0,
      table,
    });
  });
  return { atoms, consumed };
}

function gridTable(
  inside: Frag[],
  group: { h: HSeg[]; v: VSeg[] },
  hys: number[],
  vxsIn: number[],
  x0: number,
  x1: number,
  top: number,
  bottom: number,
  page: number,
  dehyphenate: boolean,
  stats: { dehyphenated: number },
): (PdfLayoutBlock & { type: "table" }) | null {
  const xs = [...vxsIn];
  if (xs[0] > x0 + 4) xs.unshift(x0);
  if (xs[xs.length - 1] < x1 - 4) xs.push(x1);
  const rowsY = [...hys];
  if (rowsY[0] < top - 4) rowsY.unshift(top);
  if (rowsY[rowsY.length - 1] > bottom + 4) rowsY.push(bottom);
  const cols = xs.length - 1;
  const rows = rowsY.length - 1;
  if (cols < 2 || rows < 1 || cols > MAX_COLS || rows > MAX_TABLE_ROWS) return null;
  const grid: Frag[][][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => []));
  const ascRows = [...rowsY].reverse();
  for (const frag of inside) {
    const x = frag.x0 + Math.min(2, (frag.x1 - frag.x0) / 2);
    const c = lowerBound(xs, x + 1e-9) - 1;
    const yProbe = frag.y + frag.size * 0.3;
    const r = rows - (lowerBound(ascRows, yProbe + 1e-9) - 1) - 1;
    if (c >= 0 && c < cols && r >= 0 && r < rows) grid[r][c].push(frag);
  }
  const filled = grid.flat().filter((cell) => cell.length).length;
  if (filled < 2 || (rows < 2 && cols < 2)) return null;
  // Rules indexed by the grid edge they lie on, so span checks stay cheap.
  const vAt: VSeg[][] = xs.map(() => []);
  for (const seg of group.v) {
    const k = lowerBound(xs, seg.x - 2);
    if (k < xs.length && Math.abs(xs[k] - seg.x) <= 2) vAt[k].push(seg);
  }
  const hAt: HSeg[][] = rowsY.map(() => []);
  for (const seg of group.h) {
    const k = rows - (lowerBound(ascRows, seg.y - 2));
    if (k >= 0 && k <= rows && Math.abs(rowsY[k] - seg.y) <= 2) hAt[k].push(seg);
  }
  const hasV = (k: number, y: number) => vAt[k].some((s) => y >= s.y0 - 2 && y <= s.y1 + 2);
  const hasH = (k: number, x: number) => hAt[k].some((s) => x >= s.x0 - 2 && x <= s.x1 + 2);
  const covered = grid.map((row) => row.map(() => false));
  const header = headerRowCount(grid);
  const out: PdfTableCell[][] = [];
  for (let r = 0; r < rows; r++) {
    const midY = (rowsY[r] + rowsY[r + 1]) / 2;
    const row: PdfTableCell[] = [];
    for (let c = 0; c < cols; c++) {
      if (covered[r][c]) continue;
      let colSpan = 1;
      while (c + colSpan < cols && !hasV(c + colSpan, midY) && !grid[r][c + colSpan].length && !covered[r][c + colSpan]) colSpan++;
      let rowSpan = 1;
      const midX = (xs[c] + xs[c + colSpan]) / 2;
      while (
        r + rowSpan < rows &&
        !hasH(r + rowSpan, midX) &&
        !covered[r + rowSpan].slice(c, c + colSpan).some(Boolean) &&
        grid[r + rowSpan].slice(c, c + colSpan).every((cell) => !cell.length)
      ) {
        rowSpan++;
      }
      for (let rr = r; rr < r + rowSpan; rr++) for (let cc = c; cc < c + colSpan; cc++) covered[rr][cc] = true;
      row.push({ text: cellText(grid[r][c], dehyphenate, stats), colSpan, rowSpan, header: r < header });
    }
    out.push(row);
  }
  return { type: "table", page, confidence: 0.95, ruled: true, rows: out, columns: cols, headerRows: header };
}

// ---------------------------------------------------------------------------
// Tables from aligned columns

/**
 * Builds a table from fragments laid out in rows with shared column gaps.
 * Columns are the gaps in the horizontal coverage of rows with several cells;
 * a single-cell row that crosses a column gap becomes a spanning cell. Rows
 * that look like prose at either end are left over for the flow.
 */
function alignedTable(
  frags: Frag[],
  page: number,
  minRows: number,
  dehyphenate: boolean,
  stats: { dehyphenated: number },
  headerRuleY?: number,
): { table: PdfLayoutBlock & { type: "table" }; leftover: Frag[]; before: Frag[] } | null {
  const sorted = [...frags].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  let rows = baselineRows(sorted).map((row) => row.sort((a, b) => a.x0 - b.x0));
  if (rows.length < minRows) return null;
  // Column gaps from rows with at least two cells.
  const multi = rows.filter((row) => row.length >= 2);
  if (multi.length < Math.min(minRows, 2)) return null;
  const spans = multi.flat().map((f) => [f.x0, f.x1] as const).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (merged.length < 2 || merged.length > MAX_COLS) return null;
  const edges = merged.map((m) => m[0]);
  const cols = merged.length;
  const colOf = (x: number) => {
    let c = 0;
    while (c + 1 < cols && x >= merged[c + 1][0] - 1) c++;
    return c;
  };
  const spanOf = (f: Frag, c: number) => {
    let span = 1;
    while (c + span < cols && f.x1 > merged[c + span][0] + 2) span++;
    return span;
  };
  // Peel prose-like or lone rows from both ends.
  const rowIsCells = (row: Frag[]) => {
    if (row.length >= 2) return true;
    const f = row[0];
    const c = colOf(f.x0);
    return spanOf(f, c) >= 2 && f.words <= 8 && Math.abs(f.x0 - edges[c]) <= Math.max(4, f.size * 0.6);
  };
  const before: Frag[] = [];
  const leftover: Frag[] = [];
  let first = 0;
  let end = rows.length;
  while (first < end && !rowIsCells(rows[first])) first++;
  while (end > first && !rowIsCells(rows[end - 1])) end--;
  rows.slice(0, first).forEach((row) => before.push(...row));
  rows.slice(end).forEach((row) => leftover.push(...row));
  rows = rows.slice(first, end);
  if (rows.length < minRows || rows.length > MAX_TABLE_ROWS) return null;
  // Wrapped cell text: a row with its first column empty and tight spacing continues the row above.
  const grid: Frag[][][] = [];
  const spansGrid: number[][] = [];
  let prevRow: Frag[] | null = null;
  for (const row of rows) {
    const cells: Frag[][] = Array.from({ length: cols }, () => []);
    const spanRow = Array.from({ length: cols }, () => 1);
    for (const f of row) {
      const c = colOf(f.x0);
      cells[c].push(f);
      spanRow[c] = Math.max(spanRow[c], row.length === 1 ? spanOf(f, c) : 1);
    }
    const continuation =
      prevRow !== null &&
      grid.length > 0 &&
      cells[0].length === 0 &&
      grid[grid.length - 1][0].length > 0 &&
      cells.every((cell, c) => !cell.length || grid[grid.length - 1][c].length > 0) &&
      minOf(prevRow, (f) => f.bottom) - maxOf(row, (f) => f.top) < row[0].size * 0.5;
    if (continuation) {
      cells.forEach((cell, c) => grid[grid.length - 1][c].push(...cell));
    } else {
      grid.push(cells);
      spansGrid.push(spanRow);
    }
    prevRow = row;
  }
  if (grid.length < minRows) return null;
  const full = grid.filter((cells) => cells.filter((c) => c.length).length >= 2).length;
  if (full / grid.length < 0.6) return null;
  // Prose check: table cells are short.
  const cellsWithText = grid.flat().filter((c) => c.length);
  const meanWords = cellsWithText.reduce((sum, cell) => sum + cell.reduce((s, f) => s + f.words, 0), 0) / cellsWithText.length;
  if (meanWords > 12) return null;

  let header = headerRowCount(grid);
  if (headerRuleY !== undefined) {
    // Rows above the second rule are the header.
    const above = rows.filter((row) => row[0].y > headerRuleY).length;
    if (above > 0 && above < grid.length) header = Math.max(header, Math.min(above, grid.length - 1));
  }
  const out: PdfTableCell[][] = grid.map((cells, r) => {
    const row: PdfTableCell[] = [];
    for (let c = 0; c < cols; ) {
      const span = Math.min(spansGrid[r][c], cols - c);
      row.push({ text: cellText(cells[c], dehyphenate, stats), colSpan: span, rowSpan: 1, header: r < header });
      c += span;
    }
    return row;
  });
  const confidence = Math.min(
    0.9,
    0.5 + (grid.length >= 5 ? 0.1 : 0) + (cols >= 3 ? 0.1 : 0) + 0.2 * (full / grid.length) - (cols === 2 ? 0.05 : 0),
  );
  return {
    table: { type: "table", page, confidence, ruled: false, rows: out, columns: cols, headerRows: header },
    leftover,
    before,
  };
}

// ---------------------------------------------------------------------------
// Reading order: columns and bands

/**
 * Splits a region into reading-order segments. Gutters are vertical strips
 * that no narrow fragment crosses; fragments crossing one (titles, full-width
 * paragraphs) form their own bands. A band whose columns read like prose is
 * read column by column; one that doesn't (short aligned cells) is a grid,
 * which table detection looks at.
 */
function readingOrder(items: Frag[], body: number, detectColumns: boolean, depth: number, columnPages: { count: number }): Segment[] {
  const byTop = [...items].sort((a, b) => b.top - a.top || a.x0 - b.x0);
  if (!detectColumns || items.length < 2 || depth > MAX_DEPTH) return [{ kind: "flow", items: byTop }];
  const left = minOf(items, (f) => f.x0);
  const right = maxOf(items, (f) => f.x1);
  const width = right - left;
  const isNarrow = (f: Frag) => f.x1 - f.x0 < width * 0.55;
  const narrow = items.filter(isNarrow);
  const minGutter = Math.max(body * 0.9, 6);
  // Sweep the narrow items' horizontal coverage. A gutter is an interior strip
  // crossed by (almost) no narrow item: a few stray lines crossing a table's
  // column gap must not hide it.
  const allowed = Math.max(1, Math.floor(narrow.length * 0.08));
  const events: [number, number][] = [];
  for (const f of narrow) events.push([f.x0, 1], [f.x1, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const candidates: [number, number][] = [];
  let depthNow = 0;
  let seenContent = false;
  let start: number | null = null;
  for (const [x, delta] of events) {
    depthNow += delta;
    if (depthNow > allowed) {
      if (start !== null && seenContent && x - start >= minGutter) candidates.push([start, x]);
      start = null;
      seenContent = true;
    } else if (start === null) start = x;
  }
  // Shrink each strip to the items that end or start inside it: only items
  // crossing it entirely are strays.
  const ends = narrow.map((f) => f.x1).sort((a, b) => a - b);
  const starts = narrow.map((f) => f.x0).sort((a, b) => a - b);
  const gutters: [number, number][] = [];
  for (const [a, b] of candidates) {
    const endBelow = lowerBound(ends, b) - 1;
    const left = endBelow >= 0 && ends[endBelow] > a ? ends[endBelow] : a;
    const startAbove = lowerBound(starts, a + 1e-9);
    const right = startAbove < starts.length && starts[startAbove] < b ? starts[startAbove] : b;
    if (right - left < minGutter) continue;
    // Strays must be fewer than the fragments on either side, or the "gutter"
    // is just the ragged end of one long line.
    const onLeft = lowerBound(ends, left + 1e-6);
    const onRight = starts.length - lowerBound(starts, right - 1e-6);
    const strays = narrow.length - onLeft - onRight;
    if (strays < Math.min(onLeft, onRight)) gutters.push([left, right]);
  }
  if (!gutters.length) return [{ kind: "flow", items: byTop }];
  const gutterEnds = gutters.map((g) => g[1]);
  // The first gutter ending right of x0; the item crosses it if it reaches past its start.
  const crosses = (f: Frag) => {
    const k = lowerBound(gutterEnds, f.x0 + 1 + 1e-9);
    return k < gutters.length && f.x1 > gutters[k][0] + 1 && f.x0 < gutters[k][1] - 1;
  };
  const columnOf = (f: Frag) => lowerBound(gutterEnds, f.x0 + 1 + 1e-9);

  // Bands: runs of non-crossing items between crossing ones.
  const bands: { spanning: boolean; items: Frag[] }[] = [];
  for (const f of byTop) {
    const spanning = crosses(f);
    const band = bands[bands.length - 1];
    if (band && band.spanning === spanning) band.items.push(f);
    else bands.push({ spanning, items: [f] });
  }
  const segments: Segment[] = [];
  /** Column segments are sealed so the next band does not merge into the last column. */
  let sealed = false;
  const pushFlow = (list: Frag[]) => {
    if (!list.length) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === "flow" && !sealed) last.items.push(...list);
    else segments.push({ kind: "flow", items: list });
    sealed = false;
  };
  let multiColumn = false;
  /** A short line crossing the gutters: a spanning header or totals row of a table. */
  const isShortSpan = (f: Frag) => !f.table && isNarrow(f) && f.words <= 8;
  for (const band of bands) {
    const last = segments[segments.length - 1];
    if (band.spanning) {
      const lead = band.items[0];
      if (last && last.kind === "grid" && isShortSpan(lead) && minOf(last.items, (f) => f.bottom) - lead.top <= lead.size * 2) {
        last.items.push(lead);
        pushFlow(band.items.slice(1));
      } else pushFlow(band.items);
      continue;
    }
    const columns: Frag[][] = Array.from({ length: gutters.length + 1 }, () => []);
    band.items.forEach((f) => columns[columnOf(f)].push(f));
    const used = columns.filter((c) => c.length);
    if (used.length < 2) {
      pushFlow(band.items);
      continue;
    }
    const prose = used.every((col) => {
      const text = col.filter((f) => !f.table);
      if (text.length < 2) return text.length === 0;
      const colLeft = minOf(text, (f) => f.x0);
      const colRight = maxOf(text, (f) => f.x1);
      const fill = text.reduce((sum, f) => sum + (f.x1 - f.x0), 0) / text.length / Math.max(1, colRight - colLeft);
      const words = text.reduce((sum, f) => sum + f.words, 0) / text.length;
      return fill >= 0.55 && words >= 3;
    });
    const tops = used.map((col) => [minOf(col, (f) => f.bottom), maxOf(col, (f) => f.top)]);
    const overlapping = tops.every(([b, t], i) => i === 0 || Math.min(t, tops[0][1]) - Math.max(b, tops[0][0]) > 0);
    if (prose && overlapping) {
      multiColumn = true;
      for (const col of used) segments.push(...readingOrder(col, body, detectColumns, depth + 1, columnPages));
      sealed = true;
      continue;
    }
    // A grid band. Pull a short spanning line right above it (a header band) into it,
    // which also re-joins grids split by such a line.
    const pulled: Frag[] = [];
    if (last && last.kind === "flow" && !sealed) {
      const tail = last.items[last.items.length - 1];
      if (isShortSpan(tail) && tail.bottom - maxOf(band.items, (f) => f.top) <= tail.size * 2) {
        pulled.push(last.items.pop()!);
        if (!last.items.length) segments.pop();
      }
    }
    const prevSegment = segments[segments.length - 1];
    if (prevSegment && prevSegment.kind === "grid" && (pulled.length || prevSegment === last)) {
      prevSegment.items.push(...pulled, ...band.items);
    } else segments.push({ kind: "grid", items: [...pulled, ...band.items] });
    sealed = false;
  }
  if (multiColumn && depth === 0) columnPages.count++;
  return segments;
}

// ---------------------------------------------------------------------------
// Lines → blocks

interface Line {
  text: string;
  x0: number;
  x1: number;
  y: number;
  top: number;
  size: number;
  bold: boolean;
  page: number;
  table?: PdfLayoutBlock & { type: "table" };
}

function flowLines(items: Frag[], page: number): Line[] {
  const lines: Line[] = [];
  const sorted = [...items].sort((a, b) => b.top - a.top || a.x0 - b.x0);
  for (const f of sorted) {
    if (f.table) {
      lines.push({ text: "", x0: f.x0, x1: f.x1, y: f.y, top: f.top, size: f.size, bold: false, page, table: f.table });
      continue;
    }
    const last = lines[lines.length - 1];
    if (last && !last.table && Math.abs(last.y - f.y) <= Math.min(last.size, f.size) * 0.5) {
      last.text = `${last.text} ${f.text}`;
      last.x0 = Math.min(last.x0, f.x0);
      last.x1 = Math.max(last.x1, f.x1);
    } else {
      lines.push({ text: f.text, x0: f.x0, x1: f.x1, y: f.y, top: f.top, size: f.size, bold: f.bold, page });
    }
  }
  return lines;
}

function joinLines(prev: string, next: string, dehyphenate: boolean, stats: { dehyphenated: number }): string {
  if (prev.endsWith("­")) {
    stats.dehyphenated++;
    return prev.slice(0, -1) + next;
  }
  if (dehyphenate && /[A-Za-zÀ-ɏ]-$/.test(prev) && /^[a-zß-ɏ]/.test(next)) {
    stats.dehyphenated++;
    return prev.slice(0, -1) + next;
  }
  return `${prev} ${next}`;
}

type MarkerKind = "glyph" | "dash" | "num" | "alpha" | "roman";

function listMarker(text: string): { kind: MarkerKind; rest: string; ordered: boolean; value?: number } | null {
  const glyph = BULLET_GLYPH_RE.exec(text);
  if (glyph) return { kind: "glyph", rest: text.slice(glyph[0].length), ordered: false };
  const dash = BULLET_DASH_RE.exec(text);
  if (dash) return { kind: "dash", rest: text.slice(dash[0].length), ordered: false };
  const ordered = ORDERED_RE.exec(text);
  if (ordered) {
    const token = ordered[1] ?? ordered[2];
    const kind: MarkerKind = /^\d+$/.test(token) ? "num" : /^[ivxlc]{2,}$/i.test(token) || /^i$/i.test(token) ? "roman" : "alpha";
    return { kind, rest: text.slice(ordered[0].length), ordered: true, value: kind === "num" ? Number(token) : undefined };
  }
  return null;
}

interface BuildContext {
  body: number;
  boldBody: boolean;
  pitch: (size: number) => number;
  options: Required<PdfLayoutOptions>;
  stats: { dehyphenated: number };
  blocks: PdfLayoutBlock[];
  /** Heading candidates waiting for levels: block plus its style key. */
  headings: { block: PdfLayoutBlock & { type: "heading" }; key: number; boldOnly: boolean }[];
  /** The paragraph that may continue in the next segment. */
  open: { block: PdfLayoutBlock & { type: "paragraph" }; size: number; lastText: string } | null;
}

function headingStyle(
  line: Line,
  next: Line | undefined,
  segRight: number,
  ctx: BuildContext,
): { key: number; confidence: number; boldOnly: boolean } | null {
  if (!ctx.options.detectHeadings || line.table) return null;
  const text = line.text;
  const words = countWords(text);
  if (text.length > 200 || words > 25 || !/\p{L}/u.test(text)) return null;
  // A long sentence in a larger font is a lede paragraph, not a heading.
  if (words > 15 && SENTENCE_END_RE.test(text)) return null;
  const ratio = line.size / ctx.body;
  if (ratio >= 1.15) {
    const confidence = Math.min(0.95, 0.6 + (ratio - 1.15) * 0.8 + (line.bold ? 0.1 : 0));
    return { key: Math.round(line.size * 2) / 2 + (line.bold ? 0.25 : 0), confidence, boldOnly: false };
  }
  // A bold line that fills the column and runs on into more bold text is a bold paragraph.
  const runsOn =
    !!next && !next.table && next.bold && Math.abs(next.size - line.size) < 0.5 && line.x1 >= segRight - 2 * line.size;
  if (line.bold && !ctx.boldBody && !runsOn && ratio >= 0.95 && text.length <= 100 && !/[.,;]$/.test(text)) {
    return { key: Math.round(line.size * 2) / 2 + 0.25, confidence: 0.6, boldOnly: true };
  }
  return null;
}

/** Turns one flow segment's lines into blocks. */
function buildBlocks(lines: Line[], ctx: BuildContext) {
  const textLines = lines.filter((l) => !l.table);
  const segLeft = textLines.length ? minOf(textLines, (l) => l.x0) : 0;
  const segRight = textLines.length ? maxOf(textLines, (l) => l.x1) : 0;
  // Marker kinds that need company (two items) before they count as a list.
  const kindCounts = new Map<MarkerKind, number>();
  const markers = lines.map((line) => {
    if (!ctx.options.detectLists || line.table) return null;
    const marker = listMarker(line.text);
    if (marker) kindCounts.set(marker.kind, (kindCounts.get(marker.kind) ?? 0) + 1);
    return marker;
  });
  let list: (PdfLayoutBlock & { type: "list" }) | null = null;
  let listStack: number[] = [];
  let lastItemLine: Line | null = null;
  let para: { block: PdfLayoutBlock & { type: "paragraph" }; lines: Line[] } | null = null;
  let heading: { block: PdfLayoutBlock & { type: "heading" }; line: Line; key: number; lines: number } | null = null;

  const closeAll = () => {
    if (para) {
      const last = para.lines[para.lines.length - 1];
      const ended = SENTENCE_END_RE.test(last.text) || last.x1 < segRight - 3 * last.size;
      ctx.open = ended ? null : { block: para.block, size: last.size, lastText: para.block.text };
    } else ctx.open = null;
    para = null;
    list = null;
    listStack = [];
    lastItemLine = null;
    heading = null;
  };

  lines.forEach((line, index) => {
    const prev = index > 0 ? lines[index - 1] : null;
    if (line.table) {
      closeAll();
      ctx.open = null;
      ctx.blocks.push(line.table);
      return;
    }
    const style = headingStyle(line, lines[index + 1], segRight, ctx);
    if (style) {
      // Consecutive lines in the same heading style form one heading.
      if (
        heading &&
        heading.key === style.key &&
        heading.lines < 3 &&
        prev === heading.line &&
        prev.y - line.y <= line.size * 1.6
      ) {
        heading.block.text = joinLines(heading.block.text, line.text, ctx.options.dehyphenate, ctx.stats);
        heading.line = line;
        heading.lines++;
        return;
      }
      closeAll();
      ctx.open = null;
      const block: PdfLayoutBlock & { type: "heading" } = { type: "heading", level: 1, text: line.text, page: line.page, confidence: style.confidence };
      ctx.blocks.push(block);
      ctx.headings.push({ block, key: style.key, boldOnly: style.boldOnly });
      heading = { block, line, key: style.key, lines: 1 };
      return;
    }
    heading = null;

    const marker = markers[index];
    const validMarker = marker && (marker.kind === "glyph" || (kindCounts.get(marker.kind) ?? 0) >= 2) && marker.rest.trim() !== "";
    if (validMarker) {
      const gapOk = lastItemLine && lastItemLine.y - line.y <= Math.max(ctx.pitch(line.size) * 2.2, line.size * 2.4);
      if (!list || !gapOk) {
        closeAll();
        ctx.open = null;
        list = { type: "list", page: line.page, confidence: 0.6, items: [] };
        ctx.blocks.push(list);
        listStack = [line.x0];
      }
      const tol = line.size * 0.5;
      while (listStack.length > 1 && line.x0 < listStack[listStack.length - 1] - tol) listStack.pop();
      if (line.x0 > listStack[listStack.length - 1] + tol) listStack.push(line.x0);
      else listStack[listStack.length - 1] = Math.min(listStack[listStack.length - 1], line.x0);
      const prevDepth = list.items.length ? list.items[list.items.length - 1].depth : -1;
      const depth = Math.min(listStack.length - 1, prevDepth + 1);
      const item: { text: string; depth: number; ordered: boolean; start?: number } = {
        text: collapse(marker!.rest),
        depth,
        ordered: marker!.ordered,
      };
      if (marker!.value !== undefined) item.start = marker!.value;
      list.items.push(item);
      list.confidence = Math.min(0.95, (marker!.kind === "glyph" ? 0.75 : 0.6) + 0.05 * list.items.length);
      lastItemLine = line;
      para = null;
      return;
    }
    if (list && lastItemLine && prev) {
      // Hanging-indent continuation of the last item.
      const markerX = listStack[listStack.length - 1];
      const continues =
        line.x0 > markerX + line.size * 0.3 &&
        line.x0 <= markerX + line.size * 5 &&
        prev.y - line.y <= ctx.pitch(line.size) * ctx.options.paragraphGap;
      if (continues) {
        const item = list.items[list.items.length - 1];
        item.text = joinLines(item.text, line.text, ctx.options.dehyphenate, ctx.stats);
        lastItemLine = line;
        return;
      }
      closeAll();
    }

    // Paragraph continuation from the previous segment (next column or page).
    if (!para && ctx.open && index === 0 && /^[a-z]/.test(line.text) && Math.abs(ctx.open.size - line.size) <= line.size * 0.12) {
      ctx.open.block.text = joinLines(ctx.open.block.text, line.text, ctx.options.dehyphenate, ctx.stats);
      para = { block: ctx.open.block, lines: [line] };
      ctx.open = null;
      return;
    }
    if (para && prev && !prev.table) {
      const last = para.lines[para.lines.length - 1];
      const gap = last.y - line.y;
      const sameSize = Math.abs(last.size - line.size) <= last.size * 0.12;
      const closeEnough = gap > 0 && gap <= ctx.pitch(line.size) * ctx.options.paragraphGap;
      const indentEm = line.size * 0.8;
      const indented = line.x0 - segLeft >= indentEm && last.x0 - segLeft < indentEm && line.x0 - segLeft < line.size * 8;
      const shortEnded = last.x1 < segRight - 3 * last.size && SENTENCE_END_RE.test(last.text);
      if (sameSize && closeEnough && !indented && !shortEnded) {
        para.block.text = joinLines(para.block.text, line.text, ctx.options.dehyphenate, ctx.stats);
        para.lines.push(line);
        return;
      }
    }
    closeAll();
    ctx.open = null;
    const block: PdfLayoutBlock & { type: "paragraph" } = { type: "paragraph", text: line.text, page: line.page };
    ctx.blocks.push(block);
    para = { block, lines: [line] };
  });
  closeAll();
}

/** Assigns heading levels by rank of style: larger first, bold before regular. */
function assignHeadingLevels(headings: BuildContext["headings"]) {
  const keys = Array.from(new Set(headings.map((h) => h.key))).sort((a, b) => b - a);
  const levelOf = new Map(keys.map((key, i) => [key, Math.min(6, i + 1) as 1 | 2 | 3 | 4 | 5 | 6]));
  headings.forEach((h) => {
    h.block.level = levelOf.get(h.key)!;
  });
}

// ---------------------------------------------------------------------------
// Entry point

const DEFAULTS: Required<PdfLayoutOptions> = {
  paragraphGap: 1.4,
  removeHeadersAndFooters: true,
  detectColumns: true,
  detectHeadings: true,
  detectLists: true,
  detectTables: true,
  dehyphenate: true,
};

/**
 * Analyses positioned text runs (one entry per page) and returns blocks in
 * reading order plus a report of what was detected.
 */
export function analyzePdfLayout(pages: readonly PdfLayoutPage[], options: PdfLayoutOptions = {}): PdfLayoutResult {
  const opts: Required<PdfLayoutOptions> = { ...DEFAULTS };
  (Object.keys(options) as (keyof PdfLayoutOptions)[]).forEach((key) => {
    if (options[key] !== undefined) (opts as any)[key] = options[key];
  });
  const fragPages = pages.map((page) => buildFragments(page.runs ?? []));
  const removed = opts.removeHeadersAndFooters ? removeHeadersAndFooters(fragPages) : { headers: 0, footers: 0, pageNumbers: 0 };

  // Body size: the size most characters are set in.
  const bySize = new Map<number, number>();
  let boldChars = 0;
  let totalChars = 0;
  fragPages.flat().forEach((f) => {
    const key = Math.round(f.size * 2) / 2;
    bySize.set(key, (bySize.get(key) ?? 0) + f.text.length);
  });
  let body = 10;
  let bodyChars = -1;
  bySize.forEach((chars, size) => {
    if (chars > bodyChars) {
      body = size;
      bodyChars = chars;
    }
  });
  fragPages.flat().forEach((f) => {
    if (Math.abs(f.size - body) <= body * 0.05) {
      totalChars += f.text.length;
      if (f.bold) boldChars += f.text.length;
    }
  });
  // Typical baseline pitch per size, from consecutive rows on each page.
  const pitches = new Map<number, number[]>();
  fragPages.forEach((frags) => {
    const rows = baselineRows([...frags].sort((a, b) => b.y - a.y || a.x0 - b.x0));
    for (let k = 1; k < rows.length; k++) {
      const a = rows[k - 1][0];
      const b = rows[k][0];
      if (Math.abs(a.size - b.size) > 0.5) continue;
      const d = a.y - b.y;
      if (d > 0 && d < a.size * 3) {
        const key = Math.round(b.size * 2) / 2;
        if (!pitches.has(key)) pitches.set(key, []);
        pitches.get(key)!.push(d);
      }
    }
  });
  const pitchMedians = new Map<number, number>();
  pitches.forEach((values, key) => pitchMedians.set(key, median(values)));

  const stats = { dehyphenated: 0 };
  const ctx: BuildContext = {
    body,
    boldBody: totalChars > 0 && boldChars / totalChars > 0.5,
    pitch: (size) => {
      const known = pitchMedians.get(Math.round(size * 2) / 2);
      return known && known >= size * 0.9 ? known : size * 1.2;
    },
    options: opts,
    stats,
    blocks: [],
    headings: [],
    open: null,
  };
  const columnPages = { count: 0 };
  const items: ImportStructureItem[] = [];

  fragPages.forEach((frags, pageIndex) => {
    const page = pageIndex + 1;
    let flowFrags = frags;
    const atoms: Frag[] = [];
    if (opts.detectTables && pages[pageIndex].rules?.length) {
      const ruled = ruledTables(frags, pages[pageIndex].rules!, page, opts.dehyphenate, stats);
      flowFrags = frags.filter((f) => !ruled.consumed.has(f));
      atoms.push(...ruled.atoms);
    }
    const before = columnPages.count;
    const segments = readingOrder([...flowFrags, ...atoms], body, opts.detectColumns, 0, columnPages);
    if (columnPages.count > before) items.push({ type: "columns", page, confidence: 0.8, detail: "multi-column layout" });
    // Rows peeled off a grid (a paragraph's last line, a caption) go back to the neighbouring flow.
    const units: ({ kind: "flow"; items: Frag[] } | { kind: "table"; table: PdfLayoutBlock & { type: "table" } })[] = [];
    let carry: Frag[] = [];
    for (const segment of segments) {
      if (segment.kind === "grid" && opts.detectTables) {
        const result = alignedTable(segment.items.filter((f) => !f.table), page, 3, opts.dehyphenate, stats);
        if (result) {
          const last = units[units.length - 1];
          if (result.before.length && last && last.kind === "flow") last.items.push(...carry, ...result.before);
          else if (result.before.length || carry.length) units.push({ kind: "flow", items: [...carry, ...result.before] });
          units.push({ kind: "table", table: result.table });
          carry = [...segment.items.filter((f) => f.table), ...result.leftover];
          continue;
        }
      }
      units.push({ kind: "flow", items: [...carry, ...segment.items] });
      carry = [];
    }
    if (carry.length) units.push({ kind: "flow", items: carry });
    for (const unit of units) {
      if (unit.kind === "table") {
        ctx.open = null;
        ctx.blocks.push(unit.table);
      } else buildBlocks(flowLines(unit.items, page), ctx);
    }
  });
  assignHeadingLevels(ctx.headings);

  const counts = { headings: 0, lists: 0, tables: 0, paragraphs: 0 };
  const confidences: number[] = [];
  ctx.blocks.forEach((block) => {
    if (block.type === "heading") {
      counts.headings++;
      confidences.push(block.confidence);
      items.push({ type: "heading", page: block.page, confidence: block.confidence, detail: `H${block.level} "${truncate(block.text)}"` });
    } else if (block.type === "list") {
      counts.lists++;
      confidences.push(block.confidence);
      const depth = maxOf(block.items, (i) => i.depth) + 1;
      items.push({
        type: "list",
        page: block.page,
        confidence: block.confidence,
        detail: `${block.items[0]?.ordered ? "numbered" : "bulleted"} list, ${block.items.length} items${depth > 1 ? `, ${depth} levels` : ""}`,
      });
    } else if (block.type === "table") {
      counts.tables++;
      confidences.push(block.confidence);
      items.push({
        type: "table",
        page: block.page,
        confidence: block.confidence,
        detail: `${block.rows.length}×${block.columns} table${block.ruled ? " (ruled)" : ""}${block.headerRows ? ", header row" : ""}`,
      });
    } else counts.paragraphs++;
  });
  items.sort((a, b) => a.page - b.page);
  return {
    blocks: ctx.blocks,
    report: {
      mode: "structured",
      pages: pages.length,
      counts,
      multiColumnPages: columnPages.count,
      confidence: confidences.length ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100 : 1,
      items,
      removed,
      dehyphenated: stats.dehyphenated,
    },
  };
}

const truncate = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

// ---------------------------------------------------------------------------
// HTML

function listHtml(items: { text: string; depth: number; ordered: boolean; start?: number }[]): string {
  let html = "";
  const stack: ("ul" | "ol")[] = [];
  for (const item of items) {
    const level = item.depth + 1;
    while (stack.length > level) html += `</li></${stack.pop()}>`;
    const tag = item.ordered ? "ol" : "ul";
    if (stack.length === level) {
      if (stack[stack.length - 1] !== tag) {
        html += `</li></${stack.pop()}>`;
      } else html += "</li>";
    }
    while (stack.length < level) {
      const start = item.ordered && item.start !== undefined && item.start !== 1 ? ` start="${item.start}"` : "";
      html += `<${tag}${start}>`;
      stack.push(tag);
    }
    html += `<li><p>${escapeHtml(item.text)}</p>`;
  }
  while (stack.length) html += `</li></${stack.pop()}>`;
  return html;
}

/** Renders layout blocks as editor HTML (`h1`–`h6`, `p`, `ul`/`ol`, `table`). Text is escaped. */
export function pdfLayoutBlocksToHtml(blocks: readonly PdfLayoutBlock[]): string {
  let html = "";
  for (const block of blocks) {
    if (block.type === "heading") html += `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    else if (block.type === "paragraph") html += `<p>${escapeHtml(block.text)}</p>`;
    else if (block.type === "list") html += listHtml(block.items);
    else {
      html += "<table><tbody>";
      for (const row of block.rows) {
        html += "<tr>";
        for (const cell of row) {
          const tag = cell.header ? "th" : "td";
          const attrs = `${cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ""}${cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ""}`;
          html += `<${tag}${attrs}><p>${escapeHtml(cell.text)}</p></${tag}>`;
        }
        html += "</tr>";
      }
      html += "</tbody></table>";
    }
  }
  return html || "<p></p>";
}
