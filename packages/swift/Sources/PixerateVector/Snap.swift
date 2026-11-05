import Foundation
import PixerateCore
import PixerateRaster

// The snapping options the commands read and set (`vector/snap.ts`): the default construction
// angles and polar tracking increments. The snapping itself (guides, targets, tracking) happens at
// the pointer, which the Swift controller does not handle yet.

/// The polar / construction angles drawing snaps to by default, in degrees (`VECTOR_CONSTRUCTION_ANGLES`).
public let VECTOR_CONSTRUCTION_ANGLES: [Double] = [0, 45, 90, 135]

/// Every multiple of `increment` degrees below 360, then `additional` angles, each in [0, 360)
/// and without repeats (`vectorPolarAngles`); just 0 for an increment that is not positive.
public func vectorPolarAngles(_ increment: Double, _ additional: [Double] = []) -> [Double] {
    var out: [Double] = []
    func push(_ a: Double) {
        let n = (a.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        if out.count < 360 && !out.contains(where: { abs((n - $0 + 540).truncatingRemainder(dividingBy: 360) - 180) < 1e-9 }) { out.append(n) }
    }
    if increment.isFinite && increment > 1e-6 {
        let n = Int(JS.min(360, JS.max(1, JS.ceil(360 / increment - 1e-9))))
        for k in 0 ..< n { push(Double(k) * increment) }
    } else {
        push(0)
    }
    for a in additional where a.isFinite { push(a) }
    return out
}
