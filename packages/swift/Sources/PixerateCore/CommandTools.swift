import Foundation

public struct CommandToolProviderOptions<Context> {
    /// Provider id (default `commands`).
    public var id: String
    /// Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `""` for bare names.
    public var namespace: String?
    /// Context for enablement and runs (default: the registry's).
    public var context: (() -> Context)?
    /// Only expose global commands plus these scopes.
    public var scope: [String]?
    /// Commands agents may not see or run (e.g. ones that open dialogs).
    public var exclude: ((String) -> Bool)?
    /**
     Commands also listed as tools of their own, beside `run_command`: the params schema is the
     tool's input schema, and the label, description and read-only flag carry over. Agents then see
     them without calling `list_commands` first. For a list of ids, pass `{ ids.contains($0) }`.
     */
    public var tools: ((String) -> Bool)?
    /**
     Name of a command's own tool (default: the id with every character other than letters, digits,
     `_` and `-` replaced by `_`, so `canvas.circle` is `canvas_circle`).
     */
    public var toolName: ((String) -> String)?

    public init(id: String = "commands", namespace: String? = nil, context: (() -> Context)? = nil, scope: [String]? = nil, exclude: ((String) -> Bool)? = nil, tools: ((String) -> Bool)? = nil, toolName: ((String) -> String)? = nil) {
        self.id = id
        self.namespace = namespace
        self.context = context
        self.scope = scope
        self.exclude = exclude
        self.tools = tools
        self.toolName = toolName
    }
}

/// What `JSON.parse(JSON.stringify(value))` gives: `undefined` and non-finite numbers become `null`, `-0` becomes `0`.
public func commandResultJSON(_ value: JSONValue?) -> JSONValue {
    guard let value else { return .null }
    switch value {
    case .number(let n): return n.isFinite ? .number(n == 0 ? 0 : n) : .null
    case .array(let items): return .array(items.map { commandResultJSON($0) })
    case .object(let o): return .object(JSONObject(o.map { ($0.key, commandResultJSON($0.value)) }))
    default: return value
    }
}

/// A handler's return value as `toToolResult` in TS reads it: an object with a `content` array is a
/// tool result, a string is a text block, anything else is JSON.
private func jsToolOutput(_ value: JSONValue) -> ToolOutput {
    if case .string(let s) = value { return .text(s) }
    guard case .object(let o) = value, case .array(let blocks)? = o["content"] else { return .value(value) }
    let content: [McpToolContent] = blocks.map { block in
        guard case .object(let b) = block else { return .other(JSONObject()) }
        if b["type"] == "text", case .string(let t)? = b["text"] { return .text(t) }
        if b["type"] == "image", case .string(let d)? = b["data"], case .string(let m)? = b["mimeType"] { return .image(data: d, mimeType: m) }
        return .other(b)
    }
    return .result(McpToolResult(content: content, structuredContent: o["structuredContent"]?.objectValue, isError: o["isError"] == .bool(true)))
}

private func commandErrorResult(_ f: CommandFailure) -> McpToolResult {
    var error: JSONObject = ["code": .string(f.code.rawValue), "message": .string(f.message), "command": .string(f.id)]
    if let details = f.details { error["details"] = .array(details.map(\.json)) }
    return McpToolResult(content: [.text("\(f.code.rawValue): \(f.message)")], structuredContent: ["error": .object(error)], isError: true)
}

private struct RefError: Error, LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

private struct Rollback: Error {}

private func isWordUnit(_ u: UInt16) -> Bool { (48 ... 57).contains(u) || (65 ... 90).contains(u) || (97 ... 122).contains(u) || u == 95 }

/// Matches `^\$(\d+|last)((?:\.[\w-]+|\[\d+\])*)$`: the step text and the path's parts, or `nil`.
private func parseRef(_ value: String) -> (step: String, parts: [String])? {
    let u = Array(value.utf16)
    guard u.first == 0x24 else { return nil }
    var i = 1
    let step: String
    if i < u.count, (48 ... 57).contains(u[i]) {
        let start = i
        while i < u.count, (48 ... 57).contains(u[i]) { i += 1 }
        step = String(decoding: u[start ..< i], as: UTF16.self)
    } else if u.count >= 5, String(decoding: u[1 ..< 5], as: UTF16.self) == "last" {
        step = "last"
        i = 5
    } else {
        return nil
    }
    var parts: [String] = []
    while i < u.count {
        let start: Int
        if u[i] == 0x2E { // .[\w-]+
            i += 1
            start = i
            while i < u.count, isWordUnit(u[i]) || u[i] == 0x2D { i += 1 }
            guard i > start else { return nil }
            parts.append(String(decoding: u[start ..< i], as: UTF16.self))
        } else if u[i] == 0x5B { // \[\d+\]
            i += 1
            start = i
            while i < u.count, (48 ... 57).contains(u[i]) { i += 1 }
            guard i > start, i < u.count, u[i] == 0x5D else { return nil }
            parts.append(String(decoding: u[start ..< i], as: UTF16.self))
            i += 1
        } else {
            return nil
        }
    }
    return (step, parts)
}

/// `part in cur` then `cur[part]` for JSON values (own keys only; array indices and `length`).
private func member(_ cur: JSONValue, _ part: String) -> JSONValue? {
    switch cur {
    case .object(let o): return o[part]
    case .array(let a):
        if part == "length" { return .number(Double(a.count)) }
        guard JSONObject.isArrayIndex(part), let n = Int(part), n < a.count else { return nil }
        return a[n]
    default: return nil
    }
}

/// Replaces `"$N.path"` / `"$last.path"` strings with values from earlier results.
private func resolveRefs(_ value: JSONValue?, _ results: [JSONValue]) throws -> JSONValue? {
    guard let value else { return nil }
    switch value {
    case .string(let s):
        guard let ref = parseRef(s) else { return value }
        let index = ref.step == "last" ? Double(results.count - 1) : Double(ref.step)!
        if index < 0 || index >= Double(results.count) {
            throw RefError(message: "\"\(s)\" refers to step \(ref.step), but only \(results.count) step\(results.count == 1 ? " has" : "s have") run.")
        }
        var cur = results[Int(index)]
        for part in ref.parts {
            guard let next = member(cur, part) else {
                throw RefError(message: "\"\(s)\": step \(JSONValue.jsNumber(index))'s result has no \"\(part)\".")
            }
            cur = next
        }
        return cur
    case .array(let items): return .array(try items.map { try resolveRefs($0, results)! })
    case .object(let o): return .object(JSONObject(try o.map { ($0.key, try resolveRefs($0.value, results)!) }))
    default: return value
    }
}

/**
 Exposes a `CommandRegistry` to agents through a `ToolRegistry`, a port of
 `createCommandToolProvider` in `commands/agentTools.ts`:

 - `list_commands {query?, enabledOnly?}`: ids, labels, params schemas, shortcuts and enablement
   (with the reason a command is disabled).
 - `run_command {id, params?}`: runs one command; disabled commands, unknown params and failures
   come back as `isError` results with a `{code, message, command}` error.
 - `run_commands {steps: [{id, params?}], stopOnError?, atomic?, label?}`: runs steps **in order**.
   A param string `"$0.id"` or `"$last.id"` is replaced by that path of an earlier step's result.
   By default each step is its own undo step and steps before a failure stay applied;
   `atomic: true` (on a registry with `history`) runs them as one undo step named `label` and
   takes everything back when one fails.

 With `tools`, chosen commands are also tools of their own (`canvas.circle` → `canvas_circle`, or
 `toolName`), taking the command's params as arguments.

 The id enum in `run_command`'s schema follows the registered commands, so the `ToolRegistry`
 announces a list change when commands are added or removed. Agent playback (`plan`) is not ported.
 */
public func createCommandToolProvider<Context>(_ registry: CommandRegistry<Context>, _ options: CommandToolProviderOptions<Context> = CommandToolProviderOptions()) -> AgentToolProvider {
    let context = { options.context?() ?? registry.context }
    let visible = { registry.list(scope: options.scope, context: context()).filter { !(options.exclude?($0.id) ?? false) } }
    let allowed = { (id: String) in registry.has(id) && !(options.exclude?(id) ?? false) && visible().contains { $0.id == id } }

    nonisolated(nonsending) func runOne(_ id: String, _ params: JSONValue?) async -> CommandResult {
        if !allowed(id) { return .failure(CommandFailure(id: id, code: .unknownCommand, message: "Unknown command \"\(id)\".")) }
        return await registry.executeAsync(id, params ?? .object(JSONObject()), context: context())
    }

    func stepRecord(_ result: CommandResult, _ value: JSONValue) -> JSONValue {
        switch result {
        case .ok(let id, _): return ["id": .string(id), "ok": true, "result": value]
        case .failure(let f): return ["id": .string(f.id), "ok": false, "code": .string(f.code.rawValue), "message": .string(f.message)]
        }
    }

    let listCommands = AgentTool(
        name: "list_commands",
        title: "List commands",
        description: "Lists the commands you can run with run_command: id, label, group, params (JSON Schema), shortcuts, and whether each is enabled now (with the reason when it is not).",
        inputSchema: [
            "type": "object",
            "properties": [
                "query": ["type": "string", "description": "Fuzzy filter on label, keywords, group and id."],
                "enabledOnly": ["type": "boolean", "description": "Only commands that can run now (default false)."],
            ],
            "additionalProperties": false,
        ],
        annotations: ToolAnnotations(title: "List commands", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false)
    ) { args, _ in
        let query = args["query"]?.stringValue ?? ""
        var entries = visible()
        if args["enabledOnly"] == .bool(true) { entries = entries.filter(\.enabled) }
        if !query.jsTrimmed.isEmpty { entries = rankCommands(query, entries, RankCommandsOptions(disabledLast: false)).map(\.entry) }
        let commands: [JSONValue] = entries.map { e in
            var o: JSONObject = ["id": .string(e.id), "label": .string(e.label)]
            if let group = e.group, !group.isEmpty { o["group"] = .string(group) }
            if let description = e.description, !description.isEmpty { o["description"] = .string(description) }
            if let params = e.params { o["params"] = .object(params) }
            if !e.shortcuts.isEmpty { o["shortcuts"] = .array(e.shortcuts.map { .string($0) }) }
            o["enabled"] = .bool(e.enabled)
            if let reason = e.disabledReason, !reason.isEmpty { o["disabledReason"] = .string(reason) }
            o["readOnly"] = .bool(e.readOnly)
            return .object(o)
        }
        return .value(["commands": .array(commands)])
    }

    func runCommandTool() -> AgentTool {
        let ids = visible().map(\.id)
        var idSchema: JSONObject = ["type": "string", "description": "Command id from list_commands."]
        if !ids.isEmpty { idSchema["enum"] = .array(ids.map { .string($0) }) }
        return AgentTool(
            name: "run_command",
            title: "Run a command",
            description: "Runs one command by id with optional params (see list_commands for each command's params schema). Unknown params are rejected.",
            inputSchema: [
                "type": "object",
                "properties": [
                    "id": .object(idSchema),
                    "params": ["type": "object", "description": "Command parameters."],
                ],
                "required": ["id"],
                "additionalProperties": false,
            ],
            annotations: ToolAnnotations(title: "Run a command", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false)
        ) { args, _ in
            let result = await runOne(args["id"]?.stringValue ?? "", args["params"])
            switch result {
            case .ok(let id, let value): return .value(["id": .string(id), "ok": true, "result": commandResultJSON(value)])
            case .failure(let f): return .result(commandErrorResult(f))
            }
        }
    }

    let runCommands = AgentTool(
        name: "run_commands",
        title: "Run several commands",
        description: "Runs several commands in order: {steps: [{id, params?}], stopOnError?: true, atomic?: false, label?}. A param string \"$0.id\" or \"$last.id\" is replaced by that path of an earlier step's result, so you can use an id a step created without another round trip. Not atomic by default (each step is its own undo step and steps before a failure stay applied); atomic: true makes the batch one undo step named label and takes everything back if a step fails. Returns {completed, failed, skipped, results: [{id, ok, result | code, message}]}.",
        inputSchema: [
            "type": "object",
            "properties": [
                "steps": [
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 256,
                    "description": "Commands to run in order (at most 256).",
                    "items": [
                        "type": "object",
                        "properties": [
                            "id": ["type": "string", "description": "Command id."],
                            "params": ["type": "object", "description": "Command parameters; strings like \"$0.id\" or \"$last.series[0]\" refer to earlier results."],
                        ],
                        "required": ["id"],
                        "additionalProperties": false,
                    ],
                ],
                "stopOnError": ["type": "boolean", "description": "Stop at the first failing step (default true). Ignored when atomic."],
                "atomic": ["type": "boolean", "description": "Run every step as one undo step, all or nothing (default false). Needs a registry created with a history."],
                "label": ["type": "string", "description": "Undo step name for an atomic batch (default \"Run commands\")."],
            ],
            "required": ["steps"],
            "additionalProperties": false,
        ],
        annotations: ToolAnnotations(title: "Run several commands", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false)
    ) { args, _ in
        let list: [(id: String, params: JSONValue?)] = (args["steps"]?.arrayValue ?? []).map { ($0["id"]?.stringValue ?? "", $0["params"]) }
        let stopOnError = args["stopOnError"]?.boolValue ?? true
        let atomic = args["atomic"]?.boolValue ?? false
        let label = args["label"]?.stringValue ?? "Run commands"
        var completed = 0
        var failed = 0
        var results: [JSONValue] = []
        var values: [JSONValue] = []

        func summary(rolledBack: Bool?) -> JSONObject {
            var o: JSONObject = ["completed": .number(Double(rolledBack == true ? 0 : completed)), "failed": .number(Double(failed)), "skipped": .number(Double(list.count - completed - failed))]
            if let rolledBack { o["rolledBack"] = .bool(rolledBack) }
            o["results"] = .array(results)
            return o
        }
        func finish(_ s: JSONObject) -> ToolOutput {
            failed > 0 ? .result(McpToolResult(content: [.text(JSONValue.object(s).stringified())], structuredContent: s, isError: true)) : .value(.object(s))
        }

        if atomic {
            guard let history = registry.history else {
                let message = "atomic batches need a CommandRegistry created with { history }; run the steps without atomic, or ask the host to share its history."
                return .result(McpToolResult(content: [.text(message)], structuredContent: ["error": ["code": "unsupported", "message": .string(message)]], isError: true))
            }
            func syncRun(_ id: String, _ params: JSONValue?) -> CommandResult {
                if !allowed(id) { return .failure(CommandFailure(id: id, code: .unknownCommand, message: "Unknown command \"\(id)\".")) }
                if registry.get(id)?.isAsync == true {
                    return .failure(CommandFailure(id: id, code: .failed, message: "\"\(id)\" runs asynchronously and cannot be part of an atomic batch."))
                }
                return registry.execute(id, params ?? .object(JSONObject()), context: context())
            }
            func step(_ s: (id: String, params: JSONValue?)) -> Bool {
                let params: JSONValue?
                do {
                    params = try resolveRefs(s.params, values)
                } catch {
                    failed += 1
                    results.append(["id": .string(s.id), "ok": false, "code": "invalid_params", "message": .string(errorMessage(error))])
                    return false
                }
                let result = syncRun(s.id, params)
                if case .ok(_, let raw) = result {
                    completed += 1
                    let value = commandResultJSON(raw)
                    values.append(value)
                    results.append(stepRecord(result, value))
                    return true
                }
                failed += 1
                values.append(.null)
                results.append(stepRecord(result, .null))
                return false
            }
            // The batch rolls back on the throw: nothing stays applied.
            try? history.batch(label) {
                for s in list where !step(s) { throw Rollback() }
            }
            return finish(summary(rolledBack: failed > 0))
        }

        for s in list {
            let params: JSONValue?
            do {
                params = try resolveRefs(s.params, values)
            } catch {
                failed += 1
                values.append(.null)
                results.append(["id": .string(s.id), "ok": false, "code": "invalid_params", "message": .string(errorMessage(error))])
                if stopOnError { break }
                continue
            }
            let result = await runOne(s.id, params)
            if case .ok(_, let raw) = result {
                completed += 1
                let value = commandResultJSON(raw)
                values.append(value)
                results.append(stepRecord(result, value))
            } else {
                failed += 1
                values.append(.null)
                results.append(stepRecord(result, .null))
                if stopOnError { break }
            }
        }
        return finish(summary(rolledBack: nil))
    }

    let toolNameOf = { (id: String) -> String in
        if let name = options.toolName?(id) { return name }
        // `id.replace(/[^A-Za-z0-9_-]/g, '_')`, one `_` per UTF-16 unit.
        return String(id.utf16.map { isWordUnit($0) || $0 == 0x2D ? Character(Unicode.Scalar($0)!) : "_" })
    }

    /// One command as a tool of its own: its params are the arguments.
    func commandTool(_ entry: CommandEntry) -> AgentTool {
        AgentTool(
            name: toolNameOf(entry.id),
            title: entry.label,
            description: (entry.description ?? entry.label) + (entry.readOnly ? "" : " (Runs the \"\(entry.id)\" command; refused with the reason when it cannot run now.)"),
            inputSchema: entry.params.map { .object($0) } ?? ["type": "object", "properties": [:], "additionalProperties": false],
            annotations: ToolAnnotations(title: entry.label, readOnlyHint: entry.readOnly, destructiveHint: !entry.readOnly, idempotentHint: entry.readOnly, openWorldHint: false)
        ) { args, _ in
            switch await runOne(entry.id, .object(args)) {
            case .ok(_, let value): return jsToolOutput(commandResultJSON(value))
            case .failure(let f): return .result(commandErrorResult(f))
            }
        }
    }

    return AgentToolProvider(
        id: options.id,
        namespace: options.namespace,
        title: "Commands",
        description: "The app's commands (menu and keyboard actions) with their params schemas: list them, run one, or run several as one undo step.",
        skill: "pixerate-agent-tools",
        tools: {
            var tools = [listCommands, runCommandTool(), runCommands]
            if let picked = options.tools { tools += visible().filter { picked($0.id) }.map(commandTool) }
            return tools
        },
        subscribe: { notify in registry.subscribe(notify) }
    )
}
