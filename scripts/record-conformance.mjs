#!/usr/bin/env node
// Records the conformance scenarios of `@pixerate/conformance` from the built core: replays each
// scenario's tool calls (packages/conformance/domains/<domain>/fixtures/*.json) and writes what
// every step returned into its `expect` (with the document and render data the step asks for), with
// a PNG for each pixel snapshot. Run after
// `pnpm --filter @pixerate/editor build`, then commit what changed. A core test
// (`tests/paint-conformance.test.ts`) replays the scenarios and fails when the core no longer
// produces what is recorded.
//
// Each scenario is run twice on fresh editors; a step whose output differs between the runs is
// not deterministic (a random seed, a clock) and fails the recording.
//
// Usage: node scripts/record-conformance.mjs [domain…] [--check]
//   --check writes nothing and exits 1 when a recording is out of date.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");

async function core(entry) {
  const file = path.join(root, "packages/core/dist", entry);
  if (!fs.existsSync(file)) {
    console.error(`No ${path.relative(root, file)}: build the core first (pnpm --filter @pixerate/editor build).`);
    process.exit(1);
  }
  return import(pathToFileURL(file).href);
}
const { runConformanceScenario } = await core("tools/index.js");
const { encodePng } = await core("raster/index.js");
const { createPaintConformanceHost } = await core("paint-editor/index.js");
const { createVectorConformanceHost } = await core("vector/index.js");
const { createChartConformanceHost } = await core("chart/index.js");
const { createFakeEffectProvider } = await core("effects/index.js");

/** How each domain builds a fresh host for a scenario. */
const DOMAINS = {
  paint: (scenario) => createPaintConformanceHost(scenario.setup ?? {}, { effects: createFakeEffectProvider() }),
  vector: (scenario) => createVectorConformanceHost(scenario.setup ?? {}, { effects: createFakeEffectProvider() }),
  chart: (scenario) => createChartConformanceHost(scenario.setup ?? {}),
};

/** Default pixel tolerances another implementation is held to (this core matches exactly). */
const PIXEL_TOLERANCE = { maxDelta: 2, meanDelta: 0.1 };

const format = (value) => JSON.stringify(value, null, 2) + "\n";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const wanted = args.filter((a) => !a.startsWith("--"));
const failed = [];
let stale = 0;
for (const [domain, createHost] of Object.entries(DOMAINS)) {
  if (wanted.length && !wanted.includes(domain)) continue;
  const dir = path.join(root, "packages/conformance/domains", domain, "fixtures");
  if (!fs.existsSync(dir)) continue;
  const pngDir = path.join(dir, "png");
  const pngs = new Set();
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()) {
    const file = path.join(dir, name);
    const scenario = JSON.parse(fs.readFileSync(file, "utf8"));
    if (`${scenario.id}.json` !== name) throw new Error(`${domain}/fixtures/${name}: id "${scenario.id}" should match the file name.`);
    let first, second;
    try {
      first = await runConformanceScenario(scenario, createHost(scenario));
      second = await runConformanceScenario(scenario, createHost(scenario));
    } catch (e) {
      failed.push(`${domain}/${scenario.id}: ${e.message}`);
      continue;
    }
    let steps;
    try {
      steps = scenario.steps.map((step, i) => {
      const out = first[i];
      const again = second[i];
      const label = `${domain}/${scenario.id} step ${i + 1} (${step.tool})`;
      if (JSON.stringify([out.result, out.loaded, out.document, out.render]) !== JSON.stringify([again.result, again.loaded, again.document, again.render])) throw new Error(`${label} is not deterministic: pass a seed or avoid clock-dependent values.`);
      const expect = { result: out.result };
      if (out.isError) expect.isError = true;
      if (step.reload || step.load !== undefined) expect.loaded = out.loaded;
      if (step.document) expect.document = out.document;
      if (step.render) expect.render = out.render;
      if (out.pixels) {
        const hash = sha256(out.pixels.data);
        if (hash !== sha256(again.pixels.data)) throw new Error(`${label}: the pixels are not deterministic.`);
        const png = `png/${scenario.id}.${i + 1}.png`;
        pngs.add(png);
        const bytes = encodePng(out.pixels.width, out.pixels.height, out.pixels.data);
        const target = path.join(dir, png);
        const was = fs.existsSync(target) ? fs.readFileSync(target) : null;
        if (!was || !was.equals(Buffer.from(bytes))) {
          stale++;
          if (check) console.error(`${png} is out of date.`);
          else {
            fs.mkdirSync(pngDir, { recursive: true });
            fs.writeFileSync(target, bytes);
          }
        }
        const tolerance = typeof step.pixels === "object" ? { ...PIXEL_TOLERANCE, ...step.pixels.tolerance } : PIXEL_TOLERANCE;
        expect.pixels = { file: png, width: out.pixels.width, height: out.pixels.height, sha256: hash, ...tolerance };
      }
      const { expect: _old, ...rest } = step;
      return { ...rest, expect };
      });
    } catch (e) {
      failed.push(e.message);
      continue;
    }
    const text = format({ ...scenario, steps });
    if (fs.readFileSync(file, "utf8") !== text) {
      stale++;
      if (check) console.error(`${domain}/fixtures/${name} is out of date.`);
      else fs.writeFileSync(file, text);
    }
  }
  // PNGs no scenario records any more are removed.
  if (fs.existsSync(pngDir)) {
    for (const old of fs.readdirSync(pngDir)) {
      if (pngs.has(`png/${old}`)) continue;
      stale++;
      if (check) console.error(`${domain}/fixtures/png/${old} is no longer recorded.`);
      else fs.rmSync(path.join(pngDir, old));
    }
  }
}
if (failed.length) {
  for (const f of failed) console.error(f);
  console.error(`${failed.length} scenario(s) could not be recorded.`);
  process.exit(1);
}
if (check && stale) {
  console.error(`${stale} recording(s) differ from the core: run node scripts/record-conformance.mjs and commit them.`);
  process.exit(1);
}
console.log(check ? "record-conformance: up to date" : `record-conformance: ${stale} file(s) written`);
