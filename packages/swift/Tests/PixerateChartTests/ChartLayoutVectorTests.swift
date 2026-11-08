import Foundation
@testable import PixerateChart
import PixerateCore
import XCTest

final class ChartLayoutVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "chart-layout-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    override class func setUp() {
        super.setUp()
        registerChartMap(EUROPE_CHART_MAP)
    }

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

    private func point(_ v: JSONValue) -> (x: Double, y: Double) {
        (x: v["x"]!.doubleValue!, y: v["y"]!.doubleValue!)
    }

    private func run(_ e: JSONValue) throws -> JSONValue {
        switch e["fn"]!.stringValue! {
        case "layoutChart":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let options = ChartLayoutOptions(json: e["options"] ?? .object(JSONObject()))
            return layoutChart(spec, options).toJSON()

        case "layoutSparkline":
            let values: [ChartValue] = e["values"]!.arrayValue!.map { $0.doubleValue }
            let options = ChartSparklineOptions(json: e["options"]!)
            return layoutSparkline(values, options).toJSON()

        case "chartTooltipFor":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let index = e["index"]!.intValue!
            let seriesId = e["seriesId"]?.stringValue
            return chartTooltipFor(spec, index, seriesId)?.toJSON() ?? .null

        case "chartTooltipAt":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let options = ChartLayoutOptions(json: e["options"]!)
            let scene = layoutChart(spec, options)
            let pt = point(e["point"]!)
            let mode = e["mode"]?.stringValue.flatMap(ChartTooltipMode.init(rawValue:))
            return chartTooltipAt(spec, scene, pt, ChartTooltipOptions(mode: mode))?.toJSON() ?? .null

        case "sameChartTooltip":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let t1 = chartTooltipFor(spec, e["i1"]!.intValue!, e["s1"]?.stringValue)
            let t2 = chartTooltipFor(spec, e["i2"]!.intValue!, e["s2"]?.stringValue)
            return .bool(sameChartTooltip(t1, t2))

        case "chartHitTest":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let options = ChartLayoutOptions(json: e["options"]!)
            let scene = layoutChart(spec, options)
            let pt = point(e["point"]!)
            return chartHitTest(scene, pt)?.toJSON() ?? .null

        case "chartValueAtPoint":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let options = ChartLayoutOptions(json: e["options"]!)
            let scene = layoutChart(spec, options)
            let pt = point(e["point"]!)
            return chartValueAtPoint(scene, pt).map(JSONValue.number) ?? .null

        case "chartCategoryAtPoint":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let options = ChartLayoutOptions(json: e["options"]!)
            let scene = layoutChart(spec, options)
            let pt = point(e["point"]!)
            return chartCategoryAtPoint(scene, pt).map { .number(Double($0)) } ?? .null

        case "chartXAtPoint":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let options = ChartLayoutOptions(json: e["options"]!)
            let scene = layoutChart(spec, options)
            let pt = point(e["point"]!)
            return chartXAtPoint(scene, pt).map(JSONValue.number) ?? .null

        case "snapChartValue":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let options = ChartLayoutOptions(json: e["options"]!)
            let scene = layoutChart(spec, options)
            return .number(snapChartValue(scene, e["value"]!.doubleValue!))

        case "snapChartDragValue":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let options = ChartLayoutOptions(json: e["options"]!)
            let scene = layoutChart(spec, options)
            return .number(snapChartDragValue(scene, e["value"]!.doubleValue!))

        case "describeChartSelection":
            let spec = normalizeChartSpec(e["spec"]!).spec
            let selection = e["selection"].flatMap(ChartSelection.init(json:))
            return .string(describeChartSelection(spec, selection))

        case "parsePartialChartJson":
            return parsePartialChartJson(e["text"]!.stringValue!) ?? .null

        case "easeChartTween":
            return .number(easeChartTween(e["t"]!.doubleValue!))

        case "blendChartScenes":
            let fromSpec = normalizeChartSpec(e["fromSpec"]!).spec
            let toSpec = normalizeChartSpec(e["toSpec"]!).spec
            let options = ChartLayoutOptions(json: e["options"]!)
            let fromScene = layoutChart(fromSpec, options)
            let toScene = layoutChart(toSpec, options)
            let t = e["t"]!.doubleValue!
            return blendChartScenes(fromScene, toScene, t).toJSON()

        case "chartStream":
            let stream = ChartStream(format: .json)
            let chunks = e["chunks"]!.arrayValue!
            return .array(chunks.map { c in
                stream.update(c["source"]!.stringValue!, complete: c["complete"]!.boolValue!).toJSON()
            })

        default:
            XCTFail("Unknown vector fn: \(e["fn"]!)")
            return .null
        }
    }

    func testVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertFalse(entries.isEmpty)
        for (i, e) in entries.enumerated() {
            let fn = e["fn"]!.stringValue!
            let trig = e["trig"]!.boolValue!
            let got = try run(e)
            let want = e["out"]!
            if let diff = mismatch(got, want, trig, "\(fn)#\(i)") {
                XCTFail(diff)
            }
        }
    }
}
