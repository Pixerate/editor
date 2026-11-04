import Foundation

// The editor side of the tool bridge, as `tools/bridge-client.ts`: an editor connects its
// `ToolRegistry` to a local MCP bridge (`pixerate-mcp-bridge`) over a WebSocket, and the bridge's
// MCP client (Claude Desktop, Claude Code, an IDE) can then list and call the editor's tools, by
// the same names and schemas as the TypeScript editors'.

/// Protocol version spoken with the bridge (`TOOL_BRIDGE_PROTOCOL`).
public let toolBridgeProtocol = 1

/// Default port the bridge listens on (127.0.0.1 only).
public let toolBridgeDefaultPort = 4477

public enum ToolBridgeStatus: String, Sendable {
    case connecting, connected, disconnected, closed
}

/// Receives a socket's events.
@MainActor
public protocol ToolBridgeSocketDelegate: AnyObject {
    func socketDidOpen()
    func socketDidReceive(_ text: String)
    func socketDidClose(code: Int, reason: String?)
}

/// The parts of a WebSocket the client uses; `URLSessionToolBridgeSocket` is the real one.
@MainActor
public protocol ToolBridgeSocket: AnyObject {
    func send(_ text: String)
    func close(code: Int, reason: String)
}

public struct ToolBridgeOptions {
    /// Bridge URL (default `ws://127.0.0.1:4477`).
    public var url: URL
    /// The bridge's token, if it was started with one (sent as `?token=`).
    public var token: String?
    /// How this editor is listed to the agent (`list_editors`), e.g. "Paint — Sketch".
    public var name: String
    /// What kind of editor this is ("paint", "vector"…), shown in `list_editors`.
    public var kind: String?
    /// Reconnect after the bridge goes away (default true), backing off up to 10 s.
    public var reconnect: Bool
    /// The first reconnect delay in seconds (doubles each time, up to 10 s).
    public var reconnectDelay: Double
    /// Opens a socket to a URL (default: `URLSessionToolBridgeSocket`).
    public var openSocket: @MainActor (URL, ToolBridgeSocketDelegate) -> ToolBridgeSocket
    /// Called when the connection state changes.
    public var onStatus: (@MainActor (ToolBridgeStatus, String?) -> Void)?

    public init(name: String, kind: String? = nil, url: URL = URL(string: "ws://127.0.0.1:\(toolBridgeDefaultPort)")!, token: String? = nil, reconnect: Bool = true, reconnectDelay: Double = 0.5, openSocket: @escaping @MainActor (URL, ToolBridgeSocketDelegate) -> ToolBridgeSocket = { URLSessionToolBridgeSocket(url: $0, delegate: $1) }, onStatus: (@MainActor (ToolBridgeStatus, String?) -> Void)? = nil) {
        self.name = name
        self.kind = kind
        self.url = url
        self.token = token
        self.reconnect = reconnect
        self.reconnectDelay = reconnectDelay
        self.openSocket = openSocket
        self.onStatus = onStatus
    }
}

/**
 Connects a `ToolRegistry` to a local MCP bridge: the registry's tool list is sent on connect and
 whenever it changes, calls run through `registry.callTool` (a cancelled call sends no result), and
 the connection comes back after the bridge restarts. Lives on the main actor, as editors do.
 */
@MainActor
public final class ToolBridgeClient: ToolBridgeSocketDelegate {
    public private(set) var status: ToolBridgeStatus = .connecting
    /// The id the bridge gave this editor (`list_editors`), once connected.
    public private(set) var editorId: String?

    private let registry: ToolRegistry
    private let options: ToolBridgeOptions
    private var socket: ToolBridgeSocket?
    private var closed = false
    private var delay: Double
    private var retry: Task<Void, Never>?
    private var running: [String: Task<Void, Never>] = [:]
    private var listSubscription: Cancellable?

    public init(registry: ToolRegistry, options: ToolBridgeOptions) {
        self.registry = registry
        self.options = options
        delay = options.reconnectDelay
        listSubscription = registry.onListChanged { [weak self] tools in
            Task { @MainActor in self?.send(["t": "tools", "tools": .array(tools.map(\.json))]) }
        }
        open()
    }

    /// The URL with the token as `?token=`.
    var connectURL: URL {
        guard let token = options.token, var components = URLComponents(url: options.url, resolvingAgainstBaseURL: false) else { return options.url }
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "token", value: token)]
        return components.url ?? options.url
    }

    /// Disconnects and stops reconnecting; running calls are cancelled.
    public func close() {
        guard !closed else { return }
        closed = true
        retry?.cancel()
        listSubscription?.cancel()
        cancelRunning()
        let ws = socket
        socket = nil
        ws?.close(code: 1000, reason: "Editor closed.")
        setStatus(.closed)
    }

    private func open() {
        guard !closed else { return }
        setStatus(.connecting)
        socket = options.openSocket(connectURL, self)
    }

    private func setStatus(_ next: ToolBridgeStatus, _ detail: String? = nil) {
        if next == status && detail == nil { return }
        status = next
        options.onStatus?(next, detail)
    }

    private func send(_ message: JSONObject) {
        socket?.send(JSONValue.object(message).stringified())
    }

    private func cancelRunning() {
        for task in running.values { task.cancel() }
        running = [:]
    }

    // MARK: ToolBridgeSocketDelegate

    public func socketDidOpen() {
        delay = options.reconnectDelay
        var hello: JSONObject = ["t": "hello", "v": .number(Double(toolBridgeProtocol)), "name": .string(options.name)]
        if let kind = options.kind { hello["kind"] = .string(kind) }
        hello["tools"] = .array(registry.listTools().map(\.json))
        send(hello)
    }

    public func socketDidReceive(_ text: String) {
        guard let message = try? JSONValue.parse(text).objectValue, let type = message["t"]?.stringValue else { return }
        switch type {
        case "welcome":
            editorId = message["id"]?.stringValue
            setStatus(.connected)
        case "call":
            guard let id = message["id"]?.stringValue, let name = message["name"]?.stringValue else { return }
            let args = message["arguments"]?.objectValue ?? JSONObject()
            running[id] = Task { [weak self] in
                guard let self else { return }
                let result = await self.registry.callTool(name, args)
                guard !Task.isCancelled, self.running[id] != nil else { return }
                self.running[id] = nil
                self.send(["t": "result", "id": .string(id), "result": result.json])
            }
        case "cancel":
            guard let id = message["id"]?.stringValue else { return }
            running.removeValue(forKey: id)?.cancel()
        default:
            break
        }
    }

    public func socketDidClose(code: Int, reason: String?) {
        socket = nil
        editorId = nil
        cancelRunning()
        if closed { return setStatus(.closed) }
        setStatus(.disconnected, reason?.isEmpty == false ? reason : nil)
        guard options.reconnect else { return }
        let wait = delay
        delay = min(10, delay * 2)
        retry = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.open()
        }
    }
}

/// A `ToolBridgeSocket` on `URLSessionWebSocketTask`.
@MainActor
public final class URLSessionToolBridgeSocket: NSObject, ToolBridgeSocket, URLSessionWebSocketDelegate {
    private weak var delegate: ToolBridgeSocketDelegate?
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var didClose = false

    public init(url: URL, delegate: ToolBridgeSocketDelegate) {
        self.delegate = delegate
        super.init()
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        self.session = session
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        receive()
    }

    public func send(_ text: String) {
        task?.send(.string(text)) { _ in }
    }

    public func close(code: Int, reason: String) {
        task?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: Data(reason.utf8))
        finish(code: code, reason: reason)
    }

    private func receive() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(.string(let text)):
                    self.delegate?.socketDidReceive(text)
                    self.receive()
                case .success(.data(let data)):
                    self.delegate?.socketDidReceive(String(decoding: data, as: UTF8.self))
                    self.receive()
                case .success:
                    self.receive()
                case .failure(let error):
                    self.finish(code: 1006, reason: error.localizedDescription)
                }
            }
        }
    }

    private func finish(code: Int, reason: String?) {
        guard !didClose else { return }
        didClose = true
        session?.invalidateAndCancel()
        delegate?.socketDidClose(code: code, reason: reason)
    }

    nonisolated public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        MainActor.assumeIsolated { self.delegate?.socketDidOpen() }
    }

    nonisolated public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        MainActor.assumeIsolated { self.finish(code: closeCode.rawValue, reason: reason.map { String(decoding: $0, as: UTF8.self) }) }
    }
}
