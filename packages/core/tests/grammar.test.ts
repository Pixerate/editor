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
  TEMPLATE_LOOP_ERROR,
  TEMPLATE_DEPTH_ERROR,
  Template,
  tokenizePromptWithDiagnostics,
  getPromptDiagnostics,
  parseVariableBody,
  matchConditionalTags,
  escapeVariableText,
  unescapeVariableText,
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

  it("replaces only the recursing tag with [Template loop detected]", () => {
    const res = resolveTemplates("Start {{loop_a}}", templates);
    expect(res).toBe("Start calls calls [Template loop detected]");
    expect(res).toContain(TEMPLATE_LOOP_ERROR);
  });

  it("keeps surrounding text and other tags when a loop is detected", () => {
    const res = resolveTemplates(
      "Hello {{self}} and {{animal}} more text",
      [...templates, { name: "self", body: "{{self}}" }],
    );
    expect(res).toBe("Hello [Template loop detected] and red panda more text");
  });

  it("replaces tags nested beyond maxDepth with [Template max depth exceeded]", () => {
    const chain: Template[] = [
      { name: "a", body: "a>{{b}}" },
      { name: "b", body: "b>{{c}}" },
      { name: "c", body: "c" },
    ];
    expect(resolveTemplates("x {{a}} y", chain, { maxDepth: 2 })).toBe(
      `x a>b>${TEMPLATE_DEPTH_ERROR} y`,
    );
    expect(resolveTemplates("x {{a}} y", chain, { maxDepth: 3 })).toBe(
      "x a>b>c y",
    );
  });

  it("keeps $ replacement patterns in template bodies literal", () => {
    const priced: Template[] = [
      { name: "p", body: "costs $& or $` or $' or $$5" },
    ];
    expect(resolveTemplates("A {{p}} B", priced)).toBe(
      "A costs $& or $` or $' or $$5 B",
    );
  });

  it("leaves unknown templates untouched", () => {
    expect(resolveTemplates("{{missing}} {{animal}}", templates)).toBe(
      "{{missing}} red panda",
    );
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

  it("maps the end of a trailing template to the end of its tag", () => {
    const text = "ab {{style}}";
    const { text: resolved, map } = resolveTemplatesWithMapping(text, templates);
    expect(resolved).toBe("ab hyper-realistic 8k");
    expect(mapResolvedOffsetToRaw(resolved.length, map)).toBe(text.length);
    expect(mapRawOffsetToResolved(text.length, map)).toBe(resolved.length);
    // Inside the resolved template still maps to the start of the tag.
    expect(mapResolvedOffsetToRaw(5, map)).toBe(3);
  });

  it("agrees with resolveTemplates on loops, depth limits and $ patterns", () => {
    const tricky: Template[] = [
      ...templates,
      { name: "self", body: "x {{self}}" },
      { name: "price", body: "$& $`" },
      { name: "a", body: "{{b}}" },
      { name: "b", body: "deep" },
    ];
    const cases = [
      "Hello {{self}} more",
      "A {{price}} B",
      "{{style}} and {{missing}}",
    ];
    for (const input of cases) {
      expect(resolveTemplatesWithMapping(input, tricky).text).toBe(
        resolveTemplates(input, tricky),
      );
    }
    expect(
      resolveTemplatesWithMapping("{{a}}", tricky, undefined, { maxDepth: 1 }).text,
    ).toBe(resolveTemplates("{{a}}", tricky, { maxDepth: 1 }));
  });
});

describe("Grammar: Variable defaults, descriptions and conditional tags", () => {
  it("tokenizes a variable with a default", () => {
    expect(tokenizePrompt("A {subject|a red fox}.")).toEqual([
      { type: "text", raw: "A ", value: "A ", start: 0, end: 2 },
      {
        type: "variable",
        raw: "{subject|a red fox}",
        value: "subject",
        defaultValue: "a red fox",
        start: 2,
        end: 21,
      },
      { type: "text", raw: ".", value: ".", start: 21, end: 22 },
    ]);
  });

  it("tokenizes a variable with a default and a description, trimming parts", () => {
    const [token] = tokenizePrompt(
      "{ subject | a red fox | Describe the main subject }",
    );
    expect(token).toMatchObject({
      type: "variable",
      value: "subject",
      defaultValue: "a red fox",
      description: "Describe the main subject",
    });
  });

  it("keeps extra pipes in the description and allows an empty default", () => {
    expect(tokenizePrompt("{x||Pick one | or two}")[0]).toMatchObject({
      value: "x",
      defaultValue: "",
      description: "Pick one | or two",
    });
    expect(tokenizePrompt("{x|}")[0]).toMatchObject({
      value: "x",
      defaultValue: "",
    });
    expect(tokenizePrompt("{x}")[0]).not.toHaveProperty("defaultValue");
  });

  it("unescapes \\|, \\{, \\} and \\\\ inside defaults and keeps other backslashes", () => {
    const [token] = tokenizePrompt(
      String.raw`{shape|a \{curly\} \| pipe \\ C:\dir}`,
    );
    expect(token.type).toBe("variable");
    expect(token.value).toBe("shape");
    expect(token.defaultValue).toBe(String.raw`a {curly} | pipe \ C:\dir`);
  });

  it("escapeVariableText round-trips through the tokenizer", () => {
    const text = String.raw`weird {text} | with \ slashes`;
    const [token] = tokenizePrompt(`{v|${escapeVariableText(text)}}`);
    expect(token.defaultValue).toBe(text);
    expect(unescapeVariableText(escapeVariableText(text))).toBe(text);
  });

  it("tokenizes balanced conditional tags with their kind", () => {
    const tokens = tokenizePrompt(
      "{?style}in the style of {style}{/style}{!style}plain{/style}",
    );
    expect(tokens.map((t) => [t.type, t.value, t.conditional])).toEqual([
      ["conditional", "style", "if"],
      ["text", "in the style of ", undefined],
      ["variable", "style", undefined],
      ["conditional", "style", "end"],
      ["conditional", "style", "unless"],
      ["text", "plain", undefined],
      ["conditional", "style", "end"],
    ]);
  });

  it("tokenizes nested sections containing templates and instructions", () => {
    const tokens = tokenizePrompt("{?a}x {?b}{{t}} __i__{/b}{/a}");
    expect(tokens.map((t) => t.type)).toEqual([
      "conditional",
      "text",
      "conditional",
      "template",
      "text",
      "instruction",
      "conditional",
      "conditional",
    ]);
  });

  it("treats unbalanced tags as text and reports diagnostics without throwing", () => {
    const { tokens, diagnostics } =
      tokenizePromptWithDiagnostics("a {?x} b {/y} c");
    expect(tokens).toEqual([
      {
        type: "text",
        raw: "a {?x} b {/y} c",
        value: "a {?x} b {/y} c",
        start: 0,
        end: 15,
      },
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unclosed-section",
        name: "x",
        start: 2,
        end: 6,
      }),
      expect.objectContaining({
        code: "unexpected-close",
        name: "y",
        start: 9,
        end: 13,
      }),
    ]);
    expect(getPromptDiagnostics("{?x}ok{/x}")).toEqual([]);
  });

  it("recovers from mismatched nesting by closing the nearest matching section", () => {
    // {/a} closes {?a}; {?b} was never closed, and {/b} then closes nothing.
    const { tokens, diagnostics } =
      tokenizePromptWithDiagnostics("{?a}{?b}x{/a}{/b}");
    expect(tokens.map((t) => [t.type, t.raw])).toEqual([
      ["conditional", "{?a}"],
      ["text", "{?b}x"],
      ["conditional", "{/a}"],
      ["text", "{/b}"],
    ]);
    expect(diagnostics.map((d) => [d.code, d.name])).toEqual([
      ["unclosed-section", "b"],
      ["unexpected-close", "b"],
    ]);
  });

  it("only treats ?, ! and / directly after the brace with a plain name as tags", () => {
    expect(tokenizePrompt("{ ?x}")[0]).toMatchObject({
      type: "variable",
      value: "?x",
    });
    expect(tokenizePrompt("{?}")[0]).toMatchObject({
      type: "variable",
      value: "?",
    });
    expect(tokenizePrompt("{?x|y}")[0]).toMatchObject({
      type: "variable",
      value: "?x",
    });
  });

  it("parseVariableBody classifies bodies", () => {
    expect(parseVariableBody("name")).toEqual({
      kind: "variable",
      name: "name",
    });
    expect(parseVariableBody("!name ")).toEqual({
      kind: "conditional",
      conditional: "unless",
      name: "name",
    });
  });

  it("matchConditionalTags pairs tags and flags the rest", () => {
    expect(
      matchConditionalTags([
        { conditional: "if", name: "a" },
        { conditional: "unless", name: "b" },
        { conditional: "end", name: "b" },
        { conditional: "end", name: "a" },
        { conditional: "end", name: "a" },
      ]),
    ).toEqual([
      { partner: 3 },
      { partner: 2 },
      { partner: 1 },
      { partner: 0 },
      { partner: -1, error: "unexpected-close" },
    ]);
  });

  it("extractVariableNames strips defaults and includes condition names", () => {
    expect(
      extractVariableNames("{?style}{style|oil}{/style} {subject|fox|Who?}"),
    ).toEqual(["style", "subject"]);
  });

  it("does not backtrack catastrophically on long unterminated escapes", () => {
    const started = Date.now();
    tokenizePrompt("{" + "\\".repeat(5000) + "x");
    tokenizePrompt("{" + "\\a".repeat(5000));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("Grammar: Backwards compatibility with the original grammar", () => {
  // The tokenizer and resolver as they were before defaults and conditionals.
  type LegacyToken = {
    type: string;
    raw: string;
    value: string;
    start: number;
    end: number;
  };
  function legacyTokenize(text: string): LegacyToken[] {
    const matches: LegacyToken[] = [];
    const scan = (regex: RegExp, type: string, skipOverlaps: boolean) => {
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (
          skipOverlaps &&
          matches.some((x) => !(end <= x.start || start >= x.end))
        ) {
          continue;
        }
        matches.push({ type, raw: m[0], value: m[1].trim(), start, end });
      }
    };
    scan(/{{\s*([^}]+?)\s*}}/g, "template", false);
    scan(/(?<!\{)\{([^{}]+)\}(?!\})/g, "variable", true);
    scan(/__(.+?)__/g, "instruction", true);
    matches.sort((a, b) => a.start - b.start);
    const tokens: LegacyToken[] = [];
    const text_ = (start: number, end: number): LegacyToken => ({
      type: "text",
      raw: text.slice(start, end),
      value: text.slice(start, end),
      start,
      end,
    });
    let i = 0;
    for (const m of matches) {
      if (m.start > i) tokens.push(text_(i, m.start));
      tokens.push(m);
      i = m.end;
    }
    if (i < text.length) tokens.push(text_(i, text.length));
    return tokens;
  }
  function legacyResolve(
    text: string,
    templates: Template[],
    maxDepth = 10,
  ): string {
    const map = new Map(templates.map((t) => [t.name, t]));
    const rec = (s: string, visited: Set<string>, depth: number): string =>
      s.replace(/{{\s*([^}]+?)\s*}}/g, (full, raw: string) => {
        const name = raw.trim();
        if (visited.has(name)) return TEMPLATE_LOOP_ERROR;
        const body = map.get(name)?.body;
        if (body === undefined) return full;
        if (depth + 1 > maxDepth) return TEMPLATE_DEPTH_ERROR;
        return rec(body, new Set(visited).add(name), depth + 1);
      });
    return rec(text, new Set(), 0);
  }

  // Deterministic pseudo-random generator so failures are reproducible.
  function rng(seed: number) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  function randomPrompt(r: () => number, pieces: string[]): string {
    const length = 1 + Math.floor(r() * 10);
    return Array.from(
      { length },
      () => pieces[Math.floor(r() * pieces.length)],
    ).join("");
  }

  const templates: Template[] = [
    { name: "a", body: "A{{b}}{x}" },
    { name: "b", body: "B {?x}{{a}}{/x} __i__" },
    { name: "c", body: "$& {y|z}" },
    { name: "self", body: "{{self}}" },
  ];

  it("resolves every prompt exactly as before when no values are passed", () => {
    const r = rng(42);
    const pieces = [
      "{{a}}",
      "{{b}}",
      "{{c}}",
      "{{self}}",
      "{{ missing }}",
      "{x}",
      "{?x}",
      "{/x}",
      "{!y}",
      "{y|d|p}",
      "__i__",
      "{",
      "}",
      "|",
      " ",
      "text",
      "$&",
      "\\",
    ];
    for (let n = 0; n < 500; n++) {
      const input = randomPrompt(r, pieces);
      expect(resolveTemplates(input, templates)).toBe(
        legacyResolve(input, templates),
      );
      expect(resolveTemplates(input, templates, { maxDepth: 2 })).toBe(
        legacyResolve(input, templates, 2),
      );
      expect(resolveTemplatesWithMapping(input, templates).text).toBe(
        legacyResolve(input, templates),
      );
    }
  });

  it("tokenizes every prompt without the new syntax exactly as before", () => {
    const r = rng(7);
    const pieces = [
      "{{a}}",
      "{x}",
      "{ y }",
      "__i__",
      "{",
      "}",
      "{{",
      "}}",
      " ",
      "text",
      "_",
      "{{b}",
      "{c}}",
    ];
    for (let n = 0; n < 500; n++) {
      const input = randomPrompt(r, pieces);
      expect(tokenizePrompt(input)).toEqual(legacyTokenize(input));
    }
  });
});
