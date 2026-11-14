import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

/**
 * What a paint document reads of the image editor's vector layers (`image-editor/layers/serialize.ts`
 * `readShapeComponents`, `readVectorMask`, `readShape`, `readType` and the annotation migration,
 * with the validation of `layers/shape.ts`, `layers/text.ts` and `layers/css-color.ts`):
 *
 * - Vector masks on pixel layers and groups are read, normalised (live shapes, SVG path data,
 *   hybrid edges) and kept, so they save back as the TS core saves them. The paint editor does not
 *   draw them, as in TS.
 * - Shape and type layers are checked as the image editor checks them, so a broken one reports the
 *   image editor's own problem; the paint editor then leaves the rest out.
 * - Annotations report the layer type the image editor migrates them to (shape, type or annotation).
 *
 * The geometry (live shapes, live corners, SVG path data → anchors) is the TS core's, ported here
 * on JSON because the vector editor's typed port (`PixerateVector`) depends on this module.
 * An annotation with a field it can't draw (a pen without points, a text that is not a string)
 * reports the TS core's field check (`layers/annotation-fields.ts`), and only that layer is left out.
 */

/// A failed check, with the TS core's message (`LayerOperationError`, or V8's `TypeError`).
private func fail(_ message: String) -> PaintEditorError { PaintEditorError(message) }

/// `${n}` of a number in a message.
private func jsNum(_ n: Double) -> String { JSONValue.jsString(n) }

/// `v === undefined || v === null` (what `??` replaces).
private func nullish(_ v: JSONValue?) -> Bool { v == nil || v == .null }

/// `typeof v === 'object' && v !== null` (arrays too).
private func isObjectLike(_ v: JSONValue?) -> Bool {
    switch v {
    case .object?, .array?: return true
    default: return false
    }
}

/// The members `v?.name` reads: an object's own; arrays and other non-null values have none of the
/// names read here; `null` and missing values have no properties at all (nil).
private func props(_ v: JSONValue?) -> JSONObject? {
    switch v {
    case nil, .null?: return nil
    case .object(let o)?: return o
    default: return JSONObject()
    }
}

/// `Object.entries(v)` of an object or array (its indices), in JavaScript's key order.
private func entries(_ v: JSONValue) -> [(String, JSONValue)] {
    switch v {
    case .object(let o): return o.map { ($0.key, $0.value) }
    case .array(let a): return a.enumerated().map { (String($0.offset), $0.element) }
    default: return []
    }
}

private func isNum(_ v: JSONValue?) -> Bool {
    if case .number(let n)? = v { return n.isFinite }
    return false
}

/// `requireNum` (`layers/shape.ts`).
@discardableResult
private func requireNum(_ v: JSONValue?, _ path: String, _ min: Double = -.infinity, _ max: Double = .infinity) throws -> Double {
    guard case .number(let n)? = v, n.isFinite else { throw fail("\(path) must be a finite number.") }
    if n < min || n > max { throw fail("\(path) must be between \(jsNum(min)) and \(jsNum(max)), got \(jsNum(n)).") }
    return n
}

/// `x ?? fallback` of a saved value.
private func orDefault(_ v: JSONValue?, _ fallback: JSONValue) -> JSONValue { nullish(v) ? fallback : v! }

private func point(_ x: Double, _ y: Double) -> JSONValue { .object(JSONObject([("x", .number(x)), ("y", .number(y))])) }

// MARK: - CSS colours (`layers/css-color.ts`)

private let NAMED: [String: String] = [
    "aliceblue": "f0f8ff", "antiquewhite": "faebd7", "aqua": "00ffff", "aquamarine": "7fffd4", "azure": "f0ffff", "beige": "f5f5dc",
    "bisque": "ffe4c4", "black": "000000", "blanchedalmond": "ffebcd", "blue": "0000ff", "blueviolet": "8a2be2", "brown": "a52a2a",
    "burlywood": "deb887", "cadetblue": "5f9ea0", "chartreuse": "7fff00", "chocolate": "d2691e", "coral": "ff7f50", "cornflowerblue": "6495ed",
    "cornsilk": "fff8dc", "crimson": "dc143c", "cyan": "00ffff", "darkblue": "00008b", "darkcyan": "008b8b", "darkgoldenrod": "b8860b",
    "darkgray": "a9a9a9", "darkgreen": "006400", "darkgrey": "a9a9a9", "darkkhaki": "bdb76b", "darkmagenta": "8b008b", "darkolivegreen": "556b2f",
    "darkorange": "ff8c00", "darkorchid": "9932cc", "darkred": "8b0000", "darksalmon": "e9967a", "darkseagreen": "8fbc8f", "darkslateblue": "483d8b",
    "darkslategray": "2f4f4f", "darkslategrey": "2f4f4f", "darkturquoise": "00ced1", "darkviolet": "9400d3", "deeppink": "ff1493",
    "deepskyblue": "00bfff", "dimgray": "696969", "dimgrey": "696969", "dodgerblue": "1e90ff", "firebrick": "b22222", "floralwhite": "fffaf0",
    "forestgreen": "228b22", "fuchsia": "ff00ff", "gainsboro": "dcdcdc", "ghostwhite": "f8f8ff", "gold": "ffd700", "goldenrod": "daa520",
    "gray": "808080", "green": "008000", "greenyellow": "adff2f", "grey": "808080", "honeydew": "f0fff0", "hotpink": "ff69b4", "indianred": "cd5c5c",
    "indigo": "4b0082", "ivory": "fffff0", "khaki": "f0e68c", "lavender": "e6e6fa", "lavenderblush": "fff0f5", "lawngreen": "7cfc00",
    "lemonchiffon": "fffacd", "lightblue": "add8e6", "lightcoral": "f08080", "lightcyan": "e0ffff", "lightgoldenrodyellow": "fafad2",
    "lightgray": "d3d3d3", "lightgreen": "90ee90", "lightgrey": "d3d3d3", "lightpink": "ffb6c1", "lightsalmon": "ffa07a", "lightseagreen": "20b2aa",
    "lightskyblue": "87cefa", "lightslategray": "778899", "lightslategrey": "778899", "lightsteelblue": "b0c4de", "lightyellow": "ffffe0",
    "lime": "00ff00", "limegreen": "32cd32", "linen": "faf0e6", "magenta": "ff00ff", "maroon": "800000", "mediumaquamarine": "66cdaa",
    "mediumblue": "0000cd", "mediumorchid": "ba55d3", "mediumpurple": "9370db", "mediumseagreen": "3cb371", "mediumslateblue": "7b68ee",
    "mediumspringgreen": "00fa9a", "mediumturquoise": "48d1cc", "mediumvioletred": "c71585", "midnightblue": "191970", "mintcream": "f5fffa",
    "mistyrose": "ffe4e1", "moccasin": "ffe4b5", "navajowhite": "ffdead", "navy": "000080", "oldlace": "fdf5e6", "olive": "808000",
    "olivedrab": "6b8e23", "orange": "ffa500", "orangered": "ff4500", "orchid": "da70d6", "palegoldenrod": "eee8aa", "palegreen": "98fb98",
    "paleturquoise": "afeeee", "palevioletred": "db7093", "papayawhip": "ffefd5", "peachpuff": "ffdab9", "peru": "cd853f", "pink": "ffc0cb",
    "plum": "dda0dd", "powderblue": "b0e0e6", "purple": "800080", "rebeccapurple": "663399", "red": "ff0000", "rosybrown": "bc8f8f",
    "royalblue": "4169e1", "saddlebrown": "8b4513", "salmon": "fa8072", "sandybrown": "f4a460", "seagreen": "2e8b57", "seashell": "fff5ee",
    "sienna": "a0522d", "silver": "c0c0c0", "skyblue": "87ceeb", "slateblue": "6a5acd", "slategray": "708090", "slategrey": "708090",
    "snow": "fffafa", "springgreen": "00ff7f", "steelblue": "4682b4", "tan": "d2b48c", "teal": "008080", "thistle": "d8bfd8", "tomato": "ff6347",
    "turquoise": "40e0d0", "violet": "ee82ee", "wheat": "f5deb3", "white": "ffffff", "whitesmoke": "f5f5f5", "yellow": "ffff00",
    "yellowgreen": "9acd32"
]


/// JavaScript's `\s` as an ICU class.
private let WS = "[\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]"
private let NUM = "([+-]?[0-9.]+%?)"
private let HEX_RE = try! NSRegularExpression(pattern: "^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\\z")
private let RGB_RE = try! NSRegularExpression(pattern: "^rgba?\\(\(WS)*\(NUM)[\(WS.dropFirst().dropLast()),]+\(NUM)[\(WS.dropFirst().dropLast()),]+\(NUM)(?:\(WS)*[,/]\(WS)*\(NUM))?\(WS)*\\)\\z")
private let HSL_RE = try! NSRegularExpression(pattern: "^hsla?\\(\(WS)*([+-]?[0-9.]+)(?:deg)?[\(WS.dropFirst().dropLast()),]+\(NUM)[\(WS.dropFirst().dropLast()),]+\(NUM)(?:\(WS)*[,/]\(WS)*\(NUM))?\(WS)*\\)\\z")

/// The capture groups of a whole-string match (nil for a group that did not take part).
private func groups(_ re: NSRegularExpression, _ text: String) -> [String?]? {
    let ns = text as NSString
    guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
    return (1 ..< m.numberOfRanges).map { (i: Int) -> String? in
        let r = m.range(at: i)
        return r.location == NSNotFound ? nil : ns.substring(with: r)
    }
}

private func hex2(_ v: Double) -> String {
    let n = Int(JS.round(JS.max(0, JS.min(255, v))))
    let s = String(n, radix: 16)
    return s.count < 2 ? "0" + s : s
}

private func channel(_ s: String) -> Double {
    s.hasSuffix("%") ? (s.jsParseFloat / 100) * 255 : s.jsParseFloat
}

private func alphaOf(_ s: String?) -> Double {
    guard let s else { return 1 }
    let v = s.hasSuffix("%") ? s.jsParseFloat / 100 : s.jsParseFloat
    return JS.max(0, JS.min(1, v))
}

private func hslToRgb(_ hIn: Double, _ s: Double, _ l: Double) -> [Double] {
    let h = (hIn.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    let c = (1 - abs(2 * l - 1)) * s
    let x = c * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1))
    let m = l - c / 2
    let rgb: [Double]
    if h < 60 { rgb = [c, x, 0] } else if h < 120 { rgb = [x, c, 0] } else if h < 180 { rgb = [0, c, x] } else if h < 240 { rgb = [0, x, c] } else if h < 300 { rgb = [x, 0, c] } else { rgb = [c, 0, x] }
    return rgb.map { (v: Double) -> Double in (v + m) * 255 }
}

/// `parseCssColor` of the image editor: `#rrggbb` plus alpha, or nil (non-strings too).
func imageCssColor(_ value: JSONValue?) -> (hex: String, alpha: Double)? {
    guard case .string(let raw)? = value else { return nil }
    let text = raw.jsTrimmed.jsLowercased
    if text == "transparent" { return ("#000000", 0) }
    if let named = NAMED[text] { return ("#\(named)", 1) }
    if let m = groups(HEX_RE, text), var h = m[0] {
        if h.count <= 4 { h = h.map { "\($0)\($0)" }.joined() }
        let alpha: Double = h.count == 8 ? Double(Int(String(h.suffix(2)), radix: 16) ?? 0) / 255 : 1
        return ("#\(h.prefix(6))", alpha)
    }
    if let m = groups(RGB_RE, text) {
        let rgb = [m[0]!, m[1]!, m[2]!].map(channel)
        if !rgb.allSatisfy({ $0.isFinite }) { return nil }
        return ("#\(rgb.map(hex2).joined())", alphaOf(m[3]))
    }
    if let m = groups(HSL_RE, text) {
        let rgb = hslToRgb(m[0]!.jsParseFloat, m[1]!.jsParseFloat / 100, m[2]!.jsParseFloat / 100)
        if !rgb.allSatisfy({ $0.isFinite }) { return nil }
        return ("#\(rgb.map(hex2).joined())", alphaOf(m[3]))
    }
    return nil
}

// MARK: - Shape validation (`layers/shape.ts`)

private let SHAPE_OPERATIONS = ["combine", "subtract", "intersect", "exclude"]
private let LIVE_SHAPE_KINDS = ["rect", "ellipse", "polygon", "star", "line"]

/// `requireOperation`.
private func requireOperation(_ v: JSONValue?, _ path: String) throws -> String {
    guard let v else { return "combine" }
    guard case .string(let s) = v, SHAPE_OPERATIONS.contains(s) else {
        throw fail("\(path) must be one of \(SHAPE_OPERATIONS.joined(separator: ", ")), got \(jsStringify(v)).")
    }
    return s
}

/// `normalizeShapePaint` (validation only: a paint document leaves shape layers out).
private func checkShapePaint(_ v: JSONValue?, _ path: String) throws {
    if case .string(let s)? = v {
        if imageCssColor(v) == nil { throw fail("\(path): \"\(s)\" is not a colour; use #rrggbb (or #rrggbbaa, rgb(), a CSS colour name).") }
        return
    }
    guard isObjectLike(v), let o = props(v) else { throw fail("\(path) must be a colour string or an object with type color, gradient or pattern.") }
    if o["opacity"] != nil { try requireNum(o["opacity"], "\(path).opacity", 0, 1) }
    switch o["type"] {
    case .string("color")?:
        if imageCssColor(o["color"]) == nil { throw fail("\(path).color must be a colour such as #rrggbb.") }
    case .string("gradient")?:
        let g = o["gradient"]
        guard isObjectLike(g), let go = props(g) else { throw fail("\(path).gradient is required: { stops: [{ position, color }], style, angle, … }.") }
        var stops: [JSONValue] = []
        if let list = go["stops"]?.arrayValue {
            for s in list {
                guard let so = props(s) else { throw fail("Cannot read properties of null (reading 'position')") }
                var stop = JSONObject()
                if let p = so["position"] { stop["position"] = p }
                if let c = imageCssColor(so["color"]) { stop["color"] = .string(c.hex) } else if let c = so["color"] { stop["color"] = c }
                stops.append(.object(stop))
            }
        }
        var gradient = JSONObject([("stops", .array(stops))])
        if jsTruthy(go["opacityStops"]) { gradient["opacityStops"] = go["opacityStops"] }
        gradient["style"] = orDefault(go["style"], "linear")
        gradient["angle"] = orDefault(go["angle"], 90)
        gradient["scale"] = orDefault(go["scale"], 1)
        gradient["reverse"] = orDefault(go["reverse"], false)
        gradient["align"] = orDefault(go["align"], true)
        gradient["offset"] = orDefault(go["offset"], point(0, 0))
        try validateEffectGradient(.object(gradient), "\(path).gradient")
        if stops.isEmpty { throw fail("\(path).gradient.stops needs at least one { position, color }.") }
    case .string("pattern")?:
        guard case .string(let id)? = o["patternId"], !id.isEmpty else { throw fail("\(path).patternId is required (a document or built-in pattern id).") }
        if o["scale"] != nil { try requireNum(o["scale"], "\(path).scale", 0.01, 10) }
        if o["angle"] != nil { try requireNum(o["angle"], "\(path).angle", -360, 360) }
        if let phase = o["phase"] {
            let ph = props(phase)
            try requireNum(ph?["x"], "\(path).phase.x")
            try requireNum(ph?["y"], "\(path).phase.y")
        }
    default:
        throw fail("\(path).type must be color, gradient or pattern, got \(jsStringify(o["type"])).")
    }
}

/// `normalizeShapeStroke` (validation only).
private func checkShapeStroke(_ v: JSONValue?, _ path: String) throws {
    guard isObjectLike(v), let o = props(v) else {
        throw fail("\(path) must be an object { width, paint, align?, cap?, join?, miterLimit?, dashes?, dashOffset? } or null.")
    }
    try requireNum(o["width"], "\(path).width", 0, 10000)
    if o["paint"] == nil && o["color"] != nil { try checkShapePaint(o["color"], "\(path).color") } else { try checkShapePaint(o["paint"], "\(path).paint") }
    for (k, allowed) in [("align", ["inside", "center", "outside"]), ("cap", ["butt", "round", "square"]), ("join", ["miter", "round", "bevel"])] {
        guard let value = o[k] else { continue }
        guard case .string(let s) = value, allowed.contains(s) else {
            throw fail("\(path).\(k) must be one of \(allowed.joined(separator: ", ")), got \(jsStringify(value)).")
        }
    }
    if o["miterLimit"] != nil { try requireNum(o["miterLimit"], "\(path).miterLimit", 1, 500) }
    if let dashes = o["dashes"], dashes != .null {
        guard let list = dashes.arrayValue, list.count <= 32, list.allSatisfy({ (d: JSONValue) -> Bool in
            guard case .number(let n) = d, n.isFinite else { return false }
            return n >= 0 && n <= 10000
        }) else { throw fail("\(path).dashes must be at most 32 lengths 0..10000 (multiples of the width).") }
        if !list.isEmpty {
            var sum = 0.0
            for d in list { sum += d.numberValue! }
            if sum < 0.01 { throw fail("\(path).dashes must add up to at least 0.01 widths.") }
        }
    }
    if o["dashOffset"] != nil { try requireNum(o["dashOffset"], "\(path).dashOffset", -1e6, 1e6) }
}

/// `matrixArg`: six finite numbers, not singular; nil for the identity.
private func matrixArg(_ v: JSONValue?, _ path: String) throws -> [Double]? {
    if nullish(v) { return nil }
    guard let list = v?.arrayValue, list.count == 6, list.allSatisfy({ (x: JSONValue) -> Bool in isNum(x) }) else { throw fail("\(path) must be six numbers [a, b, c, d, e, f].") }
    let m = list.map { $0.numberValue! }
    let det: Double = m[0] * m[3] - m[1] * m[2]
    if abs(det) < 1e-12 { throw fail("\(path) is singular.") }
    return isIdentity(m) ? nil : m
}

/// `isIdentityMatrix` (`geom/affine.ts`).
private func isIdentity(_ m: [Double], _ eps: Double = 1e-12) -> Bool {
    abs(m[0] - 1) < eps && abs(m[1]) < eps && abs(m[2]) < eps && abs(m[3] - 1) < eps && abs(m[4]) < eps && abs(m[5]) < eps
}

/// `arrowhead`: `{ width, length, concavity? }`, or nil for none.
private func arrowhead(_ v: JSONValue?, _ path: String) throws -> JSONObject? {
    if nullish(v) || v == .bool(false) { return nil }
    guard isObjectLike(v), let o = props(v) else { throw fail("\(path) must be { width, length, concavity? } in pixels, or null.") }
    var head = JSONObject()
    head["width"] = .number(try requireNum(o["width"], "\(path).width", 0, 1e5))
    head["length"] = .number(try requireNum(o["length"], "\(path).length", 0, 1e5))
    if let c = o["concavity"], c != .number(0) { head["concavity"] = .number(try requireNum(c, "\(path).concavity", -0.5, 0.5)) }
    return head
}

/// `normalizeLiveShape`: a live shape from loose input, validated, as the TS object (key order kept).
private func normalizeLiveShape(_ v: JSONValue?, _ path: String) throws -> JSONObject {
    guard isObjectLike(v), let o = props(v) else { throw fail("\(path) must be an object with kind \(LIVE_SHAPE_KINDS.joined(separator: ", ")).") }
    let transform = try matrixArg(o["transform"], "\(path).transform")
    var out = JSONObject()
    func box() throws {
        out["x"] = .number(try requireNum(o["x"], "\(path).x"))
        out["y"] = .number(try requireNum(o["y"], "\(path).y"))
        out["width"] = .number(try requireNum(o["width"], "\(path).width", -1e6, 1e6))
        out["height"] = .number(try requireNum(o["height"], "\(path).height", -1e6, 1e6))
    }
    func addTransform() {
        if let transform { out["transform"] = .array(transform.map { .number($0) }) }
    }
    switch o["kind"] {
    case .string("rect")?:
        out["kind"] = "rect"
        try box()
        if o["radii"] != nil || o["radius"] != nil {
            let r = orDefault(o["radii"], o["radius"] ?? .null)
            let list: [JSONValue]? = { if case .number = r { return [r, r, r, r] }; return r.arrayValue }()
            guard let list, list.count == 4, list.allSatisfy({ (x: JSONValue) -> Bool in isNum(x) && x.numberValue! >= 0 }) else {
                throw fail("\(path).radii must be four radii ≥ 0 [top-left, top-right, bottom-right, bottom-left] (or radius, one number).")
            }
            if list.contains(where: { $0.numberValue! > 0 }) { out["radii"] = .array(list) }
        }
        addTransform()
    case .string("ellipse")?:
        out["kind"] = "ellipse"
        try box()
        addTransform()
    case .string("polygon")?:
        out["kind"] = "polygon"
        try box()
        out["sides"] = .number(JS.round(try requireNum(orDefault(o["sides"], 6), "\(path).sides", 3, 100)))
        addTransform()
    case .string("star")?:
        out["kind"] = "star"
        try box()
        out["points"] = .number(JS.round(try requireNum(orDefault(o["points"], 5), "\(path).points", 3, 100)))
        out["innerRatio"] = .number(try requireNum(orDefault(o["innerRatio"], 0.5), "\(path).innerRatio", 0.01, 1))
        addTransform()
    case .string("line")?:
        out["kind"] = "line"
        let x1 = try requireNum(o["x1"], "\(path).x1")
        let y1 = try requireNum(o["y1"], "\(path).y1")
        let x2 = try requireNum(o["x2"], "\(path).x2")
        let y2 = try requireNum(o["y2"], "\(path).y2")
        out["x1"] = .number(x1)
        out["y1"] = .number(y1)
        out["x2"] = .number(x2)
        out["y2"] = .number(y2)
        out["weight"] = .number(try requireNum(orDefault(o["weight"], 1), "\(path).weight", 0, 1e5))
        addTransform()
        let s = try arrowhead(o["startArrow"], "\(path).startArrow")
        let e = try arrowhead(o["endArrow"], "\(path).endArrow")
        if let s { out["startArrow"] = .object(s) }
        if let e { out["endArrow"] = .object(e) }
        if x1 == x2 && y1 == y2 { throw fail("\(path): the line's two ends are the same point.") }
    default:
        throw fail("\(path).kind must be one of \(LIVE_SHAPE_KINDS.joined(separator: ", ")), got \(jsStringify(o["kind"])).")
    }
    return out
}

/// `point` of `normalizeSubpaths`.
private func checkPoint(_ v: JSONValue?, _ path: String) throws -> JSONValue {
    guard isObjectLike(v), let p = props(v) else { throw fail("\(path) must be { x, y } in document pixels.") }
    let x = try requireNum(p["x"], "\(path).x")
    let y = try requireNum(p["y"], "\(path).y")
    return point(x, y)
}

/// `normalizeSubpaths`: `[{ anchors: [{ x, y, in?, out?, type?, corner? }], closed }]` or SVG path
/// data, each anchor's keys in that order (the order `bezierToSubpaths` writes).
private func normalizeSubpaths(_ v: JSONValue?, _ path: String) throws -> [JSONObject] {
    if case .string(let d)? = v {
        let subs: [JSONObject]
        do { subs = try bezierToSubpaths(d) } catch { throw fail("\(path): could not read the SVG path data.") }
        let drawable = subs.allSatisfy { sp in anchorsOf(sp).allSatisfy { isNum($0["x"]) && isNum($0["y"]) } }
        if subs.isEmpty || !drawable { throw fail("\(path): the SVG path data holds no drawable subpath.") }
        return subs
    }
    guard let list = v?.arrayValue, !list.isEmpty else {
        throw fail("\(path) must be a non-empty array of { anchors: [{ x, y, in?, out? }], closed } (or SVG path data).")
    }
    var out: [JSONObject] = []
    for (i, s) in list.enumerated() {
        let sp = props(s)
        guard let anchorList = sp?["anchors"]?.arrayValue, !anchorList.isEmpty else { throw fail("\(path)[\(i)].anchors must be a non-empty array.") }
        var anchors: [JSONValue] = []
        for (j, a) in anchorList.enumerated() {
            let at = "\(path)[\(i)].anchors[\(j)]"
            var anchor = try checkPoint(a, at).objectValue!
            let ao = props(a)!
            if jsTruthy(ao["in"]) { anchor["in"] = try checkPoint(ao["in"], "\(at).in") }
            if jsTruthy(ao["out"]) { anchor["out"] = try checkPoint(ao["out"], "\(at).out") }
            // Kept so a save of SVG path data (anchor types inferred) reopens unchanged (#850).
            if case .string(let type)? = ao["type"], type == "corner" || type == "smooth" || type == "symmetric" { anchor["type"] = .string(type) }
            if let c = ao["corner"], c != .null {
                let radius: JSONValue? = { if case .number = c { return c }; return props(c)?["radius"] }()
                let r = try requireNum(radius, "\(at).corner.radius", 0, 1e5)
                if r > 0 { anchor["corner"] = .object(JSONObject([("radius", .number(r))])) }
            }
            anchors.append(.object(anchor))
        }
        out.append(JSONObject([("anchors", .array(anchors)), ("closed", .bool(sp?["closed"] != .bool(false)))]))
    }
    return out
}

// MARK: - Geometry (`vector/geometry.ts`, `vector/corners.ts`, `layers/shape.ts` `liveShapeSubpaths`)

private let EPS = 1e-9
private let MIN_SINE = 1e-6
private let KAPPA = 0.5522847498307936

private func anchorsOf(_ sp: JSONObject) -> [JSONObject] { (sp["anchors"]?.arrayValue ?? []).compactMap(\.objectValue) }
private func num(_ o: JSONObject, _ k: String) -> Double { o[k]?.numberValue ?? .nan }
private func vec(_ v: JSONValue?) -> (x: Double, y: Double)? {
    guard let o = v?.objectValue, let x = o["x"]?.numberValue, let y = o["y"]?.numberValue else { return nil }
    return (x, y)
}

/// `isOnAnchor` / `onAnchor`: no handle, or a handle on the anchor.
private func isOnAnchor(_ a: JSONObject, _ h: JSONValue?) -> Bool {
    guard let p = vec(h) else { return true }
    return abs(p.x - num(a, "x")) < EPS && abs(p.y - num(a, "y")) < EPS
}

/// `inferAnchorType`.
private func inferAnchorType(_ a: JSONObject) -> String {
    if isOnAnchor(a, a["in"]) || isOnAnchor(a, a["out"]) { return "corner" }
    let hin = vec(a["in"])!
    let hout = vec(a["out"])!
    let ix = hin.x - num(a, "x")
    let iy = hin.y - num(a, "y")
    let ox = hout.x - num(a, "x")
    let oy = hout.y - num(a, "y")
    let li = JS.hypot(ix, iy)
    let lo = JS.hypot(ox, oy)
    let lilo: Double = li * lo
    let cross: Double = (ix * oy - iy * ox) / lilo
    let dot: Double = (ix * ox + iy * oy) / lilo
    if abs(cross) > 1e-3 || dot > 0 { return "corner" }
    return abs(li - lo) <= 1e-3 * JS.max(li, lo) ? "symmetric" : "smooth"
}

private struct NotReadable: Error {}

/// `bezierToSubpaths` of SVG path data: quadratics and arcs become cubics, a closing anchor that
/// repeats the first one is merged into it, and each anchor's type is inferred from its handles.
private func bezierToSubpaths(_ d: String) throws -> [JSONObject] {
    var subs: [(anchors: [JSONObject], closed: Bool)] = []
    var current: Int?
    for cmd in PixerateGeometry.toBezierPath(.svg(d)) {
        switch cmd {
        case let .M(x, y):
            subs.append(([JSONObject([("x", .number(x)), ("y", .number(y))])], false))
            current = subs.count - 1
        case let .L(x, y):
            guard let c = current else { throw NotReadable() }
            subs[c].anchors.append(JSONObject([("x", .number(x)), ("y", .number(y))]))
        case let .Q(x1, y1, x, y):
            guard let c = current, !subs[c].anchors.isEmpty else { throw NotReadable() }
            let k = subs[c].anchors.count - 1
            let p0x = num(subs[c].anchors[k], "x")
            let p0y = num(subs[c].anchors[k], "y")
            let ox: Double = p0x + (2.0 / 3.0) * (x1 - p0x)
            let oy: Double = p0y + (2.0 / 3.0) * (y1 - p0y)
            subs[c].anchors[k]["out"] = point(ox, oy)
            let ix: Double = x + (2.0 / 3.0) * (x1 - x)
            let iy: Double = y + (2.0 / 3.0) * (y1 - y)
            subs[c].anchors.append(JSONObject([("x", .number(x)), ("y", .number(y)), ("in", point(ix, iy))]))
        case let .C(x1, y1, x2, y2, x, y):
            guard let c = current, !subs[c].anchors.isEmpty else { throw NotReadable() }
            subs[c].anchors[subs[c].anchors.count - 1]["out"] = point(x1, y1)
            subs[c].anchors.append(JSONObject([("x", .number(x)), ("y", .number(y)), ("in", point(x2, y2))]))
        case .Z:
            guard let c = current else { break }
            subs[c].closed = true
            let anchors = subs[c].anchors
            if anchors.count > 1 {
                let first = anchors[0]
                let end = anchors[anchors.count - 1]
                if abs(num(end, "x") - num(first, "x")) < 1e-7 && abs(num(end, "y") - num(first, "y")) < 1e-7 {
                    // `in` before `out`, as on every other anchor, so the save reopens unchanged (#850).
                    if jsTruthy(end["in"]) {
                        var merged: JSONObject = JSONObject([("x", first["x"] ?? .null), ("y", first["y"] ?? .null), ("in", end["in"] ?? .null)])
                        if let out = first["out"] { merged["out"] = out }
                        subs[c].anchors[0] = merged
                    }
                    subs[c].anchors.removeLast()
                }
            }
            current = nil
        default:
            break
        }
    }
    var out: [JSONObject] = []
    for sp in subs where !sp.anchors.isEmpty {
        let anchors = sp.anchors.map { (aIn: JSONObject) -> JSONValue in
            var a = aIn
            if isOnAnchor(a, a["in"]) { a["in"] = nil }
            if isOnAnchor(a, a["out"]) { a["out"] = nil }
            let type = inferAnchorType(a)
            if type != "corner" { a["type"] = .string(type) }
            return .object(a)
        }
        out.append(JSONObject([("anchors", .array(anchors)), ("closed", .bool(sp.closed))]))
    }
    return out
}

/// `subpathSegmentCount`.
private func segmentCount(_ sp: JSONObject) -> Int {
    let n = anchorsOf(sp).count
    if n < 2 { return 0 }
    return sp["closed"] == .bool(true) ? n : n - 1
}

/// A closed polygon wound clockwise on screen (`polygon` in `layers/shape.ts`).
private func polygon(_ points: [(x: Double, y: Double)]) -> JSONObject {
    var a = 0.0
    for i in 0 ..< points.count {
        let p = points[i]
        let q = points[(i + 1) % points.count]
        let term: Double = p.x * q.y - q.x * p.y
        a += term
    }
    let ordered = a < 0 ? Array(points.reversed()) : points
    return JSONObject([("closed", true), ("anchors", .array(ordered.map { point($0.x, $0.y) }))])
}

/// `arrowheadPolygon`: an arrowhead with its tip at `tip`, pointing along unit `dir`.
private func arrowheadPolygon(_ head: JSONObject, _ tip: (x: Double, y: Double), _ dir: (x: Double, y: Double)) -> JSONObject? {
    let len = JS.max(0, num(head, "length"))
    let hw = JS.max(0, num(head, "width")) / 2
    if !(len > 0) || !(hw > 0) { return nil }
    let n = (x: -dir.y, y: dir.x)
    let base = (x: tip.x - dir.x * len, y: tip.y - dir.y * len)
    let c = JS.max(-0.5, JS.min(0.5, head["concavity"]?.numberValue ?? 0))
    var pts: [(x: Double, y: Double)] = [tip, (base.x + n.x * hw, base.y + n.y * hw)]
    if c != 0 { pts.append((base.x + dir.x * len * c, base.y + dir.y * len * c)) }
    pts.append((base.x - n.x * hw, base.y - n.y * hw))
    return polygon(pts)
}

private func xy(_ x: Double, _ y: Double) -> JSONObject { JSONObject([("x", .number(x)), ("y", .number(y))]) }

/// `normBox`.
private func normBox(_ live: JSONObject) -> (x: Double, y: Double, width: Double, height: Double) {
    let x = num(live, "x"), y = num(live, "y"), w = num(live, "width"), h = num(live, "height")
    return (JS.min(x, x + w), JS.min(y, y + h), abs(w), abs(h))
}

/// `liveShapeSubpaths`: the subpaths a (normalised) live shape describes, in document pixels.
private func liveShapeSubpaths(_ live: JSONObject) -> [JSONObject] {
    var out: [JSONObject] = []
    switch live["kind"]?.stringValue {
    case "rect":
        let b = normBox(live)
        let corners: [(Double, Double)] = [(b.x, b.y), (b.x + b.width, b.y), (b.x + b.width, b.y + b.height), (b.x, b.y + b.height)]
        let radii = live["radii"]?.arrayValue?.map { $0.numberValue ?? 0 } ?? [0, 0, 0, 0]
        let anchors = corners.enumerated().map { (i: Int, p: (Double, Double)) -> JSONValue in
            var a = xy(p.0, p.1)
            // `setAnchorCorner(a, r)`: a positive radius, round, unsmoothed.
            if radii[i] > 0 { a["corner"] = .object(JSONObject([("radius", .number(radii[i]))])) }
            return .object(a)
        }
        out = [JSONObject([("closed", true), ("anchors", .array(anchors))])]
    case "ellipse":
        let b = normBox(live)
        let rx = b.width / 2
        let ry = b.height / 2
        let cx = b.x + rx
        let cy = b.y + ry
        let kx = rx * KAPPA
        let ky = ry * KAPPA
        func anchor(_ x: Double, _ y: Double, _ ix: Double, _ iy: Double, _ ox: Double, _ oy: Double) -> JSONValue {
            .object(JSONObject([("x", .number(x)), ("y", .number(y)), ("in", point(ix, iy)), ("out", point(ox, oy)), ("type", "symmetric")]))
        }
        out = [JSONObject([("closed", true), ("anchors", .array([
            anchor(cx, cy - ry, cx - kx, cy - ry, cx + kx, cy - ry),
            anchor(cx + rx, cy, cx + rx, cy - ky, cx + rx, cy + ky),
            anchor(cx, cy + ry, cx + kx, cy + ry, cx - kx, cy + ry),
            anchor(cx - rx, cy, cx - rx, cy + ky, cx - rx, cy - ky),
        ]))])]
    case "polygon":
        let b = normBox(live)
        let n = Int(JS.max(3, JS.round(num(live, "sides"))))
        let cx = b.x + b.width / 2
        let cy = b.y + b.height / 2
        var anchors: [JSONValue] = []
        for i in 0 ..< n {
            let t: Double = -Double.pi / 2 + (Double(i) * 2 * Double.pi) / Double(n)
            let x: Double = cx + (JS.cos(t) * b.width) / 2
            let y: Double = cy + (JS.sin(t) * b.height) / 2
            anchors.append(point(x, y))
        }
        out = [JSONObject([("anchors", .array(anchors)), ("closed", true)])]
    case "star":
        let b = normBox(live)
        let n = Int(JS.max(3, JS.round(num(live, "points"))))
        let inner = JS.max(0, JS.min(1, num(live, "innerRatio")))
        let cx = b.x + b.width / 2
        let cy = b.y + b.height / 2
        var anchors: [JSONValue] = []
        for i in 0 ..< n * 2 {
            let t: Double = -Double.pi / 2 + (Double(i) * Double.pi) / Double(n)
            let r: Double = i % 2 == 0 ? 1 : inner
            let x: Double = cx + (JS.cos(t) * r * b.width) / 2
            let y: Double = cy + (JS.sin(t) * r * b.height) / 2
            anchors.append(point(x, y))
        }
        out = [JSONObject([("anchors", .array(anchors)), ("closed", true)])]
    case "line":
        let a = (x: num(live, "x1"), y: num(live, "y1"))
        let b = (x: num(live, "x2"), y: num(live, "y2"))
        let len = JS.hypot(b.x - a.x, b.y - a.y)
        if len > 0 {
            let d = (x: (b.x - a.x) / len, y: (b.y - a.y) / len)
            let hw = JS.max(0, num(live, "weight")) / 2
            if hw > 0 {
                let n = (x: -d.y * hw, y: d.x * hw)
                out.append(polygon([(a.x + n.x, a.y + n.y), (b.x + n.x, b.y + n.y), (b.x - n.x, b.y - n.y), (a.x - n.x, a.y - n.y)]))
            }
            let end = live["endArrow"]?.objectValue.flatMap { arrowheadPolygon($0, b, d) }
            let start = live["startArrow"]?.objectValue.flatMap { arrowheadPolygon($0, a, (-d.x, -d.y)) }
            if let start { out.append(start) }
            if let end { out.append(end) }
        }
    default:
        break
    }
    guard let m = live["transform"]?.arrayValue?.map({ $0.numberValue ?? .nan }), !isIdentity(m) else { return out }
    return mapSubpaths(out, m)
}

/// `applyMatrix`.
private func apply(_ m: [Double], _ x: Double, _ y: Double) -> (x: Double, y: Double) {
    let px: Double = m[0] * x + m[2] * y + m[4]
    let py: Double = m[1] * x + m[3] * y + m[5]
    return (px, py)
}

/// `mapSubpaths`: live corners cut first, then every anchor and handle mapped by `m`.
private func mapSubpaths(_ subpaths: [JSONObject], _ m: [Double]) -> [JSONObject] {
    expandVectorCorners(subpaths).map { sp in
        let anchors = anchorsOf(sp).map { (a: JSONObject) -> JSONValue in
            let p = apply(m, num(a, "x"), num(a, "y"))
            var out = xy(p.x, p.y)
            if jsTruthy(a["in"]), let h = vec(a["in"]) { let q = apply(m, h.x, h.y); out["in"] = point(q.x, q.y) }
            if jsTruthy(a["out"]), let h = vec(a["out"]) { let q = apply(m, h.x, h.y); out["out"] = point(q.x, q.y) }
            if jsTruthy(a["type"]) { out["type"] = a["type"] }
            if jsTruthy(a["corner"]) { out["corner"] = a["corner"] }
            return .object(out)
        }
        return JSONObject([("closed", sp["closed"] ?? false), ("anchors", .array(anchors))])
    }
}

/// `radiusOf`: an anchor's live corner radius (0 for none).
private func radiusOf(_ a: JSONObject) -> Double {
    guard case .number(let r)? = a["corner"]?.objectValue?["radius"], r > 0, r.isFinite else { return 0 }
    return r
}

/// `cornerOf` for straight sides (the only corners a live shape has: a rectangle's).
private func cornerOf(_ anchors: [JSONObject], _ closed: Bool, _ i: Int) -> (u: (x: Double, y: Double), v: (x: Double, y: Double), lu: Double, lv: Double, cos: Double, sin: Double, maxRadius: Double)? {
    let n = anchors.count
    if n < 2 || (!closed && (i == 0 || i == n - 1)) { return nil }
    if n == 2 && closed { return nil }
    let a = anchors[i]
    if a["type"] == .string("smooth") || a["type"] == .string("symmetric") { return nil }
    let prev = anchors[(i - 1 + n) % n]
    let next = anchors[(i + 1) % n]
    func side(_ b: JSONObject) -> (dir: (x: Double, y: Double)?, length: Double) {
        let dx = num(b, "x") - num(a, "x")
        let dy = num(b, "y") - num(a, "y")
        let l = JS.hypot(dx, dy)
        return (l > EPS ? (dx * (1 / l), dy * (1 / l)) : nil, JS.hypot(dx, dy))
    }
    let su = side(prev)
    let sv = side(next)
    guard let u = su.dir, let v = sv.dir else { return nil }
    let lu = su.length
    let lv = sv.length
    if !(lu > EPS && lv > EPS) || !lu.isFinite || !lv.isFinite { return nil }
    let dot: Double = u.x * v.x + u.y * v.y
    let cross: Double = u.x * v.y - u.y * v.x
    let cos = JS.max(-1, JS.min(1, dot))
    let sin = abs(cross)
    if sin <= MIN_SINE { return nil }
    let half: Double = JS.min(lu, lv) / 2
    let maxRadius: Double = (half * sin) / (1 + cos)
    return (u, v, lu, lv, cos, sin, maxRadius)
}

/// `expandVectorCorners` for subpaths of straight segments with round, unsmoothed corners (what
/// `liveShapeSubpaths` makes: a rectangle's radii), as `vector/corners.ts` cuts them.
private func expandVectorCorners(_ subpaths: [JSONObject]) -> [JSONObject] {
    if !subpaths.contains(where: { anchorsOf($0).contains { radiusOf($0) > 0 } }) { return subpaths }
    return subpaths.map { sp in
        let anchors = anchorsOf(sp)
        guard anchors.contains(where: { radiusOf($0) > 0 }) else { return sp }
        let closed = sp["closed"] == .bool(true)
        typealias Cut = (start: (x: Double, y: Double), out: (x: Double, y: Double), in: (x: Double, y: Double), end: (x: Double, y: Double))
        let cuts = anchors.indices.map { (i: Int) -> Cut? in
            let r = radiusOf(anchors[i])
            guard r > 0, let c = cornerOf(anchors, closed, i) else { return nil }
            let fitted = JS.min(JS.max(0, r), c.maxRadius)
            guard fitted > EPS else { return nil }
            // `cutCorner`, round: trim each side by the setback, at most half of it.
            let setback: Double = (fitted * (1 + c.cos)) / c.sin
            let s = JS.min(setback, JS.min(c.lu, c.lv) / 2)
            guard s > EPS else { return nil }
            let ax = num(anchors[i], "x"), ay = num(anchors[i], "y")
            let pa = (x: ax + c.u.x * s, y: ay + c.u.y * s)
            let pb = (x: ax + c.v.x * s, y: ay + c.v.y * s)
            let d1 = (x: c.u.x * -1, y: c.u.y * -1)
            let d2 = (x: c.v.x * -1, y: c.v.y * -1)
            let d12: Double = d1.x * d2.x + d1.y * d2.y
            let turn = JS.acos(JS.max(-1, JS.min(1, -d12)))
            let chord = JS.hypot(pb.x - pa.x, pb.y - pa.y)
            let k: Double
            if turn < 1e-9 {
                k = chord / 3
            } else {
                let top: Double = (4.0 / 3.0) * JS.tan(turn / 4) * chord
                let bottom: Double = 2 * JS.sin(turn / 2)
                k = top / bottom
            }
            guard k.isFinite else { return nil }
            return (pa, (pa.x + d1.x * k, pa.y + d1.y * k), (pb.x + d2.x * k, pb.y + d2.y * k), pb)
        }
        if !cuts.contains(where: { $0 != nil }) {
            let plain = anchors.map { (a: JSONObject) -> JSONValue in
                var out = a
                out["corner"] = nil
                return .object(out)
            }
            return JSONObject([("closed", .bool(closed)), ("anchors", .array(plain))])
        }
        // Straight segments keep no handles; the cut's own segment gets the arc's.
        var out: [JSONValue] = []
        var closing: JSONObject?
        for (i, a) in anchors.enumerated() {
            guard let c = cuts[i] else {
                var plain = xy(num(a, "x"), num(a, "y"))
                if jsTruthy(a["type"]) { plain["type"] = a["type"] }
                out.append(.object(plain))
                continue
            }
            var start = xy(c.start.x, c.start.y)
            if !(abs(c.out.x - c.start.x) < EPS && abs(c.out.y - c.start.y) < EPS) { start["out"] = point(c.out.x, c.out.y) }
            var end = xy(c.end.x, c.end.y)
            if !(abs(c.in.x - c.end.x) < EPS && abs(c.in.y - c.end.y) < EPS) { end["in"] = point(c.in.x, c.in.y) }
            if i == 0 && closed { closing = start } else { out.append(.object(start)) }
            out.append(.object(end))
        }
        if let closing { out.append(.object(closing)) }
        return JSONObject([("closed", .bool(closed)), ("anchors", .array(out))])
    }
}

// MARK: - Shape components and vector masks (`layers/serialize.ts`)

/// `readShapeComponents`: stored shape components restored; throws on damaged ones.
private func readShapeComponents(_ stored: JSONValue?) throws -> [JSONObject] {
    guard let list = stored?.arrayValue else { throw fail("its components are missing") }
    return try list.enumerated().map { (i: Int, raw: JSONValue) -> JSONObject in
        let c = props(raw)
        let op = try requireOperation(c?["op"], "components[\(i)].op")
        if jsTruthy(c?["live"]) {
            let live = try normalizeLiveShape(c?["live"], "components[\(i)].live")
            let subpaths = liveShapeSubpaths(live).map { JSONValue.object($0) }
            return JSONObject([("op", .string(op)), ("subpaths", .array(subpaths)), ("live", .object(live))])
        }
        let stored = c?["subpaths"]
        let subpaths: [JSONObject] = stored?.arrayValue?.isEmpty == true ? [] : try normalizeSubpaths(stored, "components[\(i)].subpaths")
        return JSONObject([("op", .string(op)), ("subpaths", .array(subpaths.map { .object($0) }))])
    }
}

/// `num` of `layers/serialize.ts`: a finite number clamped to lo...hi, else the fallback.
private func clampNum(_ v: JSONValue?, _ lo: Double, _ hi: Double, _ fallback: Double) -> Double {
    if case .number(let n)? = v, n.isFinite { return Swift.min(hi, Swift.max(lo, n)) }
    return fallback
}

/// `readVectorMask`: a stored vector mask restored (as the `VectorMask` object); throws on damaged components.
func readVectorMask(_ raw: JSONValue) throws -> JSONObject {
    let r = props(raw) ?? JSONObject()
    let components = try readShapeComponents(r["components"])
    var vm = JSONObject([("components", .array(components.map { .object($0) }))])
    if r["fillRule"] == .string("evenodd") { vm["fillRule"] = "evenodd" }
    if r["inverted"] == .bool(true) { vm["inverted"] = true }
    if r["enabled"] == .bool(false) { vm["enabled"] = false }
    if r["linked"] == .bool(false) { vm["linked"] = false }
    if case .number(let d)? = r["density"], d != 1 { vm["density"] = .number(clampNum(r["density"], 0, 1, 1)) }
    if case .number(let f)? = r["feather"], f > 0 { vm["feather"] = .number(clampNum(r["feather"], 0, 1000, 0)) }
    // Hybrid edges: well-formed soft ones on segments the path has (others are dropped).
    if let list = r["edges"]?.arrayValue {
        func int(_ v: JSONValue?) -> Double {
            if case .number(let n)? = v, n.rounded(.towardZero) == n, n.isFinite, n >= 0 { return n }
            return -1
        }
        var edges: [JSONObject] = []
        for raw in list {
            let e = props(raw)
            let component = int(e?["component"]), subpath = int(e?["subpath"]), segment = int(e?["segment"])
            if component < 0 || subpath < 0 || segment < 0 { continue }
            var edge = JSONObject([("component", .number(component)), ("subpath", .number(subpath)), ("segment", .number(segment))])
            switch e?["mode"] {
            case .string("feather")?:
                edge["mode"] = "feather"
                edge["radius"] = .number(clampNum(e?["radius"], 0.5, 250, 4))
            case .string("matte")?:
                edge["mode"] = "matte"
                edge["inner"] = .number(clampNum(e?["inner"], 0.5, 200, 4))
                edge["outer"] = .number(clampNum(e?["outer"], 0.5, 200, 8))
            default:
                continue
            }
            edges.append(edge)
        }
        // `validVectorMaskEdges`: edges whose segment exists in the components.
        let valid = edges.filter { e in
            let ci = e["component"]!.numberValue!, si = e["subpath"]!.numberValue!, k = e["segment"]!.numberValue!
            guard ci < Double(components.count) else { return false }
            let subs = components[Int(ci)]["subpaths"]?.arrayValue ?? []
            guard si < Double(subs.count), let sp = subs[Int(si)].objectValue else { return false }
            return k >= 0 && k < Double(segmentCount(sp))
        }
        if !valid.isEmpty { vm["edges"] = .array(valid.map { .object($0) }) }
    }
    return vm
}

/// `serializeVectorMask`: a vector mask as stored.
func serializeVectorMask(_ vm: JSONObject) -> JSONObject {
    var out = JSONObject([("components", vm["components"] ?? .array([]))])
    if vm["fillRule"] == .string("evenodd") { out["fillRule"] = "evenodd" }
    if jsTruthy(vm["inverted"]) { out["inverted"] = true }
    if vm["enabled"] == .bool(false) { out["enabled"] = false }
    if vm["linked"] == .bool(false) { out["linked"] = false }
    if let d = vm["density"], d != .number(1) { out["density"] = d }
    if jsTruthy(vm["feather"]) { out["feather"] = vm["feather"] }
    if let edges = vm["edges"]?.arrayValue, !edges.isEmpty { out["edges"] = .array(edges) }
    return out
}

// MARK: - Annotations (`shapeFromAnnotation`, `typeFromAnnotation`)

/// `annotationPaint` is defined: a colour `parseCssColor` reads and the effect renderer takes.
private func annotationPaintReadable(_ color: JSONValue?) -> Bool {
    guard let c = imageCssColor(color) else { return false }
    return parseEffectColor(c.hex) != nil
}

/// `checkAnnotationNumber` (`layers/annotation-fields.ts`): a finite number, or (when `optional`) left out or `null`.
private func checkAnnotationNumber(_ a: JSONObject, _ key: String, optional: Bool = false) throws {
    let v: JSONValue? = a[key]
    if optional && nullish(v) { return }
    if !isNum(v) { throw fail("\(key) must be a finite number.") }
}

/// `checkAnnotationPoints`: a pen's `points` is an array of `{ x, y }` points with finite coordinates.
private func checkAnnotationPoints(_ a: JSONObject) throws {
    guard let pts: [JSONValue] = a["points"]?.arrayValue else { throw fail("points must be an array of { x, y } points.") }
    for (i, p) in pts.enumerated() {
        guard let point: JSONObject = p.objectValue, isNum(point["x"]), isNum(point["y"]) else {
            throw fail("points[\(i)] must be a point { x, y } with finite numbers.")
        }
    }
}

/// The geometry fields `checkShapeAnnotationFields` reads of each shape annotation, in order.
private let ANNOTATION_GEOMETRY: [String: [String]] = [
    "rect": ["x", "y", "width", "height"],
    "circle": ["x", "y", "radiusX", "radiusY"],
    "line": ["x", "y", "endX", "endY"],
    "arrow": ["x", "y", "endX", "endY"],
]

/// `checkShapeAnnotationFields`: the geometry, then `strokeWidth`, `opacity` and `rotation`; a pen's
/// `x` and `y` only as the centre of a rotation.
private func checkShapeAnnotationFields(_ a: JSONObject, _ type: String) throws {
    if type == "pen" { try checkAnnotationPoints(a) }
    let geometry: [String] = ANNOTATION_GEOMETRY[type] ?? []
    for key in geometry { try checkAnnotationNumber(a, key) }
    try checkAnnotationNumber(a, "strokeWidth", optional: true)
    try checkAnnotationNumber(a, "opacity", optional: true)
    try checkAnnotationNumber(a, "rotation", optional: true)
    if type == "pen" && jsTruthy(a["rotation"]) {
        try checkAnnotationNumber(a, "x")
        try checkAnnotationNumber(a, "y")
    }
}

/// `checkTextAnnotationFields`: checked after the colour and weight are read.
private func checkTextAnnotationFields(_ a: JSONObject) throws {
    guard case .string? = a["text"] else { throw fail("text must be a string.") }
    try checkAnnotationNumber(a, "x")
    try checkAnnotationNumber(a, "y")
    try checkAnnotationNumber(a, "fontSize", optional: true)
    let family: JSONValue? = a["fontFamily"]
    if !nullish(family) && family?.stringValue == nil { throw fail("fontFamily must be a font family name.") }
    try checkAnnotationNumber(a, "opacity", optional: true)
    try checkAnnotationNumber(a, "rotation", optional: true)
}

/// `shapeFromAnnotation(a) !== null`: the annotations the image editor draws as shape layers. A field
/// it draws with that has the wrong type throws the field check's message.
func shapeFromAnnotationReadable(_ a: JSONObject) throws -> Bool {
    guard let type: String = a["type"]?.stringValue else { return false }
    switch type {
    case "rect", "circle":
        guard annotationPaintReadable(a["strokeColor"]) else { return false }
        if jsTruthy(a["fillColor"]) && !annotationPaintReadable(a["fillColor"]) { return false }
    case "line", "arrow", "pen":
        guard annotationPaintReadable(a["strokeColor"]) else { return false }
    default:
        return false
    }
    try checkShapeAnnotationFields(a, type)
    return true
}

/// `typeFromAnnotation(a) !== null`: text annotations with a colour and weight it reads. A field it
/// draws with that has the wrong type throws the field check's message.
func typeFromAnnotationReadable(_ a: JSONObject) throws -> Bool {
    guard a["type"] == .string("text"), imageCssColor(a["color"]) != nil else { return false }
    // `checkAnnotationFontWeight`: left out, null, a string or a number.
    let w: JSONValue? = a["fontWeight"]
    switch w {
    case nil, .null?, .string?, .number?: break
    default: throw fail("fontWeight must be normal, bold or a number from 1 to 1000.")
    }
    var weight: Double = 400
    if let w, w != .null, w != .string("normal") { weight = w == .string("bold") ? 700 : jsToNumber(w) }
    if !weight.isFinite { return false }
    try checkTextAnnotationFields(a)
    return true
}

/// The layer type the image editor migrates an annotation layer to (`annotationLayerFor`).
func migratedAnnotationType(_ a: JSONObject) throws -> String {
    if try typeFromAnnotationReadable(a) { return "type" }
    if try shapeFromAnnotationReadable(a) { return "shape" }
    return "annotation"
}

// MARK: - Shape and type layers (`readShape`, `readType`)

/// PSD blocks as `readShape` / `readType` decode them (`base64ToBytes` throws on bad data).
private func checkPsdBlocks(_ blocks: JSONValue?) throws {
    guard let list = blocks?.arrayValue else { return }
    for b in list {
        guard let o = props(b), jsTruthy(b), case .string? = o["key"], case .string(let data)? = o["data"] else { continue }
        _ = try base64ToBytes(data)
    }
}

/// What `readShape` reports for a stored shape layer (nil when it reads; the paint editor then leaves it out).
func shapeLayerProblem(_ r: JSONObject) -> String? {
    do {
        var readable = false
        if let a = r["annotation"]?.objectValue, case .string? = a["type"] { readable = try shapeFromAnnotationReadable(a) }
        if !readable {
            guard let list = r["components"]?.arrayValue, !list.isEmpty else { throw fail("it has no components") }
            _ = try readShapeComponents(r["components"])
            if !nullish(r["fill"]) { try checkShapePaint(r["fill"], "fill") }
            if !nullish(r["stroke"]) { try checkShapeStroke(r["stroke"], "stroke") }
        }
        if jsTruthy(r["psd"]), let psd = props(r["psd"]) { try checkPsdBlocks(psd["blocks"]) }
        return nil
    } catch {
        return errorMessage(error)
    }
}

private let TEXT_STYLE_FIELDS = ["fontFamily", "fontWeight", "italic", "fontSize", "color", "opacity", "tracking", "leading", "baselineShift", "underline", "strikethrough", "upright", "postScriptName"]
private let PARAGRAPH_STYLE_FIELDS = ["align", "autoLeading", "firstLineIndent", "startIndent", "endIndent", "spaceBefore", "spaceAfter"]
private let TEXT_ALIGNS = ["left", "center", "right", "justify"]

/// `num` of `layers/text.ts`.
private func textNum(_ v: JSONValue, _ path: String, _ min: Double, _ max: Double) throws {
    guard case .number(let n) = v, n.isFinite, n >= min, n <= max else {
        throw fail("\(path) must be a number from \(jsNum(min)) to \(jsNum(max)), got \(jsStringify(v)).")
    }
}

/// `patchTextStyle` (validation only).
private func checkTextStyle(_ patch: JSONValue, _ path: String) throws {
    for (k, v) in entries(patch) {
        switch k {
        case "postScriptName":
            if v.stringValue == nil && v != .null { throw fail("\(path).postScriptName must be a PostScript font name.") }
        case "fontFamily":
            guard case .string(let s) = v, !s.jsTrimmed.isEmpty else { throw fail("\(path).fontFamily must be a font family name.") }
        case "fontWeight":
            var w = v
            if v == .string("normal") { w = .number(400) } else if v == .string("bold") { w = .number(700) }
            try textNum(w, "\(path).fontWeight", 1, 1000)
        case "italic", "underline", "strikethrough", "upright":
            if v.boolValue == nil && v != .null { throw fail("\(path).\(k) must be true or false.") }
        case "fontSize":
            try textNum(v, "\(path).fontSize", 0.5, 5000)
        case "color":
            if imageCssColor(v) == nil { throw fail("\(path).color must be a colour such as #rrggbb.") }
        case "opacity", "tracking", "leading", "baselineShift":
            if v == .null { continue }
            let ranges: [String: (Double, Double)] = ["opacity": (0, 1), "tracking": (-1000, 10000), "leading": (0, 10000), "baselineShift": (-5000, 5000)]
            let range = ranges[k]!
            try textNum(v, "\(path).\(k)", range.0, range.1)
        default:
            throw fail("\(path).\(k) is not a character style field; use \(TEXT_STYLE_FIELDS.joined(separator: ", ")).")
        }
    }
}

/// `patchParagraphStyle` (validation only).
private func checkParagraphStyle(_ patch: JSONValue, _ path: String) throws {
    for (k, v) in entries(patch) {
        if k == "align" {
            guard case .string(let s) = v, TEXT_ALIGNS.contains(s) else { throw fail("\(path).align must be one of \(TEXT_ALIGNS.joined(separator: ", ")).") }
        } else if PARAGRAPH_STYLE_FIELDS.contains(k) {
            if v == .null { continue }
            if k == "autoLeading" { try textNum(v, "\(path).\(k)", 0.1, 10) } else { try textNum(v, "\(path).\(k)", -10000, 10000) }
        } else {
            throw fail("\(path).\(k) is not a paragraph style field; use \(PARAGRAPH_STYLE_FIELDS.joined(separator: ", ")).")
        }
    }
}

/// The style a run or paragraph is patched with: `x?.style && typeof x.style === 'object' ? x.style : {}`.
private func styleOf(_ v: JSONValue) -> JSONValue {
    let s = props(v)?["style"]
    return isObjectLike(s) ? s! : .object(JSONObject())
}

/// What `readType` reports for a stored type layer before its pixels are read (nil when it reads).
func typeLayerProblem(_ r: JSONObject) -> String? {
    do {
        guard case .string = orDefault(r["text"], "") else { throw fail("text must be a string.") }
        for (i, run) in (r["runs"]?.arrayValue ?? []).enumerated() { try checkTextStyle(styleOf(run), "runs[\(i)].style") }
        for (i, p) in (r["paragraphs"]?.arrayValue ?? []).enumerated() { try checkParagraphStyle(styleOf(p), "paragraphs[\(i)].style") }
        if isObjectLike(r["psd"]), let psd = props(r["psd"]) {
            if case .string(let tySh)? = psd["tySh"] { _ = try base64ToBytes(tySh) }
            try checkPsdBlocks(psd["blocks"])
        }
        return nil
    } catch {
        return errorMessage(error)
    }
}
