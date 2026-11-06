import Foundation

/**
 * Generation provenance (`generation/provenance.ts`) and stable JSON (`generation/hash.ts`): the
 * record of what produced an output (raw prompt, resolved prompt and its source map, model,
 * planned request and adjustments, references by role, time), kept next to the output so it can
 * be explained and regenerated.
 *
 * Prompt templates (`{{name}}` with template bodies) and variable values are not ported (the
 * prompt grammar lives in the TS core): `createProvenance` records a prompt as written, which is
 * what the TS records when no templates or values are given (a `{{tag}}` is kept as its own
 * locked segment of the source map, as the TS resolver keeps an unknown template).
 */

public let PROVENANCE_FORMAT = "pixerate.generation-provenance"
public let PROVENANCE_VERSION = 1

/// What `createProvenance` records (`CreateProvenanceOptions` without templates, bindings and values).
public struct CreateProvenanceOptions: Sendable {
    public var rawPrompt: String
    /// The model's id.
    public var model: String
    /// The plan the request came from (its request and adjustments are recorded) …
    public var plan: GenerationPlan?
    /// … or the request that was sent.
    public var request: GenerationRequest?
    public var adjustments: [PlanAdjustment]?
    /// Creation time (default now).
    public var createdAt: Date?
    public var startedAt: Date?
    public var completedAt: Date?
    public var outputIds: [String]?
    public var meta: JSONObject?

    public init(rawPrompt: String, model: String, plan: GenerationPlan? = nil, request: GenerationRequest? = nil, adjustments: [PlanAdjustment]? = nil, createdAt: Date? = nil, startedAt: Date? = nil, completedAt: Date? = nil, outputIds: [String]? = nil, meta: JSONObject? = nil) {
        self.rawPrompt = rawPrompt
        self.model = model
        self.plan = plan
        self.request = request
        self.adjustments = adjustments
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.outputIds = outputIds
        self.meta = meta
    }
}

/// Thrown by `parseProvenance` (`ProvenanceParseError`).
public struct ProvenanceParseError: Error, LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// `new Date(value).toISOString()`.
public func isoTimestamp(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    f.timeZone = TimeZone(identifier: "UTC")
    return f.string(from: date)
}

private let TEMPLATE_TAG = try! NSRegularExpression(pattern: "\\{\\{\\s*([^}]+?)\\s*\\}\\}")

/**
 * The source map of a prompt resolved with no templates and no values (`resolvePrompt(text)`):
 * the text is unchanged, plain runs map to themselves and each `{{tag}}` is a segment of its own.
 * Offsets are UTF-16 units, as in the TS.
 */
public func rawPromptSourceMap(_ text: String) -> [JSONValue] {
    func seg(_ start: Int, _ end: Int) -> JSONValue {
        .object(JSONObject([("resolvedStart", .number(Double(start))), ("resolvedEnd", .number(Double(end))), ("source", "raw"), ("rawStart", .number(Double(start))), ("rawEnd", .number(Double(end)))]))
    }
    let length = (text as NSString).length
    var out: [JSONValue] = []
    var at = 0
    for m in TEMPLATE_TAG.matches(in: text, range: NSRange(location: 0, length: length)) {
        if m.range.location > at { out.append(seg(at, m.range.location)) }
        out.append(seg(m.range.location, m.range.location + m.range.length))
        at = m.range.location + m.range.length
    }
    if at < length { out.append(seg(at, length)) }
    if out.isEmpty { out.append(seg(0, 0)) }
    return out
}

/**
 * Records what produced an output (`createProvenance`): the raw prompt, the resolved prompt and
 * its source map, the model, the planned request and adjustments, and the references by role.
 * Keys are in the TS order.
 */
public func createProvenance(_ options: CreateProvenanceOptions) -> JSONObject {
    var request = options.plan?.request ?? options.request ?? GenerationRequest()
    request["model"] = .string(options.model)
    if request["prompt"] == nil { request["prompt"] = .string(options.rawPrompt) }
    let adjustments = options.adjustments ?? options.plan?.adjustments ?? []
    let references: [JSONValue] = (request["references"]?.arrayValue ?? []).map { r in
        var o = JSONObject()
        o["id"] = r["id"]
        o["role"] = r["role"]
        return .object(o)
    }
    var out = JSONObject([
        ("format", .string(PROVENANCE_FORMAT)), ("version", .number(Double(PROVENANCE_VERSION))), ("rawPrompt", .string(options.rawPrompt)), ("templates", []), ("bindings", .object(JSONObject())),
        ("values", .null), ("resolvedPrompt", .string(options.rawPrompt)), ("sourceMap", .array(rawPromptSourceMap(options.rawPrompt))), ("modelId", .string(options.model)),
        ("request", .object(request)), ("adjustments", .array(adjustments.map(\.json))), ("references", .array(references)), ("createdAt", .string(isoTimestamp(options.createdAt ?? Date()))),
    ])
    if let s = options.startedAt { out["startedAt"] = .string(isoTimestamp(s)) }
    if let c = options.completedAt { out["completedAt"] = .string(isoTimestamp(c)) }
    if let ids = options.outputIds { out["outputIds"] = .array(ids.map { .string($0) }) }
    if let meta = options.meta { out["meta"] = .object(meta) }
    return out
}

/// Versioned JSON for storage next to an output (`serializeProvenance`).
public func serializeProvenance(_ provenance: JSONObject) -> String { JSONValue.object(provenance).stringified() }

/// Parses and checks serialized provenance (`parseProvenance`): JSON text or a value. Throws `ProvenanceParseError`.
public func parseProvenance(_ input: JSONValue) throws -> JSONObject {
    var data = input
    if case .string(let text) = input {
        guard let parsed = try? JSONValue.parse(text) else { throw ProvenanceParseError("Provenance is not valid JSON.") }
        data = parsed
    }
    guard var o = data.objectValue, o["format"] == .string(PROVENANCE_FORMAT) else { throw ProvenanceParseError("Not a generation provenance record.") }
    guard case .number(let version)? = o["version"], version <= Double(PROVENANCE_VERSION) else {
        throw ProvenanceParseError("Unsupported provenance version \(o["version"].map { $0.stringified() } ?? "undefined").")
    }
    let isString = { (k: String) in o[k]?.stringValue != nil }
    let isRecord = { (k: String) in o[k]?.objectValue != nil }
    let isArray = { (k: String) in o[k]?.arrayValue != nil }
    let templatesOk = o["templates"]?.arrayValue?.allSatisfy { $0["name"]?.stringValue != nil && $0["body"]?.stringValue != nil } ?? false
    let checks: [(String, Bool)] = [
        ("rawPrompt", isString("rawPrompt")), ("resolvedPrompt", isString("resolvedPrompt")), ("modelId", isString("modelId")), ("createdAt", isString("createdAt")), ("request", isRecord("request")),
        ("templates", templatesOk), ("sourceMap", isArray("sourceMap")), ("adjustments", isArray("adjustments")), ("references", isArray("references")),
    ]
    if let bad = checks.first(where: { !$0.1 }) { throw ProvenanceParseError("Invalid provenance field \"\(bad.0)\".") }
    o["bindings"] = isRecord("bindings") ? o["bindings"] : .object(JSONObject())
    o["values"] = isRecord("values") ? o["values"] : .null
    return o
}

/**
 * Stable JSON (`stableStringify`): object keys sorted (by UTF-16 code units, as JavaScript's
 * sort), so equal values always give the same string regardless of key order.
 */
public func stableStringify(_ value: JSONValue) -> String {
    switch value {
    case .array(let items): return "[\(items.map(stableStringify).joined(separator: ","))]"
    case .object(let o):
        let keys = o.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        return "{\(keys.map { "\(JSONValue.string($0).stringified()):\(stableStringify(o[$0]!))" }.joined(separator: ","))}"
    default: return value.stringified()
    }
}
