// Portions after cadcraft's crates/io/src/pdf.rs and pdfcraft's crates/content/src/lib.rs (MIT OR
// Apache-2.0, © ArtCraft Team and contributors) by way of packages/core/src/vector/pdf.ts. See
// THIRD_PARTY_NOTICES.md.

import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Vector PDF export (`vector/pdf.ts`): the drawing as real PDF paths, not a picture. A minimal PDF
// writer (numbered objects, a cross-reference table, Flate-compressed content streams through
// `PixerateRaster`'s `deflate`, the TS one ported) draws what the canvas draws: the scene render
// data, with linear and radial gradients as PDF shadings and pattern paints as their tiles. Filters,
// opacity masks, stop opacity and text without glyph outlines are left out and named in `notes`.
// What the Swift render data cannot draw yet (stroke parts, brushstrokes, lenses) throws
// `VectorNotPorted` from there; the writer itself is complete. Numbers print as the TS prints
// them (`Math.round(v * 1000) / 1000`, then `String`), so the bytes match the TS byte for byte.

/// Options of `vectorDocumentToPdf` (`VectorPdfOptions`).
public struct VectorPdfOptions: Sendable {
    /// `document`: one page of the artboard (default); `artboards`: a page per top-level frame.
    public var pages: String?
    /// PDF points per document unit (default 1).
    public var scale: Double?
    /// Document title.
    public var title: String?
    /// Flate-compress the content streams (default true).
    public var compress: Bool?

    public init(pages: String? = nil, scale: Double? = nil, title: String? = nil, compress: Bool? = nil) {
        self.pages = pages
        self.scale = scale
        self.title = title
        self.compress = compress
    }
}

/// What `vectorDocumentToPdf` returns (`VectorPdfExport`).
public struct VectorPdfExport: Sendable {
    public var bytes: [UInt8]
    public var pages: Int
    /// What was approximated or left out.
    public var notes: [String]
}

/// `String(Math.round(v * 1000) / 1000)`, with -0 as `0`.
private func n(_ v: Double) -> String {
    let r = JS.round(v * 1000) / 1000
    return r == 0 ? "0" : jsString(r)
}

private let PDF_BLEND: [String: String] = [
    "multiply": "Multiply", "screen": "Screen", "overlay": "Overlay", "darken": "Darken", "lighten": "Lighten", "color-dodge": "ColorDodge", "color-burn": "ColorBurn",
    "hard-light": "HardLight", "soft-light": "SoftLight", "difference": "Difference", "exclusion": "Exclusion", "hue": "Hue", "saturation": "Saturation", "color": "Color",
    "luminosity": "Luminosity",
]

/// JavaScript's `\s` as a character class body.
private let WS = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
private let TRANSFORM_RE = try! NSRegularExpression(pattern: "([A-Za-z0-9_]+)[\(WS)]*\\(([^)]*)\\)")

/// `s.split(/[\s,]+/).filter(Boolean)`.
private func splitList(_ s: String) -> [String] {
    var out: [String] = []
    var cur = String.UnicodeScalarView()
    for u in s.unicodeScalars {
        if u == "," || isJSWhitespace(u) {
            if !cur.isEmpty { out.append(String(cur)) }
            cur = String.UnicodeScalarView()
        } else {
            cur.append(u)
        }
    }
    if !cur.isEmpty { out.append(String(cur)) }
    return out
}

/// An SVG transform attribute as `[a, b, c, d, e, f]` (identity when absent; `matrixOf`).
private func matrixOf(_ t: String?) -> [Double] {
    guard let t, !t.isEmpty else { return [1, 0, 0, 1, 0, 0] }
    func mul(_ a: [Double], _ b: [Double]) -> [Double] {
        [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]
    }
    var m: [Double] = [1, 0, 0, 1, 0, 0]
    let ns = t as NSString
    for match in TRANSFORM_RE.matches(in: t, range: NSRange(location: 0, length: ns.length)) {
        let name = ns.substring(with: match.range(at: 1))
        let v = splitList(ns.substring(with: match.range(at: 2))).map(\.jsToNumber)
        func at(_ i: Int) -> Double? { i < v.count ? v[i] : nil }
        var k: [Double] = [1, 0, 0, 1, 0, 0]
        if name == "matrix" && v.count == 6 { k = v }
        else if name == "translate" { k = [1, 0, 0, 1, at(0) ?? 0, at(1) ?? 0] }
        else if name == "scale" { k = [at(0) ?? 1, 0, 0, at(1) ?? at(0) ?? 1, 0, 0] }
        else if name == "rotate" {
            let r = ((at(0) ?? 0) * Double.pi) / 180
            let (cx, cy) = (at(1) ?? 0, at(2) ?? 0)
            k = mul(mul([1, 0, 0, 1, cx, cy], [JS.cos(r), JS.sin(r), -JS.sin(r), JS.cos(r), 0, 0]), [1, 0, 0, 1, -cx, -cy])
        }
        m = mul(m, k)
    }
    return m
}

/// A box of path data (`{ x, y, w, h }`).
private struct PdfBox {
    var x: Double, y: Double, w: Double, h: Double
}

/// SVG path data as PDF path operators, and its box (`pathOps`).
private func pathOps(_ d: String) -> (ops: String, box: PdfBox?) {
    var out: [String] = []
    var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
    func see(_ x: Double, _ y: Double) {
        minX = JS.min(minX, x)
        minY = JS.min(minY, y)
        maxX = JS.max(maxX, x)
        maxY = JS.max(maxY, y)
    }
    var cx = 0.0, cy = 0.0
    for c in parseSvgPath(d) {
        switch c {
        case let .M(x, y):
            out.append("\(n(x)) \(n(y)) m")
            see(x, y)
            (cx, cy) = (x, y)
        case let .L(x, y):
            out.append("\(n(x)) \(n(y)) l")
            see(x, y)
            (cx, cy) = (x, y)
        case let .C(x1, y1, x2, y2, x, y):
            out.append("\(n(x1)) \(n(y1)) \(n(x2)) \(n(y2)) \(n(x)) \(n(y)) c")
            see(x1, y1)
            see(x2, y2)
            see(x, y)
            (cx, cy) = (x, y)
        case let .Q(x1, y1, x, y):
            // A quadratic as the equal cubic.
            let c1 = (cx + (2.0 / 3) * (x1 - cx), cy + (2.0 / 3) * (y1 - cy))
            let c2 = (x + (2.0 / 3) * (x1 - x), y + (2.0 / 3) * (y1 - y))
            out.append("\(n(c1.0)) \(n(c1.1)) \(n(c2.0)) \(n(c2.1)) \(n(x)) \(n(y)) c")
            see(x, y)
            (cx, cy) = (x, y)
        case .Z:
            out.append("h")
        case let .A(_, _, _, _, _, x, y):
            // Arcs never come from our own path data; a straight line keeps the outline closed.
            out.append("\(n(x)) \(n(y)) l")
            (cx, cy) = (x, y)
        }
    }
    return (out.joined(separator: "\n"), minX == .infinity ? nil : PdfBox(x: minX, y: minY, w: maxX - minX, h: maxY - minY))
}

/// `[...set]` of a JS `Set` of strings: insertion order, no repeats.
struct OrderedNotes {
    private(set) var list: [String] = []
    private var seen: Set<String> = []
    mutating func add(_ s: String) {
        if seen.insert(s).inserted { list.append(s) }
    }
}

/// The PDF file: numbered objects, then the cross-reference table (`PdfWriter`).
private final class PdfWriter {
    var objects: [[UInt8]] = []
    var gsDicts: [String: String] = [:]
    var shadingDicts: [String: String] = [:]
    var imageIds: [String: Int] = [:]
    var pageIndex = 0

    func add(_ body: [UInt8]) -> Int {
        objects.append(body)
        return objects.count
    }

    func add(_ body: String) -> Int { add(Array(body.utf8)) }

    func set(_ id: Int, _ body: String) { objects[id - 1] = Array(body.utf8) }

    func stream(_ dict: String, _ data: [UInt8], _ compress: Bool) -> [UInt8] {
        let body = compress ? deflate(data) : data
        let head = Array("<< \(dict)\(compress ? " /Filter /FlateDecode" : "") /Length \(body.count) >>\nstream\n".utf8)
        return head + body + Array("\nendstream".utf8)
    }

    func bytes(_ root: Int, _ info: Int) -> [UInt8] {
        var out = Array("%PDF-1.7\n%âãÏÓ\n".utf8)
        var offsets: [Int] = []
        for (k, o) in objects.enumerated() {
            offsets.append(out.count)
            out += Array("\(k + 1) 0 obj\n".utf8)
            out += o
            out += Array("\nendobj\n".utf8)
        }
        let offset = out.count
        var xref = "xref\n0 \(objects.count + 1)\n0000000000 65535 f \n"
        for o in offsets {
            let s = String(o)
            xref += String(repeating: "0", count: max(0, 10 - s.count)) + s + " 00000 n \n"
        }
        out += Array("\(xref)trailer\n<< /Size \(objects.count + 1) /Root \(root) 0 R /Info \(info) 0 R >>\nstartxref\n\(offset)\n%%EOF\n".utf8)
        return out
    }
}

/// An ordered `Map<string, string>` (names by key, in insertion order).
private struct NameMap {
    private(set) var keys: [String] = []
    private var names: [String: String] = [:]
    var count: Int { keys.count }
    subscript(key: String) -> String? { names[key] }
    mutating func set(_ key: String, _ name: String) {
        if names[key] == nil { keys.append(key) }
        names[key] = name
    }
    var values: [String] { keys.map { names[$0]! } }
}

/// One page's resources and content, built up while drawing (`Page`).
private final class PdfPage {
    var content: [String] = []
    var states = NameMap()
    var shadings = NameMap()
    var images = NameMap()
    let writer: PdfWriter
    let defs: [String: VectorPaintDef]
    var notes: OrderedNotes

    init(_ writer: PdfWriter, _ defs: [String: VectorPaintDef], _ notes: OrderedNotes) {
        self.writer = writer
        self.defs = defs
        self.notes = notes
    }

    /// A graphics state with this fill / stroke alpha and blend mode, by name.
    func gs(_ alpha: Double, _ strokeAlpha: Double, _ blend: String? = nil) -> String {
        let bm = blend.flatMap { PDF_BLEND[$0] }
        if let blend, !blend.isEmpty, blend != "normal", bm == nil { notes.add("Blend mode \(blend) has no PDF equivalent (normal used).") }
        let key = "\(n(alpha))|\(n(strokeAlpha))|\(bm ?? "")"
        if let name = states[key] { return name }
        let name = "GS\(states.count + 1)"
        states.set(key, name)
        writer.gsDicts["\(writer.pageIndex):\(name)"] = "<< /Type /ExtGState /ca \(n(alpha)) /CA \(n(strokeAlpha))\(bm.map { " /BM /\($0)" } ?? "") >>"
        return name
    }

    /// An image (a PNG data URL) as an XObject with its alpha as a soft mask, by name; nil when unreadable.
    func image(_ href: String) -> String? {
        if let hit = images[href] { return hit }
        guard let parsed = parseDataUrl(href), isPng(parsed.bytes), let img = try? decodePng(parsed.bytes) else { return nil }
        let px = img.width * img.height
        var rgb = [UInt8](repeating: 0, count: px * 3)
        var alpha = [UInt8](repeating: 0, count: px)
        for i in 0 ..< px {
            rgb[i * 3] = img.data[i * 4]
            rgb[i * 3 + 1] = img.data[i * 4 + 1]
            rgb[i * 3 + 2] = img.data[i * 4 + 2]
            alpha[i] = img.data[i * 4 + 3]
        }
        let w = writer
        let dims = "/Type /XObject /Subtype /Image /Width \(img.width) /Height \(img.height) /BitsPerComponent 8"
        let mask = w.add(w.stream("\(dims) /ColorSpace /DeviceGray", alpha, true))
        let id = w.add(w.stream("\(dims) /ColorSpace /DeviceRGB /SMask \(mask) 0 R", rgb, true))
        let name = "Im\(images.count + 1)"
        images.set(href, name)
        w.imageIds["\(w.pageIndex):\(name)"] = id
        return name
    }

    /// Sets the colour (or finds the paint server) for `paint`: its alpha, or a def to fill with by clipping.
    func paint(_ paint: String, _ stroking: Bool) -> (alpha: Double, def: VectorPaintDef?)? {
        if paint.isEmpty || paint == "none" { return nil }
        if paint.hasPrefix("url(#") && paint.hasSuffix(")") && paint.count > 6 {
            let id = String(paint.dropFirst(5).dropLast())
            return defs[id].map { (1, $0) }
        }
        guard let c = parseVectorColor(paint) else { return nil }
        content.append("\(n(c[0])) \(n(c[1])) \(n(c[2])) \(stroking ? "RG" : "rg")")
        return (c[3], nil)
    }

    /// A linear or radial gradient as a shading, by name (stop opacity left out).
    func shading(_ def: SvgGradientDef) -> String {
        if let name = shadings[def.id] { return name }
        let name = "Sh\(shadings.count + 1)"
        shadings.set(def.id, name)
        struct Stop { var t: Double; var c: [Double]; var a: Double }
        let stops = def.stops.map { s in
            Stop(t: JS.min(1, JS.max(0, s.offset.jsParseFloat / (s.offset.hasSuffix("%") ? 100 : 1))), c: parseVectorColor(s.stopColor) ?? [0, 0, 0, 1], a: s.stopOpacity ?? 1)
        }
        if stops.contains(where: { $0.a < 1 || $0.c[3] < 1 }) { notes.add("Gradient stop opacity has no PDF shading equivalent (stops drawn opaque).") }
        if let spread = def.attrs["spreadMethod"], truthy(spread), spread != .string("pad") { notes.add("Repeating and reflected gradient spreads are drawn padded.") }
        func rgb(_ c: [Double]) -> String { "[\(n(c[0])) \(n(c[1])) \(n(c[2]))]" }
        let list = stops.count == 1 ? [stops[0], stops[0]] : stops
        let fns = list.dropFirst().enumerated().map { k, s in "<< /FunctionType 2 /Domain [0 1] /C0 \(rgb(list[k].c)) /C1 \(rgb(s.c)) /N 1 >>" }
        let fn: String
        if fns.count == 1 {
            fn = fns[0]
        } else {
            let first = list.first.map { n($0.t) } ?? "undefined"
            let last = list.last.map { n($0.t) } ?? "undefined"
            let bounds = list.count > 2 ? list[1 ..< list.count - 1].map { n($0.t) }.joined(separator: " ") : ""
            fn = "<< /FunctionType 3 /Domain [\(first) \(last)] /Functions [\(fns.joined(separator: " "))] /Bounds [\(bounds)] /Encode [\(fns.map { _ in "0 1" }.joined(separator: " "))] >>"
        }
        let a = def.attrs
        func num(_ k: String, _ d: Double = 0) -> Double {
            guard let v = a[k] else { return d }
            switch v {
            case let .number(x): return jsString(x).jsParseFloat
            case let .string(s): return s.jsParseFloat
            default: return .nan
            }
        }
        let coords = def.type == "linear"
            ? "/ShadingType 2 /Coords [\(n(num("x1"))) \(n(num("y1"))) \(n(num("x2", 1))) \(n(num("y2")))]"
            : "/ShadingType 3 /Coords [\(n(num("fx", num("cx", 0.5)))) \(n(num("fy", num("cy", 0.5)))) \(n(num("fr"))) \(n(num("cx", 0.5))) \(n(num("cy", 0.5))) \(n(num("r", 0.5)))]"
        writer.shadingDicts["\(writer.pageIndex):\(name)"] = "<< \(coords) /ColorSpace /DeviceRGB /Function \(fn) /Extend [true true] >>"
        return name
    }

    /// Fills the current clip with a paint server (a gradient shading, or a pattern's tiles).
    func fillDef(_ def: VectorPaintDef, _ box: PdfBox?) {
        switch def {
        case let .pattern(p):
            tiles(p)
        case let .gradient(g):
            let name = shading(g)
            content.append("q")
            if g.attrs["gradientUnits"] != .string("userSpaceOnUse"), let box { content.append("\(n(box.w)) 0 0 \(n(box.h)) \(n(box.x)) \(n(box.y)) cm") }
            let t = matrixOf(g.attrs["gradientTransform"]?.stringValue)
            if t != [1, 0, 0, 1, 0, 0] { content.append("\(t.map(n).joined(separator: " ")) cm") }
            content.append("/\(name) sh")
            content.append("Q")
        }
    }

    /// A pattern's tiles, each filled (a gradient tile through its own clip).
    func tiles(_ def: VectorSvgPatternDef) {
        var inner = defs
        for g in def.gradients { inner[g.id] = .gradient(g) }
        for tile in def.tiles {
            let (ops, box) = pathOps(tile.d)
            if tile.fill.hasPrefix("url(#") && tile.fill.hasSuffix(")") && tile.fill.count > 6 {
                guard let g = inner[String(tile.fill.dropFirst(5).dropLast())] else { continue }
                content += ["q", ops, "W n"]
                fillDef(g, box)
                content.append("Q")
            } else {
                guard let c = parseVectorColor(tile.fill) else { continue }
                content.append("q")
                if c[3] < 1 { content.append("/\(gs(c[3], 1)) gs") }
                content += ["\(n(c[0])) \(n(c[1])) \(n(c[2])) rg", ops, "f", "Q"]
            }
        }
    }

    /// Fills path data `d` with `paint` at `alpha` (`evenodd` for the even-odd rule).
    func fill(_ d: String, _ paint: String, _ alpha: Double, _ evenodd: Bool, _ blend: String?) {
        let (ops, box) = pathOps(d)
        content.append("q")
        guard let p = self.paint(paint, false) else {
            content.removeLast()
            return
        }
        let a = alpha * p.alpha
        if a < 1 || (blend.map { !$0.isEmpty && $0 != "normal" } ?? false) { content.append("/\(gs(a, a, blend)) gs") }
        if let def = p.def {
            content += [ops, evenodd ? "W* n" : "W n"]
            fillDef(def, box)
        } else {
            content += [ops, evenodd ? "f*" : "f"]
        }
        content.append("Q")
    }

    /// Strokes path data `d` (a gradient stroke is drawn as solid in its first colour).
    func stroke(_ d: String, _ paint: String, _ width: Double, _ alpha: Double, _ cap: String?, _ join: String?, _ dash: String?, _ blend: String?) {
        let ops = pathOps(d).ops
        content.append("q")
        var p = self.paint(paint, true)
        if let def = p?.def {
            // PDF strokes take one colour; gradients on strokes go through their outline elsewhere.
            let first: String? = switch def {
            case let .pattern(pt): pt.tiles.first?.fill
            case let .gradient(g): g.stops.first?.stopColor
            }
            notes.add("Gradient strokes are drawn in their first colour.")
            p = first.flatMap { $0.isEmpty ? nil : self.paint($0, true) }
        }
        guard let p else {
            content.removeLast()
            return
        }
        let a = alpha * p.alpha
        if a < 1 || (blend.map { !$0.isEmpty && $0 != "normal" } ?? false) { content.append("/\(gs(a, a, blend)) gs") }
        content += ["\(n(width)) w", "\(cap == "round" ? 1 : cap == "square" ? 2 : 0) J", "\(join == "round" ? 1 : join == "bevel" ? 2 : 0) j"]
        let dashes = splitList(dash ?? "").map(\.jsToNumber)
        if !dashes.isEmpty { content.append("[\(dashes.map(n).joined(separator: " "))] 0 d") }
        content += [ops, "S", "Q"]
    }

    /// A stroke drawn in parts (aligned inside / outside, arrowheads, width profiles).
    func strokeParts(_ parts: JSONObject, _ fillD: String, _ paint: String, cap: String?, join: String?, dash: String?, alpha: Double, blend: String?, _ evenodd: Bool) {
        let clip = parts["clip"]?.objectValue
        if let clip {
            content.append("q")
            let shape = pathOps(fillD).ops
            if clip["kind"] == "clip" {
                content += [shape, evenodd ? "W* n" : "W n"]
            } else {
                // Outside: everything in the box but the shape.
                let b = clip["bounds"]
                let num = { (k: String) in b?[k]?.numberValue ?? .nan }
                content += ["\(n(num("x"))) \(n(num("y"))) \(n(num("width"))) \(n(num("height"))) re", shape, "W* n"]
            }
        }
        if let outline = parts["outline"]?.stringValue, !outline.isEmpty { fill(outline, paint, alpha, false, blend) }
        else { stroke(parts["d"]?.stringValue ?? "", paint, parts["width"]?.numberValue ?? .nan, alpha, cap, join, dash, blend) }
        if clip != nil { content.append("Q") }
        for h in parts["heads"]?.arrayValue ?? [] { fill(h.stringValue ?? "", paint, alpha, false, blend) }
    }

    /// One render node (cumulative `alpha` from its groups).
    func node(_ node: JSONObject, _ alpha: Double) {
        if node["kind"] == "text" {
            notes.add("Text without glyph outlines is left out (load fonts so text draws as outlines).")
            return
        }
        if truthy(node["filter"]) { notes.add("Filters (shadows, glows, blurs) are left out.") }
        content.append("q")
        if let t = node["transform"]?.stringValue, !t.isEmpty { content.append("\(matrixOf(t).map(n).joined(separator: " ")) cm") }
        let opacity = node["opacity"]?.numberValue ?? .nan
        let a = alpha * opacity
        if node["kind"] == "group" {
            let children = node["children"]?.arrayValue ?? []
            let blend = node["blendMode"]?.stringValue
            if opacity < 1 && children.count > 1 { notes.add("Group opacity is applied to each object in the group.") }
            if let blend, !blend.isEmpty, blend != "normal" { notes.add("Group blend modes are applied to each object in the group.") }
            if let mask = node["mask"]?.objectValue {
                if mask["type"] == "clip", let clip = mask["clip"]?.arrayValue, !clip.isEmpty {
                    let evenodd = clip.contains { $0["clipRule"] == "evenodd" }
                    content += [clip.map { pathOps($0["d"]?.stringValue ?? "").ops }.joined(separator: "\n"), evenodd ? "W* n" : "W n"]
                } else {
                    notes.add("Opacity masks are left out (the contents are drawn whole).")
                }
            }
            for c in children {
                guard var child = c.objectValue else { continue }
                // A child carries its group's blend mode (PDF has no isolated groups here).
                if let blend, !blend.isEmpty, blend != "normal", !truthy(child["blendMode"]) { child["blendMode"] = .string(blend) }
                self.node(child, a)
            }
        } else {
            path(node, a)
        }
        content.append("Q")
    }

    func path(_ p: JSONObject, _ alpha: Double) {
        let evenodd = p["fillRule"] == "evenodd"
        let layers: [JSONObject]
        if let list = p["layers"]?.arrayValue {
            layers = list.compactMap(\.objectValue)
        } else {
            let fill = JSONObject([("kind", "fill"), ("index", 0), ("fill", p["fill"] ?? .null), ("stroke", "none"), ("strokeWidth", 0), ("opacity", 1)])
            var stroke = JSONObject([("kind", "stroke"), ("index", 0), ("fill", "none")])
            for key in ["stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray"] { if let v = p[key] { stroke[key] = v } }
            stroke["opacity"] = 1
            if let parts = p["strokeParts"] { stroke["strokeParts"] = parts }
            layers = [fill, stroke]
        }
        for l in layers {
            let a = alpha * (l["opacity"]?.numberValue ?? .nan)
            let blend = l["blendMode"]?.stringValue ?? p["blendMode"]?.stringValue
            if l["kind"] == "brushstroke" {
                // Each image drawn over its box (y down: the image's top row at the box's top).
                for im in l["images"]?.arrayValue ?? [] {
                    guard let name = image(im["href"]?.stringValue ?? "") else { continue }
                    let num = { (k: String) in im[k]?.numberValue ?? .nan }
                    content += ["q", "/\(gs(a, a, blend)) gs", "\(n(num("width"))) 0 0 \(n(-num("height"))) \(n(num("x"))) \(n(num("y") + num("height"))) cm", "/\(name) Do", "Q"]
                }
                continue
            }
            let d = p["d"]?.stringValue ?? ""
            if l["kind"] == "fill" {
                let fill = l["fill"]?.stringValue ?? ""
                if fill != "none" { self.fill(d, fill, a, evenodd, blend) }
            } else if let stroke = l["stroke"]?.stringValue, stroke != "none", (l["strokeWidth"]?.numberValue ?? .nan) > 0 {
                let cap = l["strokeLinecap"]?.stringValue
                let join = l["strokeLinejoin"]?.stringValue
                let dash = l["strokeDasharray"]?.stringValue
                if let parts = l["strokeParts"]?.objectValue {
                    strokeParts(parts, d, stroke, cap: cap, join: join, dash: dash, alpha: a, blend: blend, evenodd)
                } else {
                    self.stroke(d, stroke, l["strokeWidth"]!.numberValue!, a, cap, join, dash, blend)
                }
            }
        }
    }
}

/// A PDF string literal (escaped; UTF-16 units outside printable ASCII become `?`).
private func pdfString(_ s: String) -> String {
    var out = "("
    for u in s.utf16 {
        if u == 0x5C || u == 0x28 || u == 0x29 { out += "\\" + String(UnicodeScalar(UInt8(u))) }
        else if u >= 0x20 && u <= 0x7E { out.append(Character(UnicodeScalar(UInt8(u)))) }
        else { out += "?" }
    }
    return out + ")"
}

/**
 * The document as a vector PDF (`vectorDocumentToPdf`): one page of the artboard, or (`pages:
 * "artboards"`) one page per top-level frame, each the frame's size. One document unit is `scale`
 * points.
 */
public func vectorDocumentToPdf(_ docIn: VectorDocument, _ options: VectorPdfOptions = VectorPdfOptions()) throws -> VectorPdfExport {
    var notes = OrderedNotes()
    let doc = resolveVectorLenses(resolveVectorMasterPages(docIn))
    let scale = options.scale ?? 1
    let compress = options.compress != false
    // Master pages are not pages: they show only through the pages that use them.
    let frames = options.pages == "artboards" ? vectorPages(doc.nodes) : []
    if options.pages == "artboards" && frames.isEmpty { notes.add("There are no artboards (top-level frames): the whole drawing is one page.") }
    let docs = frames.isEmpty ? [doc] : frames.map { vectorFrameDocument(doc, $0.id)! }
    let w = PdfWriter()
    let catalog = w.add("")
    let pagesId = w.add("")
    var pageIds: [Int] = []
    for (k, d) in docs.enumerated() {
        w.pageIndex = k
        let scene = try vectorSceneRender(d, idPrefix: "p\(k)-")
        var defs: [String: VectorPaintDef] = [:]
        for def in scene.defs { defs[def.id] = def }
        let page = PdfPage(w, defs, notes)
        let W = d.width * scale
        let H = d.height * scale
        // y down, in document units.
        page.content.append("\(n(scale)) 0 0 \(n(-scale)) 0 \(n(H)) cm")
        if let bg = d.background, !bg.isEmpty, let c = parseVectorColor(bg) {
            page.content += ["\(n(c[0])) \(n(c[1])) \(n(c[2])) rg", "0 0 \(n(d.width)) \(n(d.height)) re", "f"]
        }
        for node in scene.data["nodes"]?.arrayValue ?? [] { if let o = node.objectValue { page.node(o, 1) } }
        notes = page.notes
        let content = w.add(w.stream("", Array(page.content.joined(separator: "\n").utf8), compress))
        let gsEntries = page.states.values.map { name in "/\(name) \(w.add(w.gsDicts["\(k):\(name)"]!)) 0 R" }
        let shEntries = page.shadings.values.map { name in "/\(name) \(w.add(w.shadingDicts["\(k):\(name)"]!)) 0 R" }
        let imEntries = page.images.values.map { name in "/\(name) \(w.imageIds["\(k):\(name)"]!) 0 R" }
        let resources = "<< \(gsEntries.isEmpty ? "" : "/ExtGState << \(gsEntries.joined(separator: " ")) >> ")\(shEntries.isEmpty ? "" : "/Shading << \(shEntries.joined(separator: " ")) >> ")\(imEntries.isEmpty ? "" : "/XObject << \(imEntries.joined(separator: " ")) >>") >>"
        pageIds.append(w.add("<< /Type /Page /Parent \(pagesId) 0 R /MediaBox [0 0 \(n(W)) \(n(H))] /Resources \(resources) /Contents \(content) 0 R >>"))
    }
    w.set(catalog, "<< /Type /Catalog /Pages \(pagesId) 0 R >>")
    w.set(pagesId, "<< /Type /Pages /Kids [\(pageIds.map { "\($0) 0 R" }.joined(separator: " "))] /Count \(pageIds.count) >>")
    let info = w.add("<< /Producer (Pixerate vector editor)\(options.title.flatMap { $0.isEmpty ? nil : " /Title \(pdfString($0))" } ?? "") >>")
    return VectorPdfExport(bytes: w.bytes(catalog, info), pages: pageIds.count, notes: notes.list)
}
