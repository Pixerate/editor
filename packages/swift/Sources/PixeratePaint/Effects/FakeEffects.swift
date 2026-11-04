import Foundation
import PixerateCore
import PixerateRaster

/**
 * `FakeEffectProvider` (`effects/fake.ts`, `createFakeEffectProvider`): a small, deterministic,
 * CPU-only provider with the TS core's nine effects (ids `fake.…`). The shader effects render the
 * same pixels as the TS one: `invert` and `tint` (filters), `gradient` (a generator that loops),
 * `bar` (a lower-third title / overlay), `crossfade` (a transition) and `trail` (an overlay along a
 * path). `fade-in`, `badge` and `route` are vector and motion effects: they are listed and
 * described, and refuse to render pixels, as in the TS core. Tests and the conformance host use
 * it; it is also a reference for real providers.
 */
public final class FakeEffectProvider: EffectProvider {
    public let id = "fake"
    public let name = "Fake effects"
    public let capabilities: JSONObject = [
        "supportsWorker": false, "supportsFloat": true, "supportsMask": true, "supportsHostImages": false, "supportsVector": true, "supportsAuthoring": true, "maxSize": 8192,
    ]
    private let all: [EffectDescription]

    public init() {
        all = (try! JSONValue.parse(FAKE_EFFECTS_JSON)).arrayValue!.map { EffectDescription($0.objectValue!) }
    }

    private func get(_ id: String) throws -> EffectDescription {
        guard let d = all.first(where: { $0.id == id }) else { throw EffectError.unknown(id, in: "the fake provider") }
        return d
    }

    public func list(_ options: EffectSearchOptions) async throws -> [EffectDescription] { searchEffectSummaries(all.map(\.summary), "", options) }
    public func search(_ query: String, _ options: EffectSearchOptions) async throws -> [EffectDescription] { searchEffectSummaries(all.map(\.summary), query, options) }
    public func describe(_ id: String) async throws -> EffectDescription { try get(id) }

    public func createRenderer(_ id: String, width: Int, height: Int) throws -> EffectRenderer {
        let d = try get(id)
        if d.kind != "shader" { throw EffectError.unsupported("\"\(id)\" is a \(d.kind) effect; use applyVectorEffect.", id) }
        if !(width > 0 && height > 0) || width > 8192 || height > 8192 { throw EffectError.unsupported("Renderer size \(width)×\(height) is outside 1–8192.", id) }
        return FakeRenderer(d, width, height)
    }
}

private final class FakeRenderer: EffectRenderer {
    let d: EffectDescription
    let width: Int
    let height: Int
    var effectId: String { d.id }
    private var disposed = false

    init(_ d: EffectDescription, _ width: Int, _ height: Int) {
        self.d = d
        self.width = width
        self.height = height
    }

    func dispose() { disposed = true }

    func render(_ request: EffectRenderRequest) async throws -> EffectPixels {
        if disposed { throw EffectError("disposed", "The renderer for \"\(d.id)\" was disposed. Create a new renderer.", effectId: d.id) }
        if !request.time.isFinite || request.time < 0 { throw EffectError.unsupported("time must be a finite number of ms ≥ 0, got \(jsText(request.time)).", d.id) }
        let v = try resolveEffectValues(d, request.values)
        var out = try renderPixels(v, request)
        if let mask = request.mask {
            if mask.width != width || mask.height != height { throw EffectError.unsupported("The mask must be EffectPixels the size of the renderer.", d.id) }
            let source = d.uses.contains("filter") ? request.inputs["source"] : nil
            for i in stride(from: 0, to: out.data.count, by: 4) {
                let k = Double(mask.data[i + 3]) / 255
                if let s = source {
                    for c in 0..<4 { out.data[i + c] = JS.u8c(Double(s.data[i + c]) + (Double(out.data[i + c]) - Double(s.data[i + c])) * k) }
                } else {
                    out.data[i + 3] = JS.u8c(Double(out.data[i + 3]) * k)
                }
            }
        }
        return out
    }

    private func input(_ request: EffectRenderRequest, _ name: String) throws -> EffectPixels {
        guard let src = request.inputs[name] else { throw EffectError.unsupported("Effect \"\(d.id)\" needs an input named \"\(name)\".", d.id) }
        if src.width != width || src.height != height { throw EffectError.unsupported("Input \"\(name)\" is \(src.width)×\(src.height); the renderer is \(width)×\(height).", d.id) }
        return src
    }

    private func renderPixels(_ v: JSONObject, _ request: EffectRenderRequest) throws -> EffectPixels {
        var out = EffectPixels(width: width, height: height)
        let n = out.data.count
        func num(_ k: String) -> Double { v[k]?.numberValue ?? 0 }
        func rgb(_ k: String) -> [Double] { hexToRgb8(v[k]?.stringValue ?? "#000000").map(Double.init) }
        func clamp01(_ x: Double) -> Double { x < 0 ? 0 : x > 1 ? 1 : x }
        func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }
        switch d.id {
        case "fake.invert":
            let s = try input(request, "source").data
            let k = num("amount")
            for i in stride(from: 0, to: n, by: 4) {
                for c in 0..<3 { out.data[i + c] = JS.u8c(Double(s[i + c]) + (255 - 2 * Double(s[i + c])) * k) }
                out.data[i + 3] = s[i + 3]
            }
        case "fake.tint":
            let s = try input(request, "source").data
            let col = rgb("color")
            let k = num("amount")
            for i in stride(from: 0, to: n, by: 4) {
                for c in 0..<3 { out.data[i + c] = JS.u8c(Double(s[i + c]) + (col[c] - Double(s[i + c])) * k) }
                out.data[i + 3] = s[i + 3]
            }
        case "fake.gradient":
            let a = rgb("from"), b = rgb("to")
            let dur = d.duration ?? 4000
            let turn = ((request.time.truncatingRemainder(dividingBy: dur)) / dur) * num("spin")
            let rad = ((num("angle") + turn) * Double.pi) / 180
            let dx = JS.cos(rad), dy = JS.sin(rad)
            let h0 = (abs(dx) * Double(width) + abs(dy) * Double(height)) / 2
            let half = h0 != 0 && !h0.isNaN ? h0 : 1
            let alpha = JS.u8c(255 * clamp01(num("opacity")))
            var i = 0
            for y in 0..<height {
                for x in 0..<width {
                    let t = clamp01(((Double(x) + 0.5 - Double(width) / 2) * dx + (Double(y) + 0.5 - Double(height) / 2) * dy) / (2 * half) + 0.5)
                    for c in 0..<3 { out.data[i + c] = JS.u8c(a[c] + (b[c] - a[c]) * t) }
                    out.data[i + 3] = alpha
                    i += 4
                }
            }
        case "fake.trail":
            let col = rgb("color").map { UInt8($0) }
            let pts = framePoints(v["path"], Double(width), Double(height), [0, Double(height) / 2, Double(width), Double(height) / 2])
            let r = num("width") / 2
            var i = 0
            while i + 3 < pts.count {
                let ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3]
                let steps = Swift.max(1, Int(JS.ceil(JS.hypot(bx - ax, by - ay))))
                for s in 0...steps {
                    let cx = ax + ((bx - ax) * Double(s)) / Double(steps)
                    let cy = ay + ((by - ay) * Double(s)) / Double(steps)
                    let y0 = Swift.max(0, Int(JS.floor(cy - r))), y1 = Swift.min(height - 1, Int(JS.ceil(cy + r)))
                    let x0 = Swift.max(0, Int(JS.floor(cx - r))), x1 = Swift.min(width - 1, Int(JS.ceil(cx + r)))
                    if y0 > y1 || x0 > x1 { continue }
                    for y in y0...y1 {
                        for x in x0...x1 {
                            let ex = Double(x) + 0.5 - cx, ey = Double(y) + 0.5 - cy
                            if ex * ex + ey * ey > r * r { continue }
                            let o = (y * width + x) * 4
                            out.data[o] = col[0]; out.data[o + 1] = col[1]; out.data[o + 2] = col[2]; out.data[o + 3] = 255
                        }
                    }
                }
                i += 2
            }
        case "fake.bar":
            let col = rgb("color").map { UInt8($0) }
            let slide = num("slide")
            let shown = slide > 0 ? smooth(clamp01(request.time / slide)) : 1
            let top = Int(JS.round(Double(height) * (0.75 - num("height") / 2)))
            let bottom = Int(JS.round(Double(height) * (0.75 + num("height") / 2)))
            let right = Int(JS.round(Double(width) * 0.7 * shown))
            if Swift.max(0, top) < Swift.min(height, bottom) && right > 0 {
                for y in Swift.max(0, top)..<Swift.min(height, bottom) {
                    for x in 0..<right {
                        let o = (y * width + x) * 4
                        out.data[o] = col[0]; out.data[o + 1] = col[1]; out.data[o + 2] = col[2]; out.data[o + 3] = 255
                    }
                }
            }
        case "fake.crossfade":
            let from = try input(request, "from").data, to = try input(request, "to").data
            let p = clamp01(request.progress ?? request.time / (d.duration ?? 1000))
            let k = v["curve"]?.stringValue == "smooth" ? smooth(p) : p
            for i in 0..<n { out.data[i] = JS.u8c(Double(from[i]) + (Double(to[i]) - Double(from[i])) * k) }
        default:
            throw EffectError.unsupported("\"\(d.id)\" is a \(d.kind) effect; use applyVectorEffect.", d.id)
        }
        return out
    }
}

/// The numbers of SVG path data in order.
private func pathNumbers(_ d: String) -> [Double] {
    guard let re = try? NSRegularExpression(pattern: "-?\\d*\\.?\\d+(?:e[-+]?\\d+)?", options: [.caseInsensitive]) else { return [] }
    let ns = d as NSString
    return re.matches(in: d, range: NSRange(location: 0, length: ns.length)).compactMap { Double(ns.substring(with: $0.range)) }
}

/// A path control's value as points in frame pixels: lists as given, path data fitted (contain, 8% margin), "" as `fallback`.
private func framePoints(_ value: JSONValue?, _ width: Double, _ height: Double, _ fallback: [Double]) -> [Double] {
    if let a = value?.arrayValue { return a.count >= 4 ? a.map { $0.numberValue ?? 0 } : fallback }
    guard let s = value?.stringValue, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return fallback }
    let n = pathNumbers(s)
    if n.count < 4 { return fallback }
    var x0 = Double.infinity, y0 = Double.infinity, x1 = -Double.infinity, y1 = -Double.infinity
    var i = 0
    while i + 1 < n.count {
        x0 = Swift.min(x0, n[i]); x1 = Swift.max(x1, n[i])
        y0 = Swift.min(y0, n[i + 1]); y1 = Swift.max(y1, n[i + 1])
        i += 2
    }
    let m = 0.08
    let k = Swift.min((width * (1 - 2 * m)) / Swift.max(1e-9, x1 - x0), (height * (1 - 2 * m)) / Swift.max(1e-9, y1 - y0))
    let ox = (width - (x1 - x0) * k) / 2 - x0 * k
    let oy = (height - (y1 - y0) * k) / 2 - y0 * k
    return n.enumerated().map { i, v in i % 2 != 0 ? v * k + oy : v * k + ox }
}

/// The fake provider's effect descriptions, as the TS core's `createFakeEffectProvider().describe(id)` returns them.
private let FAKE_EFFECTS_JSON = ##"[{"id":"fake.invert","name":"Invert","kind":"shader","category":"image","uses":["filter"],"description":"Inverts the colours of the source.","tags":["negative","colour"],"transparent":false,"loop":false,"controls":{"type":"object","additionalProperties":false,"properties":{"amount":{"type":"number","minimum":0,"maximum":1,"description":"How far to invert, 0 (unchanged) to 1 (fully inverted). Default 1."}}},"defaults":{"amount":1},"presets":[{"name":"Half","values":{"amount":0.5}}],"inputs":[{"name":"source","kind":"image","description":"The picture to invert.","required":true}]},{"id":"fake.tint","name":"Tint","kind":"shader","category":"image","uses":["filter"],"description":"Mixes the source towards a colour.","tags":["colour","wash"],"transparent":false,"loop":false,"controls":{"type":"object","additionalProperties":false,"properties":{"color":{"type":"string","pattern":"^#[0-9a-fA-F]{6}$","description":"Tint colour as #rrggbb. Default #ff8800."},"amount":{"type":"number","minimum":0,"maximum":1,"description":"How far to mix towards the colour, 0–1. Default 0.5."}}},"defaults":{"color":"#ff8800","amount":0.5},"presets":[{"name":"Sepia","values":{"color":"#704214","amount":0.4}},{"name":"Cool","values":{"color":"#2060ff","amount":0.25}}],"inputs":[{"name":"source","kind":"image","description":"The picture to tint.","required":true}]},{"id":"fake.gradient","name":"Gradient","kind":"shader","category":"gradient","uses":["generator"],"description":"A linear gradient between two colours that can turn over time.","tags":["background"],"transparent":false,"loop":true,"duration":4000,"backgroundOpacity":"opacity","controls":{"type":"object","additionalProperties":false,"properties":{"from":{"type":"string","pattern":"^#[0-9a-fA-F]{6}$","description":"Start colour as #rrggbb. Default #1e3a8a."},"to":{"type":"string","pattern":"^#[0-9a-fA-F]{6}$","description":"End colour as #rrggbb. Default #f472b6."},"angle":{"type":"number","minimum":0,"maximum":360,"description":"Direction in degrees, 0 = left to right, 90 = top to bottom. Default 90."},"spin":{"type":"number","minimum":-360,"maximum":360,"description":"Turn per loop (4 s) in degrees. Default 0."},"opacity":{"type":"number","minimum":0,"maximum":1,"description":"Background opacity 0–1: 0 is fully transparent. Default 1."}}},"defaults":{"from":"#1e3a8a","to":"#f472b6","angle":90,"spin":0,"opacity":1},"presets":[{"name":"Sunset","values":{"from":"#f97316","to":"#7c3aed"}}],"inputs":[]},{"id":"fake.bar","name":"Lower-third bar","kind":"shader","category":"broadcast","uses":["title","overlay"],"description":"A coloured bar that slides in from the left in the lower third. Transparent elsewhere.","tags":["lower third","title"],"transparent":true,"loop":false,"duration":2000,"controls":{"type":"object","additionalProperties":false,"properties":{"color":{"type":"string","pattern":"^#[0-9a-fA-F]{6}$","description":"Bar colour as #rrggbb. Default #0ea5e9."},"height":{"type":"number","minimum":0.02,"maximum":0.5,"description":"Bar height as a fraction of the picture height. Default 0.12."},"slide":{"type":"number","minimum":0,"maximum":5000,"description":"Slide-in time (ms). Default 500."}}},"defaults":{"color":"#0ea5e9","height":0.12,"slide":500},"presets":[],"inputs":[]},{"id":"fake.crossfade","name":"Crossfade","kind":"shader","category":"transition","uses":["transition"],"description":"Dissolves from one picture to the next.","tags":["dissolve","mix"],"transparent":false,"loop":false,"duration":1000,"controls":{"type":"object","additionalProperties":false,"properties":{"curve":{"type":"string","enum":["linear","smooth"],"description":"Mix curve: linear, or smooth (ease in and out). Default smooth."}}},"defaults":{"curve":"smooth"},"presets":[],"inputs":[{"name":"from","kind":"image","description":"The outgoing picture.","required":true},{"name":"to","kind":"image","description":"The incoming picture.","required":true}]},{"id":"fake.fade-in","name":"Fade in","kind":"motion","category":"morph","uses":["motion"],"description":"Fades vector elements in from transparent, one after another.","tags":["appear","entrance"],"transparent":true,"loop":false,"duration":600,"controls":{"type":"object","additionalProperties":false,"properties":{"ms":{"type":"number","minimum":0,"maximum":10000,"description":"Fade time per element (ms). Default 600."},"stagger":{"type":"number","minimum":0,"maximum":5000,"description":"Delay between elements (ms). Default 0."}}},"defaults":{"ms":600,"stagger":0},"presets":[{"name":"Cascade","values":{"ms":400,"stagger":120}}],"inputs":[]},{"id":"fake.badge","name":"Badge","kind":"vector","category":"sticker","uses":["title"],"description":"A coloured disc that fades in: a vector effect that brings its own picture.","tags":["sticker","disc"],"transparent":true,"loop":false,"duration":500,"controls":{"type":"object","additionalProperties":false,"properties":{"color":{"type":"string","pattern":"^#[0-9a-fA-F]{6}$","description":"Disc colour as #rrggbb. Default #f43f5e."},"ms":{"type":"number","minimum":0,"maximum":10000,"description":"Fade-in time (ms). Default 500."}}},"defaults":{"color":"#f43f5e","ms":500},"presets":[],"inputs":[]},{"id":"fake.trail","name":"Trail","kind":"shader","category":"path","uses":["overlay"],"description":"A line drawn along its path control over transparency; with no path, a line across the middle.","tags":["path","line"],"transparent":true,"loop":false,"accepts":["path"],"controls":{"type":"object","additionalProperties":false,"properties":{"path":{"description":"Where the line runs: SVG path data (fitted into the frame, contain, 8% margin), or points [x0, y0, x1, y1, …] in frame pixels from the top left (used as given), or \"\" for none.","anyOf":[{"type":"string","format":"svg-path","description":"SVG path data, or \"\" for no path."},{"type":"array","items":{"type":"number","description":"x or y, frame pixels."},"description":"Points x0, y0, x1, y1, … in frame pixels."}]},"color":{"type":"string","pattern":"^#[0-9a-fA-F]{6}$","description":"Line colour as #rrggbb. Default #22d3ee."},"width":{"type":"number","minimum":1,"maximum":64,"description":"Line width in pixels. Default 6."}}},"defaults":{"path":"","color":"#22d3ee","width":6},"presets":[],"inputs":[]},{"id":"fake.route","name":"Route","kind":"vector","category":"path","uses":["title"],"description":"A vector line along its path control, its picture fitted to the path (viewBox = the path bounds); with no path, a short wave.","tags":["path","route"],"transparent":true,"loop":false,"duration":400,"accepts":["path"],"controls":{"type":"object","additionalProperties":false,"properties":{"path":{"description":"The route: SVG path data (fitted into the frame, contain, 8% margin), or points [x0, y0, x1, y1, …] in frame pixels from the top left (used as given), or \"\" for none.","anyOf":[{"type":"string","format":"svg-path","description":"SVG path data, or \"\" for no path."},{"type":"array","items":{"type":"number","description":"x or y, frame pixels."},"description":"Points x0, y0, x1, y1, … in frame pixels."}]},"color":{"type":"string","pattern":"^#[0-9a-fA-F]{6}$","description":"Line colour as #rrggbb. Default #f59e0b."}}},"defaults":{"path":"","color":"#f59e0b"},"presets":[],"inputs":[]}]"##
