import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { builtinModules } from "module";

const dist = path.resolve(__dirname, "../dist");

/**
 * Bare (package) specifiers reachable from an ESM or CJS entry, following relative chunk imports.
 * `import` / `export` right after a quote is text (e.g. a command keyword), not a statement.
 */
function reachablePackages(entry: string): Set<string> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = source.matchAll(
      /(?<![\w$."'])(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|(?<![\w$."'])(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g,
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

describe("subpath entry isolation", () => {
  it.each(["spreadsheet/index.js", "raster/index.js", "cms/index.js", "paint/index.js", "image-editor/index.js", "paint-editor/index.js", "history/index.js", "animation/index.js", "animation-editor/index.js", "video-editor/index.js", "grammar/index.js", "commands/index.js", "persistence/index.js", "generation/index.js", "tokens/index.js", "export/index.js", "parameters/index.js", "vector/index.js", "chart/index.js", "diagram/index.js"])(
    "%s pulls in no third-party packages",
    (entry) => {
      expect([...reachablePackages(entry)]).toEqual([]);
    },
  );

  it("canvas/index.js only pulls in dagre", () => {
    expect([...reachablePackages("canvas/index.js")]).toEqual(["@dagrejs/dagre"]);
  });

  it("canvas/index.js loads the paint engine only lazily, for brushed strokes", () => {
    // Files reachable through static imports only (a dynamic `import()` is not followed).
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?<![\w$."'])(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g)) visit(path.resolve(path.dirname(file), m[1]));
    };
    visit(path.join(dist, "canvas/index.js"));
    const paint = [...seen].filter((f) => /function renderBrushstroke\b|BUILTIN_BRUSHES/.test(readFileSync(f, "utf8")));
    expect(paint).toEqual([]);
    // ... and is reached once the dynamic imports are followed too.
    const all = new Set<string>();
    const visitAll = (file: string) => {
      if (all.has(file)) return;
      all.add(file);
      for (const m of readFileSync(file, "utf8").matchAll(/(?:from\s*|import\(\s*|import\s+)["'](\.\.?\/[\w./-]+\.js)["']/g)) visitAll(path.resolve(path.dirname(file), m[1]));
    };
    visitAll(path.join(dist, "canvas/index.js"));
    expect([...all].some((f) => /function renderBrushstroke\b/.test(readFileSync(f, "utf8")))).toBe(true);
  });

  it("compare/index.js only pulls in TipTap / ProseMirror", () => {
    const packages = [...reachablePackages("compare/index.js")];
    expect(packages.every((name) => name === "@tiptap/core" || name.startsWith("@tiptap/pm/"))).toBe(true);
  });

  it.each(["tools/index.js", "tools/index.cjs"])("%s pulls in no TipTap, ProseMirror or dagre", (entry) => {
    const packages = [...reachablePackages(entry)];
    expect(packages.filter((name) => /tiptap|prosemirror|dagre/.test(name))).toEqual([]);
    expect(packages).toEqual([]);
  });

  it("agent/index.js still re-exports the registry from tools", async () => {
    const agent = await import(path.join(dist, "agent/index.js"));
    const tools = await import(path.join(dist, "tools/index.js"));
    expect(agent.ToolRegistry).toBe(tools.ToolRegistry);
    expect(agent.createToolRegistry).toBe(tools.createToolRegistry);
    expect(agent.EDITOR_MCP_TOOLS).toBe(tools.EDITOR_MCP_TOOLS);
    expect(typeof agent.createRichTextToolProvider).toBe("function");
    expect(tools.createRichTextToolProvider).toBeUndefined();
  });

  it.each(["bridge/index.js", "bridge/cli.js"])("%s only pulls in Node built-ins", (entry) => {
    expect([...reachablePackages(entry)].filter((name) => !builtinModules.includes(name.replace(/^node:/, "")))).toEqual([]);
  });

  it("root entry does not pull in dagre", () => {
    expect(reachablePackages("index.js").has("@dagrejs/dagre")).toBe(false);
  });
});
