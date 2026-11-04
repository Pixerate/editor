import Foundation
import PixerateCore
import PixerateRaster

/**
 * Flow maps (`paint/wet/flow.ts`): a push on the water at every cell (cells per step², like tilt),
 * from a few generated patterns, each computed with + − × ÷ only so it is the same everywhere.
 */

/// A flow map: a vector per document pixel, in cells per step² at strength 1.
public typealias WetFlowField = (Double, Double) -> (Double, Double)

public let WET_FLOW_KINDS = ["none", "linear", "swirl", "radial", "turbulent"]

/// A flow map as settings (saved with the document).
public struct WetFlowSpec: Equatable, Sendable {
    public var kind: String
    /// 0..1: how hard it pushes.
    public var strength: Double
    /// `linear`: direction in degrees clockwise from canvas down.
    public var angle: Double
    /// `swirl` / `radial`: centre in document pixels (default the canvas centre).
    public var center: (x: Double, y: Double)?
    /// `swirl`: true turns clockwise.
    public var clockwise: Bool
    /// `turbulent`: eddy size in pixels (8..1024).
    public var scale: Double
    public var seed: Int

    public static func == (a: WetFlowSpec, b: WetFlowSpec) -> Bool {
        a.kind == b.kind && a.strength == b.strength && a.angle == b.angle && a.center?.x == b.center?.x && a.center?.y == b.center?.y && a.clockwise == b.clockwise && a.scale == b.scale && a.seed == b.seed
    }

    public var json: JSONValue {
        var o: JSONObject = ["kind": .string(kind), "strength": .number(strength), "angle": .number(angle)]
        if let c = center { o["center"] = pointJSON(c.x, c.y) }
        o["clockwise"] = .bool(clockwise)
        o["scale"] = .number(scale)
        o["seed"] = .number(Double(seed))
        return .object(o)
    }
}

public let DEFAULT_FLOW = WetFlowSpec(kind: "none", strength: 0.5, angle: 0, center: nil, clockwise: true, scale: 120, seed: 1)

/// Acceleration of a flow map at strength 1, cells per step².
private let FLOW_ACCEL = 0.01

/// sin and cos of an angle in radians, by range reduction and Taylor series (deterministic).
func dsincos(_ a: Double) -> (Double, Double) {
    let twoPi = 6.283185307179586
    var x = a - JS.round(a / twoPi) * twoPi
    let q = JS.round(x / (twoPi / 4))
    x -= q * (twoPi / 4)
    let x2 = x * x
    var s = x, c = 1.0, ts = x, tc = 1.0
    for i in 1..<12 {
        let di = Double(i)
        ts *= -x2 / ((2 * di) * (2 * di + 1))
        tc *= -x2 / ((2 * di - 1) * (2 * di))
        s += ts
        c += tc
    }
    let qi = Int(q)
    switch ((qi % 4) + 4) % 4 {
    case 0: return (s, c)
    case 1: return (c, -s)
    case 2: return (-s, -c)
    default: return (-c, s)
    }
}

private func flowHash(_ x: Int, _ y: Int, _ seed: Int) -> Double {
    let xi = Int32(truncatingIfNeeded: x), yi = Int32(truncatingIfNeeded: y), si = Int32(truncatingIfNeeded: seed)
    var h = (xi &* 374761393) &+ (yi &* 668265263) &+ (si &* 1442695041)
    h = (h ^ Int32(bitPattern: UInt32(bitPattern: h) >> 13)) &* 1274126177
    h ^= Int32(bitPattern: UInt32(bitPattern: h) >> 16)
    return Double(UInt32(bitPattern: h)) / 4294967296
}

private func valueNoise(_ x: Double, _ y: Double, _ seed: Int) -> Double {
    let x0 = JS.floor(x), y0 = JS.floor(y)
    let fx = x - x0, fy = y - y0
    let sx = fx * fx * (3 - 2 * fx)
    let sy = fy * fy * (3 - 2 * fy)
    let ix = Int(x0), iy = Int(y0)
    let a = flowHash(ix, iy, seed)
    let b = flowHash(ix + 1, iy, seed)
    let c = flowHash(ix, iy + 1, seed)
    let d = flowHash(ix + 1, iy + 1, seed)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

/// Settings with every field in range.
public func normalizeFlow(_ raw: JSONObject = [:], _ base: WetFlowSpec = DEFAULT_FLOW) -> WetFlowSpec {
    func num(_ k: String, _ d: Double) -> Double { raw[k]?.numberValue.flatMap { $0.isFinite ? $0 : nil } ?? d }
    let kind = raw["kind"]?.stringValue.flatMap { WET_FLOW_KINDS.contains($0) ? $0 : nil } ?? base.kind
    var center = base.center
    if let c = raw["center"]?.objectValue, let x = c["x"]?.numberValue, let y = c["y"]?.numberValue, x.isFinite, y.isFinite { center = (x, y) }
    let angle = (num("angle", base.angle).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    let seed = Int(Swift.abs(JS.round(num("seed", Double(base.seed)))).truncatingRemainder(dividingBy: 2147483647))
    return WetFlowSpec(
        kind: kind,
        strength: Swift.min(1, Swift.max(0, num("strength", base.strength))),
        angle: angle,
        center: center,
        clockwise: raw["clockwise"]?.boolValue ?? base.clockwise,
        scale: Swift.min(1024, Swift.max(8, num("scale", base.scale))),
        seed: seed
    )
}

/// The flow field of a spec on a canvas, or nil for `none` (strength is applied by the world).
public func flowField(_ spec: WetFlowSpec, _ width: Int, _ height: Int) -> WetFlowField? {
    let k = FLOW_ACCEL
    let cx = spec.center?.x ?? Double(width) / 2
    let cy = spec.center?.y ?? Double(height) / 2
    let r0 = Double(Swift.max(width, height)) / 2
    switch spec.kind {
    case "linear":
        let (s, c) = dsincos((spec.angle * Double.pi) / 180)
        let v = (-s * k, c * k)
        return { _, _ in v }
    case "swirl":
        let sign = spec.clockwise ? 1.0 : -1.0
        return { x, y in ((-(y - cy) / r0) * k * sign, ((x - cx) / r0) * k * sign) }
    case "radial":
        return { x, y in (((x - cx) / r0) * k, ((y - cy) / r0) * k) }
    case "turbulent":
        let sc = spec.scale
        let e = 0.5
        let seed = spec.seed
        return { x, y in
            let u = x / sc
            let v = y / sc
            let dndy = (valueNoise(u, v + e / sc, seed) - valueNoise(u, v - e / sc, seed)) * sc
            let dndx = (valueNoise(u + e / sc, v, seed) - valueNoise(u - e / sc, v, seed)) * sc
            return (dndy * k * 0.5, -dndx * k * 0.5)
        }
    default:
        return nil
    }
}
