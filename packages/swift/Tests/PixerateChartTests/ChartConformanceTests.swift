import Foundation
import PixerateConformance
import PixerateContracts
import PixerateCore
import XCTest
@testable import PixerateChart

final class ChartConformanceTests: XCTestCase {
    func testChartScenarios() async throws {
        let scenarios = try ConformanceScenario.load(domain: "chart")
        XCTAssertEqual(scenarios.count, 16)
        var passed: [String] = []
        var skipped: [(String, String)] = []
        var failures: [ConformanceMismatch] = []
        for scenario in scenarios {
            if let reason = scenario.skip["swift"] {
                skipped.append((scenario.id, reason))
                continue
            }
            let host = try ChartConformanceHost(setup: scenario.setup)
            let outputs = try await runConformanceScenario(scenario, host: host)
            let mismatches = compareConformance(scenario, outputs) { _ in
                throw ContractError("Chart scenarios without PNG snapshots do not decode PNG.")
            }
            if mismatches.isEmpty {
                passed.append(scenario.id)
            } else {
                failures += mismatches
                for m in mismatches {
                    let i = m.step - 1
                    let step = scenario.steps[i]
                    if let path = firstChartDifference(outputs[i].result, step.expect["result"] ?? .null) {
                        print("\(scenario.id) step \(m.step) result: \(path)")
                    }
                    if step.document, let path = firstChartDifference(outputs[i].document ?? .null, step.expect["document"] ?? .null) {
                        print("\(scenario.id) step \(m.step) document: \(path)")
                    }
                    if step.render, let path = firstChartDifference(outputs[i].render ?? .null, step.expect["render"] ?? .null) {
                        print("\(scenario.id) step \(m.step) render: \(path)")
                    }
                }
            }
        }
        for failure in failures { XCTFail(failure.description) }
        XCTAssertEqual(passed.count, 15)
        XCTAssertEqual(skipped.count, 1)
        ChartConformanceReport.write(passed: passed, skipped: skipped, failed: Set(failures.map(\.scenario)).count)
    }

    func testEveryContractCommandIsRegistered() throws {
        let host = try ChartConformanceHost(setup: [:])
        let contract = try ChartContracts.commands()
        XCTAssertEqual(host.commands.ids, contract.map(\.id))
        let listed = host.commands.list()
        XCTAssertEqual(listed.count, contract.count)
        for (entry, c) in zip(listed, contract) {
            XCTAssertEqual(entry.label, c.label)
            XCTAssertEqual(entry.readOnly, c.readOnly)
        }
    }

    func testRacePlaybackAndPresenceAndInteraction() throws {
        let host = try ChartConformanceHost(setup: [:])
        _ = host.controller.setData(["categories": ["2020", "2021", "2022"], "series": [["id": "s1", "name": "Alpha", "values": [10, 20, 30]]]])
        XCTAssertTrue(host.controller.playRace(msPerStep: 100).ok)
        XCTAssertEqual(host.controller.getState().racePlaying, true)
        XCTAssertEqual(host.controller.getState().raceFrame, 0)
        host.advanceRace(50)
        XCTAssertEqual(host.controller.getState().raceFrame, 0.5)
        host.advanceRace(200)
        XCTAssertEqual(host.controller.getState().racePlaying, false)
        XCTAssertNil(host.controller.getState().raceFrame)

        let scene = layoutChart(host.controller.getSpec(), ChartLayoutOptions(width: 640, height: 400))
        let steps = planChartCommand(host.controller.getSpec(), scene, .setValue(seriesId: "s1", index: 0, value: 25, note: "Boost"))
        XCTAssertFalse(steps.isEmpty)

        host.controller.select(.series(seriesId: "s1"))
        XCTAssertTrue(handleChartKey(host.controller, scene, ChartKeyInput(key: "Escape")))
        XCTAssertNil(host.controller.getState().selection)
    }

    func testUnportedToolsAndCommandsReportClearError() async throws {
        let host = try ChartConformanceHost(setup: [:])
        let cases702: [(String, JSONObject)] = [
            ("import_chart_ooxml", JSONObject([("xml", .string("<c:chartSpace/>"))])),
            ("export_chart_ooxml", JSONObject())
        ]
        for (tool, args) in cases702 {
            let res = await host.callTool(tool, args)
            XCTAssertTrue(res.isError)
            XCTAssertTrue(res.structuredContent?["error"]?["message"]?.stringValue?.contains("#702") == true)
        }
    }
}

func firstChartDifference(_ a: JSONValue, _ b: JSONValue, _ path: String = "") -> String? {
    switch (a, b) {
    case (.array(let x), .array(let y)):
        if x.count != y.count { return "\(path): \(x.count) items ≠ \(y.count)" }
        for (i, (p, q)) in zip(x, y).enumerated() {
            if let d = firstChartDifference(p, q, "\(path)/\(i)") { return d }
        }
        return nil
    case (.object(let x), .object(let y)):
        if Set(x.keys) != Set(y.keys) { return "\(path): keys \(x.keys.sorted()) ≠ \(y.keys.sorted())" }
        for k in x.keys.sorted() {
            if let d = firstChartDifference(x[k]!, y[k]!, "\(path)/\(k)") { return d }
        }
        return nil
    default:
        return conformanceValuesMatch(a, b) ? nil : "\(path): \(a.stringified()) ≠ \(b.stringified())"
    }
}

enum ChartConformanceReport {
    static func write(passed: [String], skipped: [(String, String)], failed: Int) {
        var text = "chart scenarios: \(passed.count) passed, \(failed) failed, \(skipped.count) skipped\n"
        for (id, reason) in skipped { text += "- skipped \(id): \(reason)\n" }
        print(text)
        if let path = ProcessInfo.processInfo.environment["GITHUB_STEP_SUMMARY"],
           let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(Data("### Swift conformance\n\n\(text)\n".utf8))
            try? handle.close()
        }
    }
}
