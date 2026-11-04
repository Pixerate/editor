import Foundation
import PixerateConformance
import PixerateContracts
import PixerateCore
import XCTest
@testable import PixeratePaint

/// Records what each call returned before normalization (for `PIXERATE_PAINT_DUMP`).
private final class RecordingHost: ConformanceHost {
    let inner: PaintConformanceHost
    var raw: [JSONValue] = []
    init(_ inner: PaintConformanceHost) { self.inner = inner }
    func callTool(_ name: String, _ args: JSONObject) async -> McpToolResult {
        let r = await inner.callTool(name, args)
        raw.append(["tool": .string(name), "args": .object(args), "result": r.structuredContent.map { .object($0) } ?? .string("\(r.content)")])
        return r
    }
    func document() throws -> JSONValue { try inner.document() }
    func pixels(paper: Bool?) throws -> ConformanceImage { try inner.pixels(paper: paper) }
    func isGeneratedId(_ value: String) -> Bool { inner.isGeneratedId(value) }
}

/// Runs the scenarios named in `PIXERATE_PAINT_PROBE` (comma-separated ids, or `all`) whether or not
/// they are skipped, and prints every mismatch: for working on a scenario before its skip comes off.
/// With `PIXERATE_PAINT_DUMP=<dir>`, also writes each call's raw (unnormalized) result to
/// `<dir>/<id>.swift.json`, to compare with the TS core's output in detail.
final class PaintScenarioProbeTests: XCTestCase {
    func testProbe() async throws {
        guard let wanted = ProcessInfo.processInfo.environment["PIXERATE_PAINT_PROBE"] else { return }
        let ids = Set(wanted.split(separator: ",").map(String.init))
        var scenarios = try ConformanceScenario.load(domain: "paint")
        // `PIXERATE_PAINT_PROBE_FILES`: more scenario files (paths, comma-separated), unrecorded ones too.
        for path in (ProcessInfo.processInfo.environment["PIXERATE_PAINT_PROBE_FILES"] ?? "").split(separator: ",") {
            scenarios.append(try ConformanceScenario(json: try JSONValue.parse(Data(contentsOf: URL(fileURLWithPath: String(path)))), domain: "paint"))
        }
        for scenario in scenarios where ids.contains("all") || ids.contains(scenario.id) {
            let host = RecordingHost(try PaintConformanceHost(setup: scenario.setup))
            let outputs: [ConformanceStepOutput]
            do { outputs = try await runConformanceScenario(scenario, host: host) } catch {
                print("PROBE \(scenario.id): stopped: \(error)")
                continue
            }
            if let dir = ProcessInfo.processInfo.environment["PIXERATE_PAINT_DUMP"] {
                try JSONValue.array(host.raw).stringified().write(toFile: "\(dir)/\(scenario.id).swift.json", atomically: true, encoding: .utf8)
                try JSONValue.array(outputs.map { $0.document ?? .null }).stringified().write(toFile: "\(dir)/\(scenario.id).swift.doc", atomically: true, encoding: .utf8)
                try outputs.map { $0.pixels.map { Data($0.data).base64EncodedString() } ?? "" }.joined(separator: "\n").write(toFile: "\(dir)/\(scenario.id).swift.px", atomically: true, encoding: .utf8)
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
        let have = Set(try (createPaintEditorToolProvider(c).tools + createPaintEffectsToolProvider(c).tools + createPaintBrushLibraryToolProvider(c).tools + createPaintProposalToolProvider(PaintProposals(controller: c)).tools).map(\.name))
        for p in try PaintContracts.toolProviders() {
            let missing = p.tools.map(\.name).filter { !have.contains($0) }
            print("UNPORTED \(p.id): \(missing.joined(separator: ", "))")
        }
    }
}
