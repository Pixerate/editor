import CoreGraphics
import CoreText
import Foundation
import PixerateChart
import PixerateCore
import PixerateRaster
import SwiftUI

/// Parses a CSS paint as an SVG renderer reads it (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, named
/// colours, `rgb()` / `rgba()` with an optional alpha, also as a percentage or after `/`) times an optional
/// opacity into normalized `(r, g, b, a)` components, or `nil` for `"none"` / `"transparent"` / empty.
/// The RGB comes from `parseChartColor`, which ignores alpha (it compares colours); the alpha is read here.
public func parseChartRGBA(_ css: String?, opacity: Double? = nil) -> (r: Double, g: Double, b: Double, a: Double)? {
    guard let raw = css?.jsTrimmed.jsLowercased, !raw.isEmpty, raw != "none", raw != "transparent" else { return nil }
    let op = opacity.map { $0.isNaN ? 1 : Swift.max(0.0, Swift.min(1.0, $0)) } ?? 1.0
    let units = Array(raw.utf16)
    func hexDigit(_ u: UInt16) -> Double? {
        switch u {
        case 0x30...0x39: return Double(u - 0x30)
        case 0x61...0x66: return Double(u - 0x61 + 10)
        default: return nil
        }
    }
    if units.first == 0x23, units.count == 5 || units.count == 9, let digits = Optional(units.dropFirst().map(hexDigit)), !digits.contains(where: { $0 == nil }) {
        let d: [Double] = digits.map { (v: Double?) -> Double in v! }
        // Typed steps: the one-line ternary of two maps timed out CI's type checker.
        var c: [Double] = []
        if units.count == 5 {
            for v in d { let doubled: Double = v * 16 + v; c.append(doubled / 255) }
        } else {
            for i in stride(from: 0, to: 8, by: 2) { let pair: Double = d[i] * 16 + d[i + 1]; c.append(pair / 255) }
        }
        return (r: c[0], g: c[1], b: c[2], a: c[3] * op)
    }
    var alpha = 1.0
    if raw.hasPrefix("rgb"), let open = raw.firstIndex(of: "("), raw.hasSuffix(")") {
        let inner = raw[raw.index(after: open)..<raw.index(before: raw.endIndex)]
        let parts = inner.split(whereSeparator: { $0 == "," || $0 == "/" || $0 == " " }).map(String.init)
        if parts.count == 4 {
            let a = parts[3]
            if a.hasSuffix("%"), let v = Double(a.dropLast()) { alpha = v / 100 } else if let v = Double(a) { alpha = v }
            alpha = Swift.max(0, Swift.min(1, alpha))
        }
    }
    guard let rgb = parseChartColor(raw), rgb.count >= 3 else { return nil }
    // parseChartColor already returns components in 0...1.
    return (r: rgb[0], g: rgb[1], b: rgb[2], a: alpha * op)
}

/// A mark's `opacity` as SVG applies it: to the fill and stroke drawn together, not to each one.
/// `nil` when the mark is drawn at full opacity (no group needed).
public func chartMarkGroupOpacity(_ mark: ChartMark) -> Double? {
    guard let op = mark.opacity, !op.isNaN, op < 1 else { return nil }
    return Swift.max(0, op)
}

public func chartSwiftUIColor(_ css: String?, opacity: Double? = nil) -> Color? {
    guard let rgba = parseChartRGBA(css, opacity: opacity) else { return nil }
    return Color(.sRGB, red: rgba.r, green: rgba.g, blue: rgba.b, opacity: rgba.a)
}

public func parseChartDash(_ dash: String?) -> [CGFloat] {
    guard let dash, !dash.isEmpty else { return [] }
    return dash
        .split(whereSeparator: { $0 == " " || $0 == "," })
        .compactMap { Double($0).map { CGFloat($0) } }
}

/// Draws a `ChartScene` into a CoreGraphics `CGContext` (with top-left origin already configured or
/// flipped by this function).
public func drawChartSceneInCGContext(_ scene: ChartScene, context ctx: CGContext, scale: Double = 1.0) {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    func makeCGColor(_ css: String?) -> CGColor? {
        guard let c = parseChartRGBA(css) else { return nil }
        let comps: [CGFloat] = [CGFloat(c.r), CGFloat(c.g), CGFloat(c.b), CGFloat(c.a)]
        return CGColor(colorSpace: colorSpace, components: comps)
    }

    ctx.saveGState()
    defer { ctx.restoreGState() }

    // Flip from CoreGraphics bottom-left origin to SVG/scene top-left origin.
    ctx.translateBy(x: 0, y: CGFloat(scene.height * scale))
    ctx.scaleBy(x: CGFloat(scale), y: CGFloat(-scale))

    for mark in scene.marks {
        // SVG's `opacity` composites the mark's fill and stroke as one group.
        let group = chartMarkGroupOpacity(mark)
        if let group {
            ctx.saveGState()
            ctx.setAlpha(CGFloat(group))
            ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        }
        defer {
            if group != nil {
                ctx.endTransparencyLayer()
                ctx.restoreGState()
            }
        }
        switch mark {
        case .rect(let m):
            let rect = CGRect(x: m.x, y: m.y, width: m.width, height: m.height)
            let cgPath: CGPath
            if let r = m.radius, r > 0 {
                let clamped = CGFloat(Swift.min(r, Swift.min(m.width, m.height) / 2.0))
                cgPath = CGPath(roundedRect: rect, cornerWidth: clamped, cornerHeight: clamped, transform: nil)
            } else {
                cgPath = CGPath(rect: rect, transform: nil)
            }
            if let fill = makeCGColor(m.fill) {
                ctx.saveGState()
                ctx.addPath(cgPath)
                ctx.setFillColor(fill)
                ctx.fillPath()
                ctx.restoreGState()
            }
            if let stroke = makeCGColor(m.stroke) {
                ctx.saveGState()
                ctx.addPath(cgPath)
                ctx.setStrokeColor(stroke)
                ctx.setLineWidth(CGFloat(m.strokeWidth ?? 1.0))
                if m.role == .selection {
                    ctx.setLineDash(phase: 0, lengths: [3, 2])
                }
                ctx.strokePath()
                ctx.restoreGState()
            }

        case .path(let m):
            let cgPath = parseChartCGPath(m.d)
            if let fill = makeCGColor(m.fill) {
                ctx.saveGState()
                ctx.addPath(cgPath)
                ctx.setFillColor(fill)
                ctx.fillPath()
                ctx.restoreGState()
            }
            if let stroke = makeCGColor(m.stroke) {
                ctx.saveGState()
                ctx.addPath(cgPath)
                ctx.setStrokeColor(stroke)
                ctx.setLineWidth(CGFloat(m.strokeWidth ?? 1.0))
                // chartSceneToSvg strokes every path with round joins and caps.
                ctx.setLineJoin(.round)
                ctx.setLineCap(.round)
                let dash = parseChartDash(m.dash)
                if !dash.isEmpty {
                    ctx.setLineDash(phase: 0, lengths: dash)
                }
                ctx.strokePath()
                ctx.restoreGState()
            }

        case .circle(let m):
            let rect = CGRect(x: m.cx - m.r, y: m.cy - m.r, width: m.r * 2.0, height: m.r * 2.0)
            if let fill = makeCGColor(m.fill) {
                ctx.saveGState()
                ctx.setFillColor(fill)
                ctx.fillEllipse(in: rect)
                ctx.restoreGState()
            }
            if let stroke = makeCGColor(m.stroke) {
                ctx.saveGState()
                ctx.setStrokeColor(stroke)
                ctx.setLineWidth(CGFloat(m.strokeWidth ?? 1.0))
                ctx.strokeEllipse(in: rect)
                ctx.restoreGState()
            }

        case .line(let m):
            guard let stroke = makeCGColor(m.stroke) else { break }
            ctx.saveGState()
            ctx.setStrokeColor(stroke)
            ctx.setLineWidth(CGFloat(m.strokeWidth ?? 1.0))
            let dash = parseChartDash(m.dash)
            if !dash.isEmpty {
                ctx.setLineDash(phase: 0, lengths: dash)
            }
            ctx.move(to: CGPoint(x: m.x1, y: m.y1))
            ctx.addLine(to: CGPoint(x: m.x2, y: m.y2))
            ctx.strokePath()
            ctx.restoreGState()

        case .text(let m):
            guard !m.text.isEmpty, let fill = makeCGColor(m.fill) else { break }
            let ctFont = makeChartCTFont(size: m.size, weight: m.weight)
            let attrs: [NSAttributedString.Key: Any] = [
                NSAttributedString.Key(kCTFontAttributeName as String): ctFont,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): fill,
            ]
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: m.text, attributes: attrs))
            var ascent: CGFloat = 0
            var descent: CGFloat = 0
            let width = Double(CTLineGetTypographicBounds(line, &ascent, &descent, nil))
            let dx: Double
            switch m.anchor {
            case .start: dx = 0
            case .middle: dx = -width / 2.0
            case .end: dx = -width
            }
            let dy: Double
            switch m.baseline {
            case .top: dy = Double(ascent)
            case .middle: dy = Double(ascent - descent) / 2.0
            case .bottom: dy = -Double(descent)
            }
            ctx.saveGState()
            ctx.translateBy(x: CGFloat(m.x), y: CGFloat(m.y))
            if let rot = m.rotate, rot != 0 {
                ctx.rotate(by: CGFloat(rot * .pi / 180.0))
            }
            // Unflip text so glyphs render right-side-up.
            ctx.scaleBy(x: 1, y: -1)
            ctx.textPosition = CGPoint(x: CGFloat(dx), y: CGFloat(-dy))
            CTLineDraw(line, ctx)
            ctx.restoreGState()
        }
    }
}

/// Rasterizes a `ChartScene` using CoreGraphics into a `ChartRasterImage` (base64 PNG).
public func rasterizeChartScene(
    _ scene: ChartScene,
    scale: Double = 2,
    maxSize: Double = CHART_RASTER_MAX_SIZE
) throws -> ChartRasterImage {
    let size = try chartRasterSize(scene.width, scene.height, scale: scale, maxSize: maxSize)
    // A browser canvas silently turns a NaN or huge size into 0; a CGContext cannot, so say so.
    guard size.width.isFinite, size.height.isFinite, size.width * size.height * 4 <= Double(Int32.max) else {
        throw ChartRasterError("A chart image of \(JSONValue.jsString(size.width)) × \(JSONValue.jsString(size.height)) pixels can't be drawn; pass a finite maxSize.")
    }
    let outW = Int(size.width)
    let outH = Int(size.height)
    let effectiveScale = outW > 0 && scene.width > 0 ? Double(outW) / scene.width : 1.0
    var premul = [UInt8](repeating: 0, count: outW * outH * 4)
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    premul.withUnsafeMutableBytes { buf in
        guard let ctx = CGContext(
            data: buf.baseAddress,
            width: outW,
            height: outH,
            bitsPerComponent: 8,
            bytesPerRow: outW * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return }
        drawChartSceneInCGContext(scene, context: ctx, scale: effectiveScale)
    }
    // Un-premultiply RGBA for straight-alpha PNG encoding.
    var rgba = premul
    for i in stride(from: 0, to: rgba.count, by: 4) {
        let a = Int(rgba[i + 3])
        if a > 0 && a < 255 {
            rgba[i] = UInt8(Swift.min(255, (Int(rgba[i]) * 255 + a / 2) / a))
            rgba[i + 1] = UInt8(Swift.min(255, (Int(rgba[i + 1]) * 255 + a / 2) / a))
            rgba[i + 2] = UInt8(Swift.min(255, (Int(rgba[i + 2]) * 255 + a / 2) / a))
        }
    }
    let pngBytes = encodePng(outW, outH, rgba, 4)
    return ChartRasterImage(
        data: Data(pngBytes).base64EncodedString(),
        mimeType: "image/png",
        width: outW,
        height: outH
    )
}

/// Creates a `ChartToolProviderOptions.rasterize` closure backed by CoreGraphics for `controller`.
public func makeChartCoreGraphicsRasterizer(
    _ controller: ChartController,
    scale: Double = 2,
    maxSize: Double = CHART_RASTER_MAX_SIZE
) -> (@Sendable (String, (width: Double, height: Double), ChartScene) async throws -> ChartRasterImage) {
    return { _, _, scene in
        // Draw the scene render_chart laid out, so its `time` / race frame and size carry over.
        try rasterizeChartScene(scene, scale: scale, maxSize: maxSize)
    }
}
