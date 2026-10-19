/**
 * Synchronous zlib (RFC 1950) and raw deflate (RFC 1951), dependency-free, for the image editor's
 * layer PNGs and PSD ZIP channels. `CompressionStream` is asynchronous and not everywhere, and
 * layer pixels must serialize inside the synchronous `toJSON()`.
 *
 * - `inflate` handles stored, fixed and dynamic blocks and refuses to produce more than
 *   `maxOutput` bytes (a decompression bomb guard).
 * - `deflate` is a greedy LZ77 (hash chains, 32 KiB window) with one dynamic Huffman block per
 *   64 Ki symbols. It favours simplicity over the last few percent of ratio.
 */

// ---------------------------------------------------------------------------
// Shared tables
// ---------------------------------------------------------------------------

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export class ZlibError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZlibError';
  }
}

// ---------------------------------------------------------------------------
// Inflate
// ---------------------------------------------------------------------------

interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;
function fixedTables(): [Huffman, Huffman] {
  if (!fixedLit || !fixedDist) {
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    fixedLit = buildHuffman(l, 288);
    const d = new Uint8Array(30).fill(5);
    fixedDist = buildHuffman(d, 30);
  }
  return [fixedLit, fixedDist];
}

class BitReader {
  pos = 0;
  bit = 0;
  bits = 0;
  constructor(readonly data: Uint8Array) {}
  need(n: number): number {
    while (this.bits < n) {
      if (this.pos >= this.data.length) throw new ZlibError('Unexpected end of compressed data');
      this.bit |= this.data[this.pos++] << this.bits;
      this.bits += 8;
    }
    const v = this.bit & ((1 << n) - 1);
    this.bit >>>= n;
    this.bits -= n;
    return v;
  }
  decode(h: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.need(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new ZlibError('Invalid Huffman code');
  }
  align(): void {
    this.bit = 0;
    this.bits = 0;
  }
}

class Output {
  buf: Uint8Array;
  len = 0;
  constructor(hint: number, readonly max: number) {
    this.buf = new Uint8Array(Math.max(1024, Math.min(hint, max)));
  }
  ensure(n: number): void {
    if (this.len + n > this.max) throw new ZlibError(`Decompressed data exceeds ${this.max} bytes`);
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(Math.min(size, Math.max(this.max, this.len + n)));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
}

/** Inflates raw deflate data (no zlib header). */
export function inflateRaw(data: Uint8Array, options: { maxOutput?: number; sizeHint?: number } = {}): Uint8Array {
  const max = options.maxOutput ?? 512 * 1024 * 1024;
  const out = new Output(options.sizeHint ?? data.length * 4, max);
  const br = new BitReader(data);
  let final = 0;
  while (!final) {
    final = br.need(1);
    const type = br.need(2);
    if (type === 0) {
      br.align();
      if (br.pos + 4 > data.length) throw new ZlibError('Unexpected end of compressed data');
      const len = data[br.pos] | (data[br.pos + 1] << 8);
      const nlen = data[br.pos + 2] | (data[br.pos + 3] << 8);
      br.pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new ZlibError('Stored block length mismatch');
      if (br.pos + len > data.length) throw new ZlibError('Unexpected end of compressed data');
      out.ensure(len);
      out.buf.set(data.subarray(br.pos, br.pos + len), out.len);
      out.len += len;
      br.pos += len;
      continue;
    }
    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) [lit, dist] = fixedTables();
    else if (type === 2) {
      const hlit = br.need(5) + 257;
      const hdist = br.need(5) + 1;
      const hclen = br.need(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = br.need(3);
      const clh = buildHuffman(cl, 19);
      const lengths = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = br.decode(clh);
        if (sym < 16) lengths[i++] = sym;
        else {
          let rep = 0;
          let val = 0;
          if (sym === 16) {
            if (i === 0) throw new ZlibError('Repeat with no previous length');
            val = lengths[i - 1];
            rep = 3 + br.need(2);
          } else if (sym === 17) rep = 3 + br.need(3);
          else rep = 11 + br.need(7);
          if (i + rep > hlit + hdist) throw new ZlibError('Too many code lengths');
          while (rep--) lengths[i++] = val;
        }
      }
      lit = buildHuffman(lengths.subarray(0, hlit), hlit);
      dist = buildHuffman(lengths.subarray(hlit), hdist);
    } else throw new ZlibError('Invalid block type');
    for (;;) {
      const sym = br.decode(lit);
      if (sym < 256) {
        out.ensure(1);
        out.buf[out.len++] = sym;
      } else if (sym === 256) break;
      else {
        const li = sym - 257;
        if (li >= 29) throw new ZlibError('Invalid length symbol');
        const len = LENGTH_BASE[li] + br.need(LENGTH_EXTRA[li]);
        const di = br.decode(dist);
        if (di >= 30) throw new ZlibError('Invalid distance symbol');
        const d = DIST_BASE[di] + br.need(DIST_EXTRA[di]);
        if (d > out.len) throw new ZlibError('Distance too far back');
        out.ensure(len);
        const buf = out.buf;
        let p = out.len;
        for (let k = 0; k < len; k++, p++) buf[p] = buf[p - d];
        out.len = p;
      }
    }
  }
  return out.buf.slice(0, out.len);
}

/** Adler-32 checksum (zlib trailer). */
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const n = data.length;
  let i = 0;
  while (i < n) {
    const end = Math.min(n, i + 3800);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Inflates zlib data (header, deflate stream, Adler-32 trailer). */
export function inflate(data: Uint8Array, options: { maxOutput?: number; sizeHint?: number; verify?: boolean } = {}): Uint8Array {
  if (data.length < 6) throw new ZlibError('Truncated zlib stream');
  const cmf = data[0];
  const flg = data[1];
  if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw new ZlibError('Not a zlib stream');
  if (flg & 32) throw new ZlibError('Preset dictionaries are not supported');
  const out = inflateRaw(data.subarray(2), options);
  if (options.verify !== false && data.length >= 6) {
    const t = data.length - 4;
    const want = ((data[t] << 24) | (data[t + 1] << 16) | (data[t + 2] << 8) | data[t + 3]) >>> 0;
    if (adler32(out) !== want) throw new ZlibError('Adler-32 mismatch');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deflate
// ---------------------------------------------------------------------------

class BitWriter {
  buf: Uint8Array;
  len = 0;
  bit = 0;
  bits = 0;
  constructor(hint: number) {
    this.buf = new Uint8Array(Math.max(1024, hint));
  }
  private grow(): void {
    const next = new Uint8Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }
  write(value: number, n: number): void {
    this.bit |= value << this.bits;
    this.bits += n;
    while (this.bits >= 8) {
      if (this.len >= this.buf.length) this.grow();
      this.buf[this.len++] = this.bit & 255;
      this.bit >>>= 8;
      this.bits -= 8;
    }
  }
  flush(): void {
    if (this.bits > 0) {
      if (this.len >= this.buf.length) this.grow();
      this.buf[this.len++] = this.bit & 255;
    }
    this.bit = 0;
    this.bits = 0;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Code lengths (≤ maxBits) for symbol frequencies, by Huffman's algorithm with frequency flattening. */
function codeLengths(freqs: Uint32Array, maxBits: number): Uint8Array {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const f = Float64Array.from(freqs);
  for (;;) {
    const nodes: Array<{ w: number; sym: number; left?: number; right?: number }> = [];
    for (let i = 0; i < n; i++) if (f[i] > 0) nodes.push({ w: f[i], sym: i });
    lengths.fill(0);
    if (nodes.length === 0) return lengths;
    if (nodes.length === 1) {
      lengths[nodes[0].sym] = 1;
      return lengths;
    }
    // Simple binary heap of node indexes by weight.
    const heap: number[] = nodes.map((_, i) => i);
    const less = (a: number, b: number) => nodes[a].w < nodes[b].w || (nodes[a].w === nodes[b].w && a < b);
    const down = (i: number) => {
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) return;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    };
    const up = (i: number) => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(heap[i], heap[p])) return;
        [heap[i], heap[p]] = [heap[p], heap[i]];
        i = p;
      }
    };
    for (let i = (heap.length >> 1) - 1; i >= 0; i--) down(i);
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        down(0);
      }
      return top;
    };
    while (heap.length > 1) {
      const a = pop();
      const b = pop();
      nodes.push({ w: nodes[a].w + nodes[b].w, sym: -1, left: a, right: b });
      heap.push(nodes.length - 1);
      up(heap.length - 1);
    }
    let maxLen = 0;
    const stack: Array<[number, number]> = [[heap[0], 0]];
    while (stack.length) {
      const [i, d] = stack.pop()!;
      const node = nodes[i];
      if (node.sym >= 0) {
        lengths[node.sym] = d;
        if (d > maxLen) maxLen = d;
      } else {
        stack.push([node.left!, d + 1], [node.right!, d + 1]);
      }
    }
    if (maxLen <= maxBits) return lengths;
    // Too deep: flatten the distribution and retry.
    for (let i = 0; i < n; i++) if (f[i] > 0) f[i] = Math.floor(f[i] / 2) + 1;
  }
}

/** Canonical codes for code lengths, bit-reversed for LSB-first output. */
function canonicalCodes(lengths: Uint8Array): Uint16Array {
  const blCount = new Uint16Array(16);
  for (const l of lengths) blCount[l]++;
  blCount[0] = 0;
  const next = new Uint16Array(16);
  let code = 0;
  for (let bits = 1; bits < 16; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i];
    if (!len) continue;
    let c = next[len]++;
    let r = 0;
    for (let k = 0; k < len; k++) {
      r = (r << 1) | (c & 1);
      c >>= 1;
    }
    codes[i] = r;
  }
  return codes;
}

function lengthSymbol(len: number): number {
  let i = 28;
  while (LENGTH_BASE[i] > len) i--;
  return i;
}

function distSymbol(d: number): number {
  let i = 29;
  while (DIST_BASE[i] > d) i--;
  return i;
}

const WINDOW = 32768;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_CHAIN = 24;
const MAX_MATCH = 258;
const BLOCK_SYMBOLS = 65536;

/** Raw deflate (no zlib header). `level` 0 stores the data uncompressed. */
export function deflateRaw(data: Uint8Array, level: 0 | 1 = 1): Uint8Array {
  const w = new BitWriter(Math.ceil(data.length / 2) + 64);
  const n = data.length;
  if (level === 0 || n === 0) {
    let pos = 0;
    do {
      const len = Math.min(65535, n - pos);
      const final = pos + len >= n ? 1 : 0;
      w.write(final, 1);
      w.write(0, 2);
      w.flush();
      w.write(len & 0xffff, 16);
      w.write(~len & 0xffff, 16);
      for (let i = 0; i < len; i++) w.write(data[pos + i], 8);
      pos += len;
    } while (pos < n);
    return w.bytes();
  }

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WINDOW);
  // Symbols of the current block: literal (0..255) or length/distance pairs.
  const litLen = new Uint16Array(BLOCK_SYMBOLS);
  const dists = new Uint16Array(BLOCK_SYMBOLS);
  let count = 0;
  const hash = (i: number) => (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) * 2654435761) >>> (32 - HASH_BITS);
  const insert = (i: number) => {
    if (i + 2 >= n) return;
    const h = hash(i);
    prev[i & (WINDOW - 1)] = head[h];
    head[h] = i;
  };

  const flushBlock = (final: boolean) => {
    const litFreq = new Uint32Array(286);
    const distFreq = new Uint32Array(30);
    for (let k = 0; k < count; k++) {
      if (dists[k] === 0) litFreq[litLen[k]]++;
      else {
        litFreq[257 + lengthSymbol(litLen[k])]++;
        distFreq[distSymbol(dists[k])]++;
      }
    }
    litFreq[256] = 1;
    let anyDist = false;
    for (const v of distFreq) if (v) anyDist = true;
    if (!anyDist) distFreq[0] = 1;
    const litLengths = codeLengths(litFreq, 15);
    const distLengths = codeLengths(distFreq, 15);
    let hlit = 286;
    while (hlit > 257 && !litLengths[hlit - 1]) hlit--;
    let hdist = 30;
    while (hdist > 1 && !distLengths[hdist - 1]) hdist--;
    const all = new Uint8Array(hlit + hdist);
    all.set(litLengths.subarray(0, hlit));
    all.set(distLengths.subarray(0, hdist), hlit);
    // Run-length encode the code lengths.
    const clSyms: number[] = [];
    const clExtra: number[] = [];
    for (let i = 0; i < all.length; ) {
      const v = all[i];
      let run = 1;
      while (i + run < all.length && all[i + run] === v) run++;
      if (v === 0 && run >= 3) {
        const r = Math.min(run, 138);
        if (r >= 11) {
          clSyms.push(18);
          clExtra.push(r - 11);
        } else {
          clSyms.push(17);
          clExtra.push(r - 3);
        }
        i += r;
      } else if (v !== 0 && run >= 4) {
        clSyms.push(v);
        clExtra.push(0);
        const r = Math.min(run - 1, 6);
        clSyms.push(16);
        clExtra.push(r - 3);
        i += r + 1;
      } else {
        clSyms.push(v);
        clExtra.push(0);
        i++;
      }
    }
    const clFreq = new Uint32Array(19);
    for (const s of clSyms) clFreq[s]++;
    const clLengths = codeLengths(clFreq, 7);
    let hclen = 19;
    while (hclen > 4 && !clLengths[CL_ORDER[hclen - 1]]) hclen--;
    const clCodes = canonicalCodes(clLengths);
    const litCodes = canonicalCodes(litLengths);
    const distCodes = canonicalCodes(distLengths);

    w.write(final ? 1 : 0, 1);
    w.write(2, 2);
    w.write(hlit - 257, 5);
    w.write(hdist - 1, 5);
    w.write(hclen - 4, 4);
    for (let i = 0; i < hclen; i++) w.write(clLengths[CL_ORDER[i]], 3);
    for (let i = 0; i < clSyms.length; i++) {
      const s = clSyms[i];
      w.write(clCodes[s], clLengths[s]);
      if (s === 16) w.write(clExtra[i], 2);
      else if (s === 17) w.write(clExtra[i], 3);
      else if (s === 18) w.write(clExtra[i], 7);
    }
    for (let k = 0; k < count; k++) {
      const d = dists[k];
      if (d === 0) {
        const s = litLen[k];
        w.write(litCodes[s], litLengths[s]);
      } else {
        const len = litLen[k];
        const li = lengthSymbol(len);
        w.write(litCodes[257 + li], litLengths[257 + li]);
        if (LENGTH_EXTRA[li]) w.write(len - LENGTH_BASE[li], LENGTH_EXTRA[li]);
        const di = distSymbol(d);
        w.write(distCodes[di], distLengths[di]);
        if (DIST_EXTRA[di]) w.write(d - DIST_BASE[di], DIST_EXTRA[di]);
      }
    }
    w.write(litCodes[256], litLengths[256]);
    count = 0;
  };

  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + 2 < n) {
      let cand = head[hash(i)];
      let chain = MAX_CHAIN;
      const limit = Math.min(MAX_MATCH, n - i);
      while (cand >= 0 && i - cand <= WINDOW - 1 && chain-- > 0) {
        if (data[cand + bestLen] === data[i + bestLen]) {
          let l = 0;
          while (l < limit && data[cand + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l === limit) break;
          }
        }
        const next = prev[cand & (WINDOW - 1)];
        if (next >= cand) break;
        cand = next;
      }
    }
    if (bestLen >= 3) {
      litLen[count] = bestLen;
      dists[count] = bestDist;
      count++;
      const end = i + bestLen;
      // Insert every position of long runs only up to a cap, which keeps solid areas fast.
      const insertEnd = bestLen > 64 ? i + 64 : end;
      for (let k = i; k < insertEnd; k++) insert(k);
      for (let k = Math.max(insertEnd, end - 3); k < end; k++) insert(k);
      i = end;
    } else {
      litLen[count] = data[i];
      dists[count] = 0;
      count++;
      insert(i);
      i++;
    }
    if (count >= BLOCK_SYMBOLS - 1 && i < n) flushBlock(false);
  }
  // The final block may hold only the end-of-block symbol.
  flushBlock(true);
  w.flush();
  return w.bytes();
}

/** zlib stream: header, raw deflate, Adler-32. */
export function deflate(data: Uint8Array, level: 0 | 1 = 1): Uint8Array {
  const raw = deflateRaw(data, level);
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(raw, 2);
  const a = adler32(data);
  const t = out.length - 4;
  out[t] = a >>> 24;
  out[t + 1] = (a >>> 16) & 255;
  out[t + 2] = (a >>> 8) & 255;
  out[t + 3] = a & 255;
  return out;
}
