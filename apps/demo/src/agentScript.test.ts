import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@pixerate/editor/agent";
import { runAgentScript, type AgentRunEvent, type AgentScript } from "./agentScript";

const noWait = () => Promise.resolve();

function registry() {
  const reg = new ToolRegistry();
  const values: Record<string, number> = { a: 1 };
  reg.register({
    id: "test",
    namespace: "t",
    tools: [
      {
        name: "get",
        title: "Get",
        description: "Reads a value.",
        inputSchema: { type: "object", properties: { key: { type: "string", description: "Key." } }, required: ["key"], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        handler: ({ key }) => {
          if (!(key in values)) throw new Error(`No value "${key}".`);
          return { key, value: values[key] };
        },
      },
      {
        name: "set",
        title: "Set",
        description: "Writes a value.",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string", description: "Key." }, value: { type: "number", description: "Value." } },
          required: ["key", "value"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        handler: ({ key, value }) => {
          values[key] = value;
          return { key, value };
        },
      },
    ],
  });
  return { reg, values };
}

describe("runAgentScript", () => {
  it("calls each tool in order and passes earlier results to later arguments", async () => {
    const { reg, values } = registry();
    const events: AgentRunEvent[] = [];
    const script: AgentScript = {
      id: "double",
      prompt: "Double a",
      steps: [
        { say: "Reading a.", tool: "t__get", args: { key: "a" }, as: "a" },
        { say: "Doubling it.", tool: "t__set", args: (ctx) => ({ key: "a", value: ctx.results.a.value * 2 }) },
      ],
    };
    const { ok, ctx } = await runAgentScript(reg, script, { wait: noWait, onEvent: (e) => events.push(e) });
    expect(ok).toBe(true);
    expect(values.a).toBe(2);
    expect(ctx.last).toEqual({ key: "a", value: 2 });
    expect(events.map((e) => e.type)).toEqual(["say", "call", "result", "say", "call", "result", "done"]);
    expect(events[4]).toMatchObject({ type: "call", tool: "t__set", args: { key: "a", value: 2 } });
  });

  it("stops at a tool error and reports its message", async () => {
    const { reg, values } = registry();
    const events: AgentRunEvent[] = [];
    const { ok } = await runAgentScript(
      reg,
      { id: "bad", prompt: "Read b", steps: [{ tool: "t__get", args: { key: "b" } }, { tool: "t__set", args: { key: "a", value: 9 } }] },
      { wait: noWait, onEvent: (e) => events.push(e) },
    );
    expect(ok).toBe(false);
    expect(values.a).toBe(1);
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", step: 0 });
    expect((error as { message: string }).message).toContain('No value "b"');
    expect(events[events.length - 1]).toEqual({ type: "done", ok: false, stopped: false });
  });

  it("reports arguments that cannot be built without calling the tool", async () => {
    const { reg, values } = registry();
    const events: AgentRunEvent[] = [];
    const { ok } = await runAgentScript(
      reg,
      {
        id: "args",
        prompt: "Use a missing result",
        steps: [{ tool: "t__set", args: () => { throw new Error("find_text found nothing."); } }],
      },
      { wait: noWait, onEvent: (e) => events.push(e) },
    );
    expect(ok).toBe(false);
    expect(values.a).toBe(1);
    expect(events.some((e) => e.type === "call")).toBe(false);
    expect(events[0]).toEqual({ type: "error", step: 0, message: "find_text found nothing." });
  });

  it("stops before the next step when the run is stopped", async () => {
    const { reg, values } = registry();
    const control = { speed: 1, stopped: false };
    const { ok } = await runAgentScript(
      reg,
      {
        id: "stop",
        prompt: "Two writes",
        steps: [
          { tool: "t__set", args: { key: "a", value: 5 } },
          { tool: "t__set", args: { key: "a", value: 6 } },
        ],
      },
      {
        control,
        wait: noWait,
        onEvent: (e) => {
          if (e.type === "result") control.stopped = true;
        },
      },
    );
    expect(ok).toBe(false);
    expect(values.a).toBe(5);
  });

  it("skips pauses at infinite speed", async () => {
    const { reg } = registry();
    const waits: number[] = [];
    await runAgentScript(
      reg,
      { id: "fast", prompt: "Read", steps: [{ say: "Reading.", tool: "t__get", args: { key: "a" } }] },
      { control: { speed: Infinity, stopped: false }, wait: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([]);
  });
});
