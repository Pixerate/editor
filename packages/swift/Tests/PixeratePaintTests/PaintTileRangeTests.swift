import Foundation
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// Paint code that keys tiles straight from pixel coordinates (coverage, the paint exchange, culture)
/// stays inside the surface tile range, as the TS core does: a pixel layer offset past ±8388608 px
/// must not alias a stroke onto another tile of that layer (#852).
final class PaintTileRangeTests: XCTestCase {
    private let far = 9_000_000

    private final class Target: PaintTileTarget {
        var tiles: [TileKey: ByteTile] = [:]
        var asked: [[Int]] = []
        let offset: LayerOffset
        let lockTransparency = false
        let selection: PaintSelection? = nil
        init(_ offset: LayerOffset) { self.offset = offset }
        func readTile(_ tx: Int, _ ty: Int) -> ByteTile? {
            asked.append([tx, ty])
            return tiles[tileKey(tx, ty)]
        }
        func writeTile(_ tx: Int, _ ty: Int) -> ByteTile {
            asked.append([tx, ty])
            let k = tileKey(tx, ty)
            if let t = tiles[k] { return t }
            let t = ByteTile([UInt8](repeating: 0, count: TILE * TILE * 4))
            tiles[k] = t
            return t
        }
    }

    func testTileKeyInKeysTheRangeAndNothingPastIt() {
        for (tx, ty) in [(0, 0), (MIN_TILE, MIN_TILE), (MAX_TILE, MAX_TILE), (-1, 7)] { XCTAssertEqual(tileKeyIn(tx, ty), tileKey(tx, ty)) }
        for (tx, ty) in [(MIN_TILE - 1, 0), (0, MAX_TILE + 1), (-35157, -1), (1 << 40, 0)] { XCTAssertEqual(tileKeyIn(tx, ty), NO_TILE_KEY) }
        XCTAssertEqual(tileKey(MAX_TILE + 1, 0), tileKey(MIN_TILE, 1))
    }

    func testCoverageMapDropsCoveragePastTheRange() {
        let cov = CoverageMap()
        let x = (MAX_TILE + 1) * TILE
        cov.accumulate(RasterRect(x: x - 2, y: 0, width: 4, height: 1), [1, 1, 1, 1], 1)
        XCTAssertEqual(Array(cov.tiles.keys), [tileKey(MAX_TILE, 0)])
        XCTAssertEqual(cov.get(x - 1, 0), 1)
        XCTAssertEqual(cov.get(x, 0), 0)
        XCTAssertEqual(cov.get(MIN_TILE * TILE, TILE), 0)
        let farMap = CoverageMap()
        farMap.accumulate(RasterRect(x: -1_000_000_000_000, y: 5, width: 3, height: 3), [Float](repeating: 1, count: 9), 1)
        XCTAssertTrue(farMap.tiles.isEmpty)
        XCTAssertNil(farMap.bounds)
    }

    func testPaintExchangeReadsPastTheRangeAsEmptyAndDropsWrites() {
        let target = Target(LayerOffset(x: far, y: 0))
        let m = TileMedium(target)
        m.deposit(RasterRect(x: 10, y: 10, width: 4, height: 4), [Float](repeating: 1, count: 16), 1, [1, 0, 0], nil)
        XCTAssertEqual(m.locate(10, 10, false), -1)
        XCTAssertNil(m.sample(RasterRect(x: 10, y: 10, width: 4, height: 4), [Float](repeating: 1, count: 16)))
        XCTAssertTrue(target.asked.isEmpty)
        XCTAssertTrue(target.tiles.isEmpty)
        m.deposit(RasterRect(x: far + 3, y: 2, width: 1, height: 1), [1], 1, [1, 0, 0], nil)
        XCTAssertEqual(Array(target.tiles.keys), [tileKey(0, 0)])
        XCTAssertGreaterThanOrEqual(m.locate(far + 3, 2, false), 0)
    }

    func testCultureSeedsNoSporesPastTheRange() {
        func seeds(_ offsetX: Int, _ x0: Double) -> Int {
            seedCultureFromStroke(
                points: [Point2(x: x0 + 20, y: 30), Point2(x: x0 + 80, y: 30)],
                brushSize: 8,
                color: [20, 40, 60],
                culture: DEFAULT_CULTURE,
                strokeSeed: 7,
                beforeSurface: emptySurface(4),
                afterSurface: emptySurface(4),
                canvasWidth: 96,
                canvasHeight: 64,
                offsetX: offsetX
            ).seedsAdded
        }
        XCTAssertGreaterThan(seeds(0, 0), 0)
        XCTAssertEqual(seeds(far, -Double(far)), 0)
    }
}
