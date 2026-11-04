import Foundation
import PixerateConformance
import PixerateCore

/**
 * A fresh paint editor for replaying a conformance scenario (`domains/paint/fixtures`), as
 * `createPaintConformanceHost` in `paint-editor/contract.ts`: every paint tool provider this port
 * has in one registry that validates arguments, the saved document (the `pixerate.editor-document`
 * envelope) and the composited pixels. Wet paint runs with the GPU engine off, as in the TS host. `setup` is the scenario's editor options (`width`,
 * `height`, `dpi`, `paper`, `brushId`, `color`). Provider effects come from `FakeEffectProvider`,
 * as the TS host uses the fake provider.
 */
public final class PaintConformanceHost: ConformanceHost {
    public let controller: PaintEditorController
    private let registry = ToolRegistry(validateArguments: true)

    public init(setup: JSONObject) throws {
        let paper = setup["paper"]
        controller = try PaintEditorController(
            width: setup["width"]?.numberValue, height: setup["height"]?.numberValue, dpi: setup["dpi"]?.numberValue,
            paper: paper?.objectValue, paperPreset: paper?.stringValue, brushId: setup["brushId"]?.stringValue,
            color: setup["color"]?.stringValue, hand: setup["hand"]?.stringValue,
            // The TypeScript wet kernel with the GPU off is the reference, as the TS host forces it.
            wet: PaintWetOptions(gpu: "off")
        )
        controller.setEffectsProvider(FakeEffectProvider())
        _ = try registry.register(createPaintEditorToolProvider(controller))
        _ = try registry.register(createPaintEffectsToolProvider(controller))
        _ = try registry.register(createPaintBrushLibraryToolProvider(controller))
        _ = try registry.register(createPaintProposalToolProvider(PaintProposals(controller: controller)))
    }

    public func callTool(_ name: String, _ args: JSONObject) async -> McpToolResult {
        await registry.callTool(name, args)
    }

    public func document() throws -> JSONValue { controller.editorDocument() }

    public func pixels(paper: Bool?) throws -> ConformanceImage {
        let p = controller.compositePixels(paper: paper)
        return ConformanceImage(width: p.width, height: p.height, data: p.data)
    }

    /// Layers `pl` and nine or more base-36 digits; layer styles `fx_…_…` (the TS core's format).
    public func isGeneratedId(_ value: String) -> Bool { isGeneratedPaintId(value) }
}
