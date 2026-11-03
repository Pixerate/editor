// Portions ported from craft-libs-main/crates/settings/src/migrate.rs, src/document.rs and
// src/error.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors) by way of
// packages/core/src/persistence/migrate.ts. See THIRD_PARTY_NOTICES.md.

import Foundation

/// Keys dropped from untrusted JSON objects (`tools/safe-json.ts`), so documents and tool
/// arguments read the same as in the TS core.
public let unsafeJSONKeys: Set<String> = ["__proto__", "constructor", "prototype"]

/// A copy of `value` without `__proto__` / `constructor` / `prototype` keys, at any depth.
public func stripPrototypeKeys(_ value: JSONValue) -> JSONValue {
    switch value {
    case .array(let items): return .array(items.map(stripPrototypeKeys))
    case .object(let obj):
        var out = JSONObject()
        for (k, v) in obj where !unsafeJSONKeys.contains(k) { out[k] = stripPrototypeKeys(v) }
        return .object(out)
    default: return value
    }
}

/// A section whose stored value did not fit; its defaults were used instead.
public struct SectionProblem: Equatable, Sendable {
    /// Top-level key of the section.
    public var section: String
    public var message: String
    public init(section: String, message: String) {
        self.section = section
        self.message = message
    }
}

/// Why a loaded document must not be written back.
public enum ReadOnlyReason: Equatable, Sendable {
    case newerVersion(version: Int, supported: Int, message: String)
    case migrationFailed(from: Int, message: String)
    case invalid(message: String)

    public var message: String {
        switch self {
        case .newerVersion(_, _, let m), .migrationFailed(_, let m), .invalid(let m): return m
        }
    }

    /// `newerVersion`, `migrationFailed` or `invalid`, as the TS `kind`.
    public var kind: String {
        switch self {
        case .newerVersion: return "newerVersion"
        case .migrationFailed: return "migrationFailed"
        case .invalid: return "invalid"
        }
    }
}

/// What happened while loading a document. Nothing in here is fatal.
public struct LoadReport: Equatable, Sendable {
    /// Set when the document was upgraded step by step from this older version.
    public var migratedFrom: Int?
    /// The version found in the input (`nil` when it had none).
    public var version: Int?
    /// Sections replaced by their defaults (see `loadSections`).
    public var problems: [SectionProblem] = []
    /// Set when the document must not be saved over: show it, never overwrite the stored one.
    public var readOnly: ReadOnlyReason?
    /// Top-level keys this build does not know; kept so a save can write them back.
    public var unknownKeys: [String] = []

    public init(migratedFrom: Int? = nil, version: Int? = nil, problems: [SectionProblem] = [], readOnly: ReadOnlyReason? = nil, unknownKeys: [String] = []) {
        self.migratedFrom = migratedFrom
        self.version = version
        self.problems = problems
        self.readOnly = readOnly
        self.unknownKeys = unknownKeys
    }

    /// True when something should be shown to the user.
    public var hasProblems: Bool { !problems.isEmpty || readOnly != nil }
}

/// One migration step: turns a document at version `from` into version `from + 1`. Throw to fail.
public typealias MigrationStep = (JSONObject) throws -> JSONObject

public struct MigrateOptions {
    /// The version this build writes.
    public var currentVersion: Int
    /// Steps keyed by the version they start from.
    public var steps: [Int: MigrationStep]
    /// Key holding the version (default `"version"`).
    public var versionKey: String
    /// Version assumed when the key is missing (default: `currentVersion`).
    public var missingVersion: Int?

    public init(currentVersion: Int, steps: [Int: MigrationStep] = [:], versionKey: String = "version", missingVersion: Int? = nil) {
        self.currentVersion = currentVersion
        self.steps = steps
        self.versionKey = versionKey
        self.missingVersion = missingVersion
    }
}

/// The input to `migrateDocument`: JSON text or a parsed value.
public enum DocumentInput {
    case text(String)
    case value(JSONValue)
}

/**
 Brings a stored document up to `currentVersion` by running one step per version (`steps[v]`
 turns version `v` into `v + 1`), as `migrateDocument` in `persistence/migrate.ts`:
 - Missing version: taken as `missingVersion` (default current); the key is added.
 - Newer than `currentVersion`: left alone and reported `readOnly`.
 - A missing or throwing step: the document is returned as it was and reported `readOnly`.
 - Keys the steps do not touch are kept.
 */
public func migrateDocument(_ input: DocumentInput, _ options: MigrateOptions) -> (doc: JSONObject, report: LoadReport) {
    let key = options.versionKey
    let target = options.currentVersion
    var parsed: JSONValue?
    switch input {
    case .text(let text): parsed = try? JSONValue.parse(text)
    case .value(let v): parsed = v
    }
    guard case .object(var original)? = parsed.map(stripPrototypeKeys) else {
        return ([key: .number(Double(target))], LoadReport(readOnly: .invalid(message: "document is not a JSON object")))
    }
    var found: Int?
    if case .number(let n)? = original[key], n.isFinite, n.rounded(.towardZero) == n, n >= 0 { found = Int(n) }
    let from = found ?? options.missingVersion ?? target
    var report = LoadReport(version: found)

    if from > target {
        report.readOnly = .newerVersion(version: from, supported: target, message: "document has version \(from), newer than the supported \(target)")
        return (original, report)
    }
    if from == target {
        original[key] = .number(Double(target))
        return (original, report)
    }
    var doc = original
    for step in from ..< target {
        guard let fn = options.steps[step] else {
            report.readOnly = .migrationFailed(from: step, message: "no migration step from version \(step)")
            return (original, report)
        }
        do {
            doc = try fn(doc)
        } catch {
            report.readOnly = .migrationFailed(from: step, message: "migration from version \(step) failed: \(errorMessage(error))")
            // Never hand back half-migrated values.
            return (original, report)
        }
        doc[key] = .number(Double(step + 1))
    }
    report.migratedFrom = from
    return (doc, report)
}

/// An error's message as TS shows `error.message`: `LocalizedError`'s description, else `String(describing:)`.
func errorMessage(_ error: Error) -> String {
    if let e = error as? LocalizedError, let d = e.errorDescription { return d }
    return String(describing: error)
}

/// A thrown reason a section did not parse.
public struct InvalidSectionValue: Error, CustomStringConvertible {
    public var description: String
    public init(_ description: String = "invalid value") { self.description = description }
}

/// How one top-level section is read.
public struct SectionSpec {
    public var key: String
    /// Validates / converts the stored value; throw (or return `nil`) to reject it.
    public var parse: (JSONValue) throws -> JSONValue?
    /// Used when the section is missing or rejected.
    public var defaults: () -> JSONValue

    public init(_ key: String, parse: @escaping (JSONValue) throws -> JSONValue?, defaults: @escaping () -> JSONValue) {
        self.key = key
        self.parse = parse
        self.defaults = defaults
    }
}

/**
 Reads `doc` one top-level section at a time: a section that does not parse is reported and
 replaced by its defaults; every other section is kept. Returns the values, the problems, and the
 keys no section describes (`unknown`, to write back on save). `ignore` defaults to `["version"]`.
 */
public func loadSections(_ doc: JSONValue, _ sections: [SectionSpec], ignore: [String] = ["version"]) -> (value: JSONObject, problems: [SectionProblem], unknown: JSONObject) {
    let source = doc.objectValue ?? JSONObject()
    var value = JSONObject()
    var problems: [SectionProblem] = []
    for spec in sections {
        guard let stored = source[spec.key] else {
            value[spec.key] = spec.defaults()
            continue
        }
        do {
            guard let parsed = try spec.parse(stored) else { throw InvalidSectionValue() }
            value[spec.key] = parsed
        } catch {
            problems.append(SectionProblem(section: spec.key, message: errorMessage(error)))
            value[spec.key] = spec.defaults()
        }
    }
    let known = Set(sections.map(\.key)).union(ignore)
    var unknown = JSONObject()
    for (k, v) in source where !known.contains(k) && !unsafeJSONKeys.contains(k) { unknown[k] = v }
    return (value, problems, unknown)
}

/// `migrateDocument` then `loadSections`, with one `LoadReport` (`problems` and `unknownKeys` filled in).
public func loadDocument(_ input: DocumentInput, _ sections: [SectionSpec], _ options: MigrateOptions, ignore: [String]? = nil) -> (value: JSONObject, problems: [SectionProblem], unknown: JSONObject, report: LoadReport) {
    let migrated = migrateDocument(input, options)
    var report = migrated.report
    let result = loadSections(report.readOnly?.kind == "invalid" ? .object(JSONObject()) : .object(migrated.doc), sections, ignore: ignore ?? [options.versionKey])
    report.problems = result.problems
    report.unknownKeys = result.unknown.keys
    return (result.value, result.problems, result.unknown, report)
}
