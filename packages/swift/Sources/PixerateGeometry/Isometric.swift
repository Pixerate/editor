// Isometric ("2.5D") projection (#799), ported from packages/core/src/geom/iso.ts: grid points
// (i, j, k) drawn flat, boxes with three visible faces, grid lines and back-to-front order.
import Foundation
import PixerateRaster

/// A box in grid units: each axis from low to high (`k0` may equal `k1` for a flat tile).
public struct IsoBox: Sendable, Equatable {
    public var i0, i1, j0, j1, k0, k1: Double
    public init(i0: Double, i1: Double, j0: Double, j1: Double, k0: Double, k1: Double) {
        self.i0 = i0; self.i1 = i1; self.j0 = j0; self.j1 = j1; self.k0 = k0; self.k1 = k1
    }
}

/// A box drawn: its visible faces, its six-sided outline and the outline's bounds.
public struct IsoBoxFaces: Sendable {
    public var top: [Vec2]
    public var right: [Vec2]
    public var left: [Vec2]
    public var outline: [Vec2]
    public var bounds: (x: Double, y: Double, width: Double, height: Double)
}

public enum IsoError: Error, CustomStringConvertible {
    case invalid(String)
    public var description: String { switch self { case .invalid(let m): return m } }
}

/// Problems with a box, or `[]` (`isoBoxProblems`).
public func isoBoxProblems(_ b: IsoBox) -> [String] {
    for (key, v) in [("i0", b.i0), ("i1", b.i1), ("j0", b.j0), ("j1", b.j1), ("k0", b.k0), ("k1", b.k1)] where !v.isFinite {
        return ["\(key) must be a number"]
    }
    if !(b.i0 < b.i1) || !(b.j0 < b.j1) || !(b.k0 <= b.k1) { return ["each axis must run from low to high (i0 < i1, j0 < j1, k0 <= k1)"] }
    return []
}

public struct IsoProjector: Sendable {
    public let angle: Double
    public let scale: Double
    public let origin: Vec2
    private let cosS: Double
    private let sinS: Double

    /// Throws for an angle outside 1–89 degrees or a scale that is not positive.
    public init(angle: Double? = nil, scale: Double? = nil, origin: Vec2? = nil) throws {
        let a = angle ?? 30
        let s = scale ?? 20
        if !(a >= 1 && a <= 89) { throw IsoError.invalid("The isometric angle must be from 1 to 89 degrees, not \(jsNumber(a)).") }
        if !(s > 0) || !s.isFinite { throw IsoError.invalid("The isometric scale must be a positive number of document units per grid unit, not \(jsNumber(s)).") }
        self.angle = a
        self.scale = s
        self.origin = origin ?? Vec2(x: 0, y: 0)
        cosS = JS.cos((a * Double.pi) / 180) * s
        sinS = JS.sin((a * Double.pi) / 180) * s
    }

    /// Grid point (i, j, k) on the page.
    public func point(_ i: Double, _ j: Double, _ k: Double = 0) -> Vec2 {
        Vec2(x: origin.x + (i - j) * cosS, y: origin.y + (i + j) * sinS - k * scale)
    }

    /// The visible faces of `b`.
    public func box(_ b: IsoBox) -> IsoBoxFaces {
        let flat = b.k0 == b.k1
        let top = [point(b.i0, b.j0, b.k1), point(b.i1, b.j0, b.k1), point(b.i1, b.j1, b.k1), point(b.i0, b.j1, b.k1)]
        let right = flat ? [] : [point(b.i1, b.j0, b.k1), point(b.i1, b.j1, b.k1), point(b.i1, b.j1, b.k0), point(b.i1, b.j0, b.k0)]
        let left = flat ? [] : [point(b.i0, b.j1, b.k1), point(b.i1, b.j1, b.k1), point(b.i1, b.j1, b.k0), point(b.i0, b.j1, b.k0)]
        let outline = flat ? top : [point(b.i0, b.j0, b.k1), point(b.i1, b.j0, b.k1), point(b.i1, b.j0, b.k0), point(b.i1, b.j1, b.k0), point(b.i0, b.j1, b.k0), point(b.i0, b.j1, b.k1)]
        let xs = outline.map(\.x)
        let ys = outline.map(\.y)
        let minX = xs.reduce(Double.infinity) { JS.min($0, $1) }
        let minY = ys.reduce(Double.infinity) { JS.min($0, $1) }
        let maxX = xs.reduce(-Double.infinity) { JS.max($0, $1) }
        let maxY = ys.reduce(-Double.infinity) { JS.max($0, $1) }
        return IsoBoxFaces(top: top, right: right, left: left, outline: outline, bounds: (minX, minY, maxX - minX, maxY - minY))
    }

    /// Grid lines on the visible faces at whole multiples of `step`.
    public func gridLines(_ b: IsoBox, step: Double = 1) throws -> (top: [(Vec2, Vec2)], right: [(Vec2, Vec2)], left: [(Vec2, Vec2)]) {
        if !(step > 0) { throw IsoError.invalid("The grid step must be a positive number of grid units, not \(jsNumber(step)).") }
        func inside(_ lo: Double, _ hi: Double) -> [Double] {
            var out: [Double] = []
            var n = JS.floor(lo / step) + 1
            while n * step < hi - 1e-9 {
                if n * step > lo + 1e-9 { out.append(n * step) }
                n += 1
            }
            return out
        }
        let top = inside(b.i0, b.i1).map { (point($0, b.j0, b.k1), point($0, b.j1, b.k1)) } + inside(b.j0, b.j1).map { (point(b.i0, $0, b.k1), point(b.i1, $0, b.k1)) }
        let flat = b.k0 == b.k1
        let right = flat ? [] : inside(b.j0, b.j1).map { (point(b.i1, $0, b.k0), point(b.i1, $0, b.k1)) } + inside(b.k0, b.k1).map { (point(b.i1, b.j0, $0), point(b.i1, b.j1, $0)) }
        let left = flat ? [] : inside(b.i0, b.i1).map { (point($0, b.j1, b.k0), point($0, b.j1, b.k1)) } + inside(b.k0, b.k1).map { (point(b.i0, b.j1, $0), point(b.i1, b.j1, $0)) }
        return (top, right, left)
    }
}

/// The order to draw `boxes` in, back to front, as indices (`isoOrder`).
public func isoOrder(_ boxes: [IsoBox], _ projector: IsoProjector) -> [Int] {
    func behind(_ a: IsoBox, _ b: IsoBox) -> Bool { a.i1 <= b.i0 || a.j1 <= b.j0 || a.k1 <= b.k0 }
    func depth(_ b: IsoBox) -> Double { b.i0 + b.i1 + b.j0 + b.j1 + b.k0 + b.k1 }
    let bounds = boxes.map { projector.box($0).bounds }
    func overlap(_ a: Int, _ b: Int) -> Bool {
        let p = bounds[a], q = bounds[b]
        return p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height
    }
    let n = boxes.count
    var after = [[Int]](repeating: [], count: n)
    var blockers = [Int](repeating: 0, count: n)
    for a in 0..<n {
        for b in 0..<n where a != b && overlap(a, b) {
            if behind(boxes[a], boxes[b]) && !behind(boxes[b], boxes[a]) {
                after[a].append(b)
                blockers[b] += 1
            }
        }
    }
    var done = [Bool](repeating: false, count: n)
    var order: [Int] = []
    func better(_ x: Int, _ y: Int) -> Bool { depth(boxes[x]) < depth(boxes[y]) || (depth(boxes[x]) == depth(boxes[y]) && x < y) }
    while order.count < n {
        var pick = -1
        for i in 0..<n where !done[i] && blockers[i] == 0 && (pick < 0 || better(i, pick)) { pick = i }
        if pick < 0 { for i in 0..<n where !done[i] && (pick < 0 || better(i, pick)) { pick = i } }
        done[pick] = true
        order.append(pick)
        for b in after[pick] { blockers[b] -= 1 }
    }
    return order
}

/// `hex` (#rgb or #rrggbb) moved `amount` towards black; other colours come back unchanged.
public func isoShade(_ hex: String, _ amount: Double) -> String {
    let t = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.hasPrefix("#") else { return hex }
    let body = String(t.dropFirst())
    guard body.count == 3 || body.count == 6, body.allSatisfy(\.isHexDigit) else { return hex }
    let full = body.count == 3 ? body.map { "\($0)\($0)" }.joined() : body
    let chars = Array(full)
    var out = "#"
    for k in stride(from: 0, to: 6, by: 2) {
        let v = Double(Int(String(chars[k..<k + 2]), radix: 16) ?? 0)
        let c = Int(JS.round(v * (1 - amount)))
        let h = String(c, radix: 16)
        out += h.count < 2 ? "0" + h : h
    }
    return out
}

/// The three face colours of one fill: the top as given, the left 15 % darker, the right 30 %.
public func isoFaceColors(_ fill: String) -> (top: String, left: String, right: String) {
    (fill, isoShade(fill, 0.15), isoShade(fill, 0.3))
}

/// A number as JavaScript's `String(n)` writes it, for messages.
private func jsNumber(_ v: Double) -> String {
    if v.isFinite && v == v.rounded() && abs(v) < 1e15 { return String(Int(v)) }
    return "\(v)"
}
