// Portions ported from pdfcraft/crates/compare/src/lib.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Generic sequence diff: common prefix/suffix stripping, Myers' O((N+M)·D)
 * algorithm for small segments and patience anchors (items unique on both
 * sides, longest increasing subsequence) to split long ones. Dependency-free.
 */

export type DiffOpType = "equal" | "delete" | "insert";

/** A run of consecutive operations of one type. */
export interface DiffRun {
  type: DiffOpType;
  /** Start index in `a` (for `insert`, where the items go in `a`). */
  aIndex: number;
  /** Start index in `b` (for `delete`, where the items were in `b`). */
  bIndex: number;
  length: number;
}

/** A change: a deleted range of `a`, an inserted range of `b`, or both (replaced). */
export interface DiffChange {
  kind: "inserted" | "deleted" | "replaced";
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export interface DiffSequencesOptions<T> {
  /**
   * Key of an item: items with the same key are equal. Defaults to the item
   * itself for strings, numbers and booleans, and `JSON.stringify` otherwise.
   * Keys enable patience anchors for long inputs.
   */
  hash?: (item: T) => string | number | boolean;
  /**
   * Custom equality. Without `hash`, segments longer than `direct` are only
   * diffed while the edit distance stays below `direct`, otherwise replaced.
   */
  equals?: (a: T, b: T) => boolean;
  /**
   * Segments with more items (both sides together) are split at anchors
   * first so Myers' saved frontiers (O(D²) memory) stay small. Default 3000.
   */
  direct?: number;
  /** Maximum anchor recursion depth before a long segment is replaced whole. Default 8. */
  maxDepth?: number;
}

const EQUAL = 0;
const DELETE = 1;
const INSERT = 2;

type Eq = (i: number, j: number) => boolean;

function pushRepeat(out: number[], op: number, count: number): void {
  for (let i = 0; i < count; i++) out.push(op);
}

/**
 * Myers' diff of a[aLo..aHi) and b[bLo..bHi). Returns false (and emits
 * nothing) when the edit distance exceeds `maxD`.
 */
function myers(
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  eq: Eq,
  out: number[],
  maxD: number,
): boolean {
  const n = aHi - aLo;
  const m = bHi - bLo;
  if (n === 0 || m === 0) {
    pushRepeat(out, DELETE, n);
    pushRepeat(out, INSERT, m);
    return true;
  }
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Frontier d only spans diagonals -d..d: save just that slice.
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxD);
  let found = false;
  outer: for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(Math.max(off - d - 1, 0), off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const i = k + off;
      let x = k === -d || (k !== d && v[i - 1] < v[i + 1]) ? v[i + 1] : v[i - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(aLo + x, bLo + y)) {
        x++;
        y++;
      }
      v[i] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return false;

  // Walk back through the saved frontiers.
  const ops: number[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const frontier = trace[d];
    const base = Math.max(off - d - 1, 0);
    const at = (k: number) => frontier[k + off - base];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(EQUAL);
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? INSERT : DELETE);
    x = prevX;
    y = prevY;
  }
  for (let i = ops.length - 1; i >= 0; i--) out.push(ops[i]);
  return true;
}

/**
 * Patience anchors: items that occur once on each side, in an order both
 * sides agree on (the longest increasing subsequence of their positions).
 */
function anchors(
  ids: { a: Int32Array; b: Int32Array },
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
): [number, number][] {
  const count = new Map<number, [number, number, number, number]>();
  for (let i = aLo; i < aHi; i++) {
    const id = ids.a[i];
    const entry = count.get(id);
    if (entry) {
      entry[0]++;
    } else {
      count.set(id, [1, 0, i, -1]);
    }
  }
  for (let j = bLo; j < bHi; j++) {
    const entry = count.get(ids.b[j]);
    if (entry) {
      entry[1]++;
      entry[3] = j;
    }
  }
  const pairs: [number, number][] = [];
  count.forEach((entry) => {
    if (entry[0] === 1 && entry[1] === 1) pairs.push([entry[2], entry[3]]);
  });
  pairs.sort((p, q) => p[0] - q[0]);
  // LIS on the b positions (patience sorting with back links).
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const y = pairs[k][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < y) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    if (lo === tails.length) tails.push(k);
    else tails[lo] = k;
  }
  const result: [number, number][] = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k !== -1) {
    result.push(pairs[k]);
    k = prev[k];
  }
  return result.reverse();
}

interface DiffContext {
  eq: Eq;
  ids: { a: Int32Array; b: Int32Array } | null;
  direct: number;
  maxDepth: number;
}

function diffRange(
  ctx: DiffContext,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  out: number[],
  depth: number,
): void {
  const { eq } = ctx;
  let prefix = 0;
  while (aLo + prefix < aHi && bLo + prefix < bHi && eq(aLo + prefix, bLo + prefix)) prefix++;
  let suffix = 0;
  while (
    aHi - suffix > aLo + prefix &&
    bHi - suffix > bLo + prefix &&
    eq(aHi - suffix - 1, bHi - suffix - 1)
  ) {
    suffix++;
  }
  pushRepeat(out, EQUAL, prefix);
  const ma = aLo + prefix;
  const mb = bLo + prefix;
  const ea = aHi - suffix;
  const eb = bHi - suffix;
  const replace = () => {
    pushRepeat(out, DELETE, ea - ma);
    pushRepeat(out, INSERT, eb - mb);
  };

  if (ea - ma + (eb - mb) <= ctx.direct) {
    myers(ma, ea, mb, eb, eq, out, Infinity);
  } else if (!ctx.ids) {
    // No keys, so no anchors: bounded Myers, else one replacement.
    if (!myers(ma, ea, mb, eb, eq, out, ctx.direct)) replace();
  } else {
    const found = depth >= ctx.maxDepth ? [] : anchors(ctx.ids, ma, ea, mb, eb);
    if (found.length === 0) {
      // A long stretch with nothing unique in common: one replacement.
      replace();
    } else {
      let i = ma;
      let j = mb;
      for (const [x, y] of found) {
        diffRange(ctx, i, x, j, y, out, depth + 1);
        out.push(EQUAL);
        i = x + 1;
        j = y + 1;
      }
      diffRange(ctx, i, ea, j, eb, out, depth + 1);
    }
  }
  pushRepeat(out, EQUAL, suffix);
}

const defaultHash = (item: unknown): string | number | boolean =>
  typeof item === "string" || typeof item === "number" || typeof item === "boolean"
    ? item
    : JSON.stringify(item);

/**
 * Diffs two sequences and returns the edit script as runs of equal, deleted
 * and inserted items, in order. Within a changed stretch deletions come
 * before insertions. The script is minimal for segments up to `direct`
 * items; longer inputs are split at patience anchors (bounded work).
 */
export function diffSequences<T>(
  a: readonly T[],
  b: readonly T[],
  options: DiffSequencesOptions<T> = {},
): DiffRun[] {
  const direct = Math.max(2, options.direct ?? 3000);
  const maxDepth = options.maxDepth ?? 8;
  let ids: { a: Int32Array; b: Int32Array } | null = null;
  let eq: Eq;
  if (options.equals && !options.hash) {
    const equals = options.equals;
    eq = (i, j) => equals(a[i], b[j]);
  } else {
    const hash = options.hash ?? (defaultHash as (item: T) => string | number | boolean);
    const table = new Map<string | number | boolean, number>();
    const idOf = (item: T) => {
      const key = hash(item);
      let id = table.get(key);
      if (id === undefined) {
        id = table.size;
        table.set(key, id);
      }
      return id;
    };
    ids = { a: Int32Array.from(a, idOf), b: Int32Array.from(b, idOf) };
    const { a: ia, b: ib } = ids;
    eq = (i, j) => ia[i] === ib[j];
  }

  const ops: number[] = [];
  diffRange({ eq, ids, direct, maxDepth }, 0, a.length, 0, b.length, ops, 0);

  // Group into runs, deletions first within each changed stretch.
  const runs: DiffRun[] = [];
  const push = (type: DiffOpType, aIndex: number, bIndex: number, length: number) => {
    if (length === 0) return;
    const last = runs[runs.length - 1];
    if (last && last.type === type) {
      last.length += length;
    } else {
      runs.push({ type, aIndex, bIndex, length });
    }
  };
  let i = 0;
  let j = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k] === EQUAL) {
      let n = 0;
      while (k < ops.length && ops[k] === EQUAL) {
        n++;
        k++;
      }
      push("equal", i, j, n);
      i += n;
      j += n;
      continue;
    }
    let dels = 0;
    let inss = 0;
    while (k < ops.length && ops[k] !== EQUAL) {
      if (ops[k] === DELETE) dels++;
      else inss++;
      k++;
    }
    push("delete", i, j, dels);
    push("insert", i + dels, j, inss);
    i += dels;
    j += inss;
  }
  return runs;
}

/** Groups an edit script into inserted, deleted and replaced ranges. */
export function diffChanges<T>(
  a: readonly T[],
  b: readonly T[],
  options: DiffSequencesOptions<T> = {},
): DiffChange[] {
  const changes: DiffChange[] = [];
  let current: DiffChange | null = null;
  for (const run of diffSequences(a, b, options)) {
    if (run.type === "equal") {
      current = null;
      continue;
    }
    if (!current) {
      current = {
        kind: run.type === "delete" ? "deleted" : "inserted",
        aStart: run.aIndex,
        aEnd: run.aIndex,
        bStart: run.bIndex,
        bEnd: run.bIndex,
      };
      changes.push(current);
    }
    if (run.type === "delete") {
      current.aEnd = run.aIndex + run.length;
    } else {
      current.bEnd = run.bIndex + run.length;
    }
    if (current.aEnd > current.aStart && current.bEnd > current.bStart) current.kind = "replaced";
  }
  return changes;
}
