import Foundation
import PixerateCore
import SwiftUI

/// The bridge connection's state for the panel.
@MainActor
@Observable
final class BridgeConnection {
    var status: ToolBridgeStatus = .closed
    var detail: String?
    var editorId: String?
    @ObservationIgnored private var client: ToolBridgeClient?

    var connected: Bool { client != nil }

    /// Connects `registry` to the bridge at `url` (with `token` when the bridge was started with one).
    func connect(_ registry: ToolRegistry, name: String = "Paint — Swift demo", kind: String = "paint", url: String, token: String) {
        disconnect()
        guard let u = URL(string: url) else {
            detail = "\(url) is not a URL."
            return
        }
        status = .connecting
        detail = nil
        client = ToolBridgeClient(registry: registry, options: ToolBridgeOptions(name: name, kind: kind, url: u, token: token.isEmpty ? nil : token, onStatus: { [weak self] status, detail in
            guard let self else { return }
            self.status = status
            self.detail = detail
            self.editorId = self.client?.editorId
        }))
    }

    func disconnect() {
        client?.close()
        client = nil
        status = .closed
        editorId = nil
    }
}

/**
 * The agent panel: the tools the editor registers (name and title), and a switch that connects
 * them to `pixerate-mcp-bridge` (start it with `npx pixerate-mcp-bridge`; see docs/mcp-bridge.md),
 * with the connection's status, the editor id agents pass, and the bridge token.
 */
struct AgentPanel: View {
    let registry: ToolRegistry
    var name: String = "Paint — Swift demo"
    var kind: String = "paint"
    @State private var bridge = BridgeConnection()
    @State private var url = "ws://127.0.0.1:\(toolBridgeDefaultPort)"
    @State private var token = ""

    var body: some View {
        let tools = registry.listTools()
        VStack(alignment: .leading, spacing: 10) {
            Text("Agent").font(.headline)
            Toggle("Connect to pixerate-mcp-bridge", isOn: Binding(get: { bridge.connected }, set: { on in
                if on { bridge.connect(registry, name: name, kind: kind, url: url, token: token) } else { bridge.disconnect() }
            }))
            .toggleStyle(.switch)
            TextField("Bridge URL", text: $url).textFieldStyle(.roundedBorder).disabled(bridge.connected)
            SecureField("Token", text: $token).textFieldStyle(.roundedBorder).disabled(bridge.connected)
            Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 4) {
                GridRow {
                    Text("Status").foregroundStyle(.secondary)
                    Text(bridge.status.rawValue).foregroundStyle(bridge.status == .connected ? .green : .primary)
                }
                GridRow {
                    Text("Editor id").foregroundStyle(.secondary)
                    Text(bridge.editorId ?? "—").textSelection(.enabled).font(.body.monospaced())
                }
            }
            .font(.caption)
            if let d = bridge.detail { Text(d).font(.caption).foregroundStyle(.secondary) }
            Divider()
            Text("\(tools.count) tools").font(.subheadline.weight(.semibold))
            List(tools, id: \.name) { t in
                VStack(alignment: .leading, spacing: 1) {
                    Text(t.name).font(.caption.monospaced())
                    if let title = t.title { Text(title).font(.caption2).foregroundStyle(.secondary) }
                }
            }
            .listStyle(.plain)
        }
        .padding(10)
        .onDisappear { bridge.disconnect() }
    }
}
