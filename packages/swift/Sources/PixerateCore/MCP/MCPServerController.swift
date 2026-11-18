#if canImport(Network)
import Foundation
import Observation

/**
 Owns an app's in-process MCP server: start, stop and restart it from the app's settings, and show
 its status. Storage-agnostic: the app reads its own settings and calls `update(enabled:port:token:)`.

 ```swift
 let router = MCPToolRouter(configuration: .init(serverName: "Swash", serverVersion: "1.4"), catalog: catalog.registry)
 let mcp = MCPServerController(serverName: "swash", realm: "Swash", defaultPort: 4478, router: router)
 mcp.update(enabled: true, port: storedPort, token: storedToken)
 ```

 Each app passes its own `defaultPort`: there is no shared default, so two apps (or an app and
 `pixerate-mcp-bridge` on `toolBridgeDefaultPort`) don't collide out of the box.
 */
@MainActor
@Observable
public final class MCPServerController {
    public private(set) var status: MCPServerStatus = .stopped
    public private(set) var isEnabled = false
    /// The port the server listens (or will listen) on.
    public private(set) var port: UInt16
    /// The Bearer token, or nil for none. Changing it applies to the next request without a restart.
    public var token: String?

    /// The key of the server in `mcpConfigSnippet()` ("swash").
    public let serverName: String
    /// The app's name, for the 401 challenge and messages ("Swash").
    public let realm: String
    /// The app's default port.
    public let defaultPort: UInt16
    /// The 401 message (default names the app's settings).
    @ObservationIgnored public var unauthorizedMessage: String?
    @ObservationIgnored public var logSubsystem: String

    @ObservationIgnored private let handler: MCPRequestHandler
    @ObservationIgnored private var server: MCPHTTPServer?
    @ObservationIgnored private var generation = 0

    public init(serverName: String, realm: String, defaultPort: UInt16, logSubsystem: String = "com.pixerate.PixerateCore", handler: @escaping MCPRequestHandler) {
        self.serverName = serverName
        self.realm = realm
        self.defaultPort = defaultPort
        self.port = defaultPort
        self.logSubsystem = logSubsystem
        self.handler = handler
    }

    /// A controller that answers requests with `router.handle`.
    public convenience init(serverName: String, realm: String, defaultPort: UInt16, logSubsystem: String = "com.pixerate.PixerateCore", router: MCPToolRouter) {
        self.init(serverName: serverName, realm: realm, defaultPort: defaultPort, logSubsystem: logSubsystem) { [weak router] method, params in
            guard let router else { return .failure(code: -32603, message: "Server shut down.") }
            return await router.handle(method: method, params: params)
        }
    }

    /// The endpoint clients connect to.
    public var endpointURL: String { MCPHTTP.endpointURL(port: port) }

    /// The `mcpServers` JSON for a "Copy MCP Config" button (with `"type": "http"`).
    public func mcpConfigSnippet() -> String {
        MCPHTTP.configSnippet(serverName: serverName, url: endpointURL, token: token)
    }

    /// A stored port setting if valid, else this app's default.
    public func validatedPort(_ raw: Int?) -> UInt16 { MCPHTTP.validatedPort(raw, default: defaultPort) }

    /**
     Applies the settings: stops when disabled; when enabled, starts, or restarts if the port
     changed or the last listener failed. An invalid port falls back to `defaultPort`.
     */
    public func update(enabled: Bool, port: UInt16, token: String?) {
        self.token = token.flatMap { $0.isEmpty ? nil : $0 }
        isEnabled = enabled
        let port = validatedPort(Int(port))
        guard enabled else {
            self.port = port
            stop()
            return
        }
        if let server, server.port == port, !server.hasFailed { return }
        self.port = port
        restart()
    }

    /// Restarts the listener, waiting for the old socket to close before binding again.
    public func restart() {
        guard isEnabled else { return stop() }
        generation += 1
        let current = generation
        guard let old = server else { return startServer() }
        status = .starting
        old.stop { [weak self] in
            guard let self, self.generation == current, self.isEnabled else { return }
            self.server = nil
            self.startServer()
        }
    }

    /// Stops the server.
    public func stop() {
        generation += 1
        server?.stop()
        server = nil
        status = .stopped
    }

    private func startServer() {
        let server = MCPHTTPServer(port: port, realm: realm, unauthorizedMessage: unauthorizedMessage, token: { [weak self] in self?.token }, logSubsystem: logSubsystem, onRequest: handler)
        // An old server's late updates (its `.cancelled`) must not overwrite the new one's status.
        server.onStateChange = { [weak self, weak server] status in
            guard let self, let server, self.server === server else { return }
            self.status = status
        }
        self.server = server
        server.start()
    }
}
#endif
