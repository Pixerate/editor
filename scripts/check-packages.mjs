#!/usr/bin/env node
// Checks the packages as consumers get them from npm. Run after `pnpm build`.
//
// 1. `pnpm pack`s @pixerate/editor, -react and -svelte and unpacks the tarballs into a temporary
//    project. Their dependencies are linked from the workspace's node_modules, so no network is
//    needed.
// 2. Checks that every `exports` target and `bin` file is in the tarball.
// 3. Type-checks a consumer that imports every subpath of every package with
//    `moduleResolution: "bundler"`, `node16` from an ES module (.mts) and `node16` from
//    CommonJS (.cts, core and React only: Svelte is ESM-only). The packages' own declaration
//    files are checked too (`skipLibCheck` would hide an import inside them that doesn't
//    resolve, which silently turns its types into `any`).
// 4. Imports every core and React subpath in Node, with `import` and with `require`.
//
// Usage: node scripts/check-packages.mjs [--keep]   (--keep leaves the temporary project)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(path.join(root, "package.json"))("typescript");
const PACKAGES = ["core", "react", "svelte"];
const keep = process.argv.includes("--keep");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pixerate-check-packages-"));
const modules = path.join(work, "node_modules");
fs.mkdirSync(modules);
const failures = [];
const fail = (message) => failures.push(message);

function packTo(dir) {
  const source = path.join(root, "packages", dir);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(source, "package.json"), "utf8"),
  );
  const out = execFileSync("pnpm", ["pack", "--pack-destination", work], {
    cwd: source,
    encoding: "utf8",
  });
  const tarball = out.trim().split("\n").pop().trim();
  const target = path.join(modules, pkg.name);
  fs.mkdirSync(target, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    path.isAbsolute(tarball) ? tarball : path.join(work, tarball),
    "-C",
    target,
    "--strip-components=1",
  ]);
  return {
    dir,
    source,
    target,
    pkg: JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")),
  };
}

// 1. Pack and unpack. Data packages (markdown-conformance) are bundled into core, so they stay
// out: the checks below then fail if a package still needs one installed.
const packages = PACKAGES.map(packTo);

// Link everything the workspace installed for these packages (dependencies, peers and type
// packages), plus the root's @types/node. The first package to provide a name wins.
function linkFrom(nodeModules) {
  if (!fs.existsSync(nodeModules)) return;
  for (const name of fs.readdirSync(nodeModules)) {
    if (name.startsWith(".")) continue;
    const names = name.startsWith("@")
      ? fs.readdirSync(path.join(nodeModules, name)).map((n) => `${name}/${n}`)
      : [name];
    for (const full of names) {
      if (full.startsWith("@pixerate/")) continue;
      const link = path.join(modules, full);
      if (fs.existsSync(link)) continue;
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(
        fs.realpathSync(path.join(nodeModules, full)),
        link,
        "dir",
      );
    }
  }
}
for (const { source } of packages) linkFrom(path.join(source, "node_modules"));
linkFrom(path.join(root, "node_modules"));

// 2. Every exports target and bin is in the tarball.
function targets(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object")
    return Object.values(value).flatMap(targets);
  return [];
}
const subpaths = (pkg) =>
  Object.keys(pkg.exports)
    .filter((key) => key !== "./package.json")
    .map((key) => pkg.name + key.slice(1));
for (const { pkg, target } of packages) {
  const files = [
    ...targets(pkg.exports),
    ...targets(pkg.bin ?? {}),
    ...targets(pkg.types ?? []),
  ];
  for (const file of new Set(files)) {
    if (!fs.existsSync(path.join(target, file)))
      fail(
        `${pkg.name}: ${file} is referenced by package.json but not in the tarball`,
      );
  }
}

// 3. Type-check consumers.
const base = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  strict: true,
  noEmit: true,
  skipLibCheck: false,
  jsx: ts.JsxEmit.ReactJSX,
  types: ["node"],
};
const consumers = [
  {
    name: "bundler",
    file: "consumer-bundler.ts",
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    packages: packages,
  },
  {
    name: "node16 (ESM)",
    file: "consumer-node16.mts",
    options: {
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
    },
    packages: packages,
  },
  {
    name: "node16 (CommonJS)",
    file: "consumer-node16.cts",
    cjs: true,
    options: {
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
    },
    packages: packages.filter(({ pkg }) =>
      targets(pkg.exports).some((file) => file.endsWith(".cjs")),
    ),
  },
];
const ours = (fileName) =>
  fileName.includes("/node_modules/@pixerate/") ||
  !fileName.includes("/node_modules/");
// TipTap and tiptap-markdown are `"type": "module"` with one `.d.ts` for both conditions, so
// TypeScript treats their types as ESM-only and flags every import of them from our `.d.cts`
// files (TS1479, and TS1541 / TS1542 for type-only imports). Their types still resolve, and
// `skipLibCheck` hides these errors for consumers. Only that case is tolerated: the import
// must be in one of our declaration files and name a third-party package.
const THIRD_PARTY_ESM_ONLY = new Set([1479, 1541, 1542]);
function tolerated(consumer, d) {
  if (
    !consumer.cjs ||
    !THIRD_PARTY_ESM_ONLY.has(d.code) ||
    !d.file?.fileName.includes("/node_modules/@pixerate/")
  )
    return false;
  const specifier = /["']([^"']+)["']/.exec(
    d.file.text.slice(d.start, d.start + d.length),
  )?.[1];
  return (
    !!specifier &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("@pixerate/")
  );
}
for (const consumer of consumers) {
  const specifiers = consumer.packages.flatMap(({ pkg }) => subpaths(pkg));
  const source = specifiers
    .map(
      (specifier, i) =>
        `import * as m${i} from ${JSON.stringify(specifier)};\nexport const keys${i}: string[] = Object.keys(m${i});`,
    )
    .join("\n");
  const file = path.join(work, consumer.file);
  fs.writeFileSync(file, source + "\n");
  const program = ts.createProgram([file], { ...base, ...consumer.options });
  const all = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program
      .getSourceFiles()
      .filter((sf) => ours(sf.fileName))
      .flatMap((sf) => [
        ...program.getSyntacticDiagnostics(sf),
        ...program.getSemanticDiagnostics(sf),
      ]),
  ];
  const diagnostics = all.filter((d) => !tolerated(consumer, d));
  const skipped = all.length - diagnostics.length;
  const checked = program
    .getSourceFiles()
    .filter((sf) => sf.fileName.includes("/node_modules/@pixerate/")).length;
  console.log(
    `types ${consumer.name}: ${specifiers.length} subpaths, ${checked} package declaration files, ${diagnostics.length} errors${skipped ? ` (${skipped} third-party ESM-only imports tolerated)` : ""}`,
  );
  for (const d of diagnostics.slice(0, 20)) {
    const where = d.file
      ? `${path.relative(work, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: `
      : "";
    fail(
      `types ${consumer.name}: ${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    );
  }
  if (diagnostics.length > 20)
    fail(`types ${consumer.name}: … and ${diagnostics.length - 20} more`);
}

// 4. Import every core and React subpath in Node. Svelte ships .svelte files, which Node can't load.
const runtime = packages
  .filter(({ dir }) => dir !== "svelte")
  .flatMap(({ pkg }) => subpaths(pkg));
const run = (args) => {
  try {
    execFileSync(process.execPath, args, {
      cwd: work,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return error.stderr || error.message;
  }
};
const importAll = `const s=${JSON.stringify(runtime)};for(const x of s){const m=await import(x);if(!Object.keys(m).length)throw new Error(x+" has no exports")}`;
const requireAll = `const s=${JSON.stringify(runtime)};for(const x of s){const m=require(x);if(!Object.keys(m).length)throw new Error(x+" has no exports")}`;
for (const [name, args] of [
  ["import", ["--input-type=module", "-e", importAll]],
  ["require", ["--input-type=commonjs", "-e", requireAll]],
]) {
  const error = run(args);
  console.log(
    `node ${name}: ${runtime.length} subpaths ${error ? "FAILED" : "ok"}`,
  );
  if (error)
    fail(`node ${name}: ${error.trim().split("\n").slice(0, 8).join("\n")}`);
}

if (keep) console.log(`kept ${work}`);
else fs.rmSync(work, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("check-packages: ok");
