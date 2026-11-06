import Foundation
import PixerateConformance
import PixerateCore
import PixeratePaint

/**
 * A fresh vector editor for replaying a conformance scenario (`domains/vector/fixtures`), as
 * `createVectorConformanceHost` in `vector/contract.ts`: the commands (`createVectorCommands`) in
 * a registry on the controller's history, exposed through `createCommandToolProvider` with bare
 * tool names (`list_commands`, `run_command`, `run_commands`) in a registry that validates
 * arguments, the saved document (the `pixerate.editor-document` envelope) and the scene render
 * data (`getVectorSceneRenderData` with its defaults). Node ids come from a counter (`n1`, `n2`,
 * …), so they are part of the contract and are not normalised. Text uses the metric shaper (set
 * for the process, `setVectorTextShaper`), the one every implementation can match. `setup` is the scenario's artboard
 * size (`{ width, height }`, default the editor's).
 *
 * Beside the commands the registry holds the effect tools (`vector-effects`, on the fake effect
 * provider `FakeEffectProvider`) and the generation tools (`vector-generation`, on
 * `FAKE_VECTOR_ART_MODELS` and `fakeVectorArtGenerator`), as `vectorProviders` registers them.
 * Provenance `createdAt` times are normalised by the runner.
 */
public final class VectorConformanceHost: ConformanceHost {
    public let controller: VectorEditorController
    public let commands: CommandRegistry<VectorEditorController>
    private let registry = ToolRegistry(validateArguments: true)

    public init(setup: JSONObject) throws {
        // Text lays out with the metric shaper, the one every implementation can match.
        setVectorTextShaper(MetricTextShaper())
        var next = 0
        let width = setup["width"]?.numberValue
        let height = setup["height"]?.numberValue
        let sized = width.map { $0 != 0 } == true || height.map { $0 != 0 } == true ? VectorDocument(width: width ?? 800, height: height ?? 600) : nil
        controller = try VectorEditorController(document: sized, createId: {
            next += 1
            return "n\(next)"
        })
        controller.setEffectsProvider(FakeEffectProvider())
        commands = CommandRegistry(context: controller, history: controller.history)
        try commands.register(createVectorCommands(controller))
        _ = try registry.register(createCommandToolProvider(commands, CommandToolProviderOptions(id: "vector-commands", namespace: "")))
        _ = try registry.register(createVectorEffectsToolProvider(controller))
        _ = try registry.register(createVectorGenerationToolProvider(controller, VectorGenerationToolProviderOptions(VectorGenerationOptions(models: FAKE_VECTOR_ART_MODELS, generate: fakeVectorArtGenerator))))
    }

    public func callTool(_ name: String, _ args: JSONObject) async -> McpToolResult {
        await registry.callTool(name, args)
    }

    public func document() throws -> JSONValue { try controller.editorDocument() }

    public func pixels(paper: Bool?) throws -> ConformanceImage {
        throw ContractError("The vector editor has no pixels; compare its document, results, render data and SVG export.")
    }

    /// What the canvases draw: the scene render data with the default options.
    public func render() throws -> JSONValue? { try controller.sceneRenderData() }

    /// Ids come from the counter and are compared as they are.
    public func isGeneratedId(_ value: String) -> Bool { false }
}
