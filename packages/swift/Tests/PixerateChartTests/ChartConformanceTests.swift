import Foundation
import PixerateConformance
import PixerateContracts
import PixerateCore
import XCTest
@testable import PixerateChart

final class ChartConformanceTests: XCTestCase {
    func testChartScenarios() async throws {
        let scenarios = try ConformanceScenario.load(domain: "chart")
        XCTAssertEqual(scenarios.count, 24)
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
        for (id, reason) in skipped { XCTFail("The chart domain is fully ported, but \(id) is skipped for Swift: \(reason)") }
        XCTAssertEqual(passed.count, 24)
        XCTAssertEqual(skipped.count, 0)
        ChartConformanceReport.write(passed: passed, skipped: skipped, failed: Set(failures.map(\.scenario)).count)
    }

    /// Every chart scenario runs on Swift: none carries a skip, and the 18 known ones are there.
    func testNoChartScenarioIsSkipped() throws {
        let scenarios = try ConformanceScenario.load(domain: "chart")
        for scenario in scenarios { XCTAssertNil(scenario.skip["swift"], "\(scenario.id) is skipped for Swift; the chart domain is fully ported (#694).") }
        for id in [
            "bar-basics", "bar-race", "errors", "interaction", "line-dates", "map-choropleth",
            "mermaid-round-trip", "number-formats", "office", "pie-donut", "presets-style", "read-only",
            "render-svg", "sankey-links", "scatter-trend", "stacked-area-streamgraph", "style-skips", "tree-treemap"
        ] {
            XCTAssertNotNil(scenarios.first { $0.id == id }, id)
        }
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

    func testOoxmlAndZipHelpers() throws {
        XCTAssertEqual(zipCrc32(Array("123456789".utf8)), 0xCBF4_3926)
        XCTAssertTrue(isUnsafeZipPath("../secret.xml"))
        XCTAssertTrue(isUnsafeZipPath("/etc/passwd"))
        XCTAssertTrue(isUnsafeZipPath("C:\\Windows\\win.ini"))
        XCTAssertFalse(isUnsafeZipPath("xl/charts/chart1.xml"))

        let spec = createChartSpec([
            "type": "bar",
            "title": "Quarterly Revenue",
            "categories": ["Q1", "Q2"],
            "series": [
                [
                    "id": "s1",
                    "name": "North",
                    "values": [120, 150],
                    "color": "#4269d0",
                    "errorBars": ["type": "percent", "value": 5],
                    "trendlines": [["type": "linear", "showR2": true]]
                ]
            ],
            "yAxis": ["format": ["style": "currency", "currency": "$", "decimals": 0]]
        ])
        let written = chartToOoxml(spec)
        XCTAssertTrue(written.issues.isEmpty)
        let roundTrip = chartFromOoxml(written.xml)
        XCTAssertTrue(roundTrip.lossless)
        XCTAssertEqual(roundTrip.spec.title, "Quarterly Revenue")
        XCTAssertEqual(roundTrip.spec.categories, ["Q1", "Q2"])
        XCTAssertEqual(roundTrip.spec.series.first?.values, [120, 150])
        XCTAssertEqual(roundTrip.spec.series.first?.errorBars?.type, .percent)
        XCTAssertEqual(roundTrip.spec.series.first?.trendlines?.first?.type, .linear)

        let chartexXml = """
        <cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <cx:chartData>
            <cx:data id="0">
              <cx:strDim type="cat">
                <cx:lvl ptCount="2"><cx:pt idx="0">France</cx:pt><cx:pt idx="1">Japan</cx:pt></cx:lvl>
                <cx:lvl ptCount="2"><cx:pt idx="0">Europe</cx:pt><cx:pt idx="1">Asia</cx:pt></cx:lvl>
              </cx:strDim>
              <cx:numDim type="val"><cx:lvl ptCount="2"><cx:pt idx="0">40</cx:pt><cx:pt idx="1">60</cx:pt></cx:lvl></cx:numDim>
            </cx:data>
          </cx:chartData>
          <cx:chart>
            <cx:title><cx:tx><cx:rich><a:p><a:r><a:t>Regions</a:t></a:r></a:p></cx:rich></cx:tx></cx:title>
            <cx:plotArea><cx:plotAreaRegion><cx:series layoutId="treemap"><cx:dataId val="0"/><cx:dataLabels pos="inEnd"/></cx:series></cx:plotAreaRegion></cx:plotArea>
          </cx:chart>
        </cx:chartSpace>
        """
        let cxRead = chartFromOoxml(chartexXml)
        XCTAssertTrue(cxRead.lossless)
        XCTAssertEqual(cxRead.spec.type, .treemap)
        XCTAssertEqual(cxRead.spec.title, "Regions")
        XCTAssertEqual(cxRead.spec.tree.count, 2)
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
