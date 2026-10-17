// @vitest-environment node
// Re-expresses Ursula's bridge tests (src/bridge/index.test.ts) for the ToolRegistry bridge.
import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { connect as netConnect } from "node:net";
import { PassThrough } from "node:stream";
import { ToolRegistry, connectToolBridge, type AgentToolProvider, type ToolBridgeConnection } from "../src/tools";
import { createToolBridge, isLocalOrigin, type ToolBridge } from "../src/bridge";
import { DiagramController, createDiagramToolProvider } from "../src/diagram";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

const until = async (check: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const startBridge = async (options: Partial<Parameters<typeof createToolBridge>[0]> = {}) => {
  const bridge = await createToolBridge({ name: "test", port: 0, stdio: false, log: () => {}, ...options });
  cleanups.push(() => bridge.close());
  return bridge;
};

const echoProvider = (id = "echo"): AgentToolProvider => ({
  id,
  tools: [
    {
      name: "echo",
      title: "Echo",
      description: "Returns its text.",
      inputSchema: { type: "object", properties: { text: { type: "string", description: "Text." } }, required: ["text"], additionalProperties: false },
      annotations: { title: "Echo", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: ({ text }) => ({ text, from: id }),
    },
    {
      name: "wait",
      title: "Wait",
      description: "Waits until cancelled.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Wait", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: (_args, context) =>
        new Promise((_, reject) => context.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    },
  ],
});

const connect = async (bridge: ToolBridge, registry: ToolRegistry, name: string, extra: Partial<Parameters<typeof connectToolBridge>[1]> = {}) => {
  const connection = connectToolBridge(registry, { url: `ws://127.0.0.1:${bridge.port}`, name, reconnect: false, ...extra });
  cleanups.push(() => connection.close());
  await until(() => connection.status === "connected" || connection.status === "disconnected");
  return connection;
};

let rpc = 0;
const mcp = async (bridge: ToolBridge, method: string, params: Record<string, unknown> = {}) => {
  const response: any = await bridge.mcp.handle({ jsonrpc: "2.0", id: ++rpc, method, params });
  return response.result;
};

describe("createToolBridge", () => {
  it("accepts only local browser origins unless allowed", () => {
    expect(isLocalOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isLocalOrigin("http://app.localhost")).toBe(true);
    expect(isLocalOrigin("https://evil.example")).toBe(false);
    expect(isLocalOrigin("not a url")).toBe(false);
  });

  it("forwards a page's tools over MCP and lists editors", async () => {
    const bridge = await startBridge();
    const registry = new ToolRegistry();
    registry.register(echoProvider());
    const connection = await connect(bridge, registry, "Docs tab", { kind: "document" });
    expect(connection.status).toBe("connected");
    expect(connection.editorId).toBe("e1");

    await mcp(bridge, "initialize", { protocolVersion: "2025-06-18" });
    const { tools } = await mcp(bridge, "tools/list");
    expect(tools.map((t: any) => t.name)).toEqual(["list_editors", "echo", "wait"]);
    const echo = tools.find((t: any) => t.name === "echo");
    expect(Object.keys(echo.inputSchema.properties)).toEqual(["editor", "text"]);
    expect(echo.annotations.readOnlyHint).toBe(true);

    const result = await mcp(bridge, "tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(result.structuredContent).toEqual({ text: "hi", from: "echo" });
    const list = tools.find((t: any) => t.name === "list_editors");
    expect(list.title).toBe("List connected editors");
    expect(Object.keys(list.annotations).sort()).toEqual(["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint", "title"]);
    expect(echo.inputSchema.properties.editor.description).toMatch(/list_editors/);
    const listed = await mcp(bridge, "tools/call", { name: "list_editors", arguments: {} });
    expect(listed.structuredContent.editors).toEqual([{ id: "e1", name: "Docs tab", kind: "document", tools: 2, idleSeconds: 0 }]);
  });

  it("routes by editor id or name, defaulting to the most recently active", async () => {
    const bridge = await startBridge();
    const a = new ToolRegistry();
    a.register(echoProvider("a"));
    const b = new ToolRegistry();
    b.register(echoProvider("b"));
    await connect(bridge, a, "Order flow diagram");
    await connect(bridge, b, "Sales chart");
    const call = (args: Record<string, unknown>) => bridge.registry.callTool("echo", { text: "x", ...args });
    expect(((await call({ editor: "e1" })) as any).structuredContent.from).toBe("a");
    expect(((await call({ editor: "chart" })) as any).structuredContent.from).toBe("b");
    expect(((await call({})) as any).structuredContent.from).toBe("b");
    expect(((await call({ editor: "e1" })) as any).structuredContent.from).toBe("a");
    expect(((await call({})) as any).structuredContent.from).toBe("a");
    const bad: any = await call({ editor: "nothing" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/No single editor matches "nothing". Connected: e1 \(Order flow diagram\), e2 \(Sales chart\)/);
  });

  it("keeps the page's own argument validation and error results", async () => {
    const bridge = await startBridge();
    const registry = new ToolRegistry();
    const controller = new DiagramController({ source: "flowchart LR\n  A --> B" });
    registry.register(createDiagramToolProvider(controller));
    await connect(bridge, registry, "Diagram");
    const ok: any = await bridge.registry.callTool("add_diagram_node", { label: "C", from: "B" });
    expect(ok.structuredContent.node).toMatchObject({ id: "N1", label: "C" });
    expect(controller.getSource()).toContain("B --> N1");
    const bad: any = await bridge.registry.callTool("rename_diagram_node", { id: "Z", label: "x" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/There is no node "Z"/);
    const invalid: any = await bridge.registry.callTool("rename_diagram_node", { id: "A", label: "x", extra: 1 });
    expect(invalid.isError).toBe(true);
  });

  it("announces tool-list changes as editors come, change and go", async () => {
    const sent: any[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    output.on("data", (chunk) => String(chunk).split("\n").filter(Boolean).forEach((line) => sent.push(JSON.parse(line))));
    const bridge = await startBridge({ stdio: { input, output } });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await until(() => sent.some((m) => m.id === 1));
    expect(sent[0].result.instructions).toMatch(/list_editors/);

    const registry = new ToolRegistry();
    const connection = await connect(bridge, registry, "Empty");
    const changes = () => sent.filter((m) => m.method === "notifications/tools/list_changed").length;
    const unregister = registry.register(echoProvider());
    await until(() => bridge.registry.hasTool("echo"));
    await until(() => changes() >= 1);
    unregister();
    await until(() => !bridge.registry.hasTool("echo"));
    connection.close();
    await until(() => bridge.editors().length === 0);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await until(() => sent.some((m) => m.id === 2));
    expect(sent.find((m) => m.id === 2).result.tools.map((t: any) => t.name)).toEqual(["list_editors"]);
  });

  it("cancels a call in the page when the MCP client cancels it", async () => {
    const bridge = await startBridge();
    const registry = new ToolRegistry();
    let aborted = false;
    const provider = echoProvider();
    const wait = (provider.tools as any[]).find((t) => t.name === "wait");
    const inner = wait.handler;
    wait.handler = (args: any, context: any) => {
      context.signal?.addEventListener("abort", () => (aborted = true));
      return inner(args, context);
    };
    registry.register(provider);
    await connect(bridge, registry, "Tab");
    const pending = bridge.mcp.handle({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "wait", arguments: {} } });
    await new Promise((r) => setTimeout(r, 50));
    await bridge.mcp.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } });
    expect(await pending).toBeNull();
    await until(() => aborted);
  });

  it("fails a call whose editor disconnects or does not answer in time", async () => {
    const bridge = await startBridge({ timeoutMs: 100 });
    const registry = new ToolRegistry();
    registry.register(echoProvider());
    await connect(bridge, registry, "Slow tab");
    const late: any = await bridge.registry.callTool("wait", {});
    expect(late.content[0].text).toMatch(/did not answer within/);
    const other = new ToolRegistry();
    other.register(echoProvider("o"));
    const connection = await connect(bridge, other, "Closing tab");
    const call = bridge.registry.callTool("wait", { editor: connection.editorId! });
    await new Promise((r) => setTimeout(r, 20));
    connection.close();
    expect(((await call) as any).content[0].text).toMatch(/disconnected before answering/);
  });

  it("refuses wrong tokens and foreign origins", async () => {
    const bridge = await startBridge({ token: "s3cret" });
    const registry = new ToolRegistry();
    const statuses: string[] = [];
    const refused = await connect(bridge, registry, "No token", { onStatus: (s) => statuses.push(s) });
    expect(refused.status).toBe("disconnected");
    expect(bridge.editors()).toEqual([]);
    const allowed = await connect(bridge, registry, "With token", { token: "s3cret" });
    expect(allowed.status).toBe("connected");

    const upgrade = (origin: string) =>
      new Promise<number>((resolve) => {
        const req = request({
          host: "127.0.0.1",
          port: bridge.port,
          path: "/?token=s3cret",
          headers: { Connection: "Upgrade", Upgrade: "websocket", Origin: origin, "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
        });
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          resolve(101);
        });
        req.on("response", (res) => resolve(res.statusCode ?? 0));
        req.on("error", () => resolve(-1));
        req.end();
      });
    expect(await upgrade("https://evil.example")).toBe(403);
    expect(await upgrade("http://localhost:3000")).toBe(101);
  });

  it("tells the agent why nothing connects when the port is taken", async () => {
    const first = await startBridge();
    const second = await startBridge({ port: first.port, retryMs: 0 });
    const result: any = await second.registry.callTool("list_editors", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/is in use/);
  });

  it("reconnects after the bridge restarts", async () => {
    const bridge = await startBridge();
    const port = bridge.port;
    const registry = new ToolRegistry();
    registry.register(echoProvider());
    const connection = connectToolBridge(registry, { url: `ws://127.0.0.1:${port}`, name: "Tab" });
    cleanups.push(() => connection.close());
    await until(() => connection.status === "connected");
    await bridge.close();
    await until(() => connection.status === "disconnected");
    const again = await startBridge({ port });
    await until(() => connection.status === "connected", 5000);
    expect(again.editors().map((e) => e.name)).toEqual(["Tab"]);
  });

  it("carries large messages both ways", async () => {
    const bridge = await startBridge();
    const registry = new ToolRegistry();
    registry.register(echoProvider());
    await connect(bridge, registry, "Tab");
    const text = "x".repeat(70_000);
    const result: any = await bridge.registry.callTool("echo", { text });
    expect(result.structuredContent.text).toBe(text);
  });
});

describe("bridge WebSocket framing", () => {
  const masked = (opcode: number, payload: Buffer, fin = true) => {
    const mask = Buffer.from([1, 2, 3, 4]);
    const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]), mask, body]);
  };

  it("joins fragmented text frames and answers pings", async () => {
    const bridge = await startBridge();
    const socket = netConnect(bridge.port, "127.0.0.1");
    cleanups.push(() => socket.destroy());
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => (received = Buffer.concat([received, chunk])));
    socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    await until(() => received.includes("\r\n\r\n"));
    expect(received.toString()).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    received = Buffer.alloc(0);
    const hello = Buffer.from(JSON.stringify({ t: "hello", v: 1, name: "Raw", tools: [] }));
    socket.write(Buffer.concat([masked(0x1, hello.subarray(0, 10), false), masked(0x9, Buffer.from("hi")), masked(0x0, hello.subarray(10))]));
    await until(() => bridge.editors().length === 1);
    expect(bridge.editors()[0]!.name).toBe("Raw");
    // A pong (0x8A) echoing "hi" and the welcome text frame (0x81).
    await until(() => received.includes(Buffer.from([0x8a, 2])) && received.includes(Buffer.from('"welcome"')));
    socket.write(masked(0x8, Buffer.from([0x03, 0xe8])));
    await until(() => bridge.editors().length === 0);
  });
});
