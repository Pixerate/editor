// Portions ported from gridcraft/crates/numfmt/src/parse.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/** Number format code parsing: sections, bracket tags and tokens. */

/** Colour from a `[Red]` or `[ColorN]` section tag (`color1`…`color56` = palette index). */
export type NumberFormatColor =
  | 'black'
  | 'blue'
  | 'cyan'
  | 'green'
  | 'magenta'
  | 'red'
  | 'white'
  | 'yellow'
  | `color${number}`;

/** At most this many sections are honoured (`pos;neg;zero;text`); extra ones are ignored. */
const MAX_SECTIONS = 4;

export type DatePart =
  | { k: 'year' | 'month' | 'minute' | 'day' | 'hour' | 'second' | 'subsec' | 'eh' | 'em' | 'es'; n: number }
  | { k: 'ampm' }
  /** `A/P` with the letters as typed. */
  | { k: 'ap'; a: string; p: string };

export const isCalendarPart = (d: DatePart): boolean => d.k === 'year' || d.k === 'month' || d.k === 'day';

export type Tok =
  | { t: 'lit'; s: string }
  /** `0`, `#` or `?`. */
  | { t: 'digit'; c: string }
  /** The decimal point (only the first one in a number section). */
  | { t: 'point' }
  /** Unresolved comma (resolved during analysis into thousands/scale markers or a literal). */
  | { t: 'comma' }
  | { t: 'percent' }
  | { t: 'exp'; upper: boolean; plus: boolean }
  /** The fraction bar (only after analysis decides the section is a fraction). */
  | { t: 'slash' }
  /** A fixed fraction denominator such as the `8` in `?/8`. */
  | { t: 'denom'; s: string }
  | { t: 'fill'; c: string }
  | { t: 'at' }
  | { t: 'general' }
  | { t: 'date'; d: DatePart };

/** The text a token shows when it has no special meaning in its section. */
export function literalText(tok: Tok): string {
  switch (tok.t) {
    case 'lit':
    case 'denom':
      return tok.s;
    case 'digit':
      return tok.c;
    case 'point':
      return '.';
    case 'comma':
      return ',';
    case 'percent':
      return '%';
    case 'exp':
      return `${tok.upper ? 'E' : 'e'}${tok.plus ? '+' : '-'}`;
    case 'slash':
      return '/';
    default:
      return '';
  }
}

export type CondOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

export interface Cond {
  op: CondOp;
  value: number;
}

export function testCond(c: Cond, v: number): boolean {
  switch (c.op) {
    case '=':
      return v === c.value;
    case '<>':
      return v !== c.value;
    case '<':
      return v < c.value;
    case '<=':
      return v <= c.value;
    case '>':
      return v > c.value;
    case '>=':
      return v >= c.value;
  }
}

export type SecKind = 'number' | 'date' | 'text' | 'general';

export interface Section {
  toks: Tok[];
  color?: NumberFormatColor;
  cond?: Cond;
  kind: SecKind;
  thousands: boolean;
  /** Number of scaling commas (each divides by 1000). */
  scale: number;
  percent: number;
  hasAt: boolean;
  hasDigits: boolean;
  exp: boolean;
  fraction: boolean;
  currency: boolean;
  fill: boolean;
}

const isDigitTok = (t: Tok | undefined, c?: string): boolean => t?.t === 'digit' && (c === undefined || t.c === c);

/**
 * Splits a code into sections at unquoted, unescaped, unbracketed semicolons.
 * A `[` opens a bracket only when a `]` follows it somewhere; the bracket then
 * runs to the next `]`. An unclosed `[` is a literal, so a later `;` still
 * separates sections. Linear in the code length.
 */
export function splitSections(code: string): string[] {
  const cs = Array.from(code);
  const lastClose = cs.lastIndexOf(']');
  const out: string[] = [''];
  let quoted = false;
  let escape = false;
  let i = 0;
  while (i < cs.length) {
    const c = cs[i];
    i += 1;
    const cur = out.length - 1;
    if (escape) {
      out[cur] += c;
      escape = false;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      out[cur] += c;
    } else if ((c === '\\' || c === '_' || c === '*') && !quoted) {
      escape = true;
      out[cur] += c;
    } else if (c === '[' && !quoted && lastClose >= i) {
      // `i` is already past the `[`; the closing bracket is at or after it.
      let s = c;
      while (i < cs.length) {
        const d = cs[i];
        i += 1;
        s += d;
        if (d === ']') break;
      }
      out[cur] += s;
    } else if (c === ';' && !quoted) {
      if (out.length >= MAX_SECTIONS) break;
      out.push('');
    } else {
      out[cur] += c;
    }
  }
  return out;
}

const lowerAscii = (c: string) => (c >= 'A' && c <= 'Z' ? c.toLowerCase() : c);

function startsWithCi(cs: string[], i: number, pat: string): boolean {
  for (let k = 0; k < pat.length; k++) {
    const c = cs[i + k];
    if (c === undefined || lowerAscii(c) !== pat[k]) return false;
  }
  return true;
}

function pushLit(toks: Tok[], s: string): void {
  if (s === '') return;
  const last = toks[toks.length - 1];
  if (last?.t === 'lit') last.s += s;
  else toks.push({ t: 'lit', s });
}

const CURRENCY_CHARS = new Set(['$', '€', '£', '¥', '₹', '₩', '₽', '¢', '₪', '₫', '฿']);
const isCurrencyChar = (c: string) => CURRENCY_CHARS.has(c);

const NAMED_COLORS = new Set(['black', 'blue', 'cyan', 'green', 'magenta', 'red', 'white', 'yellow']);

function parseColor(lc: string): NumberFormatColor | undefined {
  if (NAMED_COLORS.has(lc)) return lc as NumberFormatColor;
  if (!lc.startsWith('color')) return undefined;
  const rest = lc.slice(5).trim();
  if (!/^\+?\d{1,3}$/.test(rest)) return undefined;
  const n = Number(rest);
  return n >= 1 && n <= 56 ? `color${n}` : undefined;
}

function parseCond(s: string): Cond | undefined {
  const t = s.trim();
  let op: CondOp;
  let rest: string;
  if (t.startsWith('<=')) [op, rest] = ['<=', t.slice(2)];
  else if (t.startsWith('>=')) [op, rest] = ['>=', t.slice(2)];
  else if (t.startsWith('<>')) [op, rest] = ['<>', t.slice(2)];
  else if (t.startsWith('<')) [op, rest] = ['<', t.slice(1)];
  else if (t.startsWith('>')) [op, rest] = ['>', t.slice(1)];
  else if (t.startsWith('=')) [op, rest] = ['=', t.slice(1)];
  else return undefined;
  const r = rest.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(r)) return undefined;
  const value = Number(r);
  return Number.isFinite(value) ? { op, value } : undefined;
}

interface Raw {
  toks: Tok[];
  color?: NumberFormatColor;
  cond?: Cond;
  currency: boolean;
}

/** Handles the content of a `[...]` tag. */
function bracket(raw: Raw, content: string): void {
  const lc = content.trim().toLowerCase();
  const color = parseColor(lc);
  if (color) {
    raw.color = color;
    return;
  }
  if (lc.startsWith('<') || lc.startsWith('>') || lc.startsWith('=')) {
    const c = parseCond(lc);
    if (c) raw.cond = c;
    return;
  }
  if (content.startsWith('$')) {
    const sym = content.slice(1).split('-')[0];
    if (sym !== '') {
      raw.currency = true;
      pushLit(raw.toks, sym);
    }
    return;
  }
  const first = lc[0];
  if ((first === 'h' || first === 'm' || first === 's') && Array.from(lc).every((c) => c === first)) {
    const n = Math.min(Array.from(lc).length, 255);
    raw.toks.push({ t: 'date', d: { k: first === 'h' ? 'eh' : first === 'm' ? 'em' : 'es', n } });
  }
  // Anything else ([DBNum1], [natural], locale tags…) is ignored.
}

function tokenize(src: string): Raw {
  const cs = Array.from(src);
  const raw: Raw = { toks: [], currency: false };
  const toks = raw.toks;
  // With no `]` after a `[`, that `[` is a literal; checking this once keeps the scan linear.
  const lastClose = cs.lastIndexOf(']');
  let i = 0;
  while (i < cs.length) {
    const c = cs[i];
    if (c === '"') {
      let s = '';
      i += 1;
      while (i < cs.length) {
        const d = cs[i];
        i += 1;
        if (d === '"') break;
        s += d;
      }
      if (Array.from(s).some(isCurrencyChar)) raw.currency = true;
      pushLit(toks, s);
      continue;
    }
    if (c === '\\') {
      const d = cs[i + 1];
      if (d !== undefined) {
        if (isCurrencyChar(d)) raw.currency = true;
        pushLit(toks, d);
      }
      i += 2;
      continue;
    }
    if (c === '_') {
      if (cs[i + 1] !== undefined) pushLit(toks, ' ');
      i += 2;
      continue;
    }
    if (c === '*') {
      const d = cs[i + 1];
      if (d !== undefined) toks.push({ t: 'fill', c: d });
      i += 2;
      continue;
    }
    if (c === '[') {
      const close = lastClose > i ? cs.indexOf(']', i + 1) : -1;
      if (close !== -1) {
        bracket(raw, cs.slice(i + 1, close).join(''));
        i = close + 1;
      } else {
        pushLit(toks, '[');
        i += 1;
      }
      continue;
    }
    if (c === '0' || c === '#' || c === '?') toks.push({ t: 'digit', c });
    else if (c === '.') toks.push({ t: 'point' });
    else if (c === ',') toks.push({ t: 'comma' });
    else if (c === '%') toks.push({ t: 'percent' });
    else if (c === '@') toks.push({ t: 'at' });
    else if (c === '/') {
      toks.push({ t: 'slash' });
      i += 1;
      if (cs[i] !== undefined && cs[i] >= '1' && cs[i] <= '9') {
        let s = '';
        while (i < cs.length && cs[i] >= '0' && cs[i] <= '9') {
          s += cs[i];
          i += 1;
        }
        toks.push({ t: 'denom', s });
      }
      continue;
    } else if ((c === 'e' || c === 'E') && (cs[i + 1] === '+' || cs[i + 1] === '-')) {
      toks.push({ t: 'exp', upper: c === 'E', plus: cs[i + 1] === '+' });
      i += 2;
      continue;
    } else if ((c === 'G' || c === 'g') && startsWithCi(cs, i, 'general')) {
      toks.push({ t: 'general' });
      i += 7;
      continue;
    } else if ((c === 'A' || c === 'a') && startsWithCi(cs, i, 'am/pm')) {
      toks.push({ t: 'date', d: { k: 'ampm' } });
      i += 5;
      continue;
    } else if ((c === 'A' || c === 'a') && startsWithCi(cs, i, 'a/p')) {
      toks.push({ t: 'date', d: { k: 'ap', a: c, p: cs[i + 2] ?? 'P' } });
      i += 3;
      continue;
    } else if ('yYmMdDhHsSeE'.includes(c)) {
      const lc = lowerAscii(c);
      let n = 0;
      while (cs[i + n] !== undefined && lowerAscii(cs[i + n]) === lc) n += 1;
      const n8 = Math.min(n, 255);
      const d: DatePart =
        lc === 'y'
          ? { k: 'year', n: n8 }
          : lc === 'e'
            ? { k: 'year', n: 4 }
            : lc === 'm'
              ? { k: 'month', n: n8 }
              : lc === 'd'
                ? { k: 'day', n: n8 }
                : lc === 'h'
                  ? { k: 'hour', n: n8 }
                  : { k: 'second', n: n8 };
      toks.push({ t: 'date', d });
      i += Math.max(n, 1);
      continue;
    } else {
      if (isCurrencyChar(c)) raw.currency = true;
      pushLit(toks, c);
    }
    i += 1;
  }
  return raw;
}

const datePartOf = (t: Tok | undefined): DatePart | undefined => (t?.t === 'date' ? t.d : undefined);

function analyze(raw: Raw): Section {
  const toks = raw.toks;
  const isDate = toks.some((t) => t.t === 'date');
  const hasGeneral = toks.some((t) => t.t === 'general');
  const sec: Section = {
    toks: [],
    color: raw.color,
    cond: raw.cond,
    kind: 'number',
    thousands: false,
    scale: 0,
    percent: 0,
    hasAt: toks.some((t) => t.t === 'at'),
    hasDigits: false,
    exp: false,
    fraction: false,
    currency: raw.currency,
    fill: toks.some((t) => t.t === 'fill'),
  };
  if (isDate) {
    sec.kind = 'date';
    // m/mm after hours or before seconds means minutes. Scanning for the
    // nearest date part either side is linear overall (prev/next are tracked).
    const prevPart: Array<DatePart | undefined> = [];
    let last: DatePart | undefined;
    for (let i = 0; i < toks.length; i++) {
      prevPart.push(last);
      const d = datePartOf(toks[i]);
      if (d) last = d;
    }
    const nextPart: Array<DatePart | undefined> = new Array(toks.length);
    let next: DatePart | undefined;
    for (let i = toks.length - 1; i >= 0; i--) {
      nextPart[i] = next;
      const d = datePartOf(toks[i]);
      if (d) next = d;
    }
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t !== 'date' || t.d.k !== 'month' || t.d.n > 2) continue;
      const prev = prevPart[i];
      const nxt = nextPart[i];
      const afterH = prev?.k === 'hour' || prev?.k === 'eh';
      const beforeS = nxt?.k === 'second' || nxt?.k === 'es';
      if (afterH || beforeS) toks[i] = { t: 'date', d: { k: 'minute', n: t.d.n } };
    }
    const out: Tok[] = [];
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (t.t === 'point' && isDigitTok(toks[i + 1], '0')) {
        let n = 0;
        while (isDigitTok(toks[i + 1 + n], '0')) n += 1;
        out.push({ t: 'date', d: { k: 'subsec', n: Math.min(n, 255) } });
        i += 1 + n;
        continue;
      }
      if (t.t === 'date' || t.t === 'fill') out.push(t);
      else pushLit(out, literalText(t));
      i += 1;
    }
    sec.toks = out;
    return sec;
  }
  if (hasGeneral) {
    sec.kind = 'general';
    const out: Tok[] = [];
    for (const t of toks) {
      if (t.t === 'general' || t.t === 'fill') out.push(t);
      else pushLit(out, literalText(t));
    }
    sec.toks = out;
    return sec;
  }
  sec.hasDigits = toks.some((t) => t.t === 'digit');
  if (sec.hasAt && !sec.hasDigits) {
    sec.kind = 'text';
    const out: Tok[] = [];
    for (const t of toks) {
      if (t.t === 'at' || t.t === 'fill') out.push(t);
      else pushLit(out, literalText(t));
    }
    sec.toks = out;
    return sec;
  }
  // Number section.
  let seenPoint = false;
  let seenExp = false;
  let seenDigit = false;
  let fractionSlash = false;
  // Precomputed so each comma and slash is O(1): whether the first non-comma
  // token after a position is a digit, the first non-literal token after a
  // position, and where the last exponent marker is.
  const digitAfterCommas: boolean[] = new Array(toks.length).fill(false);
  const firstNonLitAfter: Array<Tok | undefined> = new Array(toks.length);
  let after = false;
  let nonLit: Tok | undefined;
  for (let j = toks.length - 1; j >= 0; j--) {
    digitAfterCommas[j] = after;
    firstNonLitAfter[j] = nonLit;
    const t = toks[j];
    if (t.t !== 'comma') after = t.t === 'digit';
    if (t.t !== 'lit') nonLit = t;
  }
  let lastExp = -1;
  for (let j = toks.length - 1; j >= 0; j--) {
    if (toks[j].t === 'exp') {
      lastExp = j;
      break;
    }
  }
  const firstDigit = toks.findIndex((t) => t.t === 'digit');
  const scientific = firstDigit !== -1 && toks.slice(firstDigit).some((t) => t.t === 'exp');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let replace: Tok | undefined;
    switch (t.t) {
      case 'digit':
        seenDigit = true;
        break;
      case 'point':
        if (seenPoint || seenExp) replace = { t: 'lit', s: '.' };
        else seenPoint = true;
        break;
      case 'percent':
        sec.percent += 1;
        break;
      case 'exp':
        if (seenExp || !seenDigit) replace = { t: 'lit', s: literalText(t) };
        else {
          seenExp = true;
          sec.exp = true;
        }
        break;
      case 'comma': {
        const nextDigit = digitAfterCommas[i];
        if (seenDigit && nextDigit && !seenPoint && !seenExp) {
          sec.thousands = true;
          replace = { t: 'lit', s: '' };
        } else if (seenDigit && scientific) {
          // Observed: a scientific section never scales; any other comma after
          // the first digit shows nothing (`#,e+#`, `#e+#,`, `#e+000,00`).
          replace = { t: 'lit', s: '' };
        } else if (seenDigit && !nextDigit) {
          sec.scale += 1;
          replace = { t: 'lit', s: '' };
        } else {
          replace = { t: 'lit', s: ',' };
        }
        break;
      }
      case 'slash': {
        // Literal text may sit between the bar and the denominator (`#/ #`, `# ?=/=?`).
        const nextOk = toks[i + 1]?.t === 'denom' || firstNonLitAfter[i]?.t === 'digit';
        // An exponent kept before this bar or any marker still ahead of it.
        const hasExp = seenExp || lastExp > i;
        if (!fractionSlash && seenDigit && nextOk && !seenPoint && !hasExp) {
          fractionSlash = true;
          sec.fraction = true;
        } else {
          replace = { t: 'lit', s: '/' };
        }
        break;
      }
      case 'denom':
        if (!(toks[i - 1]?.t === 'slash' && sec.fraction)) replace = { t: 'lit', s: t.s };
        break;
      default:
        break;
    }
    if (replace) toks[i] = replace;
  }
  if (sec.fraction) {
    // A decimal point in a fraction section is literal.
    for (let i = 0; i < toks.length; i++) if (toks[i].t === 'point') toks[i] = { t: 'lit', s: '.' };
  }
  // Merge literals (removed commas left empty ones).
  const out: Tok[] = [];
  for (const t of toks) {
    if (t.t === 'lit') pushLit(out, t.s);
    else out.push(t);
  }
  sec.toks = out;
  return sec;
}

/** Parses a whole format code into its sections. */
export function parseSections(code: string): Section[] {
  return splitSections(code).map((s) => analyze(tokenize(s)));
}
