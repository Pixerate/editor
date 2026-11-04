import Foundation
import PixerateCore

/**
 * The per-tile layer compositor engine. Composites a layer stack (pixel layers and groups with
 * masks, clipping, blend modes, opacity, fill and pass-through) tile by tile in document space,
 * so results are deterministic and testable. The port of `raster/compositor.ts`.
 *
 * Editors add their own layer kinds through a `CompositorProfile`: layers that filter what is
 * below them (adjustment layers), content layers drawn by the editor (annotations), per-layer
 * pixel filters, and parametric mask sources.
 *
 * Caches:
 * - Each top-level *step* (a content layer and the layers clipped to it, a run of filter layers,
 *   a group) has a per-tile *signature*: its properties plus the identity of every surface tile
 *   it reads. A tile whose signatures are unchanged returns the cached result.
 * - A prefix cache keeps the accumulator *before* the step that changed last time (and, when the
 *   caller names it, before the active layer). Dragging a slider on layer k, or a stroke on layer
 *   k, recomposites from step k upwards only; `dirty` rectangles limit that to where it changed.
 * - Spatial filters and feathered or parametric masks are computed once over the canvas and
 *   cached by the identity of their inputs.
 * - Layer effects: a layer's effect maps are built once over the layer's region (its bounds grown
 *   by the effects' margin, within the canvas grown the same) and cached by the identity of every
 *   surface tile the shape reads; tiles crop them. When only some of those tiles changed and every
 *   effect is local, the maps are rebuilt only within the margin of the change and patched in.
 *
 * The TS engine also memoises the steps and effect reach per layer array (by array identity);
 * Swift arrays have none, so those are rebuilt per call (they are cheap: one pass over the layers).
 */

private let TILE_BYTES = TILE_PIXELS * 4

/// What the compositor needs from its host besides the layers.
public protocol RasterSources {
    /// Canvas (document) size: spatial filters and mask feathering clamp at this rect.
    var width: Int { get }
    var height: Int { get }
    /// Changes whenever one of the host's callbacks would return something new for the same layers.
    var version: String? { get }
    /// The document's global light for effects that use it (default angle 120°, altitude 30°).
    var globalLight: GlobalLight? { get }
    /// The pixels of a pixel layer (lets a host resolve layers whose pixels live elsewhere); `nil`: its `surface`.
    func surfaceOf<L: CompositorLayer>(_ layer: L) -> PixelSurface?
    /// A document pattern by id for pattern effects (built-in patterns are found without it).
    func pattern(_ id: String) -> EffectPattern?
}

extension RasterSources {
    public var version: String? { nil }
    public var globalLight: GlobalLight? { nil }
    public func surfaceOf<L: CompositorLayer>(_ layer: L) -> PixelSurface? { nil }
    public func pattern(_ id: String) -> EffectPattern? { nil }
}

/// Plain sources: a canvas size and, optionally, the global light, a version and document patterns.
public struct BasicRasterSources: RasterSources {
    public var width: Int
    public var height: Int
    public var version: String?
    public var globalLight: GlobalLight?
    public var patterns: [String: EffectPattern]
    public init(width: Int, height: Int, version: String? = nil, globalLight: GlobalLight? = nil, patterns: [String: EffectPattern] = [:]) {
        self.width = width
        self.height = height
        self.version = version
        self.globalLight = globalLight
        self.patterns = patterns
    }
    public func pattern(_ id: String) -> EffectPattern? { patterns[id] }
}

/// The fields the engine reads; editor layer types are wider.
public protocol CompositorLayer: RasterNode {
    var visible: Bool { get }
    var opacity: Double { get }
    var blend: GroupBlendMode { get }
    var clipped: Bool { get }
    var mask: RasterMask? { get }
    /// Pixel layers.
    var surface: PixelSurface? { get }
    var offset: LayerOffset? { get }
    var fillOpacity: Double? { get }
    /// Layer effects.
    var effects: LayerEffects? { get }
    /// Edge colour; the engine applies `ambient` (the profile's pixel filters handle the rest).
    var edge: LayerEdgeColor? { get }
    /// A copy that draws alone (the deep compositor's 8-bit render of a layer): these fields replaced.
    func solo(blend: GroupBlendMode, opacity: Double, clipped: Bool, edge: LayerEdgeColor?) -> Self
}

extension RasterLayer: CompositorLayer {
    public var surface: PixelSurface? {
        if case .pixel(let s, _, _) = content { return s }
        return nil
    }
    public var offset: LayerOffset? {
        if case .pixel(_, let o, _) = content { return o }
        return nil
    }
    public var fillOpacity: Double? {
        if case .pixel(_, _, let f) = content { return f }
        return nil
    }
    public func solo(blend: GroupBlendMode, opacity: Double, clipped: Bool, edge: LayerEdgeColor?) -> RasterLayer {
        with(opacity: opacity, blend: blend, clipped: clipped, edge: .some(edge))
    }
}

/**
 * Live edge cast (`LayerEdgeColor.ambient`): pulls straight RGBA `content` toward `below` (the
 * composite behind it, same size) or a fixed colour, by `amount × (1 − α)` where α is the content's
 * alpha times `coverage` (its mask). Opaque and invisible pixels are unchanged. `max` is 255 for
 * bytes or 1 for float samples; `color` is in the same units.
 */
public func applyEdgeAmbient(_ content: inout [UInt8], _ below: [UInt8], _ coverage: [Float]?, _ amount: Double, _ color: [Double]?, _ max: Double) {
    edgeAmbient(content.count, { Double(content[$0]) }, { content[$0] = JS.u8c($1) }, { Double(below[$0]) }, coverage, amount, color, max)
}

/// `applyEdgeAmbient` on float samples.
public func applyEdgeAmbient(_ content: inout [Float], _ below: [Float], _ coverage: [Float]?, _ amount: Double, _ color: [Double]?, _ max: Double) {
    edgeAmbient(content.count, { Double(content[$0]) }, { content[$0] = Float($1) }, { Double(below[$0]) }, coverage, amount, color, max)
}

private func edgeAmbient(_ count: Int, _ get: (Int) -> Double, _ set: (Int, Double) -> Void, _ below: (Int) -> Double, _ coverage: [Float]?, _ amount: Double, _ color: [Double]?, _ max: Double) {
    let k = JS.min(1, JS.max(0, amount))
    if !(k > 0) { return }
    let n = count / 4
    for i in 0..<n {
        let a = (get(i * 4 + 3) / max) * (coverage.map { Double($0[i]) } ?? 1)
        if a <= 0 || a >= 1 { continue }
        let r: Double, g: Double, b: Double
        if let color {
            r = color[0]
            g = color[1]
            b = color[2]
        } else {
            if !(below(i * 4 + 3) > 0) { continue }
            r = below(i * 4)
            g = below(i * 4 + 1)
            b = below(i * 4 + 2)
        }
        let t = k * (1 - a)
        set(i * 4, get(i * 4) + t * (r - get(i * 4)))
        set(i * 4 + 1, get(i * 4 + 1) + t * (g - get(i * 4 + 1)))
        set(i * 4 + 2, get(i * 4 + 2) + t * (b - get(i * 4 + 2)))
    }
}

/// A pixel layer's filters as the engine runs them.
public struct PixelFilterSpec {
    /// Identifies the settings (part of the cache key).
    public var key: String
    /// Needs neighbouring pixels: runs once over the canvas instead of per tile.
    public var spatial: Bool
    /// Filters RGBA `data` (`width × height`) in place.
    public var apply: (_ data: inout [UInt8], _ width: Int, _ height: Int) -> Void
    public init(key: String, spatial: Bool, apply: @escaping (_ data: inout [UInt8], _ width: Int, _ height: Int) -> Void) {
        self.key = key
        self.spatial = spatial
        self.apply = apply
    }
}

/// How an editor's own layer kinds composite. Every hook is optional.
public struct CompositorProfile<L: CompositorLayer, S: RasterSources> {
    /// Layers that change what is below them; adjacent ones run as one step.
    public var isFilterLayer: ((L) -> Bool)?
    /// Applies a run of visible filter layers to `acc` (RGBA over `r`); `coverage` holds masked ones by id.
    public var applyFilterRun: ((_ layers: [L], _ acc: inout [UInt8], _ r: RasterRect, _ coverage: [String: [Float]]?, _ sources: S) -> Void)?
    /// RGBA of a content layer that is neither a pixel layer nor a group, over `r`, or `nil`.
    public var contentTile: ((L, RasterRect, S) -> [UInt8]?)?
    /// The blend mode a content layer draws with (default `layer.blend`).
    public var contentBlend: ((L) -> BlendMode)?
    /// Properties of a layer beyond the generic ones that change its pixels (part of its signature).
    public var layerKey: ((L) -> JSONValue?)?
    /// Active filters of a pixel layer, or `nil`.
    public var pixelFilters: ((L) -> PixelFilterSpec?)?
    /// Canvas coverage (0..1, `width × height`) of a parametric mask source, or `nil` to reveal all.
    public var maskSourcePlane: ((_ source: JSONValue, _ width: Int, _ height: Int, _ sources: S) -> [Float]?)?
    /**
     * Layer kinds besides `pixel` that composite exactly like pixel layers, from their `surface`,
     * `offset` and `fillOpacity` (a smart object's rendered pixels).
     */
    public var isPixelLike: ((L) -> Bool)?

    public init() {}
}

public struct CompositorOptions {
    /// Upper bound for cached tile buffers (default 256 MiB).
    public var maxCacheBytes: Int?
    public init(maxCacheBytes: Int? = nil) { self.maxCacheBytes = maxCacheBytes }
}

/// A rectangle with fractional edges (a stroke's dabs), as `dirty` takes them.
public struct DirtyRect: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
    public init(_ r: RasterRect) { self.init(x: Double(r.x), y: Double(r.y), width: Double(r.width), height: Double(r.height)) }
}

public struct CompositeCallOptions {
    /**
     * The layer about to be edited (the active layer): every tile composited in this call keeps a
     * checkpoint below its step, so strokes and slider drags on it start there.
     */
    public var checkpointLayerId: String?
    /**
     * Where the layers changed since the previous call, when the caller knows (a stroke's dabs).
     * Changed tiles are then recomposited only inside these rectangles (grown by the effects' reach),
     * tiles they miss keep their pixels, and effect maps are rebuilt only around them. Changes outside
     * them would be missed, so pass nothing when unsure.
     */
    public var dirty: [DirtyRect]?
    public init(checkpointLayerId: String? = nil, dirty: [DirtyRect]? = nil) {
        self.checkpointLayerId = checkpointLayerId
        self.dirty = dirty
    }
}

// MARK: - Steps and signatures

final class Step<L> {
    enum Kind { case content, adjust, group }
    let kind: Kind
    /// Content and group steps.
    let layer: L?
    var clipped: [L] = []
    /// Adjust steps.
    var layers: [L] = []
    /// Group steps.
    let steps: [Step<L>]

    init(content layer: L) {
        kind = .content
        self.layer = layer
        steps = []
    }
    init(adjust layers: [L]) {
        kind = .adjust
        layer = nil
        self.layers = layers
        steps = []
    }
    init(group layer: L, steps: [Step<L>]) {
        kind = .group
        self.layer = layer
        self.steps = steps
    }
}

/// One part of a signature: a number, a string, `null`, or an object compared by identity.
enum SigRef: Equatable {
    case null
    case number(Double)
    case string(String)
    case object(AnyObject)

    static func == (a: SigRef, b: SigRef) -> Bool {
        switch (a, b) {
        case (.null, .null): return true
        case (.number(let x), .number(let y)): return x == y
        case (.string(let x), .string(let y)): return x == y
        case (.object(let x), .object(let y)): return x === y
        default: return false
        }
    }

    static func tile(_ t: Tile?) -> SigRef { t.map { .object($0) } ?? .null }
}

struct Sig {
    var key: String
    var refs: [SigRef]
}

private func sameSig(_ a: Sig?, _ b: Sig) -> Bool {
    guard let a, a.key == b.key, a.refs.count == b.refs.count else { return false }
    for i in 0..<a.refs.count where a.refs[i] != b.refs[i] { return false }
    return true
}

/// The bounding box of the parts of `rects` inside tile (tx, ty), or `nil` when none is.
private func dirtyInTile(_ rects: [DirtyRect], _ tx: Int, _ ty: Int) -> RasterRect? {
    var x0 = Int.max, y0 = Int.max, x1 = Int.min, y1 = Int.min
    let ox = tx * TILE
    let oy = ty * TILE
    for r in rects {
        let a = Swift.max(ox, Int(JS.floor(r.x)))
        let b = Swift.max(oy, Int(JS.floor(r.y)))
        let c = Swift.min(ox + TILE, Int(JS.ceil(r.x + r.width)))
        let d = Swift.min(oy + TILE, Int(JS.ceil(r.y + r.height)))
        if c <= a || d <= b { continue }
        x0 = Swift.min(x0, a)
        y0 = Swift.min(y0, b)
        x1 = Swift.max(x1, c)
        y1 = Swift.max(y1, d)
    }
    return x0 == Int.max ? nil : RasterRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
}

// MARK: - Blending

/**
 * Blends straight-alpha `src` over `dst` (both RGBA) in place with `mode`, scaling the source
 * alpha by `alpha` and, per pixel, by `coverage`. Same maths as `blendPixel` (including the
 * `pigment` paint mix, which caches each 8-bit colour's spectrum).
 */
public func blendTile(_ dst: inout [UInt8], _ src: [UInt8], _ mode: BlendMode, _ alpha: Double, _ coverage: [Float]?) {
    if !(alpha > 0) { return }
    let normal = mode == .normal
    let pigment = mode == .pigment
    let lut = !normal && isSeparableBlendMode(mode) ? separableLut(mode) : nil
    var cb = [0.0, 0.0, 0.0]
    var cs = [0.0, 0.0, 0.0]
    let n = dst.count
    var i = 0, p = 0
    while i < n {
        defer {
            i += 4
            p += 1
        }
        let sa = src[i + 3]
        if sa == 0 { continue }
        let k = coverage.map { alpha * Double($0[p]) } ?? alpha
        if !(k > 0) { continue }
        if normal && sa == 255 && k >= 1 {
            // Opaque normal source: the result is the source (what the general formula rounds to).
            dst[i] = src[i]
            dst[i + 1] = src[i + 1]
            dst[i + 2] = src[i + 2]
            dst[i + 3] = 255
            continue
        }
        let as_ = (Double(sa) / 255) * k
        let ab = Double(dst[i + 3]) / 255
        let ao = as_ + ab * (1 - as_)
        if ao <= 0 {
            dst[i] = 0
            dst[i + 1] = 0
            dst[i + 2] = 0
            dst[i + 3] = 0
            continue
        }
        let d0 = Int(dst[i]), d1 = Int(dst[i + 1]), d2 = Int(dst[i + 2])
        if pigment {
            // Not B(Cb, Cs): the colours mix like paint by amount, `as / ao` of the source.
            mixPigment8(d0, d1, d2, Int(src[i]), Int(src[i + 1]), Int(src[i + 2]), as_ / ao, &cb)
            dst[i] = JS.u8c(JS.round(cb[0] * 255))
            dst[i + 1] = JS.u8c(JS.round(cb[1] * 255))
            dst[i + 2] = JS.u8c(JS.round(cb[2] * 255))
            dst[i + 3] = JS.u8c(JS.round(ao * 255))
            continue
        }
        let b0 = Double(d0) / 255, b1 = Double(d1) / 255, b2 = Double(d2) / 255
        let s0 = Double(src[i]) / 255, s1 = Double(src[i + 1]) / 255, s2 = Double(src[i + 2]) / 255
        let m0: Double, m1: Double, m2: Double
        if normal {
            m0 = s0
            m1 = s1
            m2 = s2
        } else if let lut {
            m0 = lut[(d0 << 8) | Int(src[i])]
            m1 = lut[(d1 << 8) | Int(src[i + 1])]
            m2 = lut[(d2 << 8) | Int(src[i + 2])]
        } else {
            cb[0] = b0
            cb[1] = b1
            cb[2] = b2
            cs[0] = s0
            cs[1] = s1
            cs[2] = s2
            let m = blendRgb(mode, cb, cs)
            m0 = m[0]
            m1 = m[1]
            m2 = m[2]
        }
        let wb = (1 - as_) * ab
        let ws = (1 - ab) * as_
        let wm = as_ * ab
        dst[i] = JS.u8c(JS.round(((wb * b0 + ws * s0 + wm * m0) / ao) * 255))
        dst[i + 1] = JS.u8c(JS.round(((wb * b1 + ws * s1 + wm * m1) / ao) * 255))
        dst[i + 2] = JS.u8c(JS.round(((wb * b2 + ws * s2 + wm * m2) / ao) * 255))
        dst[i + 3] = JS.u8c(JS.round(ao * 255))
    }
}

private let separableLuts = Locked([BlendMode: [Double]]())

/// `B(cb, cs)` of a separable mode for every pair of 8-bit values (index `cb << 8 | cs`).
private func separableLut(_ mode: BlendMode) -> [Double] {
    if let lut = separableLuts.with({ $0[mode] }) { return lut }
    var lut = [Double](repeating: 0, count: 65536)
    for b in 0..<256 { for c in 0..<256 { lut[(b << 8) | c] = blendChannel(mode, Double(b) / 255, Double(c) / 255) } }
    separableLuts.with { $0[mode] = lut }
    return lut
}

/// Composites `src` onto `dst` but keeps `dst`'s alpha (clipping: source-atop).
private func blendAtop(_ dst: inout [UInt8], _ src: [UInt8], _ mode: BlendMode, _ alpha: Double, _ coverage: [Float]?) {
    var keep = [UInt8](repeating: 0, count: dst.count >> 2)
    var i = 3, p = 0
    while i < dst.count {
        keep[p] = dst[i]
        i += 4
        p += 1
    }
    blendTile(&dst, src, mode, alpha, coverage)
    i = 3
    p = 0
    while i < dst.count {
        dst[i] = keep[p]
        i += 4
        p += 1
    }
}

/// `dst = lerp(before, dst, alpha · coverage)` per channel (pass-through groups with opacity).
private func lerpTile(_ dst: inout [UInt8], _ before: [UInt8], _ alpha: Double, _ coverage: [Float]?) {
    var i = 0, p = 0
    while i < dst.count {
        let k = coverage.map { alpha * Double($0[p]) } ?? alpha
        if k < 1 {
            for c in 0..<4 { dst[i + c] = JS.u8c(JS.round(Double(before[i + c]) + (Double(dst[i + c]) - Double(before[i + c])) * k)) }
        }
        i += 4
        p += 1
    }
}

// MARK: - The compositor

/// A layer's cached effect maps: built for `key` over `region` from the shape tiles `tiles`.
private final class EffectEntry {
    let key: String
    let region: RasterRect
    let tiles: [TileKey: Sig]
    let maps: EffectMaps
    /// The call that last validated it.
    var stamp: Int
    init(key: String, region: RasterRect, tiles: [TileKey: Sig], maps: EffectMaps, stamp: Int) {
        self.key = key
        self.region = region
        self.tiles = tiles
        self.maps = maps
        self.stamp = stamp
    }
}

/// A composited tile's pixels; the same object comes back while a tile's inputs are unchanged.
final class TileResult: Sendable {
    let data: [UInt8]
    init(_ data: [UInt8]) { self.data = data }
}

private struct Checkpoint {
    var data: [UInt8]
    var empty: Bool
}

private final class TileEntry {
    var sigs: [Sig]
    /// Accumulator before step `index` (index 0 is the empty accumulator and is never stored).
    var checkpoints: OrderedMap<Int, Checkpoint>
    var result: TileResult
    var stamp: Int
    init(sigs: [Sig], checkpoints: OrderedMap<Int, Checkpoint>, result: TileResult, stamp: Int) {
        self.sigs = sigs
        self.checkpoints = checkpoints
        self.result = result
        self.stamp = stamp
    }
}

/// Coverage over the canvas (`width × height`).
final class CoveragePlane {
    let data: [Float]
    let width: Int
    let height: Int
    init(data: [Float], width: Int, height: Int) {
        self.data = data
        self.width = width
        self.height = height
    }
}

private let ZERO_TILE = TileResult([UInt8](repeating: 0, count: TILE_BYTES))

/// Statistics of the last `composite` call (for benchmarks and tests).
public struct CompositeStats: Equatable, Sendable {
    public var tiles = 0
    /// Tiles returned straight from the cache.
    public var cached = 0
    /// Steps actually run, summed over tiles.
    public var stepsRun = 0
    /// Layers whose effect maps were built over their whole region.
    public var effectsBuilt = 0
    /// Layers whose effect maps were rebuilt only around a change and patched in.
    public var effectsPatched = 0
    public init() {}
}

/// What `compositeLayerEffects` needs for a layer besides the pixels (see `RasterCompositor.effectsInput`).
public struct EffectsInput {
    public var rect: EffectRect
    public var maps: EffectMaps
    public var blend: BlendMode
    public var opacity: Double
    public var fillOpacity: Double
    public var canvas: EffectRect
    public var ctx: EffectContext
}

private func isGroup<L: CompositorLayer>(_ l: L) -> Bool { l.type == "group" }

public final class RasterCompositor<L: CompositorLayer, S: RasterSources> {
    private var tiles = OrderedMap<TileKey, TileEntry>()
    private let maxCacheBytes: Int
    private var cacheBytes = 0
    private var stamp = 0
    private var sources: S?
    private var sourcesVersion: String?
    private var filteredCache = IdentityCache<TiledSurface, OrderedMap<String, PixelSurface>>()
    private var planeCache = OrderedMap<String, CoveragePlane>()
    private let planeIds = IdentityCache<TiledSurface, Int>()
    private var nextPlaneId = 1
    private var contentCache = IdentityCache<AnyObject, [String: [UInt8]]>()
    private let propsKeyCache = IdentityCache<L, String>()
    /// Effect maps by layer id (see the module comment), least recently used first.
    private var effectCache = OrderedMap<String, EffectEntry>()
    /// Effect maps already validated in this call, by layer object.
    private var effectMemo = IdentityCache<L, (stamp: Int, maps: EffectMaps)>()
    private let patternTiles = IdentityCache<EffectPattern, PatternTile>()
    private let maskDepths = IdentityCache<TiledSurface, Int>()
    private var fxContext: EffectContext?
    public private(set) var lastStats = CompositeStats()
    private var hint = -1
    /// The `dirty` rectangles of the current call, as passed.
    private var callDirty: [DirtyRect]?
    private var callStats = CompositeStats()
    private let profile: CompositorProfile<L, S>

    public init(profile: CompositorProfile<L, S> = CompositorProfile(), options: CompositorOptions = CompositorOptions()) {
        self.profile = profile
        maxCacheBytes = options.maxCacheBytes ?? 256 * 1024 * 1024
    }

    /// Drops every cached tile and plane.
    public func clear() {
        tiles.clear()
        cacheBytes = 0
        planeCache.clear()
        filteredCache = IdentityCache()
        contentCache = IdentityCache()
        effectCache.clear()
        effectMemo = IdentityCache()
    }

    private var src: S { sources! }

    private func setSources(_ sources: S) {
        let version = "\(sources.width)x\(sources.height):\(sources.version ?? "")"
        if version != sourcesVersion {
            clear()
            sourcesVersion = version
        }
        self.sources = sources
        fxContext = nil
    }

    /// The composite of `layers` over `rect` as `rect.width × rect.height` RGBA (straight alpha).
    public func composite(_ layers: [L], _ rect: RasterRect, _ sources: S, _ options: CompositeCallOptions = CompositeCallOptions()) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: Swift.max(0, rect.width * rect.height * 4))
        compositeTiles(layers, rect, sources, { tx, ty, data, _ in
            let ox = tx * TILE
            let oy = ty * TILE
            let x0 = Swift.max(rect.x, ox)
            let y0 = Swift.max(rect.y, oy)
            let x1 = Swift.min(rect.x + rect.width, ox + TILE)
            let y1 = Swift.min(rect.y + rect.height, oy + TILE)
            let span = (x1 - x0) * 4
            for y in y0..<y1 {
                let s = ((y - oy) * TILE + (x0 - ox)) * 4
                let d = ((y - rect.y) * rect.width + (x0 - rect.x)) * 4
                for k in 0..<span { out[d + k] = data[s + k] }
            }
        }, options)
        return out
    }

    /**
     * Composites every tile intersecting `rect` and calls `onTile` with each tile's RGBA buffer
     * (TILE × TILE) and whether it changed since the last call (a tile whose inputs did not change
     * comes back from the cache).
     */
    public func compositeTiles(_ layers: [L], _ rect: RasterRect, _ sources: S, _ onTile: (_ tx: Int, _ ty: Int, _ data: [UInt8], _ changed: Bool) -> Void, _ options: CompositeCallOptions = CompositeCallOptions()) {
        setSources(sources)
        let steps = buildSteps(layers)
        hint = options.checkpointLayerId.map { stepIndexOf(steps, $0) } ?? -1
        stamp += 1
        callDirty = options.dirty
        callStats = CompositeStats()
        // A change reaches as far as the effects of any layer reach.
        let grow = options.dirty != nil ? effectsReach(layers) : 0
        let dirty = grow > 0 ? options.dirty!.map { inflateDirty($0, Double(grow)) } : options.dirty
        for (tx, ty) in tilesInRect(rect) {
            callStats.tiles += 1
            let before = tiles.get(tileKey(tx, ty))?.result
            let data = compositeTile(steps, tx, ty, dirty.flatMap { dirtyInTile($0, tx, ty) })
            onTile(tx, ty, data.data, data !== before)
        }
        lastStats = callStats
        evict()
    }

    /// The composite of one tile (cached).
    public func tile(_ layers: [L], _ tx: Int, _ ty: Int, _ sources: S) -> [UInt8] {
        setSources(sources)
        stamp += 1
        callStats = CompositeStats()
        callStats.tiles = 1
        hint = -1
        callDirty = nil
        let data = compositeTile(buildSteps(layers), tx, ty, nil)
        lastStats = callStats
        evict()
        return data.data
    }

    /**
     * A layer's effective mask coverage (0..1, after density, feather or parametric evaluation)
     * over `r` in document space, or `nil` when it reveals all of `r`.
     */
    public func maskCoverage(_ layer: L, _ r: RasterRect, _ sources: S) -> [Float]? {
        setSources(sources)
        return maskTile(layer, r)
    }

    /**
     * For the float compositor: everything `compositeLayerEffects` needs for `layer` over `r` but
     * the pixels (the area its effects reach inside `r`, the effect maps built from its 8-bit
     * shape, blend, opacities, canvas and context), or `nil` when nothing reaches `r`.
     */
    public func effectsInput(_ layer: L, _ r: RasterRect, _ sources: S) -> EffectsInput? {
        setSources(sources)
        let maps = effectMapsOf(layer)
        guard let rect = effectArea(layer, maps, r) else { return nil }
        return EffectsInput(
            rect: rect,
            maps: maps,
            blend: isGroup(layer) ? layer.blend.drawMode : contentBlend(layer),
            opacity: layer.opacity,
            fillOpacity: isPixel(layer) ? (layer.fillOpacity ?? 1) : 1,
            canvas: RasterRect(x: 0, y: 0, width: src.width, height: src.height),
            ctx: effectContext()
        )
    }

    // MARK: Steps

    /// Pixel layers, and the layer kinds the profile composites like them.
    func isPixel(_ l: L) -> Bool {
        l.type == "pixel" || (profile.isPixelLike?(l) ?? false)
    }

    func isFilter(_ l: L) -> Bool {
        profile.isFilterLayer?(l) ?? false
    }

    /**
     * Groups a layer list into compositing steps: clipped layers join the nearest unclipped
     * content or group layer below; consecutive unclipped filter layers form one run.
     */
    func buildSteps(_ layers: [L]) -> [Step<L>] {
        var steps: [Step<L>] = []
        for layer in layers {
            let last = steps.last
            if layer.clipped, let last, last.kind == .content || last.kind == .group {
                last.clipped.append(layer)
                continue
            }
            if isFilter(layer) {
                if let last, last.kind == .adjust { last.layers.append(layer) } else { steps.append(Step(adjust: [layer])) }
            } else if isGroup(layer) {
                steps.append(Step(group: layer, steps: buildSteps(layer.children ?? [])))
            } else {
                steps.append(Step(content: layer))
            }
        }
        return steps
    }

    /// The index of the top-level step that holds layer `id` (searching groups and clipped layers), or -1.
    private func stepIndexOf(_ steps: [Step<L>], _ id: String) -> Int {
        func holds(_ l: L) -> Bool { l.id == id || (isGroup(l) && (l.children ?? []).contains(where: holds)) }
        return steps.firstIndex { s in s.kind == .adjust ? s.layers.contains(where: holds) : holds(s.layer!) || s.clipped.contains(where: holds) } ?? -1
    }

    /// Properties of a layer that change pixels, minus its surfaces (memoised per object).
    private func propsKey(_ layer: L) -> String {
        if let key = propsKeyCache.get(layer) { return key }
        let mask: JSONValue = layer.mask.map { m in
            .array([.bool(m.enabled != false), .number(m.density ?? 1), .number(m.feather ?? 0), .number(Double(m.defaultValue)), m.source ?? .null])
        } ?? .null
        var base: [JSONValue] = [.string(layer.type), .string(layer.id), .bool(layer.visible), .number(layer.opacity), .string(layer.blend.rawValue), .bool(layer.clipped), mask]
        if isPixel(layer) { base += [.number(Double(layer.offset?.x ?? 0)), .number(Double(layer.offset?.y ?? 0)), .number(layer.fillOpacity ?? 1)] }
        if hasEffects(layer) { base.append(.string(effectsFingerprint(layer.effects))) }
        if let edge = layer.edge { base.append(edge.json) }
        if let extra = profile.layerKey?(layer) { base.append(extra) }
        let key = JSONValue.array(base).stringified()
        propsKeyCache.set(layer, key)
        return key
    }

    private func compositeTile(_ steps: [Step<L>], _ tx: Int, _ ty: Int, _ dirty: RasterRect?) -> TileResult {
        let key = tileKey(tx, ty)
        let entry = tiles.get(key)
        let sigs = steps.map { stepSig($0, tx, ty) }
        var first = 0
        if let entry {
            while first < sigs.count && first < entry.sigs.count && sameSig(entry.sigs[first], sigs[first]) { first += 1 }
            if (first == sigs.count && first == entry.sigs.count) || changedOnlyNearby(steps, sigs, entry, dirty) {
                entry.sigs = sigs
                entry.stamp = stamp
                callStats.cached += 1
                return entry.result
            }
        }
        // Resume from the best checkpoint at or below the first changed step.
        var start = 0
        var base: Checkpoint? = nil
        if let entry {
            for (index, cp) in entry.checkpoints where index <= first && index > start {
                start = index
                base = cp
            }
        }
        let tileRect = RasterRect(x: tx * TILE, y: ty * TILE, width: TILE, height: TILE)
        let hint = self.hint
        var checkpoints = OrderedMap<Int, Checkpoint>()
        if let entry { for (index, cp) in entry.checkpoints where index <= start { checkpoints.set(index, cp) } }
        var result: TileResult

        if let entry, let r = dirty, r.width < TILE || r.height < TILE {
            // Only `dirty` changed: recomposite that part from the checkpoint and patch the previous result.
            var acc = [UInt8](repeating: 0, count: r.width * r.height * 4)
            if let b = base {
                for y in 0..<r.height {
                    let s = ((r.y - tileRect.y + y) * TILE + (r.x - tileRect.x)) * 4
                    for k in 0..<(r.width * 4) { acc[y * r.width * 4 + k] = b.data[s + k] }
                }
            }
            var empty = base?.empty ?? true
            for i in start..<steps.count {
                empty = runStep(steps[i], &acc, empty, r)
                callStats.stepsRun += 1
            }
            var data = entry.result.data
            for y in 0..<r.height {
                let d = ((r.y - tileRect.y + y) * TILE + (r.x - tileRect.x)) * 4
                for k in 0..<(r.width * 4) { data[d + k] = acc[y * r.width * 4 + k] }
            }
            result = TileResult(data)
        } else {
            var acc = base?.data ?? [UInt8](repeating: 0, count: TILE_BYTES)
            var empty = base?.empty ?? true
            for i in start..<steps.count {
                if (i == first || i == hint) && i > 0 && !checkpoints.has(i) { checkpoints.set(i, Checkpoint(data: acc, empty: empty)) }
                empty = runStep(steps[i], &acc, empty, tileRect)
                callStats.stepsRun += 1
            }
            result = empty ? ZERO_TILE : TileResult(acc)
        }
        // Keep few checkpoints: below the active layer, below the step that changed, and the newest.
        if checkpoints.count > 2 {
            let keys = checkpoints.keys.sorted()
            let keep: Set<Int> = [keys[keys.count - 1], first, hint]
            for k in keys where !keep.contains(k) { checkpoints.delete(k) }
        }
        let prevBytes = entry.map(entryBytes) ?? 0
        let next = TileEntry(sigs: sigs, checkpoints: checkpoints, result: result, stamp: stamp)
        tiles.set(key, next)
        cacheBytes += entryBytes(next) - prevBytes
        return result
    }

    /**
     * Whether a tile with no part in this call's (grown) `dirty` rectangles changed only in what local
     * effects read beyond it: every changed step is a pixel layer with local effects whose changes stay
     * inside `dirty` (and so are farther than its margin), which leaves the tile's pixels as they were.
     */
    private func changedOnlyNearby(_ steps: [Step<L>], _ sigs: [Sig], _ entry: TileEntry, _ dirty: RasterRect?) -> Bool {
        if callDirty == nil || dirty != nil || entry.stamp != stamp - 1 || sigs.count != entry.sigs.count { return false }
        for (i, step) in steps.enumerated() {
            if sameSig(entry.sigs[i], sigs[i]) { continue }
            if step.kind != .content || entry.sigs[i].key != sigs[i].key { return false }
            let layer = step.layer!
            if !(hasEffects(layer) && effectsAreLocal(activeEffectItems(layer.effects)) && dirtyCoversShape(layer) && step.clipped.allSatisfy(dirtyCoversShape)) { return false }
        }
        return true
    }

    private func entryBytes(_ e: TileEntry) -> Int {
        var n = e.result === ZERO_TILE ? 0 : TILE_BYTES
        for (_, cp) in e.checkpoints { n += cp.data.count }
        return n
    }

    private func evict() {
        if cacheBytes <= maxCacheBytes { return }
        // Drop checkpoints first (oldest tiles first), then whole entries not used this call.
        let entries = Array(tiles).enumerated().sorted { $0.element.value.stamp != $1.element.value.stamp ? $0.element.value.stamp < $1.element.value.stamp : $0.offset < $1.offset }.map(\.element)
        for (_, e) in entries {
            if cacheBytes <= maxCacheBytes { return }
            for (_, cp) in e.checkpoints { cacheBytes -= cp.data.count }
            e.checkpoints.clear()
        }
        for (k, e) in entries {
            if cacheBytes <= maxCacheBytes { return }
            if e.stamp == stamp { continue }
            cacheBytes -= entryBytes(e)
            tiles.delete(k)
        }
    }

    // MARK: Signatures

    private func stepSig(_ step: Step<L>, _ tx: Int, _ ty: Int) -> Sig {
        if step.kind == .adjust {
            var refs: [SigRef] = []
            var key = "A"
            for l in step.layers {
                key += propsKey(l)
                refs += maskRefs(l, tx, ty, 0, 0)
            }
            return Sig(key: key, refs: refs)
        }
        let own = step.kind == .content ? contentSig(step.layer!, tx, ty) : groupSig(step.layer!, step.steps, tx, ty)
        if step.clipped.isEmpty { return own }
        var refs = own.refs
        var key = own.key
        for c in step.clipped {
            let s = layerSig(c, tx, ty)
            key += "|" + s.key
            refs += s.refs
        }
        return Sig(key: key, refs: refs)
    }

    private func layerSig(_ layer: L, _ tx: Int, _ ty: Int) -> Sig {
        if isFilter(layer) { return Sig(key: propsKey(layer), refs: maskRefs(layer, tx, ty, 0, 0)) }
        if isGroup(layer) { return groupSig(layer, buildSteps(layer.children ?? []), tx, ty) }
        return contentSig(layer, tx, ty)
    }

    private func groupSig(_ group: L, _ steps: [Step<L>], _ tx: Int, _ ty: Int) -> Sig {
        if group.visible && hasEffects(group) { return effectSig(group, tx, ty) }
        return plainGroupSig(group, steps, tx, ty)
    }

    private func plainGroupSig(_ group: L, _ steps: [Step<L>], _ tx: Int, _ ty: Int) -> Sig {
        var key = "G" + propsKey(group)
        var refs = maskRefs(group, tx, ty, 0, 0)
        if !group.visible { return Sig(key: key, refs: refs) }
        for s in steps {
            let sig = stepSig(s, tx, ty)
            key += "[" + sig.key + "]"
            refs += sig.refs
        }
        return Sig(key: key, refs: refs)
    }

    private func contentSig(_ layer: L, _ tx: Int, _ ty: Int) -> Sig {
        if layer.visible && hasEffects(layer) { return effectSig(layer, tx, ty) }
        return plainContentSig(layer, tx, ty)
    }

    private func plainContentSig(_ layer: L, _ tx: Int, _ ty: Int) -> Sig {
        let key = "C" + propsKey(layer)
        if !layer.visible { return Sig(key: key, refs: []) }
        if !isPixel(layer) { return Sig(key: key, refs: maskRefs(layer, tx, ty, 0, 0)) }
        let (surface, dx, dy, _) = layerPixels(layer)
        var refs: [SigRef] = [.number(Double(surface.defaultValue))]
        let r = RasterRect(x: tx * TILE - dx, y: ty * TILE - dy, width: TILE, height: TILE)
        for t in tilesInRect(r) { refs.append(.tile(surface.getTile(t.tx, t.ty))) }
        refs += maskRefs(layer, tx, ty, layer.offset?.x ?? 0, layer.offset?.y ?? 0)
        return Sig(key: key, refs: refs)
    }

    // MARK: Layer effects

    private func hasEffects(_ layer: L) -> Bool {
        hasActiveEffects(layer.effects) && !isFilter(layer)
    }

    /// The largest effects margin of any visible layer in the stack.
    private func effectsReach(_ layers: [L]) -> Int {
        var m = 0
        func walk(_ list: [L]) {
            for l in list where l.visible {
                if hasEffects(l) { m = Swift.max(m, effectsMargin(l.effects)) }
                if let c = l.children { walk(c) }
            }
        }
        walk(layers)
        return m
    }

    private func effectContext() -> EffectContext {
        if let fxContext { return fxContext }
        let sources = src
        let tiles = patternTiles
        let ctx = EffectContext(light: sources.globalLight ?? DEFAULT_GLOBAL_LIGHT) { id in
            guard let p = sources.pattern(id) ?? builtinPattern(id), p.width > 0 && p.height > 0, p.data.count >= p.width * p.height * 4 else { return nil }
            if let t = tiles.get(p) { return t }
            let t = PatternTile(p)
            tiles.set(p, t)
            return t
        }
        fxContext = ctx
        return ctx
    }

    /**
     * Where a layer's effect maps are built: its bounds (pixel layers; the canvas otherwise) grown by
     * the effects' margin, within the canvas grown the same.
     */
    private func effectRegion(_ layer: L) -> RasterRect {
        let m = effectsMargin(layer.effects)
        let canvas = RasterRect(x: -m, y: -m, width: src.width + 2 * m, height: src.height + 2 * m)
        if !isPixel(layer) { return canvas }
        let (surface, dx, dy, _) = layerPixels(layer)
        if surface.defaultValue != 0 { return canvas }
        guard let b = surface.bounds else { return RasterRect(x: 0, y: 0, width: 0, height: 0) }
        return intersectRect(RasterRect(x: b.x + dx - m, y: b.y + dy - m, width: b.width + 2 * m, height: b.height + 2 * m), canvas)
    }

    /// The signature of a layer's shape (its surface tiles and mask refs) per tile of `region`.
    private func shapeSigs(_ layer: L, _ region: RasterRect) -> (keys: [TileKey], sigs: [TileKey: Sig]) {
        var sigs: [TileKey: Sig] = [:]
        var keys: [TileKey] = []
        if region.width <= 0 || region.height <= 0 { return (keys, sigs) }
        let steps = isGroup(layer) ? buildSteps(layer.children ?? []) : nil
        for t in tilesInRect(region) {
            let k = tileKey(t.tx, t.ty)
            keys.append(k)
            sigs[k] = steps.map { plainGroupSig(layer, $0, t.tx, t.ty) } ?? plainContentSig(layer, t.tx, t.ty)
        }
        return (keys, sigs)
    }

    /// The surface tiles (and mask refs) a layer's shape reads over `region`.
    private func shapeRefs(_ layer: L, _ region: RasterRect) -> [SigRef] {
        let (keys, sigs) = shapeSigs(layer, region)
        return keys.flatMap { sigs[$0]!.refs }
    }

    private func lightKey() -> String {
        let l = effectContext().light
        return "\(formatNumber(l.angle)),\(formatNumber(l.altitude))"
    }

    /**
     * The signature of a layer with effects for tile (tx, ty): its properties and the tiles its shape
     * reads within the effects' margin around the tile, or over its whole region when an effect is
     * laid out over the layer's bounds.
     */
    private func effectSig(_ layer: L, _ tx: Int, _ ty: Int) -> Sig {
        let key = (isGroup(layer) ? "Gfx" : "Cfx") + propsKey(layer) + lightKey()
        let region = effectRegion(layer)
        let m = effectsMargin(layer.effects)
        // Local maps over the tile do not depend on how far the region reaches (it is zero beyond the
        // shape); maps laid out over the layer's bounds do.
        if effectsAreLocal(activeEffectItems(layer.effects)) {
            return Sig(key: key, refs: shapeRefs(layer, intersectRect(RasterRect(x: tx * TILE - m, y: ty * TILE - m, width: TILE + 2 * m, height: TILE + 2 * m), region)))
        }
        return Sig(key: key, refs: [.string("\(region.x),\(region.y),\(region.width),\(region.height)")] + shapeRefs(layer, region))
    }

    /// A layer's effect maps over its region (cached; see the module comment).
    private func effectMapsOf(_ layer: L) -> EffectMaps {
        if let memo = effectMemo.get(layer), memo.stamp == stamp { return memo.maps }
        let region = effectRegion(layer)
        let key = propsKey(layer) + lightKey()
        let (_, tiles) = shapeSigs(layer, region)
        let hit = effectCache.get(layer.id)
        effectCache.delete(layer.id)
        let entry: EffectEntry
        if let hit, hit.key == key, hit.region == region, tiles.allSatisfy({ sameSig(hit.tiles[$0.key], $0.value) }) {
            entry = hit
        } else {
            let items = activeEffectItems(layer.effects)
            let ctx = effectContext()
            var maps: EffectMaps? = nil
            if let hit, hit.key == key, items.allSatisfy({ effectReach($0) <= MAX_EFFECT_REACH }) {
                let changed = shapeChanges(layer, hit, tiles, region)
                maps = patchEffectMaps(hit.maps, items, region, changed, effectsMargin(layer.effects), { self.layerShape(layer, $0) }, ctx)
            }
            if maps != nil { callStats.effectsPatched += 1 } else { callStats.effectsBuilt += 1 }
            entry = EffectEntry(key: key, region: region, tiles: tiles, maps: maps ?? buildEffectMaps(items, layerShape(layer, region), region, ctx), stamp: 0)
        }
        entry.stamp = stamp
        effectCache.set(layer.id, entry)
        if entry !== hit {
            var bytes = 0
            for (_, e) in effectCache { bytes += e.maps.bytes }
            while effectCache.count > 1 && (effectCache.count > 32 || bytes > maxCacheBytes / 2) {
                let (oldest, e) = effectCache.first!
                bytes -= e.maps.bytes
                effectCache.delete(oldest)
            }
        }
        effectMemo.set(layer, (stamp, entry.maps))
        return entry.maps
    }

    /**
     * Where a layer's shape may differ from the one `prev` was built from: the tiles whose signature
     * changed (a tile new to the region that reads nothing did not), narrowed to this call's `dirty`
     * rectangles when `prev` is from the previous call and they cover every change of the shape.
     */
    private func shapeChanges(_ layer: L, _ prev: EffectEntry, _ tiles: [TileKey: Sig], _ region: RasterRect) -> [RasterRect] {
        var out: [RasterRect] = []
        for (tx, ty) in tilesInRect(region) {
            let sig = tiles[tileKey(tx, ty)]!
            if let old = prev.tiles[tileKey(tx, ty)] {
                if sameSig(old, sig) { continue }
            } else if sig.refs.allSatisfy({ $0 == .null || $0 == .number(0) }) {
                continue
            }
            let r = intersectRect(RasterRect(x: tx * TILE, y: ty * TILE, width: TILE, height: TILE), region)
            if r.width > 0 && r.height > 0 { out.append(r) }
        }
        guard let dirty = callDirty, prev.stamp == stamp - 1, dirtyCoversShape(layer) else { return out }
        var narrowed: [RasterRect] = []
        for r in out {
            for d in dirty {
                let fx = Int(JS.floor(d.x)), fy = Int(JS.floor(d.y))
                let a = intersectRect(r, RasterRect(x: fx, y: fy, width: Int(JS.ceil(d.x + d.width)) - fx, height: Int(JS.ceil(d.y + d.height)) - fy))
                if a.width > 0 && a.height > 0 { narrowed.append(a) }
            }
        }
        return narrowed
    }

    /**
     * Whether a change to a layer stays inside the `dirty` rectangles that name it: a pixel layer
     * without filters or a feathered or parametric mask (those spread a change beyond it).
     */
    private func dirtyCoversShape(_ layer: L) -> Bool {
        if !isPixel(layer) || profile.pixelFilters?(layer) != nil { return false }
        guard let mask = layer.mask else { return true }
        return mask.enabled == false || (mask.source == nil && !((mask.feather ?? 0) > 0))
    }

    /// A layer's alpha over `r` after its mask (0..1, quantised to bytes as tiles see it).
    private func layerShape(_ layer: L, _ r: RasterRect) -> [Float] {
        let n = r.width * r.height
        var shape = [Float](repeating: 0, count: Swift.max(0, n))
        if n <= 0 { return shape }
        guard let rgba = ownPixels(layer, r) else { return shape }
        for i in 0..<n { shape[i] = Float(Double(rgba[i * 4 + 3]) / 255) }
        return shape
    }

    /// A content or group layer's own pixels over `r` with its mask applied to alpha, or `nil` when empty.
    private func ownPixels(_ layer: L, _ r: RasterRect) -> [UInt8]? {
        var rgba: [UInt8]
        if isGroup(layer) {
            var buf = [UInt8](repeating: 0, count: r.width * r.height * 4)
            if runSteps(buildSteps(layer.children ?? []), &buf, true, r) { return nil }
            rgba = buf
        } else {
            guard let content = contentTile(layer, r) else { return nil }
            rgba = content
        }
        if let cov = maskTile(layer, r) {
            var p = 3
            for i in 0..<cov.count {
                rgba[p] = JS.u8c(JS.round(Double(rgba[p]) * Double(cov[i])))
                p += 4
            }
        }
        return rgba
    }

    /**
     * The part of `r` a layer with effects can change: its shape's bounds grown by the effects'
     * margin. Beyond it the layer and every effect are transparent, so the backdrop stays as it is.
     */
    private func effectArea(_ layer: L, _ maps: EffectMaps, _ r: RasterRect) -> RasterRect? {
        guard let b = maps.bounds else { return nil }
        let a = intersectRect(inflateRect(b, effectsMargin(layer.effects)), r)
        return a.width > 0 && a.height > 0 ? a : nil
    }

    /**
     * Composites `layer`'s pixels (with `clipped` applied) and its effects onto `acc` (RGBA over `r`),
     * only where they can reach. `keepAlpha`: clipped layers keep the base's alpha.
     */
    private func compositeEffects(_ layer: L, _ clipped: [L], _ acc: inout [UInt8], _ r: RasterRect, _ keepAlpha: Bool) -> Bool {
        let maps = effectMapsOf(layer)
        guard let a = effectArea(layer, maps, r) else { return false }
        let whole = a.width == r.width && a.height == r.height
        var sub = whole ? acc : copyRect(acc, r, a)
        var content = ownPixels(layer, a) ?? [UInt8](repeating: 0, count: a.width * a.height * 4)
        if !clipped.isEmpty { applyClipped(clipped, &content, a) }
        let keep: [UInt8]? = keepAlpha ? stride(from: 3, to: sub.count, by: 4).map { sub[$0] } : nil
        let blend = isGroup(layer) ? layer.blend.drawMode : contentBlend(layer)
        var input = EffectCompositeInput(
            backdrop: .bytes(sub), content: .bytes(content), rect: a, maps: maps, blend: blend, opacity: layer.opacity,
            fillOpacity: isPixel(layer) ? (layer.fillOpacity ?? 1) : 1,
            canvas: RasterRect(x: 0, y: 0, width: src.width, height: src.height), ctx: effectContext()
        )
        compositeLayerEffects(&input)
        sub = input.backdrop.bytes!
        if let keep { for i in 0..<keep.count { sub[i * 4 + 3] = keep[i] } }
        if whole { acc = sub } else { pasteRect(&acc, r, sub, a) }
        return true
    }

    /// Composites a layer with active effects onto `acc` over `r`; returns whether `acc` is still empty.
    private func runEffectStep(_ layer: L, _ clipped: [L], _ acc: inout [UInt8], _ empty: Bool, _ r: RasterRect) -> Bool {
        compositeEffects(layer, clipped, &acc, r, false) ? false : empty
    }

    private func maskRefs(_ layer: L, _ tx: Int, _ ty: Int, _ ox: Int, _ oy: Int) -> [SigRef] {
        guard let mask = layer.mask, mask.enabled != false else { return [] }
        if mask.source != nil || (mask.feather ?? 0) > 0 { return [.object(planeFor(mask, ox, oy))] }
        return tilesInRect(RasterRect(x: tx * TILE - ox, y: ty * TILE - oy, width: TILE, height: TILE)).map { .tile(mask.surface.getTile($0.tx, $0.ty)) }
    }

    // MARK: Layer pixels

    /**
     * A pixel layer's pixels after spatial filters: the surface and the offset to apply. Layers
     * with a spatial filter are filtered once over the canvas (in document space, offset 0).
     */
    private func layerPixels(_ layer: L) -> (surface: PixelSurface, dx: Int, dy: Int, perPixel: PixelFilterSpec?) {
        let raw = src.surfaceOf(layer) ?? layer.surface ?? emptySurface(4)
        let ox = layer.offset?.x ?? 0
        let oy = layer.offset?.y ?? 0
        let filters = profile.pixelFilters?(layer)
        guard let filters, filters.spatial else { return (raw, ox, oy, filters) }
        let fkey = "\(ox),\(oy):\(filters.key)"
        var byKey = filteredCache.get(raw) ?? OrderedMap()
        if let filtered = byKey.get(fkey) { return (filtered, 0, 0, nil) }
        let filtered = filterOverCanvas(raw, ox, oy, filters, src.width, src.height)
        byKey.clear()
        byKey.set(fkey, filtered)
        filteredCache.set(raw, byKey)
        return (filtered, 0, 0, nil)
    }

    /// RGBA of a content layer over `r` (document space, inside one tile), or `nil` when it has nothing there.
    private func contentTile(_ layer: L, _ r: RasterRect) -> [UInt8]? {
        if !isPixel(layer) { return profile.contentTile?(layer, r, src) }
        let (surface, dx, dy, perPixel) = layerPixels(layer)
        let srcRect = RasterRect(x: r.x - dx, y: r.y - dy, width: r.width, height: r.height)
        let covered = tilesInRect(srcRect).map { surface.getTile($0.tx, $0.ty) }
        if surface.defaultValue == 0 && covered.allSatisfy({ $0 == nil }) { return nil }
        let aligned = r.width == TILE && r.height == TILE && jsMod(Double(srcRect.x), Double(TILE)) == 0 && jsMod(Double(srcRect.y), Double(TILE)) == 0
        guard let perPixel else {
            if aligned, let t = covered[0] { return t.data }
            return readRegion(surface, srcRect)
        }
        // Per-pixel filters: cache the filtered tile by its source tile and the filter settings.
        let fkey = "\(dx),\(dy):\(perPixel.key)"
        let anchor: AnyObject = (covered.first(where: { $0 != nil }) ?? nil) ?? surface
        let refsKey = "\(r.x),\(r.y):\(fkey)"
        if aligned, let hit = contentCache.get(anchor)?[refsKey] { return hit }
        var data = readRegion(surface, srcRect)
        perPixel.apply(&data, r.width, r.height)
        if aligned {
            var byKey = contentCache.get(anchor) ?? [:]
            byKey[refsKey] = data
            contentCache.set(anchor, byKey)
        }
        return data
    }

    // MARK: Masks

    private func planeKey(_ mask: RasterMask, _ ox: Int, _ oy: Int) -> String {
        let W = src.width
        let H = src.height
        let id: Int
        if let known = planeIds.get(mask.surface) {
            id = known
        } else {
            id = nextPlaneId
            nextPlaneId += 1
            planeIds.set(mask.surface, id)
        }
        return "\(id):\(ox),\(oy):\(W)x\(H):\(formatNumber(mask.feather ?? 0)):\(formatNumber(mask.density ?? 1)):\(mask.source.map { $0.stringified() } ?? "")"
    }

    /// Canvas-sized coverage of a feathered or parametric mask (cached).
    private func planeFor(_ mask: RasterMask, _ ox: Int, _ oy: Int) -> CoveragePlane {
        let key = planeKey(mask, ox, oy)
        if let plane = planeCache.get(key) {
            planeCache.delete(key)
            planeCache.set(key, plane)
            return plane
        }
        let W = src.width
        let H = src.height
        var v = [Float](repeating: 0, count: W * H)
        if let source = mask.source {
            let generated = profile.maskSourcePlane?(source, W, H, src)
            if let generated, generated.count == W * H { v = generated } else { v = [Float](repeating: 1, count: W * H) }
        } else {
            let bytes = readRegion(mask.surface, RasterRect(x: -ox, y: -oy, width: W, height: H))
            for i in 0..<v.count { v[i] = Float(Double(bytes[i]) / 255) }
        }
        let feather = mask.feather ?? 0
        if feather > 0 { v = gaussianBlur(v, W, H, feather, .clamp) }
        let density = mask.density ?? 1
        if density != 1 { for i in 0..<v.count { v[i] = Float(1 - density * (1 - Double(v[i]))) } }
        let plane = CoveragePlane(data: v, width: W, height: H)
        planeCache.set(key, plane)
        while planeCache.count > 8 { planeCache.delete(planeCache.first!.key) }
        return plane
    }

    private func maskDepth(_ surface: TiledSurface) -> Int {
        if let d = maskDepths.get(surface) { return d }
        let d = surfaceDepth(surface)
        maskDepths.set(surface, d)
        return d
    }

    private func maskTile(_ layer: L, _ r: RasterRect) -> [Float]? {
        guard let mask = layer.mask, mask.enabled != false else { return nil }
        let ox = isPixel(layer) ? (layer.offset?.x ?? 0) : 0
        let oy = isPixel(layer) ? (layer.offset?.y ?? 0) : 0
        let n = r.width * r.height
        var out = [Float](repeating: 0, count: Swift.max(0, n))
        let density = mask.density ?? 1
        if mask.source != nil || (mask.feather ?? 0) > 0 {
            let plane = planeFor(mask, ox, oy)
            let W = plane.width
            let H = plane.height
            // Outside the canvas the mask holds its default (feathering clamps at the canvas edge).
            let outside = mask.source != nil ? 1 : 1 - density * (1 - Double(mask.defaultValue) / 255)
            out = [Float](repeating: Float(outside), count: Swift.max(0, n))
            let x0 = Swift.max(0, r.x)
            let y0 = Swift.max(0, r.y)
            let x1 = Swift.min(W, r.x + r.width)
            let y1 = Swift.min(H, r.y + r.height)
            if y1 > y0 && x1 > x0 {
                for y in y0..<y1 {
                    let s = y * W
                    let d = (y - r.y) * r.width - r.x
                    for x in x0..<x1 { out[d + x] = plane.data[s + x] }
                }
            }
        } else {
            let rect = RasterRect(x: r.x - ox, y: r.y - oy, width: r.width, height: r.height)
            var all = true
            if maskDepth(mask.surface) != 8 {
                // A 16- or 32-bit mask: coverage from its deep samples.
                let d = readDeepRegion32(mask.surface, rect)
                for i in 0..<n {
                    let v = d[i] <= 0 ? 0 : d[i] >= 1 ? 1 : d[i]
                    out[i] = v
                    if v != 1 { all = false }
                }
            } else {
                let bytes = readRegion(mask.surface, rect)
                for i in 0..<n {
                    out[i] = Float(Double(bytes[i]) / 255)
                    if bytes[i] != 255 { all = false }
                }
            }
            if all { return nil }
            if density != 1 { for i in 0..<n { out[i] = Float(1 - density * (1 - Double(out[i]))) } }
        }
        return out
    }

    // MARK: Running steps

    /// Runs one step onto `acc`; returns whether `acc` is still empty.
    private func runStep(_ step: Step<L>, _ acc: inout [UInt8], _ empty: Bool, _ r: RasterRect) -> Bool {
        if step.kind == .adjust {
            if empty { return true }
            applyFilterRun(step.layers, &acc, r)
            return false
        }
        let layer = step.layer!
        if !layer.visible { return empty }
        let clipped = step.clipped.filter(\.visible)
        // Effects can reach into a tile the layer's mask hides.
        if hasEffects(layer) { return runEffectStep(layer, clipped, &acc, empty, r) }
        let coverage = maskTile(layer, r)
        if let coverage, coverage.allSatisfy({ $0 <= 0 }) { return empty }
        if step.kind == .group {
            if layer.blend == .passThrough && clipped.isEmpty {
                if layer.opacity >= 1 && coverage == nil { return runSteps(step.steps, &acc, empty, r) }
                let before = acc
                let stillEmpty = runSteps(step.steps, &acc, empty, r)
                lerpTile(&acc, before, layer.opacity, coverage)
                return empty && stillEmpty
            }
            var buf = [UInt8](repeating: 0, count: acc.count)
            if runSteps(step.steps, &buf, true, r) { return empty }
            applyClipped(clipped, &buf, r)
            return blendOnto(&acc, buf, empty, layer.blend.drawMode, layer.opacity, coverage)
        }
        guard var content = contentTile(layer, r) else { return empty }
        // The live edge cast needs something behind the layer, or a fixed colour.
        let ambient = layer.edge?.ambient ?? 0
        if ambient > 0 && (!empty || layer.edge?.ambientColor != nil) {
            applyEdgeAmbient(&content, acc, coverage, ambient, layer.edge?.ambientColor, 255)
        }
        let fill = isPixel(layer) ? (layer.fillOpacity ?? 1) : 1
        let blend = contentBlend(layer)
        if clipped.isEmpty { return blendOnto(&acc, content, empty, blend, layer.opacity * fill, coverage) }
        // Clipping group: the base (with its mask and fill) is the shape the clipped layers paint in.
        var buf = [UInt8](repeating: 0, count: acc.count)
        blendTile(&buf, content, .normal, fill, coverage)
        applyClipped(clipped, &buf, r)
        return blendOnto(&acc, buf, empty, blend, layer.opacity, nil)
    }

    private func runSteps(_ steps: [Step<L>], _ acc: inout [UInt8], _ emptyIn: Bool, _ r: RasterRect) -> Bool {
        var empty = emptyIn
        for s in steps { empty = runStep(s, &acc, empty, r) }
        return empty
    }

    private func contentBlend(_ layer: L) -> BlendMode {
        profile.contentBlend?(layer) ?? layer.blend.drawMode
    }

    private func blendOnto(_ acc: inout [UInt8], _ src: [UInt8], _ empty: Bool, _ mode: BlendMode, _ alpha: Double, _ coverage: [Float]?) -> Bool {
        if !(alpha > 0) { return empty }
        if empty && mode == .normal && alpha >= 1 && coverage == nil {
            // Over a transparent accumulator a normal, opaque, unmasked layer is a plain copy (which also
            // keeps the colour of transparent pixels, as a single-layer render always has).
            acc = src
            return false
        }
        blendTile(&acc, src, mode, alpha, coverage)
        return false
    }

    private func applyClipped(_ clipped: [L], _ buf: inout [UInt8], _ r: RasterRect) {
        var run: [L] = []
        func flush() {
            if !run.isEmpty { applyFilterRun(run, &buf, r) }
            run = []
        }
        for c in clipped {
            if isFilter(c) {
                run.append(c)
                continue
            }
            flush()
            if hasEffects(c) && !isGroup(c) {
                // Clipped to the base: the layer and its effects composite, then the base's alpha is kept.
                _ = compositeEffects(c, [], &buf, r, true)
                continue
            }
            let coverage = maskTile(c, r)
            if isGroup(c) {
                var inner = [UInt8](repeating: 0, count: buf.count)
                if runSteps(buildSteps(c.children ?? []), &inner, true, r) { continue }
                blendAtop(&buf, inner, c.blend.drawMode, c.opacity, coverage)
                continue
            }
            guard let content = contentTile(c, r) else { continue }
            let fill = isPixel(c) ? (c.fillOpacity ?? 1) : 1
            blendAtop(&buf, content, contentBlend(c), c.opacity * fill, coverage)
        }
        flush()
    }

    private func applyFilterRun(_ layers: [L], _ acc: inout [UInt8], _ r: RasterRect) {
        var visible: [L] = []
        var masks: [String: [Float]]? = nil
        for node in layers where node.visible {
            if let cov = maskTile(node, r) {
                if cov.allSatisfy({ $0 <= 0 }) { continue }
                if masks == nil { masks = [:] }
                masks![node.id] = cov
            }
            visible.append(node)
        }
        if !visible.isEmpty { profile.applyFilterRun?(visible, &acc, r, masks, src) }
    }
}

/**
 * Applies a layer's filters over the canvas rect in document space: the result is a surface at
 * offset 0 holding only canvas pixels (spatial filters clamp at the canvas edges).
 */
private func filterOverCanvas(_ surface: PixelSurface, _ ox: Int, _ oy: Int, _ filters: PixelFilterSpec, _ width: Int, _ height: Int) -> PixelSurface {
    if width <= 0 || height <= 0 { return emptySurface(4) }
    var data = readRegion(surface, RasterRect(x: -ox, y: -oy, width: width, height: height))
    filters.apply(&data, width, height)
    return surfaceFromPixels(width: width, height: height, data: data, channels: 4, x: 0, y: 0)
}

/// The part `a` of RGBA `data` over `r`, as its own buffer.
private func copyRect(_ data: [UInt8], _ r: RasterRect, _ a: RasterRect) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: a.width * a.height * 4)
    for y in 0..<a.height {
        let s = ((a.y - r.y + y) * r.width + (a.x - r.x)) * 4
        for k in 0..<(a.width * 4) { out[y * a.width * 4 + k] = data[s + k] }
    }
    return out
}

/// Writes `part` (RGBA over `a`) back into `data` (over `r`).
private func pasteRect(_ data: inout [UInt8], _ r: RasterRect, _ part: [UInt8], _ a: RasterRect) {
    for y in 0..<a.height {
        let d = ((a.y - r.y + y) * r.width + (a.x - r.x)) * 4
        for k in 0..<(a.width * 4) { data[d + k] = part[y * a.width * 4 + k] }
    }
}

private func inflateRect(_ r: RasterRect, _ m: Int) -> RasterRect {
    RasterRect(x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m)
}

private func inflateDirty(_ r: DirtyRect, _ m: Double) -> DirtyRect {
    DirtyRect(x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m)
}

func intersectRect(_ a: RasterRect, _ b: RasterRect) -> RasterRect {
    let x0 = Swift.max(a.x, b.x)
    let y0 = Swift.max(a.y, b.y)
    let x1 = Swift.min(a.x + a.width, b.x + b.width)
    let y1 = Swift.min(a.y + a.height, b.y + b.height)
    return x1 <= x0 || y1 <= y0 ? RasterRect(x: x0, y: y0, width: 0, height: 0) : RasterRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
}

/// Tiles that differ between two surfaces (by tile identity), as tile keys.
public func changedTiles(_ a: TiledSurface, _ b: TiledSurface) -> [TileKey] {
    var out: [TileKey] = []
    for (k, t) in b.tiles where a.tiles.get(k) !== t { out.append(k) }
    for k in a.tiles.keys where !b.tiles.has(k) { out.append(k) }
    return out
}
