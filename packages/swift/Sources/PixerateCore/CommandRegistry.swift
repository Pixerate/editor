import Foundation

/// Whether a command can run: `true`, `false`, or a reason it cannot ("Nothing to undo"). Boolean and
/// string literals convert, as `enabled` returns `boolean | string` in TS.
public enum CommandAvailability: Equatable, Sendable, ExpressibleByBooleanLiteral, ExpressibleByStringLiteral {
    case enabled
    /// Disabled without a reason ("This command is not available right now.").
    case disabled
    case disabledBecause(String)

    public init(booleanLiteral value: Bool) { self = value ? .enabled : .disabled }
    public init(stringLiteral value: String) { self = .disabledBecause(value) }
}

/// Whether a command can run now, and why not.
public struct CommandEnablement: Equatable, Sendable {
    public var enabled: Bool
    /// Why the command is disabled (only when `enabled` is false).
    public var reason: String?
}

/// How a command runs: synchronously, or `async` (only `executeAsync` and agent tools await it).
public enum CommandRun<Context> {
    case sync((Context, JSONObject) throws -> JSONValue?)
    case async((Context, JSONObject) async throws -> JSONValue?)
}

/**
 Metadata and implementation of one command, a port of `CommandSpec` in `commands/registry.ts`.
 Menus, shortcuts, the palette and agent tools all run commands by id, so every entry point shares
 enablement and validation. `run` returns the command's result as JSON (`nil` for `undefined`).
 Agent playback (`plan`, `playbackSurface`) is not ported.
 */
public struct CommandSpec<Context> {
    /// Unique id, e.g. `history.undo` or `canvas.alignLeft`.
    public var id: String
    public var label: String
    /// Group / menu name shown next to the label, e.g. `Edit` or `Arrange`.
    public var group: String?
    /// Extra search terms for the palette.
    public var keywords: [String]?
    public var description: String?
    /// Object JSON Schema for `params`. Unknown keys are rejected unless `additionalProperties` allows them.
    public var params: JSONObject?
    /// Default shortcut(s): platform-neutral chord text such as `Mod+Shift+Z`.
    public var shortcut: [CommandShortcut]
    /// Scope the command (and its shortcuts) belong to, e.g. `canvas`. Omit for global commands.
    public var scope: String?
    /**
     Whether the command can run. Receives the params a caller named, so a command acting on the
     selection can still run on targets passed explicitly (`nil` for menus). A throw disables it
     with the error's message.
     */
    public var enabled: ((Context, JSONObject?) throws -> CommandAvailability)?
    public var run: CommandRun<Context>
    /**
     Runs inside the registry's `history.batch(label, …)`, so all history entries the command records
     become one undo step and a throw rolls back its partial changes (synchronous commands only).
     */
    public var undoable: Bool
    /// The command only reads state (agent tools mark it read-only).
    public var readOnly: Bool
    /// Hide from the palette and `list()` unless `includeHidden` (still runnable by id).
    public var hidden: Bool

    public init(id: String, label: String, group: String? = nil, keywords: [String]? = nil, description: String? = nil, params: JSONObject? = nil, shortcut: [CommandShortcut] = [], scope: String? = nil, undoable: Bool = false, readOnly: Bool = false, hidden: Bool = false, enabled: ((Context, JSONObject?) throws -> CommandAvailability)? = nil, run: @escaping (Context, JSONObject) throws -> JSONValue?) {
        self.init(id: id, label: label, group: group, keywords: keywords, description: description, params: params, shortcut: shortcut, scope: scope, undoable: undoable, readOnly: readOnly, hidden: hidden, enabled: enabled, runner: .sync(run))
    }

    public init(id: String, label: String, group: String? = nil, keywords: [String]? = nil, description: String? = nil, params: JSONObject? = nil, shortcut: [CommandShortcut] = [], scope: String? = nil, undoable: Bool = false, readOnly: Bool = false, hidden: Bool = false, enabled: ((Context, JSONObject?) throws -> CommandAvailability)? = nil, runAsync: @escaping (Context, JSONObject) async throws -> JSONValue?) {
        self.init(id: id, label: label, group: group, keywords: keywords, description: description, params: params, shortcut: shortcut, scope: scope, undoable: undoable, readOnly: readOnly, hidden: hidden, enabled: enabled, runner: .async(runAsync))
    }

    public init(id: String, label: String, group: String?, keywords: [String]?, description: String?, params: JSONObject?, shortcut: [CommandShortcut], scope: String?, undoable: Bool, readOnly: Bool, hidden: Bool, enabled: ((Context, JSONObject?) throws -> CommandAvailability)?, runner: CommandRun<Context>) {
        self.id = id
        self.label = label
        self.group = group
        self.keywords = keywords
        self.description = description
        self.params = params
        self.shortcut = shortcut
        self.scope = scope
        self.undoable = undoable
        self.readOnly = readOnly
        self.hidden = hidden
        self.enabled = enabled
        self.run = runner
    }

    var isAsync: Bool { if case .async = run { return true }; return false }
}

public enum CommandErrorCode: String, Sendable {
    case unknownCommand = "unknown_command"
    case disabled
    case invalidParams = "invalid_params"
    case failed
}

/// A command that did not run, or failed.
public struct CommandFailure: Error, LocalizedError, Equatable, Sendable {
    public var id: String
    public var code: CommandErrorCode
    public var message: String
    public var details: [SchemaValidationError]?

    public init(id: String, code: CommandErrorCode, message: String, details: [SchemaValidationError]? = nil) {
        self.id = id
        self.code = code
        self.message = message
        self.details = details
    }

    public var errorDescription: String? { message }
}

/// What `execute` returns; never thrown.
public enum CommandResult: Equatable, Sendable {
    case ok(id: String, result: JSONValue?)
    case failure(CommandFailure)

    public var id: String {
        switch self {
        case .ok(let id, _): return id
        case .failure(let f): return f.id
        }
    }

    public var isOk: Bool { if case .ok = self { return true }; return false }

    /// The result as the TS object: `{ok, id, result}` or `{ok, id, code, message, details?}`.
    public var json: JSONValue {
        switch self {
        case .ok(let id, let result):
            var o: JSONObject = ["ok": true, "id": .string(id)]
            if let result { o["result"] = result }
            return .object(o)
        case .failure(let f):
            var o: JSONObject = ["ok": false, "id": .string(f.id), "code": .string(f.code.rawValue), "message": .string(f.message)]
            if let details = f.details { o["details"] = .array(details.map(\.json)) }
            return .object(o)
        }
    }
}

/// A command as listed for menus, palettes and agents.
public struct CommandEntry: Equatable, Sendable, RankableCommand {
    public var id: String
    public var label: String
    public var group: String?
    public var keywords: [String]?
    public var description: String?
    public var params: JSONObject?
    public var scope: String?
    /// Canonical chord text bound on the registry's platform (first = primary).
    public var shortcuts: [String]
    public var enabled: Bool
    /// Why the command is disabled (only when `enabled` is false).
    public var disabledReason: String?
    public var undoable: Bool
    public var readOnly: Bool

    public var isEnabledForRanking: Bool? { enabled }

    /// The entry as `list()` returns it in TS.
    public var json: JSONValue {
        var o: JSONObject = ["id": .string(id), "label": .string(label)]
        if let group { o["group"] = .string(group) }
        if let keywords { o["keywords"] = .array(keywords.map { .string($0) }) }
        if let description { o["description"] = .string(description) }
        if let params { o["params"] = .object(params) }
        if let scope { o["scope"] = .string(scope) }
        o["shortcuts"] = .array(shortcuts.map { .string($0) })
        o["enabled"] = .bool(enabled)
        if !enabled, let disabledReason { o["disabledReason"] = .string(disabledReason) }
        o["undoable"] = .bool(undoable)
        o["readOnly"] = .bool(readOnly)
        return .object(o)
    }
}

/// Minimal history surface (`HistoryManager` satisfies it).
public protocol CommandHistoryTarget: AnyObject {
    /// Runs `body` as one undo step; when it throws, its steps are undone and the error rethrown.
    func batch(_ name: String, _ body: () throws -> Void) rethrows
}

extension HistoryManager: CommandHistoryTarget {}

public struct CommandRegistryError: Error, LocalizedError, Equatable, Sendable {
    public enum Code: String, Sendable { case duplicateCommand = "duplicate_command", invalidCommand = "invalid_command" }
    public var code: Code
    public var message: String
    public var errorDescription: String? { message }
}

/// `^[A-Za-z0-9_.:-]{1,128}$`.
private func isValidCommandId(_ id: String) -> Bool {
    let b = Array(id.utf8)
    return (1 ... 128).contains(b.count) && b.allSatisfy { (48 ... 57).contains($0) || (65 ... 90).contains($0) || (97 ... 122).contains($0) || $0 == 95 || $0 == 46 || $0 == 58 || $0 == 45 }
}

private func enablement(_ result: CommandAvailability) -> CommandEnablement {
    switch result {
    case .enabled: return CommandEnablement(enabled: true)
    case .disabled: return CommandEnablement(enabled: false, reason: "This command is not available right now.")
    case .disabledBecause(let reason): return CommandEnablement(enabled: false, reason: reason)
    }
}

/// Error for params the command does not accept, naming the accepted keys.
private func unknownParams(_ params: JSONObject?, _ id: String, _ input: JSONObject) -> String? {
    let keys = input.keys
    if keys.isEmpty { return nil }
    if let additional = params?["additionalProperties"], additional != .bool(false) { return nil }
    let accepted = params?["properties"]?.objectValue?.keys ?? []
    guard let bad = keys.first(where: { k in !accepted.contains { $0.utf16.elementsEqual(k.utf16) } }) else { return nil }
    return "Unknown parameter \"\(bad)\" for command \"\(id)\"; expected \(accepted.isEmpty ? "no parameters" : accepted.map { "\"\($0)\"" }.joined(separator: ", "))."
}

/**
 Registry of commands, a port of `CommandRegistry` in `commands/registry.ts`: one id per action,
 shared by shortcuts (`shortcuts(for:)`), the command palette (`list` + `rankCommands`) and agent
 tools (`createCommandToolProvider`). Keyboard handling (`handleKeyDown`) and user shortcut
 overrides are not ported.
 */
public final class CommandRegistry<Context> {
    private struct Registered {
        var spec: CommandSpec<Context>
        var token: UUID
    }

    private struct Binding {
        var command: String
        var chord: Chord
        var scope: String?
        var platforms: [ShortcutPlatform]?
        var token: UUID
    }

    /// The platform `list()` resolves shortcuts for (default mac).
    public let platform: ShortcutPlatform
    /// The history `undoable` commands (and atomic agent batches) record into, if any.
    public let history: CommandHistoryTarget?

    private let readContext: () -> Context
    private var order: [String] = []
    private var commands: [String: Registered] = [:]
    private var bindings: [Binding] = []
    private var listeners: [(id: UUID, fn: () -> Void)] = []

    /// Monotonic counter bumped on every change (useful as a snapshot key).
    public private(set) var version = 0

    /// `context` is read on every call (a getter), as the TS option may be.
    public init(context: @escaping () -> Context, history: CommandHistoryTarget? = nil, platform: ShortcutPlatform = .mac) {
        readContext = context
        self.history = history
        self.platform = platform
    }

    public convenience init(context: Context, history: CommandHistoryTarget? = nil, platform: ShortcutPlatform = .mac) {
        self.init(context: { context }, history: history, platform: platform)
    }

    /// The default context.
    public var context: Context { readContext() }

    /**
     Registers commands and returns a `Cancellable` that unregisters them. Throws a
     `CommandRegistryError` for a duplicate or invalid id, or invalid chord text, registering nothing.
     */
    @discardableResult
    public func register(_ specs: [CommandSpec<Context>]) throws -> Cancellable {
        var seen = Set<String>()
        for s in specs {
            if !isValidCommandId(s.id) {
                throw CommandRegistryError(code: .invalidCommand, message: "Invalid command id \"\(s.id)\".")
            }
            if commands[s.id] != nil || seen.contains(s.id) {
                throw CommandRegistryError(code: .duplicateCommand, message: "Command \"\(s.id)\" is already registered.")
            }
            seen.insert(s.id)
        }
        // Parse every chord before registering anything, so a bad shortcut registers nothing.
        let tokens = specs.map { _ in UUID() }
        var added: [Binding] = []
        for (s, token) in zip(specs, tokens) {
            for item in s.shortcut {
                do {
                    added.append(Binding(command: s.id, chord: try parseChord(item.chord), scope: item.scope ?? s.scope, platforms: item.platforms, token: token))
                } catch {
                    throw CommandRegistryError(code: .invalidCommand, message: errorMessage(error))
                }
            }
        }
        bindings += added
        for (s, token) in zip(specs, tokens) {
            commands[s.id] = Registered(spec: s, token: token)
            order.append(s.id)
        }
        notify()
        return Cancellable { [weak self] in
            guard let self else { return }
            var changed = false
            for (s, token) in zip(specs, tokens) where self.commands[s.id]?.token == token {
                self.remove(s.id)
                changed = true
            }
            if changed { self.notify() }
        }
    }

    /// Registers one command (see `register(_:)`).
    @discardableResult
    public func register(_ spec: CommandSpec<Context>) throws -> Cancellable { try register([spec]) }

    /// Removes a command by id. Returns whether it was registered.
    @discardableResult
    public func unregister(_ id: String) -> Bool {
        guard commands[id] != nil else { return false }
        remove(id)
        notify()
        return true
    }

    private func remove(_ id: String) {
        guard let entry = commands.removeValue(forKey: id) else { return }
        order.removeAll { $0 == id }
        bindings.removeAll { $0.token == entry.token }
    }

    public func has(_ id: String) -> Bool { commands[id] != nil }

    public func get(_ id: String) -> CommandSpec<Context>? { commands[id]?.spec }

    /// Registered ids in registration order.
    public var ids: [String] { order }

    /// Canonical chord text bound to `id` on `platform` (first = primary).
    public func shortcuts(for id: String, platform: ShortcutPlatform? = nil) -> [String] {
        let p = platform ?? self.platform
        return bindings.filter { $0.command == id && ($0.platforms?.contains(p) ?? true) }.map { chordToString($0.chord) }
    }

    /// Display-ready primary shortcut of a command (`⇧⌘Z` / `Ctrl+Shift+Z`), or `nil`.
    public func shortcutFor(_ id: String, platform: ShortcutPlatform? = nil) -> String? {
        let p = platform ?? self.platform
        return bindings.first { $0.command == id && ($0.platforms?.contains(p) ?? true) }.map { formatShortcut($0.chord, platform: p) }
    }

    /// Whether `id` can run now; `params` are the targets a caller named.
    public func isEnabled(_ id: String, params: JSONObject? = nil, context: Context? = nil) -> CommandEnablement {
        guard let spec = get(id) else { return CommandEnablement(enabled: false, reason: "Unknown command \"\(id)\".") }
        guard let check = spec.enabled else { return CommandEnablement(enabled: true) }
        do {
            return enablement(try check(context ?? self.context, params))
        } catch {
            return CommandEnablement(enabled: false, reason: errorMessage(error))
        }
    }

    /**
     Commands for menus, palettes and agents, with their current enablement. `scope` keeps global
     commands plus commands of these scopes; `context` replaces the registry's for the check.
     */
    public func list(scope: [String]? = nil, enabledOnly: Bool = false, includeHidden: Bool = false, context: Context? = nil) -> [CommandEntry] {
        let ctx = context ?? self.context
        var out: [CommandEntry] = []
        for id in order {
            let spec = commands[id]!.spec
            if spec.hidden && !includeHidden { continue }
            if let scope, let own = spec.scope, !scope.contains(own) { continue }
            let state = isEnabled(spec.id, context: ctx)
            if enabledOnly && !state.enabled { continue }
            out.append(CommandEntry(id: spec.id, label: spec.label, group: spec.group, keywords: spec.keywords, description: spec.description,
                                    params: spec.params, scope: spec.scope, shortcuts: shortcuts(for: spec.id), enabled: state.enabled,
                                    disabledReason: state.enabled ? nil : state.reason, undoable: spec.undoable, readOnly: spec.readOnly))
        }
        return out
    }

    private func check(_ id: String, _ params: JSONValue?, _ context: Context) -> Result<(CommandSpec<Context>, JSONObject), CommandFailure> {
        guard let spec = get(id) else { return .failure(CommandFailure(id: id, code: .unknownCommand, message: "Unknown command \"\(id)\".")) }
        let input: JSONObject
        switch params ?? .null {
        case .null: input = JSONObject()
        case .object(let o): input = o
        default: return .failure(CommandFailure(id: id, code: .invalidParams, message: "Parameters for command \"\(id)\" must be an object."))
        }
        if let message = unknownParams(spec.params, id, input) {
            return .failure(CommandFailure(id: id, code: .invalidParams, message: message))
        }
        if let schema = spec.params {
            let details = validateJSONSchema(.object(input), .object(schema))
            if !details.isEmpty {
                return .failure(CommandFailure(id: id, code: .invalidParams, message: "Invalid parameters for command \"\(id)\": \(details.map { "\($0.path) \($0.message)" }.joined(separator: "; "))", details: details))
            }
        }
        let state = isEnabled(id, params: params.map { _ in input }, context: context)
        if !state.enabled { return .failure(CommandFailure(id: id, code: .disabled, message: state.reason ?? "Disabled.")) }
        return .success((spec, input))
    }

    /**
     Runs a command synchronously and returns a structured result; never throws. A command with an
     `async` run fails here (use `executeAsync`), where TS would hand back its promise.
     */
    @discardableResult
    public func execute(_ id: String, _ params: JSONValue? = nil, context: Context? = nil) -> CommandResult {
        let ctx = context ?? self.context
        switch check(id, params, ctx) {
        case .failure(let f): return .failure(f)
        case .success(let (spec, input)):
            guard case .sync(let run) = spec.run else {
                return .failure(CommandFailure(id: id, code: .failed, message: "Command \"\(id)\" runs asynchronously; run it with executeAsync."))
            }
            do {
                var value: JSONValue?
                if spec.undoable, let history {
                    // `batch` rolls back already-recorded steps and rethrows when `run` throws.
                    try history.batch(spec.label) { value = try run(ctx, input) }
                } else {
                    value = try run(ctx, input)
                }
                notify()
                return .ok(id: id, result: value)
            } catch {
                notify()
                return .failure(CommandFailure(id: id, code: .failed, message: errorMessage(error)))
            }
        }
    }

    /// Like `execute`, but awaits async commands (throws become `failed` results). Async commands run
    /// outside the history batch, as the awaited part of a TS command does.
    nonisolated(nonsending)
    public func executeAsync(_ id: String, _ params: JSONValue? = nil, context: Context? = nil) async -> CommandResult {
        let ctx = context ?? self.context
        guard let spec = get(id), case .async(let run) = spec.run else { return execute(id, params, context: ctx) }
        switch check(id, params, ctx) {
        case .failure(let f): return .failure(f)
        case .success(let (_, input)):
            do {
                let value = try await run(ctx, input)
                notify()
                return .ok(id: id, result: value)
            } catch {
                notify()
                return .failure(CommandFailure(id: id, code: .failed, message: errorMessage(error)))
            }
        }
    }

    /**
     Subscribes to changes: commands registered or removed, executed commands and `invalidate()`
     calls (e.g. when enablement inputs change).
     */
    @discardableResult
    public func subscribe(_ listener: @escaping () -> Void) -> Cancellable {
        let id = UUID()
        listeners.append((id, listener))
        return Cancellable { [weak self] in self?.listeners.removeAll { $0.id == id } }
    }

    /// Tells subscribers that enablement may have changed (e.g. the selection changed).
    public func invalidate() { notify() }

    private func notify() {
        version += 1
        for l in listeners { l.fn() }
    }
}

extension CommandRegistry where Context == Void {
    public convenience init(history: CommandHistoryTarget? = nil, platform: ShortcutPlatform = .mac) {
        self.init(context: {}, history: history, platform: platform)
    }
}
