import Foundation
import PixerateCore
import PixerateRaster

/**
 * Paint editor brushes (`paint-editor/brushes.ts`): the engine form a stroke paints with
 * (`PaintBrush`, what `resolveBrush` makes of a facet brush): the shared engine's tip settings
 * plus paper grain response, pen dynamics, a rotation mode, jitter, and the settings of every
 * engine (Mixer Brush, blender, smudge, wet, impasto, particle, bristle, sticker), light, stamp
 * tips, spray marks and gradient paint.
 */

public let PAINT_BRUSH_ENGINES = ["dab", "eraser", "mixer", "blender", "smudge", "wet", "impasto", "particle", "bristle", "sticker", "antimatter", "scraper"]
public let ANTIMATTER_INVERT_MODES = ["rgb", "oklab"]
public let PAINT_BRUSH_CATEGORIES = ["pencil", "pastel", "charcoal", "airbrush", "marker", "ink", "paint", "eraser", "blender", "smudge", "mixer", "watercolor", "wet-tool", "oil", "impasto", "procedural", "bristle", "sticker", "light", "custom"]
public let WET_TOOLS = ["paint", "water", "dry", "blow", "blend", "smudge", "blot"]
public let WET_MEDIA = ["watercolor", "gouache", "oil"]
public let IMPASTO_TOOLS = ["brush", "tube", "knife", "roller", "gloop"]
public let MULTI_COLOR_MODES = ["off", "tip", "dab"]
public let BRUSH_ROTATIONS = ["fixed", "stroke", "barrel"]
public let STAMP_KINDS = ["dot", "star", "heart", "leaf", "flower", "confetti", "splat", "sparkle", "ring"]
public let PARTICLE_KINDS = ["string", "spring", "orbit", "flow", "elastic", "fuzzy"]
public let PARTICLE_RENDERS = ["dot", "line", "sequence", "ribbon"]
public let RIBBON_PAIRS = ["adjacent", "first-last"]
public let DOT_TEXTURE_ORDERS = ["sequence", "random"]
public let DOT_ROTATIONS = ["follow", "random", "fixed"]
public let MAX_DOT_TEXTURES = 4
public let MAX_STICKER_STAMPS = 16

/// Brush ids: lowercase letters, digits and dashes.
public func isBrushId(_ v: String) -> Bool {
    v.range(of: "^[a-z0-9][a-z0-9-]{0,63}$", options: .regularExpression) != nil
}

/// Wet engine settings, each 0..1.
public struct WetBrushSettings: Equatable, Sendable {
    public var tool: String
    public var water: Double
    public var pigment: Double
    public var body: Double
    public var strength: Double
    public var rewet: Double
    public var medium: String
    public var load: Double
    public var thinner: Double

    var json: JSONValue {
        ["tool": .string(tool), "water": .number(water), "pigment": .number(pigment), "body": .number(body), "strength": .number(strength), "rewet": .number(rewet), "medium": .string(medium), "load": .number(load), "thinner": .number(thinner)]
    }
}

public let DEFAULT_WET_BRUSH = WetBrushSettings(tool: "paint", water: 0.5, pigment: 0.5, body: 0, strength: 0.5, rewet: 0, medium: "watercolor", load: 1, thinner: 0)

func normalizeWetBrush(_ raw: JSONObject, _ base: WetBrushSettings) -> WetBrushSettings {
    WetBrushSettings(
        tool: raw["tool"]?.stringValue.flatMap { WET_TOOLS.contains($0) ? $0 : nil } ?? base.tool,
        water: unitValue(raw["water"], base.water),
        pigment: unitValue(raw["pigment"], base.pigment),
        body: unitValue(raw["body"], base.body),
        strength: unitValue(raw["strength"], base.strength),
        rewet: unitValue(raw["rewet"], base.rewet),
        medium: raw["medium"]?.stringValue.flatMap { WET_MEDIA.contains($0) ? $0 : nil } ?? base.medium,
        load: unitValue(raw["load"], base.load),
        thinner: unitValue(raw["thinner"], base.thinner)
    )
}

/// Impasto engine settings, each 0..1.
public struct ImpastoSettings: Equatable, Sendable {
    public var tool: String
    public var thickness: Double
    public var gloss: Double
    public var metallic: Double
    public var load: Double
    public var thinner: Double
    public var drag: Double
    public var rim: Double
    public var clarity: Double

    var json: JSONValue {
        ["tool": .string(tool), "thickness": .number(thickness), "gloss": .number(gloss), "metallic": .number(metallic), "load": .number(load), "thinner": .number(thinner), "drag": .number(drag), "rim": .number(rim), "clarity": .number(clarity)]
    }
}

public let DEFAULT_IMPASTO = ImpastoSettings(tool: "brush", thickness: 0.6, gloss: 0.4, metallic: 0, load: 0.9, thinner: 0, drag: 0.4, rim: 0, clarity: 0)

func normalizeImpasto(_ raw: JSONObject, _ base: ImpastoSettings) -> ImpastoSettings {
    ImpastoSettings(
        tool: raw["tool"]?.stringValue.flatMap { IMPASTO_TOOLS.contains($0) ? $0 : nil } ?? base.tool,
        thickness: unitValue(raw["thickness"], base.thickness),
        gloss: unitValue(raw["gloss"], base.gloss),
        metallic: unitValue(raw["metallic"], base.metallic),
        load: unitValue(raw["load"], base.load),
        thinner: unitValue(raw["thinner"], base.thinner),
        drag: unitValue(raw["drag"], base.drag),
        rim: unitValue(raw["rim"], base.rim),
        clarity: unitValue(raw["clarity"], base.clarity)
    )
}

/// Light paint: how much light a brush lays with its colour.
public struct LightSettings: Equatable, Sendable {
    public var amount: Double
    public var pressure: Bool
    var json: JSONValue { ["amount": .number(amount), "pressure": .bool(pressure)] }
}

public let DEFAULT_LIGHT = LightSettings(amount: 0, pressure: false)

/// UV-fluorescent ink: how strongly the stroke glows under the virtual UV blacklight, and whether it leaves no daylight pigment.
public struct FluorescenceSettings: Equatable, Sendable {
    public var amount: Double
    public var invisible: Bool
    var json: JSONValue { ["amount": .number(amount), "invisible": .bool(invisible)] }
}

public let DEFAULT_FLUORESCENCE = FluorescenceSettings(amount: 0, invisible: false)

/// Thermochromic ink: the colour the stroke shifts toward where the canvas heat field exceeds `threshold` (0.05..0.95).
public struct ThermochromicSettings: Equatable, Sendable {
    public var hotColor: String?
    public var threshold: Double
    var json: JSONValue { ["hotColor": hotColor.map { .string($0) } ?? .null, "threshold": .number(threshold)] }
}

public let DEFAULT_THERMOCHROMIC = ThermochromicSettings(hotColor: nil, threshold: 0.5)

/// Thin-film iridescence: interference coat whose hue shifts with the light and view angle.
public struct IridescenceSettings: Equatable, Sendable {
    /// Film thickness at full pressure in nanometres (100..1000).
    public var thickness: Double
    /// How much lighter pressure thins the film (0: uniform thickness, 1: scales with pressure).
    public var pressureToThickness: Double
    /// Film refractive index (1.2..2.0; 1.33 soap film, 1.5 lacquer, 1.7 pearl / chitin).
    public var ior: Double

    public init(thickness: Double = 400, pressureToThickness: Double = 0, ior: Double = 1.5) {
        self.thickness = thickness
        self.pressureToThickness = pressureToThickness
        self.ior = ior
    }

    var json: JSONValue { ["thickness": .number(thickness), "pressureToThickness": .number(pressureToThickness), "ior": .number(ior)] }
}

public let DEFAULT_IRIDESCENCE = IridescenceSettings(thickness: 400, pressureToThickness: 0, ior: 1.5)

func readIridescence(_ raw: JSONValue?, _ base: IridescenceSettings?) -> IridescenceSettings? {
    guard let raw else { return base }
    if raw == .null || raw == .bool(false) { return nil }
    guard let r = raw.objectValue else { return base }
    let b = base ?? DEFAULT_IRIDESCENCE
    return IridescenceSettings(
        thickness: rangeValue(r["thickness"], 100, 1000, b.thickness),
        pressureToThickness: unitValue(r["pressureToThickness"], b.pressureToThickness),
        ior: rangeValue(r["ior"], 1.2, 2.0, b.ior)
    )
}

public func withIridescence(_ brush: PaintBrush, _ patch: IridescenceSettings?) -> PaintBrush {
    guard let patch else {
        var next = brush
        next.iridescence = nil
        return next
    }
    let b = brush.iridescence ?? DEFAULT_IRIDESCENCE
    var next = brush
    next.iridescence = IridescenceSettings(
        thickness: Swift.min(1000, Swift.max(100, patch.thickness.isFinite ? patch.thickness : b.thickness)),
        pressureToThickness: Swift.min(1, Swift.max(0, patch.pressureToThickness.isFinite ? patch.pressureToThickness : b.pressureToThickness)),
        ior: Swift.min(2.0, Swift.max(1.2, patch.ior.isFinite ? patch.ior : b.ior))
    )
    return next
}

/// Ghost paint: wet paint whose colour vanishes after `linger` seconds, leaving only what it smeared.
public struct GhostSettings: Equatable, Sendable {
    public var linger: Double
    public var smear: Double
    /// When the fade begins: `immediate` (default) fades as the wet clock ticks; `agent` waits for an agent claim (`read_mutation`).
    public var trigger: String? = nil
    var json: JSONValue {
        var o: JSONObject = ["linger": .number(linger), "smear": .number(smear)]
        if trigger == "agent" { o["trigger"] = "agent" }
        return .object(o)
    }
}

public let DEFAULT_GHOST = GhostSettings(linger: 4, smear: 0.3)

func normalizeGhost(_ raw: JSONObject, _ base: GhostSettings = DEFAULT_GHOST) -> GhostSettings {
    let trigger = raw["trigger"]?.stringValue == "agent" ? "agent" : raw["trigger"]?.stringValue == "immediate" ? "immediate" : base.trigger
    return GhostSettings(
        linger: rangeValue(raw["linger"], 0.5, 60, base.linger),
        smear: unitValue(raw["smear"], base.smear),
        trigger: trigger == "agent" ? "agent" : nil
    )
}

/// Mutation paint: strokes pause for `settle` seconds, then an agent claims them, they fade over `fade` seconds, and the agent paints an answer.
public struct MutationSettings: Equatable, Sendable {
    public var settle: Double
    public var patience: Double
    public var fade: Double
    var json: JSONValue { ["settle": .number(settle), "patience": .number(patience), "fade": .number(fade)] }
}

public let DEFAULT_MUTATION = MutationSettings(settle: 1.5, patience: 45, fade: 2)

func normalizeMutation(_ raw: JSONObject, _ base: MutationSettings = DEFAULT_MUTATION) -> MutationSettings {
    MutationSettings(
        settle: rangeValue(raw["settle"], 0.5, 10, base.settle),
        patience: rangeValue(raw["patience"], 5, 300, base.patience),
        fade: rangeValue(raw["fade"], 0.5, 10, base.fade)
    )
}

/// Antimatter paint settings.
public struct AntimatterSettings: Equatable, Sendable {
    public var blastRadius: Double
    public var blastSpacing: Double
    public var threshold: Double
    public var invert: Double
    public var invertMode: String
    public var scorch: Double
    public var annihilate: Double
    public var sparks: Double
    public var sparkReach: Double
    public var crater: Double
    public var duration: Double

    public var json: JSONValue {
        [
            "blastRadius": .number(blastRadius),
            "blastSpacing": .number(blastSpacing),
            "threshold": .number(threshold),
            "invert": .number(invert),
            "invertMode": .string(invertMode),
            "scorch": .number(scorch),
            "annihilate": .number(annihilate),
            "sparks": .number(sparks),
            "sparkReach": .number(sparkReach),
            "crater": .number(crater),
            "duration": .number(duration),
        ]
    }
}

public let DEFAULT_ANTIMATTER = AntimatterSettings(
    blastRadius: 2.5,
    blastSpacing: 2,
    threshold: 0.1,
    invert: 1,
    invertMode: "rgb",
    scorch: 0.6,
    annihilate: 0.25,
    sparks: 0.5,
    sparkReach: 3,
    crater: 0.5,
    duration: 0.7
)

func normalizeAntimatter(_ raw: JSONObject, _ base: AntimatterSettings = DEFAULT_ANTIMATTER) -> AntimatterSettings {
    AntimatterSettings(
        blastRadius: rangeValue(raw["blastRadius"], 1, 6, base.blastRadius),
        blastSpacing: rangeValue(raw["blastSpacing"], 0.5, 8, base.blastSpacing),
        threshold: unitValue(raw["threshold"], base.threshold),
        invert: unitValue(raw["invert"], base.invert),
        invertMode: raw["invertMode"]?.stringValue.flatMap { ANTIMATTER_INVERT_MODES.contains($0) ? $0 : nil } ?? base.invertMode,
        scorch: unitValue(raw["scorch"], base.scorch),
        annihilate: unitValue(raw["annihilate"], base.annihilate),
        sparks: unitValue(raw["sparks"], base.sparks),
        sparkReach: rangeValue(raw["sparkReach"], 0.5, 8, base.sparkReach),
        crater: unitValue(raw["crater"], base.crater),
        duration: rangeValue(raw["duration"], 0, 2, base.duration)
    )
}

/// Multi-coloured brush (the read-only view of gradient paint older readers know).
public struct MultiColorSettings: Equatable, Sendable {
    public var mode: String
    public var colors: [String]
    public var order: String
    public var length: Double
    public var softness: Double

    var json: JSONValue {
        ["mode": .string(mode), "colors": .array(colors.map { .string($0) }), "order": .string(order), "length": .number(length), "softness": .number(softness)]
    }
}

public let DEFAULT_MULTI_COLOR = MultiColorSettings(mode: "off", colors: [], order: "sequence", length: 12, softness: 1)

func normalizeMultiColor(_ raw: JSONObject, _ base: MultiColorSettings) -> MultiColorSettings {
    var colors = base.colors
    if let list = raw["colors"]?.arrayValue {
        colors = Array(list.compactMap { v -> String? in
            guard let s = v.stringValue else { return nil }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil ? t.lowercased() : nil
        }.prefix(8))
    }
    return MultiColorSettings(
        mode: raw["mode"]?.stringValue.flatMap { MULTI_COLOR_MODES.contains($0) ? $0 : nil } ?? base.mode,
        colors: colors,
        order: raw["order"]?.stringValue.flatMap { $0 == "random" || $0 == "sequence" ? $0 : nil } ?? base.order,
        length: raw["length"]?.finite.map { Swift.min(500, Swift.max(1, JS.round($0))) } ?? base.length,
        softness: unitValue(raw["softness"], base.softness)
    )
}

/// How a brush handles paint on the canvas (pick-up and mix ratios, dirty brush, mixing, multi-colour).
public struct BrushBehavior: Equatable, Sendable {
    public var pickup: Double
    public var mix: Double
    public var dirty: Bool
    public var mixing: String
    public var multicolor: MultiColorSettings

    var json: JSONValue { ["pickup": .number(pickup), "mix": .number(mix), "dirty": .bool(dirty), "mixing": .string(mixing), "multicolor": multicolor.json] }
}

public let DEFAULT_BEHAVIOR = BrushBehavior(pickup: 0, mix: 0.5, dirty: false, mixing: "pigment", multicolor: DEFAULT_MULTI_COLOR)

func normalizeBehavior(_ raw: JSONObject, _ base: BrushBehavior) -> BrushBehavior {
    BrushBehavior(
        pickup: unitValue(raw["pickup"], base.pickup),
        mix: unitValue(raw["mix"], base.mix),
        dirty: boolValue(raw["dirty"], base.dirty),
        mixing: raw["mixing"]?.stringValue.flatMap { $0 == "rgb" || $0 == "pigment" ? $0 : nil } ?? base.mixing,
        multicolor: normalizeMultiColor(raw["multicolor"]?.objectValue ?? [:], base.multicolor)
    )
}

/// Pen dynamics and jitter. Every amount is 0 (off) .. 1 unless noted.
public struct BrushDynamics: Equatable, Sendable {
    public var minSize: Double
    public var pressureFlow: Double
    public var tiltSize: Double
    public var tiltRoundness: Double
    public var tiltOpacity: Double
    public var velocitySize: Double
    public var velocityOpacity: Double
    public var sizeJitter: Double
    public var angleJitter: Double
    public var opacityJitter: Double
    public var scatter: Double
    /// Dabs laid at each spacing step, 2..16, each with its own jitter (nil: one).
    public var count: Int? = nil
    /// Mirror each dab at random across `x`, `y` or both (nil: none).
    public var flip: String? = nil

    var json: JSONValue {
        var o: JSONObject = ["minSize": .number(minSize), "pressureFlow": .number(pressureFlow), "tiltSize": .number(tiltSize), "tiltRoundness": .number(tiltRoundness), "tiltOpacity": .number(tiltOpacity), "velocitySize": .number(velocitySize), "velocityOpacity": .number(velocityOpacity), "sizeJitter": .number(sizeJitter), "angleJitter": .number(angleJitter), "opacityJitter": .number(opacityJitter), "scatter": .number(scatter)]
        if let count { o["count"] = .number(Double(count)) }
        if let flip { o["flip"] = .string(flip) }
        return .object(o)
    }
}

public let DEFAULT_DYNAMICS = BrushDynamics(minSize: 0, pressureFlow: 0, tiltSize: 0, tiltRoundness: 0, tiltOpacity: 0, velocitySize: 0, velocityOpacity: 0, sizeJitter: 0, angleJitter: 0, opacityJitter: 0, scatter: 0)

func normalizeDynamics(_ raw: JSONObject, _ base: BrushDynamics) -> BrushDynamics {
    BrushDynamics(
        minSize: unitValue(raw["minSize"], base.minSize),
        pressureFlow: unitValue(raw["pressureFlow"], base.pressureFlow),
        tiltSize: unitValue(raw["tiltSize"], base.tiltSize),
        tiltRoundness: unitValue(raw["tiltRoundness"], base.tiltRoundness),
        tiltOpacity: unitValue(raw["tiltOpacity"], base.tiltOpacity),
        velocitySize: rangeValue(raw["velocitySize"], -1, 1, base.velocitySize),
        velocityOpacity: rangeValue(raw["velocityOpacity"], -1, 1, base.velocityOpacity),
        sizeJitter: unitValue(raw["sizeJitter"], base.sizeJitter),
        angleJitter: unitValue(raw["angleJitter"], base.angleJitter),
        opacityJitter: unitValue(raw["opacityJitter"], base.opacityJitter),
        scatter: rangeValue(raw["scatter"], 0, 4, base.scatter),
        // Kept only when they are not the defaults (one dab, no flip), so brushes that don't use them read as before.
        count: { let n = raw["count"]?.finite.map { Int(Swift.min(16, Swift.max(1, JS.round($0)))) } ?? base.count ?? 1; return n > 1 ? n : nil }(),
        flip: { let f = raw["flip"]?.stringValue.flatMap { DAB_FLIPS.contains($0) ? $0 : nil } ?? base.flip ?? "none"; return f != "none" ? f : nil }()
    )
}

/// Spray marks (dab engine).
public struct SpraySettings: Equatable, Sendable {
    public var density: Double
    public var size: Double
    var json: JSONValue { ["density": .number(density), "size": .number(size)] }
}

public let DEFAULT_SPRAY = SpraySettings(density: 0.5, size: 0.12)

extension BrushSettings {
    var json: JSONValue {
        ["size": .number(size), "hardness": .number(hardness), "spacing": .number(spacing), "angle": .number(angle), "roundness": .number(roundness), "opacity": .number(opacity), "flow": .number(flow), "smoothing": .number(smoothing), "pressureSize": .bool(pressureSize), "pressureOpacity": .bool(pressureOpacity), "blend": .string(blend.rawValue)]
    }
}

/// A tip with every field in range (missing fields from `DEFAULT_BRUSH`).
func normalizeBrushSettings(_ raw: JSONObject) -> BrushSettings {
    BrushSettings(
        size: rangeValue(raw["size"], 1, MAX_BRUSH_SIZE, DEFAULT_BRUSH.size),
        hardness: rangeValue(raw["hardness"], 0, 1, DEFAULT_BRUSH.hardness),
        spacing: rangeValue(raw["spacing"], 0.01, 10, DEFAULT_BRUSH.spacing),
        angle: rangeValue(raw["angle"], -360, 360, DEFAULT_BRUSH.angle),
        roundness: rangeValue(raw["roundness"], 0.01, 1, DEFAULT_BRUSH.roundness),
        opacity: rangeValue(raw["opacity"], 0, 1, DEFAULT_BRUSH.opacity),
        flow: rangeValue(raw["flow"], 0, 1, DEFAULT_BRUSH.flow),
        smoothing: rangeValue(raw["smoothing"], 0, 0.95, DEFAULT_BRUSH.smoothing),
        pressureSize: boolValue(raw["pressureSize"], DEFAULT_BRUSH.pressureSize),
        pressureOpacity: boolValue(raw["pressureOpacity"], DEFAULT_BRUSH.pressureOpacity),
        blend: raw["blend"]?.stringValue.flatMap(BlendMode.init(rawValue:)) ?? .normal
    )
}

// MARK: - The settings of the engines this port does not paint with yet (kept as data)

let DEFAULT_PARTICLE: JSONObject = ["kind": "spring", "render": "line", "count": 12, "size": 0.08, "spread": 0.5, "stiffness": 0.4, "damping": 0.25, "speed": 0.5, "gravity": 0, "life": 0.5, "interval": 0.3, "ribbonFill": 0.5, "ribbonPairs": "adjacent", "waveAmplitude": 0, "waveLength": 60, "waveSpeed": 0, "wavePhaseJitter": 0, "dotTextures": [], "dotTextureOrder": "sequence", "dotRotation": "random"]
let DEFAULT_BRISTLE: JSONObject = ["count": 32, "stiffness": 0.5, "splay": 0.5, "thickness": 0.06, "load": 0.6, "jitter": 0.4]
let DEFAULT_STICKER: JSONObject = ["stamps": ["editor:star"], "density": 0.4, "sizeJitter": 0.4, "rotationJitter": 1, "scatter": 0.5, "colorJitter": 0.2]

private func oneOf(_ v: JSONValue?, _ list: [String], _ d: JSONValue?) -> JSONValue {
    if let s = v?.stringValue, list.contains(s) { return .string(s) }
    return d ?? .null
}

/// A sticker ref split into provider and id (a bare editor stamp is `editor:<stamp>`), or nil.
func parseStickerRef(_ ref: String) -> (provider: String, id: String)? {
    guard !ref.isEmpty else { return nil }
    guard let i = ref.firstIndex(of: ":") else { return STAMP_KINDS.contains(ref) ? ("editor", ref) : nil }
    if i == ref.startIndex || ref.index(after: i) == ref.endIndex { return nil }
    return (String(ref[..<i]), String(ref[ref.index(after: i)...]))
}

/// The canonical form of a sticker ref (`"star"` → `"editor:star"`), or nil.
func normalizeStickerRef(_ ref: String) -> String? {
    parseStickerRef(ref).map { "\($0.provider):\($0.id)" }
}

/// The editor stamp a ref names, or nil for another provider's sticker (or no ref at all).
func editorStampOf(_ ref: String) -> String? {
    guard let r = parseStickerRef(ref) else { return nil }
    return r.provider == "editor" && STAMP_KINDS.contains(r.id) ? r.id : nil
}

func normalizeParticle(_ raw: JSONObject, _ base: JSONObject) -> JSONObject {
    func texture(_ t: JSONValue) -> String? {
        guard let s = t.stringValue else { return nil }
        let bare = s.hasPrefix("editor:") ? String(s.dropFirst(7)) : s
        if STAMP_KINDS.contains(bare) { return bare }
        return s.range(of: #"^[^:\s]+:\S+$"#, options: .regularExpression) != nil && s.utf16.count <= 200 ? s : nil
    }
    let textures: JSONValue = raw["dotTextures"]?.arrayValue.map { .array(Array($0.compactMap(texture).prefix(MAX_DOT_TEXTURES)).map { .string($0) }) } ?? (base["dotTextures"] ?? [])
    func unitKey(_ k: String) -> JSONValue { .number(unitValue(raw[k], base[k]?.numberValue ?? DEFAULT_PARTICLE[k]!.numberValue!)) }
    return [
        "kind": oneOf(raw["kind"], PARTICLE_KINDS, base["kind"]),
        "render": oneOf(raw["render"], PARTICLE_RENDERS, base["render"]),
        "count": raw["count"]?.finite.map { .number(Swift.min(64, Swift.max(1, JS.round($0)))) } ?? base["count"]!,
        "size": unitKey("size"), "spread": unitKey("spread"), "stiffness": unitKey("stiffness"), "damping": unitKey("damping"), "speed": unitKey("speed"),
        "gravity": raw["gravity"]?.finite.map { .number(Swift.min(1, Swift.max(-1, $0))) } ?? base["gravity"]!,
        "life": unitKey("life"), "interval": unitKey("interval"), "ribbonFill": unitKey("ribbonFill"),
        "ribbonPairs": oneOf(raw["ribbonPairs"], RIBBON_PAIRS, base["ribbonPairs"] ?? DEFAULT_PARTICLE["ribbonPairs"]),
        "waveAmplitude": unitKey("waveAmplitude"),
        "waveLength": raw["waveLength"]?.finite.map { .number(Swift.min(2000, Swift.max(4, $0))) } ?? base["waveLength"] ?? DEFAULT_PARTICLE["waveLength"]!,
        "waveSpeed": unitKey("waveSpeed"), "wavePhaseJitter": unitKey("wavePhaseJitter"),
        "dotTextures": textures,
        "dotTextureOrder": oneOf(raw["dotTextureOrder"], DOT_TEXTURE_ORDERS, base["dotTextureOrder"] ?? DEFAULT_PARTICLE["dotTextureOrder"]),
        "dotRotation": oneOf(raw["dotRotation"], DOT_ROTATIONS, base["dotRotation"] ?? DEFAULT_PARTICLE["dotRotation"]),
    ]
}

func normalizeBristle(_ raw: JSONObject, _ base: JSONObject) -> JSONObject {
    func unitKey(_ k: String) -> JSONValue { .number(unitValue(raw[k], base[k]!.numberValue!)) }
    return [
        "count": raw["count"]?.finite.map { .number(Swift.min(128, Swift.max(3, JS.round($0)))) } ?? base["count"]!,
        "stiffness": unitKey("stiffness"), "splay": unitKey("splay"), "thickness": unitKey("thickness"), "load": unitKey("load"), "jitter": unitKey("jitter"),
    ]
}

func normalizeStickerSettings(_ raw: JSONObject, _ base: JSONObject) -> JSONObject {
    let refs = { (list: [JSONValue]) in list.compactMap { $0.stringValue.flatMap(normalizeStickerRef) } }
    let baseStamps = base["stamps"]?.arrayValue ?? []
    let stamps = raw["stamps"]?.arrayValue.map(refs) ?? refs(baseStamps)
    var unique: [String] = []
    for s in stamps where !unique.contains(s) { unique.append(s) }
    let final: [String] = !stamps.isEmpty ? Array(unique.prefix(MAX_STICKER_STAMPS)) : refs(!baseStamps.isEmpty ? baseStamps : DEFAULT_STICKER["stamps"]!.arrayValue!)
    func unitKey(_ k: String) -> JSONValue { .number(unitValue(raw[k], base[k]!.numberValue!)) }
    return [
        "stamps": .array(final.map { .string($0) }),
        "density": unitKey("density"), "sizeJitter": unitKey("sizeJitter"), "rotationJitter": unitKey("rotationJitter"),
        "scatter": raw["scatter"]?.finite.map { .number(Swift.min(2, Swift.max(0, $0))) } ?? base["scatter"]!,
        "colorJitter": unitKey("colorJitter"),
    ]
}

/// Scraper engine settings: how many layers per pass (0..1) and bevel sharpness (0..1).
public struct ScraperSettings: Equatable, Sendable {
    public var depth: Double
    public var sharpness: Double

    public init(depth: Double = 0.5, sharpness: Double = 0.7) {
        self.depth = depth
        self.sharpness = sharpness
    }

    var json: JSONValue { ["depth": .number(depth), "sharpness": .number(sharpness)] }
}

public let DEFAULT_SCRAPER = ScraperSettings(depth: 0.5, sharpness: 0.7)

func normalizeScraper(_ raw: JSONObject, _ base: ScraperSettings = DEFAULT_SCRAPER) -> ScraperSettings {
    ScraperSettings(
        depth: unitValue(raw["depth"], base.depth),
        sharpness: unitValue(raw["sharpness"], base.sharpness)
    )
}

// MARK: - The brush

/// The flat form the paint engine reads: every engine block, filled.
public struct PaintBrush: Equatable, Sendable {
    public var id: String
    public var name: String
    public var category: String
    public var engine: String
    public var tip: BrushSettings
    public var grain: Double
    public var pressureSmoothing: Double
    public var rotation: String
    public var dynamics: BrushDynamics
    public var mixer: MixerSettings
    public var loadsColor: Bool
    public var behavior: BrushBehavior
    public var blender: BlenderSettings
    public var smudge: SmudgeSettings
    public var wet: WetBrushSettings
    public var impasto: ImpastoSettings
    public var particle: JSONObject
    public var bristle: JSONObject
    public var sticker: JSONObject
    public var antimatter: AntimatterSettings = DEFAULT_ANTIMATTER
    public var scraper: ScraperSettings = DEFAULT_SCRAPER
    public var light: LightSettings
    public var fluorescence: FluorescenceSettings
    public var thermochromic: ThermochromicSettings
    /// Thin-film iridescence coat (nil: none).
    public var iridescence: IridescenceSettings? = nil
    public var ghost: GhostSettings? = nil
    public var mutation: MutationSettings? = nil
    public var ferro: FerroSettings = DEFAULT_FERRO
    public var culture: CultureSettings? = nil
    public var stamp: String?
    public var spray: SpraySettings?
    /// Dab engines: texture inside the tip (nil: none).
    public var tipGrain: TipGrainSettings? = nil
    /// Wet engine: Gray-Scott reaction-diffusion patterns that grow in wet paint (nil: none).
    public var livePatterns: LivePatternsSettings? = nil
    public var paint: PaintGradientSource?
    public var builtin: Bool?

    /// The brush as plain JSON in the TS key order (`brushToJSON` leaves `builtin` out).
    public func json(builtin withBuiltin: Bool = true) -> JSONObject {
        var o: JSONObject = [
            "id": .string(id), "name": .string(name), "category": .string(category), "engine": .string(engine),
            "tip": tip.json, "grain": .number(grain), "pressureSmoothing": .number(pressureSmoothing), "rotation": .string(rotation),
            "dynamics": dynamics.json,
            "mixer": ["wet": .number(mixer.wet), "load": .number(mixer.load), "mix": .number(mixer.mix), "loadEachStroke": .bool(mixer.loadEachStroke), "cleanEachStroke": .bool(mixer.cleanEachStroke), "mixing": .string(mixer.mixing)],
            "loadsColor": .bool(loadsColor), "behavior": behavior.json,
            "blender": ["strength": .number(blender.strength), "distance": .number(blender.distance), "mixing": .string(blender.mixing)],
            "smudge": ["strength": .number(smudge.strength), "length": .number(smudge.length), "mixing": .string(smudge.mixing)],
            "wet": wet.json, "impasto": impasto.json,
            "particle": .object(particle), "bristle": .object(bristle), "sticker": .object(sticker),
            "antimatter": antimatter.json,
            "scraper": scraper.json,
            "light": light.json,
            "fluorescence": fluorescence.json,
            "thermochromic": thermochromic.json,
        ]
        if let iridescence { o["iridescence"] = iridescence.json }
        if let ghost { o["ghost"] = ghost.json }
        if let mutation { o["mutation"] = mutation.json }
        o["ferro"] = ferro.json
        o["stamp"] = stamp.map { .string($0) } ?? .null
        o["spray"] = spray?.json ?? .null
        if let tipGrain { o["tipGrain"] = tipGrain.json }
        if let livePatterns { o["livePatterns"] = livePatterns.json }
        if let culture { o["culture"] = culture.json }
        o["paint"] = paint?.json ?? .null
        if withBuiltin, builtin == true { o["builtin"] = true }
        return o
    }
}

/// Whether a dab brush paints dab by dab through the exchange (it picks up paint or paints a gradient).
public func usesPaintExchange(_ brush: PaintBrush, _ gradient: Bool? = nil) -> Bool {
    brush.engine == "dab" && (brush.behavior.pickup > 0 || (gradient ?? (brush.paint != nil)))
}

/// Whether strokes of a brush paint colour, so gradient paint applies.
public func brushTakesPaint(_ brush: PaintBrush) -> Bool {
    if brush.engine == "eraser" || brush.engine == "blender" || brush.engine == "smudge" || brush.engine == "scraper" { return false }
    if brush.engine == "wet" { return brush.wet.tool == "paint" }
    if brush.engine == "mixer" { return brush.loadsColor }
    return true
}

/// Whether a brush paints wet media.
public func isWetBrush(_ brush: PaintBrush) -> Bool { brush.engine == "wet" }

/// The multi-colour settings a gradient paints the same as, or nil when there are none.
func paintToMultiColor(_ g: PaintGradientSource?) -> MultiColorSettings? {
    guard let g, g.space != "oklab", !g.stops.contains(where: { $0.opacity != nil || $0.midpoint != nil }) else { return nil }
    let colors = g.stops.map(\.color)
    func own(_ list: [String]) -> [String]? {
        if list.count == 2 && list[0] == "paint" && list[1] == "secondary" { return [] }
        return list.contains { $0 == "paint" || $0 == "secondary" } ? nil : list
    }
    func uniform(_ n: Int) -> Bool { g.stops.enumerated().allSatisfy { k, s in s.offset == Double(k) / Double(n) } }
    let softness = g.softness ?? 1
    if g.map.by == "across-tip" && colors.count <= 8 && uniform(colors.count - 1) {
        return own(colors).map { MultiColorSettings(mode: "tip", colors: $0, order: "sequence", length: DEFAULT_MULTI_COLOR.length, softness: softness) }
    }
    if g.map.by == "random" && colors.count % 2 == 0 && colors.count <= 16 {
        let n = colors.count / 2
        let pairs = (0..<n).map { colors[2 * $0] }
        let hard = g.stops.enumerated().allSatisfy { i, s in s.offset == Double(i / 2 + i % 2) / Double(n) && s.color == pairs[i / 2] }
        let c = hard ? own(pairs) : nil
        return c.map { MultiColorSettings(mode: "dab", colors: $0, order: "random", length: g.map.every ?? 1, softness: softness) }
    }
    if g.map.by == "distance" && g.map.unit == "dabs" && g.map.repeat == "repeat" && colors.count >= 3 && colors.count <= 9 && colors.first == colors.last && uniform(colors.count - 1) {
        let n = colors.count - 1
        let c = own(Array(colors.prefix(n)))
        let length = (g.map.length ?? 0) / Double(n)
        guard let c, length.rounded() == length else { return nil }
        return MultiColorSettings(mode: "dab", colors: c, order: "sequence", length: length, softness: softness)
    }
    return nil
}

/// The gradient paint a multi-coloured brush paints the same pixels with.
func multiColorToPaint(_ mc: MultiColorSettings, _ mixing: String) -> PaintGradientSource? {
    if mc.mode == "off" { return nil }
    let colors = mc.colors.count >= 2 ? mc.colors : ["paint", "secondary"]
    let n = colors.count
    let space = mixing == "rgb" ? "srgb" : "pigment"
    let soft: Double? = mc.softness < 1 ? mc.softness : nil
    if mc.mode == "tip" {
        return PaintGradientSource(stops: colors.enumerated().map { PaintGradientStop(offset: Double($0.offset) / Double(n - 1), color: $0.element) }, space: space, map: PaintGradientMapping(by: "across-tip"), softness: soft)
    }
    if mc.order == "random" {
        let stops = colors.enumerated().flatMap { k, color in [PaintGradientStop(offset: Double(k) / Double(n), color: color), PaintGradientStop(offset: Double(k + 1) / Double(n), color: color)] }
        return PaintGradientSource(stops: stops, space: space, map: PaintGradientMapping(by: "random", every: mc.length))
    }
    return PaintGradientSource(stops: (colors + [colors[0]]).enumerated().map { PaintGradientStop(offset: Double($0.offset) / Double(n), color: $0.element) }, space: space, map: PaintGradientMapping(by: "distance", length: mc.length * Double(n), repeat: "repeat", unit: "dabs"), softness: soft)
}

private func readStamp(_ raw: JSONValue?, _ base: String?) -> String? {
    guard let raw else { return base }
    if raw == .null { return nil }
    guard let s = raw.stringValue else { return base }
    if STAMP_KINDS.contains(s) { return "editor:\(s)" }
    return s.range(of: #"^[^:\s]+:\S+$"#, options: .regularExpression) != nil && s.utf16.count <= 200 ? s : base
}

private func readSpray(_ raw: JSONValue?, _ base: SpraySettings?) -> SpraySettings? {
    guard let raw else { return base }
    if raw == .null { return nil }
    guard let r = raw.objectValue else { return base }
    let b = base ?? DEFAULT_SPRAY
    return SpraySettings(density: unitValue(r["density"], b.density), size: rangeValue(r["size"], 0.02, 1, b.size))
}

private func readLivePatterns(_ raw: JSONValue?, _ base: LivePatternsSettings?) -> LivePatternsSettings? {
    guard let raw else { return base }
    if raw == .null { return nil }
    guard let r = raw.objectValue else { return base }
    return normalizeLivePatterns(r, base ?? DEFAULT_LIVE_PATTERNS)
}

let BASE_BRUSH = PaintBrush(
    id: "round", name: "Round", category: "custom", engine: "dab", tip: DEFAULT_BRUSH, grain: 0, pressureSmoothing: 0, rotation: "fixed",
    dynamics: DEFAULT_DYNAMICS, mixer: DEFAULT_MIXER, loadsColor: true, behavior: DEFAULT_BEHAVIOR, blender: DEFAULT_BLENDER, smudge: DEFAULT_SMUDGE,
    wet: DEFAULT_WET_BRUSH, impasto: DEFAULT_IMPASTO, particle: DEFAULT_PARTICLE, bristle: DEFAULT_BRISTLE, sticker: DEFAULT_STICKER,
    light: DEFAULT_LIGHT, fluorescence: DEFAULT_FLUORESCENCE, thermochromic: DEFAULT_THERMOCHROMIC, ferro: DEFAULT_FERRO, stamp: nil, spray: nil, paint: nil, builtin: nil
)

/// A brush with every field in range; missing fields come from `base` (default: a plain round dab brush).
public func normalizePaintBrush(_ raw: JSONObject, _ base: PaintBrush? = nil) -> PaintBrush {
    let b = base ?? BASE_BRUSH
    let id = raw["id"]?.stringValue.flatMap { isBrushId($0) ? $0 : nil } ?? b.id
    let engine = raw["engine"]?.stringValue.flatMap { PAINT_BRUSH_ENGINES.contains($0) ? $0 : nil } ?? b.engine
    // A Mixer Brush's pick-up / mix ratios, dirtiness and mixing are its mixer settings.
    let rb = raw["behavior"]?.objectValue ?? [:]
    let rm = raw["mixer"]?.objectValue ?? [:]
    func mixerValue(_ key: String) -> JSONValue? { rm[key] ?? nil }
    var wetV: JSONValue = rm["wet"] ?? .number(b.mixer.wet)
    var mixV: JSONValue = rm["mix"] ?? .number(b.mixer.mix)
    var cleanV: JSONValue = rm["cleanEachStroke"] ?? .bool(b.mixer.cleanEachStroke)
    var mixingV: JSONValue = rm["mixing"] ?? .string(b.mixer.mixing)
    if engine == "mixer" {
        if let v = rb["pickup"] { wetV = v }
        if let v = rb["mix"] { mixV = v }
        if let v = rb["dirty"] { cleanV = v.boolValue.map { .bool(!$0) } ?? .bool(true) }
        if let v = rb["mixing"] { mixingV = v }
    }
    let mixer = MixerSettings(
        wet: unitValue(wetV, DEFAULT_MIXER.wet),
        load: unitValue(rm["load"] ?? .number(b.mixer.load), DEFAULT_MIXER.load),
        mix: unitValue(mixV, DEFAULT_MIXER.mix),
        loadEachStroke: boolValue(rm["loadEachStroke"] ?? .bool(b.mixer.loadEachStroke), DEFAULT_MIXER.loadEachStroke),
        cleanEachStroke: boolValue(cleanV, DEFAULT_MIXER.cleanEachStroke),
        mixing: mixingV.stringValue == "pigment" ? "pigment" : "rgb"
    )
    var behavior = normalizeBehavior(rb, b.behavior)
    if engine == "mixer" { behavior = BrushBehavior(pickup: mixer.wet, mix: mixer.mix, dirty: !mixer.cleanEachStroke, mixing: mixer.mixing, multicolor: behavior.multicolor) }
    // Gradient paint: given (a plain colour or null clears it), or the multi-colour settings of older brushes.
    var paint = b.paint
    if let rp = raw["paint"] {
        if case .gradient(let g)? = readPaintSource(rp) { paint = g } else { paint = nil }
    } else if let mcRaw = rb["multicolor"] {
        let mc = normalizeMultiColor(mcRaw.objectValue ?? [:], paintToMultiColor(paint) ?? DEFAULT_MULTI_COLOR)
        paint = mc.mode == "off" ? (paintToMultiColor(paint) != nil ? nil : paint) : multiColorToPaint(mc, behavior.mixing)
    }
    // `behavior.multicolor` is a read-only view of the gradient, for older readers.
    behavior.multicolor = paintToMultiColor(paint) ?? DEFAULT_MULTI_COLOR
    let tipRaw = b.tip.json.objectValue!.merging(raw["tip"]?.objectValue ?? [:])
    let name: String = {
        if let n = raw["name"]?.stringValue {
            let t = n.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return String(t.prefix(80)) }
        }
        return b.name
    }()
    let rbl = raw["blender"]?.objectValue ?? [:]
    let rsm = raw["smudge"]?.objectValue ?? [:]
    let rl = raw["light"]?.objectValue ?? [:]
    let rfl: JSONObject = {
        if let n = raw["fluorescence"]?.finite { return ["amount": .number(n)] }
        return raw["fluorescence"]?.objectValue ?? [:]
    }()
    let rth = raw["thermochromic"]?.objectValue ?? [:]
    let hotColor: String? = {
        if rth["hotColor"] == .null { return nil }
        if let s = rth["hotColor"]?.stringValue {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if isHexColor(t) { return t }
        }
        return b.thermochromic.hotColor
    }()
    let wet = normalizeWetBrush(raw["wet"]?.objectValue ?? [:], b.wet)
    let wantsLight = (rl["amount"]?.finite ?? 0) > 0
    let canMutate = engine == "dab" || (engine == "wet" && wet.tool == "paint") || engine == "impasto" || engine == "particle" || engine == "bristle"
    let mutation: MutationSettings? = {
        guard canMutate else { return nil }
        if let rm = raw["mutation"] {
            if rm == .null { return nil }
            return normalizeMutation(rm.objectValue ?? [:], b.mutation ?? DEFAULT_MUTATION)
        }
        return b.mutation.map { normalizeMutation([:], $0) }
    }()
    let hadAutoGhost = b.mutation != nil && raw["mutation"] == .null && raw["ghost"] == nil
    let ghostBase: GhostSettings = {
        if let mutation {
            var g = b.ghost ?? DEFAULT_GHOST
            g.linger = mutation.fade
            g.trigger = "agent"
            return g
        }
        return b.ghost ?? DEFAULT_GHOST
    }()
    let ghost: GhostSettings? = {
        guard engine == "wet" && wet.tool == "paint" && !hadAutoGhost else { return nil }
        if let rg = raw["ghost"] {
            if rg == .null { return nil }
            return normalizeGhost(rg.objectValue ?? [:], ghostBase)
        }
        return (mutation != nil || (!wantsLight && b.ghost != nil)) ? normalizeGhost([:], ghostBase) : nil
    }()
    if ghost != nil || mutation != nil {
        behavior.pickup = 0
        behavior.dirty = false
    }
    return PaintBrush(
        id: id,
        name: name,
        category: raw["category"]?.stringValue.flatMap { PAINT_BRUSH_CATEGORIES.contains($0) ? $0 : nil } ?? b.category,
        engine: engine,
        tip: normalizeBrushSettings(tipRaw),
        grain: unitValue(raw["grain"], b.grain),
        pressureSmoothing: rangeValue(raw["pressureSmoothing"], 0, 0.95, b.pressureSmoothing),
        rotation: raw["rotation"]?.stringValue.flatMap { BRUSH_ROTATIONS.contains($0) ? $0 : nil } ?? b.rotation,
        dynamics: normalizeDynamics(raw["dynamics"]?.objectValue ?? [:], b.dynamics),
        mixer: mixer,
        loadsColor: boolValue(raw["loadsColor"], b.loadsColor),
        behavior: behavior,
        blender: BlenderSettings(strength: unitValue(rbl["strength"], b.blender.strength), distance: unitValue(rbl["distance"], b.blender.distance), mixing: rbl["mixing"]?.stringValue.flatMap { $0 == "rgb" || $0 == "pigment" ? $0 : nil } ?? b.blender.mixing),
        smudge: SmudgeSettings(strength: unitValue(rsm["strength"], b.smudge.strength), length: unitValue(rsm["length"], b.smudge.length), mixing: rsm["mixing"]?.stringValue.flatMap { $0 == "rgb" || $0 == "pigment" ? $0 : nil } ?? b.smudge.mixing),
        wet: wet,
        impasto: normalizeImpasto(raw["impasto"]?.objectValue ?? [:], b.impasto),
        particle: normalizeParticle(raw["particle"]?.objectValue ?? [:], b.particle),
        bristle: normalizeBristle(raw["bristle"]?.objectValue ?? [:], b.bristle),
        sticker: normalizeStickerSettings(raw["sticker"]?.objectValue ?? [:], b.sticker),
        antimatter: normalizeAntimatter(raw["antimatter"]?.objectValue ?? [:], b.antimatter),
        scraper: normalizeScraper(raw["scraper"]?.objectValue ?? [:], b.scraper),
        light: ghost != nil && !wantsLight ? DEFAULT_LIGHT : LightSettings(amount: unitValue(rl["amount"], b.light.amount), pressure: boolValue(rl["pressure"], b.light.pressure)),
        fluorescence: FluorescenceSettings(amount: unitValue(rfl["amount"], b.fluorescence.amount), invisible: boolValue(rfl["invisible"], b.fluorescence.invisible)),
        thermochromic: ThermochromicSettings(hotColor: hotColor, threshold: rangeValue(rth["threshold"], 0.05, 0.95, b.thermochromic.threshold)),
        iridescence: readIridescence(raw["iridescence"], b.iridescence),
        ghost: ghost,
        mutation: mutation,
        ferro: normalizeFerro(raw["ferro"]?.objectValue ?? (raw["ferro"]?.numberValue.map { ["amount": .number($0)] } ?? [:]), b.ferro),
        culture: {
            let canCulture = ["dab", "mixer", "wet", "impasto", "particle", "bristle"].contains(engine) && (engine != "wet" || wet.tool == "paint")
            return canCulture ? readCulture(raw["culture"], b.culture) : nil
        }(),
        stamp: readStamp(raw["stamp"], b.stamp),
        spray: readSpray(raw["spray"], b.spray),
        tipGrain: readTipGrain(raw["tipGrain"], b.tipGrain),
        livePatterns: readLivePatterns(raw["livePatterns"], b.livePatterns),
        paint: paint,
        builtin: raw["builtin"]?.boolValue == true ? true : nil
    )
}

/// `normalizePaintBrush(brush, brush)`: a brush read again over itself (a copy in range).
public func renormalized(_ brush: PaintBrush) -> PaintBrush {
    normalizePaintBrush(brush.json(), brush)
}
