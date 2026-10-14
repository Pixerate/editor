// Portions ported from gridcraft/crates/numfmt/src/decimal.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/**
 * Decimal-string rounding and the General format.
 *
 * Excel works with 15 significant digits, so numbers are first written with
 * 15 significant digits and then rounded half away from zero on that decimal
 * string. That makes 2.675 with `0.00` show 2.68 and 1.005 show 1.01, as in
 * Excel, even though neither is exact in binary.
 */

/** Most decimals ever computed; placeholders beyond this are padded with zeros. */
export const MAX_DECIMALS = 400;

/**
 * `n` significant digits of a positive finite `a` (correctly rounded) and the
 * power of ten of the first digit.
 */
function significantDigits(a: number, n: number): { digits: number[]; exp: number } {
  const s = a.toExponential(Math.max(0, Math.min(100, n - 1)));
  const e = s.indexOf('e');
  const digits: number[] = [];
  for (let i = 0; i < e; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) digits.push(c - 48);
  }
  return { digits, exp: Number(s.slice(e + 1)) };
}

/** The exact decimal expansion of a positive finite double, as significant digits (no trailing zeros). */
function exactDigits(a: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, a);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp2: number;
  if (biased === 0) {
    exp2 = -1074;
  } else {
    mantissa |= 1n << 52n;
    exp2 = biased - 1075;
  }
  const digits = exp2 >= 0 ? (mantissa << BigInt(exp2)).toString() : (mantissa * 5n ** BigInt(-exp2)).toString();
  return digits.replace(/0+$/, '');
}

/** True when `a`'s exact decimal expansion has a 5 as its 16th significant digit and only zeros after. */
function isExactTie(a: number): boolean {
  const isTie = (ds: string) => ds.length >= 16 && ds[15] === '5' && /^0*$/.test(ds.slice(16));
  // A cheap screen first (30 digits), then the exact expansion.
  return isTie(significantDigits(a, 30).digits.join('')) && isTie(exactDigits(a).padEnd(16, '0'));
}

/**
 * The 15 significant digits of a positive finite number and the power of ten
 * of the first digit: `a ≈ d0.d1d2… × 10^exp`.
 *
 * The value is rounded to the nearest 15-digit decimal. An exact tie at the
 * 16th digit goes toward zero, as Excel does: `1234567890123455` shows
 * `1234567890123450`, not `…460`.
 */
export function decimalDigits(a: number): { digits: number[]; exp: number } {
  if (!Number.isFinite(a) || a <= 0) return { digits: new Array(15).fill(0), exp: 0 };
  const { digits: d16, exp } = significantDigits(a, 16);
  const digits = d16.slice(0, 15);
  while (digits.length < 15) digits.push(0);
  const sixteenth = d16[15] ?? 0;
  if (sixteenth <= 4) return { digits, exp };
  if (sixteenth === 5) {
    if (isExactTie(a)) return { digits, exp };
    // Not a tie: round the exact value (the 16-digit rounding may be a double rounding).
    const r = significantDigits(a, 15);
    while (r.digits.length < 15) r.digits.push(0);
    return r;
  }
  let e = exp;
  let carry = true;
  for (let i = 14; i >= 0; i--) {
    if (digits[i] === 9) {
      digits[i] = 0;
    } else {
      digits[i] += 1;
      carry = false;
      break;
    }
  }
  if (carry) {
    digits.fill(0);
    digits[0] = 1;
    e += 1;
  }
  return { digits, exp: e };
}

/**
 * Rounds the number `digits × 10^exp` (see `decimalDigits`) to `decimals`
 * places, half away from zero. Returns the integer digits (`''` when the
 * integer part is zero) and exactly `decimals` fraction digits.
 */
export function fixedFromDigits(digits: number[], exp: number, decimals: number): [string, string] {
  const decimalsCalc = Math.min(decimals, MAX_DECIMALS);
  const keep = exp + decimalsCalc + 1;
  let m: number[];
  if (keep <= 0) {
    m = keep === 0 && (digits[0] ?? 0) >= 5 ? [1] : [];
  } else if (keep >= digits.length) {
    m = digits.slice();
    while (m.length < keep) m.push(0);
  } else {
    m = digits.slice(0, keep);
    if ((digits[keep] ?? 0) >= 5) {
      let carry = true;
      for (let i = m.length - 1; i >= 0; i--) {
        if (m[i] === 9) {
          m[i] = 0;
        } else {
          m[i] += 1;
          carry = false;
          break;
        }
      }
      if (carry) m.unshift(1);
    }
  }
  let lead = 0;
  while (lead < m.length && m[lead] === 0) lead++;
  m = m.slice(lead);
  const toS = (ds: number[]) => ds.join('');
  let int: string;
  let frac: string;
  if (m.length <= decimalsCalc) {
    int = '';
    frac = '0'.repeat(decimalsCalc - m.length) + toS(m);
  } else {
    const split = m.length - decimalsCalc;
    int = toS(m.slice(0, split));
    frac = toS(m.slice(split));
  }
  if (decimals > decimalsCalc) frac += '0'.repeat(decimals - decimalsCalc);
  return [int, frac];
}

/** Rounds a non-negative number to `decimals` places (see `fixedFromDigits`). */
export function fixed(a: number, decimals: number): [string, string] {
  if (!Number.isFinite(a) || a <= 0) return ['', '0'.repeat(Math.min(decimals, MAX_DECIMALS * 4))];
  const { digits, exp } = decimalDigits(a);
  return fixedFromDigits(digits, exp, decimals);
}

const charCount = (s: string) => Array.from(s).length;

/**
 * The General format squeezed into `maxChars` characters, as Excel shows it
 * in a narrow column: fewer decimals, then scientific notation; `null` when
 * even that does not fit (the caller paints `####`).
 */
export function formatGeneralFit(n: number, maxChars: number): string | null {
  if (!Number.isFinite(n)) return null;
  if (n === 0) return maxChars >= 1 ? '0' : null;
  const sign = n < 0 ? '-' : '';
  const { digits, exp: x } = decimalDigits(Math.abs(n));
  const intLen = sign.length + Math.max(x, 0) + 1;
  // Fixed notation for magnitudes from 1E-4 up to what fits.
  if (x >= -4 && intLen <= maxChars) {
    const avail = maxChars - intLen;
    let decimals = avail >= 2 ? avail - 1 : 0;
    for (;;) {
      const [i, f0] = fixedFromDigits(digits, x, decimals);
      const f = f0.replace(/0+$/, '');
      if (i === '' && f === '') break; // rounded away to zero: use scientific
      let s = sign + (i === '' ? '0' : i);
      if (f !== '') s += `.${f}`;
      if (charCount(s) <= maxChars) return s;
      if (decimals === 0) break;
      decimals -= 1;
    }
  }
  for (let md = Math.min(maxChars, 14); md >= 0; md--) {
    let e = x;
    let [mi, mf] = fixedFromDigits(digits, 0, md);
    if (mi.length > 1) {
      e += 1;
      [mi, mf] = fixedFromDigits(digits, -1, md);
    }
    mf = mf.replace(/0+$/, '');
    let s = sign + (mi === '' ? '0' : mi);
    if (mf !== '') s += `.${mf}`;
    s += `E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
    if (charCount(s) <= maxChars) return s;
  }
  return null;
}
