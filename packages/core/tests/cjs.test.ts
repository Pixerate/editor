import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);

describe("CommonJS Module Compatibility", () => {
  it("can be required via CommonJS and correctly initializes extensions", () => {
    const cjsPath = path.resolve(__dirname, "../dist/index.cjs");
    const core = require(cjsPath);
    expect(core).toBeDefined();
    expect(typeof core.Mention).toBe("object");
    expect(typeof core.Mention.extend).toBe("function");
    expect(typeof core.createRichTextPreset).toBe("function");

    const preset = core.createRichTextPreset();
    expect(Array.isArray(preset)).toBe(true);
    expect(preset.length).toBeGreaterThan(0);
  });
});
