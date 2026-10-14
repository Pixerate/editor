import { describe, it, expect, vi } from "vitest";
import {
  blockingDrift,
  capabilitiesToJsonSchema,
  completeGenerationRecord,
  createGenerationRecord,
  createGenerationRecordStore,
  createGenerationToolProvider,
  createProvenance,
  getAssetRoleOptions,
  getReferenceSlots,
  hashCapabilities,
  hashText,
  hashValue,
  isGenerationRecord,
  mediaTypeMatches,
  normalizeReferenceRole,
  parseGenerationRecord,
  planGenerationRequest,
  ProvenanceParseError,
  recreateRequest,
  referenceRoleLabel,
  resolveAssetMentions,
  serializeGenerationRecord,
  stableStringify,
  supportedReferenceRoles,
  validateAssetMentions,
  validateJsonSchema,
  variationRequest,
  describeAssetMentions,
  defaultAssetRoleOptions,
  findTextMentions,
  setMentionRoleInText,
  type AssetInfo,
  type DriftItem,
  type GenerationRecord,
  type ModelCapabilities,
} from "../src/generation";
import { createMemoryStorage, withStorageFailures } from "../src/persistence";
import { ToolRegistry } from "../src/agent/registry";
import type { Template } from "../src/grammar";

const model: ModelCapabilities = {
  id: "img-2",
  name: "Image Two",
  media: "image",
  prompt: { maxLength: 500 },
  aspectRatios: { options: ["1:1", "16:9"], default: "1:1" },
  resolutions: { options: ["1k", "2k"], default: "1k" },
  count: { max: 4 },
  seed: { min: 0, max: 99_999 },
  references: {
    roles: {
      style_ref: { max: 1, accepts: ["image"] },
      character_ref: { max: 2, accepts: ["image/png", "image/jpeg"] },
      subject: { max: 1, label: "Subject", accepts: ["image/*"] },
    },
    maxTotal: 4,
  },
  inpainting: true,
  params: { guidance: { type: "number", min: 1, max: 10, step: 0.5 } },
};

const templates: Template[] = [
  { id: "t-style", name: "style", versions: [{ id: "s1", version: "1", body: "oil painting, {{light}}" }], latestVersion: "1" },
  { id: "t-light", name: "light", body: "golden hour" },
];

const assets: AssetInfo[] = [
  { id: "fox", label: "Fox", mediaType: "image/png", contentHash: "c-fox-1" },
  { id: "monet", label: "Monet", mediaType: "image/jpeg", contentHash: "c-monet-1" },
];

function makeRecord(overrides: Partial<Parameters<typeof createGenerationRecord>[0]> = {}): GenerationRecord {
  return createGenerationRecord({
    rawPrompt: "A {animal} in {{style}}",
    templates,
    values: { animal: "fox" },
    model,
    request: { prompt: "A {animal} in {{style}}", resolution: "4k", aspectRatio: "16:9", seed: 42, params: { guidance: 7.3 } },
    mentions: [
      { id: "fox", role: "character", label: "Fox" },
      { id: "monet", role: "style_ref", label: "Monet" },
    ],
    assets,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "rec-1",
    ...overrides,
  });
}

const types = (drift: DriftItem[]) => drift.map((d) => d.type);

describe("hashing", () => {
  it("is deterministic, short and sensitive to every character", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).toMatch(/^h1-[0-9a-f]{16}$/);
    expect(hashText("abc")).not.toBe(hashText("abd"));
    expect(hashText("")).not.toBe(hashText(" "));
    expect(hashText("\u{1F600}")).not.toBe(hashText("\u{1F601}"));
    // Pinned values: changing the algorithm would orphan every stored hash.
    expect(hashText("")).toBe("h1-5db4a501cd465b98");
    expect(hashText("oil painting")).toBe("h1-95d63fe4050afa23");
  });

  it("has no collisions on a random corpus", () => {
    const seen = new Map<string, string>();
    let x = 7;
    for (let i = 0; i < 5000; i++) {
      x = (x * 48271) % 2147483647;
      const text = `${x.toString(36)}-${i}`;
      const hash = hashText(text);
      expect(seen.get(hash) ?? text).toBe(text);
      seen.set(hash, text);
    }
  });

  it("hashes values independently of key order", () => {
    expect(hashValue({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashValue({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(stableStringify({ b: undefined, a: 1 })).toBe('{"a":1}');
  });

  it("ignores presentation and timing in capability hashes", () => {
    const base = hashCapabilities(model);
    expect(hashCapabilities({ ...model, name: "Renamed", badges: ["new"], timing: { baseMs: 1 } })).toBe(base);
    expect(hashCapabilities({ ...model, resolutions: { options: ["1k"] } })).not.toBe(base);
  });
});

describe("createGenerationRecord", () => {
  it("captures everything needed to reproduce the output", () => {
    const record = makeRecord();
    expect(isGenerationRecord(record)).toBe(true);
    expect(record).toMatchObject({
      format: "pixerate.generation-record",
      version: 1,
      id: "rec-1",
      kind: "generate",
      strategy: "nearest",
      seed: 42,
      createdAt: "2026-01-01T00:00:00.000Z",
      capabilityHash: hashCapabilities(model),
      settings: { resolution: "4k", aspectRatio: "16:9", seed: 42, params: { guidance: 7.3 } },
    });
    const p = record.provenance;
    expect(p.rawPrompt).toBe("A {animal} in {{style}}");
    expect(p.resolvedPrompt).toBe("A fox in oil painting, golden hour");
    expect(p.values).toEqual({ animal: "fox" });
    expect(p.sourceMap.length).toBeGreaterThan(0);
    expect(p.modelId).toBe("img-2");
    // Planned settings: 4k snapped, guidance stepped, mention roles mapped.
    expect(p.request.resolution).toBe("2k");
    expect(p.request.params).toEqual({ guidance: 7.5 });
    expect(p.request.references).toEqual([
      { id: "fox", role: "character_ref" },
      { id: "monet", role: "style_ref" },
    ]);
    expect(p.adjustments.map((a) => a.field)).toEqual(
      expect.arrayContaining(["resolution", "params.guidance", "references.character"]),
    );
    expect(record.templates).toEqual([
      { name: "style", templateId: "t-style", versionId: "s1", version: "1", hash: hashText("oil painting, {{light}}") },
      { name: "light", templateId: "t-light", hash: hashText("golden hour") },
    ]);
    expect(record.promptHash).toBe(hashText(p.resolvedPrompt));
    expect(record.assets).toEqual([
      { id: "fox", role: "character_ref", contentHash: "c-fox-1", mediaType: "image/png" },
      { id: "monet", role: "style_ref", contentHash: "c-monet-1", mediaType: "image/jpeg" },
    ]);
    expect(record.mentions).toHaveLength(2);
  });

  it("reuses a given plan and records the provider's seed", () => {
    const plan = planGenerationRequest({ aspectRatio: "16:9" }, model, { strategy: "downgrade" });
    const record = createGenerationRecord({ rawPrompt: "cat", model, plan, seed: 7, parentId: "p" });
    expect(record.strategy).toBe("downgrade");
    expect(record.seed).toBe(7);
    expect(record.kind).toBe("recreate");
    expect(record.parentId).toBe("p");
    expect(record.provenance.request).toEqual({ ...plan.request, prompt: "cat" });
    expect(record.id).toMatch(/^gen_/);
    expect(createGenerationRecord({ rawPrompt: "cat", model }).id).not.toBe(record.id);
  });

  it("works with a bare model id (no capability hash, no planning)", () => {
    const record = createGenerationRecord({ rawPrompt: "cat", model: "remote-1", request: { aspectRatio: "3:2" } });
    expect(record.capabilityHash).toBeUndefined();
    expect(record.provenance.request).toEqual({ aspectRatio: "3:2", model: "remote-1", prompt: "cat" });
  });

  it("serializes, parses and completes", () => {
    const record = makeRecord();
    const parsed = parseGenerationRecord(serializeGenerationRecord(record));
    expect(parsed).toEqual(record);
    const done = completeGenerationRecord(parsed, { outputIds: ["o1"], completedAt: 0, seed: 9 });
    expect(done.provenance.outputIds).toEqual(["o1"]);
    expect(done.provenance.completedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(done.seed).toBe(9);
    expect(record.seed).toBe(42);
    expect(() => parseGenerationRecord("{")).toThrow(ProvenanceParseError);
    expect(() => parseGenerationRecord({ format: "nope" })).toThrow(/Not a generation record/);
    expect(() => parseGenerationRecord({ ...record, version: 99 })).toThrow(/version/);
    expect(() => parseGenerationRecord({ ...record, assets: [{ id: 1 }] })).toThrow(/assets/);
    expect(() => parseGenerationRecord({ ...record, provenance: {} })).toThrow(ProvenanceParseError);
  });
});

describe("recreateRequest", () => {
  it("keeps the original provenance API", () => {
    const provenance = createProvenance({ rawPrompt: "x", model, request: { aspectRatio: "1:1" } });
    expect(recreateRequest(provenance)).toEqual({ aspectRatio: "1:1", model: "img-2", prompt: "x" });
  });

  it("reproduces exactly with no drift when nothing changed", () => {
    const record = makeRecord();
    const result = recreateRequest(record, { templates, capabilities: [model], assets });
    expect(result.drift).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("exact");
    expect(result.resolvedPrompt).toBe(record.provenance.resolvedPrompt);
    expect(result.request).toEqual({
      ...record.provenance.request,
      references: [
        { id: "fox", role: "character_ref", contentHash: "c-fox-1", mediaType: "image/png" },
        { id: "monet", role: "style_ref", contentHash: "c-monet-1", mediaType: "image/jpeg" },
      ],
    });
    expect(result.plan?.adjustments).toEqual([]);
    expect(result.parentId).toBe("rec-1");
    // Without any context it still rebuilds the request.
    const bare = recreateRequest(record);
    expect(bare.request).toEqual(record.provenance.request);
    expect(bare.drift).toEqual([]);
  });

  it("latest without changes plans the original settings to the same request", () => {
    const record = makeRecord();
    const result = recreateRequest(record, { templates, capabilities: model, mode: "latest", assets });
    expect(result.drift).toEqual([]);
    expect(result.request.resolution).toBe("2k");
    expect(result.request.references?.map((r) => `${r.role}:${r.id}`)).toEqual(["character_ref:fox", "style_ref:monet"]);
  });

  it("reports template edits; only latest applies them", () => {
    const record = makeRecord();
    const edited: Template[] = [
      { ...templates[0], versions: [...templates[0].versions!, { id: "s2", version: "2", body: "watercolor, {{light}}" }], latestVersion: "2" },
      templates[1],
    ];
    const exact = recreateRequest(record, { templates: edited, capabilities: model, mode: "exact" });
    expect(types(exact.drift)).toEqual(["template-changed"]);
    expect(exact.drift[0]).toMatchObject({ template: "style", applied: false, severity: "warning", from: { version: "1" }, to: { version: "2" } });
    expect(exact.resolvedPrompt).toBe("A fox in oil painting, golden hour");
    expect(exact.ok).toBe(true);

    const latest = recreateRequest(record, { templates: edited, capabilities: model, mode: "latest" });
    expect(types(latest.drift)).toEqual(["template-changed", "prompt-changed"]);
    expect(latest.drift[0].applied).toBe(true);
    expect(latest.resolvedPrompt).toBe("A fox in watercolor, golden hour");
    expect(latest.request.prompt).toBe("A {animal} in {{style}}");
    expect(latest.plan?.ok).toBe(true);
  });

  it("detects edits of nested and unversioned templates", () => {
    const record = makeRecord();
    const edited = [templates[0], { ...templates[1], body: "blue hour" }];
    const latest = recreateRequest(record, { templates: edited, mode: "latest" });
    expect(latest.drift.find((d) => d.type === "template-changed")?.template).toBe("light");
    expect(latest.resolvedPrompt).toBe("A fox in oil painting, blue hour");
  });

  it("falls back to the recorded body for deleted templates", () => {
    const record = makeRecord();
    for (const mode of ["exact", "latest"] as const) {
      const result = recreateRequest(record, { templates: [templates[0]], mode });
      expect(types(result.drift)).toEqual(["template-missing"]);
      expect(result.resolvedPrompt).toBe("A fox in oil painting, golden hour");
    }
  });

  it("reports a missing model as blocking", () => {
    const record = makeRecord();
    const result = recreateRequest(record, { capabilities: [{ ...model, id: "other" }] });
    expect(types(result.drift)).toEqual(["model-missing"]);
    expect(result.ok).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(blockingDrift(result.drift)).toHaveLength(1);
  });

  it("reports changed capabilities and settings that are no longer supported", () => {
    const record = makeRecord();
    const changed: ModelCapabilities = { ...model, resolutions: { options: ["1k"] }, params: {} };
    const exact = recreateRequest(record, { capabilities: changed });
    expect(types(exact.drift)).toEqual(["model-changed", "setting-unsupported", "setting-unsupported"]);
    expect(exact.drift[1]).toMatchObject({ field: "resolution", from: "2k", to: "1k", severity: "warning" });
    expect(exact.drift[2]).toMatchObject({ field: "params.guidance", from: 7.5, to: undefined });
    expect(exact.ok).toBe(true);

    // Under `error` the same changes block.
    const strict = recreateRequest(record, { capabilities: changed, strategy: "error" });
    expect(strict.ok).toBe(false);
    expect(strict.drift.filter((d) => d.severity === "error").map((d) => d.field)).toEqual(["resolution", "params.guidance"]);
  });

  it("latest re-plans the original settings and reports what now differs", () => {
    const record = makeRecord();
    const upgraded: ModelCapabilities = { ...model, resolutions: { options: ["1k", "2k", "4k"] } };
    const latest = recreateRequest(record, { capabilities: upgraded, mode: "latest" });
    expect(types(latest.drift)).toEqual(["model-changed", "setting-changed"]);
    expect(latest.drift[1]).toMatchObject({ field: "resolution", from: "2k", to: "4k", severity: "info" });
    expect(latest.request.resolution).toBe("4k");
    // Exact keeps the recorded 2k, which is still supported.
    expect(types(recreateRequest(record, { capabilities: upgraded }).drift)).toEqual(["model-changed"]);
  });

  it("reports dropped seeds and references as unsupported settings", () => {
    const record = makeRecord();
    const noSeed: ModelCapabilities = { ...model, seed: undefined, references: { roles: { style_ref: { max: 1 } } } };
    const result = recreateRequest(record, { capabilities: noSeed });
    const fields = result.drift.filter((d) => d.type === "setting-unsupported").map((d) => d.field);
    expect(fields).toEqual(["seed", "references"]);
    expect(result.request.seed).toBeUndefined();
    expect(result.request.references).toEqual([{ id: "monet", role: "style_ref" }]);
  });

  it("reports missing and changed assets", () => {
    const record = makeRecord();
    const current: AssetInfo[] = [{ ...assets[0], contentHash: "c-fox-2" }];
    const result = recreateRequest(record, { capabilities: model, assets: current });
    expect(types(result.drift)).toEqual(["asset-changed", "asset-missing"]);
    expect(result.drift[0]).toMatchObject({ assetId: "fox", role: "character_ref", from: "c-fox-1", to: "c-fox-2" });
    expect(result.drift[1]).toMatchObject({ assetId: "monet", role: "style_ref", severity: "error" });
    expect(result.ok).toBe(false);
    expect(result.request.references).toEqual([
      { id: "fox", role: "character_ref", contentHash: "c-fox-2", mediaType: "image/png" },
    ]);
    // A lookup function and a map work too.
    expect(types(recreateRequest(record, { assets: (id) => (id === "fox" ? assets[0] : null) }).drift)).toEqual(["asset-missing"]);
    expect(recreateRequest(record, { assets: new Map(assets.map((a) => [a.id, a])) }).drift).toEqual([]);
  });

  it("gives options to record the recreated generation as a child", () => {
    const record = makeRecord();
    const result = recreateRequest(record, { capabilities: model, templates });
    const child = createGenerationRecord({ ...result.recordOptions, createdAt: 5 });
    expect(child.parentId).toBe("rec-1");
    expect(child.kind).toBe("recreate");
    expect(child.provenance.resolvedPrompt).toBe(record.provenance.resolvedPrompt);
    expect(child.templates.map((t) => t.hash)).toEqual(record.templates.map((t) => t.hash));
    expect(child.provenance.request).toEqual(result.request);
  });
});

describe("variationRequest", () => {
  it("changes the seed within the model's range and keeps everything else", () => {
    const record = makeRecord();
    const random = vi.fn(() => 0.5);
    const result = variationRequest(record, { random }, { capabilities: model });
    expect(result.kind).toBe("variation");
    expect(result.parentId).toBe("rec-1");
    expect(result.request.seed).toBe(50_000);
    expect({ ...result.request, seed: 42 }).toEqual(record.provenance.request);
    expect(result.drift).toEqual([]);
    expect(createGenerationRecord(result.recordOptions).kind).toBe("variation");
  });

  it("never repeats the recorded seed", () => {
    const record = makeRecord({ seed: 0 });
    const result = variationRequest(record, { random: () => 0 }, { capabilities: model });
    expect(result.request.seed).not.toBe(0);
    expect(result.request.seed).toBeGreaterThanOrEqual(0);
    expect(result.request.seed).toBeLessThanOrEqual(99_999);
  });

  it("applies overrides for seed, values, settings and prompt", () => {
    const record = makeRecord();
    const result = variationRequest(
      record,
      { seed: 5, values: { animal: "owl" }, settings: { aspectRatio: "1:1", params: { guidance: 2 } } },
      { capabilities: model },
    );
    expect(result.request).toMatchObject({ seed: 5, aspectRatio: "1:1", params: { guidance: 2 } });
    expect(result.resolvedPrompt).toBe("A owl in oil painting, golden hour");
    expect(result.values).toEqual({ animal: "owl" });
    expect(variationRequest(record, { seed: null }).request.seed).toBeUndefined();
    expect(variationRequest(record, { rawPrompt: "just {animal}", seed: 1 }).resolvedPrompt).toBe("just fox");
  });

  it("omits the seed for models without one and still reports drift", () => {
    const record = makeRecord();
    const result = variationRequest(record, {}, { capabilities: { ...model, seed: undefined }, templates: [] });
    expect(result.request.seed).toBeUndefined();
    expect(types(result.drift)).toEqual(["template-missing", "template-missing", "model-changed"]);
  });
});

describe("asset roles and capabilities", () => {
  it("lists built-in then custom roles and labels them", () => {
    expect(supportedReferenceRoles(model)).toEqual(["style_ref", "character_ref", "subject"]);
    expect(getAssetRoleOptions(model).map((o) => [o.role, o.label, o.max, o.accepts])).toEqual([
      ["style_ref", "Style reference", 1, ["image"]],
      ["character_ref", "Character reference", 2, ["image/png", "image/jpeg"]],
      ["subject", "Subject", 1, ["image/*"]],
      ["mask", "Mask", 1, undefined],
    ]);
    expect(referenceRoleLabel("hero_pose")).toBe("Hero pose");
    expect(getReferenceSlots(model).map((s) => s.label)).toEqual(["Style reference", "Character reference", "Subject", "Mask"]);
  });

  it("normalizes aliases unless the model declares the name", () => {
    expect(normalizeReferenceRole("style")).toBe("style_ref");
    expect(normalizeReferenceRole("Start-Frame")).toBe("start_frame");
    expect(normalizeReferenceRole("reference")).toBe("image_ref");
    expect(normalizeReferenceRole("subject", model)).toBe("subject");
    expect(normalizeReferenceRole("style", { ...model, references: { roles: { style: { max: 1 } } } })).toBe("style");
    expect(normalizeReferenceRole("pose")).toBe("pose");
  });

  it("matches media types against kinds, wildcards and MIME types", () => {
    expect(mediaTypeMatches("image/png", undefined)).toBe(true);
    expect(mediaTypeMatches("image/png", ["image"])).toBe(true);
    expect(mediaTypeMatches("IMAGE/PNG; q=1", ["image/*"])).toBe(true);
    expect(mediaTypeMatches("image/png", ["image/jpeg"])).toBe(false);
    expect(mediaTypeMatches("video/mp4", ["image"])).toBe(false);
    expect(mediaTypeMatches(undefined, ["image"])).toBe(false);
    expect(mediaTypeMatches("image", ["image/*"])).toBe(true);
  });

  it("plans mentions per role: snaps aliases, drops wrong media, truncates, infers roles", () => {
    const plan = planGenerationRequest({ prompt: "x" }, model, {
      mentions: [
        { id: "a", role: "style", mediaType: "image/png" },
        { id: "b", role: "character", mediaType: "image/webp" },
        { id: "c", role: "subject", mediaType: "image/webp" },
        { id: "d", role: "subject" },
        { id: "e", mediaType: "image/jpeg", label: "Eve" },
        { id: "f", role: "pose" },
      ],
    });
    expect(plan.ok).toBe(true);
    expect(plan.request.references).toEqual([
      { id: "a", role: "style_ref", mediaType: "image/png" },
      { id: "c", role: "subject", mediaType: "image/webp" },
    ]);
    expect(plan.adjustments.map((a) => [a.field, a.kind])).toEqual([
      ["references.style_ref", "defaulted"],
      ["references.style", "snapped"],
      ["references.character", "snapped"],
      ["references.character_ref", "dropped"],
      ["references.pose", "dropped"],
      ["references.style_ref", "truncated"],
      ["references.subject", "truncated"],
    ]);
    expect(plan.adjustments[0].reason).toContain("@Eve has no role");
  });

  it("rejects instead of fixing under error and upgrade", () => {
    const mentions = [{ id: "b", role: "character", mediaType: "video/mp4" }];
    const strict = planGenerationRequest({}, model, { strategy: "error", mentions });
    expect(strict.ok).toBe(false);
    expect(strict.errors.map((e) => e.field)).toEqual(["references.character"]);
    const upgrade = planGenerationRequest({}, model, { strategy: "upgrade", mentions });
    expect(upgrade.errors.map((e) => e.message)).toEqual([expect.stringContaining("accepts")]);
    expect(planGenerationRequest({ references: [{ id: "x", role: "not a role" }] }, model).errors).toHaveLength(1);
  });

  it("enforces required custom roles and default mention roles", () => {
    const video: ModelCapabilities = { id: "v", media: "video", references: { roles: { "start-frame": { max: 1, min: 1 } } } };
    expect(planGenerationRequest({}, video).errors.map((e) => e.field)).toEqual(["references.start-frame"]);
    const ok = planGenerationRequest({}, video, { mentions: [{ id: "f" }], defaultMentionRole: "start-frame" });
    expect(ok.ok).toBe(true);
    expect(ok.request.references).toEqual([{ id: "f", role: "start-frame" }]);
  });

  it("validates mentions for UI feedback", () => {
    const result = validateAssetMentions(
      [
        { id: "fox", role: "character" },
        { id: "monet", role: "style_ref" },
        { id: "clip", role: "subject", mediaType: "video/mp4" },
        { id: "x", role: "pose" },
        { id: "y" },
        { id: "z", role: "style_ref" },
      ],
      model,
      { assets },
    );
    expect(result.issues.map((i) => [i.id, i.code])).toEqual([
      ["fox", "renamed-role"],
      ["clip", "media-mismatch"],
      ["x", "unsupported-role"],
      ["y", "missing-role"],
      ["z", "too-many"],
    ]);
    expect(result.issues[0].suggestion).toBe("character_ref");
    expect(result.counts).toEqual({ character_ref: 1, style_ref: 2 });
    expect(result.ok).toBe(false);
    const video: ModelCapabilities = { id: "v", media: "video", references: { roles: { start_frame: { max: 1, min: 1 } } } };
    expect(validateAssetMentions([], video).missing).toEqual([{ role: "start_frame", min: 1, count: 0 }]);
  });

  it("resolves mention handles to assets by id or label", () => {
    expect(
      resolveAssetMentions([{ handle: "fox", role: "style" }, { handle: "MONET" }, { handle: "jack" }], assets),
    ).toEqual([
      { id: "fox", label: "fox", role: "style", mediaType: "image/png", contentHash: "c-fox-1" },
      { id: "monet", label: "MONET", mediaType: "image/jpeg", contentHash: "c-monet-1" },
    ]);
  });

  it("puts role enums (built-in and custom) in agent schemas", async () => {
    const schema = capabilitiesToJsonSchema(model);
    const items = (schema.properties!.references as any).items;
    expect(items.properties.role.enum).toEqual(["style_ref", "character_ref", "subject", "mask"]);
    expect((schema.properties!.references as any).description).toContain("subject (Subject): up to 1, image/* only");
    expect(validateJsonSchema({ references: [{ id: "a", role: "subject", mediaType: "image/png" }] }, schema)).toEqual([]);
    expect(validateJsonSchema({ references: [{ id: "a", role: "pose" }] }, schema)).not.toEqual([]);

    const registry = new ToolRegistry();
    registry.register(createGenerationToolProvider({ models: [model], generate: () => ({ jobId: "j" }) }));
    const plan = registry.listTools().tools.find((t) => t.name === "plan_generation")!;
    const roleEnum = (plan.inputSchema.properties as any).request.properties.references.items.properties.role.enum;
    expect(roleEnum).toEqual(expect.arrayContaining(["start_frame", "style_ref", "subject"]));
    const result = await registry.callTool("plan_generation", {
      model: "img-2",
      request: { references: [{ id: "a", role: "subject", mediaType: "image/png" }] },
    });
    expect(result.isError).toBeFalsy();
  });
});

describe("createGenerationRecordStore", () => {
  const at = (i: number) => `2026-01-0${i}T00:00:00.000Z`;
  const records = () => [
    makeRecord({ id: "a", createdAt: at(1) }),
    makeRecord({ id: "b", createdAt: at(2), model: { ...model, id: "img-3" } }),
    makeRecord({ id: "c", createdAt: at(3), rawPrompt: "plain {{light}}", mentions: [{ id: "monet", role: "style_ref" }] }),
    makeRecord({ id: "d", createdAt: at(4), parentId: "a", kind: "variation" }),
  ];

  it("stores, lists newest first and filters by model, template, asset, role and lineage", async () => {
    const storage = createMemoryStorage();
    const store = createGenerationRecordStore({ storage });
    for (const record of records()) await store.put(record);
    const ids = async (filter?: Parameters<typeof store.list>[0]) => (await store.list(filter)).map((r) => r.id);
    expect(await ids()).toEqual(["d", "c", "b", "a"]);
    expect(await ids({ model: "img-3" })).toEqual(["b"]);
    expect(await ids({ model: ["img-3", "img-2"], limit: 2, offset: 1 })).toEqual(["c", "b"]);
    expect(await ids({ template: "style" })).toEqual(["d", "b", "a"]);
    expect(await ids({ template: "t-light" })).toEqual(["d", "c", "b", "a"]);
    expect(await ids({ asset: "fox" })).toEqual(["d", "b", "a"]);
    expect(await ids({ role: "character_ref" })).toEqual(["d", "b", "a"]);
    expect(await ids({ parentId: "a" })).toEqual(["d"]);
    expect(await ids({ kind: "variation" })).toEqual(["d"]);
    expect(await ids({ since: at(2), until: at(4) })).toEqual(["c", "b"]);
    expect(await ids({ text: "PLAIN" })).toEqual(["c"]);
    expect((await store.get("c"))?.provenance.resolvedPrompt).toBe("plain golden hour");
    expect(await store.get("zzz")).toBeNull();

    // A second store on the same storage sees the same records.
    const again = createGenerationRecordStore({ storage });
    expect((await again.summaries()).map((s) => s.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("replaces, removes, prunes and notifies", async () => {
    const storage = createMemoryStorage();
    const store = createGenerationRecordStore({ storage });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    await Promise.all(records().map((r) => store.put(r)));
    expect((await store.summaries()).length).toBe(4);
    await store.put(makeRecord({ id: "a", createdAt: at(5) }));
    expect((await store.summaries()).map((s) => s.id)).toEqual(["a", "d", "c", "b"]);
    expect(await store.remove("b")).toBe(true);
    expect(await store.remove("b")).toBe(false);
    expect(storage.entries.has("pixerate.generation-records:record:b")).toBe(false);

    expect(await store.prune({ maxRecords: 1, keep: (s) => s.id === "c" })).toEqual(["d"]);
    expect((await store.summaries()).map((s) => s.id)).toEqual(["a", "c"]);
    expect(await store.prune({ olderThan: at(4) })).toEqual(["c"]);
    expect(await store.prune({ olderThan: at(4) })).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4 + 1 + 1 + 1 + 1);
    off();
    await store.clear();
    expect(listener).toHaveBeenCalledTimes(8);
    expect([...storage.entries.keys()]).toEqual(["pixerate.generation-records:index"]);
  });

  it("prunes automatically with maxRecords", async () => {
    const store = createGenerationRecordStore({ storage: createMemoryStorage(), maxRecords: 2, namespace: "ns" });
    for (const record of records()) await store.put(record);
    expect((await store.summaries()).map((s) => s.id)).toEqual(["d", "c"]);
  });

  it("survives a corrupt index, unreadable records and failing writes", async () => {
    const storage = createMemoryStorage({ initial: { "pixerate.generation-records:index": "{not json" } });
    const store = createGenerationRecordStore({ storage });
    expect(await store.list()).toEqual([]);
    await store.put(makeRecord({ id: "a" }));
    storage.entries.set("pixerate.generation-records:record:a", "garbage");
    expect(await store.list()).toEqual([]);
    expect(await store.get("a")).toBeNull();

    let fail = true;
    const flaky = createGenerationRecordStore({ storage: withStorageFailures(createMemoryStorage(), (op) => fail && op === "set") });
    await expect(flaky.put(makeRecord({ id: "x" }))).rejects.toThrow();
    fail = false;
    await flaky.put(makeRecord({ id: "y" }));
    expect((await flaky.summaries()).map((s) => s.id)).toEqual(["y"]);
  });
});

describe("asset mention chips", () => {
  it("describes asset mentions in prompt text with role labels and issues", () => {
    const text = "A @fox:character with @Monet:pose and @jack, @fox";
    const chips = describeAssetMentions(findTextMentions(text), assets, model);
    expect(chips.map((c) => [c.handle, c.asset.id, c.role, c.roleLabel, c.issues.map((i) => i.code)])).toEqual([
      ["fox", "fox", "character", "Character reference", ["renamed-role"]],
      ["Monet", "monet", "pose", "Pose", ["unsupported-role"]],
      ["fox", "fox", undefined, undefined, ["missing-role"]],
    ]);
    expect(chips[1].start).toBe(text.indexOf("@Monet"));
    expect(setMentionRoleInText(text, chips[1].start!, "style_ref")).toBe("A @fox:character with @Monet:style_ref and @jack, @fox");
    expect(describeAssetMentions(findTextMentions(text), assets).every((c) => c.issues.length === 0)).toBe(true);
    expect(defaultAssetRoleOptions().map((o) => o.role)).toContain("start_frame");
  });
});
