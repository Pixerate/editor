import Foundation

/**
 One thing an agent can work on through `MCPToolRouter`: an open document, canvas or window, with
 its own `ToolRegistry`. The app keeps it current (name, read-only reason) and attaches it to the
 router while it is open.
 */
@MainActor
public final class MCPToolTarget {
    /// A short, stable id agents pass as the target argument.
    public let id: String
    /// The registry the target's tools are called on.
    public let registry: ToolRegistry
    /// How the target is listed to agents (also accepted as the target argument).
    public var name: String
    /// Why the target can't be edited, or nil. While it is set, a write tool from the catalogue
    /// that the target's registry hides returns a clear "read-only" error.
    public var readOnlyReason: String?
    /// Extra members of the target's entry in the list tool (e.g. `"flavor": "slack"`).
    public var info: JSONObject

    /// When the target was attached or last activated: calls without the target argument go to
    /// the most recent one.
    var activatedAt = Date.distantPast

    public init(id: String = String(UUID().uuidString.prefix(8)).lowercased(), name: String, registry: ToolRegistry, readOnlyReason: String? = nil, info: JSONObject = [:]) {
        self.id = id
        self.name = name
        self.registry = registry
        self.readOnlyReason = readOnlyReason
        self.info = info
    }
}

/**
 The JSON-RPC side of the in-process MCP server: answers `initialize`, `ping`, `tools/list` and
 `tools/call`, and routes each call to one of several targets (open documents, canvases), each
 with its own `ToolRegistry`.

 - `tools/list` returns the list tool (`list_<plural>`) and the **catalogue** registry's tools, never
   the open targets' (the server has no SSE stream, so it can't send `list_changed`, and clients
   list tools once when they connect). The catalogue should hold every tool an editable target has.
 - Every catalogue tool gets an optional target argument (`document`, `canvas`…), stripped before
   the call: a target id or name from the list tool. Without it the call goes to the target that was
   attached or activated last.
 - A tool the catalogue has but a read-only target's registry hides answers "…is read-only (reason)"
   rather than "Unknown tool".
 */
@MainActor
public final class MCPToolRouter {
    /// How the router names its targets and itself.
    public struct Configuration: Sendable {
        /// `serverInfo.name` in `initialize`, and the app named in messages ("Swash").
        public var serverName: String
        /// `serverInfo.version`.
        public var serverVersion: String
        /// What a target is ("document", "canvas"); the target argument's name.
        public var singular: String
        /// The plural ("documents", "canvases"): the list tool is `list_<plural>` and lists them under `<plural>`.
        public var plural: String
        /// The list tool's description (default: "Lists the <plural> open in <app>…").
        public var listToolDescription: String
        /// The error when no target is open (default: "No <plural> are open in <app>.").
        public var noTargetsMessage: String
        /// `instructions` in the `initialize` result, if any.
        public var instructions: String?

        public init(serverName: String, serverVersion: String, singular: String = "document", plural: String? = nil, listToolDescription: String? = nil, noTargetsMessage: String? = nil, instructions: String? = nil) {
            let plural = plural ?? singular + "s"
            self.serverName = serverName
            self.serverVersion = serverVersion
            self.singular = singular
            self.plural = plural
            self.listToolDescription = listToolDescription
                ?? "Lists the \(plural) open in \(serverName), most recently active first, with each one's id, name and readOnly status. Pass an id or name as the `\(singular)` argument of any other tool."
            self.noTargetsMessage = noTargetsMessage ?? "No \(plural) are open in \(serverName). Open one first."
            self.instructions = instructions
        }

        /// The list tool's name, `list_<plural>`.
        public var listToolName: String { "list_\(plural)" }
    }

    public let configuration: Configuration
    /// The registry whose tools `tools/list` advertises (see the type's notes).
    public let catalog: ToolRegistry
    /// Who tool calls are attributed to.
    public var actor = ToolActor(id: "mcp", name: "MCP Client")

    private var targets: [ObjectIdentifier: MCPToolTarget] = [:]

    public init(configuration: Configuration, catalog: ToolRegistry) {
        self.configuration = configuration
        self.catalog = catalog
    }

    /// The attached targets, most recently activated first.
    public var orderedTargets: [MCPToolTarget] {
        targets.values.sorted { $0.activatedAt > $1.activatedAt }
    }

    /// The target calls without the target argument go to.
    public var defaultTarget: MCPToolTarget? { orderedTargets.first }

    /// Starts routing to a target and makes it the default.
    public func attach(_ target: MCPToolTarget) {
        target.activatedAt = Date()
        targets[ObjectIdentifier(target)] = target
    }

    /// Makes a target the default (its window became active).
    public func activate(_ target: MCPToolTarget) {
        guard targets[ObjectIdentifier(target)] != nil else { return }
        target.activatedAt = Date()
    }

    /// Stops routing to a target.
    public func detach(_ target: MCPToolTarget) {
        targets.removeValue(forKey: ObjectIdentifier(target))
    }

    /// A target by id, then by name (case-insensitive); the default one for nil or "".
    public func resolveTarget(_ key: String?) -> MCPToolTarget? {
        let ordered = orderedTargets
        guard let key, !key.isEmpty else { return ordered.first }
        return ordered.first { $0.id.caseInsensitiveCompare(key) == .orderedSame }
            ?? ordered.first { $0.name.caseInsensitiveCompare(key) == .orderedSame }
    }

    // MARK: Tools

    /// What `tools/list` returns: the list tool, then the catalogue with the target argument.
    public func listTools() -> [McpToolDefinition] {
        [listToolDefinition()] + catalog.listTools().map(withTargetArgument)
    }

    private func listToolDefinition() -> McpToolDefinition {
        let title = "List Open \(configuration.plural.prefix(1).uppercased() + configuration.plural.dropFirst())"
        return McpToolDefinition(
            name: configuration.listToolName,
            title: title,
            description: configuration.listToolDescription,
            inputSchema: ["type": "object", "properties": [:], "additionalProperties": false],
            annotations: ToolAnnotations(title: title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false)
        )
    }

    /// Whether a tool defines the target argument itself, in which case it is passed through.
    private func definesTargetArgument(_ def: McpToolDefinition) -> Bool {
        def.inputSchema.objectValue?["properties"]?.objectValue?[configuration.singular] != nil
    }

    /// A catalogue tool with the optional target argument added to its schema.
    public func withTargetArgument(_ def: McpToolDefinition) -> McpToolDefinition {
        guard var schema = def.inputSchema.objectValue, !definesTargetArgument(def) else { return def }
        var properties = schema["properties"]?.objectValue ?? JSONObject()
        properties[configuration.singular] = [
            "type": "string",
            "description": .string("Optional \(configuration.singular) id or name from \(configuration.listToolName). Defaults to the \(configuration.singular) most recently active in \(configuration.serverName)."),
        ]
        schema["properties"] = .object(properties)
        var copy = def
        copy.inputSchema = .object(schema)
        return copy
    }

    /// The list tool's result.
    public func listTargetsResult() -> McpToolResult {
        let entries: [JSONValue] = orderedTargets.enumerated().map { index, target in
            var o: JSONObject = ["id": .string(target.id), "name": .string(target.name)]
            for (k, v) in target.info { o[k] = v }
            o["readOnly"] = .bool(target.readOnlyReason != nil)
            if let reason = target.readOnlyReason { o["readOnlyReason"] = .string(reason) }
            o["isActive"] = .bool(index == 0)
            return .object(o)
        }
        return McpToolResult(content: [.text(JSONValue.array(entries).stringified())], structuredContent: [configuration.plural: .array(entries)])
    }

    /// Calls a tool on the target its arguments name (or the default target).
    public func callTool(_ name: String, _ arguments: JSONObject) async -> McpToolResult {
        if name == configuration.listToolName { return listTargetsResult() }
        var args = arguments
        var key: String?
        let catalogTool = catalog.getTool(name)
        if catalogTool.map(definesTargetArgument) != true {
            key = args[configuration.singular]?.stringValue
            args[configuration.singular] = nil
        }
        guard let target = resolveTarget(key) else {
            let message = key.map { "No open \(configuration.singular) matches \"\($0)\". Call \(configuration.listToolName) to see the open \(configuration.plural)." }
                ?? configuration.noTargetsMessage
            return McpToolResult(content: [.text(message)], isError: true)
        }
        // A read-only target's registry hides its write tools, which would otherwise come back as
        // "Unknown tool" for a tool that tools/list advertised.
        if let reason = target.readOnlyReason, catalogTool != nil, !target.registry.hasTool(name) {
            return McpToolResult(content: [.text("\"\(target.name)\" is read-only (\(reason)), so \(name) can't edit it.")], isError: true)
        }
        return await target.registry.callTool(name, args, actor: actor)
    }

    // MARK: JSON-RPC

    /// Answers one JSON-RPC request; pass it to `MCPHTTPServer` / `MCPServerController`.
    public func handle(method: String, params: JSONObject?) async -> MCPDispatchResult {
        switch method {
        case "initialize":
            var result: JSONObject = [
                "protocolVersion": .string(MCPHTTP.negotiatedProtocolVersion(requested: params?["protocolVersion"]?.stringValue)),
                "capabilities": ["tools": [:]],
                "serverInfo": ["name": .string(configuration.serverName), "version": .string(configuration.serverVersion)],
            ]
            if let instructions = configuration.instructions { result["instructions"] = .string(instructions) }
            return .success(result)
        case "ping":
            return .success([:])
        case "tools/list":
            return .success(["tools": .array(listTools().map(\.json))])
        case "tools/call":
            guard let name = params?["name"]?.stringValue, !name.isEmpty else {
                return .failure(code: -32602, message: "Missing tool name.")
            }
            let result = await callTool(name, params?["arguments"]?.objectValue ?? JSONObject())
            return .success(result.json.objectValue ?? [:])
        default:
            return .failure(code: -32601, message: "Method not found: \(method)")
        }
    }
}
