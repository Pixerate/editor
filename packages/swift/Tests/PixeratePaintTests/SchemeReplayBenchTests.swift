import Foundation
import XCTest
@testable import PixeratePaint

/**
 * A full colour-scheme replay of wet paint (#720), the measurement of PR #843 in the TS core:
 * `SCHEME_REPLAY_BENCH=1 swift test -c release --filter SchemeReplayBenchTests`. A 1024² canvas,
 * 50 watercolour strokes of 40 points (2/3 dual-colour, 1/3 plain), 6 wet steps between strokes;
 * the wet engine on the CPU (the GPU off, as in the conformance host).
 */
final class SchemeReplayBenchTests: XCTestCase {
    func testFullReplay() async throws {
        guard ProcessInfo.processInfo.environment["SCHEME_REPLAY_BENCH"] != nil else { throw XCTSkip("Set SCHEME_REPLAY_BENCH=1 (and -c release) to run the benchmark.") }
        let c = try PaintEditorController(width: 1024, height: 1024, paperPreset: "cold-pressed", wet: PaintWetOptions(gpu: "off"))
        let blue = PaintDualColor(light: "#1d4ed8", dark: "#93c5fd")
        func ms(_ since: Date) -> Double { Date().timeIntervalSince(since) * 1000 }
        func strokePoints(_ k: Int) -> [PenPoint] {
            (0..<40).map { (i: Int) -> PenPoint in
                let t = Double(i)
                let y: Double = 40 + Double(k) * 18 + sin(t / 4) * 20
                return PenPoint(x: 40 + t * 23, y: y, pressure: 0.7)
            }
        }
        func paintOne(_ k: Int) throws {
            var i = PaintStrokeInit(color: k % 3 == 2 ? "#a16207" : nil, seed: k + 1)
            if k % 3 != 2 { i.dualColor = blue }
            i.brushId = "watercolor-round"
            _ = try c.paintStroke(i, points: strokePoints(k))
            _ = try c.advanceWet(steps: 6, seconds: nil)
        }
        var t = Date()
        for k in 0..<50 { try paintOne(k) }
        let painting = ms(t)
        t = Date()
        c.setColorScheme("dark")
        let switchMs = ms(t)
        var last = Date()
        var longest = 0.0
        c.schemeReplayYieldObserver = {
            longest = Swift.max(longest, ms(last))
            last = Date()
        }
        t = Date()
        last = t
        let view = await c.colorSchemeViewReady()
        let replay = ms(t)
        XCTAssertEqual(view.replayState, "ready")
        t = Date()
        try paintOne(50)
        let more = ms(t)
        t = Date()
        _ = await c.colorSchemeViewReady()
        let catchUp = ms(t)
        print("SCHEME REPLAY BENCH painting \(Int(painting)) ms; setColorScheme \(String(format: "%.1f", switchMs)) ms; full replay \(Int(replay)) ms; longest host wait \(Int(longest)) ms; one more stroke \(Int(more)) ms / replay catching up \(Int(catchUp)) ms")
    }
}
