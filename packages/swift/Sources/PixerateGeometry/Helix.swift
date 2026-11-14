// Helices for data visuals (#811), ported line for line from packages/core/src/geom/helix.ts: a
// strand wound around an axis with its depth, and its front and back runs cut at the crossings.
import Foundation
import PixerateRaster

/// How the winding's width changes along the axis.
public enum HelixEnvelope: Sendable {
    case none, pinch, start, end
    case custom(@Sendable (Double) -> Double)

    public init?(name: String) {
        switch name {
        case "none": self = .none
        case "pinch": self = .pinch
        case "start": self = .start
        case "end": self = .end
        default: return nil
        }
    }

    func at(_ t: Double) -> Double {
        switch self {
        case .custom(let f): return f(t)
        case .pinch: return sin(Double.pi * t)
        case .start: return sin((Double.pi * t) / 2)
        case .end: return cos((Double.pi * t) / 2)
        case .none: return 1
        }
    }
}

/// A strand as a polyline with its depth (-1 behind to 1 in front), path data and length.
public struct Helix: Sendable, Equatable {
    public var points: [Vec2]
    public var depth: [Double]
    public var d: String
    public var length: Double
}

/// A front or back run of a strand, with where it starts and ends along the whole strand.
public struct HelixRun: Sendable, Equatable {
    public var front: Bool
    public var points: [Vec2]
    public var d: String
    public var from: Double
    public var to: Double
    public var length: Double
}

private func helixD(_ points: [Vec2]) -> String {
    var d = ""
    for (i, p) in points.enumerated() { d += "\(i == 0 ? "M" : "L")\(formatNumber(p.x, 3)) \(formatNumber(p.y, 3))" }
    return d
}

/// A strand wound around the axis from `axis.0` to `axis.1` (`helix` in the TS core). `samples`
/// defaults to 48 per turn, at least 8.
public func helix(_ axis: (Vec2, Vec2), amplitude: Double = 12, turns: Double = 2, phase: Double = 0, envelope: HelixEnvelope = .none, samples samplesOption: Double? = nil) -> Helix {
    let (a, b) = axis
    let samples = Int(max(1, JS.round(samplesOption ?? max(8, JS.ceil(abs(turns) * 48)))))
    let len = ((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)).squareRoot()
    let ux = len == 0 ? 1 : (b.x - a.x) / len
    let uy = len == 0 ? 0 : (b.y - a.y) / len
    let nx = uy, ny = -ux
    var points: [Vec2] = []
    var depth: [Double] = []
    var length = 0.0
    for i in 0...samples {
        let t = Double(i) / Double(samples)
        let angle = 2 * Double.pi * turns * t + phase
        let off = amplitude * envelope.at(t) * sin(angle)
        let p = Vec2(x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off)
        if i > 0 {
            let q = points[i - 1]
            length += ((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y)).squareRoot()
        }
        points.append(p)
        depth.append(cos(angle))
    }
    return Helix(points: points, depth: depth, d: helixD(points), length: length)
}

/// Cuts a polyline into runs in front of (depth ≥ 0) and behind (depth < 0) the axis plane, each
/// cut exactly where the depth (linear between points) is zero (`splitByDepth` in the TS core).
public func splitByDepth(_ points: [Vec2], _ depth: [Double]) -> [HelixRun] {
    let n = min(points.count, depth.count)
    if n == 0 { return [] }
    var side = [Bool](repeating: false, count: n)
    var first = true
    for i in 0..<n where depth[i] != 0 { first = depth[i] > 0; break }
    for i in 0..<n { side[i] = depth[i] > 0 ? true : depth[i] < 0 ? false : i == 0 ? first : side[i - 1] }
    var runs: [HelixRun] = []
    var run: [Vec2] = [Vec2(x: points[0].x, y: points[0].y)]
    var runFrom = 0.0
    var at = 0.0
    func close(_ front: Bool, _ to: Double) {
        runs.append(HelixRun(front: front, points: run, d: helixD(run), from: runFrom, to: to, length: to - runFrom))
    }
    if n > 1 {
        for i in 1..<n {
            let p = points[i - 1], q = points[i]
            let seg = ((q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y)).squareRoot()
            if side[i] != side[i - 1] {
                let f = depth[i - 1] == depth[i] ? 0 : depth[i - 1] / (depth[i - 1] - depth[i])
                let cut = Vec2(x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f)
                let cutAt = at + seg * f
                if f > 0 { run.append(cut) }
                close(side[i - 1], cutAt)
                run = [cut]
                runFrom = cutAt
            }
            at += seg
            run.append(Vec2(x: q.x, y: q.y))
        }
    }
    close(side[n - 1], at)
    return runs
}
