import Foundation
import PixerateCore
import PixerateRaster

/**
 * Colour harmonies on the RGB and painter's RYB colour wheels (`color/harmony.ts`, through
 * `paint-editor/color.ts`) and the pigment mixing tool (`paint/pigment-tools.ts`).
 */

public let HARMONY_KINDS = ["complementary", "split-complementary", "analogous", "triadic", "tetradic", "square", "monochromatic"]

private func jsMod(_ v: Double, _ m: Double) -> Double { v.truncatingRemainder(dividingBy: m) }

private func rgbToHsv(_ r: Double, _ g: Double, _ b: Double) -> (h: Double, s: Double, v: Double) {
    let mx = Swift.max(r, g, b), mn = Swift.min(r, g, b)
    let d = mx - mn
    var h = 0.0
    if d > 0 {
        if mx == r { h = 60 * jsMod((g - b) / d, 6) } else if mx == g { h = 60 * ((b - r) / d + 2) } else { h = 60 * ((r - g) / d + 4) }
    }
    if h < 0 { h += 360 }
    return (h, mx == 0 ? 0 : d / mx, mx)
}

private func hueToRgb(_ h: Double, _ c: Double, _ m: Double) -> [Double] {
    let hh = jsMod(jsMod(h, 360) + 360, 360) / 60
    let x = c * (1 - abs(jsMod(hh, 2) - 1))
    let rgb: [Double] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]
    return rgb.map { $0 + m }
}

private func hsvToRgb(_ h: Double, _ s: Double, _ v: Double) -> [Double] {
    let c = v * s
    return hueToRgb(h, c, v - c)
}

private func rgbToHsl(_ r: Double, _ g: Double, _ b: Double) -> (h: Double, s: Double, l: Double) {
    let mx = Swift.max(r, g, b), mn = Swift.min(r, g, b)
    let d = mx - mn
    let l = (mx + mn) / 2
    var h = 0.0
    if d > 0 {
        if mx == r { h = 60 * jsMod((g - b) / d, 6) } else if mx == g { h = 60 * ((b - r) / d + 2) } else { h = 60 * ((r - g) / d + 4) }
    }
    if h < 0 { h += 360 }
    return (h, d == 0 ? 0 : d / (1 - abs(2 * l - 1)), l)
}

private func hslToRgb(_ h: Double, _ s: Double, _ l: Double) -> [Double] {
    let c = (1 - abs(2 * l - 1)) * s
    return hueToRgb(h, c, l - c / 2)
}

private func toHex(_ c: [Double]) -> String {
    "#" + c.prefix(3).map { String(Int(JS.round(Swift.min(1, Swift.max(0, $0)) * 255)), radix: 16).leftPad(2) }.joined()
}

// RYB wheel angle → RGB hue (a piecewise-linear map through red, orange, yellow, green, blue, violet).
private let RYB_STOPS: [(Double, Double)] = [(0, 0), (60, 30), (120, 60), (180, 120), (240, 240), (300, 280), (360, 360)]

private func piecewise(_ v: Double, _ from: Int) -> Double {
    let x = jsMod(jsMod(v, 360) + 360, 360)
    func at(_ p: (Double, Double), _ k: Int) -> Double { k == 0 ? p.0 : p.1 }
    let to = from == 0 ? 1 : 0
    for i in 1..<RYB_STOPS.count {
        let a = RYB_STOPS[i - 1], b = RYB_STOPS[i]
        if x <= at(b, from) { return at(a, to) + ((x - at(a, from)) / (at(b, from) - at(a, from))) * (at(b, to) - at(a, to)) }
    }
    return x
}

func wheelToHue(_ angle: Double, _ wheel: String) -> Double { wheel == "rgb" ? jsMod(jsMod(angle, 360) + 360, 360) : piecewise(angle, 0) }
func hueToWheel(_ hue: Double, _ wheel: String) -> Double { wheel == "rgb" ? jsMod(jsMod(hue, 360) + 360, 360) : piecewise(hue, 1) }

/// Harmony colours around a base #rrggbb colour, the base first: `{ color, angle }`.
public func colorHarmony(_ base: String, _ kind: String, wheel: String = "ryb", spread: Double = 30) throws -> [JSONValue] {
    guard let m = base.trimmingCharacters(in: .whitespacesAndNewlines).range(of: "^#?[0-9a-fA-F]{6}$", options: .regularExpression) else { throw PaintEditorError("base is \(JSONValue.string(base).stringified()); use #rrggbb, e.g. \"#2a4b8d\".") }
    let hex = base.trimmingCharacters(in: .whitespacesAndNewlines)[m].replacingOccurrences(of: "#", with: "")
    let n = Int(hex, radix: 16)!
    let rgb = [Double((n >> 16) & 255) / 255, Double((n >> 8) & 255) / 255, Double(n & 255) / 255]
    let hsv = rgbToHsv(rgb[0], rgb[1], rgb[2])
    let start = hueToWheel(hsv.h, wheel)
    func item(_ c: [Double], _ angle: Double) -> JSONValue { ["color": .string(toHex(c)), "angle": .number(JS.round(angle * 10) / 10)] }
    if kind == "monochromatic" {
        let hsl = rgbToHsl(rgb[0], rgb[1], rgb[2])
        return [0, -0.3, -0.15, 0.15, 0.3].map { d in item(d == 0 ? rgb : hslToRgb(hsl.h, hsl.s, Swift.min(0.97, Swift.max(0.03, hsl.l + d))), start) }
    }
    let offsets: [String: [Double]] = [
        "complementary": [0, 180], "split-complementary": [0, 180 - spread, 180 + spread], "analogous": [0, -spread, spread],
        "triadic": [0, 120, 240], "tetradic": [0, 60, 180, 240], "square": [0, 90, 180, 270],
    ]
    return (offsets[kind] ?? [0]).enumerated().map { i, o in
        if i == 0 { return item(rgb, start) }
        let a = jsMod(jsMod(start + o, 360) + 360, 360)
        return item(hsvToRgb(wheelToHue(a, wheel), hsv.s, hsv.v), a)
    }
}

/// `mix_colors`: paints mixed in given amounts, as pigment (Kubelka-Munk) or as light.
func mixColors(_ items: [JSONObject], model: String?) throws -> JSONObject {
    let rgbs = try items.enumerated().map { i, item -> [Double] in
        let s = item["color"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard s.range(of: "^#?[0-9a-fA-F]{6}$", options: .regularExpression) != nil, let n = Int(s.replacingOccurrences(of: "#", with: ""), radix: 16) else {
            throw PaintEditorError("colors[\(i)].color is \(item["color"].map { $0.stringified() } ?? "undefined"); use #rrggbb, e.g. \"#1e40af\".")
        }
        return [Double((n >> 16) & 255) / 255, Double((n >> 8) & 255) / 255, Double(n & 255) / 255]
    }
    let weights = items.map { $0["weight"]?.numberValue ?? 0 }
    let total = weights.reduce(0, +)
    if !(total > 0) { throw PaintEditorError("Every weight is 0; give at least one colour a weight above 0.") }
    let pigments = rgbs.enumerated().map { i, c in PigmentColor.pigment(createPigment(c, PigmentOptions(strength: items[i]["strength"]?.numberValue))) }
    let mixed = try mixPigments(pigments, weights)
    let lerp = (0..<3).map { c in rgbs.enumerated().reduce(0.0) { $0 + $1.element[c] * weights[$1.offset] } / total }
    let rgb = model == "rgb"
    return ["mixed": .string(toHex(rgb ? lerp : mixed)), "rgbLerp": .string(toHex(lerp)), "pigment": .string(toHex(mixed)), "weights": .array(weights.map { .number($0 / total) }), "model": .string(rgb ? "rgb" : "kubelka-munk")]
}

/// The handlers of the colour tools (`color_harmony`, `mix_colors`) and the view tools.
func paintColorHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["color_harmony"] = { a in
        let kind = a["kind"]?.stringValue ?? ""
        let wheel = a["wheel"]?.stringValue
        let base = try a["color"].map { try parseColor($0) } ?? c.color
        return ["kind": .string(kind), "wheel": .string(wheel ?? "ryb"), "colors": .array(try colorHarmony(base, kind, wheel: wheel ?? "ryb", spread: a["spread"]?.numberValue ?? 30))]
    }
    h["mix_colors"] = { a in .object(try mixColors((a["colors"]?.arrayValue ?? []).compactMap(\.objectValue), model: a["model"]?.stringValue)) }
    h["set_view"] = { a in
        if a["reset"] == .bool(true) { _ = c.resetView() }
        let pan = a["pan"]?.objectValue.flatMap { p -> (Double, Double)? in
            guard let x = p["x"]?.finite, let y = p["y"]?.finite else { return nil }
            return (x, y)
        }
        return c.setView(zoom: a["zoom"]?.numberValue, rotation: a["rotation"]?.numberValue, mirror: a["mirror"]?.boolValue, pan: pan).json
    }
    return h
}

/// `export_image` (PNG) as tools return it.
func paintExportHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["export_image"] = { a in
        let format = a["format"]?.stringValue ?? "image/png"
        if format != "image/png" {
            if format != "image/jpeg" && format != "image/webp" { throw PaintEditorError("format \(JSONValue.string(format).stringified()) is not supported; use image/png, image/jpeg or image/webp.") }
            throw PaintEditorError("\(format) needs a canvas to encode and there is none here; pass encodeImage to the controller, or export PNG.")
        }
        if a["time"] != nil { throw UnportedBrushError(message: "Exporting live effect paint at a moment is not ported to Swift yet.") }
        let bytes = try c.exportPng(scale: a["scale"]?.numberValue, paper: a["paper"]?.boolValue)
        return ["mimeType": .string(format), "bytes": .number(Double(bytes.count)), "data": .string(bytesToBase64(bytes))]
    }
    return h
}
