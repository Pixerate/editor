#!/usr/bin/env node
/**
 * A `command:` model for Google's Gemini API, with tool calling, so the eval can run Gemini models
 * without the repo depending on Google's SDK:
 *
 *   --model "command:node src/adapters/gemini.ts gemini-4-hydrogen"
 *
 * Reads the eval's request JSON on stdin (`wireRequest` in `src/models.ts`), calls
 * `generateContent` with the tools as function declarations and prints a response envelope
 * (see {@link RESPONSE_MARKER}) with the text, the function calls, tokens and the stop reason.
 * A function call's thought signature is returned as the call's `meta`, and sent back with it on
 * the next turn, as Gemini requires. Images a tool returned (`preview_brush`) go inside its
 * function response (`functionResponse.parts`).
 *
 * With `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) it calls the Gemini API; without one it calls
 * Vertex AI with Application Default Credentials (`gcloud auth application-default login`), in
 * `GOOGLE_CLOUD_PROJECT` (default: gcloud's project) and `GOOGLE_CLOUD_LOCATION` (default
 * `global`). Exits 3 for failures no retry fixes (bad credentials, unknown model), so the run
 * stops rather than scoring zeros.
 */
import { execFileSync } from "node:child_process";
import { request } from "node:https";
import { FATAL_EXIT_CODE, RESPONSE_MARKER } from "../types.ts";

type WireContent = { type: "text"; text: string } | { type: "image"; media_type: string; data: string };
type WirePart =
  | WireContent
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; meta?: { thoughtSignature?: string } }
  | { type: "tool_result"; id: string; name: string; is_error?: boolean; content: WireContent[] };

interface Request {
  key: string;
  system: string;
  schema?: Record<string, unknown>;
  tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  messages: { role: "user" | "assistant"; content: WirePart[] }[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

const FATAL = FATAL_EXIT_CODE;

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Maps Gemini's finish reasons onto the eval's (`end_turn`, `tool_use`, `max_tokens`, `refusal`). */
function stopReason(finish: string | undefined, blocked: string | undefined, calls: number): string {
  if (blocked) return "refusal";
  if (finish === "MAX_TOKENS") return "max_tokens";
  if (finish && ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(finish)) return "refusal";
  if (finish === "MALFORMED_FUNCTION_CALL") return "malformed_tool_call";
  return calls ? "tool_use" : "end_turn";
}

/**
 * JSON Schema keywords Gemini's `parametersJsonSchema` refuses are few, but `$schema` and
 * `$id` at the top are not needed; drop them.
 */
function parameters(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, $id: _i, ...rest } = schema;
  return rest;
}

/** The conversation in Gemini's `contents` shape. */
export function geminiContents(messages: Request["messages"]) {
  return messages.map((m) => {
    const parts: Record<string, unknown>[] = [];
    for (const p of m.content) {
      if (p.type === "text") parts.push({ text: p.text });
      else if (p.type === "image") parts.push({ inlineData: { mimeType: p.media_type, data: p.data } });
      else if (p.type === "tool_call") parts.push({ functionCall: { name: p.name, args: p.input }, ...(p.meta?.thoughtSignature && { thoughtSignature: p.meta.thoughtSignature }) });
      else {
        // Images a tool returned (preview_brush) travel inside its function response, as Gemini's
        // multimodal function responses do; loose image parts after them are refused.
        const text = p.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
        const images = p.content.filter((c) => c.type === "image") as { media_type: string; data: string }[];
        parts.push({
          functionResponse: {
            name: p.name,
            response: p.is_error ? { error: text } : { result: text },
            ...(images.length && { parts: images.map((c) => ({ inlineData: { mimeType: c.media_type, data: c.data } })) }),
          },
        });
      }
    }
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
}

interface Reply {
  status: number;
  text: string;
}

/** Most a request may take: a thinking model can take many minutes before it answers at all. */
const REQUEST_TIMEOUT_MS = 15 * 60_000;

/** POSTs over node:https rather than fetch, which gives up when the headers take more than 5 minutes. */
function post(url: string, headers: Record<string, string>, body: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`no answer within ${REQUEST_TIMEOUT_MS / 60_000} minutes`)));
    req.on("error", reject);
    req.end(body);
  });
}

/** Where to send the request and how to authenticate: an API key, else Vertex AI with ADC. */
function endpoint(model: string): { url: string; headers: Record<string, string> } {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (apiKey) return { url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, headers: { "x-goog-api-key": apiKey } };
  const gcloud = (args: string[]) => {
    try {
      return execFileSync("gcloud", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const token = gcloud(["auth", "application-default", "print-access-token"]);
  if (!token) fail("No GEMINI_API_KEY, and no Application Default Credentials: run `gcloud auth application-default login`, or set GEMINI_API_KEY.", FATAL);
  const project = process.env.GOOGLE_CLOUD_PROJECT || gcloud(["config", "get-value", "project"]);
  if (!project) fail("Set GOOGLE_CLOUD_PROJECT (or `gcloud config set project …`) to call Vertex AI.", FATAL);
  const location = process.env.GOOGLE_CLOUD_LOCATION || "global";
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return {
    url: `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`,
    headers: { authorization: `Bearer ${token}`, "x-goog-user-project": project },
  };
}

async function main() {
  const model = process.argv[2];
  if (!model) fail("Give the Gemini model id: node src/adapters/gemini.ts <model>", FATAL);
  const target = endpoint(model);
  const req = JSON.parse(await readStdin()) as Request;

  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: geminiContents(req.messages),
    ...(req.tools?.length && {
      tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: parameters(t.inputSchema) })) }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    }),
    generationConfig: {
      maxOutputTokens: 65536,
      ...(req.schema && { responseMimeType: "application/json", responseJsonSchema: req.schema }),
    },
  };
  // Rate limits, overloads and dropped connections are retried with backoff; other errors are reported at once.
  let response: Reply | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      response = await post(target.url, { "content-type": "application/json", ...target.headers }, JSON.stringify(body));
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (response.status === 400 && "responseJsonSchema" in body.generationConfig && /responseJsonSchema|response_json_schema/i.test(response.text)) {
      delete (body.generationConfig as { responseJsonSchema?: unknown }).responseJsonSchema;
      continue;
    }
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  if (response!.status < 200 || response!.status >= 300) {
    const text = response!.text.slice(0, 2000);
    fail(`Gemini ${model} answered HTTP ${response!.status}: ${text}`, [401, 403, 404].includes(response!.status) ? FATAL : 1);
  }
  const data = JSON.parse(response!.text) as GeminiResponse;
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  const toolCalls = parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({ id: p.functionCall!.id ?? `${req.key.replace(/\W+/g, "-")}-${i}`, name: p.functionCall!.name, input: p.functionCall!.args ?? {}, ...(p.thoughtSignature && { meta: { thoughtSignature: p.thoughtSignature } }) }));
  const usage = data.usageMetadata;
  process.stdout.write(
    `${RESPONSE_MARKER}\n${JSON.stringify({
      text,
      toolCalls,
      stop: stopReason(candidate?.finishReason, data.promptFeedback?.blockReason, toolCalls.length),
      usage: { input: usage?.promptTokenCount ?? 0, output: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0) },
    })}`,
  );
}

if (import.meta.main)
  main().catch((e: unknown) => {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    fail(`${(e as Error).message}${cause ? `: ${cause.code ?? ""} ${cause.message ?? ""}`.trimEnd() : ""}`);
  });
