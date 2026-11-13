import Foundation
import PixerateContracts
import PixerateCore

/// The vector domain's contracts (`@pixerate/conformance` `domains/vector`), read from the bundled
/// files: every command agents run with `run_command` (id, label, group, keywords, description,
/// params schema and flags), the tool providers and the JSON Schema of a saved drawing. The
/// TypeScript core writes them (`vectorContracts` in `vector/contract.ts`).
public enum VectorContracts {
    /// A contract file of the vector domain as JSON (`commands.json`, `tools.json`, …).
    public static func json(_ file: String) throws -> JSONValue {
        try JSONValue.parse(ConformanceContracts.data("domains/vector/\(file)"))
    }

    /// The commands, in the order `createVectorCommands` registers them.
    public static func commands() throws -> [VectorCommandContract] {
        guard let list = try json("commands.json").arrayValue else { throw ContractError("commands.json must be an array.") }
        return try list.map(VectorCommandContract.init(json:))
    }

    /// The tool providers (`vector-commands`, `vector-effects`, `vector-generation`, `vector-style`) and their tools.
    public static func toolProviders() throws -> [ToolProviderContract] {
        try ToolProviderContract.providers(json: json("tools.json"))
    }

    /// The JSON Schema of a saved drawing (the `pixerate.editor-document` envelope of kind `vector`).
    public static func documentSchema() throws -> JSONValue {
        try json("document.schema.json")
    }
}

/// One command of `commands.json`.
public struct VectorCommandContract: Equatable, Sendable {
    public var id: String
    public var label: String
    public var group: String?
    public var keywords: [String]?
    public var description: String?
    /// The params schema, or nil for a command that takes none (`run_command` refuses any).
    public var params: JSONObject?
    /// Default shortcut(s) as written (`Mod` is ⌘ / Ctrl).
    public var shortcut: [String]
    public var scope: String?
    /// The spec runs in one history step (`undoable`; unset is false).
    public var undoable: Bool
    public var readOnly: Bool
    public var hidden: Bool

    public init(json value: JSONValue) throws {
        guard let o = value.objectValue, let id = o["id"]?.stringValue, let label = o["label"]?.stringValue else { throw ContractError("A command needs an id and a label.") }
        self.id = id
        self.label = label
        group = o["group"]?.stringValue
        keywords = o["keywords"]?.arrayValue?.compactMap(\.stringValue)
        description = o["description"]?.stringValue
        params = o["params"]?.objectValue
        switch o["shortcut"] {
        case .string(let s)?: shortcut = [s]
        case .array(let a)?: shortcut = a.compactMap(\.stringValue)
        default: shortcut = []
        }
        scope = o["scope"]?.stringValue
        undoable = o["undoable"]?.boolValue ?? false
        readOnly = o["readOnly"]?.boolValue ?? false
        hidden = o["hidden"]?.boolValue ?? false
    }
}
