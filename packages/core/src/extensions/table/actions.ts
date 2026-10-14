import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { CellSelection, isInTable, selectedRect } from "@tiptap/pm/tables";
import { isTrackChangesEnabled } from "../track-changes";
import {
  normalizeTableCellAlignment,
  normalizeTableCellColor,
  type TableCellAlignment,
} from "./extension";

/** Table operations shared by the command registry, the toolbars and agent tools. */
export type TableAction =
  | "insertTable"
  | "addRowBefore"
  | "addRowAfter"
  | "deleteRow"
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteColumn"
  | "deleteTable"
  | "mergeCells"
  | "splitCell"
  | "toggleHeaderRow"
  | "toggleHeaderColumn"
  | "toggleHeaderCell"
  | "goToNextCell"
  | "goToPreviousCell"
  | "setCellAlignment"
  | "setCellBackground";

/** Parameters of `insertTable`, `setCellAlignment` and `setCellBackground`. */
export interface TableActionParams {
  /** `insertTable`: number of rows (1–100, default 3). */
  rows?: number;
  /** `insertTable`: number of columns (1–50, default 3). */
  cols?: number;
  /** `insertTable`: make the first row a header row (default `true`). */
  withHeaderRow?: boolean;
  /** `setCellAlignment`: `left`, `center`, `right`, `justify`, or `null` to clear. */
  align?: TableCellAlignment | null;
  /** `setCellBackground`: a CSS color, or `null` to clear. */
  color?: string | null;
}

export interface TableActionInfo {
  action: TableAction;
  label: string;
  description: string;
  keywords: readonly string[];
}

/** Every table action with its label, in toolbar order. */
export const TABLE_ACTIONS: readonly TableActionInfo[] = [
  { action: "insertTable", label: "Insert Table", description: "Inserts a table (rows, cols, withHeaderRow) at the cursor.", keywords: ["table", "grid", "new"] },
  { action: "addRowBefore", label: "Insert Row Above", description: "Adds a row above the current row.", keywords: ["row", "add", "above"] },
  { action: "addRowAfter", label: "Insert Row Below", description: "Adds a row below the current row.", keywords: ["row", "add", "below"] },
  { action: "deleteRow", label: "Delete Row", description: "Deletes the selected rows.", keywords: ["row", "remove"] },
  { action: "addColumnBefore", label: "Insert Column Left", description: "Adds a column left of the current column.", keywords: ["column", "add", "left", "before"] },
  { action: "addColumnAfter", label: "Insert Column Right", description: "Adds a column right of the current column.", keywords: ["column", "add", "right", "after"] },
  { action: "deleteColumn", label: "Delete Column", description: "Deletes the selected columns.", keywords: ["column", "remove"] },
  { action: "deleteTable", label: "Delete Table", description: "Deletes the table around the cursor.", keywords: ["table", "remove"] },
  { action: "mergeCells", label: "Merge Cells", description: "Merges the selected cells into one.", keywords: ["combine", "join", "span"] },
  { action: "splitCell", label: "Split Cell", description: "Splits a merged cell back into single cells.", keywords: ["unmerge", "span"] },
  { action: "toggleHeaderRow", label: "Toggle Header Row", description: "Turns the first row into header cells, or back.", keywords: ["header", "row", "th"] },
  { action: "toggleHeaderColumn", label: "Toggle Header Column", description: "Turns the first column into header cells, or back.", keywords: ["header", "column", "th"] },
  { action: "toggleHeaderCell", label: "Toggle Header Cell", description: "Turns the selected cells into header cells, or back.", keywords: ["header", "cell", "th"] },
  { action: "goToNextCell", label: "Next Cell", description: "Moves the cursor to the next cell.", keywords: ["tab", "navigate"] },
  { action: "goToPreviousCell", label: "Previous Cell", description: "Moves the cursor to the previous cell.", keywords: ["shift tab", "navigate"] },
  { action: "setCellAlignment", label: "Align Cells…", description: "Sets the horizontal alignment (align: left | center | right | justify | null) of the selected cells.", keywords: ["align", "left", "center", "right"] },
  { action: "setCellBackground", label: "Cell Background…", description: "Sets the background color (color: CSS color or null) of the selected cells.", keywords: ["shading", "fill", "color"] },
];

/** A button of the table toolbars (`TableToolbar` in React and Svelte). */
export interface TableToolbarItem {
  /** Unique id (also the button's `data-action`). */
  id: string;
  action: TableAction;
  params?: TableActionParams;
  /** Short button text. */
  label: string;
  /** Accessible name and tooltip. */
  title: string;
  /** Items of one group are separated from the next group. */
  group: string;
  /** Toggle buttons: whether the button shows as pressed. */
  active?: (state: TableState) => boolean;
}

/** The default table toolbar: rows, columns, cells, headers, alignment, delete. */
export const DEFAULT_TABLE_TOOLBAR: readonly TableToolbarItem[] = [
  { id: "addRowBefore", action: "addRowBefore", label: "+ Row ↑", title: "Insert row above", group: "rows" },
  { id: "addRowAfter", action: "addRowAfter", label: "+ Row ↓", title: "Insert row below", group: "rows" },
  { id: "deleteRow", action: "deleteRow", label: "− Row", title: "Delete row", group: "rows" },
  { id: "addColumnBefore", action: "addColumnBefore", label: "+ Col ←", title: "Insert column left", group: "columns" },
  { id: "addColumnAfter", action: "addColumnAfter", label: "+ Col →", title: "Insert column right", group: "columns" },
  { id: "deleteColumn", action: "deleteColumn", label: "− Col", title: "Delete column", group: "columns" },
  { id: "mergeCells", action: "mergeCells", label: "Merge", title: "Merge cells", group: "cells" },
  { id: "splitCell", action: "splitCell", label: "Split", title: "Split cell", group: "cells" },
  { id: "toggleHeaderRow", action: "toggleHeaderRow", label: "Header row", title: "Toggle header row", group: "headers", active: (s) => s.headerRow },
  { id: "toggleHeaderColumn", action: "toggleHeaderColumn", label: "Header col", title: "Toggle header column", group: "headers", active: (s) => s.headerColumn },
  { id: "toggleHeaderCell", action: "toggleHeaderCell", label: "Header cell", title: "Toggle header cell", group: "headers", active: (s) => s.headerCell },
  { id: "alignLeft", action: "setCellAlignment", params: { align: "left" }, label: "Left", title: "Align cell left", group: "align", active: (s) => s.cellAlignment === "left" },
  { id: "alignCenter", action: "setCellAlignment", params: { align: "center" }, label: "Center", title: "Align cell center", group: "align", active: (s) => s.cellAlignment === "center" },
  { id: "alignRight", action: "setCellAlignment", params: { align: "right" }, label: "Right", title: "Align cell right", group: "align", active: (s) => s.cellAlignment === "right" },
  { id: "deleteTable", action: "deleteTable", label: "Delete table", title: "Delete table", group: "table" },
];

export const MAX_TABLE_ROWS = 100;
export const MAX_TABLE_COLUMNS = 50;

const live = (editor: Editor | null | undefined): editor is Editor => !!editor && !editor.isDestroyed;

/** Whether the editor's schema has the table nodes (`createRichTextPreset({ table })`). */
export function isTableEnabled(editor: Editor | null | undefined): boolean {
  return live(editor) && !!editor.schema.nodes.table && !!editor.schema.nodes.tableRow;
}

/** Whether the selection (cursor, text or cell selection) is inside a table. */
export function isSelectionInTable(state: EditorState): boolean {
  if (!state.schema.nodes.table) return false;
  return state.selection instanceof CellSelection || isInTable(state);
}

/**
 * `shouldShow` for a table bubble menu (TipTap's `BubbleMenuPlugin`): shown
 * while an editable editor's selection is in a table, even a collapsed cursor.
 */
export function shouldShowTableBubbleMenu({ editor, state }: { editor: Editor; state: EditorState }): boolean {
  return editor.isEditable && isSelectionInTable(state);
}

const isInt = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const can = (editor: Editor, run: (chain: any) => any): boolean => {
  try {
    return !!run(editor.can().chain()).run();
  } catch {
    return false;
  }
};

/**
 * Whether a table action can run: `true`, or the reason it cannot (e.g.
 * "Place the cursor in a table first.").
 */
export function getTableActionState(
  editor: Editor | null | undefined,
  action: TableAction,
  params: TableActionParams = {},
): true | string {
  if (!live(editor)) return "The editor is not available.";
  if (!isTableEnabled(editor)) return "Tables are not enabled in this editor.";
  if (!editor.isEditable) return "The editor is read-only.";
  const state = editor.state;
  const inTable = isSelectionInTable(state);

  if (action === "insertTable") {
    if (inTable) return "Tables cannot be nested: move the cursor out of the table first.";
    if (params.rows !== undefined && !isInt(params.rows, 1, MAX_TABLE_ROWS)) {
      return `Rows must be a whole number from 1 to ${MAX_TABLE_ROWS}.`;
    }
    if (params.cols !== undefined && !isInt(params.cols, 1, MAX_TABLE_COLUMNS)) {
      return `Columns must be a whole number from 1 to ${MAX_TABLE_COLUMNS}.`;
    }
    return can(editor, (c) => c.insertTable({ rows: 1, cols: 1 })) ? true : "A table cannot be inserted here.";
  }

  if (!inTable) return "Place the cursor in a table first.";

  switch (action) {
    case "mergeCells":
    case "splitCell": {
      if (isTrackChangesEnabled(editor)) {
        return `${action === "mergeCells" ? "Merging" : "Splitting"} cells cannot be tracked: turn off Track Changes first.`;
      }
      if (action === "mergeCells") {
        return can(editor, (c) => c.mergeCells()) ? true : "Select two or more adjacent cells to merge.";
      }
      return can(editor, (c) => c.splitCell()) ? true : "Only a merged cell can be split.";
    }
    case "deleteRow":
    case "deleteColumn": {
      // prosemirror-tables only refuses to delete every row/column when dispatching.
      const rect = selectedRect(state);
      const all = action === "deleteRow"
        ? rect.top === 0 && rect.bottom === rect.map.height
        : rect.left === 0 && rect.right === rect.map.width;
      const what = action === "deleteRow" ? "rows" : "columns";
      if (all || !can(editor, (c) => c[action]())) return `These are all the ${what}: delete the table instead.`;
      return true;
    }
    case "goToNextCell":
      return can(editor, (c) => c.goToNextCell()) ? true : "This is the last cell.";
    case "goToPreviousCell":
      return can(editor, (c) => c.goToPreviousCell()) ? true : "This is the first cell.";
    case "setCellAlignment":
      if (params.align !== undefined && params.align !== null && !normalizeTableCellAlignment(params.align)) {
        return 'Alignment must be "left", "center", "right", "justify" or null.';
      }
      if (!editor.schema.nodes.tableCell?.spec.attrs?.align) return "Cell alignment is not supported by this schema.";
      return true;
    case "setCellBackground":
      if (params.color !== undefined && params.color !== null && !normalizeTableCellColor(params.color)) {
        return "Color must be a CSS color such as #fde68a, rgb(…) or a color name, or null.";
      }
      if (!editor.schema.nodes.tableCell?.spec.attrs?.backgroundColor) return "Cell backgrounds are not supported by this schema.";
      return true;
    default:
      return can(editor, (c) => c[action]()) ? true : "This table action is not available here.";
  }
}

export interface RunTableActionOptions {
  /** Focus the editor (toolbars). Default `false`. */
  focus?: boolean;
}

/**
 * Runs a table action. Returns `false` (and changes nothing) when it cannot
 * run; check `getTableActionState` for the reason.
 */
export function runTableAction(
  editor: Editor | null | undefined,
  action: TableAction,
  params: TableActionParams = {},
  options: RunTableActionOptions = {},
): boolean {
  if (getTableActionState(editor, action, params) !== true) return false;
  const ed = editor as Editor;
  let chain: any = ed.chain();
  if (options.focus) chain = chain.focus();
  switch (action) {
    case "insertTable":
      chain = chain.insertTable({
        rows: params.rows ?? 3,
        cols: params.cols ?? 3,
        withHeaderRow: params.withHeaderRow ?? true,
      });
      break;
    case "setCellAlignment":
      chain = chain.setCellAttribute("align", normalizeTableCellAlignment(params.align));
      break;
    case "setCellBackground":
      chain = chain.setCellAttribute("backgroundColor", normalizeTableCellColor(params.color));
      break;
    default:
      chain = chain[action]();
  }
  return !!chain.run();
}

export interface TableActionStatus {
  enabled: boolean;
  /** Why the action cannot run (only when `enabled` is false). */
  reason?: string;
}

/** The table at the selection and what can be done there. */
export interface TableState {
  /** The schema has tables. */
  enabled: boolean;
  /** The selection is inside a table. */
  inTable: boolean;
  /** Cells are selected (a `CellSelection`). */
  cellSelection: boolean;
  /** Size of the table (0 outside a table). */
  rows: number;
  columns: number;
  /** Row and column (0-based) of the selection's first cell, or -1. */
  row: number;
  column: number;
  /** The first row / first column are all header cells. */
  headerRow: boolean;
  headerColumn: boolean;
  /** The cell at the selection is a header cell. */
  headerCell: boolean;
  /** Alignment / background of the cell at the selection. */
  cellAlignment: TableCellAlignment | null;
  cellBackground: string | null;
  /** Enablement of every action (with the default params). */
  actions: Record<TableAction, TableActionStatus>;
}

const NO_ACTIONS = Object.fromEntries(
  TABLE_ACTIONS.map(({ action }) => [action, { enabled: false, reason: "The editor is not available." }]),
) as Record<TableAction, TableActionStatus>;

export const EMPTY_TABLE_STATE: TableState = Object.freeze({
  enabled: false,
  inTable: false,
  cellSelection: false,
  rows: 0,
  columns: 0,
  row: -1,
  column: -1,
  headerRow: false,
  headerColumn: false,
  headerCell: false,
  cellAlignment: null,
  cellBackground: null,
  actions: NO_ACTIONS,
}) as TableState;

/** Computes the table state at the editor's selection. */
export function getTableState(editor: Editor | null | undefined): TableState {
  if (!live(editor)) return EMPTY_TABLE_STATE;
  const actions = Object.fromEntries(
    TABLE_ACTIONS.map(({ action }) => {
      const result = getTableActionState(editor, action);
      return [action, result === true ? { enabled: true } : { enabled: false, reason: result }];
    }),
  ) as Record<TableAction, TableActionStatus>;
  const state = editor.state;
  const base: TableState = { ...EMPTY_TABLE_STATE, enabled: isTableEnabled(editor), actions };
  if (!base.enabled || !isSelectionInTable(state)) return base;
  try {
    const rect = selectedRect(state);
    const { map, table } = rect;
    const cellAt = (row: number, col: number) => table.nodeAt(map.map[row * map.width + col]);
    const allHeaders = (positions: number[]) =>
      positions.length > 0 && positions.every((pos) => table.nodeAt(pos)?.type.name === "tableHeader");
    const firstRow = map.cellsInRect({ left: 0, right: map.width, top: 0, bottom: 1 });
    const firstColumn = map.cellsInRect({ left: 0, right: 1, top: 0, bottom: map.height });
    const cell = cellAt(rect.top, rect.left);
    return {
      ...base,
      inTable: true,
      cellSelection: state.selection instanceof CellSelection,
      rows: map.height,
      columns: map.width,
      row: rect.top,
      column: rect.left,
      headerRow: allHeaders(firstRow),
      headerColumn: allHeaders(firstColumn),
      headerCell: cell?.type.name === "tableHeader",
      cellAlignment: normalizeTableCellAlignment(cell?.attrs.align),
      cellBackground: normalizeTableCellColor(cell?.attrs.backgroundColor),
    };
  } catch {
    return { ...base, inTable: true };
  }
}

const stateKey = (state: TableState) => JSON.stringify(state);

export interface TableStore {
  getSnapshot(): TableState;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

/**
 * An external store of `getTableState(editor)` for UI bindings (React's
 * `useSyncExternalStore`, Svelte runes). The snapshot object only changes
 * when the state does, and the store listens to the editor only while it
 * has subscribers.
 */
export function createTableStore(editor: Editor | null | undefined): TableStore {
  const listeners = new Set<() => void>();
  let snapshot = getTableState(editor);
  let key = stateKey(snapshot);

  const update = () => {
    const next = getTableState(editor);
    const nextKey = stateKey(next);
    if (nextKey === key) return;
    snapshot = next;
    key = nextKey;
    listeners.forEach((listener) => listener());
  };
  const detach = () => {
    editor?.off("transaction", update);
    editor?.off("update", update);
    editor?.off("focus", update);
    editor?.off("destroy", update);
  };

  return {
    getSnapshot: () => {
      if (!listeners.size) {
        const next = getTableState(editor);
        const nextKey = stateKey(next);
        if (nextKey !== key) {
          snapshot = next;
          key = nextKey;
        }
      }
      return snapshot;
    },
    subscribe(listener) {
      if (!listeners.size && editor) {
        update();
        editor.on("transaction", update);
        // `setEditable` emits `update` without a transaction.
        editor.on("update", update);
        editor.on("focus", update);
        editor.on("destroy", update);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) detach();
      };
    },
    destroy() {
      detach();
      listeners.clear();
    },
  };
}
