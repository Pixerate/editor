import Foundation

/**
 * Synchronous zlib (RFC 1950) and raw deflate (RFC 1951), dependency-free, for layer PNGs and PSD
 * ZIP channels. The port of `raster/zlib.ts`: `deflate` writes the same bytes as the TS one.
 *
 * - `inflate` handles stored, fixed and dynamic blocks and refuses to produce more than
 *   `maxOutput` bytes (a decompression bomb guard).
 * - `deflate` is a greedy LZ77 (hash chains, 32 KiB window) with one dynamic Huffman block per
 *   64 Ki symbols. It favours simplicity over the last few percent of ratio.
 */

// MARK: - Shared tables

private let LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
private let LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
private let DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
private let DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
private let CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

public struct ZlibError: Error, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

// MARK: - Inflate

private struct Huffman {
    var counts: [Int]
    var symbols: [Int]
}

private func buildHuffman(_ lengths: ArraySlice<UInt8>, _ n: Int) -> Huffman {
    let base = lengths.startIndex
    var counts = [Int](repeating: 0, count: 16)
    for i in 0..<n { counts[Int(lengths[base + i])] += 1 }
    counts[0] = 0
    var offs = [Int](repeating: 0, count: 16)
    for i in 1..<16 { offs[i] = offs[i - 1] + counts[i - 1] }
    var symbols = [Int](repeating: 0, count: n)
    for i in 0..<n where lengths[base + i] != 0 {
        let l = Int(lengths[base + i])
        symbols[offs[l]] = i
        offs[l] += 1
    }
    return Huffman(counts: counts, symbols: symbols)
}

private let fixedTables: (Huffman, Huffman) = {
    var l = [UInt8](repeating: 0, count: 288)
    for i in 0..<144 { l[i] = 8 }
    for i in 144..<256 { l[i] = 9 }
    for i in 256..<280 { l[i] = 7 }
    for i in 280..<288 { l[i] = 8 }
    let d = [UInt8](repeating: 5, count: 30)
    return (buildHuffman(l[...], 288), buildHuffman(d[...], 30))
}()

private struct BitReader {
    var pos = 0
    var bit: UInt32 = 0
    var bits = 0
    let data: [UInt8]

    mutating func need(_ n: Int) throws -> Int {
        while bits < n {
            if pos >= data.count { throw ZlibError("Unexpected end of compressed data") }
            bit |= UInt32(data[pos]) << UInt32(bits)
            pos += 1
            bits += 8
        }
        let v = Int(bit & ((1 << UInt32(n)) &- 1))
        bit = n >= 32 ? 0 : bit >> UInt32(n)
        bits -= n
        return v
    }

    mutating func decode(_ h: Huffman) throws -> Int {
        var code = 0
        var first = 0
        var index = 0
        for len in 1..<16 {
            code |= try need(1)
            let count = h.counts[len]
            if code - count < first { return h.symbols[index + (code - first)] }
            index += count
            first += count
            first <<= 1
            code <<= 1
        }
        throw ZlibError("Invalid Huffman code")
    }

    mutating func align() {
        bit = 0
        bits = 0
    }
}

/// Inflates raw deflate data (no zlib header).
public func inflateRaw(_ data: [UInt8], maxOutput: Int? = nil, sizeHint: Int? = nil) throws -> [UInt8] {
    let max = maxOutput ?? 512 * 1024 * 1024
    var out: [UInt8] = []
    out.reserveCapacity(Swift.max(1024, Swift.min(sizeHint ?? data.count * 4, max)))
    func ensure(_ n: Int) throws {
        if out.count + n > max { throw ZlibError("Decompressed data exceeds \(max) bytes") }
    }
    var br = BitReader(data: data)
    var final = 0
    while final == 0 {
        final = try br.need(1)
        let type = try br.need(2)
        if type == 0 {
            br.align()
            if br.pos + 4 > data.count { throw ZlibError("Unexpected end of compressed data") }
            let len = Int(data[br.pos]) | (Int(data[br.pos + 1]) << 8)
            let nlen = Int(data[br.pos + 2]) | (Int(data[br.pos + 3]) << 8)
            br.pos += 4
            if (len ^ 0xFFFF) != nlen { throw ZlibError("Stored block length mismatch") }
            if br.pos + len > data.count { throw ZlibError("Unexpected end of compressed data") }
            try ensure(len)
            out.append(contentsOf: data[br.pos..<(br.pos + len)])
            br.pos += len
            continue
        }
        let lit: Huffman
        let dist: Huffman
        if type == 1 {
            (lit, dist) = fixedTables
        } else if type == 2 {
            let hlit = try br.need(5) + 257
            let hdist = try br.need(5) + 1
            let hclen = try br.need(4) + 4
            var cl = [UInt8](repeating: 0, count: 19)
            for i in 0..<hclen { cl[CL_ORDER[i]] = UInt8(try br.need(3)) }
            let clh = buildHuffman(cl[...], 19)
            var lengths = [UInt8](repeating: 0, count: hlit + hdist)
            var i = 0
            while i < hlit + hdist {
                let sym = try br.decode(clh)
                if sym < 16 {
                    lengths[i] = UInt8(sym)
                    i += 1
                } else {
                    var rep = 0
                    var val: UInt8 = 0
                    if sym == 16 {
                        if i == 0 { throw ZlibError("Repeat with no previous length") }
                        val = lengths[i - 1]
                        rep = 3 + (try br.need(2))
                    } else if sym == 17 {
                        rep = 3 + (try br.need(3))
                    } else {
                        rep = 11 + (try br.need(7))
                    }
                    if i + rep > hlit + hdist { throw ZlibError("Too many code lengths") }
                    while rep > 0 {
                        lengths[i] = val
                        i += 1
                        rep -= 1
                    }
                }
            }
            lit = buildHuffman(lengths[0..<hlit], hlit)
            dist = buildHuffman(lengths[hlit...], hdist)
        } else {
            throw ZlibError("Invalid block type")
        }
        while true {
            let sym = try br.decode(lit)
            if sym < 256 {
                try ensure(1)
                out.append(UInt8(sym))
            } else if sym == 256 {
                break
            } else {
                let li = sym - 257
                if li >= 29 { throw ZlibError("Invalid length symbol") }
                let len = LENGTH_BASE[li] + (try br.need(LENGTH_EXTRA[li]))
                let di = try br.decode(dist)
                if di >= 30 { throw ZlibError("Invalid distance symbol") }
                let d = DIST_BASE[di] + (try br.need(DIST_EXTRA[di]))
                if d > out.count { throw ZlibError("Distance too far back") }
                try ensure(len)
                for _ in 0..<len { out.append(out[out.count - d]) }
            }
        }
    }
    return out
}

/// Adler-32 checksum (zlib trailer).
public func adler32(_ data: [UInt8]) -> UInt32 {
    var a: UInt32 = 1
    var b: UInt32 = 0
    let n = data.count
    var i = 0
    while i < n {
        let end = Swift.min(n, i + 3800)
        while i < end {
            a += UInt32(data[i])
            b += a
            i += 1
        }
        a %= 65521
        b %= 65521
    }
    return (b << 16) | a
}

/// Inflates zlib data (header, deflate stream, Adler-32 trailer).
public func inflate(_ data: [UInt8], maxOutput: Int? = nil, sizeHint: Int? = nil, verify: Bool = true) throws -> [UInt8] {
    if data.count < 6 { throw ZlibError("Truncated zlib stream") }
    let cmf = Int(data[0])
    let flg = Int(data[1])
    if (cmf & 15) != 8 || ((cmf << 8) | flg) % 31 != 0 { throw ZlibError("Not a zlib stream") }
    if flg & 32 != 0 { throw ZlibError("Preset dictionaries are not supported") }
    let out = try inflateRaw(Array(data[2...]), maxOutput: maxOutput, sizeHint: sizeHint)
    if verify {
        let t = data.count - 4
        let want = (UInt32(data[t]) << 24) | (UInt32(data[t + 1]) << 16) | (UInt32(data[t + 2]) << 8) | UInt32(data[t + 3])
        if adler32(out) != want { throw ZlibError("Adler-32 mismatch") }
    }
    return out
}

// MARK: - Deflate

private struct BitWriter {
    var buf: [UInt8] = []
    var bit: UInt32 = 0
    var bits: UInt32 = 0

    init(hint: Int) { buf.reserveCapacity(Swift.max(1024, hint)) }

    mutating func write(_ value: Int, _ n: Int) {
        bit |= UInt32(truncatingIfNeeded: value) << bits
        bits += UInt32(n)
        while bits >= 8 {
            buf.append(UInt8(bit & 255))
            bit >>= 8
            bits -= 8
        }
    }

    mutating func flush() {
        if bits > 0 { buf.append(UInt8(bit & 255)) }
        bit = 0
        bits = 0
    }
}

/// Code lengths (≤ maxBits) for symbol frequencies, by Huffman's algorithm with frequency flattening.
private func codeLengths(_ freqs: [Int], _ maxBits: Int) -> [UInt8] {
    let n = freqs.count
    var lengths = [UInt8](repeating: 0, count: n)
    var f = freqs.map { Double($0) }
    struct Node {
        var w: Double
        var sym: Int
        var left = -1
        var right = -1
    }
    while true {
        var nodes: [Node] = []
        for i in 0..<n where f[i] > 0 { nodes.append(Node(w: f[i], sym: i)) }
        lengths = [UInt8](repeating: 0, count: n)
        if nodes.isEmpty { return lengths }
        if nodes.count == 1 {
            lengths[nodes[0].sym] = 1
            return lengths
        }
        // Simple binary heap of node indexes by weight.
        var heap = Array(0..<nodes.count)
        func less(_ a: Int, _ b: Int) -> Bool { nodes[a].w < nodes[b].w || (nodes[a].w == nodes[b].w && a < b) }
        func down(_ start: Int) {
            var i = start
            while true {
                let l = 2 * i + 1
                let r = l + 1
                var m = i
                if l < heap.count && less(heap[l], heap[m]) { m = l }
                if r < heap.count && less(heap[r], heap[m]) { m = r }
                if m == i { return }
                heap.swapAt(i, m)
                i = m
            }
        }
        func up(_ start: Int) {
            var i = start
            while i > 0 {
                let p = (i - 1) >> 1
                if !less(heap[i], heap[p]) { return }
                heap.swapAt(i, p)
                i = p
            }
        }
        var i = (heap.count >> 1) - 1
        while i >= 0 {
            down(i)
            i -= 1
        }
        func pop() -> Int {
            let top = heap[0]
            let last = heap.removeLast()
            if !heap.isEmpty {
                heap[0] = last
                down(0)
            }
            return top
        }
        while heap.count > 1 {
            let a = pop()
            let b = pop()
            nodes.append(Node(w: nodes[a].w + nodes[b].w, sym: -1, left: a, right: b))
            heap.append(nodes.count - 1)
            up(heap.count - 1)
        }
        var maxLen = 0
        var stack: [(Int, Int)] = [(heap[0], 0)]
        while let (i, d) = stack.popLast() {
            let node = nodes[i]
            if node.sym >= 0 {
                lengths[node.sym] = UInt8(d)
                if d > maxLen { maxLen = d }
            } else {
                stack.append((node.left, d + 1))
                stack.append((node.right, d + 1))
            }
        }
        if maxLen <= maxBits { return lengths }
        // Too deep: flatten the distribution and retry.
        for i in 0..<n where f[i] > 0 { f[i] = JS.floor(f[i] / 2) + 1 }
    }
}

/// Canonical codes for code lengths, bit-reversed for LSB-first output.
private func canonicalCodes(_ lengths: [UInt8]) -> [Int] {
    var blCount = [Int](repeating: 0, count: 16)
    for l in lengths { blCount[Int(l)] += 1 }
    blCount[0] = 0
    var next = [Int](repeating: 0, count: 16)
    var code = 0
    for bits in 1..<16 {
        code = (code + blCount[bits - 1]) << 1
        // A Uint16Array store.
        next[bits] = code & 0xFFFF
    }
    var codes = [Int](repeating: 0, count: lengths.count)
    for i in 0..<lengths.count {
        let len = Int(lengths[i])
        if len == 0 { continue }
        var c = next[len]
        next[len] = (next[len] + 1) & 0xFFFF
        var r = 0
        for _ in 0..<len {
            r = (r << 1) | (c & 1)
            c >>= 1
        }
        codes[i] = r & 0xFFFF
    }
    return codes
}

private func lengthSymbol(_ len: Int) -> Int {
    var i = 28
    while LENGTH_BASE[i] > len { i -= 1 }
    return i
}

private func distSymbol(_ d: Int) -> Int {
    var i = 29
    while DIST_BASE[i] > d { i -= 1 }
    return i
}

private let WINDOW = 32768
private let HASH_BITS = 15
private let HASH_SIZE = 1 << HASH_BITS
private let MAX_CHAIN = 24
private let MAX_MATCH = 258
private let BLOCK_SYMBOLS = 65536

/// Raw deflate (no zlib header). `level` 0 stores the data uncompressed.
public func deflateRaw(_ data: [UInt8], level: Int = 1) -> [UInt8] {
    var w = BitWriter(hint: (data.count + 1) / 2 + 64)
    let n = data.count
    if level == 0 || n == 0 {
        var pos = 0
        repeat {
            let len = Swift.min(65535, n - pos)
            let final = pos + len >= n ? 1 : 0
            w.write(final, 1)
            w.write(0, 2)
            w.flush()
            w.write(len & 0xFFFF, 16)
            w.write(~len & 0xFFFF, 16)
            for i in 0..<len { w.write(Int(data[pos + i]), 8) }
            pos += len
        } while pos < n
        return w.buf
    }

    var head = [Int](repeating: -1, count: HASH_SIZE)
    var prev = [Int](repeating: 0, count: WINDOW)
    // Symbols of the current block: literal (0..255) or length/distance pairs.
    var litLen = [Int](repeating: 0, count: BLOCK_SYMBOLS)
    var dists = [Int](repeating: 0, count: BLOCK_SYMBOLS)
    var count = 0
    let hash = { (i: Int) -> Int in
        let v = UInt64((Int(data[i]) << 10) ^ (Int(data[i + 1]) << 5) ^ Int(data[i + 2]))
        return Int(UInt32(truncatingIfNeeded: v &* 2_654_435_761) >> UInt32(32 - HASH_BITS))
    }
    func insert(_ i: Int) {
        if i + 2 >= n { return }
        let h = hash(i)
        prev[i & (WINDOW - 1)] = head[h]
        head[h] = i
    }
    /// `data[i]`, or -1 past the end (`undefined` never equals a byte).
    let at = { (i: Int) -> Int in i < n ? Int(data[i]) : -1 }

    func flushBlock(_ final: Bool) {
        var litFreq = [Int](repeating: 0, count: 286)
        var distFreq = [Int](repeating: 0, count: 30)
        for k in 0..<count {
            if dists[k] == 0 {
                litFreq[litLen[k]] += 1
            } else {
                litFreq[257 + lengthSymbol(litLen[k])] += 1
                distFreq[distSymbol(dists[k])] += 1
            }
        }
        litFreq[256] = 1
        if !distFreq.contains(where: { $0 != 0 }) { distFreq[0] = 1 }
        let litLengths = codeLengths(litFreq, 15)
        let distLengths = codeLengths(distFreq, 15)
        var hlit = 286
        while hlit > 257 && litLengths[hlit - 1] == 0 { hlit -= 1 }
        var hdist = 30
        while hdist > 1 && distLengths[hdist - 1] == 0 { hdist -= 1 }
        let all = Array(litLengths[0..<hlit]) + Array(distLengths[0..<hdist])
        // Run-length encode the code lengths.
        var clSyms: [Int] = []
        var clExtra: [Int] = []
        var i = 0
        while i < all.count {
            let v = all[i]
            var run = 1
            while i + run < all.count && all[i + run] == v { run += 1 }
            if v == 0 && run >= 3 {
                let r = Swift.min(run, 138)
                if r >= 11 {
                    clSyms.append(18)
                    clExtra.append(r - 11)
                } else {
                    clSyms.append(17)
                    clExtra.append(r - 3)
                }
                i += r
            } else if v != 0 && run >= 4 {
                clSyms.append(Int(v))
                clExtra.append(0)
                let r = Swift.min(run - 1, 6)
                clSyms.append(16)
                clExtra.append(r - 3)
                i += r + 1
            } else {
                clSyms.append(Int(v))
                clExtra.append(0)
                i += 1
            }
        }
        var clFreq = [Int](repeating: 0, count: 19)
        for s in clSyms { clFreq[s] += 1 }
        let clLengths = codeLengths(clFreq, 7)
        var hclen = 19
        while hclen > 4 && clLengths[CL_ORDER[hclen - 1]] == 0 { hclen -= 1 }
        let clCodes = canonicalCodes(clLengths)
        let litCodes = canonicalCodes(litLengths)
        let distCodes = canonicalCodes(distLengths)

        w.write(final ? 1 : 0, 1)
        w.write(2, 2)
        w.write(hlit - 257, 5)
        w.write(hdist - 1, 5)
        w.write(hclen - 4, 4)
        for i in 0..<hclen { w.write(Int(clLengths[CL_ORDER[i]]), 3) }
        for i in 0..<clSyms.count {
            let s = clSyms[i]
            w.write(clCodes[s], Int(clLengths[s]))
            if s == 16 { w.write(clExtra[i], 2) } else if s == 17 { w.write(clExtra[i], 3) } else if s == 18 { w.write(clExtra[i], 7) }
        }
        for k in 0..<count {
            let d = dists[k]
            if d == 0 {
                let s = litLen[k]
                w.write(litCodes[s], Int(litLengths[s]))
            } else {
                let len = litLen[k]
                let li = lengthSymbol(len)
                w.write(litCodes[257 + li], Int(litLengths[257 + li]))
                if LENGTH_EXTRA[li] != 0 { w.write(len - LENGTH_BASE[li], LENGTH_EXTRA[li]) }
                let di = distSymbol(d)
                w.write(distCodes[di], Int(distLengths[di]))
                if DIST_EXTRA[di] != 0 { w.write(d - DIST_BASE[di], DIST_EXTRA[di]) }
            }
        }
        w.write(litCodes[256], Int(litLengths[256]))
        count = 0
    }

    var i = 0
    while i < n {
        var bestLen = 0
        var bestDist = 0
        if i + 2 < n {
            var cand = head[hash(i)]
            var chain = MAX_CHAIN
            let limit = Swift.min(MAX_MATCH, n - i)
            while cand >= 0 && i - cand <= WINDOW - 1 && chain > 0 {
                chain -= 1
                if at(cand + bestLen) == at(i + bestLen) {
                    var l = 0
                    while l < limit && data[cand + l] == data[i + l] { l += 1 }
                    if l > bestLen {
                        bestLen = l
                        bestDist = i - cand
                        if l == limit { break }
                    }
                }
                let next = prev[cand & (WINDOW - 1)]
                if next >= cand { break }
                cand = next
            }
        }
        if bestLen >= 3 {
            litLen[count] = bestLen
            dists[count] = bestDist
            count += 1
            let end = i + bestLen
            // Insert every position of long runs only up to a cap, which keeps solid areas fast.
            let insertEnd = bestLen > 64 ? i + 64 : end
            for k in i..<insertEnd { insert(k) }
            var k = Swift.max(insertEnd, end - 3)
            while k < end {
                insert(k)
                k += 1
            }
            i = end
        } else {
            litLen[count] = Int(data[i])
            dists[count] = 0
            count += 1
            insert(i)
            i += 1
        }
        if count >= BLOCK_SYMBOLS - 1 && i < n { flushBlock(false) }
    }
    // The final block may hold only the end-of-block symbol.
    flushBlock(true)
    w.flush()
    return w.buf
}

/// zlib stream: header, raw deflate, Adler-32.
public func deflate(_ data: [UInt8], level: Int = 1) -> [UInt8] {
    let raw = deflateRaw(data, level: level)
    let a = adler32(data)
    return [0x78, 0x01] + raw + [UInt8(a >> 24), UInt8((a >> 16) & 255), UInt8((a >> 8) & 255), UInt8(a & 255)]
}
