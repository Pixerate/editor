#!/usr/bin/env node
// Runs after `tsc -p tsconfig.build.json` has written one declaration file per source file into
// a package's `dist` (tsup builds only the JavaScript). It makes those declarations usable by
// every consumer:
//
// 1. Relative specifiers without an extension (`'./types'`, `'../raster'`) get the one Node's
//    ESM resolution needs (`'./types.js'`, `'../raster/index.js'`). Our sources use
//    `moduleResolution: "bundler"`, which allows extensionless imports, and tsc copies
//    specifiers into declarations unchanged, so `node16` / `nodenext` consumers would
//    otherwise lose every type behind such an import.
// 2. Every `X.d.ts` gets an `X.d.cts` twin whose relative specifiers end in `.cjs`. The packages
//    are `"type": "module"`, so a `.d.ts` describes an ES module; `require` consumers resolve
//    the `.d.cts` files through the `require` condition's `types`.
//
// Usage: node scripts/finalize-declarations.mjs <dist directory>

import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(process.argv[2] ?? "dist");
if (!fs.existsSync(dist)) {
  console.error(
    `finalize-declarations: ${dist} does not exist. Run tsc first.`,
  );
  process.exit(1);
}

// `from '…'`, `import('…')`, `import '…'` and `declare module '…'` with a relative specifier.
const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bdeclare\s+module\s+)(['"])(\.\.?(?:\/[^'"]*)?)\2/g;

function declarationFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...declarationFiles(full));
    else if (entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function withExtension(file, specifier) {
  if (/\.(c|m)?js$|\.json$/.test(specifier)) return specifier;
  const target = path.resolve(path.dirname(file), specifier);
  if (fs.existsSync(`${target}.d.ts`)) return `${specifier}.js`;
  if (fs.existsSync(path.join(target, "index.d.ts")))
    return `${specifier.replace(/\/$/, "")}/index.js`;
  throw new Error(
    `finalize-declarations: ${path.relative(dist, file)} imports '${specifier}', which matches no declaration file in ${dist}.`,
  );
}

const files = declarationFiles(dist);
for (const file of files) {
  const esm = fs
    .readFileSync(file, "utf8")
    .replace(
      SPECIFIER,
      (_, head, quote, specifier) =>
        `${head}${quote}${withExtension(file, specifier)}${quote}`,
    );
  const cjs = esm.replace(
    SPECIFIER,
    (_, head, quote, specifier) =>
      `${head}${quote}${specifier.replace(/\.js$/, ".cjs")}${quote}`,
  );
  fs.writeFileSync(file, esm);
  fs.writeFileSync(file.replace(/\.d\.ts$/, ".d.cts"), cjs);
}
console.log(
  `finalize-declarations: ${files.length} declaration files in ${path.relative(process.cwd(), dist) || "."} (+ .d.cts)`,
);
