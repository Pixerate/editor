// Portions ported from effectcraft/crates/text/src/path_text.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Text nodes (`vector/text.ts`): layout through the shared text engine (`TextLayout.swift`), glyph
// placement for point, area and path text, vertical text, glyph boxes or outlines, and the pure
// edits the controller and agent commands build on.
//
// Fonts come from one text shaper per process (`setVectorTextShaper`). The default is the metric
// shaper, which the conformance scenarios use; it gives no outlines, so text draws as SVG text and
// its geometry is a box per line fragment (a box per character on a path or in vertical text).
// Node fields stay JSON (`text`, `font`, `runs`, `paragraph`, `frame`, `orientation`) and keep their
// key order. Texts are UTF-16 code units, as in JavaScript.

// MARK: - Shaper

nonisolated(unsafe) private var currentShaper: VectorTextShaper?
nonisolated(unsafe) private var shaperGeneration = 0

/// Sets the text shaper every vector editor lays text out with (nil: back to the metric shaper).
public func setVectorTextShaper(_ shaper: VectorTextShaper?) {
    if shaper === currentShaper { return }
    currentShaper = shaper
    shaperGeneration += 1
}

/// The text shaper in use: the one set, else the metric shaper.
public func getVectorTextShaper() -> VectorTextShaper {
    if let s = currentShaper { return s }
    let s = MetricTextShaper()
    currentShaper = s
    return s
}

/// Bumped whenever the shaper changes.
public func vectorTextShaperGeneration() -> Int { shaperGeneration }

/// Whether the shaper gives glyph outlines (text then draws as paths, and Create Outlines works).
public func vectorTextHasOutlines() -> Bool { getVectorTextShaper().hasOutlines }

/// Families the shaper can draw, when it can tell (always includes the generic families).
public func vectorTextFamilies() -> [String] { getVectorTextShaper().families() ?? ["sans-serif", "serif", "monospace"] }

// MARK: - Strings as UTF-16

extension String {
    /// The string's UTF-16 code units (JavaScript's view of it).
    var u16: [UInt16] { Array(utf16) }
}

/// A string from UTF-16 code units.
func str16<C: Collection>(_ units: C) -> String where C.Element == UInt16 { String(decoding: units, as: UTF16.self) }

/// `s.replace(/\r\n?/g, '\n')`.
func normalizeLineBreaks(_ s: String) -> String {
    s.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
}

private func isJSSpace(_ s: Unicode.Scalar) -> Bool {
    switch s.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
}

// MARK: - Styles and runs

/// `DEFAULT_VECTOR_FONT`.
public let DEFAULT_VECTOR_FONT = JSONObject([("fontFamily", "sans-serif"), ("fontWeight", 400), ("fontSize", 24)])

/// Character style fields, in the order agents see them.
public let VECTOR_CHARACTER_STYLE_KEYS = ["fontFamily", "fontWeight", "italic", "fontSize", "tracking", "leading", "baselineShift", "underline", "strikethrough", "upright"]
/// Paragraph style fields.
public let VECTOR_PARAGRAPH_STYLE_KEYS = ["align", "autoLeading", "firstLineIndent", "startIndent", "endIndent", "spaceBefore", "spaceAfter"]
/// `VECTOR_TEXT_ALIGNS`.
public let VECTOR_TEXT_ALIGNS = ["left", "center", "right", "justify"]
/// `VECTOR_PATH_TEXT_BASELINES`.
public let VECTOR_PATH_TEXT_BASELINES = ["baseline", "ascender", "descender", "center"]

/// A text edit or text input that is not valid (`VectorTextError`).
public struct VectorTextError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// A resolved run (`VectorResolvedRun`): the node's style with the run's fields over it.
public struct VectorResolvedRun: Equatable, Sendable {
    public var start: Int
    public var end: Int
    public var style: JSONObject
    /// The run's own fill when it has one (`.null` is a fill of none).
    public var fill: JSONValue?
}

/// A text node's typed reads.
extension VectorNode {
    /// `text` (empty when absent).
    var textValue: String { self["text"]?.stringValue ?? "" }
    /// `font` (empty when absent).
    var fontStyle: JSONObject { self["font"]?.objectValue ?? JSONObject() }
    /// `runs` as runs (nil when absent).
    var textRuns: [StyledRun]? { self["runs"]?.arrayValue?.compactMap { StyledRun(json: $0) } }
    /// `frame.kind`.
    var textFrameKind: String { frame?["kind"]?.stringValue ?? "point" }
}

/// Runs as JSON.
func runsJSON(_ runs: [StyledRun]) -> JSONValue { .array(runs.map(\.json)) }

/**
 * Runs fitted to a text of `length` (`fitVectorTextRuns`): cut at its end, and text past the last
 * run in the node's own style (an empty override). Neighbours with equal styles merge.
 */
public func fitVectorTextRuns(_ runs: [StyledRun], _ length: Double) -> [StyledRun] {
    var out: [StyledRun] = []
    var left = length
    for r in runs {
        if left <= 0 { break }
        let n = JS.min(JS.max(0, Foundation.floor(r.length)), left)
        if n > 0 { out.append(StyledRun(length: n, style: r.style)) }
        left -= n
    }
    if left > 0 { out.append(StyledRun(length: left, style: JSONObject())) }
    return fitRuns(out, length, JSONObject())
}

/// The node's runs fitted to its text, each with the full style it draws in (`vectorTextRuns`).
public func vectorTextRuns(_ node: VectorNode) -> [VectorResolvedRun] {
    let runs = fitVectorTextRuns(node.textRuns ?? [], Double(node.textValue.utf16.count))
    var out: [VectorResolvedRun] = []
    var at = 0
    let font = node.fontStyle
    for r in runs {
        var style = font
        for (k, v) in r.style where k != "fill" { style[k] = v }
        let n = Int(r.length)
        out.append(VectorResolvedRun(start: at, end: at + n, style: style, fill: r.style["fill"]))
        at += n
    }
    if out.isEmpty { out.append(VectorResolvedRun(start: 0, end: 0, style: font, fill: nil)) }
    return out
}

/// The style at code unit `index` (the run holding it; past the end, the last run; `vectorTextStyleAt`).
public func vectorTextStyleAt(_ node: VectorNode, _ index: Int) -> VectorResolvedRun {
    let runs = vectorTextRuns(node)
    return runs.first { index >= $0.start && index < $0.end } ?? runs[runs.count - 1]
}

/// `paintKey`: "" for no paint, else its JSON.
private func paintKey(_ paint: JSONValue?) -> String { paint.map { $0.stringified() } ?? "" }

// MARK: - Path measure (text on a path)

/// A subpath flattened and measured by arc length (`VectorPathMeasure`).
public struct VectorPathMeasure: Equatable, Sendable {
    public var points: [Vec2]
    /// Cumulative length at each point.
    public var lengths: [Double]
    public var closed: Bool
    public var length: Double
}

private func flattenCommands(_ path: BezierPath) -> (points: [Vec2], closed: Bool) {
    var pts: [Vec2] = []
    var closed = false
    var cur = Vec2(0, 0)
    var started = false
    func push(_ p: Vec2) {
        if let last = pts.last, !(JS.hypot(last.x - p.x, last.y - p.y) > 1e-9) { return }
        pts.append(p)
    }
    loop: for c in path {
        switch c {
        case let .M(x, y):
            if started { break loop }
            started = true
            cur = Vec2(x, y)
            push(cur)
        case let .L(x, y):
            cur = Vec2(x, y)
            push(cur)
        case .Q, .C:
            let p0 = cur
            var ctrl: [Vec2]
            let p3: Vec2
            var q1 = Vec2(0, 0), c1 = Vec2(0, 0), c2 = Vec2(0, 0)
            if case let .Q(x1, y1, x, y) = c {
                q1 = Vec2(x1, y1)
                ctrl = [q1]
                p3 = Vec2(x, y)
            } else if case let .C(x1, y1, x2, y2, x, y) = c {
                c1 = Vec2(x1, y1)
                c2 = Vec2(x2, y2)
                ctrl = [c1, c2]
                p3 = Vec2(x, y)
            } else {
                continue
            }
            let all = [p0] + ctrl + [p3]
            var chord = 0.0
            for i in all.indices where i > 0 { chord = chord + JS.hypot(all[i].x - all[i - 1].x, all[i].y - all[i - 1].y) }
            let n = Swift.max(4, Swift.min(256, Int(Foundation.ceil(chord / 2))))
            for i in 1 ... n {
                let t = Double(i) / Double(n)
                let u = 1 - t
                if case .Q = c {
                    push(Vec2(u * u * p0.x + 2 * u * t * q1.x + t * t * p3.x, u * u * p0.y + 2 * u * t * q1.y + t * t * p3.y))
                } else {
                    push(Vec2(u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
                              u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y))
                }
            }
            cur = p3
        case .Z:
            closed = true
            if pts.count > 1 { push(pts[0]) }
            break loop
        case .A:
            continue
        }
    }
    return (pts, closed)
}

/// Measures a path's first subpath by arc length, reversed when `reverse` (`measureVectorPath`).
public func measureVectorPath(_ path: BezierPath, reverse: Bool = false) -> VectorPathMeasure {
    var (points, closed) = flattenCommands(path)
    if reverse { points.reverse() }
    var lengths: [Double] = []
    var acc = 0.0
    for (i, p) in points.enumerated() {
        if i > 0 { acc += JS.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) }
        lengths.append(acc)
    }
    return VectorPathMeasure(points: points, lengths: lengths, closed: closed, length: acc)
}

/// Point and unit tangent at arc length `s` (`vectorPathAt`): closed paths wrap, open ones continue
/// straight along their end tangents.
public func vectorPathAt(_ m: VectorPathMeasure, _ sIn: Double) -> (point: Vec2, tangent: Vec2) {
    let pts = m.points
    if pts.count < 2 || m.length <= 1e-9 { return (pts.first ?? Vec2(0, 0), Vec2(1, 0)) }
    var s = sIn
    if m.closed { s = (s.truncatingRemainder(dividingBy: m.length) + m.length).truncatingRemainder(dividingBy: m.length) }
    var lo = 0
    var hi = pts.count - 1
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1
        if m.lengths[mid] <= s { lo = mid } else { hi = mid }
    }
    let a = pts[lo]
    let b = pts[lo + 1]
    let seg = m.lengths[lo + 1] - m.lengths[lo]
    let tangent = seg > 0 ? Vec2((b.x - a.x) / seg, (b.y - a.y) / seg) : Vec2(1, 0)
    let d = s - m.lengths[lo]
    return (Vec2(a.x + tangent.x * d, a.y + tangent.y * d), tangent)
}

/// Arc-length positions for character pivots along a path (`vectorPathTextPositions`).
public func vectorPathTextPositions(_ xs: [Double], _ line: (Double, Double), _ align: String, _ length: Double, _ start: Double, _ end: Double) -> [Double] {
    if xs.isEmpty { return [] }
    if align == "justify" {
        let a = start
        let b = length - end
        let x0 = xs[0]
        let x1 = xs[xs.count - 1]
        if abs(x1 - x0) < 1e-9 { return xs.map { _ in a } }
        return xs.map { a + ((b - a) * ($0 - x0)) / (x1 - x0) }
    }
    if align == "center" {
        let mid = (start + length - end) / 2
        let c = (line.0 + line.1) / 2
        return xs.map { mid + $0 - c }
    }
    if align == "right" { return xs.map { length - end - (line.1 - $0) } }
    return xs.map { start + $0 - line.0 }
}

// MARK: - Layout

/// One placed character, in the node's own space (`VectorTextGlyph`).
public struct VectorTextGlyph: Equatable, Sendable {
    public var index: Int
    /// The character (two code units for a surrogate pair).
    public var char: [UInt16]
    /// Its origin: the start of the character on the baseline.
    public var x: Double
    public var y: Double
    /// Turn in degrees, clockwise on screen.
    public var angle: Double
    public var advance: Double
    public var ascent: Double
    public var descent: Double
    /// Index into `fragments`.
    public var fragment: Int
}

/// A run of glyphs in one style on one line (`VectorTextFragment`).
public struct VectorTextFragment: Equatable, Sendable {
    public var style: JSONObject
    public var font: TextFont
    public var fill: JSONValue?
    public var from: Int
    public var to: Int
    public var line: Int
    /// The shared engine's fragment and line (point and area text).
    public var laid: (fragment: LaidFragment, line: LaidLine)?

    public static func == (a: VectorTextFragment, b: VectorTextFragment) -> Bool {
        a.style == b.style && a.font == b.font && a.fill == b.fill && a.from == b.from && a.to == b.to && a.line == b.line && a.laid?.fragment == b.laid?.fragment && a.laid?.line == b.laid?.line
    }
}

/// A line of a text node (`VectorTextLayout.lines`).
public struct VectorTextLine: Equatable, Sendable {
    public var start: Int
    public var end: Int
    public var baseline: Double
    public var x: Double
    public var width: Double
}

/// A laid-out text node (`VectorTextLayout`).
public struct VectorTextLayout: Equatable, Sendable {
    public var shaper: String
    public var glyphs: [VectorTextGlyph]
    public var fragments: [VectorTextFragment]
    public var lines: [VectorTextLine]
    /// Where text space starts in the node: the frame's origin.
    public var origin: Vec2
    /// The shared layout in text space.
    public var text: TextLayout
    /// Bounds of the glyph boxes (or the frame box of area text), node space; nil when empty.
    public var bounds: VectorBounds?
    public var overflow: Bool
    public var missingFonts: [String]
}

/// The node as the shared engine's text block (`textBlock`).
private func textBlock(_ node: VectorNode) -> TextBlock {
    let runs = vectorTextRuns(node)
    var keys: [String] = []
    let frame = node.frame ?? JSONObject()
    let kind = frame["kind"]?.stringValue
    let text = kind == "path" ? node.textValue.replacingOccurrences(of: "\n", with: " ") : node.textValue
    let units = text.u16
    let styled = runs.map { r -> StyledRun in
        let k = paintKey(r.fill)
        var i = keys.firstIndex(of: k) ?? -1
        if i < 0 {
            keys.append(k)
            i = keys.count - 1
        }
        // `color` keeps runs of different fills apart (layout does not draw).
        var style = r.style
        style["color"] = .string("#\(i)")
        return StyledRun(length: Double(r.end - r.start), style: style)
    }
    var paragraph = node["paragraph"]?.objectValue ?? JSONObject()
    if kind == "path" { paragraph["align"] = "left" }
    let box: (width: Double, height: Double)? = kind == "area" ? (JS.max(0, frame["width"]?.numberValue ?? .nan), JS.max(0, frame["height"]?.numberValue ?? .nan)) : nil
    return TextBlock(text: units, runs: styled, paragraphs: [StyledRun(length: Double(units.count), style: paragraph)], box: box, vertical: node["orientation"] == "vertical" && kind != "path")
}

/// Code units of the character at `i` (2 for a surrogate pair; `charAt`).
private func charAt(_ text: [UInt16], _ i: Int) -> [UInt16] {
    isHighSurrogate(text[i]) && i + 1 < text.count ? [text[i], text[i + 1]] : [text[i]]
}

/// Lays out a text node with the current shaper (`layoutVectorText`; not cached).
public func layoutVectorText(_ node: VectorNode) -> VectorTextLayout {
    computeVectorTextLayout(node, getVectorTextShaper())
}

private func computeVectorTextLayout(_ node: VectorNode, _ shaper: VectorTextShaper) -> VectorTextLayout {
    let block = textBlock(node)
    let runs = vectorTextRuns(node)
    let text = layoutText(block, shaper)
    let frame = node.frame ?? JSONObject()
    let kind = frame["kind"]?.stringValue ?? "point"
    let origin = kind == "path" ? Vec2(0, 0) : Vec2(frame["x"]?.numberValue ?? .nan, frame["y"]?.numberValue ?? .nan)
    var glyphs: [VectorTextGlyph] = []
    var fragments: [VectorTextFragment] = []
    var lines: [VectorTextLine] = []
    var overflow = false
    func fillOf(_ f: LaidFragment) -> JSONValue? { runs.first { f.start >= $0.start && f.start < $0.end }?.fill }
    func styleOf(_ f: LaidFragment) -> JSONObject {
        var s = f.style
        for k in ["color", "opacity", "postScriptName"] { remove(&s, k) }
        return s
    }
    if kind != "path" {
        for (li, l) in text.lines.enumerated() {
            // Lines stack across the box: down its height, or (vertical columns) leftwards across its width.
            if kind == "area" && li > 0 && l.baseline + l.descent > (l.matrix != nil ? frame["width"]?.numberValue ?? .nan : frame["height"]?.numberValue ?? .nan) + 1e-6 {
                overflow = true
                continue
            }
            if l.matrix != nil {
                let top = lineToTextSpace(text, Vec2(l.x, l.baseline))
                lines.append(VectorTextLine(start: l.start, end: l.end, baseline: origin.x + top.x, x: origin.y + top.y, width: l.width))
            } else {
                lines.append(VectorTextLine(start: l.start, end: l.end, baseline: origin.y + l.baseline, x: origin.x + l.x, width: l.width))
            }
            for f in l.fragments {
                let from = glyphs.count
                if let gs = f.glyphs {
                    // Vertical text: each character as the engine places it, upright or turned.
                    for g in gs {
                        glyphs.append(VectorTextGlyph(index: g.index, char: Array(block.text[g.index ..< Swift.min(g.index + g.length, block.text.count)]), x: origin.x + g.x, y: origin.y + g.y,
                                                      angle: g.angle, advance: g.advance, ascent: g.ascent, descent: g.descent, fragment: fragments.count))
                    }
                    fragments.append(VectorTextFragment(style: styleOf(f), font: f.font, fill: fillOf(f), from: from, to: glyphs.count, line: lines.count - 1, laid: (f, l)))
                    continue
                }
                for k in 0 ..< (f.end - f.start) {
                    let index = f.start + k
                    let lo = block.text[index]
                    if isLowSurrogate(lo) && k > 0 {
                        // The low half of a pair: its advance joins the high half's glyph.
                        if !glyphs.isEmpty { glyphs[glyphs.count - 1].advance += f.carets[k + 1] - f.carets[k] }
                        continue
                    }
                    glyphs.append(VectorTextGlyph(index: index, char: charAt(block.text, index), x: origin.x + f.x + f.carets[k], y: origin.y + f.y, angle: 0, advance: f.carets[k + 1] - f.carets[k],
                                                  ascent: l.ascent, descent: l.descent, fragment: fragments.count))
                }
                fragments.append(VectorTextFragment(style: styleOf(f), font: f.font, fill: fillOf(f), from: from, to: glyphs.count, line: lines.count - 1, laid: (f, l)))
            }
        }
    } else {
        let line = text.lines.first
        let measure = measureVectorPath(subpathPath(frame["path"]), reverse: truthy(frame["flip"]))
        let align = node["paragraph"]?["align"]?.stringValue ?? "left"
        let start = JS.max(0, frame["start"]?.numberValue ?? 0)
        let end = JS.max(0, frame["end"]?.numberValue ?? 0)
        let upright = frame["orientation"] == "upright"
        let baselineOffset = pathBaselineOffset(frame["baseline"]?.stringValue ?? "baseline", line?.ascent ?? 0, line?.descent ?? 0)
        if let line {
            let chars = line.chars.filter { c in
                let lo = block.text[c.index]
                return !(isLowSurrogate(lo) && c.index > 0 && isHighSurrogate(block.text[c.index - 1]))
            }
            func advanceOf(_ c: LaidChar) -> Double {
                let pair = charAt(block.text, c.index).count == 2
                let low = pair ? line.chars.first { $0.index == c.index + 1 } : nil
                return c.advance + (low?.advance ?? 0)
            }
            let pivots = chars.map { $0.x + advanceOf($0) / 2 }
            let positions = vectorPathTextPositions(pivots, (line.x, line.x + line.width), align, measure.length, start, end)
            let limit = measure.length - end
            lines.append(VectorTextLine(start: line.start, end: line.end, baseline: 0, x: 0, width: line.width))
            for f in line.fragments {
                let from = glyphs.count
                let shift = f.y - line.baseline
                for (k, c) in chars.enumerated() {
                    if c.index < f.start || c.index >= f.end { continue }
                    let s = positions[k]
                    let adv = advanceOf(c)
                    if s - adv / 2 < start - 1e-6 || s + adv / 2 > limit + 1e-6 {
                        if !isTextSpace(block.text[c.index]) { overflow = true }
                        continue
                    }
                    let (point, tangent) = vectorPathAt(measure, s)
                    let t = upright ? Vec2(1, 0) : tangent
                    let n = upright ? Vec2(0, 1) : Vec2(-tangent.y, tangent.x)
                    let off = baselineOffset + shift
                    glyphs.append(VectorTextGlyph(index: c.index, char: charAt(block.text, c.index), x: point.x + n.x * off - (t.x * adv) / 2, y: point.y + n.y * off - (t.y * adv) / 2,
                                                  angle: upright ? 0 : (JS.atan2(tangent.y, tangent.x) * 180) / Double.pi, advance: adv, ascent: line.ascent, descent: line.descent, fragment: fragments.count))
                }
                fragments.append(VectorTextFragment(style: styleOf(f), font: f.font, fill: fillOf(f), from: from, to: glyphs.count, line: 0, laid: nil))
            }
        }
    }
    var bounds: VectorBounds?
    if kind == "area" {
        bounds = VectorBounds(x: frame["x"]?.numberValue ?? .nan, y: frame["y"]?.numberValue ?? .nan, width: JS.max(0, frame["width"]?.numberValue ?? .nan), height: JS.max(0, frame["height"]?.numberValue ?? .nan))
    } else {
        var x0 = Double.infinity
        var y0 = Double.infinity
        var x1 = -Double.infinity
        var y1 = -Double.infinity
        for g in glyphs {
            for p in glyphBox(g) {
                x0 = JS.min(x0, p.x)
                y0 = JS.min(y0, p.y)
                x1 = JS.max(x1, p.x)
                y1 = JS.max(y1, p.y)
            }
        }
        if x0 < .infinity {
            bounds = VectorBounds(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
        } else if kind == "point" {
            // Empty point text still has a place: a zero-width line at its origin.
            let l = text.lines.first
            bounds = VectorBounds(x: origin.x, y: origin.y - (l?.ascent ?? 0), width: 0, height: (l?.ascent ?? 0) + (l?.descent ?? 0))
        }
    }
    return VectorTextLayout(shaper: shaper.id, glyphs: glyphs, fragments: fragments, lines: lines, origin: origin, text: text, bounds: bounds, overflow: overflow, missingFonts: text.missingFonts)
}

private func pathBaselineOffset(_ baseline: String, _ ascent: Double, _ descent: Double) -> Double {
    switch baseline {
    case "ascender": ascent
    case "descender": -descent
    case "center": (ascent - descent) / 2
    default: 0
    }
}

/// The anchors of a subpath (JSON) as a Bézier path (no live corners: text follows the stored path; `subpathPath`).
func subpathPath(_ sp: JSONValue?) -> BezierPath {
    let a = sp?["anchors"]?.arrayValue ?? []
    var out: BezierPath = []
    if a.isEmpty { return out }
    func xy(_ v: JSONValue?) -> Vec2 { Vec2(v?["x"]?.numberValue ?? .nan, v?["y"]?.numberValue ?? .nan) }
    out.append(.M(x: xy(a[0]).x, y: xy(a[0]).y))
    func seg(_ p: JSONValue, _ q: JSONValue) {
        if truthy(p["out"]) || truthy(q["in"]) {
            let c1 = truthy(p["out"]) ? xy(p["out"]) : xy(p)
            let c2 = truthy(q["in"]) ? xy(q["in"]) : xy(q)
            out.append(.C(x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: xy(q).x, y: xy(q).y))
        } else {
            out.append(.L(x: xy(q).x, y: xy(q).y))
        }
    }
    for i in 1 ..< a.count { seg(a[i - 1], a[i]) }
    if truthy(sp?["closed"]) && a.count > 1 {
        seg(a[a.count - 1], a[0])
        out.append(.Z)
    }
    return out
}

/// The four corners of a glyph's box (origin, advance, ascent to descent), turned by its angle (`glyphBox`).
public func glyphBox(_ g: VectorTextGlyph) -> [Vec2] {
    let r = (g.angle * Double.pi) / 180
    let t = Vec2(JS.cos(r), JS.sin(r))
    let n = Vec2(-t.y, t.x)
    func at(_ u: Double, _ v: Double) -> Vec2 { Vec2(g.x + t.x * u + n.x * v, g.y + t.y * u + n.y * v) }
    return [at(0, -g.ascent), at(g.advance, -g.ascent), at(g.advance, g.descent), at(0, g.descent)]
}

// MARK: - Outlines

/// The text as paths in the node's own space, one per fill (`VectorTextPaths`).
public struct VectorTextPaths: Sendable {
    /// `fill`: a run's own fill, or nil for the node's paint.
    public var parts: [(fill: JSONValue?, path: BezierPath)]
    /// Whether these are glyph outlines (false: glyph boxes).
    public var outlines: Bool
}

private func polygon(_ pts: [Vec2]) -> BezierPath {
    [.M(x: pts[0].x, y: pts[0].y)] + pts.dropFirst().map { .L(x: $0.x, y: $0.y) } + [.Z]
}

/**
 * What a text node draws as geometry (`vectorTextPaths`): its glyph outlines (plus underline and
 * strike-through bars) with an outline shaper, else a box per glyph (ascent to descent), which
 * bounds, hit-testing and snapping use.
 */
public func vectorTextPaths(_ node: VectorNode) -> VectorTextPaths {
    let shaper = getVectorTextShaper()
    let layout = layoutVectorText(node)
    let outlines = shaper.hasOutlines
    var keys: [String] = []
    var parts: [(fill: JSONValue?, path: BezierPath)] = []
    func partFor(_ fill: JSONValue?) -> Int {
        let k = paintKey(fill)
        if let i = keys.firstIndex(of: k) { return i }
        keys.append(k)
        parts.append((fill, []))
        return parts.count - 1
    }
    let kind = node.textFrameKind
    let blockText = (kind == "path" ? node.textValue.replacingOccurrences(of: "\n", with: " ") : node.textValue).u16
    for f in layout.fragments {
        let out = partFor(f.fill)
        let glyphs = Array(layout.glyphs[f.from ..< f.to])
        guard let first = glyphs.first, let last = glyphs.last else { continue }
        if !outlines {
            if kind == "path" || layout.text.orientation == "vertical" {
                for g in glyphs where !isTextSpace(g.char) { parts[out].path += polygon(glyphBox(g)) }
            } else {
                parts[out].path += polygon([Vec2(first.x, first.y - first.ascent), Vec2(last.x + last.advance, first.y - first.ascent), Vec2(last.x + last.advance, first.y + first.descent), Vec2(first.x, first.y + first.descent)])
            }
            continue
        }
        if kind != "path" {
            // Point and area text: the shared engine's fragment outline, moved to the frame.
            guard let laid = f.laid else { continue }
            var path = textFragmentOutline(shaper, blockText, laid.fragment)
            for r in textDecorations(laid.fragment, laid.line) { path += textRectPath(r) }
            parts[out].path += layout.origin.x != 0 || layout.origin.y != 0 ? transformBezierPath(.commands(path), (1, 0, 0, 1, layout.origin.x, layout.origin.y)) : path
            continue
        }
        for g in glyphs where !isTextSpace(g.char) {
            let glyph = shaper.outline(g.char, f.font, x: 0, y: 0, vertical: false) ?? []
            let r = (g.angle * Double.pi) / 180
            let c = JS.cos(r)
            let s = JS.sin(r)
            parts[out].path += transformBezierPath(.commands(glyph), (c, s, -s, c, g.x, g.y))
        }
        // Decorations along a path: a bar under each glyph.
        if f.style.flag("underline") || f.style.flag("strikethrough") {
            let t = JS.max(1, f.style.fontSize / 15)
            for g in glyphs {
                var bars: [(Double, Double)] = []
                if f.style.flag("underline") { bars.append((JS.max(t, g.descent * 0.35), t)) }
                if f.style.flag("strikethrough") { bars.append((-g.ascent * 0.3 - t / 2, t)) }
                for (v, h) in bars {
                    var bar = g
                    bar.ascent = -v
                    bar.descent = v + h
                    parts[out].path += polygon(glyphBox(bar))
                }
            }
        }
    }
    return VectorTextPaths(parts: parts.filter { !$0.path.isEmpty }, outlines: outlines)
}

/// Members of a text node that are not path style (`vectorTextPaintSource` drops them).
private let TEXT_FIELDS: Set<String> = ["type", "text", "font", "runs", "paragraph", "frame", "orientation"]

/**
 * The style a text node paints with as a path node (`vectorTextPaintSource`): its paint stacks,
 * stroke settings and fill rule, with `fill` replacing the top fill's paint when given (nil: none
 * given; `.null`: a fill of none).
 */
public func vectorTextPaintSource(_ node: VectorNode, _ fill: JSONValue? = nil, _ subpaths: [VectorSubpath] = []) -> VectorNode {
    var props = JSONObject()
    for k in node.keys where !TEXT_FIELDS.contains(k) { props[k] = node[k] }
    props["type"] = "path"
    props["subpaths"] = .null
    props["fillRule"] = "nonzero"
    var out = VectorNode(props: props, subpaths: subpaths)
    guard let fill else { return out }
    if let fills = out["fills"]?.arrayValue, !fills.isEmpty {
        var copy = fills
        if var top = copy[copy.count - 1].objectValue {
            top["paint"] = fill
            copy[copy.count - 1] = .object(top)
        }
        out["fills"] = .array(copy)
        out["fill"] = fill
        return out
    }
    out["fill"] = fill
    return out
}

// MARK: - Carets and hit testing (editing)

/// A caret as a segment from the top of its line to the bottom, node space (`VectorTextCaret`).
public struct VectorTextCaret: Equatable, Sendable {
    public var top: Vec2
    public var bottom: Vec2
    public var line: Int
}

/// The caret before code unit `index` (after the last character at the end; `vectorTextCaret`).
public func vectorTextCaret(_ node: VectorNode, _ index: Int) -> VectorTextCaret {
    let layout = layoutVectorText(node)
    let glyphs = layout.glyphs
    func at(_ g: VectorTextGlyph, _ u: Double) -> VectorTextCaret {
        let r = (g.angle * Double.pi) / 180
        let t = Vec2(JS.cos(r), JS.sin(r))
        let n = Vec2(-t.y, t.x)
        let o = Vec2(g.x + t.x * u, g.y + t.y * u)
        let line = g.fragment < layout.fragments.count ? layout.fragments[g.fragment].line : 0
        return VectorTextCaret(top: Vec2(o.x - n.x * g.ascent, o.y - n.y * g.ascent), bottom: Vec2(o.x + n.x * g.descent, o.y + n.y * g.descent), line: line)
    }
    if node.textFrameKind != "path" {
        // Point and area text: the shared engine's caret (it knows empty lines and line ends).
        let c = caretAt(layout.text, index)
        let o = layout.origin
        return VectorTextCaret(top: Vec2(o.x + c.from.x, o.y + c.from.y), bottom: Vec2(o.x + c.to.x, o.y + c.to.y), line: c.line)
    }
    let g = glyphs.first { $0.index >= index }
    if let g, g.index == index { return at(g, 0) }
    if let prev = glyphs.last(where: { $0.index < index }) { return at(prev, prev.advance) }
    if let g { return at(g, 0) }
    // No glyphs: the start of the path.
    let frame = node.frame ?? JSONObject()
    let m = measureVectorPath(subpathPath(frame["path"]), reverse: truthy(frame["flip"]))
    let (point, tangent) = vectorPathAt(m, frame["start"]?.numberValue ?? 0)
    let size = node.fontStyle.fontSize
    let n = Vec2(-tangent.y, tangent.x)
    return VectorTextCaret(top: Vec2(point.x - n.x * size * 0.8, point.y - n.y * size * 0.8), bottom: Vec2(point.x + n.x * size * 0.2, point.y + n.y * size * 0.2), line: 0)
}

/// The text index nearest a node-space point (for clicks; `vectorTextIndexAt`).
public func vectorTextIndexAt(_ node: VectorNode, _ p: Vec2) -> Int {
    let layout = layoutVectorText(node)
    if node.textFrameKind != "path" { return textIndexAt(layout.text, Vec2(p.x - layout.origin.x, p.y - layout.origin.y)) }
    var best = node.textValue.utf16.count
    var bestD = Double.infinity
    for g in layout.glyphs {
        let r = (g.angle * Double.pi) / 180
        let t = Vec2(JS.cos(r), JS.sin(r))
        let dx = p.x - g.x
        let dy = p.y - g.y
        let u = dx * t.x + dy * t.y
        let v = -dx * t.y + dy * t.x
        let du = u < 0 ? -u : u > g.advance ? u - g.advance : 0
        let dv = v < -g.ascent ? -g.ascent - v : v > g.descent ? v - g.descent : 0
        let d = JS.hypot(du, dv)
        if d < bestD {
            bestD = d
            best = u < g.advance / 2 ? g.index : g.index + g.char.count
        }
    }
    return best
}

/// Quads (node space) covering the glyphs of [start, end), one per line for point and area text (`vectorTextSelectionQuads`).
public func vectorTextSelectionQuads(_ node: VectorNode, _ start: Int, _ end: Int) -> [[Vec2]] {
    if end <= start { return [] }
    let layout = layoutVectorText(node)
    let picked = layout.glyphs.filter { $0.index >= start && $0.index < end }
    if node.textFrameKind == "path" { return picked.map(glyphBox) }
    if layout.text.orientation == "vertical" {
        let o = layout.origin
        return textSelectionQuads(layout.text, start, end).map { q in q.map { Vec2(o.x + $0.x, o.y + $0.y) } }
    }
    var order: [Int] = []
    var byLine: [Int: [VectorTextGlyph]] = [:]
    for g in picked {
        let line = layout.fragments[g.fragment].line
        if byLine[line] == nil { order.append(line) }
        byLine[line, default: []].append(g)
    }
    return order.map { line in
        let gs = byLine[line]!
        var a = gs[0]
        let b = gs[gs.count - 1]
        a.advance = b.x + b.advance - a.x
        return glyphBox(a)
    }
}

// MARK: - Validation

private func isNum(_ v: JSONValue?) -> Bool { v?.numberValue?.isFinite ?? false }

/// `JSON.stringify(v)` for messages (`undefined` when absent).
private func shown(_ v: JSONValue?) -> String { v?.stringified() ?? "undefined" }

private func num(_ v: JSONValue?, _ path: String, _ min: Double, _ max: Double) throws -> Double {
    guard let n = v?.numberValue, n.isFinite, n >= min, n <= max else {
        throw VectorTextError("\(path) must be a number from \(jsString(min)) to \(jsString(max)), got \(shown(v)).")
    }
    return n
}

/// A character style patch validated (`patchVectorCharacterStyle`; `null` clears an optional field).
public func patchVectorCharacterStyle(_ base: JSONObject, _ patch: JSONObject, _ path: String = "style") throws -> JSONObject {
    var out = base
    for (k, v) in patch {
        switch k {
        case "fontFamily":
            guard let s = v.stringValue, !s.jsTrimmed.isEmpty else { throw VectorTextError("\(path).fontFamily must be a font family name.") }
            out["fontFamily"] = .string(s.jsTrimmed)
        case "fontWeight":
            let w: JSONValue = v == "normal" ? 400 : v == "bold" ? 700 : v
            out["fontWeight"] = .number(JS.round(try num(w, "\(path).fontWeight", 1, 1000)))
        case "fontSize":
            out["fontSize"] = .number(try num(v, "\(path).fontSize", 0.5, 5000))
        case "italic", "underline", "strikethrough", "upright":
            if v.boolValue == nil && v != .null { throw VectorTextError("\(path).\(k) must be true or false.") }
            if truthy(v) { out[k] = true } else { remove(&out, k) }
        case "tracking", "leading", "baselineShift":
            if v == .null {
                remove(&out, k)
                break
            }
            let (min, max): (Double, Double) = k == "tracking" ? (-1000, 10000) : k == "leading" ? (0, 10000) : (-5000, 5000)
            let value = try num(v, "\(path).\(k)", min, max)
            if k != "leading" && value == 0 { remove(&out, k) } else { out[k] = .number(value) }
        default:
            throw VectorTextError("\(path).\(k) is not a character style field; use \(VECTOR_CHARACTER_STYLE_KEYS.joined(separator: ", ")) (and fill for a range's colour).")
        }
    }
    return out
}

/// A paragraph style patch validated (`patchVectorParagraphStyle`; `null` clears a field).
public func patchVectorParagraphStyle(_ base: JSONObject, _ patch: JSONObject, _ path: String = "paragraph") throws -> JSONObject {
    var out = base
    for (k, v) in patch {
        if k == "align" {
            if v == .null || v == "left" { remove(&out, "align") }
            else if !(v.stringValue.map(VECTOR_TEXT_ALIGNS.contains) ?? false) { throw VectorTextError("\(path).align must be one of \(VECTOR_TEXT_ALIGNS.joined(separator: ", ")).") }
            else { out["align"] = v }
        } else if VECTOR_PARAGRAPH_STYLE_KEYS.contains(k) {
            if v == .null {
                remove(&out, k)
                continue
            }
            let value = k == "autoLeading" ? try num(v, "\(path).\(k)", 0.1, 10) : try num(v, "\(path).\(k)", -10000, 10000)
            if (k == "autoLeading" && value == DEFAULT_AUTO_LEADING) || (k != "autoLeading" && value == 0) { remove(&out, k) } else { out[k] = .number(value) }
        } else {
            throw VectorTextError("\(path).\(k) is not a paragraph style field; use \(VECTOR_PARAGRAPH_STYLE_KEYS.joined(separator: ", ")).")
        }
    }
    return out
}

/// A frame from loose input, validated (`sanitizeVectorTextFrame`).
public func sanitizeVectorTextFrame(_ value: JSONValue?, _ path: String = "frame") throws -> JSONObject {
    guard let value, value != .null, value.objectValue != nil || value.arrayValue != nil else { throw VectorTextError("\(path) must be an object with kind point, area or path.") }
    let f = value.objectValue ?? JSONObject()
    let kind = f["kind"]
    if kind == "point" { return JSONObject([("kind", "point"), ("x", .number(try num(f["x"], "\(path).x", -1e7, 1e7))), ("y", .number(try num(f["y"], "\(path).y", -1e7, 1e7)))]) }
    if kind == "area" {
        return JSONObject([
            ("kind", "area"), ("x", .number(try num(f["x"], "\(path).x", -1e7, 1e7))), ("y", .number(try num(f["y"], "\(path).y", -1e7, 1e7))),
            ("width", .number(try num(f["width"], "\(path).width", 0, 1e7))), ("height", .number(try num(f["height"], "\(path).height", 0, 1e7))),
        ])
    }
    if kind == "path" {
        let sp = f["path"]
        guard let anchors = sp?["anchors"]?.arrayValue, anchors.count >= 2, anchors.allSatisfy({ isNum($0["x"]) && isNum($0["y"]) }) else {
            throw VectorTextError("\(path).path must be a subpath with at least two anchors.")
        }
        var out = JSONObject([("kind", "path"), ("path", .object(JSONObject([("closed", .bool(truthy(sp?["closed"]))), ("anchors", .array(anchors))])))])
        if let s = f["start"], s != 0 { out["start"] = .number(try num(s, "\(path).start", 0, 1e7)) }
        if let e = f["end"], e != 0 { out["end"] = .number(try num(e, "\(path).end", 0, 1e7)) }
        if truthy(f["flip"]) { out["flip"] = true }
        if let o = f["orientation"], o != "rotate" {
            if o != "upright" { throw VectorTextError("\(path).orientation must be rotate or upright.") }
            out["orientation"] = "upright"
        }
        if let b = f["baseline"], b != "baseline" {
            guard let s = b.stringValue, VECTOR_PATH_TEXT_BASELINES.contains(s) else { throw VectorTextError("\(path).baseline must be one of \(VECTOR_PATH_TEXT_BASELINES.joined(separator: ", ")).") }
            out["baseline"] = b
        }
        return out
    }
    throw VectorTextError("\(path).kind must be point, area or path, got \(shown(kind)).")
}

/// Normalised runs (`normalizeVectorTextRuns`): fitted to the text, empty overrides dropped, nil when there is one plain style.
public func normalizeVectorTextRuns(_ text: String, _ runs: [StyledRun]?) -> [StyledRun]? {
    guard let runs, !runs.isEmpty else { return nil }
    let cleaned = fitVectorTextRuns(runs, Double(text.utf16.count))
    if cleaned.allSatisfy({ $0.style.isEmpty }) { return nil }
    return cleaned
}

/// An orientation from loose input (`vectorTextOrientation`): true for `vertical`, false for `horizontal` (the default).
public func vectorTextOrientation(_ value: JSONValue?, _ path: String = "orientation") throws -> Bool {
    guard let value, value != .null, value != "horizontal" else { return false }
    if value != "vertical" { throw VectorTextError("\(path) must be horizontal or vertical, got \(shown(value)).") }
    return true
}

/// A text node's fields read from untrusted data (`sanitizeVectorTextFields`), in the TS key order:
/// `text`, `font`, `runs`, `paragraph`, `frame`, `orientation`.
public func sanitizeVectorTextFields(_ value: JSONObject) throws -> JSONObject {
    let text = value["text"]?.stringValue.map(normalizeLineBreaks) ?? ""
    let font = try patchVectorCharacterStyle(DEFAULT_VECTOR_FONT, value["font"]?.objectValue ?? JSONObject(), "font")
    var runs: [StyledRun]?
    if let list = value["runs"]?.arrayValue {
        let parsed = try list.filter { truthy($0) && isNum($0["length"]) }.map { r -> StyledRun in
            var rest = r["style"]?.objectValue ?? JSONObject()
            let fill = rest["fill"]
            remove(&rest, "fill")
            var style = try patchVectorCharacterStyle(JSONObject(), rest, "runs.style")
            if let fill { style["fill"] = fill }
            return StyledRun(length: r["length"]!.numberValue!, style: style)
        }
        runs = normalizeVectorTextRuns(text, parsed)
    }
    let paragraph = truthy(value["paragraph"]) ? try patchVectorParagraphStyle(JSONObject(), value["paragraph"]?.objectValue ?? JSONObject()) : nil
    let frame = try sanitizeVectorTextFrame(value["frame"].flatMap { $0 == .null ? nil : $0 } ?? .object(JSONObject([("kind", "point"), ("x", 0), ("y", 0)])))
    let vertical = try vectorTextOrientation(value["orientation"])
    var out = JSONObject([("text", .string(text)), ("font", .object(font))])
    if let runs { out["runs"] = runsJSON(runs) }
    if let paragraph, !paragraph.isEmpty { out["paragraph"] = .object(paragraph) }
    out["frame"] = .object(frame)
    if vertical { out["orientation"] = "vertical" }
    return out
}

/// A range of the text from loose input (`vectorTextRange`): [start, end) in UTF-16 code units (default the whole text).
public func vectorTextRange(_ text: String, _ start: Double?, _ end: Double?) throws -> (Int, Int) {
    let n = Double(text.utf16.count)
    let s = start ?? 0
    let e = end ?? n
    if !(s.isFinite && s.rounded(.towardZero) == s) || !(e.isFinite && e.rounded(.towardZero) == e) || s < 0 || e > n || s > e {
        throw VectorTextError("start and end must be whole numbers with 0 ≤ start ≤ end ≤ \(Int(n)) (the text's length in UTF-16 code units), got \(start.map(jsString) ?? "undefined") and \(end.map(jsString) ?? "undefined").")
    }
    return (Int(s), Int(e))
}

// MARK: - Edits (pure)

/// The node with [start, end) of its text replaced by `insert`, styled like the character before it (`replaceVectorText`).
public func replaceVectorText(_ node: VectorNode, _ start: Int, _ end: Int, _ insert: String) -> VectorNode {
    let clean = normalizeLineBreaks(insert)
    let old = node.textValue.u16
    let text = str16(old[0 ..< start] + clean.u16 + old[end...])
    var runs: [StyledRun]?
    if let own = node.textRuns, !own.isEmpty {
        let fitted = fitVectorTextRuns(own, Double(old.count))
        let style = styleAt(fitted, Double(start > 0 ? start - 1 : start), JSONObject())
        runs = normalizeVectorTextRuns(text, spliceRuns(fitted, Double(start), Double(end), Double(clean.utf16.count), style))
    }
    var next = node
    next["text"] = .string(text)
    if let runs { next["runs"] = runsJSON(runs) } else { next["runs"] = Optional<JSONValue>.none }
    return next
}

/**
 * The node with a character style patch (and `fill`) applied over [start, end) (`styleVectorText`).
 * The whole text changes the node's own style (and its `fill`) and drops those fields from its runs.
 */
public func styleVectorText(_ node: VectorNode, _ start: Int, _ end: Int, _ patch: JSONObject) throws -> VectorNode {
    var fields = patch
    let fill = patch["fill"]
    remove(&fields, "fill")
    let length = node.textValue.utf16.count
    let whole = start <= 0 && end >= length
    if whole {
        var next = node
        next["font"] = .object(try patchVectorCharacterStyle(node.fontStyle, fields, "style"))
        let keys = fields.keys
        if let own = next.textRuns, !own.isEmpty, !keys.isEmpty || fill != nil {
            let runs = normalizeVectorTextRuns(next.textValue, own.map { r in
                var style = r.style
                for k in keys { remove(&style, k) }
                if fill != nil { remove(&style, "fill") }
                return StyledRun(length: r.length, style: style)
            })
            if let runs { next["runs"] = runsJSON(runs) } else { next["runs"] = Optional<JSONValue>.none }
        }
        if let fill { next["fill"] = fill }
        return next
    }
    if end <= start { return node }
    let fitted = fitVectorTextRuns(node.textRuns ?? [], Double(length))
    let font = node.fontStyle
    let restyled = try restyleRange(fitted.isEmpty ? [StyledRun(length: Double(length), style: JSONObject())] : fitted, Double(start), Double(end)) { s in
        var own = try patchVectorCharacterStyle(s, fields, "style")
        // A field set back to the node's own value is no override.
        for k in VECTOR_CHARACTER_STYLE_KEYS { if let v = own[k], v == font[k] { remove(&own, k) } }
        var out = own
        if let fill {
            if fill == .null && s["fill"] != nil { remove(&out, "fill") } else { out["fill"] = fill }
        } else if let f = s["fill"] {
            out["fill"] = f
        }
        return out
    }
    let runs = normalizeVectorTextRuns(node.textValue, restyled)
    var next = node
    if let runs { next["runs"] = runsJSON(runs) } else { next["runs"] = Optional<JSONValue>.none }
    return next
}

/**
 * The node with scale and skew of `m` baked in (`bakeVectorTextGeometry`): the frame's points map
 * through `m`, font sizes scale by √|det| (text keeps its proportions), and an area's box takes
 * each axis' own scale.
 */
public func bakeVectorTextGeometry(_ node: VectorNode, _ m: VectorMatrix) -> VectorNode {
    if isIdentityMatrix(m) { return node }
    var k = abs(m.a * m.d - m.b * m.c).squareRoot()
    if k == 0 || k.isNaN { k = 1 }
    func scaleStyle(_ s: JSONObject) -> JSONObject {
        var out = s
        for key in ["fontSize", "leading", "baselineShift"] { if let v = s[key] { out[key] = .number((v.numberValue ?? .nan) * k) } }
        return out
    }
    var next = node
    next["font"] = .object(scaleStyle(node.fontStyle))
    if let runs = node["runs"]?.arrayValue {
        next["runs"] = .array(runs.map { r in
            .object(JSONObject([("length", r["length"] ?? .null), ("style", .object(scaleStyle(r["style"]?.objectValue ?? JSONObject())))]))
        })
    }
    if let p = node["paragraph"]?.objectValue {
        var out = p
        for key in ["firstLineIndent", "startIndent", "endIndent", "spaceBefore", "spaceAfter"] where truthy(p[key]) { out[key] = .number((p[key]?.numberValue ?? .nan) * k) }
        next["paragraph"] = .object(out)
    }
    let f = node.frame ?? JSONObject()
    let at = Vec2(f["x"]?.numberValue ?? .nan, f["y"]?.numberValue ?? .nan)
    var frame: JSONObject
    switch f["kind"]?.stringValue {
    case "point":
        let q = applyMatrix(m, at)
        frame = JSONObject([("kind", "point"), ("x", .number(q.x)), ("y", .number(q.y))])
    case "area":
        let q = applyMatrix(m, at)
        let sx = JS.hypot(m.a, m.b)
        let sy = JS.hypot(m.c, m.d)
        frame = JSONObject([("kind", "area"), ("x", .number(q.x)), ("y", .number(q.y)), ("width", .number((f["width"]?.numberValue ?? .nan) * sx)), ("height", .number((f["height"]?.numberValue ?? .nan) * sy))])
    default:
        func map(_ v: JSONValue?) -> Vec2 { applyMatrix(m, Vec2(v?["x"]?.numberValue ?? .nan, v?["y"]?.numberValue ?? .nan)) }
        frame = f
        let anchors = (f["path"]?["anchors"]?.arrayValue ?? []).map { a -> JSONValue in
            var o = a.objectValue ?? JSONObject()
            let p = map(a)
            o["x"] = .number(p.x)
            o["y"] = .number(p.y)
            if truthy(a["in"]) { o["in"] = map(a["in"]).json }
            if truthy(a["out"]) { o["out"] = map(a["out"]).json }
            return .object(o)
        }
        frame["path"] = .object(JSONObject([("closed", f["path"]?["closed"] ?? .null), ("anchors", .array(anchors))]))
        if let s = f["start"]?.numberValue, truthy(f["start"]) { frame["start"] = .number(s * k) }
        if let e = f["end"]?.numberValue, truthy(f["end"]) { frame["end"] = .number(e * k) }
    }
    next["frame"] = .object(frame)
    return next
}

/// The text of a node as a short name ("Hello world…"; `vectorTextName`).
public func vectorTextName(_ text: String) -> String {
    var collapsed = String.UnicodeScalarView()
    var inSpace = false
    for s in text.unicodeScalars {
        if isJSSpace(s) {
            if !inSpace { collapsed.append(" ") }
            inSpace = true
        } else {
            collapsed.append(s)
            inSpace = false
        }
    }
    let t = String(collapsed).jsTrimmed.u16
    if t.isEmpty { return "Text" }
    return t.count > 24 ? str16(t[0 ..< 24]) + "…" : str16(t)
}

/// Path data for a path text frame (`pathTextFrameFromBezier`): the first subpath's anchors, or nil.
public func pathTextFrameFromBezier(_ path: BezierPath) -> JSONObject? {
    var anchors: [JSONObject] = []
    var closed = false
    loop: for c in path {
        switch c {
        case let .M(x, y):
            if !anchors.isEmpty { break loop }
            anchors.append(JSONObject([("x", .number(x)), ("y", .number(y))]))
        case let .L(x, y):
            anchors.append(JSONObject([("x", .number(x)), ("y", .number(y))]))
        case let .C(x1, y1, x2, y2, x, y):
            anchors[anchors.count - 1]["out"] = Vec2(x1, y1).json
            anchors.append(JSONObject([("x", .number(x)), ("y", .number(y)), ("in", Vec2(x2, y2).json)]))
        case let .Q(x1, y1, x, y):
            let px = anchors[anchors.count - 1]["x"]!.numberValue!
            let py = anchors[anchors.count - 1]["y"]!.numberValue!
            anchors[anchors.count - 1]["out"] = Vec2(px + ((x1 - px) * 2) / 3, py + ((y1 - py) * 2) / 3).json
            anchors.append(JSONObject([("x", .number(x)), ("y", .number(y)), ("in", Vec2(x + ((x1 - x) * 2) / 3, y + ((y1 - y) * 2) / 3).json)]))
        case .Z:
            closed = true
            break loop
        case .A:
            continue
        }
    }
    return anchors.count >= 2 ? JSONObject([("anchors", .array(anchors.map { .object($0) })), ("closed", .bool(closed))]) : nil
}

/// A subpath as the JSON a path text frame stores (`{ closed, anchors }` read by `sanitizeVectorTextFrame`).
func subpathFrameJSON(_ sp: VectorSubpath) -> JSONValue { sp.toJSON() }

/**
 * The outline the editor shows for a text node (`vectorTextBoxOutline`), node space: an area's box,
 * a path text's path, or a box round each line of point text.
 */
public func vectorTextBoxOutline(_ node: VectorNode) -> BezierPath {
    let f = node.frame ?? JSONObject()
    let kind = f["kind"]?.stringValue
    if kind == "area" {
        let x = f["x"]?.numberValue ?? .nan, y = f["y"]?.numberValue ?? .nan, w = f["width"]?.numberValue ?? .nan, h = f["height"]?.numberValue ?? .nan
        return polygon([Vec2(x, y), Vec2(x + w, y), Vec2(x + w, y + h), Vec2(x, y + h)])
    }
    if kind == "path" { return subpathPath(f["path"]) }
    let layout = layoutVectorText(node)
    var out: BezierPath = []
    for (i, l) in layout.text.lines.enumerated() {
        guard i < layout.lines.count else { continue }
        let line = layout.lines[i]
        if l.matrix != nil {
            let r = textLineRect(l)
            let o = layout.origin
            let h = JS.max(r.height, 1)
            out += polygon([Vec2(o.x + r.x, o.y + r.y), Vec2(o.x + r.x + r.width, o.y + r.y), Vec2(o.x + r.x + r.width, o.y + r.y + h), Vec2(o.x + r.x, o.y + r.y + h)])
            continue
        }
        let top = line.baseline - l.ascent
        let bottom = line.baseline + l.descent
        let w = JS.max(l.width, 1)
        out += polygon([Vec2(line.x, top), Vec2(line.x + w, top), Vec2(line.x + w, bottom), Vec2(line.x, bottom)])
    }
    return out
}

/// One `<tspan>` of text drawn as SVG text (`VectorTextSpan`).
public struct VectorTextSpan: Equatable, Sendable {
    public var text: String
    public var x: [Double]
    public var y: [Double]
    public var rotate: [Double]?
    public var style: JSONObject
    public var family: String
    public var fill: JSONValue?
}

/// The text as SVG text spans (`vectorTextSpans`): one per fragment, every character placed by the layout.
public func vectorTextSpans(_ node: VectorNode) -> [VectorTextSpan] {
    let layout = layoutVectorText(node)
    var out: [VectorTextSpan] = []
    for f in layout.fragments {
        let glyphs = layout.glyphs[f.from ..< f.to]
        if glyphs.isEmpty { continue }
        let turned = glyphs.contains { $0.angle != 0 }
        out.append(VectorTextSpan(text: str16(glyphs.flatMap(\.char)), x: glyphs.map(\.x), y: glyphs.map(\.y), rotate: turned ? glyphs.map(\.angle) : nil, style: f.style, family: f.font.family, fill: f.fill))
    }
    return out
}

/**
 * The text as one path node in its style (`vectorTextGeometryNode`): its geometry (glyph outlines,
 * or glyph boxes) and paint stacks. Paint servers and stroke layers of SVG text are computed on it.
 */
public func vectorTextGeometryNode(_ node: VectorNode) -> VectorNode {
    let path = vectorTextPaths(node).parts.flatMap(\.path)
    return vectorTextPaintSource(node, nil, bezierToSubpathsLite(path))
}

/// Polygon / Bézier commands to subpaths (anchors with absolute handles; `bezierToSubpathsLite`).
private func bezierToSubpathsLite(_ path: BezierPath) -> [VectorSubpath] {
    var out: [VectorSubpath] = []
    for c in path {
        switch c {
        case let .M(x, y):
            out.append(VectorSubpath(anchors: [VectorAnchor(x: x, y: y)], closed: false))
        case let .L(x, y):
            guard !out.isEmpty else { continue }
            out[out.count - 1].anchors.append(VectorAnchor(x: x, y: y))
        case let .C(x1, y1, x2, y2, x, y):
            guard !out.isEmpty else { continue }
            let i = out.count - 1
            out[i].anchors[out[i].anchors.count - 1].out = Vec2(x1, y1)
            out[i].anchors.append(VectorAnchor(x: x, y: y, in: Vec2(x2, y2)))
        case let .Q(x1, y1, x, y):
            guard !out.isEmpty else { continue }
            let i = out.count - 1
            let p = out[i].anchors[out[i].anchors.count - 1]
            out[i].anchors[out[i].anchors.count - 1].out = Vec2(p.x + ((x1 - p.x) * 2) / 3, p.y + ((y1 - p.y) * 2) / 3)
            out[i].anchors.append(VectorAnchor(x: x, y: y, in: Vec2(x + ((x1 - x) * 2) / 3, y + ((y1 - y) * 2) / 3)))
        case .Z:
            guard !out.isEmpty else { continue }
            let i = out.count - 1
            var a = out[i].anchors
            if a.count > 1 && abs(a[0].x - a[a.count - 1].x) < 1e-9 && abs(a[0].y - a[a.count - 1].y) < 1e-9 {
                let last = a.removeLast()
                if let h = last.in { a[0].in = h }
                out[i].anchors = a
            }
            out[i].closed = true
        case .A:
            continue
        }
    }
    return out.filter { !$0.anchors.isEmpty }
}

/// `Math.round(n * 1000) / 1000`.
private func fmt3(_ n: Double) -> Double { JS.round(n * 1000) / 1000 }

/// A span as render data (`vectorTextSpanSvg`): positions as SVG number lists, with the run's fill as drawn.
public func vectorTextSpanSvg(_ sp: VectorTextSpan, _ fill: String? = nil) -> JSONObject {
    func list(_ v: [Double]) -> String { v.map { jsString(fmt3($0)) }.joined(separator: " ") }
    let deco = [sp.style.flag("underline") ? "underline" : "", sp.style.flag("strikethrough") ? "line-through" : ""].filter { !$0.isEmpty }.joined(separator: " ")
    var o = JSONObject([("text", .string(sp.text)), ("x", .string(list(sp.x)))])
    o["y"] = .string(sp.y.allSatisfy { $0 == sp.y[0] } ? jsString(fmt3(sp.y[0])) : list(sp.y))
    if let r = sp.rotate { o["rotate"] = .string(list(r)) }
    o["fontFamily"] = .string(cssFontFamily(sp.family))
    o["fontSize"] = sp.style["fontSize"] ?? .null
    o["fontWeight"] = sp.style["fontWeight"] ?? .null
    if sp.style.flag("italic") { o["fontStyle"] = "italic" }
    if !deco.isEmpty { o["textDecoration"] = .string(deco) }
    if let fill { o["fill"] = .string(fill) }
    return o
}

private let GENERIC_FAMILIES: Set<String> = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong"]

/// A family as it goes into a CSS `font` value (`cssFontFamily`): generics and lists as written, other names quoted when needed.
public func cssFontFamily(_ family: String) -> String {
    let f = family.jsTrimmed
    if GENERIC_FAMILIES.contains(f.jsLowercased) || f.contains(",") || f.hasPrefix("\"") || f.hasPrefix("'") { return f }
    let plain = f.unicodeScalars.first.map { ($0.value >= 65 && $0.value <= 90) || ($0.value >= 97 && $0.value <= 122) || $0 == "_" || $0 == "-" } ?? false
        && f.unicodeScalars.allSatisfy { ($0.value >= 65 && $0.value <= 90) || ($0.value >= 97 && $0.value <= 122) || ($0.value >= 48 && $0.value <= 57) || $0 == "_" || $0 == " " || $0 == "-" }
    return plain && !f.contains("  ") ? f : "\"\(f.replacingOccurrences(of: "\"", with: "\\\""))\""
}
