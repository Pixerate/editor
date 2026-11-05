import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Distortion brushes (`vector/distortBrush.ts`), after CorelDRAW's Smudge, Twirl, Attract, Repel
// and Roughen tools: each dab is a point map with a smooth falloff; a stroke's dabs are composed
// into one map and the curves re-fitted, or (Roughen) broken into short spiky segments.

/// One dab of a distortion brush (document units).
public struct VectorDistortDab: Sendable {
    public var x: Double
    public var y: Double
    public var radius: Double
    /// 0–1.
    public var strength: Double
    /// Smudge: how far the brush moved since the last dab.
    public var dx: Double?
    public var dy: Double?
    /// Twirl: degrees turned at full strength per dab (default 15).
    public var angle: Double?
    /// Roughen: seed of the spikes (default 1).
    public var seed: Double?
}

/// The brush's weight at distance `d` from its centre: 1 at the centre, 0 at and beyond `r`.
func vectorDistortFalloff(_ d: Double, _ r: Double) -> Double {
    if !(r > 0) || d >= r { return 0 }
    let u = d / r
    let k = 1 - u * u
    return k * k
}

/// The point map of one smooth dab (smudge, twirl, attract, repel).
func vectorDistortDabMap(_ mode: String, _ dab: VectorDistortDab) -> (Vec2) -> Vec2 {
    let s = JS.min(1, JS.max(0, dab.strength))
    return { p in
        let dx = p.x - dab.x
        let dy = p.y - dab.y
        let f = vectorDistortFalloff(JS.hypot(dx, dy), dab.radius) * s
        if f <= 0 { return p }
        switch mode {
        case "smudge":
            return Vec2(p.x + (dab.dx ?? 0) * f, p.y + (dab.dy ?? 0) * f)
        case "twirl":
            let a = (((dab.angle ?? 15) * Double.pi) / 180) * f
            let c = JS.cos(a)
            let sn = JS.sin(a)
            return Vec2(dab.x + dx * c - dy * sn, dab.y + dx * sn + dy * c)
        case "attract":
            return Vec2(p.x - dx * f * 0.5, p.y - dy * f * 0.5)
        default:
            return Vec2(p.x + dx * f * 0.5, p.y + dy * f * 0.5)
        }
    }
}

/// `x >>> n` on a 32-bit value.
@inline(__always) private func ushr(_ x: Int32, _ n: UInt32) -> Int32 { Int32(bitPattern: UInt32(bitPattern: x) >> n) }

/// A deterministic hash of a point to −1…1 (`Math.imul` arithmetic).
private func noise(_ x: Double, _ y: Double, _ seed: Double) -> Double {
    let a = (JS.i32(JS.round(x * 16)) ^ Int32(bitPattern: 0x9E37_79B9)) &* Int32(bitPattern: 0x85EB_CA6B)
    let b = (JS.i32(JS.round(y * 16)) ^ Int32(bitPattern: 0xC2B2_AE35)) &* Int32(0x27D4_EB2F)
    let c = JS.i32(seed) &* Int32(0x1656_67B1)
    var h = a ^ b ^ c
    h ^= ushr(h, 15)
    h = h &* Int32(0x2C1B_3C6D)
    h ^= ushr(h, 12)
    return (Double(UInt32(bitPattern: h)) / Double(0xFFFF_FFFF as UInt32)) * 2 - 1
}

/// Whether a dab can reach a path's bounds.
private func reaches(_ b: PathBounds, _ dab: VectorDistortDab) -> Bool {
    dab.x + dab.radius >= b.minX && dab.x - dab.radius <= b.maxX && dab.y + dab.radius >= b.minY && dab.y - dab.radius <= b.maxY
}

/// Roughen: the contours the dabs reach broken into short segments, their points pushed in and out.
private func roughen(_ path: BezierPath, _ dabs: [VectorDistortDab]) -> BezierPath {
    let step = JS.max(0.5, dabs.map(\.radius).reduce(Double.infinity) { JS.min($0, $1) } / 6)
    let contours = pathToContours(.commands(path)).map { c -> BezierContour in
        guard let b = bezierPathBounds(.commands(contoursToPath([c]))), dabs.contains(where: { reaches(b, $0) }) else { return c }
        let ring = flattenChain(closeContour(c, c.closed), JS.min(0.25, step / 8))
        var pts: [PathPoint] = []
        for i in ring.indices {
            let a = ring[i]
            let nxt: PathPoint? = i + 1 < ring.count ? ring[i + 1] : (c.closed ? ring[0] : nil)
            pts.append(a)
            guard let nxt else { continue }
            let n = Int(JS.floor(JS.hypot(nxt[0] - a[0], nxt[1] - a[1]) / step))
            if n > 1 { for k in 1 ..< n { pts.append(PathPoint(a[0] + ((nxt[0] - a[0]) * Double(k)) / Double(n), a[1] + ((nxt[1] - a[1]) * Double(k)) / Double(n))) } }
        }
        let out = pts.enumerated().map { i, p -> PathPoint in
            let prev = i > 0 ? pts[i - 1] : (c.closed ? pts[pts.count - 1] : p)
            let next = i + 1 < pts.count ? pts[i + 1] : (c.closed ? pts[0] : p)
            let tx = next[0] - prev[0]
            let ty = next[1] - prev[1]
            let hl = JS.hypot(tx, ty)
            let tl = hl != 0 && !hl.isNaN ? hl : 1
            var off = 0.0
            for dab in dabs {
                let f = vectorDistortFalloff(JS.hypot(p[0] - dab.x, p[1] - dab.y), dab.radius) * JS.min(1, JS.max(0, dab.strength))
                if f > 0 { off += noise(p[0], p[1], dab.seed ?? 1) * f * dab.radius * 0.25 * (i % 2 != 0 ? 1 : -1) }
            }
            return PathPoint(p[0] - (ty / tl) * off, p[1] + (tx / tl) * off)
        }
        var segments: [BezierSegment] = []
        if out.count > 1 { for i in 0 ..< (out.count - 1) { segments.append([out[i], out[i + 1]]) } }
        if c.closed && out.count > 1 { segments.append([out[out.count - 1], out[0]]) }
        return BezierContour(segments: segments, closed: c.closed)
    }
    return contoursToPath(contours)
}

/// `mapVectorSubpaths` for Bézier commands (`mapBezierPath`).
func mapBezierPath(_ path: BezierPath, _ f: (Vec2) -> Vec2, _ tolerance: Double = 0.1) -> BezierPath {
    subpathsToBezier(mapVectorSubpaths(bezierToSubpaths(.commands(path)), f, tolerance), corners: false)
}

/// A path distorted by a stroke of dabs (`distortVectorPath`); nil when the stroke never reaches it.
func distortVectorPath(_ path: BezierPath, _ mode: String, _ dabs: [VectorDistortDab]) -> BezierPath? {
    let live = dabs.filter { $0.radius > 0 && $0.strength > 0 }
    guard let b0 = bezierPathBounds(.commands(path)), !live.isEmpty else { return nil }
    if mode == "roughen" {
        let reaching = live.filter { reaches(b0, $0) }
        return reaching.isEmpty ? nil : roughen(path, reaching)
    }
    var grow = 0.0
    var reaching: [VectorDistortDab] = []
    for d in live {
        let b = PathBounds(minX: b0.minX - grow, minY: b0.minY - grow, maxX: b0.maxX + grow, maxY: b0.maxY + grow)
        if reaches(b, d) {
            reaching.append(d)
            grow += JS.hypot(d.dx ?? 0, d.dy ?? 0) + d.radius * 0.5
        }
    }
    if reaching.isEmpty { return nil }
    let maps = reaching.map { vectorDistortDabMap(mode, $0) }
    return mapBezierPath(path, { p in maps.reduce(p) { q, m in m(q) } }, 0.05)
}
