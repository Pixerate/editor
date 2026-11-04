import Foundation
import PixerateWetKernel

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

    var flags: UInt32 = 0
    // The per-direction work is unrolled with constant offsets (the same operations in the same
    // order as the loops of the TS kernel, so the same bits): indexing small arrays by direction in
    // the inner loop was most of the cost.
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

            // 1. streaming with partial bounce-back and pinning (n = x − eₖ)
            var dryNb: Float = 0
            @inline(__always) func stream(_ k: Int, _ off: Int, _ opp: Int) -> Float {
                let n = c + off
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
                return (1 - b) * src[k * PL + n] + b * src[opp * PL + c]
            }
            let f0 = src[c]
            let f1 = stream(1, -1, 3)
            let f2 = stream(2, -S, 4)
            let f3 = stream(3, 1, 1)
            let f4 = stream(4, S, 2)
            let f5 = stream(5, -S - 1, 7)
            let f6 = stream(6, -S + 1, 8)
            let f7 = stream(7, S + 1, 5)
            let f8 = stream(8, S - 1, 6)

            // 2. depth, velocity, forcing
            let rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8
            let mx = f1 - f3 + f5 - f6 - f7 + f8
            let my = f2 - f4 + f5 + f6 - f7 - f8
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
            dst[c] = (f0 + omega * (wr0 * (1 - usq) - f0)) * scale
            @inline(__always) func collide(_ k: Int, _ fk: Float, _ wr: Float, _ eu: Float) {
                let feq = wr * (1 + 3 * eu + 4.5 * eu * eu - usq)
                dst[k * PL + c] = (fk + omega * (feq - fk)) * scale
            }
            collide(1, f1, wr1, ux)
            collide(2, f2, wr1, uy)
            collide(3, f3, wr1, -ux)
            collide(4, f4, wr1, -uy)
            collide(5, f5, wr2, ux + uy)
            collide(6, f6, wr2, uy - ux)
            collide(7, f7, wr2, -(ux + uy))
            collide(8, f8, wr2, ux - uy)

            // 5. pigment: upwind advection with the last step's velocities, plus bleed
            let rxWet = !rxDry
            let uxc = uxS[c]
            let uyc = uyS[c]
            var p0 = pS[c], p1 = pS[PL + c], p2 = pS[2 * PL + c], p3 = pS[3 * PL + c], p4 = pS[4 * PL + c]
            @inline(__always) func face(_ nb: Int, _ uf: Float, _ out: Bool) {
                if !(rxWet && rhoS[nb] >= EPS) { return }
                @inline(__always) func move(_ q: Int, _ p: inout Float) {
                    let pc = pS[q * PL + c]
                    let pn = pS[q * PL + nb]
                    let flux: Float = out ? (uf > 0 ? uf * pc : uf * pn) : (uf > 0 ? uf * pn : uf * pc)
                    let diff = bleed * (pn - pc)
                    p = out ? p - flux + diff : p + flux + diff
                }
                move(0, &p0)
                move(1, &p1)
                move(2, &p2)
                move(3, &p3)
                move(4, &p4)
            }
            face(c + 1, mobility * (uxc + uxS[c + 1]), true)
            face(c - 1, mobility * (uxS[c - 1] + uxc), false)
            face(c + S, mobility * (uyc + uyS[c + S]), true)
            face(c - S, mobility * (uyS[c - S] + uyc), false)

            // 6. deposition and pickup
            let dryNow = rhoNew < EPS
            let rate = depRate * (1 + gran * (1 - hx)) * (1 + edgeDep * ex)
            let lift: Float = dryNow ? 0 : pickup * fmin(rhoNew, 1) * (1 + bloom * fmax(0, rhoNew - rx))
            @inline(__always) func settle(_ q: Int, _ p: Float) {
                let pq = fmax(0, p)
                let dq = dP[q * PL + c]
                let dep = dryNow ? pq : fmin(pq, pq * rate)
                let lq = dq * lift
                dst[(P_P0 + q) * PL + c] = pq - dep + lq
                dP[q * PL + c] = dq + dep - lq
            }
            settle(0, p0)
            settle(1, p1)
            settle(2, p2)
            settle(3, p3)
            settle(4, p4)
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
    return flags
}

// MARK: - SIMD

/// The slot layout and constants for the C kernel, from this module's model.
private let WET_LAYOUT: PixerateWetLayout = PixerateWetLayout(
    side: Int32(S), plane: Int32(PL), setPlanes: Int32(SET_PLANES), tile: Int32(WET_TILE), strip: Int32(STRIP),
    pRho: Int32(P_RHO), pUx: Int32(P_UX), pUy: Int32(P_UY), pSw: Int32(P_SW), pP0: Int32(P_P0), pEdge: Int32(P_EDGE), pD0: Int32(P_D0), pH: Int32(P_H), pFx: Int32(P_FX), pFy: Int32(P_FY),
    omega: Int32(PARAM.omega), tau: Int32(PARAM.tau), evap: Int32(PARAM.evap), edgeEvap: Int32(PARAM.edgeEvap), mobility: Int32(PARAM.mobility), depRate: Int32(PARAM.depRate),
    pickup: Int32(PARAM.pickup), absorption: Int32(PARAM.absorption), invCap: Int32(PARAM.invCap), blockScale: Int32(PARAM.blockScale), rough: Int32(PARAM.rough), pinT: Int32(PARAM.pinT),
    gx: Int32(PARAM.gx), gy: Int32(PARAM.gy), flowK: Int32(PARAM.flowK), granulation: Int32(PARAM.granulation), edgeDep: Int32(PARAM.edgeDep), bloom: Int32(PARAM.bloom),
    paperEvap: Int32(PARAM.paperEvap), hasFlow: Int32(PARAM.hasFlow), bleed: Int32(PARAM.bleed),
    flagAlive: FLAG_ALIVE, flagLeft: FLAG_LEFT, flagRight: FLAG_RIGHT, flagTop: FLAG_TOP, flagBottom: FLAG_BOTTOM, flagWet: FLAG_WET,
    eps: EPS, umax: UMAXF, umax2: UMAX2, w0: W0, w1: W1, w2: W2, tiny: TINY, decay: DECAY
)

/**
 * `wetStepSlot` on four cells at a time (`PixerateWetKernel`, C with clang vector extensions), as
 * the TS core's WebAssembly kernel does. Same bits as the scalar kernel, which stays the readable
 * reference (`WetKernelTests` compares them); several times faster.
 */
func wetStepSlotSIMD(_ f: UnsafeMutablePointer<Float>, _ parity: Int, _ prm: [Float]) -> UInt32 {
    prm.withUnsafeBufferPointer { p in
        withUnsafePointer(to: WET_LAYOUT) { pixerate_wet_step(f, Int32(parity), p.baseAddress!, $0) }
    }
}
