import Foundation
import PixerateChart
import PixerateCore
import XCTest

/// `readZip`, `extractOfficeCharts`, `chartFromOoxml` and `chartToOoxml` against the TS core
/// (`packages/core/tests/swift-chart-office-vectors.test.ts`), including malformed archives.
final class ChartOfficeVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "chart-office-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    func mismatch(_ got: JSONValue, _ want: JSONValue, _ path: String = "") -> String? {
        switch (got, want) {
        case let (.array(g), .array(w)):
            if g.count != w.count { return "\(path): \(g.count) items != \(w.count)" }
            for i in 0 ..< g.count { if let d = mismatch(g[i], w[i], "\(path)[\(i)]") { return d } }
            return nil
        case let (.object(g), .object(w)):
            if Set(g.keys) != Set(w.keys) { return "\(path): keys \(g.keys.sorted()) != \(w.keys.sorted())" }
            for k in w.keys { if let d = mismatch(g[k]!, w[k]!, "\(path).\(k)") { return d } }
            return nil
        default:
            return got.stringified() == want.stringified() ? nil : "\(path): \(got.stringified().prefix(300)) != \(want.stringified().prefix(300))"
        }
    }

    private func bytes(_ e: JSONValue) -> [UInt8] {
        [UInt8](Data(base64Encoded: e["bytes"]!.stringValue!)!)
    }

    private func errorJSON(_ error: Error) -> JSONValue {
        if let z = error as? ZipError {
            var o = JSONObject([("error", .string(z.message)), ("code", .string(z.code.rawValue))])
            if let name = z.entryName { o["entryName"] = .string(name) }
            return .object(o)
        }
        return .object(JSONObject([("error", .string((error as? LocalizedError)?.errorDescription ?? "\(error)"))]))
    }

    private func attempt(_ fn: () throws -> JSONValue) -> JSONValue {
        do { return try fn() } catch { return errorJSON(error) }
    }

    private func entryJSON(_ e: ZipEntry) -> JSONValue {
        .object(JSONObject([
            ("name", .string(e.name)),
            ("isDirectory", .bool(e.isDirectory)),
            ("encrypted", .bool(e.encrypted)),
            ("method", .number(Double(e.method))),
            ("compressedSize", .number(Double(e.compressedSize))),
            ("size", .number(Double(e.size))),
            ("crc32", .number(Double(e.crc32))),
            ("localHeaderOffset", .number(Double(e.localHeaderOffset))),
        ]))
    }

    private func zipOptions(_ o: JSONValue?) -> ZipReadOptions {
        ZipReadOptions(
            maxEntries: o?["maxEntries"]?.numberValue.map { Int($0) },
            maxTotalSize: o?["maxTotalSize"]?.numberValue.map { Int($0) },
            unsafePaths: o?["unsafePaths"]?.stringValue.flatMap(ZipUnsafePaths.init(rawValue:))
        )
    }

    private func run(_ e: JSONValue) throws -> JSONValue {
        switch e["fn"]!.stringValue! {
        case "readZip":
            let archive: ZipArchive
            do { archive = try readZip(bytes(e), options: zipOptions(e["options"])) } catch { return errorJSON(error) }
            let lookups = e["lookups"]?.arrayValue?.map { $0.stringValue! } ?? []
            let reads = archive.entries.map { entry in
                attempt { .object(JSONObject([("data", .string(Data(try archive.read(entry)).base64EncodedString()))])) }
            }
            let gets = lookups.map { name -> JSONValue in
                guard let entry = archive.get(name) else { return .number(-1) }
                return .number(Double(archive.entries.firstIndex(of: entry)!))
            }
            let named = lookups.map { name in attempt { .object(JSONObject([("text", .string(try archive.readText(name)))])) } }
            return .object(JSONObject([
                ("entries", .array(archive.entries.map(entryJSON))),
                ("reads", .array(reads)),
                ("gets", .array(gets)),
                ("named", .array(named)),
                ("extractedSize", .number(Double(archive.extractedSize))),
            ]))
        case let fn where fn.hasPrefix("extract"):
            let o = e["options"]
            let options = OfficeChartsReadOptions(
                maxEntries: o?["maxEntries"]?.numberValue.map { Int($0) },
                maxTotalSize: o?["maxTotalSize"]?.numberValue.map { Int($0) },
                unsafePaths: o?["unsafePaths"]?.stringValue.flatMap(ZipUnsafePaths.init(rawValue:)),
                maxCharts: o?["maxCharts"]?.numberValue.map { Int($0) }
            )
            return attempt {
                switch fn {
                case "extractXlsxCharts": return .array(try extractXlsxCharts(bytes(e), options: options).map { $0.toJSON() })
                case "extractPptxCharts": return .array(try extractPptxCharts(bytes(e), options: options).map { $0.toJSON() })
                default: return try extractOfficeCharts(bytes(e), options: options).toJSON()
                }
            }
        case "chartToOoxml":
            return chartToOoxml(createChartSpec(e["input"]!)).toJSON()
        case "chartFromOoxml":
            return chartFromOoxml(e["xml"]!.stringValue!).toJSON()
        case "chartFromMermaid":
            return chartFromMermaid(e["text"]!.stringValue!).toJSON()
        case "parseSankey":
            return parseSankey(e["text"]!.stringValue!).toJSON()
        case "parseTreemap":
            return parseTreemap(e["text"]!.stringValue!).toJSON()
        case let fn:
            XCTFail("unknown fn \(fn)")
            return .null
        }
    }

    func testVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        var failures: [String] = []
        for e in entries {
            let label = "\(e["fn"]!.stringValue!) \(e["name"]?.stringValue ?? e["input"]?.stringified().prefix(60).description ?? "")"
            if let diff = mismatch(try run(e), e["expected"]!) { failures.append("\(label): \(diff)") }
        }
        XCTAssertTrue(failures.isEmpty, "\(failures.count) of \(entries.count) vectors differ:\n" + failures.joined(separator: "\n"))
    }

    /// `chartRasterSize` with sizes JSON can't carry (values from the TS function in Node).
    func testRasterSizeFollowsJSForNonFiniteNumbers() throws {
        func size(_ w: Double, _ h: Double, _ scale: Double = 2, _ maxSize: Double = CHART_RASTER_MAX_SIZE) throws -> String {
            let s = try chartRasterSize(w, h, scale: scale, maxSize: maxSize)
            return [s.width, s.height, s.scale].map(JSONValue.jsString).joined(separator: ",")
        }
        XCTAssertEqual(try size(.infinity, 100), "NaN,1,0")
        XCTAssertEqual(try size(100, .infinity), "1,NaN,0")
        XCTAssertEqual(try size(100, 50, 2, .nan), "NaN,NaN,NaN")
        XCTAssertEqual(try size(1e300, 1e300, 2, 1e300), "1e+300,1e+300,1")
        XCTAssertEqual(try size(100, 50, .nan, 4096), "100,50,1")
        XCTAssertEqual(try size(100, 50, .infinity, .infinity), "Infinity,Infinity,Infinity")
        XCTAssertThrowsError(try size(.nan, 1)) { XCTAssertEqual($0.localizedDescription, "A chart image needs a positive width and height; got NaN × 1.") }
        func mark(_ rotate: Double) -> ChartTextMark {
            ChartTextMark(key: "t", role: .title, x: 1, y: 2, text: "a", anchor: .start, baseline: .middle, size: 11, fill: "#000", rotate: rotate)
        }
        // `mark.rotate ? … : undefined`, and `${n}` writes NaN / Infinity, not JSON's null.
        XCTAssertNil(chartTextTransform(mark(.nan)))
        XCTAssertEqual(chartTextTransform(mark(.infinity)), "rotate(Infinity 1 2)")
    }

    /// `playRace` captures the last time point when it starts (the TS `step` closure's `last`).
    func testRacePlaybackKeepsTheEndItStartedWith() throws {
        let host = try ChartConformanceHost(setup: JSONObject([
            ("spec", .object(JSONObject([
                ("type", .string("bar")),
                ("categories", .array([.string("a"), .string("b"), .string("c")])),
                ("series", .array([.object(JSONObject([("id", .string("s")), ("name", .string("S")), ("values", .array([.number(1), .number(2), .number(3)]))]))])),
            ]))),
        ]))
        XCTAssertTrue(host.controller.playRace(msPerStep: 50).ok)
        XCTAssertTrue(host.controller.addCategory("d").ok)
        host.advanceRace(50)
        XCTAssertEqual(host.controller.getState().raceFrame, 1)
        host.advanceRace(50)
        // At the old last frame (2) the race ends, although the chart now has four time points.
        XCTAssertNil(host.controller.getState().raceFrame)
    }

    func testAtob() {
        XCTAssertEqual(jsAtob("YWJj"), Array("abc".utf8))
        XCTAssertEqual(jsAtob("YWI"), Array("ab".utf8))
        XCTAssertEqual(jsAtob(" YW I= "), Array("ab".utf8))
        XCTAssertNil(jsAtob("a"))
        XCTAssertNil(jsAtob("a="))
        XCTAssertNil(jsAtob("!!!"))
        XCTAssertEqual(jsDecodeBase64DataUrl("data:application/zip;base64,\u{FEFF}YW\nJj\u{3000}"), Array("abc".utf8))
    }
}
