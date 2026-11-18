import Foundation

// The transport rules of the in-process Streamable HTTP MCP server (`MCPHTTPServer`), kept free of
// sockets so they can be tested on their own: HTTP/1.1 request parsing with size limits, the
// local-only request check (Host / Origin / DNS rebinding / `application/json`), the Bearer token
// compared in constant time, MCP protocol-version negotiation, and the response to each request.
// First written for Swash (GOTCHAS "[swift/core] The In-Process MCP Server…").

/// The answer to a JSON-RPC request: a `result` object or an `error`.
public enum MCPDispatchResult: Equatable, Sendable {
    case success(JSONObject)
    case failure(code: Int, message: String)
}

/// Answers one JSON-RPC request (`method`, `params`). `MCPToolRouter.handle` is one.
public typealias MCPRequestHandler = (_ method: String, _ params: JSONObject?) async -> MCPDispatchResult

/// A parsed HTTP/1.1 request. Header names are lowercased.
public struct MCPHTTPRequest: Equatable, Sendable {
    public var method: String
    public var path: String
    public var headers: [String: String]
    public var body: Data

    public init(method: String, path: String, headers: [String: String] = [:], body: Data = Data()) {
        self.method = method
        self.path = path
        self.headers = headers
        self.body = body
    }

    /// The path without its query string.
    public var pathWithoutQuery: String {
        path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? path
    }
}

/// An HTTP response. `serialized()` adds `Content-Length` and `Connection: close`.
public struct MCPHTTPResponse: Equatable, Sendable {
    /// Status line text, e.g. "200 OK".
    public var status: String
    public var headers: [String: String]
    public var body: Data

    public init(status: String, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    /// A JSON body with `Content-Type: application/json`.
    public static func json(_ status: String, _ value: JSONValue, headers: [String: String] = [:]) -> MCPHTTPResponse {
        var h = headers
        h["Content-Type"] = "application/json"
        return MCPHTTPResponse(status: status, headers: h, body: Data(value.stringified().utf8))
    }

    /// The numeric status code.
    public var statusCode: Int { Int(status.prefix(while: { $0.isNumber })) ?? 0 }

    /// The body as JSON, if it is JSON.
    public var json: JSONValue? { body.isEmpty ? nil : try? JSONValue.parse(body) }

    /// The bytes sent on the wire.
    public func serialized() -> Data {
        var lines = ["HTTP/1.1 \(status)", "Content-Length: \(body.count)", "Connection: close"]
        for (k, v) in headers.sorted(by: { $0.key < $1.key }) { lines.append("\(k): \(v)") }
        var data = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
        data.append(body)
        return data
    }
}

/// The transport rules of the in-process MCP server.
public enum MCPHTTP {
    /// MCP protocol versions the server speaks, newest first.
    public static let supportedProtocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"]

    /// The largest request body accepted (4 MB).
    public static let maximumBodySize = 4 * 1024 * 1024

    /// The largest request head (request line and headers) accepted (64 KB).
    public static let maximumHeaderSize = 64 * 1024

    /// Ports a server may listen on: unprivileged, so binding never needs root.
    public static let validPorts: ClosedRange<Int> = 1024...65535

    /// The endpoint clients connect to.
    public static func endpointURL(port: UInt16) -> String { "http://127.0.0.1:\(port)/mcp" }

    /// A stored port setting if it is in `validPorts`, else the app's default.
    public static func validatedPort(_ raw: Int?, default fallback: UInt16) -> UInt16 {
        guard let raw, validPorts.contains(raw) else { return fallback }
        return UInt16(raw)
    }

    /// The version to answer `initialize` with: the client's if supported, else the newest.
    public static func negotiatedProtocolVersion(requested: String?) -> String {
        requested.flatMap { supportedProtocolVersions.contains($0) ? $0 : nil } ?? supportedProtocolVersions[0]
    }

    /// The `mcpServers` JSON an MCP client config takes. `"type": "http"` is required: Claude Code
    /// reads an entry without it as a stdio server and rejects it.
    public static func configSnippet(serverName: String, url: String, token: String?) -> String {
        var entry: [String: Any] = ["type": "http", "url": url]
        if let token, !token.isEmpty { entry["headers"] = ["Authorization": "Bearer \(token)"] }
        let root: [String: Any] = ["mcpServers": [serverName: entry]]
        guard let data = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    // MARK: Parsing

    public enum ParseResult: Equatable, Sendable {
        /// More bytes are needed.
        case incomplete
        /// The request can't be served (bad request line, bad or oversized `Content-Length`,
        /// chunked body, oversized head): answer 400.
        case invalid
        case request(MCPHTTPRequest)
    }

    /// Parses an HTTP/1.1 request from the bytes received so far.
    public static func parseRequest(_ data: Data) -> ParseResult {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else {
            return data.count > maximumHeaderSize ? .invalid : .incomplete
        }
        guard headerEnd.lowerBound - data.startIndex <= maximumHeaderSize,
              let head = String(data: data[data.startIndex..<headerEnd.lowerBound], encoding: .utf8) else { return .invalid }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count >= 2 else { return .invalid }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }
        // Bodies are read by Content-Length only.
        if headers["transfer-encoding"] != nil { return .invalid }
        // A negative or absurd length would trap when slicing (any local process could crash the app).
        guard let length = Int(headers["content-length"] ?? "0"), length >= 0, length <= maximumBodySize else { return .invalid }
        let bodyStart = headerEnd.upperBound
        guard data.endIndex - bodyStart >= length else { return .incomplete }
        let body = Data(data[bodyStart..<(bodyStart + length)])
        return .request(MCPHTTPRequest(method: String(parts[0]).uppercased(), path: String(parts[1]), headers: headers, body: body))
    }

    // MARK: Checks

    /**
     Whether a request may reach the tools. Web pages can send requests to 127.0.0.1 too and the
     token is optional, so (as the MCP Streamable HTTP transport requires) a request from a browser
     page on another origin, or naming a host other than this machine (DNS rebinding), is refused.
     POSTs must be `application/json`, which a page on another origin can't send without a CORS
     preflight, and the server never answers one with CORS headers.
     */
    public static func isAllowed(method: String, headers: [String: String], port: UInt16) -> Bool {
        let localHosts: Set<String> = ["127.0.0.1", "localhost", "[::1]"]
        guard let host = headers["host"]?.lowercased(),
              localHosts.contains(host) || localHosts.contains(where: { host == "\($0):\(port)" }) else { return false }
        if let origin = headers["origin"] {
            guard let originHost = URL(string: origin)?.host(percentEncoded: false),
                  ["127.0.0.1", "localhost", "::1"].contains(originHost.lowercased()) else { return false }
        }
        if method.uppercased() == "POST" {
            let type = headers["content-type"]?.split(separator: ";").first?
                .trimmingCharacters(in: .whitespaces).lowercased()
            guard type == "application/json" else { return false }
        }
        return true
    }

    /// Compares an `Authorization` header with `Bearer <token>` in constant time (for the token's length).
    public static func isAuthorized(header: String?, token: String) -> Bool {
        let expected = Array("Bearer \(token)".utf8)
        let given = Array((header ?? "").utf8)
        var diff = UInt8(expected.count == given.count ? 0 : 1)
        for i in expected.indices {
            diff |= expected[i] ^ (i < given.count ? given[i] : 0)
        }
        return diff == 0
    }

    // MARK: Responding

    /// What the server says about itself in errors and challenges.
    public struct ResponseContext: Sendable {
        /// The port the server listens on (for the Host check).
        public var port: UInt16
        /// The Bearer token, or nil when the server takes requests without one.
        public var token: String?
        /// The `Mcp-Session-Id` sent with the `initialize` response.
        public var sessionID: String
        /// The `realm` of the 401 challenge (the app's name).
        public var realm: String
        /// The message of a 401, telling the person where the token is.
        public var unauthorizedMessage: String

        public init(port: UInt16, token: String?, sessionID: String = UUID().uuidString, realm: String, unauthorizedMessage: String? = nil) {
            self.port = port
            self.token = token
            self.sessionID = sessionID
            self.realm = realm
            self.unauthorizedMessage = unauthorizedMessage
                ?? "Unauthorized: send \"Authorization: Bearer <token>\" with the token from \(realm)'s settings."
        }
    }

    /**
     The response to one request, in this order: 403 for a request that isn't local, 404 for any
     path but `/mcp` and `/` (before the token, so OAuth discovery at `/.well-known/…` doesn't get a
     401 that sends clients looking for an authorization server), 401 with `WWW-Authenticate` for a
     missing or wrong token, 400 for an unsupported `MCP-Protocol-Version`, then by method: POST
     dispatches JSON-RPC (notifications get 202), GET is 405 (no SSE stream), DELETE ends the
     session, OPTIONS lists the methods without CORS headers.
     */
    public static func response(to request: MCPHTTPRequest, context: ResponseContext, dispatch: MCPRequestHandler) async -> MCPHTTPResponse {
        guard isAllowed(method: request.method, headers: request.headers, port: context.port) else {
            return MCPHTTPResponse(status: "403 Forbidden")
        }
        let path = request.pathWithoutQuery
        guard path == "/mcp" || path == "/" else { return MCPHTTPResponse(status: "404 Not Found") }

        if let token = context.token, !isAuthorized(header: request.headers["authorization"], token: token) {
            return .json("401 Unauthorized", rpcError(.null, -32001, context.unauthorizedMessage), headers: [
                "WWW-Authenticate": "Bearer realm=\"\(context.realm)\", error=\"invalid_token\"",
            ])
        }
        // Clients send the negotiated version on every request after `initialize` (2025-06-18).
        if let version = request.headers["mcp-protocol-version"], !supportedProtocolVersions.contains(version) {
            let message = "Unsupported MCP-Protocol-Version \(version). Supported: \(supportedProtocolVersions.joined(separator: ", "))."
            return .json("400 Bad Request", rpcError(.null, -32600, message))
        }

        switch request.method {
        case "OPTIONS":
            return MCPHTTPResponse(status: "204 No Content", headers: ["Allow": "GET, POST, DELETE, OPTIONS"])
        case "GET":
            return MCPHTTPResponse(status: "405 Method Not Allowed", headers: ["Allow": "POST, DELETE, OPTIONS"])
        case "DELETE":
            return MCPHTTPResponse(status: "200 OK")
        case "POST":
            guard let message = (try? JSONValue.parse(request.body))?.objectValue,
                  let method = message["method"]?.stringValue else {
                return .json("400 Bad Request", rpcError(.null, -32700, "Invalid JSON-RPC request"))
            }
            // Notifications have no id and get 202 Accepted with an empty body.
            guard let id = message["id"], !id.isNull else { return MCPHTTPResponse(status: "202 Accepted") }
            let reply: JSONValue
            switch await dispatch(method, message["params"]?.objectValue) {
            case .success(let result): reply = ["jsonrpc": "2.0", "id": id, "result": .object(result)]
            case .failure(let code, let text): reply = rpcError(id, code, text)
            }
            return .json("200 OK", reply, headers: method == "initialize" ? ["Mcp-Session-Id": context.sessionID] : [:])
        default:
            return MCPHTTPResponse(status: "405 Method Not Allowed", headers: ["Allow": "POST, DELETE, OPTIONS"])
        }
    }

    private static func rpcError(_ id: JSONValue, _ code: Int, _ message: String) -> JSONValue {
        ["jsonrpc": "2.0", "id": id, "error": ["code": .number(Double(code)), "message": .string(message)]]
    }
}
