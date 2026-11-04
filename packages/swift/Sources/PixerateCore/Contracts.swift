import Foundation

/// A contract file that does not have the shape its reader expects.
public struct ContractError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

extension ToolAnnotations {
    /// Annotations from MCP JSON (`readOnlyHint`, … and an optional `title`).
    public init(json: JSONValue) throws {
        guard let o = json.objectValue else { throw ContractError("Tool annotations must be an object.") }
        self.init(title: o["title"]?.stringValue, readOnlyHint: o["readOnlyHint"]?.boolValue, destructiveHint: o["destructiveHint"]?.boolValue, idempotentHint: o["idempotentHint"]?.boolValue, openWorldHint: o["openWorldHint"]?.boolValue)
    }
}

extension McpToolDefinition {
    /// A definition from MCP `tools/list` JSON, as the contracts store it.
    public init(json: JSONValue) throws {
        guard let o = json.objectValue, let name = o["name"]?.stringValue else { throw ContractError("A tool definition needs a name.") }
        guard let inputSchema = o["inputSchema"], inputSchema.objectValue != nil else { throw ContractError("Tool \(name) needs an inputSchema object.") }
        self.init(name: name, title: o["title"]?.stringValue, description: o["description"]?.stringValue, inputSchema: inputSchema, outputSchema: o["outputSchema"], annotations: try o["annotations"].map(ToolAnnotations.init(json:)))
    }
}

/// One tool provider of a domain's `tools.json`: what it is called and the tools it offers.
public struct ToolProviderContract: Equatable, Sendable {
    public var id: String
    public var title: String?
    public var skill: String?
    public var tools: [McpToolDefinition]

    public init(json: JSONValue) throws {
        guard let o = json.objectValue, let id = o["id"]?.stringValue else { throw ContractError("A tool provider needs an id.") }
        guard let tools = o["tools"]?.arrayValue else { throw ContractError("Provider \(id) needs a tools array.") }
        self.id = id
        title = o["title"]?.stringValue
        skill = o["skill"]?.stringValue
        self.tools = try tools.map(McpToolDefinition.init(json:))
    }

    /// The providers of a `tools.json` file (`{ "providers": [...] }`).
    public static func providers(json: JSONValue) throws -> [ToolProviderContract] {
        guard let providers = json.objectValue?["providers"]?.arrayValue else { throw ContractError("tools.json needs a providers array.") }
        return try providers.map(ToolProviderContract.init(json:))
    }
}

/// A keyboard command of a domain's `commands.json`: its keys (`Mod` is Ctrl or Cmd) and the agent
/// tool that does the same, where there is one.
public struct ShortcutCommand: Equatable, Sendable {
    public var id: String
    public var label: String
    public var group: String
    public var keys: [String]
    public var tool: String?
    public var params: JSONValue

    public init(json: JSONValue) throws {
        guard let o = json.objectValue, let id = o["id"]?.stringValue, let label = o["label"]?.stringValue, let group = o["group"]?.stringValue else { throw ContractError("A command needs an id, a label and a group.") }
        self.id = id
        self.label = label
        self.group = group
        keys = (o["keys"]?.arrayValue ?? []).compactMap(\.stringValue)
        tool = o["tool"]?.stringValue
        params = o["params"] ?? ["type": "object", "properties": [:], "additionalProperties": false]
    }
}

// MARK: - Tool arguments

/// Tool arguments of the wrong type. The registry validates arguments against each tool's
/// `inputSchema` before a handler runs, so this means a handler read a key the schema does not have.
public struct ToolArgumentError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

extension JSONObject {
    /// The value at `key`, or nil when it is missing or `null`.
    public func argument(_ key: String) -> JSONValue? {
        guard let value = self[key], value != .null else { return nil }
        return value
    }

    public func string(_ key: String) throws -> String? {
        guard let value = argument(key) else { return nil }
        guard let s = value.stringValue else { throw ToolArgumentError("\(key) must be a string.") }
        return s
    }

    public func number(_ key: String) throws -> Double? {
        guard let value = argument(key) else { return nil }
        guard let n = value.numberValue else { throw ToolArgumentError("\(key) must be a number.") }
        return n
    }

    public func integer(_ key: String) throws -> Int? {
        guard let n = try number(key) else { return nil }
        guard n.rounded() == n, abs(n) < 9.007_199_254_740_992e15 else { throw ToolArgumentError("\(key) must be a whole number.") }
        return Int(n)
    }

    public func bool(_ key: String) throws -> Bool? {
        guard let value = argument(key) else { return nil }
        guard let b = value.boolValue else { throw ToolArgumentError("\(key) must be true or false.") }
        return b
    }

    public func array(_ key: String) throws -> [JSONValue]? {
        guard let value = argument(key) else { return nil }
        guard let a = value.arrayValue else { throw ToolArgumentError("\(key) must be an array.") }
        return a
    }

    public func strings(_ key: String) throws -> [String]? {
        try array(key)?.map { guard let s = $0.stringValue else { throw ToolArgumentError("\(key) must hold strings.") }; return s }
    }

    public func numbers(_ key: String) throws -> [Double]? {
        try array(key)?.map { guard let n = $0.numberValue else { throw ToolArgumentError("\(key) must hold numbers.") }; return n }
    }

    public func integers(_ key: String) throws -> [Int]? {
        try numbers(key)?.map { n in
            guard n.rounded() == n else { throw ToolArgumentError("\(key) must hold whole numbers.") }
            return Int(n)
        }
    }

    /// A string argument as one of an enum's cases.
    public func enumeration<E: RawRepresentable>(_ key: String, as type: E.Type) throws -> E? where E.RawValue == String {
        guard let s = try string(key) else { return nil }
        guard let e = E(rawValue: s) else { throw ToolArgumentError("\(key) has no option \"\(s)\".") }
        return e
    }

    /// String arguments as cases of an enum.
    public func enumerations<E: RawRepresentable>(_ key: String, as type: E.Type) throws -> [E]? where E.RawValue == String {
        try strings(key)?.map { s in
            guard let e = E(rawValue: s) else { throw ToolArgumentError("\(key) has no option \"\(s)\".") }
            return e
        }
    }

    /// `value`, or an error naming the missing required argument.
    public func required<T>(_ value: T?, _ key: String) throws -> T {
        guard let value else { throw ToolArgumentError("\(key) is required.") }
        return value
    }
}

// MARK: - Contract tables

/// Helpers for generated readers of contract tables (`ui.json` and the like), which turn the JSON
/// into typed values and name what is missing when a file does not match.
public enum ContractTable {
    public static func object(_ json: JSONValue, _ type: String) throws -> JSONObject {
        guard let o = json.objectValue else { throw ContractError("\(type) must be a JSON object.") }
        return o
    }

    public static func field<T>(_ value: T?, _ key: String, _ type: String) throws -> T {
        guard let value else { throw ContractError("\(type).\(key) is missing or has the wrong type.") }
        return value
    }

    public static func value<T>(_ json: JSONValue, _ type: String, _ read: (JSONValue?) throws -> T?) throws -> T {
        guard let value = try read(json) else { throw ContractError("An element is not a \(type).") }
        return value
    }

    public static func dictionary<T>(_ object: JSONObject, _ read: (JSONValue?) throws -> T?) throws -> [String: T] {
        var out: [String: T] = [:]
        for (key, json) in object {
            guard let value = try read(json) else { throw ContractError("Member \(key) has the wrong type.") }
            out[key] = value
        }
        return out
    }
}
