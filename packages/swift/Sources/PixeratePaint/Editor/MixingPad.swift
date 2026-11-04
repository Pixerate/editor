import Foundation
import PixerateCore
import PixerateRaster

/**
 * The mixing pad (`paint-editor/mixing-pad.ts`): a small canvas beside the painting to put paint
 * on, smear it with a palette knife and pick the mixed colour from. Paint is laid with the Mixer
 * Brush in pigment mode and the knife smears it with pigment mixing. It is scratch space: not part
 * of the painting's undo history, but saved with the document.
 */

public let MIXING_PAD_WIDTH = 360
public let MIXING_PAD_HEIGHT = 220

private let PAD_PAINT = normalizePaintBrush([
    "id": "pad-paint", "name": "Pad paint", "category": "mixer", "engine": "mixer",
    "tip": ["size": 28, "hardness": 0.75, "spacing": 0.1, "opacity": 1, "flow": 0.7, "pressureSize": false, "pressureOpacity": false],
    "mixer": ["wet": 0.45, "load": 1, "mix": 0.4, "loadEachStroke": true, "cleanEachStroke": true, "mixing": "pigment"],
])

private let PAD_KNIFE = normalizePaintBrush([
    "id": "pad-knife", "name": "Palette knife", "category": "smudge", "engine": "smudge", "loadsColor": false,
    "tip": ["size": 34, "hardness": 0.9, "spacing": 0.08, "roundness": 0.35, "angle": 90, "opacity": 1, "flow": 1, "pressureSize": false, "pressureOpacity": false],
    // A knife drags streaks of paint and folds them into each other, mixing them as pigment.
    "smudge": ["strength": 0.6, "length": 0.8, "mixing": "pigment"],
])

/// A solid round blob of paint (one dab).
private let PAD_BLOB = normalizePaintBrush([
    "id": "pad-blob", "name": "Pad blob", "category": "custom", "engine": "dab",
    "tip": ["size": 20, "hardness": 1, "spacing": 0.1, "opacity": 1, "flow": 1, "pressureSize": false, "pressureOpacity": false],
])

private func withTip(_ b: PaintBrush, _ changes: JSONObject) -> PaintBrush {
    normalizePaintBrush(["tip": .object(b.tip.json.objectValue!.merging(changes))], b)
}

public final class MixingPad {
    public let width = MIXING_PAD_WIDTH
    public let height = MIXING_PAD_HEIGHT
    private var surface = emptySurface(4)
    /// Increments on every change (for redrawing).
    public private(set) var version = 0

    /// Paints (`paint`, with `color`) or smears (`knife`) through `points` in pad pixels.
    func stroke(_ points: [PenPoint], tool: String, color: String, size: Double?) throws -> RasterRect? {
        if points.isEmpty { throw PaintEditorError("points is empty; give at least one {x, y} in pad pixels.") }
        for (i, p) in points.enumerated() where !p.x.isFinite || !p.y.isFinite || p.x < 0 || p.y < 0 || p.x > Double(width) || p.y > Double(height) {
            throw PaintEditorError("points[\(i)] (\(jsText(p.x)), \(jsText(p.y))) is off the \(width)×\(height) mixing pad.")
        }
        var brush = tool == "knife" ? PAD_KNIFE : PAD_PAINT
        if let size { brush = withTip(brush, ["size": .number(size)]) }
        return try run(brush, points, color)
    }

    /// Paints `points` with `brush` in `color` on the pad.
    private func run(_ brush: PaintBrush, _ points: [PenPoint], _ color: String) throws -> RasterRect? {
        let rgb = hexToRgb8(color)
        let session = try PaintStrokeSession(StrokeSessionInit(
            layerId: "mixing-pad", surface: surface, offset: LayerOffset(x: 0, y: 0), lockTransparency: false, brush: brush,
            color: rgb + [255], background: [255, 255, 255, 255], grain: nil, paperDepth: 0, seed: 1, colorHex: color,
            affineCopies: [], copies: [IDENTITY_COPY],
            mixerLoad: brushLoadForStroke(brush, EMPTY_MIXER_LOAD, rgb.map { Double($0) / 255 }), secondary: nil, selection: nil, paint: nil
        ))
        try session.push(points)
        let res = try session.end()
        if let s = session.surfaceAfter {
            surface = s
            version += 1
        }
        return res.bounds
    }

    /// The average colour within `radius` pixels of (x, y), or nil where the pad is bare.
    func pick(_ x: Double, _ y: Double, _ radius: Double = 3) throws -> String? {
        if !(x >= 0 && y >= 0 && x < Double(width) && y < Double(height)) { throw PaintEditorError("(\(jsText(x)), \(jsText(y))) is off the \(width)×\(height) mixing pad.") }
        let r = Swift.max(0, Int(JS.round(radius)))
        let fx = Int(JS.floor(x)), fy = Int(JS.floor(y))
        let x0 = Swift.max(0, fx - r), y0 = Swift.max(0, fy - r)
        let x1 = Swift.min(width, fx + r + 1), y1 = Swift.min(height, fy + r + 1)
        let px = readRegion(surface, RasterRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0))
        var R = 0.0, G = 0.0, B = 0.0, A = 0.0
        var i = 0
        while i < px.count {
            let a = Double(px[i + 3])
            R += Double(px[i]) * a
            G += Double(px[i + 1]) * a
            B += Double(px[i + 2]) * a
            A += a
            i += 4
        }
        if A == 0 { return nil }
        let hex = { (v: Double) in String(Int(JS.round(v / A)), radix: 16).leftPad(2) }
        return "#\(hex(R))\(hex(G))\(hex(B))"
    }

    func clear() {
        surface = emptySurface(4)
        version += 1
    }

    /**
     * Mixes paints the way a painter does on a palette: blobs whose areas are in proportion to
     * their parts, spiral knife passes that fold them together, and a soft-edged core of the
     * Kubelka-Munk mix. Returns that colour (picked back from the centre) and the pile's bounds.
     */
    func mix(_ paints: [(color: String, parts: Double)], x: Double?, y: Double?, radius: Double?, passes passesIn: Int?, clear: Bool?) throws -> (color: String?, bounds: RasterRect) {
        if paints.isEmpty || paints.count > 8 { throw PaintEditorError("Give 1 to 8 paints to mix; got \(paints.count).") }
        let total = paints.reduce(0) { $0 + $1.parts }
        for (i, p) in paints.enumerated() where !(p.parts.isFinite && p.parts >= 0) { throw PaintEditorError("paints[\(i)].parts is \(jsText(p.parts)); use a number ≥ 0.") }
        if !(total > 0) { throw PaintEditorError("Every paint has 0 parts; give at least one paint parts above 0.") }
        let R = radius ?? 40
        if !(R >= 12 && R <= 100) { throw PaintEditorError("radius \(jsText(R)) is out of range; use 12..100 pad px.") }
        let passes = passesIn ?? 3
        if !(passes >= 1 && passes <= 20) { throw PaintEditorError("passes \(passes) is out of range; use a whole number 1..20.") }
        let cx = x ?? Double(width) / 2
        let cy = y ?? Double(height) / 2
        if !(cx - R >= 0 && cy - R >= 0 && cx + R <= Double(width) && cy + R <= Double(height)) {
            throw PaintEditorError("A pile of radius \(jsText(R)) at (\(jsText(cx)), \(jsText(cy))) does not fit on the \(width)×\(height) pad; move it at least \(jsText(R)) px from every edge or use a smaller radius.")
        }
        let bounds = RasterRect(x: Int(JS.floor(cx - R)), y: Int(JS.floor(cy - R)), width: Int(JS.ceil(2 * R)), height: Int(JS.ceil(2 * R)))
        if clear != false { surface = writeRegion(surface, bounds, [UInt8](repeating: 0, count: bounds.width * bounds.height * 4)) }
        // Blobs: equal-area share of a disc of radius 0.7·R per part, placed around the centre.
        let used = paints.filter { $0.parts > 0 }
        let area = Double.pi * JS.pow(0.7 * R, 2)
        for (i, p) in used.enumerated() {
            let r = ((area * (p.parts / total)) / Double.pi).squareRoot()
            let a = (Double(i) / Double(used.count)) * Double.pi * 2
            let off = used.count == 1 ? 0 : 0.45 * R
            let bx = Swift.min(cx + R - r, Swift.max(cx - R + r, cx + JS.cos(a) * off))
            let by = Swift.min(cy + R - r, Swift.max(cy - R + r, cy + JS.sin(a) * off))
            let blob = withTip(PAD_BLOB, ["size": .number(Swift.max(2, 2 * r))])
            _ = try run(blob, [PenPoint(x: bx, y: by)], p.color.lowercased())
        }
        // Knife passes: spiral stirs through the pile, each turned a little, folding the blobs together.
        let knife = withTip(PAD_KNIFE, ["size": .number(Swift.max(12, R * 0.5))])
        for k in 0..<passes {
            var stir: [PenPoint] = []
            let turns = 1.6
            for t in 0...48 {
                let a = (Double(t) / 48) * Double.pi * 2 * turns + Double(k) * 1.3
                let rr = R * (0.85 - 0.6 * (Double(t) / 48))
                stir.append(PenPoint(x: cx + JS.cos(a) * rr, y: cy + JS.sin(a) * rr))
            }
            _ = try run(knife, stir, "#000000")
        }
        let mixed = try mixPigments(paints.map { p in let c = hexToRgb8(p.color); return .rgb(Double(c[0]) / 255, Double(c[1]) / 255, Double(c[2]) / 255) }, paints.map(\.parts))
        let core = withTip(PAD_BLOB, ["size": .number(R * 1.1), "hardness": 0.55])
        let hex = "#" + mixed.map { String(Int(JS.round($0 * 255)), radix: 16).leftPad(2) }.joined()
        _ = try run(core, [PenPoint(x: cx, y: cy)], hex)
        return (try pick(cx, cy, 2), bounds)
    }

    /// The pad's pixels as a PNG data URL (with alpha), for saving.
    func toPng() -> String {
        pngDataUrl(width, height, readRegion(surface, RasterRect(x: 0, y: 0, width: width, height: height)))
    }

    /// Replaces the pad with a PNG data URL of the pad's size, as `toPng` writes.
    func fromPng(_ png: String) throws {
        let bytes = png.hasPrefix("data:") ? parseDataUrl(png)?.bytes : try? base64ToBytes(png)
        guard let bytes, isPng(bytes) else { throw PaintEditorError("The pad image is not a PNG data URL or base64 PNG.") }
        let img = try decodePng(bytes)
        if img.width != width || img.height != height { throw PaintEditorError("The pad image is \(img.width)×\(img.height); a mixing pad is \(width)×\(height).") }
        surface = surfaceFromPixels(width: img.width, height: img.height, data: img.data, channels: 4)
        version += 1
    }

    /// Whether nothing is on the pad.
    var empty: Bool { surface.tiles.isEmpty }

    /// The pad over white, `width × height` RGBA.
    func pixels() -> [UInt8] {
        var px = readRegion(surface, RasterRect(x: 0, y: 0, width: width, height: height))
        var i = 0
        while i < px.count {
            let a = Double(px[i + 3]) / 255
            for c in 0..<3 { px[i + c] = JS.u8c(JS.round(Double(px[i + c]) * a + 255 * (1 - a))) }
            px[i + 3] = 255
            i += 4
        }
        return px
    }
}

/// A kept mixing pad.
struct SavedMixingPad {
    var id: String
    var name: String
    var png: String
}
