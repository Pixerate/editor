import PixerateVector
import XCTest

// No `@testable import` here: this file only uses what a host outside PixerateVector can see (#747).
final class VectorPublicInitTests: XCTestCase {
    func testHostBuildsWiggleParams() {
        let w = VectorWiggleParams(size: 4, detail: 10, smooth: true, speed: 0, correlation: 0, phase: 0, seed: 1, time: 0)
        XCTAssertTrue(wigglePaths([], w).isEmpty)
    }
}
