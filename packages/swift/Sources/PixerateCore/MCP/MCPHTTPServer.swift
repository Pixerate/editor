import Foundation

/// The state of an in-process MCP server.
public enum MCPServerStatus: Equatable, Sendable {
    case stopped
    case starting
    case listening(port: UInt16)
    case failed(String)
}

#if canImport(Network)
import Network
import os

/**
 A minimal Streamable HTTP MCP server on 127.0.0.1 (Network.framework), so MCP clients reach an
 app's tools without an external bridge. One request per connection (`Connection: close`), plain
 JSON responses, no SSE. The HTTP rules are `MCPHTTP.response(to:context:dispatch:)`; JSON-RPC goes
 to `onRequest` (usually `MCPToolRouter.handle`). Most apps use `MCPServerController` instead.

 A listener that fails (e.g. the port is taken) is released and reported as `.failed`, and
 `hasFailed` stays true, so the app can retry. `stop(completion:)` calls back once the socket is
 closed, so a restart on the same port doesn't race the old listener.
 */
@MainActor
public final class MCPHTTPServer {
    public let port: UInt16
    /// Read on every request, so a token change applies without a restart. Nil: no token needed.
    public var token: () -> String?
    /// The 401 challenge's realm and message.
    public var realm: String
    public var unauthorizedMessage: String?
    /// Status changes, on the main actor.
    public var onStateChange: (MCPServerStatus) -> Void
    private let onRequest: MCPRequestHandler

    /// Whether the listener failed (and was released), so the app can retry.
    public private(set) var hasFailed = false

    private var listener: NWListener?
    private var onStopped: (() -> Void)?
    private let sessionID = UUID().uuidString
    private let logger: Logger

    /// - Parameters:
    ///   - port: The port to listen on (127.0.0.1 only). Each app picks its own: there is no shared default.
    ///   - realm: The app's name, for the 401 challenge and messages.
    ///   - logSubsystem: The `Logger` subsystem (e.g. the app's bundle id).
    public init(
        port: UInt16,
        realm: String,
        unauthorizedMessage: String? = nil,
        token: @escaping () -> String? = { nil },
        logSubsystem: String = "com.pixerate.PixerateCore",
        onStateChange: @escaping (MCPServerStatus) -> Void = { _ in },
        onRequest: @escaping MCPRequestHandler
    ) {
        self.port = port
        self.realm = realm
        self.unauthorizedMessage = unauthorizedMessage
        self.token = token
        self.onStateChange = onStateChange
        self.onRequest = onRequest
        logger = Logger(subsystem: logSubsystem, category: "MCPServer")
    }

    /// Starts listening. Reports `.listening` or `.failed` through `onStateChange`.
    public func start() {
        guard listener == nil else { return }
        hasFailed = false
        guard MCPHTTP.validPorts.contains(Int(port)), let nwPort = NWEndpoint.Port(rawValue: port) else {
            fail("Port \(port) is not between \(MCPHTTP.validPorts.lowerBound) and \(MCPHTTP.validPorts.upperBound).")
            return
        }
        onStateChange(.starting)
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: nwPort)
        let listener: NWListener
        do {
            listener = try NWListener(using: params)
        } catch {
            fail(error.localizedDescription)
            return
        }
        self.listener = listener
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            Task { @MainActor [weak self, weak listener] in
                guard let self, let listener, self.listener === listener else { return }
                self.listenerChanged(listener, state)
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor [weak self] in
                guard let self else { return connection.cancel() }
                connection.start(queue: .main)
                self.receive(on: connection, buffer: Data())
            }
        }
        listener.start(queue: .main)
    }

    /// Stops listening; `completion` runs once the socket is closed (at once if not listening).
    public func stop(completion: (() -> Void)? = nil) {
        guard let listener else {
            completion?()
            return
        }
        onStopped = completion
        listener.cancel()
    }

    private func listenerChanged(_ listener: NWListener, _ state: NWListener.State) {
        switch state {
        case .ready:
            logger.notice("Listening on http://127.0.0.1:\(self.port)/mcp")
            onStateChange(.listening(port: port))
        case .failed(let error):
            logger.error("Listener failed on port \(self.port): \(error.localizedDescription)")
            // A failed listener must still be cancelled to release it. Detach it first so its
            // `.cancelled` update is ignored and the failure stays visible.
            self.listener = nil
            listener.cancel()
            fail(Self.failureMessage(error, port: port))
            finishStopping()
        case .cancelled:
            self.listener = nil
            onStateChange(.stopped)
            finishStopping()
        default:
            break
        }
    }

    private func fail(_ message: String) {
        hasFailed = true
        onStateChange(.failed(message))
    }

    private func finishStopping() {
        let completion = onStopped
        onStopped = nil
        completion?()
    }

    /// A readable failure ("Port 4477 is in use by another app…" for EADDRINUSE).
    nonisolated static func failureMessage(_ error: NWError, port: UInt16) -> String {
        if case .posix(.EADDRINUSE) = error {
            return "Port \(port) is in use by another app. Choose another port."
        }
        return error.localizedDescription
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            Task { @MainActor [weak self] in
                guard let self, error == nil else { return connection.cancel() }
                var accumulated = buffer
                if let data { accumulated.append(data) }
                switch MCPHTTP.parseRequest(accumulated) {
                case .request(let request):
                    let context = MCPHTTP.ResponseContext(port: self.port, token: self.token(), sessionID: self.sessionID, realm: self.realm, unauthorizedMessage: self.unauthorizedMessage)
                    let response = await MCPHTTP.response(to: request, context: context, dispatch: self.onRequest)
                    Self.send(response, on: connection)
                case .invalid:
                    Self.send(MCPHTTPResponse(status: "400 Bad Request"), on: connection)
                case .incomplete where isComplete:
                    Self.send(MCPHTTPResponse(status: "400 Bad Request"), on: connection)
                case .incomplete:
                    self.receive(on: connection, buffer: accumulated)
                }
            }
        }
    }

    private static func send(_ response: MCPHTTPResponse, on connection: NWConnection) {
        connection.send(content: response.serialized(), completion: .contentProcessed { _ in connection.cancel() })
    }
}
#endif
