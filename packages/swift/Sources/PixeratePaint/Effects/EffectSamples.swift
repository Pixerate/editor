import Foundation
import PixerateCore
import PixerateRaster

/**
 Sample pictures for effect previews (`effects/ui.ts`: `effectSamplePicture`, `effectSampleInputs`),
 so previews of filters and transitions have something to change.
 */

/// A colourful, deterministic picture for previews of filters and transitions (`variant` 0 and 1 differ, for a transition's two sides).
public func effectSamplePicture(width: Int, height: Int, variant: Int = 0) -> EffectPixels {
    var p = EffectPixels(width: width, height: height)
    let wd = Double(Swift.max(1, width - 1)), hd = Double(Swift.max(1, height - 1))
    var i = 0
    for y in 0..<Swift.max(0, height) {
        for x in 0..<Swift.max(0, width) {
            let u = Double(x) / wd
            let v = Double(y) / hd
            let check = Double((Int((u * 4).rounded(.down)) + Int((v * 4).rounded(.down))) % 2)
            let rgb: (Double, Double, Double) = variant == 0
                ? (JS.round(40 + 200 * u), JS.round(80 + 120 * v), JS.round(200 - 120 * u) + check * 30)
                : (JS.round(230 - 60 * v), JS.round(190 - 100 * u), 60 + check * 40)
            p.data[i] = UInt8(rgb.0)
            p.data[i + 1] = UInt8(rgb.1)
            p.data[i + 2] = UInt8(rgb.2)
            p.data[i + 3] = 255
            i += 4
        }
    }
    return p
}

/// Sample pictures for an effect's image inputs (a transition's `to` gets the second variant).
public func effectSampleInputs(_ description: EffectDescription, width: Int, height: Int) -> [String: EffectPixels] {
    var inputs: [String: EffectPixels] = [:]
    for input in description.inputs where input["kind"]?.stringValue == "image" {
        guard let name = input["name"]?.stringValue else { continue }
        inputs[name] = effectSamplePicture(width: width, height: height, variant: name == "to" ? 1 : 0)
    }
    return inputs
}
