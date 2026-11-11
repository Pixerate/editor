// Portions ported from filmcraft-main/crates/project/src/keyframe.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors)
// by way of packages/core/src/animation/easing.ts. See THIRD_PARTY_NOTICES.md.

import Foundation

/**
 Keyframe easing (`animation/easing.ts`): the curve a segment follows from one keyframe to the next.

 - `hold` keeps the first keyframe's value until the next one (a step).
 - `linear` and the CSS presets (`ease`, `ease-in`, `ease-out`, `ease-in-out`) are CSS-compatible
   `cubic-bezier()` curves; `.cubicBezier` is any such curve.
 - `spring` is a damped spring settling on the next value (it may overshoot); `elastic` oscillates.

 Numbers match the TS core to about 1e-9 (Foundation maths, not V8's).
 */
public enum AnimationEasing: Equatable, Sendable {
    /// A preset name (`ANIMATION_EASING_PRESETS`) or a CSS easing string (`cubic-bezier(…)`, `steps(1, end)`).
    case named(String)
    case cubicBezier(x1: Double, y1: Double, x2: Double, y2: Double)
    /// Defaults: stiffness 170, damping 26, mass 1, velocity 0 (units of the segment's change per second).
    case spring(stiffness: Double? = nil, damping: Double? = nil, mass: Double? = nil, velocity: Double? = nil)
    /// Defaults: amplitude 1, period 0.3 (fraction of the length), mode `out` (`in`, `in-out`).
    case elastic(amplitude: Double? = nil, period: Double? = nil, mode: String? = nil)

    /// An easing from JSON, or nil when it is not a usable easing (`isAnimationEasing`).
    public init?(json: JSONValue) {
        guard isAnimationEasing(json) else { return nil }
        if let s = json.stringValue {
            self = .named(s)
            return
        }
        let o = json.objectValue!
        func num(_ k: String) -> Double? { o[k]?.numberValue }
        switch o["type"]?.stringValue {
        case "spring": self = .spring(stiffness: num("stiffness"), damping: num("damping"), mass: num("mass"), velocity: num("velocity"))
        case "elastic": self = .elastic(amplitude: num("amplitude"), period: num("period"), mode: o["mode"]?.stringValue)
        default: self = .cubicBezier(x1: num("x1")!, y1: num("y1")!, x2: num("x2")!, y2: num("y2")!)
        }
    }

    /// The easing as the TS core writes it: a string, or `{ type, … }` with the fields that are set.
    public var json: JSONValue {
        switch self {
        case .named(let s): return .string(s)
        case let .cubicBezier(x1, y1, x2, y2): return ["type": "cubic-bezier", "x1": .number(x1), "y1": .number(y1), "x2": .number(x2), "y2": .number(y2)]
        case let .spring(stiffness, damping, mass, velocity):
            var o: JSONObject = ["type": "spring"]
            if let stiffness { o["stiffness"] = .number(stiffness) }
            if let damping { o["damping"] = .number(damping) }
            if let mass { o["mass"] = .number(mass) }
            if let velocity { o["velocity"] = .number(velocity) }
            return .object(o)
        case let .elastic(amplitude, period, mode):
            var o: JSONObject = ["type": "elastic"]
            if let amplitude { o["amplitude"] = .number(amplitude) }
            if let period { o["period"] = .number(period) }
            if let mode { o["mode"] = .string(mode) }
            return .object(o)
        }
    }
}

/// Preset names, in picker order.
public let ANIMATION_EASING_PRESETS: [String] = [
    "linear", "ease", "ease-in", "ease-out", "ease-in-out", "ease-in-back", "ease-out-back", "ease-out-elastic", "ease-in-elastic", "ease-in-out-elastic",
    "elastic", "spring", "spring-gentle", "spring-quick", "spring-bouncy", "spring-slow", "hold",
]

/// Picker labels for the presets.
public let ANIMATION_EASING_LABELS: [String: String] = [
    "linear": "Linear", "hold": "Hold", "ease": "Ease", "ease-in": "Ease in", "ease-out": "Ease out", "ease-in-out": "Ease in-out", "ease-in-back": "Back in",
    "ease-out-back": "Back out", "ease-out-elastic": "Elastic out", "ease-in-elastic": "Elastic in", "ease-in-out-elastic": "Elastic in-out", "elastic": "Elastic",
    "spring": "Spring", "spring-gentle": "Spring (gentle)", "spring-quick": "Spring (quick)", "spring-bouncy": "Spring (bouncy)", "spring-slow": "Spring (slow)",
]

/// The CSS control points of the bezier presets (CSS Easing Functions Level 1 values for the CSS keywords).
public let CUBIC_BEZIER_PRESETS: [String: [Double]] = [
    "linear": [0, 0, 1, 1],
    "ease": [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
    "ease-in-back": [0.36, 0, 0.66, -0.56],
    "ease-out-back": [0.34, 1.56, 0.64, 1],
]

/// A spring with every field set.
public struct SpringParameters: Equatable, Sendable {
    public var stiffness: Double
    public var damping: Double
    public var mass: Double
    public var velocity: Double
    public init(stiffness: Double = 170, damping: Double = 26, mass: Double = 1, velocity: Double = 0) {
        self.stiffness = stiffness
        self.damping = damping
        self.mass = mass
        self.velocity = velocity
    }
}

/// An elastic curve with every field set.
public struct ElasticParameters: Equatable, Sendable {
    public var amplitude: Double
    public var period: Double
    /// `out`, `in` or `in-out`.
    public var mode: String
    public init(amplitude: Double = 1, period: Double = 0.3, mode: String = "out") {
        self.amplitude = amplitude
        self.period = period
        self.mode = mode
    }
}

private let DEFAULT_SPRING = SpringParameters()
private let DEFAULT_ELASTIC = ElasticParameters()

/// Figma's named springs (mass 1): gentle 100 / 15, quick 300 / 20, bouncy 600 / 15, slow 80 / 20 (stiffness / damping).
public let SPRING_PRESETS: [String: SpringParameters] = [
    "spring-gentle": SpringParameters(stiffness: 100, damping: 15, mass: 1, velocity: 0),
    "spring-quick": SpringParameters(stiffness: 300, damping: 20, mass: 1, velocity: 0),
    "spring-bouncy": SpringParameters(stiffness: 600, damping: 15, mass: 1, velocity: 0),
    "spring-slow": SpringParameters(stiffness: 80, damping: 20, mass: 1, velocity: 0),
]

private func clampValue(_ v: Double, _ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, v)) }
private func finite(_ v: Double?, _ fallback: Double) -> Double { if let v, v.isFinite { return v }; return fallback }

/// How long a spring takes to settle within 0.1% of its target, in ms (clamped to 50–10000).
public func springSettleMs(stiffness: Double? = nil, damping: Double? = nil, mass: Double? = nil) -> Double {
    let k = Swift.max(1e-6, finite(stiffness, DEFAULT_SPRING.stiffness))
    let c = Swift.max(0, finite(damping, DEFAULT_SPRING.damping))
    let m = Swift.max(1e-6, finite(mass, DEFAULT_SPRING.mass))
    let w0 = (k / m).squareRoot()
    let zeta = c / (2 * (k * m).squareRoot())
    let seconds: Double
    if zeta <= 0 { seconds = .infinity }
    else if zeta < 1 - 1e-6 { seconds = 6.9 / (zeta * w0) }
    else if zeta <= 1 + 1e-6 { seconds = 9.2 / w0 }
    else { seconds = 9.2 / (w0 * (zeta - (zeta * zeta - 1).squareRoot())) }
    return (Swift.min(10000, Swift.max(50, seconds * 1000)) + 0.5).rounded(.down)
}

/// Normalised position of a parametric elastic oscillation (Rive / Penner curves) at progress `t` (0–1).
public func elasticAt(_ elastic: ElasticParameters, _ t: Double) -> Double {
    if t <= 0 { return 0 }
    if t >= 1 { return 1 }
    let a = Swift.max(1e-6, finite(elastic.amplitude, DEFAULT_ELASTIC.amplitude))
    let p = Swift.max(1e-6, finite(elastic.period, DEFAULT_ELASTIC.period))
    let tau = 2 * Double.pi
    func shift(_ amp: Double, _ per: Double) -> Double { amp < 1 ? per / 4 : (per / tau) * asin(1 / amp) }
    func solveOut(_ u: Double) -> Double { a * pow(2, -10 * u) * sin(((u - shift(a, p)) * tau) / p) + 1 }
    func solveIn(_ u: Double) -> Double {
        let adjusted = u - 1
        return -(a * pow(2, 10 * adjusted) * sin(((adjusted - shift(a, p)) * tau) / p))
    }
    switch elastic.mode {
    case "in": return solveIn(t)
    case "in-out": return t < 0.5 ? 0.5 * solveIn(t * 2) : 0.5 + 0.5 * solveOut((t - 0.5) * 2)
    default: return solveOut(t)
    }
}

/// Solves a CSS `cubic-bezier(x1, y1, x2, y2)` for y at progress x (Newton steps with a bisection fallback).
public func cubicBezierAt(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }
    let x1 = clampValue(x1, 0, 1), x2 = clampValue(x2, 0, 1)
    func bx(_ s: Double) -> Double { 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s }
    func by(_ s: Double) -> Double { 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s }
    func dbx(_ s: Double) -> Double { 3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2) }
    var s = x
    for _ in 0..<8 {
        let d = dbx(s)
        if abs(d) < 1e-9 { break }
        let next = s - (bx(s) - x) / d
        if !(next >= 0 && next <= 1) { break }
        s = next
    }
    if abs(bx(s) - x) > 1e-7 {
        var lo = 0.0, hi = 1.0
        for _ in 0..<60 {
            s = (lo + hi) / 2
            if bx(s) < x { lo = s } else { hi = s }
        }
    }
    return by(s)
}

/// Normalised position of a damped spring released from 0 towards 1, `seconds` after release.
public func springAt(_ spring: SpringParameters, _ seconds: Double) -> Double {
    let stiffness = Swift.max(1e-6, finite(spring.stiffness, DEFAULT_SPRING.stiffness))
    let damping = Swift.max(0, finite(spring.damping, DEFAULT_SPRING.damping))
    let mass = Swift.max(1e-6, finite(spring.mass, DEFAULT_SPRING.mass))
    let v0 = -finite(spring.velocity, DEFAULT_SPRING.velocity)
    let t = Swift.max(0, seconds)
    let w0 = (stiffness / mass).squareRoot()
    let zeta = damping / (2 * (stiffness * mass).squareRoot())
    let x: Double
    if zeta < 1 - 1e-6 {
        let wd = w0 * (1 - zeta * zeta).squareRoot()
        x = exp(-zeta * w0 * t) * (cos(wd * t) + ((zeta * w0 + v0) / wd) * sin(wd * t))
    } else if zeta <= 1 + 1e-6 {
        x = exp(-w0 * t) * (1 + (w0 + v0) * t)
    } else {
        let r = (zeta * zeta - 1).squareRoot()
        let s1 = -w0 * (zeta - r)
        let s2 = -w0 * (zeta + r)
        let c2 = (v0 - s1) / (s2 - s1)
        let c1 = 1 - c2
        x = c1 * exp(s1 * t) + c2 * exp(s2 * t)
    }
    return 1 - x
}

/// An easing resolved to the curve it draws (`resolveEasing`).
public enum ResolvedEasing: Equatable, Sendable {
    case hold
    case cubicBezier(x1: Double, y1: Double, x2: Double, y2: Double)
    case spring(SpringParameters)
    case elastic(ElasticParameters)
}

private let LINEAR_RESOLVED = ResolvedEasing.cubicBezier(x1: 0, y1: 0, x2: 1, y2: 1)

/// Resolves an easing to a cubic-bezier, spring, elastic or hold curve (unknown input → linear).
public func resolveEasing(_ easing: AnimationEasing?) -> ResolvedEasing {
    guard let easing else { return LINEAR_RESOLVED }
    switch easing {
    case .named(let name):
        if name == "hold" { return .hold }
        if name == "spring" { return .spring(DEFAULT_SPRING) }
        if let p = SPRING_PRESETS[name] { return .spring(p) }
        if name == "elastic" || name == "ease-out-elastic" { return .elastic(ElasticParameters(mode: "out")) }
        if name == "ease-in-elastic" { return .elastic(ElasticParameters(mode: "in")) }
        if name == "ease-in-out-elastic" { return .elastic(ElasticParameters(mode: "in-out")) }
        if let p = CUBIC_BEZIER_PRESETS[name] { return .cubicBezier(x1: p[0], y1: p[1], x2: p[2], y2: p[3]) }
        if let parsed = parseCssEasing(name) { return resolveEasing(parsed) }
        return LINEAR_RESOLVED
    case let .spring(stiffness, damping, mass, velocity):
        return .spring(SpringParameters(stiffness: finite(stiffness, DEFAULT_SPRING.stiffness), damping: finite(damping, DEFAULT_SPRING.damping), mass: finite(mass, DEFAULT_SPRING.mass), velocity: finite(velocity, DEFAULT_SPRING.velocity)))
    case let .elastic(amplitude, period, mode):
        return .elastic(ElasticParameters(amplitude: finite(amplitude, DEFAULT_ELASTIC.amplitude), period: finite(period, DEFAULT_ELASTIC.period), mode: mode == "in" || mode == "in-out" ? mode! : "out"))
    case let .cubicBezier(x1, y1, x2, y2):
        return .cubicBezier(x1: clampValue(finite(x1, 0), 0, 1), y1: finite(y1, 0), x2: clampValue(finite(x2, 1), 0, 1), y2: finite(y2, 1))
    }
}

/**
 Eased progress for linear progress `u` (0–1) through a segment lasting `durationMs` (springs depend
 on real time; other curves ignore it). `hold` returns 0 until `u` reaches 1.
 */
public func evaluateEasing(_ easing: AnimationEasing?, _ u: Double, durationMs: Double = 1000) -> Double {
    if !(u > 0) { return 0 }
    if u >= 1 { return 1 }
    switch resolveEasing(easing) {
    case .hold: return 0
    case .spring(let s): return springAt(s, (u * Swift.max(0, durationMs)) / 1000)
    case .elastic(let e): return elasticAt(e, u)
    case let .cubicBezier(x1, y1, x2, y2):
        if x1 == y1 && x2 == y2 { return u }
        return cubicBezierAt(x1, y1, x2, y2, u)
    }
}

/// The easing filmcraft (and Premiere) derive from temporal "influence" handles (0.01–1, default 1/3).
public func easingFromInfluence(_ outInfluence: Double = 1.0 / 3, _ inInfluence: Double = 1.0 / 3) -> AnimationEasing {
    .cubicBezier(x1: clampValue(outInfluence, 0.01, 1), y1: 0, x2: 1 - clampValue(inInfluence, 0.01, 1), y2: 1)
}

private let NUMBER_RE = "\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?)\\s*"
private let CUBIC_RE = try! NSRegularExpression(pattern: "^cubic-bezier\\(\(NUMBER_RE),\(NUMBER_RE),\(NUMBER_RE),\(NUMBER_RE)\\)$", options: [.caseInsensitive])
private let STEPS_RE = try! NSRegularExpression(pattern: "^steps\\(\\s*1\\s*(,\\s*(end|jump-end)\\s*)?\\)$")

/// Parses a CSS easing (`linear`, `ease…`, `cubic-bezier(…)`, `steps(1, end)` / `step-end` → hold) or a preset name; nil for anything else.
public func parseCssEasing(_ text: String) -> AnimationEasing? {
    let value = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if value.utf16.count > 200 { return nil }
    if ANIMATION_EASING_PRESETS.contains(value) { return .named(value) }
    let ns = value as NSString
    let range = NSRange(location: 0, length: ns.length)
    if value == "step-end" || STEPS_RE.firstMatch(in: value, range: range) != nil { return .named("hold") }
    guard let m = CUBIC_RE.firstMatch(in: value, range: range) else { return nil }
    let n = (1...4).map { Double(ns.substring(with: m.range(at: $0))) ?? .nan }
    if !n.allSatisfy(\.isFinite) || n[0] < 0 || n[0] > 1 || n[2] < 0 || n[2] > 1 { return nil }
    return .cubicBezier(x1: n[0], y1: n[1], x2: n[2], y2: n[3])
}

/// Whether a value is a usable easing (preset name, CSS easing string or descriptor).
public func isAnimationEasing(_ value: JSONValue) -> Bool {
    if let s = value.stringValue { return parseCssEasing(s) != nil }
    guard let o = value.objectValue else { return false }
    switch o["type"]?.stringValue {
    case "spring", "elastic": return true
    case "cubic-bezier": return ["x1", "y1", "x2", "y2"].allSatisfy { o[$0]?.numberValue?.isFinite == true }
    default: return false
    }
}

/// Short label for an easing (a preset's label, or `Custom` / `Spring` / `Elastic`).
public func easingLabel(_ easing: AnimationEasing?) -> String {
    guard let easing else { return ANIMATION_EASING_LABELS["linear"]! }
    switch easing {
    case .named(let s): return ANIMATION_EASING_LABELS[s] ?? s
    case .spring: return "Spring"
    case .elastic: return "Elastic"
    case .cubicBezier: return "Custom"
    }
}
