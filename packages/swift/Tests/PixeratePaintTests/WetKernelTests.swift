import XCTest
@testable import PixeratePaint
import PixerateCore
import PixerateRaster

/// The fast wet step (`wetStepSlotSIMD` on several threads) against the scalar reference, bit for bit.
final class WetKernelTests: XCTestCase {
    private let paper = WetPaperInput(absorption: 0.5, permeability: 0.5, roughness: 0.7, color: [247, 243, 234], heightAt: { x, y in 0.5 + 0.3 * sin(x * 0.7) * cos(y * 0.9) })

    /// Two tiles (a seam) and an edge tile with paint, light, flow, tilt, granulation and blooms, stepped `steps` times.
    private func scene(scalar: Bool, threads: Int, steps: Int) throws -> WetWorld {
        let w = try WetWorld(width: 520, height: 300, paper: paper)
        w.scalarKernel = scalar
        w.threads = threads
        try w.ensureLane("a", params: ["granulation": .number(0.8), "bloom": .number(0.8), "edgeDarkening": .number(0.9), "viscosity": .number(0.3)])
        try w.setFlow("a", { x, y in (sin(y * 0.05) * 0.4, cos(x * 0.04) * 0.3) }, strength: 0.6)
        _ = w.setTilt(WetTilt(angle: 25, direction: 40))
        func disc(_ cx: Int, _ cy: Int, _ r: Int) -> (RasterRect, [Float]) {
            let side = 2 * r + 1
            var cov = [Float](repeating: 0, count: side * side)
            for y in 0..<side { for x in 0..<side { cov[y * side + x] = Float(Swift.max(0, Swift.min(1, Double(r) - hypot(Double(x - r), Double(y - r)) + 0.5))) } }
            return (RasterRect(x: cx - r, y: cy - r, width: side, height: side), cov)
        }
        let a = disc(256, 140, 40)
        try w.paint("a", a.0, a.1, water: 0.6, pigment: pigmentOf([0.15, 0.3, 0.75], 0.1).map { $0 * 0.06 }, light: 0.4)
        let b = disc(500, 280, 18)
        try w.paint("a", b.0, b.1, water: 0.5, pigment: pigmentOf([0.8, 0.2, 0.15], 0.3).map { $0 * 0.05 })
        try w.wetPaper("a", RasterRect(x: 200, y: 60, width: 120, height: 40), nil, amount: 0.5)
        w.step(steps)
        return w
    }

    private func assertSameBits(_ a: WetWorld, _ b: WetWorld, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(a.clock, b.clock, file: file, line: line)
        let sa = a.snapshot(), sb = b.snapshot()
        XCTAssertEqual(sa.slots.map(\.key), sb.slots.map(\.key), file: file, line: line)
        XCTAssertGreaterThan(sa.slots.count, 1, file: file, line: line)
        for (x, y) in zip(sa.slots, sb.slots) {
            XCTAssertEqual(x.last, y.last, "flags of slot \(x.key)", file: file, line: line)
            let different = zip(x.planes, y.planes).filter { $0.bitPattern != $1.bitPattern }.count
            XCTAssertEqual(different, 0, "floats that differ in slot \(x.key)", file: file, line: line)
        }
        let ba = try a.bakedSurface("a"), bb = try b.bakedSurface("a")
        XCTAssertEqual(Set(ba.tiles.keys), Set(bb.tiles.keys), file: file, line: line)
        for k in ba.tiles.keys { XCTAssertEqual(ba.tiles.get(k)?.data, bb.tiles.get(k)?.data, file: file, line: line) }
    }

    func testTheSimdKernelGivesTheScalarKernelsBits() throws {
        try assertSameBits(scene(scalar: true, threads: 1, steps: 6), scene(scalar: false, threads: 1, steps: 6))
    }

    func testSteppingOnSeveralThreadsGivesTheSameBits() throws {
        try assertSameBits(scene(scalar: false, threads: 1, steps: 6), scene(scalar: false, threads: 8, steps: 6))
    }
}
