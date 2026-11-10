import Foundation
import PixerateChart
import PixerateCore
import XCTest

final class ChartModelVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "chart-model-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    func mismatch(_ got: JSONValue, _ want: JSONValue, _ trig: Bool, _ path: String = "") -> String? {
        switch (got, want) {
        case let (.number(g), .number(w)):
            if g == w || (trig && abs(g - w) <= 1e-9 * max(1, abs(g), abs(w))) { return nil }
            return "\(path): \(JSONValue.jsNumber(g)) != \(JSONValue.jsNumber(w))"
        case let (.array(g), .array(w)):
            if g.count != w.count { return "\(path): \(g.count) items != \(w.count)" }
            for i in 0 ..< g.count { if let d = mismatch(g[i], w[i], trig, "\(path)[\(i)]") { return d } }
            return nil
        case let (.object(g), .object(w)):
            if Set(g.keys) != Set(w.keys) { return "\(path): keys \(g.keys.sorted()) != \(w.keys.sorted())" }
            for k in w.keys { if let d = mismatch(g[k]!, w[k]!, trig, "\(path).\(k)") { return d } }
            return nil
        default:
            return got == want ? nil : "\(path): \(got.stringified().prefix(200)) != \(want.stringified().prefix(200))"
        }
    }

    private func run(_ e: JSONValue) throws -> JSONValue {
        func list(_ k: String) -> [JSONValue] { e[k]!.arrayValue! }
        switch e["fn"]!.stringValue! {
        case "parseAndSerializeCsv":
            let csvTexts = list("csvTexts").map { $0.stringValue! }
            return .object(JSONObject([
                ("parsedDefault", .array(csvTexts.map { t in
                    .array(parseCsv(t).map { .array($0.map(JSONValue.string)) })
                })),
                ("parsedSemi", .array(parseCsv("a;b;c\n1;2;3", options: CsvParseOptions(delimiter: ";")).map { .array($0.map(JSONValue.string)) })),
                ("escaped", .array(["plain", "with,comma", "with\"quote", "with\nnewline"].map {
                    .string(escapeCsvField($0))
                })),
                ("serializedCsv", .array(csvTexts.map { t in
                    .string(serializeCsv(parseCsv(t)))
                })),
                ("tsvRoundTrip", .string(serializeTsv(parseTsv("col1\tcol2\nval1\tval2\n")))),
            ]))

        case "parseChartValue":
            let inputs = list("inputs")
            return .array(inputs.map { v in
                guard let parsed = parseChartValue(v) else {
                    return .string("undefined")
                }
                return parsed.map(JSONValue.number) ?? .null
            })

        case "normalizeChartSpec":
            let inputs = list("inputs")
            return .array(inputs.map { inp in
                let r = normalizeChartSpec(inp)
                return .object(JSONObject([
                    ("spec", r.spec.toJSON()),
                    ("issues", .array(r.issues.map { $0.toJSON() })),
                ]))
            })

        case "specHelpers":
            let sampleSpec = ChartSpec(json: e["sampleSpec"]!)
            let likertSpec = ChartSpec(json: e["likertSpec"]!)
            let xySpec = createChartSpec(.object(JSONObject([
                ("type", .string("scatter")),
                ("series", .array([
                    .object(JSONObject([
                        ("id", .string("s1")),
                        ("name", .string("S1")),
                        ("values", .array([.number(1), .number(2)])),
                        ("x", .array([.number(10), .number(20)])),
                    ])),
                ])),
            ])))
            return .object(JSONObject([
                ("families", .array(CHART_TYPES.map { t in
                    let spec = createChartSpec(.object(JSONObject([("type", .string(t.rawValue))])))
                    return .object(JSONObject([
                        ("type", .string(t.rawValue)),
                        ("cartesian", .bool(isCartesianChart(t))),
                        ("byCategory", .bool(chartColorsByCategory(t))),
                        ("family", .string(chartFamily(spec).rawValue)),
                    ]))
                })),
                ("xyScatter", .bool(isXyChart(xySpec))),
                ("likertColors", .array((1 ... 7).map { count in
                    .array((0 ..< count).map { i in .string(chartLikertColor(count, i)) })
                })),
                ("pointColors", .array([0, 1, 2].map { .string(chartPointColor(sampleSpec, 0, $0)) })),
                ("seriesColors", .array([0, 1, 2, 3, 4].map { .string(chartSeriesColor(likertSpec, $0)) })),
                ("sliceColors", .array([0, 1, 2, 3].map { .string(chartSliceColor(sampleSpec, $0)) })),
                ("varies", .bool(chartVariesColors(sampleSpec))),
                ("specByCat", .bool(chartSpecColorsByCategory(sampleSpec))),
                ("seriesType", .array(CHART_TYPES.map { t in
                    .string(chartSeriesType(chartType: t, series: ChartSeries(id: "s1", name: "S1", values: [])).rawValue)
                })),
                ("uniqueId", .string(uniqueChartSeriesId(["series-1", "series-2", "series-4"].map { ChartSeries(id: $0, name: $0, values: []) }))),
                ("colorInput", .array(["#AbC", "#123456", "rgb(0,0,0)", "bad"].map {
                    .string(chartColorInputValue($0))
                })),
            ]))

        case "chartTableData":
            let tableRows: [[JSONValue]] = list("tableRows").map { $0.arrayValue! }
            let fromCols = chartDataFromTable(tableRows)
            let fromRows = chartDataFromTable(tableRows, ChartTableOptions(seriesIn: .rows, header: .auto))
            let withXRows: [[JSONValue]] = [
                [.string("X"), .string("Y")],
                [.string("10"), .string("20")],
                [.string("30"), .string("40")],
            ]
            let withX = chartDataFromTable(withXRows, ChartTableOptions(xFromFirstColumn: true))
            let specForToTable = createChartSpec(.object(JSONObject([
                ("categories", .array(fromCols.categories.map(JSONValue.string))),
                ("series", .array(fromCols.series.map { $0.toJSON() })),
            ])))
            let toTable = chartDataToTable(specForToTable, categoryHeader: "Quarter")
            return .object(JSONObject([
                ("fromCols", fromCols.toJSON()),
                ("fromRows", fromRows.toJSON()),
                ("withX", withX.toJSON()),
                ("toTable", .array(toTable.map { .array($0) })),
            ]))

        case "chartLinks":
            let rawLinkTable: [[JSONValue]] = list("rawLinkTable").map { $0.arrayValue! }
            var issues: [ChartIssue] = []
            let fromTable = chartLinksFromTable(rawLinkTable)
            let links = normalizeChartLinks(.array(fromTable), &issues)
            let nodes = chartSankeyNodes(links, ["Signup", "Ghost"], &issues)
            let values = chartSankeyNodeValues(links, nodes)
            let edited = setChartLinkField(links, 1, .target, "  Checkout ")
            let added = addChartLink(links)
            return .object(JSONObject([
                ("fromTable", .array(fromTable)),
                ("links", .array(links.map { $0.toJSON() })),
                ("nodes", .array(nodes.map(JSONValue.string))),
                ("values", .array(values.map(JSONValue.number))),
                ("edited", .array(edited)),
                ("added", .array(added.map { $0.toJSON() })),
                ("issues", .array(issues.map { $0.toJSON() })),
            ]))

        case "chartTree":
            let rawTreeTable: [[JSONValue]] = list("rawTreeTable").map { $0.arrayValue! }
            var issues: [ChartIssue] = []
            let tree = chartTreeFromTable(rawTreeTable, header: .auto, &issues)
            let rows = chartTreeToRows(tree)
            let depth = chartTreeDepth(tree)
            let totals = tree.map { chartTreeTotal($0) }
            let found = findChartTreeNode(tree, ["Europe", "Germany"])
            let missing = findChartTreeNode(tree, ["Europe", "Spain"])
            let flat = chartTreeFromSeries(["A", "B", "A"], [10, -5, 20])
            let cols = [1, 2, 3, 4].map { chartTreeColumnLabels($0) }
            let renamed = setChartTreeRowName(rows, 0, 1, "Italy")
            let revalued = setChartTreeRowValue(rows, 1, .number(99))
            let withAdded = addChartTreeRow(rows)
            let withRemoved = removeChartTreeRow(withAdded, 0)
            let rebuilt = chartTreeFromRows(
                renamed.map { (path: $0.path.map(JSONValue.string), value: $0.value) },
                &issues
            )
            func tupleRowsToJSON(_ r: [(path: [String], value: JSONValue)]) -> JSONValue {
                .array(r.map {
                    .object(JSONObject([
                        ("path", .array($0.path.map(JSONValue.string))),
                        ("value", $0.value),
                    ]))
                })
            }
            return .object(JSONObject([
                ("tree", .array(tree.map { $0.toJSON() })),
                ("rows", .array(rows.map { $0.toJSON() })),
                ("depth", .number(Double(depth))),
                ("totals", .array(totals.map(JSONValue.number))),
                ("found", found?.toJSON() ?? .null),
                ("missing", missing?.toJSON() ?? .null),
                ("flat", .array(flat.map { $0.toJSON() })),
                ("cols", .array(cols.map { .array($0.map(JSONValue.string)) })),
                ("renamed", tupleRowsToJSON(renamed)),
                ("revalued", tupleRowsToJSON(revalued)),
                ("withAdded", .array(withAdded.map { $0.toJSON() })),
                ("withRemoved", .array(withRemoved.map { $0.toJSON() })),
                ("rebuilt", .array(rebuilt.map { $0.toJSON() })),
                ("issues", .array(issues.map { $0.toJSON() })),
            ]))

        case "chartMaps":
            registerChartMap(EUROPE_CHART_MAP)
            let mapCategories = list("mapCategories").map { $0.stringValue! }
            let map = getChartMap("europe")!
            let matched = matchChartMapRegions(map, mapCategories).map { $0?.id }
            let breaksAuto = chartMapBreaks([10, 25, 40, 80, 95], 4, [])
            let breaksFixed = chartMapBreaks([10, 25, 40, 80, 95], 4, [20, 50, 80])
            let classes = [10.0, 20.0, 35.0, 50.0, 90.0].map { chartMapClass($0, breaksFixed) }
            let ramp = chartMapRamp("#4269d0", 5)
            return .object(JSONObject([
                ("mapId", .string(map.id)),
                ("regionCount", .number(Double(map.regions.count))),
                ("matched", .array(matched.map { $0.map(JSONValue.string) ?? .null })),
                ("breaksAuto", .array(breaksAuto.map(JSONValue.number))),
                ("breaksFixed", .array(breaksFixed.map(JSONValue.number))),
                ("classes", .array(classes.map { .number(Double($0)) })),
                ("ramp", .array(ramp.map(JSONValue.string))),
            ]))

        case "chartPresets":
            return .object(JSONObject([
                ("layouts", .array(CHART_LAYOUT_PRESETS.map { $0.toJSON() })),
                ("schemes", .array(CHART_COLOR_SCHEMES.map { $0.toJSON() })),
                ("mono", .array(monochromeChartPalette("#4269d0", 5).map(JSONValue.string))),
                ("patches", .array([
                    chartPresetPatch(layout: "minimal").toJSON(),
                    chartPresetPatch(colors: "okabe-ito").toJSON(),
                    chartPresetPatch(layout: "presentation", colors: "warm").toJSON(),
                    chartPresetPatch(layout: "unknown").toJSON(),
                    chartPresetPatch(colors: "unknown").toJSON(),
                    chartPresetPatch().toJSON(),
                ])),
            ]))

        case "recommendAndFromTable":
            let tables: [[[JSONValue]]] = list("tables").map { $0.arrayValue!.map { $0.arrayValue! } }
            return .array(tables.map { t in
                .object(JSONObject([
                    ("shape", analyzeChartTable(t).toJSON()),
                    ("recommendations", .array(recommendChartTypes(t).map { $0.toJSON() })),
                    ("fromAuto", chartFromTable(t).toJSON()),
                    ("fromLine", chartFromTable(t, type: .line).toJSON()),
                ]))
            })

        case "raceAndSummary":
            registerChartMap(EUROPE_CHART_MAP)
            let raceSpec = ChartSpec(json: e["raceSpec"]!)
            let summarySpecs = list("summarySpecs").map { ChartSpec(json: $0) }
            let scene = ChartScene(
                width: 640,
                height: 400,
                plot: ChartRect(x: 48, y: 32, width: 560, height: 320),
                percent: false,
                theme: ChartTheme(
                    background: "#ffffff",
                    surface: "#ffffff",
                    text: "#0f172a",
                    mutedText: "#64748b",
                    grid: "#e2e8f0",
                    axis: "#94a3b8",
                    selection: "#2563eb",
                    positive: "#3ca951",
                    negative: "#e5484d",
                    fontFamily: "sans-serif",
                    fontSize: 11,
                    titleSize: 15
                ),
                warnings: []
            )
            let frames: [Double?] = [nil, 0, 0.5, 1.25, 5]
            return .object(JSONObject([
                ("raceValue", .array([0, 1, 2].map { .number(chartRaceValueAt(raceSpec.series[0], $0)) })),
                ("raceMoments", .array(frames.map { chartRaceMoment(3, $0).toJSON() })),
                ("raceRankings", .array([0.0, 0.5, 1.0, 2.0].map { f in
                    .array(chartRaceRanking(raceSpec, f).map { $0.toJSON() })
                })),
                ("descriptions", .array(summarySpecs.map { .string(describeChart($0)) })),
                ("summaries", .array(summarySpecs.map { summarizeChart($0, scene: scene).toJSON() })),
            ]))

        case let fn:
            throw NSError(domain: "ChartModelVectorTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown fn \(fn)"])
        }
    }

    func testModelVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThanOrEqual(entries.count, 11)
        for (i, e) in entries.enumerated() {
            let fn = e["fn"]!.stringValue!
            do {
                let got = try run(e)
                if let d = mismatch(got, e["out"]!, e["trig"]!.boolValue!) {
                    XCTFail("entry \(i) \(fn): \(d)")
                }
            } catch {
                XCTFail("entry \(i) \(fn) threw: \(error)")
            }
        }
    }
}
