#!/usr/bin/env node
// Runs one shard of the unit tests on CI. Pushes to main run every test. A pull request runs
// only the tests its changes can affect:
//
// 1. Every test, when the change touches something all tests depend on (`GLOBAL`: the
//    lockfile, a package.json, a tsconfig, a vitest config, this script or the CI workflow).
// 2. Every test of a project that depends on a changed package's source. React, Svelte and
//    the demo import `@pixerate/editor` through its built `dist/`, so vitest's import graph
//    can't link a change in `packages/core/src` to their tests.
// 3. The tests vitest's import graph links to the changed files (`vitest list --changed`).
// 4. Every test that reads files from disk (its package's src or dist, skills, fixtures).
//    Those reads are not imports, so 3 never selects them. They are cheap.
//
// Every shard computes the same list and runs its part of it, so the shards never overlap.
// After `pnpm build`. See GOTCHAS.md, "PR CI Runs Only the Affected Tests".
//
// Usage: [BASE_SHA=<commit>] node scripts/ci-test.mjs [--shard=1/4] [--list]
//   No BASE_SHA: every test. --list prints the selection without running it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Changed files that mean every test runs. */
export const GLOBAL = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)pnpm-workspace\.yaml$/,
  /(^|\/)package\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)vitest[^/]*\.ts$/,
  /^scripts\/ci-test\.mjs$/,
  /^\.github\/workflows\/ci\.yml$/,
];

/** Paths in a package that its built `dist/` comes from. */
const SOURCE = /^(src|assembly)\/|^tsup\.config\.ts$/;

/** Calls that make a test depend on files it doesn't import. */
const READS_DISK = /\b(readFileSync|readdirSync|readFile|readdir|existsSync|globSync)\(/;

/**
 * Picks the test files to run.
 *
 * @param {object} input
 * @param {string[]} input.changed Changed paths, relative to the repository root.
 * @param {{ name: string, dir: string, dependencies: string[] }[]} input.projects Workspace
 *   projects: vitest project name (the package name), directory relative to the root, and the
 *   names of the workspace packages it depends on.
 * @param {{ file: string, project: string }[]} input.tests Every test file (relative paths).
 * @param {string[]} input.affected Test files vitest links to the changed files.
 * @param {string[]} input.readsDisk Test files that read files from disk.
 * @returns {{ all: boolean, files: string[], reasons: string[] }} `all` means run every test,
 *   otherwise `files` lists them (empty when nothing is affected).
 */
export function selectTests({ changed, projects, tests, affected, readsDisk }) {
  const global = changed.filter((f) => GLOBAL.some((re) => re.test(f)));
  if (global.length)
    return { all: true, files: [], reasons: [`every test: ${global.join(", ")} changed`] };

  // Projects whose built source changed, then every project that depends on them, transitively.
  const changedSource = new Set(
    projects
      .filter((p) => changed.some((f) => f.startsWith(`${p.dir}/`) && SOURCE.test(f.slice(p.dir.length + 1))))
      .map((p) => p.name),
  );
  const full = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of projects) {
      if (full.has(p.name)) continue;
      if (p.dependencies.some((d) => changedSource.has(d) || full.has(d))) {
        full.add(p.name);
        grew = true;
      }
    }
  }

  const reasons = [...full].map((name) => {
    const via = projects.find((p) => p.name === name).dependencies.filter((d) => changedSource.has(d) || full.has(d));
    return `every ${name} test: it uses the built ${via.join(", ")}`;
  });
  const selected = new Set(tests.filter((t) => full.has(t.project)).map((t) => t.file));
  const before = selected.size;
  for (const f of affected) selected.add(f);
  if (selected.size > before) reasons.push(`${selected.size - before} test file(s) that import a changed file`);
  // Disk-reading tests only matter when something besides docs changed.
  if (changed.some((f) => !f.endsWith(".md"))) {
    const count = selected.size;
    for (const f of readsDisk) selected.add(f);
    if (selected.size > count) reasons.push(`${selected.size - count} test file(s) that read files from disk`);
  }

  const files = tests.map((t) => t.file).filter((f) => selected.has(f));
  if (files.length === tests.length) return { all: true, files: [], reasons };
  if (!files.length) reasons.push("no test is affected by this change");
  return { all: false, files, reasons };
}

function workspaceProjects() {
  const dirs = ["packages", "apps"].flatMap((group) =>
    fs
      .readdirSync(path.join(root, group))
      .map((name) => `${group}/${name}`)
      .filter((dir) => fs.existsSync(path.join(root, dir, "package.json"))),
  );
  const pkgs = dirs.map((dir) => ({ dir, pkg: JSON.parse(fs.readFileSync(path.join(root, dir, "package.json"), "utf8")) }));
  const names = new Set(pkgs.map((p) => p.pkg.name));
  return pkgs.map(({ dir, pkg }) => ({
    name: pkg.name,
    dir,
    dependencies: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }).filter(
      (d) => d !== pkg.name && names.has(d),
    ),
  }));
}

function vitestList(extra) {
  // To a file: vite's plugin warnings also go to stdout.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ci-test-")), "list.json");
  execFileSync("pnpm", ["exec", "vitest", "list", "--filesOnly", `--json=${out}`, ...extra], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const files = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : [];
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return files.map((t) => ({ file: path.relative(root, t.file), project: t.projectName }));
}

function main() {
  const shard = process.argv.slice(2).filter((a) => a.startsWith("--shard="));
  const list = process.argv.includes("--list");
  const base = process.env.BASE_SHA;
  const summary = (lines) => {
    console.log(lines.join("\n"));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n\n`);
  };
  const vitest = (args) => execFileSync("pnpm", ["exec", "vitest", "run", ...shard, "--passWithNoTests", ...args], { cwd: root, stdio: "inherit" });

  if (!base) {
    summary(["### Unit tests: all (not a pull request)"]);
    return list ? undefined : vitest([]);
  }
  const changed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const tests = vitestList([]);
  const { all, files, reasons } = selectTests({
    changed,
    projects: workspaceProjects(),
    tests,
    affected: vitestList([`--changed=${base}`]).map((t) => t.file),
    readsDisk: tests.map((t) => t.file).filter((f) => READS_DISK.test(fs.readFileSync(path.join(root, f), "utf8"))),
  });
  summary([
    `### Unit tests: ${all ? "all" : `${files.length} of ${tests.length} files`}, affected by ${changed.length} changed file(s)`,
    "",
    ...reasons.map((r) => `- ${r}`),
  ]);
  if (list) return console.log(all ? "(every test)" : files.join("\n"));
  if (all) return vitest([]);
  if (!files.length) return;
  // Vitest matches each filter as a substring of a test's path, so pass the full paths.
  vitest(files.map((f) => path.join(root, f)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    // vitest has already printed its failures; only report anything else.
    if (error.status == null) console.error(error);
    process.exit(error.status ?? 1);
  }
}
