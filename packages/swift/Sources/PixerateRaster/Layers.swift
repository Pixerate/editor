import Foundation
import PixerateCore

/**
 * A layer stack that is not specific to any editor: pixel layers on tiled surfaces, groups (with
 * pass-through), raster masks with density and feather, clipping, locks, opacity, fill and blend
 * modes, plus pure tree helpers. Editors extend these with their own layer kinds (the image editor
 * adds adjustment and annotation layers, filters and parametric masks). The port of
 * `raster/layers.ts`.
 *
 * Layer objects are immutable: every change builds new objects along the path from the root to
 * the changed layer and shares everything else. They are classes, so caches can key on identity
 * as the TS ones do on object identity.
 */

/// Blend modes of a layer; groups also accept `pass-through`.
public enum GroupBlendMode: Hashable, Sendable, RawRepresentable {
    case mode(BlendMode)
    case passThrough

    public init?(rawValue: String) {
        if rawValue == "pass-through" { self = .passThrough } else if let m = BlendMode(rawValue: rawValue) { self = .mode(m) } else { return nil }
    }

    public var rawValue: String {
        switch self {
        case .mode(let m): return m.rawValue
        case .passThrough: return "pass-through"
        }
    }

    /// The mode it draws with: `normal` for pass-through.
    public var drawMode: BlendMode {
        if case .mode(let m) = self { return m }
        return .normal
    }
}

public struct LayerLocks: Equatable, Hashable, Sendable {
    /// Painting and filling are refused.
    public var pixels: Bool?
    /// Painting keeps each pixel's alpha.
    public var transparency: Bool?
    /// Moving (offset) is refused.
    public var position: Bool?
    /// Everything above, plus property changes and deletion.
    public var all: Bool?
    public init(pixels: Bool? = nil, transparency: Bool? = nil, position: Bool? = nil, all: Bool? = nil) {
        self.pixels = pixels
        self.transparency = transparency
        self.position = position
        self.all = all
    }
}

/**
 * A layer mask: 8-bit coverage (255 reveals, 0 hides) on a tiled surface, plus non-destructive
 * density and feather. `source` is an editor-defined parametric mask (generated instead of
 * painted; the compositor asks its profile for the coverage, and the surface is unused).
 */
public struct RasterMask {
    public var surface: MaskSurface
    /// Value outside the painted tiles (PSD's default colour); equals `surface.defaultValue`.
    public var defaultValue: Int
    /// 0..1 (missing = 1): at 0.5 hidden areas still show half.
    public var density: Double?
    /// Gaussian σ in pixels (missing = 0).
    public var feather: Double?
    /// `false` keeps the mask but ignores it.
    public var enabled: Bool?
    /// `false` unlinks the mask from its layer (Photoshop's chain icon). Missing = linked.
    public var linked: Bool?
    public var source: JSONValue?
    public init(surface: MaskSurface, defaultValue: Int, density: Double? = nil, feather: Double? = nil, enabled: Bool? = nil, linked: Bool? = nil, source: JSONValue? = nil) {
        self.surface = surface
        self.defaultValue = defaultValue
        self.density = density
        self.feather = feather
        self.enabled = enabled
        self.linked = linked
        self.source = source
    }
}

/**
 * Colour corrections at a layer's soft edge, applied when compositing (nothing is baked). Amounts
 * are 0..1; missing or 0 is off.
 */
public struct LayerEdgeColor: Equatable, Hashable, Sendable {
    /// Replaces edge colour with the subject's own, unmixed from the old background.
    public var decontaminate: Double?
    /// Limits how much of the old background's hue the edge carries.
    public var despill: Double?
    /// Pulls edge colour toward what is behind the layer now, more where the edge is more transparent.
    public var ambient: Double?
    /// sRGB 0..255 for `ambient`; missing: the composite behind the layer, sampled live.
    public var ambientColor: [Double]?
    public init(decontaminate: Double? = nil, despill: Double? = nil, ambient: Double? = nil, ambientColor: [Double]? = nil) {
        self.decontaminate = decontaminate
        self.despill = despill
        self.ambient = ambient
        self.ambientColor = ambientColor
    }

    /// The fields as the TS object (part of cache keys).
    public var json: JSONValue {
        var o = JSONObject()
        if let decontaminate { o["decontaminate"] = .number(decontaminate) }
        if let despill { o["despill"] = .number(despill) }
        if let ambient { o["ambient"] = .number(ambient) }
        if let ambientColor { o["ambientColor"] = .array(ambientColor.map { .number($0) }) }
        return .object(o)
    }
}

/// A pixel layer's integer move (document position = layer position + offset).
public struct LayerOffset: Equatable, Hashable, Sendable {
    public var x: Int
    public var y: Int
    public init(x: Int, y: Int) {
        self.x = x
        self.y = y
    }
}

/// What the tree helpers need of a layer: an id, a type, and `children` on groups.
public protocol RasterNode: AnyObject {
    var id: String { get }
    var type: String { get }
    /// Groups: their children, bottom to top; `nil` for other layers.
    var children: [Self]? { get }
    /// A copy of this group with other children (`{ ...group, children }`).
    func withChildren(_ children: [Self]) -> Self
}

/// The plain stack: pixel layers and groups.
public final class RasterLayer: RasterNode, @unchecked Sendable {
    public enum Content {
        /// Pixels in layer space, the integer move, and PSD "Fill" (0..1, missing = 1).
        case pixel(surface: PixelSurface, offset: LayerOffset, fillOpacity: Double?)
        /// Bottom to top; `collapsed` is UI only.
        case group(children: [RasterLayer], collapsed: Bool?)
    }

    public let id: String
    public let name: String
    public let visible: Bool
    /// 0..1
    public let opacity: Double
    /// Pixel layers take a blend mode; groups also `pass-through`.
    public let blend: GroupBlendMode
    /// Clip to the nearest unclipped layer below (Photoshop's clipping mask).
    public let clipped: Bool
    public let mask: RasterMask?
    public let locks: LayerLocks?
    /// Live layer effects (drop shadow, stroke, …), rendered between the content and its blend.
    public let effects: LayerEffects?
    /// Colour corrections at the layer's soft edge (see `LayerEdgeColor`).
    public let edge: LayerEdgeColor?
    /// Temporary dry mutation layer (editor state, merged down on save or patience expiry).
    public let temporary: Bool?
    /// An image editor pixel layer's effect generator (`{ effect, provider?, name?, values, time?, animate? }`):
    /// carried and saved, not drawn by the paint editor.
    public let generator: JSONObject?
    /// An image editor vector mask (`VectorMask`: `{ components, fillRule?, inverted?, enabled?,
    /// linked?, density?, feather?, edges? }`, normalised when read): carried and saved, not drawn by
    /// the paint editor.
    public let vectorMask: JSONObject?
    public let content: Content

    public init(id: String, name: String = "", visible: Bool = true, opacity: Double = 1, blend: GroupBlendMode = .mode(.normal), clipped: Bool = false, mask: RasterMask? = nil, locks: LayerLocks? = nil, effects: LayerEffects? = nil, edge: LayerEdgeColor? = nil, temporary: Bool? = nil, generator: JSONObject? = nil, vectorMask: JSONObject? = nil, content: Content) {
        self.id = id
        self.name = name
        self.visible = visible
        self.opacity = opacity
        self.blend = blend
        self.clipped = clipped
        self.mask = mask
        self.locks = locks
        self.effects = effects
        self.edge = edge
        self.temporary = temporary
        self.generator = generator
        self.vectorMask = vectorMask
        self.content = content
    }

    public var type: String {
        if case .group = content { return "group" }
        return "pixel"
    }

    public var children: [RasterLayer]? {
        if case .group(let c, _) = content { return c }
        return nil
    }

    /// A copy with some properties replaced.
    public func with(visible: Bool? = nil, opacity: Double? = nil, blend: GroupBlendMode? = nil, clipped: Bool? = nil, mask: RasterMask?? = nil, effects: LayerEffects?? = nil, edge: LayerEdgeColor?? = nil, content: Content? = nil) -> RasterLayer {
        RasterLayer(
            id: id, name: name, visible: visible ?? self.visible, opacity: opacity ?? self.opacity, blend: blend ?? self.blend,
            clipped: clipped ?? self.clipped, mask: mask ?? self.mask, locks: locks, effects: effects ?? self.effects,
            edge: edge ?? self.edge, temporary: temporary, generator: generator, vectorMask: vectorMask, content: content ?? self.content
        )
    }

    public func withChildren(_ children: [RasterLayer]) -> RasterLayer {
        if case .group(_, let collapsed) = content { return with(content: .group(children: children, collapsed: collapsed)) }
        return self
    }
}

public struct LayerLocation<T: RasterNode> {
    public let layer: T
    /// The containing group, or `nil` at the top level.
    public let parent: T?
    /// Index within the parent's children (or the top-level list).
    public let index: Int
    /// Ancestors from the top level down to the parent.
    public let path: [T]
}

/// Every layer, depth first, bottom to top (a group comes before its children).
public func flattenLayers<T: RasterNode>(_ layers: [T]) -> [T] {
    var out: [T] = []
    func walk(_ list: [T]) {
        for l in list {
            out.append(l)
            if let c = l.children { walk(c) }
        }
    }
    walk(layers)
    return out
}

public func findLayer<T: RasterNode>(_ layers: [T], _ id: String) -> LayerLocation<T>? {
    func walk(_ list: [T], _ parent: T?, _ path: [T]) -> LayerLocation<T>? {
        for (i, l) in list.enumerated() {
            if l.id == id { return LayerLocation(layer: l, parent: parent, index: i, path: path) }
            if let c = l.children, let hit = walk(c, l, path + [l]) { return hit }
        }
        return nil
    }
    return walk(layers, nil, [])
}

/// Replaces the layer with `id` by `fn(layer)` (or removes it when `fn` returns `nil`).
public func mapLayer<T: RasterNode>(_ layers: [T], _ id: String, _ fn: (T) -> T?) -> [T] {
    var changed = false
    func walk(_ list: [T]) -> [T]? {
        var out: [T]? = nil
        for (i, l) in list.enumerated() {
            var next: T? = l
            if l.id == id {
                next = fn(l)
                changed = true
            } else if let c = l.children, let children = walk(c) {
                next = l.withChildren(children)
            }
            if next !== l {
                if out == nil { out = Array(list[0..<i]) }
                if let next { out!.append(next) }
            } else if out != nil {
                out!.append(l)
            }
        }
        return out
    }
    let result = walk(layers)
    return changed ? (result ?? layers) : layers
}

/// Inserts `layer` into `parentId`'s children (or the top level) at `index` (default: top).
public func insertLayer<T: RasterNode>(_ layers: [T], _ layer: T, _ parentId: String?, _ index: Int? = nil) -> [T] {
    let put = { (list: [T]) -> [T] in
        let at = index.map { Swift.max(0, Swift.min(list.count, $0)) } ?? list.count
        var next = list
        next.insert(layer, at: at)
        return next
    }
    guard let parentId, !parentId.isEmpty else { return put(layers) }
    return mapLayer(layers, parentId) { g in
        if let c = g.children { return g.withChildren(put(c)) }
        return g
    }
}

public enum LayerLockKind {
    case pixels, transparency, position, all
}

public func isLayerLocked(_ locks: LayerLocks?, _ what: LayerLockKind) -> Bool {
    guard let locks else { return false }
    if locks.all == true { return true }
    switch what {
    case .pixels: return locks.pixels == true
    case .transparency: return locks.transparency == true
    case .position: return locks.position == true
    case .all: return locks.all == true
    }
}
