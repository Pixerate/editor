import { describe, it, expect } from "vitest";
import { matchParameterOptionValue, parameterThemeStyles, parameterThemeStyleText } from "../src/parameters";

describe("parameter theme tokens", () => {
  it("writes a part's declarations as an inline style string", () => {
    expect(parameterThemeStyleText("range")).toBe("accent-color: var(--pixerate-parameter-accent, var(--primary, currentColor));");
    expect(parameterThemeStyleText("input")).toContain("background-color: var(--pixerate-parameter-input-bg,");
    expect(parameterThemeStyleText("input")).toContain("border-color: var(--pixerate-parameter-border,");
  });

  it("leaves button backgrounds to the classes so hover still applies", () => {
    expect(parameterThemeStyles.button).not.toHaveProperty("backgroundColor");
  });

  it("falls back from the select tokens to the input tokens", () => {
    expect(parameterThemeStyles.select.backgroundColor).toMatch(/^var\(--pixerate-parameter-select-bg, var\(--pixerate-parameter-input-bg,/);
  });
});

describe("matchParameterOptionValue", () => {
  const options = [{ value: 1 }, { value: 2 }, { value: "2" }, { value: "soft" }];
  it("prefers an exact match, then a string match", () => {
    expect(matchParameterOptionValue(options, 2)).toBe(2);
    expect(matchParameterOptionValue(options, "2")).toBe("2");
    expect(matchParameterOptionValue([{ value: 1 }, { value: 4 }], "4")).toBe(4);
  });
  it("returns the value itself when no option matches", () => {
    expect(matchParameterOptionValue(options, "hard")).toBe("hard");
  });
});
