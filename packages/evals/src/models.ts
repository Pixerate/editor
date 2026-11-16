import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { BRUSH_PRESETS } from "@pixerate/editor/brushes";
import { FATAL_EXIT_CODE, FatalModelError, RESPONSE_MARKER, type EvalTask, type Model, type ModelMessage, type ModelRequest, type ModelResponse, type ToolCallSpec } from "./types.ts";

/**
 * A model from its spec:
 * - `anthropic:<model>[?effort=low|medium|high|xhigh|max]`: the Claude API (credentials from the
 *   environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile).
 * - `command:<shell command>`: any other model, behind a command that reads the request as JSON on
 *   stdin (see {@link wireRequest}) and prints a {@link RESPONSE_MARKER} envelope.
 * - `replay:<folder>`: answers saved by an earlier run (`<folder>/<key>.json`), to re-grade without calling a model.
 * - `oracle`: answers scratch tasks with their known-good solution and reference tasks with the
 *   preset they hold out: what a perfect brush scores, to calibrate the graders. Needs the tasks.
 */
export function createModel(spec: string, tasks: readonly EvalTask[] = []): Model {
  if (spec === "oracle") return oracleModel(tasks);
  const colon = spec.indexOf(":");
  const scheme = colon < 0 ? spec : spec.slice(0, colon);
  const rest = colon < 0 ? "" : spec.slice(colon + 1);
  if (scheme === "anthropic" && rest) return anthropicModel(spec, rest);
  if (scheme === "command" && rest) return commandModel(spec, rest);
  if (scheme === "replay" && rest) return replayModel(spec, rest);
  throw new Error(`"${spec}" is not a model spec; use anthropic:<model>[?effort=…], command:<shell command>, replay:<folder> or oracle.`);
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

const png64 = (png: Buffer) => png.toString("base64");

/** The conversation in the Messages API's shape. */
export function anthropicMessages(messages: readonly ModelMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((p): Anthropic.ContentBlockParam => {
      switch (p.type) {
        case "text":
          return { type: "text", text: p.text };
        case "image":
          return { type: "image", source: { type: "base64", media_type: "image/png", data: png64(p.png) } };
        case "tool_call":
          return { type: "tool_use", id: p.id, name: p.name, input: p.input };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: p.id,
            ...(p.isError && { is_error: true }),
            content: p.content.map((c) => (c.type === "text" ? { type: "text" as const, text: c.text } : { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: png64(c.png) } })),
          };
      }
    }),
  }));
}

function anthropicModel(spec: string, rest: string): Model {
  const [id, query = ""] = rest.split("?");
  const params = new URLSearchParams(query);
  const effort = params.get("effort") ?? undefined;
  if (effort !== undefined && !EFFORTS.includes(effort as Effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}; not "${effort}".`);
  const unknown = [...params.keys()].filter((k) => k !== "effort");
  if (unknown.length) throw new Error(`"${spec}" has unknown option ${unknown.join(", ")}; the only option is effort.`);
  const client = new Anthropic();
  return {
    name: spec,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const outputConfig: Record<string, unknown> = {};
      if (effort) outputConfig.effort = effort;
      if (request.schema) outputConfig.format = { type: "json_schema", schema: request.schema };
      // The system prompt and tools are the same on every turn of every sample: cache them.
      const tools: Anthropic.Tool[] | undefined = request.tools?.map((t, i, all) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        ...(i === all.length - 1 && { cache_control: { type: "ephemeral" as const } }),
      }));
      const stream = client.messages.stream({
        model: id!,
        max_tokens: 32000,
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: anthropicMessages(request.messages),
        ...(tools?.length && { tools }),
        ...(Object.keys(outputConfig).length && { output_config: outputConfig as Anthropic.OutputConfig }),
      });
      let message: Anthropic.Message;
      try {
        message = await stream.finalMessage();
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError || /authentication method/i.test((e as Error).message))
          throw new FatalModelError(`${spec}: ${(e as Error).message.replace(/\.?\s*$/, ".")} Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN, or run \`ant auth login\`) and check the model id.`);
        throw e;
      }
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolCalls = message.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
      const u = message.usage;
      return {
        text,
        ...(toolCalls.length && { toolCalls }),
        stop: message.stop_reason ?? undefined,
        usage: { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens },
      };
    },
  };
}

/** A part as a command model reads it: images as base64 PNG. */
type WirePart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: "image/png"; data: string; label?: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; meta?: unknown }
  | { type: "tool_result"; id: string; name: string; is_error?: boolean; content: ({ type: "text"; text: string } | { type: "image"; media_type: "image/png"; data: string })[] };

/** The request a `command:` model reads on stdin. */
export function wireRequest(request: ModelRequest) {
  return {
    key: request.key,
    system: request.system,
    schema: request.schema,
    tools: request.tools,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content.map((p): WirePart => {
        if (p.type === "image") return { type: "image", media_type: "image/png", data: png64(p.png), label: p.label };
        if (p.type === "tool_result")
          return { type: "tool_result", id: p.id, name: p.name, ...(p.isError && { is_error: true }), content: p.content.map((c) => (c.type === "text" ? c : { type: "image", media_type: "image/png", data: png64(c.png) })) };
        return p;
      }),
    })),
  };
}

function commandModel(spec: string, command: string): Model {
  return {
    name: spec,
    generate(request: ModelRequest): Promise<ModelResponse> {
      const body = JSON.stringify(wireRequest(request));
      return new Promise((resolve, reject) => {
        const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on("data", (d: Buffer) => out.push(d));
        child.stderr.on("data", (d: Buffer) => err.push(d));
        child.on("error", reject);
        child.on("close", (code) => {
          const stderr = Buffer.concat(err).toString("utf8").trim().slice(0, 2000);
          if (code === FATAL_EXIT_CODE) return reject(new FatalModelError(`${spec}: ${stderr}`));
          if (code !== 0) return reject(new Error(`The model command exited with ${code}: ${stderr}`));
          try {
            resolve(commandResponse(Buffer.concat(out).toString("utf8")));
          } catch (e) {
            reject(e as Error);
          }
        });
        child.stdin.end(body);
      });
    },
  };
}

/** A command's output: the plain answer, or a {@link RESPONSE_MARKER} envelope with tool calls, tokens and the stop reason. */
export function commandResponse(stdout: string): ModelResponse {
  if (!stdout.startsWith(RESPONSE_MARKER)) return { text: stdout };
  const envelope = JSON.parse(stdout.slice(RESPONSE_MARKER.length)) as { text?: unknown; stop?: unknown; toolCalls?: unknown; usage?: { input?: unknown; output?: unknown } };
  if (typeof envelope.text !== "string") throw new Error(`The model command's ${RESPONSE_MARKER} envelope has no "text" string.`);
  const calls = Array.isArray(envelope.toolCalls) ? envelope.toolCalls : [];
  for (const c of calls) {
    if (!c || typeof c.id !== "string" || typeof c.name !== "string" || typeof c.input !== "object") throw new Error(`The model command's envelope has a tool call without an id, name and input object: ${JSON.stringify(c).slice(0, 200)}`);
  }
  return {
    text: envelope.text,
    ...(calls.length && { toolCalls: calls as ModelResponse["toolCalls"] }),
    ...(typeof envelope.stop === "string" && { stop: envelope.stop }),
    ...(envelope.usage && { usage: { input: Number(envelope.usage.input) || 0, output: Number(envelope.usage.output) || 0 } }),
  };
}

function replayModel(spec: string, folder: string): Model {
  const root = path.resolve(folder);
  return {
    name: spec,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const file = path.join(root, `${request.key}.json`);
      if (!existsSync(file)) throw new Error(`There is no saved answer for ${request.key} (looked for ${file}).`);
      return JSON.parse(readFileSync(file, "utf8")) as ModelResponse;
    },
  };
}

/** The tool calls that remake a built-in preset as a brush of its own under `id`: every facet, no `basedOn`. */
export function presetAsCalls(presetId: string, id: string): ToolCallSpec[] {
  const preset = BRUSH_PRESETS.find((b) => b.id === presetId);
  if (!preset) throw new Error(`There is no built-in brush "${presetId}".`);
  const { id: _id, ...facets } = JSON.parse(JSON.stringify(preset)) as Record<string, unknown>;
  return [{ tool: "create_brush", args: { ...facets, id } }];
}

/** The calls the oracle makes for a task. */
export function oracleCalls(task: EvalTask): ToolCallSpec[] {
  if (task.reference) return presetAsCalls(task.reference.preset, task.brushId);
  if (task.solution?.length) return [...task.solution];
  throw new Error(`The oracle has no answer for "${task.id}": give it a solution.`);
}

function oracleModel(tasks: readonly EvalTask[]): Model {
  return {
    name: "oracle",
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const [id, sample, turn] = request.key.split("/");
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new Error(`The oracle has no task "${id}".`);
      // One turn makes every call; the next says it is done.
      if (Number(turn) > 1) return { text: "Done.", stop: "end_turn" };
      const calls = oracleCalls(task).map((c, i) => ({ id: `oracle-${sample}-${i}`, name: c.tool, input: c.args ?? {} }));
      return { text: "", toolCalls: calls, stop: "tool_use" };
    },
  };
}
