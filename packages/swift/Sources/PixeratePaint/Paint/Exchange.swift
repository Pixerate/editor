// Portions ported from photocraft/crates/paint/src/mixer.rs (MIT OR Apache-2.0, © ArtCraft Team and
// contributors) by way of packages/core/src/paint/exchange.ts. See THIRD_PARTY_NOTICES.md.

import Foundation
import PixerateRaster

/**
 * The pick-up / mix exchange between a loaded brush and the paint under it: the one mechanism
 * every wet-capable brush shares (`paint/exchange.ts`).
 *
 * - `PaintExchange` is what the brush carries: a reservoir of loaded paint (with an amount that
 *   drains per dab) and a well of paint picked up from the canvas. Per dab it picks up, mixes the
 *   dab's paint and drains.
 * - `TileMedium` is what the brush touches: `sample` (the colour and contact under a footprint)
 *   and `deposit` (lay paint at per-pixel amounts) over a raster layer's live tiles.
 */

/// How colours mix: straight sRGB averages (`rgb`), or like paint (`pigment`, Kubelka-Munk).
public let MIXING_MODELS = ["rgb", "pigment"]

/// What a brush carries between dabs and strokes. Colours are straight sRGB, 0..1.
public struct MixerLoad: Equatable, Sendable {
    /// Loaded paint, or nil when the brush is unloaded.
    public var reservoir: [Double]?
    /// Reservoir left, 0..1.
    public var amount: Double
    /// Colour picked up from the canvas (the well), or nil when the brush is clean.
    public var pickup: [Double]?

    public init(reservoir: [Double]?, amount: Double, pickup: [Double]?) {
        self.reservoir = reservoir
        self.amount = amount
        self.pickup = pickup
    }
}

public let EMPTY_MIXER_LOAD = MixerLoad(reservoir: nil, amount: 0, pickup: nil)

/// Fraction of the way the well moves towards the canvas colour per dab at a pick-up ratio of 1.
public let MIXER_PICKUP_RATE = 0.25
/// Fraction of the reservoir that drains per dab at a load of 0.
public let MIXER_DRAIN = 0.08

/// Per-dab rates of an exchange.
public struct ExchangeRates {
    public var pickup: Double
    public var mix: Double
    public var drain: Double
    public var mixing: String
}

/// Per-dab rates from the ratios a user sets (see `paint/exchange.ts`).
public func exchangeRates(_ pickup: Double, _ mix: Double, _ load: Double, _ mixing: String) -> ExchangeRates {
    ExchangeRates(pickup: MIXER_PICKUP_RATE * pickup, mix: mix * pickup, drain: MIXER_DRAIN * (1 - load), mixing: mixing)
}

/// What a footprint holds: its average paint colour and how much of it holds paint (0..1).
public struct PaintSample {
    public var rgb: [Double]
    public var contact: Double
}

/// The brush side of the exchange: reservoir, amount and well, mixed per dab.
public final class PaintExchange {
    public let rates: ExchangeRates
    private var reservoir: [Double]?
    private var amount: Double
    private var well: [Double]?
    private let pig: (res: Pigment, well: Pigment, paint: Pigment, canvas: Pigment)?
    private var out = [0.0, 0.0, 0.0]

    public init(_ rates: ExchangeRates, _ load: MixerLoad) {
        self.rates = rates
        reservoir = load.reservoir.map { [$0[0], $0[1], $0[2]] }
        amount = reservoir != nil ? Swift.min(1, Swift.max(0, load.amount)) : 0
        well = load.pickup.map { [$0[0], $0[1], $0[2]] }
        pig = rates.mixing == "pigment"
            ? (res: createPigment(reservoir ?? [0, 0, 0]), well: createPigment(well ?? [0, 0, 0]), paint: createPigment([0, 0, 0]), canvas: createPigment([0, 0, 0]))
            : nil
    }

    /// What the brush carries now.
    public var load: MixerLoad { MixerLoad(reservoir: reservoir, amount: amount, pickup: well) }

    /// The prepared pigment of the last `paint` colour (pigment mixing only), for `deposit`.
    public var paintPigment: Pigment? { pig?.paint }

    /// Recolours the reservoir without refilling it (a multi-coloured brush, per dab).
    public func setReservoirColor(_ r: Double, _ g: Double, _ b: Double) {
        if reservoir == nil {
            reservoir = [r, g, b]
            amount = 1
        } else {
            reservoir![0] = r
            reservoir![1] = g
            reservoir![2] = b
        }
        if let pig { setPigmentColor(pig.res, r, g, b) }
    }

    /// `a` mixed `t` of the way to `b` into `out`, by the mixing model.
    private func mix(_ a: [Double], _ pa: Pigment?, _ b: [Double], _ pb: Pigment?, _ t: Double) -> [Double] {
        if let pa, let pb { lerpPigmentInto(pa, pb, t, &out, 0) } else { for c in 0..<3 { out[c] = a[c] + (b[c] - a[c]) * t } }
        return out
    }

    /// 1. Pick-up: the well moves towards the sampled colour (or takes it, when clean).
    public func pickUp(_ sample: PaintSample?) {
        guard let sample, rates.pickup > 0 else { return }
        if well == nil {
            well = [sample.rgb[0], sample.rgb[1], sample.rgb[2]]
        } else {
            if let pig { setPigmentColor(pig.canvas, sample.rgb[0], sample.rgb[1], sample.rgb[2]) }
            let o = mix(well!, pig?.well, sample.rgb, pig?.canvas, rates.pickup * sample.contact)
            well = [o[0], o[1], o[2]]
        }
        if let pig { setPigmentColor(pig.well, well![0], well![1], well![2]) }
    }

    /**
     * 2. The dab's paint: the reservoir mixed with the well, written to `out`. Returns the total
     * weight (≤ 0: nothing to lay down).
     */
    public func paint(_ dst: inout [Double]) -> Double {
        let wr = reservoir != nil ? amount * (1 - rates.mix) : 0
        let wp = well != nil ? rates.mix : 0
        let total = wr + wp
        if !(total > 1e-6) { return 0 }
        if let res = reservoir, let w = well {
            let m = mix(res, pig?.res, w, pig?.well, wp / total)
            dst[0] = m[0]
            dst[1] = m[1]
            dst[2] = m[2]
        } else {
            let c = reservoir ?? well!
            dst[0] = c[0]
            dst[1] = c[1]
            dst[2] = c[2]
        }
        if let pig { setPigmentColor(pig.paint, dst[0], dst[1], dst[2]) }
        return total
    }

    /// 3. The reservoir drains.
    public func drain() {
        amount *= 1 - rates.drain
    }
}

/// A writable tile of a stroke's live pixels (a reference, written in place).
public final class ByteTile {
    public var data: [UInt8]
    public init(_ data: [UInt8]) { self.data = data }
}

/// Writes `v` (0..1) into a working tile, rounded as a `Uint8ClampedArray` store of `Math.round(v × 255)`.
@inline(__always) func put255(_ px: ByteTile, _ i: Int, _ v: Double) {
    px.data[i] = JS.u8c(JS.round(v * 255))
}

/// The pixels a brush reads and writes (RGBA tiles in layer space).
public protocol PaintTileTarget: AnyObject {
    /// The tile at (tx, ty) as it is now, or nil when it is fully transparent.
    func readTile(_ tx: Int, _ ty: Int) -> ByteTile?
    /// A writable tile at (tx, ty), returned by `readTile` from then on.
    func writeTile(_ tx: Int, _ ty: Int) -> ByteTile
    /// Layer offset: layer pixel = document pixel − offset.
    var offset: LayerOffset { get }
    /// Keep alpha and paint only where the layer has pixels.
    var lockTransparency: Bool { get }
    /// Selection coverage (document space, canvas-sized), or nil.
    var selection: PaintSelection? { get }
}

/// A raster layer's pixels as a paint medium (through live tiles).
public final class TileMedium {
    public let target: PaintTileTarget
    private let blend: BlendMode?
    private var tx = Int.min
    private var ty = Int.min
    private var tile: ByteTile?
    private var writable = false
    private let canvasPig = createPigment([0, 0, 0])
    private let paintPig = createPigment([0, 0, 0])
    private var paintKey = -1
    private var cb = [0.0, 0.0, 0.0, 0.0]
    private var src = [0.0, 0.0, 0.0, 1.0]
    private var o = [0.0, 0.0, 0.0]

    /// `blend`: nil mixes as the exchange does (the Mixer Brush); otherwise a brush tip's blend mode.
    public init(_ target: PaintTileTarget, blend: BlendMode? = nil) {
        self.target = target
        self.blend = blend
    }

    /// Forgets the cached tile.
    public func reset() { tx = Int.min }

    /// The byte index of document pixel (dx, dy) in the tile holding it (`pixels`), or -1 when reading an empty tile.
    public func locate(_ dx: Int, _ dy: Int, _ write: Bool) -> Int {
        let t = target
        let lx = dx - t.offset.x
        let ly = dy - t.offset.y
        let tx = floorTile(lx)
        let ty = floorTile(ly)
        if tx != self.tx || ty != self.ty || (write && !writable) {
            self.tx = tx
            self.ty = ty
            tile = write ? t.writeTile(tx, ty) : t.readTile(tx, ty)
            writable = write
        }
        return tile != nil ? ((ly - ty * TILE) * TILE + (lx - tx * TILE)) * 4 : -1
    }

    /// The tile `locate` last found.
    public var pixels: ByteTile { tile! }

    /// Selection coverage at a document pixel, 0..1 (1 without a selection).
    public func selectionAt(_ dx: Int, _ dy: Int) -> Double {
        guard let sel = target.selection else { return 1 }
        if dx < 0 || dy < 0 || dx >= sel.width || dy >= sel.height { return 0 }
        return Double(sel.data[dy * sel.width + dx]) / 255
    }

    public func sample(_ rect: RasterRect, _ cov: [Float]) -> PaintSample? {
        let w = rect.width
        reset()
        var ar = 0.0, ag = 0.0, ab = 0.0, wsum = 0.0, asum = 0.0
        for yy in 0..<rect.height {
            for xx in 0..<w {
                let k = Double(cov[yy * w + xx])
                if k <= 0 { continue }
                wsum += k
                let i = locate(rect.x + xx, rect.y + yy, false)
                if i < 0 { continue }
                let px = tile!.data
                let al = Double(px[i + 3]) / 255
                if al <= 0 { continue }
                let ka = k * al
                ar += (Double(px[i]) / 255) * ka
                ag += (Double(px[i + 1]) / 255) * ka
                ab += (Double(px[i + 2]) / 255) * ka
                asum += ka
            }
        }
        if !(asum > 1e-6) { return nil }
        return PaintSample(rgb: [ar / asum, ag / asum, ab / asum], contact: asum / Swift.max(1e-6, wsum))
    }

    public func deposit(_ rect: RasterRect, _ cov: [Float], _ dep: Double, _ paint: [Double], _ paintPigment: Pigment?, _ field: [Float]? = nil) {
        let t = target
        let sel = t.selection
        let w = rect.width
        // Pigment where the exchange mixes pigment (no blend given) or the blend is `pigment`.
        let pigment = blend == nil ? paintPigment != nil : blend == .pigment
        let general = blend != nil && blend != .normal && blend != .pigment
        var lastKey = -1
        reset()
        for yy in 0..<rect.height {
            let dy = rect.y + yy
            for xx in 0..<w {
                let p = yy * w + xx
                var k = Double(cov[p]) * dep
                if k <= 0 { continue }
                let dx = rect.x + xx
                if let sel {
                    if dx < 0 || dy < 0 || dx >= sel.width || dy >= sel.height { continue }
                    k *= Double(sel.data[dy * sel.width + dx]) / 255
                    if k <= 0 { continue }
                }
                if k > 1 { k = 1 }
                // A locked layer keeps its transparent pixels (and leaves their tiles unwritten).
                if t.lockTransparency {
                    let ri = locate(dx, dy, false)
                    if ri < 0 || tile!.data[ri + 3] == 0 { continue }
                }
                let i = locate(dx, dy, true)
                let px = tile!
                let pr = field != nil ? Double(field![p * 3]) : paint[0]
                let pg = field != nil ? Double(field![p * 3 + 1]) : paint[1]
                let pb = field != nil ? Double(field![p * 3 + 2]) : paint[2]
                if general {
                    for c in 0..<4 { cb[c] = Double(px.data[i + c]) / 255 }
                    src[0] = pr
                    src[1] = pg
                    src[2] = pb
                    let r = blendPixel(blend!, cb, src, k)
                    put255(px, i, r[0])
                    put255(px, i + 1, r[1])
                    put255(px, i + 2, r[2])
                    if !t.lockTransparency { put255(px, i + 3, r[3]) }
                    continue
                }
                let a = Double(px.data[i + 3]) / 255
                let na = t.lockTransparency ? a : a + (1 - a) * k
                // The new paint's share of the result (source-over); a locked layer mixes by `k` alone.
                let share = t.lockTransparency ? k : na > 0 ? k / na : 1
                if a <= 0 || share >= 1 {
                    o[0] = pr
                    o[1] = pg
                    o[2] = pb
                } else if pigment && field != nil {
                    mixPigment8(Int(px.data[i]), Int(px.data[i + 1]), Int(px.data[i + 2]), Int(JS.round(pr * 255)), Int(JS.round(pg * 255)), Int(JS.round(pb * 255)), share, &o)
                } else if pigment {
                    let key = (Int(px.data[i]) << 16) | (Int(px.data[i + 1]) << 8) | Int(px.data[i + 2])
                    if key != lastKey {
                        setPigmentColor(canvasPig, Double(px.data[i]) / 255, Double(px.data[i + 1]) / 255, Double(px.data[i + 2]) / 255)
                        lastKey = key
                    }
                    var pp = paintPigment
                    if pp == nil {
                        // A pigment-blend tip over an RGB exchange: prepare the paint colour once per colour.
                        let pkey = (Int(JS.round(pr * 255)) << 16) | (Int(JS.round(pg * 255)) << 8) | Int(JS.round(pb * 255))
                        if pkey != paintKey {
                            setPigmentColor(paintPig, pr, pg, pb)
                            paintKey = pkey
                        }
                        pp = paintPig
                    }
                    lerpPigmentInto(canvasPig, pp!, share, &o, 0)
                } else {
                    let c0 = Double(px.data[i]) / 255, c1 = Double(px.data[i + 1]) / 255, c2 = Double(px.data[i + 2]) / 255
                    o[0] = c0 + (pr - c0) * share
                    o[1] = c1 + (pg - c1) * share
                    o[2] = c2 + (pb - c2) * share
                }
                put255(px, i, o[0])
                put255(px, i + 1, o[1])
                put255(px, i + 2, o[2])
                put255(px, i + 3, na)
            }
        }
    }
}

// MARK: - The Mixer Brush (`paint/mixer.ts`)

/// Mixer Brush options.
public struct MixerSettings: Equatable, Sendable {
    public var wet: Double
    public var load: Double
    public var mix: Double
    public var loadEachStroke: Bool
    public var cleanEachStroke: Bool
    public var mixing: String
}

public let DEFAULT_MIXER = MixerSettings(wet: 0.5, load: 0.5, mix: 0.5, loadEachStroke: true, cleanEachStroke: true, mixing: "rgb")

/// The per-dab exchange rates of Mixer Brush settings.
public func mixerRates(_ s: MixerSettings) -> ExchangeRates {
    exchangeRates(s.wet, s.mix, s.load, s.mixing)
}

/// The brush loaded full with `color` (sRGB 0..1); the pickup well is kept.
public func loadMixer(_ load: MixerLoad, _ color: [Double]) -> MixerLoad {
    let c = { (v: Double) in Swift.min(1, Swift.max(0, v.isFinite ? v : 0)) }
    return MixerLoad(reservoir: [c(color[0]), c(color[1]), c(color[2])], amount: 1, pickup: load.pickup)
}

/// The brush with its pickup well emptied; the reservoir is kept.
public func cleanMixer(_ load: MixerLoad) -> MixerLoad {
    MixerLoad(reservoir: load.reservoir, amount: load.amount, pickup: nil)
}
