import Foundation

/// One problem `validateJSONSchema` found.
public struct SchemaValidationError: Equatable, Sendable {
    /// JSON-pointer-like path to the offending value, e.g. `/node/id` (`/` is the root).
    public var path: String
    public var message: String

    public init(path: String, message: String) {
        self.path = path
        self.message = message
    }

    public var json: JSONValue { ["path": .string(path), "message": .string(message)] }
}

/// Most `$ref` hops followed before a reference cycle is reported.
private let maxRefDepth = 32

/// The JSON-Schema-lite type of a value: `integer` for whole numbers, as `tools/schema.ts` reads them.
private func typeOf(_ value: JSONValue) -> String {
    switch value {
    case .null: return "null"
    case .array: return "array"
    case .number(let n): return n.isFinite && n.rounded(.towardZero) == n ? "integer" : "number"
    case .string: return "string"
    case .bool: return "boolean"
    case .object: return "object"
    }
}

private func matchesType(_ value: JSONValue, _ type: String) -> Bool {
    let actual = typeOf(value)
    if type == "number" { return actual == "number" || actual == "integer" }
    return actual == type
}

/// Resolves a local `$ref` (`#`, `#/$defs/a`, `#/definitions/a/properties/b`, …) against `root`.
private func resolveRef(_ ref: String, _ root: JSONValue) -> JSONValue? {
    if ref == "#" { return root }
    guard ref.hasPrefix("#/") else { return nil }
    var node: JSONValue? = root
    for raw in ref.dropFirst(2).split(separator: "/", omittingEmptySubsequences: false) {
        let key = (String(raw).removingPercentEncoding ?? String(raw)).replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
        guard case .object(let obj)? = node else { return nil }
        node = obj[key]
    }
    if case .object? = node { return node }
    return nil
}

private func number(_ schema: JSONObject, _ key: String) -> Double? { schema[key]?.numberValue }

/// `String(n)` as JavaScript formats numbers in messages.
private func js(_ n: Double) -> String { JSONValue.jsNumber(n) }

/**
 Validates `value` against `schema` and returns every error found (empty: valid). A port of
 `validateJsonSchema` in `tools/schema.ts`, with the same keywords and messages: `type` (and
 arrays of types), `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`,
 `minItems`, `maxItems`, `uniqueItems`, `minimum`, `maximum`, `exclusiveMinimum`,
 `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `anyOf`, `oneOf`, `allOf`,
 `not` and local `$ref`s. Other keywords are ignored. When no `anyOf` / `oneOf` branch matches, the
 errors of the closest branch are reported.
 */
public func validateJSONSchema(_ value: JSONValue, _ schema: JSONValue?) -> [SchemaValidationError] {
    validate(value, schema, path: "", root: schema, refDepth: 0)
}

private func validate(_ value: JSONValue, _ schemaValue: JSONValue?, path: String, root: JSONValue?, refDepth: Int) -> [SchemaValidationError] {
    guard case .object(let schema)? = schemaValue else { return [] }
    var errors: [SchemaValidationError] = []
    let at = path.isEmpty ? "/" : path
    func recurse(_ child: JSONValue, _ childSchema: JSONValue?, _ childPath: String) -> [SchemaValidationError] {
        validate(child, childSchema, path: childPath, root: root, refDepth: refDepth)
    }

    if case .string(let ref)? = schema["$ref"] {
        let target = root.flatMap { resolveRef(ref, $0) }
        if target == nil {
            errors.append(.init(path: at, message: "Unresolvable schema reference \(ref)."))
        } else if refDepth >= maxRefDepth {
            errors.append(.init(path: at, message: "Schema reference \(ref) is nested too deeply."))
        } else {
            errors += validate(value, target, path: path, root: root, refDepth: refDepth + 1)
        }
        // Sibling keywords still apply (2019-09+ semantics).
    }

    if case .array(let all)? = schema["allOf"] {
        for branch in all { errors += recurse(value, branch, path) }
    }
    let anyOf = schema["anyOf"]?.arrayValue
    let oneOf = schema["oneOf"]?.arrayValue
    if let branches = anyOf ?? oneOf {
        let results = branches.map { recurse(value, $0, path) }
        let matching = results.filter(\.isEmpty).count
        if matching == 0 && !results.isEmpty {
            let closest = results.dropFirst().reduce(results[0]) { $1.count < $0.count ? $1 : $0 }
            errors.append(.init(path: at, message: "Does not match any allowed shape (\(branches.count) options); closest match failed with:"))
            errors += closest
        } else if oneOf != nil && anyOf == nil && matching > 1 {
            errors.append(.init(path: at, message: "Matches \(matching) shapes; exactly one is allowed."))
        }
    }
    if let not = schema["not"], recurse(value, not, path).isEmpty {
        errors.append(.init(path: at, message: "Matches a disallowed shape."))
    }

    if let typeValue = schema["type"] {
        let types: [String] = typeValue.arrayValue?.compactMap(\.stringValue) ?? [typeValue.stringValue].compactMap { $0 }
        if !types.contains(where: { matchesType(value, $0) }) {
            errors.append(.init(path: at, message: "Expected \(types.joined(separator: " | ")), got \(typeOf(value))."))
            return errors
        }
    }
    if let constant = schema["const"], value != constant {
        errors.append(.init(path: at, message: "Expected \(constant.stringified())."))
    }
    if case .array(let options)? = schema["enum"], !options.contains(value) {
        errors.append(.init(path: at, message: "Expected one of \(options.map { $0.stringified() }.joined(separator: ", ")), got \(value.stringified())."))
    }

    if case .string(let s) = value {
        let length = s.utf16.count
        if let min = number(schema, "minLength"), Double(length) < min {
            errors.append(.init(path: at, message: "Must be at least \(js(min)) characters."))
        }
        if let max = number(schema, "maxLength"), Double(length) > max {
            errors.append(.init(path: at, message: "Must be at most \(js(max)) characters."))
        }
        if case .string(let pattern)? = schema["pattern"], let regex = try? NSRegularExpression(pattern: pattern) {
            // An invalid pattern in the schema is not the caller's fault: it is skipped.
            if regex.firstMatch(in: s, range: NSRange(location: 0, length: length)) == nil {
                errors.append(.init(path: at, message: "Must match pattern \(pattern)."))
            }
        }
    }

    if case .number(let n) = value {
        if let min = number(schema, "minimum"), n < min { errors.append(.init(path: at, message: "Must be >= \(js(min)).")) }
        if let max = number(schema, "maximum"), n > max { errors.append(.init(path: at, message: "Must be <= \(js(max)).")) }
        if let min = number(schema, "exclusiveMinimum"), n <= min { errors.append(.init(path: at, message: "Must be > \(js(min)).")) }
        if let max = number(schema, "exclusiveMaximum"), n >= max { errors.append(.init(path: at, message: "Must be < \(js(max)).")) }
        if let step = number(schema, "multipleOf"), step > 0 {
            let quotient = n / step
            if abs(quotient - jsRound(quotient)) > 1e-9 { errors.append(.init(path: at, message: "Must be a multiple of \(js(step)).")) }
        }
    }

    if case .array(let items) = value {
        if let min = number(schema, "minItems"), Double(items.count) < min { errors.append(.init(path: at, message: "Must have at least \(js(min)) items.")) }
        if let max = number(schema, "maxItems"), Double(items.count) > max { errors.append(.init(path: at, message: "Must have at most \(js(max)) items.")) }
        if schema["uniqueItems"] == .bool(true) {
            var seen = Set<String>()
            for (index, item) in items.enumerated() {
                let key = item.stringified()
                if seen.contains(key) { errors.append(.init(path: "\(path)/\(index)", message: "Duplicate item; items must be unique.")) }
                seen.insert(key)
            }
        }
        if let itemSchema = schema["items"] {
            for (index, item) in items.enumerated() { errors += recurse(item, itemSchema, "\(path)/\(index)") }
        }
    }

    if case .object(let obj) = value {
        for key in schema["required"]?.arrayValue?.compactMap(\.stringValue) ?? [] where !obj.contains(key) {
            errors.append(.init(path: "\(path)/\(key)", message: "Missing required property \"\(key)\"."))
        }
        let properties = schema["properties"]?.objectValue ?? JSONObject()
        for (key, child) in obj {
            if properties.contains(key) {
                errors += recurse(child, properties[key], "\(path)/\(key)")
            } else if schema["additionalProperties"] == .bool(false) {
                let known = properties.keys
                errors.append(.init(path: "\(path)/\(key)", message: "Unknown property \"\(key)\".\(closestName(key, known))\(known.isEmpty ? "" : " Allowed: \(known.joined(separator: ", ")).")"))
            } else if case .object? = schema["additionalProperties"] {
                errors += recurse(child, schema["additionalProperties"], "\(path)/\(key)")
            }
        }
    }

    return errors
}

/// Edit distance between two short strings (case-insensitive, over UTF-16 units as in TS).
func editDistance(_ a: String, _ b: String) -> Int {
    let x = Array(a.lowercased().utf16)
    let y = Array(b.lowercased().utf16)
    var row = Array(0 ... y.count)
    if x.isEmpty { return y.count }
    for i in 1 ... x.count {
        var prev = row[0]
        row[0] = i
        if y.isEmpty { continue }
        for j in 1 ... y.count {
            let tmp = row[j]
            row[j] = min(row[j] + 1, row[j - 1] + 1, prev + (x[i - 1] == y[j - 1] ? 0 : 1))
            prev = tmp
        }
    }
    return row[y.count]
}

/// ` Did you mean "x"?` for the nearest known name within a couple of edits, else "".
private func closestName(_ name: String, _ known: [String]) -> String {
    var best = ""
    var bestDistance = Int.max
    for k in known {
        let d = editDistance(name, k)
        if d < bestDistance {
            best = k
            bestDistance = d
        }
    }
    return !best.isEmpty && bestDistance <= max(1, min(2, name.utf16.count / 2)) ? " Did you mean \"\(best)\"?" : ""
}
