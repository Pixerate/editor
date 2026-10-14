// Portions ported from gridcraft/crates/numfmt/src/render.rs and gridcraft/crates/core/src/date.rs
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/** Rendering a value with a parsed section. */
import { decimalDigits, fixed, fixedFromDigits, formatGeneralFit } from './decimal';
import { isCalendarPart, literalText, type Section, type Tok } from './parse';

/** Last serial that is a valid date in the 1900 date system: 9999-12-31. */
export const MAX_DATE_SERIAL = 2_958_465;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UNIX_1899_12_30 = -25569;

/** Civil date for days since 1970-01-01 (Howard Hinnant's algorithm). */
function civilFromDays(z0: number): { y: number; m: number; d: number } {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/**
 * Year, month, day and weekday (0 = Sunday) of a whole 1900-system serial.
 * Serial 0 is the fictitious 1900-01-00 and serial 60 the fictitious
 * 1900-02-29; weekdays continue that calendar (serial 1 is a Sunday).
 */
export function dateFromSerial(day: number): { year: number; month: number; day: number; weekday: number } {
  const weekday = (((day + 6) % 7) + 7) % 7;
  if (day === 60) return { year: 1900, month: 2, day: 29, weekday };
  if (day === 0) return { year: 1900, month: 1, day: 0, weekday };
  const real = day < 60 ? day + 1 : day;
  const { y, m, d } = civilFromDays(real + UNIX_1899_12_30);
  return { year: y, month: m, day: d, weekday };
}

/** Text being built plus the first repeat-fill position. */
export class Out {
  text = '';
  fill: { char: string; index: number } | undefined;
  /** True when every digit shown is zero (a number section that rounded to zero). */
  zero = false;
  push(s: string): void {
    this.text += s;
  }
  setFill(c: string): void {
    if (!this.fill) this.fill = { char: c, index: this.text.length };
  }
  prepend(s: string): void {
    this.text = s + this.text;
    if (this.fill) this.fill.index += s.length;
  }
}

/** Renders a text value through a text section (`@` is replaced by the text). */
export function renderText(sec: Section, text: string): Out {
  const out = new Out();
  for (const t of sec.toks) {
    if (t.t === 'at') out.push(text);
    else if (t.t === 'fill') out.setFill(t.c);
    else out.push(literalText(t));
  }
  return out;
}

/** Renders a number through a General section (literals around the General keyword). */
export function renderGeneral(sec: Section, v: number, width: number): Out {
  const out = new Out();
  for (const t of sec.toks) {
    if (t.t === 'general') out.push(formatGeneralFit(v, width) ?? '#'.repeat(Math.min(Math.max(width, 1), 11)));
    else if (t.t === 'fill') out.setFill(t.c);
    else out.push(literalText(t));
  }
  return out;
}

const padNum = (n: number, w: number) => (w >= 2 ? String(n).padStart(Math.min(w, 20), '0') : String(n));

/** Renders a date/time. `null` when the serial is outside the supported range. */
export function renderDate(sec: Section, v: number): Out | null {
  if (!Number.isFinite(v) || v < 0 || v >= MAX_DATE_SERIAL + 1) return null;
  let subDigits = 0;
  for (const t of sec.toks) if (t.t === 'date' && t.d.k === 'subsec') subDigits = Math.max(subDigits, t.d.n);
  subDigits = Math.min(subDigits, 3);
  const unit = 10 ** (3 - subDigits);
  let day = Math.floor(v);
  let ms = Math.round(((v - Math.floor(v)) * 86_400_000) / unit) * unit;
  if (ms >= 86_400_000) {
    ms -= 86_400_000;
    day += 1;
  }
  const totalMs = day * 86_400_000 + ms;
  const needsDate = sec.toks.some((t) => t.t === 'date' && isCalendarPart(t.d));
  if (needsDate && day > MAX_DATE_SERIAL) return null;
  const dt = needsDate ? dateFromSerial(day) : dateFromSerial(0);
  const ampm = sec.toks.some((t) => t.t === 'date' && (t.d.k === 'ampm' || t.d.k === 'ap'));
  const hour = Math.floor(ms / 3_600_000);
  const minute = Math.floor(ms / 60_000) % 60;
  const second = Math.floor(ms / 1000) % 60;
  const milli = ms % 1000;
  const monthName = MONTHS[dt.month - 1] ?? '';
  const dayName = WEEKDAYS[dt.weekday] ?? '';
  const out = new Out();
  for (const t of sec.toks) {
    if (t.t === 'fill') {
      out.setFill(t.c);
      continue;
    }
    if (t.t !== 'date') {
      out.push(literalText(t));
      continue;
    }
    const d = t.d;
    let s: string;
    switch (d.k) {
      case 'year':
        s = d.n <= 2 ? String(((dt.year % 100) + 100) % 100).padStart(2, '0') : String(dt.year).padStart(4, '0');
        break;
      case 'month':
        s = d.n <= 2 ? padNum(dt.month, d.n) : d.n === 3 ? monthName.slice(0, 3) : d.n === 5 ? monthName.slice(0, 1) : monthName;
        break;
      case 'day':
        s = d.n <= 2 ? padNum(dt.day, d.n) : d.n === 3 ? dayName.slice(0, 3) : dayName;
        break;
      case 'hour':
        s = padNum(ampm ? hour % 12 || 12 : hour, d.n);
        break;
      case 'minute':
        s = padNum(minute, d.n);
        break;
      case 'second':
        s = padNum(second, d.n);
        break;
      case 'subsec': {
        s = `.${String(milli).padStart(3, '0')}`.slice(0, 1 + Math.min(d.n, 3));
        if (d.n > 3) s += '0'.repeat(d.n - 3);
        break;
      }
      case 'eh':
        s = padNum(Math.floor(totalMs / 3_600_000), d.n);
        break;
      case 'em':
        s = padNum(Math.floor(totalMs / 60_000), d.n);
        break;
      case 'es':
        s = padNum(Math.floor(totalMs / 1000), d.n);
        break;
      case 'ampm':
        s = hour >= 12 ? 'PM' : 'AM';
        break;
      case 'ap':
        s = hour >= 12 ? d.p : d.a;
        break;
    }
    out.push(s);
  }
  return out;
}

const digitChar = (toks: Tok[], i: number): string => {
  const t = toks[i];
  return t?.t === 'digit' ? t.c : '0';
};

/**
 * Assigns integer digits right-to-left to the placeholders at `idxs`; the
 * leftmost placeholder takes all remaining digits. `forceZero` shows `0` in
 * the units placeholder when there are no digits. A blank `?` pads with a
 * space, and so does the thousands separator it would carry.
 */
function fillInt(toks: Tok[], idxs: number[], digits: string, thousands: boolean, forceZero: boolean, pieces: string[]): void {
  let rem = digits.length;
  let pos = 0;
  const count = idxs.length;
  for (let k = 0; k < count; k++) {
    const ti = idxs[count - 1 - k];
    const leftmost = k + 1 === count;
    const ph = digitChar(toks, ti);
    const rev: string[] = [];
    const pushDigit = (c: string) => {
      if (thousands && pos > 0 && pos % 3 === 0) rev.push(',');
      rev.push(c);
      pos += 1;
    };
    const take = leftmost ? rem : Math.min(rem, 1);
    if (take === 0) {
      if (ph === '0') pushDigit('0');
      else if (forceZero && k === 0) pushDigit('0');
      else if (ph === '?') {
        if (thousands && pos > 0 && pos % 3 === 0) rev.push(' ');
        rev.push(' ');
        pos += 1;
      }
    } else {
      for (let n = 0; n < take; n++) {
        rem -= 1;
        pushDigit(digits[rem] ?? '0');
      }
    }
    pieces[ti] = rev.reverse().join('');
  }
}

function withCommas(digits: string, thousands: boolean): string {
  if (!thousands) return digits;
  const n = digits.length;
  let s = '';
  for (let i = 0; i < n; i++) {
    if (i > 0 && (n - i) % 3 === 0) s += ',';
    s += digits[i];
  }
  return s;
}

/** Fraction-digit placeholders: trailing zeros show as `0`, nothing (`#`) or a space (`?`). */
function fillFrac(toks: Tok[], idxs: number[], frac: string, pieces: string[]): void {
  let lastSig = -1;
  for (let i = frac.length - 1; i >= 0; i--) {
    if (frac[i] !== '0') {
      lastSig = i;
      break;
    }
  }
  idxs.forEach((ti, i) => {
    const ph = digitChar(toks, ti);
    pieces[ti] = i <= lastSig ? (frac[i] ?? '0') : ph === '0' ? '0' : ph === '?' ? ' ' : '';
  });
}

function digitIndices(toks: Tok[], start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) if (toks[i]?.t === 'digit') out.push(i);
  return out;
}

/** Renders a non-negative number through a number section. */
export function renderNumber(sec: Section, v: number): Out {
  let x = Math.abs(v);
  // Observed: `%` in a scientific section is only a literal (`#%e+#` shows 123456.789 as `1%e+5`).
  if (sec.percent > 0 && !sec.exp) x *= 100 ** Math.min(sec.percent, 20);
  if (sec.scale > 0) x /= 1000 ** Math.min(sec.scale, 110);
  if (!Number.isFinite(x)) x = Number.MAX_VALUE;
  const toks = sec.toks;
  const n = toks.length;
  // Pieces replace the token's own output; `before` is inserted ahead of a
  // token; `lits` replaces a literal's text (fractions blank hidden parts).
  const pieces: string[] = new Array(n).fill('');
  const before: string[] = new Array(n + 1).fill('');
  const lits: Array<string | undefined> = new Array(n);
  let zero = false;
  if (sec.fraction) {
    renderFraction(sec, x, pieces, lits);
  } else {
    const pointIdx = toks.findIndex((t) => t.t === 'point');
    const expIdx = toks.findIndex((t) => t.t === 'exp');
    const point = pointIdx === -1 ? undefined : pointIdx;
    const exp = expIdx === -1 ? undefined : expIdx;
    const intEnd = point ?? exp ?? n;
    const fracEnd = exp ?? n;
    const intIdx = digitIndices(toks, 0, intEnd);
    const fracIdx = point === undefined ? [] : digitIndices(toks, point + 1, fracEnd);
    let intS: string;
    let fracS: string;
    if (exp !== undefined) {
      const expDigitIdx = digitIndices(toks, exp + 1, n);
      const step = Math.max(intIdx.length, 1);
      let e: number;
      if (x === 0) {
        // Observed: zero shows `0` in every integer placeholder, `#` and `?` too.
        e = 0;
        intS = '0'.repeat(intIdx.length);
        fracS = '0'.repeat(fracIdx.length);
      } else {
        const { digits, exp: xe } = decimalDigits(x);
        e = xe - (((xe % step) + step) % step);
        [intS, fracS] = fixedFromDigits(digits, xe - e, fracIdx.length);
        if (intS.length > step) {
          e += step;
          [intS, fracS] = fixedFromDigits(digits, xe - e, fracIdx.length);
        }
      }
      const et = toks[exp];
      const upper = et.t === 'exp' ? et.upper : true;
      const plus = et.t === 'exp' ? et.plus : true;
      if (intS === '' && /^0*$/.test(fracS)) e = 0;
      const head = upper ? 'E' : 'e';
      const sign = e < 0 ? '-' : plus ? '+' : '';
      const expDigits = String(Math.abs(e));
      // The sign sits right before the exponent digits, after any literal that
      // follows the `E`; `?` pads the digits with spaces.
      if (expDigitIdx.length > 0) {
        pieces[exp] = head;
        before[expDigitIdx[0]] = sign;
        fillInt(toks, expDigitIdx, expDigits, false, false, pieces);
      } else {
        pieces[exp] = `${head}${sign}${expDigits}`;
      }
    } else {
      [intS, fracS] = fixed(x, fracIdx.length);
    }
    zero = /^0*$/.test(intS + fracS);
    fillInt(toks, intIdx, intS, sec.thousands, false, pieces);
    const anchor = point ?? exp;
    if (intIdx.length === 0 && intS !== '' && anchor !== undefined) before[anchor] = withCommas(intS, sec.thousands);
    fillFrac(toks, fracIdx, fracS, pieces);
    if (point !== undefined) pieces[point] = '.';
  }
  const out = new Out();
  for (let i = 0; i < n; i++) {
    out.push(before[i]);
    const t = toks[i];
    if (t.t === 'lit') out.push(lits[i] ?? t.s);
    else if (t.t === 'percent') out.push('%');
    else if (t.t === 'fill') out.setFill(t.c);
    else if (t.t === 'at' || t.t === 'general' || t.t === 'date' || t.t === 'comma') continue;
    else out.push(pieces[i]);
  }
  out.zero = zero;
  return out;
}

/** Best rational approximation of `x` with denominator at most `maxDen` (continued fractions). */
export function approximate(x: number, maxDen: number): [number, number] {
  if (Number.isNaN(x) || x <= 0 || !Number.isFinite(x)) return [0, 1];
  if (x >= 1e15) return [Math.round(x), 1];
  let [p0, q0, p1, q1] = [0, 1, 1, 0];
  let r = x;
  for (let iter = 0; iter < 64; iter++) {
    const aF = Math.floor(r);
    if (aF > 1e15) break;
    const q2 = aF * q1 + q0;
    if (q2 > maxDen) break;
    const p2 = aF * p1 + p0;
    [p0, q0, p1, q1] = [p1, q1, p2, q2];
    const frac = r - aF;
    if (frac < 1e-12) break;
    r = 1 / frac;
  }
  if (q1 === 0) return [Math.round(x), 1];
  // Semiconvergent bound.
  const k = Math.floor((maxDen - q0) / q1);
  const pb = p0 + k * p1;
  const qb = q0 + k * q1;
  const errA = Math.abs(p1 / q1 - x);
  const errB = qb > 0 ? Math.abs(pb / qb - x) : Infinity;
  return errB < errA ? [pb, qb] : [p1, q1];
}

/** Display width of a token in a fraction section, for blanking a hidden part with spaces. */
function shownWidth(t: Tok): number {
  if (t.t === 'lit' || t.t === 'denom') return Array.from(t.s).length;
  return t.t === 'digit' || t.t === 'slash' ? 1 : 0;
}

/** Replaces the literals, placeholders and bar in `[start, end)` with spaces (`spaces`) or nothing. */
function blankRange(toks: Tok[], start: number, end: number, spaces: boolean, pieces: string[], lits: Array<string | undefined>): void {
  for (let i = start; i < end && i < toks.length; i++) {
    const t = toks[i];
    const s = spaces ? ' '.repeat(shownWidth(t)) : '';
    if (t.t === 'lit') lits[i] = s;
    else if (t.t === 'digit' || t.t === 'slash' || t.t === 'denom') pieces[i] = s;
  }
}

/**
 * A fraction section is `[whole] [sep] num [lit] / [lit] den`: the numerator
 * is the run of placeholders ending at the last one before the bar, the whole
 * part is every placeholder before it, `sep` the literals between them.
 *
 * Observed Excel behaviour: when the whole part shows no digit its separator
 * disappears (or becomes spaces when the whole part or the numerator has a
 * `?`); when the fraction is zero and the numerator has no `0` placeholder,
 * the separator, numerator, bar and denominator disappear (or become spaces
 * when any part has a `?`) and the whole part shows at least `0`.
 */
function renderFraction(sec: Section, x: number, pieces: string[], lits: Array<string | undefined>): void {
  const toks = sec.toks;
  const isDigit = (i: number) => toks[i]?.t === 'digit';
  const slash = toks.findIndex((t) => t.t === 'slash');
  if (slash === -1) return;
  let numLast = -1;
  for (let i = slash - 1; i >= 0; i--) {
    if (isDigit(i)) {
      numLast = i;
      break;
    }
  }
  if (numLast === -1) return;
  let numStart = numLast;
  while (numStart > 0 && isDigit(numStart - 1)) numStart -= 1;
  const wholeIdx = digitIndices(toks, 0, numStart);
  const numIdx = digitIndices(toks, numStart, numLast + 1);
  const sepStart = wholeIdx.length > 0 ? wholeIdx[wholeIdx.length - 1] + 1 : numStart;
  let fixedDen: number | undefined;
  let denStart: number;
  const afterSlash = toks[slash + 1];
  if (afterSlash?.t === 'denom') {
    const parsed = Number(afterSlash.s);
    fixedDen = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 1e9, 1), 1_000_000_000);
    denStart = slash + 1;
  } else {
    denStart = slash + 1;
    while (toks[denStart]?.t === 'lit') denStart += 1;
  }
  let denEnd = denStart;
  if (fixedDen !== undefined) denEnd += 1;
  else while (isDigit(denEnd)) denEnd += 1;
  const denIdx = digitIndices(toks, denStart, denEnd);
  const hasQ = (idx: number[]) => idx.some((i) => isDigitTok(toks[i], '?'));
  const hasWhole = wholeIdx.length > 0;
  let whole = hasWhole ? Math.floor(x) : 0;
  const f = hasWhole ? x - Math.floor(x) : x;
  let num: number;
  let den: number;
  if (fixedDen !== undefined) {
    num = Math.round(f * fixedDen);
    den = fixedDen;
  } else {
    const digits = Math.min(Math.max(denIdx.length, 1), 7);
    [num, den] = approximate(f, 10 ** digits - 1);
  }
  if (hasWhole && num >= den && den > 0) {
    whole += Math.floor(num / den);
    num %= den;
  }
  const wholeS = whole >= 1 ? fixed(whole, 0)[0] : '';
  const numZeroPh = numIdx.some((i) => isDigitTok(toks[i], '0'));
  if (hasWhole && num === 0 && !numZeroPh) {
    fillInt(toks, wholeIdx, wholeS, sec.thousands, true, pieces);
    const spaces = hasQ(wholeIdx) || hasQ(numIdx) || hasQ(denIdx);
    blankRange(toks, sepStart, denEnd, spaces, pieces, lits);
    return;
  }
  if (hasWhole) {
    // A zero value shows `0` in a `?` or `0` units place, nothing in a `#` one.
    const unitsHash = isDigitTok(toks[wholeIdx[wholeIdx.length - 1]], '#');
    const force = wholeS === '' && num === 0 && !unitsHash;
    fillInt(toks, wholeIdx, wholeS, sec.thousands, force, pieces);
    const wholeShown = wholeIdx.some((i) => /[0-9]/.test(pieces[i] ?? ''));
    if (!wholeShown) {
      const spaces = hasQ(wholeIdx) || hasQ(numIdx);
      blankRange(toks, sepStart, numStart, spaces, pieces, lits);
    }
  }
  fillInt(toks, numIdx, fixed(num, 0)[0] || '0', false, true, pieces);
  pieces[slash] = '/';
  const denS = fixed(den, 0)[0] || '0';
  if (fixedDen !== undefined) {
    pieces[denStart] = denS;
  } else {
    // Denominator digits are zero padded to the `0` placeholders, then left
    // aligned; `?` pads with spaces after them.
    const zeros = denIdx.filter((i) => isDigitTok(toks[i], '0')).length;
    const padded = '0'.repeat(Math.max(zeros - denS.length, 0)) + denS;
    const count = denIdx.length;
    denIdx.forEach((ti, k) => {
      let s = k + 1 === count ? padded.slice(k) : (padded[k] ?? '');
      if (s === '') s = isDigitTok(toks[ti], '?') ? ' ' : isDigitTok(toks[ti], '0') ? '0' : '';
      pieces[ti] = s;
    });
  }
}

function isDigitTok(t: Tok | undefined, c: string): boolean {
  return t?.t === 'digit' && t.c === c;
}
