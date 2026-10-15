import { Fragment, Slice, type Node as ProsemirrorNode, type ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  CellSelection,
  __pastedCells,
  handlePaste as handleTablePaste,
} from "@tiptap/pm/tables";

/**
 * Set this meta on a transaction to let it create tables inside table cells
 * (the nesting guard leaves it alone), e.g. when loading legacy content
 * through a transaction that does not replace the whole document.
 */
export const ALLOW_NESTED_TABLES_META = "allowNestedTables";

export const tableNestingPluginKey = new PluginKey("tableNesting");

const roleOf = (node: ProsemirrorNode) => node.type.spec.tableRole as string | undefined;
const isTableNode = (node: ProsemirrorNode) => roleOf(node) === "table";

/** Depth of the outermost table around `$pos`, or `-1` outside tables. */
export function outermostTableDepth($pos: ResolvedPos): number {
  for (let d = 1; d <= $pos.depth; d++) if (isTableNode($pos.node(d))) return d;
  return -1;
}

/** Whether `$pos` lies inside a table cell or header cell. */
export function isInTableCell($pos: ResolvedPos): boolean {
  for (let d = $pos.depth; d > 0; d--) {
    const role = roleOf($pos.node(d));
    if (role === "cell" || role === "header_cell") return true;
  }
  return false;
}

/** Whether a slice or fragment contains a table node at any depth. */
export function sliceContainsTable(content: Slice | Fragment): boolean {
  const fragment = content instanceof Slice ? content.content : content;
  let found = false;
  fragment.descendants((node) => {
    if (found) return false;
    if (isTableNode(node)) found = true;
    return !found;
  });
  return found;
}

/**
 * Inserts `slice` right after the outermost table around `from` instead of
 * inside the cell, deleting `from`–`to` first when both lie in that table.
 * Returns the position right after the inserted content, or `null` (and
 * leaves `tr` unchanged) when `from` is not in a table.
 */
export function insertSliceAfterTable(tr: Transaction, from: number, to: number, slice: Slice): number | null {
  const $from = tr.doc.resolve(from);
  const depth = outermostTableDepth($from);
  if (depth < 0) return null;
  const tableStart = $from.before(depth);
  const tableEnd = $from.after(depth);
  if (to > from && to < tableEnd) {
    if (tr.selection instanceof CellSelection && tr.selection.from === from && tr.selection.to === to) {
      tr.deleteSelection();
    } else {
      tr.delete(from, to);
    }
  }
  const table = tr.doc.nodeAt(tableStart);
  if (!table) return null;
  const after = tableStart + table.nodeSize;
  const before = tr.doc.content.size;
  // A closed slice: the content becomes blocks of its own after the table
  // instead of merging into whatever follows it.
  tr.replace(after, after, new Slice(slice.content, 0, 0));
  return after + (tr.doc.content.size - before);
}

/**
 * Paste handling for slices that contain a table while the selection is in a
 * table: a cell selection or a pasted table (rows, cells) fills the cells from
 * the cursor (prosemirror-tables), and anything else that contains a table is
 * inserted after the outermost table, with the cursor at its end. Returns
 * `false` when the paste needs no special handling.
 */
export function handleTablePasteWithoutNesting(view: EditorView, event: ClipboardEvent | null, slice: Slice): boolean {
  const { state } = view;
  const { selection } = state;
  if (outermostTableDepth(selection.$from) < 0) return false;
  if (selection instanceof CellSelection || __pastedCells(slice)) {
    if (handleTablePaste(view, event as ClipboardEvent, slice)) return true;
  }
  if (!sliceContainsTable(slice)) return false;
  const tr = state.tr;
  const end = insertSliceAfterTable(tr, selection.from, selection.to, slice);
  if (end === null) return false;
  tr.setSelection(Selection.near(tr.doc.resolve(end), -1));
  view.dispatch(tr.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
  return true;
}

/**
 * Ranges of the final document that `transactions` changed, leaving out the
 * changes of skipped transactions (their steps still map the other ranges).
 */
function changedRanges(transactions: readonly Transaction[], skip: (tr: Transaction) => boolean): [number, number][] {
  let ranges: [number, number][] = [];
  for (const tr of transactions) {
    const skipped = skip(tr);
    for (const step of tr.steps) {
      const map = step.getMap();
      // Content that later (skipped) steps insert at a range's edge is not
      // part of it; pure deletions leave nothing to check.
      ranges = ranges
        .map(([from, to]): [number, number] => [map.map(from, 1), map.map(to, -1)])
        .filter(([from, to]) => to > from);
      if (skipped) continue;
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        if (newEnd > newStart) ranges.push([newStart, newEnd]);
      });
    }
  }
  return ranges;
}

/** Tables starting inside `ranges` that sit in a table cell. */
function findNestedTables(doc: ProsemirrorNode, ranges: [number, number][]): number[] {
  const found = new Set<number>();
  for (const [from, to] of ranges) {
    doc.nodesBetween(from, to, (node, pos) => {
      if (!isTableNode(node) || pos < from) return true;
      if (isInTableCell(doc.resolve(pos))) {
        found.add(pos);
        return false;
      }
      return true;
    });
  }
  // A table inside another found table moves with it.
  const sorted = [...found].sort((a, b) => a - b);
  const outer: number[] = [];
  for (const pos of sorted) {
    const last = outer[outer.length - 1];
    if (last === undefined || pos >= last + doc.nodeAt(last)!.nodeSize) outer.push(pos);
  }
  return outer;
}

/**
 * Moves tables that sit in table cells (at positions in `ranges`) to right
 * after their outermost table, keeping their content, and repeats for tables
 * nested in the moved ones. A cell left without content gets an empty
 * paragraph. Returns whether `tr` changed.
 */
export function unnestTables(tr: Transaction, ranges: [number, number][]): boolean {
  let changed = false;
  for (let round = 0; round < 32 && ranges.length; round++) {
    const nested = findNestedTables(tr.doc, ranges);
    if (!nested.length) break;
    // Group by outermost table; handle later tables first so earlier
    // positions stay valid.
    const groups = new Map<number, number[]>();
    for (const pos of nested) {
      const $pos = tr.doc.resolve(pos);
      const outer = $pos.before(outermostTableDepth($pos));
      groups.set(outer, [...(groups.get(outer) ?? []), pos]);
    }
    const next: [number, number][] = [];
    for (const outer of [...groups.keys()].sort((a, b) => b - a)) {
      const positions = groups.get(outer)!;
      const nodes = positions.map((pos) => tr.doc.nodeAt(pos)!);
      for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i];
        const node = nodes[i];
        const $pos = tr.doc.resolve(pos);
        const parent = $pos.parent;
        const filler = parent.childCount === 1 ? parent.type.contentMatch.defaultType?.createAndFill() : null;
        if (filler) tr.replaceWith(pos, pos + node.nodeSize, filler);
        else tr.delete(pos, pos + node.nodeSize);
      }
      const table = tr.doc.nodeAt(outer)!;
      const after = outer + table.nodeSize;
      const fragment = Fragment.fromArray(nodes);
      tr.insert(after, fragment);
      // Later groups are before this one, so this range stays valid.
      next.push([after, after + fragment.size]);
      changed = true;
    }
    ranges = next;
  }
  return changed;
}

/**
 * Whether a transaction replaces the whole document (`setContent`, loading):
 * existing documents keep their nested tables.
 */
function replacesDocument(tr: Transaction): boolean {
  return tr.steps.some((step, i) => {
    const { from, to } = step as unknown as { from?: number; to?: number };
    return from === 0 && to !== undefined && to >= tr.docs[i].content.size;
  });
}

const skip = (tr: Transaction) =>
  !tr.docChanged ||
  tr.getMeta(ALLOW_NESTED_TABLES_META) === true ||
  // Undo/redo and remote collaborative changes restore what was there.
  !!tr.getMeta("history$") ||
  !!tr.getMeta("y-sync$") ||
  // Other plugins' housekeeping, e.g. Track Changes putting a deleted
  // (nested) table back so the deletion can be reviewed.
  !!tr.getMeta("appendedTransaction") ||
  replacesDocument(tr);

/**
 * Keeps tables out of table cells: paste handling (see
 * `handleTablePasteWithoutNesting`) plus a guard that moves any table a
 * local edit puts into a cell (`insertContent`, `insertTable`, drops) to
 * right after the outermost table. Documents that already contain nested
 * tables (initial content, `setContent`, undo/redo, collaboration, Track
 * Changes restoring a deleted table) are left as they are.
 */
export function createTableNestingPlugin(): Plugin {
  return new Plugin({
    key: tableNestingPluginKey,
    props: {
      handlePaste: (view, event, slice) => handleTablePasteWithoutNesting(view, event, slice),
    },
    appendTransaction(transactions, _oldState, newState) {
      if (transactions.every(skip)) return null;
      const ranges = changedRanges(transactions, skip);
      if (!ranges.length) return null;
      const tr = newState.tr;
      if (!unnestTables(tr, ranges)) return null;
      return tr;
    },
  });
}
