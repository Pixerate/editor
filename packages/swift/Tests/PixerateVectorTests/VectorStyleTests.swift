import Foundation
import PixerateConformance
import PixerateCore
import XCTest
@testable import PixerateVector

/// The vector house-style tools (#791) beyond what the scenarios record: `fix_vector_style` is one
/// undo step that keeps the selection, and a read-only drawing lists only the check.
final class VectorStyleTests: XCTestCase {
    private let setup: JSONObject = [
        "width": 300,
        "height": 200,
        "style": ["strokeWidths": [1, 2, 4], "cornerRadii": [4, 8], "checks": ["stroke-widths", "corner-radii"]],
    ]

    func testFixIsOneUndoStepAndKeepsTheSelection() async throws {
        let host = try VectorConformanceHost(setup: setup)
        _ = await host.callTool("run_command", ["id": "vector.addShape", "params": ["kind": "rect", "x": 10, "y": 10, "width": 60, "height": 40, "cornerRadius": 6, "stroke": "#111111", "strokeWidth": 3]])
        _ = await host.callTool("run_command", ["id": "vector.addPath", "params": ["d": "M100 20 L160 60", "stroke": "#111111", "strokeWidth": 5]])
        host.controller.select(["n2"])
        let before = host.controller.document
        let undoDepth = host.controller.history.state.undoCount
        let fixed = await host.callTool("fix_vector_style", [:])
        XCTAssertNotEqual(fixed.isError, true)
        XCTAssertEqual(fixed.structuredContent?["strokeWidths"], ["n1": 2, "n2": 4])
        XCTAssertEqual(host.controller.history.state.undoCount, undoDepth + 1)
        XCTAssertEqual(host.controller.history.state.undoName, "Apply House Style")
        XCTAssertEqual(host.controller.selectedIds, ["n2"])
        XCTAssertEqual(host.controller.document.nodes[0].strokeWidth, 2)
        XCTAssertEqual(host.controller.document.nodes[0].subpaths[0].anchors[0].corner?.radius, 4)
        XCTAssertTrue(host.controller.undo())
        XCTAssertEqual(host.controller.document, before)
        XCTAssertEqual(host.controller.selectedIds, ["n2"])
    }

    func testReadOnlyListsOnlyTheCheck() async throws {
        let controller = try VectorEditorController()
        let style = vectorHouseStyle(profileJson: ["strokeWidths": [2], "checks": ["stroke-widths"]], brandJson: nil)
        var readOnly: String? = "Locked for review."
        let provider = try createVectorStyleToolProvider(controller, style, VectorStyleToolProviderOptions(readOnly: { readOnly }))
        XCTAssertEqual(provider.tools.map(\.definition.name), ["check_vector_style"])
        readOnly = nil
        XCTAssertEqual(provider.tools.map(\.definition.name), ["check_vector_style", "fix_vector_style"])
    }

    func testThemeFromBrandGivesPaletteAndFonts() {
        let derived = vectorStyleFromBrand(["colors": ["primary": "#0b5fff", "accent": "#ff6a00"], "fonts": ["heading": "Inter", "body": "Inter", "mono": "Menlo"]])
        XCTAssertEqual(JSONValue.object(derived), ["palette": ["#0b5fff", "#ff6a00"], "fonts": ["Inter", "Menlo"]])
        XCTAssertTrue(vectorStyleFromBrand([:]).isEmpty)
    }
}
