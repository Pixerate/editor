import Foundation
import PixerateConformance
import PixerateContracts
import PixerateCore
import XCTest
@testable import PixerateVector

/// Replays the vector scenarios of `@pixerate/conformance` against the Swift vector editor. A
/// scenario the Swift port can't pass yet is marked `"skip": { "swift": "… (#issue)" }` in its file
/// and reported here, so the remaining work is a count that goes down.
final class VectorConformanceTests: XCTestCase {
    func testVectorScenarios() async throws {
        let scenarios = try ConformanceScenario.load(domain: "vector")
        XCTAssertEqual(scenarios.count, 15)
        var passed: [String] = []
        var skipped: [(String, String)] = []
        var failures: [ConformanceMismatch] = []
        for scenario in scenarios {
            if let reason = scenario.skip["swift"] {
                skipped.append((scenario.id, reason))
                continue
            }
            let host = try VectorConformanceHost(setup: scenario.setup)
            let outputs = try await runConformanceScenario(scenario, host: host)
            let mismatches = compareConformance(scenario, outputs) { _ in throw ContractError("The vector scenarios record no pixels.") }
            if mismatches.isEmpty {
                passed.append(scenario.id)
            } else {
                failures += mismatches
                // The first difference of each mismatching step, so a failure points at its cause.
                for m in mismatches {
                    let i = m.step - 1
                    let step = scenario.steps[i]
                    if let path = firstDifference(outputs[i].result, step.expect["result"] ?? .null) { print("\(scenario.id) step \(m.step) result: \(path)") }
                    if step.document, let path = firstDifference(outputs[i].document ?? .null, step.expect["document"] ?? .null) { print("\(scenario.id) step \(m.step) document: \(path)") }
                    if step.render, let path = firstDifference(outputs[i].render ?? .null, step.expect["render"] ?? .null) { print("\(scenario.id) step \(m.step) render: \(path)") }
                }
            }
        }
        for failure in failures { XCTFail(failure.description) }
        VectorConformanceReport.write(passed: passed, skipped: skipped, failed: Set(failures.map(\.scenario)).count)
    }

    /// The scenarios this port covers stay unskipped.
    func testPortedScenariosAreNotSkipped() throws {
        let scenarios = try ConformanceScenario.load(domain: "vector")
        for id in ["shapes-and-paths", "arrange-and-transform", "booleans-and-pathfinder", "path-editing", "svg-round-trip", "paint-and-appearance", "strokes-and-corners", "gradients-and-shading", "blends-and-envelopes", "symbols", "constraints"] {
            let scenario = try XCTUnwrap(scenarios.first { $0.id == id })
            XCTAssertNil(scenario.skip["swift"], id)
        }
    }

    /// The render steps of the ported scenarios are compared (the render data is not left out).
    func testPortedScenariosCompareRenderData() throws {
        let scenarios = try ConformanceScenario.load(domain: "vector")
        for id in ["shapes-and-paths", "arrange-and-transform", "booleans-and-pathfinder", "path-editing", "svg-round-trip"] {
            let scenario = try XCTUnwrap(scenarios.first { $0.id == id })
            let steps = scenario.steps.filter(\.render)
            XCTAssertFalse(steps.isEmpty, id)
            for step in steps { XCTAssertNotNil(step.expect["render"], id) }
        }
    }

    /// `import-export` is skipped for PDF, Lottie and tracing; its SVG steps (import, export and a
    /// failed import) replay on their own.
    func testImportExportSvgSteps() async throws {
        var scenario = try XCTUnwrap(ConformanceScenario.load(domain: "vector").first { $0.id == "import-export" })
        XCTAssertNotNil(scenario.skip["swift"])
        scenario.steps = [scenario.steps[0], scenario.steps[1], scenario.steps[10]]
        XCTAssertEqual(scenario.steps.map { $0.arguments["id"]?.stringValue }, ["vector.importSvg", "vector.exportSvg", "vector.importSvg"])
        let outputs = try await runConformanceScenario(scenario, host: VectorConformanceHost(setup: scenario.setup))
        for m in compareConformance(scenario, outputs, decodePNG: { _ in throw ContractError("no pixels") }) { XCTFail(m.description) }
    }

    /// A render step fails on a host without render data.
    func testRenderStepNeedsRenderData() async throws {
        struct NoRender: ConformanceHost {
            let inner: VectorConformanceHost
            func callTool(_ name: String, _ args: JSONObject) async -> McpToolResult { await inner.callTool(name, args) }
            func document() throws -> JSONValue { try inner.document() }
            func pixels(paper: Bool?) throws -> ConformanceImage { try inner.pixels(paper: paper) }
            func isGeneratedId(_ value: String) -> Bool { false }
        }
        var scenario = try XCTUnwrap(ConformanceScenario.load(domain: "vector").first { $0.id == "shapes-and-paths" })
        scenario.steps = Array(scenario.steps.prefix(7))
        do {
            _ = try await runConformanceScenario(scenario, host: NoRender(inner: VectorConformanceHost(setup: scenario.setup)))
            XCTFail("ran without render data")
        } catch {
            XCTAssertEqual("\(error)".contains("asks for render data, which this host does not have"), true, "\(error)")
        }
    }

    /// Every command of the contract is registered, with the TS metadata, and a command that is
    /// not ported yet fails with a message rather than crashing.
    func testEveryContractCommandIsRegistered() throws {
        let host = try VectorConformanceHost(setup: [:])
        let contract = try VectorContracts.commands()
        XCTAssertEqual(host.commands.ids, contract.map(\.id))
        let listed = host.commands.list()
        XCTAssertEqual(listed.count, contract.count)
        for (entry, c) in zip(listed, contract) {
            XCTAssertEqual(entry.label, c.label)
            XCTAssertEqual(entry.readOnly, c.readOnly)
        }
        // As the TS host lists them: 36 commands need a selection (or ids), and no symbol is in isolation.
        let disabled = listed.filter { !$0.enabled }
        XCTAssertEqual(disabled.count, 37)
        XCTAssertEqual(disabled.filter { $0.disabledReason == "Nothing is selected." }.count, 36)
        XCTAssertEqual(host.commands.isEnabled("vector.exitSymbolEdit").reason, "No symbol is being edited.")
        XCTAssertEqual(host.commands.isEnabled("vector.group").reason, "Nothing is selected.")
        XCTAssertTrue(host.commands.isEnabled("vector.group", params: ["ids": ["n1"]]).enabled)
        XCTAssertNil(listed.first { $0.id == "vector.list" }?.params)
        _ = host.commands.execute("vector.addShape", ["kind": "rect", "x": 0, "y": 0, "width": 10, "height": 10])
        XCTAssertEqual(host.commands.list().filter { !$0.enabled }.map(\.id), ["vector.exitSymbolEdit"])
        let result = host.commands.execute("vector.listFonts")
        guard case .failure(let f) = result else { return XCTFail("listFonts ran") }
        XCTAssertEqual(f.code, .failed)
        XCTAssertTrue(f.message.contains("not ported to Swift yet (#624)"), f.message)
    }
}

/// The path to the first place two values differ (numbers within the conformance tolerance), or nil.
func firstDifference(_ a: JSONValue, _ b: JSONValue, _ path: String = "") -> String? {
    switch (a, b) {
    case (.array(let x), .array(let y)):
        if x.count != y.count { return "\(path): \(x.count) items ≠ \(y.count)" }
        for (i, (p, q)) in zip(x, y).enumerated() { if let d = firstDifference(p, q, "\(path)/\(i)") { return d } }
        return nil
    case (.object(let x), .object(let y)):
        if Set(x.keys) != Set(y.keys) { return "\(path): keys \(x.keys.sorted()) ≠ \(y.keys.sorted())" }
        for k in x.keys.sorted() { if let d = firstDifference(x[k]!, y[k]!, "\(path)/\(k)") { return d } }
        return nil
    default:
        return conformanceValuesMatch(a, b) ? nil : "\(path): \(a.stringified()) ≠ \(b.stringified())"
    }
}

/// Prints the summary and adds it to the GitHub job summary when there is one.
enum VectorConformanceReport {
    static func write(passed: [String], skipped: [(String, String)], failed: Int) {
        var text = "vector scenarios: \(passed.count) passed, \(failed) failed, \(skipped.count) skipped\n"
        for (id, reason) in skipped { text += "- skipped \(id): \(reason)\n" }
        print(text)
        if let path = ProcessInfo.processInfo.environment["GITHUB_STEP_SUMMARY"], let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(Data("### Swift conformance\n\n\(text)\n".utf8))
            try? handle.close()
        }
    }
}
