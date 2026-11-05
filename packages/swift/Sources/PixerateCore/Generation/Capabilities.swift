import Foundation

/**
 * Generative models and the requests sent to them (`generation/capabilities.ts` in the TS core).
 * Everything is plain JSON, as in the TS: a model's capabilities can come from a server and are
 * passed through as they are, so `ModelCapabilities` wraps its JSON object (`id`, `media`,
 * `name`, `prompt`, `negativePrompt`, `systemPrompt`, `aspectRatios`, `resolutions`, `quality`,
 * `count`, `duration`, `seed`, `references`, `editing`, `inpainting`, `params`, `timing`) and a
 * `GenerationRequest` is a JSON object (`model`, `prompt`, `negativePrompt`, `systemPrompt`,
 * `aspectRatio`, `resolution`, `quality`, `count`, `duration`, `seed`, `mode`, `references`,
 * `params`), its keys in the order they were set.
 */

/// A request for one model (`GenerationRequest`): every field is optional; the planner fills and fixes.
public typealias GenerationRequest = JSONObject

/// Everything a generative model accepts (`ModelCapabilities`), as its JSON. Absent sections mean "unsupported".
public struct ModelCapabilities: Equatable, Sendable {
    public var json: JSONObject
    public init(_ json: JSONObject) { self.json = json }

    public var id: String { json["id"]?.stringValue ?? "" }
    /// `image`, `video`, `audio` or `text`.
    public var media: String { json["media"]?.stringValue ?? "" }
    public var name: String? { json["name"]?.stringValue }
    public subscript(key: String) -> JSONValue? { json[key] }
}

/// Valid role names: a letter, then letters, digits, `_` or `-`, not ending in `_` or `-`.
private let REFERENCE_ROLE_NAME = try! NSRegularExpression(pattern: "^[A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$")

/// True for a string usable as a role name (`isReferenceRoleName`).
public func isReferenceRoleName(_ value: JSONValue?) -> Bool {
    guard let s = value?.stringValue, s.utf16.count <= 64 else { return false }
    return REFERENCE_ROLE_NAME.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
}

/// Every built-in reference role, in a stable display order (`REFERENCE_ROLES`).
public let REFERENCE_ROLES = ["start_frame", "end_frame", "style_ref", "character_ref", "background_ref", "mask", "image_ref", "video_ref", "audio_ref"]

/// Friendly role names accepted wherever a role is written by hand (`REFERENCE_ROLE_ALIASES`); keys are lower case.
public let REFERENCE_ROLE_ALIASES: [String: String] = [
    "reference": "image_ref", "image": "image_ref", "style": "style_ref", "character": "character_ref", "background": "background_ref",
    "start-frame": "start_frame", "first-frame": "start_frame", "first_frame": "start_frame", "end-frame": "end_frame", "last-frame": "end_frame", "last_frame": "end_frame",
    "style-ref": "style_ref", "character-ref": "character_ref", "background-ref": "background_ref", "image-ref": "image_ref", "video-ref": "video_ref", "audio-ref": "audio_ref",
    "video": "video_ref", "audio": "audio_ref",
]

/// Fields of a request the planner knows about, in planning order (`GENERATION_REQUEST_FIELDS`).
public let GENERATION_REQUEST_FIELDS = ["model", "prompt", "negativePrompt", "systemPrompt", "aspectRatio", "resolution", "quality", "count", "duration", "seed", "mode", "references", "params"]

private func isBuiltinRole(_ role: String) -> Bool { REFERENCE_ROLES.contains(role) }

/// A model's declared role, or nil.
private func declaredRole(_ caps: ModelCapabilities?, _ role: String) -> JSONObject? {
    caps?["references"]?["roles"]?[role]?.objectValue
}

/**
 * Canonical role for a hand-written name (`normalizeReferenceRole`): the name itself when the
 * model declares it (or, without a model, when it is built in), else its alias
 * (case-insensitive), else the trimmed name.
 */
public func normalizeReferenceRole(_ role: String, _ caps: ModelCapabilities? = nil) -> String {
    let name = role.jsTrimmed
    if caps != nil ? declaredRole(caps, name) != nil : isBuiltinRole(name) { return name }
    let lower = name.jsLowercased
    if declaredRole(caps, lower) != nil { return lower }
    if caps == nil && isBuiltinRole(lower) { return lower }
    return REFERENCE_ROLE_ALIASES[lower] ?? (isBuiltinRole(lower) ? lower : name)
}

/**
 * Whether `mediaType` (a MIME type such as `image/png`, or a media kind such as `image`) matches
 * one of `accepts` (`mediaTypeMatches`). An empty or missing `accepts` accepts everything.
 */
public func mediaTypeMatches(_ mediaType: String?, _ accepts: [String]?) -> Bool {
    guard let accepts, !accepts.isEmpty else { return true }
    guard let mediaType, !mediaType.isEmpty else { return false }
    let type = String(mediaType.split(separator: ";", omittingEmptySubsequences: false)[0]).jsTrimmed.jsLowercased
    let kind = String(type.split(separator: "/", omittingEmptySubsequences: false)[0])
    return accepts.contains { entry in
        let pattern = entry.jsTrimmed.jsLowercased
        if pattern == "*" || pattern == "*/*" || pattern == type { return true }
        if !pattern.contains("/") { return pattern == kind }
        if pattern.hasSuffix("/*") { return String(pattern.dropLast(2)) == kind }
        return false
    }
}

/// Text field limits from `boolean | { maxLength }` (`textFieldCapability`), or nil when unsupported.
public func textFieldCapability(_ value: JSONValue?) -> JSONObject? {
    switch value {
    case .bool(true)?: return JSONObject()
    case .object(let o)?: return o
    default: return nil
    }
}

/// Seed limits from `boolean | { min, max }` (`seedCapability`), or nil when unsupported.
public func seedCapability(_ value: JSONValue?) -> JSONObject? { textFieldCapability(value) }

private func maxOf(_ cap: JSONValue?) -> Double { cap?["max"]?.numberValue ?? 0 }

/// Supported reference roles of a model: built-in roles first, then custom roles in declaration order.
public func supportedReferenceRoles(_ caps: ModelCapabilities) -> [String] {
    let roles = caps["references"]?["roles"]?.objectValue ?? JSONObject()
    let builtin = REFERENCE_ROLES.filter { maxOf(roles[$0]) > 0 }
    let custom = roles.keys.filter { !isBuiltinRole($0) && isReferenceRoleName(.string($0)) && maxOf(roles[$0]) > 0 }
    return builtin + custom
}

/// Supported generation modes of a model (`supportedModes`).
public func supportedModes(_ caps: ModelCapabilities) -> [String] {
    var modes = ["generate"]
    if truthyJSON(caps["editing"]) { modes.append("edit") }
    if truthyJSON(caps["inpainting"]) { modes.append("inpaint") }
    return modes
}

/// JavaScript truthiness of an optional JSON value.
func truthyJSON(_ v: JSONValue?) -> Bool {
    switch v {
    case .none, .some(.null): return false
    case .some(.bool(let b)): return b
    case .some(.number(let n)): return n != 0 && !n.isNaN
    case .some(.string(let s)): return !s.isEmpty
    default: return true
    }
}
