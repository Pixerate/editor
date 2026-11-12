// Label placement around obstacles (#792), ported line for line from
// packages/core/src/geom/labels.ts so the same input gives the same boxes. Pure geometry: callers
// measure text and pass sizes.

/** A point in some 2D space. */
public struct LabelPoint: Sendable, Equatable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

/** An axis-aligned box: top-left corner, width and height. */
public struct LabelBox: Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
}

/** Where a label sits relative to its anchor. `center` puts it on the anchor. */
public enum LabelSide: String, Sendable, Equatable, CaseIterable {
    case above, below, left, right
    case aboveRight = "above-right"
    case aboveLeft = "above-left"
    case belowRight = "below-right"
    case belowLeft = "below-left"
    case center
}

/** Every side, in the default order of preference after the caller's. */
public let LABEL_SIDES: [LabelSide] = [.above, .right, .below, .left, .aboveRight, .belowRight, .aboveLeft, .belowLeft, .center]

public struct LabelRequest: Sendable {
    public var anchor: LabelPoint
    public var width: Double
    public var height: Double
    /** The label's size wrapped to two lines, tried after the one-line size. */
    public var wrapped: (width: Double, height: Double)?
    /** Sides to try, best first (default: the options' `prefer`). */
    public var prefer: [LabelSide]?
    public init(anchor: LabelPoint, width: Double, height: Double, wrapped: (width: Double, height: Double)? = nil, prefer: [LabelSide]? = nil) {
        self.anchor = anchor; self.width = width; self.height = height; self.wrapped = wrapped; self.prefer = prefer
    }
}

/** Something labels must not cover. `label` ties it to one label, which may cover it. */
public struct LabelObstacle: Sendable {
    public enum Shape: Sendable {
        case box(LabelBox)
        case point(LabelPoint)
        case segment(LabelPoint, LabelPoint)
        case polygon([LabelPoint])
    }
    public var shape: Shape
    public var label: Int?
    public var pad: Double
    public init(_ shape: Shape, label: Int? = nil, pad: Double = 0) {
        self.shape = shape; self.label = label; self.pad = pad
    }
}

public struct PlaceLabelsOptions: Sendable {
    public var obstacles: [LabelObstacle] = []
    public var bounds: LabelBox?
    public var gap: Double = 2
    public var prefer: [LabelSide]?
    public var distance: Double?
    public var reach: Double?
    public var step: Double = 6
    public var leader: Bool = false
    public var passes: Int = 4
    public init() {}
}

public struct PlacedLabel: Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var side: LabelSide
    public var wrapped: Bool
    public var leader: (LabelPoint, LabelPoint)?
    public var clashes: Int
    public var ok: Bool

    public static func == (a: PlacedLabel, b: PlacedLabel) -> Bool {
        a.x == b.x && a.y == b.y && a.width == b.width && a.height == b.height && a.side == b.side && a.wrapped == b.wrapped
            && a.leader?.0 == b.leader?.0 && a.leader?.1 == b.leader?.1 && a.clashes == b.clashes && a.ok == b.ok
    }
}

public enum LabelPlacementError: Error, CustomStringConvertible {
    case invalid(String)
    public var description: String {
        switch self { case .invalid(let m): return m }
    }
}

private struct LabelCandidate {
    var box: LabelBox
    var side: LabelSide
    var wrapped: Bool
    var cost: Double
}

private let DIAGONAL = 0.5.squareRoot()

private func boxOn(_ side: LabelSide, _ a: LabelPoint, _ w: Double, _ h: Double, _ d: Double) -> LabelBox {
    switch side {
    case .above: return LabelBox(x: a.x - w / 2, y: a.y - d - h, width: w, height: h)
    case .below: return LabelBox(x: a.x - w / 2, y: a.y + d, width: w, height: h)
    case .left: return LabelBox(x: a.x - d - w, y: a.y - h / 2, width: w, height: h)
    case .right: return LabelBox(x: a.x + d, y: a.y - h / 2, width: w, height: h)
    case .aboveRight: return LabelBox(x: a.x + d * DIAGONAL, y: a.y - d * DIAGONAL - h, width: w, height: h)
    case .aboveLeft: return LabelBox(x: a.x - d * DIAGONAL - w, y: a.y - d * DIAGONAL - h, width: w, height: h)
    case .belowRight: return LabelBox(x: a.x + d * DIAGONAL, y: a.y + d * DIAGONAL, width: w, height: h)
    case .belowLeft: return LabelBox(x: a.x - d * DIAGONAL - w, y: a.y + d * DIAGONAL, width: w, height: h)
    case .center: return LabelBox(x: a.x - w / 2, y: a.y - h / 2, width: w, height: h)
    }
}

private func boxesOverlap(_ a: LabelBox, _ b: LabelBox, _ gap: Double) -> Bool {
    a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap
}

private func inBox(_ p: LabelPoint, _ b: LabelBox, _ pad: Double) -> Bool {
    p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad
}

private func segmentsCross(_ p: LabelPoint, _ q: LabelPoint, _ r: LabelPoint, _ s: LabelPoint) -> Bool {
    func cross(_ a: LabelPoint, _ b: LabelPoint, _ c: LabelPoint) -> Double { (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) }
    let d1 = cross(r, s, p)
    let d2 = cross(r, s, q)
    let d3 = cross(p, q, r)
    let d4 = cross(p, q, s)
    if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)) { return true }
    func on(_ a: LabelPoint, _ b: LabelPoint, _ c: LabelPoint, _ d: Double) -> Bool {
        d == 0 && Swift.min(a.x, b.x) <= c.x && c.x <= Swift.max(a.x, b.x) && Swift.min(a.y, b.y) <= c.y && c.y <= Swift.max(a.y, b.y)
    }
    return on(r, s, p, d1) || on(r, s, q, d2) || on(p, q, r, d3) || on(p, q, s, d4)
}

private func corners(_ b: LabelBox) -> [LabelPoint] {
    [LabelPoint(x: b.x, y: b.y), LabelPoint(x: b.x + b.width, y: b.y), LabelPoint(x: b.x + b.width, y: b.y + b.height), LabelPoint(x: b.x, y: b.y + b.height)]
}

private func segmentHitsBox(_ p: LabelPoint, _ q: LabelPoint, _ b: LabelBox) -> Bool {
    if inBox(p, b, 0) || inBox(q, b, 0) { return true }
    let c = corners(b)
    for i in 0..<4 where segmentsCross(p, q, c[i], c[(i + 1) % 4]) { return true }
    return false
}

private func pointInPolygon(_ p: LabelPoint, _ poly: [LabelPoint]) -> Bool {
    var inside = false
    var j = poly.count - 1
    for i in 0..<poly.count {
        let a = poly[i]
        let b = poly[j]
        if (a.y > p.y) != (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x { inside.toggle() }
        j = i
    }
    return inside
}

private func polygonHitsBox(_ poly: [LabelPoint], _ b: LabelBox) -> Bool {
    if poly.contains(where: { inBox($0, b, 0) }) { return true }
    if corners(b).contains(where: { pointInPolygon($0, poly) }) { return true }
    for i in 0..<poly.count where segmentHitsBox(poly[i], poly[(i + 1) % poly.count], b) { return true }
    return false
}

private func grow(_ b: LabelBox, _ pad: Double) -> LabelBox {
    LabelBox(x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad)
}

private func hits(_ o: LabelObstacle, _ box: LabelBox) -> Bool {
    switch o.shape {
    case .box(let b): return boxesOverlap(grow(b, o.pad), box, 0)
    case .point(let p): return inBox(p, box, o.pad)
    case .segment(let p, let q): return segmentHitsBox(p, q, grow(box, o.pad))
    case .polygon(let poly): return poly.count > 2 && polygonHitsBox(poly, grow(box, o.pad))
    }
}

/** The convex hull of `points`, clockwise on screen (y down), for polygon obstacles. */
public func labelHull(_ points: [LabelPoint]) -> [LabelPoint] {
    let pts = points.enumerated().sorted { a, b in
        a.element.x != b.element.x ? a.element.x < b.element.x : a.element.y != b.element.y ? a.element.y < b.element.y : a.offset < b.offset
    }.map(\.element)
    if pts.count < 3 { return pts }
    func cross(_ o: LabelPoint, _ a: LabelPoint, _ b: LabelPoint) -> Double { (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) }
    var lower: [LabelPoint] = []
    for p in pts {
        while lower.count >= 2 && cross(lower[lower.count - 2], lower[lower.count - 1], p) <= 0 { lower.removeLast() }
        lower.append(p)
    }
    var upper: [LabelPoint] = []
    for p in pts.reversed() {
        while upper.count >= 2 && cross(upper[upper.count - 2], upper[upper.count - 1], p) <= 0 { upper.removeLast() }
        upper.append(p)
    }
    return Array(lower.dropLast()) + Array(upper.dropLast())
}

/** Labels placed near their anchors and clear of the obstacles and each other, in input order. */
public func placeLabels(_ labels: [LabelRequest], _ options: PlaceLabelsOptions = PlaceLabelsOptions()) throws -> [PlacedLabel] {
    let obstacles = options.obstacles
    let gap = options.gap
    let distance = options.distance ?? (options.leader ? 12 : 4)
    let reach = Swift.max(distance, options.reach ?? distance + 48)
    let step = Swift.max(1, options.step)
    let passes = Swift.max(0, options.passes)
    let bounds = options.bounds
    for (i, l) in labels.enumerated() {
        if !l.anchor.x.isFinite || !l.anchor.y.isFinite { throw LabelPlacementError.invalid("placeLabels: label \(i) needs an anchor { x, y }.") }
        if !(l.width >= 0) || !(l.height >= 0) { throw LabelPlacementError.invalid("placeLabels: label \(i) needs a width and height of at least 0.") }
    }

    let anchorObstacles: [LabelObstacle] = labels.enumerated().map { LabelObstacle(.point($0.element.anchor), label: $0.offset, pad: 1) }

    let candidates: [[LabelCandidate]] = labels.map { l in
        let prefer = l.prefer ?? options.prefer ?? Array(LABEL_SIDES.prefix(8))
        var sizes: [(width: Double, height: Double, wrapped: Bool)] = [(l.width, l.height, false)]
        if let w = l.wrapped { sizes.append((w.width, w.height, true)) }
        var out: [LabelCandidate] = []
        for (s, side) in prefer.enumerated() {
            for size in sizes {
                var steps: [Double] = side == .center ? [0] : []
                if side != .center {
                    var d = distance
                    while d <= reach + 1e-9 { steps.append(d); d += step }
                }
                for d in steps {
                    var box = boxOn(side, l.anchor, size.width, size.height, d)
                    var clamped = false
                    if let b = bounds, size.width <= b.width, size.height <= b.height {
                        let x = Swift.max(b.x, Swift.min(b.x + b.width - size.width, box.x))
                        let y = Swift.max(b.y, Swift.min(b.y + b.height - size.height, box.y))
                        clamped = x != box.x || y != box.y
                        box = LabelBox(x: x, y: y, width: size.width, height: size.height)
                    }
                    let cost = Double(s) * 10 + ((d - distance) / step) * 2 + (size.wrapped ? 3 : 0) + (clamped ? 5 : 0)
                    out.append(LabelCandidate(box: box, side: side, wrapped: size.wrapped, cost: cost))
                }
            }
        }
        return out
    }

    func obstacleClashes(_ i: Int, _ box: LabelBox, _ side: LabelSide) -> Int {
        var n = 0
        for o in obstacles where o.label != i && hits(o, box) { n += 1 }
        for o in anchorObstacles where (o.label != i || side != .center) && hits(o, box) { n += 1 }
        return n
    }

    let clear = candidates.enumerated().map { i, list in list.filter { obstacleClashes(i, $0.box, $0.side) == 0 }.count }
    let baseOrder = Array(0..<labels.count).sorted { a, b in clear[a] != clear[b] ? clear[a] < clear[b] : a < b }

    func run(_ order: [Int]) -> [(PlacedLabel, Double)] {
        var placed = [(PlacedLabel, Double)?](repeating: nil, count: labels.count)
        var boxes: [LabelBox] = []
        for i in order {
            var best: (c: LabelCandidate, clashes: Int, score: Double)?
            for c in candidates[i] {
                var clashes = obstacleClashes(i, c.box, c.side)
                for b in boxes where boxesOverlap(b, c.box, gap) { clashes += 1 }
                let score = Double(clashes) * 100 + c.cost
                if best == nil || score < best!.score { best = (c, clashes, score) }
                if clashes == 0 && c.cost == 0 { break }
            }
            let l = labels[i]
            let c = best?.c ?? LabelCandidate(box: boxOn(.center, l.anchor, l.width, l.height, 0), side: .center, wrapped: false, cost: 0)
            let clashes = best?.clashes ?? 0
            boxes.append(c.box)
            var leader: (LabelPoint, LabelPoint)?
            if options.leader {
                let ex = Swift.max(c.box.x, Swift.min(c.box.x + c.box.width, l.anchor.x))
                let ey = Swift.max(c.box.y, Swift.min(c.box.y + c.box.height, l.anchor.y))
                if JS.hypot(ex - l.anchor.x, ey - l.anchor.y) > 2 { leader = (LabelPoint(x: l.anchor.x, y: l.anchor.y), LabelPoint(x: ex, y: ey)) }
            }
            placed[i] = (PlacedLabel(x: c.box.x, y: c.box.y, width: c.box.width, height: c.box.height, side: c.side, wrapped: c.wrapped, leader: leader, clashes: clashes, ok: clashes == 0), c.cost)
        }
        return placed.map { $0! }
    }

    func total(_ r: [(PlacedLabel, Double)]) -> Int { r.reduce(0) { $0 + $1.0.clashes } }
    func totalCost(_ r: [(PlacedLabel, Double)]) -> Double { r.reduce(0) { $0 + $1.1 } }
    var best = run(baseOrder)
    var pass = 0
    while pass < passes && total(best) > 0 {
        let failed = baseOrder.filter { !best[$0].0.ok }
        let order = failed + baseOrder.filter { best[$0].0.ok }
        let next = run(order)
        if total(next) < total(best) || (total(next) == total(best) && totalCost(next) < totalCost(best)) { best = next } else { break }
        pass += 1
    }
    return best.map(\.0)
}
