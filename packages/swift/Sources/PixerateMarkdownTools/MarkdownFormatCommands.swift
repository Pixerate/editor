// The format commands from `@pixerate/markdown-conformance` (`format.bold`, `format.heading`
// {level}, `format.codeBlock` {language}…) as `PixerateCore` commands on a Markdown text (#609),
// the Swift side of `createFormatCommands` in packages/core/src/commands/format.ts. They have the
// web ids, labels, groups, shortcuts and params schemas (all from the generated
// `FormatManifest`), so `createCommandToolProvider` exposes them to agents as the web does:
// `list_commands`, `run_command {id, params}` and `run_commands`.

import Foundation
import PixerateCore
import PixerateMarkdown

public struct MarkdownFormatCommandOptions {
    /// Id prefix (default `format.`), as the web's `prefix` option.
    public var prefix: String
    /// Scope the commands belong to, e.g. `editor`.
    public var scope: String?

    public init(prefix: String = "format.", scope: String? = nil) {
        self.prefix = prefix
        self.scope = scope
    }
}

/// What the web's `enabled` says when a command can't run at the selection.
private func disabledReason(_ id: String) -> String {
    switch id {
    case "format.bold": return "Cannot toggle bold at current selection."
    case "format.italic": return "Cannot toggle italic at current selection."
    case "format.strikethrough": return "Cannot toggle strikethrough at current selection."
    case "format.code": return "Cannot toggle inline code at current selection."
    case "format.link": return "Cannot modify link at current selection."
    case "format.paragraph": return "Cannot set paragraph at current selection."
    case "format.bulletList": return "Cannot toggle bullet list at current selection."
    case "format.numberedList": return "Cannot toggle numbered list at current selection."
    case "format.taskList": return "Cannot toggle task list at current selection."
    case "format.quote": return "Cannot toggle blockquote at current selection."
    case "format.codeBlock": return "Cannot toggle code block at current selection."
    case "format.table": return "Not inside a table."
    default: return "This command is not available right now."
    }
}

/**
 The format commands of the manifest, acting on `host`'s selection. Each run is one undo step on
 the host named after the command's label, and returns `true` when it changed the text (`false`
 when the toggle had nothing to do), as the web commands return their chain's result.
 `format.table` only reports whether the selection is in a table, as on the web.
 */
public func createMarkdownFormatCommands<Context>(_ host: MarkdownTextHost, _ options: MarkdownFormatCommandOptions = MarkdownFormatCommandOptions()) -> [CommandSpec<Context>] {
    FormatManifest.commands.map { definition -> CommandSpec<Context> in
        let canonical = definition.id.hasPrefix("format.") ? String(definition.id.dropFirst("format.".count)) : definition.id
        let params = definition.params.flatMap { try? JSONValue.parse($0).objectValue }

        func command(_ input: JSONObject?) -> FormatCommand? {
            var values: [String: FormatParamValue] = [:]
            if let level = input?["level"]?.numberValue { values["level"] = .int(Int(level)) }
            // Without a level (enablement checks), any heading level answers for the command.
            if definition.id == "format.heading" && values["level"] == nil { values["level"] = .int(1) }
            return FormatCommand(manifestID: definition.id, params: values)
        }

        let enabled: (Context, JSONObject?) throws -> CommandAvailability = { _, input in
            if let reason = host.readOnlyReason { return .disabledBecause(reason.isEmpty ? "The document is read-only." : reason) }
            let formatting = MarkdownFormatting(text: host.markdown)
            let selection = host.selectedRange
            if definition.id == "format.table" {
                return formatting.isInTable(selection) ? .enabled : .disabledBecause(disabledReason(definition.id))
            }
            if definition.id == "format.codeBlock", formatting.codeBlock(containing: selection) != nil { return .enabled }
            guard let cmd = command(input), formatting.isEnabled(cmd, selection: selection) else {
                if definition.id == "format.heading", let level = input?["level"]?.numberValue { return .disabledBecause("Cannot toggle heading level \(Int(level)).") }
                return .disabledBecause(disabledReason(definition.id))
            }
            return .enabled
        }

        let run: (Context, JSONObject) throws -> JSONValue? = { _, input in
            if let reason = host.readOnlyReason { throw MarkdownToolError(reason.isEmpty ? "The document is read-only." : reason) }
            let text = host.markdown
            let selection = host.selectedRange
            let edit: MarkdownEdit?
            switch definition.id {
            case "format.table":
                return .bool(MarkdownFormatting(text: text).isInTable(selection))
            case "format.link":
                edit = FormatCommandEdits.link(input["url"]?.stringValue, text: text, selection: selection)
            case "format.codeBlock" where input.contains("language"):
                let language = input["language"]?.stringValue
                edit = FormatCommandEdits.codeBlock(language: language?.isEmpty == true ? nil : language, text: text, selection: selection)
            default:
                guard let cmd = command(input) else { throw MarkdownToolError("Unknown parameters for \(definition.id).") }
                edit = FormatCommandEdits.edit(for: cmd, text: text, selection: selection)
            }
            guard let edit, let diff = MarkdownTextEdit.minimal(from: text, to: edit.text) else { return .bool(false) }
            try host.apply(MarkdownTextChange(edits: [diff], selection: edit.selection, actionName: command(input)?.label ?? definition.label))
            return .bool(true)
        }

        var shortcuts: [CommandShortcut] = definition.shortcut.map { [CommandShortcut($0.chord)] } ?? []
        // Parameterised shortcuts (Heading 1–3) are bound by the host, which knows the params.
        if !definition.variants.isEmpty { shortcuts = [] }
        return CommandSpec(
            id: options.prefix + canonical,
            label: definition.label,
            group: definition.group,
            params: params,
            shortcut: shortcuts,
            scope: options.scope,
            enabled: enabled,
            run: run
        )
    }
}

public struct MarkdownCommandToolProviderOptions {
    /// Provider id (default `commands`, as the web's `createCommandToolProvider`).
    public var id: String
    /// Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `""` for bare names.
    public var namespace: String?
    /// Options for the format commands.
    public var commands: MarkdownFormatCommandOptions

    public init(id: String = "commands", namespace: String? = nil, commands: MarkdownFormatCommandOptions = MarkdownFormatCommandOptions()) {
        self.id = id
        self.namespace = namespace
        self.commands = commands
    }
}

/**
 A `CommandRegistry` holding the format commands for `host`, and the `list_commands`,
 `run_command` and `run_commands` tools over it. Hosts with a registry of their own register
 `createMarkdownFormatCommands(host)` in it and call `createCommandToolProvider` themselves.
 `run_commands {atomic: true}` needs a registry with a history, so it isn't available here.
 */
public func createMarkdownCommandToolProvider(_ host: MarkdownTextHost, _ options: MarkdownCommandToolProviderOptions = MarkdownCommandToolProviderOptions()) -> (registry: CommandRegistry<Void>, provider: AgentToolProvider) {
    let registry = CommandRegistry<Void>(context: ())
    // The manifest's ids are valid and unique, and it has no chords the parser rejects (its tests check both).
    _ = try? registry.register(createMarkdownFormatCommands(host, options.commands))
    let provider = createCommandToolProvider(registry, CommandToolProviderOptions(id: options.id, namespace: options.namespace))
    return (registry, provider)
}
