// @vitest-environment node
// The transport-free halves of the tool bridge: `serveToolSource` (editor) and
// `createRemoteToolProvider` (bridge), joined here in memory as a relay would join them.
import { describe, expect, it, vi } from "vitest";
import {
  ToolRegistry,
  TOOL_BRIDGE_PROTOCOL,
  createRemoteToolProvider,
  serveToolSource,
  type AgentToolProvider,
  type McpToolResult,
  type RemoteToolEditor,
} from "../src/tools";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const pageProvider = (id: string): AgentToolProvider => ({
  id,
  namespace: "page",
  tools: [
    {
      name: "echo",
      title: "Echo",
      description: "Returns its text and which page answered.",
      inputSchema: { type: "object", properties: { text: { type: "string", description: "Text." } }, required: ["text"], additionalProperties: false },
      annotations: { title: "Echo", ...readOnly },
      handler: ({ text }) => ({ text, from: id }),
    },
    {
      name: "wait",
      title: "Wait",
      description: "Waits until cancelled.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Wait", ...readOnly },
      handler: (_args, context) =>
        new Promise((_, reject) => context.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    },
  ],
});

const json = (result: McpToolResult) => JSON.parse((result.content[0] as { text: string }).text);

describe("serveToolSource", () => {
  it("announces the source's tools and follows changes", async () => {
    const registry = new ToolRegistry();
    const served = serveToolSource(registry, { name: "Canvas", kind: "canvas" });
    expect(served.info()).toEqual({ v: TOOL_BRIDGE_PROTOCOL, name: "Canvas", kind: "canvas", tools: [] });
    const seen: string[][] = [];
    served.onInfoChange((info) => seen.push(info.tools.map((t) => t.name)));
    registry.register(pageProvider("p1"));
    registry.flush();
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["page__echo", "page__wait"]));
    expect(served.info().tools.map((t) => t.name)).toEqual(["page__echo", "page__wait"]);
  });

  it("answers calls, keeping the source's validation and errors", async () => {
    const registry = new ToolRegistry();
    registry.register(pageProvider("p1"));
    const served = serveToolSource(registry, { name: "Canvas" });
    expect(json(await served.handle({ name: "page__echo", arguments: { text: "hi" } }))).toEqual({ text: "hi", from: "p1" });
    expect((await served.handle({ name: "page__echo", arguments: {} })).isError).toBe(true);
    expect((await served.handle({ name: "nope" })).isError).toBe(true);
  });

  it("cancels a running call when its signal aborts, and refuses one already aborted", async () => {
    const registry = new ToolRegistry();
    registry.register(pageProvider("p1"));
    const served = serveToolSource(registry, { name: "Canvas" });
    const controller = new AbortController();
    const running = served.handle({ name: "page__wait" }, { signal: controller.signal });
    controller.abort();
    expect((await running).isError).toBe(true);
    const refused = await served.handle({ name: "page__echo", arguments: { text: "x" } }, { signal: controller.signal });
    expect(refused).toMatchObject({ isError: true, content: [{ text: "The call was cancelled." }] });
  });
});

describe("createRemoteToolProvider", () => {
  /** Two pages, each served, reached through an in-memory "relay". */
  const setup = () => {
    const pages = new Map<string, ReturnType<typeof serveToolSource>>();
    const editors: RemoteToolEditor[] = [];
    for (const [id, name, activeAt] of [["tab-a", "Moodboard", 1000], ["tab-b", "Brand book", 2000]] as const) {
      const registry = new ToolRegistry();
      registry.register(pageProvider(id));
      const served = serveToolSource(registry, { name, kind: "canvas" });
      pages.set(id, served);
      editors.push({ id, name, kind: "canvas", tools: served.info().tools, activeAt });
    }
    const call = vi.fn((editor: RemoteToolEditor, request, context) => pages.get(editor.id)!.handle(request, context));
    const bridge = new ToolRegistry();
    bridge.register(createRemoteToolProvider({ editors: () => editors, call, now: () => 5000 }));
    return { bridge, editors, call };
  };

  it("forwards each tool once, with an `editor` argument, plus list_editors", () => {
    const { bridge } = setup();
    const tools = bridge.listTools().tools;
    expect(tools.map((t) => t.name)).toEqual(["list_editors", "page__echo", "page__wait"]);
    const echo = tools.find((t) => t.name === "page__echo")!;
    expect(Object.keys((echo.inputSchema as { properties: object }).properties)).toEqual(["editor", "text"]);
    expect(echo.annotations).toMatchObject(readOnly);
  });

  it("lists editors with how long they have been idle", async () => {
    const { bridge } = setup();
    expect(json(await bridge.callTool("list_editors", {}))).toEqual({
      editors: [
        { id: "tab-a", name: "Moodboard", kind: "canvas", tools: 2, idleSeconds: 4 },
        { id: "tab-b", name: "Brand book", kind: "canvas", tools: 2, idleSeconds: 3 },
      ],
    });
  });

  it("routes to the most recently active editor, or the one named", async () => {
    const { bridge, call } = setup();
    expect(json(await bridge.callTool("page__echo", { text: "a" }))).toEqual({ text: "a", from: "tab-b" });
    expect(json(await bridge.callTool("page__echo", { text: "b", editor: "tab-a" }))).toEqual({ text: "b", from: "tab-a" });
    expect(json(await bridge.callTool("page__echo", { text: "c", editor: "mood" }))).toEqual({ text: "c", from: "tab-a" });
    // The `editor` argument is the bridge's, not the page's.
    expect(call.mock.calls[1]![1]).toEqual({ name: "page__echo", arguments: { text: "b" } });
  });

  it("explains what to do when no editor fits", async () => {
    const { bridge, editors } = setup();
    const message = async (args: Record<string, unknown>) => (await bridge.callTool("page__echo", args)).content[0];
    expect(await message({ text: "x", editor: "nobody" })).toMatchObject({ text: expect.stringContaining('No single editor matches "nobody"') });
    editors.splice(0);
    const none = await bridge.callTool("list_editors", {});
    expect(json(none)).toEqual({ editors: [] });
  });

  it("uses the no-editors message and the unavailable reason", async () => {
    const editors: RemoteToolEditor[] = [{ id: "e1", name: "Doc", tools: [{ name: "x", inputSchema: { type: "object" } }] }];
    const bridge = new ToolRegistry();
    let reason: string | null = "Port 4477 is in use.";
    bridge.register(
      createRemoteToolProvider({
        editors: () => editors,
        call: async () => ({ content: [] }),
        unavailable: () => reason,
        noEditorsMessage: () => "Open the exploration in Pixerate.",
      })
    );
    expect((await bridge.callTool("x", {})).content[0]).toMatchObject({ text: expect.stringContaining("Port 4477 is in use.") });
    reason = null;
    editors[0]!.tools = [];
    expect((await bridge.callTool("list_editors", {})).isError).toBeFalsy();
  });

  it("turns a failed delivery into an error result", async () => {
    const editors: RemoteToolEditor[] = [{ id: "e1", name: "Doc", tools: [{ name: "x", inputSchema: { type: "object" } }] }];
    const bridge = new ToolRegistry();
    bridge.register(
      createRemoteToolProvider({
        editors: () => editors,
        call: async () => {
          throw new Error("The host did not answer within 30 s.");
        },
      })
    );
    const result = await bridge.callTool("x", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("did not answer") });
  });

  it("passes cancellation through to the page", async () => {
    const { bridge } = setup();
    const controller = new AbortController();
    const running = bridge.callTool("page__wait", {}, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    expect((await running).isError).toBe(true);
  });
});
