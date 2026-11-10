import Foundation
import PixerateCore
import PixerateRaster

/**
 * Compositing for the paint editor (`paint-editor/render.ts`), on the shared `RasterCompositor`:
 * the paper is a content layer at the bottom of the stack (its tiles are generated from the paper
 * settings), and view-only images (the tracing image) sit between it and the paint.
 */

public let PAPER_NODE_ID = "__paper"
public let TRACING_NODE_ID = "__tracing"
public let XRAY_NODE_ID = "__xray"
public let AGE_NODE_ID = "__age"

/// The time machine's ageing as one filter over everything below it (`ageCompositeRegion`).
public struct AgeNodeSettings {
    public var age: PaintAgeSettings
    /// The painted layers: where they cover, the cracks use `layerCount` and their thick height.
    public var field: [AgeFieldLayer]
    /// Painted (visible, non-empty) pixel layers: more layers, denser craquelure.
    public var layerCount: Int
}

/// An RGBA image under the paint (the tracing image), drawn at its opacity and blend.
public struct ImageNodeImage {
    public var width: Int
    public var height: Int
    public var data: [UInt8]
}

/// A layer of the paint compositor: a paint layer, the paper, or a view-only image.
public final class ViewLayer: CompositorLayer, @unchecked Sendable {
    public enum Kind {
        case layer(RasterLayer)
        case paper(PaperSettings)
        case image(ImageNodeImage, version: Double)
        case age(AgeNodeSettings)
    }

    public let kind: Kind
    public let id: String
    public let name: String
    public let visible: Bool
    public let opacity: Double
    public let blend: GroupBlendMode
    public let clipped: Bool
    public let edge: LayerEdgeColor?
    /// The paper: where the light comes from, for metallic paper (nil otherwise).
    public private(set) var paperLight: (azimuth: Double, elevation: Double)?
    /// The paper: time-machine ageing (yellowed varnish and dust), nil when unaged.
    public private(set) var paperAge: PaintAgeSettings?
    private let kids: [ViewLayer]?

    public init(_ layer: RasterLayer) {
        kind = .layer(layer)
        id = layer.id
        name = layer.name
        visible = layer.visible
        opacity = layer.opacity
        blend = layer.blend
        clipped = layer.clipped
        edge = layer.edge
        kids = layer.children?.map(ViewLayer.init)
    }

    init(kind: Kind, id: String, name: String, visible: Bool = true, opacity: Double = 1, blend: GroupBlendMode = .mode(.normal), clipped: Bool = false) {
        self.kind = kind
        self.id = id
        self.name = name
        self.visible = visible
        self.opacity = opacity
        self.blend = blend
        self.clipped = clipped
        edge = nil
        kids = nil
    }

    /// The paper as a compositor layer; `light` relights metallic paper (`paperNode`); `age` applies yellowed varnish and dust.
    public static func paper(_ paper: PaperSettings, light: PaintLighting? = nil, age: PaintAgeSettings? = nil) -> ViewLayer {
        let node = ViewLayer(kind: .paper(paper), id: PAPER_NODE_ID, name: "Paper")
        if (paper.metallic ?? 0) > 0, let light { node.paperLight = (light.azimuth, light.elevation) }
        if let age, isAgeActive(age), (age.varnish > 0 || age.dust > 0) { node.paperAge = age }
        return node
    }

    /// The ageing pass for the top of the painting (above the paint, below any backlight): `ageNode`.
    public static func age(_ age: PaintAgeSettings, field: [AgeFieldLayer], layerCount: Int) -> ViewLayer {
        ViewLayer(kind: .age(AgeNodeSettings(age: age, field: field, layerCount: layerCount)), id: AGE_NODE_ID, name: "Age")
    }

    private var raster: RasterLayer? {
        if case .layer(let l) = kind { return l }
        return nil
    }

    public var type: String {
        switch kind {
        case .layer(let l): l.type
        case .paper: "paper"
        case .image: "image"
        case .age: "age"
        }
    }

    public var children: [ViewLayer]? { kids }

    public func withChildren(_ children: [ViewLayer]) -> ViewLayer {
        guard let l = raster else { return self }
        return ViewLayer(l.withChildren(children.compactMap(\.raster)))
    }

    public var mask: RasterMask? { raster?.mask }
    public var surface: PixelSurface? { raster?.surface }
    public var offset: LayerOffset? { raster?.offset }
    public var fillOpacity: Double? { raster?.fillOpacity }
    public var effects: LayerEffects? { raster?.effects }

    public func solo(blend: GroupBlendMode, opacity: Double, clipped: Bool, edge: LayerEdgeColor?) -> ViewLayer {
        if let l = raster { return ViewLayer(l.solo(blend: blend, opacity: opacity, clipped: clipped, edge: edge)) }
        return ViewLayer(kind: kind, id: id, name: name, visible: visible, opacity: opacity, blend: blend, clipped: clipped)
    }
}

/// A paper tile (cached by the paper settings and the rect).
private let paperTiles = Locked(OrderedMap<String, [UInt8]>())

func paperTile(_ paper: PaperSettings, _ r: RasterRect, light: (azimuth: Double, elevation: Double)? = nil, age: PaintAgeSettings? = nil) -> [UInt8] {
    let lightKey = light.map { "|\($0.azimuth),\($0.elevation)" } ?? ""
    let agePart = age.map { "|age:\(ageKey($0))" } ?? ""
    let key = "\(JSONValue.object(paper.json).stringified())|\(r.x),\(r.y),\(r.width),\(r.height)\(lightKey)\(agePart)"
    if let t = paperTiles.with({ $0.get(key) }) { return t }
    let base = renderPaper(paper, r, paperGrain(paper), light: light)
    let t = age != nil ? agePaperTile(base, r.x, r.y, r.width, r.height, age!) : base
    paperTiles.with { cache in
        if cache.count > 512, let first = cache.first { _ = cache.delete(first.key) }
        cache.set(key, t)
    }
    return t
}

/// The compositor profile of paint editor stacks: paper and view-only images are content layers.
func paintCompositorProfile() -> CompositorProfile<ViewLayer, BasicRasterSources> {
    var p = CompositorProfile<ViewLayer, BasicRasterSources>()
    p.isFilterLayer = { if case .age = $0.kind { return true }; return false }
    p.applyFilterRun = { layers, acc, r, _, _ in
        for l in layers {
            if case .age(let a) = l.kind { ageCompositeRegion(&acc, r, a.age, a.field, a.layerCount) }
        }
    }
    p.contentTile = { layer, r, _ in
        switch layer.kind {
        case .paper(let paper): return paperTile(paper, r, light: layer.paperLight, age: layer.paperAge)
        case .image(let image, _):
            var out = [UInt8](repeating: 0, count: r.width * r.height * 4)
            let x0 = Swift.max(0, r.x), y0 = Swift.max(0, r.y)
            let x1 = Swift.min(image.width, r.x + r.width), y1 = Swift.min(image.height, r.y + r.height)
            if x1 <= x0 || y1 <= y0 { return nil }
            for y in y0..<y1 {
                let s = (y * image.width + x0) * 4
                let d = ((y - r.y) * r.width + (x0 - r.x)) * 4
                for k in 0..<((x1 - x0) * 4) { out[d + k] = image.data[s + k] }
            }
            return out
        case .layer, .age:
            return nil
        }
    }
    p.layerKey = { layer in
        switch layer.kind {
        case .paper(let paper):
            if layer.paperLight != nil || layer.paperAge != nil {
                var arr: [JSONValue] = [.object(paper.json)]
                if let l = layer.paperLight {
                    arr.append(.number(l.azimuth))
                    arr.append(.number(l.elevation))
                } else {
                    arr.append(.null)
                    arr.append(.null)
                }
                if let a = layer.paperAge { arr.append(.string(ageKey(a))) }
                return .array(arr)
            }
            return .object(paper.json)
        case .image(_, let version): return .number(version)
        // The field's pixels are already in the signatures of the layers below.
        case .age(let a): return .array([.string(ageKey(a.age)), .number(Double(a.layerCount))])
        case .layer: return nil
        }
    }
    return p
}

/// A compositor for paint editor stacks (paper and view-only images included).
public func createPaintCompositor() -> RasterCompositor<ViewLayer, BasicRasterSources> {
    RasterCompositor(profile: paintCompositorProfile())
}

/**
 * Area-averaged downscale of straight-alpha RGBA (colours weighted by alpha). Sizes at or above
 * the source copy it.
 */
public func downsampleRgba(_ data: [UInt8], _ width: Int, _ height: Int, _ twIn: Double, _ thIn: Double) -> [UInt8] {
    let tw = Swift.max(1, Int(JS.round(twIn)))
    let th = Swift.max(1, Int(JS.round(thIn)))
    if tw >= width && th >= height { return data }
    var out = [UInt8](repeating: 0, count: tw * th * 4)
    let sx = Double(width) / Double(tw)
    let sy = Double(height) / Double(th)
    for y in 0..<th {
        let y0 = Double(y) * sy
        let y1 = y0 + sy
        for x in 0..<tw {
            let x0 = Double(x) * sx
            let x1 = x0 + sx
            var r = 0.0, g = 0.0, b = 0.0, a = 0.0, w = 0.0
            var yy = Int(JS.floor(y0))
            while Double(yy) < JS.ceil(y1) && yy < height {
                let wy = Swift.min(y1, Double(yy + 1)) - Swift.max(y0, Double(yy))
                var xx = Int(JS.floor(x0))
                while Double(xx) < JS.ceil(x1) && xx < width {
                    let wgt = wy * (Swift.min(x1, Double(xx + 1)) - Swift.max(x0, Double(xx)))
                    let i = (yy * width + xx) * 4
                    let al = Double(data[i + 3]) * wgt
                    r += Double(data[i]) * al
                    g += Double(data[i + 1]) * al
                    b += Double(data[i + 2]) * al
                    a += al
                    w += wgt
                    xx += 1
                }
                yy += 1
            }
            let o = (y * tw + x) * 4
            if a > 0 {
                out[o] = JS.u8c(r / a)
                out[o + 1] = JS.u8c(g / a)
                out[o + 2] = JS.u8c(b / a)
            }
            out[o + 3] = w > 0 ? JS.u8c(a / w) : 0
        }
    }
    return out
}
