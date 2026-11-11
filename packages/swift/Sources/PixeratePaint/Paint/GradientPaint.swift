import Foundation
import PixerateCore
import PixerateRaster

/**
 * Gradient paint: a colour slot (the paint colour, a swatch, a stroke's colour) holds a
 * `PaintSource`, either one colour or a gradient that the brush samples dab by dab as the stroke
 * goes: by distance travelled, pen pressure, tilt, speed, direction, time, across the tip, or at
 * random. The port of `paint/gradient-paint.ts`.
 *
 * - **Stops** have the vector and image gradients' shape (`offset`, `color`, `opacity`,
 *   `midpoint`); opacity multiplies the brush's flow. `softness` (1, smooth, by default) turns
 *   each blend into a harder step towards 0.
 * - **Space**: `pigment` (default) mixes neighbouring stops like paint (Kubelka-Munk, so blue to
 *   yellow passes through green), `oklab` perceptually, `srgb` as plain numbers.
 * - **Mapping**: what moves along the gradient. `distance` (default: 300 px, mirrored) is the
 *   "drag it out" paint: the colour changes as the stroke travels.
 *
 * Everything is a pure function of the stroke's recorded samples and seed, so replays stay exact.
 */

/// sRGB 0..1.
public typealias PaintRgb = [Double]

/// A gradient stop: the vector and image gradients' shape.
public struct PaintGradientStop: Equatable, Sendable {
    /// 0..1 along the gradient.
    public var offset: Double
    /// #rrggbb, or `paint` / `secondary`: the editor's paint and second colours when the stroke starts.
    public var color: String
    /// 0..1 (missing: 1): multiplies the brush's flow where this colour is laid.
    public var opacity: Double?
    /// Where between this stop and the next the colours are half mixed (missing: 0.5).
    public var midpoint: Double?

    public init(offset: Double, color: String, opacity: Double? = nil, midpoint: Double? = nil) {
        self.offset = offset
        self.color = color
        self.opacity = opacity
        self.midpoint = midpoint
    }

    public var json: JSONValue {
        var o: JSONObject = ["offset": .number(offset), "color": .string(color)]
        if let opacity { o["opacity"] = .number(opacity) }
        if let midpoint { o["midpoint"] = .number(midpoint) }
        return .object(o)
    }
}

public let PAINT_GRADIENT_SPACES = ["pigment", "oklab", "srgb"]
public let PAINT_GRADIENT_REPEATS = ["clamp", "repeat", "mirror"]
public let PAINT_GRADIENT_MAPPINGS = ["distance", "pressure", "tilt", "velocity", "direction", "time", "across-tip", "random"]

/// What moves a stroke along its gradient (`by` and the fields that mapping has).
public struct PaintGradientMapping: Equatable, Sendable {
    public var by: String
    /// distance: px (or dabs) per run.
    public var length: Double?
    /// distance and time: past the end.
    public var `repeat`: String?
    /// distance: `px` or `dabs`.
    public var unit: String?
    /// time: ms per run.
    public var duration: Double?
    /// random: dabs per pick.
    public var every: Double?

    public init(by: String, length: Double? = nil, repeat: String? = nil, unit: String? = nil, duration: Double? = nil, every: Double? = nil) {
        self.by = by
        self.length = length
        self.repeat = `repeat`
        self.unit = unit
        self.duration = duration
        self.every = every
    }

    public var json: JSONValue {
        var o: JSONObject = ["by": .string(by)]
        if let length { o["length"] = .number(length) }
        if let duration { o["duration"] = .number(duration) }
        if let `repeat` { o["repeat"] = .string(`repeat`) }
        if let unit { o["unit"] = .string(unit) }
        if let every { o["every"] = .number(every) }
        return .object(o)
    }
}

public struct PaintGradientSource: Equatable, Sendable {
    /// 2..16 stops, sorted by offset.
    public var stops: [PaintGradientStop]
    public var space: String
    public var map: PaintGradientMapping
    /// 0 (hard steps) .. 1 (smooth blends, default); missing is 1.
    public var softness: Double?

    public init(stops: [PaintGradientStop], space: String, map: PaintGradientMapping, softness: Double? = nil) {
        self.stops = stops
        self.space = space
        self.map = map
        self.softness = softness
    }

    public var json: JSONValue {
        var o: JSONObject = ["type": "gradient", "stops": .array(stops.map(\.json)), "space": .string(space), "map": map.json]
        if let softness { o["softness"] = .number(softness) }
        return .object(o)
    }
}

/// What a colour slot holds: one colour or a gradient.
public enum PaintSource: Equatable, Sendable {
    case color(String)
    case gradient(PaintGradientSource)

    public var json: JSONValue {
        switch self {
        case .color(let c): ["type": "color", "color": .string(c)]
        case .gradient(let g): g.json
        }
    }
}

/// "Drag it out": 300 px of travel per run, mirrored back and forth.
public let DEFAULT_PAINT_GRADIENT_MAPPING = PaintGradientMapping(by: "distance", length: 300, repeat: "mirror", unit: "px")

/// Speed (px/ms) at which `velocity` reaches the end of the gradient.
public let PAINT_GRADIENT_FULL_SPEED = 2.5

/// Seed stream of `random` (the multi-colour brush's, so migrated brushes pick the same colours).
private let RANDOM_STREAM = 11

public struct PaintSourceError: Error, LocalizedError, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}

/// `#rgb` / `#rrggbb` → lowercase `#rrggbb`, or nil.
public func normalizeHexColor(_ v: JSONValue?) -> String? {
    guard let s = v?.stringValue else { return nil }
    let h = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard h.range(of: "^#([0-9a-f]{3}|[0-9a-f]{6})$", options: .regularExpression) != nil else { return nil }
    if h.count == 4 {
        let c = Array(h)
        return "#\(c[1])\(c[1])\(c[2])\(c[2])\(c[3])\(c[3])"
    }
    return h
}

/// `#rrggbb` → sRGB 0..1.
public func hexToPaintRgb(_ hex: String) -> PaintRgb {
    let n = Int(hex.dropFirst(), radix: 16) ?? 0
    return [Double((n >> 16) & 255) / 255, Double((n >> 8) & 255) / 255, Double(n & 255) / 255]
}

/// How a value reads in a message: strings quoted, anything else as `JSON.stringify` prints it.
func describeValue(_ v: JSONValue?) -> String {
    guard let v else { return "undefined" }
    if case .string(let s) = v { return "\"\(s)\"" }
    return v.stringified()
}

private func finiteNumber(_ v: JSONValue?) -> Double? {
    guard let n = v?.numberValue, n.isFinite else { return nil }
    return n
}

private func parseMapping(_ raw: JSONValue?, _ at: String) throws -> PaintGradientMapping {
    guard let raw else { return DEFAULT_PAINT_GRADIENT_MAPPING }
    guard let r = raw.objectValue else { throw PaintSourceError("\(at) must be an object like { \"by\": \"distance\", \"length\": 300, \"repeat\": \"mirror\" }.") }
    guard let by = r["by"]?.stringValue, PAINT_GRADIENT_MAPPINGS.contains(by) else {
        throw PaintSourceError("\(at).by \(describeValue(r["by"])) is not a mapping; use one of \(PAINT_GRADIENT_MAPPINGS.joined(separator: ", ")).")
    }
    func repeatOf(_ key: String, _ def: String) throws -> String {
        guard let v = r[key] else { return def }
        guard let s = v.stringValue, PAINT_GRADIENT_REPEATS.contains(s) else {
            throw PaintSourceError("\(at).\(key) \(describeValue(v)) is not a repeat; use \(PAINT_GRADIENT_REPEATS.joined(separator: ", ")).")
        }
        return s
    }
    func range(_ key: String, _ lo: Double, _ hi: Double, _ def: Double, _ unit: String) throws -> Double {
        guard let v = r[key] else { return def }
        guard let n = finiteNumber(v), n >= lo, n <= hi else {
            throw PaintSourceError("\(at).\(key) \(describeValue(v)) is out of range; use \(JSONValue.number(lo).stringified())..\(JSONValue.number(hi).stringified()) \(unit).")
        }
        return n
    }
    switch by {
    case "distance":
        let unit: String
        if let u = r["unit"] {
            guard let s = u.stringValue, s == "px" || s == "dabs" else { throw PaintSourceError("\(at).unit \(describeValue(u)) is not a unit; use px or dabs.") }
            unit = s
        } else {
            unit = "px"
        }
        return PaintGradientMapping(by: by, length: try range("length", 1, unit == "px" ? 100000 : 10000, 300, unit), repeat: try repeatOf("repeat", "mirror"), unit: unit)
    case "time":
        return PaintGradientMapping(by: by, repeat: try repeatOf("repeat", "clamp"), duration: try range("duration", 1, 600000, 2000, "ms"))
    case "random":
        return PaintGradientMapping(by: by, every: JS.round(try range("every", 1, 500, 1, "dabs")))
    default:
        return PaintGradientMapping(by: by)
    }
}

/**
 * Reads a paint source strictly: what tools and APIs take. Throws `PaintSourceError` saying what
 * is wrong and how to fix it. Missing optional fields get their defaults.
 */
public func parsePaintSource(_ raw: JSONValue?, at: String = "paint") throws -> PaintSource {
    if case .string(let s)? = raw {
        guard let color = normalizeHexColor(.string(s)) else { throw PaintSourceError("\(at) \(describeValue(raw)) is not a colour; use #rrggbb or a gradient object.") }
        return .color(color)
    }
    guard let r = raw?.objectValue else { throw PaintSourceError("\(at) must be { \"type\": \"color\", \"color\": \"#rrggbb\" } or { \"type\": \"gradient\", \"stops\": [...] }.") }
    if r["type"] == "color" {
        guard let color = normalizeHexColor(r["color"]) else { throw PaintSourceError("\(at).color \(describeValue(r["color"])) is not a colour; use #rrggbb.") }
        return .color(color)
    }
    guard r["type"] == "gradient" else { throw PaintSourceError("\(at).type \(describeValue(r["type"])) is not a paint; use \"color\" or \"gradient\".") }
    guard let list = r["stops"]?.arrayValue, list.count >= 2, list.count <= 16 else {
        let got = r["stops"]?.arrayValue.map { String($0.count) } ?? describeValue(r["stops"])
        throw PaintSourceError("\(at).stops needs 2..16 stops like { \"offset\": 0, \"color\": \"#1d4ed8\" }; got \(got).")
    }
    var stops: [PaintGradientStop] = []
    for (i, s) in list.enumerated() {
        let sat = "\(at).stops[\(i)]"
        guard let o = s.objectValue else { throw PaintSourceError("\(sat) must be { \"offset\": 0..1, \"color\": \"#rrggbb\" }.") }
        guard let offset = finiteNumber(o["offset"]), offset >= 0, offset <= 1 else { throw PaintSourceError("\(sat).offset \(describeValue(o["offset"])) must be a number 0..1.") }
        let c = o["color"]?.stringValue
        guard let color = (c == "paint" || c == "secondary") ? c : normalizeHexColor(o["color"]) else {
            throw PaintSourceError("\(sat).color \(describeValue(o["color"])) is not a colour; use #rrggbb, \"paint\" or \"secondary\".")
        }
        var stop = PaintGradientStop(offset: offset, color: color)
        if let v = o["opacity"] {
            guard let n = finiteNumber(v), n >= 0, n <= 1 else { throw PaintSourceError("\(sat).opacity \(describeValue(v)) must be 0..1.") }
            if n != 1 { stop.opacity = n }
        }
        if let v = o["midpoint"] {
            guard let n = finiteNumber(v), n >= 0.05, n <= 0.95 else { throw PaintSourceError("\(sat).midpoint \(describeValue(v)) must be 0.05..0.95.") }
            if n != 0.5 { stop.midpoint = n }
        }
        stops.append(stop)
    }
    for i in 1..<stops.count where stops[i].offset < stops[i - 1].offset {
        throw PaintSourceError("\(at).stops must be sorted by offset: stop \(i) (\(JSONValue.number(stops[i].offset).stringified())) comes before stop \(i - 1) (\(JSONValue.number(stops[i - 1].offset).stringified())).")
    }
    let space: String
    if let v = r["space"] {
        guard let s = v.stringValue, PAINT_GRADIENT_SPACES.contains(s) else { throw PaintSourceError("\(at).space \(describeValue(v)) is not a space; use \(PAINT_GRADIENT_SPACES.joined(separator: ", ")).") }
        space = s
    } else {
        space = "pigment"
    }
    var out = PaintGradientSource(stops: stops, space: space, map: try parseMapping(r["map"], "\(at).map"))
    if let v = r["softness"] {
        guard let n = finiteNumber(v), n >= 0, n <= 1 else { throw PaintSourceError("\(at).softness \(describeValue(v)) must be 0..1.") }
        if n != 1 { out.softness = n }
    }
    return .gradient(out)
}

/// Reads a paint source leniently (documents, presets): nil when it is not one.
public func readPaintSource(_ raw: JSONValue?) -> PaintSource? {
    guard let raw, raw != .null else { return nil }
    return try? parsePaintSource(raw)
}

/// The gradient with its `paint` / `secondary` stops replaced by those colours (#rrggbb).
public func resolvePaintGradient(_ g: PaintGradientSource, paint: String, secondary: String) -> PaintGradientSource {
    guard g.stops.contains(where: { $0.color == "paint" || $0.color == "secondary" }) else { return g }
    var out = g
    out.stops = g.stops.map { s in
        var s = s
        if s.color == "paint" { s.color = paint } else if s.color == "secondary" { s.color = secondary }
        return s
    }
    return out
}

// MARK: - Sampling

/// Where `u` (0..1 of a segment) lands with the midpoint `m`.
private func midpointRemap(_ u: Double, _ m: Double) -> Double {
    if abs(m - 0.5) < 1e-6 { return u }
    return u <= m ? (0.5 * u) / m : 0.5 + (0.5 * (u - m)) / (1 - m)
}

/// Softness 1 keeps the blend; towards 0 it becomes a step at ½.
func softenBlend(_ f: Double, _ softness: Double) -> Double {
    if softness >= 1 { return f }
    let w = Swift.max(1e-3, softness)
    return Swift.min(1, Swift.max(0, (f - 0.5) / w + 0.5))
}

@inline(__always) func q8(_ v: Double) -> Int { Int(JS.round(Swift.min(1, Swift.max(0, v)) * 255)) }

private func srgbToLinear(_ v: Double) -> Double {
    v <= 0.04045 ? v / 12.92 : JS.pow((v + 0.055) / 1.055, 2.4)
}

private func linearToSrgb(_ v: Double) -> Double {
    v <= 0.0031308 ? 12.92 * v : 1.055 * JS.pow(v, 1 / 2.4) - 0.055
}

private func toOklab(_ c: PaintRgb) -> PaintRgb {
    let r = srgbToLinear(c[0]), g = srgbToLinear(c[1]), b = srgbToLinear(c[2])
    let l = JS.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    let m = JS.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    let s = JS.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

private func cube(_ v: Double) -> Double { JS.pow(v, 3) }

private func fromOklab(_ c: PaintRgb) -> PaintRgb {
    let l = cube(c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2])
    let m = cube(c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2])
    let s = cube(c[0] - 0.0894841775 * c[1] - 1.291485548 * c[2])
    let out = [
        linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ]
    // Rounded to 16 bits so last-bit differences between engines' pow / cbrt never show.
    return out.map { JS.round(Swift.min(1, Swift.max(0, $0)) * 65535) / 65535 }
}

private struct RampStop {
    var t: Double
    var rgb: PaintRgb
    var lab: PaintRgb?
    var alpha: Double
    var mid: Double
}

/// A gradient's colour at a dab: sRGB 0..1 and the opacity to multiply the flow by.
public struct PaintGradientSample {
    public var rgb: PaintRgb = [0, 0, 0]
    public var alpha: Double = 1
    public init() {}
}

/// What a dab offers a mapping: all pure functions of the stroke's recorded samples and seed.
public struct PaintDabParams {
    public var travel: Double
    public var index: Int
    public var pressure: Double
    public var lean: Double
    public var speed: Double?
    public var direction: Double
    public var time: Double?

    /// Public so hosts outside the module can build one (#747).
    public init(
        travel: Double,
        index: Int,
        pressure: Double,
        lean: Double,
        speed: Double? = nil,
        direction: Double,
        time: Double? = nil
    ) {
        self.travel = travel
        self.index = index
        self.pressure = pressure
        self.lean = lean
        self.speed = speed
        self.direction = direction
        self.time = time
    }
}

/**
 * A gradient prepared for sampling. `dab` gives the colour of one dab; `across-tip` gradients give
 * a table across the tip instead (`tipTable`).
 */
public final class PaintGradientSampler {
    public let source: PaintGradientSource
    private let seed: Int
    private let stops: [RampStop]
    private let softness: Double
    /// Stops at exactly k/(n − 1): segments found by arithmetic, as the multi-colour brush did.
    private let uniform: Bool
    public let acrossTip: Bool
    private var mixScratch = [0.0, 0.0, 0.0]

    public init(_ source: PaintGradientSource, seed: Int = 0) {
        self.source = source
        self.seed = seed
        stops = source.stops.map { s in
            let rgb: PaintRgb = s.color == "paint" ? [0, 0, 0] : s.color == "secondary" ? [1, 1, 1] : hexToPaintRgb(s.color)
            return RampStop(t: s.offset, rgb: rgb, lab: source.space == "oklab" ? toOklab(rgb) : nil, alpha: s.opacity ?? 1, mid: s.midpoint ?? 0.5)
        }
        softness = source.softness ?? 1
        let n = stops.count
        uniform = stops.enumerated().allSatisfy { k, s in s.t == Double(k) / Double(n - 1) && s.mid == 0.5 }
        acrossTip = source.map.by == "across-tip"
    }

    /// The two stops' mix `u` of the way (0..1), in the gradient's space.
    private func mix(_ a: RampStop, _ b: RampStop, _ u: Double) -> PaintGradientSample {
        var out = PaintGradientSample()
        let v = softenBlend(u, softness)
        out.alpha = a.alpha + (b.alpha - a.alpha) * v
        let ar = a.rgb, br = b.rgb
        if v <= 0 || (ar[0] == br[0] && ar[1] == br[1] && ar[2] == br[2]) {
            out.rgb = ar
            return out
        }
        if v >= 1 {
            out.rgb = br
            return out
        }
        if source.space == "pigment" {
            mixPigment8(q8(ar[0]), q8(ar[1]), q8(ar[2]), q8(br[0]), q8(br[1]), q8(br[2]), v, &mixScratch)
            out.rgb = mixScratch
        } else if source.space == "oklab" {
            let la = a.lab!, lb = b.lab!
            out.rgb = fromOklab([la[0] + (lb[0] - la[0]) * v, la[1] + (lb[1] - la[1]) * v, la[2] + (lb[2] - la[2]) * v])
        } else {
            out.rgb = [ar[0] + (br[0] - ar[0]) * v, ar[1] + (br[1] - ar[1]) * v, ar[2] + (br[2] - ar[2]) * v]
        }
        return out
    }

    /// The colour at `t` (clamped to 0..1).
    public func sample(_ t: Double) -> PaintGradientSample {
        let st = stops
        let n = st.count
        if uniform {
            let f = Swift.min(1, Swift.max(0, t)) * Double(n - 1)
            let i = Swift.min(n - 2, Int(JS.floor(f)))
            return mix(st[i], st[i + 1], f - Double(i))
        }
        if !(t > st[0].t) { return mix(st[0], st[0], 0) }
        if t >= st[n - 1].t { return mix(st[n - 1], st[n - 1], 0) }
        var i = 0
        while i < n - 2 && !(t < st[i + 1].t) { i += 1 }
        let a = st[i], b = st[i + 1]
        let h = b.t - a.t
        return mix(a, b, h > 0 ? midpointRemap((t - a.t) / h, a.mid) : 1)
    }

    /// Sampled `travel / length` runs along, past the end as `repeat` says.
    private func along(_ travel: Double, _ length: Double, _ repeatMode: String) -> PaintGradientSample {
        let n = stops.count
        if repeatMode == "repeat" && uniform {
            // Whole segments: the multi-colour brush's `(index / length) % colours`, to the bit.
            let segs = Double(n - 1)
            let f = (travel / (length / segs)).truncatingRemainder(dividingBy: segs)
            let i = Swift.min(n - 2, Int(JS.floor(f)))
            return mix(stops[i], stops[i + 1], f - Double(i))
        }
        let x = travel / length
        let t: Double
        if repeatMode == "clamp" { t = x } else if repeatMode == "repeat" { t = x - JS.floor(x) } else {
            let m = x - 2 * JS.floor(x / 2)
            t = m <= 1 ? m : 2 - m
        }
        return sample(t)
    }

    /// The colour of one dab (not for `across-tip`: see `tipTable`).
    public func dab(_ d: PaintDabParams) -> PaintGradientSample {
        let map = source.map
        switch map.by {
        case "distance":
            return along(map.unit == "dabs" ? Double(d.index) : d.travel, map.length ?? 300, map.repeat ?? "mirror")
        case "pressure":
            return sample(d.pressure)
        case "tilt":
            return sample(d.lean)
        case "velocity":
            return sample(d.speed.map { Swift.min(1, $0 / PAINT_GRADIENT_FULL_SPEED) } ?? 0)
        case "direction":
            let turn = d.direction / (2 * Double.pi)
            return sample(turn - JS.floor(turn))
        case "time":
            return along(d.time ?? 0, map.duration ?? 2000, map.repeat ?? "clamp")
        case "random":
            return sample(PixerateRandom.rand01(seed, Int(JS.floor(Double(d.index) / (map.every ?? 1))), RANDOM_STREAM))
        default:
            return sample(0.5)
        }
    }

    /// `steps` colours from the left edge of the tip to the right (`across-tip`).
    public func tipTable(_ steps: Int) -> [PaintGradientSample] {
        (0..<steps).map { sample(Double($0) / Double(steps - 1)) }
    }
}
