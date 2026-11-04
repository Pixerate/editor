import Foundation
import PixerateCore
import PixerateRaster

/**
 * Effect paint (`paint-editor/effect-paint.ts`): brushes that paint with a provider effect instead
 * of a colour. The effect is rendered once, at the canvas size (or as a strip along each stroke),
 * and each pixel a mark covers takes its colour (and alpha) from it.
 */

/// How effect paint lies along a stroke (`PaintEffectStrokeMap`).
public struct PaintEffectStrokeMap: Equatable, Sendable {
    /// px of stroke per repeat of the effect, 16..4096.
    public var length: Int
    /// `repeat`, `mirror` or `clamp`.
    public var repeatMode: String
    public var json: JSONValue { ["by": "stroke", "length": .number(Double(length)), "repeat": .string(repeatMode)] }
}

public let EFFECT_STRIP_HEIGHT = 256
public let EFFECT_MAP_REPEATS = ["repeat", "mirror", "clamp"]

/// A provider effect brushes paint with (`PaintEffectPaint`).
public struct PaintEffectPaint: Equatable, Sendable {
    public var effect: String
    public var provider: String
    /// Every control value.
    public var values: JSONObject
    /// Which moment of an animated effect, in ms.
    public var time: Double
    public var map: PaintEffectStrokeMap?
    /// Live: on a stroke layer the stroke keeps playing the effect.
    public var live: Bool

    public init(effect: String, provider: String, values: JSONObject, time: Double, map: PaintEffectStrokeMap? = nil, live: Bool = false) {
        self.effect = effect
        self.provider = provider
        self.values = values
        self.time = time
        self.map = map
        self.live = live
    }

    public var json: JSONValue {
        var o: JSONObject = ["type": "effect", "effect": .string(effect), "provider": .string(provider), "values": .object(values), "time": .number(time)]
        if let map { o["map"] = map.json }
        if live { o["live"] = true }
        return .object(o)
    }

    /// The cache key of its pixels (`effectPaintKey`: `live` does not change them).
    public var key: String {
        var o: JSONObject = ["type": "effect", "effect": .string(effect), "provider": .string(provider), "values": .object(values), "time": .number(time)]
        if let map { o["map"] = map.json }
        return JSONValue.object(o).stringified()
    }

    /// The size its pixels are rendered at (`effectPaintSize`).
    func size(_ canvas: PaintCanvas) -> (width: Int, height: Int) { map.map { ($0.length, EFFECT_STRIP_HEIGHT) } ?? (canvas.width, canvas.height) }
}

/// Reads a `map` argument (`readEffectStrokeMap`); throws saying what is wrong.
func readEffectStrokeMap(_ raw: JSONValue?) throws -> PaintEffectStrokeMap? {
    guard let raw, raw != .null else { return nil }
    let r = raw.objectValue ?? [:]
    if r["by"] == .string("canvas") { return nil }
    if r["by"] != .string("stroke") { throw PaintEditorError("map.by \((r["by"] ?? .null).stringified()) is not a mapping; use \"canvas\" (fixed to the canvas) or \"stroke\" (along each stroke).") }
    let length = r["length"] == nil ? 300 : (r["length"]?.numberValue ?? .nan)
    if !(length.isFinite && length >= 16 && length <= 4096) { throw PaintEditorError("map.length \((r["length"] ?? .null).stringified()) is out of range; use 16..4096 px of stroke per repeat.") }
    let rep = r["repeat"] ?? .string("repeat")
    guard let s = rep.stringValue, EFFECT_MAP_REPEATS.contains(s) else { throw PaintEditorError("map.repeat \(rep.stringified()) is not a repeat mode; use \(EFFECT_MAP_REPEATS.joined(separator: ", ")).") }
    return PaintEffectStrokeMap(length: Int(JS.round(length)), repeatMode: s)
}

/// Whether a paint value is effect paint (`type: "effect"`).
func isPaintEffectPaint(_ raw: JSONValue?) -> Bool { raw?.objectValue?["type"] == .string("effect") }

/// A saved effect paint, or nil (`readPaintEffectPaint`).
func readPaintEffectPaint(_ raw: JSONValue?) -> PaintEffectPaint? {
    guard isPaintEffectPaint(raw), let r = raw?.objectValue, let effect = r["effect"]?.stringValue, !effect.isEmpty, let values = r["values"]?.objectValue else { return nil }
    let t = r["time"]?.numberValue ?? 0
    return PaintEffectPaint(effect: effect, provider: r["provider"]?.stringValue ?? "", values: values, time: t.isFinite && t > 0 ? t : 0, map: (try? readEffectStrokeMap(r["map"])) ?? nil, live: r["live"] == .bool(true))
}

/// Rendered effect paint (`EffectPaintPixels`).
public struct EffectPaintPixels: Sendable {
    public var width: Int
    public var height: Int
    public var data: [UInt8]
    public var map: PaintEffectStrokeMap?
}

/// Where a dab is, for stroke-mapped effects (`EffectDabPlace`).
struct EffectDabPlace {
    var x: Double, y: Double, direction: Double, radius: Double, travel: Double
    init(_ d: PenDab) {
        x = d.dab.x; y = d.dab.y; direction = d.direction; radius = d.dab.radius; travel = d.travel
    }
}

private func stripIndex(_ img: EffectPaintPixels, _ map: PaintEffectStrokeMap, _ dab: EffectDabPlace, _ x: Double, _ y: Double) -> Int {
    let ca = JS.cos(dab.direction), sa = JS.sin(dab.direction)
    let dx = x - dab.x, dy = y - dab.y
    var u = (dab.travel + dx * ca - dy * sa) / Double(map.length)
    if map.repeatMode == "clamp" { u = Swift.min(1, Swift.max(0, u)) } else if map.repeatMode == "mirror" {
        let m = (u.truncatingRemainder(dividingBy: 2) + 2).truncatingRemainder(dividingBy: 2)
        u = m > 1 ? 2 - m : m
    } else { u = (u.truncatingRemainder(dividingBy: 1) + 1).truncatingRemainder(dividingBy: 1) }
    let v = Swift.min(1, Swift.max(0, ((dx * sa + dy * ca) / Swift.max(0.5, dab.radius) + 1) / 2))
    let px = Swift.min(img.width - 1, Int(JS.floor(u * Double(img.width))))
    let py = Swift.min(img.height - 1, Int(JS.floor(v * Double(img.height))))
    return (py * img.width + px) * 4
}

/// Each covered pixel's colour from the effect (3 per pixel into `field`), its alpha into the coverage (`sampleEffectField`).
func sampleEffectField(_ img: EffectPaintPixels, _ rect: RasterRect, _ vals: inout [Float], _ field: inout [Float], _ dab: EffectDabPlace?) {
    let data = img.data
    if let map = img.map, let dab {
        var k = 0
        for yy in 0..<rect.height {
            for xx in 0..<rect.width {
                let i = stripIndex(img, map, dab, Double(rect.x + xx) + 0.5, Double(rect.y + yy) + 0.5)
                let f = k * 3
                let a = data[i + 3]
                if a < 255 { vals[k] = Float(Double(vals[k]) * (Double(a) / 255)) }
                field[f] = Float(Double(data[i]) / 255)
                field[f + 1] = Float(Double(data[i + 1]) / 255)
                field[f + 2] = Float(Double(data[i + 2]) / 255)
                k += 1
            }
        }
        return
    }
    var k = 0
    for yy in 0..<rect.height {
        let y = rect.y + yy
        let inY = y >= 0 && y < img.height
        for xx in 0..<rect.width {
            let x = rect.x + xx
            let f = k * 3
            if !inY || x < 0 || x >= img.width {
                vals[k] = 0
                field[f] = 0; field[f + 1] = 0; field[f + 2] = 0
                k += 1
                continue
            }
            let i = (y * img.width + x) * 4
            let a = data[i + 3]
            if a < 255 { vals[k] = Float(Double(vals[k]) * (Double(a) / 255)) }
            field[f] = Float(Double(data[i]) / 255)
            field[f + 1] = Float(Double(data[i + 1]) / 255)
            field[f + 2] = Float(Double(data[i + 2]) / 255)
            k += 1
        }
    }
}

/// The effect's colour (0..1) at one point and its alpha (`sampleEffectAt`).
func sampleEffectAt(_ img: EffectPaintPixels, _ x: Double, _ y: Double, _ dab: EffectDabPlace?) -> (rgb: [Double], alpha: Double) {
    if let map = img.map, let dab {
        let i = stripIndex(img, map, dab, x, y)
        return ([Double(img.data[i]) / 255, Double(img.data[i + 1]) / 255, Double(img.data[i + 2]) / 255], Double(img.data[i + 3]) / 255)
    }
    let px = Int(JS.floor(x)), py = Int(JS.floor(y))
    if px < 0 || py < 0 || px >= img.width || py >= img.height { return ([0, 0, 0], 0) }
    let i = (py * img.width + px) * 4
    return ([Double(img.data[i]) / 255, Double(img.data[i + 1]) / 255, Double(img.data[i + 2]) / 255], Double(img.data[i + 3]) / 255)
}

/// The pixels with every colour `grey` and their alpha kept (`greyPixels`: the light twin's effect paint).
func greyPixels(_ img: EffectPaintPixels, _ grey: Int) -> EffectPaintPixels {
    var out = img
    let g = UInt8(grey)
    for i in stride(from: 0, to: out.data.count, by: 4) { out.data[i] = g; out.data[i + 1] = g; out.data[i + 2] = g }
    return out
}
