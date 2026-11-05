import Foundation
import PixerateRaster

// Port of the geometry in `canvas/shapeGeometry.ts`: shape descriptions to polygons, SVG path
// parsing / flattening, and polygons back to path data. Paints, gradients, effects and
// brushstrokes (`getShapeRenderData`) are render data and live elsewhere (#623).

// MARK: - Shape descriptions

/// `ShapeKind`.
public enum ShapeKind: String, CaseIterable, Sendable {
    case rect, ellipse, polygon, star, path
}

/// `RectShape.cornerRadius`: one radius, or `[topLeft, topRight, bottomRight, bottomLeft]`.
public enum ShapeCornerRadius: Equatable, Sendable {
    case uniform(Double)
    case corners(Double, Double, Double, Double)
}

/// `ShapeDescription` (geometry fields only). Geometry is relative to the node box
/// (`0,0` to `width,height`); fields that do not apply to `kind` are ignored.
public struct ShapeDescription: Equatable, Sendable {
    public var kind: ShapeKind
    /// Clockwise rotation in degrees about the centre of the node box.
    public var rotation: Double?
    /// `rect`: corner radius, clamped to fit.
    public var cornerRadius: ShapeCornerRadius?
    /// `polygon`: number of sides (at least 3, default 6).
    public var sides: Double?
    /// `star`: number of points (at least 3, default 5).
    public var points: Double?
    /// `star`: inner radius as a fraction of the outer radius (default 0.5).
    public var innerRadius: Double?
    /// `path`: SVG path data.
    public var d: String
    /// `path`: `[minX, minY, width, height]` of the path's coordinate space.
    public var viewBox: [Double]?
    /// `path`: fill rule (default `nonzero`).
    public var fillRule: PolygonFillRule?

    public init(
        kind: ShapeKind, rotation: Double? = nil, cornerRadius: ShapeCornerRadius? = nil, sides: Double? = nil,
        points: Double? = nil, innerRadius: Double? = nil, d: String = "", viewBox: [Double]? = nil,
        fillRule: PolygonFillRule? = nil
    ) {
        self.kind = kind
        self.rotation = rotation
        self.cornerRadius = cornerRadius
        self.sides = sides
        self.points = points
        self.innerRadius = innerRadius
        self.d = d
        self.viewBox = viewBox
        self.fillRule = fillRule
    }
}

/// `ShapeSize`.
public struct ShapeSize: Equatable, Sendable {
    public var width: Double
    public var height: Double
    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

/// `FlattenOptions`.
public struct FlattenOptions: Sendable {
    /// Maximum distance between a curve and its polyline, in output units (default 0.25).
    public var tolerance: Double?
    /// Upper bound on the segments one curve is split into (default 512).
    public var maxSegments: Double?
    public init(tolerance: Double? = nil, maxSegments: Double? = nil) {
        self.tolerance = tolerance
        self.maxSegments = maxSegments
    }
}

// MARK: - SVG path parsing

private func paramCount(_ lower: UInt16) -> Int {
    switch lower {
    case 0x6D, 0x6C, 0x74: 2 // m l t
    case 0x68, 0x76: 1 // h v
    case 0x63: 6 // c
    case 0x73, 0x71: 4 // s q
    case 0x61: 7 // a
    default: 0 // z
    }
}

/// JS `\s`.
private func isJSSpace(_ c: UInt16) -> Bool {
    switch c {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
}

@inline(__always) private func isDigit(_ c: UInt16) -> Bool { c >= 0x30 && c <= 0x39 }

/// Character scanner for path data (handles `1.5.5`, `1e-3`, `-1-2` and compact arc flags).
/// Indexes UTF-16 code units, as the TS does.
struct PathScanner {
    private var pos = 0
    private let text: [UInt16]

    init(_ text: String) { self.text = Array(text.utf16) }

    private mutating func skip() {
        while pos < text.count && (isJSSpace(text[pos]) || text[pos] == 0x2C) { pos += 1 }
    }

    /// The next command letter, or nil when a number (or the end) follows.
    mutating func command() -> UInt16? {
        skip()
        guard pos < text.count else { return nil }
        let ch = text[pos]
        switch ch {
        case 0x4D, 0x6D, 0x4C, 0x6C, 0x48, 0x68, 0x56, 0x76, 0x43, 0x63, 0x53, 0x73, 0x51, 0x71, 0x54, 0x74, 0x41, 0x61, 0x5A, 0x7A:
            pos += 1
            return ch
        default:
            return nil
        }
    }

    mutating func done() -> Bool {
        skip()
        return pos >= text.count
    }

    /// `/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/` on the next 64 code units, then `Number`.
    mutating func number() -> Double? {
        skip()
        let end = Swift.min(pos + 64, text.count)
        var i = pos
        var sign = ""
        if i < end && (text[i] == 0x2B || text[i] == 0x2D) {
            if text[i] == 0x2D { sign = "-" }
            i += 1
        }
        var intDigits = ""
        var fracDigits = ""
        if i < end && isDigit(text[i]) {
            while i < end && isDigit(text[i]) { intDigits.append(Character(Unicode.Scalar(text[i])!)); i += 1 }
            if i < end && text[i] == 0x2E {
                i += 1
                while i < end && isDigit(text[i]) { fracDigits.append(Character(Unicode.Scalar(text[i])!)); i += 1 }
            }
        } else if i + 1 < end && text[i] == 0x2E && isDigit(text[i + 1]) {
            i += 1
            while i < end && isDigit(text[i]) { fracDigits.append(Character(Unicode.Scalar(text[i])!)); i += 1 }
        } else {
            return nil
        }
        var exponent = ""
        if i < end && (text[i] == 0x65 || text[i] == 0x45) {
            var j = i + 1
            var expSign = ""
            if j < end && (text[j] == 0x2B || text[j] == 0x2D) {
                if text[j] == 0x2D { expSign = "-" }
                j += 1
            }
            if j < end && isDigit(text[j]) {
                var digits = ""
                while j < end && isDigit(text[j]) { digits.append(Character(Unicode.Scalar(text[j])!)); j += 1 }
                exponent = "e" + expSign + digits
                i = j
            }
        }
        pos = i
        // Swift's `Double(_:)` rejects "1." and ".5"; spell the match in a form it reads.
        let literal = sign + (intDigits.isEmpty ? "0" : intDigits) + "." + (fracDigits.isEmpty ? "0" : fracDigits) + exponent
        guard let value = Double(literal), value.isFinite else { return nil }
        return value
    }

    mutating func flag() -> Double? {
        skip()
        guard pos < text.count else { return nil }
        let ch = text[pos]
        if ch == 0x30 || ch == 0x31 {
            pos += 1
            return ch == 0x31 ? 1 : 0
        }
        return nil
    }
}

/// Parses SVG path data into absolute `M`, `L`, `C`, `Q`, `A` and `Z` commands (relative
/// commands, `H` / `V`, `S` / `T` and implicit repeats normalised). Stops at the first
/// malformed command.
public func parseSvgPath(_ d: String) -> [PathCommand] {
    var scanner = PathScanner(d)
    var commands: [PathCommand] = []
    var cx = 0.0
    var cy = 0.0
    var startX = 0.0
    var startY = 0.0
    var lastControl: (x: Double, y: Double, type: UInt8)? = nil // type: C or Q
    var command: UInt16 = 0
    let C = UInt8(ascii: "C"), Q = UInt8(ascii: "Q")

    while !scanner.done() {
        if let letter = scanner.command() {
            command = letter
            if command == 0x7A || command == 0x5A {
                commands.append(.Z)
                cx = startX
                cy = startY
                lastControl = nil
                continue
            }
        } else if command == 0 || command == 0x7A || command == 0x5A {
            break
        }
        let rel = command >= 0x61
        let lower = rel ? command : command + 0x20
        let count = paramCount(lower)
        var args: [Double] = []
        for k in 0..<count {
            let value = lower == 0x61 && (k == 3 || k == 4) ? scanner.flag() : scanner.number()
            guard let value else { return commands }
            args.append(value)
        }
        let ox = rel ? cx : 0
        let oy = rel ? cy : 0
        switch lower {
        case 0x6D: // m
            cx = args[0] + ox
            cy = args[1] + oy
            startX = cx
            startY = cy
            commands.append(.M(x: cx, y: cy))
            lastControl = nil
            // Extra coordinate pairs after a moveto are implicit linetos.
            command = rel ? 0x6C : 0x4C
        case 0x6C: // l
            cx = args[0] + ox
            cy = args[1] + oy
            commands.append(.L(x: cx, y: cy))
            lastControl = nil
        case 0x68: // h
            cx = args[0] + (rel ? cx : 0)
            commands.append(.L(x: cx, y: cy))
            lastControl = nil
        case 0x76: // v
            cy = args[0] + (rel ? cy : 0)
            commands.append(.L(x: cx, y: cy))
            lastControl = nil
        case 0x63: // c
            let x2 = args[2] + ox, y2 = args[3] + oy, x = args[4] + ox, y = args[5] + oy
            commands.append(.C(x1: args[0] + ox, y1: args[1] + oy, x2: x2, y2: y2, x: x, y: y))
            lastControl = (x2, y2, C)
            cx = x
            cy = y
        case 0x73: // s
            let x1: Double = lastControl?.type == C ? 2 * cx - lastControl!.x : cx
            let y1: Double = lastControl?.type == C ? 2 * cy - lastControl!.y : cy
            let x2 = args[0] + ox, y2 = args[1] + oy, x = args[2] + ox, y = args[3] + oy
            commands.append(.C(x1: x1, y1: y1, x2: x2, y2: y2, x: x, y: y))
            lastControl = (x2, y2, C)
            cx = x
            cy = y
        case 0x71: // q
            let x1 = args[0] + ox, y1 = args[1] + oy, x = args[2] + ox, y = args[3] + oy
            commands.append(.Q(x1: x1, y1: y1, x: x, y: y))
            lastControl = (x1, y1, Q)
            cx = x
            cy = y
        case 0x74: // t
            let x1: Double = lastControl?.type == Q ? 2 * cx - lastControl!.x : cx
            let y1: Double = lastControl?.type == Q ? 2 * cy - lastControl!.y : cy
            let x = args[0] + ox, y = args[1] + oy
            commands.append(.Q(x1: x1, y1: y1, x: x, y: y))
            lastControl = (x1, y1, Q)
            cx = x
            cy = y
        case 0x61: // a
            let x = args[5] + ox, y = args[6] + oy
            commands.append(.A(rx: abs(args[0]), ry: abs(args[1]), rotation: args[2], largeArc: args[3] != 0, sweep: args[4] != 0, x: x, y: y))
            lastControl = nil
            cx = x
            cy = y
        default:
            break
        }
    }
    return commands
}

// MARK: - Curve flattening

private func segmentCount(_ curvature: Double, _ tolerance: Double, _ max: Double) -> Double {
    if !(curvature > 0) { return 1 }
    return jmax(1, jmin(max, JS.ceil(JS.sqrt(curvature / tolerance))))
}

func flattenCubic(
    _ out: inout [Point], _ p0: Point, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ x: Double, _ y: Double,
    _ tolerance: Double, _ max: Double
) {
    // Uniform subdivision error <= max|B''| / (8 n²) with |B''| <= 6 * max second difference.
    let dd = jmax(
        hypot(p0[0] - 2 * x1 + x2, p0[1] - 2 * y1 + y2),
        hypot(x1 - 2 * x2 + x, y1 - 2 * y2 + y)
    )
    let n = segmentCount((6 * dd) / 8, tolerance, max)
    var k = 1.0
    while k <= n {
        let t = k / n
        let mt = 1 - t
        let a = mt * mt * mt
        let b = 3 * mt * mt * t
        let c = 3 * mt * t * t
        let e = t * t * t
        let px: Double = a * p0[0] + b * x1 + c * x2 + e * x
        let py: Double = a * p0[1] + b * y1 + c * y2 + e * y
        out.append(Point(px, py))
        k += 1
    }
}

func flattenQuadratic(
    _ out: inout [Point], _ p0: Point, _ x1: Double, _ y1: Double, _ x: Double, _ y: Double, _ tolerance: Double, _ max: Double
) {
    let dd = hypot(p0[0] - 2 * x1 + x, p0[1] - 2 * y1 + y)
    let n = segmentCount((2 * dd) / 8, tolerance, max)
    var k = 1.0
    while k <= n {
        let t = k / n
        let mt = 1 - t
        let px: Double = mt * mt * p0[0] + 2 * mt * t * x1 + t * t * x
        let py: Double = mt * mt * p0[1] + 2 * mt * t * y1 + t * t * y
        out.append(Point(px, py))
        k += 1
    }
}

private func arcSteps(_ radius: Double, _ sweep: Double, _ tolerance: Double, _ max: Double) -> Double {
    if radius <= tolerance { return jmax(1, JS.ceil(abs(sweep) / (PI / 2))) }
    let step = 2 * jacos(1 - tolerance / radius)
    return jmax(1, jmin(max, JS.ceil(abs(sweep) / step)))
}

/// Flattens an SVG elliptical arc (endpoint parameterisation, SVG 1.1 F.6.5).
func flattenArc(
    _ out: inout [Point], _ p0: Point, rx rxIn: Double, ry ryIn: Double, rotation: Double, largeArc: Bool, sweep: Bool,
    x: Double, y: Double, _ tolerance: Double, _ max: Double
) {
    let x0 = p0[0], y0 = p0[1]
    var rx = rxIn, ry = ryIn
    if x0 == x && y0 == y { return }
    if rx == 0 || ry == 0 {
        out.append(Point(x, y))
        return
    }
    let phi = (rotation * PI) / 180
    let cos = JS.cos(phi)
    let sin = JS.sin(phi)
    let dx = (x0 - x) / 2
    let dy = (y0 - y) / 2
    let x1p = cos * dx + sin * dy
    let y1p = -sin * dx + cos * dy
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lambda > 1 {
        let s = JS.sqrt(lambda)
        rx *= s
        ry *= s
    }
    let num: Double = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    let den: Double = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    var coef = den == 0 ? 0 : JS.sqrt(jmax(0, num / den))
    if largeArc == sweep { coef = -coef }
    let cxp = (coef * rx * y1p) / ry
    let cyp = (-coef * ry * x1p) / rx
    let cx = cos * cxp - sin * cyp + (x0 + x) / 2
    let cy = sin * cxp + cos * cyp + (y0 + y) / 2
    let angle = { (ux: Double, uy: Double, vx: Double, vy: Double) -> Double in
        JS.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    }
    let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    var delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if !sweep && delta > 0 {
        delta -= 2 * PI
    } else if sweep && delta < 0 {
        delta += 2 * PI
    }
    let n = arcSteps(jmax(rx, ry), delta, tolerance, max)
    var k = 1.0
    while k < n {
        let t = theta1 + (delta * k) / n
        let ex = rx * JS.cos(t)
        let ey = ry * JS.sin(t)
        out.append(Point(cos * ex - sin * ey + cx, sin * ex + cos * ey + cy))
        k += 1
    }
    out.append(Point(x, y))
}

/// Flattens SVG path data into closed rings (one per subpath; open subpaths closed the way
/// SVG fills them). Curves are approximated within `tolerance`.
public func flattenSvgPath(_ d: String, _ options: FlattenOptions = FlattenOptions()) -> [PolygonRing] {
    flattenSvgPath(parseSvgPath(d), options)
}

/// `flattenSvgPath` for parsed commands.
public func flattenSvgPath(_ commands: [PathCommand], _ options: FlattenOptions = FlattenOptions()) -> [PolygonRing] {
    let tolerance = options.tolerance.flatMap { $0 > 0 ? $0 : nil } ?? 0.25
    let max = options.maxSegments ?? 512
    var rings: [PolygonRing] = []
    var current: [Point] = []
    var start = Point(0, 0)
    func flush() {
        if current.count >= 3 { rings.append(current) }
        current = []
    }
    for cmd in commands {
        switch cmd {
        case let .M(x, y):
            flush()
            start = Point(x, y)
            current = [start]
        case let .L(x, y):
            if current.isEmpty { current = [start] }
            current.append(Point(x, y))
        case let .C(x1, y1, x2, y2, x, y):
            if current.isEmpty { current = [start] }
            let last = current[current.count - 1]
            flattenCubic(&current, last, x1, y1, x2, y2, x, y, tolerance, max)
        case let .Q(x1, y1, x, y):
            if current.isEmpty { current = [start] }
            let last = current[current.count - 1]
            flattenQuadratic(&current, last, x1, y1, x, y, tolerance, max)
        case let .A(rx, ry, rotation, largeArc, sweep, x, y):
            if current.isEmpty { current = [start] }
            let last = current[current.count - 1]
            flattenArc(&current, last, rx: rx, ry: ry, rotation: rotation, largeArc: largeArc, sweep: sweep, x: x, y: y, tolerance, max)
        case .Z:
            flush()
            // A command after Z without a moveto starts at the subpath start.
        }
    }
    flush()
    return rings.map(dedupeRing).filter { $0.count >= 3 }
}

func dedupeRing(_ ring: [Point]) -> [Point] {
    var out: [Point] = []
    for p in ring {
        if let prev = out.last, prev[0] == p[0] && prev[1] == p[1] { continue }
        out.append(p)
    }
    while out.count > 1 && out[0][0] == out[out.count - 1][0] && out[0][1] == out[out.count - 1][1] { out.removeLast() }
    return out
}

// MARK: - Shapes to polygons

/// JS truthiness of a number (`0`, `-0` and `NaN` are falsy).
@inline(__always) private func truthy(_ x: Double) -> Bool { x != 0 && !x.isNaN }

/// `[topLeft, topRight, bottomRight, bottomLeft]` radii, scaled down together to fit (CSS rule).
func cornerRadii(_ shape: ShapeDescription, _ width: Double, _ height: Double) -> [Double] {
    let raw: [Double]
    switch shape.cornerRadius ?? .uniform(0) {
    case let .uniform(r): raw = [r, r, r, r]
    case let .corners(a, b, c, d): raw = [a, b, c, d]
    }
    var radii = raw.map { $0.isFinite && $0 > 0 ? $0 : 0 }
    let factor = jmin(
        jmin(
            1,
            width / jmax(radii[0] + radii[1], 1e-12),
            height / jmax(radii[1] + radii[2], 1e-12),
            width / jmax(radii[2] + radii[3], 1e-12)
        ),
        height / jmax(radii[3] + radii[0], 1e-12)
    )
    if factor < 1 { radii = radii.map { $0 * factor } }
    return radii
}

/// Unit vertices of a regular polygon / star (`inner` nil for a polygon), stretched to fill the box.
func polygonVertices(_ count: Double, _ inner: Double?, _ width: Double, _ height: Double) -> [Point] {
    var raw: [Point] = []
    let total = inner == nil ? count : count * 2
    var k = 0.0
    while k < total {
        let angle = -PI / 2 + (k * 2 * PI) / total
        let r = inner != nil && k.truncatingRemainder(dividingBy: 2) == 1 ? inner! : 1
        raw.append(Point(r * JS.cos(angle), r * JS.sin(angle)))
        k += 1
    }
    var minX = Double.infinity
    var minY = Double.infinity
    var maxX = -Double.infinity
    var maxY = -Double.infinity
    for p in raw {
        minX = jmin(minX, p[0])
        minY = jmin(minY, p[1])
        maxX = jmax(maxX, p[0])
        maxY = jmax(maxY, p[1])
    }
    let spanX = maxX - minX
    let spanY = maxY - minY
    let sx = width / (truthy(spanX) ? spanX : 1)
    let sy = height / (truthy(spanY) ? spanY : 1)
    return raw.map { Point(($0[0] - minX) * sx, ($0[1] - minY) * sy) }
}

/// Rotation about the centre of the node box, or nil when the shape is not rotated.
func rotationTransform(_ shape: ShapeDescription, _ size: ShapeSize) -> ((Point) -> Point)? {
    let deg = shape.rotation ?? 0
    if !truthy(deg) || !deg.isFinite { return nil }
    let rad = (deg * PI) / 180
    let cos = JS.cos(rad)
    let sin = JS.sin(rad)
    let cx = size.width / 2
    let cy = size.height / 2
    return { p in
        let x = p[0], y = p[1]
        return Point(cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos)
    }
}

/// SVG path data for a shape in node-local pixels (arcs for rounded corners and ellipses),
/// with its fill rule and a `transform` for rotation / path view boxes.
public func getShapeSvg(_ shape: ShapeDescription, _ size: ShapeSize) -> (d: String, fillRule: PolygonFillRule, transform: String?) {
    let w = size.width, h = size.height
    let f = { (n: Double) in formatNumber(n, 3) }
    var transforms: [String] = []
    if let rotation = shape.rotation, truthy(rotation) { transforms.append("rotate(\(f(rotation)) \(f(w / 2)) \(f(h / 2)))") }
    var d = ""
    var fillRule = PolygonFillRule.nonzero
    switch shape.kind {
    case .rect:
        let radii = cornerRadii(shape, w, h)
        let tl = radii[0], tr = radii[1], br = radii[2], bl = radii[3]
        if tl + tr + br + bl == 0 {
            d = "M0 0H\(f(w))V\(f(h))H0Z"
        } else {
            let arc = { (r: Double, x: Double, y: Double) in r > 0 ? "A\(f(r)) \(f(r)) 0 0 1 \(f(x)) \(f(y))" : "" }
            d = "M\(f(tl)) 0H\(f(w - tr))\(arc(tr, w, tr))V\(f(h - br))\(arc(br, w - br, h))"
                + "H\(f(bl))\(arc(bl, 0, h - bl))V\(f(tl))\(arc(tl, tl, 0))Z"
        }
    case .ellipse:
        let rx = w / 2
        let ry = h / 2
        d = "M0 \(f(ry))A\(f(rx)) \(f(ry)) 0 1 1 \(f(w)) \(f(ry))A\(f(rx)) \(f(ry)) 0 1 1 0 \(f(ry))Z"
    case .polygon, .star:
        let points = shape.kind == .polygon
            ? polygonVertices(jmax(3, JS.floor(shape.sides ?? 6)), nil, w, h)
            : polygonVertices(jmax(3, JS.floor(shape.points ?? 5)), clampRatio(shape.innerRadius), w, h)
        d = ringsToPath([points], f)
    case .path:
        d = shape.d
        fillRule = shape.fillRule ?? .nonzero
        if let vb = validViewBox(shape.viewBox) {
            transforms.append("scale(\(f(w / vb[2])) \(f(h / vb[3])))")
            transforms.append("translate(\(f(-vb[0])) \(f(-vb[1])))")
        }
    }
    return (d, fillRule, transforms.isEmpty ? nil : transforms.joined(separator: " "))
}

private func clampRatio(_ value: Double?) -> Double {
    guard let value, value.isFinite else { return 0.5 }
    return jmin(1, jmax(0.01, value))
}

/// The view box when it has four finite numbers and a positive size, else nil.
func validViewBox(_ vb: [Double]?) -> [Double]? {
    guard let vb, vb.count == 4, vb.allSatisfy({ $0.isFinite }), !(vb[2] <= 0), !(vb[3] <= 0) else { return nil }
    return vb
}

/// Converts a shape to rings in node-local pixels (rotation applied), flattening curves at
/// `tolerance`, with the fill rule they must be read with.
public func shapeToPolygon(_ shape: ShapeDescription, _ size: ShapeSize, _ options: FlattenOptions = FlattenOptions()) -> (rings: [PolygonRing], fillRule: PolygonFillRule) {
    let w = size.width, h = size.height
    if !(w > 0) || !(h > 0) { return ([], .nonzero) }
    var rings: [PolygonRing]
    var fillRule = PolygonFillRule.nonzero
    if shape.kind == .path {
        fillRule = shape.fillRule ?? .nonzero
        if let vb = validViewBox(shape.viewBox) {
            let sx = w / vb[2]
            let sy = h / vb[3]
            // Flatten in path units with the tolerance scaled to stay within `tolerance` px.
            var scaled = options
            scaled.tolerance = (options.tolerance ?? 0.25) / jmax(sx, sy)
            rings = flattenSvgPath(shape.d, scaled).map { ring in
                ring.map { Point(($0[0] - vb[0]) * sx, ($0[1] - vb[1]) * sy) }
            }
        } else {
            rings = flattenSvgPath(shape.d, options)
        }
    } else {
        var unrotated = shape
        unrotated.rotation = 0
        rings = flattenSvgPath(getShapeSvg(unrotated, size).d, options)
    }
    if let rotate = rotationTransform(shape, size) { rings = rings.map { $0.map(rotate) } }
    return (rings, fillRule)
}

// MARK: - Polygons to path data

/// Formats a number with at most `precision` decimals, without trailing zeros (`-0` as `0`).
public func formatNumber(_ value: Double, _ precision: Double = 3) -> String {
    let factor = JS.pow(10, precision)
    let rounded = JS.round(value * factor) / factor
    return rounded == 0 && rounded.sign == .minus ? "0" : jsString(rounded)
}

/// `formatNumber` with a whole number of decimals.
public func formatNumber(_ value: Double, _ precision: Int) -> String { formatNumber(value, Double(precision)) }

private func ringsToPath(_ rings: [[Point]], _ f: (Double) -> String) -> String {
    var d = ""
    for ring in rings {
        if ring.count < 2 { continue }
        d += "M\(f(ring[0][0])) \(f(ring[0][1]))"
        for i in 1..<ring.count { d += "L\(f(ring[i][0])) \(f(ring[i][1]))" }
        d += "Z"
    }
    return d
}

/// Perpendicular distance from `p` to the segment `a`–`b`.
func segmentDistance(_ p: Point, _ a: Point, _ b: Point) -> Double {
    let dx = b[0] - a[0]
    let dy = b[1] - a[1]
    let len2 = dx * dx + dy * dy
    if len2 == 0 { return hypot(p[0] - a[0], p[1] - a[1]) }
    let t = jmax(0, jmin(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
    return hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

func rdp(_ points: [Point], _ tolerance: Double) -> [Point] {
    if points.count <= 2 { return points }
    var keep = [Bool](repeating: false, count: points.count)
    keep[0] = true
    keep[points.count - 1] = true
    var stack: [(Int, Int)] = [(0, points.count - 1)]
    while let (s, e) = stack.popLast() {
        var maxDist = -1.0
        var index = -1
        var i = s + 1
        while i < e {
            let dist = segmentDistance(points[i], points[s], points[e])
            if dist > maxDist {
                maxDist = dist
                index = i
            }
            i += 1
        }
        if index != -1 && maxDist > tolerance {
            keep[index] = true
            stack.append((s, index))
            stack.append((index, e))
        }
    }
    return points.indices.filter { keep[$0] }.map { points[$0] }
}

/// Simplifies a closed ring with Ramer–Douglas–Peucker at `tolerance`. Returns an empty ring
/// when fewer than three points survive.
public func simplifyRing(_ ring: [PathPoint], _ tolerance: Double) -> [PathPoint] {
    if ring.count <= 3 || !(tolerance > 0) { return ring }
    // Anchor on the point farthest from the first one so the closing seam is not lost.
    var far = 0
    var farDist = -1.0
    for i in 1..<ring.count {
        let dist = hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1])
        if dist > farDist {
            farDist = dist
            far = i
        }
    }
    let first = rdp(Array(ring[0...far]), tolerance)
    let second = rdp(Array(ring[far...]) + [ring[0]], tolerance)
    let out = Array(first.dropLast()) + Array(second.dropLast())
    return out.count >= 3 ? out : []
}

/// `PolygonToPathOptions`.
public struct PolygonToPathOptions: Sendable {
    /// Decimal places in the output (default 3).
    public var precision: Double?
    /// Ramer–Douglas–Peucker tolerance; `0` (default) keeps every vertex.
    public var simplify: Double?
    /// Added to every point before formatting.
    public var offset: (x: Double, y: Double)?
    /// `lines` (default) writes `M`/`L`/`Z`; `fit` fits cubics to each ring (`fitPathData`).
    public var curves: Curves?
    /// Curve-fitting tolerance in path units for `fit` (default 0.25).
    public var curveTolerance: Double?
    /// Corner threshold in degrees for `fit` (default 30).
    public var cornerAngleDeg: Double?

    public enum Curves: String, Sendable { case lines, fit }

    public init(
        precision: Double? = nil, simplify: Double? = nil, offset: (x: Double, y: Double)? = nil, curves: Curves? = nil,
        curveTolerance: Double? = nil, cornerAngleDeg: Double? = nil
    ) {
        self.precision = precision
        self.simplify = simplify
        self.offset = offset
        self.curves = curves
        self.curveTolerance = curveTolerance
        self.cornerAngleDeg = cornerAngleDeg
    }
}

/// Converts a multi-polygon to SVG path data using `M`/`L`/`Z` (or fitted curves). Holes keep
/// their opposite orientation, so the path fills correctly with either fill rule.
public func polygonToSvgPath(_ input: MultiPolygon, _ options: PolygonToPathOptions = PolygonToPathOptions()) -> String {
    var rings: [PolygonRing] = []
    for polygon in input {
        if polygon.isEmpty { continue }
        if polygon[0].isEmpty {
            // The TS reads a polygon whose first ring is empty as one ring of non-numbers.
            rings.append([PathPoint](repeating: PathPoint(.nan, .nan), count: polygon.count))
        } else {
            rings += polygon
        }
    }
    return polygonRingsToSvgPath(rings, options)
}

/// `polygonToSvgPath` for a list of rings.
public func polygonToSvgPath(_ input: [PolygonRing], _ options: PolygonToPathOptions = PolygonToPathOptions()) -> String {
    polygonRingsToSvgPath(input, options)
}

private func polygonRingsToSvgPath(_ input: [PolygonRing], _ options: PolygonToPathOptions) -> String {
    let precision = options.precision ?? 3
    let f = { (n: Double) in formatNumber(n, precision) }
    let dx = options.offset?.x ?? 0
    let dy = options.offset?.y ?? 0
    var rings: [[Point]] = []
    let fit = options.curves == .fit
    var fitted = ""
    for ring in input {
        var r = ring
        if let simplify = options.simplify, simplify > 0 { r = simplifyRing(r, simplify) }
        if r.count < 3 { continue }
        if fit {
            fitted += fitPathData(r, FitPathDataOptions(
                cornerAngleDeg: options.cornerAngleDeg,
                tolerance: options.curveTolerance ?? 0.25,
                precision: precision,
                offset: (dx, dy)
            ))
            continue
        }
        rings.append(truthy(dx) || truthy(dy) ? r.map { Point($0[0] + dx, $0[1] + dy) } : r)
    }
    return fit ? fitted : ringsToPath(rings, f)
}
