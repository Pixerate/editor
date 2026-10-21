import { describe, it, expect, vi } from "vitest";
import {
  capabilitiesToJsonSchema,
  createBatchResolver,
  createGenerationToolProvider,
  createProvenance,
  estimateJobProgress,
  expectedDurationFor,
  formatRemaining,
  mergeCapabilities,
  parseProvenance,
  planGenerationRequest,
  ProvenanceParseError,
  recreateRequest,
  replayProvenancePrompt,
  serializeProvenance,
  snapToOption,
  aspectRatioRank,
  resolutionRank,
  validateJsonSchema,
  getGenerationControls,
  getReferenceSlots,
  getRequestValue,
  setRequestValue,
  parseControlValue,
  addReference,
  removeReference,
  type GenerationRequest,
  type ModelCapabilities,
} from "../src/generation";
import { ToolRegistry } from "../src/tools/registry";
import type { Template } from "../src/grammar";
import { baseToolName } from "../src/tools";

const imageModel: ModelCapabilities = {
  id: "img-1",
  name: "Image One",
  media: "image",
  prompt: { maxLength: 40, countResolved: false },
  negativePrompt: { maxLength: 20 },
  aspectRatios: { options: ["9:16", "1:1", "16:9"], default: "1:1" },
  resolutions: { options: ["512x512", "1024x1024", "2048x2048"], default: "1024x1024" },
  quality: { options: ["draft", "standard", "high"], default: "standard" },
  count: { max: 4, options: [1, 2, 4], default: 1 },
  seed: { min: 0, max: 1000 },
  references: {
    roles: { style_ref: { max: 2 }, character_ref: { max: 1 } },
    maxTotal: 2,
  },
  inpainting: true,
  params: {
    guidance: { type: "number", min: 1, max: 10, step: 0.5, default: 7 },
    steps: { type: "integer", min: 1, max: 50 },
    sampler: { type: "enum", options: ["euler", "ddim"], default: "euler" },
    tile: { type: "boolean" },
  },
  timing: { baseMs: 10_000, perItemMs: 5_000, perMegapixelMs: 1_000 },
};

const videoModel: ModelCapabilities = {
  id: "vid-1",
  media: "video",
  duration: { min: 2, max: 10, options: [4, 6, 8] },
  references: { roles: { start_frame: { max: 1, min: 1 }, end_frame: { max: 1 } } },
  timing: { baseMs: 30_000, perSecondMs: 10_000 },
};

const textModel: ModelCapabilities = {
  id: "txt-1",
  media: "text",
  prompt: { maxLength: 100 },
  systemPrompt: true,
};

describe("planGenerationRequest", () => {
  it("leaves a valid request unchanged and does not mutate the input", () => {
    const request: GenerationRequest = {
      prompt: "a cat",
      aspectRatio: "16:9",
      references: [{ id: "a", role: "style_ref" }],
    };
    const snapshot = JSON.stringify(request);
    const plan = planGenerationRequest(request, imageModel);
    expect(plan.ok).toBe(true);
    expect(plan.adjustments).toEqual([]);
    expect(plan.request).toEqual({ ...request, model: "img-1" });
    expect(JSON.stringify(request)).toBe(snapshot);
    expect(planGenerationRequest(request, imageModel)).toEqual(plan);
  });

  it("snaps aspect ratios and resolutions to the nearest option", () => {
    const plan = planGenerationRequest({ aspectRatio: "21:9", resolution: "1200x1200" }, imageModel);
    expect(plan.request.aspectRatio).toBe("16:9");
    expect(plan.request.resolution).toBe("1024x1024");
    expect(plan.adjustments.map((a) => [a.field, a.from, a.to, a.kind])).toEqual([
      ["aspectRatio", "21:9", "16:9", "snapped"],
      ["resolution", "1200x1200", "1024x1024", "snapped"],
    ]);
  });

  it("breaks ties lower for downgrade and higher for upgrade/nearest", () => {
    // 1:1 is equidistant (in log ratio) from 9:16 and 16:9 when 1:1 itself is not offered.
    const caps: ModelCapabilities = { id: "m", media: "image", aspectRatios: { options: ["9:16", "16:9"] } };
    expect(planGenerationRequest({ aspectRatio: "1:1" }, caps, { strategy: "downgrade" }).request.aspectRatio).toBe("9:16");
    expect(planGenerationRequest({ aspectRatio: "1:1" }, caps, { strategy: "upgrade" }).request.aspectRatio).toBe("16:9");
    expect(planGenerationRequest({ aspectRatio: "1:1" }, caps, { strategy: "nearest" }).request.aspectRatio).toBe("16:9");
    // Count 3 is equidistant from 2 and 4.
    expect(planGenerationRequest({ count: 3 }, imageModel, { strategy: "downgrade" }).request.count).toBe(2);
    expect(planGenerationRequest({ count: 3 }, imageModel, { strategy: "upgrade" }).request.count).toBe(4);
    // Duration 5 is equidistant from 4 and 6.
    expect(planGenerationRequest({ duration: 5, references: [{ id: "f", role: "start_frame" }] }, videoModel, { strategy: "downgrade" }).request.duration).toBe(4);
    expect(planGenerationRequest({ duration: 5, references: [{ id: "f", role: "start_frame" }] }, videoModel, { strategy: "upgrade" }).request.duration).toBe(6);
  });

  it("snaps quality via the known ladder and falls back to the default for unknown names", () => {
    expect(planGenerationRequest({ quality: "ultra" }, imageModel).request.quality).toBe("high");
    expect(planGenerationRequest({ quality: "medium" }, imageModel).request.quality).toBe("standard");
    const plan = planGenerationRequest({ quality: "sparkly" }, imageModel);
    expect(plan.request.quality).toBe("standard");
    expect(plan.adjustments[0].reason).toMatch(/default/);
  });

  it("clamps and rounds ranges", () => {
    const plan = planGenerationRequest(
      { seed: 5000, count: 9, params: { guidance: 7.3, steps: 80.4 } },
      imageModel,
    );
    expect(plan.request.seed).toBe(1000);
    expect(plan.request.count).toBe(4);
    expect(plan.request.params).toEqual({ guidance: 7.5, steps: 50 });
    const byField = Object.fromEntries(plan.adjustments.map((a) => [a.field, a.kind]));
    expect(byField).toEqual({ seed: "clamped", count: "snapped", "params.guidance": "snapped", "params.steps": "clamped" });
    // Range without options.
    const ranged: ModelCapabilities = { id: "r", media: "video", duration: { min: 2, max: 10 } };
    expect(planGenerationRequest({ duration: 1 }, ranged).request.duration).toBe(2);
    expect(planGenerationRequest({ duration: 12 }, ranged).request.duration).toBe(10);
  });

  it("truncates reference lists per role and in total, reporting each", () => {
    const plan = planGenerationRequest(
      {
        references: [
          { id: "s1", role: "style_ref" },
          { id: "s2", role: "style_ref" },
          { id: "s3", role: "style_ref" },
          { id: "c1", role: "character_ref" },
        ],
      },
      imageModel,
    );
    expect(plan.ok).toBe(true);
    expect(plan.request.references!.map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(plan.adjustments.map((a) => [a.field, a.from, a.to, a.kind])).toEqual([
      ["references.style_ref", 3, 2, "truncated"],
      ["references", 3, 2, "truncated"],
    ]);
  });

  it("drops duplicate references and unsupported fields with a note", () => {
    const plan = planGenerationRequest(
      {
        duration: 4,
        references: [
          { id: "s1", role: "style_ref" },
          { id: "s1", role: "style_ref" },
        ],
        params: { unknown: 1 },
        ...({ bogus: true } as any),
      },
      imageModel,
    );
    expect(plan.ok).toBe(true);
    expect(plan.request).toEqual({ model: "img-1", references: [{ id: "s1", role: "style_ref" }] });
    expect(plan.adjustments.map((a) => [a.field, a.kind])).toEqual([
      ["bogus", "dropped"],
      ["duration", "dropped"],
      ["references.style_ref", "dropped"],
      ["params.unknown", "dropped"],
    ]);
  });

  it("truncates over-long text unless the strategy is error", () => {
    const long = "x".repeat(50);
    const plan = planGenerationRequest({ prompt: long, negativePrompt: "y".repeat(25) }, imageModel);
    expect(plan.request.prompt).toHaveLength(40);
    expect(plan.request.negativePrompt).toHaveLength(20);
    expect(plan.adjustments.map((a) => [a.field, a.from, a.to])).toEqual([
      ["prompt", 50, 40],
      ["negativePrompt", 25, 20],
    ]);
    // Never splits a surrogate pair.
    const emoji = planGenerationRequest({ prompt: "a".repeat(39) + "😀" }, imageModel);
    expect(emoji.request.prompt).toBe("a".repeat(39));
    const strict = planGenerationRequest({ prompt: long }, imageModel, { strategy: "error" });
    expect(strict.ok).toBe(false);
    expect(strict.request.prompt).toBe(long);
  });

  it("measures the resolved prompt when the model counts resolved text", () => {
    const caps: ModelCapabilities = { id: "p", media: "image", prompt: { maxLength: 10 } };
    const ok = planGenerationRequest({ prompt: "{{t}}" }, caps, { resolvedPrompt: "short" });
    expect(ok.ok).toBe(true);
    const tooLong = planGenerationRequest({ prompt: "{{t}}" }, caps, { resolvedPrompt: "much too long text" });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.errors[0]).toMatchObject({ field: "prompt", value: 18 });
    expect(tooLong.request.prompt).toBe("{{t}}");
  });

  it("errors on a text-only model given image references unless the strategy may drop them", () => {
    const request: GenerationRequest = { prompt: "hi", references: [{ id: "i", role: "image_ref" }] };
    for (const strategy of ["error", "upgrade"] as const) {
      const plan = planGenerationRequest(request, textModel, { strategy });
      expect(plan.ok).toBe(false);
      expect(plan.errors[0].field).toBe("references.image_ref");
      expect(plan.errors[0].message).toMatch(/text model/);
    }
    for (const strategy of ["nearest", "downgrade"] as const) {
      const plan = planGenerationRequest(request, textModel, { strategy });
      expect(plan.ok).toBe(true);
      expect(plan.request.references).toBeUndefined();
      expect(plan.adjustments[0]).toMatchObject({ field: "references.image_ref", from: 1, to: 0, kind: "dropped" });
    }
    expect(planGenerationRequest(request, textModel, { strategy: "upgrade", dropUnsupportedReferences: true }).ok).toBe(true);
  });

  it("reports every mismatch as an error under the error strategy and changes nothing", () => {
    const request: GenerationRequest = {
      aspectRatio: "4:3",
      count: 3,
      seed: -1,
      duration: 5,
      references: [
        { id: "a", role: "style_ref" },
        { id: "b", role: "style_ref" },
        { id: "c", role: "style_ref" },
      ],
      params: { sampler: "heun" },
    };
    const plan = planGenerationRequest(request, imageModel, { strategy: "error" });
    expect(plan.ok).toBe(false);
    expect(plan.adjustments).toEqual([]);
    expect(plan.errors.map((e) => e.field)).toEqual([
      "aspectRatio",
      "count",
      "duration",
      "seed",
      "references.style_ref",
      "references",
      "params.sampler",
    ]);
    expect(plan.request).toEqual({ ...request, model: "img-1" });
  });

  it("errors on required references, unsupported modes, inpaint without mask, wrong model and missing prompt", () => {
    expect(planGenerationRequest({}, videoModel).errors[0]).toMatchObject({ field: "references.start_frame" });
    expect(planGenerationRequest({ mode: "edit" }, imageModel).errors[0]).toMatchObject({ field: "mode" });
    expect(planGenerationRequest({ mode: "inpaint" }, imageModel).errors[0]).toMatchObject({ field: "references.mask" });
    expect(
      planGenerationRequest({ mode: "inpaint", references: [{ id: "m", role: "mask" }] }, imageModel).ok,
    ).toBe(true);
    expect(planGenerationRequest({ model: "other" }, imageModel).errors[0]).toMatchObject({ field: "model" });
    const required: ModelCapabilities = { id: "q", media: "image", prompt: { required: true } };
    expect(planGenerationRequest({ prompt: "  " }, required).errors[0]).toMatchObject({ field: "prompt" });
  });

  it("fills defaults when asked", () => {
    const plan = planGenerationRequest({}, imageModel, { fillDefaults: true });
    expect(plan.request).toMatchObject({
      aspectRatio: "1:1",
      resolution: "1024x1024",
      quality: "standard",
      count: 1,
      params: { guidance: 7, sampler: "euler" },
    });
    expect(plan.adjustments.every((a) => a.kind === "defaulted")).toBe(true);
  });

  it("snapToOption ranks and returns undefined for unrankable values", () => {
    expect(snapToOption("2:1", ["1:1", "16:9"], aspectRatioRank, "lower")).toBe("16:9");
    expect(snapToOption("800p", ["480p", "1080p"], resolutionRank, "lower")).toBe("1080p");
    // 720p is a geometric tie between 480p and 1080p.
    expect(snapToOption("720p", ["480p", "1080p"], resolutionRank, "lower")).toBe("480p");
    expect(snapToOption("720p", ["480p", "1080p"], resolutionRank, "higher")).toBe("1080p");
    expect(snapToOption("wide", ["1:1"], aspectRatioRank, "lower")).toBeUndefined();
  });
});

describe("capabilitiesToJsonSchema", () => {
  const schema = capabilitiesToJsonSchema(imageModel);

  it("describes enums, ranges and limits", () => {
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties!;
    expect(props.aspectRatio).toMatchObject({ enum: ["9:16", "1:1", "16:9"], default: "1:1" });
    expect(props.count).toMatchObject({ type: "integer", enum: [1, 2, 4] });
    expect(props.seed).toMatchObject({ minimum: 0, maximum: 1000 });
    expect(props.prompt).toMatchObject({ maxLength: 40 });
    expect(props.references).toMatchObject({ maxItems: 2 });
    expect((props.references.items as any).properties.role.enum).toEqual(["style_ref", "character_ref", "mask"]);
    expect(props.references.description).toMatch(/style_ref .*up to 2/);
    expect((props.params as any).properties.guidance).toMatchObject({ minimum: 1, maximum: 10 });
    expect(props.mode.enum).toEqual(["generate", "inpaint"]);
    expect(props.duration).toBeUndefined();
  });

  it("validates with validateJsonSchema", () => {
    expect(
      validateJsonSchema(
        { prompt: "cat", aspectRatio: "16:9", count: 2, references: [{ id: "a", role: "style_ref" }], params: { guidance: 3 } },
        schema,
      ),
    ).toEqual([]);
    const errors = validateJsonSchema(
      { aspectRatio: "4:3", count: 3, seed: 2000, duration: 4, references: [{ id: "a", role: "start_frame" }], params: { guidance: 99 } },
      schema,
    );
    expect(errors.map((e) => e.path).sort()).toEqual(
      ["/aspectRatio", "/count", "/duration", "/params/guidance", "/references/0/role", "/seed"].sort(),
    );
  });

  it("does not put maxLength on prompts counted after resolution, and marks required references", () => {
    const caps: ModelCapabilities = { id: "p", media: "image", prompt: { maxLength: 10 } };
    expect(capabilitiesToJsonSchema(caps).properties!.prompt.maxLength).toBeUndefined();
    expect(capabilitiesToJsonSchema(caps).properties!.prompt.description).toMatch(/resolved/);
    const video = capabilitiesToJsonSchema(videoModel);
    expect(video.required).toContain("references");
    expect(video.properties!.duration).toMatchObject({ enum: [4, 6, 8] });
    expect(validateJsonSchema({ references: [{ id: "f", role: "start_frame" }], duration: 6 }, video)).toEqual([]);
  });
});

describe("mergeCapabilities", () => {
  it("keeps remote capability values, adds overlay presentation and overlay-only models", () => {
    const remote: ModelCapabilities[] = [{ id: "a", media: "image", name: "a-raw", count: { max: 4 } }, { id: "b", media: "video" }];
    const merged = mergeCapabilities(remote, [
      { id: "a", name: "Model A", badges: ["new"], count: { max: 99 }, media: "audio" },
      { id: "c", media: "text", name: "Local" },
      { id: "d", name: "Incomplete" },
    ]);
    expect(merged).toEqual([
      { id: "a", media: "image", name: "Model A", badges: ["new"], count: { max: 4 } },
      { id: "b", media: "video" },
      { id: "c", media: "text", name: "Local" },
    ]);
    expect(remote[0].name).toBe("a-raw");
  });
});

describe("createGenerationToolProvider", () => {
  function setup(overrides: Partial<Parameters<typeof createGenerationToolProvider>[0]> = {}) {
    const generate = vi.fn(async (request: GenerationRequest) => ({ jobId: `job-${generate.mock.calls.length}`, request }));
    const provider = createGenerationToolProvider({ models: [imageModel, textModel], generate, ...overrides });
    const registry = new ToolRegistry();
    registry.register(provider);
    return { registry, generate, provider };
  }

  it("exposes annotated tools", () => {
    const { registry } = setup({ estimate: () => ({ credits: 2 }) });
    const tools = registry.listTools().tools;
    expect(tools.map((t) => baseToolName(t.name))).toEqual(["list_models", "plan_generation", "estimate_generation", "generate"]);
    const annotations = Object.fromEntries(tools.map((t) => [baseToolName(t.name), t.annotations]));
    for (const name of ["list_models", "plan_generation", "estimate_generation"]) {
      expect(annotations[name]).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      expect(typeof annotations[name]!.openWorldHint).toBe("boolean");
      expect(annotations[name]!.title).toBeTruthy();
    }
    expect(annotations.generate).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    const generate = tools.find((t) => baseToolName(t.name) === "generate")!;
    expect(generate.inputSchema.required).toEqual(["model", "request", "idempotencyKey"]);
    expect((generate.inputSchema.properties as any).model.enum).toEqual(["img-1", "txt-1"]);
  });

  it("omits estimate_generation without an estimate function", () => {
    const { registry } = setup();
    expect(registry.hasTool("estimate_generation")).toBe(false);
  });

  it("lists models with request schemas and plans without generating", async () => {
    const { registry, generate } = setup();
    const list = await registry.callTool("list_models", { media: "image" });
    const models = (list.structuredContent as any).models;
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "img-1", name: "Image One", media: "image" });
    expect(models[0].requestSchema.properties.aspectRatio.enum).toEqual(["9:16", "1:1", "16:9"]);

    const plan = await registry.callTool("plan_generation", { model: "img-1", request: { aspectRatio: "21:9" } });
    expect((plan.structuredContent as any).plan.request.aspectRatio).toBe("16:9");
    expect(generate).not.toHaveBeenCalled();
  });

  it("estimates the planned request", async () => {
    const estimate = vi.fn(() => ({ credits: 3 }));
    const { registry } = setup({ estimate });
    const result = await registry.callTool("estimate_generation", { model: "img-1", request: { count: 3 }, strategy: "downgrade" });
    expect((result.structuredContent as any).estimate).toEqual({ credits: 3 });
    expect((estimate.mock.calls[0] as any)[0].count).toBe(2);
  });

  it("deduplicates generate calls by idempotency key", async () => {
    const { registry, generate } = setup();
    const args = { model: "img-1", request: { prompt: "cat", aspectRatio: "21:9" }, idempotencyKey: "k1" };
    const [first, concurrent] = await Promise.all([registry.callTool("generate", args), registry.callTool("generate", args)]);
    const retry = await registry.callTool("generate", { ...args, request: { aspectRatio: "21:9", prompt: "cat" } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect((generate.mock.calls[0] as any)[0].aspectRatio).toBe("16:9");
    expect((generate.mock.calls[0] as any)[1].idempotencyKey).toBe("k1");
    expect((first.structuredContent as any).result.jobId).toBe("job-1");
    expect((concurrent.structuredContent as any).deduplicated).toBe(true);
    expect((retry.structuredContent as any)).toMatchObject({ deduplicated: true, result: { jobId: "job-1" } });

    const conflict = await registry.callTool("generate", { ...args, request: { prompt: "dog" } });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]).toMatchObject({ text: expect.stringMatching(/different arguments/) });

    await registry.callTool("generate", { ...args, idempotencyKey: "k2" });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("forgets keys of failed calls so retries can succeed, and rejects failing plans", async () => {
    let fail = true;
    const generate = vi.fn(async () => {
      if (fail) throw new Error("upstream down");
      return { jobId: "ok" };
    });
    const { registry } = setup({ generate });
    const args = { model: "img-1", request: { prompt: "cat" }, idempotencyKey: "k" };
    expect((await registry.callTool("generate", args)).isError).toBe(true);
    fail = false;
    const retry = await registry.callTool("generate", args);
    expect((retry.structuredContent as any).result).toEqual({ jobId: "ok" });
    expect(generate).toHaveBeenCalledTimes(2);

    const bad = await registry.callTool("generate", {
      model: "txt-1",
      request: { references: [{ id: "i", role: "image_ref" }] },
      strategy: "error",
      idempotencyKey: "k3",
    });
    expect(bad.isError).toBe(true);
    expect((bad.structuredContent as any).error.code).toBe("plan_failed");
    expect(generate).toHaveBeenCalledTimes(2);

    const missingKey = await registry.callTool("generate", { model: "img-1", request: {} });
    expect((missingKey.structuredContent as any).error.code).toBe("invalid_arguments");
  });

  it("evicts the oldest keys past maxIdempotencyKeys", async () => {
    const { registry, generate } = setup({ maxIdempotencyKeys: 1 });
    const call = (key: string) => registry.callTool("generate", { model: "img-1", request: {}, idempotencyKey: key });
    await call("a");
    await call("b");
    await call("a");
    expect(generate).toHaveBeenCalledTimes(3);
  });
});

describe("provenance", () => {
  const templates: Template[] = [
    {
      id: "t-style",
      name: "style",
      latestVersion: "2",
      versions: [
        { id: "v1", version: "1", body: "oil painting" },
        { id: "v2", version: "2", body: "watercolor, {{mood}}" },
      ],
    },
    { name: "mood", body: "calm" },
  ];

  it("records pinned templates, values, the resolved prompt and sourcemap, and round-trips", () => {
    const plan = planGenerationRequest(
      { prompt: "A {animal} in {{style}}", aspectRatio: "21:9", seed: 42, references: [{ id: "r1", role: "style_ref" }] },
      imageModel,
    );
    const provenance = createProvenance({
      rawPrompt: "A {animal} in {{style}}",
      templates,
      values: { animal: "fox" },
      model: imageModel,
      plan,
      createdAt: 0,
      completedAt: "2026-01-01T00:00:10Z",
      outputIds: ["out-1"],
    });
    expect(provenance.resolvedPrompt).toBe("A fox in watercolor, calm");
    expect(provenance.templates).toEqual([
      { name: "style", templateId: "t-style", versionId: "v2", version: "2", body: "watercolor, {{mood}}" },
      { name: "mood", body: "calm" },
    ]);
    expect(provenance.bindings).toEqual({ style: "v2" });
    expect(provenance.sourceMap.some((s) => s.source === "template" && s.templateName === "style")).toBe(true);
    expect(provenance.adjustments[0]).toMatchObject({ field: "aspectRatio", to: "16:9" });
    expect(provenance.references).toEqual([{ id: "r1", role: "style_ref" }]);
    expect(provenance.createdAt).toBe("1970-01-01T00:00:00.000Z");

    const parsed = parseProvenance(serializeProvenance(provenance));
    expect(parsed).toEqual(provenance);
    expect(recreateRequest(parsed)).toEqual(plan.request);
    // Later template edits do not change the replay.
    expect(replayProvenancePrompt(parsed)).toMatchObject({ text: provenance.resolvedPrompt, matches: true });
  });

  it("honours version bindings and fills the prompt with the resolved text when the request has none", () => {
    const provenance = createProvenance({
      rawPrompt: "{{style}}",
      templates,
      bindings: { style: "v1" },
      model: "img-1",
      request: { aspectRatio: "1:1" },
      createdAt: 1000,
    });
    expect(provenance.resolvedPrompt).toBe("oil painting");
    expect(provenance.templates).toEqual([{ name: "style", templateId: "t-style", versionId: "v1", version: "1", body: "oil painting" }]);
    expect(provenance.values).toBeNull();
    expect(recreateRequest(provenance)).toEqual({ aspectRatio: "1:1", model: "img-1", prompt: "oil painting" });
    expect(replayProvenancePrompt(provenance).matches).toBe(true);
  });

  it("rejects malformed or future records", () => {
    expect(() => parseProvenance("{")).toThrow(ProvenanceParseError);
    expect(() => parseProvenance({ format: "x" })).toThrow(/Not a generation provenance/);
    const valid = createProvenance({ rawPrompt: "x", model: "m", createdAt: 0 });
    expect(() => parseProvenance({ ...valid, version: 99 })).toThrow(/Unsupported provenance version/);
    expect(() => parseProvenance({ ...valid, modelId: 3 })).toThrow(/modelId/);
  });
});

describe("createBatchResolver", () => {
  it("batches and dedupes lookups within the delay window and caches results", async () => {
    const fetch = vi.fn(async (keys: string[]) => new Map(keys.filter((k) => k !== "missing").map((k) => [k, k.toUpperCase()])));
    const resolver = createBatchResolver({ fetch, maxBatch: 10 });
    const results = await Promise.all([resolver.load("a"), resolver.load("b"), resolver.load("a"), resolver.load("missing")]);
    expect(results).toEqual(["A", "B", "A", undefined]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toEqual(["a", "b", "missing"]);
    expect(await resolver.load("a")).toBe("A");
    expect(resolver.has("missing")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("splits batches at maxBatch", async () => {
    const fetch = vi.fn(async (keys: number[]) => new Map(keys.map((k) => [k, k * 2])));
    const resolver = createBatchResolver({ fetch, maxBatch: 2 });
    expect(await resolver.loadMany([1, 2, 3, 4, 5])).toEqual([2, 4, 6, 8, 10]);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("waits delayMs and records failures as resolved-empty", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const fetch = vi.fn(async () => {
        throw new Error("boom");
      });
      const resolver = createBatchResolver<string, string>({ fetch, delayMs: 50, onError });
      const pending = resolver.load("x");
      await vi.advanceTimersByTimeAsync(49);
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBeUndefined();
      expect(resolver.failed("x")).toBe(true);
      expect(onError).toHaveBeenCalledWith(expect.any(Error), ["x"]);
      await resolver.load("x");
      expect(fetch).toHaveBeenCalledTimes(1);
      resolver.clear("x");
      const again = resolver.load("x");
      await vi.advanceTimersByTimeAsync(50);
      await again;
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports prime, peek and clearing while a fetch is in flight", async () => {
    let release!: (value: Map<string, number>) => void;
    const fetch = vi.fn(() => new Promise<Map<string, number>>((r) => (release = r)));
    const resolver = createBatchResolver({ fetch });
    resolver.prime("p", 1);
    expect(await resolver.load("p")).toBe(1);
    expect(resolver.peek("p")).toBe(1);
    const pending = resolver.load("q");
    resolver.flush();
    resolver.clear();
    release(new Map([["q", 2]]));
    expect(await pending).toBe(2);
    expect(resolver.has("q")).toBe(false);
    expect(resolver.has("p")).toBe(false);
  });
});

describe("job progress", () => {
  it("is linear, capped at 95 until done, with remaining-time labels", () => {
    const at = (now: number, expectedMs = 300_000) => estimateJobProgress({ startedAt: 0, now, expectedMs });
    expect(at(0)).toMatchObject({ percent: 0, label: "Starting…" });
    expect(at(60_000)).toMatchObject({ percent: 20, label: "~4m left", remainingMs: 240_000, overdue: false });
    expect(at(290_000)).toMatchObject({ percent: 95, label: "~10s left" });
    expect(at(296_000)).toMatchObject({ percent: 95, label: "Almost done…" });
    expect(at(400_000)).toMatchObject({ percent: 95, label: "Almost done…", overdue: true });
    expect(estimateJobProgress({ startedAt: 0, now: 10, expectedMs: 100, done: true })).toMatchObject({ percent: 100, label: "Done" });
  });

  it("eases towards 95% without an expected duration", () => {
    const early = estimateJobProgress({ startedAt: 0, now: 10_000 });
    const late = estimateJobProgress({ startedAt: 0, now: 600_000 });
    expect(early.label).toBe("Working…");
    expect(early.percent).toBeGreaterThan(0);
    expect(late.percent).toBeLessThanOrEqual(95);
    expect(late.percent).toBeGreaterThan(early.percent);
  });

  it("formats remaining time", () => {
    expect(formatRemaining(400)).toBe("~1s left");
    expect(formatRemaining(45_000)).toBe("~45s left");
    expect(formatRemaining(61_000)).toBe("~2m left");
    expect(formatRemaining(3_900_000)).toBe("~1h 5m left");
    expect(formatRemaining(7_200_000)).toBe("~2h left");
  });

  it("derives expected durations from model timing", () => {
    // 10s base + 1 extra item × 5s + 1.048576 MP × 1s.
    expect(expectedDurationFor(imageModel, { count: 2, resolution: "1024x1024" })).toBe(16_049);
    expect(expectedDurationFor(videoModel, { duration: 6 })).toBe(90_000);
    expect(expectedDurationFor(textModel, {})).toBeUndefined();
  });
});

describe("generation controls", () => {
  it("derives controls from capabilities", () => {
    const controls = getGenerationControls(imageModel);
    expect(controls.map((c) => [c.key, c.kind])).toEqual([
      ["mode", "select"],
      ["negativePrompt", "textarea"],
      ["aspectRatio", "select"],
      ["resolution", "select"],
      ["quality", "select"],
      ["count", "select"],
      ["seed", "number"],
      ["params.guidance", "range"],
      ["params.steps", "range"],
      ["params.sampler", "select"],
      ["params.tile", "checkbox"],
    ]);
    expect(controls.find((c) => c.key === "count")!.options!.map((o) => o.value)).toEqual([1, 2, 4]);
    expect(getGenerationControls(videoModel).map((c) => [c.key, c.kind, c.valueType])).toEqual([["duration", "select", "number"]]);
    const ranged = getGenerationControls({ id: "r", media: "video", duration: { min: 2, max: 10, step: 1 }, count: { max: 3 } });
    expect(ranged.map((c) => [c.key, c.kind, c.min, c.max])).toEqual([
      ["count", "range", 1, 3],
      ["duration", "range", 2, 10],
    ]);
  });

  it("reads and writes request values immutably", () => {
    const request: GenerationRequest = { aspectRatio: "1:1", params: { guidance: 3 } };
    expect(getRequestValue(request, "params.guidance")).toBe(3);
    const next = setRequestValue(setRequestValue(request, "params.guidance", undefined), "aspectRatio", "");
    expect(next).toEqual({});
    expect(request).toEqual({ aspectRatio: "1:1", params: { guidance: 3 } });
    const count = getGenerationControls(imageModel).find((c) => c.key === "count")!;
    expect(parseControlValue(count, "2")).toBe(2);
    expect(parseControlValue(count, "")).toBeUndefined();
  });

  it("builds reference slots and adds/removes references", () => {
    let request: GenerationRequest = addReference({}, { id: "a", role: "style_ref" });
    request = addReference(request, { id: "b", role: "style_ref" });
    const slots = getReferenceSlots(imageModel, request);
    expect(slots.map((s) => [s.role, s.references.length, s.max, s.canAdd])).toEqual([
      ["style_ref", 2, 2, false],
      ["character_ref", 0, 1, false],
      ["mask", 0, 1, false],
    ]);
    request = removeReference(request, "style_ref", "a");
    expect(request.references).toEqual([{ id: "b", role: "style_ref" }]);
    expect(removeReference(request, "style_ref", "b")).toEqual({});
    expect(getReferenceSlots(textModel)).toEqual([]);
  });
});
