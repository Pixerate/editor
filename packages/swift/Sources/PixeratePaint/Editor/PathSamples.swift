import Foundation
import PixerateCore
import PixerateRaster

/**
 * Pen samples along vector path data (`paint-editor/path-samples.ts`), so a path can be brushed
 * like a hand-drawn stroke (`stroke_path`): each subpath becomes one stroke, sampled at an even
 * spacing, with an optional pressure profile spread along its length. The path parser and curve
 * flattening are the canvas module's (`canvas/shapeGeometry.ts`, `canvas/pathops/bezier.ts`).
 */

typealias PathPoint = (Double, Double)

/// An absolute path command (`M`, `L`, `Q`, `C`, `A`, `Z`).
enum PathCommand {
    case move(Double, Double)
    case line(Double, Double)
    case quad(Double, Double, Double, Double)
    case cubic(Double, Double, Double, Double, Double, Double)
    case arc(rx: Double, ry: Double, rotation: Double, largeArc: Bool, sweep: Bool, x: Double, y: Double)
    case close
}

private let PARAM_COUNTS: [Character: Int] = ["m": 2, "l": 2, "h": 1, "v": 1, "c": 6, "s": 4, "q": 4, "t": 2, "a": 7, "z": 0]

/// Character scanner for path data (handles `1.5.5`, `1e-3`, `-1-2` and compact arc flags).
private struct PathScanner {
    let text: [Character]
    var pos = 0

    init(_ s: String) { text = Array(s) }

    mutating func skip() {
        while pos < text.count, text[pos].isWhitespace || text[pos] == "," { pos += 1 }
    }

    mutating func command() -> Character? {
        skip()
        guard pos < text.count, "MmLlHhVvCcSsQqTtAaZz".contains(text[pos]) else { return nil }
        pos += 1
        return text[pos - 1]
    }

    mutating func done() -> Bool {
        skip()
        return pos >= text.count
    }

    mutating func number() -> Double? {
        skip()
        let rest = String(text[pos..<Swift.min(text.count, pos + 64)])
        guard let r = rest.range(of: #"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?"#, options: .regularExpression) else { return nil }
        let m = String(rest[r])
        pos += m.count
        guard let v = Double(m), v.isFinite else { return nil }
        return v
    }

    mutating func flag() -> Double? {
        skip()
        guard pos < text.count, text[pos] == "0" || text[pos] == "1" else { return nil }
        pos += 1
        return text[pos - 1] == "1" ? 1 : 0
    }
}

/// Parses SVG path data into absolute commands; parsing stops at the first malformed command.
func parseSvgPath(_ d: String) -> [PathCommand] {
    var scanner = PathScanner(d)
    var commands: [PathCommand] = []
    var cx = 0.0, cy = 0.0, startX = 0.0, startY = 0.0
    var lastControl: (x: Double, y: Double, type: Character)? = nil
    var command: Character? = nil
    while !scanner.done() {
        if let letter = scanner.command() {
            command = letter
            if letter == "z" || letter == "Z" {
                commands.append(.close)
                cx = startX
                cy = startY
                lastControl = nil
                continue
            }
        } else if command == nil || command == "z" || command == "Z" {
            break
        }
        let lower = Character(command!.lowercased())
        let count = PARAM_COUNTS[lower] ?? 0
        var args: [Double] = []
        for k in 0..<count {
            guard let v = lower == "a" && (k == 3 || k == 4) ? scanner.flag() : scanner.number() else { return commands }
            args.append(v)
        }
        let rel = command!.isLowercase
        let ox = rel ? cx : 0, oy = rel ? cy : 0
        switch lower {
        case "m":
            cx = args[0] + ox
            cy = args[1] + oy
            startX = cx
            startY = cy
            commands.append(.move(cx, cy))
            lastControl = nil
            command = rel ? "l" : "L"
        case "l":
            cx = args[0] + ox
            cy = args[1] + oy
            commands.append(.line(cx, cy))
            lastControl = nil
        case "h":
            cx = args[0] + (rel ? cx : 0)
            commands.append(.line(cx, cy))
            lastControl = nil
        case "v":
            cy = args[0] + (rel ? cy : 0)
            commands.append(.line(cx, cy))
            lastControl = nil
        case "c":
            let c = (args[0] + ox, args[1] + oy, args[2] + ox, args[3] + oy, args[4] + ox, args[5] + oy)
            commands.append(.cubic(c.0, c.1, c.2, c.3, c.4, c.5))
            lastControl = (c.2, c.3, "C")
            cx = c.4
            cy = c.5
        case "s":
            let x1 = lastControl?.type == "C" ? 2 * cx - lastControl!.x : cx
            let y1 = lastControl?.type == "C" ? 2 * cy - lastControl!.y : cy
            let c = (x1, y1, args[0] + ox, args[1] + oy, args[2] + ox, args[3] + oy)
            commands.append(.cubic(c.0, c.1, c.2, c.3, c.4, c.5))
            lastControl = (c.2, c.3, "C")
            cx = c.4
            cy = c.5
        case "q":
            let c = (args[0] + ox, args[1] + oy, args[2] + ox, args[3] + oy)
            commands.append(.quad(c.0, c.1, c.2, c.3))
            lastControl = (c.0, c.1, "Q")
            cx = c.2
            cy = c.3
        case "t":
            let x1 = lastControl?.type == "Q" ? 2 * cx - lastControl!.x : cx
            let y1 = lastControl?.type == "Q" ? 2 * cy - lastControl!.y : cy
            let c = (x1, y1, args[0] + ox, args[1] + oy)
            commands.append(.quad(c.0, c.1, c.2, c.3))
            lastControl = (x1, y1, "Q")
            cx = c.2
            cy = c.3
        case "a":
            let x = args[5] + ox, y = args[6] + oy
            commands.append(.arc(rx: abs(args[0]), ry: abs(args[1]), rotation: args[2], largeArc: args[3] != 0, sweep: args[4] != 0, x: x, y: y))
            lastControl = nil
            cx = x
            cy = y
        default:
            break
        }
    }
    return commands
}

/// An elliptical arc as cubic Béziers (at most 90° each); a degenerate one as a line.
private func arcToCubics(_ from: PathPoint, rx rxIn: Double, ry ryIn: Double, rotation: Double, largeArc: Bool, sweep: Bool, x: Double, y: Double) -> [[PathPoint]] {
    let (x0, y0) = from
    if x0 == x && y0 == y { return [] }
    var rx = abs(rxIn), ry = abs(ryIn)
    if rx == 0 || ry == 0 { return [[from, (x, y)]] }
    let phi = (rotation * Double.pi) / 180
    let cos = JS.cos(phi), sin = JS.sin(phi)
    let dx = (x0 - x) / 2, dy = (y0 - y) / 2
    let x1p = cos * dx + sin * dy
    let y1p = -sin * dx + cos * dy
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lambda > 1 {
        let s = lambda.squareRoot()
        rx *= s
        ry *= s
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    var coef = den == 0 ? 0 : Swift.max(0, num / den).squareRoot()
    if largeArc == sweep { coef = -coef }
    let cxp = (coef * rx * y1p) / ry
    let cyp = (-coef * ry * x1p) / rx
    let cx = cos * cxp - sin * cyp + (x0 + x) / 2
    let cy = sin * cxp + cos * cyp + (y0 + y) / 2
    func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double { JS.atan2(ux * vy - uy * vx, ux * vx + uy * vy) }
    let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    var delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if !sweep && delta > 0 { delta -= 2 * Double.pi } else if sweep && delta < 0 { delta += 2 * Double.pi }
    let n = Swift.max(1, Int(JS.ceil(abs(delta) / (Double.pi / 2) - 1e-9)))
    let step = delta / Double(n)
    let k = (4.0 / 3) * jsTan(step / 4)
    func map(_ ux: Double, _ uy: Double) -> PathPoint {
        let ex = rx * ux, ey = ry * uy
        return (cos * ex - sin * ey + cx, sin * ex + cos * ey + cy)
    }
    var out: [[PathPoint]] = []
    var prev = from
    for i in 0..<n {
        let a0 = theta1 + step * Double(i)
        let a1 = a0 + step
        let c0 = JS.cos(a0), s0 = JS.sin(a0), c1 = JS.cos(a1), s1 = JS.sin(a1)
        let end: PathPoint = i == n - 1 ? (x, y) : map(c1, s1)
        out.append([prev, map(c0 - k * s0, s0 + k * c0), map(c1 + k * s1, s1 - k * c1), end])
        prev = end
    }
    return out
}

/// A subpath: its Bézier segments (2 to 4 points each) and whether it is closed.
struct BezierContour {
    var segments: [[PathPoint]]
    var closed: Bool
}

/// Splits path data into contours of segments (arcs as cubics). Zero-length segments are dropped.
func pathToContours(_ d: String) -> [BezierContour] {
    // `toBezierPath`: absolute M / L / Q / C / Z, with a moveto before drawing commands that lack one.
    var path: [PathCommand] = []
    var current: PathPoint = (0, 0)
    var start: PathPoint = (0, 0)
    var open = false
    func ensureMove() {
        if !open {
            path.append(.move(start.0, start.1))
            current = start
            open = true
        }
    }
    for cmd in parseSvgPath(d) {
        switch cmd {
        case .move(let x, let y):
            start = (x, y)
            current = start
            path.append(cmd)
            open = true
        case .line(let x, let y):
            ensureMove()
            path.append(cmd)
            current = (x, y)
        case .quad(_, _, let x, let y), .cubic(_, _, _, _, let x, let y):
            ensureMove()
            path.append(cmd)
            current = (x, y)
        case .arc(let rx, let ry, let rot, let large, let sweep, let x, let y):
            ensureMove()
            for c in arcToCubics(current, rx: rx, ry: ry, rotation: rot, largeArc: large, sweep: sweep, x: x, y: y) {
                if c.count == 2 { path.append(.line(c[1].0, c[1].1)) } else { path.append(.cubic(c[1].0, c[1].1, c[2].0, c[2].1, c[3].0, c[3].1)) }
            }
            current = (x, y)
        case .close:
            if open { path.append(.close) }
            open = false
            current = start
        }
    }
    var contours: [BezierContour] = []
    var cur: Int? = nil
    var pen: PathPoint = (0, 0)
    var st: PathPoint = (0, 0)
    func push(_ seg: [PathPoint]) {
        if cur == nil {
            contours.append(BezierContour(segments: [], closed: false))
            cur = contours.count - 1
        }
        if seg.allSatisfy({ $0.0 == seg[0].0 && $0.1 == seg[0].1 }) { return }
        contours[cur!].segments.append(seg)
    }
    for cmd in path {
        switch cmd {
        case .move(let x, let y):
            st = (x, y)
            pen = st
            contours.append(BezierContour(segments: [], closed: false))
            cur = contours.count - 1
        case .line(let x, let y):
            push([pen, (x, y)])
            pen = (x, y)
        case .quad(let x1, let y1, let x, let y):
            push([pen, (x1, y1), (x, y)])
            pen = (x, y)
        case .cubic(let x1, let y1, let x2, let y2, let x, let y):
            push([pen, (x1, y1), (x2, y2), (x, y)])
            pen = (x, y)
        case .close:
            if let c = cur { contours[c].closed = true }
            cur = nil
            pen = st
        case .arc:
            break
        }
    }
    return contours
}

private func segmentPoint(_ seg: [PathPoint], _ t: Double) -> PathPoint {
    let n = seg.count
    if n == 2 { return (seg[0].0 + (seg[1].0 - seg[0].0) * t, seg[0].1 + (seg[1].1 - seg[0].1) * t) }
    let mt = 1 - t
    if n == 3 {
        let a = mt * mt, b = 2 * mt * t, c = t * t
        return (a * seg[0].0 + b * seg[1].0 + c * seg[2].0, a * seg[0].1 + b * seg[1].1 + c * seg[2].1)
    }
    let a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t
    return (a * seg[0].0 + b * seg[1].0 + c * seg[2].0 + d * seg[3].0, a * seg[0].1 + b * seg[1].1 + c * seg[2].1 + d * seg[3].1)
}

/// A chain of segments as a polyline within `tolerance`.
func flattenChain(_ segs: [[PathPoint]], _ tolerance: Double) -> [PathPoint] {
    var out: [PathPoint] = []
    for s in segs {
        if out.isEmpty { out.append(s[0]) }
        if s.count == 2 {
            out.append(s[1])
            continue
        }
        var dd = 0.0
        var i = 0
        while i + 2 < s.count {
            dd = Swift.max(dd, JS.hypot(s[i].0 - 2 * s[i + 1].0 + s[i + 2].0, s[i].1 - 2 * s[i + 1].1 + s[i + 2].1))
            i += 1
        }
        let deg = Double(s.count - 1)
        let n = Swift.max(1, Swift.min(256, Int(JS.ceil(((deg * (deg - 1) * dd) / (8 * tolerance)).squareRoot()))))
        for k in 1...n { out.append(segmentPoint(s, Double(k) / Double(n))) }
    }
    if out.count > 1, out[0].0 == out[out.count - 1].0, out[0].1 == out[out.count - 1].1 { out.removeLast() }
    return out
}

/// How finely curves are flattened before resampling, in document pixels.
private let FLATTEN_TOLERANCE = 0.1

/// The most samples one subpath may have (the stroke tools' point limit).
public let MAX_PATH_SAMPLES = 20000

/// Pressure at `t` (0..1 along the length) of an evenly spread profile.
private func profileAt(_ profile: [Double], _ t: Double) -> Double {
    if profile.count == 1 { return profile[0] }
    let at = t * Double(profile.count - 1)
    let i = Swift.min(profile.count - 2, Int(JS.floor(at)))
    return profile[i] + (profile[i + 1] - profile[i]) * (at - Double(i))
}

/**
 * Samples SVG path data (document pixels) into pen points, one array per subpath. Closed
 * subpaths end where they start. Throws a sentence when the path has nothing to brush.
 */
func samplePath(_ d: String, spacing spacingIn: Double?, pressure profile: [Double]?) throws -> [[PenPoint]] {
    let spacing = spacingIn ?? 2
    if !(spacing >= 0.25 && spacing <= 100) { throw PaintEditorError("spacing \(jsText(spacing)) is out of range; use 0.25..100 document pixels.") }
    if let profile, profile.isEmpty || profile.contains(where: { !($0 >= 0 && $0 <= 1) }) { throw PaintEditorError("pressure needs one or more values from 0 to 1, e.g. [0.2, 1, 0.2] for a taper.") }
    var out: [[PenPoint]] = []
    for contour in pathToContours(d) {
        if contour.segments.isEmpty { continue }
        var line = flattenChain(contour.segments, FLATTEN_TOLERANCE)
        if contour.closed && !line.isEmpty { line.append(line[0]) }
        // Even resampling along the flattened line.
        var lengths = [0.0]
        for i in 1..<Swift.max(1, line.count) { lengths.append(lengths[i - 1] + JS.hypot(line[i].0 - line[i - 1].0, line[i].1 - line[i - 1].1)) }
        let total = lengths[lengths.count - 1]
        let n = Swift.max(1, Int(JS.ceil(total / spacing)))
        if n + 1 > MAX_PATH_SAMPLES { throw PaintEditorError("The path is \(jsText(JS.round(total))) px long: too many samples at spacing \(jsText(spacing)); use a larger spacing (at least \(jsText(JS.ceil(total / Double(MAX_PATH_SAMPLES - 1))))).") }
        var points: [PenPoint] = []
        var j = 0
        for k in 0...n {
            let at = (total * Double(k)) / Double(n)
            while j < line.count - 2 && lengths[j + 1] < at { j += 1 }
            let spanRaw = (j + 1 < lengths.count ? lengths[j + 1] : Double.nan) - lengths[j]
            let span = spanRaw.isNaN || spanRaw == 0 ? 1 : spanRaw
            let f = line.count > 1 ? Swift.min(1, Swift.max(0, (at - lengths[j]) / span)) : 0
            let a = line[j]
            let b = line[Swift.min(j + 1, line.count - 1)]
            let x = JS.round((a.0 + (b.0 - a.0) * f) * 1000) / 1000
            let y = JS.round((a.1 + (b.1 - a.1) * f) * 1000) / 1000
            points.append(profile.map { PenPoint(x: x, y: y, pressure: JS.round(profileAt($0, Double(k) / Double(n)) * 1000) / 1000) } ?? PenPoint(x: x, y: y))
        }
        out.append(points)
    }
    if out.isEmpty { throw PaintEditorError("path has no segments to brush; give SVG path data such as \"M 10 10 L 200 80\".") }
    return out
}
