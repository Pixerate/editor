import XCTest
@testable import PixeratePaint
import PixerateRaster

/// Which wet tiles get reshaded, and what the display reports as changed.
final class WetDisplayTests: XCTestCase {
    private let paper = WetPaperInput(absorption: 0.5, permeability: 0.5, roughness: 0.5, color: [250, 248, 240], heightAt: { _, _ in 0.5 })

    /// Wet paint in the middle of tile `tx` of the top row, too small to wake its neighbours.
    private func wetTile(_ w: WetWorld, _ tx: Int) throws {
        try w.paint("a", RasterRect(x: tx * WET_TILE + 118, y: 118, width: 20, height: 20), nil, water: 0.6, pigment: [0.05, 0.05, 0.05, 0.05])
    }

    func testCappedShadingReachesEveryTileHoweverLongItHasBeenLive() throws {
        let w = try WetWorld(width: 8 * WET_TILE, height: WET_TILE, paper: paper)
        try w.ensureLane("a")
        for tx in 0..<4 { try wetTile(w, tx) }
        w.step(20)
        // These four have far fewer steps behind them than the first four.
        for tx in 4..<8 { try wetTile(w, tx) }
        _ = try w.display("a")

        var reached = Set<Int>()
        for _ in 0..<4 {
            w.step(1)
            for r in try w.display("a", maxTiles: 2).changed { reached.insert(r.x / WET_TILE) }
        }
        XCTAssertEqual(reached, Set(0..<8), "2 tiles a round over 4 rounds is every tile once")
    }

    func testAFreedTileIsReportedAsChangedOnce() throws {
        let w = try WetWorld(width: 2 * WET_TILE, height: WET_TILE, paper: paper)
        try w.ensureLane("a")
        for tx in 0..<2 { try wetTile(w, tx) }
        _ = try w.display("a")

        // Drying a whole tile bakes and frees it, so it is no longer among the tiles to shade.
        _ = try w.dry("a", RasterRect(x: 0, y: 0, width: WET_TILE, height: WET_TILE))
        XCTAssertEqual(try w.display("a").changed, [RasterRect(x: 0, y: 0, width: WET_TILE, height: WET_TILE)])
        XCTAssertEqual(try w.display("a").changed, [])
    }

    func testTickKeepsTheStepsItCouldNotRun() throws {
        let c = try PaintEditorController(width: 256, height: 256, brushId: "watercolor-round", color: "#1e5aa8")
        _ = try c.paintStroke(PaintStrokeInit(seed: 1), points: [PenPoint(x: 60, y: 60, pressure: 0.8), PenPoint(x: 200, y: 200, pressure: 0.8)])
        XCTAssertEqual(c.tickWet(1000, maxSteps: 2), 0)
        // A second at 120 steps a second owes more than the cap of 4 × maxSteps: 8 owed, 2 run, 6 kept.
        XCTAssertEqual(c.tickWet(2000, maxSteps: 2), 2)
        XCTAssertEqual(c.tickWet(2000.001, maxSteps: 2), 2)
        XCTAssertEqual(c.tickWet(2000.002, maxSteps: 2), 2)
        XCTAssertEqual(c.tickWet(2000.003, maxSteps: 2), 2)
        XCTAssertEqual(c.tickWet(2000.004, maxSteps: 2), 0)
    }
}
