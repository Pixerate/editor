import CoreGraphics
import CoreText
import Foundation
import PixerateGeometry
import PixerateVector

/// The family a CSS generic name draws with on Apple platforms.
private let GENERIC_FAMILIES: [String: String] = [
    "sans-serif": "Helvetica Neue", "system-ui": "Helvetica Neue", "ui-sans-serif": "Helvetica Neue",
    "serif": "Times New Roman", "ui-serif": "Times New Roman",
    "monospace": "Menlo", "ui-monospace": "Menlo",
    "cursive": "Snell Roundhand", "fantasy": "Papyrus", "ui-rounded": "Arial Rounded MT Bold",
]

/// A CSS weight (100–900) as a CoreText weight trait (-1…1).
private func coreTextWeight(_ css: Double) -> CGFloat {
    let table: [(Double, CGFloat)] = [(100, -0.8), (200, -0.6), (300, -0.4), (400, 0), (500, 0.23), (600, 0.3), (700, 0.4), (800, 0.56), (900, 0.62)]
    let w = css.isFinite ? css : 400
    if w <= 100 { return -0.8 }
    if w >= 900 { return 0.62 }
    for i in 1..<table.count where w <= table[i].0 {
        let (w0, t0) = table[i - 1]
        let (w1, t1) = table[i]
        let k = CGFloat((w - w0) / (w1 - w0))
        return t0 + (t1 - t0) * k
    }
    return 0
}

/// The first family of a CSS family list, unquoted.
private func firstFamily(_ family: String) -> String {
    let first = family.split(separator: ",").first.map(String.init) ?? family
    return first.trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
}

private let fontCache = FontCache()

private final class FontCache: @unchecked Sendable {
    private let lock = NSLock()
    private var fonts: [String: CTFont] = [:]

    func font(_ key: String, _ make: () -> CTFont) -> CTFont {
        lock.lock()
        defer { lock.unlock() }
        if let f = fonts[key] { return f }
        let f = make()
        fonts[key] = f
        return f
    }
}

/// The CoreText font that draws `font` (a generic family maps to a system family; a missing one falls back to Helvetica Neue).
public func coreTextFont(_ font: TextFont) -> CTFont {
    let family = firstFamily(font.family)
    let key = "\(family)|\(font.weight)|\(font.italic)|\(font.size)|\(font.postScriptName ?? "")"
    return fontCache.font(key) {
        let size = CGFloat(font.size.isFinite && font.size > 0 ? font.size : 24)
        if let ps = font.postScriptName, !ps.isEmpty {
            let f = CTFontCreateWithName(ps as CFString, size, nil)
            if (CTFontCopyPostScriptName(f) as String) == ps { return f }
        }
        let name = GENERIC_FAMILIES[family.lowercased()] ?? family
        var traits: [CFString: Any] = [kCTFontWeightTrait: coreTextWeight(font.weight)]
        if font.italic { traits[kCTFontSymbolicTrait] = CTFontSymbolicTraits.traitItalic.rawValue }
        let attributes: [CFString: Any] = [kCTFontFamilyNameAttribute: name, kCTFontTraitsAttribute: traits]
        let descriptor = CTFontDescriptorCreateWithAttributes(attributes as CFDictionary)
        return CTFontCreateWithFontDescriptor(descriptor, size, nil)
    }
}

/**
 * A text shaper on CoreText (the TS core's browser shaper, for apps): real fonts for measuring,
 * line breaking and glyph outlines, so text draws with its fonts and Create Outlines works.
 * Families are the system's (CSS generics map to Helvetica Neue, Times New Roman, Menlo, …);
 * a family that isn't installed resolves to the fallback with `available: false`. Kerning comes
 * from the font. Conformance scenarios keep the metric shaper, which every implementation matches.
 * Set it for the process with `setVectorTextShaper(CoreTextVectorShaper())` (`VectorEditorModel`
 * does unless told otherwise).
 */
public final class CoreTextVectorShaper: VectorTextShaper, @unchecked Sendable {
    public let id: String

    public init(id: String = "coretext") { self.id = id }

    public func resolve(_ font: TextFont) -> (family: String, available: Bool) {
        let family = firstFamily(font.family)
        if GENERIC_FAMILIES[family.lowercased()] != nil { return (family, true) }
        let ct = coreTextFont(font)
        let actual = CTFontCopyFamilyName(ct) as String
        return actual.caseInsensitiveCompare(family) == .orderedSame ? (family, true) : (actual, false)
    }

    public func metrics(_ font: TextFont) -> (ascent: Double, descent: Double) {
        let ct = coreTextFont(font)
        return (Double(CTFontGetAscent(ct)), Double(CTFontGetDescent(ct)))
    }

    private func line(_ text: [UInt16], _ font: TextFont) -> CTLine {
        let string = String(decoding: text, as: UTF16.self)
        let attributed = NSAttributedString(string: string, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): coreTextFont(font)])
        return CTLineCreateWithAttributedString(attributed)
    }

    public func measure(_ text: [UInt16], _ font: TextFont) -> [Double] {
        if text.isEmpty { return [0] }
        let l = line(text, font)
        var out: [Double] = []
        out.reserveCapacity(text.count + 1)
        var last = 0.0
        for i in 0...text.count {
            var x = Double(CTLineGetOffsetForStringIndex(l, i, nil))
            // Carets never run backwards (inside a ligature or a surrogate pair CoreText may say 0).
            if i > 0 && x < last { x = last }
            out.append(x)
            last = x
        }
        let width = Double(CTLineGetTypographicBounds(l, nil, nil, nil))
        if width > out[text.count] { out[text.count] = width }
        return out
    }

    public var hasOutlines: Bool { true }

    public func outline(_ text: [UInt16], _ font: TextFont, x: Double, y: Double, vertical: Bool) -> BezierPath? {
        if text.isEmpty { return [] }
        let l = line(text, font)
        var out: BezierPath = []
        let runs = (CTLineGetGlyphRuns(l) as? [CTRun]) ?? []
        for run in runs {
            let count = CTRunGetGlyphCount(run)
            if count == 0 { continue }
            let attributes = CTRunGetAttributes(run) as NSDictionary
            let runFont = (attributes[kCTFontAttributeName as String]).map { $0 as! CTFont } ?? coreTextFont(font)
            var glyphs = [CGGlyph](repeating: 0, count: count)
            var positions = [CGPoint](repeating: .zero, count: count)
            CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
            CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
            for i in 0..<count {
                // Glyph outlines are y up from the baseline: flip them and move them to the pen position.
                var m = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: CGFloat(x) + positions[i].x, ty: CGFloat(y) - positions[i].y)
                guard let path = CTFontCreatePathForGlyph(runFont, glyphs[i], &m) else { continue }
                out += bezierPath(of: path)
            }
        }
        return out
    }

    public func families() -> [String]? {
        let installed = (CTFontManagerCopyAvailableFontFamilyNames() as? [String]) ?? []
        return ["sans-serif", "serif", "monospace"] + installed.filter { !$0.hasPrefix(".") }
    }
}

/// A `CGPath` as absolute path commands.
public func bezierPath(of path: CGPath) -> BezierPath {
    var out: BezierPath = []
    path.applyWithBlock { element in
        let e = element.pointee
        let p = e.points
        switch e.type {
        case .moveToPoint: out.append(.M(x: Double(p[0].x), y: Double(p[0].y)))
        case .addLineToPoint: out.append(.L(x: Double(p[0].x), y: Double(p[0].y)))
        case .addQuadCurveToPoint: out.append(.Q(x1: Double(p[0].x), y1: Double(p[0].y), x: Double(p[1].x), y: Double(p[1].y)))
        case .addCurveToPoint: out.append(.C(x1: Double(p[0].x), y1: Double(p[0].y), x2: Double(p[1].x), y2: Double(p[1].y), x: Double(p[2].x), y: Double(p[2].y)))
        case .closeSubpath: out.append(.Z)
        @unknown default: break
        }
    }
    return out
}
