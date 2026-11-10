import CryptoKit
import Foundation
import PixerateConformance
import PixerateContracts
import PixerateCore
import XCTest
@testable import PixeratePaint

/// Replays the paint scenarios of `@pixerate/conformance` against the Swift paint editor. A scenario
/// the Swift port can't pass yet is marked `"skip": { "swift": "… (#issue)" }` in its file and
/// reported here, so the remaining work is a count that goes down.
final class PaintConformanceTests: XCTestCase {
    func testPaintScenarios() async throws {
        let scenarios = try ConformanceScenario.load(domain: "paint")
        XCTAssertFalse(scenarios.isEmpty)
        var passed: [String] = []
        var skipped: [(String, String)] = []
        var failures: [ConformanceMismatch] = []
        for scenario in scenarios {
            if let reason = scenario.skip["swift"] {
                skipped.append((scenario.id, reason))
                continue
            }
            guard let paint = try? PaintConformanceHost(setup: scenario.setup) else {
                XCTFail("\(scenario.id) is not skipped, but there is no Swift paint editor to run it against.")
                continue
            }
            // Also checks Swift's own save → load → save at each reload step (`RoundTripHost`).
            let host = RoundTripHost(paint, scenario.id)
            let outputs = try await runConformanceScenario(scenario, host: host)
            XCTAssertEqual(host.checked, scenario.steps.filter(\.reload).count, "\(scenario.id) reloads checked")
            let mismatches = compareConformance(scenario, outputs) { try decodeConformancePNG(Data(contentsOf: $0)) }
            if mismatches.isEmpty { passed.append(scenario.id) } else { failures += mismatches }
        }
        for failure in failures { XCTFail(failure.description) }
        ConformanceReport.write(domain: "paint", passed: passed, skipped: skipped, failed: Set(failures.map(\.scenario)).count)
    }
}

/**
 * The paint host, checking Swift's own save → load → save at every reload step: the save after
 * reopening is the save that was opened, and the pixels are the same. The recorded comparison
 * leaves the document out of two reload steps (`culture`, `culture-replay`; see GOTCHAS), so this
 * is what checks them; the TS core checks itself the same way (`reopens what it saved unchanged`
 * in `paint-conformance.test.ts`).
 */
private final class RoundTripHost: ConformanceHost {
    let inner: PaintConformanceHost
    let id: String
    var checked = 0
    private var pending: [UInt8]?

    init(_ inner: PaintConformanceHost, _ id: String) {
        self.inner = inner
        self.id = id
    }

    func callTool(_ name: String, _ args: JSONObject) async -> McpToolResult { await inner.callTool(name, args) }
    func document() throws -> JSONValue { try inner.document() }
    func pixels(paper: Bool?) throws -> ConformanceImage { try inner.pixels(paper: paper) }
    func isGeneratedId(_ value: String) -> Bool { inner.isGeneratedId(value) }

    func save() throws -> JSONValue? {
        pending = try inner.pixels(paper: nil).data
        return try inner.save()
    }

    func load(_ document: JSONValue) throws -> [String]? {
        let before = pending
        pending = nil
        let problems = try inner.load(document)
        // A `load` step opens another document on purpose; only reloads must change nothing.
        guard let before else { return problems }
        checked += 1
        XCTAssertEqual(problems, [], "\(id): problems reopening its own save")
        let again = comparable(try inner.save())
        let opened = comparable(document)
        if again != opened { XCTFail("\(id): the save after reopening differs from the one opened at \(firstDifference(again, opened))") }
        XCTAssertTrue(try inner.pixels(paper: nil).data == before, "\(id): the pixels changed on reopening")
        return problems
    }

    /// `lastGrownAt` is the clock at save time (growWhileClosed); everything else must come back.
    private func comparable(_ doc: JSONValue?) -> JSONValue {
        guard var o = doc?.objectValue else { return doc ?? .null }
        if var c = o["cultures"]?.objectValue {
            c["lastGrownAt"] = nil
            o["cultures"] = .object(c)
        }
        return .object(o)
    }
}

/// Where two JSON values first differ, as a JSON pointer and both values (for failure messages).
private func firstDifference(_ a: JSONValue, _ b: JSONValue, _ path: String = "") -> String {
    switch (a, b) {
    case (.object(let x), .object(let y)):
        for k in Set(x.keys).union(y.keys).sorted() where x[k] != y[k] {
            return firstDifference(x[k] ?? .null, y[k] ?? .null, "\(path)/\(k)")
        }
    case (.array(let x), .array(let y)) where x.count == y.count:
        for (i, (u, v)) in zip(x, y).enumerated() where u != v { return firstDifference(u, v, "\(path)/\(i)") }
    default: break
    }
    return "\(path.isEmpty ? "/" : path): \(String(a.stringified().prefix(200))) ≠ \(String(b.stringified().prefix(200)))"
}

/// Prints the summary and adds it to the GitHub job summary when there is one.
enum ConformanceReport {
    static func write(domain: String, passed: [String], skipped: [(String, String)], failed: Int) {
        var text = "\(domain) scenarios: \(passed.count) passed, \(failed) failed, \(skipped.count) skipped\n"
        for (id, reason) in skipped { text += "- skipped \(id): \(reason)\n" }
        print(text)
        if let path = ProcessInfo.processInfo.environment["GITHUB_STEP_SUMMARY"], let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(Data("### Swift conformance\n\n\(text)\n".utf8))
            try? handle.close()
        }
    }
}

/// The runner itself, checked against the recordings: a host that plays back what the TypeScript
/// core returned (with its own generated ids) must match every scenario exactly.
final class ConformanceRunnerTests: XCTestCase {
    func testPlaybackOfEveryRecordingMatches() async throws {
        let scenarios = try ConformanceScenario.load(domain: "paint")
        for scenario in scenarios {
            let host = PlaybackHost(scenario)
            let outputs = try await runConformanceScenario(scenario, host: host)
            let mismatches = compareConformance(scenario, outputs) { try decodeConformancePNG(Data(contentsOf: $0)) }
            XCTAssertEqual(mismatches.map(\.description), [], scenario.id)
        }
    }

    func testRecordedPNGsDecodeToTheRecordedPixels() throws {
        var checked = 0
        for scenario in try ConformanceScenario.load(domain: "paint") {
            for step in scenario.steps {
                guard let pixels = step.expect["pixels"]?.objectValue, let file = pixels["file"]?.stringValue else { continue }
                let image = try decodeConformancePNG(Data(contentsOf: ConformanceContracts.url("domains/paint/fixtures/\(file)")))
                XCTAssertEqual(image.width, Int(pixels["width"]?.numberValue ?? 0), file)
                let hash = SHA256.hash(data: Data(image.data)).map { String(format: "%02x", $0) }.joined()
                XCTAssertEqual(hash, pixels["sha256"]?.stringValue, file)
                checked += 1
            }
        }
        XCTAssertGreaterThan(checked, 50)
    }

    /// The same cases as the TypeScript normalization tests (`tests/paint-conformance.test.ts`).
    func testNormalizationMatchesTheTypeScriptRules() throws {
        let isId: (String) -> Bool = { $0.range(of: #"^pl[0-9a-z]{9,}$"#, options: .regularExpression) != nil }
        let ids = ConformanceIds()
        let value: JSONValue = ["layers": [["name": "B", "id": "plb000000002"], ["id": "pla000000001", "name": "A"]], "active": "pla000000001", "strokeId": "s1", "brush": "ink-pen"]
        XCTAssertEqual(normalizeConformanceValue(value, ids, isGeneratedId: isId), ["active": "@1", "brush": "ink-pen", "layers": [["id": "@2", "name": "B"], ["id": "@1", "name": "A"]], "strokeId": "s1"])
        XCTAssertEqual(normalizeConformanceValue(["message": "Unknown layer \"plb000000002\".", "byLayer": ["pla000000001": 1], "id": "plc000000003"], ids, isGeneratedId: isId), ["byLayer": ["@1": 1], "id": "@3", "message": "Unknown layer \"@2\"."])
        XCTAssertEqual(ids.resolve("@3"), "plc000000003")
        let binary = normalizeConformanceValue(["png": .string(String(repeating: "A", count: 200)), "short": "AAAA", "url": "data:image/png;base64,AA", "at": "2026-11-04T01:06:52.993Z", "day": "2026-11-04"], ConformanceIds())
        XCTAssertEqual(binary, ["at": "<time>", "day": "2026-11-04", "png": "<binary>", "short": "AAAA", "url": "<binary>"])
        XCTAssertEqual(omitConformancePaths(["a": 1, "backend": ["x": 1], "layers": [["engine": 1, "id": "x"], ["engine": 2, "id": "y"]]], ["/backend", "/layers/*/engine"]), ["a": 1, "layers": [["id": "x"], ["id": "y"]]])
        XCTAssertEqual(omitConformancePaths(["m": ["a": ["k": 1, "j": 2], "b": ["k": 3]]], ["/m/*/k"]), ["m": ["a": ["j": 2], "b": [:]]])
        XCTAssertThrowsError(try resolveConformanceArguments(["layerId": "@9"], ConformanceIds()))
        XCTAssertTrue(conformanceValuesMatch(["x": .number(0.1 + 0.2)], ["x": 0.3]))
        XCTAssertFalse(conformanceValuesMatch(["x": 1], ["x": 1.001]))
    }
}

/// A document the recording says the editor refused.
private struct RefusedDocument: LocalizedError {
    var errorDescription: String?
}

/// Plays back a scenario's recording: each call returns what the TypeScript core returned, with
/// every `@n` turned into an id of its own (`gen-n`), as a real implementation's ids would be.
private final class PlaybackHost: ConformanceHost {
    private let scenario: ConformanceScenario
    private var step = 0

    init(_ scenario: ConformanceScenario) { self.scenario = scenario }

    func callTool(_ name: String, _ args: JSONObject) async -> McpToolResult {
        let expect = scenario.steps[step].expect
        step += 1
        let result = Self.realIds(expect["result"] ?? .null)
        if expect["isError"] == .bool(true) {
            let message = result.objectValue?["error"]?.objectValue?["message"]?.stringValue ?? ""
            return McpToolResult(content: [.text(message)], structuredContent: result.objectValue, isError: true)
        }
        return McpToolResult(content: [.text(result.stringified())], structuredContent: result.objectValue)
    }

    func document() throws -> JSONValue {
        Self.realIds(scenario.steps[step - 1].expect["document"] ?? .null)
    }

    func pixels(paper: Bool?) throws -> ConformanceImage {
        let file = scenario.steps[step - 1].expect["pixels"]?.objectValue?["file"]?.stringValue ?? ""
        return try decodeConformancePNG(Data(contentsOf: ConformanceContracts.url("domains/paint/fixtures/\(file)")))
    }

    func save() throws -> JSONValue? { ["saved": true] }

    /// What opening reported for the next step (loading comes before its call): its problems, or its error.
    func load(_ document: JSONValue) throws -> [String]? {
        let loaded = Self.realIds(scenario.steps[step].expect["loaded"] ?? .null)
        if let message = loaded.objectValue?["error"]?.stringValue { throw RefusedDocument(errorDescription: message) }
        return (loaded.arrayValue ?? []).compactMap(\.stringValue)
    }

    func isGeneratedId(_ value: String) -> Bool {
        value.range(of: #"^gen-[0-9]+$"#, options: .regularExpression) != nil
    }

    private static func realIds(_ value: JSONValue) -> JSONValue {
        switch value {
        case .string(let s): .string(s.replacingOccurrences(of: #"@([1-9][0-9]*)"#, with: "gen-$1", options: .regularExpression))
        case .array(let a): .array(a.map(realIds))
        case .object(let o): .object(JSONObject(o.map { (realIds(.string($0.key)).stringValue!, realIds($0.value)) }))
        default: value
        }
    }
}
