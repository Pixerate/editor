import Foundation
import PixerateCore
import PixerateRaster

/// Moving, scaling and rotating a layer's paint (`transformLayer` in `controller.ts`).
extension PaintEditorController {
    /**
     * Moves, scales and rotates a pixel layer's paint (a placed picture, a sketch) about `origin`
     * (default the centre of its painted area): rotate `rotation` degrees clockwise, scale by
     * `scaleX` / `scaleY`, then move by `translateX` / `translateY` (document pixels). The paint is
     * resampled once (bilinear on premultiplied colour, so clear edges don't darken). One undo step.
     * Plain paint only: a layer with wet paint is dried first, and one carrying relief, light, UV or
     * thermochromic ink, ferrofluid or a culture is refused, since those can't be resampled yet.
     */
    public func transformLayer(
        layerId: String? = nil, translateX: Double? = nil, translateY: Double? = nil, scaleX: Double? = nil, scaleY: Double? = nil,
        rotation: Double? = nil, originX: Double? = nil, originY: Double? = nil
    ) throws -> PaintLayerInfo {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before transforming a layer.") }
        let target = try paintTarget(layerId, "transform")
        if doc.stickers?.get(target.id)?.isEmpty == false { throw PaintEditorError("Layer \"\(target.name)\" is a sticker layer; move its stickers with update_sticker instead.") }
        if doc.liveStrokes?.get(target.id) != nil { throw PaintEditorError("Layer \"\(target.name)\" is a stroke layer; move its strokes with edit_stroke_points, or rasterize it first (rasterize_stroke_layer).") }
        func num(_ v: Double?, _ name: String, _ dflt: Double) throws -> Double {
            guard let v else { return dflt }
            if !v.isFinite { throw PaintEditorError("\(name) must be a number.") }
            return v
        }
        let tx = try num(translateX, "translateX", 0), ty = try num(translateY, "translateY", 0)
        let sx = try num(scaleX, "scaleX", 1), sy = try num(scaleY, "scaleY", 1)
        let deg = try num(rotation, "rotation", 0)
        for (k, v) in [("scaleX", sx), ("scaleY", sy)] where !(Swift.abs(v) >= 0.01 && Swift.abs(v) <= 64) {
            throw PaintEditorError("\(k) \(jsText(v)) is out of range; use 0.01..64 (negative flips).")
        }
        _ = dryLayersFirst([target.id])
        let l = try paintTarget(target.id, "transform")
        var carried: [String] = []
        if doc.thick?.get(l.id) != nil { carried.append("relief (thick paint)") }
        if doc.light?.get(l.id) != nil { carried.append("light") }
        if doc.fluor?.get(l.id) != nil { carried.append("UV ink") }
        if doc.thermo?.get(l.id) != nil { carried.append("thermochromic ink") }
        if doc.ferro?.get(l.id) != nil { carried.append("ferrofluid") }
        if doc.cultures?.get(l.id) != nil { carried.append("a living culture") }
        if !carried.isEmpty { throw PaintEditorError("Layer \"\(l.name)\" carries \(carried.joined(separator: ", ")), which can't be transformed yet; transform a layer of plain paint (a placed picture or a dry sketch).") }
        if l.mask != nil { throw PaintEditorError("Layer \"\(l.name)\" has a mask, which can't be transformed with it yet; apply or remove the mask first.") }
        guard let area = contentBounds(l.pixelSurface) else { throw PaintEditorError("Layer \"\(l.name)\" is empty; there is nothing to transform.") }
        let off = l.pixelOffset
        let srcX = Double(area.x + off.x), srcY = Double(area.y + off.y)
        let sw = area.width, shh = area.height
        let ox = try num(originX, "originX", srcX + Double(sw) / 2), oy = try num(originY, "originY", srcY + Double(shh) / 2)
        let rad = deg * Double.pi / 180
        let cosA = JS.cos(rad), sinA = JS.sin(rad)
        // Forward: p' = origin + translate + R·S·(p − origin). Inverse for sampling.
        func fwd(_ x: Double, _ y: Double) -> (x: Double, y: Double) {
            let ux = (x - ox) * sx, uy = (y - oy) * sy
            return (ox + tx + ux * cosA - uy * sinA, oy + ty + ux * sinA + uy * cosA)
        }
        let corners = [fwd(srcX, srcY), fwd(srcX + Double(sw), srcY), fwd(srcX, srcY + Double(shh)), fwd(srcX + Double(sw), srcY + Double(shh))]
        let cw = doc.canvas.width, ch = doc.canvas.height
        // Paint may hang off the sheet, up to a sheet's width or height beyond each edge.
        let x0 = Swift.max(-cw, Int(JS.floor(corners.map(\.x).min()!))), y0 = Swift.max(-ch, Int(JS.floor(corners.map(\.y).min()!)))
        let x1 = Swift.min(2 * cw, Int(JS.ceil(corners.map(\.x).max()!))), y1 = Swift.min(2 * ch, Int(JS.ceil(corners.map(\.y).max()!)))
        let dw = Swift.max(0, x1 - x0), dh = Swift.max(0, y1 - y0)
        let pixels = readRegion(l.pixelSurface, area)
        var out = [UInt8](repeating: 0, count: dw * dh * 4)
        pixels.withUnsafeBufferPointer { src in
            func tap(_ px: Int, _ py: Int, _ w: Double, _ r: inout Double, _ g: inout Double, _ b: inout Double, _ a: inout Double) {
                if px < 0 || py < 0 || px >= sw || py >= shh { return }
                let o = (py * sw + px) * 4
                let al = Double(src[o + 3]) * w
                r += Double(src[o]) * al
                g += Double(src[o + 1]) * al
                b += Double(src[o + 2]) * al
                a += al
            }
            for y in 0..<dh {
                for x in 0..<dw {
                    let ux = Double(x0 + x) + 0.5 - ox - tx, uy = Double(y0 + y) + 0.5 - oy - ty
                    let qx = ox + (ux * cosA + uy * sinA) / sx, qy = oy + (-ux * sinA + uy * cosA) / sy
                    let fx = qx - srcX - 0.5, fy = qy - srcY - 0.5
                    if fx < -1 || fy < -1 || fx > Double(sw) || fy > Double(shh) { continue }
                    let ix = Int(JS.floor(fx)), iy = Int(JS.floor(fy))
                    let ax = fx - Double(ix), ay = fy - Double(iy)
                    var r = 0.0, g = 0.0, b = 0.0, a = 0.0
                    tap(ix, iy, (1 - ax) * (1 - ay), &r, &g, &b, &a)
                    tap(ix + 1, iy, ax * (1 - ay), &r, &g, &b, &a)
                    tap(ix, iy + 1, (1 - ax) * ay, &r, &g, &b, &a)
                    tap(ix + 1, iy + 1, ax * ay, &r, &g, &b, &a)
                    if a <= 0 { continue }
                    let k = (y * dw + x) * 4
                    out[k] = UInt8(clamping: Int(JS.round(r / a)))
                    out[k + 1] = UInt8(clamping: Int(JS.round(g / a)))
                    out[k + 2] = UInt8(clamping: Int(JS.round(b / a)))
                    out[k + 3] = UInt8(clamping: Int(JS.round(a)))
                }
            }
        }
        let next = l.withSurface(surfaceFromPixels(width: dw, height: dh, data: out, channels: 4, x: x0, y: y0), offset: LayerOffset(x: 0, y: 0))
        commit("Transform layer", doc.with { $0.layers = mapLayer($0.layers, l.id) { _ in next } })
        return describeLayer(next)
    }
}

/// The handler of `transform_layer` (`tools.ts`).
func paintTransformHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    ["transform_layer": { a in
        try c.transformLayer(
            layerId: a["layerId"]?.stringValue, translateX: a["translateX"]?.numberValue, translateY: a["translateY"]?.numberValue,
            scaleX: a["scaleX"]?.numberValue, scaleY: a["scaleY"]?.numberValue, rotation: a["rotation"]?.numberValue,
            originX: a["originX"]?.numberValue, originY: a["originY"]?.numberValue
        ).json
    }]
}
