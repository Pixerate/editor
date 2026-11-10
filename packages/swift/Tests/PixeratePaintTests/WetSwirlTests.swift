import XCTest
@testable import PixeratePaint
import PixerateRaster

/// The vortex swirl on a wet layer (`WetWorld.swirl`): a fading stir, never the layer's flow map.
final class WetSwirlTests: XCTestCase {
    private let paper = WetPaperInput(absorption: 0.5, permeability: 0.5, roughness: 0.5, color: [250, 248, 240], heightAt: { _, _ in 0.5 })
    private let rect = RasterRect(x: 100, y: 100, width: 56, height: 56)

    private func wetWorld() throws -> WetWorld {
        let w = try WetWorld(width: 2 * WET_TILE, height: 2 * WET_TILE, paper: paper)
        try w.ensureLane("a")
        try w.paint("a", rect, nil, water: 0.6, pigment: [0.05, 0.05, 0.05, 0.05])
        return w
    }

    /// Spins around the middle of `rect`.
    private func spin(_ x: Double, _ y: Double) -> (Double, Double) {
        let dx = x - 128, dy = y - 128
        return (-dy * 0.004, dx * 0.004)
    }

    func testTheSwirlFadesOutWithoutBecomingTheFlowMap() throws {
        let w = try wetWorld()
        let shift = try w.swirl("a", rect, spin, rewetAmount: 0.25)
        XCTAssertGreaterThan(shift, 0)
        XCTAssertLessThanOrEqual(shift, 3)
        XCTAssertEqual(try w.swirlOf("a")?.remaining, SWIRL_FADE_INTERVALS)
        XCTAssertFalse(try w.hasFlow("a"))
        w.step(FREE_INTERVAL * 2)
        XCTAssertEqual(try w.swirlOf("a")?.remaining, SWIRL_FADE_INTERVALS - 2)
        w.step(FREE_INTERVAL * SWIRL_FADE_INTERVALS)
        XCTAssertNil(try w.swirlOf("a"))
        XCTAssertFalse(try w.hasFlow("a"))
    }

    func testANewSwirlReplacesTheLastOneInsteadOfChainingIt() throws {
        let w = try wetWorld()
        for _ in 0..<4 {
            try w.swirl("a", rect, spin)
            w.step(3)
        }
        XCTAssertEqual(try w.swirlOf("a")?.patches.count, 1)
        // Swirls at the same clock (symmetry copies of one stroke) share the slot, capped.
        for _ in 0..<12 { try w.swirl("a", rect, spin) }
        XCTAssertLessThanOrEqual(try w.swirlOf("a")?.patches.count ?? 0, 8)
    }

    func testSnapshotsKeepTheSwirlAndAMoveTranslatesIt() throws {
        let w = try wetWorld()
        try w.swirl("a", rect, spin)
        w.step(FREE_INTERVAL)
        let snap = w.snapshot()
        w.step(FREE_INTERVAL * SWIRL_FADE_INTERVALS)
        XCTAssertNil(try w.swirlOf("a"))
        w.restore(snap)
        XCTAssertEqual(try w.swirlOf("a")?.remaining, SWIRL_FADE_INTERVALS - 1)

        let moved = try WetWorld.moveSnapshot(snap, from: (w.width, w.height), to: (w.width + WET_TILE, w.height + WET_TILE), dx: WET_TILE, dy: WET_TILE) { _ in (nil, nil, nil) }
        let big = try WetWorld(width: w.width + WET_TILE, height: w.height + WET_TILE, paper: paper)
        big.restore(moved)
        XCTAssertEqual(try big.swirlOf("a")?.patches.first?.rect, RasterRect(x: rect.x + WET_TILE, y: rect.y + WET_TILE, width: rect.width, height: rect.height))
    }
}
