import Foundation

/**
 * One wet-media step for the 256 × 256 interior of a tile slot (`stepSlotTs` in
 * `paint/wet/kernel.ts`, the TypeScript kernel the conformance host forces). The TS kernel rounds
 * every intermediate to f32 with `Math.fround`; an f32 `+ − × ÷ √` computed in f64 and rounded
 * once is exactly the f32 operation, so here every intermediate is a `Float` and the order of
 * operations is the TS order. `Math.min` / `Math.max` keep JavaScript's signed-zero rules
 * (`fmin` / `fmax` below).
 *
 * A slot is `SLOT_PLANES` planes of 258 × 258 f32 (the tile plus a one-cell halo). The step reads
 * set `parity` (and the single planes) and writes the interior of the other set, the deposit
 * planes in place, and returns the tile's flags. See the TS file for the model, step by step.
 */

/// `Math.max` on floats (NaN wins; +0 over −0).
@inline(__always) func fmax(_ a: Float, _ b: Float) -> Float {
    if a.isNaN || b.isNaN { return .nan }
    if a == b { return a.sign == .minus ? b : a }
    return a > b ? a : b
}

/// `Math.min` on floats (NaN wins; −0 over +0).
@inline(__always) func fmin(_ a: Float, _ b: Float) -> Float {
    if a.isNaN || b.isNaN { return .nan }
    if a == b { return a.sign == .minus ? a : b }
    return a < b ? a : b
}

private let S = SLOT_SIDE
private let PL = WET_PLANE
private let EPS = Float(DRY_EPS)
private let UMAXF = Float(U_MAX)
private let UMAX2 = Float(U_MAX * U_MAX)
private let W0 = Float(4.0 / 9)
private let W1 = Float(1.0 / 9)
private let W2 = Float(1.0 / 36)
private let TINY = Float(1e-9)
private let DECAY = Float(0.99)
/// Neighbour n = x − eₖ as an offset, k = 1..8.
private let NB = [0, -1, -S, 1, S, -S - 1, -S + 1, S + 1, S - 1]
private let OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6]

/// Steps one slot. `f` is the slot's first float; `prm` the lane's packed parameters. Returns the tile's flags.
func wetStepSlot(_ f: UnsafeMutablePointer<Float>, _ parity: Int, _ prm: [Float]) -> UInt32 {
    let src = f + parity * SET_PLANES * PL
    let dst = f + (1 - parity) * SET_PLANES * PL
    let hP = f + P_H * PL
    let dP = f + P_D0 * PL
    let rhoS = src + P_RHO * PL
    let uxS = src + P_UX * PL
    let uyS = src + P_UY * PL
    let swS = src + P_SW * PL
    let pS = src + P_P0 * PL
    let eS = src + P_EDGE * PL
    let fxP = f + P_FX * PL
    let fyP = f + P_FY * PL

    let omega = prm[PARAM.omega]
    let tau = prm[PARAM.tau]
    let evap = prm[PARAM.evap]
    let edgeEvap = prm[PARAM.edgeEvap]
    let mobility = prm[PARAM.mobility]
    let depRate = prm[PARAM.depRate]
    let pickup = prm[PARAM.pickup]
    let absorption = prm[PARAM.absorption]
    let invCap = prm[PARAM.invCap]
    let blockScale = prm[PARAM.blockScale]
    let rough = prm[PARAM.rough]
    let pinT = prm[PARAM.pinT]
    let gx0 = prm[PARAM.gx]
    let gy0 = prm[PARAM.gy]
    let flowK = prm[PARAM.flowK]
    let gran = prm[PARAM.granulation]
    let edgeDep = prm[PARAM.edgeDep]
    let bloom = prm[PARAM.bloom]
    let paperEvap = prm[PARAM.paperEvap]
    let hasFlow = prm[PARAM.hasFlow] != 0
    let bleed = prm[PARAM.bleed]

    var fin = [Float](repeating: 0, count: 9)
    var pNew = [Float](repeating: 0, count: MASS_CHANNELS)
    var flags: UInt32 = 0
    fin.withUnsafeMutableBufferPointer { finB in
        pNew.withUnsafeMutableBufferPointer { pNewB in
            let fin = finB.baseAddress!
            let pNew = pNewB.baseAddress!
            for y in 1...256 {
                for x in 1...256 {
                    let c = y * S + x
                    let hx = hP[c]
                    let kx = blockScale * hx
                    let rx = rhoS[c]
                    let sx = swS[c]
                    let damp = fmax(0, 1 - sx * invCap)
                    let pinX = (pinT + rough * hx) * damp
                    let rxDry = rx < EPS
                    let xWall = hx < 0

                    // 1. streaming with partial bounce-back and pinning
                    fin[0] = src[c]
                    var dryNb: Float = 0
                    for k in 1...8 {
                        let n = c + NB[k]
                        let hn = hP[n]
                        let rn = rhoS[n]
                        let sn = swS[n]
                        let wall = hn < 0
                        let rnDry = rn < EPS
                        let dampN = fmax(0, 1 - sn * invCap)
                        if rnDry && !wall { dryNb = dryNb + dampN }
                        var b = fmax(kx, blockScale * hn)
                        let pinN = (pinT + rough * hn) * dampN
                        if wall || xWall || (rxDry && rn < pinX) || (rnDry && rx < pinN) { b = 1 }
                        fin[k] = (1 - b) * src[k * PL + n] + b * src[OPP[k] * PL + c]
                    }

                    // 2. depth, velocity, forcing
                    let rho = fin[0] + fin[1] + fin[2] + fin[3] + fin[4] + fin[5] + fin[6] + fin[7] + fin[8]
                    let mx = fin[1] - fin[3] + fin[5] - fin[6] - fin[7] + fin[8]
                    let my = fin[2] - fin[4] + fin[5] + fin[6] - fin[7] - fin[8]
                    var gx = gx0
                    var gy = gy0
                    if hasFlow {
                        gx = gx + flowK * fxP[c]
                        gy = gy + flowK * fyP[c]
                    }
                    var ux: Float = 0
                    var uy: Float = 0
                    if rho > EPS {
                        ux = mx / rho + tau * gx
                        uy = my / rho + tau * gy
                    }
                    let sp2 = ux * ux + uy * uy
                    if sp2 > UMAX2 {
                        let sc = UMAXF / sp2.squareRoot()
                        ux = ux * sc
                        uy = uy * sc
                    }

                    // 3. absorption and evaporation
                    let absorbed = fmin(rho, absorption * (1 - 0.5 * hx) * rho * damp)
                    let ex = eS[c]
                    let ev: Float = rho > 0 ? evap * (1 + edgeEvap * ex) : 0
                    let rhoNew = fmax(0, rho - absorbed - ev)
                    let scale: Float = rho > TINY ? rhoNew / rho : 0
                    let sNew = fmax(0, sx + absorbed - (sx > 0 ? paperEvap : 0))
                    dst[P_SW * PL + c] = sNew

                    // 4. collision, then scale
                    let usq = 1.5 * (ux * ux + uy * uy)
                    let wr0 = W0 * rho
                    let wr1 = W1 * rho
                    let wr2 = W2 * rho
                    var feq = wr0 * (1 - usq)
                    dst[c] = (fin[0] + omega * (feq - fin[0])) * scale
                    for k in 1...8 {
                        let eu: Float
                        var wr = wr1
                        switch k {
                        case 1: eu = ux
                        case 2: eu = uy
                        case 3: eu = -ux
                        case 4: eu = -uy
                        case 5: eu = ux + uy; wr = wr2
                        case 6: eu = uy - ux; wr = wr2
                        case 7: eu = -(ux + uy); wr = wr2
                        default: eu = ux - uy; wr = wr2
                        }
                        feq = wr * (1 + 3 * eu + 4.5 * eu * eu - usq)
                        dst[k * PL + c] = (fin[k] + omega * (feq - fin[k])) * scale
                    }

                    // 5. pigment: upwind advection with the last step's velocities, plus bleed
                    let rxWet = !rxDry
                    let uxc = uxS[c]
                    let uyc = uyS[c]
                    for q in 0..<MASS_CHANNELS { pNew[q] = pS[q * PL + c] }
                    for face in 0..<4 {
                        let nb = c + (face == 0 ? 1 : face == 1 ? -1 : face == 2 ? S : -S)
                        let open = rxWet && rhoS[nb] >= EPS
                        let uf: Float = face == 0 ? mobility * (uxc + uxS[nb]) : face == 1 ? mobility * (uxS[nb] + uxc) : face == 2 ? mobility * (uyc + uyS[nb]) : mobility * (uyS[nb] + uyc)
                        let out = face == 0 || face == 2
                        for q in 0..<MASS_CHANNELS {
                            let pc = pS[q * PL + c]
                            let pn = pS[q * PL + nb]
                            let flux: Float = out ? (uf > 0 ? uf * pc : uf * pn) : (uf > 0 ? uf * pn : uf * pc)
                            let diff = bleed * (pn - pc)
                            let v = out ? pNew[q] - flux + diff : pNew[q] + flux + diff
                            if open { pNew[q] = v }
                        }
                    }

                    // 6. deposition and pickup
                    let dryNow = rhoNew < EPS
                    let rate = depRate * (1 + gran * (1 - hx)) * (1 + edgeDep * ex)
                    let lift: Float = dryNow ? 0 : pickup * fmin(rhoNew, 1) * (1 + bloom * fmax(0, rhoNew - rx))
                    for q in 0..<MASS_CHANNELS {
                        let pq = fmax(0, pNew[q])
                        let dq = dP[q * PL + c]
                        let dep = dryNow ? pq : fmin(pq, pq * rate)
                        let lq = dq * lift
                        dst[(P_P0 + q) * PL + c] = pq - dep + lq
                        dP[q * PL + c] = dq + dep - lq
                    }
                    // the edge field
                    let mean4 = (eS[c + 1] + eS[c - 1] + eS[c + S] + eS[c - S]) * 0.25
                    let eNew = fmin(1, fmax(fmin(1, dryNb * 0.25), DECAY * mean4))
                    dst[P_EDGE * PL + c] = dryNow ? 0 : eNew
                    dst[P_RHO * PL + c] = rhoNew
                    dst[P_UX * PL + c] = dryNow ? 0 : ux
                    dst[P_UY * PL + c] = dryNow ? 0 : uy
                    let alive = rhoNew > 0 || sNew > 0
                    if alive { flags |= FLAG_ALIVE | edgeBits(x - 1, y - 1) }
                    if !dryNow { flags |= FLAG_WET }
                }
            }
        }
    }
    return flags
}
