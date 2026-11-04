import Foundation
import PixerateContracts
import PixerateCore

/// The paint domain's contracts (`@pixerate/conformance` `domains/paint`), read from the bundled
/// files: the tools every paint provider offers, the keyboard commands, the UI tables and the JSON
/// Schema of a saved painting. The TypeScript core writes them; the generated types in
/// `Generated/` are made from the same files.
public enum PaintContracts {
    /// A contract file of the paint domain as JSON (`tools.json`, `ui.json`, …).
    public static func json(_ file: String) throws -> JSONValue {
        try JSONValue.parse(ConformanceContracts.data("domains/paint/\(file)"))
    }

    /// The tool providers (`paint-editor`, `paint-effects`, `brushes`, `paint-proposals`) and their tools.
    public static func toolProviders() throws -> [ToolProviderContract] {
        try ToolProviderContract.providers(json: json("tools.json"))
    }

    /// The definition of one paint tool.
    public static func tool(_ name: PaintToolName) throws -> McpToolDefinition {
        guard let tool = try toolProviders().lazy.flatMap(\.tools).first(where: { $0.name == name.rawValue }) else {
            throw ContractError("tools.json has no tool \(name.rawValue).")
        }
        return tool
    }

    /// The keyboard commands, in the order the editors list them.
    public static func commands() throws -> [ShortcutCommand] {
        guard let list = try json("commands.json").arrayValue else { throw ContractError("commands.json must be an array.") }
        return try list.map(ShortcutCommand.init(json:))
    }

    /// The tables the panels render.
    public static func uiTables() throws -> PaintUITables {
        try PaintUITables(json: json("ui.json"))
    }

    /// The JSON Schema of a saved painting (the `pixerate.editor-document` envelope of kind `paint`).
    public static func documentSchema() throws -> JSONValue {
        try json("document.schema.json")
    }
}
