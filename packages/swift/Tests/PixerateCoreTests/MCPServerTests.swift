import Foundation
import XCTest
@testable import PixerateCore

private func raw(_ text: String) -> Data { Data(text.utf8) }

private func post(_ body: String, headers: [String: String] = [:], path: String = "/mcp") -> MCPHTTPRequest {
    var h = ["host": "127.0.0.1:4490", "content-type": "application/json"]
    for (k, v) in headers { h[k] = v }
    return MCPHTTPRequest(method: "POST", path: path, headers: h, body: Data(body.utf8))
}

final class MCPHTTPTests: XCTestCase {
    // MARK: Parsing

    func testParsesARequestWithItsBody() {
        let data = raw("POST /mcp?x=1 HTTP/1.1\r\nHost: 127.0.0.1:4490\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}")
        guard case .request(let r) = MCPHTTP.parseRequest(data) else { return XCTFail("not parsed") }
        XCTAssertEqual(r.method, "POST")
        XCTAssertEqual(r.path, "/mcp?x=1")
        XCTAssertEqual(r.pathWithoutQuery, "/mcp")
        XCTAssertEqual(r.headers["host"], "127.0.0.1:4490")
        XCTAssertEqual(r.headers["content-type"], "application/json")
        XCTAssertEqual(r.body, raw("{}"))
    }

    func testWaitsForTheHeadAndTheWholeBody() {
        XCTAssertEqual(MCPHTTP.parseRequest(raw("POST /mcp HTTP/1.1\r\nContent-Length: 2\r\n")), .incomplete)
        XCTAssertEqual(MCPHTTP.parseRequest(raw("POST /mcp HTTP/1.1\r\nContent-Length: 5\r\n\r\n{}")), .incomplete)
    }

    func testParsesFromASlice() {
        let data = raw("xxGET / HTTP/1.1\r\nHost: localhost\r\n\r\n").dropFirst(2)
        guard case .request(let r) = MCPHTTP.parseRequest(Data(data)) else { return XCTFail("not parsed") }
        XCTAssertEqual(r.method, "GET")
        guard case .request(let s) = MCPHTTP.parseRequest(data) else { return XCTFail("slice not parsed") }
        XCTAssertEqual(s.path, "/")
    }

    func testRefusesBadLengthsChunkedBodiesAndOversizedHeads() {
        XCTAssertEqual(MCPHTTP.parseRequest(raw("POST /mcp HTTP/1.1\r\nContent-Length: -1\r\n\r\n")), .invalid)
        XCTAssertEqual(MCPHTTP.parseRequest(raw("POST /mcp HTTP/1.1\r\nContent-Length: abc\r\n\r\n")), .invalid)
        XCTAssertEqual(MCPHTTP.parseRequest(raw("POST /mcp HTTP/1.1\r\nContent-Length: \(MCPHTTP.maximumBodySize + 1)\r\n\r\n")), .invalid)
        XCTAssertEqual(MCPHTTP.parseRequest(raw("POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")), .invalid)
        XCTAssertEqual(MCPHTTP.parseRequest(raw("GARBAGE\r\n\r\n")), .invalid)
        XCTAssertEqual(MCPHTTP.parseRequest(Data(repeating: 65, count: MCPHTTP.maximumHeaderSize + 1)), .invalid)
    }

    func testSerializesAResponse() {
        let text = String(decoding: MCPHTTPResponse(status: "200 OK", headers: ["X-B": "2", "X-A": "1"], body: raw("hi")).serialized(), as: UTF8.self)
        XCTAssertEqual(text, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\nX-A: 1\r\nX-B: 2\r\n\r\nhi")
    }

    // MARK: Checks

    func testAllowsOnlyLocalHostsAndOrigins() {
        let json = ["content-type": "application/json"]
        for host in ["127.0.0.1", "127.0.0.1:4490", "localhost:4490", "LOCALHOST", "[::1]:4490"] {
            XCTAssertTrue(MCPHTTP.isAllowed(method: "POST", headers: json.merging(["host": host]) { $1 }, port: 4490), host)
        }
        for host in ["evil.example", "127.0.0.1:9999", "evil.example:4490"] {
            XCTAssertFalse(MCPHTTP.isAllowed(method: "POST", headers: json.merging(["host": host]) { $1 }, port: 4490), host)
        }
        XCTAssertFalse(MCPHTTP.isAllowed(method: "POST", headers: json, port: 4490), "no Host")
        let local = json.merging(["host": "127.0.0.1:4490"]) { $1 }
        XCTAssertTrue(MCPHTTP.isAllowed(method: "POST", headers: local.merging(["origin": "http://localhost:3000"]) { $1 }, port: 4490))
        XCTAssertTrue(MCPHTTP.isAllowed(method: "POST", headers: local.merging(["origin": "http://[::1]:3000"]) { $1 }, port: 4490))
        XCTAssertFalse(MCPHTTP.isAllowed(method: "POST", headers: local.merging(["origin": "https://evil.example"]) { $1 }, port: 4490))
        XCTAssertFalse(MCPHTTP.isAllowed(method: "POST", headers: local.merging(["origin": "null"]) { $1 }, port: 4490))
    }

    func testPostsMustBeJSON() {
        let host = ["host": "127.0.0.1:4490"]
        XCTAssertTrue(MCPHTTP.isAllowed(method: "POST", headers: host.merging(["content-type": "Application/JSON; charset=utf-8"]) { $1 }, port: 4490))
        XCTAssertFalse(MCPHTTP.isAllowed(method: "POST", headers: host.merging(["content-type": "text/plain"]) { $1 }, port: 4490))
        XCTAssertFalse(MCPHTTP.isAllowed(method: "POST", headers: host, port: 4490))
        XCTAssertTrue(MCPHTTP.isAllowed(method: "GET", headers: host, port: 4490))
    }

    func testComparesTheTokenExactly() {
        XCTAssertTrue(MCPHTTP.isAuthorized(header: "Bearer s3cret", token: "s3cret"))
        XCTAssertFalse(MCPHTTP.isAuthorized(header: "Bearer s3cre", token: "s3cret"))
        XCTAssertFalse(MCPHTTP.isAuthorized(header: "Bearer s3cret!", token: "s3cret"))
        XCTAssertFalse(MCPHTTP.isAuthorized(header: "bearer s3cret", token: "s3cret"))
        XCTAssertFalse(MCPHTTP.isAuthorized(header: nil, token: "s3cret"))
        XCTAssertFalse(MCPHTTP.isAuthorized(header: "", token: ""))
    }

    func testNegotiatesTheProtocolVersion() {
        XCTAssertEqual(MCPHTTP.negotiatedProtocolVersion(requested: "2024-11-05"), "2024-11-05")
        XCTAssertEqual(MCPHTTP.negotiatedProtocolVersion(requested: "2025-03-26"), "2025-03-26")
        XCTAssertEqual(MCPHTTP.negotiatedProtocolVersion(requested: "1999-01-01"), "2025-06-18")
        XCTAssertEqual(MCPHTTP.negotiatedProtocolVersion(requested: nil), MCPHTTP.supportedProtocolVersions[0])
    }

    func testValidatesPortsAndBuildsTheConfig() throws {
        XCTAssertEqual(MCPHTTP.validatedPort(5000, default: 4478), 5000)
        XCTAssertEqual(MCPHTTP.validatedPort(80, default: 4478), 4478)
        XCTAssertEqual(MCPHTTP.validatedPort(70000, default: 4478), 4478)
        XCTAssertEqual(MCPHTTP.validatedPort(nil, default: 4478), 4478)
        XCTAssertEqual(MCPHTTP.endpointURL(port: 4478), "http://127.0.0.1:4478/mcp")

        let config = try JSONValue.parse(MCPHTTP.configSnippet(serverName: "swash", url: "http://127.0.0.1:4478/mcp", token: "t"))
        XCTAssertEqual(config, ["mcpServers": ["swash": ["headers": ["Authorization": "Bearer t"], "type": "http", "url": "http://127.0.0.1:4478/mcp"]]])
        let open = try JSONValue.parse(MCPHTTP.configSnippet(serverName: "jazz", url: "u", token: ""))
        XCTAssertEqual(open, ["mcpServers": ["jazz": ["type": "http", "url": "u"]]])
    }

    // MARK: Responses

    private func respond(_ request: MCPHTTPRequest, token: String? = nil, dispatched: UnsafeMutablePointer<Int>? = nil) async -> MCPHTTPResponse {
        let context = MCPHTTP.ResponseContext(port: 4490, token: token, sessionID: "sess", realm: "Test")
        return await MCPHTTP.response(to: request, context: context) { method, params in
            dispatched?.pointee += 1
            if method == "boom" { return .failure(code: -32601, message: "Method not found: boom") }
            return .success(["method": .string(method), "params": params.map(JSONValue.object) ?? .null])
        }
    }

    func testDispatchesJSONRPC() async {
        let r = await respond(post(#"{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{"a":1}}"#))
        XCTAssertEqual(r.statusCode, 200)
        XCTAssertEqual(r.headers["Content-Type"], "application/json")
        XCTAssertNil(r.headers["Mcp-Session-Id"])
        XCTAssertEqual(r.json, ["jsonrpc": "2.0", "id": 7, "result": ["method": "tools/list", "params": ["a": 1]]])

        let e = await respond(post(#"{"jsonrpc":"2.0","id":"x","method":"boom"}"#))
        XCTAssertEqual(e.json, ["jsonrpc": "2.0", "id": "x", "error": ["code": -32601, "message": "Method not found: boom"]])

        let i = await respond(post(#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#))
        XCTAssertEqual(i.headers["Mcp-Session-Id"], "sess")
    }

    func testNotificationsAreAccepted() async {
        var calls = 0
        let r = await respond(post(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#), dispatched: &calls)
        XCTAssertEqual(r.statusCode, 202)
        XCTAssertTrue(r.body.isEmpty)
        XCTAssertEqual(calls, 0)
    }

    func testRefusesForeignRequestsBeforeAnythingElse() async {
        let r = await respond(post("{}", headers: ["origin": "https://evil.example"]), token: "t")
        XCTAssertEqual(r.statusCode, 403)
        let plain = await respond(post("{}", headers: ["content-type": "text/plain"]))
        XCTAssertEqual(plain.statusCode, 403)
    }

    func testUnknownPathsAre404BeforeTheToken() async {
        let r = await respond(MCPHTTPRequest(method: "GET", path: "/.well-known/oauth-protected-resource", headers: ["host": "127.0.0.1:4490"]), token: "t")
        XCTAssertEqual(r.statusCode, 404)
        XCTAssertNil(r.headers["WWW-Authenticate"])
    }

    func testAWrongTokenIs401WithAChallenge() async {
        var calls = 0
        let r = await respond(post(#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, headers: ["authorization": "Bearer nope"]), token: "t", dispatched: &calls)
        XCTAssertEqual(r.statusCode, 401)
        XCTAssertEqual(r.headers["WWW-Authenticate"], #"Bearer realm="Test", error="invalid_token""#)
        XCTAssertEqual(r.json?.objectValue?["error"]?.objectValue?["code"], -32001)
        XCTAssertEqual(calls, 0)

        let ok = await respond(post(#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, headers: ["authorization": "Bearer t"]), token: "t")
        XCTAssertEqual(ok.statusCode, 200)
    }

    func testAnUnsupportedProtocolVersionIs400() async {
        let r = await respond(post(#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, headers: ["mcp-protocol-version": "1999-01-01"]))
        XCTAssertEqual(r.statusCode, 400)
        XCTAssertEqual(r.json?.objectValue?["error"]?.objectValue?["code"], -32600)
        let ok = await respond(post(#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, headers: ["mcp-protocol-version": "2025-06-18"]))
        XCTAssertEqual(ok.statusCode, 200)
    }

    func testOtherMethodsAndBadJSON() async {
        let host = ["host": "localhost"]
        let get = await respond(MCPHTTPRequest(method: "GET", path: "/mcp", headers: host))
        XCTAssertEqual(get.statusCode, 405)
        XCTAssertEqual(get.headers["Allow"], "POST, DELETE, OPTIONS")
        let options = await respond(MCPHTTPRequest(method: "OPTIONS", path: "/mcp", headers: host))
        XCTAssertEqual(options.statusCode, 204)
        XCTAssertNil(options.headers["Access-Control-Allow-Origin"])
        let delete = await respond(MCPHTTPRequest(method: "DELETE", path: "/", headers: host))
        XCTAssertEqual(delete.statusCode, 200)
        let put = await respond(MCPHTTPRequest(method: "PUT", path: "/mcp", headers: host))
        XCTAssertEqual(put.statusCode, 405)
        let bad = await respond(post("not json"))
        XCTAssertEqual(bad.statusCode, 400)
        XCTAssertEqual(bad.json?.objectValue?["error"]?.objectValue?["code"], -32700)
    }
}

// MARK: - Router

@MainActor
final class MCPToolRouterTests: XCTestCase {
    private let empty: JSONValue = ["type": "object", "properties": [:], "additionalProperties": false]

    /// A registry with `get_text` and, unless read-only, `set_text`, on a shared text box.
    private func registry(_ text: Box, readOnly: Bool = false) throws -> ToolRegistry {
        let r = ToolRegistry()
        var tools = [
            AgentTool(name: "get_text", description: "Returns the text.", inputSchema: empty, annotations: ToolAnnotations(readOnlyHint: true)) { _, _ in .text(text.value) },
        ]
        if !readOnly {
            tools.append(AgentTool(name: "set_text", description: "Sets the text.", inputSchema: ["type": "object", "properties": ["text": ["type": "string"]], "required": ["text"], "additionalProperties": false]) { args, _ in
                text.value = args["text"]?.stringValue ?? ""
                return .value(["text": .string(text.value)])
            })
        }
        try r.register(AgentToolProvider(id: "doc", namespace: "", tools: tools))
        return r
    }

    final class Box { var value: String; init(_ v: String) { value = v } }

    private func router(singular: String = "document", plural: String? = nil) throws -> MCPToolRouter {
        MCPToolRouter(configuration: .init(serverName: "Swash", serverVersion: "1.2", singular: singular, plural: plural, instructions: "Be kind."), catalog: try registry(Box("")))
    }

    func testInitializeAndPing() async throws {
        let r = try router()
        let result = await r.handle(method: "initialize", params: ["protocolVersion": "2025-03-26"])
        XCTAssertEqual(result, .success([
            "protocolVersion": "2025-03-26",
            "capabilities": ["tools": [:]],
            "serverInfo": ["name": "Swash", "version": "1.2"],
            "instructions": "Be kind.",
        ]))
        let ping = await r.handle(method: "ping", params: nil)
        XCTAssertEqual(ping, .success([:]))
        let unknown = await r.handle(method: "resources/list", params: nil)
        XCTAssertEqual(unknown, .failure(code: -32601, message: "Method not found: resources/list"))
        let noName = await r.handle(method: "tools/call", params: [:])
        XCTAssertEqual(noName, .failure(code: -32602, message: "Missing tool name."))
    }

    func testToolsListIsTheCatalogueWhateverIsOpen() async throws {
        let r = try router()
        func names() async -> [String] {
            guard case .success(let o) = await r.handle(method: "tools/list", params: nil) else { return [] }
            return o["tools"]?.arrayValue?.compactMap { $0.objectValue?["name"]?.stringValue } ?? []
        }
        let none = await names()
        XCTAssertEqual(none, ["list_documents", "get_text", "set_text"])
        r.attach(MCPToolTarget(name: "Notes", registry: try registry(Box(""), readOnly: true), readOnlyReason: "locked"))
        let withReadOnly = await names()
        XCTAssertEqual(withReadOnly, ["list_documents", "get_text", "set_text"])
    }

    func testInjectsTheTargetArgument() throws {
        let r = try router(singular: "canvas", plural: "canvases")
        let tools = r.listTools()
        XCTAssertEqual(tools[0].name, "list_canvases")
        XCTAssertEqual(tools[0].annotations?.readOnlyHint, true)
        XCTAssertEqual(tools[0].inputSchema, empty)
        let set = try XCTUnwrap(tools.first { $0.name == "set_text" })
        let props = try XCTUnwrap(set.inputSchema.objectValue?["properties"]?.objectValue)
        XCTAssertEqual(props["canvas"]?.objectValue?["type"], "string")
        XCTAssertEqual(props["canvas"]?.objectValue?["description"]?.stringValue?.contains("list_canvases"), true)
        XCTAssertNotNil(props["text"])
        XCTAssertEqual(set.inputSchema.objectValue?["required"], ["text"], "the target argument stays optional")
    }

    func testRoutesByIdNameOrMostRecentlyActive() async throws {
        let r = try router()
        let a = Box("alpha"), b = Box("beta")
        let ta = MCPToolTarget(id: "aaaa", name: "Alpha.md", registry: try registry(a), info: ["flavor": "github"])
        let tb = MCPToolTarget(id: "bbbb", name: "Beta.md", registry: try registry(b))
        r.attach(ta)
        try await Task.sleep(nanoseconds: 2_000_000)
        r.attach(tb)

        var res = await r.callTool("get_text", [:])
        XCTAssertEqual(res.text, "beta", "defaults to the last attached")
        try await Task.sleep(nanoseconds: 2_000_000)
        r.activate(ta)
        res = await r.callTool("get_text", [:])
        XCTAssertEqual(res.text, "alpha", "then to the last activated")
        res = await r.callTool("get_text", ["document": "BBBB"])
        XCTAssertEqual(res.text, "beta")
        res = await r.callTool("get_text", ["document": "beta.md"])
        XCTAssertEqual(res.text, "beta")

        // The argument is stripped, so a strict schema still validates.
        res = await r.callTool("set_text", ["document": "Beta.md", "text": "new"])
        XCTAssertFalse(res.isError, res.text ?? "")
        XCTAssertEqual(b.value, "new")
        XCTAssertEqual(a.value, "alpha")

        let list = r.listTargetsResult()
        XCTAssertEqual(list.structuredContent?["documents"], [
            ["id": "aaaa", "name": "Alpha.md", "flavor": "github", "readOnly": false, "isActive": true],
            ["id": "bbbb", "name": "Beta.md", "readOnly": false, "isActive": false],
        ])
        let viaRPC = await r.handle(method: "tools/call", params: ["name": "list_documents", "arguments": [:]])
        XCTAssertEqual(viaRPC, .success(list.json.objectValue!))

        r.detach(ta)
        res = await r.callTool("get_text", [:])
        XCTAssertEqual(res.text, "new", "detaching the default falls back to the other target")
    }

    func testExplainsMissingTargets() async throws {
        let r = try router()
        var res = await r.callTool("get_text", [:])
        XCTAssertTrue(res.isError)
        XCTAssertEqual(res.text, "No documents are open in Swash. Open one first.")
        r.attach(MCPToolTarget(name: "A", registry: try registry(Box(""))))
        res = await r.callTool("get_text", ["document": "Z"])
        XCTAssertTrue(res.isError)
        XCTAssertEqual(res.text, "No open document matches \"Z\". Call list_documents to see the open documents.")
    }

    func testAWriteToolOnAReadOnlyTargetSaysWhy() async throws {
        let r = try router()
        let text = Box("locked text")
        r.attach(MCPToolTarget(name: "Locked.md", registry: try registry(text, readOnly: true), readOnlyReason: "opened from a template"))
        var res = await r.callTool("set_text", ["text": "x"])
        XCTAssertTrue(res.isError)
        XCTAssertEqual(res.text, "\"Locked.md\" is read-only (opened from a template), so set_text can't edit it.")
        XCTAssertEqual(text.value, "locked text")
        res = await r.callTool("get_text", [:])
        XCTAssertEqual(res.text, "locked text", "read tools still work")
        res = await r.callTool("nonexistent", [:])
        XCTAssertTrue(res.isError)
        XCTAssertEqual(res.text?.hasPrefix("Unknown tool \"nonexistent\""), true, "a tool outside the catalogue is just unknown")

        let list = r.listTargetsResult().structuredContent?["documents"]?.arrayValue?.first?.objectValue
        XCTAssertEqual(list?["readOnly"], true)
        XCTAssertEqual(list?["readOnlyReason"], "opened from a template")
    }

    func testAToolWithItsOwnTargetArgumentKeepsIt() async throws {
        let catalog = ToolRegistry()
        let echo = AgentTool(name: "echo", description: "Echoes.", inputSchema: ["type": "object", "properties": ["document": ["type": "string", "description": "The text."]], "additionalProperties": false]) { args, _ in
            .text(args["document"]?.stringValue ?? "-")
        }
        try catalog.register(AgentToolProvider(id: "e", namespace: "", tools: [echo]))
        let r = MCPToolRouter(configuration: .init(serverName: "App", serverVersion: "1"), catalog: catalog)
        r.attach(MCPToolTarget(name: "Only", registry: catalog))
        XCTAssertEqual(r.listTools()[1].inputSchema.objectValue?["properties"]?.objectValue?["document"]?.objectValue?["description"], "The text.")
        let res = await r.callTool("echo", ["document": "hello"])
        XCTAssertEqual(res.text, "hello")
    }
}

// MARK: - Live server

#if canImport(Network)
@MainActor
final class MCPServerControllerTests: XCTestCase {
    private func freePort() -> UInt16 { UInt16.random(in: 40000...59000) }

    private func waitFor(_ controller: MCPServerController, timeout: TimeInterval = 5, _ predicate: (MCPServerStatus) -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate(controller.status) {
            if Date() > deadline { return XCTFail("timed out; status \(controller.status)") }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func call(_ port: UInt16, _ body: String, token: String? = nil) async throws -> (Int, JSONValue?) {
        var request = URLRequest(url: URL(string: MCPHTTP.endpointURL(port: port))!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = Data(body.utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data.isEmpty ? nil : try? JSONValue.parse(data))
    }

    func testServesToolsOverLoopbackAndRestarts() async throws {
        let catalog = ToolRegistry()
        try catalog.register(AgentToolProvider(id: "t", namespace: "", tools: [
            AgentTool(name: "hello", description: "Says hello.", inputSchema: ["type": "object", "properties": [:], "additionalProperties": false]) { _, _ in .text("hi") },
        ]))
        let router = MCPToolRouter(configuration: .init(serverName: "Test", serverVersion: "1"), catalog: catalog)
        router.attach(MCPToolTarget(name: "Doc", registry: catalog))
        let port = freePort()
        let controller = MCPServerController(serverName: "test", realm: "Test", defaultPort: port, router: router)
        XCTAssertEqual(controller.status, .stopped)

        controller.update(enabled: true, port: port, token: "s3cret")
        try await waitFor(controller) { $0 == .listening(port: port) }
        XCTAssertTrue(controller.mcpConfigSnippet().contains(#""type" : "http""#))

        var (status, json) = try await call(port, #"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello","arguments":{}}}"#)
        XCTAssertEqual(status, 401)
        (status, json) = try await call(port, #"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello","arguments":{"document":"Doc"}}}"#, token: "s3cret")
        XCTAssertEqual(status, 200)
        XCTAssertEqual(json?.objectValue?["result"]?.objectValue?["content"], [["type": "text", "text": "hi"]])

        // A token change applies without a restart; a port change restarts.
        controller.update(enabled: true, port: port, token: nil)
        (status, _) = try await call(port, #"{"jsonrpc":"2.0","id":2,"method":"ping"}"#)
        XCTAssertEqual(status, 200)
        let next = port &+ 1
        controller.update(enabled: true, port: next, token: nil)
        try await waitFor(controller) { $0 == .listening(port: next) }
        (status, _) = try await call(next, #"{"jsonrpc":"2.0","id":3,"method":"ping"}"#)
        XCTAssertEqual(status, 200)

        controller.update(enabled: false, port: next, token: nil)
        XCTAssertEqual(controller.status, .stopped)
    }

    func testAPortInUseFailsVisiblyAndCanBeRetried() async throws {
        let port = freePort()
        let handler: MCPRequestHandler = { _, _ in .success([:]) }
        let first = MCPServerController(serverName: "a", realm: "A", defaultPort: port, handler: handler)
        first.update(enabled: true, port: port, token: nil)
        try await waitFor(first) { $0 == .listening(port: port) }

        let second = MCPServerController(serverName: "b", realm: "B", defaultPort: port, handler: handler)
        second.update(enabled: true, port: port, token: nil)
        try await waitFor(second) { if case .failed = $0 { return true }; return false }
        XCTAssertEqual(second.status, .failed("Port \(port) is in use by another app. Choose another port."))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(second.status, .failed("Port \(port) is in use by another app. Choose another port."), "the release of the failed listener doesn't hide the failure")

        first.stop()
        try await Task.sleep(nanoseconds: 100_000_000)
        second.update(enabled: true, port: port, token: nil)
        try await waitFor(second) { $0 == .listening(port: port) }
        second.stop()
    }

    func testAnInvalidPortFallsBackToTheDefault() {
        let c = MCPServerController(serverName: "a", realm: "A", defaultPort: 4478) { _, _ in .success([:]) }
        XCTAssertEqual(c.validatedPort(80), 4478)
        c.update(enabled: false, port: 80, token: "")
        XCTAssertEqual(c.port, 4478)
        XCTAssertNil(c.token)
        XCTAssertEqual(c.endpointURL, "http://127.0.0.1:4478/mcp")
    }
}
#endif
