import Foundation
import PixerateCore
import PixerateRaster

/**
 * Generative prompts in the vector editor (`vector/generate.ts`), on the generation planning in
 * `PixerateCore` (`planGenerationRequest`, `createProvenance`): a prompt is planned against a
 * model's capabilities, sent to the host's generator, and what comes back becomes editable vector
 * art in one group:
 *
 * - SVG markup (from a text model that writes SVG, or an image model with vector output) is read
 *   with the SVG importer;
 * - pixels or a PNG (an image model) are traced (`color` or `threshold`, Image Trace) or stylised
 *   (`mosaic`, `halftone`, `lowPoly`, `hatch`).
 *
 * The art is fitted into a box on the artboard and the group keeps the generation's provenance
 * (`generation`: prompt, model, planned request and adjustments), so it can be regenerated with a
 * new seed or prompt in place, keeping its id. Requests cost money: every call takes an
 * idempotency key, and a retry with the same key and input returns the first result instead of
 * generating again (a failure forgets its key so it can be retried).
 */

/// What a generator returns: SVG markup, RGBA pixels, or a PNG data URL (`VectorGeneratedArt`).
public enum VectorGeneratedArt: Sendable {
    case svg(String)
    case image(VectorTracePixels)
    case png(String)
}

/// What a generator is told besides the request.
public struct VectorArtContext {
    public var model: ModelCapabilities
    public var plan: GenerationPlan
    public var idempotencyKey: String
}

/// The host's generator (`VectorArtGenerator`): sends a planned request to its model and returns the art.
public typealias VectorArtGenerator = (_ request: GenerationRequest, _ context: VectorArtContext) async throws -> VectorGeneratedArt

/// How pixels become vectors: traced in colour or one colour, or stylised (`VECTOR_GENERATED_IMAGE_AS`).
public let VECTOR_GENERATED_IMAGE_AS = ["color", "threshold"] + VECTOR_STYLIZE_STYLES

/// Models that can make vector art: image models (traced or stylised) and text models that write SVG.
public func vectorArtModels(_ models: [ModelCapabilities]) -> [ModelCapabilities] {
    models.filter { $0.media == "image" || $0.media == "text" }
}

/**
 * The generation models and generator the contracts and scenarios use (`FAKE_VECTOR_ART_MODELS`,
 * `fakeVectorArtGenerator` in `vector/contract.ts`): one text model that writes a fixed SVG from
 * the prompt (a circle whose size and colour follow the prompt's length), so generation tools
 * replay the same everywhere without a network.
 */
public let FAKE_VECTOR_ART_MODELS = [ModelCapabilities(JSONObject([("id", "fake-svg"), ("name", "Fake SVG"), ("media", "text"), ("seed", true)]))]

public func fakeVectorArtGenerator(_ request: GenerationRequest, _ context: VectorArtContext) async throws -> VectorGeneratedArt {
    let n = (request["prompt"]?.stringValue ?? "").utf16.count
    let r = 10 + n % 30
    let hue = ["#e11d48", "#2563eb", "#16a34a", "#d97706"][n % 4]
    return .svg("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\"><circle cx=\"50\" cy=\"50\" r=\"\(r)\" fill=\"\(hue)\"/></svg>")
}

/// A generation's input (`VectorGenerateInput`).
public struct VectorGenerateInput {
    public var prompt: String
    /// Model id (default: the first vector-capable model).
    public var model: String?
    public var negativePrompt: String?
    public var seed: Double?
    /// E.g. "1:1" (default: from the box, snapped to what the model offers).
    public var aspectRatio: String?
    /// The box the art is fitted into (document units; default a square in the artboard's middle).
    public var x: Double?
    public var y: Double?
    public var width: Double?
    public var height: Double?
    /// How pixels become vectors (default `color`).
    public var as_: String?
    /// Palette size for traced or stylised colour (default 8).
    public var colors: Double?
    public var name: String?
    /// Required: a retry with the same key and input returns the first result without generating again.
    public var idempotencyKey: String

    public init(prompt: String, model: String? = nil, negativePrompt: String? = nil, seed: Double? = nil, aspectRatio: String? = nil, x: Double? = nil, y: Double? = nil, width: Double? = nil, height: Double? = nil, as_: String? = nil, colors: Double? = nil, name: String? = nil, idempotencyKey: String) {
        self.prompt = prompt
        self.model = model
        self.negativePrompt = negativePrompt
        self.seed = seed
        self.aspectRatio = aspectRatio
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.as_ = as_
        self.colors = colors
        self.name = name
        self.idempotencyKey = idempotencyKey
    }

    /// From tool arguments (`as` is `as_`).
    public init(json o: JSONObject) {
        self.init(prompt: o["prompt"]?.stringValue ?? "", model: o["model"]?.stringValue, negativePrompt: o["negativePrompt"]?.stringValue, seed: o["seed"]?.numberValue, aspectRatio: o["aspectRatio"]?.stringValue,
                  x: o["x"]?.numberValue, y: o["y"]?.numberValue, width: o["width"]?.numberValue, height: o["height"]?.numberValue, as_: o["as"]?.stringValue, colors: o["colors"]?.numberValue, name: o["name"]?.stringValue,
                  idempotencyKey: o["idempotencyKey"]?.stringValue ?? "")
    }

    /// The input as JSON (what an idempotency key is checked against).
    public var json: JSONValue {
        var o = JSONObject([("prompt", .string(prompt))])
        o["model"] = model.map { .string($0) }
        o["negativePrompt"] = negativePrompt.map { .string($0) }
        o["seed"] = seed.map { .number($0) }
        o["aspectRatio"] = aspectRatio.map { .string($0) }
        o["x"] = x.map { .number($0) }
        o["y"] = y.map { .number($0) }
        o["width"] = width.map { .number($0) }
        o["height"] = height.map { .number($0) }
        o["as"] = as_.map { .string($0) }
        o["colors"] = colors.map { .number($0) }
        o["name"] = name.map { .string($0) }
        o["idempotencyKey"] = .string(idempotencyKey)
        return .object(o)
    }
}

/// A regeneration's input: the group, an optional new prompt and seed (default random), and the key.
public struct VectorRegenerateInput {
    public var id: String
    public var prompt: String?
    public var seed: Double?
    public var idempotencyKey: String
    public init(id: String, prompt: String? = nil, seed: Double? = nil, idempotencyKey: String) {
        self.id = id
        self.prompt = prompt
        self.seed = seed
        self.idempotencyKey = idempotencyKey
    }

    public var json: JSONValue {
        var o = JSONObject([("id", .string(id))])
        o["prompt"] = prompt.map { .string($0) }
        o["seed"] = seed.map { .number($0) }
        o["idempotencyKey"] = .string(idempotencyKey)
        return .object(o)
    }
}

/// What a generation did (`VectorGenerateResult`).
public struct VectorGenerateResult: Sendable {
    public var ok: Bool
    public var message: String?
    /// The group holding the art.
    public var id: String?
    /// Its children.
    public var ids: [String]?
    /// What the planner changed to fit the model.
    public var adjustments: [PlanAdjustment]?
    public var model: String?

    static func failure(_ message: String) -> VectorGenerateResult { VectorGenerateResult(ok: false, message: message) }
}

/// The models and generator a vector editor generates with (`VectorGenerationOptions`).
public struct VectorGenerationOptions {
    /// The current models.
    public var models: () -> [ModelCapabilities]
    public var generate: VectorArtGenerator
    public init(models: @escaping () -> [ModelCapabilities], generate: @escaping VectorArtGenerator) {
        self.models = models
        self.generate = generate
    }

    public init(models: [ModelCapabilities], generate: @escaping VectorArtGenerator) {
        self.init(models: { models }, generate: generate)
    }
}

/// Generations by idempotency key on one controller: their input and result (or the calls waiting for it).
final class VectorGenerationRuns {
    final class Run {
        let args: String
        var outcome: Result<VectorGenerateResult, Error>?
        var waiters: [CheckedContinuation<VectorGenerateResult, Error>] = []
        init(args: String) { self.args = args }
    }

    var runs: [String: Run] = [:]
    var order: [String] = []

    /// Runs `fn` once per key and input; a different input under a used key is refused. A failed
    /// result forgets its key so it can be retried; a thrown error stays, as a rejected promise does.
    func once(_ key: String, _ args: JSONValue, _ fn: () async throws -> VectorGenerateResult) async throws -> VectorGenerateResult {
        let sig = stableStringify(args)
        if let hit = runs[key] {
            if hit.args != sig { return .failure("idempotencyKey \"\(key)\" was already used with different input: pass a new key for a new request.") }
            if let outcome = hit.outcome { return try outcome.get() }
            return try await withCheckedThrowingContinuation { hit.waiters.append($0) }
        }
        let run = Run(args: sig)
        runs[key] = run
        order.append(key)
        if order.count > 500 { runs[order.removeFirst()] = nil }
        let outcome: Result<VectorGenerateResult, Error>
        do {
            outcome = .success(try await fn())
        } catch {
            outcome = .failure(error)
        }
        run.outcome = outcome
        if case .success(let r) = outcome, !r.ok, runs[key] === run {
            runs[key] = nil
            order.removeAll { $0 == key }
        }
        for w in run.waiters { w.resume(with: outcome) }
        run.waiters = []
        return try outcome.get()
    }
}

/// An error's message, as TS shows `error.message`.
func describeError(_ error: Error) -> String {
    if let e = error as? LocalizedError, let d = e.errorDescription { return d }
    return String(describing: error)
}

/// The art as nodes in its own units with its natural box, or an error.
private func artNodes(_ art: VectorGeneratedArt, _ as_: String, _ colors: Double) throws -> Result<(nodes: [VectorNode], box: VectorBounds), VectorEditorError> {
    let pixels: VectorTracePixels
    switch art {
    case .svg(let svg):
        let doc: VectorDocument
        do {
            doc = try parseVectorSvg(svg)
        } catch let e as VectorNotPorted {
            throw e
        } catch {
            return .failure(VectorEditorError("The generated SVG could not be read: \(describeError(error))"))
        }
        if doc.nodes.isEmpty { return .failure(VectorEditorError("The generated SVG has no shapes the editor can read.")) }
        let drawn = unionBounds(try doc.nodes.map { try vectorNodeBounds($0) })
        let box = doc.width > 0 && doc.height > 0 ? VectorBounds(x: 0, y: 0, width: doc.width, height: doc.height) : drawn
        guard let box else { return .failure(VectorEditorError("The generated SVG is empty.")) }
        return .success((doc.nodes, box))
    case .image(let p):
        pixels = p
    case .png(let url):
        guard let parsed = parseDataUrl(url), isPng(parsed.bytes) else { return .failure(VectorEditorError("The generated image is not a PNG data URL.")) }
        do {
            let png = try decodePng(parsed.bytes, maxPixels: VECTOR_TRACE_MAX_PIXELS)
            pixels = VectorTracePixels(width: png.width, height: png.height, data: png.data)
        } catch {
            return .failure(VectorEditorError("The generated PNG could not be read: \(describeError(error))"))
        }
    }
    let nodes: [VectorNode]
    do {
        nodes = as_ == "color" || as_ == "threshold" ? try traceVectorImage(pixels, VectorTraceOptions(mode: as_, colors: colors)) : try stylizeVectorImage(pixels, as_, VectorStylizeOptions(colors: colors))
    } catch let e as VectorNotPorted {
        throw e
    } catch {
        return .failure(VectorEditorError(describeError(error)))
    }
    if nodes.isEmpty { return .failure(VectorEditorError("The generated image had nothing to trace (try another `as`).")) }
    return .success((nodes, VectorBounds(x: 0, y: 0, width: Double(pixels.width), height: Double(pixels.height))))
}

/// `x || 1`.
private func orOne(_ x: Double) -> Double { x == 0 || x.isNaN ? 1 : x }

/// `nodes` in a box of their own units scaled to fit `target`, centred.
private func fitted(_ nodes: [VectorNode], _ box: VectorBounds, _ target: VectorBounds) throws -> [VectorNode] {
    let k = Swift.min(target.width / orOne(box.width), target.height / orOne(box.height))
    let dx = target.x + (target.width - box.width * k) / 2 - box.x * k
    let dy = target.y + (target.height - box.height * k) / 2 - box.y * k
    return try nodes.map { try transformVectorNode($0, VectorMatrix(k, 0, 0, k, dx, dy)) }
}

/// "w:h" reduced, for a box.
private func ratioOf(_ w: Double, _ h: Double) -> String {
    func g(_ a: Double, _ b: Double) -> Double { b < 1 ? a : g(b, a.truncatingRemainder(dividingBy: b)) }
    let a = Swift.max(1, (w + 0.5).rounded(.down)), b = Swift.max(1, (h + 0.5).rounded(.down))
    let d = g(a, b)
    return "\(JSONValue.jsNumber(a / d)):\(JSONValue.jsNumber(b / d))"
}

/// Plans and sends one request; the art as fitted nodes, or an error.
private func produce(_ request: GenerationRequest, _ model: ModelCapabilities, _ target: VectorBounds, _ as_: String, _ colors: Double, _ options: VectorGenerationOptions, _ idempotencyKey: String) async throws -> Result<(nodes: [VectorNode], plan: GenerationPlan), VectorEditorError> {
    let plan = planGenerationRequest(request, model, PlanOptions(strategy: "nearest"))
    if !plan.ok { return .failure(VectorEditorError("The request cannot be sent to \"\(model.id)\": \(plan.errors.map { "\($0.field): \($0.message)" }.joined(separator: "; "))")) }
    let art: VectorGeneratedArt
    do {
        art = try await options.generate(plan.request, VectorArtContext(model: model, plan: plan, idempotencyKey: idempotencyKey))
    } catch {
        return .failure(VectorEditorError("The generator failed: \(describeError(error))"))
    }
    switch try artNodes(art, as_, colors) {
    case .failure(let e): return .failure(e)
    case .success(let made): return .success((try fitted(made.nodes, made.box, target), plan))
    }
}

extension VectorEditorController {
    /**
     * Swaps a generated group's art (given in document space) and provenance, keeping its id, place
     * and transform; the new children get fresh ids. One undo step (`replaceGeneratedArt`).
     */
    @discardableResult
    public func replaceGeneratedArt(_ id: String, _ children: [VectorNode], _ generation: JSONObject) throws -> VectorActionResult {
        guard let node = getNode(id), node.isGroup, truthy(node["generation"]) else { return VectorActionResult(ok: false, message: "\"\(id)\" is not generated art.") }
        if truthy(node["locked"]) { return VectorActionResult(ok: false, message: "\"\(id)\" is locked; unlock it first.") }
        // The art comes in document space: bring it into the group's own space.
        let inv = invertMatrix(worldOf(id))
        let placed = try children.map { try freshIds(isIdentityMatrix(inv) ? $0 : transformVectorNode($0, inv)) }
        try change("Regenerate Art") {
            var next = node
            next["generation"] = .object(generation)
            next.children = placed
            try replaceNode(id, next)
            anchors = []
        }
        return .success
    }
}

/**
 * Generates vector art from a prompt and adds it as one group (one undo step), fitted into the
 * box (default a square in the artboard's middle), holding the generation's provenance
 * (`generateVectorArt`).
 */
public func generateVectorArt(_ controller: VectorEditorController, _ input: VectorGenerateInput, _ options: VectorGenerationOptions) async throws -> VectorGenerateResult {
    try await controller.generationRuns.once(input.idempotencyKey, input.json) {
        if input.prompt.jsTrimmed.isEmpty { return .failure("prompt must be some text describing the art.") }
        if input.idempotencyKey.isEmpty { return .failure("idempotencyKey is required (any unique string per request).") }
        let models = vectorArtModels(options.models())
        if models.isEmpty { return .failure("No model can make vector art (an image model, or a text model that writes SVG).") }
        let wanted = input.model.flatMap { $0.isEmpty ? nil : $0 }
        let chosen: ModelCapabilities? = wanted != nil ? models.first { $0.id == wanted } : models.first
        guard let model = chosen else {
            return .failure("Unknown model \"\(input.model ?? "")\": use one of \(models.map(\.id).joined(separator: ", ")).")
        }
        let as_ = input.as_ ?? "color"
        if !VECTOR_GENERATED_IMAGE_AS.contains(as_) { return .failure("as must be one of \(VECTOR_GENERATED_IMAGE_AS.joined(separator: ", ")).") }
        let doc = controller.document
        let side = Swift.min(doc.width, doc.height) * 0.6
        let width = input.width ?? side
        let target = VectorBounds(x: input.x ?? (doc.width - width) / 2, y: input.y ?? (doc.height - (input.height ?? side)) / 2, width: width, height: input.height ?? input.width ?? side)
        if !(target.width > 0 && target.height > 0) { return .failure("width and height must be above 0.") }
        var request = GenerationRequest([("prompt", .string(input.prompt)), ("mode", "generate"), ("aspectRatio", .string(input.aspectRatio ?? ratioOf(target.width, target.height)))])
        if let n = input.negativePrompt, !n.isEmpty { request["negativePrompt"] = .string(n) }
        if let s = input.seed { request["seed"] = .number(s) }
        let colors = input.colors ?? 8
        switch try await produce(request, model, target, as_, colors, options, input.idempotencyKey) {
        case .failure(let e): return .failure(e.message)
        case .success(let made):
            let meta = JSONObject([("as", .string(as_)), ("colors", .number(colors)), ("box", target.json)])
            let provenance = createProvenance(CreateProvenanceOptions(rawPrompt: input.prompt, model: model.id, plan: made.plan, meta: meta))
            let name = input.name ?? String(decoding: Array(input.prompt.utf16.prefix(40)), as: UTF16.self)
            let props = JSONObject([("id", "generated"), ("type", "group"), ("name", .string(name)), ("generation", .object(provenance)), ("children", .null)])
            let id = try controller.addNode(VectorNode(props: props, children: made.nodes), AddVectorNodeOptions(label: "Generate Art"))
            let added = controller.getNode(id)!
            return VectorGenerateResult(ok: true, id: id, ids: added.children.map(\.id), adjustments: made.plan.adjustments, model: model.id)
        }
    }
}

/**
 * Generates a group's art again from its provenance, with a new `seed` (default a random one) and
 * optionally a new `prompt`, replacing its children in place (one undo step; `regenerateVectorArt`).
 */
public func regenerateVectorArt(_ controller: VectorEditorController, _ input: VectorRegenerateInput, _ options: VectorGenerationOptions) async throws -> VectorGenerateResult {
    try await controller.generationRuns.once(input.idempotencyKey, input.json) {
        let node = controller.getNode(input.id)
        guard let node, node.isGroup, let prov = node["generation"]?.objectValue else { return .failure("\"\(input.id)\" is not generated art (generate some with generate_vector_art).") }
        if truthy(node["locked"]) { return .failure("\"\(input.id)\" is locked; unlock it first.") }
        let models = vectorArtModels(options.models())
        let modelId = prov["modelId"]?.stringValue
        guard let model = models.first(where: { $0.id == modelId }) else { return .failure("The model \"\(modelId ?? "undefined")\" it was made with is not available.") }
        var meta = prov["meta"]?.objectValue ?? JSONObject()
        let metaBox = meta["box"].flatMap { b -> VectorBounds? in
            guard let x = b["x"]?.numberValue, let y = b["y"]?.numberValue, let w = b["width"]?.numberValue, let h = b["height"]?.numberValue else { return nil }
            return VectorBounds(x: x, y: y, width: w, height: h)
        }
        let box = try vectorNodeBounds(node) ?? metaBox ?? VectorBounds(x: 0, y: 0, width: 100, height: 100)
        let prompt = input.prompt ?? prov["rawPrompt"]?.stringValue ?? ""
        var request = prov["request"]?.objectValue ?? GenerationRequest()
        request["prompt"] = .string(prompt)
        request["seed"] = .number(input.seed ?? Double(Int.random(in: 0 ..< (1 << 31))))
        switch try await produce(request, model, box, meta["as"]?.stringValue ?? "color", meta["colors"]?.numberValue ?? 8, options, input.idempotencyKey) {
        case .failure(let e): return .failure(e.message)
        case .success(let made):
            meta["box"] = box.json
            let provenance = createProvenance(CreateProvenanceOptions(rawPrompt: prompt, model: model.id, plan: made.plan, meta: meta))
            let r = try controller.replaceGeneratedArt(input.id, made.nodes, provenance)
            if !r.ok { return .failure(r.message ?? "") }
            let now = controller.getNode(input.id)!
            return VectorGenerateResult(ok: true, id: input.id, ids: now.children.map(\.id), adjustments: made.plan.adjustments, model: model.id)
        }
    }
}

/// Options for `createVectorGenerationToolProvider`.
public struct VectorGenerationToolProviderOptions {
    public var generation: VectorGenerationOptions
    /// Provider id (default `vector-generation`).
    public var namespace: String?
    /// Why the document cannot be edited now (the write tools are hidden), or nil.
    public var readOnly: (() -> String?)?
    public init(_ generation: VectorGenerationOptions, namespace: String? = nil, readOnly: (() -> String?)? = nil) {
        self.generation = generation
        self.namespace = namespace
        self.readOnly = readOnly
    }
}

/**
 * Agent tools for generative prompts in the vector editor (`createVectorGenerationToolProvider`):
 * `list_vector_art_models` (read-only), `generate_vector_art` and `regenerate_vector_art` (both
 * cost money: an idempotency key is required; hidden while the document is read-only).
 * Definitions come from the vector contracts (provider `vector-generation`).
 */
public func createVectorGenerationToolProvider(_ controller: VectorEditorController, _ options: VectorGenerationToolProviderOptions) throws -> AgentToolProvider {
    func output(_ r: VectorGenerateResult) -> ToolOutput {
        if !r.ok { return .result(McpToolResult(content: [.text(r.message ?? "Generation failed.")], isError: true)) }
        var o = JSONObject()
        o["id"] = r.id.map { .string($0) }
        o["ids"] = r.ids.map { .array($0.map { .string($0) }) }
        o["model"] = r.model.map { .string($0) }
        o["adjustments"] = r.adjustments.map { .array($0.map(\.json)) }
        return .value(.object(o))
    }
    var h: [String: VectorToolHandler] = [:]
    h["list_vector_art_models"] = { _ in
        .value(["models": .array(vectorArtModels(options.generation.models()).map { m in
            var o = JSONObject([("id", .string(m.id)), ("name", .string(m.name ?? m.id)), ("media", .string(m.media))])
            if let a = m["aspectRatios"], a != .null { o["aspectRatios"] = a }
            o["seed"] = .bool(truthy(m["seed"]))
            return .object(o)
        })])
    }
    h["generate_vector_art"] = { a in output(try await generateVectorArt(controller, VectorGenerateInput(json: a), options.generation)) }
    h["regenerate_vector_art"] = { a in
        output(try await regenerateVectorArt(controller, VectorRegenerateInput(id: a["id"]?.stringValue ?? "", prompt: a["prompt"]?.stringValue, seed: a["seed"]?.numberValue, idempotencyKey: a["idempotencyKey"]?.stringValue ?? ""), options.generation))
    }
    return try vectorContractProvider("vector-generation", namespace: options.namespace, description: "Generate vector art from a prompt with a configured model, and regenerate it.", h, readOnly: options.readOnly, subscribe: options.readOnly == nil ? nil : { notify in controller.subscribe(notify) })
}
