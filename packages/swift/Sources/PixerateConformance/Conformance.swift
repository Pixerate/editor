import Foundation
import PixerateContracts
import PixerateCore

/// Replays the recorded scenarios of `@pixerate/conformance` (`domains/<domain>/fixtures`)
/// against a Swift editor and compares what it returns with what the TypeScript core returned:
/// the Swift side of `packages/core/src/tools/conformance.ts`. The normalization rules are the
/// same, rule for rule (see the package README), so both sides compare the same values.

/// What a scenario runs against: a tool registry plus ways to read the document and pixels.
public protocol ConformanceHost {
    func callTool(_ name: String, _ args: JSONObject) async -> McpToolResult
    /// The saved document (for paint, the `pixerate.editor-document` envelope).
    func document() throws -> JSONValue
    /// The composited canvas as RGBA; `paper: false` leaves the paper out.
    func pixels(paper: Bool?) throws -> ConformanceImage
    /// Whether a string is an id this implementation generated in its own format.
    func isGeneratedId(_ value: String) -> Bool
    /// What the canvases draw, as plain data (the vector scene), for steps with `render: true`;
    /// nil (the default) for an editor without render data.
    func render() throws -> JSONValue?
}

extension ConformanceHost {
    public func render() throws -> JSONValue? { nil }
}

/// Straight (not premultiplied) 8-bit RGBA, rows top to bottom.
public struct ConformanceImage: Equatable, Sendable {
    public var width: Int
    public var height: Int
    public var data: [UInt8]

    public init(width: Int, height: Int, data: [UInt8]) {
        self.width = width
        self.height = height
        self.data = data
    }
}

// MARK: - Scenarios

public struct ConformanceStep: Sendable {
    public var tool: String
    public var arguments: JSONObject
    public var document: Bool
    /// Also compare the render data (`render: true`).
    public var render: Bool
    /// nil: no snapshot; otherwise the `paper` option (nil when unset).
    public var pixels: PixelSnapshot?
    public var ignore: [String]
    public var expect: JSONObject

    public struct PixelSnapshot: Sendable {
        public var paper: Bool?
    }
}

public struct ConformanceScenario: Sendable {
    /// The domain whose `fixtures/` folder holds it (`paint`).
    public var domain: String
    public var id: String
    public var description: String
    public var setup: JSONObject
    public var skip: [String: String]
    public var steps: [ConformanceStep]

    public init(json: JSONValue, domain: String) throws {
        guard let o = json.objectValue, let id = o["id"]?.stringValue, let steps = o["steps"]?.arrayValue else { throw ContractError("A scenario needs an id and steps.") }
        self.domain = domain
        self.id = id
        description = o["description"]?.stringValue ?? ""
        setup = o["setup"]?.objectValue ?? JSONObject()
        skip = Dictionary(uniqueKeysWithValues: (o["skip"]?.objectValue ?? JSONObject()).compactMap { k, v in v.stringValue.map { (k, $0) } })
        self.steps = try steps.map { step in
            guard let s = step.objectValue, let tool = s["tool"]?.stringValue, let expect = s["expect"]?.objectValue else { throw ContractError("\(id): every step needs a tool and a recorded expect.") }
            var pixels: ConformanceStep.PixelSnapshot?
            switch s["pixels"] {
            case .bool(true): pixels = .init(paper: nil)
            case .object(let p): pixels = .init(paper: p["paper"]?.boolValue)
            default: pixels = nil
            }
            return ConformanceStep(tool: tool, arguments: s["arguments"]?.objectValue ?? JSONObject(), document: s["document"]?.boolValue == true, render: s["render"]?.boolValue == true, pixels: pixels, ignore: (s["ignore"]?.arrayValue ?? []).compactMap(\.stringValue), expect: expect)
        }
    }

    /// Every scenario of a domain, in file order.
    public static func load(domain: String) throws -> [ConformanceScenario] {
        let dir = ConformanceContracts.url("domains/\(domain)/fixtures")
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") && !$0.hasPrefix("_") }.sorted()
        return try files.map { try ConformanceScenario(json: JSONValue.parse(Data(contentsOf: dir.appendingPathComponent($0))), domain: domain) }
    }
}

// MARK: - Normalization

/// Maps generated ids to `@n` placeholders and back, across a whole scenario.
public final class ConformanceIds {
    private var toPlaceholder: [String: String] = [:]
    private var fromPlaceholder: [String: String] = [:]
    private var order: [String] = []

    public init() {}

    @discardableResult
    public func add(_ id: String) -> String {
        if let p = toPlaceholder[id] { return p }
        let p = "@\(toPlaceholder.count + 1)"
        toPlaceholder[id] = p
        fromPlaceholder[p] = id
        order.append(id)
        return p
    }

    public func placeholder(_ id: String) -> String? { toPlaceholder[id] }
    public func resolve(_ placeholder: String) -> String? { fromPlaceholder[placeholder] }

    /// `text` with every known id in it replaced by its placeholder (longest ids first).
    public func replaceWithin(_ text: String) -> String {
        if let exact = toPlaceholder[text] { return exact }
        var out = text
        for id in order.sorted(by: { $0.utf16.count > $1.utf16.count }) where out.contains(id) {
            out = out.replacingOccurrences(of: id, with: toPlaceholder[id]!)
        }
        return out
    }
}

private func isPlaceholder(_ s: String) -> Bool {
    guard s.utf8.count >= 2, s.hasPrefix("@") else { return false }
    let digits = s.utf8.dropFirst()
    return digits.first != UInt8(ascii: "0") && digits.allSatisfy { $0 >= 48 && $0 <= 57 }
}

private func isBase64Character(_ c: UInt16) -> Bool {
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 43 || c == 47 || c == 61 || c == 95 || c == 45
}

/// Strings at least this long made only of base64 characters are binary payloads.
public let conformanceBinaryMinLength = 200

private func isBinary(_ s: String) -> Bool {
    s.hasPrefix("data:") || (s.utf16.count >= conformanceBinaryMinLength && s.utf16.allSatisfy(isBase64Character))
}

private let timestamp = try! NSRegularExpression(pattern: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"#)

private func isTimestamp(_ s: String) -> Bool {
    timestamp.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

/// Keys sorted by UTF-16 code units, as JavaScript's default sort compares them.
private func sortedKeys(_ o: JSONObject) -> [String] {
    o.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
}

private func collectIds(_ value: JSONValue, _ ids: ConformanceIds, _ isId: (String) -> Bool) {
    switch value {
    case .string(let s): if isId(s) { ids.add(s) }
    case .array(let a): for item in a { collectIds(item, ids, isId) }
    case .object(let o):
        for k in sortedKeys(o) {
            if isId(k) { ids.add(k) }
            collectIds(o[k]!, ids, isId)
        }
    default: break
    }
}

private func replaceIds(_ value: JSONValue, _ ids: ConformanceIds) -> JSONValue {
    switch value {
    case .string(let s): return .string(isBinary(s) ? "<binary>" : isTimestamp(s) ? "<time>" : ids.replaceWithin(s))
    case .array(let a): return .array(a.map { replaceIds($0, ids) })
    case .object(let o):
        var out = JSONObject()
        for k in sortedKeys(o) { out[ids.replaceWithin(k)] = replaceIds(o[k]!, ids) }
        return .object(out)
    default: return value
    }
}

/// A value as scenarios store it (the package README's normalization rules).
public func normalizeConformanceValue(_ value: JSONValue, _ ids: ConformanceIds, isGeneratedId: (String) -> Bool = { _ in false }) -> JSONValue {
    collectIds(value, ids) { !isPlaceholder($0) && isGeneratedId($0) }
    return replaceIds(value, ids)
}

/// `value` without the members at `paths` (`/a/b`, `*` for every element or member).
public func omitConformancePaths(_ value: JSONValue, _ paths: [String]) -> JSONValue {
    paths.reduce(value) { v, path in omitPath(v, Array(path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init))) }
}

private func omitPath(_ value: JSONValue, _ parts: [String]) -> JSONValue {
    guard let head = parts.first else { return value }
    let rest = Array(parts.dropFirst())
    switch value {
    case .array(let a):
        if head == "*" { return .array(a.map { omitPath($0, rest) }) }
        guard let i = Int(head), i >= 0, i < a.count else { return value }
        if rest.isEmpty { return .array(a.enumerated().filter { $0.offset != i }.map(\.element)) }
        return .array(a.enumerated().map { $0.offset == i ? omitPath($0.element, rest) : $0.element })
    case .object(var o):
        let keys = head == "*" ? o.keys : (o.contains(head) ? [head] : [])
        for k in keys {
            // `nil` as a JSONValue would be JSON null: remove the member instead.
            if rest.isEmpty { o[k] = Optional<JSONValue>.none } else { o[k] = omitPath(o[k]!, rest) }
        }
        return .object(o)
    default: return value
    }
}

/// Arguments with each `@n` placeholder string replaced by the id it stands for.
public func resolveConformanceArguments(_ value: JSONValue, _ ids: ConformanceIds) throws -> JSONValue {
    switch value {
    case .string(let s) where isPlaceholder(s):
        guard let id = ids.resolve(s) else { throw ContractError("Placeholder \(s) is used before any result returned that id.") }
        return .string(id)
    case .array(let a): return .array(try a.map { try resolveConformanceArguments($0, ids) })
    case .object(let o):
        var out = JSONObject()
        for (k, v) in o { out[k] = try resolveConformanceArguments(v, ids) }
        return .object(out)
    default: return value
    }
}

/// The comparable part of a tool result: `structuredContent`, or the error's code, message and details.
public func conformanceResult(_ result: McpToolResult) -> (value: JSONValue, isError: Bool) {
    if result.isError {
        let error = result.structuredContent?["error"]?.objectValue ?? JSONObject()
        var value: JSONObject = ["code": .string(error["code"]?.stringValue ?? "tool_failed"), "message": .string(error["message"]?.stringValue ?? result.text ?? "")]
        if let details = error["details"] { value["details"] = details }
        return (["error": .object(value)], true)
    }
    if let structured = result.structuredContent { return (.object(structured), false) }
    guard let text = result.text else { return (.null, false) }
    return ((try? JSONValue.parse(text)) ?? .string(text), false)
}

// MARK: - Running and comparing

public struct ConformanceStepOutput: Sendable {
    public var result: JSONValue
    public var isError: Bool
    public var document: JSONValue?
    public var render: JSONValue?
    public var pixels: ConformanceImage?
}

/// Runs a scenario's calls in order against a fresh host.
public func runConformanceScenario(_ scenario: ConformanceScenario, host: some ConformanceHost) async throws -> [ConformanceStepOutput] {
    let ids = ConformanceIds()
    var outputs: [ConformanceStepOutput] = []
    for step in scenario.steps {
        guard case .object(let args) = try resolveConformanceArguments(.object(step.arguments), ids) else { continue }
        let (value, isError) = conformanceResult(await host.callTool(step.tool, args))
        var result = normalizeConformanceValue(value, ids, isGeneratedId: host.isGeneratedId)
        if !step.ignore.isEmpty { result = omitConformancePaths(result, step.ignore) }
        var output = ConformanceStepOutput(result: result, isError: isError)
        if step.document { output.document = normalizeConformanceValue(try host.document(), ids, isGeneratedId: host.isGeneratedId) }
        if step.render {
            guard let render = try host.render() else { throw ContractError("Step \(outputs.count + 1) (\(step.tool)) asks for render data, which this host does not have.") }
            output.render = normalizeConformanceValue(render, ids, isGeneratedId: host.isGeneratedId)
        }
        if let snapshot = step.pixels { output.pixels = try host.pixels(paper: snapshot.paper) }
        outputs.append(output)
    }
    return outputs
}

/// Numbers within this relative difference compare equal (floating point may differ in the last bits).
public let conformanceNumberTolerance = 1e-9

/// Whether two normalized values match: same structure and strings, numbers within tolerance.
public func conformanceValuesMatch(_ a: JSONValue, _ b: JSONValue) -> Bool {
    switch (a, b) {
    case (.number(let x), .number(let y)):
        return x == y || abs(x - y) <= conformanceNumberTolerance * max(1, abs(x), abs(y))
    case (.array(let x), .array(let y)):
        return x.count == y.count && zip(x, y).allSatisfy(conformanceValuesMatch)
    case (.object(let x), .object(let y)):
        return Set(x.keys) == Set(y.keys) && x.keys.allSatisfy { conformanceValuesMatch(x[$0]!, y[$0]!) }
    default:
        return a == b
    }
}

/// How far two images are apart, per channel (0–255).
public struct PixelDifference: Sendable {
    public var maxDelta: Int
    public var meanDelta: Double
}

public func pixelDifference(_ a: ConformanceImage, _ b: ConformanceImage) -> PixelDifference? {
    guard a.width == b.width, a.height == b.height, a.data.count == b.data.count, !a.data.isEmpty else { return nil }
    var maxDelta = 0
    var total = 0
    for i in 0..<a.data.count {
        let d = abs(Int(a.data[i]) - Int(b.data[i]))
        maxDelta = max(maxDelta, d)
        total += d
    }
    return PixelDifference(maxDelta: maxDelta, meanDelta: Double(total) / Double(a.data.count))
}

/// One way a step differed from its recording.
public struct ConformanceMismatch: CustomStringConvertible, Sendable {
    public var scenario: String
    public var step: Int
    public var tool: String
    public var message: String
    public var description: String { "\(scenario) step \(step) (\(tool)): \(message)" }
}

/// Compares a run with the scenario's recording. `decodePNG` reads a recorded snapshot.
public func compareConformance(_ scenario: ConformanceScenario, _ outputs: [ConformanceStepOutput], decodePNG: (URL) throws -> ConformanceImage) -> [ConformanceMismatch] {
    var mismatches: [ConformanceMismatch] = []
    let dir = ConformanceContracts.url("domains")
    for (i, step) in scenario.steps.enumerated() {
        func fail(_ message: String) { mismatches.append(ConformanceMismatch(scenario: scenario.id, step: i + 1, tool: step.tool, message: message)) }
        guard i < outputs.count else { fail("did not run"); continue }
        let out = outputs[i]
        let expectedResult = step.expect["result"] ?? .null
        if out.isError != (step.expect["isError"] == .bool(true)) || !conformanceValuesMatch(out.result, expectedResult) {
            fail("result \(out.result.stringified()) ≠ recorded \(expectedResult.stringified())")
        }
        if step.document, let expected = step.expect["document"], !conformanceValuesMatch(out.document ?? .null, expected) {
            fail("document differs from the recording")
        }
        if step.render, let expected = step.expect["render"], !conformanceValuesMatch(out.render ?? .null, expected) {
            fail("render data differs from the recording")
        }
        if step.pixels != nil, let recorded = step.expect["pixels"]?.objectValue, let file = recorded["file"]?.stringValue {
            guard let image = out.pixels else { fail("no pixels"); continue }
            do {
                let expected = try decodePNG(dir.appendingPathComponent("\(scenario.domain)/fixtures/\(file)"))
                guard let diff = pixelDifference(image, expected) else { fail("pixels are \(image.width)×\(image.height), recorded \(expected.width)×\(expected.height)"); continue }
                let maxAllowed = Int(recorded["maxDelta"]?.numberValue ?? 0)
                let meanAllowed = recorded["meanDelta"]?.numberValue ?? 0
                if diff.maxDelta > maxAllowed || diff.meanDelta > meanAllowed {
                    fail("pixels differ by up to \(diff.maxDelta) (mean \(diff.meanDelta)); allowed \(maxAllowed) (mean \(meanAllowed))")
                }
            } catch {
                fail("could not read \(file): \(error)")
            }
        }
    }
    return mismatches
}
