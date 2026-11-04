import Foundation
import XCTest
@testable import PixerateCore

/// A socket the test drives: it records what the client sends.
@MainActor
private final class FakeSocket: ToolBridgeSocket {
    let url: URL
    weak var delegate: ToolBridgeSocketDelegate?
    var sent: [JSONObject] = []
    var closedWith: (Int, String)?

    init(url: URL, delegate: ToolBridgeSocketDelegate) {
        self.url = url
        self.delegate = delegate
    }

    func send(_ text: String) { sent.append(try! JSONValue.parse(text).objectValue!) }
    func close(code: Int, reason: String) { closedWith = (code, reason) }
}

@MainActor
final class ToolBridgeTests: XCTestCase {
    private var sockets: [FakeSocket] = []
    private var statuses: [ToolBridgeStatus] = []

    private func registry(slow: @escaping () async -> Void = {}) throws -> ToolRegistry {
        let r = ToolRegistry()
        let schema: JSONValue = ["type": "object", "properties": ["x": ["type": "number"]], "required": ["x"], "additionalProperties": false]
        _ = try r.register(AgentToolProvider(id: "paint", tools: [
            AgentTool(name: "double", description: "Doubles x.", inputSchema: schema, annotations: ToolAnnotations(readOnlyHint: true)) { args, _ in
                await slow()
                return .value(["x": .number((args["x"]?.numberValue ?? 0) * 2)])
            },
        ]))
        return r
    }

    private func connect(_ registry: ToolRegistry, reconnect: Bool = true) -> ToolBridgeClient {
        ToolBridgeClient(registry: registry, options: ToolBridgeOptions(name: "Paint — Sketch", kind: "paint", token: "s3cret", reconnect: reconnect, reconnectDelay: 0.01, openSocket: { url, delegate in
            let socket = FakeSocket(url: url, delegate: delegate)
            self.sockets.append(socket)
            return socket
        }, onStatus: { status, _ in self.statuses.append(status) }))
    }

    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    func testHelloWelcomeCallAndResult() async throws {
        let client = connect(try registry())
        let socket = try XCTUnwrap(sockets.first)
        XCTAssertEqual(socket.url.absoluteString, "ws://127.0.0.1:4477?token=s3cret")
        XCTAssertEqual(client.status, .connecting)
        socket.delegate?.socketDidOpen()
        let hello = try XCTUnwrap(socket.sent.first)
        XCTAssertEqual(hello["t"], "hello")
        XCTAssertEqual(hello["v"], 1)
        XCTAssertEqual(hello["name"], "Paint — Sketch")
        XCTAssertEqual(hello["kind"], "paint")
        XCTAssertEqual(hello["tools"]?.arrayValue?.first?.objectValue?["name"], "paint__double")
        socket.delegate?.socketDidReceive(#"{"t":"welcome","v":1,"id":"e1"}"#)
        XCTAssertEqual(client.status, .connected)
        XCTAssertEqual(client.editorId, "e1")
        socket.delegate?.socketDidReceive(#"{"t":"call","id":"c1","name":"double","arguments":{"x":21}}"#)
        await settle()
        let result = try XCTUnwrap(socket.sent.last)
        XCTAssertEqual(result["t"], "result")
        XCTAssertEqual(result["id"], "c1")
        XCTAssertEqual(result["result"]?.objectValue?["structuredContent"], ["x": 42])
        // Invalid arguments come back as an error result the agent can act on
        socket.delegate?.socketDidReceive(#"{"t":"call","id":"c2","name":"double","arguments":{}}"#)
        await settle()
        XCTAssertEqual(socket.sent.last?["result"]?.objectValue?["isError"], true)
        client.close()
        XCTAssertEqual(socket.closedWith?.0, 1000)
        XCTAssertEqual(client.status, .closed)
        XCTAssertEqual(statuses, [.connected, .closed])
    }

    func testCancelledCallsSendNoResult() async throws {
        let gate = AsyncStream<Void>.makeStream()
        let client = connect(try registry(slow: { for await _ in gate.stream { break } }))
        let socket = try XCTUnwrap(sockets.first)
        socket.delegate?.socketDidOpen()
        socket.delegate?.socketDidReceive(#"{"t":"call","id":"c1","name":"double","arguments":{"x":1}}"#)
        await settle()
        socket.delegate?.socketDidReceive(#"{"t":"cancel","id":"c1","reason":"Stop."}"#)
        gate.continuation.yield()
        await settle()
        XCTAssertFalse(socket.sent.contains { $0["t"] == "result" })
        client.close()
    }

    func testToolListChangesAreSent() async throws {
        let r = try registry()
        let client = connect(r)
        let socket = try XCTUnwrap(sockets.first)
        socket.delegate?.socketDidOpen()
        _ = try r.register(AgentToolProvider(id: "vector", tools: [AgentTool(name: "ping", description: "Ping.", inputSchema: ["type": "object", "properties": [:], "additionalProperties": false]) { _, _ in .none }]))
        r.notifyListChanged()
        await settle()
        let tools = try XCTUnwrap(socket.sent.last { $0["t"] == "tools" })
        XCTAssertEqual(tools["tools"]?.arrayValue?.compactMap { $0.objectValue?["name"]?.stringValue }, ["paint__double", "vector__ping"])
        client.close()
    }

    func testReconnectsAfterTheBridgeGoesAway() async throws {
        let client = connect(try registry())
        sockets[0].delegate?.socketDidOpen()
        sockets[0].delegate?.socketDidReceive(#"{"t":"welcome","v":1,"id":"e1"}"#)
        sockets[0].delegate?.socketDidClose(code: 1001, reason: "Bridge stopped.")
        XCTAssertEqual(client.status, .disconnected)
        XCTAssertNil(client.editorId)
        for _ in 0..<50 where sockets.count < 2 { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(sockets.count, 2, "a new socket after the delay")
        XCTAssertEqual(client.status, .connecting)
        client.close()
        // No reconnecting when told not to
        let once = connect(try registry(), reconnect: false)
        sockets.last?.delegate?.socketDidClose(code: 1006, reason: nil)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(sockets.count, 3)
        XCTAssertEqual(once.status, .disconnected)
    }
}

/// Against a real `pixerate-mcp-bridge` over a real WebSocket, when one is running: set
/// `PIXERATE_BRIDGE_TEST_PORT` (and `PIXERATE_BRIDGE_TEST_TOKEN`) to its port and token. The test
/// connects, then waits up to 30 s for an MCP client to call its `echo` tool through the bridge.
@MainActor
final class ToolBridgeLiveTests: XCTestCase {
    func testServesCallsThroughARunningBridge() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let port = env["PIXERATE_BRIDGE_TEST_PORT"] else { throw XCTSkip("No bridge: set PIXERATE_BRIDGE_TEST_PORT.") }
        let registry = ToolRegistry()
        var echoed: String?
        _ = try registry.register(AgentToolProvider(id: "swift", tools: [
            AgentTool(name: "echo", description: "Returns its text.", inputSchema: ["type": "object", "properties": ["text": ["type": "string"]], "required": ["text"], "additionalProperties": false], annotations: ToolAnnotations(readOnlyHint: true)) { args, _ in
                echoed = args["text"]?.stringValue
                return .value(["echo": .string(echoed ?? "")])
            },
        ]))
        let client = ToolBridgeClient(registry: registry, options: ToolBridgeOptions(name: "Swift test editor", kind: "paint", url: URL(string: "ws://127.0.0.1:\(port)")!, token: env["PIXERATE_BRIDGE_TEST_TOKEN"]))
        for _ in 0..<300 where client.status != .connected { try await Task.sleep(nanoseconds: 100_000_000) }
        XCTAssertEqual(client.status, .connected)
        XCTAssertNotNil(client.editorId)
        for _ in 0..<300 where echoed == nil { try await Task.sleep(nanoseconds: 100_000_000) }
        XCTAssertEqual(echoed, "hello from MCP")
        client.close()
    }
}
