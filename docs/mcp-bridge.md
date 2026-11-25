# MCP bridge

The bridge lets an MCP client (Claude Desktop, Claude Code, an IDE) drive editors that are open in a browser tab. It is one Node process: it speaks MCP to the client over stdio and listens on a localhost WebSocket. Each page connects its `ToolRegistry` to it, and the bridge forwards the page's tools. Ported from Ursula's `createRemoteBridge` and built on `createMcpServer`.

```
MCP client ──stdio──▶ pixerate-mcp-bridge ──ws://127.0.0.1:4477──▶ tab (ToolRegistry) ──▶ editor
```

## Run the bridge

Add it to the MCP client's configuration, for example:

```json
{
  "mcpServers": {
    "pixerate": { "command": "npx", "args": ["pixerate-mcp-bridge", "--token", "choose-a-secret"] }
  }
}
```

Flags: `--port` (default 4477), `--token` (or `PIXERATE_BRIDGE_TOKEN`), `--origin URL` (repeatable; browser origins allowed besides localhost ones), `--name`. In code:

```ts
import { createToolBridge } from "@pixerate/editor/bridge";

const bridge = await createToolBridge({ name: "my-app", token: process.env.BRIDGE_TOKEN, origins: ["https://app.example.com"] });
```

`@pixerate/editor/bridge` is Node only and has no dependencies. The WebSocket server is a small RFC 6455 implementation on `node:http`.

## Connect a page

```ts
import { connectToolBridge } from "@pixerate/editor/tools";

const connection = connectToolBridge(registry, { name: "Order flow diagram", kind: "diagram", token: "choose-a-secret" });
```

- React: `useToolBridge(registry, options | null)`. Svelte: `useToolBridge(() => registry, () => options)`. Both return `status`, `detail` and `editorId`.
- The demo's agent-tools panel has a **Connect** button for this.

The page sends its tool list on connect and whenever it changes. The bridge then announces `notifications/tools/list_changed` to the client. The page runs each call through `registry.callTool`, so argument validation, `isError` results and created ids work exactly as they do in the page. If the bridge restarts, the page reconnects with backoff (up to 10 s).

## What the agent sees

- `list_editors` returns each connected editor's id, name, kind, number of tools and idle time.
- Every tool any connected page exposes, with an added `editor` argument. It takes an id (`e1`) or part of a name. Without it, the most recently active editor that has the tool answers.
- Cancelling a request (MCP `notifications/cancelled`) aborts the call's `AbortSignal` in the page.
- A call that gets no answer within `timeoutMs` (default 60 s; background tabs can stall) fails with a sentence saying so.
- If the page disconnects mid-call, the call fails with a sentence too.
- If the port is taken, the bridge keeps retrying it, and `list_editors` says why nothing connects.

## Security

- The bridge listens on 127.0.0.1 only.
- Browsers always send an `Origin` header. Non-local origins are refused unless they are listed with `--origin`.
- Any page on this machine could otherwise connect, so pass a token.
- Clients that are not browsers (scripts) send no origin and only need the token.

## Other transports

The protocol doesn't need a WebSocket. Its two halves work with any carrier, for example a relay through a database that lets a server reach a tab (`@pixerate/realtime`'s `createRelayHost` / `createRelayClient`):

```ts
import { serveToolSource, createRemoteToolProvider, ToolRegistry } from '@pixerate/editor/tools';

// In the page: what to announce, and how to answer.
const served = serveToolSource(registry.view(), { name: 'Canvas — Moodboard', kind: 'canvas' });
const host = createRelayHost({ store, room, ownerId, info: served.info(), handle: (request, { signal }) => served.handle(request, { signal }) });
served.onInfoChange((info) => host.setInfo(info));

// On the server: the pages' tools, forwarded with an `editor` argument, plus `list_editors`.
const hosts = await relay.hosts<ToolHostInfo>();
const bridge = new ToolRegistry();
bridge.register(
  createRemoteToolProvider({
    editors: () => hosts.map((h) => ({ id: h.id, name: h.info.name, kind: h.info.kind, tools: h.info.tools, activeAt: h.heartbeatAt })),
    call: (editor, request, { signal }) => relay.call(editor.id, request, { signal })
  })
);
```

- **`serveToolSource(source, { name, kind })`** is the editor half. `info()` is the `hello` message, `onInfoChange` sends `tools`, and `handle(request, { signal })` answers a `call`, with the signal aborted on `cancel`. It never rejects: failures are `isError` results.
- **`createRemoteToolProvider({ editors, call })`** is the bridge half. It forwards each tool once with an `editor` argument and adds `list_editors`. Calls go to the named editor, or to the most recently active one that has the tool (`activity`, else `activeAt`). A rejected `call` becomes an `isError` result. `unavailable()` and `noEditorsMessage` say why nothing can answer.
- `connectToolBridge` and `createToolBridge` are built on these halves.

## Native editors (Swift)

The Swift editors (`packages/swift`, #533) connect the same way with `ToolBridgeClient` from `PixerateCore`:

```swift
let client = ToolBridgeClient(registry: registry, options: ToolBridgeOptions(name: "Paint — Sketch", kind: "paint", token: "choose-a-secret"))
// client.status: .connecting / .connected / .disconnected / .closed; client.editorId once connected
client.close()
```

It speaks protocol 1 over `URLSessionWebSocketTask` (the token goes in `?token=`, so a native app needs no `--origin`), sends the registry's tools on connect and when they change, runs calls through `registry.callTool` (a cancelled call sends no result) and reconnects with the same back-off. Its tools carry the TypeScript editors' names and schemas, so an agent and the skills use them the same way. `ToolBridgeLiveTests` runs against a real bridge when `PIXERATE_BRIDGE_TEST_PORT` is set.

### Serving MCP from the app itself

A Swift app can skip the bridge and host a Streamable HTTP MCP server in-process (`MCPHTTPServer`, `MCPToolRouter`, `MCPServerController` in `PixerateCore`). MCP clients then connect to `http://127.0.0.1:<port>/mcp` with `"type": "http"`:

```swift
let router = MCPToolRouter(configuration: .init(serverName: "Swash", serverVersion: "1.4", singular: "document"), catalog: catalogRegistry)
let mcp = MCPServerController(serverName: "swash", realm: "Swash", defaultPort: 4478, router: router)
mcp.update(enabled: true, port: storedPort, token: storedToken)   // from the app's settings
router.attach(target)      // an MCPToolTarget per open document, with its own ToolRegistry
router.activate(target)    // its window became active: calls without `document` go here
router.detach(target)
```

`tools/list` is `list_<plural>` plus the catalogue registry's tools, each with an optional target argument (`document`, `canvas`…). The catalogue never depends on what is open, because the server has no SSE stream to announce changes. Each app chooses its own default port; there is no shared default, so it never collides with the bridge (4477) or another app. The server takes local requests only (Host, Origin, `application/json`), returns 404 for any path but `/mcp` before checking the token, and compares the optional Bearer token in constant time.

