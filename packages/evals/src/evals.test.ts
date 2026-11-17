import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { geminiContents } from "./adapters/gemini.ts";
import { createBrushSession, strokePng, WITHHELD_TOOLS } from "./host.ts";
import { inkColour, readPng, strokeSimilarity, isBlank } from "./image.ts";
import { judgeParts, judgeScore, parseJudge } from "./judge.ts";
import { commandResponse, createModel, oracleCalls, wireRequest } from "./models.ts";
import { systemPrompt, SKILLS, readSkill, taskMessage } from "./prompt.ts";
import { markdownReport } from "./report.ts";
import { compareRuns } from "./compare.ts";
import { facetChecks, overallScore, referenceStroke, runSample, typeChecks } from "./run.ts";
import { BUILTIN_TASKS, loadTaskFile, selectTasks } from "./tasks.ts";
import { BRUSH_TYPES, FatalModelError, RESPONSE_MARKER, type EvalTask, type Model, type ModelRequest, type ModelResponse } from "./types.ts";

const out = mkdtempSync(path.join(tmpdir(), "brush-evals-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** A model that makes the given calls on its first turn, then says it is done. */
function scripted(calls: { name: string; input: Record<string, unknown> }[], name = "scripted"): Model & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    name,
    requests,
    async generate(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const turn = Number(request.key.split("/")[2]);
      if (turn > 1 || !calls.length) return { text: "Done.", stop: "end_turn" };
      return { text: "", stop: "tool_use", toolCalls: calls.map((c, i) => ({ id: `c${i}`, ...c })) };
    },
  };
}

const task = (id: string) => BUILTIN_TASKS.find((t) => t.id === id)!;

describe("tasks", () => {
  it("cover every brush type in both modes, with unique ids", () => {
    const ids = BUILTIN_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const scratchTypes = new Set(BUILTIN_TASKS.filter((t) => t.mode === "scratch").map((t) => t.type));
    expect([...scratchTypes].sort()).toEqual([...BRUSH_TYPES].sort());
    const refTypes = new Set(BUILTIN_TASKS.filter((t) => t.mode === "reference").map((t) => t.type));
    expect(BRUSH_TYPES.filter((t) => !refTypes.has(t))).toEqual(["metallic"]);
    for (const host of ["paint", "image", "canvas", "vector"]) expect(BUILTIN_TASKS.some((t) => t.host === host)).toBe(true);
  });

  it("each scratch solution saves its brush, passes every check and files under its type; an empty library fails", async () => {
    for (const t of BUILTIN_TASKS.filter((x) => x.mode === "scratch")) {
      const session = createBrushSession(t.host);
      expect((await session.call("describe_brush", { id: t.brushId })).isError, t.id).toBe(true);
      for (const call of oracleCalls(t)) {
        const r = await session.call(call.tool, call.args);
        expect(r.isError, `${t.id}: ${call.tool} ${JSON.stringify(r.content)}`).toBeFalsy();
      }
      const d = (await session.call("describe_brush", { id: t.brushId })).structuredContent as Record<string, unknown>;
      const failed = [...typeChecks(t, d), ...facetChecks(t.checks, d)].filter((c) => !c.pass);
      expect(failed, t.id).toEqual([]);
    }
  });

  it("filters by mode, type, host and id, and refuses unknown ones", () => {
    expect(selectTasks(BUILTIN_TASKS, { modes: ["reference"], hosts: ["canvas"] }).map((t) => t.id)).toEqual(["ref-chalk-canvas"]);
    expect(selectTasks(BUILTIN_TASKS, { types: ["metallic"] }).map((t) => t.id)).toEqual(["metallic-gold-leaf"]);
    expect(() => selectTasks(BUILTIN_TASKS, { types: ["sparkly"] })).toThrow(/--type takes/);
    expect(() => selectTasks(BUILTIN_TASKS, { hosts: ["web"] })).toThrow(/--host takes/);
    expect(() => selectTasks(BUILTIN_TASKS, { ids: ["nope"] })).toThrow(/No task nope/);
  });

  it("loads the example task file", () => {
    const tasks = loadTaskFile(path.join(import.meta.dirname, "../tasks/custom.example.json"));
    expect(tasks.map((t) => [t.id, t.mode, t.host, t.brushId])).toEqual([
      ["rainy-window", "scratch", "paint", "rain-streak"],
      ["ref-oil-flat", "reference", "paint", "my-brush"],
    ]);
  });
});

describe("the brush session", () => {
  it("offers the host's tools by bare name, without the file-import tools", () => {
    const names = createBrushSession("paint").tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_brush_presets", "describe_brush", "create_brush", "update_brush", "check_brush", "preview_brush"]));
    for (const w of WITHHELD_TOOLS) expect(names).not.toContain(w);
  });

  it("holds a reference preset out, so it can neither be found nor based on", async () => {
    const s = createBrushSession("paint", "watercolor-wash");
    expect((await s.call("describe_brush", { id: "watercolor-wash" })).isError).toBe(true);
    const r = await s.call("create_brush", { id: "x", name: "X", basedOn: "watercolor-wash" });
    expect(r.isError).toBe(true);
    expect(() => createBrushSession("paint", "no-such-brush")).toThrow(/no built-in brush/);
  });

  it("draws every brush the vector host takes with its own preview, wet paint and smudge included", async () => {
    const s = createBrushSession("vector");
    for (const id of ["gouache", "watercolor-wash", "smudge", "pencil-hb"]) {
      const drawn = await strokePng(s, id);
      expect(drawn.fallback, id).toBeUndefined();
      expect(isBlank(readPng(drawn.png)), id).toBe(false);
    }
  }, 60_000);

  it("files a brush based on a preset under the family its own facets make it", async () => {
    const s = createBrushSession("paint");
    await s.call("create_brush", { id: "gold", name: "Gold", basedOn: "impasto-brush", behaviour: { thick: { metallic: 1 } } });
    expect(((await s.call("describe_brush", { id: "gold" })).structuredContent as { family: string }).family).toBe("metallic");
  });
});

describe("stroke colour", () => {
  it("draws a light / dark default in the side for its paper, as preview_brush and the brush UI do", async () => {
    const s = createBrushSession("paint");
    await s.call("create_brush", { id: "rust", name: "Rust", basedOn: "crayon", colour: { default: { light: "#a0402a", dark: "#c8603f" } } });
    const [r, g, b] = inkColour(readPng((await strokePng(s, "rust")).png));
    expect(r).toBeGreaterThan(g + 20);
    expect(r).toBeGreaterThan(b + 20);
  });

  it("passes a colour check on the light side of a pair", async () => {
    const t = task("dry-conte-canvas");
    const d = { brush: { colour: { default: { light: "#a0402a", dark: "#f1e6d6" } } } };
    expect(facetChecks(t.checks!.filter((c) => c.why === "rust red"), d)[0]!.pass).toBe(true);
  });
});

describe("colour hints", () => {
  it("tell the model the colour a reference was drawn in, and whether it is the brush's own", async () => {
    const own = await referenceStroke(task("ref-chalk-canvas"), out);
    const fallback = await referenceStroke(task("ref-watercolor-wash"), out);
    expect(own).toMatchObject({ ownColour: true, colour: expect.stringMatching(/^#[0-9a-f]{6}$/) });
    expect(fallback).toMatchObject({ ownColour: false, colour: expect.stringMatching(/^#[0-9a-f]{6}$/) });
    const text = (parts: ReturnType<typeof taskMessage>) => parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ");
    expect(text(taskMessage(task("ref-chalk-canvas"), own))).toContain(`drawn in ${own.colour}, from the brush's own default colour`);
    expect(text(taskMessage(task("ref-watercolor-wash"), fallback))).toMatch(/fallback for its medium: the brush has no default colour of its own/);
  });

  it("tell the judge what the host ignores and when a colour is only the preview's fallback", async () => {
    const reference = await referenceStroke(task("ref-watercolor-wash"), out);
    const text = (parts: ReturnType<typeof judgeParts>) => parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ");
    const forImage = text(judgeParts(task("dry-pastel-image"), { png: reference.png, colour: "#8a8478" }, { colour: { default: "#f8f6f0" } }));
    expect(forImage).toMatch(/ignores paper grain/);
    expect(forImage).toMatch(/darkens or lightens a colour until it reads/);
    const forRef = text(judgeParts(task("ref-watercolor-wash"), { png: reference.png, colour: "#1d4ed8" }, {}, reference));
    expect(forRef.match(/don't grade its colour/g)).toHaveLength(2);
  });
});

describe("stroke similarity", () => {
  it("is 1 for the same stroke and lower for a different brush", async () => {
    const s = createBrushSession("paint");
    const wash = readPng((await strokePng(s, "watercolor-wash")).png);
    const pencil = readPng((await strokePng(s, "pencil-hb")).png);
    expect(strokeSimilarity(wash, wash).overall).toBeCloseTo(1, 5);
    expect(strokeSimilarity(pencil, wash).overall).toBeLessThan(0.6);
  });

  it("compares strokes of different sizes, as canvas and vector previews of different brushes are", async () => {
    const s = createBrushSession("canvas");
    await s.call("create_brush", { id: "fat-chalk", name: "Fat chalk", basedOn: "chalk", tip: { size: 40 } });
    const chalk = readPng((await strokePng(s, "chalk")).png);
    const fat = readPng((await strokePng(s, "fat-chalk")).png);
    expect([fat.width, fat.height]).not.toEqual([chalk.width, chalk.height]);
    const sim = strokeSimilarity(fat, chalk);
    expect(sim.overall).toBeGreaterThan(0.4);
    expect(sim.overall).toBeLessThan(1);
  });
});

describe("grading", () => {
  it("scores the oracle 100 on scratch and reference tasks", async () => {
    // A white paint on cream paper, tools that move the bands they preview over, and wet paint in vector strokes.
    const tasks = [task("wet-cerulean-bloom"), task("ref-chalk-canvas"), task("ref-gouache-vector"), task("thick-titanium-impasto"), task("ref-smudge"), task("volatile-tight-whirl")];
    const oracle = createModel("oracle", tasks);
    for (const t of tasks) {
      const r = await runSample(t, 1, { model: oracle, out });
      expect(r.overall, `${t.id}: ${JSON.stringify(r.checks.filter((c) => !c.pass))} ${r.error ?? ""}`).toBe(100);
      expect(r.firstTry).toBe(true);
    }
  }, 120_000);

  it("scores a brush from the wrong preset lower on a reference task", async () => {
    const r = await runSample(task("ref-watercolor-wash"), 1, { model: scripted([{ name: "create_brush", input: { id: "my-brush", name: "Mine", basedOn: "pencil-hb" } }]), out });
    expect(r.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual(expect.arrayContaining(["files under the wet family", "same medium", "same surface"]));
    expect(r.overall).toBeLessThan(60);
  });

  it("reminds a model once that stopped without saving, then scores it 0", async () => {
    const model = scripted([]);
    const r = await runSample(task("glow-neon-tube"), 1, { model, out });
    expect(model.requests).toHaveLength(2);
    const reminder = model.requests[1]!.messages.at(-1)!.content[0];
    expect(reminder).toMatchObject({ type: "text", text: expect.stringMatching(/no brush `neon-tube`/) });
    expect(r).toMatchObject({ overall: 0, turns: 2, firstTry: false, checks: [{ name: "saved", pass: false }] });
  });

  it("feeds tool errors back and counts a refused write against the first try", async () => {
    const model = scripted([
      { name: "create_brush", input: { id: "conte-canvas", name: "Wet", basedOn: "watercolor-wash" } },
      { name: "create_brush", input: { id: "conte-canvas", name: "Conté", basedOn: "crayon", colour: { default: "#9a3b26" }, behaviour: { grain: 0.95 } } },
    ]);
    const r = await runSample(task("dry-conte-canvas"), 1, { model, out });
    const results = model.requests[1]!.messages.at(-1)!.content;
    expect(results[0]).toMatchObject({ type: "tool_result", isError: true, name: "create_brush" });
    expect(r).toMatchObject({ firstTry: false, toolCalls: 2, toolErrors: 1, tools: { create_brush: 2 } });
    expect(r.scores.validity).toBe(1);
    const transcript = readFileSync(path.join(r.dir, "transcript.md"), "utf8");
    expect(transcript).toMatch(/create_brush` \*\*error\*\*: Canvas can't use this brush/);
  });

  it("stops the run on a fatal model error", async () => {
    const fatal: Model = { name: "bad", generate: async () => Promise.reject(new FatalModelError("no key")) };
    await expect(runSample(task("glow-neon-tube"), 1, { model: fatal, out })).rejects.toThrow("no key");
    const flaky: Model = { name: "flaky", generate: async () => Promise.reject(new Error("socket hang up")) };
    expect(await runSample(task("glow-neon-tube"), 2, { model: flaky, out })).toMatchObject({ overall: 0, error: "socket hang up" });
  });

  it("weights the areas, ignores missing ones and caps a brush that paints nothing", () => {
    expect(overallScore({ validity: 1, requirements: 1, render: 1, judge: 1 })).toBe(100);
    expect(overallScore({ validity: 1, requirements: 0.5, render: 1 })).toBeCloseTo(((0.15 + 0.125 + 0.15) / 0.55) * 100, 0);
    expect(overallScore({ validity: 1, requirements: 1, render: 0, judge: 1 })).toBe(20);
    expect(overallScore({ validity: 0 })).toBe(0);
    expect(overallScore({ validity: 1, requirements: 1, render: 1, judge: 0, similarity: 1 })).toBeCloseTo(70, 0);
  });

  it("gives the judge's request and reads its answer", () => {
    expect(parseJudge('ok {"fidelity": 5, "medium": 4, "craft": 3, "settings": 2, "notes": "fine"}')).toEqual({ fidelity: 5, medium: 4, craft: 3, settings: 2, notes: "fine" });
    expect(() => parseJudge('{"fidelity": 9, "medium": 4, "craft": 3, "settings": 2}')).toThrow(/fidelity is 9/);
    expect(judgeScore({ fidelity: 5, medium: 5, craft: 5, settings: 5, notes: "" })).toBe(1);
    expect(judgeScore({ fidelity: 1, medium: 1, craft: 1, settings: 1, notes: "" })).toBe(0);
  });

  it("re-grades a run from its saved answers", async () => {
    const t = task("spray-stencil-pink");
    const first = await runSample(t, 3, { model: createModel("oracle", [t]), out });
    const again = await runSample(t, 3, { model: createModel(`replay:${path.join(out, "answers")}`), out: path.join(out, "replayed") });
    expect(again.overall).toBe(first.overall);
  });
});

describe("models", () => {
  it("send the shipped skills as the system prompt", () => {
    const system = systemPrompt();
    for (const s of SKILLS) expect(system).toContain(readSkill(s).slice(0, 200));
    expect(system).not.toMatch(/^---/m);
  });

  it("read a command's envelope with tool calls, or its plain text", () => {
    expect(commandResponse("hello")).toEqual({ text: "hello" });
    const r = commandResponse(`${RESPONSE_MARKER}\n${JSON.stringify({ text: "", stop: "tool_use", toolCalls: [{ id: "a", name: "list_brush_presets", input: {} }], usage: { input: 3, output: 4 } })}`);
    expect(r).toEqual({ text: "", stop: "tool_use", toolCalls: [{ id: "a", name: "list_brush_presets", input: {} }], usage: { input: 3, output: 4 } });
    expect(() => commandResponse(`${RESPONSE_MARKER}\n{"text":"", "toolCalls":[{"name":"x"}]}`)).toThrow(/tool call without an id/);
  });

  it("send images as base64 and tool results with their images to a command, and Gemini gets them inside the function response", () => {
    const png = Buffer.from([1, 2, 3]);
    const wire = wireRequest({
      key: "k",
      system: "s",
      tools: [{ name: "preview_brush", description: "d", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "make one" }, { type: "image", png, label: "Reference" }] },
        { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "preview_brush", input: { id: "x" }, meta: { thoughtSignature: "sig" } }] },
        { role: "user", content: [{ type: "tool_result", id: "c1", name: "preview_brush", content: [{ type: "text", text: "{}" }, { type: "image", png }] }] },
      ],
    });
    expect(wire.messages[0]!.content[1]).toEqual({ type: "image", media_type: "image/png", data: "AQID", label: "Reference" });
    const contents = geminiContents(JSON.parse(JSON.stringify(wire.messages)));
    expect(contents[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "preview_brush", args: { id: "x" } }, thoughtSignature: "sig" }] });
    expect(contents[2]!.parts).toEqual([{ functionResponse: { name: "preview_brush", response: { result: "{}" }, parts: [{ inlineData: { mimeType: "image/png", data: "AQID" } }] } }]);
  });

  it("refuse an unknown spec and an unknown option", () => {
    expect(() => createModel("openai:gpt")).toThrow(/not a model spec/);
    expect(() => createModel("anthropic:claude-opus-5-5?temp=1")).toThrow(/unknown option temp/);
  });
});

describe("reports", () => {
  it("summarise a run and compare two", async () => {
    const t = task("tool-soft-blender");
    const a = await runSample(t, 1, { model: createModel("oracle", [t]), out: path.join(out, "a") });
    const b = await runSample(t, 1, { model: scripted([], "anthropic:other"), out: path.join(out, "b") });
    const report = markdownReport([a, b], { model: "oracle", turns: 20, started: "now" });
    expect(report).toMatch(/# Brush drafting eval/);
    expect(report).toMatch(/- saved: 1/);
    const compared = compareRuns([
      { dir: "a", meta: { model: "oracle", turns: 20 }, results: [a] },
      { dir: "b", meta: { model: "anthropic:other", turns: 20 }, results: [b] },
    ]);
    expect(compared).toMatch(/# oracle vs other/);
    expect(compared).toMatch(/## By host/);
  });
});
