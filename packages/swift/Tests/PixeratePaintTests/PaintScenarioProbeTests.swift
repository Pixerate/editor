import Foundation
import PixerateConformance
import PixerateContracts
import PixerateCore
import XCTest
@testable import PixeratePaint

/// Runs the scenarios named in `PIXERATE_PAINT_PROBE` (comma-separated ids, or `all`) whether or not
/// they are skipped, and prints every mismatch: for working on a scenario before its skip comes off.
final class PaintScenarioProbeTests: XCTestCase {
    func testProbe() async throws {
        guard let wanted = ProcessInfo.processInfo.environment["PIXERATE_PAINT_PROBE"] else { return }
        let ids = Set(wanted.split(separator: ",").map(String.init))
        for scenario in try ConformanceScenario.load(domain: "paint") where ids.contains("all") || ids.contains(scenario.id) {
            let host = try PaintConformanceHost(setup: scenario.setup)
            let outputs: [ConformanceStepOutput]
            do { outputs = try await runConformanceScenario(scenario, host: host) } catch {
                print("PROBE \(scenario.id): stopped: \(error)")
                continue
            }
            let mismatches = compareConformance(scenario, outputs) { try decodeConformancePNG(Data(contentsOf: $0)) }
            print("PROBE \(scenario.id): \(mismatches.isEmpty ? "pass" : "\(mismatches.count) mismatches")")
            for m in mismatches { print("  \(m.description.prefix(1500))") }
            for (k, step) in scenario.steps.enumerated() {
                guard let file = step.expect["pixels"]?.objectValue?["file"]?.stringValue, let got = outputs[k].pixels else { continue }
                let want = try decodeConformancePNG(Data(contentsOf: ConformanceContracts.url("domains/paint/fixtures/\(file)")))
                if let d = pixelDifference(got, want), d.maxDelta > 0 { print("  pixels step \(k + 1) (\(step.tool)): max \(d.maxDelta), mean \(d.meanDelta)") }
            }
        }
    }
}

/// With `PIXERATE_PAINT_PROBE` set, prints the contract tools this port does not implement yet.
final class PaintUnportedToolsProbeTests: XCTestCase {
    func testUnportedTools() throws {
        guard ProcessInfo.processInfo.environment["PIXERATE_PAINT_PROBE"] != nil else { return }
        let host = try PaintConformanceHost(setup: [:])
        let c = host.controller
        let have = Set(try (createPaintEditorToolProvider(c).tools + createPaintBrushLibraryToolProvider(c).tools + createPaintProposalToolProvider(PaintProposals(controller: c)).tools).map(\.name))
        for p in try PaintContracts.toolProviders() {
            let missing = p.tools.map(\.name).filter { !have.contains($0) }
            print("UNPORTED \(p.id): \(missing.joined(separator: ", "))")
        }
    }
}
