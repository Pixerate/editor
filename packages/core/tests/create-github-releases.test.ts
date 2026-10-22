import { describe, expect, it } from "vitest";
import {
  extractChangelogSection,
  getPackageMap,
  parseTag,
} from "../../../scripts/create-github-releases.mjs";

describe("create-github-releases", () => {
  describe("parseTag", () => {
    it("parses scoped package tags", () => {
      expect(parseTag("@pixerate/editor@0.144.0")).toEqual({
        name: "@pixerate/editor",
        version: "0.144.0",
      });
      expect(parseTag("@pixerate/editor-react@0.93.1")).toEqual({
        name: "@pixerate/editor-react",
        version: "0.93.1",
      });
    });

    it("parses unscoped package tags", () => {
      expect(parseTag("my-package@1.2.3")).toEqual({
        name: "my-package",
        version: "1.2.3",
      });
    });

    it("returns null for non-package tags", () => {
      expect(parseTag("v1.0.0")).toBeNull();
      expect(parseTag("release")).toBeNull();
      expect(parseTag("")).toBeNull();
    });
  });

  describe("extractChangelogSection", () => {
    const sampleChangelog = `# Changelog

## 0.144.0

### Minor Changes

- 9fb0b8b: Agent playback changes.

## 0.143.0

### Minor Changes

- 23a822a: Layout improvements.

## 0.1.0

### Initial Release
`;

    it("extracts the matching version section", () => {
      const section = extractChangelogSection(sampleChangelog, "0.144.0");
      expect(section).toBe(
        `### Minor Changes\n\n- 9fb0b8b: Agent playback changes.`,
      );
    });

    it("extracts the middle version section", () => {
      const section = extractChangelogSection(sampleChangelog, "0.143.0");
      expect(section).toBe(
        `### Minor Changes\n\n- 23a822a: Layout improvements.`,
      );
    });

    it("extracts the final version section at EOF", () => {
      const section = extractChangelogSection(sampleChangelog, "0.1.0");
      expect(section).toBe(`### Initial Release`);
    });

    it("returns empty string when version is not present", () => {
      expect(extractChangelogSection(sampleChangelog, "9.9.9")).toBe("");
    });

    it("returns empty string for empty content", () => {
      expect(extractChangelogSection("", "1.0.0")).toBe("");
    });
  });

  describe("getPackageMap", () => {
    it("maps package names to existing package directories", () => {
      const map = getPackageMap();
      expect(map.get("@pixerate/editor")).toMatch(/packages\/core$/);
      expect(map.get("@pixerate/editor-react")).toMatch(/packages\/react$/);
      expect(map.get("@pixerate/editor-svelte")).toMatch(/packages\/svelte$/);
    });
  });
});
