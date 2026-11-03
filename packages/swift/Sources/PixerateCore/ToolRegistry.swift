import Foundation

/// The hints of a tool (MCP `annotations`).
public struct ToolAnnotations: Equatable, Sendable {
    public var title: String?
    public var readOnlyHint: Bool?
    public var destructiveHint: Bool?
    public var idempotentHint: Bool?
    public var openWorldHint: Bool?

    public init(title: String? = nil, readOnlyHint: Bool? = nil, destructiveHint: Bool? = nil, idempotentHint: Bool? = nil, openWorldHint: Bool? = nil) {
        self.title = title
        self.readOnlyHint = readOnlyHint
        self.destructiveHint = destructiveHint
        self.idempotentHint = idempotentHint
        self.openWorldHint = openWorldHint
    }

    var json: JSONValue {
        var o = JSONObject()
        if let title { o["title"] = .string(title) }
        if let readOnlyHint { o["readOnlyHint"] = .bool(readOnlyHint) }
        if let destructiveHint { o["destructiveHint"] = .bool(destructiveHint) }
        if let idempotentHint { o["idempotentHint"] = .bool(idempotentHint) }
        if let openWorldHint { o["openWorldHint"] = .bool(openWorldHint) }
        return .object(o)
    }
}

/// An MCP tool definition, as `tools/list` returns it.
public struct McpToolDefinition: Equatable, Sendable {
    public var name: String
    public var title: String?
    public var description: String?
    /// A JSON Schema with `type: "object"`.
    public var inputSchema: JSONValue
    public var outputSchema: JSONValue?
    public var annotations: ToolAnnotations?

    /// The definition as MCP JSON.
    public var json: JSONValue {
        var o: JSONObject = ["name": .string(name)]
        if let title { o["title"] = .string(title) }
        if let description { o["description"] = .string(description) }
        o["inputSchema"] = inputSchema
        if let outputSchema { o["outputSchema"] = outputSchema }
        if let annotations { o["annotations"] = annotations.json }
        return .object(o)
    }
}

/// One block of a tool result.
public enum McpToolContent: Equatable, Sendable {
    case text(String)
    case image(data: String, mimeType: String)
    /// Any other block, as JSON.
    case other(JSONObject)

    public var json: JSONValue {
        switch self {
        case .text(let t): return ["type": "text", "text": .string(t)]
        case .image(let d, let m): return ["type": "image", "data": .string(d), "mimeType": .string(m)]
        case .other(let o): return .object(o)
        }
    }
}

/// An MCP `tools/call` result.
public struct McpToolResult: Equatable, Sendable {
    public var content: [McpToolContent]
    public var structuredContent: JSONObject?
    public var isError: Bool

    public init(content: [McpToolContent], structuredContent: JSONObject? = nil, isError: Bool = false) {
        self.content = content
        self.structuredContent = structuredContent
        self.isError = isError
    }

    /// The first text block.
    public var text: String? {
        for c in content { if case .text(let t) = c { return t } }
        return nil
    }

    public var json: JSONValue {
        var o: JSONObject = ["content": .array(content.map(\.json))]
        if let structuredContent { o["structuredContent"] = .object(structuredContent) }
        if isError { o["isError"] = true }
        return .object(o)
    }
}

/// Who is calling a tool (an MCP client, a scripted agent).
public struct ToolActor: Equatable, Sendable {
    public var id: String
    public var name: String?
    public init(id: String, name: String? = nil) {
        self.id = id
        self.name = name
    }
}

public struct ToolCallContext: Sendable {
    /// The name the tool was called by (possibly namespaced).
    public var name: String
    /// Id of the provider that owns the tool.
    public var providerId: String
    /// Who is calling.
    public var actor: ToolActor?
}

/// What a handler returns; normalised into an `McpToolResult` (as `toToolResult`).
public enum ToolOutput: Sendable {
    /// An empty result.
    case none
    /// A text block.
    case text(String)
    /// JSON: an object is also `structuredContent`; any value becomes a JSON text block.
    case value(JSONValue)
    /// A full result, passed through.
    case result(McpToolResult)
}

public typealias AgentToolHandler = (JSONObject, ToolCallContext) async throws -> ToolOutput

/// A tool an agent can call: its definition and handler.
public struct AgentTool {
    public var definition: McpToolDefinition
    public var handler: AgentToolHandler

    public init(name: String, title: String? = nil, description: String? = nil, inputSchema: JSONValue, outputSchema: JSONValue? = nil, annotations: ToolAnnotations? = nil, handler: @escaping AgentToolHandler) {
        definition = McpToolDefinition(name: name, title: title, description: description, inputSchema: inputSchema, outputSchema: outputSchema, annotations: annotations)
        self.handler = handler
    }

    public var name: String { definition.name }
}

/// A source of tools, typically one per mounted editor.
public final class AgentToolProvider {
    /// Unique within a registry; the default namespace.
    public let id: String
    /// Prefix for its tools (`<namespace>__<name>`); defaults to `id`. `""` exposes bare names.
    public let namespace: String?
    public let title: String?
    public let description: String?
    /// The agent skill that documents these tools.
    public let skill: String?
    private let readTools: () -> [AgentTool]
    /// Lets the provider signal that its tools changed.
    let subscribe: ((@escaping () -> Void) -> Cancellable)?

    public init(id: String, namespace: String? = nil, title: String? = nil, description: String? = nil, skill: String? = nil, tools: @escaping () -> [AgentTool], subscribe: ((@escaping () -> Void) -> Cancellable)? = nil) {
        self.id = id
        self.namespace = namespace
        self.title = title
        self.description = description
        self.skill = skill
        readTools = tools
        self.subscribe = subscribe
    }

    public convenience init(id: String, namespace: String? = nil, title: String? = nil, description: String? = nil, skill: String? = nil, tools: [AgentTool]) {
        self.init(id: id, namespace: namespace, title: title, description: description, skill: skill, tools: { tools })
    }

    public var tools: [AgentTool] { readTools() }
}

/// A tool call as a middleware sees it (arguments already validated).
public struct ToolMiddlewareCall {
    /// The exposed (possibly namespaced) name.
    public var name: String
    public var tool: AgentTool
    public var provider: AgentToolProvider
    public var args: JSONObject
    public var context: ToolCallContext
}

/// Wraps every tool call of a registry (`use`): call `next()` to run the handler (or the next
/// middleware) and return its output. A throw becomes an `isError` result.
public typealias ToolMiddleware = (ToolMiddlewareCall, () async throws -> ToolOutput) async throws -> ToolOutput

public enum ToolErrorCode: String, Sendable {
    case unknownTool = "unknown_tool"
    case invalidArguments = "invalid_arguments"
    case toolFailed = "tool_failed"
}

/// The error in `structuredContent.error` of a failed call.
public struct ToolCallError: Equatable, Sendable {
    public var code: ToolErrorCode
    public var message: String
    public var tool: String
    public var details: [SchemaValidationError]?

    var json: JSONValue {
        var o: JSONObject = ["code": .string(code.rawValue), "message": .string(message), "tool": .string(tool)]
        if let details { o["details"] = .array(details.map(\.json)) }
        return .object(o)
    }
}

public struct ToolRegistryError: Error, LocalizedError, Equatable {
    public enum Code: String, Sendable { case duplicateProvider = "duplicate_provider", nameCollision = "name_collision", invalidTool = "invalid_tool" }
    public var code: Code
    public var message: String
    public var errorDescription: String? { message }
}

/// The toolset a provider belongs to: its namespace, or its id.
public struct ToolsetInfo: Equatable, Sendable {
    public var name: String
    public var title: String?
    public var description: String?
    public var skill: String?
    public var providers: [String]
    public var tools: [String]
}

/// Separator between namespace and tool name.
public let toolNamespaceSeparator = "__"

private func sanitizeNamespace(_ id: String) -> String {
    String(id.unicodeScalars.map { ($0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-")) ? Character($0) : "_" })
}

/// The tool's name without its namespace (`chart__get_chart` → `get_chart`).
public func baseToolName(_ name: String) -> String {
    guard let r = name.range(of: toolNamespaceSeparator, options: .backwards) else { return name }
    return String(name[r.upperBound...])
}

/// `unknown_tool` message, naming the tools a bare name could mean.
public func unknownToolMessage(_ name: String, _ candidates: [String] = []) -> String {
    candidates.count > 1
        ? "Tool \"\(name)\" is ambiguous: \(candidates.map { "\"\($0)\"" }.joined(separator: ", ")) all have that name. Call one of them by its full name."
        : "Unknown tool \"\(name)\". List the tools again; the editor that had it may have closed or become read-only."
}

/// An `isError` result carrying a `ToolCallError`.
public func errorResult(_ error: ToolCallError) -> McpToolResult {
    let details = (error.details ?? []).isEmpty ? "" : "\n" + error.details!.map { "- \($0.path): \($0.message)" }.joined(separator: "\n")
    return McpToolResult(content: [.text(error.message + details)], structuredContent: ["error": error.json], isError: true)
}

/// A handler's output as an MCP result.
public func toToolResult(_ output: ToolOutput) -> McpToolResult {
    switch output {
    case .none: return McpToolResult(content: [])
    case .text(let t): return McpToolResult(content: [.text(t)])
    case .result(let r): return r
    case .value(let v): return McpToolResult(content: [.text(v.stringified())], structuredContent: v.objectValue)
    }
}

private let toolNamePattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_.-]{1,128}$")

/**
 A registry of agent tools contributed by live providers, a port of `ToolRegistry` in
 `tools/registry.ts`: MCP-shaped `listTools()` and `callTool()`, namespaces, argument validation
 against each `inputSchema`, middleware, and list-changed notifications.
 */
public final class ToolRegistry {
    public enum Namespaces: Sendable { case always, onCollision }
    public enum OnCollision: Sendable { case namespace, error }

    private var entries: [(provider: AgentToolProvider, subscription: Cancellable?)] = []
    private var listeners: [(id: UUID, fn: ([McpToolDefinition]) -> Void)] = []
    private var middleware: [(id: UUID, fn: ToolMiddleware)] = []
    private let namespaces: Namespaces
    private let onCollision: OnCollision
    private let validateArguments: Bool
    private var lastSignature = ""

    public init(namespaces: Namespaces = .always, onCollision: OnCollision = .namespace, validateArguments: Bool = true) {
        self.namespaces = namespaces
        self.onCollision = onCollision
        self.validateArguments = validateArguments
        lastSignature = signature()
    }

    private struct Resolved {
        var name: String
        var tool: AgentTool
        var provider: AgentToolProvider
    }

    /// Registers a provider. Throws for a duplicate id, an invalid tool name, or (with
    /// `onCollision: .error`) a name collision. The `Cancellable` unregisters it.
    @discardableResult
    public func register(_ provider: AgentToolProvider) throws -> Cancellable {
        if entries.contains(where: { $0.provider.id == provider.id }) {
            throw ToolRegistryError(code: .duplicateProvider, message: "Tool provider \"\(provider.id)\" is already registered.")
        }
        for tool in provider.tools where toolNamePattern.firstMatch(in: tool.name, range: NSRange(location: 0, length: tool.name.utf16.count)) == nil {
            throw ToolRegistryError(code: .invalidTool, message: "Invalid tool name \"\(tool.name)\" from provider \"\(provider.id)\".")
        }
        entries.append((provider, nil))
        do {
            let names = try resolve(throwOnCollision: onCollision == .error).map(\.name)
            var seen = Set<String>()
            for name in names {
                if seen.contains(name) { throw ToolRegistryError(code: .nameCollision, message: "Tool name \"\(name)\" is exposed more than once.") }
                seen.insert(name)
            }
        } catch {
            entries.removeLast()
            throw error
        }
        if let subscribe = provider.subscribe {
            entries[entries.count - 1].subscription = subscribe { [weak self] in self?.notifyListChanged() }
        }
        notifyListChanged()
        return Cancellable { [weak self] in _ = self?.unregister(provider.id) }
    }

    /// Removes a provider by id. Returns whether it was registered.
    @discardableResult
    public func unregister(_ id: String) -> Bool {
        guard let index = entries.firstIndex(where: { $0.provider.id == id }) else { return false }
        let entry = entries.remove(at: index)
        entry.subscription?.cancel()
        notifyListChanged()
        return true
    }

    /// Adds a middleware around every call (the first added runs outermost).
    @discardableResult
    public func use(_ fn: @escaping ToolMiddleware) -> Cancellable {
        let id = UUID()
        middleware.append((id, fn))
        return Cancellable { [weak self] in self?.middleware.removeAll { $0.id == id } }
    }

    /// Registered provider ids in registration order.
    public var providerIds: [String] { entries.map(\.provider.id) }

    private func resolve(throwOnCollision: Bool = false) throws -> [Resolved] {
        func fixed(_ p: AgentToolProvider) -> String? {
            if let ns = p.namespace, !ns.isEmpty { return ns }
            return p.namespace == nil && namespaces == .always ? p.id : nil
        }
        var all: [Resolved] = []
        var counts: [String: Int] = [:]
        for (provider, _) in entries {
            let prefixed = fixed(provider) != nil
            for tool in provider.tools {
                all.append(Resolved(name: tool.name, tool: tool, provider: provider))
                if !prefixed { counts[tool.name, default: 0] += 1 }
            }
        }
        for k in all.indices {
            let explicit = fixed(all[k].provider)
            let prefix = explicit ?? ((counts[all[k].name] ?? 0) > 1 ? all[k].provider.id : nil)
            if let prefix {
                if throwOnCollision && explicit == nil {
                    throw ToolRegistryError(code: .nameCollision, message: "Tool \"\(all[k].name)\" from provider \"\(all[k].provider.id)\" collides with another provider's tool.")
                }
                all[k].name = sanitizeNamespace(prefix) + toolNamespaceSeparator + all[k].name
            }
        }
        return all
    }

    private func resolved() -> [Resolved] { (try? resolve()) ?? [] }

    private func lookup(_ name: String) -> (found: Resolved?, candidates: [String]) {
        let tools = resolved()
        if let exact = tools.first(where: { $0.name == name }) { return (exact, []) }
        let candidates = tools.filter { baseToolName($0.name) == name }
        return candidates.count == 1 ? (candidates[0], []) : (nil, candidates.map(\.name))
    }

    private func definition(_ r: Resolved) -> McpToolDefinition {
        var d = r.tool.definition
        d.name = r.name
        return d
    }

    /// MCP `tools/list`: every tool with its exposed name.
    public func listTools() -> [McpToolDefinition] { resolved().map(definition) }

    /// Whether a tool with this exposed name (or unique bare name) exists.
    public func hasTool(_ name: String) -> Bool { lookup(name).found != nil }

    /// A tool definition by exposed name (or unique bare name).
    public func getTool(_ name: String) -> McpToolDefinition? { lookup(name).found.map(definition) }

    /// The providers grouped by namespace, in listing order.
    public func toolsets() -> [ToolsetInfo] {
        var order: [String] = []
        var sets: [String: ToolsetInfo] = [:]
        for r in resolved() {
            let key = sanitizeNamespace((r.provider.namespace?.isEmpty == false ? r.provider.namespace : nil) ?? r.provider.id)
            if sets[key] == nil {
                sets[key] = ToolsetInfo(name: key, providers: [], tools: [])
                order.append(key)
            }
            if !sets[key]!.providers.contains(r.provider.id) { sets[key]!.providers.append(r.provider.id) }
            sets[key]!.title = sets[key]!.title ?? r.provider.title
            sets[key]!.description = sets[key]!.description ?? r.provider.description
            sets[key]!.skill = sets[key]!.skill ?? r.provider.skill
            sets[key]!.tools.append(r.name)
        }
        return order.map { sets[$0]! }
    }

    /**
     Calls a tool by exposed name. Never throws: unknown tools, invalid arguments and handler
     errors come back as `isError` results with a `ToolCallError` in `structuredContent.error`.
     */
    nonisolated(nonsending)
    public func callTool(_ name: String, _ args: JSONObject = JSONObject(), actor: ToolActor? = nil) async -> McpToolResult {
        let match = lookup(name)
        guard let found = match.found else {
            return errorResult(ToolCallError(code: .unknownTool, message: unknownToolMessage(name, match.candidates), tool: name))
        }
        let exposed = found.name
        // Arguments are untrusted model output: drop prototype keys before any handler sees them.
        let input = stripPrototypeKeys(.object(args)).objectValue ?? JSONObject()
        if validateArguments {
            let details = validateJSONSchema(.object(input), found.tool.definition.inputSchema)
            if !details.isEmpty {
                return errorResult(ToolCallError(code: .invalidArguments, message: "Invalid arguments for tool \"\(exposed)\".", tool: exposed, details: details))
            }
        }
        let context = ToolCallContext(name: exposed, providerId: found.provider.id, actor: actor)
        let call = ToolMiddlewareCall(name: exposed, tool: found.tool, provider: found.provider, args: input, context: context)
        let chain = middleware.map(\.fn)
        func run(_ i: Int) async throws -> ToolOutput {
            i < chain.count ? try await chain[i](call, { try await run(i + 1) }) : try await found.tool.handler(call.args, context)
        }
        do {
            return toToolResult(try await run(0))
        } catch {
            return errorResult(ToolCallError(code: .toolFailed, message: errorMessage(error), tool: exposed))
        }
    }

    /// Listens to changes of the exposed tool list (only real changes are reported).
    @discardableResult
    public func onListChanged(_ listener: @escaping ([McpToolDefinition]) -> Void) -> Cancellable {
        let id = UUID()
        listeners.append((id, listener))
        return Cancellable { [weak self] in self?.listeners.removeAll { $0.id == id } }
    }

    /// Checks the tool list and tells listeners when it changed; providers may call it directly.
    public func notifyListChanged() {
        let s = signature()
        guard s != lastSignature else { return }
        lastSignature = s
        let tools = listTools()
        for l in listeners { l.fn(tools) }
    }

    private func signature() -> String { JSONValue.array(listTools().map(\.json)).stringified() }

    /// Unregisters every provider and listener.
    public func dispose() {
        for e in entries { e.subscription?.cancel() }
        entries = []
        listeners = []
    }
}
