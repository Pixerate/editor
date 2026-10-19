// Portions ported from photocraft/crates/psd/src/io.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/** A malformed or unsupported PSD; the message says what was wrong and where. */
export class PsdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PsdError';
  }
}

/** Big-endian reader over a byte range that never reads past its end (it throws `PsdError`). */
export class PsdReader {
  pos: number;

  constructor(
    readonly data: Uint8Array,
    private readonly start = 0,
    readonly end = data.length
  ) {
    this.pos = start;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  get offset(): number {
    return this.pos - this.start;
  }

  private need(n: number, what: string): void {
    if (n < 0 || this.pos + n > this.end) throw new PsdError(`Unexpected end of data reading ${what} at byte ${this.pos}.`);
  }

  u8(): number {
    this.need(1, 'a byte');
    return this.data[this.pos++];
  }

  i8(): number {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }

  u16(): number {
    this.need(2, 'a 16-bit value');
    const v = (this.data[this.pos] << 8) | this.data[this.pos + 1];
    this.pos += 2;
    return v;
  }

  i16(): number {
    const v = this.u16();
    return v > 32767 ? v - 65536 : v;
  }

  u32(): number {
    this.need(4, 'a 32-bit value');
    const d = this.data;
    const p = this.pos;
    this.pos += 4;
    return ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
  }

  i32(): number {
    return this.u32() | 0;
  }

  u64(): number {
    const hi = this.u32();
    const lo = this.u32();
    const v = hi * 2 ** 32 + lo;
    if (!Number.isSafeInteger(v)) throw new PsdError('A 64-bit length is too large.');
    return v;
  }

  i64(): number {
    const hi = this.i32();
    const lo = this.u32();
    return hi * 2 ** 32 + lo;
  }

  f32(): number {
    this.need(4, 'a float');
    const v = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 4).getFloat32(0, false);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8, 'a double');
    const v = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 8).getFloat64(0, false);
    this.pos += 8;
    return v;
  }

  /** A length field: 8 bytes in PSB where the format says so, else 4. */
  len(long: boolean): number {
    return long ? this.u64() : this.u32();
  }

  bytes(n: number): Uint8Array {
    this.need(n, `${n} bytes`);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  ascii(n: number): string {
    return String.fromCharCode(...this.bytes(n));
  }

  skip(n: number): void {
    this.need(n, `${n} bytes`);
    this.pos += n;
  }

  /** A reader over the next `n` bytes (and skips them here). */
  sub(n: number): PsdReader {
    this.need(n, `a ${n}-byte section`);
    const r = new PsdReader(this.data, this.pos, this.pos + n);
    this.pos += n;
    return r;
  }

  peek(n: number): Uint8Array {
    return this.data.subarray(this.pos, Math.min(this.end, this.pos + n));
  }

  rest(): Uint8Array {
    const out = this.data.subarray(this.pos, this.end);
    this.pos = this.end;
    return out;
  }

  /** Refuses counts that could not fit in what is left (each item at least `size` bytes). */
  checkCount(n: number, size: number, what: string): void {
    if (n * size > this.remaining) throw new PsdError(`${what}: count ${n} does not fit in the remaining ${this.remaining} bytes.`);
  }

  /** Pascal string padded to a multiple of `align` (length byte included). */
  pascal(align: number): Uint8Array {
    const n = this.u8();
    const s = this.bytes(n);
    const pad = (align - ((1 + n) % align)) % align;
    this.skip(Math.min(pad, this.remaining));
    return s;
  }

  /** Photoshop Unicode string: u32 code-unit count, UTF-16BE units (trailing NULs dropped). */
  unicode(): string {
    const n = this.u32();
    this.checkCount(n, 2, 'Unicode string');
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16());
    return s.replace(/\u0000+$/, '');
  }
}

/** A growable big-endian writer. */
export class PsdWriter {
  private buf = new Uint8Array(1 << 16);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.length++] = v & 255;
  }

  u16(v: number): void {
    this.ensure(2);
    this.buf[this.length++] = (v >>> 8) & 255;
    this.buf[this.length++] = v & 255;
  }

  i16(v: number): void {
    this.u16(v < 0 ? v + 65536 : v);
  }

  u32(v: number): void {
    this.ensure(4);
    this.buf[this.length++] = (v >>> 24) & 255;
    this.buf[this.length++] = (v >>> 16) & 255;
    this.buf[this.length++] = (v >>> 8) & 255;
    this.buf[this.length++] = v & 255;
  }

  i32(v: number): void {
    this.u32(v >>> 0);
  }

  u64(v: number): void {
    this.u32(Math.floor(v / 2 ** 32));
    this.u32(v >>> 0);
  }

  f64(v: number): void {
    this.ensure(8);
    new DataView(this.buf.buffer, this.length, 8).setFloat64(0, v, false);
    this.length += 8;
  }

  bytes(b: ArrayLike<number>): void {
    this.ensure(b.length);
    this.buf.set(b as Uint8Array, this.length);
    this.length += b.length;
  }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }

  zeros(n: number): void {
    this.ensure(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
  }

  /** Reserves a length field; `endLen` fills it with the bytes written since. */
  beginLen(long: boolean): { at: number; long: boolean } {
    const at = this.length;
    if (long) this.u64(0);
    else this.u32(0);
    return { at, long };
  }

  endLen(mark: { at: number; long: boolean }): number {
    const n = this.length - mark.at - (mark.long ? 8 : 4);
    const save = this.length;
    this.length = mark.at;
    if (mark.long) this.u64(n);
    else this.u32(n);
    this.length = save;
    return n;
  }

  /** Pascal string padded to a multiple of `align`. */
  pascal(s: Uint8Array, align: number): void {
    const n = Math.min(255, s.length);
    this.u8(n);
    this.bytes(s.subarray(0, n));
    this.zeros((align - ((1 + n) % align)) % align);
  }

  unicode(s: string, nul = false): void {
    const n = s.length + (nul ? 1 : 0);
    this.u32(n);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    if (nul) this.u16(0);
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** A legacy (Pascal) name: UTF-8 when valid, else Latin-1. */
export function decodeLegacyName(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return String.fromCharCode(...b);
  }
}

/** Encodes a name for a legacy Pascal field: non-ASCII characters become `?`. */
export function encodeLegacyName(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out.push(c >= 32 && c < 127 ? c : 63);
    if (out.length >= 255) break;
  }
  return Uint8Array.from(out);
}
