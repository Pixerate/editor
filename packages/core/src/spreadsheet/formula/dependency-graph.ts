// Portions ported from gridcraft/crates/calc/src/recalc.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { ASTNode, parseFormula, WHOLE_COLUMN_END_ROW } from './parser';
import { colNameToIndex, indexToColName } from './evaluator';

export interface CellDep {
  col: string;
  /** Row number; 0 for a whole-column dependency (`A:A`). */
  row: number;
  /** Sheet of a sheet-qualified reference (`Sheet2!A1`); unset for the formula's own sheet. */
  sheet?: string;
  /** Last sheet of a 3-D reference (`Sheet1:Sheet3!A1`). */
  sheetEnd?: string;
}

/** A name used by a formula: a defined name, LET/LAMBDA variable or (with `call`) a function. */
export interface NameDep {
  /** Upper-case name. */
  name: string;
  /** Sheet of a sheet-qualified name (`Data!Rate`). */
  sheet?: string;
  /** Used as a function (`Double(4)`). */
  call: boolean;
}

/**
 * Names a formula uses (bare names and calls), for dependencies on defined
 * names. LET/LAMBDA variables are included; callers ignore names that are
 * not defined.
 */
export function extractNameDependencies(node: ASTNode): NameDep[] {
  const names: NameDep[] = [];
  const stack: ASTNode[] = [node];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    switch (curr.type) {
      case 'Name':
        names.push(curr.sheet === undefined ? { name: curr.name, call: false } : { name: curr.name, sheet: curr.sheet, call: false });
        break;
      case 'FunctionCall':
        names.push({ name: curr.name, call: true });
        for (const arg of curr.args) stack.push(arg);
        break;
      case 'Invoke':
        stack.push(curr.callee);
        for (const arg of curr.args) stack.push(arg);
        break;
      case 'BinaryOp':
        stack.push(curr.left, curr.right);
        break;
      case 'UnaryOp':
        stack.push(curr.argument);
        break;
      default:
        break;
    }
  }
  return names;
}

/**
 * Dependency key for "every cell in column `col`", used by whole-column ranges
 * (`A:A`) instead of expanding a million cell keys.
 */
export const columnDependencyKey = (col: string): string => `${col.toUpperCase()}:`;

export function extractCellDependencies(node: ASTNode): CellDep[] {
  const deps: CellDep[] = [];

  const visit = (curr: ASTNode) => {
    const sheet: Pick<CellDep, 'sheet' | 'sheetEnd'> =
      'sheet' in curr && curr.sheet !== undefined
        ? 'sheetEnd' in curr && curr.sheetEnd !== undefined
          ? { sheet: curr.sheet, sheetEnd: curr.sheetEnd }
          : { sheet: curr.sheet }
        : {};
    if (curr.type === 'CellRef') {
      deps.push({ col: curr.col, row: curr.row, ...sheet });
    } else if (curr.type === 'SpillRef') {
      // A1# is computed by A1: depending on the anchor orders it correctly.
      deps.push({ col: curr.col, row: curr.row, ...sheet });
    } else if (curr.type === 'Range' && curr.endRow >= WHOLE_COLUMN_END_ROW) {
      // Whole-column range: depend on the columns, not on every cell.
      const startC = colNameToIndex(curr.startCol);
      const endC = colNameToIndex(curr.endCol);
      for (let c = Math.min(startC, endC); c <= Math.max(startC, endC); c++) {
        deps.push({ col: indexToColName(c), row: 0, ...sheet });
      }
    } else if (curr.type === 'Range') {
      const startC = colNameToIndex(curr.startCol);
      const endC = colNameToIndex(curr.endCol);
      const minC = Math.min(startC, endC);
      const maxC = Math.max(startC, endC);
      const minR = Math.min(curr.startRow, curr.endRow);
      const maxR = Math.max(curr.startRow, curr.endRow);

      for (let c = minC; c <= maxC; c++) {
        for (let r = minR; r <= maxR; r++) {
          deps.push({ col: indexToColName(c), row: r, ...sheet });
        }
      }
    } else if (curr.type === 'BinaryOp') {
      visit(curr.left);
      visit(curr.right);
    } else if (curr.type === 'UnaryOp') {
      visit(curr.argument);
    } else if (curr.type === 'FunctionCall') {
      curr.args.forEach(visit);
    } else if (curr.type === 'Invoke') {
      visit(curr.callee);
      curr.args.forEach(visit);
    }
  };

  visit(node);
  return deps;
}


/**
 * A reference a formula reads, without expanding ranges: a single cell or
 * a rectangle (`A1:B9`; a whole column `A:A` runs to `WHOLE_COLUMN_END_ROW`).
 * Columns are letters, rows are 1-based; ranges are normalised (start ≤ end).
 */
export type ReferenceDep =
  | ({ kind: 'cell'; col: string; row: number } & Pick<CellDep, 'sheet' | 'sheetEnd'>)
  | ({ kind: 'range'; startCol: string; startRow: number; endCol: string; endRow: number } & Pick<
      CellDep,
      'sheet' | 'sheetEnd'
    >);

/**
 * The cells and ranges a formula reads, ranges kept whole (unlike
 * `extractCellDependencies`, which lists every cell of a range). `A1#`
 * depends on its anchor `A1`.
 */
export function extractReferenceDependencies(node: ASTNode): ReferenceDep[] {
  const deps: ReferenceDep[] = [];
  const stack: ASTNode[] = [node];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    const sheet: Pick<CellDep, 'sheet' | 'sheetEnd'> =
      'sheet' in curr && curr.sheet !== undefined
        ? 'sheetEnd' in curr && curr.sheetEnd !== undefined
          ? { sheet: curr.sheet, sheetEnd: curr.sheetEnd }
          : { sheet: curr.sheet }
        : {};
    switch (curr.type) {
      case 'CellRef':
      case 'SpillRef':
        deps.push({ kind: 'cell', col: curr.col.toUpperCase(), row: curr.row, ...sheet });
        break;
      case 'Range': {
        const startC = colNameToIndex(curr.startCol);
        const endC = colNameToIndex(curr.endCol);
        const whole = curr.endRow >= WHOLE_COLUMN_END_ROW;
        deps.push({
          kind: 'range',
          startCol: indexToColName(Math.min(startC, endC)),
          endCol: indexToColName(Math.max(startC, endC)),
          startRow: whole ? 1 : Math.min(curr.startRow, curr.endRow),
          endRow: whole ? WHOLE_COLUMN_END_ROW : Math.max(curr.startRow, curr.endRow),
          ...sheet,
        });
        break;
      }
      case 'BinaryOp':
        stack.push(curr.right, curr.left);
        break;
      case 'UnaryOp':
        stack.push(curr.argument);
        break;
      case 'FunctionCall':
        for (let i = curr.args.length - 1; i >= 0; i--) stack.push(curr.args[i]);
        break;
      case 'Invoke':
        for (let i = curr.args.length - 1; i >= 0; i--) stack.push(curr.args[i]);
        stack.push(curr.callee);
        break;
      default:
        break;
    }
  }
  return deps;
}

/**
 * Dependency key of a rectangle (`A1:B9`, or `SHEET!A1:B9` with a sheet
 * prefix), for `DependencyGraph.setCellDependencies`. The graph stores it as
 * one range, however many cells it covers.
 */
export function rangeDependencyKey(startCol: string, startRow: number, endCol: string, endRow: number, sheetPrefix = ''): string {
  const prefix = sheetPrefix === '' ? '' : `${sheetPrefix}!`;
  return `${prefix}${startCol}${startRow}:${endCol}${endRow}`.toUpperCase();
}

// --- Range index (after gridcraft's calc/src/recalc.rs `Intervals`) -------

/** Ranges wider than this many columns go to the per-sheet wide index instead of per-column ones. */
const WIDE_RANGE_COLUMNS = 64;
/** Insertions an `IntervalIndex` keeps aside (scanned by every query) before merging them in. */
const PENDING_INTERVALS = 32;

interface IntervalEntry<T> {
  r0: number;
  r1: number;
  id: string;
  payload: T;
}

/**
 * Row intervals `[r0, r1]` with payloads, answering "which intervals overlap
 * rows `a..b`?" in O(log n + k). Entries are sorted by start, with an
 * implicit segment tree of the largest end below each node, so a query only
 * descends into subtrees holding a match. Removals mark entries dead;
 * insertions wait in a small pending set. Both are merged in (on the next
 * query) once either grows, so mutations cost O(log n) amortised.
 */
export class IntervalIndex<T> {
  private items: IntervalEntry<T>[] = [];
  private dead: Uint8Array = new Uint8Array(0);
  private deadCount = 0;
  private maxEnd: Float64Array = new Float64Array(0);
  private leaves = 0;
  private position = new Map<string, number>();
  private pending = new Map<string, IntervalEntry<T>>();

  /** Live entries. */
  get size(): number {
    return this.items.length - this.deadCount + this.pending.size;
  }

  /** Adds (or revives) the entry `id`. An id always names the same interval. */
  insert(r0: number, r1: number, id: string, payload: T): void {
    const at = this.position.get(id);
    if (at !== undefined) {
      if (this.dead[at]) {
        this.dead[at] = 0;
        this.deadCount--;
        this.items[at].payload = payload;
      }
      return;
    }
    this.pending.set(id, { r0, r1, id, payload });
  }

  remove(id: string): void {
    const at = this.position.get(id);
    if (at !== undefined) {
      if (!this.dead[at]) {
        this.dead[at] = 1;
        this.deadCount++;
      }
      return;
    }
    this.pending.delete(id);
  }

  /** Merges pending insertions and drops dead entries when there are enough of them. */
  private settle(): void {
    if (this.pending.size <= PENDING_INTERVALS && this.deadCount <= Math.max(this.items.length / 2, PENDING_INTERVALS)) return;
    const all: IntervalEntry<T>[] = [];
    this.items.forEach((item, i) => {
      if (!this.dead[i]) all.push(item);
    });
    for (const item of this.pending.values()) all.push(item);
    all.sort((a, b) => a.r0 - b.r0 || a.r1 - b.r1 || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let leaves = 1;
    while (leaves < all.length) leaves *= 2;
    const maxEnd = new Float64Array(2 * leaves).fill(-1);
    all.forEach((item, i) => {
      maxEnd[leaves + i] = item.r1;
    });
    for (let i = leaves - 1; i >= 1; i--) maxEnd[i] = Math.max(maxEnd[2 * i], maxEnd[2 * i + 1]);
    this.items = all;
    this.dead = new Uint8Array(all.length);
    this.deadCount = 0;
    this.maxEnd = maxEnd;
    this.leaves = leaves;
    this.position = new Map(all.map((item, i) => [item.id, i]));
    this.pending = new Map();
  }

  /** Calls `fn` for every live interval overlapping rows `a..b` (`r0 <= b && r1 >= a`). */
  query(a: number, b: number, fn: (payload: T, entry: IntervalEntry<T>) => void): void {
    this.settle();
    for (const item of this.pending.values()) {
      if (item.r0 <= b && item.r1 >= a) fn(item.payload, item);
    }
    // Entries before `p` start at or before row `b`.
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.items[mid].r0 <= b) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return;
    this.walk(1, 0, this.leaves, lo, a, fn);
  }

  private walk(node: number, lo: number, hi: number, p: number, a: number, fn: (payload: T, entry: IntervalEntry<T>) => void): void {
    if (lo >= p || this.maxEnd[node] < a) return;
    if (hi - lo <= 1) {
      const item = this.items[lo];
      if (item && !this.dead[lo] && item.r1 >= a) fn(item.payload, item);
      return;
    }
    const mid = lo + ((hi - lo) >>> 1);
    this.walk(2 * node, lo, mid, p, a, fn);
    this.walk(2 * node + 1, mid, hi, p, a, fn);
  }
}

/** A parsed graph key: a cell, a rectangle, or (`opaque`) a key that names no cell. */
type ParsedKey =
  | { kind: 'cell'; sheet: string; col: number; row: number }
  | { kind: 'range'; sheet: string; c0: number; c1: number; r0: number; r1: number }
  | { kind: 'opaque' };

const CELL_KEY = /^([A-Z]+)(\d+)$/;
const RANGE_KEY = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/;
const COLUMN_KEY = /^([A-Z]+):$/;

/** Parses an upper-cased key: `A1`, `A1:B9`, `A:` (whole column), each optionally after `SHEET!`. */
function parseKey(key: string): ParsedKey {
  const bang = key.lastIndexOf('!');
  const sheet = bang < 0 ? '' : key.slice(0, bang);
  const ref = bang < 0 ? key : key.slice(bang + 1);
  let m = CELL_KEY.exec(ref);
  if (m) return { kind: 'cell', sheet, col: colNameToIndex(m[1]), row: Number(m[2]) };
  m = RANGE_KEY.exec(ref);
  if (m) {
    const ca = colNameToIndex(m[1]);
    const cb = colNameToIndex(m[3]);
    const ra = Number(m[2]);
    const rb = Number(m[4]);
    return { kind: 'range', sheet, c0: Math.min(ca, cb), c1: Math.max(ca, cb), r0: Math.min(ra, rb), r1: Math.max(ra, rb) };
  }
  m = COLUMN_KEY.exec(ref);
  if (m) {
    const c = colNameToIndex(m[1]);
    return { kind: 'range', sheet, c0: c, c1: c, r0: 1, r1: WHOLE_COLUMN_END_ROW };
  }
  return { kind: 'opaque' };
}

interface RegisteredRange {
  /** The key as registered (returned by `getDependencies`). */
  key: string;
  sheet: string;
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

interface FormulaNode {
  cells: Set<string>;
  ranges: RegisteredRange[];
}

interface SheetRangeIndex {
  /** Column → row intervals of the ranges (up to `WIDE_RANGE_COLUMNS` columns) covering it. */
  cols: Map<number, IntervalIndex<string>>;
  /** Row intervals of wider ranges, with their columns. */
  wide: IntervalIndex<{ c0: number; c1: number; key: string }>;
}

/** Sizes of the dependency index (see `DependencyGraph.getIndexStats`). */
export interface DependencyIndexStats {
  /** Cells with registered dependencies (formulas). */
  formulas: number;
  /** Single-cell edges (formula → cell it reads). */
  cellEdges: number;
  /** Range entries: one per range (per column for ranges up to 64 columns wide), however many cells it covers. */
  rangeEntries: number;
  /** Formulas that use a volatile function. */
  volatile: number;
}

const VIRTUAL_PREFIX = '\u0000';

export class DependencyGraph {
  // Formula cell -> what it reads (single cells and whole ranges).
  private nodes = new Map<string, FormulaNode>();
  // Cell -> formulas reading it as a single cell.
  private cellDependents = new Map<string, Set<string>>();
  // Sheet ('' for unqualified keys) -> interval index of the ranges formulas read.
  private rangeIndex = new Map<string, SheetRangeIndex>();
  // Formulas recalculated on every recalculation (NOW, RAND, …).
  private volatile = new Set<string>();
  // Dynamic-array edges, set by the controller after evaluating an anchor:
  // spilled cells depend on their anchor, and a blocked (#SPILL!) anchor
  // depends on the cells blocking it. Kept apart from formula dependencies,
  // so re-entering a formula doesn't drop them.
  private spillDependencies = new Map<string, Set<string>>();
  private spillDependents = new Map<string, Set<string>>();
  // anchor -> the edges it registered (so they can be replaced).
  private spillEdges = new Map<string, Array<[from: string, to: string]>>();
  // Blocked anchor -> its blockers. These edges only propagate changes
  // (clearing a blocker recalculates the anchor): whether a cell blocks
  // depends on its input, not its value, so they don't order evaluation and
  // can't close a cycle.
  private blockingEdges = new Map<string, Set<string>>();
  private parsed = new Map<string, ParsedKey>();

  private parse(key: string): ParsedKey {
    let parsed = this.parsed.get(key);
    if (!parsed) {
      parsed = parseKey(key);
      if (this.parsed.size > 200_000) this.parsed.clear();
      this.parsed.set(key, parsed);
    }
    return parsed;
  }

  private sheetIndex(sheet: string): SheetRangeIndex {
    let index = this.rangeIndex.get(sheet);
    if (!index) {
      index = { cols: new Map(), wide: new IntervalIndex() };
      this.rangeIndex.set(sheet, index);
    }
    return index;
  }

  private removeNode(key: string): void {
    const node = this.nodes.get(key);
    if (!node) return;
    for (const dep of node.cells) {
      const set = this.cellDependents.get(dep);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) this.cellDependents.delete(dep);
    }
    for (const range of node.ranges) {
      const index = this.rangeIndex.get(range.sheet);
      if (!index) continue;
      if (range.c1 - range.c0 + 1 > WIDE_RANGE_COLUMNS) {
        index.wide.remove(`${range.r0}:${range.r1}:${range.c0}:${range.c1}:${key}`);
      } else {
        for (let c = range.c0; c <= range.c1; c++) index.cols.get(c)?.remove(`${range.r0}:${range.r1}:${key}`);
      }
    }
    this.nodes.delete(key);
  }

  /**
   * Sets what `cellKey` depends on directly, replacing its previous
   * dependencies. Keys are single cells (`B2`), rectangles (`A1:B9`) or
   * whole columns (`A:`, see `columnDependencyKey`), each optionally
   * sheet-qualified (`SHEET!A1:A9`). Ranges are stored whole in an interval
   * index, never expanded cell by cell. `setCellFormula` derives the keys
   * from a formula.
   */
  public setCellDependencies(cellKey: string, dependencyKeys: Iterable<string>): void {
    const key = cellKey.toUpperCase();
    this.removeNode(key);
    const node: FormulaNode = { cells: new Set(), ranges: [] };
    const seenRanges = new Set<string>();
    for (const raw of dependencyKeys) {
      const dep = raw.toUpperCase();
      const parsed = this.parse(dep);
      if (parsed.kind === 'range' && !(parsed.c0 === parsed.c1 && parsed.r0 === parsed.r1)) {
        if (seenRanges.has(dep)) continue;
        seenRanges.add(dep);
        node.ranges.push({ key: dep, sheet: parsed.sheet, c0: parsed.c0, c1: parsed.c1, r0: parsed.r0, r1: parsed.r1 });
        continue;
      }
      // A one-cell range is a cell.
      const cell =
        parsed.kind === 'range'
          ? `${parsed.sheet === '' ? '' : `${parsed.sheet}!`}${indexToColName(parsed.c0)}${parsed.r0}`
          : dep;
      node.cells.add(cell);
    }
    if (node.cells.size === 0 && node.ranges.length === 0) {
      this.volatile.delete(key);
      return;
    }
    for (const dep of node.cells) {
      let set = this.cellDependents.get(dep);
      if (!set) this.cellDependents.set(dep, (set = new Set()));
      set.add(key);
    }
    for (const range of node.ranges) {
      const index = this.sheetIndex(range.sheet);
      if (range.c1 - range.c0 + 1 > WIDE_RANGE_COLUMNS) {
        index.wide.insert(range.r0, range.r1, `${range.r0}:${range.r1}:${range.c0}:${range.c1}:${key}`, {
          c0: range.c0,
          c1: range.c1,
          key,
        });
      } else {
        for (let c = range.c0; c <= range.c1; c++) {
          let col = index.cols.get(c);
          if (!col) index.cols.set(c, (col = new IntervalIndex()));
          col.insert(range.r0, range.r1, `${range.r0}:${range.r1}:${key}`, key);
        }
      }
    }
    this.nodes.set(key, node);
  }

  /**
   * Marks `cellKey` as volatile (its formula uses NOW, RAND, …): it is
   * recalculated by every plan made with `includeVolatile`, whatever changed.
   */
  public setVolatile(cellKey: string, volatile: boolean): void {
    const key = cellKey.toUpperCase();
    if (volatile) this.volatile.add(key);
    else this.volatile.delete(key);
  }

  /** Cells whose formulas are volatile. */
  public getVolatileKeys(): string[] {
    return Array.from(this.volatile);
  }

  public setCellFormula(cellKey: string, formulaStr: string | null): void {
    const key = cellKey.toUpperCase();
    if (!formulaStr || !formulaStr.startsWith('=')) {
      this.setCellDependencies(key, []);
      return;
    }
    let ast: ASTNode;
    try {
      ast = parseFormula(formulaStr);
    } catch {
      // Syntax errors in formula have no valid dependencies
      this.setCellDependencies(key, []);
      return;
    }
    const keys: string[] = [];
    for (const dep of extractReferenceDependencies(ast)) {
      keys.push(
        dep.kind === 'cell'
          ? `${dep.col}${dep.row}`
          : dep.endRow >= WHOLE_COLUMN_END_ROW && dep.startCol === dep.endCol
            ? columnDependencyKey(dep.startCol)
            : rangeDependencyKey(dep.startCol, dep.startRow, dep.endCol, dep.endRow),
      );
    }
    this.setCellDependencies(key, keys);
  }

  /** Removes every registered formula and dependency. */
  public clear(): void {
    this.nodes.clear();
    this.cellDependents.clear();
    this.rangeIndex.clear();
    this.volatile.clear();
    this.spillDependencies.clear();
    this.spillDependents.clear();
    this.spillEdges.clear();
    this.blockingEdges.clear();
  }

  /**
   * Records the dynamic-array edges of the anchor `anchorKey`, replacing its
   * previous ones: every key in `spilledKeys` (cells holding its spilled
   * values) depends on the anchor, and the anchor depends on every key in
   * `blockingKeys` (cells that stop it spilling). Pass empty lists to remove
   * the anchor's edges.
   */
  public setSpillEdges(anchorKey: string, spilledKeys: Iterable<string>, blockingKeys: Iterable<string> = []): void {
    const anchor = anchorKey.toUpperCase();
    for (const [from, to] of this.spillEdges.get(anchor) ?? []) {
      this.spillDependencies.get(from)?.delete(to);
      this.spillDependents.get(to)?.delete(from);
    }
    this.blockingEdges.delete(anchor);
    const edges: Array<[string, string]> = [];
    for (const key of spilledKeys) edges.push([key.toUpperCase(), anchor]);
    const blockers = new Set<string>();
    for (const key of blockingKeys) {
      edges.push([anchor, key.toUpperCase()]);
      blockers.add(key.toUpperCase());
    }
    if (blockers.size > 0) this.blockingEdges.set(anchor, blockers);
    for (const [from, to] of edges) {
      if (!this.spillDependencies.has(from)) this.spillDependencies.set(from, new Set());
      this.spillDependencies.get(from)!.add(to);
      if (!this.spillDependents.has(to)) this.spillDependents.set(to, new Set());
      this.spillDependents.get(to)!.add(from);
    }
    if (edges.length > 0) this.spillEdges.set(anchor, edges);
    else this.spillEdges.delete(anchor);
  }

  /**
   * Drops the edge from a spilled cell to the anchor whose values it holds,
   * for a cell that just got input of its own: its value no longer comes
   * from the anchor (which recalculates and becomes `#SPILL!`), and the
   * stale edge could otherwise close a false cycle with the cell's new
   * formula before the anchor is evaluated again.
   */
  public detachSpilledCell(cellKey: string): void {
    const key = cellKey.toUpperCase();
    const anchors = this.spillDependencies.get(key);
    if (!anchors) return;
    for (const anchor of Array.from(anchors)) {
      if (this.blockingEdges.get(key)?.has(anchor)) continue; // `key` is itself a blocked anchor
      const edges = this.spillEdges.get(anchor);
      if (!edges?.some(([from, to]) => from === key && to === anchor)) continue;
      anchors.delete(anchor);
      this.spillDependents.get(anchor)?.delete(key);
      const kept = edges.filter(([from, to]) => !(from === key && to === anchor));
      if (kept.length > 0) this.spillEdges.set(anchor, kept);
      else this.spillEdges.delete(anchor);
    }
  }

  /** The spilled cells registered for `anchorKey` by `setSpillEdges`. */
  public getSpilledKeys(anchorKey: string): string[] {
    const anchor = anchorKey.toUpperCase();
    return (this.spillEdges.get(anchor) ?? []).filter(([, to]) => to === anchor).map(([from]) => from);
  }

  /**
   * What a cell depends on directly: single cells, ranges (as registered,
   * e.g. `A1:A9` or `A:`, not expanded) and dynamic-array (spill) edges.
   */
  public getDependencies(cellKey: string): string[] {
    const key = cellKey.toUpperCase();
    const node = this.nodes.get(key);
    const own = node ? [...node.cells, ...node.ranges.map((r) => r.key)] : [];
    const spill = this.spillDependencies.get(key);
    if (!spill || spill.size === 0) return own;
    return Array.from(new Set([...own, ...spill]));
  }

  /**
   * Whether the formula in `formulaKey` reads `cellKey` directly: as a cell,
   * inside one of its ranges, or through a spill edge.
   */
  public dependsOn(formulaKey: string, cellKey: string): boolean {
    const key = formulaKey.toUpperCase();
    const target = cellKey.toUpperCase();
    if (this.spillDependencies.get(key)?.has(target)) return true;
    const node = this.nodes.get(key);
    if (!node) return false;
    if (node.cells.has(target)) return true;
    const parsed = this.parse(target);
    if (parsed.kind !== 'cell') return false;
    return node.ranges.some(
      (r) => r.sheet === parsed.sheet && parsed.col >= r.c0 && parsed.col <= r.c1 && parsed.row >= r.r0 && parsed.row <= r.r1,
    );
  }

  /**
   * Formulas (and spilled cells) reading `cellKey` directly, through formulas
   * or spills. Found in O(log n + k) through the range index.
   */
  public getDependents(cellKey: string): string[] {
    const out = new Set<string>();
    this.collectDependents(cellKey.toUpperCase(), (key) => out.add(key));
    return Array.from(out);
  }

  private collectDependents(key: string, add: (key: string) => void): void {
    const cells = this.cellDependents.get(key);
    if (cells) for (const dep of cells) add(dep);
    const spill = this.spillDependents.get(key);
    if (spill) for (const dep of spill) add(dep);
    if (this.rangeIndex.size === 0) return;
    const parsed = this.parse(key);
    if (parsed.kind !== 'cell') return;
    const index = this.rangeIndex.get(parsed.sheet);
    if (!index) return;
    index.cols.get(parsed.col)?.query(parsed.row, parsed.row, add);
    if (index.wide.size > 0) {
      index.wide.query(parsed.row, parsed.row, (wide) => {
        if (parsed.col >= wide.c0 && parsed.col <= wide.c1) add(wide.key);
      });
    }
  }

  /** Sizes of the index: ranges count once (per column), not once per cell. */
  public getIndexStats(): DependencyIndexStats {
    let cellEdges = 0;
    let rangeEntries = 0;
    for (const node of this.nodes.values()) {
      cellEdges += node.cells.size;
      for (const r of node.ranges) rangeEntries += r.c1 - r.c0 + 1 > WIDE_RANGE_COLUMNS ? 1 : r.c1 - r.c0 + 1;
    }
    return { formulas: this.nodes.size, cellEdges, rangeEntries, volatile: this.volatile.size };
  }

  /**
   * Detects if there is a cycle containing cellKey.
   */
  public hasCycle(cellKey: string): boolean {
    const key = cellKey.toUpperCase();
    return this.getEvaluationPlan([key], { includeDependents: true }).cyclic.has(key);
  }

  /**
   * Returns cells affected by updating cellKey in topological order.
   */
  public getEvaluationOrder(startCellKey: string): { order: string[]; hasCycle: boolean } {
    const plan = this.getEvaluationPlan([startCellKey], { includeDependents: true });
    return { order: plan.order, hasCycle: plan.cyclic.size > 0 };
  }

  /**
   * Plans a recalculation over `cellKeys` (and, with `includeDependents`, every
   * cell that transitively depends on them; with `includeVolatile`, every
   * volatile formula and its dependents too). Returns the keys in evaluation
   * order (dependencies first) and the set of keys that are part of a cycle,
   * which must be marked `#CYCLE!` instead of evaluated. Every member of a
   * cycle is reported, not just the cell that closed it.
   *
   * Only the planned cells are ordered: a range a formula reads becomes one
   * node whose edges are the planned cells inside it (found by binary
   * search), so a range shared by many formulas is resolved once.
   */
  public getEvaluationPlan(
    cellKeys: Iterable<string>,
    options: { includeDependents?: boolean; includeVolatile?: boolean } = {},
  ): { order: string[]; cyclic: Set<string> } {
    const nodes = new Set<string>();
    const queue: string[] = [];
    const visit = (key: string) => {
      if (!nodes.has(key)) {
        nodes.add(key);
        queue.push(key);
      }
    };
    for (const key of cellKeys) visit(key.toUpperCase());
    if (options.includeVolatile) for (const key of this.volatile) visit(key);
    if (options.includeDependents) {
      while (queue.length > 0) this.collectDependents(queue.pop()!, visit);
    }

    // Planned cells by sheet and column, sorted by row, for range lookups.
    let positions: Map<string, Map<number, Array<[row: number, key: string]>>> | null = null;
    const planPositions = () => {
      if (positions) return positions;
      positions = new Map();
      for (const key of nodes) {
        const parsed = this.parse(key);
        if (parsed.kind !== 'cell') continue;
        let sheet = positions.get(parsed.sheet);
        if (!sheet) positions.set(parsed.sheet, (sheet = new Map()));
        let cells = sheet.get(parsed.col);
        if (!cells) sheet.set(parsed.col, (cells = []));
        cells.push([parsed.row, key]);
      }
      for (const sheet of positions.values()) for (const cells of sheet.values()) cells.sort((a, b) => a[0] - b[0]);
      return positions;
    };
    // Range node id -> planned cells inside the range.
    const rangeMembers = new Map<string, string[]>();
    /** The node standing for `range`, or null when no planned cell is inside it. */
    const rangeNode = (range: RegisteredRange): string | null => {
      const id = `${VIRTUAL_PREFIX}${range.sheet}!${range.c0}:${range.c1}:${range.r0}:${range.r1}`;
      let members = rangeMembers.get(id);
      if (!members) {
        const found: string[] = [];
        const sheet = planPositions().get(range.sheet);
        const scan = (cells: Array<[number, string]>) => {
          let lo = 0;
          let hi = cells.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (cells[mid][0] < range.r0) lo = mid + 1;
            else hi = mid;
          }
          for (let i = lo; i < cells.length && cells[i][0] <= range.r1; i++) found.push(cells[i][1]);
        };
        if (sheet) {
          if (range.c1 - range.c0 + 1 <= sheet.size) {
            for (let c = range.c0; c <= range.c1; c++) {
              const cells = sheet.get(c);
              if (cells) scan(cells);
            }
          } else {
            for (const [c, cells] of sheet) if (c >= range.c0 && c <= range.c1) scan(cells);
          }
        }
        rangeMembers.set(id, (members = found));
      }
      return members.length > 0 ? id : null;
    };

    // Edges point from a cell to what it depends on, restricted to `nodes`.
    const neighbors = (node: string): string[] => {
      if (node.startsWith(VIRTUAL_PREFIX)) return rangeMembers.get(node) ?? [];
      const result: string[] = [];
      const formula = this.nodes.get(node);
      if (formula) {
        for (const dep of formula.cells) if (nodes.has(dep)) result.push(dep);
        for (const range of formula.ranges) {
          const id = rangeNode(range);
          if (id) result.push(id);
        }
      }
      const spill = this.spillDependencies.get(node);
      if (spill) {
        const blockers = this.blockingEdges.get(node);
        for (const dep of spill) if (nodes.has(dep) && !blockers?.has(dep)) result.push(dep);
      }
      return result;
    };

    // Iterative Tarjan: SCCs are emitted dependencies-first.
    const order: string[] = [];
    const cyclic = new Set<string>();
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    let counter = 0;

    for (const root of nodes) {
      if (index.has(root)) continue;
      const work: Array<{ node: string; edges: string[]; next: number }> = [];
      const enter = (node: string) => {
        index.set(node, counter);
        low.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
        work.push({ node, edges: neighbors(node), next: 0 });
      };
      enter(root);

      while (work.length > 0) {
        const frame = work[work.length - 1];
        if (frame.next < frame.edges.length) {
          const target = frame.edges[frame.next++];
          if (!index.has(target)) {
            enter(target);
          } else if (onStack.has(target)) {
            low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
          }
          continue;
        }

        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].node;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
        }

        if (low.get(frame.node) === index.get(frame.node)) {
          const component: string[] = [];
          let member: string;
          do {
            member = stack.pop()!;
            onStack.delete(member);
            component.push(member);
          } while (member !== frame.node);

          const isCycle = component.length > 1 || frame.edges.includes(frame.node);
          for (const key of component) {
            if (key.startsWith(VIRTUAL_PREFIX)) continue;
            order.push(key);
            if (isCycle) cyclic.add(key);
          }
        }
      }
    }

    return { order, cyclic };
  }
}
