import Foundation
import PixerateCore

/**
 * Host profiles (`brushes/profiles.ts`): what each host can render of a brush, and the check that
 * says which facets it refuses (`error`) or paints without (`warning`), with a reason and a fix.
 */

public struct BrushHostProfile: Sendable {
    public var id: String
    public var name: String
    public var kinds: [String]
    public var tools: [String]
    public var tipShapes: [String]
    public var marks: [String]
    public var surfaces: [String]
    /// `full`, `ignored` or `none`.
    public var exchange: String
    public var reservoir: String
    public var grain: String
    public var light: String
    public var motion: String
    public var colours: [String]
    public var velocity: String
    public var tilt: String
    /// Texture inside the tip (`tip.grain`); nil: `none`.
    public var tipGrain: String? = nil
    /// Several dabs per spacing step (`dynamics.count` above 1); nil: `none`.
    public var dabCount: String? = nil
    /// Live reaction-diffusion patterns (`livePatterns`); nil: `none`.
    public var livePatterns: String? = nil
}

private let ALL_COLOURS = ["solid", "dual", "gradient", "effect"]
private let ELLIPSES = ["round", "flat", "chisel"]
public let BRUSH_TIP_SHAPES = ["round", "flat", "chisel", "bristle", "stamp"]
public let BRUSH_MARKS_KINDS = ["continuous", "scatter", "particles", "objects"]

public let PAINT_PROFILE = BrushHostProfile(id: "paint", name: "Paint editor", kinds: ["mark", "tool"], tools: BRUSH_TOOLS, tipShapes: BRUSH_TIP_SHAPES, marks: BRUSH_MARKS_KINDS, surfaces: ["dry", "wet", "thick"], exchange: "full", reservoir: "full", grain: "full", light: "full", motion: "full", colours: ALL_COLOURS, velocity: "full", tilt: "full", tipGrain: "full", dabCount: "full", livePatterns: "full")
public let IMAGE_PROFILE = BrushHostProfile(id: "image", name: "Image editor", kinds: ["mark", "tool"], tools: ["eraser"], tipShapes: ELLIPSES, marks: ["continuous"], surfaces: ["dry"], exchange: "ignored", reservoir: "full", grain: "ignored", light: "none", motion: "none", colours: ["solid", "dual", "gradient"], velocity: "ignored", tilt: "ignored", tipGrain: "ignored", dabCount: "ignored")
public let CANVAS_PROFILE = BrushHostProfile(id: "canvas", name: "Canvas", kinds: ["mark"], tools: [], tipShapes: ELLIPSES, marks: ["continuous"], surfaces: ["dry"], exchange: "ignored", reservoir: "none", grain: "full", light: "none", motion: "none", colours: ["solid", "dual", "gradient"], velocity: "ignored", tilt: "full", tipGrain: "ignored", dabCount: "ignored")
/// Vector brushstrokes: as canvas, plus wet paint, the Mixer Brush, smudge and blender (#519); light paints as plain colour.
public let VECTOR_PROFILE: BrushHostProfile = {
    var p = CANVAS_PROFILE
    p.id = "vector"
    p.name = "Vector editor"
    p.kinds = ["mark", "tool"]
    p.tools = ["blender", "smudge"]
    p.surfaces = ["dry", "wet"]
    p.reservoir = "full"
    p.light = "ignored"
    return p
}()

/// The built-in profiles, in order.
public let BRUSH_HOST_PROFILES: [BrushHostProfile] = [PAINT_PROFILE, IMAGE_PROFILE, CANVAS_PROFILE, VECTOR_PROFILE]

public struct BrushIssue: Sendable {
    public var facet: String
    public var severity: String
    public var reason: String
    public var fix: String
    var json: JSONValue { ["facet": .string(facet), "severity": .string(severity), "reason": .string(reason), "fix": .string(fix)] }
}

public struct BrushCheck: Sendable {
    public var ok: Bool
    public var issues: [BrushIssue]
    var json: JSONObject { ["ok": .bool(ok), "issues": .array(issues.map(\.json))] }
}

/// What kind of colour a brush paint is.
func brushColourKind(_ paint: JSONValue) -> String {
    if paint.stringValue != nil { return "solid" }
    if let t = paint.objectValue?["type"] { return t == "gradient" ? "gradient" : "effect" }
    return "dual"
}

private func nonZero(_ v: JSONValue?) -> Bool { v != nil && v?.numberValue != 0 }

/// What a brush needs from a host, and what the host does about it.
public func checkBrush(_ brush: Brush, _ profile: BrushHostProfile) -> BrushCheck {
    var issues: [BrushIssue] = []
    let host = profile.name
    func add(_ facet: String, _ severity: String, _ reason: String, _ fix: String) { issues.append(BrushIssue(facet: facet, severity: severity, reason: reason, fix: fix)) }
    func feature(_ support: String, _ used: Bool, _ facet: String, _ what: String, _ fix: String) {
        if !used || support == "full" { return }
        if support == "none" { add(facet, "error", "\(host) can't paint \(what).", fix) } else { add(facet, "warning", "\(host) paints this brush without \(what).", "Nothing to do; or \(fix.prefix(1).lowercased())\(fix.dropFirst())") }
    }
    let kind = brush["kind"]?.stringValue ?? ""
    let list = { (v: [String]) in v.joined(separator: ", ") }
    if !profile.kinds.contains(kind) { add("kind", "error", "\(host) has no \(kind) brushes.", "Use a \(list(profile.kinds)) brush.") } else if kind == "tool", let tool = brush["tool"]?.stringValue, !profile.tools.contains(tool) {
        add("tool", "error", "\(host) has no \(tool) tool.", profile.tools.isEmpty ? "\(host) has no tools; use a mark brush." : "Use one of: \(list(profile.tools)).")
    }
    let shape = brush.path("tip.shape")?.stringValue ?? ""
    if !profile.tipShapes.contains(shape) {
        let image = shape == "stamp" && (brush.path("tip.stamps")?.arrayValue ?? []).contains { $0.stringValue.map(isBrushSourceRef) ?? false }
        add("tip.shape", "error", "\(host) can't lay a \(image ? "stamp tip (image tips are stamps)" : "\(shape) tip").", "Set tip.shape to one of: \(list(profile.tipShapes)).")
    }
    let marks = brush.path("marks.kind")?.stringValue ?? "continuous"
    if !profile.marks.contains(marks) { add("marks", "error", "\(host) can't lay \(marks) marks.", "Use marks \(list(profile.marks)) (remove marks for continuous dabs).") }
    let surface = brush.path("behaviour.surface")?.stringValue ?? "dry"
    if kind == "mark" && !profile.surfaces.contains(surface) { add("behaviour.surface", "error", "\(host) has no \(surface) surface.", "Set behaviour.surface to \(list(profile.surfaces)).") }
    let ex = brush.path("behaviour.exchange")?.objectValue
    feature(profile.reservoir, ex?["reservoir"] != nil, "behaviour.exchange.reservoir", "a Mixer Brush reservoir", "Remove behaviour.exchange.reservoir.")
    feature(profile.exchange, ex?["reservoir"] == nil && (nonZero(ex?["pickup"]) || ex?["dirty"] == .bool(true)), "behaviour.exchange", "picking paint up", "Remove behaviour.exchange.")
    feature(profile.grain, nonZero(brush.path("behaviour.grain")), "behaviour.grain", "paper grain", "Set behaviour.grain to 0.")
    feature(profile.light, nonZero(brush.path("light.amount")), "light", "light paint (glow and spill)", "Remove light (or set light.amount to 0).")
    feature(profile.livePatterns ?? "none", brush["livePatterns"] != nil, "livePatterns", "live reaction-diffusion patterns", "Remove livePatterns.")
    if let m = brush["motion"]?.objectValue {
        feature(profile.motion, m["live"] == .bool(true) || nonZero(m["waveSpeed"]) || m["fps"] != nil, "motion", "animation", "Remove motion.")
    }
    let d = brush["dynamics"]?.objectValue ?? [:]
    feature(profile.tipGrain ?? "none", brush.path("tip.grain") != nil, "tip.grain", "tip grain", "Remove tip.grain (behaviour.grain textures with the paper instead).")
    feature(profile.dabCount ?? "none", (d["count"]?.numberValue ?? 1) > 1, "dynamics.count", "several dabs per step", "Set dynamics.count to 1.")
    feature(profile.velocity, nonZero(d["velocitySize"]) || nonZero(d["velocityOpacity"]), "dynamics.velocity", "velocity dynamics (its strokes carry no timing)", "Set dynamics.velocitySize and velocityOpacity to 0.")
    feature(profile.tilt, nonZero(d["tiltSize"]) || nonZero(d["tiltRoundness"]) || nonZero(d["tiltOpacity"]), "dynamics.tilt", "tilt dynamics", "Set dynamics.tiltSize, tiltRoundness and tiltOpacity to 0.")
    let colour = brush["colour"]?.objectValue
    if let def = colour?["default"] {
        let k = brushColourKind(def)
        if !profile.colours.contains(k) { add("colour.default", "error", "\(host) can't paint \(k) colours.", "Use a \(list(profile.colours)) colour, or remove colour.default.") }
    }
    var foreign: [String] = []
    for p in colour?["palette"]?.arrayValue ?? [] {
        let k = brushColourKind(p)
        if !profile.colours.contains(k) && !foreign.contains(k) { foreign.append(k) }
    }
    if !foreign.isEmpty { add("colour.palette", "warning", "\(host) skips the palette's \(list(foreign)) colours.", "Nothing to do; or keep to \(list(profile.colours)) colours.") }
    return BrushCheck(ok: !issues.contains { $0.severity == "error" }, issues: issues)
}

/// The brush the host can render: facets it refuses are removed, each reported in `dropped`.
public func degrade(_ brush: Brush, _ profile: BrushHostProfile) -> JSONObject {
    let before = checkBrush(brush, profile).issues.filter { $0.severity == "error" }
    var b = brush
    var dropped: [BrushIssue] = []
    func edit(_ key: String, _ fn: (inout JSONObject) -> Void) {
        var o = b[key]?.objectValue ?? [:]
        fn(&o)
        b[key] = .object(o)
    }
    for issue in before {
        switch issue.facet {
        case "tip.shape":
            edit("tip") { t in
                t["shape"] = .string(profile.tipShapes.contains("round") ? "round" : profile.tipShapes[0])
                t["bristle"] = nil
                t["stamps"] = nil
            }
        case "marks":
            b["marks"] = nil
            if b.path("tip.shape") == "stamp" { edit("tip") { t in t["shape"] = "round"; t["stamps"] = nil } }
        case "behaviour.surface": edit("behaviour") { o in o["surface"] = nil; o["wet"] = nil; o["thick"] = nil }; b["livePatterns"] = nil
        case "behaviour.exchange.reservoir":
            edit("behaviour") { o in
                var e = o["exchange"]?.objectValue ?? [:]
                e["reservoir"] = nil
                o["exchange"] = .object(e)
            }
        case "behaviour.exchange": edit("behaviour") { $0["exchange"] = nil }
        case "behaviour.grain": edit("behaviour") { $0["grain"] = nil }
        case "tip.grain": edit("tip") { $0["grain"] = nil }
        case "dynamics.count": edit("dynamics") { $0["count"] = nil }
        case "light": b["light"] = nil
        case "livePatterns": b["livePatterns"] = nil
        case "motion": b["motion"] = nil
        case "dynamics.velocity": edit("dynamics") { o in o["velocitySize"] = nil; o["velocityOpacity"] = nil }
        case "dynamics.tilt": edit("dynamics") { o in o["tiltSize"] = nil; o["tiltRoundness"] = nil; o["tiltOpacity"] = nil }
        case "colour.default": edit("colour") { $0["default"] = nil }
        default: continue
        }
        dropped.append(issue)
    }
    if let e = b.path("behaviour.exchange")?.objectValue, e.isEmpty { edit("behaviour") { $0["exchange"] = nil } }
    let after = checkBrush(b, profile).issues.filter { $0.severity == "error" }
    return ["brush": .object(b), "dropped": .array(dropped.map(\.json)), "issues": .array(after.map(\.json))]
}
