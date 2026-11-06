import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster
import XCTest
@testable import PixerateVector

/// The TS core's own outputs for import and export (`packages/core/tests/swift-vector-io-vectors.test.ts`
/// writes `Fixtures/vector-io-vectors.json`): PDF export compared byte for byte (compressed and not,
/// scaled, titled, a page per artboard), Lottie export, import and round trips, image tracing,
/// colour quantising and contours, the bitmap-to-vector styles on small generated images, and a
/// replay of the commands with their failures. Entries marked `trig: false` compare exactly,
/// `trig: true` ones within relative 1e-9; strings (and so PDF bytes) always exactly. Keys compare as sets.
final class VectorIoVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-io-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    override func setUp() {
        super.setUp()
        setVectorTextShaper(nil)
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
            return got == want ? nil : "\(path): \(got.stringified().prefix(300)) != \(want.stringified().prefix(300))"
        }
    }

    // MARK: Inputs

    static func image(_ name: String) -> VectorTracePixels {
        let o = vectors["images"]![name]!
        return VectorTracePixels(width: Int(o["width"]!.numberValue!), height: Int(o["height"]!.numberValue!), data: o["data"]!.arrayValue!.map { UInt8($0.numberValue!) })
    }

    func pdfOptions(_ o: JSONValue) -> VectorPdfOptions {
        VectorPdfOptions(pages: o["pages"]?.stringValue, scale: o["scale"]?.numberValue, title: o["title"]?.stringValue, compress: o["compress"]?.boolValue)
    }

    func traceOptions(_ o: JSONValue) -> VectorTraceOptions {
        VectorTraceOptions(mode: o["mode"]?.stringValue, channel: o["channel"]?.stringValue, threshold: o["threshold"]?.numberValue, color: o["color"]?.stringValue, colors: o["colors"]?.numberValue,
                           tolerance: o["tolerance"]?.numberValue, minArea: o["minArea"]?.numberValue, cornerRoundness: o["cornerRoundness"]?.numberValue, squareCorners: o["squareCorners"]?.boolValue)
    }

    func stylizeOptions(_ o: JSONValue) -> VectorStylizeOptions {
        VectorStylizeOptions(cell: o["cell"]?.numberValue, colors: o["colors"]?.numberValue, shape: o["shape"]?.stringValue, gap: o["gap"]?.numberValue, angle: o["angle"]?.numberValue,
                             color: o["color"]?.stringValue, colorNull: o["color"] == .null, jitter: o["jitter"]?.numberValue, seed: o["seed"]?.numberValue)
    }

    func importJSON(_ r: VectorLottieImport) -> JSONValue {
        .object(JSONObject([("document", r.document.toJSON()), ("notes", .array(r.notes.map { .string($0) }))]))
    }

    func nodesJSON(_ nodes: [VectorNode]) -> JSONValue { .array(nodes.map { $0.toJSON() }) }

    // MARK: Scenes

    func testPdfScenes() throws {
        let scenes = Self.vectors["scenes"]!.arrayValue!
        XCTAssertEqual(scenes.count, 5)
        for s in scenes {
            let name = s["name"]!.stringValue!
            let doc = try VectorDocument(json: s["doc"]!)
            for (i, p) in s["pdf"]!.arrayValue!.enumerated() {
                let out = try vectorDocumentToPdf(doc, pdfOptions(p["options"]!))
                let got = bytesToBase64(out.bytes)
                if got != p["pdf"]!.stringValue! {
                    XCTFail("\(name) pdf \(i): bytes differ\n\(String(decoding: out.bytes, as: UTF8.self).prefix(3000))")
                }
                XCTAssertEqual(out.pages, Int(p["pages"]!.numberValue!), "\(name) pdf \(i)")
                XCTAssertEqual(out.notes, p["notes"]!.arrayValue!.map { $0.stringValue! }, "\(name) pdf \(i)")
            }
        }
    }

    func testLottieScenes() throws {
        for s in Self.vectors["scenes"]!.arrayValue! {
            let name = s["name"]!.stringValue!
            let doc = try VectorDocument(json: s["doc"]!)
            let out = try vectorDocumentToLottie(doc, VectorLottieExportOptions(fps: 24, frames: 12, name: name))
            if let d = mismatch(out.json, s["lottie"]!, true) { XCTFail("\(name) lottie: \(d)") }
            let back = try parseVectorLottie(s["lottie"]!["lottie"]!, VectorLottieImportOptions(idPrefix: "rt"))
            if let d = mismatch(importJSON(back), s["roundTrip"]!, true) { XCTFail("\(name) round trip: \(d)") }
        }
    }

    // MARK: Entries

    func run(_ e: JSONValue) throws -> JSONValue {
        switch e["fn"]!.stringValue! {
        case "parseVectorLottie":
            return importJSON(try parseVectorLottie(e["lottie"]!, VectorLottieImportOptions(frame: e["frame"]?.numberValue, idPrefix: e["frame"] == nil ? nil : "lt")))
        case "parseVectorLottieError":
            do {
                _ = try parseVectorLottie(e["input"]!)
                return .null
            } catch let err as VectorImageError {
                return .string(err.message)
            } catch {
                return "SyntaxError"
            }
        case "lottieValueAt":
            let frames = e["frames"]!.arrayValue!.map { $0.numberValue! }
            return .array(e["props"]!.arrayValue!.map { p in .array(frames.map { f in .array(lottieValueAt(p, f).map { .number($0) }) }) })
        case "traceVectorImage":
            return nodesJSON(try traceVectorImage(Self.image(e["image"]!.stringValue!), traceOptions(e["options"]!)))
        case "quantizeVectorTraceColors":
            let q = quantizeVectorTraceColors(Self.image(e["image"]!.stringValue!), Int(e["count"]!.numberValue!))
            return .object(JSONObject([
                ("palette", .array(q.palette.map { .array($0.map { .number($0) }) })), ("index", .array(q.index.map { .number(Double($0)) })), ("counts", .array(q.counts.map { .number(Double($0)) })),
            ]))
        case "vectorTraceContours":
            let field = e["field"]!.arrayValue!.map { $0.numberValue! }
            let rings = vectorTraceContours(field, Int(e["w"]!.numberValue!), Int(e["h"]!.numberValue!), e["threshold"]!.numberValue!)
            return .array(rings.map { .array($0.map { .array([.number($0.x), .number($0.y)]) }) })
        case "stylizeVectorImage":
            return nodesJSON(try stylizeVectorImage(Self.image(e["image"]!.stringValue!), e["style"]!.stringValue!, stylizeOptions(e["options"]!)))
        case "stylizeError":
            let style = e["style"]!.stringValue!
            let options = stylizeOptions(e["options"]!)
            let px = style == "hatch" ? VectorTracePixels(width: 400, height: 400, data: [UInt8](repeating: 0, count: 400 * 400 * 4))
                : options.cell == 1 ? VectorTracePixels(width: 300, height: 300, data: [UInt8](repeating: 0, count: 300 * 300 * 4)) : Self.image("ring")
            do {
                _ = try stylizeVectorImage(px, style, options)
                return .null
            } catch let err as VectorImageError {
                return .string(err.message)
            }
        case let fn:
            throw VectorEditorError("No import / export function \(fn).")
        }
    }

    func testEntries() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThan(entries.count, 35)
        for (i, e) in entries.enumerated() {
            let label = e["fn"]!.stringValue! + (e["name"]?.stringValue.map { " (\($0))" } ?? "") + (e["image"]?.stringValue.map { " [\($0)]" } ?? "")
            do {
                if let d = mismatch(try run(e), e["out"]!, e["trig"]!.boolValue!) { XCTFail("entry \(i) \(label): \(d)") }
            } catch {
                XCTFail("entry \(i) \(label) threw: \(error)")
            }
        }
    }

    // MARK: Commands

    private func call(_ host: VectorConformanceHost, _ id: String, _ params: JSONValue? = nil) async throws -> JSONValue {
        var args = JSONObject([("id", .string(id))])
        if let params { args["params"] = params }
        let r = await host.callTool("run_command", args)
        return r.isError ? .object(JSONObject([("error", .string(r.text ?? ""))])) : try JSONValue.parse(r.text ?? "null")
    }

    func testCommandVectors() async throws {
        let commands = Self.vectors["commands"]!
        let host = try VectorConformanceHost(setup: commands["setup"]!.objectValue!)
        for (i, step) in commands["steps"]!.arrayValue!.enumerated() {
            let got = try await call(host, step["id"]!.stringValue!, step["params"])
            if let d = mismatch(got, step["result"]!, true) { XCTFail("step \(i) \(step["id"]!.stringValue!): \(d)") }
        }
        if let d = mismatch(try host.document(), commands["document"]!, true) { XCTFail("document: \(d)") }
    }

    /// Lottie import is one undo step, and `replace` takes the animation's size.
    func testImportLottieUndoAndReplace() throws {
        let host = try VectorConformanceHost(setup: ["width": 300, "height": 200])
        let c = host.controller
        let lottie: JSONValue = ["w": 64, "h": 48, "layers": [["ty": 4, "shapes": [["ty": "rc", "p": ["k": [10, 10]], "s": ["k": [8, 8]]], ["ty": "fl", "c": ["k": [1, 0, 0, 1]]]]]]]
        let added = try c.importLottie(lottie)
        XCTAssertTrue(added.result.ok)
        XCTAssertEqual(c.document.nodes.count, 1)
        XCTAssertEqual(c.selection, added.ids)
        c.undo()
        XCTAssertEqual(c.document.nodes.count, 0)
        let replaced = try c.importLottie(lottie, replace: true)
        XCTAssertTrue(replaced.result.ok)
        XCTAssertEqual(c.document.width, 64)
        XCTAssertEqual(c.document.height, 48)
        let bad = try c.importLottie("{")
        XCTAssertFalse(bad.result.ok)
        XCTAssertTrue(bad.result.message!.hasPrefix("Not a Lottie animation this editor can read: "), bad.result.message!)
    }

    /// A broken expectation fails: the comparisons are not vacuous.
    func testMismatchIsReported() throws {
        let scene = Self.vectors["scenes"]!.arrayValue![0]
        let doc = try VectorDocument(json: scene["doc"]!)
        let p = scene["pdf"]!.arrayValue![0]
        var bytes = try vectorDocumentToPdf(doc, pdfOptions(p["options"]!)).bytes
        XCTAssertEqual(bytesToBase64(bytes), p["pdf"]!.stringValue!)
        bytes[200] ^= 1
        XCTAssertNotEqual(bytesToBase64(bytes), p["pdf"]!.stringValue!)
        let e = Self.vectors["entries"]!.arrayValue!.first { $0["fn"] == "traceVectorImage" }!
        let got = try run(e)
        XCTAssertNil(mismatch(got, e["out"]!, false))
        guard case .array(var nodes) = e["out"]!, case .object(var node) = nodes[0], case .array(var subpaths) = node["subpaths"]!, case .object(var sp) = subpaths[0],
              case .array(var anchors) = sp["anchors"]!, case .object(var a) = anchors[0] else { return XCTFail("no anchors") }
        a["x"] = .number(a["x"]!.numberValue!.nextUp)
        anchors[0] = .object(a)
        sp["anchors"] = .array(anchors)
        subpaths[0] = .object(sp)
        node["subpaths"] = .array(subpaths)
        nodes[0] = .object(node)
        XCTAssertNotNil(mismatch(got, .array(nodes), false))
    }
}
