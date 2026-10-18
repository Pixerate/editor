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
