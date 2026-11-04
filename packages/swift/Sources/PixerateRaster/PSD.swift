import Foundation
import PixerateCore

/**
 * An 8-bit RGB PSD (PSB above 30 000 px) from the shared layer stack: the part of the image
 * editor's PSD writer (`image-editor/psd/export.ts`, `file.ts`, `binary.ts`, `compression.ts`,
 * `pixels.ts`) that pixel layers and groups use. Records, tagged blocks, RLE (PackBits) channels,
 * the resolution and version resources and the merged image are written byte for byte as the TS
 * writer writes them.
 *
 * Not ported: layer styles (`lfx2`, written by the TS writer; here they are left out with a
 * warning), vector masks, adjustment, smart, shape and type layers, deep (16- / 32-bit) samples,
 * CMYK and Lab, alpha channels, paths and embedded patterns.
 */

public struct PsdError: Error, LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// A big-endian writer (`PsdWriter`).
public struct PsdWriter {
    public private(set) var bytes: [UInt8] = []
    public init() {}
    public var count: Int { bytes.count }
    public mutating func u8(_ v: Int) { bytes.append(UInt8(truncatingIfNeeded: v)) }
    public mutating func u16(_ v: Int) { u8(v >> 8); u8(v) }
    public mutating func i16(_ v: Int) { u16(v < 0 ? v + 65536 : v) }
    public mutating func u32(_ v: Int) {
        let x = UInt32(truncatingIfNeeded: v)
        bytes.append(UInt8(x >> 24)); bytes.append(UInt8((x >> 16) & 255)); bytes.append(UInt8((x >> 8) & 255)); bytes.append(UInt8(x & 255))
    }
    public mutating func i32(_ v: Int) { u32(v) }
    public mutating func u64(_ v: Int) { u32(v >> 32); u32(v & 0xffff_ffff) }
    public mutating func f64(_ v: Double) { let b = v.bitPattern; for k in stride(from: 56, through: 0, by: -8) { bytes.append(UInt8((b >> UInt64(k)) & 255)) } }
    public mutating func append(_ b: [UInt8]) { bytes.append(contentsOf: b) }
    public mutating func ascii(_ s: String) { for u in s.utf16 { u8(Int(u)) } }
    public mutating func zeros(_ n: Int) { if n > 0 { bytes.append(contentsOf: repeatElement(0, count: n)) } }
    /// Reserves a length field; `endLen` fills it with the bytes written since.
    public mutating func beginLen(_ long: Bool) -> (at: Int, long: Bool) {
        let at = bytes.count
        if long { u64(0) } else { u32(0) }
        return (at, long)
    }
    public mutating func endLen(_ mark: (at: Int, long: Bool)) {
        let n = bytes.count - mark.at - (mark.long ? 8 : 4)
        var w = PsdWriter()
        if mark.long { w.u64(n) } else { w.u32(n) }
        bytes.replaceSubrange(mark.at ..< mark.at + w.count, with: w.bytes)
    }
    /// Pascal string padded to a multiple of `align`.
    public mutating func pascal(_ s: [UInt8], _ align: Int) {
        let n = Swift.min(255, s.count)
        u8(n)
        append(Array(s.prefix(n)))
        zeros((align - ((1 + n) % align)) % align)
    }
    /// Photoshop Unicode string: u32 code-unit count, UTF-16BE units.
    public mutating func unicode(_ s: String) {
        let units = Array(s.utf16)
        u32(units.count)
        for u in units { u16(Int(u)) }
    }
}

/// A name for a legacy Pascal field: non-ASCII characters become `?` (at most 255).
public func encodePsdLegacyName(_ s: String) -> [UInt8] {
    var out: [UInt8] = []
    for ch in s.unicodeScalars {
        let c = Int(ch.value)
        out.append(c >= 32 && c < 127 ? UInt8(c) : 63)
        if out.count >= 255 { break }
    }
    return out
}

/// PackBits of one row, appended to `out`.
func packbitsEncode(_ src: ArraySlice<UInt8>, into out: inout [UInt8]) {
    let base = src.startIndex, n = src.count
    var i = 0
    while i < n {
        var run = 1
        while i + run < n && run < 128 && src[base + i + run] == src[base + i] { run += 1 }
        if run >= 2 {
            out.append(UInt8((257 - run) & 255))
            out.append(src[base + i])
            i += run
            continue
        }
        let start = i
        var len = 0
        while i < n && len < 128 {
            if i + 2 < n && src[base + i] == src[base + i + 1] && src[base + i] == src[base + i + 2] { break }
            i += 1
            len += 1
        }
        out.append(UInt8(len - 1))
        out.append(contentsOf: src[(base + start) ..< (base + start + len)])
    }
}

/// RLE-encodes planar 8-bit data: row counts (u16, or u32 in PSB), then the packed rows.
public func encodePsdRle(_ decoded: [UInt8], planes: Int, width: Int, height: Int, psb: Bool) throws -> [UInt8] {
    let rows = planes * height
    var counts = PsdWriter()
    var packed: [UInt8] = []
    for row in 0 ..< rows {
        let start = packed.count
        packbitsEncode(decoded[(row * width) ..< ((row + 1) * width)], into: &packed)
        let n = packed.count - start
        if psb { counts.u32(n) } else {
            if n > 0xffff { throw PsdError("An RLE row is longer than 65535 bytes; write a PSB instead.") }
            counts.u16(n)
        }
    }
    return counts.bytes + packed
}

public let PSD_MAX_DIMENSION = 30000
private let CHANNEL_ALPHA = -1
private let CHANNEL_USER_MASK = -2
private let LAYER_FLAG_TRANSPARENCY_PROTECTED = 1
private let LAYER_FLAG_HIDDEN = 2
private let MASK_FLAG_UNLINKED = 1
private let MASK_FLAG_DISABLED = 2
private let MASK_FLAG_PARAMETERS = 16
private let SECTION_OPEN = 1
private let SECTION_CLOSED = 2
private let SECTION_DIVIDER = 3
/// Layer flag bits 3 and 4: "bit 4 is useful" and "pixel data irrelevant" (group records).
private let FLAG_PIXELS_IRRELEVANT = 8 | 16

/// Our blend modes → PSD keys (`BLEND_TO_PSD`).
public let PSD_BLEND_KEYS: [String: String] = [
    "pass-through": "pass", "normal": "norm", "darken": "dark", "multiply": "mul ", "color-burn": "idiv", "linear-burn": "lbrn",
    "darker-color": "dkCl", "lighten": "lite", "screen": "scrn", "color-dodge": "div ", "linear-dodge": "lddg", "lighter-color": "lgCl",
    "overlay": "over", "soft-light": "sLit", "hard-light": "hLit", "vivid-light": "vLit", "linear-light": "lLit", "pin-light": "pLit",
    "hard-mix": "hMix", "difference": "diff", "exclusion": "smud", "subtract": "fsub", "divide": "fdiv", "hue": "hue ",
    "saturation": "sat ", "color": "colr", "luminosity": "lum ",
]

private struct PsdRect { var top = 0, left = 0, bottom = 0, right = 0 }
private struct PsdChannel { var id: Int; var compression: Int; var data: [UInt8] }
private struct PsdMask {
    var rect = PsdRect()
    var defaultColor: Int
    var flags: Int
    var userDensity: Int?
    var userFeather: Double?
}
private struct PsdRecord {
    var rect = PsdRect()
    var channels: [PsdChannel] = []
    var blendKey: String
    var opacity = 255
    var clipping = 0
    var flags = 0
    var mask: PsdMask?
    var legacyName: String
    var blocks: [(key: String, data: [UInt8])]
}

public struct PsdExportResult {
    public var bytes: [UInt8]
    public var psb: Bool
    /// Layer records written (group folders and dividers included).
    public var records: Int
    /// One sentence per loss, naming the layers.
    public var warnings: [String]
}

private func toRect(_ r: RasterRect) -> PsdRect { PsdRect(top: r.y, left: r.x, bottom: r.y + r.height, right: r.x + r.width) }

/**
 * Writes a stack of pixel layers and groups, bottom to top, with the caller's composite as the
 * merged image (`exportPsd` for 8-bit RGB).
 */
public func exportPsd(width: Int, height: Int, layers: [RasterLayer], merged: [UInt8], resolution: Double? = nil) throws -> PsdExportResult {
    if width < 1 || height < 1 { throw PsdError("The document is empty.") }
    let psb = width > PSD_MAX_DIMENSION || height > PSD_MAX_DIMENSION
    var records: [PsdRecord] = []
    var nextId = 0
    var notes: [(String, [String])] = []
    func note(_ msg: String, _ name: String) {
        if let i = notes.firstIndex(where: { $0.0 == msg }) { notes[i].1.append(name) } else { notes.append((msg, [name])) }
    }
    func rle(_ id: Int, _ plane: [UInt8], _ w: Int, _ h: Int) throws -> PsdChannel {
        PsdChannel(id: id, compression: 1, data: try encodePsdRle(plane, planes: 1, width: w, height: h, psb: psb))
    }
    func empty() -> [PsdChannel] { [CHANNEL_ALPHA, 0, 1, 2].map { PsdChannel(id: $0, compression: 0, data: []) } }
    func u32Bytes(_ v: Int) -> [UInt8] { var w = PsdWriter(); w.u32(v); return w.bytes }
    func unicodeBlock(_ s: String) -> [UInt8] { var w = PsdWriter(); w.unicode(s); return w.bytes }
    func sectionBlock(_ kind: Int, _ blendKey: String? = nil) -> [UInt8] {
        var w = PsdWriter()
        w.u32(kind)
        if let blendKey { w.ascii("8BIM"); w.ascii(blendKey) }
        return w.bytes
    }
    func maskChannel(_ mask: RasterMask, _ ox: Int, _ oy: Int) throws -> (PsdChannel, PsdMask) {
        if mask.source != nil { throw PsdError("A parametric mask must be baked before export.") }
        let flags = (mask.enabled == false ? MASK_FLAG_DISABLED : 0) | (mask.linked == false ? MASK_FLAG_UNLINKED : 0)
        var m = PsdMask(defaultColor: mask.defaultValue, flags: flags)
        if (mask.density ?? 1) < 1 { m.userDensity = Int(JS.round(Swift.max(0, mask.density ?? 1) * 255)) }
        if (mask.feather ?? 0) > 0 { m.userFeather = mask.feather }
        guard let b = contentBounds(mask.surface) else { return (PsdChannel(id: CHANNEL_USER_MASK, compression: 0, data: []), m) }
        m.rect = toRect(RasterRect(x: b.x + ox, y: b.y + oy, width: b.width, height: b.height))
        return (try rle(CHANNEL_USER_MASK, readRegion(mask.surface, b), b.width, b.height), m)
    }
    func lockBits(_ l: LayerLocks?) -> Int {
        guard let l else { return 0 }
        return (l.all == true ? 0x8000_0000 : 0) | (l.transparency == true ? 1 : 0) | (l.pixels == true ? 2 : 0) | (l.position == true ? 4 : 0)
    }
    func common(_ layer: RasterLayer, _ extra: [(key: String, data: [UInt8])] = []) -> PsdRecord {
        nextId += 1
        var blocks: [(key: String, data: [UInt8])] = [("luni", unicodeBlock(layer.name)), ("lyid", u32Bytes(nextId))] + extra
        if let fx = layer.effects, !(fx.items.isEmpty && fx.enabled && (fx.scale ?? 1) == 1) {
            note("Layer styles are not written by the Swift PSD writer yet; they were left out", layer.name)
        }
        let locks = lockBits(layer.locks)
        if locks != 0 { blocks.append(("lspf", u32Bytes(locks))) }
        return PsdRecord(
            blendKey: "norm", opacity: Int(JS.round(Swift.min(1, Swift.max(0, layer.opacity)) * 255)), clipping: layer.clipped ? 1 : 0,
            flags: (layer.visible ? 0 : LAYER_FLAG_HIDDEN) | (layer.locks?.transparency == true ? LAYER_FLAG_TRANSPARENCY_PROTECTED : 0),
            legacyName: layer.name, blocks: blocks
        )
    }
    func write(_ layer: RasterLayer) throws {
        switch layer.content {
        case .group(let children, let collapsed):
            records.append(PsdRecord(
                channels: empty(), blendKey: "norm", flags: FLAG_PIXELS_IRRELEVANT | (layer.visible ? 0 : LAYER_FLAG_HIDDEN), legacyName: "</Layer group>",
                blocks: [("luni", unicodeBlock("</Layer group>")), ("lsct", sectionBlock(SECTION_DIVIDER))]
            ))
            for child in children { try write(child) }
            let blendKey = PSD_BLEND_KEYS[layer.blend.rawValue] ?? "norm"
            var rec = common(layer, [("lsct", sectionBlock(collapsed == true ? SECTION_CLOSED : SECTION_OPEN, blendKey))])
            rec.channels = empty()
            rec.blendKey = blendKey
            rec.flags |= FLAG_PIXELS_IRRELEVANT
            if let mask = layer.mask {
                let (ch, m) = try maskChannel(mask, 0, 0)
                rec.channels.append(ch)
                rec.mask = m
            }
            records.append(rec)
        case .pixel(let surface, let offset, let fillOpacity):
            var extra: [(key: String, data: [UInt8])] = []
            if let f = fillOpacity, f < 1 { extra.append(("iOpa", [UInt8(JS.round(Swift.max(0, f) * 255)), 0, 0, 0])) }
            var rec = common(layer, extra)
            rec.blendKey = PSD_BLEND_KEYS[layer.blend.rawValue] ?? "norm"
            if let b = contentBounds(surface) {
                rec.rect = toRect(RasterRect(x: b.x + offset.x, y: b.y + offset.y, width: b.width, height: b.height))
                let px = readRegion(surface, b)
                let n = b.width * b.height
                var planes = [[UInt8]](repeating: [UInt8](repeating: 0, count: n), count: 4)
                for i in 0 ..< n { for c in 0 ..< 4 { planes[c][i] = px[i * 4 + c] } }
                rec.channels = try [(CHANNEL_ALPHA, 3), (0, 0), (1, 1), (2, 2)].map { try rle($0.0, planes[$0.1], b.width, b.height) }
            } else {
                rec.channels = empty()
            }
            if let mask = layer.mask {
                let (ch, m) = try maskChannel(mask, offset.x, offset.y)
                rec.channels.append(ch)
                rec.mask = m
            }
            records.append(rec)
        }
    }
    for layer in layers { try write(layer) }
    if records.count > 32767 { throw PsdError("A PSD holds at most 32767 layer records.") }

    // Merged image: RGB, plus alpha when anything is transparent, matted over white.
    let n = width * height
    if merged.count < n * 4 { throw PsdError("The merged image has \(merged.count) bytes, expected \(n * 4).") }
    var planes = [[UInt8]](repeating: [UInt8](repeating: 0, count: n), count: 4)
    for i in 0 ..< n {
        let o = i * 4, a = Double(merged[o + 3])
        for c in 0 ..< 3 {
            let v = Double(merged[o + c])
            planes[c][i] = a == 255 ? merged[o + c] : JS.u8c(JS.round((v * a + 255 * (255 - a)) / 255))
        }
        planes[3][i] = merged[o + 3]
    }
    let transparent = planes[3].contains { $0 != 255 }
    if !transparent { planes.removeLast() }
    let mergedBytes = planes.flatMap { $0 }

    let res = Swift.max(1, resolution ?? 72)
    var rw = PsdWriter()
    for _ in 0 ..< 2 {
        rw.u32(Int(JS.round(res * 65536)))
        rw.u16(1) // pixels per inch
        rw.u16(1) // inches
    }
    var version = PsdWriter()
    version.u32(1)
    version.u8(1) // the merged image is real
    version.unicode("Pixerate Editor")
    version.unicode("Pixerate Editor")
    version.u32(1)
    let resources: [(id: Int, data: [UInt8])] = [(1005, rw.bytes), (1057, version.bytes)]

    // writePsd
    var w = PsdWriter()
    w.ascii("8BPS")
    w.u16(psb ? 2 : 1)
    w.zeros(6)
    w.u16(planes.count)
    w.u32(height)
    w.u32(width)
    w.u16(8)
    w.u16(3)
    w.u32(0) // no colour mode data
    let resMark = w.beginLen(false)
    for r in resources {
        w.ascii("8BIM")
        w.u16(r.id)
        w.pascal([], 2)
        w.u32(r.data.count)
        w.append(r.data)
        if r.data.count % 2 != 0 { w.u8(0) }
    }
    w.endLen(resMark)
    let lm = w.beginLen(psb)
    if !records.isEmpty {
        let li = w.beginLen(psb)
        let start = w.count
        w.i16(transparent ? -records.count : records.count)
        for rec in records { writeLayerRecord(&w, rec, psb) }
        for rec in records { for c in rec.channels { w.u16(c.compression); w.append(c.data) } }
        if (w.count - start) % 2 != 0 { w.u8(0) }
        w.endLen(li)
        w.u32(0) // no global layer mask
    }
    w.endLen(lm)
    w.u16(1)
    w.append(try encodePsdRle(mergedBytes, planes: planes.count, width: width, height: height, psb: psb))
    let warnings = notes.map { msg, names in "\(msg) (\(names.map { "\"\($0)\"" }.joined(separator: ", ")))." }
    return PsdExportResult(bytes: w.bytes, psb: psb, records: records.count, warnings: warnings)
}

private func writeRect(_ w: inout PsdWriter, _ r: PsdRect) {
    w.i32(r.top)
    w.i32(r.left)
    w.i32(r.bottom)
    w.i32(r.right)
}

private func writeLayerRecord(_ w: inout PsdWriter, _ rec: PsdRecord, _ psb: Bool) {
    writeRect(&w, rec.rect)
    w.u16(rec.channels.count)
    for c in rec.channels {
        w.i16(c.id)
        if psb { w.u64(2 + c.data.count) } else { w.u32(2 + c.data.count) }
    }
    w.ascii("8BIM")
    w.ascii(rec.blendKey)
    w.u8(rec.opacity)
    w.u8(rec.clipping)
    w.u8(rec.flags)
    w.u8(0)
    let extra = w.beginLen(false)
    let maskMark = w.beginLen(false)
    if let m = rec.mask {
        writeRect(&w, m.rect)
        w.u8(m.defaultColor)
        let pf = (m.userDensity != nil ? 1 : 0) | (m.userFeather != nil ? 2 : 0)
        w.u8(pf != 0 ? m.flags | MASK_FLAG_PARAMETERS : m.flags & ~MASK_FLAG_PARAMETERS)
        var len = 18
        if pf != 0 {
            w.u8(pf)
            if let d = m.userDensity { w.u8(d) }
            if let f = m.userFeather { w.f64(f) }
            len += 1 + (pf & 1 != 0 ? 1 : 0) + (pf & 2 != 0 ? 8 : 0)
        }
        // Pad to the 20-byte minimum the spec asks for.
        w.zeros(Swift.max(0, 20 - len) + ((4 - (Swift.max(20, len) % 4)) % 4))
    }
    w.endLen(maskMark)
    // Blending ranges: composite gray plus one per colour channel, all full.
    w.u32(40)
    for _ in 0 ..< 5 { w.append([0, 0, 255, 255, 0, 0, 255, 255]) }
    w.pascal(encodePsdLegacyName(rec.legacyName), 4)
    for b in rec.blocks {
        w.ascii("8BIM")
        w.ascii(b.key)
        let pad = (2 - (b.data.count % 2)) % 2
        w.u32(b.data.count + pad)
        w.append(b.data)
        w.zeros(pad)
    }
    w.endLen(extra)
}
