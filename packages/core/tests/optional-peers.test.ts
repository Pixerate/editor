import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const RICH_TEXT = /^(@tiptap\/|markdown-it|prosemirror-)/;

function manifest(dir: string) {
  return JSON.parse(readFileSync(path.resolve(__dirname, "../..", dir, "package.json"), "utf8"));
}

// Chart, canvas, spreadsheet and the other non-rich-text entries must install without TipTap.
describe.each(["core", "svelte", "react"])("%s package.json", (dir) => {
  const pkg = manifest(dir);

  it("installs no TipTap, ProseMirror or markdown package as a dependency", () => {
    expect(Object.keys(pkg.dependencies ?? {}).filter((name) => RICH_TEXT.test(name))).toEqual([]);
  });

  it("marks every TipTap, ProseMirror and markdown peer optional", () => {
    const peers = Object.keys(pkg.peerDependencies ?? {}).filter((name) => RICH_TEXT.test(name));
    expect(peers.length).toBeGreaterThan(0);
    for (const name of peers) expect(pkg.peerDependenciesMeta?.[name]?.optional, name).toBe(true);
  });

  it("mirrors each optional peer in devDependencies for local builds", () => {
    for (const name of Object.keys(pkg.peerDependencies ?? {}).filter((n) => RICH_TEXT.test(n))) {
      expect(pkg.devDependencies?.[name], name).toBe(pkg.peerDependencies[name]);
    }
  });
});
