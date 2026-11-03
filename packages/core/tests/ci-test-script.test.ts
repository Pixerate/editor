import { describe, it, expect } from "vitest";
// @ts-expect-error -- a plain Node script without declarations
import { selectTests } from "../../../scripts/ci-test.mjs";

// Which tests a pull request runs on CI (scripts/ci-test.mjs).
const projects = [
  { name: "@pixerate/editor", dir: "packages/core", dependencies: [] },
  { name: "@pixerate/editor-react", dir: "packages/react", dependencies: ["@pixerate/editor"] },
  { name: "@pixerate/editor-svelte", dir: "packages/svelte", dependencies: ["@pixerate/editor"] },
  { name: "demo", dir: "apps/demo", dependencies: ["@pixerate/editor", "@pixerate/editor-react"] },
];
const tests = [
  { file: "packages/core/tests/paint.test.ts", project: "@pixerate/editor" },
  { file: "packages/core/tests/cms.test.ts", project: "@pixerate/editor" },
  { file: "packages/core/tests/entry-isolation.test.ts", project: "@pixerate/editor" },
  { file: "packages/react/tests/paint.test.tsx", project: "@pixerate/editor-react" },
  { file: "packages/react/tests/chart.test.tsx", project: "@pixerate/editor-react" },
  { file: "packages/svelte/tests/paint.test.ts", project: "@pixerate/editor-svelte" },
  { file: "apps/demo/src/scripts.test.ts", project: "demo" },
];
const select = (changed: string[], affected: string[] = [], readsDisk = ["packages/core/tests/entry-isolation.test.ts"]) =>
  selectTests({ changed, projects, tests, affected, readsDisk });

describe("selectTests", () => {
  it.each(["pnpm-lock.yaml", "packages/react/package.json", "tsconfig.base.json", "packages/svelte/vitest.config.ts", ".github/workflows/ci.yml", "scripts/ci-test.mjs"])(
    "runs every test when %s changes",
    (file) => {
      const result = select(["README.md", file]);
      expect(result.all).toBe(true);
      expect(result.reasons[0]).toContain(file);
    },
  );

  it("runs every test of the packages built from a changed core source file, plus what imports it", () => {
    const result = select(["packages/core/src/paint/brush.ts"], ["packages/core/tests/paint.test.ts"]);
    expect(result.all).toBe(false);
    expect(result.files).toEqual([
      "packages/core/tests/paint.test.ts",
      "packages/core/tests/entry-isolation.test.ts",
      "packages/react/tests/paint.test.tsx",
      "packages/react/tests/chart.test.tsx",
      "packages/svelte/tests/paint.test.ts",
      "apps/demo/src/scripts.test.ts",
    ]);
    expect(result.reasons).toContain("every @pixerate/editor-react test: it uses the built @pixerate/editor");
  });

  it("follows dependencies transitively: a React source change runs the demo, not Svelte", () => {
    const result = select(["packages/react/src/PaintEditor.tsx"], ["packages/react/tests/paint.test.tsx"]);
    expect(result.files).toEqual([
      "packages/core/tests/entry-isolation.test.ts",
      "packages/react/tests/paint.test.tsx",
      "apps/demo/src/scripts.test.ts",
    ]);
  });

  it("runs only the affected tests and the disk-reading ones when only tests change", () => {
    const result = select(["packages/core/tests/cms.test.ts"], ["packages/core/tests/cms.test.ts"]);
    expect(result.files).toEqual(["packages/core/tests/cms.test.ts", "packages/core/tests/entry-isolation.test.ts"]);
  });

  it("runs nothing for a docs-only change", () => {
    const result = select(["GOTCHAS.md", ".changeset/quiet-cats.md"]);
    expect(result).toEqual({ all: false, files: [], reasons: ["no test is affected by this change"] });
  });

  it("reports all when the selection covers every test", () => {
    expect(select(["packages/core/src/index.ts"], tests.map((t) => t.file)).all).toBe(true);
  });
});
