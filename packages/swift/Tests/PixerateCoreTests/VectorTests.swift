import Foundation
import XCTest
@testable import PixerateCore

/// The TS core's own outputs (`packages/core/tests/swift-vectors.test.ts` writes and checks
/// `Fixtures/core-vectors.json`): the Swift core must match them exactly.
final class VectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "core-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    private func rows(_ key: String) -> [[JSONValue]] { Self.vectors[key]!.arrayValue!.map { $0.arrayValue! } }
    private func int(_ v: JSONValue) -> Int { Int(v.numberValue!) }

    func testMix32BitExact() {
        for r in rows("mix") { XCTAssertEqual(PixerateRandom.mix32(UInt32(int(r[0]))), UInt32(int(r[1])), "mix32(\(r[0]))") }
    }

    func testHash2AndRand01BitExact() {
        for r in rows("hash") { XCTAssertEqual(PixerateRandom.hash2(int(r[0]), int(r[1]), int(r[2])), r[3].numberValue!, "hash2\(r)") }
        for r in rows("rand") {
            XCTAssertEqual(PixerateRandom.rand01(int(r[0]), int(r[1]), int(r[2])), r[3].numberValue!)
            XCTAssertEqual(PixerateRandom.randSigned(int(r[0]), int(r[1]), int(r[2])), r[4].numberValue!)
        }
    }

    func testSeedFromStringOverUTF16() {
        for r in rows("seeds") { XCTAssertEqual(PixerateRandom.seedFromString(r[0].stringValue!), UInt32(int(r[1])), r[0].stringValue!) }
    }

    func testTileableNoiseMatches() {
        let n = Self.vectors["noise"]!
        let noise = TileableNoise(size: n["size"]!.numberValue!, cellsX: n["cellsX"]!.numberValue!, cellsY: n["cellsY"]!.numberValue!, octaves: int(n["octaves"]!), salt: int(n["salt"]!))
        for s in n["samples"]!.arrayValue!.map({ $0.arrayValue! }) {
            XCTAssertEqual(noise.at(s[0].numberValue!, s[1].numberValue!), s[2].numberValue!, "noise at \(s[0]), \(s[1])")
        }
    }

    func testNumbersPrintAsJavaScriptDoes() {
        for r in rows("numbers") { XCTAssertEqual(JSONValue.number(r[0].numberValue!).stringified(), r[1].stringValue!) }
    }

    func testStringifyMatchesJSONStringify() {
        for c in Self.vectors["stringify"]!.arrayValue! {
            XCTAssertEqual(c["value"]!.stringified(), c["text"]!.stringValue!)
            XCTAssertEqual(c["value"]!.stringified(space: 2), c["pretty"]!.stringValue!)
            // Parsing the text gives the value back.
            XCTAssertEqual(try JSONValue.parse(c["text"]!.stringValue!), c["value"]!)
        }
    }

    func testSchemaValidationMatchesTS() {
        for c in Self.vectors["schema"]!.arrayValue! {
            let got = validateJSONSchema(c["value"]!, c["schema"]!).map(\.json)
            XCTAssertEqual(JSONValue.array(got), c["errors"]!, c["name"]!.stringValue!)
        }
    }

    func testMigrationsMatchTS() {
        let steps: [Int: MigrationStep] = [
            0: { _ in throw InvalidSectionValue("boom") },
            1: { var d = $0; d["v2"] = true; return d },
            2: { var d = $0; d["v3"] = true; return d },
        ]
        for c in Self.vectors["migrations"]!.arrayValue! {
            let (doc, report) = migrateDocument(.value(c["input"]!), MigrateOptions(currentVersion: 3, steps: steps))
            let name = c["name"]!.stringValue!
            XCTAssertEqual(JSONValue.object(doc), c["doc"]!, name)
            let r = c["report"]!
            XCTAssertEqual(report.migratedFrom.map(Double.init), r["migratedFrom"]!.numberValue, name)
            XCTAssertEqual(report.version.map(Double.init), r["version"]!.numberValue, name)
            XCTAssertEqual(report.readOnly?.kind, r["readOnly"]!["kind"]?.stringValue, name)
            XCTAssertEqual(report.readOnly?.message, r["readOnly"]!["message"]?.stringValue, name)
        }
    }
}
