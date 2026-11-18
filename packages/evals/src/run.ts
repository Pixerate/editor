import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRUSH_PRESETS } from "@pixerate/editor/brushes";
import { matchesEvalExpectation } from "@pixerate/editor/tools";
import { createBrushSession, hasOwnColour, strokePng, type BrushSession } from "./host.ts";
import { isBlank, readPng, strokeSimilarity } from "./image.ts";
import { judge, judgeParts, judgeScore } from "./judge.ts";
import { notSavedMessage, systemPrompt, taskMessage, type ReferenceView } from "./prompt.ts";
import { FatalModelError, type Check, type EvalTask, type FacetCheck, type Model, type ModelMessage, type ModelResponse, type Part, type SampleResult } from "./types.ts";

export interface RunContext {
  model: Model;
  judge?: Model;
  /** Results go here: `answers/` (replayable), `samples/<task>/<n>/`, `references/<task>/`. */
  out: string;
  /** Most model turns a sample gets (default 20). */
  turns?: number;
  log?: (line: string) => void;
}

/** Tools that change the library: a refusal from one means the first try was not clean. */
const WRITES = new Set(["create_brush", "update_brush", "duplicate_brush", "remove_brush"]);

/** Weights of the areas, as in the README. */
export const WEIGHTS = { validity: 0.15, requirements: 0.25, render: 0.15, look: 0.45 } as const;

/** The model, saving every answer as `<answers>/<key>.json`, which `replay:<answers>` reads back. */
export function recorded(model: Model, answers: string): Model {
  return {
    name: model.name,
    async generate(request) {
      const response = await model.generate(request);
      const file = path.join(answers, `${request.key}.json`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(response, null, 2));
      return response;
    },
  };
}

const references = new Map<string, Promise<ReferenceView>>();

/** A reference task's stroke: its preset drawn by the host's renderer (once per run folder), with the colour it was drawn in. */
export function referenceStroke(task: EvalTask, out: string): Promise<ReferenceView> {
  if (!task.reference) throw new Error(`"${task.id}" is not a reference task.`);
  const key = `${out}\0${task.id}`;
  let ready = references.get(key);
  if (!ready) {
    ready = (async () => {
      const { png, colour } = await strokePng(createBrushSession(task.host), task.reference!.preset);
      const preset = BRUSH_PRESETS.find((b) => b.id === task.reference!.preset)!;
      const dir = path.join(out, "references", task.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "reference.png"), png);
      return { png, ...(colour && { colour }), ownColour: hasOwnColour(preset) };
    })();
    references.set(key, ready);
  }
  return ready;
}

/** The text and images in a tool result. */
type ResultPart = { type: "text"; text: string } | { type: "image"; png: Buffer };

function resultParts(result: Awaited<ReturnType<BrushSession["call"]>>): ResultPart[] {
  return result.content.flatMap((c): ResultPart[] => {
    if (c.type === "text") return [{ type: "text" as const, text: String((c as { text: unknown }).text) }];
    if (c.type === "image") return [{ type: "image" as const, png: Buffer.from((c as { data: string }).data, "base64") }];
    return [];
  });
}

/** What describe_brush says about the saved brush, or undefined when there is none (or it is a built-in). */
async function describe(session: BrushSession, id: string): Promise<Record<string, unknown> | undefined> {
  const r = await session.call("describe_brush", { id });
  if (r.isError) return undefined;
  const s = r.structuredContent as Record<string, unknown> | undefined;
  return s && s.builtin === false ? s : undefined;
}

/** Checks every task makes on the saved brush's description: its type, and for a reference task, its kind of marks. */
export function typeChecks(task: EvalTask, description: Record<string, unknown>): Check[] {
  const brush = (description.brush ?? {}) as Record<string, any>;
  const checks: Check[] = [];
  if (task.type === "tool") checks.push({ name: "is a tool", pass: brush.kind === "tool", detail: `kind ${brush.kind}` });
  else checks.push({ name: `files under the ${task.type} family`, pass: description.family === task.type, detail: `family ${String(description.family)}` });
  return checks;
}

/** Reference tasks: the saved brush works the way the held-out preset does (same kind, surface, marks and tip shape). */
export function referenceChecks(preset: Record<string, any>, brush: Record<string, any>): Check[] {
  const same = (name: string, a: unknown, b: unknown): Check => ({ name, pass: a === b, detail: `${String(b)}, reference ${String(a)}` });
  return [
    same("same kind", preset.kind, brush.kind),
    ...(preset.kind === "tool" ? [same("same tool", preset.tool, brush.tool)] : [same("same medium", preset.medium, brush.medium)]),
    same("same surface", preset.behaviour?.surface ?? "dry", brush.behaviour?.surface ?? "dry"),
    same("same marks", preset.marks?.kind ?? "continuous", brush.marks?.kind ?? "continuous"),
    same("same tip shape", preset.tip?.shape, brush.tip?.shape),
  ];
}

/** A task's own checks against the description. */
export function facetChecks(checks: readonly FacetCheck[] | undefined, description: Record<string, unknown>): Check[] {
  return (checks ?? []).map((c) => ({ name: c.why, pass: matchesEvalExpectation(description, c.expect) }));
}

const rate = (checks: readonly Check[]) => (checks.length ? checks.filter((c) => c.pass).length / checks.length : 1);

/** The overall score, 0–100, from the areas present (missing areas don't count against it). */
export function overallScore(scores: SampleResult["scores"]): number {
  if (scores.validity === undefined || scores.validity === 0) return 0;
  const look = scores.judge !== undefined && scores.similarity !== undefined ? (2 * scores.judge + scores.similarity) / 3 : (scores.judge ?? scores.similarity);
  const parts: [number, number | undefined][] = [
    [WEIGHTS.validity, scores.validity],
    [WEIGHTS.requirements, scores.requirements],
    [WEIGHTS.render, scores.render],
    [WEIGHTS.look, look],
  ];
  const present = parts.filter(([, s]) => s !== undefined) as [number, number][];
  const total = (present.reduce((s, [w, v]) => s + w * v, 0) / present.reduce((s, [w]) => s + w, 0)) * 100;
  // A brush that paints nothing scores at most 20.
  return Math.round((scores.render === 0 ? Math.min(20, total) : total) * 10) / 10;
}

function transcriptMarkdown(messages: readonly ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    lines.push(`## ${m.role}`, "");
    for (const p of m.content) {
      if (p.type === "text") lines.push(p.text, "");
      else if (p.type === "image") lines.push(`*[image${p.label ? `: ${p.label}` : ""}]*`, "");
      else if (p.type === "tool_call") lines.push(`→ \`${p.name}\` ${JSON.stringify(p.input)}`, "");
      else {
        const text = p.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
        lines.push(`← \`${p.name}\`${p.isError ? " **error**" : ""}: ${text.length > 1500 ? `${text.slice(0, 1500)}…` : text}`, "");
      }
    }
  }
  return lines.join("\n");
}

/** Drafts (through the tool loop), checks, renders and grades one sample of one task. */
export async function runSample(task: EvalTask, sample: number, ctx: RunContext): Promise<SampleResult> {
  const dir = path.join(ctx.out, "samples", task.id, String(sample));
  mkdirSync(dir, { recursive: true });
  const answers = path.join(ctx.out, "answers");
  const maxTurns = Math.max(1, ctx.turns ?? 20);
  const usage = { input: 0, output: 0 };
  const ms = { generate: 0, tools: 0 };
  const tools: Record<string, number> = {};
  let toolCalls = 0;
  let toolErrors = 0;
  let writeRefused = false;
  let turns = 0;
  const base = { task: task.id, type: task.type, host: task.host, mode: task.mode, sample, model: ctx.model.name, dir };
  const messages: ModelMessage[] = [];

  try {
    const session = createBrushSession(task.host, task.reference?.preset);
    const reference = task.reference ? await referenceStroke(task, ctx.out) : undefined;
    const system = systemPrompt();
    messages.push({ role: "user", content: taskMessage(task, reference) });
    let nudged = false;

    while (turns < maxTurns) {
      turns++;
      const key = `${task.id}/${sample}/${turns}`;
      const t0 = Date.now();
      const response: ModelResponse = await recorded(ctx.model, answers).generate({ system, messages, tools: session.tools, key });
      ms.generate += Date.now() - t0;
      usage.input += response.usage?.input ?? 0;
      usage.output += response.usage?.output ?? 0;
      if (response.stop === "refusal") throw new Error("The model refused.");

      const calls = response.toolCalls ?? [];
      messages.push({
        role: "assistant",
        content: [...(response.text ? [{ type: "text" as const, text: response.text }] : []), ...calls.map((c) => ({ type: "tool_call" as const, ...c }))],
      });
      if (!calls.length) {
        // Done, by its own account. Remind it once if nothing was saved, as the person would.
        if (!nudged && !(await describe(session, task.brushId))) {
          nudged = true;
          messages.push({ role: "user", content: notSavedMessage(task) });
          continue;
        }
        break;
      }
      const results: Part[] = [];
      for (const call of calls) {
        const t1 = Date.now();
        const result = await session.call(call.name, call.input);
        ms.tools += Date.now() - t1;
        toolCalls++;
        tools[call.name] = (tools[call.name] ?? 0) + 1;
        if (result.isError) {
          toolErrors++;
          if (WRITES.has(call.name)) writeRefused = true;
        }
        results.push({ type: "tool_result", id: call.id, name: call.name, content: resultParts(result), ...(result.isError && { isError: true }) });
      }
      messages.push({ role: "user", content: results });
    }

    // Grade the library as the model left it.
    const description = await describe(session, task.brushId);
    const checks: Check[] = [];
    const scores: SampleResult["scores"] = {};
    if (!description) {
      checks.push({ name: "saved", pass: false, detail: `no brush ${task.brushId}` });
      scores.validity = 0;
      return finish({ ...base, turns, firstTry: false, checks, scores, overall: 0 });
    }
    writeFileSync(path.join(dir, "brush.json"), JSON.stringify(description.brush, null, 2));
    const check = description.check as { ok?: boolean; issues?: { message?: string }[] } | undefined;
    const validity: Check[] = [
      { name: "saved", pass: true },
      { name: `${task.host} can paint it`, pass: check?.ok === true, detail: check?.issues?.map((i) => i.message).join("; ") },
    ];
    const requirements: Check[] = [...typeChecks(task, description), ...facetChecks(task.checks, description)];
    if (task.reference) {
      const preset = BRUSH_PRESETS.find((b) => b.id === task.reference!.preset) as unknown as Record<string, any>;
      requirements.push(...referenceChecks(preset, description.brush as Record<string, any>));
    }
    scores.validity = rate(validity);
    scores.requirements = rate(requirements);

    let stroke: Buffer | undefined;
    let strokeColour: string | undefined;
    try {
      const drawn = await strokePng(session, task.brushId);
      stroke = drawn.png;
      strokeColour = drawn.colour;
      writeFileSync(path.join(dir, "stroke.png"), stroke);
      if (drawn.fallback) writeFileSync(path.join(dir, "stroke-note.txt"), `The host's preview_brush refused this brush, so the paint engine drew it: ${drawn.fallback}\n`);
    } catch (e) {
      checks.push({ name: "renders", pass: false, detail: (e as Error).message });
    }
    const painted = stroke ? !isBlank(readPng(stroke)) : false;
    if (stroke) checks.push({ name: "paints something", pass: painted });
    scores.render = painted ? 1 : 0;

    let similarity: SampleResult["similarity"];
    if (reference && stroke) {
      const s = strokeSimilarity(readPng(stroke), readPng(reference.png));
      similarity = { coverage: s.coverage, colour: s.colour, structure: s.structure };
      scores.similarity = s.overall;
    }
    let judged: SampleResult["judge"];
    if (ctx.judge && stroke) {
      judged = await judge(recorded(ctx.judge, answers), `judge/${task.id}/${sample}`, judgeParts(task, { png: stroke, ...(strokeColour && { colour: strokeColour }) }, description.brush, reference));
      scores.judge = judgeScore(judged);
    }
    checks.unshift(...validity, ...requirements);
    const firstTry = !writeRefused;
    return finish({ ...base, turns, firstTry, checks, scores, overall: overallScore(scores), ...(judged && { judge: judged }), ...(similarity && { similarity }) });
  } catch (e) {
    if (e instanceof FatalModelError) throw e;
    return finish({ ...base, turns, firstTry: false, checks: [], scores: {}, overall: 0, error: (e as Error).message });
  } finally {
    writeFileSync(path.join(dir, "transcript.md"), transcriptMarkdown(messages));
  }

  function finish(r: Omit<SampleResult, "usage" | "ms" | "toolCalls" | "toolErrors" | "tools">): SampleResult {
    return { ...r, usage, ms, toolCalls, toolErrors, tools };
  }
}

/** Runs every task's samples, `concurrency` at a time. A fatal model error stops the run. */
export async function runAll(tasks: readonly EvalTask[], samples: number, concurrency: number, ctx: RunContext): Promise<SampleResult[]> {
  const jobs = tasks.flatMap((t) => Array.from({ length: samples }, (_, i) => ({ task: t, sample: i + 1 })));
  const results: SampleResult[] = new Array(jobs.length);
  let next = 0;
  let fatal: unknown;
  const worker = async () => {
    while (next < jobs.length && !fatal) {
      const i = next++;
      const { task, sample } = jobs[i]!;
      try {
        const r = await runSample(task, sample, ctx);
        results[i] = r;
        ctx.log?.(`${task.id}#${sample}: ${r.overall}/100 in ${r.turns} turn(s), ${r.toolCalls} tool call(s)${r.error ? ` (${r.error})` : ""}`);
      } catch (e) {
        fatal = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (fatal) throw fatal;
  return results;
}
