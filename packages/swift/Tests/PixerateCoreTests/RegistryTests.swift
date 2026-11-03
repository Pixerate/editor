import XCTest
@testable import PixerateCore

private struct Failure: Error, CustomStringConvertible { var description: String }

private let emptyObject: JSONValue = ["type": "object", "properties": [:], "additionalProperties": false]

private func tool(_ name: String, readOnly: Bool = false, schema: JSONValue = emptyObject, _ handler: @escaping AgentToolHandler = { _, _ in .none }) -> AgentTool {
    AgentTool(name: name, description: "\(name).", inputSchema: schema, annotations: readOnly ? ToolAnnotations(readOnlyHint: true) : nil, handler: handler)
}

final class RegistryTests: XCTestCase {
    func testNamespacesListingAndLookup() throws {
        let r = ToolRegistry()
        try r.register(AgentToolProvider(id: "paint", title: "Paint", skill: "pixerate-paint-editor", tools: [tool("get_brush", readOnly: true), tool("set_brush")]))
        try r.register(AgentToolProvider(id: "vector", namespace: "vec", tools: [tool("get_brush", readOnly: true)]))
        XCTAssertEqual(r.listTools().map(\.name), ["paint__get_brush", "paint__set_brush", "vec__get_brush"])
        XCTAssertTrue(r.hasTool("set_brush"), "a unique bare name finds the tool")
        XCTAssertFalse(r.hasTool("get_brush"), "an ambiguous bare name does not")
        XCTAssertEqual(r.toolsets().map(\.name), ["paint", "vec"])
        XCTAssertEqual(r.toolsets()[0].skill, "pixerate-paint-editor")
        XCTAssertThrowsError(try r.register(AgentToolProvider(id: "paint", tools: []))) { XCTAssertEqual(($0 as! ToolRegistryError).code, .duplicateProvider) }
        XCTAssertThrowsError(try r.register(AgentToolProvider(id: "bad", tools: [tool("no spaces")]))) { XCTAssertEqual(($0 as! ToolRegistryError).code, .invalidTool) }
        // Bare names, and collisions only on demand.
        let bare = ToolRegistry(namespaces: .onCollision)
        try bare.register(AgentToolProvider(id: "a", tools: [tool("ping")]))
        XCTAssertEqual(bare.listTools().map(\.name), ["ping"])
        try bare.register(AgentToolProvider(id: "b", tools: [tool("ping")]))
        XCTAssertEqual(bare.listTools().map(\.name), ["a__ping", "b__ping"])
        let strict = ToolRegistry(namespaces: .onCollision, onCollision: .error)
        try strict.register(AgentToolProvider(id: "a", tools: [tool("ping")]))
        XCTAssertThrowsError(try strict.register(AgentToolProvider(id: "b", tools: [tool("ping")])))
    }

    func testCallsReturnMCPResultsAndNeverThrow() async throws {
        let r = ToolRegistry()
        try r.register(AgentToolProvider(id: "t", tools: [
            tool("echo", schema: ["type": "object", "properties": ["text": ["type": "string"]], "required": ["text"], "additionalProperties": false]) { args, _ in .value(["said": args["text"]!]) },
            tool("text") { _, _ in .text("hi") },
            tool("fails") { _, _ in throw Failure(description: "The layer is locked; unlock it first.") },
        ]))
        let ok = await r.callTool("t__echo", ["text": "x"])
        XCTAssertFalse(ok.isError)
        XCTAssertEqual(ok.structuredContent, ["said": "x"])
        XCTAssertEqual(ok.text, #"{"said":"x"}"#)
        let text = await r.callTool("text")
        XCTAssertEqual(text.content, [.text("hi")])

        let unknown = await r.callTool("nope")
        XCTAssertTrue(unknown.isError)
        XCTAssertEqual(unknown.structuredContent?["error"]?["code"], "unknown_tool")

        let invalid = await r.callTool("t__echo", ["txt": "x"])
        XCTAssertTrue(invalid.isError)
        XCTAssertEqual(invalid.text, "Invalid arguments for tool \"t__echo\".\n- /text: Missing required property \"text\".\n- /txt: Unknown property \"txt\". Did you mean \"text\"? Allowed: text.")
        XCTAssertEqual(invalid.structuredContent?["error"]?["code"], "invalid_arguments")
        XCTAssertEqual(invalid.structuredContent?["error"]?["details"]?.arrayValue?.count, 2)

        let failed = await r.callTool("t__fails")
        XCTAssertTrue(failed.isError)
        XCTAssertEqual(failed.text, "The layer is locked; unlock it first.")
        XCTAssertEqual(failed.structuredContent?["error"]?["code"], "tool_failed")

        // Prototype keys never reach a handler.
        var seen: JSONObject?
        try r.register(AgentToolProvider(id: "u", tools: [tool("open", schema: ["type": "object"]) { args, _ in seen = args; return .none }]))
        _ = await r.callTool("u__open", ["__proto__": ["x": 1], "keep": 1])
        XCTAssertEqual(seen, ["keep": 1])
    }

    func testMiddlewareRunsOutermostFirstAndAThrowIsAnError() async throws {
        let r = ToolRegistry()
        var order: [String] = []
        try r.register(AgentToolProvider(id: "t", tools: [tool("go") { _, ctx in
            order.append("handler:\(ctx.actor?.id ?? "-")")
            return .none
        }]))
        r.use { call, next in
            order.append("outer:\(call.name)")
            let out = try await next()
            order.append("outer done")
            return out
        }
        let inner = r.use { _, next in
            order.append("inner")
            return try await next()
        }
        _ = await r.callTool("t__go", actor: ToolActor(id: "pixie"))
        XCTAssertEqual(order, ["outer:t__go", "inner", "handler:pixie", "outer done"])
        inner.cancel()
        r.use { _, _ in throw Failure(description: "Refused by policy.") }
        let refused = await r.callTool("t__go")
        XCTAssertEqual(refused.text, "Refused by policy.")
    }

    func testListChangedOnlyOnRealChanges() throws {
        let r = ToolRegistry()
        var lists: [[String]] = []
        r.onListChanged { lists.append($0.map(\.name)) }
        let reg = try r.register(AgentToolProvider(id: "a", tools: [tool("x")]))
        reg.cancel()
        r.notifyListChanged()
        XCTAssertEqual(lists, [["a__x"], []])
    }

    // MARK: originMiddleware (packages/core/tests/canvas-proposals.test.ts)

    func testStampsWriteToolCallsWithTheCallingAgentAndLeavesReadsAlone() async throws {
        let history = HistoryManager()
        let r = ToolRegistry()
        var seen: [String] = []
        try r.register(AgentToolProvider(id: "t", tools: [
            tool("write") { _, _ in history.execute(Command(name: "W", execute: {}, undo: {})); return .none },
            tool("read", readOnly: true) { _, _ in seen.append(history.origin); return .none },
        ]))
        r.use(originMiddleware(.one(history)))
        _ = await r.callTool("t__write", actor: ToolActor(id: "pixie"))
        _ = await r.callTool("t__write")
        _ = await r.callTool("t__read", actor: ToolActor(id: "pixie"))
        XCTAssertEqual(history.entries.map(\.origin), ["agent:pixie", "agent:anonymous"])
        XCTAssertEqual(seen, ["user"])
        XCTAssertEqual(history.origin, "user")
    }

    func testPicksHistoriesPerCallAndSkipsCallsItHasNoneFor() async throws {
        let a = HistoryManager()
        let r = ToolRegistry()
        let write: AgentToolHandler = { _, _ in a.execute(Command(name: "W", execute: {}, undo: {})); return .none }
        try r.register(AgentToolProvider(id: "x", tools: [tool("w", write)]))
        try r.register(AgentToolProvider(id: "y", tools: [tool("w", write)]))
        r.use(originMiddleware(.perCall { $0.provider.id == "x" ? [a] : nil }, fallbackOrigin: "agent:mcp"))
        _ = await r.callTool("x__w")
        _ = await r.callTool("y__w")
        XCTAssertEqual(a.entries.map(\.origin), ["agent:mcp", "user"])
    }
}
