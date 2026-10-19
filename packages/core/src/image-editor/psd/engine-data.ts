// Portions ported from photocraft/crates/text/src/engine_data.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Photoshop's text EngineData: a PostScript-like syntax of dictionaries (`<< /Key value >>`),
 * arrays (`[ … ]`), strings (`( … )`, UTF-16 with a byte order mark, `\` escapes), names
 * (`/Name`), numbers and booleans. Dictionaries keep their key order, so a parse and a write give
 * back what Photoshop wrote, give or take whitespace and number formatting.
 */

export type EngineValue =
  | { t: 'dict'; items: Array<[string, EngineValue]> }
  | { t: 'array'; items: EngineValue[] }
  | { t: 'string'; value: string }
  | { t: 'int'; value: number }
  | { t: 'real'; value: number }
  | { t: 'bool'; value: boolean }
  | { t: 'name'; value: string };

export class EngineDataError extends Error {
  constructor(message: string) {
    super(`EngineData: ${message}`);
    this.name = 'EngineDataError';
  }
}

const MAX_DEPTH = 64;
const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a || c === 0;
const isDelim = (c: number) => isWs(c) || c === 0x5b || c === 0x5d || c === 0x3c || c === 0x3e || c === 0x28 || c === 0x2f;

/** Parses EngineData (a dictionary, or a bare `/key value` list as in `Txt2`). */
export function parseEngineData(b: Uint8Array): EngineValue {
  let i = 0;
  const ws = () => {
    while (i < b.length && isWs(b[i])) i++;
  };
  const name = () => {
    i++;
    const start = i;
    while (i < b.length && !isDelim(b[i])) i++;
    let s = '';
    for (let k = start; k < i; k++) s += String.fromCharCode(b[k]);
    return s;
  };
  const value = (depth: number): EngineValue => {
    if (depth > MAX_DEPTH) throw new EngineDataError('nesting too deep');
    ws();
    if (i >= b.length) throw new EngineDataError('unexpected end');
    const c = b[i];
    if (c === 0x3c && b[i + 1] === 0x3c) {
      i += 2;
      const items: Array<[string, EngineValue]> = [];
      for (;;) {
        ws();
        if (b[i] === 0x3e && b[i + 1] === 0x3e) {
          i += 2;
          return { t: 'dict', items };
        }
        if (b[i] !== 0x2f) throw new EngineDataError(i >= b.length ? 'unterminated dictionary' : `expected a key at byte ${i}`);
        const k = name();
        items.push([k, value(depth + 1)]);
      }
    }
    if (c === 0x5b) {
      i++;
      const items: EngineValue[] = [];
      for (;;) {
        ws();
        if (i >= b.length) throw new EngineDataError('unterminated array');
        if (b[i] === 0x5d) {
          i++;
          return { t: 'array', items };
        }
        items.push(value(depth + 1));
      }
    }
    if (c === 0x28) {
      i++;
      const raw: number[] = [];
      for (;;) {
        if (i >= b.length) throw new EngineDataError('unterminated string');
        const x = b[i];
        if (x === 0x5c) {
          if (i + 1 < b.length) raw.push(b[i + 1]);
          i += 2;
        } else if (x === 0x29) {
          i++;
          break;
        } else {
          raw.push(x);
          i++;
        }
      }
      return { t: 'string', value: decodeString(raw) };
    }
    if (c === 0x2f) return { t: 'name', value: name() };
    const start = i;
    while (i < b.length && !isDelim(b[i])) i++;
    let tok = '';
    for (let k = start; k < i; k++) tok += String.fromCharCode(b[k]);
    if (tok === 'true' || tok === 'false') return { t: 'bool', value: tok === 'true' };
    if (!tok) throw new EngineDataError(`unexpected byte at ${i}`);
    const n = Number(tok);
    if (!Number.isFinite(n)) throw new EngineDataError(`bad number "${tok}"`);
    return /[.eE]/.test(tok) ? { t: 'real', value: n } : { t: 'int', value: n };
  };
  ws();
  if (b[i] === 0x2f) {
    // A bare list of `/key value` pairs.
    const items: Array<[string, EngineValue]> = [];
    while (i < b.length) {
      ws();
      if (i >= b.length) break;
      if (b[i] !== 0x2f) throw new EngineDataError(`expected a key at byte ${i}`);
      const k = name();
      items.push([k, value(1)]);
      ws();
    }
    return { t: 'dict', items };
  }
  return value(0);
}

function decodeString(raw: number[]): string {
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    let s = '';
    for (let k = 2; k + 1 < raw.length; k += 2) s += String.fromCharCode((raw[k] << 8) | raw[k + 1]);
    return s;
  }
  return String.fromCharCode(...raw);
}

const isContainer = (v: EngineValue) => v.t === 'dict' || (v.t === 'array' && v.items.some((x) => x.t === 'dict' || x.t === 'array'));

function formatReal(r: number): string {
  if (!Number.isFinite(r)) return '0.0';
  if (Number.isInteger(r) && Math.abs(r) < 1e15) return r.toFixed(1);
  let s = r.toFixed(5);
  while (s.endsWith('0')) s = s.slice(0, -1);
  if (s === '0.' || s === '-0.') return '0.0';
  if (s.endsWith('.')) s += '0';
  // Photoshop writes `.5`, not `0.5`.
  return s.replace(/^(-?)0\./, '$1.');
}

/** Writes EngineData as Photoshop lays it out (tabs, one key per line). */
export function writeEngineData(v: EngineValue): Uint8Array {
  const out: number[] = [0x0a, 0x0a];
  const push = (s: string) => {
    for (let k = 0; k < s.length; k++) out.push(s.charCodeAt(k) & 0xff);
  };
  const indent = (n: number) => {
    for (let k = 0; k < n; k++) out.push(0x09);
  };
  const write = (x: EngineValue, depth: number) => {
    switch (x.t) {
      case 'dict':
        push('<<\n');
        for (const [k, val] of x.items) {
          indent(depth + 1);
          push(`/${k}`);
          if (isContainer(val)) {
            push('\n');
            indent(depth + 1);
          } else push(' ');
          write(val, depth + 1);
          push('\n');
        }
        indent(depth);
        push('>>');
        break;
      case 'array':
        if (isContainer(x)) {
          push('[\n');
          for (const item of x.items) {
            indent(depth);
            write(item, depth);
            push('\n');
          }
          indent(depth);
          push(']');
        } else {
          push('[');
          for (const item of x.items) {
            push(' ');
            write(item, depth);
          }
          push(' ]');
        }
        break;
      case 'string': {
        out.push(0x28);
        const raw = [0xfe, 0xff];
        for (let k = 0; k < x.value.length; k++) {
          const u = x.value.charCodeAt(k);
          raw.push(u >> 8, u & 0xff);
        }
        for (const c of raw) {
          if (c === 0x28 || c === 0x29 || c === 0x5c) out.push(0x5c);
          out.push(c);
        }
        out.push(0x29);
        break;
      }
      case 'int':
        push(String(Math.round(x.value)));
        break;
      case 'real':
        push(formatReal(x.value));
        break;
      case 'bool':
        push(x.value ? 'true' : 'false');
        break;
      case 'name':
        push(`/${x.value}`);
        break;
    }
  };
  write(v, 0);
  out.push(0x0a);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const E = {
  dict: (items: Array<[string, EngineValue]> = []): EngineValue => ({ t: 'dict', items }),
  array: (items: EngineValue[]): EngineValue => ({ t: 'array', items }),
  str: (value: string): EngineValue => ({ t: 'string', value }),
  int: (value: number): EngineValue => ({ t: 'int', value }),
  real: (value: number): EngineValue => ({ t: 'real', value }),
  bool: (value: boolean): EngineValue => ({ t: 'bool', value }),
};

export function eGet(v: EngineValue | undefined, key: string): EngineValue | undefined {
  return v?.t === 'dict' ? v.items.find(([k]) => k === key)?.[1] : undefined;
}

export function ePath(v: EngineValue | undefined, keys: string[]): EngineValue | undefined {
  return keys.reduce<EngineValue | undefined>((at, k) => eGet(at, k), v);
}

export function eNum(v: EngineValue | undefined): number | undefined {
  return v && (v.t === 'int' || v.t === 'real') ? v.value : undefined;
}

export function eBool(v: EngineValue | undefined): boolean | undefined {
  if (!v) return undefined;
  if (v.t === 'bool') return v.value;
  if (v.t === 'int') return v.value !== 0;
  return undefined;
}

export function eStr(v: EngineValue | undefined): string | undefined {
  return v && (v.t === 'string' || v.t === 'name') ? v.value : undefined;
}

export function eArray(v: EngineValue | undefined): EngineValue[] {
  return v?.t === 'array' ? v.items : [];
}

/** Sets `key` on a dictionary (replacing or appending). */
export function eSet(d: EngineValue, key: string, value: EngineValue): void {
  if (d.t !== 'dict') return;
  const at = d.items.findIndex(([k]) => k === key);
  if (at >= 0) d.items[at] = [key, value];
  else d.items.push([key, value]);
}

/** A deep copy. */
export function eClone(v: EngineValue): EngineValue {
  return JSON.parse(JSON.stringify(v));
}
