import Foundation

/**
 * Compositing at high bit depth: the same layer model as `RasterCompositor` (pixel layers,
 * groups with pass-through, masks, clipping, blend modes, opacity and fill, filter layers) run
 * in float over the layers' deep samples (see `Deep.swift`), for exports, merges and anything else
 * that must keep 16 or 32 bits. It is uncached and meant for one-off renders. The port of
 * `raster/deep-compositor.ts`.
 *
 * Working space: straight-alpha float RGBA, sRGB-encoded 0..1 at 16 bits and linear light at 32
 * bits (as Photoshop blends in each mode). Results come back in that space.
 *
 * What it delegates to the 8-bit compositor it wraps:
 * - mask coverage (density, feather and parametric masks: deep masks are read at depth);
 * - the effect maps of layers with effects (built from the 8-bit shape); the effects themselves
 *   composite in float over the deep content (`runEffects`), and pixel filters run in float when
 *   the profile gives `pixelFiltersDeep`;
 * - filters it cannot run in float and content layers the editor draws itself (annotations):
 *   each is rendered alone at 8 bits, converted, and blended in float with its blend mode and
 *   opacity.
 */

/// A pixel layer's filters in float (see `DeepCompositorProfile.pixelFiltersDeep`).
public struct DeepPixelFilter {
    /// How many pixels each side the filters read (0 for per-pixel filters).
    public var reach: Int
    /// Filters float RGBA in the working space (`linear` at 32 bits) in place.
    public var apply: (_ data: inout [Float], _ width: Int, _ height: Int, _ linear: Bool) -> Void
    public init(reach: Int, apply: @escaping (_ data: inout [Float], _ width: Int, _ height: Int, _ linear: Bool) -> Void) {
        self.reach = reach
        self.apply = apply
    }
}

/// Float hooks of an editor's own layer kinds (see `CompositorProfile`).
public struct DeepCompositorProfile<L: CompositorLayer, S: RasterSources> {
    /**
     * Applies a run of visible filter layers to float RGBA `acc` over `r` (sRGB-encoded 0..1,
     * straight alpha; values may exceed 1 at 32 bits); `coverage` holds masked ones by id.
     * Missing: filter layers run at 8 bits.
     */
    public var applyFilterRunDeep: ((_ layers: [L], _ acc: inout [Float], _ r: RasterRect, _ coverage: [String: [Float]]?, _ sources: S) -> Void)?
    /// A pixel layer's filters in float (`nil`: none, or none it can run). Missing: filtered layers are drawn at 8 bits.
    public var pixelFiltersDeep: ((L) -> DeepPixelFilter?)?
    public init() {}
}

public final class DeepCompositor<L: CompositorLayer, S: RasterSources> {
    private var sources: S!
    private let linear: Bool
    /// The 8-bit compositor for masks and the layers it renders (see the module comment).
    private let base: RasterCompositor<L, S>
    private let profile: CompositorProfile<L, S>
    private let deep: DeepCompositorProfile<L, S>
    public let depth: Int

    public init(base: RasterCompositor<L, S>, profile: CompositorProfile<L, S>, deep: DeepCompositorProfile<L, S> = DeepCompositorProfile(), depth: Int) {
        self.base = base
        self.profile = profile
        self.deep = deep
        self.depth = depth
        linear = depth == 32
    }

    /// The composite of `layers` over `rect` as float RGBA in the working space (`rect.width × rect.height × 4`).
    public func composite(_ layers: [L], _ rect: RasterRect, _ sources: S) -> [Float] {
        self.sources = sources
        var acc = [Float](repeating: 0, count: Swift.max(0, rect.width * rect.height * 4))
        if rect.width > 0 && rect.height > 0 { _ = runSteps(buildSteps(layers), &acc, true, rect) }
        return acc
    }

    // MARK: Steps (as RasterCompositor.buildSteps)

    private func isPixel(_ l: L) -> Bool { l.type == "pixel" || (profile.isPixelLike?(l) ?? false) }
    private func isFilter(_ l: L) -> Bool { profile.isFilterLayer?(l) ?? false }
    private func isGroup(_ l: L) -> Bool { l.type == "group" }

    private func buildSteps(_ layers: [L]) -> [Step<L>] {
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

    private func runSteps(_ steps: [Step<L>], _ acc: inout [Float], _ emptyIn: Bool, _ r: RasterRect) -> Bool {
        var empty = emptyIn
        for s in steps { empty = runStep(s, &acc, empty, r) }
        return empty
    }

    private func runStep(_ step: Step<L>, _ acc: inout [Float], _ empty: Bool, _ r: RasterRect) -> Bool {
        if step.kind == .adjust {
            if empty { return true }
            applyFilterRun(step.layers, &acc, r)
            return false
        }
        let layer = step.layer!
        if !layer.visible { return empty }
        let clipped = step.clipped.filter(\.visible)
        if deepEffects(layer) { return runEffects(layer, clipped, &acc, r, step.kind == .group ? step.steps : nil) ? false : empty }
        let coverage = renderedAlone(layer) ? nil : base.maskCoverage(layer, r, sources)
        if let coverage, coverage.allSatisfy({ $0 <= 0 }) { return empty }
        if step.kind == .group && !renderedAlone(layer) {
            if layer.blend == .passThrough && clipped.isEmpty {
                if layer.opacity >= 1 && coverage == nil { return runSteps(step.steps, &acc, empty, r) }
                let before = acc
                let stillEmpty = runSteps(step.steps, &acc, empty, r)
                lerp(&acc, before, layer.opacity, coverage)
                return empty && stillEmpty
            }
            var buf = [Float](repeating: 0, count: acc.count)
            if runSteps(step.steps, &buf, true, r) { return empty }
            applyClipped(clipped, &buf, r)
            blend(&acc, buf, layer.blend.drawMode, layer.opacity, coverage)
            return false
        }
        guard var content = content(layer, r) else { return empty }
        let ambient = layer.edge?.ambient ?? 0
        if ambient > 0 {
            // In the working space: a fixed colour is sRGB bytes (decoded at 32 bits).
            let color = layer.edge?.ambientColor.map { c in c.map { linear ? srgbDecode($0 / 255) : $0 / 255 } }
            if color != nil || !empty { applyEdgeAmbient(&content, acc, coverage, ambient, color, 1) }
        }
        let alone = renderedAlone(layer)
        // A layer rendered alone already carries its mask, fill and effects.
        let fill = !alone && isPixel(layer) ? (layer.fillOpacity ?? 1) : 1
        let mode = blendOf(layer)
        if clipped.isEmpty {
            blend(&acc, content, mode, layer.opacity * fill, coverage)
            return false
        }
        var buf = [Float](repeating: 0, count: acc.count)
        blend(&buf, content, .normal, fill, coverage)
        applyClipped(clipped, &buf, r)
        blend(&acc, buf, mode, layer.opacity, nil)
        return false
    }

    /**
     * A pixel layer with effects onto `acc` over `r`: its deep content (filters, mask, clipped
     * layers) and the effects composited in float. Effect maps come from the 8-bit shape. At 32
     * bits the effects composite in sRGB-encoded values (their colours and blends are defined
     * there) and the result is decoded back. Returns whether anything was drawn.
     */
    private func runEffects(_ layer: L, _ clipped: [L], _ acc: inout [Float], _ r: RasterRect, _ groupSteps: [Step<L>]?) -> Bool {
        guard let fx = base.effectsInput(layer, r, sources) else { return false }
        let a = fx.rect
        var content: [Float]
        if let groupSteps {
            // A group's content: its children composited alone, in float.
            content = [Float](repeating: 0, count: a.width * a.height * 4)
            _ = runSteps(groupSteps, &content, true, a)
        } else {
            content = self.content(layer, a) ?? [Float](repeating: 0, count: a.width * a.height * 4)
        }
        if let coverage = base.maskCoverage(layer, a, sources) {
            for i in 0..<coverage.count { content[i * 4 + 3] = Float(Double(content[i * 4 + 3]) * Double(coverage[i])) }
        }
        if !clipped.isEmpty { applyClipped(clipped, &content, a) }
        var sub = [Float](repeating: 0, count: a.width * a.height * 4)
        for y in 0..<a.height {
            let s = ((a.y - r.y + y) * r.width + (a.x - r.x)) * 4
            for k in 0..<(a.width * 4) { sub[y * a.width * 4 + k] = acc[s + k] }
        }
        if linear {
            mapColour(&sub, srgbEncode)
            mapColour(&content, srgbEncode)
        }
        var input = EffectCompositeInput(backdrop: .floats(sub), content: .floats(content), rect: fx.rect, maps: fx.maps, blend: fx.blend, opacity: fx.opacity, fillOpacity: fx.fillOpacity, canvas: fx.canvas, ctx: fx.ctx)
        compositeLayerEffects(&input)
        sub = input.backdrop.floats!
        if linear { mapColour(&sub, srgbDecode) }
        for y in 0..<a.height {
            let d = ((a.y - r.y + y) * r.width + (a.x - r.x)) * 4
            for k in 0..<(a.width * 4) { acc[d + k] = sub[y * a.width * 4 + k] }
        }
        return true
    }

    private func applyClipped(_ clipped: [L], _ buf: inout [Float], _ r: RasterRect) {
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
            let alone = renderedAlone(c)
            let coverage = alone ? nil : base.maskCoverage(c, r, sources)
            var src: [Float]
            if isGroup(c) && !alone {
                src = [Float](repeating: 0, count: buf.count)
                if runSteps(buildSteps(c.children ?? []), &src, true, r) { continue }
            } else {
                guard let s = content(c, r) else { continue }
                src = s
            }
            let fill = !alone && isPixel(c) ? (c.fillOpacity ?? 1) : 1
            // Source-atop: the base's alpha is kept.
            let keep = stride(from: 3, to: buf.count, by: 4).map { buf[$0] }
            blend(&buf, src, c.blend == .passThrough ? .normal : blendOf(c), c.opacity * fill, coverage)
            for (p, a) in keep.enumerated() { buf[p * 4 + 3] = a }
        }
        flush()
    }

    private func applyFilterRun(_ layers: [L], _ acc: inout [Float], _ r: RasterRect) {
        var visible: [L] = []
        var masks: [String: [Float]]? = nil
        for node in layers where node.visible {
            if let cov = base.maskCoverage(node, r, sources) {
                if cov.allSatisfy({ $0 <= 0 }) { continue }
                if masks == nil { masks = [:] }
                masks![node.id] = cov
            }
            visible.append(node)
        }
        if visible.isEmpty { return }
        if let run = deep.applyFilterRunDeep {
            // Filter layers work on encoded colour: at 32 bits encode around them.
            if linear { mapColour(&acc, srgbEncode) }
            run(visible, &acc, r, masks, sources)
            if linear { mapColour(&acc, srgbDecode) }
            return
        }
        var bytes = to8(acc)
        profile.applyFilterRun?(visible, &bytes, r, masks, sources)
        acc = from8(bytes)
    }

    // MARK: Layer content

    /// A pixel(-like) layer or a group with effects: composited in float through `compositeLayerEffects`.
    private func deepEffects(_ layer: L) -> Bool {
        hasActiveEffects(layer.effects) && !isFilter(layer) && (isGroup(layer) || isPixel(layer))
    }

    /// Layers drawn by the 8-bit compositor alone (effects, pixel filters, content the editor draws).
    private func renderedAlone(_ layer: L) -> Bool {
        if hasActiveEffects(layer.effects) && !isFilter(layer) && !deepEffects(layer) { return true }
        if isPixel(layer) { return profile.pixelFilters?(layer) != nil && deep.pixelFiltersDeep?(layer) == nil }
        return !isGroup(layer)
    }

    private func blendOf(_ layer: L) -> BlendMode {
        profile.contentBlend?(layer) ?? layer.blend.drawMode
    }

    /// A layer's float RGBA over `r` (straight alpha, working space), or `nil` when it has none there.
    private func content(_ layer: L, _ r: RasterRect) -> [Float]? {
        if renderedAlone(layer) {
            // Alone: normal blend at full opacity over transparency (mask, fill and effects applied).
            // Without the live edge cast: it needs what is behind the layer, applied in float (runStep).
            var edge = layer.edge
            if let a = edge?.ambient, a != 0 { edge?.ambient = 0 }
            let solo = layer.solo(blend: isGroup(layer) && layer.blend == .passThrough ? .passThrough : .mode(.normal), opacity: 1, clipped: false, edge: edge)
            return from8(base.composite([solo], r, sources))
        }
        guard let surface = sources.surfaceOf(layer) ?? layer.surface else { return nil }
        let ox = layer.offset?.x ?? 0
        let oy = layer.offset?.y ?? 0
        let filters = isPixel(layer) ? deep.pixelFiltersDeep?(layer) : nil
        guard let filters else { return samples(surface, RasterRect(x: r.x - ox, y: r.y - oy, width: r.width, height: r.height)) }
        // Filters in float: read what they reach (clamped at the canvas edge, as the 8-bit path
        // filters over the canvas), filter, and keep `r`.
        let m = filters.reach
        let W = sources.width
        let H = sources.height
        let x0 = m != 0 ? Swift.max(0, r.x - m) : r.x
        let y0 = m != 0 ? Swift.max(0, r.y - m) : r.y
        let x1 = m != 0 ? Swift.min(W, r.x + r.width + m) : r.x + r.width
        let y1 = m != 0 ? Swift.min(H, r.y + r.height + m) : r.y + r.height
        if x1 <= x0 || y1 <= y0 { return [Float](repeating: 0, count: r.width * r.height * 4) }
        let big = RasterRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
        var data = samples(surface, RasterRect(x: big.x - ox, y: big.y - oy, width: big.width, height: big.height))
        filters.apply(&data, big.width, big.height, linear)
        if big == r { return data }
        var out = [Float](repeating: 0, count: r.width * r.height * 4)
        for y in 0..<r.height {
            let sy = r.y + y - big.y
            if sy < 0 || sy >= big.height { continue }
            for x in 0..<r.width {
                let sx = r.x + x - big.x
                if sx < 0 || sx >= big.width { continue }
                let s = (sy * big.width + sx) * 4
                let d = (y * r.width + x) * 4
                for c in 0..<4 { out[d + c] = data[s + c] }
            }
        }
        return out
    }

    /// A surface's samples over `rect` (layer space) in the working space.
    private func samples(_ surface: PixelSurface, _ rect: RasterRect) -> [Float] {
        switch readDeepRegion(surface, rect, depth) {
        case .f32(let f): return f
        case .u16(let u): return u.map { Float(Double($0) / 65535) }
        }
    }

    /// 8-bit RGBA to the working space.
    private func from8(_ bytes: [UInt8]) -> [Float] {
        if linear { return to32From8(bytes, 4) }
        return bytes.map { Float(Double($0) / 255) }
    }

    /// The working space to 8-bit RGBA.
    private func to8(_ acc: [Float]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: acc.count)
        var i = 0
        while i < acc.count {
            for c in 0..<3 { out[i + c] = JS.u8c(JS.round((linear ? srgbEncode(Double(acc[i + c])) : Double(acc[i + c])) * 255)) }
            out[i + 3] = JS.u8c(JS.round(Double(acc[i + 3]) * 255))
            i += 4
        }
        return out
    }

    // MARK: Blending

    /// `src` over `dst` with `mode` at `alpha` × coverage (straight alpha, float), as `blendTile`.
    private func blend(_ dst: inout [Float], _ src: [Float], _ mode: BlendMode, _ alpha: Double, _ coverage: [Float]?) {
        if !(alpha > 0) { return }
        let normal = mode == .normal
        let pigment = mode == .pigment
        var cb = [0.0, 0.0, 0.0]
        var cs = [0.0, 0.0, 0.0]
        var i = 0, p = 0
        while i < dst.count {
            defer {
                i += 4
                p += 1
            }
            let sa = Double(src[i + 3])
            if !(sa > 0) { continue }
            let k = coverage.map { alpha * Double($0[p]) } ?? alpha
            if !(k > 0) { continue }
            let as_ = JS.min(1, sa * k)
            let ab = Double(dst[i + 3])
            let ao = as_ + ab * (1 - as_)
            if ao <= 0 {
                for c in 0..<4 { dst[i + c] = 0 }
                continue
            }
            if normal && as_ >= 1 {
                dst[i] = src[i]
                dst[i + 1] = src[i + 1]
                dst[i + 2] = src[i + 2]
                dst[i + 3] = 1
                continue
            }
            for c in 0..<3 {
                cb[c] = Double(dst[i + c])
                cs[c] = Double(src[i + c])
            }
            if pigment {
                // Paint mixing works on encoded colour.
                if linear {
                    for c in 0..<3 {
                        cb[c] = srgbEncode(cb[c])
                        cs[c] = srgbEncode(cs[c])
                    }
                }
                let mix = mixPigmentRgb(cb, cs, as_ / ao)
                for c in 0..<3 { dst[i + c] = Float(linear ? srgbDecode(mix[c]) : mix[c]) }
                dst[i + 3] = Float(ao)
                continue
            }
            let m = normal ? cs : blendRgb(mode, cb, cs)
            let wb = (1 - as_) * ab
            let ws = (1 - ab) * as_
            let wm = as_ * ab
            for c in 0..<3 { dst[i + c] = Float((wb * cb[c] + ws * cs[c] + wm * m[c]) / ao) }
            dst[i + 3] = Float(ao)
        }
    }
}

/// `dst = lerp(before, dst, alpha · coverage)` (pass-through groups with opacity).
private func lerp(_ dst: inout [Float], _ before: [Float], _ alpha: Double, _ coverage: [Float]?) {
    var i = 0, p = 0
    while i < dst.count {
        let k = coverage.map { alpha * Double($0[p]) } ?? alpha
        if k < 1 { for c in 0..<4 { dst[i + c] = Float(Double(before[i + c]) + (Double(dst[i + c]) - Double(before[i + c])) * k) } }
        i += 4
        p += 1
    }
}

/// Applies `f` to the colour channels of float RGBA in place.
private func mapColour(_ data: inout [Float], _ f: (Double) -> Double) {
    var i = 0
    while i < data.count {
        data[i] = Float(f(Double(data[i])))
        data[i + 1] = Float(f(Double(data[i + 1])))
        data[i + 2] = Float(f(Double(data[i + 2])))
        i += 4
    }
}

/// Float RGBA in the working space of `depth` as deep samples of that depth (16: encoded codes; 32: as is).
public func workingToSamples(_ data: [Float], _ depth: Int) -> DeepSamples {
    if depth == 32 { return .f32(data) }
    return .u16(data.map { v in v > 0 ? (v < 1 ? UInt16(JS.round(Double(v) * 65535)) : 65535) : 0 })
}
