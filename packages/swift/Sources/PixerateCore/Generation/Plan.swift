import Foundation

/**
 * Plans a generation request against a model's capabilities before it is sent
 * (`generation/plan.ts`, `planGenerationRequest`): snaps enum values (aspect ratio, resolution,
 * quality, count and duration choices) to the nearest supported option, clamps ranges, truncates
 * text and reference lists over their limits, drops unsupported fields, and reports every change
 * in `adjustments` and every unfixable problem in `errors`. Pure and deterministic, as the TS:
 * messages, adjustments and the planned request (its keys in the TS order) match it exactly.
 *
 * Strategies: `error` (nothing changes; every mismatch is an error), `nearest` (snap, ties to the
 * higher value; clamp, truncate, drop), `downgrade` (ties to the lower value) and `upgrade` (like
 * `nearest`, but references the model cannot use are errors, not dropped).
 */

/// A change the planner made: `{ field, from, to, reason, kind }` (`from` / `to` absent when undefined).
public struct PlanAdjustment: Equatable, Sendable {
    public var field: String
    public var from: JSONValue?
    public var to: JSONValue?
    public var reason: String
    /// `snapped`, `clamped`, `truncated`, `dropped` or `defaulted`.
    public var kind: String

    /// As the TS writes it (`{ field, from, to, kind, reason }`, undefined members left out).
    public var json: JSONValue {
        var o = JSONObject()
        o["field"] = .string(field)
        o["from"] = from
        o["to"] = to
        o["kind"] = .string(kind)
        o["reason"] = .string(reason)
        return .object(o)
    }

    public init(field: String, from: JSONValue?, to: JSONValue?, reason: String, kind: String) {
        self.field = field
        self.from = from
        self.to = to
        self.reason = reason
        self.kind = kind
    }

    /// An adjustment from its JSON (as provenance stores it).
    public init?(json: JSONValue) {
        guard let o = json.objectValue, let field = o["field"]?.stringValue else { return nil }
        self.init(field: field, from: o["from"], to: o["to"], reason: o["reason"]?.stringValue ?? "", kind: o["kind"]?.stringValue ?? "")
    }
}

/// A problem the planner could not fix: `{ field, value, message }`.
public struct PlanError: Equatable, Sendable {
    public var field: String
    public var value: JSONValue?
    public var message: String
    public var json: JSONValue {
        var o = JSONObject()
        o["field"] = .string(field)
        o["value"] = value
        o["message"] = .string(message)
        return .object(o)
    }
}

/// The plan for one request (`GenerationPlan`).
public struct GenerationPlan: Sendable {
    /// No errors: `request` can be sent.
    public var ok: Bool
    /// The adjusted request (a copy; the input is never changed).
    public var request: GenerationRequest
    public var adjustments: [PlanAdjustment]
    public var errors: [PlanError]
    /// The model the plan was made for.
    public var model: String
    public var strategy: String

    public var json: JSONValue {
        .object(JSONObject([("ok", .bool(ok)), ("request", .object(request)), ("adjustments", .array(adjustments.map(\.json))), ("errors", .array(errors.map(\.json))), ("model", .string(model)), ("strategy", .string(strategy))]))
    }
}

/// An asset mentioned in the prompt, handed to the planner (`PlanAssetMention`).
public struct PlanAssetMention: Sendable {
    public var id: String
    public var role: String?
    public var mediaType: String?
    public var contentHash: String?
    public var url: String?
    /// The mention text, used in messages (default: the id).
    public var label: String?
    public init(id: String, role: String? = nil, mediaType: String? = nil, contentHash: String? = nil, url: String? = nil, label: String? = nil) {
        self.id = id
        self.role = role
        self.mediaType = mediaType
        self.contentHash = contentHash
        self.url = url
        self.label = label
    }
}

/// Planner options (`PlanOptions`).
public struct PlanOptions: Sendable {
    /// `error`, `upgrade`, `downgrade` or `nearest` (default).
    public var strategy: String?
    /// The prompt with templates and variables resolved, measured against `prompt.maxLength` when the model counts resolved text.
    public var resolvedPrompt: String?
    /// Fill missing fields that have a capability `default` (reported as `defaulted`).
    public var fillDefaults: Bool
    /// Whether references with unsupported roles may be dropped (default: `nearest` and `downgrade` only).
    public var dropUnsupportedReferences: Bool?
    /// Assets mentioned in the prompt, appended to the request's references.
    public var mentions: [PlanAssetMention]?
    /// Role for mentions that have none.
    public var defaultMentionRole: String?
    public init(strategy: String? = nil, resolvedPrompt: String? = nil, fillDefaults: Bool = false, dropUnsupportedReferences: Bool? = nil, mentions: [PlanAssetMention]? = nil, defaultMentionRole: String? = nil) {
        self.strategy = strategy
        self.resolvedPrompt = resolvedPrompt
        self.fillDefaults = fillDefaults
        self.dropUnsupportedReferences = dropUnsupportedReferences
        self.mentions = mentions
        self.defaultMentionRole = defaultMentionRole
    }
}

private let EPSILON = 1e-9

/// `String(value)` for the values a rank reads.
private func jsString(_ v: JSONValue?) -> String {
    switch v {
    case .string(let s)?: return s
    case .number(let n)?: return JSONValue.jsNumber(n)
    case .bool(let b)?: return b ? "true" : "false"
    case .null?: return "null"
    case nil: return "undefined"
    case let other?: return other.stringified()
    }
}

private func firstMatch(_ pattern: String, _ text: String) -> [String]? {
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
    let ns = text as NSString
    guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
    return (0 ..< m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
}

/// Numeric rank of an aspect ratio such as `16:9` (log of width / height).
public func aspectRatioRank(_ value: JSONValue?) -> Double? {
    guard let m = firstMatch("^\\s*(\\d+(?:\\.\\d+)?)\\s*[:x/×]\\s*(\\d+(?:\\.\\d+)?)\\s*$", jsString(value)) else { return nil }
    let w = Double(m[1]) ?? .nan, h = Double(m[2]) ?? .nan
    if !(w > 0) || !(h > 0) { return nil }
    return log(w / h)
}

/// Numeric rank of a resolution: `1024x768` (pixels), `720p` (16:9 at that height) or `2k`. Log scale.
public func resolutionRank(_ value: JSONValue?) -> Double? {
    let text = jsString(value).jsTrimmed.jsLowercased
    var pixels: Double?
    if let m = firstMatch("^(\\d+(?:\\.\\d+)?)\\s*[x×*]\\s*(\\d+(?:\\.\\d+)?)$", text) { pixels = Double(m[1])! * Double(m[2])! }
    else if let m = firstMatch("^(\\d+(?:\\.\\d+)?)p$", text) { pixels = (pow(Double(m[1])!, 2) * 16) / 9 }
    else if let m = firstMatch("^(\\d+(?:\\.\\d+)?)k$", text) { pixels = pow(Double(m[1])! * 1024, 2) }
    guard let p = pixels, p > 0 else { return nil }
    return log(p)
}

/// Megapixels of a resolution string, when it can be parsed.
public func resolutionMegapixels(_ value: String) -> Double? {
    resolutionRank(.string(value)).map { exp($0) / 1_000_000 }
}

/// Common quality names, low → high (`QUALITY_LADDER`).
public let QUALITY_LADDER: [String: Double] = ["draft": 0, "preview": 0, "low": 1, "fast": 1, "turbo": 1, "standard": 2, "normal": 2, "medium": 2, "balanced": 2, "high": 3, "hd": 3, "quality": 3, "ultra": 4, "max": 5, "best": 5]

public func qualityRank(_ value: JSONValue?) -> Double? { QUALITY_LADDER[jsString(value).jsTrimmed.jsLowercased] }

private func numberRank(_ value: JSONValue?) -> Double? {
    if case .number(let n)? = value, n.isFinite { return n }
    return nil
}

/// The option closest to `value` by `rank`; ties go to the lower or higher rank (`snapToOption`).
public func snapToOption(_ value: JSONValue?, _ options: [JSONValue], _ rank: (JSONValue?) -> Double?, _ tie: String) -> JSONValue? {
    guard let target = rank(value) else { return nil }
    var best: (option: JSONValue, distance: Double, rank: Double)?
    for option in options {
        guard let r = rank(option) else { continue }
        let distance = abs(r - target)
        if best == nil || distance < best!.distance - EPSILON || (abs(distance - best!.distance) <= EPSILON && (tie == "lower" ? r < best!.rank : r > best!.rank)) {
            best = (option, distance, r)
        }
    }
    return best?.option
}

/// Truncates to `max` UTF-16 units without splitting a surrogate pair.
private func truncateText(_ text: String, _ max: Int) -> String {
    let units = Array(text.utf16)
    if units.count <= max { return text }
    var end = max
    if end > 0 && (0xD800 ... 0xDBFF).contains(units[end - 1]) { end -= 1 }
    return String(decoding: units[0 ..< end], as: UTF16.self)
}

private func describe(_ value: JSONValue?) -> String {
    if case .string(let s)? = value { return "\"\(s)\"" }
    guard let value else { return "undefined" }
    return value.stringified()
}

private func list(_ options: [JSONValue]) -> String { options.map { describe($0) }.joined(separator: ", ") }

/// `Number(x.toPrecision(12))`.
private func precision12(_ x: Double) -> Double { Double(String(format: "%.11e", x)) ?? x }

private func isInteger(_ x: Double) -> Bool { x.isFinite && x.rounded(.towardZero) == x }

private func numberText(_ x: Double) -> String { JSONValue.jsNumber(x) }

private struct NumberSpec {
    var min: Double?
    var max: Double?
    var step: Double?
    var integer = false
    var options: [Double]?

    init(min: Double? = nil, max: Double? = nil, step: Double? = nil, integer: Bool = false, options: [Double]? = nil) {
        self.min = min
        self.max = max
        self.step = step
        self.integer = integer
        self.options = options
    }

    /// From a capability or parameter spec (`min`, `max`, `step`, `options`).
    init(_ o: JSONObject?, integer: Bool = false) {
        min = o?["min"]?.numberValue
        max = o?["max"]?.numberValue
        step = o?["step"]?.numberValue
        options = o?["options"]?.arrayValue?.compactMap(\.numberValue)
        self.integer = integer
    }
}

private final class Planner {
    var adjustments: [PlanAdjustment] = []
    var errors: [PlanError] = []
    let tie: String
    let strict: Bool
    let caps: ModelCapabilities
    var request: GenerationRequest
    let options: PlanOptions
    let strategy: String

    init(_ caps: ModelCapabilities, _ request: GenerationRequest, _ options: PlanOptions, _ strategy: String) {
        self.caps = caps
        self.request = request
        self.options = options
        self.strategy = strategy
        tie = strategy == "downgrade" ? "lower" : "higher"
        strict = strategy == "error"
    }

    func adjust(_ field: String, _ from: JSONValue?, _ to: JSONValue?, _ kind: String, _ reason: String) {
        adjustments.append(PlanAdjustment(field: field, from: from, to: to, reason: reason, kind: kind))
    }

    func error(_ field: String, _ value: JSONValue?, _ message: String) {
        errors.append(PlanError(field: field, value: value, message: message))
    }

    /// Removes an unsupported field (or reports it under `error`).
    func unsupported(_ field: String, _ message: String) {
        let value = request[field]
        if strict {
            error(field, value, message)
            return
        }
        request[field] = nil
        adjust(field, value, nil, "dropped", message)
    }

    func defaulted(_ field: String, _ value: JSONValue?, _ set: () -> Void) {
        guard options.fillDefaults, value != nil else { return }
        set()
        adjust(field, nil, value, "defaulted", "Filled with the model default.")
    }

    func planText(_ field: String, _ maxLength: Double?, _ measured: String? = nil) {
        guard let value = request[field], let maxLength else { return }
        guard case .string(let text0) = value else {
            error(field, value, "Expected text.")
            return
        }
        let text = measured ?? text0
        let length = text.utf16.count
        if Double(length) <= maxLength { return }
        if strict || measured != nil {
            error(field, .number(Double(length)), "\(measured != nil ? "Resolved text" : "Text") is \(length) characters; the model accepts at most \(numberText(maxLength)).")
            return
        }
        let next = truncateText(text0, Int(maxLength))
        request[field] = .string(next)
        adjust(field, .number(Double(text0.utf16.count)), .number(Double(next.utf16.count)), "truncated", "Truncated to the model's \(numberText(maxLength))-character limit.")
    }

    func planEnum(_ field: String, _ cap: JSONObject?, _ rank: (JSONValue?) -> Double?, _ label: String) {
        guard let value = request[field] else {
            if let cap { defaulted(field, cap["default"]) { request[field] = cap["default"] } }
            return
        }
        let options = cap?["options"]?.arrayValue ?? []
        guard let cap, !options.isEmpty else {
            unsupported(field, "The model does not take a \(label).")
            return
        }
        if options.contains(value) { return }
        if strict {
            error(field, value, "\(describe(value)) is not a supported \(label); supported: \(list(options)).")
            return
        }
        let snapped = snapToOption(value, options, rank, tie)
        let next = snapped ?? cap["default"] ?? options[0]
        request[field] = next
        adjust(field, value, next, "snapped", snapped != nil ? "\(describe(value)) is not supported; using the nearest \(label)." : "\(describe(value)) is not supported; using \(cap["default"] != nil ? "the default" : "the first option").")
    }

    /// Clamps, rounds or snaps a number. Returns the next value, or nil after an error.
    func planNumber(_ field: String, _ value: JSONValue?, _ spec: NumberSpec, _ label: String) -> (value: Double, changed: Bool)? {
        guard case .number(let v)? = value, v.isFinite else {
            error(field, value, "Expected a number for \(label).")
            return nil
        }
        let options = spec.options?.filter { o in (spec.min == nil || o >= spec.min!) && (spec.max == nil || o <= spec.max!) }
        if let options, !options.isEmpty {
            if options.contains(v) { return (v, false) }
            if strict {
                error(field, value, "\(numberText(v)) is not a supported \(label); supported: \(list(options.map { .number($0) })).")
                return nil
            }
            let next = snapToOption(value, options.map { .number($0) }, numberRank, tie)!.numberValue!
            adjust(field, value, .number(next), "snapped", "\(numberText(v)) is not supported; using the nearest \(label).")
            return (next, true)
        }
        var next = v
        if let step = spec.step, step > 0 {
            let base = spec.min ?? 0
            let steps = (next - base) / step
            let rounded = abs(steps - steps.rounded(.towardZero) - 0.5) < EPSILON ? (tie == "lower" ? steps.rounded(.down) : steps.rounded(.up)) : jsRound(steps)
            next = precision12(base + rounded * step)
        }
        if spec.integer && !isInteger(next) {
            let frac = next - next.rounded(.down)
            next = abs(frac - 0.5) < EPSILON ? (tie == "lower" ? next.rounded(.down) : next.rounded(.up)) : jsRound(next)
        }
        var kind = "snapped"
        if let min = spec.min, next < min {
            next = min
            kind = "clamped"
        }
        if let max = spec.max, next > max {
            next = max
            kind = "clamped"
        }
        if next == v { return (v, false) }
        let range = "\(spec.min.map(numberText) ?? "-∞")–\(spec.max.map(numberText) ?? "∞")"
        if strict {
            error(field, value, kind == "clamped" ? "\(label) must be within \(range)." : "\(numberText(v)) is not a valid \(label) (try \(numberText(next))).")
            return nil
        }
        adjust(field, value, .number(next), kind, kind == "clamped" ? "Clamped to the supported range \(range)." : "Rounded to a supported \(label).")
        return (next, true)
    }

    func planCount() {
        let cap = caps["count"]?.objectValue
        guard let value = request["count"] else {
            if let cap { defaulted("count", cap["default"]) { request["count"] = cap["default"] } }
            return
        }
        guard let cap else {
            if value == .number(1) { return }
            unsupported("count", "The model produces one output per request.")
            return
        }
        var spec = NumberSpec(min: 1, max: cap["max"]?.numberValue, integer: true)
        spec.options = cap["options"]?.arrayValue?.compactMap(\.numberValue)
        if let r = planNumber("count", value, spec, "output count") { request["count"] = .number(r.value) }
    }

    func planDuration() {
        let cap = caps["duration"]?.objectValue
        guard let value = request["duration"] else {
            if let cap { defaulted("duration", cap["default"]) { request["duration"] = cap["default"] } }
            return
        }
        guard let cap else {
            unsupported("duration", "The model does not take a duration.")
            return
        }
        if let r = planNumber("duration", value, NumberSpec(cap), "duration") { request["duration"] = .number(r.value) }
    }

    func planSeed() {
        guard let value = request["seed"] else { return }
        guard let cap = seedCapability(caps["seed"]) else {
            unsupported("seed", "The model does not take a seed.")
            return
        }
        if let r = planNumber("seed", value, NumberSpec(cap, integer: true), "seed") { request["seed"] = .number(r.value) }
    }

    func planMode() {
        guard let mode = request["mode"] else { return }
        let modes = supportedModes(caps)
        if !modes.contains(where: { JSONValue.string($0) == mode }) {
            error("mode", mode, "The model does not support \(describe(mode)); supported: \(list(modes.map { .string($0) })).")
        }
    }

    func roleCapability(_ role: String) -> JSONObject? {
        if let cap = caps["references"]?["roles"]?[role]?.objectValue, (cap["max"]?.numberValue ?? 0) > 0 { return cap }
        if role == "mask" && truthyJSON(caps["inpainting"]) { return JSONObject([("max", 1)]) }
        return nil
    }

    /// Turns `options.mentions` into references (appended after the request's own).
    func addMentions() {
        guard let mentions = options.mentions, !mentions.isEmpty else { return }
        var refs = request["references"]?.arrayValue ?? []
        for mention in mentions where !mention.id.isEmpty {
            var role = mention.role
            if role == nil || role!.isEmpty {
                let r = options.defaultMentionRole ?? inferRole(mention.mediaType)
                role = r
                adjust("references.\(r)", nil, .string(r), "defaulted", "@\(mention.label ?? mention.id) has no role; using \(r).")
            }
            var ref = JSONObject([("id", .string(mention.id)), ("role", .string(role!))])
            if let u = mention.url { ref["url"] = .string(u) }
            if let m = mention.mediaType { ref["mediaType"] = .string(m) }
            if let h = mention.contentHash { ref["contentHash"] = .string(h) }
            refs.append(.object(ref))
        }
        request["references"] = .array(refs)
    }

    /// First role of the model (other than `mask`) whose `accepts` matches `mediaType`.
    func inferRole(_ mediaType: String?) -> String {
        for role in supportedReferenceRoles(caps) where role != "mask" {
            if let cap = roleCapability(role), mediaType == nil || mediaTypeMatches(mediaType, cap["accepts"]?.arrayValue?.compactMap(\.stringValue)) { return role }
        }
        return "image_ref"
    }

    func planReferences() {
        let refs = request["references"]?.arrayValue
        let allowDrop = !strict && (options.dropUnsupportedReferences ?? (strategy == "nearest" || strategy == "downgrade"))
        var byRole: [String: [Int]] = [:]
        var kept: [JSONObject] = []
        var unsupportedRoles: [(role: String, count: Int)] = []
        for (index, original) in (refs ?? []).enumerated() {
            guard var ref = original.objectValue, let id = ref["id"]?.stringValue, !id.isEmpty, isReferenceRoleName(ref["role"]) else {
                error("references.\(index)", original, "Each reference needs an `id` and a valid `role`.")
                continue
            }
            var role = ref["role"]!.stringValue!
            if roleCapability(role) == nil {
                let alias = normalizeReferenceRole(role, caps)
                if alias != role && roleCapability(alias) != nil {
                    if strict {
                        error("references.\(role)", .string(role), "The model calls this role \(describe(.string(alias))).")
                        continue
                    }
                    adjust("references.\(role)", .string(role), .string(alias), "snapped", "Using the model's \(alias) role for \(describe(.string(role))).")
                    ref["role"] = .string(alias)
                    role = alias
                } else {
                    if let i = unsupportedRoles.firstIndex(where: { $0.role == role }) { unsupportedRoles[i].count += 1 } else { unsupportedRoles.append((role, 1)) }
                    continue
                }
            }
            let cap = roleCapability(role)!
            let accepts = cap["accepts"]?.arrayValue?.compactMap(\.stringValue)
            if let mediaType = ref["mediaType"], !mediaTypeMatches(mediaType.stringValue, accepts) {
                let message = "\(describe(.string(id))) is \(describe(mediaType)); \(role) accepts \(list((accepts ?? []).map { .string($0) }))."
                if allowDrop { adjust("references.\(role)", .string(id), nil, "dropped", message) } else { error("references.\(role)", .string(id), message) }
                continue
            }
            let group = byRole[role] ?? []
            if group.contains(where: { kept[$0]["id"]?.stringValue == id }) {
                adjust("references.\(role)", .string(id), nil, "dropped", "Duplicate reference \"\(id)\" removed.")
                continue
            }
            byRole[role] = group + [kept.count]
            kept.append(ref)
        }

        for (role, count) in unsupportedRoles {
            let message = caps.media == "text" || caps["references"] == nil ? "The \(caps.media) model \"\(caps.id)\" does not accept reference inputs (\(role))." : "The model does not accept \(role) references."
            if allowDrop { adjust("references.\(role)", .number(Double(count)), .number(0), "dropped", message) } else { error("references.\(role)", .number(Double(count)), message) }
        }

        // Per-role limits (built-in roles first, then the model's own roles).
        var removed = Set<Int>()
        let custom = supportedReferenceRoles(caps).filter { !REFERENCE_ROLES.contains($0) }
        for role in REFERENCE_ROLES + custom {
            guard let cap = roleCapability(role) else { continue }
            let group = byRole[role] ?? []
            let max = cap["max"]?.numberValue ?? 0
            if Double(group.count) > max {
                if strict {
                    error("references.\(role)", .number(Double(group.count)), "At most \(numberText(max)) \(role) reference(s) are supported.")
                } else {
                    for i in group.dropFirst(Int(max)) { removed.insert(i) }
                    adjust("references.\(role)", .number(Double(group.count)), .number(max), "truncated", "Kept the first \(numberText(max)) \(role) reference(s); the model accepts no more.")
                }
            }
            if let min = cap["min"]?.numberValue, Double(group.count) < min {
                error("references.\(role)", .number(Double(group.count)), "At least \(numberText(min)) \(role) reference(s) are required.")
            }
        }
        var next = kept.indices.filter { !removed.contains($0) }.map { kept[$0] }

        // Total limit.
        if let maxTotal = caps["references"]?["maxTotal"]?.numberValue, Double(next.count) > maxTotal {
            if strict {
                error("references", .number(Double(next.count)), "At most \(numberText(maxTotal)) references are supported in total.")
            } else {
                adjust("references", .number(Double(next.count)), .number(maxTotal), "truncated", "Kept the first \(numberText(maxTotal)) references; the model accepts no more in total.")
                next = Array(next.prefix(Int(maxTotal)))
            }
        }

        if request["mode"] == .string("inpaint") && !next.contains(where: { $0["role"] == .string("mask") }) {
            error("references.mask", .number(0), "Inpainting needs a `mask` reference.")
        }

        if refs == nil { return }
        if !strict {
            if !next.isEmpty { request["references"] = .array(next.map { .object($0) }) } else { request["references"] = nil }
        }
    }

    func planParam(_ name: String, _ spec: JSONObject?, _ value: JSONValue) -> JSONValue? {
        let field = "params.\(name)"
        guard let spec else {
            if strict { error(field, value, "Unknown parameter \"\(name)\".") } else { adjust(field, value, nil, "dropped", "The model has no \"\(name)\" parameter.") }
            return nil
        }
        let label = spec["label"]?.stringValue ?? name
        switch spec["type"]?.stringValue {
        case "boolean":
            if value.boolValue == nil { error(field, value, "Expected true or false for \(label).") }
            return value
        case "enum":
            let options = spec["options"]?.arrayValue ?? []
            if options.contains(value) { return value }
            if strict {
                error(field, value, "\(describe(value)) is not a supported \(label); supported: \(list(options)).")
                return value
            }
            let numeric = options.allSatisfy { $0.numberValue != nil }
            let snapped = numeric ? snapToOption(value, options, numberRank, tie) : nil
            let next = snapped ?? spec["default"] ?? options.first
            adjust(field, value, next, "snapped", snapped != nil ? "Using the nearest supported \(label)." : "\(describe(value)) is not supported; using \(spec["default"] != nil ? "the default" : "the first option").")
            return next
        default:
            let r = planNumber(field, value, NumberSpec(spec, integer: spec["type"]?.stringValue == "integer"), label)
            return r.map { .number($0.value) } ?? value
        }
    }

    func planParams() {
        let params = request["params"]?.objectValue ?? JSONObject()
        let specs = caps["params"]?.objectValue ?? JSONObject()
        var next = JSONObject()
        for (name, value) in params {
            if let planned = planParam(name, specs[name]?.objectValue, value) { next[name] = planned } else if strict { next[name] = value }
        }
        if options.fillDefaults {
            for (name, spec) in specs where next[name] == nil {
                if let d = spec["default"] {
                    next[name] = d
                    adjust("params.\(name)", nil, d, "defaulted", "Filled with the model default.")
                }
            }
        }
        request["params"] = next.isEmpty ? nil : .object(next)
    }

    func run() {
        for key in request.keys where !GENERATION_REQUEST_FIELDS.contains(key) {
            let value = request[key]
            if strict { error(key, value, "Unknown request field \"\(key)\".") } else {
                request[key] = nil
                adjust(key, value, nil, "dropped", "Unknown request field \"\(key)\".")
            }
        }

        if let model = request["model"], model != .string(caps.id) {
            error("model", model, "The request targets \"\(jsString(model))\" but the plan is for \"\(caps.id)\".")
        }
        request["model"] = .string(caps.id)

        // Text fields.
        let promptCap = caps["prompt"]?.objectValue ?? JSONObject()
        if truthyJSON(promptCap["required"]) && (request["prompt"]?.stringValue ?? "").jsTrimmed.isEmpty {
            error("prompt", request["prompt"], "A prompt is required.")
        }
        let countResolved = promptCap["countResolved"]?.boolValue ?? true
        let measured = countResolved && options.resolvedPrompt != nil && JSONValue.string(options.resolvedPrompt!) != request["prompt"] ? options.resolvedPrompt : nil
        planText("prompt", promptCap["maxLength"]?.numberValue, measured)
        for field in ["negativePrompt", "systemPrompt"] {
            if request[field] == nil { continue }
            guard let cap = textFieldCapability(caps[field]) else {
                unsupported(field, "The model does not take a \(field == "negativePrompt" ? "negative" : "system") prompt.")
                continue
            }
            planText(field, cap["maxLength"]?.numberValue)
        }

        planEnum("aspectRatio", caps["aspectRatios"]?.objectValue, aspectRatioRank, "aspect ratio")
        planEnum("resolution", caps["resolutions"]?.objectValue, resolutionRank, "resolution")
        planEnum("quality", caps["quality"]?.objectValue, qualityRank, "quality")
        planCount()
        planDuration()
        planSeed()
        planMode()
        addMentions()
        planReferences()
        planParams()
    }
}

/**
 * Plans `request` against a model's capabilities (`planGenerationRequest`; see the file comment).
 * Pure and deterministic: the same input always gives the same plan.
 */
public func planGenerationRequest(_ request: GenerationRequest, _ caps: ModelCapabilities, _ options: PlanOptions = PlanOptions()) -> GenerationPlan {
    let strategy = options.strategy ?? "nearest"
    let planner = Planner(caps, request, options, strategy)
    planner.run()
    return GenerationPlan(ok: planner.errors.isEmpty, request: planner.request, adjustments: planner.adjustments, errors: planner.errors, model: caps.id, strategy: strategy)
}
