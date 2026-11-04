#!/usr/bin/env node
// Writes the language-neutral contracts of `@pixerate/conformance` from the built core. Run after
// `pnpm build` (or `pnpm --filter @pixerate/editor build`), then commit what changed. A core test
// (`tests/brush-contracts.test.ts`) fails when the committed files differ from the code.
//
// Domains:
//   brushes  `brushContracts()` from `@pixerate/editor/brushes` → packages/conformance/domains/brushes/
//   paint    `paintContracts()` from `@pixerate/editor/paint-editor` (effect tools listed with the fake effect provider) → packages/conformance/domains/paint/
//   vector   `vectorContracts()` from `@pixerate/editor/vector` (the same fake effect provider) → packages/conformance/domains/vector/
//
// Usage: node scripts/export-contracts.mjs [--check]   (--check writes nothing and exits 1 when a file is out of date)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

/** Every contract file is JSON with two-space indents and a final newline, so diffs stay small. */
const format = (value) => JSON.stringify(value, null, 2) + "\n";

/** Imports a built core entry, e.g. `brushes/index.js`. */
async function core(entry) {
  const file = path.join(root, "packages/core/dist", entry);
  if (!fs.existsSync(file)) {
    console.error(`No ${path.relative(root, file)}: build the core first (pnpm --filter @pixerate/editor build).`);
    process.exit(1);
  }
  return import(pathToFileURL(file).href);
}
const { brushContracts } = await core("brushes/index.js");
const { paintContracts } = await core("paint-editor/index.js");
const { vectorContracts } = await core("vector/index.js");
const { createFakeEffectProvider } = await core("effects/index.js");

const domains = {
  brushes: brushContracts(),
  paint: paintContracts({ effects: createFakeEffectProvider() }),
  vector: vectorContracts({ effects: createFakeEffectProvider() }),
};
let stale = 0;
for (const [domain, files] of Object.entries(domains)) {
  const dir = path.join(root, "packages/conformance/domains", domain);
  fs.mkdirSync(dir, { recursive: true });
  // Files no longer exported are removed, so the folder matches the code.
  for (const old of fs.readdirSync(dir)) {
    if (old.endsWith(".json") && !(old in files)) {
      stale++;
      if (check) console.error(`${domain}/${old} is no longer exported.`);
      else fs.rmSync(path.join(dir, old));
    }
  }
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(dir, name);
    const text = format(value);
    const was = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (was === text) continue;
    stale++;
    if (check) console.error(`${domain}/${name} is out of date.`);
    else fs.writeFileSync(file, text);
  }
}
if (check && stale) {
  console.error(`${stale} contract file(s) differ from the code: run node scripts/export-contracts.mjs and commit them.`);
  process.exit(1);
}
console.log(check ? "export-contracts: up to date" : `export-contracts: ${stale} file(s) written`);
