import Foundation
import PixerateContracts
import PixerateCore
import PixerateRaster

/**
 * The brush model of `@pixerate/editor/brushes`: a facet `Brush` (identity, what it is, and its
 * tip, marks, dynamics, behaviour, light, motion and colour facets) kept as JSON, as files and
 * agents exchange it, and resolved to the flat form the paint engine reads (`resolveBrush`).
 *
 * `BRUSH_FIELDS` maps each facet field to the engine field it sets, for the engines that read it;
 * `migrateBrushV1` reads the same map the other way. The port of `brushes/resolve.ts`.
 */
public typealias Brush = JSONObject

private let ALL = ["dab", "eraser", "mixer", "blender", "smudge", "wet", "impasto", "particle", "bristle", "sticker", "antimatter"]
/// Engines that pick up and mix paint dab by dab (the exchange ratios apply).
private let EXCHANGE = ["dab", "wet", "impasto"]
/// Engines that lay dabs from the pen dab walker: tip grain, count and flip apply.
private let DABS = ["dab", "eraser", "mixer", "blender", "smudge"]
/// Engines that can deposit a thin-film iridescence coat.
private let FILM = ["dab", "mixer", "wet", "impasto", "particle", "bristle"]

/// One facet field and the engine field it sets.
struct BrushField: Sendable {
    /// Dot path in the facet brush.
    let facet: String
    /// Dot path in the resolved brush.
    let engine: String
    /// The engines that read it.
    let engines: [String]
    /// When the two forms differ: facet value → engine value, and back.
    var map: FieldMap?
    /// Read only on these tip shapes.
    var shapes: [String]?
    /// Read only with these marks kinds.
    var marks: [String]?
}

typealias FieldMap = (toEngine: @Sendable (JSONValue) -> JSONValue, toFacet: @Sendable (JSONValue) -> JSONValue?)

/// `dirty` is the Mixer Brush's `!cleanEachStroke`.
private let NOT: FieldMap = (
    { .bool(!($0.boolValue ?? false)) },
    { .bool(!($0.boolValue ?? false)) }
)
/// Textured particle dots: refs in the facet; the editor's stamps are bare in the engine.
private let EDITOR_STAMPS: FieldMap = (
    { v in
        .array((v.arrayValue ?? []).compactMap { r -> JSONValue? in
            guard let ref = r.stringValue else { return nil }
            if parseStickerRef(ref) == nil { return nil }
            if let stamp = editorStampOf(ref) { return .string(stamp) }
            return ref.contains(":") ? .string(ref) : nil
        })
    },
    { v in .array((v.arrayValue ?? []).map { s in let t = s.stringValue ?? ""; return .string(t.contains(":") ? t : "editor:\(t)") }) }
)
/// A continuous stamp tip lays one sticker: the first of `tip.stamps`.
private let ONE_STAMP: FieldMap = (
    { v in v.arrayValue?.first ?? .null },
    { v in v == .null || v == .bool(false) || v == .string("") ? nil : .array([v]) }
)
/// Live reaction-diffusion patterns (`livePatterns`): sparse facet ↔ normalized engine settings.
private let LIVE_PATTERNS_MAP: FieldMap = (
    { v in
        guard let o = v.objectValue else { return .null }
        return normalizeLivePatterns(o, DEFAULT_LIVE_PATTERNS).json
    },
    { v in
        guard let r = v.objectValue else { return nil }
        let pattern = isLivePatternKind(r["pattern"]?.stringValue) ? r["pattern"]!.stringValue! : DEFAULT_LIVE_PATTERNS.pattern
        let preset = LIVE_PATTERN_PRESETS[pattern] ?? LIVE_PATTERN_PRESETS["spots"]!
        var out = JSONObject()
        out["pattern"] = .string(pattern)
        if let feed = r["feed"]?.numberValue, feed != preset.feed { out["feed"] = .number(feed) }
        if let kill = r["kill"]?.numberValue, kill != preset.kill { out["kill"] = .number(kill) }
        if let scale = r["scale"]?.numberValue, scale != DEFAULT_LIVE_PATTERNS.scale { out["scale"] = .number(scale) }
        if let contrast = r["contrast"]?.numberValue, contrast != DEFAULT_LIVE_PATTERNS.contrast { out["contrast"] = .number(contrast) }
        if let secondColor = r["secondColor"]?.stringValue, !secondColor.isEmpty { out["secondColor"] = .string(secondColor) }
        if let relief = r["relief"]?.numberValue, relief != DEFAULT_LIVE_PATTERNS.relief { out["relief"] = .number(relief) }
        return .object(out)
    }
)

private func f(_ facet: String, _ engine: String, _ engines: [String] = ALL, map: FieldMap? = nil, shapes: [String]? = nil, marks: [String]? = nil) -> BrushField {
    BrushField(facet: facet, engine: engine, engines: engines, map: map, shapes: shapes, marks: marks)
}

private func each(_ facetPrefix: String, _ enginePrefix: String, _ keys: [String], _ engines: [String] = ALL) -> [BrushField] {
    keys.map { f("\(facetPrefix).\($0)", "\(enginePrefix).\($0)", engines) }
}

/// Every facet field and where it lands in the resolved brush.
let BRUSH_FIELDS: [BrushField] = {
    var out: [BrushField] = []
    out += each("tip", "tip", ["size", "hardness", "spacing", "angle", "roundness", "opacity", "flow", "blend"])
    out += each("dynamics", "tip", ["smoothing", "pressureSize", "pressureOpacity"])
    out.append(f("dynamics.pressureSmoothing", "pressureSmoothing"))
    out.append(f("dynamics.rotation", "rotation"))
    out += each("dynamics", "dynamics", ["minSize", "pressureFlow", "tiltSize", "tiltRoundness", "tiltOpacity", "velocitySize", "velocityOpacity", "sizeJitter", "angleJitter", "opacityJitter", "scatter"])
    out.append(f("dynamics.count", "dynamics.count", DABS))
    out.append(f("dynamics.flip", "dynamics.flip", DABS))
    out.append(f("tip.grain", "tipGrain", DABS))
    out.append(f("behaviour.grain", "grain"))
    out += each("light", "light", ["amount", "pressure"])
    out += each("fluorescence", "fluorescence", ["amount", "invisible"])
    out += each("thermochromic", "thermochromic", ["hotColor", "threshold"])
    out += each("iridescence", "iridescence", ["thickness", "pressureToThickness", "ior"], FILM)
    out += each("ferro", "ferro", ["amount", "wavelength", "threshold"])
    out.append(f("behaviour.exchange.pickup", "behavior.pickup", EXCHANGE))
    out.append(f("behaviour.exchange.mix", "behavior.mix", EXCHANGE))
    out.append(f("behaviour.exchange.dirty", "behavior.dirty", EXCHANGE))
    out.append(f("behaviour.mixing", "behavior.mixing", EXCHANGE))
    out.append(f("behaviour.exchange.pickup", "mixer.wet", ["mixer"]))
    out.append(f("behaviour.exchange.mix", "mixer.mix", ["mixer"]))
    out.append(f("behaviour.exchange.dirty", "mixer.cleanEachStroke", ["mixer"], map: NOT))
    out.append(f("behaviour.mixing", "mixer.mixing", ["mixer"]))
    out.append(f("behaviour.exchange.reservoir.load", "mixer.load", ["mixer"]))
    out.append(f("behaviour.exchange.reservoir.refill", "mixer.loadEachStroke", ["mixer"]))
    out.append(f("behaviour.exchange.reservoir.loadsColour", "loadsColor", ["mixer"]))
    out.append(f("behaviour.strength", "blender.strength", ["blender"]))
    out.append(f("behaviour.distance", "blender.distance", ["blender"]))
    out.append(f("behaviour.mixing", "blender.mixing", ["blender"]))
    out.append(f("behaviour.strength", "smudge.strength", ["smudge"]))
    out.append(f("behaviour.length", "smudge.length", ["smudge"]))
    out.append(f("behaviour.mixing", "smudge.mixing", ["smudge"]))
    out.append(f("behaviour.strength", "wet.strength", ["wet"]))
    out += each("behaviour.wet", "wet", ["medium", "water", "pigment", "body", "rewet", "load", "thinner"], ["wet"])
    out.append(f("livePatterns", "livePatterns", ["wet"], map: LIVE_PATTERNS_MAP))
    out += each("ghost", "ghost", ["linger", "smear"], ["wet"])
    out += each("mutation", "mutation", ["settle", "patience", "fade"], ["dab", "wet", "impasto", "particle", "bristle"])
    out.append(f("behaviour.thick.applicator", "impasto.tool", ["impasto"]))
    out += each("behaviour.thick", "impasto", ["thickness", "gloss", "metallic", "load", "thinner", "drag", "rim", "clarity"], ["impasto"])
    out.append(f("marks.physics", "particle.kind", ["particle"]))
    out += each("marks", "particle", ["render", "count", "size", "spread", "stiffness", "damping", "speed", "gravity", "life", "interval", "ribbonFill", "ribbonPairs", "waveAmplitude", "waveLength", "wavePhaseJitter"], ["particle"])
    out.append(f("marks.stampOrder", "particle.dotTextureOrder", ["particle"]))
    out.append(f("marks.stampRotation", "particle.dotRotation", ["particle"]))
    out.append(f("tip.stamps", "particle.dotTextures", ["particle"], map: EDITOR_STAMPS, shapes: ["stamp"]))
    out.append(f("motion.waveSpeed", "particle.waveSpeed", ["particle"]))
    out.append(f("tip.stamps", "sticker.stamps", ["sticker"], shapes: ["stamp"]))
    out.append(f("tip.stamps", "stamp", ["dab"], map: ONE_STAMP, shapes: ["stamp"]))
    out.append(f("marks.density", "spray.density", ["dab"], marks: ["scatter"]))
    out.append(f("marks.size", "spray.size", ["dab"], marks: ["scatter"]))
    out += each("marks", "sticker", ["density", "sizeJitter", "rotationJitter", "scatter", "frameMode"], ["sticker"])
    out.append(f("marks.colourJitter", "sticker.colorJitter", ["sticker"]))
    out += each("marks", "antimatter", ["blastRadius", "blastSpacing", "threshold", "invert", "invertMode", "scorch", "annihilate", "sparks", "sparkReach", "crater", "duration"], ["antimatter"])
    out += each("tip.bristle", "bristle", ["count", "stiffness", "splay", "thickness", "load", "jitter"], ["bristle"])
    return out
}()

/// The wet tool each wet-layer tool brush is.
let WET_TOOL_OF: [(String, String)] = [("water", "water"), ("dryer", "dry"), ("blow", "blow"), ("blot", "blot"), ("wet-blend", "blend"), ("wet-drag", "smudge")]

func getPath(_ o: JSONValue, _ path: String) -> JSONValue? {
    var v: JSONValue? = o
    for k in path.split(separator: ".") {
        guard let obj = v?.objectValue else { return nil }
        v = obj[String(k)]
    }
    return v
}

func setPath(_ o: inout JSONObject, _ path: String, _ value: JSONValue) {
    let keys = path.split(separator: ".").map(String.init)
    func set(_ node: inout JSONObject, _ i: Int) {
        let k = keys[i]
        if i == keys.count - 1 {
            node[k] = value
            return
        }
        var child = node[k]?.objectValue ?? [:]
        set(&child, i + 1)
        node[k] = .object(child)
    }
    set(&o, 0)
}

extension JSONObject {
    /// `brush.<a>.<b>` as JSON.
    func path(_ p: String) -> JSONValue? { getPath(.object(self), p) }
}

/**
 * The engine that renders a brush: tools by what they do; marks by how they are laid (particles,
 * objects), the tip (bristle), the surface (thick, wet) and the paint exchange (a reservoir makes
 * a Mixer Brush); everything else paints dabs.
 */
public func resolveEngine(_ brush: Brush) -> String {
    if brush["kind"]?.stringValue == "tool" {
        let tool = brush["tool"]?.stringValue
        return tool == "eraser" || tool == "blender" || tool == "smudge" ? tool! : "wet"
    }
    let marks = brush.path("marks.kind")?.stringValue
    if marks == "particles" { return "particle" }
    if marks == "objects" { return "sticker" }
    if marks == "antimatter" { return "antimatter" }
    if brush.path("tip.shape")?.stringValue == "bristle" { return "bristle" }
    let surface = brush.path("behaviour.surface")?.stringValue
    if surface == "thick" { return "impasto" }
    if surface == "wet" { return "wet" }
    if brush.path("behaviour.exchange.reservoir") != nil { return "mixer" }
    return "dab"
}

private let VARIETY_CATEGORY: [String: String] = ["pencil": "pencil", "pastel": "pastel", "soft-pastel": "pastel", "oil-pastel": "pastel", "crayon": "pastel", "chalk": "pastel", "charcoal": "charcoal", "airbrush": "airbrush", "marker": "marker"]
private let MEDIUM_CATEGORY: [String: String] = ["paint": "paint", "ink": "ink", "dry": "pencil", "spray": "airbrush"]

/// The wet medium a wet brush paints: `behaviour.wet.medium`, else its variety when that is a wet medium.
public func resolveWetMedium(_ brush: Brush) -> String? {
    if let m = brush.path("behaviour.wet.medium")?.stringValue { return m }
    if let v = brush["variety"]?.stringValue, WET_MEDIA.contains(v) { return v }
    return nil
}

/// The library category a brush is grouped under.
public func resolveCategory(_ brush: Brush, _ engineIn: String? = nil) -> String {
    let engine = engineIn ?? resolveEngine(brush)
    if brush["kind"]?.stringValue == "tool" {
        let tool = brush["tool"]?.stringValue
        return tool == "eraser" || tool == "blender" || tool == "smudge" ? tool! : "wet-tool"
    }
    if (brush.path("light.amount")?.numberValue ?? 0) > 0 { return "light" }
    switch engine {
    case "particle": return "procedural"
    case "sticker": return "sticker"
    case "bristle": return "bristle"
    case "impasto": return "impasto"
    case "wet": return resolveWetMedium(brush) == "oil" ? "oil" : "watercolor"
    case "mixer": return "mixer"
    default:
        if let v = brush["variety"]?.stringValue, let c = VARIETY_CATEGORY[v] { return c }
        if let m = brush["medium"]?.stringValue, let c = MEDIUM_CATEGORY[m] { return c }
        return "custom"
    }
}

/**
 * The flat engine form of a brush. Missing fields take the engine's defaults, and every value is
 * clamped into range, so any brush resolves.
 */
public func resolveBrush(_ brush: Brush, builtin: Bool = false) -> PaintBrush {
    let engine = resolveEngine(brush)
    var input: JSONObject = ["id": brush["id"] ?? .null, "name": brush["name"] ?? .null, "category": .string(resolveCategory(brush, engine)), "engine": .string(engine)]
    let shape = brush.path("tip.shape")?.stringValue ?? ""
    let marksKind = brush.path("marks.kind")?.stringValue ?? "continuous"
    for field in BRUSH_FIELDS {
        if !field.engines.contains(engine) || (field.shapes.map { !$0.contains(shape) } ?? false) || (field.marks.map { !$0.contains(marksKind) } ?? false) { continue }
        if let v = brush.path(field.facet) { setPath(&input, field.engine, field.map?.toEngine(v) ?? v) }
    }
    // Spray marks: the dab engine with droplets.
    if engine == "dab" && marksKind == "scatter" { input["spray"] = .object(input["spray"]?.objectValue ?? [:]) }
    if brush["iridescence"] != nil && FILM.contains(engine) { input["iridescence"] = .object(input["iridescence"]?.objectValue ?? [:]) }
    if engine == "wet" {
        let tool = brush["kind"]?.stringValue == "tool" ? WET_TOOL_OF.first { $0.0 == brush["tool"]?.stringValue }?.1 : "paint"
        setPath(&input, "wet.tool", tool.map { .string($0) } ?? .null)
        if let medium = resolveWetMedium(brush) { setPath(&input, "wet.medium", .string(medium)) }
        if brush["ghost"] != nil && tool == "paint" { input["ghost"] = .object(input["ghost"]?.objectValue ?? [:]) }
    }
    if brush["mutation"] != nil && ["dab", "wet", "impasto", "particle", "bristle"].contains(engine) && (engine != "wet" || brush["kind"]?.stringValue != "tool") {
        input["mutation"] = .object(brush["mutation"]?.objectValue ?? [:])
    }
    // Blenders and smudges only move paint already down.
    if engine == "blender" || engine == "smudge" { input["loadsColor"] = false }
    if let paint = brush.path("colour.default"), paint.objectValue?["type"] == "gradient" { input["paint"] = paint }
    if builtin { input["builtin"] = true }
    return normalizePaintBrush(input)
}
