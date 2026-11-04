import Foundation
import PixerateCore
import PixerateRaster

/**
 * The wet-media model (`paint/wet/model.ts`): water and pigment on paper, simulated per cell on
 * 256 px tiles. Water is a D2Q9 lattice Boltzmann fluid, pigment is Kubelka-Munk absorption and
 * scattering carried by the water, and light paint is a fifth mass channel moving with it. See the
 * TS file for the model and its sources; `wetStepSlot` (`WetKernel.swift`) is one step of it, in
 * exact f32 arithmetic, bit-exact with the TypeScript kernel.
 */

/// Tile side in cells (the raster tile size).
public let WET_TILE = 256
/// A tile slot's side: the tile plus a one-cell halo on each side.
public let SLOT_SIDE = 258
/// Floats per plane of a slot.
public let WET_PLANE = SLOT_SIDE * SLOT_SIDE

/// Planes in each ping-ponged set: f0..f8, depth, velocity, paper water, 4 pigment channels, suspended light, edge.
public let SET_PLANES = 19
let P_RHO = 9
let P_UX = 10
let P_UY = 11
/// Water held in the paper.
let P_SW = 12
/// Suspended pigment: K red, K green, K blue, S; then suspended light (`P_P0 + 4`).
let P_P0 = 13
/// Suspended light paint.
let P_L = P_P0 + 4
/// Edge: 1 at the wet front, fading over a few cells into the wet area (0 where dry).
let P_EDGE = 18
/// Single planes after the two sets: deposited pigment K r, g, b, S.
let P_D0 = 2 * SET_PLANES
/// Settled light.
let P_DL = P_D0 + 4
/// Paper height (−1 marks the off-canvas halo).
let P_H = P_D0 + 5
let P_FX = P_H + 1
let P_FY = P_H + 2
public let SLOT_PLANES = P_FY + 1
let SLOT_FLOATS = SLOT_PLANES * WET_PLANE
/// Pigment channels per cell.
let PIGMENT_CHANNELS = 4
/// Mass channels per cell: the 4 pigment channels and light.
let MASS_CHANNELS = 5

/// D2Q9 lattice velocities: 0 rest, 1–4 axis (E, S, W, N in screen space), 5–8 diagonals.
let WET_EX: [Double] = [0, 1, 0, -1, 0, 1, -1, -1, 1]
let WET_EY: [Double] = [0, 0, 1, 0, -1, 1, 1, -1, -1]
let W9: [Double] = [4.0 / 9, 1.0 / 9, 1.0 / 9, 1.0 / 9, 1.0 / 9, 1.0 / 36, 1.0 / 36, 1.0 / 36, 1.0 / 36]

/// Water shallower than this counts as dry.
public let DRY_EPS = 1e-3
/// Fluid speed cap in cells per step.
let U_MAX = 0.25
/// A tile's wet cells within this many cells of an edge wake the neighbouring tile.
let STRIP = 64
/// Steps per batch at most.
let MAX_BATCH = 32
/// Dry tiles are baked and freed only on steps that are multiples of this.
let FREE_INTERVAL = 32

let FLAG_ALIVE: UInt32 = 1
let FLAG_LEFT: UInt32 = 2
let FLAG_RIGHT: UInt32 = 4
let FLAG_TOP: UInt32 = 8
let FLAG_BOTTOM: UInt32 = 16
let FLAG_WET: UInt32 = 32

/// f32 parameters per lane.
let PARAM_FLOATS = 32

enum PARAM {
    static let omega = 0
    static let tau = 1
    static let evap = 2
    static let edgeEvap = 3
    static let mobility = 4
    static let depRate = 5
    static let pickup = 6
    static let absorption = 7
    static let invCap = 8
    static let blockScale = 9
    static let rough = 10
    static let pinT = 11
    static let gx = 12
    static let gy = 13
    static let flowK = 14
    static let granulation = 15
    static let edgeDep = 16
    static let bloom = 17
    static let paperEvap = 18
    static let hasFlow = 19
    static let bleed = 20
}

/// A wet layer's settings, each 0..1 (`WetParams`).
public struct WetParams: Equatable, Sendable {
    public var viscosity: Double
    public var evaporation: Double
    public var edgeDarkening: Double
    public var pigmentWeight: Double
    public var granulation: Double
    public var pickup: Double
    public var fixture: Double
    public var bloom: Double
    public var bleed: Double

    public init(viscosity: Double, evaporation: Double, edgeDarkening: Double, pigmentWeight: Double, granulation: Double, pickup: Double, fixture: Double, bloom: Double, bleed: Double) {
        self.viscosity = viscosity
        self.evaporation = evaporation
        self.edgeDarkening = edgeDarkening
        self.pigmentWeight = pigmentWeight
        self.granulation = granulation
        self.pickup = pickup
        self.fixture = fixture
        self.bloom = bloom
        self.bleed = bleed
    }

    public subscript(key: String) -> Double {
        get {
            switch key {
            case "viscosity": viscosity
            case "evaporation": evaporation
            case "edgeDarkening": edgeDarkening
            case "pigmentWeight": pigmentWeight
            case "granulation": granulation
            case "pickup": pickup
            case "fixture": fixture
            case "bloom": bloom
            default: bleed
            }
        }
        set {
            switch key {
            case "viscosity": viscosity = newValue
            case "evaporation": evaporation = newValue
            case "edgeDarkening": edgeDarkening = newValue
            case "pigmentWeight": pigmentWeight = newValue
            case "granulation": granulation = newValue
            case "pickup": pickup = newValue
            case "fixture": fixture = newValue
            case "bloom": bloom = newValue
            default: bleed = newValue
            }
        }
    }

    /// In `WET_PARAM_KEYS` order, as the TS core writes it.
    public var json: JSONValue {
        var o = JSONObject()
        for k in WET_PARAM_KEYS { o[k] = .number(self[k]) }
        return .object(o)
    }
}

public let DEFAULT_WET_PARAMS = WetParams(viscosity: 0.3, evaporation: 0.45, edgeDarkening: 0.5, pigmentWeight: 0.3, granulation: 0.4, pickup: 0.2, fixture: 0.2, bloom: 0.4, bleed: 0.3)

public let WET_PARAM_KEYS = ["viscosity", "evaporation", "edgeDarkening", "pigmentWeight", "granulation", "pickup", "fixture", "bloom", "bleed"]

/// The paper as wet media read it (all 0..1).
public struct WetPaper: Sendable {
    public var absorption: Double
    public var permeability: Double
    public var roughness: Double
}

public let DEFAULT_WET_PAPER = WetPaper(absorption: 0.7, permeability: 0.5, roughness: 0.6)

/// Canvas tilt (shared by every wet layer): water runs downhill.
public struct WetTilt: Equatable, Sendable {
    /// Degrees from flat, 0 (flat) .. 90 (upright).
    public var angle: Double
    /// Which way is downhill, degrees clockwise from canvas down.
    public var direction: Double
    public init(angle: Double, direction: Double) {
        self.angle = angle
        self.direction = direction
    }
    public var json: JSONValue { ["angle": .number(angle), "direction": .number(direction)] }
}

public let FLAT_TILT = WetTilt(angle: 0, direction: 0)

/// Settings with every field in range; missing fields come from `base`.
public func normalizeWetParams(_ raw: JSONObject = [:], _ base: WetParams = DEFAULT_WET_PARAMS) -> WetParams {
    var out = base
    for k in WET_PARAM_KEYS {
        if let v = raw[k]?.numberValue, v.isFinite { out[k] = Swift.min(1, Swift.max(0, v)) }
    }
    return out
}

public func normalizeTilt(angle rawAngle: Double?, direction rawDirection: Double?, _ base: WetTilt = FLAT_TILT) -> WetTilt {
    let angle = rawAngle.flatMap { $0.isFinite ? Swift.min(90, Swift.max(0, $0)) : nil } ?? base.angle
    var direction = rawDirection.flatMap { $0.isFinite ? $0 : nil } ?? base.direction
    direction = (direction.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    return WetTilt(angle: angle, direction: direction)
}

/// Kinematic viscosity (lattice units) for `viscosity` 0..1: 0.02 .. 1.5, exponential.
func latticeViscosity(_ v: Double) -> Double { 0.02 * JS.pow(75, v) }

/// Water a cell of paper holds when saturated, in depth units.
let PAPER_CAPACITY = 0.08
/// Largest tilt acceleration (cells per step²), at 90°.
let MAX_TILT_ACCEL = 0.025

/// Packs a lane's settings into the f32 block the kernel reads. `flowStrength` 0 turns the flow map off.
func packWetParams(_ params: WetParams, _ paper: WetPaper, _ tilt: WetTilt, _ flowStrength: Double) -> [Float] {
    var out = [Float](repeating: 0, count: PARAM_FLOATS)
    let nu = latticeViscosity(params.viscosity)
    let tau = 3 * nu + 0.5
    let g = MAX_TILT_ACCEL * JS.sin((tilt.angle * Double.pi) / 180)
    let dir = (tilt.direction * Double.pi) / 180
    out[PARAM.omega] = Float(1 / tau)
    out[PARAM.tau] = Float(tau)
    out[PARAM.evap] = Float(1e-3 * params.evaporation * params.evaporation)
    out[PARAM.edgeEvap] = Float(params.edgeDarkening * 12)
    out[PARAM.mobility] = Float(0.5 * (1 - 0.5 * params.pigmentWeight))
    out[PARAM.depRate] = Float(0.019 * params.fixture * (0.5 + params.pigmentWeight))
    out[PARAM.pickup] = Float(0.01 * params.pickup)
    out[PARAM.absorption] = Float(0.0015 * paper.absorption)
    out[PARAM.invCap] = Float(1 / PAPER_CAPACITY)
    out[PARAM.blockScale] = Float(0.05 * (1 - paper.permeability))
    out[PARAM.rough] = Float(0.15 * paper.roughness)
    out[PARAM.pinT] = Float(0.2)
    out[PARAM.gx] = Float(-g * JS.sin(dir))
    out[PARAM.gy] = Float(g * JS.cos(dir))
    out[PARAM.flowK] = Float(flowStrength)
    out[PARAM.granulation] = Float(1.2 * params.granulation * paper.roughness)
    out[PARAM.edgeDep] = Float(params.edgeDarkening * 3)
    out[PARAM.bloom] = Float(60 * params.bloom)
    out[PARAM.paperEvap] = Float(0.5e-3 * params.evaporation * params.evaporation)
    out[PARAM.hasFlow] = flowStrength != 0 ? 1 : 0
    out[PARAM.bleed] = Float(0.05 * params.bleed)
    return out
}

/// Flag bits for a wet (or alive) cell at tile-local (lx, ly): which neighbours it wakes.
@inline(__always) func edgeBits(_ lx: Int, _ ly: Int) -> UInt32 {
    var b: UInt32 = 0
    if lx < STRIP { b |= FLAG_LEFT }
    if lx >= WET_TILE - STRIP { b |= FLAG_RIGHT }
    if ly < STRIP { b |= FLAG_TOP }
    if ly >= WET_TILE - STRIP { b |= FLAG_BOTTOM }
    return b
}
