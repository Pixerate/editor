import Foundation
import PixerateContracts
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixerateVector

/// The geometry the first vector scenarios check (`shapes-and-paths`, `arrange-and-transform`),
/// computed from their recorded documents: what `vector.list` and `vector.exportSvg` will return
/// once the controller and commands are ported.
final class VectorScenarioGeometryTests: XCTestCase {
    private func scenario(_ name: String) throws -> JSONValue {
        try JSONValue.parse(Data(contentsOf: ConformanceContracts.url("domains/vector/fixtures/\(name).json")))
    }

    private func r2(_ v: Double) -> Double { JS.round(v * 100) / 100 }

    /// `vector.list` after the last step of arrange-and-transform: bounds, rotation and `d` of every node.
    func testArrangeAndTransformListing() throws {
        let step = try scenario("arrange-and-transform")["steps"]!.arrayValue!.last!
        let doc = try VectorDocument(json: step["expect"]!["document"]!["document"]!)
        let listed = step["expect"]!["result"]!["result"]!["nodes"]!.arrayValue!
        XCTAssertFalse(listed.isEmpty)
        for entry in listed {
            let id = entry["id"]!.stringValue!
            let node = try XCTUnwrap(findVectorNode(doc.nodes, id))
            let parent = vectorParentMatrix(doc.nodes, id) ?? IDENTITY_MATRIX
            let b = try XCTUnwrap(try vectorNodeBounds(node, parent))
            let want = entry["bounds"]!
            XCTAssertEqual([r2(b.x), r2(b.y), r2(b.width), r2(b.height)], ["x", "y", "width", "height"].map { want[$0]!.numberValue! }, id)
            XCTAssertEqual(r2(vectorNodeRotation(node, parent)), entry["rotation"]!.numberValue!, id)
            if node.isPath { XCTAssertEqual(vectorPathData(node, precision: 2), entry["d"]!.stringValue!, id) }
        }
    }

    /// `vector.exportSvg` at precision 2 after the last step of shapes-and-paths: each path's `d`
    /// (live corners cut on the rounded rectangle).
    func testShapesAndPathsExportedPathData() throws {
        let step = try scenario("shapes-and-paths")["steps"]!.arrayValue!.last!
        let doc = try VectorDocument(json: step["expect"]!["document"]!["document"]!)
        let svg = step["expect"]!["result"]!["result"]!["svg"]!.stringValue!
        let regex = try NSRegularExpression(pattern: #"<path id="([^"]+)" d="([^"]+)""#)
        let matches = regex.matches(in: svg, range: NSRange(svg.startIndex..., in: svg))
        XCTAssertEqual(matches.count, doc.nodes.count)
        for m in matches {
            let id = String(svg[Range(m.range(at: 1), in: svg)!])
            let d = String(svg[Range(m.range(at: 2), in: svg)!])
            let node = try XCTUnwrap(findVectorNode(doc.nodes, id))
            XCTAssertEqual(vectorPathData(node, precision: 2), d, id)
        }
    }
}
