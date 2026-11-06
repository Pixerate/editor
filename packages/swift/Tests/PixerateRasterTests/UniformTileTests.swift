import XCTest
@testable import PixerateRaster

/// `finishTile` spotting tiles of one value.
final class UniformTileTests: XCTestCase {
    func testAUniformColourTileIsShared() {
        var data = [UInt8](repeating: 0, count: TILE_PIXELS * 4)
        for i in stride(from: 0, to: data.count, by: 4) {
            data[i] = 10
            data[i + 1] = 20
            data[i + 2] = 30
            data[i + 3] = 40
        }
        XCTAssertEqual(finishTile(data, 4, 0)?.uniform, packRgba(10, 20, 30, 40))
        data[data.count - 2] = 31
        XCTAssertNil(finishTile(data, 4, 0)?.uniform)
    }

    func testAUniformMaskTileIsShared() {
        var data = [UInt8](repeating: 7, count: TILE_PIXELS)
        XCTAssertEqual(finishTile(data, 1, 0)?.uniform, 7)
        data[data.count - 1] = 8
        XCTAssertNil(finishTile(data, 1, 0)?.uniform)
    }

    func testAnAllDefaultTileIsDropped() {
        XCTAssertNil(finishTile([UInt8](repeating: 0, count: TILE_PIXELS * 4), 4, 0))
    }
}
