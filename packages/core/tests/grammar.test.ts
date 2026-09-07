import { describe, it, expect } from "vitest";
import {
  tokenizePrompt,
  resolveTemplates,
  resolveVariables,
  extractTemplateNames,
  extractVariableNames,
  extractInstructionNames,
  resolveTemplatesWithMapping,
  mapResolvedOffsetToRaw,
  mapRawOffsetToResolved,
  Template,
} from "../src/grammar";

describe("Grammar: Tokenizer", () => {
  it("returns empty array for empty string", () => {
    expect(tokenizePrompt("")).toEqual([]);
  });

  it("tokenizes pure text segment", () => {
    const tokens = tokenizePrompt("A cinematic portrait");
    expect(tokens).toEqual([
      {
        type: "text",
        raw: "A cinematic portrait",
        value: "A cinematic portrait",
        start: 0,
        end: 20,
      },
    ]);
  });

  it("tokenizes templates, variables, and instructions in correct order", () => {
    const input = "Generate {{lighting}} for {subject} with __hdr__ style";
    const tokens = tokenizePrompt(input);

    expect(tokens).toHaveLength(7);
    expect(tokens[0]).toEqual({
      type: "text",
      raw: "Generate ",
      value: "Generate ",
      start: 0,
      end: 9,
    });
    expect(tokens[1]).toEqual({
      type: "template",
      raw: "{{lighting}}",
      value: "lighting",
      start: 9,
      end: 21,
    });
    expect(tokens[2]).toEqual({
      type: "text",
      raw: " for ",
      value: " for ",
      start: 21,
      end: 26,
    });
    expect(tokens[3]).toEqual({
      type: "variable",
      raw: "{subject}",
      value: "subject",
      start: 26,
      end: 35,
    });
    expect(tokens[4]).toEqual({
      type: "text",
      raw: " with ",
      value: " with ",
      start: 35,
      end: 41,
    });
    expect(tokens[5]).toEqual({
      type: "instruction",
      raw: "__hdr__",
      value: "hdr",
      start: 41,
      end: 48,
    });
    expect(tokens[6]).toEqual({
      type: "text",
      raw: " style",
      value: " style",
      start: 48,
      end: 54,
    });
  });

  it("handles whitespace inside template tags", () => {
    const tokens = tokenizePrompt("{{  my_template  }}");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe("template");
    expect(tokens[0].value).toBe("my_template");
  });
});

describe("Grammar: Resolver & Cycle Detection", () => {
  const templates: Template[] = [
    {
      name: "lighting",
      body: "volumetric golden hour light",
    },
    {
      name: "subject_wrap",
      body: "a cute {{animal}}",
    },
    {
      name: "animal",
      body: "red panda",
    },
    {
      name: "loop_a",
      body: "calls {{loop_b}}",
    },
    {
      name: "loop_b",
      body: "calls {{loop_a}}",
    },
    {
      name: "versioned",
      latestVersion: "v2",
      versions: [
        { id: "v1-id", version: "v1", body: "v1 body" },
        { id: "v2-id", version: "v2", body: "v2 body" },
      ],
    },
  ];

  it("resolves direct templates", () => {
    const res = resolveTemplates("Shot with {{lighting}}", templates);
    expect(res).toBe("Shot with volumetric golden hour light");
  });

  it("resolves nested templates recursively", () => {
    const res = resolveTemplates("Look at {{subject_wrap}}!", templates);
    expect(res).toBe("Look at a cute red panda!");
  });

  it("detects circular recursion and returns [Template loop detected]", () => {
    const res = resolveTemplates("Start {{loop_a}}", templates);
    expect(res).toBe("[Template loop detected]");
  });

  it("honors template version bindings", () => {
    const resDefault = resolveTemplates("Use {{versioned}}", templates);
    expect(resDefault).toBe("Use v2 body");

    const resV1 = resolveTemplates("Use {{versioned}}", templates, {
      bindings: { versioned: "v1-id" },
    });
    expect(resV1).toBe("Use v1 body");
  });

  it("resolves variables correctly", () => {
    const res = resolveVariables("Hello {user}, your score is {score}", {
      user: "Alice",
      score: 100,
    });
    expect(res).toBe("Hello Alice, your score is 100");
  });

  it("extracts unique token names", () => {
    const prompt = "{{lighting}} {{camera}} {subject} {mood} __fast__ __quality__";
    expect(extractTemplateNames(prompt)).toEqual(["lighting", "camera"]);
    expect(extractVariableNames(prompt)).toEqual(["subject", "mood"]);
    expect(extractInstructionNames(prompt)).toEqual(["fast", "quality"]);
  });
});

describe("Grammar: Source Mapping", () => {
  const templates: Template[] = [
    {
      name: "style",
      body: "hyper-realistic 8k",
    },
  ];

  it("produces correct source map segments for raw and template parts", () => {
    const text = "Photo: {{style}} shot on film";
    const { text: resolved, map } = resolveTemplatesWithMapping(text, templates);

    expect(resolved).toBe("Photo: hyper-realistic 8k shot on film");
    expect(map.length).toBe(3);

    // Segment 0: "Photo: "
    expect(map[0]).toEqual({
      resolvedStart: 0,
      resolvedEnd: 7,
      source: "raw",
      rawStart: 0,
      rawEnd: 7,
    });

    // Segment 1: "hyper-realistic 8k" from {{style}}
    expect(map[1]).toEqual({
      resolvedStart: 7,
      resolvedEnd: 25,
      source: "template",
      rawStart: 7,
      rawEnd: 16, // "{{style}}".length = 9
      templateName: "style",
    });

    // Segment 2: " shot on film"
    expect(map[2]).toEqual({
      resolvedStart: 25,
      resolvedEnd: 38,
      source: "raw",
      rawStart: 16,
      rawEnd: 29,
    });
  });

  it("maps offsets bidirectionally", () => {
    const text = "A {{style}} B";
    const { map } = resolveTemplatesWithMapping(text, templates);

    // Before template: raw offset 1 is ' '
    expect(mapRawOffsetToResolved(1, map)).toBe(1);
    expect(mapResolvedOffsetToRaw(1, map)).toBe(1);

    // After template: in raw text, ' B' starts at index 11
    // In resolved text: "A hyper-realistic 8k B" -> ' B' starts at 20
    expect(mapRawOffsetToResolved(11, map)).toBe(20);
    expect(mapResolvedOffsetToRaw(20, map)).toBe(11);
  });
});
