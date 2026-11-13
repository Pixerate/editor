import Foundation
import PixerateConformance
import PixerateCore

/**
 * A fresh paint editor for replaying a conformance scenario (`domains/paint/fixtures`), as
 * `createPaintConformanceHost` in `paint-editor/contract.ts`: every paint tool provider this port
 * has in one registry that validates arguments, the saved document (the `pixerate.editor-document`
 * envelope) and the composited pixels. Wet paint runs with the GPU engine off, as in the TS host. `setup` is the scenario's editor options (`width`,
 * `height`, `dpi`, `paper`, `brushId`, `color`, `authoredEffects`, `rawShaders`, `authoredEffectLimits`), and the house style
 * (`style`, `brushStyle`, `brand` and `readOnly`, as `PaintStyleSetup`). Provider effects come from `FakeEffectProvider` (with paint hints for `effectPaintHints: true`),
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
            wet: PaintWetOptions(gpu: "off"),
            authoredEffects: try setup["authoredEffects"]?.stringValue.map(AuthoredEffectsPolicy.parse) ?? .replay,
            rawShaders: setup["rawShaders"]?.boolValue ?? false,
            authoredEffectLimits: Self.limits(setup["authoredEffectLimits"]?.objectValue)
        )
        // Authored effects render on the CPU, as the TS evaluator does.
        controller.authoredEffectsGPU = false
        controller.setEffectsProvider(FakeEffectProvider(paintHints: setup["effectPaintHints"]?.boolValue ?? false))
        if setup["stickers"] == "fake", let p = try? combineStickerProviders([editorStickers(), createFakeStickerProvider()]) {
            controller.setStickersProvider(p)
        }
        _ = try registry.register(createPaintEditorToolProvider(controller))
        _ = try registry.register(createPaintEffectsToolProvider(controller))
        _ = try registry.register(createPaintEffectAuthoringToolProvider(controller))
        _ = try registry.register(createPaintBrushLibraryToolProvider(controller))
        _ = try registry.register(createPaintProposalToolProvider(PaintProposals(controller: controller)))

        // `setup.style || setup.brushStyle || setup.brand ? { 'house/SKILL.md', 'house/paint-editor.json'?,
        // 'house/brushes.json'?, 'house/brand.json'? } : {}` in one `org` layer: a truthy value is a
        // file of the skill, and each is validated as `createStyleResolver` does.
        func truthy(_ value: JSONValue?) -> JSONValue? {
            switch value {
            case nil, .null?, .bool(false)?, .string("")?: return nil
            case .number(let n)? where n == 0 || n.isNaN: return nil
            case let raw?: return raw
            }
        }
        let style = truthy(setup["style"]), brushStyle = truthy(setup["brushStyle"]), brand = truthy(setup["brand"])
        let styles = style == nil && brushStyle == nil && brand == nil
            ? PaintHouseStyles()
            : PaintHouseStyles(skill: "house", layer: "org", style: style, brushStyle: brushStyle, brand: brand)
        // `readOnly`: true, or the reason as a string, hides fix_paint_style.
        let readOnly: String?
        switch truthy(setup["readOnly"]) {
        case .string(let reason)?: readOnly = reason
        case nil: readOnly = nil
        default: readOnly = "This painting is read-only."
        }
        _ = try registry.register(createPaintStyleToolProvider(controller, styles.paint, readOnly: { readOnly }))
        _ = try registry.register(createBrushStyleToolProvider(controller.brushLibrary, styles.brushes))
    }

    private static func limits(_ o: JSONObject?) -> AuthoredEffectLimits {
        guard let o else { return AuthoredEffectLimits() }
        return AuthoredEffectLimits(maxSourceLength: o["maxSourceLength"]?.numberValue.map { Int($0) }, maxCost: o["maxCost"]?.numberValue.map { Int($0) }, trialSize: o["trialSize"]?.numberValue.map { Int($0) }, trialRenderMs: o["trialRenderMs"]?.numberValue, liveFrameMs: o["liveFrameMs"]?.numberValue)
    }

    public func callTool(_ name: String, _ args: JSONObject) async -> McpToolResult {
        await registry.callTool(name, args)
    }

    public func document() throws -> JSONValue { controller.editorDocument() }

    public func save() throws -> JSONValue? { .object(controller.toJSON()) }

    public func load(_ document: JSONValue) throws -> [String]? { try controller.loadJSON(document) }

    public func pixels(paper: Bool?) throws -> ConformanceImage {
        let p = controller.compositePixels(paper: paper)
        return ConformanceImage(width: p.width, height: p.height, data: p.data)
    }

    /// Layers `pl` and nine or more base-36 digits; layer styles `fx_…_…` (the TS core's format).
    public func isGeneratedId(_ value: String) -> Bool { isGeneratedPaintId(value) }
}
