import Foundation
import PixerateCore
import PixerateRaster

public typealias ChartTextMeasure = @Sendable (String, Double, Double?) -> Double

public struct ChartDomainBounds: Sendable, Equatable {
    public var min: Double
    public var max: Double

    public init(min: Double, max: Double) {
        self.min = min
        self.max = max
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let min = obj["min"]?.doubleValue,
              let max = obj["max"]?.doubleValue else { return nil }
        self.min = min
        self.max = max
    }
}

public struct ChartPointReadout: Sendable, Equatable {
    public var seriesId: String
    public var index: Int

    public init(seriesId: String, index: Int) {
        self.seriesId = seriesId
        self.index = index
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let seriesId = obj["seriesId"]?.stringValue,
              let index = obj["index"]?.intValue else { return nil }
        self.seriesId = seriesId
        self.index = index
    }
}

public struct ChartThemePatch: Sendable, Equatable {
    public var background: String?
    public var surface: String?
    public var text: String?
    public var mutedText: String?
    public var grid: String?
    public var axis: String?
    public var selection: String?
    public var positive: String?
    public var negative: String?
    public var fontFamily: String?
    public var fontSize: Double?
    public var titleSize: Double?

    public init(
        background: String? = nil,
        surface: String? = nil,
        text: String? = nil,
        mutedText: String? = nil,
        grid: String? = nil,
        axis: String? = nil,
        selection: String? = nil,
        positive: String? = nil,
        negative: String? = nil,
        fontFamily: String? = nil,
        fontSize: Double? = nil,
        titleSize: Double? = nil
    ) {
        self.background = background
        self.surface = surface
        self.text = text
        self.mutedText = mutedText
        self.grid = grid
        self.axis = axis
        self.selection = selection
        self.positive = positive
        self.negative = negative
        self.fontFamily = fontFamily
        self.fontSize = fontSize
        self.titleSize = titleSize
    }

    public init(theme: ChartTheme) {
        self.background = theme.background
        self.surface = theme.surface
        self.text = theme.text
        self.mutedText = theme.mutedText
        self.grid = theme.grid
        self.axis = theme.axis
        self.selection = theme.selection
        self.positive = theme.positive
        self.negative = theme.negative
        self.fontFamily = theme.fontFamily
        self.fontSize = theme.fontSize
        self.titleSize = theme.titleSize
    }

    public init?(json: JSONValue) {
        guard let obj = json.objectValue else { return nil }
        self.background = obj["background"]?.stringValue
        self.surface = obj["surface"]?.stringValue
        self.text = obj["text"]?.stringValue
        self.mutedText = obj["mutedText"]?.stringValue
        self.grid = obj["grid"]?.stringValue
        self.axis = obj["axis"]?.stringValue
        self.selection = obj["selection"]?.stringValue
        self.positive = obj["positive"]?.stringValue
        self.negative = obj["negative"]?.stringValue
        self.fontFamily = obj["fontFamily"]?.stringValue
        self.fontSize = obj["fontSize"]?.doubleValue
        self.titleSize = obj["titleSize"]?.doubleValue
    }

    public func applied(to base: ChartTheme) -> ChartTheme {
        ChartTheme(
            background: background ?? base.background,
            surface: surface ?? base.surface,
            text: text ?? base.text,
            mutedText: mutedText ?? base.mutedText,
            grid: grid ?? base.grid,
            axis: axis ?? base.axis,
            selection: selection ?? base.selection,
            positive: positive ?? base.positive,
            negative: negative ?? base.negative,
            fontFamily: fontFamily ?? base.fontFamily,
            fontSize: fontSize ?? base.fontSize,
            titleSize: titleSize ?? base.titleSize
        )
    }
}

public struct ChartLayoutOptions: Sendable {
    public var width: Double
    public var height: Double
    public var theme: ChartThemePatch?
    public var selection: ChartSelection?
    public var measureText: ChartTextMeasure?
    public var emptyMessage: String?
    public var valueDomain: ChartDomainBounds?
    public var valueDomain2: ChartDomainBounds?
    public var xDomain: ChartDomainBounds?
    public var readout: ChartPointReadout?
    public var raceFrame: Double?

    public init(
        width: Double,
        height: Double,
        theme: ChartThemePatch? = nil,
        selection: ChartSelection? = nil,
        measureText: ChartTextMeasure? = nil,
        emptyMessage: String? = nil,
        valueDomain: ChartDomainBounds? = nil,
        valueDomain2: ChartDomainBounds? = nil,
        xDomain: ChartDomainBounds? = nil,
        readout: ChartPointReadout? = nil,
        raceFrame: Double? = nil
    ) {
        self.width = width
        self.height = height
        self.theme = theme
        self.selection = selection
        self.measureText = measureText
        self.emptyMessage = emptyMessage
        self.valueDomain = valueDomain
        self.valueDomain2 = valueDomain2
        self.xDomain = xDomain
        self.readout = readout
        self.raceFrame = raceFrame
    }

    public init(json: JSONValue) {
        let obj = json.objectValue ?? JSONObject()
        self.width = obj["width"]?.doubleValue ?? 640
        self.height = obj["height"]?.doubleValue ?? 400
        self.theme = obj["theme"].flatMap(ChartThemePatch.init(json:))
        self.selection = obj["selection"].flatMap(ChartSelection.init(json:))
        self.measureText = nil
        self.emptyMessage = obj["emptyMessage"]?.stringValue
        self.valueDomain = obj["valueDomain"].flatMap(ChartDomainBounds.init(json:))
        self.valueDomain2 = obj["valueDomain2"].flatMap(ChartDomainBounds.init(json:))
        self.xDomain = obj["xDomain"].flatMap(ChartDomainBounds.init(json:))
        self.readout = obj["readout"].flatMap(ChartPointReadout.init(json:))
        self.raceFrame = obj["raceFrame"]?.doubleValue
    }
}

/// A DOM-free text width estimate (average glyph ≈ 0.56 em, bold ≈ 0.6 em).
public func estimateChartTextWidth(_ text: String, _ size: Double, _ weight: Double? = nil) -> Double {
    let w = weight ?? 400
    return Double(text.utf16.count) * size * (w >= 600 ? 0.6 : 0.56)
}

/// Whether two selections point at the same thing.
public func sameChartSelection(_ a: ChartSelection?, _ b: ChartSelection?) -> Bool {
    guard let a, let b else { return false }
    return a == b
}

/// Black or white text for a label drawn on `fill` (#rgb, #rrggbb or rgb()), by perceived
/// luminance (0.299 R + 0.587 G + 0.114 B). Unparseable colours (CSS variables) get white.
public func contrastingTextColor(_ fill: String) -> String {
    var rgb: [Double]? = nil
    let trimmed = fill.jsTrimmed
    if let hexMatch = matchRegexGroups(#"^#([0-9a-f]{3}|[0-9a-f]{6})$"#, in: trimmed, caseInsensitive: true) {
        let raw = hexMatch[1]
        let h: String
        if raw.count == 3 {
            h = raw.map { "\($0)\($0)" }.joined()
        } else {
            h = raw
        }
        let chars = Array(h)
        rgb = [0, 2, 4].map { i in
            Double(Int(String(chars[i...i + 1]), radix: 16) ?? 0)
        }
    } else if let fnMatch = matchRegexGroups(#"^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)"#, in: trimmed, caseInsensitive: true) {
        rgb = [1, 2, 3].map { i in Double(fnMatch[i]) ?? .nan }
    }
    guard let rgb, rgb.count == 3 else { return "#ffffff" }
    let luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255.0
    return luminance > 0.5 ? "#0f172a" : "#ffffff"
}

private func matchRegexGroups(_ pattern: String, in text: String, caseInsensitive: Bool = false) -> [String]? {
    let opts: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
    guard let regex = try? NSRegularExpression(pattern: pattern, options: opts) else { return nil }
    let nsRange = NSRange(text.startIndex..<text.endIndex, in: text)
    guard let match = regex.firstMatch(in: text, options: [], range: nsRange) else { return nil }
    var out: [String] = []
    for i in 0..<match.numberOfRanges {
        let r = match.range(at: i)
        if let swiftRange = Range(r, in: text) {
            out.append(String(text[swiftRange]))
        } else {
            out.append("")
        }
    }
    return out
}

public func r2(_ n: Double) -> Double {
    JS.round(n * 100.0) / 100.0
}

internal func r2s(_ n: Double) -> String {
    JSONValue.jsString(r2(n))
}

/// Shared state while one scene is laid out.
internal final class LayoutCtx {
    var spec: ChartSpec
    var options: ChartLayoutOptions
    var theme: ChartTheme
    var measure: ChartTextMeasure
    var fs: Double
    var width: Double
    var height: Double
    var marks: [ChartMark]
    var warnings: [ChartWarning]
    var selection: ChartSelection?

    init(
        spec: ChartSpec,
        options: ChartLayoutOptions,
        theme: ChartTheme,
        measure: @escaping ChartTextMeasure,
        fs: Double,
        width: Double,
        height: Double,
        marks: [ChartMark],
        warnings: [ChartWarning],
        selection: ChartSelection?
    ) {
        self.spec = spec
        self.options = options
        self.theme = theme
        self.measure = measure
        self.fs = fs
        self.width = width
        self.height = height
        self.marks = marks
        self.warnings = warnings
        self.selection = selection
    }

    func isSelected(_ target: ChartSelection) -> Bool {
        sameChartSelection(selection, target)
    }

    func seriesSelected(_ id: String) -> Bool {
        if case .series(let seriesId) = selection {
            return seriesId == id
        }
        return false
    }

    func outline(_ key: String, _ box: ChartRect) {
        marks.append(.rect(
            key: key,
            role: .selection,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            fill: "none",
            stroke: theme.selection,
            strokeWidth: 1,
            radius: 3
        ))
    }

    func warn(_ code: ChartWarningCode, _ message: String) {
        if !warnings.contains(where: { $0.code == code && $0.message == message }) {
            warnings.append(ChartWarning(code: code, message: message))
        }
    }
}

/// What a family layout adds to the scene.
internal struct FamilyResult {
    var plot: ChartRect
    var valueScale: ChartValueScale? = nil
    var valueScale2: ChartValueScale? = nil
    var xScale: ChartValueScale? = nil
    var categoryScale: ChartCategoryScale? = nil
    var percent: Bool? = nil
}

internal struct Pt {
    var c: Double
    var v: Double
    var i: Int? = nil
}

/// Path through points (in category/value pixel space) with the chosen curve; `map` turns them into x/y.
internal func curvePath(
    _ points: [Pt],
    _ curve: ChartCurve,
    _ map: (Pt) -> (Double, Double),
    _ moveFirst: Bool = true
) -> String {
    guard !points.isEmpty else { return "" }
    let xy = points.map(map)
    var d = "\(moveFirst ? "M" : "L")\(r2s(xy[0].0)),\(r2s(xy[0].1))"
    if points.count == 1 { return d }
    if curve == .step {
        for i in 1..<points.count {
            let mid = (points[i - 1].c + points[i].c) / 2.0
            let a = map(Pt(c: mid, v: points[i - 1].v))
            let b = map(Pt(c: mid, v: points[i].v))
            d += "L\(r2s(a.0)),\(r2s(a.1))L\(r2s(b.0)),\(r2s(b.1))L\(r2s(xy[i].0)),\(r2s(xy[i].1))"
        }
        return d
    }
    if curve == .smooth && points.count > 2 {
        let n = points.count
        let dc: [Double] = (0..<(n - 1)).map { i in points[i + 1].c - points[i].c }
        let slope: [Double] = (0..<(n - 1)).map { i in dc[i] == 0 ? 0 : (points[i + 1].v - points[i].v) / dc[i] }
        let tangent: [Double] = (0..<n).map { i in
            if i == 0 { return slope[0] }
            if i == n - 1 { return slope[n - 2] }
            let a = slope[i - 1]
            let b = slope[i]
            if a * b <= 0 { return 0 }
            let wa = 2.0 * dc[i] + dc[i - 1]
            let wb = dc[i] + 2.0 * dc[i - 1]
            return (wa + wb) / (wa / a + wb / b)
        }
        for i in 1..<n {
            let h = dc[i - 1] / 3.0
            let p0 = points[i - 1]
            let p1 = points[i]
            let a = map(Pt(c: p0.c + h, v: p0.v + tangent[i - 1] * h))
            let b = map(Pt(c: p1.c - h, v: p1.v - tangent[i] * h))
            d += "C\(r2s(a.0)),\(r2s(a.1)) \(r2s(b.0)),\(r2s(b.1)) \(r2s(xy[i].0)),\(r2s(xy[i].1))"
        }
        return d
    }
    for i in 1..<xy.count {
        d += "L\(r2s(xy[i].0)),\(r2s(xy[i].1))"
    }
    return d
}

internal func arcPath(_ cx: Double, _ cy: Double, _ outer: Double, _ inner: Double, _ start: Double, _ endInput: Double) -> String {
    var end = endInput
    let full = end - start >= .pi * 2.0 - 1e-9
    if full { end = start + .pi * 2.0 - 1e-4 }
    func p(_ r: Double, _ a: Double) -> String {
        "\(r2s(cx + r * JS.sin(a))),\(r2s(cy - r * JS.cos(a)))"
    }
    let large = end - start > .pi ? 1 : 0
    var d = "M\(p(outer, start))A\(r2s(outer)),\(r2s(outer)) 0 \(large) 1 \(p(outer, end))"
    if inner > 0 {
        d += "L\(p(inner, end))A\(r2s(inner)),\(r2s(inner)) 0 \(large) 0 \(p(inner, start))Z"
    } else {
        d += "L\(r2s(cx)),\(r2s(cy))Z"
    }
    return d
}

internal func truncate(_ text: String, _ maxWidth: Double, _ size: Double, _ measure: ChartTextMeasure) -> String {
    if measure(text, size, nil) <= maxWidth { return text }
    var units = Array(text.utf16)
    while units.count > 1 && measure(String(decoding: units, as: UTF16.self) + "…", size, nil) > maxWidth {
        units.removeLast()
    }
    return String(decoding: units, as: UTF16.self) + "…"
}

/// The outline of a point marker centred on (cx, cy) with "radius" r, as an SVG path.
internal func markerPath(_ shape: ChartMarker, _ cx: Double, _ cy: Double, _ r: Double) -> String {
    switch shape {
    case .square:
        return "M\(r2s(cx - r)),\(r2s(cy - r))H\(r2s(cx + r))V\(r2s(cy + r))H\(r2s(cx - r))Z"
    case .diamond:
        let d = r * 1.3
        return "M\(r2s(cx)),\(r2s(cy - d))L\(r2s(cx + d)),\(r2s(cy))L\(r2s(cx)),\(r2s(cy + d))L\(r2s(cx - d)),\(r2s(cy))Z"
    case .triangle:
        let d = r * 1.3
        return "M\(r2s(cx)),\(r2s(cy - d))L\(r2s(cx + d * 0.87)),\(r2s(cy + d * 0.5))L\(r2s(cx - d * 0.87)),\(r2s(cy + d * 0.5))Z"
    case .cross:
        let d = r
        return "M\(r2s(cx - d)),\(r2s(cy - d))L\(r2s(cx + d)),\(r2s(cy + d))M\(r2s(cx - d)),\(r2s(cy + d))L\(r2s(cx + d)),\(r2s(cy - d))"
    case .circle, .none:
        return ""
    }
}

/// The tick count for an axis `length` pixels long (about one per 56 px, 2–10).
internal func tickCount(_ length: Double) -> Double {
    Swift.max(2.0, Swift.min(10.0, JS.round(length / 56.0)))
}

/// A value scale over [lo, hi] for an axis `length` pixels long: the axis' fixed ends and
/// step win, then `frozen` (a drag in progress) fixes both ends. `headroom` adds 5% above a
/// maximum that lands exactly on the top tick (lines and points would touch the frame).
internal func axisScale(
    _ lo: Double,
    _ hi: Double,
    _ length: Double,
    _ axis: ChartAxis,
    _ frozen: ChartDomainBounds? = nil,
    _ headroom: Bool = false
) -> NiceScale {
    let fixedMin: Double? = (frozen != nil && frozen!.min.isFinite) ? frozen!.min : axis.min
    let fixedMax: Double? = (frozen != nil && frozen!.max.isFinite) ? frozen!.max : axis.max
    if axis.scale == .log {
        return niceLogScale(lo, hi, tickCount(length), axis.logBase ?? 10.0, fixedMin, fixedMax)
    }
    let step = axis.step
    if let step, step > 0, lo.isFinite, hi.isFinite {
        var min = fixedMin ?? floor(lo / step + 1e-9) * step
        var max = fixedMax ?? ceil(hi / step - 1e-9) * step
        if !(max > min) { max = min + step }
        let first = ceil(min / step - 1e-9)
        let last = floor(max / step + 1e-9)
        if last - first <= 200 {
            func clean(_ n: Double) -> Double {
                abs(n) < 1e-12 ? 0 : (Double(jsToPrecision(n, 12)) ?? n)
            }
            min = clean(min)
            max = clean(max)
            var ticks: [Double] = []
            var i = Int(first)
            let lastInt = Int(last)
            while i <= lastInt {
                ticks.append(clean(Double(i) * step))
                i += 1
            }
            return NiceScale(min: min, max: max, step: step, ticks: ticks)
        }
    }
    var scale = niceScale(lo, hi, tickCount(length), fixedMin, fixedMax)
    let roomy = hi + (hi - lo) * 0.05
    if headroom && fixedMax == nil && hi != 0 && hi > lo && scale.max == hi && roomy.isFinite {
        scale = niceScale(lo, roomy, tickCount(length), fixedMin, fixedMax)
    }
    return scale
}

/// Liang–Barsky: the part of segment a→b inside `rect`, or nil.
internal func clipSegment(
    _ a: (Double, Double),
    _ b: (Double, Double),
    _ rect: ChartRect
) -> ((Double, Double), (Double, Double))? {
    var t0 = 0.0
    var t1 = 1.0
    let dx = b.0 - a.0
    let dy = b.1 - a.1
    let checks: [(Double, Double)] = [
        (-dx, a.0 - rect.x),
        (dx, rect.x + rect.width - a.0),
        (-dy, a.1 - rect.y),
        (dy, rect.y + rect.height - a.1)
    ]
    for (p, q) in checks {
        if p == 0 {
            if q < 0 { return nil }
            continue
        }
        let r = q / p
        if p < 0 {
            if r > t1 { return nil }
            if r > t0 { t0 = r }
        } else {
            if r < t0 { return nil }
            if r < t1 { t1 = r }
        }
    }
    return (
        (a.0 + t0 * dx, a.1 + t0 * dy),
        (a.0 + t1 * dx, a.1 + t1 * dy)
    )
}

/// A polyline clipped to `rect` as path data (separate runs where it leaves and re-enters).
internal func clippedPolyline(_ points: [(Double, Double)], _ rect: ChartRect) -> String {
    var d = ""
    var open = false
    var last: (Double, Double)? = nil
    guard points.count > 1 else { return d }
    for i in 1..<points.count {
        guard let seg = clipSegment(points[i - 1], points[i], rect) else {
            open = false
            continue
        }
        let (p, q) = seg
        if !open || last == nil || abs(last!.0 - p.0) > 0.01 || abs(last!.1 - p.1) > 0.01 {
            d += "M\(r2s(p.0)),\(r2s(p.1))"
        }
        d += "L\(r2s(q.0)),\(r2s(q.1))"
        last = q
        open = true
    }
    return d
}
