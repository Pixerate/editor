import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// The shared text engine (`src/text` in the TS core: `types.ts`, `layout.ts` and the metric shaper
// of `shapers.ts`): styled runs, paragraphs, line breaking (at spaces and after break characters,
// and between wide CJK characters), alignment and justification, tracking, leading, indents,
// spacing, baseline shift, horizontal and vertical writing, caret positions and hit testing.
// Everything that needs a font goes through a `VectorTextShaper`, so the same measurements give
// the same lines in every host.
//
// Text is handled as UTF-16 code units (`[UInt16]`), as JavaScript strings are: indices, run
// lengths and carets count code units. Styles are JSON objects (the TS `TextStyle` fields), so runs
// compare as `JSON.stringify` compares them. The TS compares run styles by object identity inside
// a layout; here a style is known by the index of its run.

// MARK: - Shapers

/// A font as a shaper is asked for it (`TextFont`; sizes in pixels).
public struct TextFont: Equatable, Sendable {
    public var family: String
    public var weight: Double
    public var italic: Bool
    public var size: Double
    public var postScriptName: String?

    public init(family: String, weight: Double, italic: Bool, size: Double, postScriptName: String? = nil) {
        self.family = family
        self.weight = weight
        self.italic = italic
        self.size = size
        self.postScriptName = postScriptName
    }
}

/// How a shaper sets a character upright in a vertical column (`TextVerticalMetrics`, pixels).
public struct TextVerticalMetrics: Equatable, Sendable {
    /// Advance down the column.
    public var advance: Double
    /// Distance from the top of the character's cell to its horizontal baseline.
    public var originY: Double
    /// Whether the font has a vertical alternate (OpenType `vert`) the shaper draws with.
    public var alternate: Bool

    public init(advance: Double, originY: Double, alternate: Bool) {
        self.advance = advance
        self.originY = originY
        self.alternate = alternate
    }
}

/**
 * What layout and rendering need from fonts (`TextShaper`). Text comes as UTF-16 code units, as in
 * JavaScript. `measure` returns `text.count + 1` caret offsets (kerning included, tracking not).
 * `outline` (glyph outlines with the text's start on the baseline at `x`, `y`, y down) is optional:
 * a shaper without outlines returns nil and `hasOutlines` is false, and text then draws as SVG text
 * with box geometry. `vertical` (upright metrics from `vhea` / `vmtx`) and `families` are optional
 * too. The metric shaper is the default; a CoreText shaper for apps can implement the same protocol.
 */
public protocol VectorTextShaper: AnyObject {
    /// Identifies the shaper (part of every layout cache key).
    var id: String { get }
    /// The family that draws `font`: the family itself when available, else a fallback (`available: false`).
    func resolve(_ font: TextFont) -> (family: String, available: Bool)
    /// Ascent and descent (both positive, pixels) of the resolved font at `font.size`.
    func metrics(_ font: TextFont) -> (ascent: Double, descent: Double)
    /// Caret positions of `text` set in `font`: `text.count + 1` x offsets in pixels from the start.
    func measure(_ text: [UInt16], _ font: TextFont) -> [Double]
    /// Whether `outline` gives glyph outlines.
    var hasOutlines: Bool { get }
    /// Glyph outlines of `text` with its start on the baseline at (`x`, `y`), or nil without outlines.
    func outline(_ text: [UInt16], _ font: TextFont, x: Double, y: Double, vertical: Bool) -> BezierPath?
    /// Vertical metrics of one character (a code point) set upright, or nil when the shaper cannot tell.
    func vertical(_ char: [UInt16], _ font: TextFont) -> TextVerticalMetrics?
    /// Families this shaper can draw, when it can tell.
    func families() -> [String]?
}

extension VectorTextShaper {
    public var hasOutlines: Bool { false }
    public func outline(_ text: [UInt16], _ font: TextFont, x: Double, y: Double, vertical: Bool) -> BezierPath? { nil }
    public func vertical(_ char: [UInt16], _ font: TextFont) -> TextVerticalMetrics? { nil }
    public func families() -> [String]? { nil }
}

private func units(_ s: String) -> Set<UInt16> { Set(s.utf16) }
private let NARROW = units("iIjl.,:;!|'`")
private let HALF = units(" frt()[]{}-\"/\\")
private let WIDE = units("mwMW@%")

/**
 * A shaper that needs no fonts (`createMetricTextShaper`): advances estimated per character class
 * (narrow, wide, CJK), an ascent of 0.8 em and a descent of 0.2 em, bold 5 % wider. It cannot draw
 * or outline. Every family counts as available. The conformance scenarios lay text out with it.
 */
public final class MetricTextShaper: VectorTextShaper {
    public let id: String

    public init(id: String = "metric") { self.id = id }

    /// The advance of one code unit in em.
    static func em(_ code: UInt16) -> Double {
        if (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef) { return 1 }
        if code >= 0xdc00 && code <= 0xdfff { return 0 }
        if code == 10 || code == 13 { return 0 }
        if NARROW.contains(code) { return 0.28 }
        if HALF.contains(code) { return 0.36 }
        if WIDE.contains(code) { return 0.85 }
        if code >= 65 && code <= 90 { return 0.66 }
        if code >= 48 && code <= 57 { return 0.56 }
        return 0.54
    }

    public func resolve(_ font: TextFont) -> (family: String, available: Bool) { (font.family, true) }

    public func metrics(_ font: TextFont) -> (ascent: Double, descent: Double) { (font.size * 0.8, font.size * 0.2) }

    public func measure(_ text: [UInt16], _ font: TextFont) -> [Double] {
        var out: [Double] = [0]
        out.reserveCapacity(text.count + 1)
        var x = 0.0
        let k = font.size * (font.weight >= 600 ? 1.05 : 1)
        for c in text {
            x += Self.em(c) * k
            out.append(x)
        }
        return out
    }
}

// MARK: - Styles and runs

/// A run of `length` UTF-16 code units in one style (`TextRun`, `ParagraphRun`, `VectorTextRun`).
public struct StyledRun: Equatable, Sendable {
    public var length: Double
    public var style: JSONObject

    public init(length: Double, style: JSONObject) {
        self.length = length
        self.style = style
    }

    /// `{ length, style }`.
    public var json: JSONValue { .object(JSONObject([("length", .number(length)), ("style", .object(style))])) }

    /// A run from `{ length, style }` (a missing style is `{}`).
    public init?(json: JSONValue) {
        guard let length = json["length"]?.numberValue else { return nil }
        self.length = length
        style = json["style"]?.objectValue ?? JSONObject()
    }
}

/// `DEFAULT_TEXT_STYLE`.
let DEFAULT_TEXT_STYLE = JSONObject([("fontFamily", "sans-serif"), ("fontWeight", 400), ("fontSize", 24), ("color", "#000000")])
/// `DEFAULT_AUTO_LEADING`.
public let DEFAULT_AUTO_LEADING = 1.2

/// Typed reads of a character style (`TextStyle`) or paragraph style object.
extension JSONObject {
    var fontFamily: String { self["fontFamily"]?.stringValue ?? "" }
    var fontWeight: Double { self["fontWeight"]?.numberValue ?? .nan }
    var fontSize: Double { self["fontSize"]?.numberValue ?? .nan }
    func num(_ key: String) -> Double? { self[key]?.numberValue }
    func flag(_ key: String) -> Bool { truthy(self[key]) }
}

/// `JSON.stringify(a) === JSON.stringify(b)`.
private func sameStyle(_ a: JSONObject, _ b: JSONObject) -> Bool { JSONValue.object(a).stringified() == JSONValue.object(b).stringified() }

/// Merges neighbouring runs with equal styles and drops empty ones (`compact`).
func compactRuns(_ runs: [StyledRun]) -> [StyledRun] {
    var out: [StyledRun] = []
    for r in runs {
        if !(r.length > 0) { continue }
        if let last = out.last, sameStyle(last.style, r.style) { out[out.count - 1].length = last.length + r.length } else { out.append(r) }
    }
    return out
}

/// Runs fitted to a text of `length` (the last run stretches or is cut), never empty while there is text (`fitRuns`).
public func fitRuns(_ runs: [StyledRun], _ length: Double, _ fallback: JSONObject) -> [StyledRun] {
    var out: [StyledRun] = []
    var left = length
    for r in runs {
        if left <= 0 { break }
        let n = JS.min(JS.max(0, Foundation.floor(r.length)), left)
        if n > 0 { out.append(StyledRun(length: n, style: r.style)) }
        left -= n
    }
    if left > 0 {
        if !out.isEmpty { out[out.count - 1].length += left } else { out.append(StyledRun(length: left, style: runs.last?.style ?? fallback)) }
    }
    return compactRuns(out)
}

/// The index of the run holding code unit `index` (the last run past the end; -1 without runs).
func runIndexAt(_ runs: [StyledRun], _ index: Double) -> Int {
    var at = 0.0
    for (i, r) in runs.enumerated() {
        if index < at + r.length { return i }
        at += r.length
    }
    return runs.count - 1
}

/// The style of the run holding code unit `index` (the last run past the end; `styleAt`).
public func styleAt(_ runs: [StyledRun], _ index: Double, _ fallback: JSONObject) -> JSONObject {
    let i = runIndexAt(runs, index)
    return i >= 0 ? runs[i].style : fallback
}

/// Runs with `patch(style)` applied over [start, end) (`restyleRange`).
public func restyleRange(_ runs: [StyledRun], _ start: Double, _ end: Double, _ patch: (JSONObject) throws -> JSONObject) rethrows -> [StyledRun] {
    var out: [StyledRun] = []
    var at = 0.0
    for r in runs {
        let a = at
        let b = at + r.length
        at = b
        let lo = JS.max(a, start)
        let hi = JS.min(b, end)
        if hi <= lo {
            out.append(r)
            continue
        }
        if lo > a { out.append(StyledRun(length: lo - a, style: r.style)) }
        out.append(StyledRun(length: hi - lo, style: try patch(r.style)))
        if b > hi { out.append(StyledRun(length: b - hi, style: r.style)) }
    }
    return compactRuns(out)
}

/// Runs after replacing [start, end) of the text with `inserted` code units styled `style` (`spliceRuns`).
public func spliceRuns(_ runs: [StyledRun], _ start: Double, _ end: Double, _ inserted: Double, _ style: JSONObject) -> [StyledRun] {
    var out: [StyledRun] = []
    var at = 0.0
    var placed = false
    for r in runs {
        let a = at
        let b = at + r.length
        at = b
        if b <= start {
            out.append(r)
            continue
        }
        if a < start { out.append(StyledRun(length: start - a, style: r.style)) }
        if !placed {
            out.append(StyledRun(length: inserted, style: style))
            placed = true
        }
        if b > end { out.append(StyledRun(length: b - JS.max(end, a), style: r.style)) }
    }
    if !placed { out.append(StyledRun(length: inserted, style: style)) }
    return compactRuns(out)
}

/// Paragraph ranges [start, end) of the text, the line break included in the paragraph it ends (`paragraphRanges`).
func paragraphRanges(_ text: [UInt16]) -> [(start: Int, end: Int, content: Int)] {
    var out: [(start: Int, end: Int, content: Int)] = []
    var start = 0
    for (i, c) in text.enumerated() where c == 10 {
        out.append((start, i + 1, i))
        start = i + 1
    }
    out.append((start, text.count, text.count))
    return out
}

// MARK: - Layout types

/// An affine matrix `[a, b, c, d, e, f]` for the layout's line space → text space (`TextMatrix`).
public typealias TextMatrix = VectorMatrix

/// One laid-out character (`LaidChar`): its index and its line-space x and advance.
public struct LaidChar: Equatable, Sendable {
    public var index: Int
    public var x: Double
    public var advance: Double
}

/// A character of vertical text as drawn, text space (`LaidGlyph`).
public struct LaidGlyph: Equatable, Sendable {
    public var index: Int
    /// Code units (2 for a surrogate pair).
    public var length: Int
    public var x: Double
    public var y: Double
    /// 90: turned sideways, clockwise; 0: upright.
    public var angle: Double
    public var advance: Double
    public var ascent: Double
    public var descent: Double
    /// Drawn with the font's vertical alternate (`vert`).
    public var vert: Bool
}

/// A run of characters on one line in one style (`LaidFragment`).
public struct LaidFragment: Equatable, Sendable {
    public var start: Int
    public var end: Int
    public var style: JSONObject
    public var font: TextFont
    /// The family the shaper draws it with.
    public var family: String
    /// Line space.
    public var x: Double
    /// Baseline in line space (baseline shift applied); for upright vertical text, the column's centre line.
    public var y: Double
    /// Per-character x positions relative to `x` (`end − start + 1` entries).
    public var carets: [Double]
    /// Whether characters are placed one by one (tracking or justification).
    public var spaced: Bool
    /// Vertical text only: whether the fragment's characters stand upright.
    public var upright: Bool?
    /// Vertical text only: each character as drawn, text space.
    public var glyphs: [LaidGlyph]?
}

/// One line (a column of vertical text; `LaidLine`).
public struct LaidLine: Equatable, Sendable {
    public var start: Int
    /// End of the line's characters (line break and trailing spaces excluded from `width`).
    public var end: Int
    /// Line space; for vertical text the column's centre line.
    public var baseline: Double
    public var ascent: Double
    public var descent: Double
    public var x: Double
    public var width: Double
    public var chars: [LaidChar]
    public var fragments: [LaidFragment]
    /// Vertical text only: line space → text space.
    public var matrix: TextMatrix?
}

/// A laid-out text block (`TextLayout`).
public struct TextLayout: Equatable, Sendable {
    public var lines: [LaidLine]
    /// Bounds of the lines (ascent to descent), text space; the box for paragraph text.
    public var bounds: VectorBounds
    /// Families replaced by a fallback.
    public var missingFonts: [String]
    /// `horizontal` or `vertical`.
    public var orientation: String
    /// Vertical text only: line space → text space.
    public var matrix: TextMatrix?
}

/// What layout needs (`TextBlock`): the text, its character and paragraph runs and its frame.
public struct TextBlock: Sendable {
    public var text: [UInt16]
    public var runs: [StyledRun]
    public var paragraphs: [StyledRun]
    /// A box (`width`, `height`) for paragraph text; nil for point text.
    public var box: (width: Double, height: Double)?
    /// Point text only: the first baseline one ascent down (`origin: 'top'`).
    public var originTop: Bool
    public var vertical: Bool

    public init(text: [UInt16], runs: [StyledRun], paragraphs: [StyledRun], box: (width: Double, height: Double)? = nil, originTop: Bool = false, vertical: Bool = false) {
        self.text = text
        self.runs = runs
        self.paragraphs = paragraphs
        self.box = box
        self.originTop = originTop
        self.vertical = vertical
    }
}

/// The font of a style (`fontOf`).
func fontOf(_ style: JSONObject) -> TextFont {
    var f = TextFont(family: style.fontFamily, weight: style.fontWeight, italic: style.flag("italic"), size: style.fontSize)
    if let ps = style["postScriptName"]?.stringValue, !ps.isEmpty { f.postScriptName = ps }
    return f
}

private func isBreakAfter(_ c: UInt16) -> Bool { c == 32 || c == 9 || c == 45 || c == 0x2010 || c == 0x200b }
/// Whether a code unit is a space or tab (spaces hang at line ends and stretch when justifying; `isTextSpace`).
public func isTextSpace(_ c: UInt16) -> Bool { c == 32 || c == 9 }
/// `isTextSpace` of a one-character string (false for anything longer).
func isTextSpace(_ s: [UInt16]) -> Bool { s.count == 1 && isTextSpace(s[0]) }
private func isWide(_ code: UInt16) -> Bool { (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) }
func isHighSurrogate(_ code: UInt16) -> Bool { code >= 0xd800 && code <= 0xdbff }
func isLowSurrogate(_ code: UInt16) -> Bool { code >= 0xdc00 && code <= 0xdfff }

private let TR: Set<UInt32> = [0x2025, 0x2026, 0x3008, 0x3009, 0x300a, 0x300b, 0x300c, 0x300d, 0x300e, 0x300f, 0x3010, 0x3011, 0x3014, 0x3015, 0x3016, 0x3017, 0x3018, 0x3019, 0x301a, 0x301b, 0x301c, 0x3030, 0x30a0, 0x30fc, 0xff08, 0xff09, 0xff0d, 0xff1a, 0xff1b, 0xff1d, 0xff3b, 0xff3d, 0xff3f, 0xff5b, 0xff5c, 0xff5d, 0xff5e]
private let TU: Set<UInt32> = [0x3001, 0x3002, 0xff0c, 0xff0e, 0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3063, 0x3083, 0x3085, 0x3087, 0x308e, 0x3095, 0x3096, 0x30a1, 0x30a3, 0x30a5, 0x30a7, 0x30a9, 0x30c3, 0x30e3, 0x30e5, 0x30e7, 0x30ee, 0x30f5, 0x30f6]
/// Punctuation that sits in the lower left of its cell horizontally and the upper right vertically.
private let CORNER: Set<UInt32> = [0x3001, 0x3002, 0xff0c, 0xff0e]

/**
 * How a code point is set in vertical text (`verticalOrientationOf`, after UAX #50 simplified to
 * CJK): `U` upright, `R` turned sideways, `Tu` upright in a vertical form when the font has one,
 * `Tr` a vertical form when the font has one, else turned sideways.
 */
public func verticalOrientationOf(_ cp: UInt32) -> String {
    if TR.contains(cp) { return "Tr" }
    if TU.contains(cp) || (cp >= 0x31f0 && cp <= 0x31ff) { return "Tu" }
    let ranges: [ClosedRange<UInt32>] = [
        0x1100 ... 0x11ff, 0x2e80 ... 0x4dbf, 0x4e00 ... 0x9fff, 0xa000 ... 0xa4cf, 0xa960 ... 0xa97f, 0xac00 ... 0xd7ff, 0xf900 ... 0xfaff, 0xfe10 ... 0xfe1f,
        0xfe30 ... 0xfe4f, 0xff00 ... 0xff60, 0xffe0 ... 0xffe7, 0x1f000 ... 0x1faff, 0x20000 ... 0x3ffff,
    ]
    return ranges.contains { $0.contains(cp) } ? "U" : "R"
}

/// `text.codePointAt(i)`: a surrogate pair's code point, else the code unit.
func codePointAt(_ text: [UInt16], _ i: Int) -> UInt32 {
    let c = text[i]
    if isHighSurrogate(c), i + 1 < text.count, isLowSurrogate(text[i + 1]) { return 0x10000 + ((UInt32(c) - 0xd800) << 10) + (UInt32(text[i + 1]) - 0xdc00) }
    return UInt32(c)
}

/// How an upright character of vertical text sits in its cell (pixels).
private struct Upright {
    var width: Double
    var originY: Double
    var vert: Bool
    var dx: Double
    var dy: Double
}

private struct ParaChar {
    var index: Int
    var ch: UInt16
    var advance: Double
    /// The index of its run (-1: the default style).
    var style: Int
    var up: Upright?
    var low = false
}

/// `applyMatrix` of `layout.ts` (the point itself without a matrix).
func textApply(_ m: TextMatrix?, _ x: Double, _ y: Double) -> Vec2 {
    guard let m else { return Vec2(x, y) }
    return Vec2(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f)
}

private func invertTextMatrix(_ m: TextMatrix) -> TextMatrix {
    let (a, b, c, d, e, f) = m.tuple
    var det = a * d - b * c
    if det == 0 || det.isNaN { det = 1 }
    return VectorMatrix(d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)
}

/// A rectangle mapped through `m` (a quarter turn keeps it a rectangle); `r` itself without `m` (`transformTextRect`).
public func transformTextRect(_ m: TextMatrix?, _ r: VectorBounds) -> VectorBounds {
    guard let m else { return r }
    let pts = [textApply(m, r.x, r.y), textApply(m, r.x + r.width, r.y), textApply(m, r.x + r.width, r.y + r.height), textApply(m, r.x, r.y + r.height)]
    let x0 = pts.reduce(Double.infinity) { JS.min($0, $1.x) }
    let y0 = pts.reduce(Double.infinity) { JS.min($0, $1.y) }
    return VectorBounds(x: x0, y: y0, width: pts.reduce(-Double.infinity) { JS.max($0, $1.x) } - x0, height: pts.reduce(-Double.infinity) { JS.max($0, $1.y) } - y0)
}

/// A line-space point of a layout in text space (`lineToTextSpace`).
public func lineToTextSpace(_ layout: TextLayout, _ p: Vec2) -> Vec2 { textApply(layout.matrix, p.x, p.y) }

/// A text-space point of a layout in line space (`textToLineSpace`).
public func textToLineSpace(_ layout: TextLayout, _ p: Vec2) -> Vec2 {
    guard let m = layout.matrix else { return p }
    return textApply(invertTextMatrix(m), p.x, p.y)
}

/// A line's box (its advance by ascent to descent) in text space (`textLineRect`).
public func textLineRect(_ l: LaidLine) -> VectorBounds {
    transformTextRect(l.matrix, VectorBounds(x: l.x, y: l.baseline - l.ascent, width: l.width, height: l.ascent + l.descent))
}

// MARK: - Layout

/// Lays out a text block with `shaper` (`layoutText`; not cached).
public func layoutText(_ layer: TextBlock, _ shaper: VectorTextShaper) -> TextLayout {
    let text = layer.text
    let vertical = layer.vertical
    let runs = fitRuns(layer.runs, Double(text.count), DEFAULT_TEXT_STYLE)
    func style(_ i: Int) -> JSONObject { i >= 0 ? runs[i].style : DEFAULT_TEXT_STYLE }
    var missing: [String] = []
    var resolved: [String: String] = [:]
    func familyOf(_ font: TextFont) -> String {
        let key = "\(font.family)|\(jsString(font.weight))|\(font.italic)|\(font.postScriptName ?? "")"
        if let fam = resolved[key] { return fam }
        let r = shaper.resolve(font)
        if !r.available && !missing.contains(font.family) { missing.append(font.family) }
        resolved[key] = r.family
        return r.family
    }
    func resolvedFont(_ s: JSONObject) -> TextFont {
        var f = fontOf(s)
        f.family = familyOf(fontOf(s))
        return f
    }
    func verticalOf(_ ch: [UInt16], _ s: JSONObject) -> TextVerticalMetrics {
        let font = resolvedFont(s)
        if let v = shaper.vertical(ch, font) { return v }
        let m = shaper.metrics(font)
        return TextVerticalMetrics(advance: m.ascent + m.descent, originY: m.ascent, alternate: false)
    }
    let box = layer.box
    // Vertical text runs down the box's height, its columns filling the width from the right.
    let inlineSize = box.map { vertical ? $0.height : $0.width } ?? 0
    let matrix: TextMatrix? = vertical ? VectorMatrix(0, 1, -1, 0, box?.width ?? 0, 0) : nil
    var lines: [LaidLine] = []
    var y = 0.0
    var first = true
    for (pi, para) in paragraphRanges(text).enumerated() {
        let pstyle = styleAt(layer.paragraphs, Double(para.start), JSONObject())
        let autoLeading = pstyle.num("autoLeading") ?? DEFAULT_AUTO_LEADING
        if pi > 0 { y += pstyle.num("spaceBefore") ?? 0 }
        // Advances of the paragraph's characters, measured per style segment.
        var chars: [ParaChar] = []
        var i = para.start
        while i < para.content {
            let si = runIndexAt(runs, Double(i))
            let st = style(si)
            var j = i + 1
            while j < para.content && runIndexAt(runs, Double(j)) == si { j += 1 }
            let seg = Array(text[i ..< j])
            let carets = shaper.measure(seg, resolvedFont(st))
            let track = ((st.num("tracking") ?? 0) / 1000) * st.fontSize
            func caret(_ k: Int) -> Double { k < carets.count ? carets[k] : 0 }
            for k in 0 ..< seg.count {
                let index = i + k
                let advance = caret(k + 1) - caret(k)
                if !vertical {
                    chars.append(ParaChar(index: index, ch: seg[k], advance: advance + track, style: si))
                    continue
                }
                let code = seg[k]
                if isLowSurrogate(code) && index > 0 && isHighSurrogate(text[index - 1]) {
                    // The low half of a pair goes with its high half.
                    if let prev = chars.last, let up = prev.up {
                        chars.append(ParaChar(index: index, ch: code, advance: 0, style: si, up: up, low: true))
                    } else {
                        chars.append(ParaChar(index: index, ch: code, advance: advance, style: si, low: true))
                    }
                    continue
                }
                let cp = codePointAt(text, index)
                let kind = verticalOrientationOf(cp)
                var upright = kind == "U" || kind == "Tu" || (kind == "R" && st.flag("upright") && !isTextSpace(code) && code != 10)
                var vm: TextVerticalMetrics?
                let char = cp > 0xffff ? Array(text[index ..< Swift.min(index + 2, text.count)]) : [code]
                if upright || kind == "Tr" {
                    let v = verticalOf(char, st)
                    vm = v
                    if kind == "Tr" { upright = v.alternate }
                }
                guard upright, let vm else {
                    chars.append(ParaChar(index: index, ch: code, advance: advance + track, style: si))
                    continue
                }
                let corner = kind == "Tu" && !vm.alternate && CORNER.contains(cp) ? st.fontSize * 0.55 : 0
                // Measured alone: horizontal kerning does not apply to characters one under the other.
                let alone = shaper.measure(char, resolvedFont(st))
                chars.append(ParaChar(index: index, ch: code, advance: vm.advance + track, style: si, up: Upright(width: alone.last ?? advance, originY: vm.originY, vert: vm.alternate, dx: corner, dy: -corner)))
            }
            i = j
        }
        let startIndent = pstyle.num("startIndent") ?? 0
        let endIndent = pstyle.num("endIndent") ?? 0
        let firstIndent = pstyle.num("firstLineIndent") ?? 0
        // Break into lines.
        var breaks: [(Int, Int)] = []
        if box == nil || chars.isEmpty {
            breaks.append((0, chars.count))
        } else {
            var s = 0
            while s < chars.count {
                let avail = inlineSize - startIndent - endIndent - (breaks.isEmpty ? firstIndent : 0)
                var w = 0.0
                var e = s
                var lastBreak = -1
                while e < chars.count {
                    let c = chars[e]
                    if !isTextSpace(c.ch) && w + c.advance > avail && e > s && !c.low { break }
                    w += c.advance
                    if isBreakAfter(c.ch) || isWide(c.ch) || (e + 1 < chars.count && isWide(chars[e + 1].ch)) { lastBreak = e + 1 }
                    e += 1
                }
                if e < chars.count && lastBreak > s { e = lastBreak }
                // Spaces at a break hang past the edge.
                while e < chars.count && isTextSpace(chars[e].ch) { e += 1 }
                breaks.append((s, e))
                s = e
            }
        }
        let align = pstyle["align"]?.stringValue ?? "left"
        for (li, (s, e)) in breaks.enumerated() {
            let lineChars = Array(chars[s ..< e])
            var visibleEnd = lineChars.count
            while visibleEnd > 0 && isTextSpace(lineChars[visibleEnd - 1].ch) { visibleEnd -= 1 }
            // Metrics: the tallest font on the line (a vertical column: the widest em); an empty line uses the style where it starts.
            var styles: [Int] = []
            if lineChars.isEmpty {
                styles = [runIndexAt(runs, Double(Swift.min(para.start, Swift.max(0, text.count - 1))))]
            } else {
                for c in lineChars where !styles.contains(c.style) { styles.append(c.style) }
            }
            var ascent = 0.0
            var descent = 0.0
            var leading = 0.0
            for si in styles {
                let st = style(si)
                if vertical {
                    ascent = JS.max(ascent, st.fontSize / 2)
                    descent = ascent
                } else {
                    let m = shaper.metrics(resolvedFont(st))
                    ascent = JS.max(ascent, m.ascent)
                    descent = JS.max(descent, m.descent)
                }
                leading = JS.max(leading, st.num("leading") ?? autoLeading * st.fontSize)
            }
            if first {
                y = box != nil || layer.originTop ? ascent : 0
                first = false
            } else {
                y += leading
            }
            let indent = startIndent + (li == 0 ? firstIndent : 0)
            var width = 0.0
            for k in 0 ..< visibleEnd { width += lineChars[k].advance }
            let lastLine = li == breaks.count - 1
            let spaces = lineChars[0 ..< visibleEnd].filter { isTextSpace($0.ch) }.count
            var extraPerSpace = 0.0
            if box != nil && align == "justify" && !lastLine {
                let avail = inlineSize - startIndent - endIndent - (li == 0 ? firstIndent : 0)
                if spaces > 0 && avail > width { extraPerSpace = (avail - width) / Double(spaces) }
            }
            let x0: Double
            let fullWidth = width + extraPerSpace * Double(spaces)
            if box != nil {
                let avail = inlineSize - startIndent - endIndent - (li == 0 ? firstIndent : 0)
                x0 = indent + (align == "center" ? (avail - fullWidth) / 2 : align == "right" ? avail - fullWidth : 0)
            } else {
                x0 = indent + (align == "center" ? -fullWidth / 2 : align == "right" ? -fullWidth : 0)
            }
            var laid: [LaidChar] = []
            var x = x0
            for c in lineChars {
                let adv = c.advance + (isTextSpace(c.ch) ? extraPerSpace : 0)
                laid.append(LaidChar(index: c.index, x: x, advance: adv))
                x += adv
            }
            // Fragments: same style (and, vertically, the same upright or sideways setting), consecutive.
            var fragments: [LaidFragment] = []
            var k = 0
            while k < lineChars.count {
                let si = lineChars[k].style
                let st = style(si)
                let up = lineChars[k].up != nil
                var m = k + 1
                while m < lineChars.count && lineChars[m].style == si && (lineChars[m].up != nil) == up { m += 1 }
                let font = resolvedFont(st)
                let fx = laid[k].x
                var carets = [0.0]
                for q in k ..< m { carets.append(laid[q].x + laid[q].advance - fx) }
                let shift = st.num("baselineShift") ?? 0
                var fy = y - shift
                if vertical && !up {
                    // Sideways text: its em box centred on the column.
                    let hm = shaper.metrics(font)
                    fy = y + (hm.ascent - hm.descent) / 2 - shift
                }
                var fragment = LaidFragment(start: lineChars[k].index, end: lineChars[m - 1].index + 1, style: st, font: font, family: font.family, x: fx, y: fy, carets: carets,
                                            spaced: truthy(st["tracking"]) || extraPerSpace > 0 || up)
                if vertical {
                    var glyphs: [LaidGlyph] = []
                    for q in k ..< m {
                        let c = lineChars[q]
                        let lc = laid[q]
                        if c.low && q > k {
                            glyphs[glyphs.count - 1].length = 2
                            if !up { glyphs[glyphs.count - 1].advance += lc.advance }
                            continue
                        }
                        let p = textApply(matrix, lc.x, fy)
                        if let u = c.up {
                            glyphs.append(LaidGlyph(index: c.index, length: 1, x: p.x - u.width / 2 + u.dx, y: p.y + u.originY + u.dy, angle: 0, advance: u.width, ascent: u.originY + u.dy, descent: lc.advance - u.originY - u.dy, vert: u.vert))
                        } else {
                            glyphs.append(LaidGlyph(index: c.index, length: 1, x: p.x, y: p.y, angle: 90, advance: lc.advance, ascent: fy - (y - ascent), descent: y + descent - fy, vert: false))
                        }
                    }
                    fragment.upright = up
                    fragment.glyphs = glyphs
                }
                fragments.append(fragment)
                k = m
            }
            let lineStart = lineChars.first?.index ?? para.start
            lines.append(LaidLine(start: lineStart, end: lineChars.last.map { $0.index + 1 } ?? para.start, baseline: y, ascent: ascent, descent: descent, x: x0, width: width, chars: laid, fragments: fragments, matrix: matrix))
        }
        y += pstyle.num("spaceAfter") ?? 0
    }
    let bounds: VectorBounds
    if let box {
        bounds = VectorBounds(x: 0, y: 0, width: box.width, height: box.height)
    } else {
        var x0 = Double.infinity
        var x1 = -Double.infinity
        for l in lines {
            x0 = JS.min(x0, l.x)
            x1 = JS.max(x1, l.x + l.width)
        }
        if !x0.isFinite {
            x0 = 0
            x1 = 0
        }
        let top = lines.first.map { $0.baseline - $0.ascent } ?? 0
        let bottom = lines.last.map { $0.baseline + $0.descent } ?? 0
        bounds = transformTextRect(matrix, VectorBounds(x: x0, y: top, width: JS.max(0, x1 - x0), height: JS.max(0, bottom - top)))
    }
    return TextLayout(lines: lines, bounds: bounds, missingFonts: missing, orientation: vertical ? "vertical" : "horizontal", matrix: matrix)
}

// MARK: - Carets and hit testing

/// The text index nearest a text-space point (for clicks; `textIndexAt`).
public func textIndexAt(_ layout: TextLayout, _ point: Vec2) -> Int {
    guard var line = layout.lines.last else { return 0 }
    let p = textToLineSpace(layout, point)
    for l in layout.lines where p.y <= l.baseline + l.descent {
        line = l
        break
    }
    guard let lastChar = line.chars.last else { return line.start }
    for c in line.chars where p.x < c.x + c.advance / 2 { return c.index }
    return lastChar.index + 1
}

/// A caret (`caretAt`): in line space its x and the line's top and bottom, in text space the segment it draws.
public struct TextCaret: Equatable, Sendable {
    public var x: Double
    public var top: Double
    public var bottom: Double
    public var line: Int
    public var from: Vec2
    public var to: Vec2
}

/// The caret at text index `index` (`caretAt`).
public func caretAt(_ layout: TextLayout, _ index: Int) -> TextCaret {
    let lines = layout.lines
    func caret(_ x: Double, _ l: LaidLine, _ line: Int) -> TextCaret {
        let top = l.baseline - l.ascent
        let bottom = l.baseline + l.descent
        return TextCaret(x: x, top: top, bottom: bottom, line: line, from: textApply(l.matrix, x, top), to: textApply(l.matrix, x, bottom))
    }
    if lines.isEmpty { return TextCaret(x: 0, top: 0, bottom: 0, line: 0, from: Vec2(0, 0), to: Vec2(0, 0)) }
    for li in lines.indices {
        let l = lines[li]
        if li + 1 < lines.count {
            let next = lines[li + 1]
            if index >= next.start && (!next.chars.isEmpty || index > l.end || next.start > l.end) { continue }
        }
        let c = l.chars.first { $0.index == index }
        let prev = l.chars.first { $0.index == index - 1 }
        return caret(c.map(\.x) ?? prev.map { $0.x + $0.advance } ?? l.x, l, li)
    }
    let l = lines[lines.count - 1]
    return caret(l.x + l.width, l, lines.count - 1)
}

/// Quads (text space, four corners each) covering the characters of [start, end), one per line (`textSelectionQuads`).
public func textSelectionQuads(_ layout: TextLayout, _ start: Int, _ end: Int) -> [[Vec2]] {
    var out: [[Vec2]] = []
    if end <= start { return out }
    for l in layout.lines {
        let chars = l.chars.filter { $0.index >= start && $0.index < end }
        guard let a = chars.first, let b = chars.last else { continue }
        let x0 = a.x
        let x1 = b.x + b.advance
        let top = l.baseline - l.ascent
        let bottom = l.baseline + l.descent
        out.append([textApply(l.matrix, x0, top), textApply(l.matrix, x1, top), textApply(l.matrix, x1, bottom), textApply(l.matrix, x0, bottom)])
    }
    return out
}

// MARK: - Outlines

/// Underline and strike-through bars of a fragment, text space, as rectangles (`textDecorations`).
public func textDecorations(_ f: LaidFragment, _ l: LaidLine) -> [VectorBounds] {
    var out: [VectorBounds] = []
    let t = JS.max(1, f.style.fontSize / 15)
    let w = f.carets[f.carets.count - 1]
    if let m = l.matrix {
        let centre = l.baseline - (f.style.num("baselineShift") ?? 0)
        if f.style.flag("underline") { out.append(transformTextRect(m, VectorBounds(x: f.x, y: centre - l.ascent, width: w, height: t))) }
        if f.style.flag("strikethrough") { out.append(transformTextRect(m, VectorBounds(x: f.x, y: centre - t / 2, width: w, height: t))) }
        return out
    }
    if f.style.flag("underline") { out.append(VectorBounds(x: f.x, y: f.y + JS.max(t, l.descent * 0.35), width: w, height: t)) }
    if f.style.flag("strikethrough") { out.append(VectorBounds(x: f.x, y: f.y - l.ascent * 0.3 - t / 2, width: w, height: t)) }
    return out
}

/// A rectangle as a closed path (`textRectPath`).
public func textRectPath(_ r: VectorBounds) -> BezierPath {
    [.M(x: r.x, y: r.y), .L(x: r.x + r.width, y: r.y), .L(x: r.x + r.width, y: r.y + r.height), .L(x: r.x, y: r.y + r.height), .Z]
}

/// A path turned 90° clockwise about the origin, then moved to (`x`, `y`) (`turnPath`).
private func turnPath(_ path: BezierPath, _ x: Double, _ y: Double) -> BezierPath {
    path.map { c in
        switch c {
        case let .M(px, py): .M(x: x - py, y: y + px)
        case let .L(px, py): .L(x: x - py, y: y + px)
        case let .Q(x1, y1, px, py): .Q(x1: x - y1, y1: y + x1, x: x - py, y: y + px)
        case let .C(x1, y1, x2, y2, px, py): .C(x1: x - y1, y1: y + x1, x2: x - y2, y2: y + x2, x: x - py, y: y + px)
        default: c
        }
    }
}

/// The text of a fragment as outlines (one placement per character when spaced or vertical), text
/// space (`textFragmentOutline`). Empty with a shaper that has no outlines.
public func textFragmentOutline(_ shaper: VectorTextShaper, _ text: [UInt16], _ f: LaidFragment) -> BezierPath {
    if let glyphs = f.glyphs {
        var out: BezierPath = []
        for g in glyphs {
            let ch = Array(text[g.index ..< Swift.min(g.index + g.length, text.count)])
            if isTextSpace(ch) { continue }
            if g.angle != 0 { out += turnPath(shaper.outline(ch, f.font, x: 0, y: 0, vertical: g.vert) ?? [], g.x, g.y) } else { out += shaper.outline(ch, f.font, x: g.x, y: g.y, vertical: g.vert) ?? [] }
        }
        return out
    }
    let s = Array(text[f.start ..< f.end])
    if !f.spaced { return shaper.outline(s, f.font, x: f.x, y: f.y, vertical: false) ?? [] }
    var out: BezierPath = []
    for k in s.indices where !isTextSpace(s[k]) { out += shaper.outline([s[k]], f.font, x: f.x + f.carets[k], y: f.y, vertical: false) ?? [] }
    return out
}
