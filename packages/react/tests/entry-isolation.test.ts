import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const dist = path.resolve(__dirname, "../dist");

/** Bare (package) specifiers reachable from an ESM entry, following relative chunk imports. */
function reachablePackages(entry: string): Set<string> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = source.matchAll(
      /(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g,
    );
    for (const match of specifiers) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith(".")) visit(path.resolve(path.dirname(file), specifier));
      else packages.add(specifier);
    }
  };
  visit(path.join(dist, entry));
  return packages;
}

/** Dependency-free core subpaths an entry may use besides its own: editors with effects support use the effects UI. */
const EXTRA: Record<string, readonly string[]> = {
  "video-editor": ["effects", "parameters"],
  "image-editor": ["effects", "parameters"],
  vector: ["effects", "parameters"],
  "animation-editor": ["effects", "parameters"],
  "paint-editor": ["effects", "parameters", "tools"],
  effects: ["parameters"],
};

// Allowed: the framework itself and the matching narrow core subpath (plus its EXTRA ones).
const isAllowed = (specifier: string, coreSubpath: string) =>
  (EXTRA[coreSubpath] ?? []).some((extra) => specifier === `@pixerate/editor/${extra}`) ||
  specifier === "react" ||
  specifier.startsWith("react/") ||
  specifier === "react-dom" ||
  specifier === `@pixerate/editor/${coreSubpath}`;

describe("subpath entry isolation", () => {
  it.each([
    ["spreadsheet/index.js", "spreadsheet"],
    ["image-editor/index.js", "image-editor"],
    ["paint-editor/index.js", "paint-editor"],
    ["commands/index.js", "commands"],
    ["persistence/index.js", "persistence"],
    ["generation/index.js", "generation"],
    ["tokens/index.js", "tokens"],
    ["parameters/index.js", "parameters"],
    ["vector/index.js", "vector"],
    ["chart/index.js", "chart"],
    ["animation-editor/index.js", "animation-editor"],
    ["video-editor/index.js", "video-editor"],
    ["effects/index.js", "effects"],
  ])("%s pulls in nothing beyond React and @pixerate/editor/%s", (entry, coreSubpath) => {
    const packages = [...reachablePackages(entry)];
    expect(packages).toContain(`@pixerate/editor/${coreSubpath}`);
    expect(packages.filter((p) => !isAllowed(p, coreSubpath))).toEqual([]);
  });

  it("root entry pulls in no canvas or agent code at runtime", () => {
    const packages = [...reachablePackages("index.js")];
    expect(packages).toContain("@pixerate/editor");
    expect(
      packages.filter((p) => p === "@dagrejs/dagre" || /^@xyflow\//.test(p) || /^@pixerate\/editor\/(canvas|agent)$/.test(p)),
    ).toEqual([]);
  });
});
