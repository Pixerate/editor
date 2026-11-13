import CoreGraphics
import CoreText
import Foundation
import PixerateCore
import PixerateGeometry
import PixerateVector

/**
 * Draws the scene render data (`getVectorSceneRenderData`, what React and Svelte draw as SVG) with
 * CoreGraphics: the artboard, then the nodes inside the document transform. Paths draw their fill
 * and stroke (or their paint layers in order) with colours, linear and radial gradients (pad
 * spread) and pattern tiles (conic and diamond gradients, meshes), node and layer opacity and blend
 * modes, and frames' clipping masks. Text spans (the metric shaper's SVG text) draw with CoreText at
 * their positions; with `CoreTextVectorShaper` text arrives as outlines and draws as paths. Node
 * filters (shadows, glows, blurs) are not drawn yet; reflect / repeat spreads draw as pad.
 */
public enum VectorSceneDrawer {
    /// Draws `scene` into `ctx`, whose space is the view's (y down, origin top left, points).
    public static func draw(_ scene: JSONValue, in ctx: CGContext, artboard: Bool = true) {
        var defs: [String: JSONValue] = [:]
        for d in scene["defs"]?.arrayValue ?? [] {
            if let id = d["id"]?.stringValue { defs[id] = d }
        }
        let drawer = Drawer(defs: defs)
        ctx.saveGState()
        if let t = scene["transform"]?.stringValue, let m = parseSvgTransform(t) { ctx.concatenate(cgAffine(m)) }
        if artboard, let w = scene["width"]?.numberValue, let h = scene["height"]?.numberValue {
            let rect = CGRect(x: 0, y: 0, width: w, height: h)
            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: 1), blur: 6, color: CGColor(gray: 0, alpha: 0.35))
            let bg: CGColor = scene["background"]?.stringValue.flatMap(parseCSSColor) ?? CGColor(gray: 1, alpha: 1)
            // A see-through background still shows the artboard: white under it.
            ctx.setFillColor(CGColor(gray: 1, alpha: 1))
            ctx.fill(rect)
            ctx.restoreGState()
            ctx.setFillColor(bg)
            ctx.fill(rect)
        }
        for node in scene["nodes"]?.arrayValue ?? [] { drawer.node(node, ctx) }
        ctx.restoreGState()
    }

    /// The scene drawn into a bitmap of `width` × `height` pixels (the view's space scaled by `scale`), for snapshots and tests.
    public static func image(_ scene: JSONValue, width: Int, height: Int, scale: CGFloat = 1, artboard: Bool = true) -> CGImage? {
        guard width > 0, height > 0,
              let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        // y down, as the view.
        ctx.translateBy(x: 0, y: CGFloat(height))
        ctx.scaleBy(x: scale, y: -scale)
        draw(scene, in: ctx, artboard: artboard)
        return ctx.makeImage()
    }
}

/// A `VectorMatrix` as a CoreGraphics transform.
func cgAffine(_ m: VectorMatrix) -> CGAffineTransform {
    CGAffineTransform(a: CGFloat(m.a), b: CGFloat(m.b), c: CGFloat(m.c), d: CGFloat(m.d), tx: CGFloat(m.e), ty: CGFloat(m.f))
}

/// SVG path data as a `CGPath` (arcs become cubics).
public func vectorCGPath(_ d: String) -> CGPath {
    vectorCGPath(commands: toBezierPath(.svg(d)))
}

/// Absolute path commands as a `CGPath`.
public func vectorCGPath(commands: BezierPath) -> CGPath {
    let path = CGMutablePath()
    var open = false
    for c in commands {
        switch c {
        case let .M(x, y):
            path.move(to: CGPoint(x: x, y: y))
            open = true
        case let .L(x, y):
            if open { path.addLine(to: CGPoint(x: x, y: y)) } else { path.move(to: CGPoint(x: x, y: y)) }
            open = true
        case let .Q(x1, y1, x, y):
            if open { path.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: x1, y: y1)) }
        case let .C(x1, y1, x2, y2, x, y):
            if open { path.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2)) }
        case .A:
            // `toBezierPath` has already turned arcs into cubics.
            break
        case .Z:
            if open { path.closeSubpath() }
        }
    }
    return path
}

/// A CSS colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()`, `transparent` and the
/// basic names) as an sRGB `CGColor`, or nil when it can't be read.
public func parseCSSColor(_ text: String) -> CGColor? {
    let s = text.trimmingCharacters(in: .whitespaces).lowercased()
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    func color(_ r: Double, _ g: Double, _ b: Double, _ a: Double) -> CGColor? {
        CGColor(colorSpace: space, components: [CGFloat(r), CGFloat(g), CGFloat(b), CGFloat(a)])
    }
    if s.hasPrefix("#") {
        let hex = Array(s.dropFirst())
        func nib(_ c: Character) -> Double? { c.hexDigitValue.map(Double.init) }
        let digits = hex.compactMap(nib)
        if digits.count != hex.count { return nil }
        switch digits.count {
        case 3, 4:
            let a = digits.count == 4 ? digits[3] * 17 / 255 : 1
            return color(digits[0] * 17 / 255, digits[1] * 17 / 255, digits[2] * 17 / 255, a)
        case 6, 8:
            let r = (digits[0] * 16 + digits[1]) / 255
            let g = (digits[2] * 16 + digits[3]) / 255
            let b = (digits[4] * 16 + digits[5]) / 255
            let a = digits.count == 8 ? (digits[6] * 16 + digits[7]) / 255 : 1
            return color(r, g, b, a)
        default:
            return nil
        }
    }
    if s.hasPrefix("rgb") {
        guard let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")") else { return nil }
        let inner = s[s.index(after: open)..<close]
        let parts = inner.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "/" }).map(String.init)
        if parts.count < 3 { return nil }
        func channel(_ p: String) -> Double? {
            if p.hasSuffix("%") { return Double(p.dropLast()).map { $0 / 100 } }
            return Double(p).map { $0 / 255 }
        }
        guard let r = channel(parts[0]), let g = channel(parts[1]), let b = channel(parts[2]) else { return nil }
        var a = 1.0
        if parts.count > 3 {
            let p = parts[3]
            a = p.hasSuffix("%") ? (Double(p.dropLast()) ?? 100) / 100 : (Double(p) ?? 1)
        }
        return color(r, g, b, a)
    }
    switch s {
    case "transparent": return color(0, 0, 0, 0)
    case "black": return color(0, 0, 0, 1)
    case "white": return color(1, 1, 1, 1)
    case "red": return color(1, 0, 0, 1)
    case "green": return color(0, 0.5, 0, 1)
    case "blue": return color(0, 0, 1, 1)
    case "gray", "grey": return color(0.5, 0.5, 0.5, 1)
    case "currentcolor": return color(0, 0, 0, 1)
    default: return nil
    }
}

/// A CSS `mix-blend-mode` as a CoreGraphics blend mode.
func cgBlendMode(_ css: String?) -> CGBlendMode {
    switch css {
    case "multiply": return .multiply
    case "screen": return .screen
    case "overlay": return .overlay
    case "darken": return .darken
    case "lighten": return .lighten
    case "color-dodge": return .colorDodge
    case "color-burn": return .colorBurn
    case "hard-light": return .hardLight
    case "soft-light": return .softLight
    case "difference": return .difference
    case "exclusion": return .exclusion
    case "hue": return .hue
    case "saturation": return .saturation
    case "color": return .color
    case "luminosity": return .luminosity
    default: return .normal
    }
}

/// A number or a `"50%"` string as a fraction.
private func fraction(_ v: JSONValue?) -> Double? {
    if let n = v?.numberValue { return n }
    guard let s = v?.stringValue?.trimmingCharacters(in: .whitespaces) else { return nil }
    if s.hasSuffix("%") { return Double(s.dropLast()).map { $0 / 100 } }
    return Double(s)
}

/// A number member that may be written as a string (SVG attributes).
private func attr(_ o: JSONValue?, _ key: String) -> Double? {
    fraction(o?[key])
}

private struct Drawer {
    let defs: [String: JSONValue]

    func node(_ n: JSONValue, _ ctx: CGContext) {
        let kind = n["kind"]?.stringValue ?? "path"
        let opacity = n["opacity"]?.numberValue ?? 1
        if opacity <= 0 { return }
        ctx.saveGState()
        if let t = n["transform"]?.stringValue, let m = parseSvgTransform(t) { ctx.concatenate(cgAffine(m)) }
        let blend = cgBlendMode(n["blendMode"]?.stringValue)
        let layered = opacity < 1 || blend != .normal
        if layered {
            ctx.setAlpha(CGFloat(opacity))
            ctx.setBlendMode(blend)
            ctx.beginTransparencyLayer(auxiliaryInfo: nil)
            ctx.setAlpha(1)
            ctx.setBlendMode(.normal)
        }
        switch kind {
        case "group":
            if let mask = n["mask"], mask["type"]?.stringValue == "clip" { clip(mask, ctx) }
            for child in n["children"]?.arrayValue ?? [] { node(child, ctx) }
        case "text":
            text(n, ctx)
        default:
            path(n, ctx)
        }
        if layered { ctx.endTransparencyLayer() }
        ctx.restoreGState()
    }

    /// A clipping mask: the union of its regions.
    func clip(_ mask: JSONValue, _ ctx: CGContext) {
        let regions = mask["clip"]?.arrayValue ?? []
        if regions.isEmpty { return }
        let union = CGMutablePath()
        var evenOdd = false
        for r in regions {
            union.addPath(vectorCGPath(r["d"]?.stringValue ?? ""))
            if r["clipRule"]?.stringValue == "evenodd" { evenOdd = true }
        }
        ctx.addPath(union)
        ctx.clip(using: evenOdd ? .evenOdd : .winding)
    }

    func path(_ n: JSONValue, _ ctx: CGContext) {
        guard let d = n["d"]?.stringValue else { return }
        let cg = vectorCGPath(d)
        let rule: CGPathFillRule = n["fillRule"]?.stringValue == "evenodd" ? .evenOdd : .winding
        if let layers = n["layers"]?.arrayValue {
            for layer in layers {
                let op = layer["opacity"]?.numberValue ?? 1
                if op <= 0 { continue }
                ctx.saveGState()
                ctx.setAlpha(CGFloat(op))
                ctx.setBlendMode(cgBlendMode(layer["blendMode"]?.stringValue))
                if layer["kind"]?.stringValue == "stroke" {
                    stroke(cg, layer, ctx)
                } else {
                    fill(cg, rule, layer["fill"]?.stringValue, ctx)
                }
                ctx.restoreGState()
            }
            return
        }
        fill(cg, rule, n["fill"]?.stringValue, ctx)
        stroke(cg, n, ctx)
    }

    /// The stroke of `style` (`stroke`, `strokeWidth`, caps, joins and dashes) along `cg`.
    func stroke(_ cg: CGPath, _ style: JSONValue, _ ctx: CGContext) {
        guard let paint = style["stroke"]?.stringValue, paint != "none" else { return }
        let width = style["strokeWidth"]?.numberValue ?? 1
        if !(width > 0) { return }
        let cap: CGLineCap
        switch style["strokeLinecap"]?.stringValue {
        case "round": cap = .round
        case "square": cap = .square
        default: cap = .butt
        }
        let join: CGLineJoin
        switch style["strokeLinejoin"]?.stringValue {
        case "round": join = .round
        case "bevel": join = .bevel
        default: join = .miter
        }
        var dashes: [CGFloat] = []
        if let dash = style["strokeDasharray"]?.stringValue {
            dashes = dash.split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }.map { CGFloat($0) }
            if dashes.allSatisfy({ $0 == 0 }) { dashes = [] }
        }
        var outline = cg
        if !dashes.isEmpty { outline = cg.copy(dashingWithPhase: 0, lengths: dashes) }
        let area = outline.copy(strokingWithWidth: CGFloat(width), lineCap: cap, lineJoin: join, miterLimit: 4)
        fill(area, .winding, paint, ctx)
    }

    /// Fills `cg` with a paint: a colour, or `url(#id)` of a gradient or pattern.
    func fill(_ cg: CGPath, _ rule: CGPathFillRule, _ paint: String?, _ ctx: CGContext) {
        guard let paint, paint != "none", !paint.isEmpty else { return }
        if paint.hasPrefix("url(") {
            let id = paint.dropFirst(4).trimmingCharacters(in: CharacterSet(charactersIn: "#)'\" "))
            guard let def = defs[id] else { return }
            ctx.saveGState()
            ctx.addPath(cg)
            ctx.clip(using: rule)
            server(def, cg.boundingBoxOfPath, ctx, inner: [:])
            ctx.restoreGState()
            return
        }
        guard let color = parseCSSColor(paint) else { return }
        ctx.setFillColor(color)
        ctx.addPath(cg)
        ctx.fillPath(using: rule)
    }

    /// Paints the clip area with a paint server (`box` is the filled shape's bounds).
    func server(_ def: JSONValue, _ box: CGRect, _ ctx: CGContext, inner: [String: JSONValue]) {
        let type = def["type"]?.stringValue ?? ""
        if type == "pattern" {
            pattern(def, ctx)
            return
        }
        let a = def["attrs"]
        let stops = def["stops"]?.arrayValue ?? []
        var colors: [CGColor] = []
        var locations: [CGFloat] = []
        for s in stops {
            guard let c = parseCSSColor(s["stopColor"]?.stringValue ?? "#000") else { continue }
            let op = s["stopOpacity"]?.numberValue ?? 1
            colors.append(c.copy(alpha: c.alpha * CGFloat(op)) ?? c)
            locations.append(CGFloat(Swift.min(1, Swift.max(0, fraction(s["offset"]) ?? 0))))
        }
        if colors.isEmpty { return }
        if colors.count == 1 {
            colors.append(colors[0])
            locations = [0, 1]
        }
        guard let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: locations) else { return }
        ctx.saveGState()
        if a?["gradientUnits"]?.stringValue != "userSpaceOnUse" {
            // objectBoundingBox: the unit square is the shape's bounds.
            ctx.concatenate(CGAffineTransform(a: box.width, b: 0, c: 0, d: box.height, tx: box.minX, ty: box.minY))
        }
        if let t = a?["gradientTransform"]?.stringValue, let m = parseSvgTransform(t) { ctx.concatenate(cgAffine(m)) }
        let options: CGGradientDrawingOptions = [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        if type == "radial" {
            let cx = attr(a, "cx") ?? 0.5
            let cy = attr(a, "cy") ?? 0.5
            let r = attr(a, "r") ?? 0.5
            let fx = attr(a, "fx") ?? cx
            let fy = attr(a, "fy") ?? cy
            let fr = attr(a, "fr") ?? 0
            ctx.drawRadialGradient(gradient, startCenter: CGPoint(x: fx, y: fy), startRadius: CGFloat(fr), endCenter: CGPoint(x: cx, y: cy), endRadius: CGFloat(r), options: options)
        } else {
            let x1 = attr(a, "x1") ?? 0
            let y1 = attr(a, "y1") ?? 0
            let x2 = attr(a, "x2") ?? 1
            let y2 = attr(a, "y2") ?? 0
            ctx.drawLinearGradient(gradient, start: CGPoint(x: x1, y: y1), end: CGPoint(x: x2, y: y2), options: options)
        }
        ctx.restoreGState()
    }

    /// A pattern of gradient tiles in user space, drawn once (the tiles cover the painted area).
    func pattern(_ def: JSONValue, _ ctx: CGContext) {
        var inner: [String: JSONValue] = [:]
        for g in def["gradients"]?.arrayValue ?? [] {
            if let id = g["id"]?.stringValue { inner[id] = g }
        }
        let local = Drawer(defs: defs.merging(inner) { _, new in new })
        ctx.saveGState()
        let a = def["attrs"]
        if let t = a?["patternTransform"]?.stringValue, let m = parseSvgTransform(t) { ctx.concatenate(cgAffine(m)) }
        for tile in def["tiles"]?.arrayValue ?? [] {
            let cg = vectorCGPath(tile["d"]?.stringValue ?? "")
            local.fill(cg, .winding, tile["fill"]?.stringValue, ctx)
        }
        ctx.restoreGState()
    }

    /// SVG text spans set with CoreText at their positions (the metric shaper's output).
    func text(_ n: JSONValue, _ ctx: CGContext) {
        let layers = n["layers"]?.arrayValue ?? []
        let fillLayer = layers.last { $0["kind"]?.stringValue == "fill" }
        let defaultFill = fillLayer?["fill"]?.stringValue
        for span in n["spans"]?.arrayValue ?? [] {
            let paint = span["fill"]?.stringValue ?? defaultFill
            guard let paint, let color = parseCSSColor(paint) else { continue }
            let text = span["text"]?.stringValue ?? ""
            let xs = (span["x"]?.stringValue ?? "0").split(separator: " ").compactMap { Double($0) }
            let ys = (span["y"]?.stringValue ?? "0").split(separator: " ").compactMap { Double($0) }
            let size = span["fontSize"]?.numberValue ?? 24
            let weight = span["fontWeight"]?.numberValue ?? 400
            let family = (span["fontFamily"]?.stringValue ?? "sans-serif").trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
            let font = coreTextFont(TextFont(family: family, weight: weight, italic: span["fontStyle"]?.stringValue == "italic", size: size))
            ctx.saveGState()
            ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
            let chars = Array(text)
            // One x per character: each is placed on its own; else the span is one line.
            let pieces: [(String, Double, Double)] = xs.count > 1
                ? chars.enumerated().map { i, c in (String(c), xs[Swift.min(i, xs.count - 1)], ys.isEmpty ? 0 : ys[Swift.min(i, ys.count - 1)]) }
                : [(text, xs.first ?? 0, ys.first ?? 0)]
            for (s, x, y) in pieces {
                let attributed = NSAttributedString(string: s, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color])
                let line = CTLineCreateWithAttributedString(attributed)
                ctx.textPosition = CGPoint(x: x, y: y)
                CTLineDraw(line, ctx)
            }
            ctx.restoreGState()
        }
    }
}
