import Foundation
import PixerateContracts
import PixerateCore
import XCTest
@testable import PixeratePaint

/// The brush model against the brushes contracts: every preset resolves to the engine brush the
/// TypeScript core resolves it to, and migrates back to itself.
final class BrushModelTests: XCTestCase {
    func testEveryPresetResolvesAsInTheContracts() throws {
        let resolved = try XCTUnwrap(JSONValue.parse(ConformanceContracts.data("domains/brushes/resolved.json")).arrayValue)
        XCTAssertEqual(resolved.count, BRUSH_PRESETS.count)
        for (spec, expected) in zip(BRUSH_PRESETS, resolved) {
            let id = spec["id"]?.stringValue ?? ""
            let brush = resolveBrush(spec)
            XCTAssertEqual(brush.engine, expected["engine"]?.stringValue, id)
            XCTAssertEqual(brush.category, expected["category"]?.stringValue, id)
            XCTAssertEqual(JSONValue.object(brush.json()), expected["brush"], id)
        }
    }

    func testEveryPresetNormalizesAndMigratesToItself() throws {
        for spec in BRUSH_PRESETS {
            let id = spec["id"]?.stringValue ?? ""
            var problems: [String] = []
            let normalized = try normalizeBrushSpec(.object(spec), &problems)
            XCTAssertEqual(problems, [], id)
            XCTAssertEqual(JSONValue.object(normalized), .object(spec), id)
            let migrated = migrateBrushV1(resolveBrush(spec))
            XCTAssertEqual(JSONValue.object(resolveBrush(migrated).json()), .object(resolveBrush(spec).json()), id)
        }
    }

    func testIridescenceIsDroppedFromAntimatterAndObjectMarks() throws {
        let film: JSONValue = .object(["thickness": .number(480), "ior": .number(1.65)])
        for (kind, why) in [("antimatter", "antimatter marks detonate paint, not film"), ("objects", "object marks are stickers, not film")] {
            var problems: [String] = []
            let brush = try normalizeBrushSpec(.object([
                "id": .string("film-\(kind)"), "name": .string("Film"), "kind": .string("mark"),
                "tip": .object(["shape": .string("round"), "size": .number(20)]),
                "marks": .object(["kind": .string(kind)]),
                "iridescence": film,
            ]), &problems)
            XCTAssertNil(brush["iridescence"], kind)
            XCTAssertTrue(problems.contains("iridescence dropped: \(why)."), "\(kind): \(problems)")
        }
        var problems: [String] = []
        let lacquer = try normalizeBrushSpec(.object([
            "id": .string("film-continuous"), "name": .string("Film"), "kind": .string("mark"),
            "tip": .object(["shape": .string("round"), "size": .number(20)]),
            "iridescence": film,
        ]), &problems)
        XCTAssertNotNil(lacquer["iridescence"])
    }

    func testMigrationsMatchTheContracts() throws {
        let list = try XCTUnwrap(JSONValue.parse(ConformanceContracts.data("domains/brushes/migrations.json")).arrayValue)
        for item in list {
            guard let v1 = item["input"]?.objectValue else { continue }
            let expected = item["output"]
            XCTAssertEqual(JSONValue.object(migrateBrushV1(normalizePaintBrush(v1))), expected, v1["id"]?.stringValue ?? "")
        }
    }
}
