// Portions ported from wordcraft/crates/engine/src/cmd/find_pattern.rs and crates/engine/src/cmd/edit.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/**
 * Word's Find and Replace patterns: special characters (`^p`, `^t`, `^#` …),
 * the "Use wildcards" language (`?`, `*`, `[a-z]`, `[!x]`, `{n,m}`, `@`, `<`,
 * `>`, `( )`) and a raw regular-expression mode.
 *
 * Special and wildcard patterns are compiled to a small program run by a
 * Pike VM, which takes time linear in the text for a given pattern, so no
 * Find text can backtrack catastrophically (JavaScript's `RegExp` would). The
 * raw regex mode uses the native `RegExp` engine; it rejects nested
 * repetition and is bounded by the search budget between matches only.
 *
 * Pure TypeScript: no ProseMirror or DOM.
 */

/** A paragraph mark in the searched text (`^p`). */
export const FIND_PARAGRAPH_MARK = "\r";
/** Longest Find what text, in characters. */
export const MAX_FIND_PATTERN_LENGTH = 1024;
/** Largest count in `{n,m}`. */
const MAX_COUNT = 1000;
/** Largest compiled program (instructions). Larger patterns are `too_complex`. */
const MAX_PROGRAM_SIZE = 20_000;

export interface FindOptions {
  matchCase?: boolean;
  /** Find whole words only (ignored with wildcards, like Word). */
  wholeWord?: boolean;
  /** The match must start a word. */
  matchPrefix?: boolean;
  /** The match must end a word. */
  matchSuffix?: boolean;
  /** Skip punctuation between the characters of the Find text. */
  ignorePunctuation?: boolean;
  /** Skip spaces and tabs between the characters of the Find text. */
  ignoreWhitespace?: boolean;
  /** Word's "Use wildcards". Always matches case. */
  wildcards?: boolean;
  /** A JavaScript regular expression (wins over `wildcards`). Replace text is literal. */
  regex?: boolean;
  /** Read the Find and Replace text literally: no `^` codes. */
  literal?: boolean;
}

export type FindPatternErrorCode = "too_long" | "invalid_pattern" | "too_complex";

/** Why a Find text cannot be used. Commands report it; they never throw it. */
export interface FindPatternError {
  code: FindPatternErrorCode;
  message: string;
}

/** One match in a searched string (UTF-16 offsets). */
export interface PatternMatch {
  start: number;
  end: number;
  /** Text of each group; index 0 is the whole match, unmatched groups are `undefined`. */
  groups: (string | undefined)[];
}

/** Shared limit on the work one search may do. */
export interface SearchBudget {
  /** `performance.now()`/`Date.now()` value after which the search stops. */
  deadline: number;
  /** VM steps left. */
  steps: number;
  /** Set once the budget ran out. */
  exhausted: boolean;
}

export interface SearchBudgetOptions {
  /** Wall-clock limit in milliseconds (default 250). */
  timeLimitMs?: number;
  /** Pike VM thread steps (default 50 million). */
  maxSteps?: number;
}

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

export function createSearchBudget(options: SearchBudgetOptions = {}): SearchBudget {
  return {
    deadline: now() + (options.timeLimitMs ?? 250),
    steps: options.maxSteps ?? 50_000_000,
    exhausted: false,
  };
}

export interface CompiledFindPattern {
  mode: "special" | "wildcards" | "regex";
  /** The pattern can match a paragraph mark, so paragraphs must be read together. */
  spansParagraphs: boolean;
  caseInsensitive: boolean;
  /** Number of capture groups (not counting the whole match). */
  groupCount: number;
  /**
   * The leftmost match in `hay[start, end)`; text outside the range is
   * context for word assertions. `"budget"` when the budget ran out.
   */
  exec(hay: string, start: number, end: number, budget: SearchBudget): PatternMatch | null | "budget";
}

export type CompileFindPatternResult =
  | { ok: true; pattern: CompiledFindPattern }
  | { ok: false; error: FindPatternError };

// ---------------------------------------------------------------------------
// Character tests
// ---------------------------------------------------------------------------

/** Tests a code point (and its case fold when matching ignores case). */
type CharTest = (cp: number, folded: number) => boolean;

const PARA = 13; // "\r"
const ANY: CharTest = (cp) => cp !== PARA;

const LETTER = /\p{L}/u;
const PUNCT = /\p{P}/u;
const WORD = /[\p{L}\p{M}\p{Nd}\p{Pc}]/u;

const foldCache = new Map<number, number>();
/** Simple (one code point to one code point) lower-case fold. */
export function foldCodePoint(cp: number): number {
  if (cp < 128) return cp >= 65 && cp <= 90 ? cp + 32 : cp;
  const cached = foldCache.get(cp);
  if (cached !== undefined) return cached;
  const lower = String.fromCodePoint(cp).toLowerCase();
  const folded = [...lower].length === 1 ? lower.codePointAt(0)! : cp;
  if (foldCache.size < 4096) foldCache.set(cp, folded);
  return folded;
}

function isWordChar(cp: number): boolean {
  if (cp < 0) return false;
  if (cp < 128) {
    return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95;
  }
  return WORD.test(String.fromCodePoint(cp));
}

const isLetter = (cp: number) =>
  cp < 128 ? (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) : LETTER.test(String.fromCodePoint(cp));

function isPunct(cp: number): boolean {
  if (cp < 128) {
    return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126);
  }
  return (cp >= 0x2010 && cp <= 0x2027) || cp === 0xa1 || cp === 0xbf || cp === 0xab || cp === 0xbb || PUNCT.test(String.fromCodePoint(cp));
}

const isSpace = (cp: number) => cp === 32 || cp === 9 || cp === 0xa0;

/** Code point before `pos` in `hay` (-1 at the start). */
function cpBefore(hay: string, pos: number): number {
  if (pos <= 0) return -1;
  const low = hay.charCodeAt(pos - 1);
  if (low >= 0xdc00 && low <= 0xdfff && pos >= 2) {
    const high = hay.charCodeAt(pos - 2);
    if (high >= 0xd800 && high <= 0xdbff) return hay.codePointAt(pos - 2)!;
  }
  return low;
}

const cpAt = (hay: string, pos: number): number => (pos < hay.length ? hay.codePointAt(pos)! : -1);

// ---------------------------------------------------------------------------
// Pattern AST
// ---------------------------------------------------------------------------

type AssertKind = "boundary" | "wordStart" | "wordEnd";

type Node =
  | { k: "char"; test: CharTest }
  | { k: "cat"; items: Node[] }
  | { k: "group"; index: number; body: Node }
  | { k: "rep"; body: Node; min: number; max: number; lazy: boolean } // max -1 = unbounded
  | { k: "assert"; kind: AssertKind };

class PatternError extends Error {
  constructor(
    readonly code: FindPatternErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const charNode = (test: CharTest): Node => ({ k: "char", test });
const exact = (cp: number): Node => charNode((c) => c === cp);
const literalNode = (cp: number, caseInsensitive: boolean): Node => {
  if (!caseInsensitive) return exact(cp);
  const f = foldCodePoint(cp);
  return charNode((_c, folded) => folded === f);
};
const star = (body: Node, lazy: boolean): Node => ({ k: "rep", body, min: 0, max: -1, lazy });

/** What a `^` code stands for in Find what. */
function findCode(c: string): Node | null {
  switch (c) {
    case "p": return exact(PARA);
    case "t": return exact(9);
    case "?": return charNode(ANY);
    case "#": return charNode((cp) => cp >= 48 && cp <= 57);
    case "$": return charNode((cp) => isLetter(cp));
    case "^": return exact(94);
    case "l": return exact(10);
    case "m": return exact(0x0c);
    case "n": return exact(0x0e);
    case "+": return exact(0x2014);
    case "=": return exact(0x2013);
    case "s": return exact(0xa0);
    case "~": return exact(0x2011);
    case "-": return exact(0xad);
    case "w": return { k: "rep", body: charNode((cp) => isSpace(cp)), min: 1, max: -1, lazy: false };
    case "g": return exact(0xfffc);
    case "%": return exact(0xa7);
    case "v": return exact(0xb6);
    default: return null;
  }
}

/** What a `^` code stands for in Replace with. */
function replaceCode(c: string): string | null {
  switch (c) {
    case "p": return FIND_PARAGRAPH_MARK;
    case "t": return "\t";
    case "^": return "^";
    case "l": return "\n";
    case "m": return "\u000c";
    case "n": return "\u000e";
    case "+": return "\u2014";
    case "=": return "\u2013";
    case "s": return "\u00a0";
    case "~": return "\u2011";
    case "-": return "\u00ad";
    case "%": return "\u00a7";
    case "v": return "\u00b6";
    default: return null;
  }
}

/** A character code (`^13`, `^0151`, `^u8212`) as the character it stands for. */
function codeChar(n: number): number | null {
  switch (n) {
    case 13: return PARA;
    case 11: return 10;
    case 12: return 0x0c;
    case 14: return 0x0e;
    case 30: return 0x2011;
    case 31: return 0xad;
  }
  if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
  // Control characters other than tab stand for nothing here.
  if ((n < 32 && n !== 9) || (n >= 0x7f && n < 0xa0)) return null;
  return n;
}

/** A numeric code after `^` starting at `chars[i]`: the code point and characters used. */
function numericCode(chars: string[], i: number): { cp: number; used: number } | null {
  const unicode = chars[i] === "u";
  const start = unicode ? i + 1 : i;
  const max = unicode ? 5 : 4;
  let digits = "";
  for (let j = start; j < chars.length && digits.length < max && /[0-9]/.test(chars[j]); j++) digits += chars[j];
  if (!digits) return null;
  const cp = codeChar(parseInt(digits, 10));
  return cp === null ? null : { cp, used: start - i + digits.length };
}

const toChars = (s: string): string[] => Array.from(s);
const cpOf = (ch: string): number => ch.codePointAt(0)!;

/** Normal search: literal text with `^` codes, optionally skipping punctuation and white space. */
function parseSpecial(query: string, o: FindOptions, caseInsensitive: boolean): { node: Node; spans: boolean } {
  const chars = toChars(query);
  const atoms: Node[] = [];
  let spans = false;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i++];
    if (c === "^" && !o.literal && i < chars.length) {
      const n = chars[i];
      const code = findCode(n);
      if (code) {
        if (n === "p") spans = true;
        atoms.push(code);
        i++;
        continue;
      }
      const num = numericCode(chars, i);
      if (num) {
        if (num.cp === PARA) spans = true;
        atoms.push(literalNode(num.cp, caseInsensitive));
        i += num.used;
        continue;
      }
      // Not a code: the caret itself.
    }
    const cp = cpOf(c);
    if ((o.ignorePunctuation && isPunct(cp)) || (o.ignoreWhitespace && isSpace(cp))) continue;
    atoms.push(literalNode(cp, caseInsensitive));
  }
  const filler: CharTest | null =
    o.ignorePunctuation && o.ignoreWhitespace
      ? (cp) => isPunct(cp) || isSpace(cp)
      : o.ignorePunctuation
        ? (cp) => isPunct(cp)
        : o.ignoreWhitespace
          ? (cp) => isSpace(cp)
          : null;
  const items: Node[] = [];
  atoms.forEach((atom, index) => {
    if (index > 0 && filler) items.push(star(charNode(filler), false));
    items.push(atom);
  });
  return { node: { k: "cat", items }, spans };
}

/** `{n}`, `{n,}`, `{n,m}` (and `{,m}`). */
function parseCount(body: string): { min: number; max: number } {
  const bad = () => new PatternError("invalid_pattern", `{${body}} is not a valid count`);
  const num = (s: string): number | null => {
    const t = s.trim();
    if (!t) return null;
    if (!/^[0-9]+$/.test(t)) throw bad();
    const n = parseInt(t, 10);
    if (n > MAX_COUNT) throw new PatternError("invalid_pattern", `counts go up to ${MAX_COUNT}`);
    return n;
  };
  const sep = body.search(/[,;]/);
  if (sep < 0) {
    const n = num(body);
    if (n === null) throw bad();
    return { min: n, max: n };
  }
  const a = num(body.slice(0, sep)) ?? 0;
  const b = num(body.slice(sep + 1));
  if (b !== null && b < a) throw bad();
  return { min: a, max: b ?? -1 };
}

/** `[abc]`, `[a-z]`, `[!x]`: the characters inside are literal. */
function parseClass(inner: string[]): CharTest {
  let negated = false;
  if (inner[0] === "!") {
    negated = true;
    inner = inner.slice(1);
  }
  if (inner.length === 0) throw new PatternError("invalid_pattern", "[ ] needs at least one character");
  const singles = new Set<number>();
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < inner.length) {
    let c = inner[i];
    if (c === "\\" && i + 1 < inner.length) c = inner[++i];
    i++;
    if (inner[i] === "-" && i + 1 < inner.length) {
      const hi = inner[i + 1];
      if (cpOf(hi) < cpOf(c)) throw new PatternError("invalid_pattern", `[${c}-${hi}] is not in ascending order`);
      ranges.push([cpOf(c), cpOf(hi)]);
      i += 2;
    } else {
      singles.add(cpOf(c));
    }
  }
  const inSet = (cp: number) => singles.has(cp) || ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
  return negated ? (cp) => cp !== PARA && !inSet(cp) : (cp) => inSet(cp);
}

/** "Use wildcards" search. */
function parseWildcards(query: string): { node: Node; spans: boolean; groups: number } {
  const chars = toChars(query);
  const stack: { items: Node[]; group: number }[] = [{ items: [], group: 0 }];
  let groups = 0;
  let spans = false;
  const top = () => stack[stack.length - 1].items;
  const quantify = (min: number, max: number, what: string) => {
    const items = top();
    const last = items[items.length - 1];
    if (!last || last.k === "assert" || last.k === "rep") {
      throw new PatternError("invalid_pattern", `${what} needs something to repeat before it`);
    }
    items[items.length - 1] = { k: "rep", body: last, min, max, lazy: false };
  };
  let i = 0;
  while (i < chars.length) {
    const c = chars[i++];
    switch (c) {
      case "?":
        top().push(charNode(ANY));
        break;
      case "*":
        top().push(star(charNode(ANY), true));
        break;
      case "@":
        quantify(1, -1, "@");
        break;
      case "<":
        top().push({ k: "assert", kind: "wordStart" });
        break;
      case ">":
        top().push({ k: "assert", kind: "wordEnd" });
        break;
      case "(":
        stack.push({ items: [], group: ++groups });
        break;
      case ")": {
        if (stack.length === 1) throw new PatternError("invalid_pattern", "a ) has no opening (");
        const frame = stack.pop()!;
        top().push({ k: "group", index: frame.group, body: { k: "cat", items: frame.items } });
        break;
      }
      case "{": {
        const end = chars.indexOf("}", i);
        if (end < 0) throw new PatternError("invalid_pattern", "a { needs a closing }");
        const { min, max } = parseCount(chars.slice(i, end).join(""));
        quantify(min, max, `{${chars.slice(i, end).join("")}}`);
        i = end + 1;
        break;
      }
      case "[": {
        const end = chars.indexOf("]", i);
        if (end < 0) throw new PatternError("invalid_pattern", "a [ needs a closing ]");
        top().push(charNode(parseClass(chars.slice(i, end))));
        i = end + 1;
        break;
      }
      case "\\": {
        if (i >= chars.length) {
          top().push(exact(92));
        } else if (/[0-9]/.test(chars[i])) {
          throw new PatternError("invalid_pattern", "back-references (\\1) work in Replace with, not in Find what");
        } else {
          top().push(exact(cpOf(chars[i++])));
        }
        break;
      }
      case "^": {
        if (i >= chars.length) {
          top().push(exact(94));
          break;
        }
        const n = chars[i];
        const code = findCode(n);
        if (code) {
          if (n === "p") spans = true;
          top().push(code);
          i++;
          break;
        }
        const num = numericCode(chars, i);
        if (num) {
          if (num.cp === PARA) spans = true;
          top().push(exact(num.cp));
          i += num.used;
        } else {
          top().push(exact(94));
        }
        break;
      }
      default:
        top().push(exact(cpOf(c)));
    }
  }
  if (stack.length > 1) throw new PatternError("invalid_pattern", "a ( needs a closing )");
  return { node: { k: "cat", items: stack[0].items }, spans, groups };
}

// ---------------------------------------------------------------------------
// Program and Pike VM
// ---------------------------------------------------------------------------

enum Op {
  Char,
  Split,
  Jmp,
  Save,
  Assert,
  Match,
}

type Inst =
  | { op: Op.Char; test: CharTest }
  | { op: Op.Split; x: number; y: number }
  | { op: Op.Jmp; x: number }
  | { op: Op.Save; n: number }
  | { op: Op.Assert; kind: AssertKind }
  | { op: Op.Match };

function compileProgram(node: Node): Inst[] {
  const prog: Inst[] = [];
  const push = (inst: Inst): number => {
    if (prog.length >= MAX_PROGRAM_SIZE) {
      throw new PatternError("too_complex", "the pattern is too complex (too many repeats)");
    }
    prog.push(inst);
    return prog.length - 1;
  };
  const emit = (n: Node): void => {
    switch (n.k) {
      case "char":
        push({ op: Op.Char, test: n.test });
        return;
      case "cat":
        n.items.forEach(emit);
        return;
      case "group":
        push({ op: Op.Save, n: 2 * n.index });
        emit(n.body);
        push({ op: Op.Save, n: 2 * n.index + 1 });
        return;
      case "assert":
        push({ op: Op.Assert, kind: n.kind });
        return;
      case "rep": {
        for (let k = 0; k < n.min; k++) emit(n.body);
        if (n.max < 0) {
          const split = push({ op: Op.Split, x: 0, y: 0 });
          emit(n.body);
          push({ op: Op.Jmp, x: split });
          const exit = prog.length;
          const inst = prog[split] as { op: Op.Split; x: number; y: number };
          inst.x = n.lazy ? exit : split + 1;
          inst.y = n.lazy ? split + 1 : exit;
          return;
        }
        const splits: number[] = [];
        for (let k = n.min; k < n.max; k++) {
          splits.push(push({ op: Op.Split, x: 0, y: 0 }));
          emit(n.body);
        }
        const exit = prog.length;
        for (const s of splits) {
          const inst = prog[s] as { op: Op.Split; x: number; y: number };
          inst.x = n.lazy ? exit : s + 1;
          inst.y = n.lazy ? s + 1 : exit;
        }
        return;
      }
    }
  };
  push({ op: Op.Save, n: 0 });
  emit(node);
  push({ op: Op.Save, n: 1 });
  push({ op: Op.Match });
  return prog;
}

function checkAssert(kind: AssertKind, hay: string, pos: number): boolean {
  const before = isWordChar(cpBefore(hay, pos));
  const after = isWordChar(cpAt(hay, pos));
  switch (kind) {
    case "boundary": return before !== after;
    case "wordStart": return !before && after;
    case "wordEnd": return before && !after;
  }
}

/**
 * Leftmost-first search (Perl/Rust priorities: greedy, lazy) with a Pike VM:
 * every position is visited once per live instruction, so time is
 * O(text × program) whatever the pattern.
 */
function pikeExec(
  prog: Inst[],
  groupCount: number,
  caseInsensitive: boolean,
  hay: string,
  start: number,
  end: number,
  budget: SearchBudget,
): PatternMatch | null | "budget" {
  const ncap = 2 * (groupCount + 1);
  const mark = new Int32Array(prog.length);
  let gen = 1;
  let clistPc: number[] = [];
  let clistCaps: Int32Array[] = [];
  let nlistPc: number[] = [];
  let nlistCaps: Int32Array[] = [];
  const stackPc: number[] = [];
  const stackCaps: Int32Array[] = [];
  let matched: Int32Array | null = null;
  const initial = new Int32Array(ncap).fill(-1);

  const add = (listPc: number[], listCaps: Int32Array[], pc0: number, caps0: Int32Array, pos: number) => {
    stackPc.push(pc0);
    stackCaps.push(caps0);
    while (stackPc.length) {
      const pc = stackPc.pop()!;
      const caps = stackCaps.pop()!;
      if (mark[pc] === gen) continue;
      mark[pc] = gen;
      const inst = prog[pc];
      switch (inst.op) {
        case Op.Jmp:
          stackPc.push(inst.x);
          stackCaps.push(caps);
          break;
        case Op.Split:
          stackPc.push(inst.y, inst.x);
          stackCaps.push(caps, caps);
          break;
        case Op.Save: {
          const next = caps.slice();
          next[inst.n] = pos;
          stackPc.push(pc + 1);
          stackCaps.push(next);
          break;
        }
        case Op.Assert:
          if (checkAssert(inst.kind, hay, pos)) {
            stackPc.push(pc + 1);
            stackCaps.push(caps);
          }
          break;
        default:
          listPc.push(pc);
          listCaps.push(caps);
      }
    }
  };

  let i = start;
  if (budget.steps <= 0 || now() > budget.deadline) {
    budget.exhausted = true;
    return "budget";
  }
  let steps = 0;
  for (;;) {
    if (!matched) add(clistPc, clistCaps, 0, initial, i);
    const cp = i < end ? hay.codePointAt(i)! : -1;
    const width = cp > 0xffff ? 2 : 1;
    if (clistPc.length === 0) {
      // Nothing alive here (e.g. an assertion failed at the start): move on.
      if (matched || i >= end) break;
      gen++;
      i += width;
      continue;
    }
    const folded = cp >= 0 && caseInsensitive ? foldCodePoint(cp) : cp;
    gen++;
    nlistPc = [];
    nlistCaps = [];
    for (let t = 0; t < clistPc.length; t++) {
      if (++steps >= 4096) {
        budget.steps -= steps;
        steps = 0;
        if (budget.steps <= 0 || now() > budget.deadline) {
          budget.exhausted = true;
          return "budget";
        }
      }
      const inst = prog[clistPc[t]];
      if (inst.op === Op.Char) {
        if (cp >= 0 && inst.test(cp, folded)) add(nlistPc, nlistCaps, clistPc[t] + 1, clistCaps[t], i + width);
      } else if (inst.op === Op.Match) {
        matched = clistCaps[t];
        // Lower-priority threads lose to this match.
        break;
      }
    }
    clistPc = nlistPc;
    clistCaps = nlistCaps;
    if (i >= end) break;
    i += width;
  }
  budget.steps -= steps;
  if (!matched) return null;
  const groups: (string | undefined)[] = [];
  for (let g = 0; g <= groupCount; g++) {
    const a = matched[2 * g];
    const b = matched[2 * g + 1];
    groups.push(a >= 0 && b >= 0 ? hay.slice(a, b) : undefined);
  }
  return { start: matched[0], end: matched[1], groups };
}

// ---------------------------------------------------------------------------
// Raw regex mode
// ---------------------------------------------------------------------------

const WORD_CLASS = "[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]";
const REGEX_BOUNDARY = `(?:(?<=${WORD_CLASS})(?!${WORD_CLASS})|(?<!${WORD_CLASS})(?=${WORD_CLASS}))`;

/**
 * Rejects a repeated group that itself contains a repeat (`(a+)+`, `(\w*)*`),
 * the shape behind most catastrophic backtracking in `RegExp`.
 */
function hasNestedRepeat(source: string): boolean {
  /** The quantifier at `i`: whether it repeats at all, and whether more than once. */
  const quantifierAt = (i: number): { repeats: boolean; many: boolean } => {
    const c = source[i];
    if (c === "*" || c === "+") return { repeats: true, many: true };
    if (c === "{") {
      const m = /^\{(\d*)(,?)(\d*)\}/.exec(source.slice(i));
      if (m) {
        const max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : Number(m[1]);
        return { repeats: max > 1, many: max > 1 };
      }
    }
    return { repeats: false, many: false };
  };
  // For each open group: whether it contains a repeat.
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      stack.push(false);
    } else if (c === ")") {
      const inner = stack.pop() ?? false;
      const q = quantifierAt(i + 1);
      if (inner && q.many) return true;
      if (stack.length && (inner || q.repeats)) stack[stack.length - 1] = true;
    } else if (stack.length && quantifierAt(i).repeats) {
      stack[stack.length - 1] = true;
    }
  }
  return false;
}

function compileRegex(query: string, o: FindOptions): CompiledFindPattern {
  if (hasNestedRepeat(query)) {
    throw new PatternError(
      "too_complex",
      "a repeated group containing a repeat, like (a+)+, can take exponential time; rewrite it without nesting",
    );
  }
  let source = query;
  if (o.wholeWord || (o.matchPrefix && o.matchSuffix)) source = `${REGEX_BOUNDARY}(?:${query})${REGEX_BOUNDARY}`;
  else if (o.matchPrefix) source = `${REGEX_BOUNDARY}(?:${query})`;
  else if (o.matchSuffix) source = `(?:${query})${REGEX_BOUNDARY}`;
  let re: RegExp;
  try {
    re = new RegExp(source, o.matchCase ? "gu" : "giu");
  } catch (error) {
    throw new PatternError("invalid_pattern", `bad pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
  let slicedFor: { hay: string; end: number; text: string } | null = null;
  return {
    mode: "regex",
    spansParagraphs: false,
    caseInsensitive: !o.matchCase,
    groupCount: 0,
    exec(hay, start, end, budget) {
      if (now() > budget.deadline) {
        budget.exhausted = true;
        return "budget";
      }
      let text = hay;
      if (end < hay.length) {
        if (!slicedFor || slicedFor.hay !== hay || slicedFor.end !== end) {
          slicedFor = { hay, end, text: hay.slice(0, end) };
        }
        text = slicedFor.text;
      }
      re.lastIndex = start;
      const m = re.exec(text);
      if (!m) return null;
      return { start: m.index, end: m.index + m[0].length, groups: Array.from(m) };
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Translates Word's Find what text. Never throws: invalid text returns `{ ok: false, error }`. */
export function compileFindPattern(query: string, options: FindOptions = {}): CompileFindPatternResult {
  try {
    if (Array.from(query).length > MAX_FIND_PATTERN_LENGTH) {
      throw new PatternError("too_long", `the Find what text is longer than ${MAX_FIND_PATTERN_LENGTH} characters`);
    }
    if (options.regex) return { ok: true, pattern: compileRegex(query, options) };

    const wildcards = !!options.wildcards && !options.literal;
    // Word's wildcard search always matches case.
    const caseInsensitive = !options.matchCase && !wildcards;
    let node: Node;
    let spans: boolean;
    let groups = 0;
    if (wildcards) {
      ({ node, spans, groups } = parseWildcards(query));
    } else {
      ({ node, spans } = parseSpecial(query, options, caseInsensitive));
      const before = options.wholeWord || options.matchPrefix;
      const after = options.wholeWord || options.matchSuffix;
      if (before || after) {
        const items: Node[] = [];
        if (before) items.push({ k: "assert", kind: "boundary" });
        items.push(node);
        if (after) items.push({ k: "assert", kind: "boundary" });
        node = { k: "cat", items };
      }
    }
    const prog = compileProgram(node);
    return {
      ok: true,
      pattern: {
        mode: wildcards ? "wildcards" : "special",
        spansParagraphs: spans,
        caseInsensitive,
        groupCount: groups,
        exec: (hay, start, end, budget) => pikeExec(prog, groups, caseInsensitive, hay, start, end, budget),
      },
    };
  } catch (error) {
    if (error instanceof PatternError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "invalid_pattern", message: error instanceof Error ? error.message : String(error) } };
  }
}

export interface FindAllOptions {
  /**
   * Offsets where the live text breaks (e.g. where tracked-deleted text was
   * skipped): no match spans a cut.
   */
  cuts?: readonly number[];
  budget?: SearchBudget;
  /** Stop after this many matches (default 10 000). */
  maxMatches?: number;
}

export interface FindAllResult {
  matches: PatternMatch[];
  /** The search stopped early (match cap or time budget). */
  truncated: boolean;
}

/**
 * Every non-empty match in `hay`, left to right, without overlaps. Empty
 * matches are stepped past so the search always moves on.
 */
export function findAllMatches(
  pattern: CompiledFindPattern,
  hay: string,
  options: FindAllOptions = {},
): FindAllResult {
  const budget = options.budget ?? createSearchBudget();
  const maxMatches = options.maxMatches ?? 10_000;
  const cuts = [...(options.cuts ?? []), hay.length].sort((a, b) => a - b);
  const matches: PatternMatch[] = [];
  let from = 0;
  for (const cut of cuts) {
    if (cut <= from) continue;
    let pos = from;
    from = cut;
    for (;;) {
      const m = pattern.exec(hay, pos, cut, budget);
      if (m === "budget") return { matches, truncated: true };
      if (!m) break;
      const empty = m.end === m.start;
      const next = empty ? m.end + (cpAt(hay, m.end) > 0xffff ? 2 : 1) : m.end;
      if (next > cut) break;
      pos = next;
      if (empty) continue;
      matches.push(m);
      if (matches.length >= maxMatches) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

/** A piece of Replace with text. */
export type ReplacePiece =
  | { type: "text"; text: string }
  /** `^&`: the text found. */
  | { type: "found" }
  /** `\n` with wildcards: group `n`. */
  | { type: "group"; index: number }
  /** `^c`: the clipboard. */
  | { type: "clipboard" };

/** Reads Replace with text: `^` codes (unless `literal`), and `\1`–`\9` with wildcards. Regex mode is literal. */
export function parseReplacement(replacement: string, options: FindOptions = {}): ReplacePiece[] {
  if (options.literal || options.regex) return replacement ? [{ type: "text", text: replacement }] : [];
  const chars = toChars(replacement);
  const out: ReplacePiece[] = [];
  let cur = "";
  const flush = () => {
    if (cur) out.push({ type: "text", text: cur });
    cur = "";
  };
  let i = 0;
  while (i < chars.length) {
    const c = chars[i++];
    if (c === "\\" && options.wildcards && i < chars.length) {
      const d = chars[i];
      if (/[1-9]/.test(d)) {
        flush();
        out.push({ type: "group", index: Number(d) });
      } else {
        cur += d;
      }
      i++;
      continue;
    }
    if (c === "^" && i < chars.length) {
      const n = chars[i];
      if (n === "&" || n === "c") {
        flush();
        out.push(n === "&" ? { type: "found" } : { type: "clipboard" });
        i++;
        continue;
      }
      const code = replaceCode(n);
      if (code !== null) {
        cur += code;
        i++;
        continue;
      }
      const num = numericCode(chars, i);
      if (num) {
        cur += String.fromCodePoint(num.cp);
        i += num.used;
        continue;
      }
    }
    cur += c;
  }
  flush();
  return out;
}

/** Fills in Replace with text for one match. Paragraph marks in the result are `\r`. */
export function expandReplacement(pieces: readonly ReplacePiece[], match: PatternMatch, clipboardText = ""): string {
  let out = "";
  for (const piece of pieces) {
    switch (piece.type) {
      case "text":
        out += piece.text;
        break;
      case "found":
        out += match.groups[0] ?? "";
        break;
      case "group":
        out += match.groups[piece.index] ?? "";
        break;
      case "clipboard":
        out += clipboardText.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
        break;
    }
  }
  return out;
}
