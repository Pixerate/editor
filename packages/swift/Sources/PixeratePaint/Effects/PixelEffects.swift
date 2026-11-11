import Foundation
import PixerateCore

/**
 * Pixel expression effects (`effects/pixel-provider.ts`): the starting points (`PIXEL_TEMPLATES`),
 * the description of a compiled program, a CPU renderer and the catalog provider
 * (`PixelEffectProvider`). Authoring sessions build on `pixelTemplate(_:)`, `describePixelSource`
 * and the provider's `limits`.
 */

public let PIXEL_PROVIDER_ID = "pixel"

/// A starting point: its id, name, what it is, and its source.
public struct PixelTemplate: Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let loop: Bool
    public let duration: Double?
    public let source: String

    /// As description metadata.
    public var meta: PixelEffectMeta { PixelEffectMeta(id: id, name: name, description: description, loop: loop, duration: duration) }
}

/// The starting points, as in the TS core.
public let PIXEL_TEMPLATES: [PixelTemplate] = [
    PixelTemplate(
        id: "pixel.blank",
        name: "Blank",
        description: "A starting point: a soft gradient between two colours, top to bottom.",
        loop: false,
        duration: nil,
        source: ["control top: color = #1d2b53 // Colour at the top.", "control bottom: color = #ff77a8 // Colour at the bottom.", "out = mix(top, bottom, uv.y)", ""].joined(separator: "\n")
    ),
    PixelTemplate(
        id: "pixel.rings",
        name: "Rings",
        description: "Rings that spread from a point, over a transparent background.",
        loop: true,
        duration: 2000,
        source: [
            "control ink: color = #1d2b53 // Colour of the rings.",
            "control count: number = 12 range 1 64 // How many rings across the picture.",
            "control center: vec2 = vec2(0.5, 0.5) range 0 1 // Where they spread from (0..1).",
            "let d = distance(uv, center)",
            "let wave = 0.5 + 0.5 * sin((d * count - time / 2) * TAU)",
            "out = vec4(ink, smoothstep(0.4, 0.6, wave))",
            "",
        ].joined(separator: "\n")
    ),
    PixelTemplate(
        id: "pixel.clouds",
        name: "Clouds",
        description: "Soft value-noise clouds drifting sideways.",
        loop: false,
        duration: 4000,
        source: [
            "control sky: color = #3a6ea5 // Colour behind the clouds.",
            "control cloud: color = #f4f4f4 // Colour of the clouds.",
            "control scale: number = 6 range 1 32 // Cloud size: cells across the picture.",
            "control drift: number = 0.25 range 0 4 // Cells a second they move.",
            "let p = uv * scale + vec2(time * drift, 0)",
            "let n = noise(p) * 0.6 + noise(p * 2.1) * 0.3 + noise(p * 4.3) * 0.1",
            "out = mix(sky, cloud, smoothstep(0.45, 0.75, n))",
            "",
        ].joined(separator: "\n")
    ),
]

/// The starting point with this id, or nil.
public func pixelTemplate(_ id: String) -> PixelTemplate? { PIXEL_TEMPLATES.first { $0.id == id } }

/// What a description says about an effect besides its program (`{ id, name, description?, loop?, duration? }`).
public struct PixelEffectMeta: Sendable {
    public var id: String
    public var name: String
    public var description: String?
    public var loop: Bool?
    public var duration: Double?
    public init(id: String, name: String, description: String? = nil, loop: Bool? = nil, duration: Double? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.loop = loop
        self.duration = duration
    }
}

private let PIXEL_CAPABILITIES: JSONObject = [
    "supportsWorker": false, "supportsFloat": false, "supportsMask": false, "supportsHostImages": false, "supportsVector": false, "supportsAuthoring": true, "maxSize": 8192,
]

/// The issues of a source as one sentence (errors only), e.g. for a thrown error (`pixelIssueText`).
public func pixelIssueText(_ issues: [EffectAuthoringIssue]) -> String {
    issues.filter { $0.severity == "error" }.map { i in
        if let line = i.line, line != 0 { return "line \(line): \(i.message)" }
        return i.message
    }.joined(separator: "; ")
}

/// The description of a compiled program (`pixelDescription`).
public func pixelDescription(program: PixelProgram, meta: PixelEffectMeta) -> EffectDescription {
    var properties = JSONObject()
    var defaults = JSONObject()
    for c in program.controls {
        properties[c.name] = .object(pixelControlSchema(c))
        defaults[c.name] = c.defaultValue
    }
    var o: JSONObject = [
        "id": .string(meta.id),
        "name": .string(meta.name),
        "kind": "shader",
        "category": "authored",
        "uses": ["generator"],
        "description": .string(meta.description ?? "An effect written in pixel expressions."),
        "tags": ["authored", "pixel"],
        "transparent": .bool(program.out.size == 4),
        "loop": .bool(meta.loop ?? false),
    ]
    // `...(meta.duration ? { duration } : {})`: 0 and NaN are left out.
    if let d = meta.duration, d != 0, !d.isNaN { o["duration"] = .number(d) }
    o["controls"] = ["type": "object", "properties": .object(properties), "additionalProperties": false]
    o["defaults"] = .object(defaults)
    o["presets"] = []
    o["inputs"] = []
    return EffectDescription(o)
}

/// A compiled source: its description and program, or nil for both with the issues (`describePixelSource`).
public struct PixelSourceDescription: Sendable {
    public var description: EffectDescription?
    public var program: PixelProgram?
    public var issues: [EffectAuthoringIssue]
}

/// Compiles a pixel source into a description (nil with issues when it doesn't compile).
public func describePixelSource(_ source: String, meta: PixelEffectMeta, limits: PixelLimits = PixelLimits()) -> PixelSourceDescription {
    let r = compilePixelSource(source, limits: limits)
    guard let program = r.program else { return PixelSourceDescription(description: nil, program: nil, issues: r.issues) }
    return PixelSourceDescription(description: pixelDescription(program: program, meta: meta), program: program, issues: r.issues)
}

/// A CPU renderer for a compiled program (`createPixelRenderer`).
public final class PixelCPURenderer: SyncEffectRenderer {
    public let description: EffectDescription
    public let program: PixelProgram
    public let width: Int
    public let height: Int
    public var effectId: String { description.id }
    private let evaluator: PixelEvaluator
    private var disposed = false

    public init(program: PixelProgram, description: EffectDescription, width: Int, height: Int) {
        self.program = program
        self.description = description
        self.width = width
        self.height = height
        evaluator = PixelEvaluator(program)
    }

    public func renderSync(_ request: EffectRenderRequest) throws -> EffectPixels {
        if disposed { throw EffectError("disposed", "The renderer for \"\(effectId)\" was disposed. Create a new renderer.", effectId: effectId) }
        let values = try resolveEffectValues(description, request.values ?? [:])
        var out = EffectPixels(width: width, height: height)
        evaluator.render(width: width, height: height, timeMs: request.time, values: values, into: &out.data)
        return out
    }

    public func render(_ request: EffectRenderRequest) async throws -> EffectPixels { try renderSync(request) }

    public func dispose() { disposed = true }
}

/// Whether a saved authoring document (as JSON) is written in pixel expressions (`isPixelDocument`).
public func isPixelDocument(_ doc: JSONObject?) -> Bool {
    guard let doc else { return false }
    return doc["version"] == .number(1) && doc["sourceLanguage"] == .string(PIXEL_LANGUAGE) && doc["source"]?.stringValue != nil
}

/// The source backend of pixel expression sessions (`createPixelEffectProvider`'s `backend`): template sources, the length limit, compiling and CPU previews.
public struct PixelSourceBackend: AuthoringSourceBackend {
    public let limits: PixelLimits
    public init(limits: PixelLimits = PixelLimits()) { self.limits = limits }

    public var language: String { PIXEL_LANGUAGE }

    public func sourceOf(_ effectId: String) throws -> String {
        guard let t = pixelTemplate(effectId) else { throw EffectError.unknown(effectId, in: "Pixel expressions") }
        return t.source
    }

    public func refuse(_ source: String) -> String? {
        let max = limits.resolved.maxSourceLength
        let n = source.utf16.count
        return n > max ? "the source is \(n) characters; the limit is \(max)" : nil
    }

    public func compile(_ source: String, effectId: String) -> AuthoringCompileResult {
        let t = pixelTemplate(effectId)
        let r = describePixelSource(source, meta: PixelEffectMeta(id: effectId, name: t?.name ?? effectId, loop: t?.loop, duration: t?.duration), limits: limits)
        return AuthoringCompileResult(description: r.description, issues: r.issues)
    }

    public func createRenderer(_ source: String, effectId: String, width: Int, height: Int) async throws -> EffectRenderer {
        let t = pixelTemplate(effectId)
        let r = describePixelSource(source, meta: PixelEffectMeta(id: effectId, name: t?.name ?? effectId), limits: limits)
        guard let program = r.program, let d = r.description else { throw EffectError.unsupported("the source doesn't compile: \(pixelIssueText(r.issues))", effectId) }
        return PixelCPURenderer(program: program, description: d, width: width, height: height)
    }
}

/**
 * The provider of pixel expression effects (`createPixelEffectProvider`): its catalog is the
 * starting points, rendered on the CPU, and any of them (or a saved pixel document) opens for
 * authoring with source editing (`openAuthoring`).
 */
public final class PixelEffectProvider: AuthoringEffectProvider {
    public let id = PIXEL_PROVIDER_ID
    public let name = "Pixel expressions"
    public let capabilities: JSONObject = PIXEL_CAPABILITIES
    public let limits: PixelLimits
    /// Passed on to the sessions `openAuthoring` makes (e.g. a manual `schedule` in tests).
    public let schedule: EffectAuthoringSchedule?
    public let mergeWindowMs: Double
    public let startTime: Double?

    public init(limits: PixelLimits = PixelLimits(), schedule: EffectAuthoringSchedule? = nil, mergeWindowMs: Double = 400, startTime: Double? = nil) {
        let l = limits.resolved
        self.limits = PixelLimits(maxSourceLength: l.maxSourceLength, maxCost: l.maxCost)
        self.schedule = schedule
        self.mergeWindowMs = mergeWindowMs
        self.startTime = startTime
    }

    /// A template's description and program; throws `unknown_effect` for other ids.
    public func describeTemplate(_ id: String) throws -> (description: EffectDescription, program: PixelProgram) {
        guard let t = pixelTemplate(id) else { throw EffectError.unknown(id, in: name) }
        let r = describePixelSource(t.source, meta: t.meta, limits: limits)
        guard let d = r.description, let p = r.program else { throw EffectError.unsupported("The template \"\(id)\" doesn't compile: \(pixelIssueText(r.issues))", id) }
        return (d, p)
    }

    private func summaries() throws -> [EffectDescription] { try PIXEL_TEMPLATES.map { try describeTemplate($0.id).description.summary } }

    public func list(_ options: EffectSearchOptions) async throws -> [EffectDescription] { searchEffectSummaries(try summaries(), "", options) }
    public func search(_ query: String, _ options: EffectSearchOptions) async throws -> [EffectDescription] { searchEffectSummaries(try summaries(), query, options) }
    public func describe(_ id: String) async throws -> EffectDescription { try describeTemplate(id).description }

    public func createRenderer(_ id: String, width: Int, height: Int) throws -> EffectRenderer {
        let t = try describeTemplate(id)
        return PixelCPURenderer(program: t.program, description: t.description, width: width, height: height)
    }

    /// Opens a template (`.effect("pixel.rings")`) or a saved pixel document for authoring, with source editing.
    public func openAuthoring(_ from: EffectAuthoringSource) async throws -> EffectAuthoringSession {
        try await createEffectAuthoringSession(from, options: GenericAuthoringOptions(provider: self, history: HistoryManager(), schedule: schedule, mergeWindowMs: mergeWindowMs, startTime: startTime, source: PixelSourceBackend(limits: limits)))
    }
}
