#!/usr/bin/env node
// Writes the language-neutral contracts of `@pixerate/conformance` from the built core. Run after
// `pnpm build` (or `pnpm --filter @pixerate/editor build`), then commit what changed. A core test
// (`tests/brush-contracts.test.ts`) fails when the committed files differ from the code.
//
// Domains:
//   brushes  `brushContracts()` from `@pixerate/editor/brushes` → packages/conformance/domains/brushes/
//
// Usage: node scripts/export-contracts.mjs [--check]   (--check writes nothing and exits 1 when a file is out of date)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

/** Every contract file is JSON with two-space indents and a final newline, so diffs stay small. */
const format = (value) => JSON.stringify(value, null, 2) + "\n";

const entry = path.join(root, "packages/core/dist/brushes/index.js");
if (!fs.existsSync(entry)) {
  console.error(`No ${path.relative(root, entry)}: build the core first (pnpm --filter @pixerate/editor build).`);
  process.exit(1);
}
const { brushContracts } = await import(pathToFileURL(entry).href);

const domains = { brushes: brushContracts() };
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
