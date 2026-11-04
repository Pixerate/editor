import Foundation
import PixerateCore
import PixerateRaster

/**
 * The paint editor's dab-by-dab stroke engine (`paint-editor/dab-stroke.ts`): every brush whose
 * dabs read what earlier dabs laid down. The Mixer Brush, the blender, the smudge, and dab brushes
 * that pick up paint or paint a gradient all run here, with the same pen input as dry media.
 *
 * - `mixer` and wet-capable `dab` brushes go through the shared pick-up / mix exchange: each dab
 *   picks up from the layer, mixes its paint from the brush colour (or the gradient) and the
 *   carried paint, and lays it down. A dab brush keeps the stroke's opacity ceiling: a shared
 *   `CoverageMap` builds up as for dry media and each dab lays only the increase.
 * - `blender` calls `blenderDab`, `smudge` a `SmudgeTip` per copy.
 */

/// Entries in a multi-colour gradient table.
private let GRADIENT_STEPS = 32

private struct CopyState {
    let walker: PenDabWalker
    let exchange: PaintExchange?
    let smudge: SmudgeTip?
}

final class PaintDabStroke {
    var dabCount = 0
    let brush: PaintBrush
    private let target: PaintTileTarget
    private let grain: PaperGrain?
    private let seed: Int
    private let smoother: PenSmoother
    private let copies: [StrokeCopy]
    private let states: [CopyState]
    private let medium: TileMedium
    private let depth: Double
    private let coverage: CoverageMap?
    private let sampler: PaintGradientSampler?
    private let gradient: [[Double]]?
    /// Opacity across the tip (`across-tip` gradients with opacity stops), or nil.
    private let gradientAlpha: [Double]?
    private var fieldLut: [[Double]] = []
    private let scratch: BlenderScratch?
    private var tip: [Float] = []
    private var cov: [Float] = []
    private var field: [Float] = []
    private var paintColor = [0.0, 0.0, 0.0]
    private var lastRaw: PenPoint?
    private var lastFed: PenPoint?
    /// Effect paint: each dab's colour (and flow, by alpha) is the effect's at the dab's centre.
    private let effect: EffectPaintPixels?

    init(_ brush: PaintBrush, target: PaintTileTarget, load: MixerLoad, grain: PaperGrain?, paperDepth: Double, seed: Int, copies: [StrokeCopy], paint: PaintGradientSource?, effect: EffectPaintPixels? = nil) {
        self.brush = brush
        self.effect = effect
        self.target = target
        self.grain = grain
        self.seed = seed
        smoother = PenSmoother(brush.tip.smoothing, brush.pressureSmoothing)
        self.copies = copies.isEmpty ? [IDENTITY_COPY] : copies
        let exchanging = brush.engine == "mixer" || brush.engine == "dab"
        let rates = brush.engine == "mixer" ? mixerRates(brush.mixer) : exchangeRates(brush.behavior.pickup, brush.behavior.mix, 1, brush.behavior.mixing)
        states = self.copies.enumerated().map { i, c in
            CopyState(
                walker: PenDabWalker(brush, Int(Int32(truncatingIfNeeded: seed + i * 7919)), c.linear),
                exchange: exchanging ? PaintExchange(rates, load) : nil,
                smudge: brush.engine == "smudge" ? SmudgeTip(brush.smudge, brush.tip.size * (1 + brush.dynamics.tiltSize * 1.5)) : nil
            )
        }
        // A Mixer Brush mixes as its settings say; a dab brush blends by its tip's blend mode.
        medium = TileMedium(target, blend: brush.engine == "dab" ? brush.tip.blend : nil)
        depth = grain != nil && !grain!.flat ? Swift.min(1, Swift.max(0, paperDepth * brush.grain)) : 0
        coverage = brush.engine == "dab" ? CoverageMap() : nil
        sampler = exchanging && paint != nil ? PaintGradientSampler(paint!, seed: seed) : nil
        let table = sampler?.acrossTip == true ? sampler!.tipTable(GRADIENT_STEPS) : nil
        gradient = table?.map(\.rgb)
        gradientAlpha = table != nil && table!.contains { $0.alpha < 1 } ? table!.map(\.alpha) : nil
        scratch = brush.engine == "blender" ? BlenderScratch() : nil
    }

    /// What copy 0's brush carries after the dabs so far (mixer and wet-capable dab brushes).
    var load: MixerLoad? { states[0].exchange?.load }

    func push(_ points: [PenPoint]) -> [RasterRect] {
        var rects: [RasterRect] = []
        for raw in points {
            lastRaw = raw
            let p = smoother.push(raw)
            lastFed = p
            for (i, c) in copies.enumerated() {
                var dabs: [PenDab] = []
                states[i].walker.push(c.map(p), &dabs)
                paintDabs(i, dabs, &rects)
            }
        }
        return rects
    }

    /// Ends the stroke: the smoothed path catches up with the last raw sample; a tap paints one dab.
    func finish() -> [RasterRect] {
        var rects: [RasterRect] = []
        for (i, c) in copies.enumerated() {
            var dabs: [PenDab] = []
            if let raw = lastRaw, let fed = lastFed, raw.x != fed.x || raw.y != fed.y {
                var q = raw
                q.pressure = fed.pressure
                states[i].walker.push(c.map(q), &dabs)
            }
            states[i].walker.finish(&dabs)
            paintDabs(i, dabs, &rects)
        }
        return rects
    }

    private func paintDabs(_ copy: Int, _ dabs: [PenDab], _ rects: inout [RasterRect]) {
        // Spray marks (dab brushes): each dab is a scatter of droplets, each picking up and laying paint.
        let spray = brush.engine == "dab" ? brush.spray : nil
        let list = spray.map { s in dabs.flatMap { sprayDroplets($0, s, seed + copy * 7919) } } ?? dabs
        for d in list {
            let rect = dabRect(d.dab, brush.tip.hardness)
            if rect.width <= 0 || rect.height <= 0 { continue }
            dab(copy, d, rect)
            rects.append(rect)
            dabCount += 1
        }
    }

    /// The tip's pure coverage (`tip`) and, with grain, what the paper catches of it (`cov`).
    private func rasterize(_ d: PenDab, _ rect: RasterRect) -> (tip: [Float], cov: [Float]) {
        let n = rect.width * rect.height
        var flat = d.dab
        flat.alpha = 1
        var t = [Float](repeating: 0, count: n)
        rasterizeDab(flat, brush.tip.hardness, rect, &t)
        guard depth > 0, let grain else { return (t, t) }
        var c = [Float](repeating: 0, count: n)
        var k = 0
        for yy in 0..<rect.height {
            let y = Double(rect.y + yy) + 0.5
            for xx in 0..<rect.width {
                c[k] = t[k] > 0 ? Float(Double(t[k]) * grainCatch(grain.at(Double(rect.x + xx) + 0.5, y), depth, d.pressure)) : 0
                k += 1
            }
        }
        return (t, c)
    }

    private func dab(_ copy: Int, _ d: PenDab, _ rect: RasterRect) {
        let (tip, cov) = rasterize(d, rect)
        let st = states[copy]
        if brush.engine == "blender" {
            blenderDab(medium, rect, cov, d.dab.opacity * d.dab.alpha * brush.tip.opacity, d.dab.radius, brush.blender, scratch!)
            return
        }
        if brush.engine == "smudge" {
            st.smudge!.dab(medium, SmudgeDab(x: d.dab.x, y: d.dab.y, radius: d.dab.radius, opacity: d.dab.opacity * d.dab.alpha * brush.tip.opacity), rect, cov)
            return
        }
        let ex = st.exchange!
        // 1. Pick up from under the tip (the pure footprint, as the Mixer Brush samples).
        ex.pickUp(medium.sample(rect, tip))
        // 2. The dab's paint: one colour, gradient paint's colour for this dab, or a colour per pixel across the tip.
        var flow = 1.0
        if let effect {
            let e = sampleEffectAt(effect, d.dab.x, d.dab.y, EffectDabPlace(d))
            flow = e.alpha
            ex.setReservoirColor(e.rgb[0], e.rgb[1], e.rgb[2])
        } else if let sampler, gradient == nil {
            let g = sampler.dab(d.params)
            ex.setReservoirColor(g.rgb[0], g.rgb[1], g.rgb[2])
            flow = g.alpha
        }
        var fieldArg: [Float]? = nil
        var total: Double
        var laid = cov
        if gradient != nil {
            total = tipField(ex, d, rect)
            fieldArg = field
            if gradientAlpha != nil { laid = tipAlpha(d, rect, cov) }
        } else {
            total = ex.paint(&paintColor)
        }
        if total > 0 && flow > 0 {
            if coverage != nil {
                depositWithCeiling(d, rect, laid, fieldArg, ex, flow)
            } else {
                let dep = Swift.min(1, total) * d.dab.alpha * brush.tip.opacity * d.dab.opacity * flow
                if dep > 0 { medium.deposit(rect, laid, dep, paintColor, ex.paintPigment, fieldArg) }
            }
        }
        // 3. Drain.
        ex.drain()
    }

    /// Fills `field` with the tip gradient (mixed with the carried paint) per pixel; returns the paint weight.
    private func tipField(_ ex: PaintExchange, _ d: PenDab, _ rect: RasterRect) -> Double {
        let g = gradient!
        var total = 0.0
        for j in 0..<g.count {
            ex.setReservoirColor(g[j][0], g[j][1], g[j][2])
            var out = j < fieldLut.count ? fieldLut[j] : [0.0, 0.0, 0.0]
            total = ex.paint(&out)
            if j < fieldLut.count { fieldLut[j] = out } else { fieldLut.append(out) }
        }
        let n = rect.width * rect.height
        if field.count < n * 3 { field = [Float](repeating: 0, count: n * 3) }
        // Across the stroke: the normal to the direction of travel (document y points down).
        let nx = JS.sin(d.direction)
        let ny = JS.cos(d.direction)
        let r = Swift.max(0.5, d.dab.radius)
        let last = g.count - 1
        var k = 0
        for yy in 0..<rect.height {
            let py = Double(rect.y + yy) + 0.5 - d.dab.y
            for xx in 0..<rect.width {
                let u = ((Double(rect.x + xx) + 0.5 - d.dab.x) * nx + py * ny) / r
                let j = Swift.min(last, Swift.max(0, Int(JS.round(((u + 1) / 2) * Double(last)))))
                field[k * 3] = Float(fieldLut[j][0])
                field[k * 3 + 1] = Float(fieldLut[j][1])
                field[k * 3 + 2] = Float(fieldLut[j][2])
                k += 1
            }
        }
        return total
    }

    /// `cov` scaled by the gradient's opacity across the tip.
    private func tipAlpha(_ d: PenDab, _ rect: RasterRect, _ cov: [Float]) -> [Float] {
        let a = gradientAlpha!
        let n = rect.width * rect.height
        var out = [Float](repeating: 0, count: n)
        let nx = JS.sin(d.direction)
        let ny = JS.cos(d.direction)
        let r = Swift.max(0.5, d.dab.radius)
        let last = a.count - 1
        var k = 0
        for yy in 0..<rect.height {
            let py = Double(rect.y + yy) + 0.5 - d.dab.y
            for xx in 0..<rect.width {
                let u = ((Double(rect.x + xx) + 0.5 - d.dab.x) * nx + py * ny) / r
                out[k] = Float(Double(cov[k]) * a[Swift.min(last, Swift.max(0, Int(JS.round(((u + 1) / 2) * Double(last)))))])
                k += 1
            }
        }
        return out
    }

    /// A dab brush's deposit: only what this dab adds to the stroke's coverage, under its opacity ceiling.
    private func depositWithCeiling(_ d: PenDab, _ rect: RasterRect, _ cov: [Float], _ field: [Float]?, _ ex: PaintExchange, _ flow: Double) {
        let map = coverage!
        let n = rect.width * rect.height
        var before = [Float](repeating: 0, count: n)
        var vals = [Float](repeating: 0, count: n)
        var k = 0
        for yy in 0..<rect.height {
            for xx in 0..<rect.width {
                if cov[k] > 0 {
                    before[k] = Float(map.get(rect.x + xx, rect.y + yy))
                    vals[k] = Float(Double(cov[k]) * d.dab.alpha * flow)
                }
                k += 1
            }
        }
        map.accumulate(rect, vals, d.dab.opacity)
        let o = brush.tip.opacity
        k = 0
        for yy in 0..<rect.height {
            for xx in 0..<rect.width {
                if cov[k] <= 0 {
                    vals[k] = 0
                    k += 1
                    continue
                }
                let c0 = Double(before[k]) * o
                let c1 = map.get(rect.x + xx, rect.y + yy) * o
                vals[k] = c1 > c0 && c0 < 1 ? Float((c1 - c0) / (1 - c0)) : 0
                k += 1
            }
        }
        medium.deposit(rect, vals, 1, paintColor, ex.paintPigment, field)
    }
}
