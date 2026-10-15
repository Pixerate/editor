import { getHTMLFromFragment, type Extensions } from "@tiptap/core";
import { Fragment, type Node as ProsemirrorNode } from "@tiptap/pm/model";
import * as _Table from "@tiptap/extension-table";
import * as _TableRow from "@tiptap/extension-table-row";
import * as _TableHeader from "@tiptap/extension-table-header";
import * as _TableCell from "@tiptap/extension-table-cell";
import { createTableNestingPlugin } from "./nesting";

const resolveExt = (mod: any, name: string) =>
  mod?.[name] || mod?.default?.[name] || mod?.default?.default || mod?.default || mod;

const BaseTable = resolveExt(_Table, "Table");
const BaseTableRow = resolveExt(_TableRow, "TableRow");
const BaseTableHeader = resolveExt(_TableHeader, "TableHeader");
const BaseTableCell = resolveExt(_TableCell, "TableCell");

/** Horizontal alignment of a table cell (`align` attribute). */
export type TableCellAlignment = "left" | "center" | "right" | "justify";

const ALIGNMENTS = new Set<TableCellAlignment>(["left", "center", "right", "justify"]);

/** Returns a valid cell alignment, or `null`. */
export function normalizeTableCellAlignment(value: unknown): TableCellAlignment | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ALIGNMENTS.has(v as TableCellAlignment) ? (v as TableCellAlignment) : null;
}

/**
 * Color values allowed as a cell background: hex, `rgb()/rgba()/hsl()/hsla()`
 * with numeric arguments, or a CSS color keyword. Anything else (e.g.
 * `url(...)`, `expression(...)`, `;`) is rejected because the value ends up in
 * a `style` attribute.
 */
const COLOR_REGEX =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[-0-9.%\s,/deg]+\)|[a-z]{3,20})$/i;

/** Returns a safe CSS color for a cell background, or `null`. */
export function normalizeTableCellColor(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || v.length > 64 || !COLOR_REGEX.test(v)) return null;
  if (/^(?:inherit|initial|unset|revert|transparent)$/i.test(v)) return null;
  return v;
}

/** Cell attributes added on top of TipTap's `colspan` / `rowspan` / `colwidth`. */
const cellAttributes = () => ({
  align: {
    default: null,
    parseHTML: (element: HTMLElement) =>
      normalizeTableCellAlignment(element.style?.textAlign || element.getAttribute("align")),
    renderHTML: (attrs: Record<string, any>) => {
      const align = normalizeTableCellAlignment(attrs.align);
      return align ? { style: `text-align: ${align}` } : {};
    },
  },
  backgroundColor: {
    default: null,
    parseHTML: (element: HTMLElement) =>
      normalizeTableCellColor(
        element.getAttribute("data-background-color") ||
          element.style?.backgroundColor ||
          element.getAttribute("bgcolor"),
      ),
    renderHTML: (attrs: Record<string, any>) => {
      const color = normalizeTableCellColor(attrs.backgroundColor);
      return color ? { style: `background-color: ${color}`, "data-background-color": color } : {};
    },
  },
});

// ---------------------------------------------------------------------------
// Markdown (tiptap-markdown)
// ---------------------------------------------------------------------------

const children = (node: ProsemirrorNode) => {
  const list: ProsemirrorNode[] = [];
  node.forEach((child) => list.push(child));
  return list;
};

const hasSpan = (cell: ProsemirrorNode) => (cell.attrs.colspan ?? 1) > 1 || (cell.attrs.rowspan ?? 1) > 1;

/**
 * Whether a table can be written as a GFM pipe table: the first row is all
 * header cells, the other rows have none, no cell spans rows or columns, and
 * every cell holds a single paragraph.
 */
export function isGfmTable(node: ProsemirrorNode): boolean {
  const rows = children(node);
  if (rows.length === 0) return false;
  const width = rows[0].childCount;
  return rows.every(
    (row, r) =>
      row.childCount === width &&
      children(row).every(
        (cell) =>
          (r === 0 ? cell.type.name === "tableHeader" : cell.type.name === "tableCell") &&
          !hasSpan(cell) &&
          cell.childCount === 1 &&
          cell.firstChild!.type.name === "paragraph",
      ),
  );
}

const DELIMITERS: Record<string, string> = { left: ":---", center: ":---:", right: "---:" };

/**
 * tiptap-markdown serializer for tables: GFM pipe tables (with column
 * alignment from the header cells and `|` escaped) when `isGfmTable`, HTML
 * otherwise (spans, header columns, multi-paragraph cells).
 */
function serializeTableMarkdown(state: any, node: ProsemirrorNode) {
  if (!isGfmTable(node)) {
    const html = getHTMLFromFragment(Fragment.from(node), node.type.schema);
    // An HTML block must start on its own line and contain no blank lines.
    state.write(html.replace(/\n{2,}/g, "\n"));
    state.closeBlock(node);
    return;
  }
  const previous = state.inTable;
  state.inTable = true;
  children(node).forEach((row, r) => {
    if (r) state.ensureNewLine();
    state.write("| ");
    children(row).forEach((cell, c) => {
      if (c) state.write(" | ");
      const paragraph = cell.firstChild!;
      // Render in place (mid-line, so no block prefix is added), then escape
      // the cell's pipes and line breaks, which would end the cell or row.
      const start = state.out.length;
      if (paragraph.childCount) state.renderInline(paragraph);
      const text: string = state.out.slice(start);
      state.out = state.out.slice(0, start) + text.replace(/\n/g, " ").replace(/\|/g, "\\|");
    });
    state.write(" |");
    if (r === 0) {
      const delimiter = children(row).map((cell) => DELIMITERS[cell.attrs.align] ?? "---");
      state.ensureNewLine();
      state.write(`| ${delimiter.join(" | ")} |`);
    }
  });
  state.inTable = previous;
  state.closeBlock(node);
}

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

export interface RichTextTableOptions {
  /** Drag column borders to resize columns (stored as `colwidth`). Default `true`. */
  resizable: boolean;
  /** Width of the resize handle in pixels. Default 5. */
  handleWidth: number;
  /** Minimum cell width in pixels. Default 25. */
  cellMinWidth: number;
  /** Whether the last column can be resized. Default `true`. */
  lastColumnResizable: boolean;
  /** Allow selecting the whole table as a node (click its border, Esc from a cell selection). Default `true`. */
  allowTableNodeSelection: boolean;
  /** HTML attributes of the `<table>` element. */
  HTMLAttributes: Record<string, any>;
  /** HTML attributes of `<td>` elements. */
  cellHTMLAttributes: Record<string, any>;
  /** HTML attributes of `<th>` elements. */
  headerHTMLAttributes: Record<string, any>;
  /** HTML attributes of `<tr>` elements. */
  rowHTMLAttributes: Record<string, any>;
}

export const DEFAULT_TABLE_OPTIONS: RichTextTableOptions = {
  resizable: true,
  handleWidth: 5,
  cellMinWidth: 25,
  lastColumnResizable: true,
  allowTableNodeSelection: true,
  HTMLAttributes: { class: "pixerate-table" },
  cellHTMLAttributes: {},
  headerHTMLAttributes: {},
  rowHTMLAttributes: {},
};

/**
 * TipTap's `Table` with the GFM-aware markdown serializer and the nesting
 * guard (`createTableNestingPlugin`): tables are never pasted, imported or
 * inserted into table cells.
 */
export const Table = BaseTable.extend({
  addStorage() {
    return { markdown: { serialize: serializeTableMarkdown } };
  },
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), createTableNestingPlugin()];
  },
});

export const TableRow = BaseTableRow;

/** TipTap's `TableCell` plus `align` and `backgroundColor` attributes. */
export const TableCell = BaseTableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellAttributes() };
  },
});

/** TipTap's `TableHeader` plus `align` and `backgroundColor` attributes. */
export const TableHeader = BaseTableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellAttributes() };
  },
});

/**
 * The table extensions (`table`, `tableRow`, `tableHeader`, `tableCell`)
 * configured for rich documents: resizable columns, header rows, columns and
 * cells, `colspan` / `rowspan` from imported HTML, cell alignment and
 * background, table node selection and GFM markdown. `createRichTextPreset`
 * adds them unless `table: false`.
 */
export function createTableExtensions(options: Partial<RichTextTableOptions> = {}): Extensions {
  const o = { ...DEFAULT_TABLE_OPTIONS, ...options };
  return [
    Table.configure({
      resizable: o.resizable,
      handleWidth: o.handleWidth,
      cellMinWidth: o.cellMinWidth,
      lastColumnResizable: o.lastColumnResizable,
      allowTableNodeSelection: o.allowTableNodeSelection,
      HTMLAttributes: o.HTMLAttributes,
    }),
    TableRow.configure({ HTMLAttributes: o.rowHTMLAttributes }),
    TableHeader.configure({ HTMLAttributes: o.headerHTMLAttributes }),
    TableCell.configure({ HTMLAttributes: o.cellHTMLAttributes }),
  ];
}
