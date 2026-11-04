import Foundation
import PixerateCore
import PixerateRaster

/**
 * Paper (`paint-editor/paper.ts`): a generated grain height map that tiles across the canvas, a
 * paper colour, grain depth, and the properties wet media read (absorption, permeability,
 * roughness). Everything is generated from a pattern and a seed, so a paper is a few numbers in
 * the document, never a bitmap.
 */

public let PAPER_FAMILIES = ["watercolor", "drawing", "pastel", "canvas", "panel", "smooth"]

public struct PaperSettings: Equatable, Sendable, PaperGrainSettings {
    /// The library preset this paper started from (`custom` when it matches none).
    public var preset: String
    public var name: String
    public var family: String
    public var pattern: String
    /// Grain seed: another seed gives another sheet of the same paper.
    public var seed: Int
    /// Paper colour #rrggbb.
    public var color: String
    /// Grain scale: 1 is the pattern's natural size (0.25..8).
    public var scale: Double
    /// `repeat` or `mirror`.
    public var tiling: String
    /// Grain depth 0..1.
    public var depth: Double
    /// How much the grain shades the paper colour, 0..1.
    public var shading: Double
    public var dry: GrainTuning
    public var wet: GrainTuning
    public var absorption: Double
    public var permeability: Double
    public var roughness: Double
    public var metallic: Double?
    public var backlight: Double?
    public var backlightColor: String?
    /// Where the grain's (0, 0) sits in document pixels (missing = the top-left).
    public var offset: LayerOffset?

    /// The paper as JSON, in the TS key order.
    public var json: JSONObject {
        var o: JSONObject = [
            "preset": .string(preset), "name": .string(name), "family": .string(family), "pattern": .string(pattern), "seed": .number(Double(seed)),
            "color": .string(color), "scale": .number(scale), "tiling": .string(tiling), "depth": .number(depth), "shading": .number(shading),
            "dry": dry.json, "wet": wet.json, "absorption": .number(absorption), "permeability": .number(permeability), "roughness": .number(roughness),
        ]
        if let metallic { o["metallic"] = .number(metallic) }
        if let backlight { o["backlight"] = .number(backlight) }
        if let backlightColor { o["backlightColor"] = .string(backlightColor) }
        if let offset { o["offset"] = pointJSON(Double(offset.x), Double(offset.y)) }
        return o
    }
}

private func preset(_ id: String, _ name: String, _ family: String, _ pattern: String, _ color: String, depth: Double, absorption: Double, permeability: Double, roughness: Double, scale: Double = 1, seed: Int = 1, shading: Double = 0.5, contrast: Double = 1, backlight: Double? = nil, backlightColor: String? = nil) -> PaperSettings {
    PaperSettings(
        preset: id, name: name, family: family, pattern: pattern, seed: seed, color: color, scale: scale, tiling: "mirror", depth: depth, shading: shading,
        dry: GrainTuning(contrast: contrast), wet: GrainTuning(contrast: 1), absorption: absorption, permeability: permeability, roughness: roughness,
        metallic: nil, backlight: backlight, backlightColor: backlight != nil ? (backlightColor ?? "#fff1d6") : nil, offset: nil
    )
}

/// The built-in paper library: generated papers in families.
public let PAPER_LIBRARY: [PaperSettings] = [
    preset("cold-pressed", "Cold pressed watercolour", "watercolor", "cold-pressed", "#f7f3ea", depth: 0.5, absorption: 0.7, permeability: 0.5, roughness: 0.6),
    preset("hot-pressed", "Hot pressed watercolour", "watercolor", "hot-pressed", "#f8f6ef", depth: 0.25, absorption: 0.55, permeability: 0.4, roughness: 0.25),
    preset("rough-watercolor", "Rough watercolour", "watercolor", "rough", "#f5f0e4", depth: 0.75, absorption: 0.8, permeability: 0.6, roughness: 0.85),
    preset("cartridge", "Cartridge", "drawing", "vellum", "#fbfaf6", depth: 0.3, absorption: 0.4, permeability: 0.3, roughness: 0.35),
    preset("laid", "Laid paper", "drawing", "laid", "#f3ecdc", depth: 0.45, absorption: 0.45, permeability: 0.35, roughness: 0.45),
    preset("ingres", "Charcoal paper", "drawing", "ingres", "#ede6d6", depth: 0.6, absorption: 0.4, permeability: 0.3, roughness: 0.65),
    preset("sanded-pastel", "Sanded pastel paper", "pastel", "sanded", "#d8cfc0", depth: 0.7, absorption: 0.3, permeability: 0.2, roughness: 0.9, shading: 0.35),
    preset("pastel-card", "Grey pastel card", "pastel", "sanded", "#9c978e", depth: 0.55, absorption: 0.3, permeability: 0.2, roughness: 0.75, scale: 1.5, shading: 0.3),
    preset("cotton-canvas", "Cotton canvas", "canvas", "canvas", "#efe9dc", depth: 0.55, absorption: 0.35, permeability: 0.25, roughness: 0.6),
    preset("fine-linen", "Fine linen", "canvas", "linen", "#e9e2d2", depth: 0.45, absorption: 0.3, permeability: 0.25, roughness: 0.5),
    preset("gesso", "Gesso panel", "panel", "gesso", "#f6f4ef", depth: 0.35, absorption: 0.2, permeability: 0.15, roughness: 0.4),
    preset("smooth", "Smooth bristol", "smooth", "smooth", "#ffffff", depth: 0, absorption: 0.3, permeability: 0.2, roughness: 0.05, shading: 0),
    // Backlit: smooth paper on a lightbox, for glazes that glow like stained glass.
    preset("stained-glass", "Stained glass (backlit)", "smooth", "smooth", "#ffffff", depth: 0, absorption: 0.35, permeability: 0.25, roughness: 0.05, shading: 0, backlight: 0.8, backlightColor: "#fff1d6"),
]

public let DEFAULT_PAPER = PAPER_LIBRARY[0]

/// A paper from the library by id, or nil.
public func paperPreset(_ id: String) -> PaperSettings? {
    PAPER_LIBRARY.first { $0.preset == id }
}

private func readTuning(_ raw: JSONValue?, _ d: GrainTuning) -> GrainTuning {
    let r = raw?.objectValue ?? [:]
    return GrainTuning(contrast: rangeValue(r["contrast"], 0, 3, d.contrast), invert: boolValue(r["invert"], d.invert))
}

func isHexColor(_ s: String) -> Bool { s.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil }

/**
 * A paper with every field in range. Missing fields come from `base` (default: the library preset
 * named by `raw.preset`, else cold pressed).
 */
public func normalizePaper(_ r: JSONObject, _ base: PaperSettings? = nil) -> PaperSettings {
    let b = base ?? r["preset"]?.stringValue.flatMap(paperPreset) ?? DEFAULT_PAPER
    let metallic = unitValue(r["metallic"], b.metallic ?? 0)
    let backlight = unitValue(r["backlight"], b.backlight ?? 0)
    var backlightColor: String? = nil
    if let c = r["backlightColor"]?.stringValue, isHexColor(c) { backlightColor = c.lowercased() } else if let c = b.backlightColor { backlightColor = c }
    // The grain origin: rounded, kept only when it is not (0, 0).
    let o = r["offset"]?.objectValue
    let ox = o?["x"]?.finite.map { Int(JS.round($0)) } ?? b.offset?.x ?? 0
    let oy = o?["y"]?.finite.map { Int(JS.round($0)) } ?? b.offset?.y ?? 0
    let name: String = r["name"]?.stringValue.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 } ?? b.name
    return PaperSettings(
        preset: r["preset"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? b.preset,
        name: name,
        family: r["family"]?.stringValue.flatMap { PAPER_FAMILIES.contains($0) ? $0 : nil } ?? b.family,
        pattern: r["pattern"]?.stringValue.flatMap { GRAIN_PATTERNS.contains($0) ? $0 : nil } ?? b.pattern,
        seed: r["seed"]?.finite.map { Int(JS.round(abs($0)).truncatingRemainder(dividingBy: 2147483647)) } ?? b.seed,
        color: r["color"]?.stringValue.flatMap { isHexColor($0) ? $0.lowercased() : nil } ?? b.color,
        scale: rangeValue(r["scale"], 0.25, 8, b.scale),
        tiling: r["tiling"]?.stringValue.flatMap { $0 == "repeat" || $0 == "mirror" ? $0 : nil } ?? b.tiling,
        depth: unitValue(r["depth"], b.depth),
        shading: unitValue(r["shading"], b.shading),
        dry: readTuning(r["dry"], b.dry),
        wet: readTuning(r["wet"], b.wet),
        absorption: unitValue(r["absorption"], b.absorption),
        permeability: unitValue(r["permeability"], b.permeability),
        roughness: unitValue(r["roughness"], b.roughness),
        metallic: metallic > 0 ? metallic : nil,
        backlight: backlight > 0 ? backlight : nil,
        backlightColor: backlightColor,
        offset: ox != 0 || oy != 0 ? LayerOffset(x: ox, y: oy) : nil
    )
}

/// `#rrggbb` → [r, g, b] 0..255.
public func hexToRgb8(_ hex: String) -> [Int] {
    let n = Int(hex.dropFirst().prefix(6), radix: 16) ?? 0
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * The paper as opaque RGBA over `rect` (document pixels): its colour, darkened in the valleys by
 * `shading`.
 */
public func renderPaper(_ paper: PaperSettings, _ rect: RasterRect, _ grain: PaperGrain, light: (azimuth: Double, elevation: Double)? = nil) -> [UInt8] {
    let c = hexToRgb8(paper.color)
    let r = Double(c[0]), g = Double(c[1]), b = Double(c[2])
    var out = [UInt8](repeating: 0, count: rect.width * rect.height * 4)
    let shade = grain.flat ? 0 : paper.shading * 0.16
    let metal = light != nil ? (paper.metallic ?? 0) : 0
    var hx = 0.0, hy = 0.0, hz = 1.0
    if metal > 0, let light {
        let az = (light.azimuth * Double.pi) / 180
        let el = (light.elevation * Double.pi) / 180
        let lx = JS.cos(el) * JS.sin(az)
        let ly = -JS.cos(el) * JS.cos(az)
        let lz = JS.sin(el) + 1
        let n = JS.hypot(lx, ly, lz)
        hx = lx / n
        hy = ly / n
        hz = lz / n
    }
    for y in 0..<rect.height {
        for x in 0..<rect.width {
            let i = (y * rect.width + x) * 4
            let px = Double(rect.x + x) + 0.5
            let py = Double(rect.y + y) + 0.5
            let k = shade != 0 ? 1 - shade * (1 - grain.at(px, py)) : 1
            var spec = 0.0
            if metal > 0 {
                let gx = (grain.at(px + 1, py) - grain.at(px - 1, py)) * 4
                let gy = (grain.at(px, py + 1) - grain.at(px, py - 1)) * 4
                let nl = JS.hypot(gx, gy, 1)
                let nh = Swift.max(0, (-gx * hx - gy * hy + hz) / nl)
                spec = metal * JS.pow(nh, 24) * 0.9
            }
            out[i] = JS.u8c(Swift.min(255, r * k * (1 - 0.25 * metal) + spec * (r * 0.6 + 102)))
            out[i + 1] = JS.u8c(Swift.min(255, g * k * (1 - 0.25 * metal) + spec * (g * 0.6 + 102)))
            out[i + 2] = JS.u8c(Swift.min(255, b * k * (1 - 0.25 * metal) + spec * (b * 0.6 + 102)))
            out[i + 3] = 255
        }
    }
    return out
}

private let grainCache = Locked(OrderedMap<String, PaperGrain>())

/// The paper's dry height field, built once per settings.
public func paperGrain(_ paper: PaperSettings) -> PaperGrain {
    let key = JSONValue.array([.string(paper.pattern), .number(Double(paper.seed)), .number(paper.scale), .string(paper.tiling), paper.dry.json, paper.offset.map { pointJSON(Double($0.x), Double($0.y)) } ?? .null]).stringified()
    if let g = grainCache.with({ $0.get(key) }) { return g }
    let g = PaperGrain(paper, media: "dry")
    grainCache.with { cache in
        if cache.count > 16, let first = cache.first { _ = cache.delete(first.key) }
        cache.set(key, g)
    }
    return g
}
