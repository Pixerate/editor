import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster
import XCTest
@testable import PixerateVector

/// The fake outline shaper of `swift-vector-text-vectors.test.ts`: metric advances, each glyph a
/// box with a quadratic top (taller for vertical alternates); `Missing` falls back to sans-serif.
final class FakeOutlineShaper: VectorTextShaper {
    let id = "fake-outline"
    private let metric = MetricTextShaper()
    func resolve(_ font: TextFont) -> (family: String, available: Bool) { font.family == "Missing" ? ("sans-serif", false) : (font.family, true) }
    func metrics(_ font: TextFont) -> (ascent: Double, descent: Double) { metric.metrics(font) }
    func measure(_ text: [UInt16], _ font: TextFont) -> [Double] { metric.measure(text, font) }
    var hasOutlines: Bool { true }
    func outline(_ text: [UInt16], _ font: TextFont, x: Double, y: Double, vertical: Bool) -> BezierPath? {
        let carets = metric.measure(text, font)
        let h = font.size * (vertical ? 0.9 : 0.7)
        var out: BezierPath = []
        for k in text.indices {
            let x0 = x + carets[k]
            let x1 = x + carets[k + 1]
            if !(x1 > x0) { continue }
            out += [.M(x: x0, y: y), .L(x: x1, y: y), .Q(x1: x1, y1: y - h, x: (x0 + x1) / 2, y: y - h), .Z]
        }
        return out
    }
    func families() -> [String]? { ["sans-serif", "serif", "Fake"] }
}

/// The TS core's own outputs for text (`packages/core/tests/swift-vector-text-vectors.test.ts` writes
/// `Fixtures/vector-text-vectors.json`): the shared layout engine with the metric shaper, text node
/// layout for point, area, path and vertical text, glyph boxes and outlines, bounds, transforms,
/// edits and validation, carets, spans, SVG export, import and render data, blends of text, and two
/// command replays (the metric shaper, and a fake outline shaper for Create Outlines). Entries
/// marked `trig: false` compare exactly, `trig: true` ones within relative 1e-9; strings always
/// exactly. Keys compare as sets.
final class VectorTextVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-text-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    override func tearDown() {
        setVectorTextShaper(nil)
        super.tearDown()
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

    // MARK: JSON of the TS shapes

    private func obj(_ pairs: [(String, JSONValue)]) -> JSONValue { .object(JSONObject(pairs)) }
    private func n(_ v: Double) -> JSONValue { .number(v) }
    private func n(_ v: Int) -> JSONValue { .number(Double(v)) }

    func pathJSON(_ path: BezierPath) -> JSONValue {
        .array(path.map { c in
            switch c {
            case let .M(x, y): obj([("type", "M"), ("x", n(x)), ("y", n(y))])
            case let .L(x, y): obj([("type", "L"), ("x", n(x)), ("y", n(y))])
            case let .Q(x1, y1, x, y): obj([("type", "Q"), ("x1", n(x1)), ("y1", n(y1)), ("x", n(x)), ("y", n(y))])
            case let .C(x1, y1, x2, y2, x, y): obj([("type", "C"), ("x1", n(x1)), ("y1", n(y1)), ("x2", n(x2)), ("y2", n(y2)), ("x", n(x)), ("y", n(y))])
            default: obj([("type", "Z")])
            }
        })
    }

    func fontJSON(_ f: TextFont) -> JSONValue {
        var o = JSONObject([("family", .string(f.family)), ("weight", n(f.weight)), ("italic", .bool(f.italic)), ("size", n(f.size))])
        if let ps = f.postScriptName { o["postScriptName"] = .string(ps) }
        return .object(o)
    }

    func layoutJSON(_ l: TextLayout) -> JSONValue {
        func fragment(_ f: LaidFragment) -> JSONValue {
            var o = JSONObject([("start", n(f.start)), ("end", n(f.end)), ("style", .object(f.style)), ("font", fontJSON(f.font)), ("family", .string(f.family)), ("x", n(f.x)), ("y", n(f.y)),
                                ("carets", .array(f.carets.map(n))), ("spaced", .bool(f.spaced))])
            if let up = f.upright { o["upright"] = .bool(up) }
            if let gs = f.glyphs {
                o["glyphs"] = .array(gs.map { g in
                    obj([("index", n(g.index)), ("length", n(g.length)), ("x", n(g.x)), ("y", n(g.y)), ("angle", n(g.angle)), ("advance", n(g.advance)), ("ascent", n(g.ascent)), ("descent", n(g.descent)), ("vert", .bool(g.vert))])
                })
            }
            return .object(o)
        }
        let lines: [JSONValue] = l.lines.map { line in
            var o = JSONObject([("start", n(line.start)), ("end", n(line.end)), ("baseline", n(line.baseline)), ("ascent", n(line.ascent)), ("descent", n(line.descent)), ("x", n(line.x)), ("width", n(line.width)),
                                ("chars", .array(line.chars.map { obj([("index", n($0.index)), ("x", n($0.x)), ("advance", n($0.advance))]) })), ("fragments", .array(line.fragments.map(fragment)))])
            if let m = line.matrix { o["matrix"] = m.json }
            return .object(o)
        }
        var o = JSONObject([("lines", .array(lines)), ("bounds", l.bounds.json), ("missingFonts", .array(l.missingFonts.map { .string($0) })), ("orientation", .string(l.orientation))])
        if let m = l.matrix { o["matrix"] = m.json }
        return .object(o)
    }

    func vectorLayoutJSON(_ l: VectorTextLayout) -> JSONValue {
        let glyphs: [JSONValue] = l.glyphs.map { g in
            obj([("index", n(g.index)), ("char", .string(str16(g.char))), ("x", n(g.x)), ("y", n(g.y)), ("angle", n(g.angle)), ("advance", n(g.advance)), ("ascent", n(g.ascent)), ("descent", n(g.descent)), ("fragment", n(g.fragment))])
        }
        let fragments: [JSONValue] = l.fragments.map { f in
            var o = JSONObject([("style", .object(f.style)), ("font", fontJSON(f.font))])
            if let fill = f.fill { o["fill"] = fill }
            o["from"] = n(f.from)
            o["to"] = n(f.to)
            o["line"] = n(f.line)
            return .object(o)
        }
        let lines: [JSONValue] = l.lines.map { obj([("start", n($0.start)), ("end", n($0.end)), ("baseline", n($0.baseline)), ("x", n($0.x)), ("width", n($0.width))]) }
        return obj([
            ("shaper", .string(l.shaper)), ("glyphs", .array(glyphs)), ("fragments", .array(fragments)), ("lines", .array(lines)), ("origin", l.origin.json), ("text", layoutJSON(l.text)),
            ("bounds", l.bounds?.json ?? .null), ("overflow", .bool(l.overflow)), ("missingFonts", .array(l.missingFonts.map { .string($0) })),
        ])
    }

    func spanJSON(_ sp: VectorTextSpan) -> JSONValue {
        var o = JSONObject([("text", .string(sp.text)), ("x", .array(sp.x.map(n))), ("y", .array(sp.y.map(n)))])
        if let r = sp.rotate { o["rotate"] = .array(r.map(n)) }
        o["style"] = .object(sp.style)
        o["family"] = .string(sp.family)
        if let f = sp.fill { o["fill"] = f }
        return .object(o)
    }

    private func block(_ v: JSONValue) -> TextBlock {
        let runs = (v["runs"]?.arrayValue ?? []).compactMap { StyledRun(json: $0) }
        let paragraphs = (v["paragraphs"]?.arrayValue ?? []).compactMap { StyledRun(json: $0) }
        let f = v["frame"]!
        let box: (width: Double, height: Double)? = f["kind"] == "box" ? (f["width"]!.numberValue!, f["height"]!.numberValue!) : nil
        return TextBlock(text: (v["text"]?.stringValue ?? "").u16, runs: runs, paragraphs: paragraphs, box: box, originTop: f["origin"] == "top", vertical: v["orientation"] == "vertical")
    }

    private func catching(_ fn: () throws -> JSONValue) -> JSONValue {
        do { return try fn() } catch { return obj([("error", .string("\(error)"))]) }
    }

    func run(_ e: JSONValue) throws -> JSONValue {
        setVectorTextShaper(e["shaper"] == "outline" ? FakeOutlineShaper() : MetricTextShaper())
        func node(_ k: String = "node") throws -> VectorNode { try VectorNode(json: e[k]!) }
        func list(_ k: String) -> [JSONValue] { e[k]!.arrayValue! }
        switch e["fn"]!.stringValue! {
        case "layoutText": return layoutJSON(layoutText(block(e["block"]!), getVectorTextShaper()))
        case "layoutVectorText": return vectorLayoutJSON(layoutVectorText(try node()))
        case "vectorTextPaths":
            let p = vectorTextPaths(try node())
            return obj([("parts", .array(p.parts.map { part in
                var o = JSONObject()
                if let f = part.fill { o["fill"] = f }
                o["path"] = pathJSON(part.path)
                return .object(o)
            })), ("outlines", .bool(p.outlines))])
        case "vectorNodeBounds":
            let t = try node()
            return .array([try vectorNodeBounds(t)?.json ?? .null, try vectorNodeBounds(t, VectorMatrix(1, 0, 0, 1, 7, 9))?.json ?? .null])
        case "expandVectorAppearance": return try expandVectorAppearance(try node()).toJSON()
        case "vectorTextGeometryNode": return vectorTextGeometryNode(try node()).toJSON()
        case "vectorTextSpans":
            return .array(vectorTextSpans(try node()).map { sp in obj([("span", spanJSON(sp)), ("svg", .object(vectorTextSpanSvg(sp, sp.fill == nil ? nil : "url(#x)")))]) })
        case "transformVectorNode":
            let t = try node()
            return .array(try list("matrices").map { try transformVectorNode(t, VectorMatrix(json: $0)!).toJSON() })
        case "vectorTextBoxOutline": return pathJSON(vectorTextBoxOutline(try node()))
        case "vectorTextCaret":
            let t = try node()
            return .array(list("indices").map { i in
                let c = vectorTextCaret(t, Int(i.numberValue!))
                return obj([("top", c.top.json), ("bottom", c.bottom.json), ("line", n(c.line))])
            })
        case "vectorTextIndexAt":
            let t = try node()
            return .array(list("points").map { n(vectorTextIndexAt(t, Vec2(json: $0)!)) })
        case "vectorTextSelectionQuads":
            let t = try node()
            return .array(list("ranges").map { r in
                let ab = r.arrayValue!.map { Int($0.numberValue!) }
                return .array(vectorTextSelectionQuads(t, ab[0], ab[1]).map { .array($0.map(\.json)) })
            })
        case "replaceVectorText":
            let t = try node()
            return .array(list("edits").map { ed in
                let a = ed.arrayValue!
                return replaceVectorText(t, Int(a[0].numberValue!), Int(a[1].numberValue!), a[2].stringValue!).toJSON()
            })
        case "styleVectorText":
            let t = try node()
            let len = t.textValue.utf16.count
            return .array(list("patches").map { p in
                let a = p.arrayValue!
                return catching { try styleVectorText(t, Int(a[0].numberValue!), min(Int(a[1].numberValue!), len), a[2].objectValue!).toJSON() }
            })
        case "patchVectorCharacterStyle":
            let base = JSONObject([("fontFamily", "sans-serif"), ("fontWeight", 400), ("fontSize", 24), ("italic", true)])
            return .array(list("patches").map { p in catching { .object(try patchVectorCharacterStyle(base, p.objectValue!, "font")) } })
        case "patchVectorParagraphStyle":
            let base = JSONObject([("align", "right"), ("startIndent", 5)])
            return .array(list("patches").map { p in catching { .object(try patchVectorParagraphStyle(base, p.objectValue!)) } })
        case "sanitizeVectorTextFrame": return .array(list("values").map { v in catching { .object(try sanitizeVectorTextFrame(v)) } })
        case "sanitizeVectorTextFields": return .array(list("values").map { v in catching { .object(try sanitizeVectorTextFields(v.objectValue!)) } })
        case "vectorTextRange":
            let text = e["text"]!.stringValue!
            return .array(list("ranges").map { r in
                let a = r.arrayValue!
                return catching {
                    let (s, t) = try vectorTextRange(text, a[0].numberValue, a[1].numberValue)
                    return .array([n(s), n(t)])
                }
            })
        case "vectorTextName": return .array(list("values").map { .string(vectorTextName($0.stringValue!)) })
        case "pathTextFrameFromBezier": return .array(list("values").map { pathTextFrameFromBezier(toBezierPath(.svg($0.stringValue!))).map { .object($0) } ?? .null })
        case "vectorDocumentToSvg": return .string(try vectorDocumentToSvg(try VectorDocument(json: e["doc"]!)))
        case "getVectorSceneRenderData": return try getVectorSceneRenderData(try VectorDocument(json: e["doc"]!))
        case "parseVectorSvg":
            if let values = e["values"]?.arrayValue { return .array(try values.map { try parseVectorSvg($0.stringValue!).toJSON() }) }
            return try parseVectorSvg(e["svg"]!.stringValue!).toJSON()
        case "createVectorMorph":
            let ts = list("ts").map { $0.numberValue! }
            return .array(try list("keys").map { pair in
                let ab = pair.arrayValue!
                let m = try createVectorMorph(try VectorNode(json: ab[0]), try VectorNode(json: ab[1]))
                return .array(try ts.map { try m.at($0).toJSON() })
            })
        case let fn:
            throw VectorEditorError("No text function \(fn).")
        }
    }

    func testTextVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThan(entries.count, 150)
        for (i, e) in entries.enumerated() {
            let fn = e["fn"]!.stringValue!
            let label = "\(fn) [\(e["shaper"]!.stringValue!)]" + (e["name"]?.stringValue.map { " (\($0))" } ?? "")
            do {
                if let d = mismatch(try run(e), e["out"]!, e["trig"]!.boolValue!) { XCTFail("entry \(i) \(label): \(d)") }
            } catch {
                XCTFail("entry \(i) \(label) threw: \(error)")
            }
        }
    }

    private func call(_ host: VectorConformanceHost, _ id: String, _ params: JSONValue? = nil) async throws -> JSONValue {
        var args = JSONObject([("id", .string(id))])
        if let params { args["params"] = params }
        let r = await host.callTool("run_command", args)
        return r.isError ? .object(JSONObject([("error", .string(r.text ?? ""))])) : try JSONValue.parse(r.text ?? "null")
    }

    private func replay(_ commands: JSONValue) async throws {
        let host = try VectorConformanceHost(setup: commands["setup"]!.objectValue!)
        if commands["shaper"] == "outline" { host.controller.setTextShaper(FakeOutlineShaper()) }
        for (i, step) in commands["steps"]!.arrayValue!.enumerated() {
            let got = try await call(host, step["id"]!.stringValue!, step["params"])
            if let d = mismatch(got, step["result"]!, true) { XCTFail("step \(i) \(step["id"]!.stringValue!): \(d)") }
        }
        if let d = mismatch(try host.document(), commands["document"]!, true) { XCTFail("document: \(d)") }
        XCTAssertEqual(try host.controller.toSvg(), commands["svg"]!.stringValue!)
        if let d = mismatch(try host.render() ?? .null, commands["render"]!, true) { XCTFail("render: \(d)") }
    }

    func testCommandVectors() async throws { try await replay(Self.vectors["commands"]!) }

    func testOutlineCommandVectors() async throws { try await replay(Self.vectors["outlineCommands"]!) }

    /// The metric shaper's advances per character class, ascent and descent (`createMetricTextShaper`).
    func testMetricShaper() {
        let s = MetricTextShaper()
        let font = TextFont(family: "x", weight: 400, italic: false, size: 10)
        XCTAssertEqual(s.measure("iA 0m日\n".u16, font), [0, 2.8000000000000003, 9.4, 13, 18.6, 27.1, 37.1, 37.1])
        XCTAssertEqual(s.measure("a".u16, TextFont(family: "x", weight: 600, italic: false, size: 10)), [0, 5.67])
        XCTAssertEqual(s.metrics(font).ascent, 8)
        XCTAssertEqual(s.metrics(font).descent, 2)
        XCTAssertFalse(s.hasOutlines)
    }

    /// Undo takes text edits back one step each; a shaper change lays text out again.
    func testUndoAndShaper() async throws {
        let host = try VectorConformanceHost(setup: ["width": 300, "height": 200])
        let c = host.controller
        _ = try await call(host, "vector.addText", ["text": "Undo me", "x": 10, "y": 30])
        _ = try await call(host, "vector.setText", ["id": "n1", "text": "Redo", "start": 0, "end": 4])
        _ = try await call(host, "vector.setTextStyle", ["id": "n1", "fontSize": 40])
        XCTAssertEqual(c.getNode("n1")?.textValue, "Redo me")
        XCTAssertTrue(c.undo())
        XCTAssertEqual(c.getNode("n1")?.fontStyle["fontSize"], 24)
        XCTAssertTrue(c.undo())
        XCTAssertEqual(c.getNode("n1")?.textValue, "Undo me")
        XCTAssertEqual(c.getNode("n1")?.name, "Undo me")
        XCTAssertTrue(c.redo())
        XCTAssertEqual(c.getNode("n1")?.name, "Redo me")
        let before = c.getTextLayout("n1")!
        c.setTextShaper(FakeOutlineShaper())
        XCTAssertEqual(c.getTextLayout("n1")!.shaper, "fake-outline")
        XCTAssertNotEqual(before.shaper, "fake-outline")
        let panel = try XCTUnwrap({ () -> VectorTextPanelData? in
            c.select(["n1"])
            return c.textPanel()
        }())
        XCTAssertEqual(panel.target, "nodes")
        XCTAssertTrue(panel.outlines)
        XCTAssertEqual(panel.font["fontSize"], 24)
    }

    /// A broken expectation fails: the comparison is not vacuous.
    func testMismatchIsReported() throws {
        let e = Self.vectors["entries"]!.arrayValue!.first { $0["fn"] == "layoutVectorText" && $0["name"] == "path" && $0["shaper"] == "metric" }!
        let got = try run(e)
        XCTAssertNil(mismatch(got, e["out"]!, true))
        guard case .object(var out) = e["out"]!, case .array(var glyphs) = out["glyphs"]!, case .object(var g) = glyphs[0] else { return XCTFail("no glyphs") }
        g["x"] = .number(g["x"]!.numberValue! + 1e-6)
        glyphs[0] = .object(g)
        out["glyphs"] = .array(glyphs)
        XCTAssertNotNil(mismatch(got, .object(out), true))
        let block = Self.vectors["entries"]!.arrayValue!.first { $0["fn"] == "layoutText" }!
        let width = try run(block)["lines"]!.arrayValue![0]["width"]!.numberValue!
        XCTAssertNotNil(mismatch(.number(width.nextUp), .number(width), false))
    }
}
