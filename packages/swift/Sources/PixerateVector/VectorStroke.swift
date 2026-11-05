import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Stroke options of vector paths (`vector/stroke.ts`): alignment (centre, inside, outside),
// arrowheads at the ends of open paths and width profiles. Everything works on a path's Bézier
// outline in one space, so masks, filter reach, hit-testing and Outline Stroke share it.

/// Where the notch of the (notched) arrow sits, as a fraction of the head's length.
private let NOTCH = 0.7

private typealias P = PathPoint

/// One arrowhead (`VectorArrowheadShape`): a filled outline (nonzero) painted with the stroke's paint.
public struct VectorArrowheadShape: Sendable {
    /// `start` or `end`.
    public var end: String
    public var kind: String
    public var tip: PathPoint
    /// Unit direction the head points in.
    public var dir: PathPoint
    /// Distance from the tip back to where the stroke ends under the head.
    public var inset: Double
    public var path: BezierPath
}

/// What the stroke of a path draws (`VectorStrokeParts`).
public struct VectorStrokeParts: Sendable {
    /// Where the stroke sits (`center` for open shapes, whatever the style says).
    public var align: String
    /// The line the stroke follows: the outline, shortened under `tip`-aligned heads.
    public var line: BezierPath
    /// The width to draw `line` with: twice the style's width for inside / outside (half is clipped away).
    public var drawWidth: Double
    public var heads: [VectorArrowheadShape]
}

/// True when the path has subpaths and all of them are closed (only such shapes have an inside).
public func isClosedBezierShape(_ path: BezierPath) -> Bool {
    let contours = pathToContours(.commands(path)).filter { !$0.segments.isEmpty }
    return !contours.isEmpty && contours.allSatisfy(\.closed)
}

/// The alignment a stroke is drawn with: the style's, or `center` for open shapes.
public func effectiveStrokeAlign(_ style: VectorNode, _ closedShape: Bool) -> String {
    closedShape ? (style["strokeAlign"]?.stringValue ?? "center") : "center"
}

/// The style's width profile, sanitised, or nil when the stroke is uniform.
public func strokeWidthProfileOf(_ style: VectorNode) -> [VectorWidthPoint]? {
    guard let n = arrayLength(style["strokeWidthProfile"]), n > 0 else { return nil }
    let p = sanitizeWidthProfile(style["strokeWidthProfile"])
    return isUniformWidthProfile(p) ? nil : p
}

/// True when the style asks for more than a plain centred stroke (an alignment, arrowheads or a width profile).
func hasStrokeExtras(_ style: VectorNode) -> Bool {
    (style["strokeAlign"]?.stringValue ?? "center") != "center" || truthy(style["startArrow"]) || truthy(style["endArrow"]) || strokeWidthProfileOf(style) != nil
}

private func strokeJoin(_ style: VectorNode) -> StrokeJoin { StrokeJoin(rawValue: style["strokeLinejoin"]?.stringValue ?? "") ?? .miter }
private func strokeCap(_ style: VectorNode) -> StrokeCap { StrokeCap(rawValue: style["strokeLinecap"]?.stringValue ?? "") ?? .butt }
private func dashOf(_ style: VectorNode) -> [Double]? {
    guard let list = style["strokeDasharray"]?.arrayValue, !list.isEmpty else { return nil }
    return list.map { $0.numberValue ?? .nan }
}

/// The area of the stroke along `line` before alignment clipping (`vectorStrokeLineArea`): SVG's
/// stroke for a uniform width, the variable-width outline for a profiled one.
public func vectorStrokeLineArea(_ line: BezierPath, drawWidth: Double, _ style: VectorNode, tolerance: Double? = nil) throws -> BezierPath {
    let tol = (tolerance ?? 0) != 0 ? tolerance : nil
    if let profile = strokeWidthProfileOf(style) {
        return variableStrokeOutline(line, VariableStrokeOptions(width: drawWidth, profile: profile, join: strokeJoin(style), cap: strokeCap(style), dash: dashOf(style), tolerance: tol))
    }
    return try outlineStroke(.commands(line), OutlineStrokeOptions(width: drawWidth, join: strokeJoin(style), cap: strokeCap(style), dash: dashOf(style), tolerance: tol))
}

private func capExtent(_ style: VectorNode, _ width: Double) -> Double {
    let cap = style["strokeLinecap"]?.stringValue
    return cap == "round" || cap == "square" ? width / 2 : 0
}

/// The weight of a head (`arrowheadWeight`): the stroke's width just before it times the head's
/// scale (at least 0.25). On a variable-width stroke the width there is the profile's (the mean
/// of its two sides at that end), floored at the stroke width.
public func arrowheadWeight(_ style: VectorNode, _ end: String) -> Double {
    let scale = style[end == "start" ? "startArrowScale" : "endArrowScale"]?.numberValue
    let s = scale.map { $0 > 0 && $0.isFinite ? $0 : 1 } ?? 1
    let width = style.strokeWidth ?? 1
    let at = strokeWidthProfileOf(style).map { widthProfileAt($0, end == "start" ? 0 : 1) }
    let here = at.map { JS.max(width, (width * ($0.left + $0.right)) / 2) } ?? width
    return JS.max(0.25, here * s)
}

/// Distance from the tip where the stroke ends, for a stroke whose cap reaches `cap` past its end
/// (`arrowheadInset`); nil for an unknown kind.
public func arrowheadInset(_ kind: String, _ hw: Double, _ cap: Double) -> Double? {
    let l = 4 * hw
    func solid(_ back: Double) -> Double { JS.max(back / 2, cap) }
    switch kind {
    case "triangle", "circle", "square": return solid(l)
    case "arrow": return solid(NOTCH * l)
    case "bar": return solid(0.75 * hw)
    case "open":
        // The inner corner of the chevron: arm / sin(half angle).
        return JS.max((hw * JS.sqrt(l * l + (l * l) / 4)) / (l / 2), cap)
    default: return nil
    }
}

@inline(__always) private func plus(_ a: P, _ b: P, _ k: Double = 1) -> P { P(a[0] + b[0] * k, a[1] + b[1] * k) }
private func unitVec(_ a: P) -> P {
    let l = JS.hypot(a[0], a[1])
    return l > 0 ? P(a[0] / l, a[1] / l) : P(1, 0)
}

private func polygon(_ pts: [P]) -> BezierPath {
    [.M(x: pts[0][0], y: pts[0][1])] + pts.dropFirst().map { .L(x: $0[0], y: $0[1]) } + [.Z]
}

private func circle(_ c: P, _ r: Double) -> BezierPath {
    let k = r * KAPPA
    let x = c[0], y = c[1]
    return [
        .M(x: x + r, y: y),
        .C(x1: x + r, y1: y + k, x2: x + k, y2: y + r, x: x, y: y + r),
        .C(x1: x - k, y1: y + r, x2: x - r, y2: y + k, x: x - r, y: y),
        .C(x1: x - r, y1: y - k, x2: x - k, y2: y - r, x: x, y: y - r),
        .C(x1: x + k, y1: y - r, x2: x + r, y2: y - k, x: x + r, y: y),
        .Z,
    ]
}

/// The outline of a `kind` head of weight `hw` with its tip at `tip`, pointing along unit `dir`
/// (`arrowheadPath`); nil for an unknown kind.
public func arrowheadPath(_ kind: String, _ tip: PathPoint, _ dir: PathPoint, _ hw: Double) -> BezierPath? {
    let n = P(-dir[1], dir[0])
    let l = 4 * hw
    let half = l / 2
    let base = plus(tip, dir, -l)
    switch kind {
    case "triangle":
        return polygon([tip, plus(base, n, half), plus(base, n, -half)])
    case "arrow":
        return polygon([tip, plus(base, n, half), plus(tip, dir, -NOTCH * l), plus(base, n, -half)])
    case "open":
        // Arms `hw` thick from the tip to the base corners, cut square at their ends.
        let t = hw
        let a = plus(base, n, half)
        let b = plus(base, n, -half)
        let ua = unitVec(plus(a, tip, -1))
        let ub = unitVec(plus(b, tip, -1))
        let na = P(-ua[1], ua[0])
        let nb = P(ub[1], -ub[0])
        let inner = plus(tip, dir, -(t * JS.hypot(a[0] - tip[0], a[1] - tip[1])) / half)
        return polygon([tip, a, plus(a, na, t), inner, plus(b, nb, t), b])
    case "circle":
        return circle(plus(tip, dir, -half), half)
    case "square":
        return polygon([plus(tip, n, half), plus(base, n, half), plus(base, n, -half), plus(tip, n, -half)])
    case "bar":
        let t = 0.75 * hw
        return polygon([plus(tip, n, half), plus(plus(tip, n, half), dir, -t), plus(plus(tip, n, -half), dir, -t), plus(tip, n, -half)])
    default:
        return nil
    }
}

/// The end point of a contour and the unit direction pointing out of it there.
private func endOf(_ segs: [BezierSegment], _ atStart: Bool) -> (p: P, out: P) {
    func long(_ s: BezierSegment) -> Bool { segmentLength(s) > 1e-9 }
    if atStart {
        let s = segs.first(where: long) ?? segs[0]
        let t = segmentTangent(s, 0)
        return (segs[0][0], P(-t[0], -t[1]))
    }
    let s = segs.last(where: long) ?? segs[segs.count - 1]
    let t = segmentTangent(s, 1)
    let last = segs[segs.count - 1]
    return (last[last.count - 1], P(t[0], t[1]))
}

/// The point `dist` along the contour from its start (or back from its end), if it is that long.
private func pointAlong(_ segs: [BezierSegment], _ fromStart: Bool, _ d: Double) -> P? {
    let order = fromStart ? segs : segs.reversed()
    var acc = 0.0
    for s in order {
        let l = segmentLength(s)
        if acc + l >= d {
            let want = fromStart ? d - acc : l - (d - acc)
            let pts = trimSegments([s], 0, want)
            return pts.isEmpty ? s[0] : pts[0][pts[0].count - 1]
        }
        acc += l
    }
    return nil
}

/// The stroke of `path` as `style` draws it (`vectorStrokeParts`): its alignment, the line it
/// follows (shortened under `tip`-aligned heads) and its arrowheads. Heads go on the start of the
/// first subpath and the end of the last one, when those are open.
public func vectorStrokeParts(_ path: BezierPath, _ style: VectorNode) -> VectorStrokeParts {
    let width = style.strokeWidth ?? 1
    let contours = pathToContours(.commands(path)).filter { !$0.segments.isEmpty }
    let closedShape = !contours.isEmpty && contours.allSatisfy(\.closed)
    let align = effectiveStrokeAlign(style, closedShape)
    let drawWidth = align == "center" ? width : width * 2
    var heads: [VectorArrowheadShape] = []
    let startKind = truthy(style["startArrow"]) ? style["startArrow"]?.stringValue : nil
    let endKind = truthy(style["endArrow"]) ? style["endArrow"]?.stringValue : nil
    if contours.isEmpty || (startKind == nil && endKind == nil) { return VectorStrokeParts(align: align, line: path, drawWidth: drawWidth, heads: heads) }
    let cap = capExtent(style, width)
    let tipMode = style["arrowAlign"]?.stringValue == "tip"
    var trims = contours.map { _ in [0.0, 0.0] }
    func place(_ end: String, _ contour: BezierContour, _ ci: Int) {
        guard let kind = end == "start" ? startKind : endKind, !contour.closed else { return }
        let hw = arrowheadWeight(style, end)
        guard let inset = arrowheadInset(kind, hw, cap) else { return }
        let atStart = end == "start"
        let (p, out) = endOf(contour.segments, atStart)
        let tip: P
        let dir: P
        if tipMode {
            // Point along the chord from where the stroke now ends to the end point.
            let q = pointAlong(contour.segments, atStart, inset)
            let d = q.map { P(p[0] - $0[0], p[1] - $0[1]) }
            dir = d.map { JS.hypot($0[0], $0[1]) > 1e-9 ? unitVec($0) : out } ?? out
            tip = p
            trims[ci][atStart ? 0 : 1] = inset
        } else {
            tip = plus(p, out, inset)
            dir = out
        }
        guard let shape = arrowheadPath(kind, tip, dir, hw) else { return }
        heads.append(VectorArrowheadShape(end: end, kind: kind, tip: tip, dir: dir, inset: inset, path: shape))
    }
    place("start", contours[0], 0)
    place("end", contours[contours.count - 1], contours.count - 1)
    if !tipMode || heads.isEmpty { return VectorStrokeParts(align: align, line: path, drawWidth: drawWidth, heads: heads) }
    let trimmed = contours.enumerated().map { i, c -> BezierContour in
        let s0 = trims[i][0], s1 = trims[i][1]
        if s0 == 0 && s1 == 0 { return c }
        let lengths = c.segments.map { segmentLength($0) }
        let total = lengths.reduce(0, +)
        return BezierContour(segments: total - s1 > s0 ? trimSegments(c.segments, s0, total - s1, lengths) : [], closed: false)
    }
    return VectorStrokeParts(align: align, line: contoursToPath(trimmed), drawWidth: drawWidth, heads: heads)
}

/// The area the stroke paints, as one filled path (`vectorStrokeOutlinePath`): the outlined stroke
/// (joins, caps and dashes as SVG, or the variable-width outline) clipped by the alignment
/// (against the fill, read with the style's `fillRule`), plus the arrowheads.
public func vectorStrokeOutlinePath(_ path: BezierPath, _ style: VectorNode) throws -> BezierPath {
    let parts = vectorStrokeParts(path, style)
    let stroke = try vectorStrokeLineArea(parts.line, drawWidth: parts.drawWidth, style)
    let fill = PathOperand(.commands(path), fillRule: style.fillRule == "evenodd" ? .evenodd : .nonzero)
    var area = stroke
    if parts.align == "inside" { area = try pathBoolean(.intersection, [PathOperand(.commands(stroke)), fill]).path }
    else if parts.align == "outside" { area = try pathBoolean(.difference, [PathOperand(.commands(stroke)), fill]).path }
    if parts.heads.isEmpty { return area }
    return try pathBoolean(.union, [PathOperand(.commands(area))] + parts.heads.map { PathOperand(.commands($0.path)) }).path
}

/// Whether point `p` hits the stroke of `path` (`hitTestVectorStroke`; `tolerance` added on every
/// side): within half the width for a centred stroke, within the whole width on the inside or the
/// outside of the fill for an aligned one, or on an arrowhead.
public func hitTestVectorStroke(_ path: BezierPath, _ p: PathPoint, _ style: VectorNode, tolerance: Double = 0) -> Bool {
    let parts = vectorStrokeParts(path, style)
    let width = style.strokeWidth ?? 1
    for h in parts.heads {
        if pointInBezierPath(.commands(h.path), p) || (tolerance > 0 && distanceToBezierPath(.commands(h.path), p) <= tolerance) { return true }
    }
    if parts.line.isEmpty { return false }
    var d: Double
    var reach = width / 2
    if let profile = strokeWidthProfileOf(style) {
        // The side width at the nearest point of the centre line (twice it when aligned).
        guard let near = nearestStrokePosition(parts.line, p) else { return false }
        d = near.distance
        let w = widthProfileAt(profile, near.t)
        reach = (width / 2) * (near.side == "left" ? w.left : w.right)
        if parts.align != "center" { reach *= 2 }
        let atEnd = near.t <= 1e-9 || near.t >= 1 - 1e-9
        let cap = style["strokeLinecap"]?.stringValue
        if atEnd && (cap == "round" || cap == "square") && d > reach {
            // Past an open end the cap reaches as far as the width there.
            reach = JS.max(reach, ((width / 2) * (w.left + w.right)) / 2)
        }
    } else {
        d = distanceToBezierPath(.commands(parts.line), p)
        if parts.align != "center" { reach = width }
    }
    if parts.align == "center" { return d <= reach + tolerance }
    if d > reach + tolerance { return false }
    if d <= tolerance { return true }
    let inside = pointInBezierPath(.commands(path), p, style.fillRule == "evenodd" ? .evenodd : .nonzero)
    return parts.align == "inside" ? inside : !inside
}

/// How far the stroke can reach past the outline, for padding bounds and masks (`vectorStrokeReach`).
func vectorStrokeReach(_ style: VectorNode) -> Double {
    let width = (style.strokeWidth ?? 1) * widthProfileMaxScale(strokeWidthProfileOf(style))
    let align = style["strokeAlign"]?.stringValue ?? "center"
    var reach = align == "center" ? width / 2 : align == "outside" ? width : 0
    let join = style["strokeLinejoin"]?.stringValue
    if join != "round" && join != "bevel" { reach *= 4 }
    for end in ["start", "end"] where truthy(style[end == "start" ? "startArrow" : "endArrow"]) {
        reach = JS.max(reach, 8 * arrowheadWeight(style, end) + width)
    }
    return reach
}

/// The area a path's stroke paints, in document space (`vectorStrokeOutline`): empty without a
/// stroke. Node transforms are rigid, so the stroke laid out in document space keeps its width.
public func vectorStrokeOutline(_ node: VectorNode, _ parent: VectorMatrix = IDENTITY_MATRIX) throws -> BezierPath {
    if !hasPaint(node.stroke) || !((node.strokeWidth ?? 1) > 0) { return [] }
    return try vectorStrokeOutlinePath(try vectorPathWorldBezier(node, parent), node)
}
