import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getVectorTextShaper, setVectorTextShaper } from "../src/vector/index.js";
import { createMetricTextShaper } from "../src/text/index.js";
import { conformanceResult, conformanceValuesMatch } from "../src/tools/conformance.js";
import { createVectorConformanceHost } from "../src/vector/contract.js";
import { createFakeEffectProvider } from "../src/effects";
import {
  createProvenance,
  parseProvenance,
  planGenerationRequest,
  stableStringify,
  type GenerationRequest,
  type ModelCapabilities,
  type PlanOptions,
} from "../src/generation/index.js";

/**
 * Test vectors the Swift vector agent tools (`packages/swift`, `PixerateVector`, #624) check
 * themselves against: replays of the effect tools (`vector/effect-tools.ts` on the fake effect
 * provider) and the generation tools (`vector/generate.ts` on the fake generator: seeds,
 * idempotency keys, regeneration of moved and rotated art, provenance through SVG export and
 * import), with their failures, the document, render data and SVG export after each replay; and
 * the generation core the Swift ports into `PixerateCore` (`generation/plan.ts` on a range of
 * capabilities and strategies, `createProvenance`'s prompt source map, `parseProvenance`,
 * `stableStringify`). Computed here from the TS core (the spec); a drift from the committed file
 * fails this test (run with UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change, then
 * rerun the Swift tests).
 *
 * Effect ids the catalog does not offer are left out of `apply_effect`: once the TS provider has
 * fetched its catalog it lists the offered ids in the argument's schema (an `invalid_arguments`
 * refusal), while the Swift tools use the contract's schema and refuse in the handler.
 *
 * ISO timestamps the replays make (`createdAt`), anywhere in a result string, read `<time>`; the
 * inputs' fixed times stay. Key order is not compared.
 *
 * Shape: `{ version, replays: [{ name, setup, steps: [{ tool, arguments, isError, result }],
 * document, render, svg }], plans: [{ caps, request, options, out }], provenance: [{ input, out }],
 * parse: [{ input, out | error }], stable: [{ input, out }] }`.
 */
const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateVectorTests/Fixtures/vector-tools-vectors.json",
);

const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const untimed = (v: unknown): unknown =>
  typeof v === "string"
    ? v.replace(TIME, "<time>")
    : Array.isArray(v)
      ? v.map(untimed)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, untimed(x)]))
        : v;

type Step = [string, Record<string, unknown>?];

/** A generated group's provenance at a fixed time, for an SVG that is imported. */
const PROVENANCE = createProvenance({
  rawPrompt: "a {{tiny}} moon",
  model: { id: "fake-svg", name: "Fake SVG", media: "text", seed: true },
  request: { prompt: "a {{tiny}} moon", mode: "generate", seed: 4, model: "fake-svg" },
  createdAt: "2026-01-02T03:04:05.006Z",
  meta: { as: "color", colors: 8, box: { x: 0, y: 0, width: 40, height: 40 } },
});
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const IMPORTED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><g id="moon" data-vector-generation="${attr(JSON.stringify(PROVENANCE))}"><circle cx="20" cy="20" r="12" fill="#2563eb"/></g><g id="junk" data-vector-generation="{&quot;format&quot;:&quot;nope&quot;}"><rect x="50" y="50" width="10" height="10" fill="#111111"/></g></svg>`;

const REPLAYS: { name: string; setup: { width: number; height: number }; steps: Step[] }[] = [
  {
    name: "effects",
    setup: { width: 320, height: 240 },
    steps: [
      ["run_command", { id: "vector.addShape", params: { kind: "rect", x: 10, y: 10, width: 60, height: 40, fill: "#2563eb" } }],
      ["search_effects", { query: "badge" }],
      ["search_effects", { tags: ["Sticker"], kind: "vector" }],
      ["search_effects", { tags: ["stick", "nope"] }],
      ["search_effects", { accepts: ["path"], limit: 1 }],
      ["describe_effect", { effect: "fake.route" }],
      ["describe_effect", { effect: "fake.bar" }],
      ["describe_effect", { effect: "fake.nope" }],
      ["list_applied_effects", {}],
      ["apply_effect", { target: "document", effect: "fake.badge", values: { color: "#123456" } }],
      ["apply_effect", { target: "document", effect: "fake.badge", index: 1 }],
      ["apply_effect", { target: "document", effect: "fake.badge", enabled: false }],
      ["apply_effect", { target: "n1", effect: "fake.badge" }],
      ["apply_effect", { target: "nope", effect: "fake.badge" }],
      ["apply_effect", { target: "document", effect: "fake.bar" }],
      ["apply_effect", { target: "document", effect: "fake.badge", values: { color: "red" } }],
      ["apply_effect", { target: "document", effect: "fake.route", values: { path: "M0 0 L50 20 L100 0", color: "#0f766e" } }],
      ["apply_effect", { target: "document", effect: "fake.route", values: { path: [5, 5, 30.12345, 40, 80, 12.5] } }],
      ["apply_effect", { target: "n3", effect: "fake.badge", values: { ms: 250 } }],
      ["list_applied_effects", {}],
      ["list_applied_effects", { target: "n1" }],
      ["list_applied_effects", { target: "n3" }],
      ["update_effect", { target: "n3", effect: "picture", values: { color: "#16a34a", ms: 900 } }],
      ["update_effect", { target: "n3", effect: "picture", values: { ms: null } }],
      ["update_effect", { target: "n3", effect: "picture", values: { nope: null } }],
      ["update_effect", { target: "n3", effect: "picture", values: { ms: -5 } }],
      ["update_effect", { target: "n3", effect: "other", values: { ms: 5 } }],
      ["update_effect", { target: "n3", effect: "picture", opacity: 0.5 }],
      ["update_effect", { target: "n3", effect: "picture" }],
      ["update_effect", { target: "n1", effect: "picture", values: { ms: 5 } }],
      ["run_command", { id: "vector.transform", params: { ids: ["n3"], dx: 15, dy: -10, rotate: 30 } }],
      ["update_effect", { target: "n3", effect: "picture", values: { color: "#7c3aed" } }],
      ["remove_effect", { target: "n3", effect: "picture" }],
      ["remove_effect", { target: "n3", effect: "picture" }],
      ["list_applied_effects", {}],
      ["run_command", { id: "vector.list" }],
    ],
  },
  {
    name: "generation",
    setup: { width: 300, height: 200 },
    steps: [
      ["list_vector_art_models", {}],
      ["generate_vector_art", { prompt: "a red planet", idempotencyKey: "k1", seed: 3 }],
      ["generate_vector_art", { prompt: "a red planet", idempotencyKey: "k1", seed: 3 }],
      ["generate_vector_art", { prompt: "a red planet", idempotencyKey: "k1", seed: 4 }],
      ["generate_vector_art", { prompt: "   ", idempotencyKey: "k2" }],
      ["generate_vector_art", { prompt: "   ", idempotencyKey: "k2" }],
      ["generate_vector_art", { prompt: "x", model: "nope", idempotencyKey: "k3" }],
      ["generate_vector_art", { prompt: "x", as: "nope", idempotencyKey: "k4" }],
      ["generate_vector_art", { prompt: "x", width: 0, idempotencyKey: "k5" }],
      ["generate_vector_art", { prompt: "a tall comet, two colours", negativePrompt: "stars", seed: 2, x: 10, y: 20, width: 50, height: 80, name: "Comet", model: "fake-svg", idempotencyKey: "k6" }],
      ["generate_vector_art", { prompt: "a very long prompt that goes on past forty characters, and on", width: 30, idempotencyKey: "k7", seed: 1 }],
      ["run_command", { id: "vector.transform", params: { ids: ["generated"], dx: 20, dy: 10, rotate: 45 } }],
      ["regenerate_vector_art", { id: "generated", prompt: "a much bigger planet", seed: 5, idempotencyKey: "r1" }],
      ["regenerate_vector_art", { id: "generated", prompt: "a much bigger planet", seed: 5, idempotencyKey: "r1" }],
      ["regenerate_vector_art", { id: "generated", seed: 6, idempotencyKey: "r2" }],
      ["regenerate_vector_art", { id: "n2", seed: 6, idempotencyKey: "r3" }],
      ["regenerate_vector_art", { id: "nope", seed: 6, idempotencyKey: "r4" }],
      ["run_command", { id: "vector.importSvg", params: { svg: IMPORTED_SVG } }],
      ["run_command", { id: "vector.list" }],
    ],
  },
];

async function replay(r: (typeof REPLAYS)[number]) {
  const host = createVectorConformanceHost(r.setup, { effects: createFakeEffectProvider() });
  const steps = [];
  for (const [tool, args] of r.steps) {
    const { value, isError } = conformanceResult(await host.callTool(tool, args ?? {}));
    steps.push({ tool, arguments: args ?? {}, isError, result: untimed(json(value)) });
  }
  const svg = conformanceResult(await host.callTool("run_command", { id: "vector.exportSvg" })).value;
  const out = { name: r.name, setup: r.setup, steps, document: untimed(json(host.document())), render: json(host.render?.()), svg: untimed(json(svg)) };
  host.dispose?.();
  return out;
}

const RATIOS = { options: ["1:1", "16:9", "9:16", "4:3"], default: "1:1" };
const IMAGE: ModelCapabilities = {
  id: "img",
  name: "Image",
  media: "image",
  prompt: { maxLength: 12 },
  negativePrompt: { maxLength: 5 },
  aspectRatios: RATIOS,
  resolutions: { options: ["512x512", "1024x1024", "2048x2048"] },
  quality: { options: ["draft", "standard", "high"], default: "standard" },
  count: { max: 4, options: [1, 2, 4], default: 1 },
  seed: { min: 0, max: 1000 },
  references: {
    roles: { style_ref: { max: 2, accepts: ["image"] }, character_ref: { max: 1, min: 1 }, subject: { max: 1, label: "Subject" } },
    maxTotal: 3,
  },
  inpainting: true,
  params: {
    guidance: { type: "number", min: 1, max: 20, step: 0.5, default: 7 },
    steps: { type: "integer", min: 1, max: 50 },
    style: { type: "enum", options: ["vivid", "natural"], default: "vivid" },
    shift: { type: "enum", options: [1, 2, 4] },
    hdr: { type: "boolean", default: false },
  },
};
const VIDEO: ModelCapabilities = {
  id: "vid",
  media: "video",
  prompt: { maxLength: 40, required: true, countResolved: false },
  systemPrompt: true,
  resolutions: { options: ["480p", "720p", "1080p", "2k"] },
  duration: { min: 2, max: 10, step: 2, default: 4 },
  references: { roles: { start_frame: { max: 1 }, end_frame: { max: 1 } } },
  editing: true,
};
const TEXT: ModelCapabilities = { id: "txt", media: "text", seed: true };

const PLANS: { caps: ModelCapabilities; request: GenerationRequest & Record<string, unknown>; options?: PlanOptions }[] = [
  { caps: IMAGE, request: { prompt: "a cat", aspectRatio: "3:2", resolution: "900x900", quality: "ultra", count: 3, seed: 1200.5 } },
  { caps: IMAGE, request: { prompt: "a cat", aspectRatio: "3:2", count: 3, seed: 2.5 }, options: { strategy: "downgrade" } },
  { caps: IMAGE, request: { prompt: "a cat on a mat with a hat", negativePrompt: "dogs and birds", aspectRatio: "weird", quality: "nope" } },
  { caps: IMAGE, request: { prompt: "😀😀😀😀😀😀😀" } },
  { caps: IMAGE, request: { prompt: "short" }, options: { resolvedPrompt: "a resolved prompt that is long" } },
  { caps: IMAGE, request: { prompt: "a cat", aspectRatio: "3:2", seed: 1200, count: 3, quality: "ultra" }, options: { strategy: "error" } },
  { caps: IMAGE, request: { prompt: "x", seed: "7" as unknown as number, count: "two" as unknown as number } },
  { caps: IMAGE, request: {}, options: { fillDefaults: true } },
  {
    caps: IMAGE,
    request: {
      prompt: "refs",
      mode: "inpaint",
      references: [
        { id: "a", role: "style" },
        { id: "b", role: "style_ref", mediaType: "video/mp4" },
        { id: "a", role: "style_ref" },
        { id: "c", role: "style_ref", mediaType: "image/png" },
        { id: "d", role: "video_ref" },
        { id: "e", role: "video_ref" },
        { id: "f", role: "Subject" },
        { id: "", role: "style_ref" },
        { id: "g", role: "bad role!" },
        { id: "h", role: "subject" },
        { id: "i", role: "subject" },
      ],
    },
  },
  { caps: IMAGE, request: { prompt: "refs", references: [{ id: "d", role: "video_ref" }, { id: "x", role: "style_ref", mediaType: "audio" }] }, options: { strategy: "upgrade" } },
  { caps: IMAGE, request: { prompt: "refs", references: [{ id: "a", role: "style" }, { id: "d", role: "video_ref" }] }, options: { strategy: "error" } },
  {
    caps: IMAGE,
    request: { prompt: "mentions", references: [{ id: "c1", role: "character_ref" }] },
    options: { mentions: [{ id: "m1", mediaType: "image/png", label: "@fox" }, { id: "m2", role: "style_ref", url: "u", contentHash: "h" }, { id: "" }], defaultMentionRole: undefined },
  },
  { caps: IMAGE, request: { prompt: "mentions" }, options: { mentions: [{ id: "m1" }], defaultMentionRole: "subject" } },
  { caps: IMAGE, request: { prompt: "p", params: { guidance: 7.3, steps: 2.5, style: "flat", shift: 3, hdr: "yes" as unknown as boolean, unknown: 1 } } },
  { caps: IMAGE, request: { prompt: "p", params: { guidance: 25, steps: 0, style: "natural", shift: 2, hdr: true } }, options: { fillDefaults: true } },
  { caps: IMAGE, request: { prompt: "p", params: { guidance: 7.3, style: "flat", unknown: 1 } }, options: { strategy: "error" } },
  { caps: IMAGE, request: { prompt: "p", model: "other", extra: 1 } as GenerationRequest },
  { caps: IMAGE, request: { prompt: "p", extra: 1 } as GenerationRequest, options: { strategy: "error" } },
  { caps: VIDEO, request: { prompt: "  ", resolution: "1440p", duration: 7, systemPrompt: "be nice", mode: "edit", count: 1 } },
  { caps: VIDEO, request: { resolution: "4k", duration: 13, mode: "inpaint", count: 2, seed: 4 } },
  { caps: VIDEO, request: { prompt: "a long prompt that the video model will not take as it is", resolution: "720P" }, options: { resolvedPrompt: "different" } },
  { caps: VIDEO, request: { duration: 5 }, options: { strategy: "downgrade" } },
  { caps: VIDEO, request: {}, options: { fillDefaults: true } },
  { caps: TEXT, request: { prompt: "svg", aspectRatio: "1:1", negativePrompt: "no", seed: 3.5, references: [{ id: "a", role: "image_ref" }] } },
  { caps: TEXT, request: { prompt: "svg", references: [] } },
];

const PROMPTS = ["a small sun", "", "{{style}} of a {cat} and {{ b }}{{c}}", "{{}} {{ x", "emoji 😀 {{t}} end", "__note__ {?a}x{/a}"];

const PARSE: unknown[] = [
  JSON.stringify(PROVENANCE),
  PROVENANCE,
  "not json",
  { format: "nope" },
  { ...PROVENANCE, version: 2 },
  { ...PROVENANCE, version: "1" },
  { ...PROVENANCE, rawPrompt: 3 },
  { ...PROVENANCE, templates: [{ name: "a" }] },
  { ...PROVENANCE, references: {} },
  { ...PROVENANCE, bindings: [1], values: "x" },
  { ...PROVENANCE, bindings: undefined, values: { a: "b" } },
];

const STABLE: unknown[] = [{ b: 1, a: [3, { d: null, c: "x" }], é: true, B: 2 }, [1, "two", null], "text", 4.5, { "10": 1, "9": 2, a: { z: 0, y: [] } }];

async function vectors() {
  const shaper = getVectorTextShaper();
  setVectorTextShaper(createMetricTextShaper());
  try {
    const replays = [];
    for (const r of REPLAYS) replays.push(await replay(r));
    return {
      version: 1,
      replays,
      plans: PLANS.map((p) => ({ caps: p.caps, request: p.request, options: p.options ?? {}, out: planGenerationRequest(p.request, p.caps, p.options) })),
      provenance: PROMPTS.map((rawPrompt) => ({
        input: { rawPrompt, model: "txt", request: { prompt: rawPrompt, seed: 1 }, meta: { as: "color" } },
        out: createProvenance({ rawPrompt, model: TEXT, request: { prompt: rawPrompt, seed: 1 }, createdAt: 0, meta: { as: "color" }, outputIds: ["o1"], startedAt: 0, completedAt: 0 }),
      })),
      parse: PARSE.map((input) => {
        try {
          return { input, out: parseProvenance(input) };
        } catch (e) {
          return { input, error: (e as Error).message };
        }
      }),
      stable: STABLE.map((input) => ({ input, out: stableStringify(input) })),
    };
  } finally {
    setVectorTextShaper(shaper);
  }
}

describe("Swift vector agent tool test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    // Times the runs make are untimed in `replay`; the inputs' fixed times stay.
    const now = json(await vectors());
    if (process.env.UPDATE_SWIFT_VECTORS) writeFileSync(FILE, JSON.stringify(now) + "\n");
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
