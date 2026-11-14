import Foundation
import XCTest
@testable import PixerateCore

/// `drawPieces` and `createLinkFocus` (#812) against the TS core's own outputs
/// (`packages/core/tests/swift-draw-link-vectors.test.ts` writes `Fixtures/draw-link-vectors.json`).
/// Numbers compare within relative 1e-9 (easing curves go through `pow` and `exp`).
final class DrawLinkFocusTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "draw-link-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    private func close(_ a: Double, _ b: Double) -> Bool { a == b || abs(a - b) <= 1e-9 * max(1, abs(a), abs(b)) }

    func testDrawPiecesMatchesTheTSCore() throws {
        let ps = Self.vectors["ps"]!.arrayValue!.map { $0.numberValue! }
        for (n, c) in Self.vectors["draw"]!.arrayValue!.enumerated() {
            let pieces = c["pieces"]!.arrayValue!.map { DrawPiece(from: $0["from"]!.numberValue!, to: $0["to"]!.numberValue!, id: $0["id"]?.stringValue) }
            let o = c["options"]!
            let ease: DrawEase = .easing(o["ease"].flatMap { AnimationEasing(json: $0) })
            do {
                let plan = try DrawPieces(pieces, total: o["total"]?.numberValue, at: o["at"]?.numberValue ?? 0, span: o["span"]?.numberValue, ease: ease)
                guard let out = c["out"] else { XCTFail("case \(n): expected a throw (\(c["throws"]!.stringValue!))"); continue }
                XCTAssertTrue(close(plan.total, out["total"]!.numberValue!), "case \(n) total")
                for (i, w) in out["windows"]!.arrayValue!.enumerated() {
                    XCTAssertTrue(close(plan.windows[i].start, w["start"]!.numberValue!) && close(plan.windows[i].end, w["end"]!.numberValue!), "case \(n) window \(i): \(plan.windows[i]) vs \(w)")
                }
                for (k, p) in ps.enumerated() {
                    XCTAssertTrue(close(plan.headAt(p), out["heads"]!.arrayValue![k].numberValue!), "case \(n) head at \(p)")
                    let want = out["drawn"]!.arrayValue![k].arrayValue!
                    for (i, d) in plan.drawAt(p).enumerated() {
                        let w = want[i]
                        XCTAssertTrue(close(d.visible, w["visible"]!.numberValue!) && close(d.length, w["length"]!.numberValue!) && close(d.fraction, w["fraction"]!.numberValue!), "case \(n) p \(p) piece \(i)")
                        XCTAssertEqual(d.dasharray, w["dasharray"]!.stringValue!, "case \(n) p \(p) piece \(i) dasharray")
                        XCTAssertEqual(d.shown, w["shown"]!.boolValue!, "case \(n) p \(p) piece \(i) shown")
                    }
                }
                let flair = drawPiecesToFlair(plan, durationMs: 1300)
                let wantFlair = out["flair"]!.arrayValue!
                XCTAssertEqual(flair.count, wantFlair.count, "case \(n) flair")
                for (a, w) in zip(flair, wantFlair) {
                    XCTAssertEqual(a.id, w["id"]!.stringValue!)
                    XCTAssertEqual(a.delay, w["delay"]!.numberValue!)
                    XCTAssertEqual(a.ms, w["ms"]!.numberValue!)
                }
            } catch {
                XCTAssertEqual("\(error)", c["throws"]?.stringValue, "case \(n)")
            }
        }
    }

    func testLinkFocusMatchesTheTSCore() throws {
        for (n, c) in Self.vectors["focus"]!.arrayValue!.enumerated() {
            let marks = c["marks"]!.arrayValue!.map { $0.arrayValue!.map { $0.stringValue! } }
            let links = c["links"]!.arrayValue!.map { e -> (String, [String]) in
                let pair = e.arrayValue!
                return (pair[0].stringValue!, pair[1].arrayValue!.map { $0.stringValue! })
            }
            var labels: [String: String] = [:]
            if let l = c["labels"]?.objectValue { for (k, v) in l { labels[k] = v.stringValue! } }
            do {
                let model = try LinkFocusModel(marks: marks, links: links, order: c["order"]?.arrayValue?.map { $0.stringValue! }, labels: labels, dim: c["dim"]?.numberValue ?? 0.25)
                guard let out = c["out"] else { XCTFail("case \(n): expected a throw"); continue }
                XCTAssertEqual(model.order, out["order"]!.arrayValue!.map { $0.stringValue! }, "case \(n) order")
                XCTAssertEqual(model.dim, out["dim"]!.numberValue!)
                for s in out["states"]!.arrayValue! {
                    let step = s["step"]!.stringValue!
                    let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
                    var handled: Bool? = nil
                    var error: String? = nil
                    switch parts[0] {
                    case "focus":
                        do { try model.focus(parts[1]) } catch let e { error = "\(e)" }
                    case "key": handled = model.handleKey(parts[1])
                    default: model.clear()
                    }
                    XCTAssertEqual(handled, s["handled"]?.boolValue, "case \(n) \(step) handled")
                    XCTAssertEqual(error, s["error"]?.stringValue, "case \(n) \(step) error")
                    XCTAssertEqual(model.focus, s["focus"]?.stringValue, "case \(n) \(step) focus")
                    XCTAssertEqual(model.lit, s["lit"]!.arrayValue!.map { $0.boolValue! }, "case \(n) \(step) lit")
                    XCTAssertEqual(model.inFocus, s["inFocus"]!.arrayValue!.map { $0.stringValue! }, "case \(n) \(step) inFocus")
                    XCTAssertEqual(model.opacity(), s["opacity"]!.arrayValue!.map { $0.numberValue! }, "case \(n) \(step) opacity")
                    XCTAssertEqual(model.describe(), s["describe"]!.stringValue!, "case \(n) \(step) describe")
                }
                var keys: [String] = []
                for m in marks { for k in m where !keys.contains(k) { keys.append(k) } }
                XCTAssertEqual(keys.map { model.related($0) }, out["related"]!.arrayValue!.map { $0.arrayValue!.map { $0.stringValue! } }, "case \(n) related")
                XCTAssertEqual(keys.map { model.describe(.some($0)) }, out["describeEach"]!.arrayValue!.map { $0.stringValue! }, "case \(n) describe each")
                let litEach = out["litEach"]!.arrayValue!.map { $0.arrayValue!.map { $0.boolValue! } }
                XCTAssertEqual(([nil] + keys.map { Optional($0) }).map { linkFocusLit(marks, links, $0) }, litEach, "case \(n) lit each")
            } catch {
                XCTAssertEqual("\(error)", c["throws"]?.stringValue, "case \(n)")
            }
        }
    }
}
