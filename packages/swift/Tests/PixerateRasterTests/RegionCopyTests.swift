import XCTest
@testable import PixerateRaster

/// `readRegion` and `writeRegion` copy whole rows at a time: every pixel must still land where `readPixel` finds it.
final class RegionCopyTests: XCTestCase {
    func testRegionsAcrossTileEdgesRoundTrip() {
        for ch in [1, 4] {
            let rect = RasterRect(x: -70, y: 190, width: 600, height: 330)
            var data = [UInt8](repeating: 0, count: rect.width * rect.height * ch)
            for i in 0..<data.count { data[i] = UInt8((i &* 31 &+ i / 7) % 251 + 1) }
            let surface = writeRegion(emptySurface(ch, 0), rect, data)
            XCTAssertTrue(readRegion(surface, rect) == data)
            // Pixel by pixel, inside and around the rectangle.
            for (x, y) in [(-70, 190), (529, 519), (0, 256), (255, 255), (256, 256), (-1, 300), (511, 400), (512, 511), (-71, 190), (530, 519), (100, 189), (100, 520)] {
                let inside = x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
                let i = ((y - rect.y) * rect.width + (x - rect.x)) * ch
                XCTAssertEqual(readPixel(surface, x, y), inside ? (0..<ch).map { Int(data[i + $0]) } : [Int](repeating: 0, count: ch), "\(ch) channels at (\(x), \(y))")
            }
            // A window that starts and ends inside tiles, over written and unwritten pixels.
            let window = RasterRect(x: 200, y: 100, width: 400, height: 300)
            let read = readRegion(surface, window)
            for y in stride(from: 0, to: window.height, by: 13) {
                for x in stride(from: 0, to: window.width, by: 11) {
                    let px = readPixel(surface, window.x + x, window.y + y)
                    for c in 0..<ch { XCTAssertEqual(Int(read[(y * window.width + x) * ch + c]), px[c]) }
                }
            }
            // Writing over part of it keeps the rest.
            let patch = RasterRect(x: 250, y: 250, width: 20, height: 12)
            let over = writeRegion(surface, patch, [UInt8](repeating: 7, count: patch.width * patch.height * ch))
            XCTAssertEqual(readPixel(over, 250, 250), [Int](repeating: 7, count: ch))
            XCTAssertEqual(readPixel(over, 269, 261), [Int](repeating: 7, count: ch))
            XCTAssertEqual(readPixel(over, 249, 250), readPixel(surface, 249, 250))
            XCTAssertEqual(readPixel(over, 270, 261), readPixel(surface, 270, 261))
        }
    }
}
