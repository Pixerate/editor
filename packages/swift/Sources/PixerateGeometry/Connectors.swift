// Connectors for data visuals (#811), ported line for line from packages/core/src/geom/connectors.ts:
// rounded orthogonal elbows and fans of nested elbows that never cross, with exact lengths.
import Foundation
import PixerateRaster

/// Which way an elbow leaves its start: `vertical` runs up or down first, `horizontal` across.
public enum ElbowAxis: String, Sendable, Equatable {
    case vertical, horizontal
}

/// One piece of a connector: a straight run or a quarter circle, with its length.
public struct ConnectorSegment: Sendable, Equatable {
    public enum Kind: String, Sendable { case line, arc }
    public var kind: Kind
    public var from: Vec2
    public var to: Vec2
    /// The arc's centre, radius and SVG sweep flag (1 turns clockwise on screen); nil / 0 for a line.
    public var center: Vec2?
    public var radius: Double
    public var sweep: Int
    public var length: Double
}

/// A drawn connector: its pieces, SVG path data and exact length.
public struct Connector: Sendable, Equatable {
    public var segments: [ConnectorSegment]
    /// Path data with `M`, `L` and `A` commands, numbers to 3 decimals.
    public var d: String
    /// Exact length of the pieces (quarter circles are πr/2).
    public var length: Double
}

/// An elbow: a connector plus where its middle run sits.
public struct Elbow: Sendable, Equatable {
    public var connector: Connector
    public var level: Double
    public var segments: [ConnectorSegment] { connector.segments }
    public var d: String { connector.d }
    public var length: Double { connector.length }
}

private func connectorFmt(_ v: Double) -> String { formatNumber(v, 3) }

private func dist(_ a: Vec2, _ b: Vec2) -> Double {
    ((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)).squareRoot()
}

/// A polyline with its right-angle corners rounded to quarter circles of up to `radius`. A corner
/// takes at most the whole of an end run and half of a run it shares with another corner; other
/// corners stay sharp. Repeated and collinear points are dropped.
public func roundedPolyline(_ input: [Vec2], _ radius: Double = 8) -> Connector {
    var pts: [Vec2] = []
    for p in input {
        if let last = pts.last, last.x == p.x, last.y == p.y { continue }
        pts.append(Vec2(x: p.x, y: p.y))
    }
    var i = 1
    while i < pts.count - 1 {
        let a = pts[i - 1], b = pts[i], c = pts[i + 1]
        let cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
        let dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)
        if cross == 0 && dot > 0 { pts.remove(at: i) } else { i += 1 }
    }
    var segments: [ConnectorSegment] = []
    if pts.isEmpty { return Connector(segments: segments, d: "", length: 0) }
    var d = "M\(connectorFmt(pts[0].x)) \(connectorFmt(pts[0].y))"
    var length = 0.0
    var cur = pts[0]
    func line(_ to: Vec2) {
        let l = dist(cur, to)
        if l == 0 { return }
        segments.append(ConnectorSegment(kind: .line, from: cur, to: to, center: nil, radius: 0, sweep: 0, length: l))
        d += "L\(connectorFmt(to.x)) \(connectorFmt(to.y))"
        length += l
        cur = to
    }
    let last = pts.count - 1
    if last >= 2 {
        for i in 1..<last {
            let p = pts[i], a = pts[i - 1], c = pts[i + 1]
            let la = dist(a, p), lb = dist(p, c)
            let ux = (p.x - a.x) / la, uy = (p.y - a.y) / la
            let vx = (c.x - p.x) / lb, vy = (c.y - p.y) / lb
            let right = ux * vx + uy * vy == 0
            let r = right ? JS.min(JS.min(radius, i - 1 == 0 ? la : la / 2), i + 1 == last ? lb : lb / 2) : 0
            if !(r > 0) {
                line(p)
                continue
            }
            let entry = Vec2(x: p.x - ux * r, y: p.y - uy * r)
            let exit = Vec2(x: p.x + vx * r, y: p.y + vy * r)
            line(entry)
            let sweep = ux * vy - uy * vx > 0 ? 1 : 0
            let arcLength = (Double.pi * r) / 2
            segments.append(ConnectorSegment(kind: .arc, from: cur, to: exit, center: Vec2(x: entry.x + vx * r, y: entry.y + vy * r), radius: r, sweep: sweep, length: arcLength))
            d += "A\(connectorFmt(r)) \(connectorFmt(r)) 0 0 \(sweep) \(connectorFmt(exit.x)) \(connectorFmt(exit.y))"
            length += arcLength
            cur = exit
        }
    }
    line(pts[last])
    return Connector(segments: segments, d: d, length: length)
}

/// One rounded orthogonal connector from `from` to `to`: along the axis to `level`, across, then
/// along the axis again (`elbow` in the TS core). `level` defaults to halfway.
public func elbow(_ from: Vec2, _ to: Vec2, level: Double? = nil, radius: Double = 8, axis: ElbowAxis = .vertical) -> Elbow {
    let level = level ?? (axis == .vertical ? (from.y + to.y) / 2 : (from.x + to.x) / 2)
    let corners = axis == .vertical
        ? [Vec2(x: from.x, y: level), Vec2(x: to.x, y: level)]
        : [Vec2(x: level, y: from.y), Vec2(x: level, y: to.y)]
    return Elbow(connector: roundedPolyline([from] + corners + [to], radius), level: level)
}

/// Nested elbows from one root to a row of targets (`fanElbows` in the TS core).
public struct Fan: Sendable, Equatable {
    /// One elbow per target, in the targets' order.
    public var elbows: [Elbow]
    public var levels: [Double]
    public var starts: [Vec2]
    /// The step and radius used after fitting.
    public var step: Double
    public var radius: Double
}

/// On each side of the root the outermost target turns nearest the root and the next ones turn a
/// `step` further each, so no two elbows cross. With a `gap`, each elbow starts at its own point
/// beside the root, in the targets' order (the guarantee then needs targets at least `gap` apart).
public func fanElbows(_ root: Vec2, _ targets: [Vec2], gap: Double = 0, step stepOption: Double = 12, radius radiusOption: Double = 8, lead leadOption: Double = 16, axis: ElbowAxis = .vertical) -> Fan {
    func main(_ v: Vec2) -> Double { axis == .vertical ? v.y : v.x }
    func across(_ v: Vec2) -> Double { axis == .vertical ? v.x : v.y }
    let n = targets.count
    // Stable sort by position across, then index (Array.sort is not stable; the index breaks ties).
    let order = (0..<n).sorted { a, b in
        let d = across(targets[a]) - across(targets[b])
        return d != 0 ? d < 0 : a < b
    }
    var startAt = [Double](repeating: 0, count: n)
    var offset = [Double](repeating: 0, count: n)
    for k in 0..<n {
        startAt[k] = across(root) + (Double(k) - Double(n - 1) / 2) * gap
        offset[k] = across(targets[order[k]]) - startAt[k]
    }
    var rank = [Double](repeating: 0, count: n)
    var left = 0
    for k in 0..<n where offset[k] < 0 { rank[k] = Double(left); left += 1 }
    var right = 0
    for k in stride(from: n - 1, through: 0, by: -1) where offset[k] > 0 { rank[k] = Double(right); right += 1 }
    var sum = 0.0
    var available = Double.infinity
    for t in targets {
        sum += main(t) - main(root)
        available = JS.min(available, abs(main(t) - main(root)))
    }
    let dir: Double = sum < 0 ? -1 : 1
    if n == 0 { available = 0 }
    let lead = JS.min(leadOption, available / 2)
    let deepest = max(left, right) - 1
    let step = deepest > 0 ? JS.min(stepOption, (available - lead) / Double(deepest + 1)) : stepOption
    let radius = JS.min(radiusOption, step / 2)
    var elbows: [Elbow?] = Array(repeating: nil, count: n)
    var levels = [Double](repeating: 0, count: n)
    var starts = [Vec2](repeating: Vec2(x: 0, y: 0), count: n)
    for k in 0..<n {
        let i = order[k]
        let level = main(root) + dir * (lead + rank[k] * step)
        let start = axis == .vertical ? Vec2(x: startAt[k], y: root.y) : Vec2(x: root.x, y: startAt[k])
        elbows[i] = elbow(start, targets[i], level: level, radius: radius, axis: axis)
        levels[i] = level
        starts[i] = start
    }
    return Fan(elbows: elbows.map { $0! }, levels: levels, starts: starts, step: step, radius: radius)
}
