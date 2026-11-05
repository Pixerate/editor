import Foundation
import XCTest
@testable import PixerateCore

private struct Failure: Error, LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

private final class Counter { var value = 0 }

private struct Entry: RankableCommand {
    var id: String
    var label: String
    var group: String?
    var keywords: [String]?
    var isEnabledForRanking: Bool?
}

private let paletteEntries = [
    Entry(id: "view.settings", label: "Color Settings", group: "View"),
    Entry(id: "app.settings", label: "Settings", group: "App"),
    Entry(id: "canvas.alignLeft", label: "Align Left", group: "Arrange", keywords: ["flush"]),
    Entry(id: "history.undo", label: "Undo", group: "Edit", isEnabledForRanking: false),
    Entry(id: "history.redo", label: "Redo", group: "Edit"),
    Entry(id: "a.b", label: "Ab", group: ""),
    Entry(id: "a.c", label: "Ac"),
]

/// The registry `swift-command-vectors.test.ts` scripts; keep the two in step.
private func vectorSetup(withHistory: Bool = true) throws -> (tools: ToolRegistry, history: HistoryManager, ctx: Counter) {
    let history = HistoryManager()
    let ctx = Counter()
    func set(_ to: Int) {
        let from = ctx.value
        history.execute(Command(name: "set", execute: { ctx.value = to }, undo: { ctx.value = from }))
    }
    let commands = CommandRegistry(context: ctx, history: withHistory ? history : nil, platform: .mac)
    try commands.register([
        CommandSpec(id: "counter.set", label: "Set Counter", group: "Counter", keywords: ["assign"],
                    params: ["type": "object", "properties": ["value": ["type": "integer", "minimum": 0, "description": "New value."]], "required": ["value"]],
                    shortcut: ["Mod+Shift+S"], undoable: true) { _, p in
            set(Int(p["value"]!.numberValue!))
            return ["value": .number(Double(ctx.value))]
        },
        CommandSpec(id: "counter.add", label: "Add…", group: "Counter", description: "Adds to the counter.",
                    params: ["type": "object", "properties": ["by": ["type": "number", "description": "Step."]], "additionalProperties": false],
                    undoable: true) { _, p in
            set(ctx.value + Int(p["by"]?.numberValue ?? 1))
            return ["value": .number(Double(ctx.value)), "items": [["id": .string("i\(ctx.value)")]]]
        },
        CommandSpec(id: "counter.reset", label: "Reset", group: "Counter", enabled: { c, _ in c.value > 0 ? true : "Already at zero." }) { _, _ in
            set(0)
            return nil
        },
        CommandSpec(id: "counter.fail", label: "Fail", undoable: true) { _, _ in
            set(99)
            throw Failure(message: "kaput")
        },
        CommandSpec(id: "counter.nan", label: "Odd Numbers", readOnly: true) { _, _ in
            ["x": .number(.nan), "y": .number(-0.0), "z": [.number(.infinity), 1.5e-7]]
        },
        CommandSpec(id: "counter.off", label: "Off", enabled: { _, _ in false }) { _, _ in 1 },
        CommandSpec(id: "counter.hidden", label: "Hidden", hidden: true) { _, _ in "secret" },
        CommandSpec(id: "canvas.thing", label: "Thing", shortcut: [CommandShortcut("Mod+Y", platforms: [.windows, .linux]), "Alt+]", "⌥⇧⌘K"], scope: "canvas") { _, _ in "thing" },
    ])
    let tools = ToolRegistry()
    try tools.register(createCommandToolProvider(commands, CommandToolProviderOptions(tools: { $0.hasPrefix("counter.a") || ["counter.reset", "canvas.thing", "counter.nan"].contains($0) })))
    return (tools, history, ctx)
}

final class CommandRegistryTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "command-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    // MARK: Recorded TS session

    func testToolSessionMatchesTheTSCoreByteForByte() async throws {
        let (tools, history, ctx) = try vectorSetup()
        XCTAssertEqual(JSONValue.array(tools.listTools().map(\.json)).stringified(), Self.vectors["listTools"]!.stringValue!)
        let calls = Self.vectors["calls"]!.arrayValue!
        XCTAssertGreaterThan(calls.count, 20)
        for call in calls {
            let name = call["name"]!.stringValue!
            let result = await tools.callTool(name, call["args"]!.objectValue!)
            let label = "\(name) \(call["args"]!.stringified())"
            XCTAssertEqual(result.json.stringified(), call["result"]!.stringValue!, label)
            XCTAssertEqual(Double(ctx.value), call["value"]!.numberValue!, label)
            XCTAssertEqual(history.state.undoName, call["undo"]!.stringValue!, label)
            XCTAssertEqual(Double(history.state.undoCount), call["undoCount"]!.numberValue!, label)
        }
        let none = try vectorSetup(withHistory: false)
        let refused = await none.tools.callTool("run_commands", ["atomic": true, "steps": [["id": "counter.add"]]])
        XCTAssertEqual(refused.json.stringified(), Self.vectors["unsupported"]!.stringValue!)
    }

    func testFuzzyMatchingMatchesTheTSCore() {
        for row in Self.vectors["fuzzy"]!.arrayValue! {
            let r = row.arrayValue!
            let m = fuzzyMatch(r[0].stringValue!, r[1].stringValue!)
            let json: JSONValue = m.map { ["score": .number(Double($0.score)), "indices": .array($0.indices.map { .number(Double($0)) })] } ?? .null
            XCTAssertEqual(json, r[2], "fuzzyMatch(\(r[0]), \(r[1]))")
        }
        for row in Self.vectors["exact"]!.arrayValue! {
            let r = row.arrayValue!
            XCTAssertEqual(Double(exactBonus(r[0].stringValue!, r[1].arrayValue!.map { $0.stringValue! })), r[2].numberValue!, "exactBonus(\(r[0]), \(r[1]))")
        }
    }

    func testRankingMatchesTheTSCore() {
        func rows(_ ranked: [RankedCommand<Entry>], indices: Bool) -> JSONValue {
            .array(ranked.map { r in
                var row: [JSONValue] = [.string(r.entry.id), .number(Double(r.score))]
                if indices { row.append(.array(r.labelIndices.map { .number(Double($0)) })) }
                return .array(row)
            })
        }
        for row in Self.vectors["rank"]!.arrayValue! {
            let q = row.arrayValue![0].stringValue!
            XCTAssertEqual(rows(rankCommands(q, paletteEntries), indices: true), row.arrayValue![1], "rankCommands(\(q))")
        }
        let recents = rankCommands("e", paletteEntries, RankCommandsOptions(recents: ["history.redo", "app.settings", "a.b", "a.c", "view.settings"]))
        XCTAssertEqual(rows(recents, indices: false), Self.vectors["rankRecents"]!)
        let empty = rankCommands("", paletteEntries, RankCommandsOptions(recents: ["history.redo", "missing", "history.redo", "app.settings"], recentLimit: -1))
        XCTAssertEqual(JSONValue.array(empty.map { [.string($0.entry.id), .number(Double($0.score)), .bool($0.recent)] }), Self.vectors["rankEmpty"]!)
    }

    // MARK: commands.test.ts

    func testChordsParseNormaliseAndFormat() throws {
        XCTAssertEqual(try parseChord("Mod+Shift+Z"), Chord(key: "KeyZ", mod: true, shift: true))
        XCTAssertEqual(try normalizeChord("shift+cmdorctrl+z"), "Mod+Shift+Z")
        XCTAssertEqual(try normalizeChord("⌥⇧⌘K"), "Meta+Alt+Shift+K")
        XCTAssertEqual(try normalizeChord("Alt+]"), "Alt+]")
        XCTAssertEqual(try parseChord("Mod+]").key, "BracketRight")
        XCTAssertEqual(try parseChord("PageDown").key, "PageDown")
        XCTAssertEqual(try parseChord("Ctrl+Up").key, "ArrowUp")
        XCTAssertEqual(try parseChord("F5").key, "F5")
        XCTAssertEqual(try parseChord("f24").key, "F24")
        XCTAssertEqual(try parseChord("Page_Down").key, "PageDown")
        XCTAssertEqual(try parseChord("Mod+Plus").key, "Equal")
        XCTAssertEqual(try parseChord("Numpad1").key, "Numpad1")
        XCTAssertEqual(formatShortcut("Mod+Shift+Z", platform: .mac), "⇧⌘Z")
        XCTAssertEqual(formatShortcut("Mod+Shift+Z", platform: .windows), "Ctrl+Shift+Z")
        XCTAssertEqual(formatShortcut("Mod+Alt+[", platform: .linux), "Ctrl+Alt+[")
        XCTAssertEqual(formatShortcut("Ctrl+Alt+K", platform: .mac), "⌃⌥K")
        XCTAssertEqual(formatShortcut("Meta+K", platform: .windows), "Win+K")
        XCTAssertEqual(formatShortcut("Meta+K", platform: .linux), "Super+K")
        XCTAssertEqual(formatShortcut("Backspace", platform: .mac), "⌫")
        XCTAssertEqual(formatShortcut("PageDown", platform: .windows), "Page Down")
        XCTAssertEqual(formatShortcut("not a chord+", platform: .mac), "not a chord+")
    }

    func testChordsRejectUnknownModifiersAndKeys() {
        func message(_ text: String) -> String? { do { _ = try parseChord(text); return nil } catch { return errorMessage(error) } }
        XCTAssertEqual(message(""), "Empty shortcut.")
        XCTAssertEqual(message("Hyper+K"), "Unknown modifier \"Hyper\" in shortcut \"Hyper+K\".")
        XCTAssertEqual(message("Mod+Banana"), "Unknown key \"Banana\" in shortcut \"Mod+Banana\".")
        XCTAssertEqual(message("Mod+"), "\"Mod+\" has no key.")
        XCTAssertEqual(message("F25"), "Unknown key \"F25\" in shortcut \"F25\".")
        XCTAssertEqual(message("F01"), "Unknown key \"F01\" in shortcut \"F01\".")
    }

    private final class Count { var count = 0 }

    private func counterRegistry() throws -> (CommandRegistry<Count>, Count, () -> Int) {
        let ctx = Count()
        let registry = CommandRegistry(context: ctx)
        var runs = 0
        try registry.register(CommandSpec(id: "counter.add", label: "Add", group: "Counter",
                                          params: ["type": "object", "properties": ["by": ["type": "integer", "minimum": 1]]],
                                          shortcut: ["Mod+Shift+A"]) { c, p in
            runs += 1
            c.count += Int(p["by"]?.numberValue ?? 1)
            return .number(Double(c.count))
        })
        try registry.register(CommandSpec(id: "counter.reset", label: "Reset", enabled: { c, _ in c.count > 0 ? true : "Already at zero." }) { c, _ in
            c.count = 0
            return nil
        })
        return (registry, ctx, { runs })
    }

    func testRegistrationRejectsDuplicatesBadIdsAndInvalidShortcutsAtomically() throws {
        let (registry, _, _) = try counterRegistry()
        func error(_ specs: [CommandSpec<Count>]) -> CommandRegistryError? {
            do { try registry.register(specs); return nil } catch { return error as? CommandRegistryError }
        }
        XCTAssertEqual(error([CommandSpec(id: "counter.add", label: "x") { _, _ in nil }]), CommandRegistryError(code: .duplicateCommand, message: "Command \"counter.add\" is already registered."))
        XCTAssertEqual(error([CommandSpec(id: "bad id", label: "x") { _, _ in nil }]), CommandRegistryError(code: .invalidCommand, message: "Invalid command id \"bad id\"."))
        XCTAssertEqual(error([CommandSpec(id: "", label: "x") { _, _ in nil }])?.code, .invalidCommand)
        XCTAssertEqual(error([CommandSpec(id: String(repeating: "a", count: 129), label: "x") { _, _ in nil }])?.code, .invalidCommand)
        XCTAssertEqual(error([CommandSpec(id: "twice", label: "x") { _, _ in nil }, CommandSpec(id: "twice", label: "y") { _, _ in nil }])?.code, .duplicateCommand)
        XCTAssertEqual(error([
            CommandSpec(id: "ok.one", label: "One") { _, _ in nil },
            CommandSpec(id: "ok.two", label: "Two", shortcut: ["Hyper+K"]) { _, _ in nil },
        ]), CommandRegistryError(code: .invalidCommand, message: "Unknown modifier \"Hyper\" in shortcut \"Hyper+K\"."))
        XCTAssertFalse(registry.has("ok.one"))
        XCTAssertEqual(registry.ids, ["counter.add", "counter.reset"])
    }

    func testExecutesWithStructuredResults() throws {
        let (registry, _, runs) = try counterRegistry()
        XCTAssertEqual(registry.execute("counter.add", ["by": 2]), .ok(id: "counter.add", result: 2))
        XCTAssertEqual(registry.execute("nope"), .failure(CommandFailure(id: "nope", code: .unknownCommand, message: "Unknown command \"nope\".")))
        XCTAssertEqual(registry.execute("counter.add", ["step": 1]), .failure(CommandFailure(id: "counter.add", code: .invalidParams, message: "Unknown parameter \"step\" for command \"counter.add\"; expected \"by\".")))
        XCTAssertEqual(registry.execute("counter.reset", ["hard": true]), .failure(CommandFailure(id: "counter.reset", code: .invalidParams, message: "Unknown parameter \"hard\" for command \"counter.reset\"; expected no parameters.")))
        XCTAssertEqual(registry.execute("counter.add", ["by": 0]), .failure(CommandFailure(id: "counter.add", code: .invalidParams, message: "Invalid parameters for command \"counter.add\": /by Must be >= 1.", details: [SchemaValidationError(path: "/by", message: "Must be >= 1.")])))
        XCTAssertEqual(registry.execute("counter.add", [1]), .failure(CommandFailure(id: "counter.add", code: .invalidParams, message: "Parameters for command \"counter.add\" must be an object.")))
        XCTAssertEqual(registry.execute("counter.add", "x").json, ["ok": false, "id": "counter.add", "code": "invalid_params", "message": "Parameters for command \"counter.add\" must be an object."])
        XCTAssertEqual(runs(), 1)
        XCTAssertTrue(registry.execute("counter.reset").isOk)
        XCTAssertEqual(registry.execute("counter.reset"), .failure(CommandFailure(id: "counter.reset", code: .disabled, message: "Already at zero.")))
        try registry.register(CommandSpec(id: "boom", label: "Boom") { _, _ in throw Failure(message: "kaput") })
        XCTAssertEqual(registry.execute("boom"), .failure(CommandFailure(id: "boom", code: .failed, message: "kaput")))
        XCTAssertEqual(registry.execute("counter.add").json, ["ok": true, "id": "counter.add", "result": 1])
    }

    func testRechecksEnablementAgainstTargetsNamedInParams() throws {
        let registry = CommandRegistry(context: [String]())
        try registry.register(CommandSpec(id: "nodes.delete", label: "Delete",
                                          params: ["type": "object", "properties": ["ids": ["type": "array", "items": ["type": "string"]]]],
                                          enabled: { selection, params in (params?["ids"]?.arrayValue?.count ?? selection.count) > 0 ? true : "No nodes selected." }) { selection, params in
            params["ids"] ?? .array(selection.map { .string($0) })
        })
        XCTAssertEqual(registry.list()[0].enabled, false)
        XCTAssertEqual(registry.list()[0].disabledReason, "No nodes selected.")
        XCTAssertEqual(registry.execute("nodes.delete"), .failure(CommandFailure(id: "nodes.delete", code: .disabled, message: "No nodes selected.")))
        XCTAssertEqual(registry.execute("nodes.delete", ["ids": ["a"]]), .ok(id: "nodes.delete", result: ["a"]))
        // A thrown enablement check disables the command with its message.
        try registry.register(CommandSpec(id: "nodes.throws", label: "Throws", enabled: { _, _ in throw Failure(message: "No document.") }) { _, _ in nil })
        XCTAssertEqual(registry.isEnabled("nodes.throws"), CommandEnablement(enabled: false, reason: "No document."))
        XCTAssertEqual(registry.isEnabled("missing"), CommandEnablement(enabled: false, reason: "Unknown command \"missing\"."))
    }

    func testListsCommandsWithEnablementShortcutsAndScopes() throws {
        let (registry, _, _) = try counterRegistry()
        try registry.register(CommandSpec(id: "canvas.thing", label: "Thing", shortcut: [CommandShortcut("Mod+Y", platforms: [.windows]), "Alt+]"], scope: "canvas") { _, _ in nil })
        try registry.register(CommandSpec(id: "secret", label: "Secret", hidden: true) { _, _ in nil })
        let list = registry.list()
        XCTAssertEqual(list.map(\.id), ["counter.add", "counter.reset", "canvas.thing"])
        XCTAssertEqual(list[0].json, [
            "id": "counter.add", "label": "Add", "group": "Counter",
            "params": ["type": "object", "properties": ["by": ["type": "integer", "minimum": 1]]],
            "shortcuts": ["Mod+Shift+A"], "enabled": true, "undoable": false, "readOnly": false,
        ])
        XCTAssertEqual(list[1].disabledReason, "Already at zero.")
        XCTAssertEqual(list[2].shortcuts, ["Alt+]"])
        XCTAssertEqual(registry.shortcuts(for: "canvas.thing", platform: .windows), ["Mod+Y", "Alt+]"])
        XCTAssertEqual(registry.shortcutFor("counter.add"), "⇧⌘A")
        XCTAssertEqual(registry.shortcutFor("counter.add", platform: .linux), "Ctrl+Shift+A")
        XCTAssertEqual(registry.list(enabledOnly: true).map(\.id), ["counter.add", "canvas.thing"])
        XCTAssertEqual(registry.list(scope: ["sheet"]).map(\.id), ["counter.add", "counter.reset"])
        XCTAssertEqual(registry.list(includeHidden: true).count, 4)
        let busy = Count()
        busy.count = 3
        XCTAssertTrue(registry.list(context: busy)[1].enabled)
    }

    func testNotifiesSubscribersAndUnregisters() throws {
        let (registry, _, _) = try counterRegistry()
        var calls = 0
        registry.subscribe { calls += 1 }
        let remove = try registry.register(CommandSpec(id: "x", label: "X", shortcut: ["Mod+X"]) { _, _ in nil })
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(registry.shortcuts(for: "x"), ["Mod+X"])
        remove.cancel()
        remove.cancel()
        XCTAssertFalse(registry.has("x"))
        XCTAssertEqual(registry.shortcuts(for: "x"), [])
        XCTAssertEqual(calls, 2)
        registry.invalidate()
        XCTAssertEqual(calls, 3)
        let version = registry.version
        _ = registry.execute("counter.add")
        XCTAssertEqual(registry.version, version + 1, "running a command notifies")
        XCTAssertTrue(registry.unregister("counter.add"))
        XCTAssertFalse(registry.unregister("counter.add"))
        // A stale remover leaves a re-registered command alone.
        let first = try registry.register(CommandSpec(id: "y", label: "Y") { _, _ in nil })
        registry.unregister("y")
        try registry.register(CommandSpec(id: "y", label: "Y again") { _, _ in nil })
        first.cancel()
        XCTAssertEqual(registry.get("y")?.label, "Y again")
    }

    func testRunsUndoableCommandsAsOneHistoryStepAndRollsBackFailures() throws {
        let history = HistoryManager()
        var value = 0
        func step(_ to: Int) {
            let from = value
            history.execute(Command(name: "set", execute: { value = to }, undo: { value = from }))
        }
        let registry = CommandRegistry(history: history)
        try registry.register([
            CommandSpec(id: "twice", label: "Twice", undoable: true) { _, _ in step(1); step(2); return nil },
            CommandSpec(id: "broken", label: "Broken", undoable: true) { _, _ in step(10); throw Failure(message: "half done") },
        ])
        XCTAssertTrue(registry.execute("twice").isOk)
        XCTAssertEqual(value, 2)
        XCTAssertEqual(history.state.undoCount, 1)
        XCTAssertEqual(history.state.undoName, "Twice")
        XCTAssertEqual(registry.execute("broken"), .failure(CommandFailure(id: "broken", code: .failed, message: "half done")))
        XCTAssertEqual(value, 2)
        XCTAssertEqual(history.state.undoCount, 1)
        _ = history.undo()
        XCTAssertEqual(value, 0)
    }

    func testAwaitsAsyncCommandsInExecuteAsync() async throws {
        let registry = CommandRegistry()
        try registry.register([
            CommandSpec(id: "later", label: "Later") { (_: Void, _: JSONObject) async throws -> JSONValue? in 42 },
            CommandSpec(id: "reject", label: "Reject") { (_: Void, _: JSONObject) async throws -> JSONValue? in throw Failure(message: "nope") },
        ])
        let later = await registry.executeAsync("later")
        XCTAssertEqual(later, .ok(id: "later", result: 42))
        let rejected = await registry.executeAsync("reject")
        XCTAssertEqual(rejected, .failure(CommandFailure(id: "reject", code: .failed, message: "nope")))
        let missing = await registry.executeAsync("missing")
        XCTAssertEqual(missing, .failure(CommandFailure(id: "missing", code: .unknownCommand, message: "Unknown command \"missing\".")))
        XCTAssertEqual(registry.execute("later"), .failure(CommandFailure(id: "later", code: .failed, message: "Command \"later\" runs asynchronously; run it with executeAsync.")))
    }

    func testPaletteRankingAndRecents() {
        XCTAssertEqual(fuzzyScore("", "Anything"), 0)
        XCTAssertNil(fuzzyScore("xyz", "Align Left"))
        XCTAssertEqual(fuzzyMatch("al", "Align Left")?.indices, [0, 1])
        XCTAssertGreaterThan(fuzzyScore("al", "Align Left")!, fuzzyScore("al", "Normal")!)
        XCTAssertGreaterThan(fuzzyScore("bf", "Bring Forward")!, fuzzyScore("bf", "Bring Toolbar Forward Later On Please")!)
        XCTAssertEqual(exactBonus("settings", ["Settings…"]), 1000)
        XCTAssertEqual(exactBonus("settings", ["Color Settings"]), 0)

        var list: [String] = []
        list = pushRecent(list, "b", cap: 3)
        list = pushRecent(list, "a", cap: 3)
        list = pushRecent(list, "c", cap: 3)
        XCTAssertEqual(list, ["c", "a", "b"])
        list = pushRecent(list, "a", cap: 3)
        XCTAssertEqual(list, ["a", "c", "b"])
        XCTAssertEqual(pushRecent(list, "d", cap: 3), ["d", "a", "c"])

        XCTAssertEqual(rankCommands("do", paletteEntries, RankCommandsOptions(disabledLast: false))[0].entry.id, "history.undo")
        let ranked = rankCommands("", paletteEntries, RankCommandsOptions(recents: ["history.redo", "missing", "history.redo", "app.settings"]))
        XCTAssertEqual(ranked.map(\.entry.id), ["history.redo", "app.settings", "view.settings", "canvas.alignLeft", "a.b", "a.c", "history.undo"])
        XCTAssertEqual(ranked.map(\.recent), [true, true, false, false, false, false, false])
        XCTAssertEqual(rankCommands("", paletteEntries, RankCommandsOptions(recents: ["history.redo", "app.settings"], recentLimit: 1, emptyQuery: .recents)).map(\.entry.id), ["history.redo"])
        XCTAssertEqual(rankCommands("", paletteEntries, RankCommandsOptions(limit: 2)).count, 2)
    }

    func testJavaScriptStringRules() {
        XCTAssertEqual("ΟΔΟΣ ΣΑΣ".jsLowercased, "οδος σας")
        XCTAssertEqual("Σ".jsLowercased, "σ")
        XCTAssertEqual("İ".jsLowercased.utf16.count, 2)
        XCTAssertEqual("\u{FEFF} x \u{3000}".jsTrimmed, "x")
        XCTAssertEqual("\u{85}x".jsTrimmed, "\u{85}x", "NEL is not JavaScript white space")
    }

    // MARK: command-tools.test.ts and chart-tools.test.ts

    private func toolSetup(history: HistoryManager? = nil) throws -> (ToolRegistry, CommandRegistry<Counter>, Counter) {
        let ctx = Counter()
        let commands = CommandRegistry(context: ctx, history: history)
        try commands.register([
            CommandSpec(id: "counter.set", label: "Set Counter", group: "Counter",
                        params: ["type": "object", "properties": ["value": ["type": "integer"]], "required": ["value"]],
                        shortcut: ["Mod+Shift+S"]) { c, p in
                c.value = Int(p["value"]!.numberValue!)
                return ["value": .number(Double(c.value))]
            },
            CommandSpec(id: "counter.fail", label: "Fail") { _, _ in throw Failure(message: "kaput") },
            CommandSpec(id: "counter.hidden", label: "Hidden", hidden: true) { _, _ in "secret" },
        ])
        let tools = ToolRegistry()
        try tools.register(createCommandToolProvider(commands))
        return (tools, commands, ctx)
    }

    func testRunsBatchesInOrderStoppingAtTheFirstErrorByDefault() async throws {
        let (tools, _, ctx) = try toolSetup()
        XCTAssertEqual(tools.listTools().map { baseToolName($0.name) }, ["list_commands", "run_command", "run_commands"])
        let stopped = await tools.callTool("run_commands", ["steps": [["id": "counter.set", "params": ["value": 1]], ["id": "counter.fail"], ["id": "counter.set", "params": ["value": 2]]]])
        XCTAssertTrue(stopped.isError)
        XCTAssertEqual(stopped.structuredContent?["completed"], 1)
        XCTAssertEqual(stopped.structuredContent?["skipped"], 1)
        XCTAssertEqual(ctx.value, 1)
        let refs = await tools.callTool("run_commands", ["steps": [["id": "counter.set", "params": ["value": 4]], ["id": "counter.set", "params": ["value": "$0.value"]]]])
        XCTAssertFalse(refs.isError)
        XCTAssertEqual(refs.structuredContent?["results"]?.arrayValue?[1], ["id": "counter.set", "ok": true, "result": ["value": 4]])
    }

    func testAnnouncesListChangesWhenCommandsAreAddedOrRemovedNotWhenTheyRun() throws {
        let (tools, commands, _) = try toolSetup()
        var changes = 0
        tools.onListChanged { _ in changes += 1 }
        _ = commands.execute("counter.set", ["value": 9])
        XCTAssertEqual(changes, 0)
        let remove = try commands.register(CommandSpec(id: "counter.new", label: "New") { _, _ in nil })
        XCTAssertEqual(changes, 1)
        XCTAssertTrue(tools.getTool("run_command")!.inputSchema["properties"]!["id"]!["enum"]!.arrayValue!.contains("counter.new"))
        remove.cancel()
        XCTAssertEqual(changes, 2)
    }

    func testSupportsScopesExclusionsNamespacesAndToolNames() async throws {
        let commands = CommandRegistry()
        try commands.register([
            CommandSpec(id: "a", label: "A") { _, _ in "a" },
            CommandSpec(id: "b", label: "B", scope: "canvas") { _, _ in "b" },
            CommandSpec(id: "c", label: "C", scope: "sheet") { _, _ in "c" },
            CommandSpec(id: "canvas.circle", label: "Circle", description: "Draws a circle.", params: ["type": "object", "properties": ["r": ["type": "number", "description": "Radius."]], "additionalProperties": false]) { _, p in ["r": p["r"] ?? 1] },
        ])
        let tools = ToolRegistry()
        try tools.register(createCommandToolProvider(commands, CommandToolProviderOptions(id: "cmd", namespace: "app", scope: ["canvas"], exclude: { $0 == "a" }, tools: { $0.hasPrefix("canvas.") })))
        XCTAssertEqual(tools.listTools().map(\.name), ["app__list_commands", "app__run_command", "app__run_commands", "app__canvas_circle"])
        let circle = tools.getTool("app__canvas_circle")!
        XCTAssertEqual(circle.description, "Draws a circle. (Runs the \"canvas.circle\" command; refused with the reason when it cannot run now.)")
        XCTAssertEqual(circle.annotations, ToolAnnotations(title: "Circle", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false))
        let drawn = await tools.callTool("app__canvas_circle", ["r": 4])
        XCTAssertEqual(drawn.structuredContent, ["r": 4])
        let listed = await tools.callTool("app__list_commands")
        XCTAssertEqual(listed.structuredContent?["commands"]?.arrayValue?.compactMap { $0["id"]?.stringValue }, ["b", "canvas.circle"])
        let blocked = await tools.callTool("app__run_commands", ["steps": [["id": "c"]]])
        XCTAssertEqual(blocked.structuredContent?["results"]?.arrayValue?[0]["code"], "unknown_command")

        let renamed = ToolRegistry(namespaces: .onCollision)
        try renamed.register(createCommandToolProvider(commands, CommandToolProviderOptions(tools: { $0 == "canvas.circle" }, toolName: { "draw_\($0.split(separator: ".").last!)" })))
        XCTAssertEqual(renamed.listTools().map(\.name).last, "draw_circle")
    }

    func testAtomicBatchesAreOneUndoStepAndRollBackOnFailure() async throws {
        let history = HistoryManager()
        let ctx = Counter()
        func set(_ to: Int) {
            let from = ctx.value
            history.execute(Command(name: "set", execute: { ctx.value = to }, undo: { ctx.value = from }))
        }
        let commands = CommandRegistry(context: ctx, history: history)
        try commands.register([
            CommandSpec(id: "set", label: "Set", params: ["type": "object", "properties": ["to": ["type": "integer"]], "required": ["to"]]) { _, p in
                set(Int(p["to"]!.numberValue!))
                return ["value": .number(Double(ctx.value))]
            },
            CommandSpec(id: "slow", label: "Slow") { (_: Counter, _: JSONObject) async throws -> JSONValue? in nil },
        ])
        let tools = ToolRegistry()
        try tools.register(createCommandToolProvider(commands))
        let ok = await tools.callTool("run_commands", ["atomic": true, "label": "Rebuild", "steps": [["id": "set", "params": ["to": 3]], ["id": "set", "params": ["to": 4]]]])
        XCTAssertFalse(ok.isError)
        XCTAssertEqual(history.state.undoName, "Rebuild")
        XCTAssertEqual(history.state.undoCount, 1)
        _ = history.undo()
        XCTAssertEqual(ctx.value, 0)
        let failed = await tools.callTool("run_commands", ["atomic": true, "steps": [["id": "set", "params": ["to": 7]], ["id": "slow"]]])
        XCTAssertTrue(failed.isError)
        XCTAssertEqual(failed.structuredContent?["rolledBack"], true)
        XCTAssertEqual(failed.structuredContent?["results"]?.arrayValue?[1]["message"], "\"slow\" runs asynchronously and cannot be part of an atomic batch.")
        XCTAssertEqual(ctx.value, 0)
        // Outside a batch, async commands run and are awaited.
        let awaited = await tools.callTool("run_command", ["id": "slow"])
        XCTAssertEqual(awaited.structuredContent, ["id": "slow", "ok": true, "result": nil])
    }
}
