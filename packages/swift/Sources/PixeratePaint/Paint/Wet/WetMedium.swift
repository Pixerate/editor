import Foundation
import PixerateRaster

/**
 * The wet layer as a paint medium (`paint/wet/medium.ts`): the canvas side of the shared pick-up /
 * mix exchange, so wet brushes pick up and mix paint the way the Mixer Brush does.
 *
 * - `sample` sees only wet paint: what a brush can lift. Its colour is the pigment's hue at full
 *   strength; contact is how much of the footprint is wet with pigment in it.
 * - `deposit` lays water and pigment (`pigmentOf` at the brush's body), and light paint with it.
 */
final class WetMedium {
    struct Options {
        /// Water depth laid per unit of coverage (at deposit weight 1).
        var water: Double
        /// Pigment mass laid per unit of coverage (at deposit weight 1).
        var mass: Double
        /// 0 transparent watercolour .. 1 opaque gouache.
        var body: Double
        /// Light paint mass laid per unit of coverage (at deposit weight 1).
        var light: Double
    }

    /// The strongest absorption (K) a sampled colour is scaled to.
    private static let SAMPLE_K = 3.0

    let world: WetWorld
    let laneId: String
    var options: Options

    init(_ world: WetWorld, _ laneId: String, _ options: Options) {
        self.world = world
        self.laneId = laneId
        self.options = options
    }

    func sample(_ rect: RasterRect, _ cov: [Float]) throws -> PaintSample? {
        let s = try world.sample(laneId, rect, cov)
        if !(s.wet > 0) || !(s.weight > 0) { return nil }
        let k0 = s.pigment[0] + s.settled[0]
        let k1 = s.pigment[1] + s.settled[1]
        let k2 = s.pigment[2] + s.settled[2]
        let k3 = s.pigment[3] + s.settled[3]
        let kmax = Swift.max(k0, k1, k2)
        if !(kmax > 1e-9) { return nil }
        let f = WetMedium.SAMPLE_K / kmax
        let rgb = pigmentColor(k0 * f, k1 * f, k2 * f, k3 * f)
        // Mass per wet cell, against a moderate wash (0.02 of K per cell).
        let density = Swift.min(1, (k0 + k1 + k2) / s.wet / 0.06)
        return PaintSample(rgb: rgb, contact: (s.wet / s.weight) * density)
    }

    func deposit(_ rect: RasterRect, _ cov: [Float], _ dep: Double, _ paint: [Double], field: [Float]? = nil) throws {
        let water = options.water, mass = options.mass, body = options.body
        let light = options.light * dep
        if let field {
            let n = rect.width * rect.height
            var out = [Float](repeating: 0, count: n * 4)
            for p in 0..<n {
                let one = pigmentOf([Double(field[p * 3]), Double(field[p * 3 + 1]), Double(field[p * 3 + 2])], body)
                for q in 0..<4 { out[p * 4 + q] = Float(one[q] * mass * dep) }
            }
            try world.paint(laneId, rect, cov, water: water * dep, pigment: nil, field: out, light: light)
            return
        }
        let one = pigmentOf(paint, body)
        let pig = (0..<4).map { one[$0] * mass * dep }
        try world.paint(laneId, rect, cov, water: water * dep, pigment: mass > 0 ? pig : nil, field: nil, light: light)
    }
}
