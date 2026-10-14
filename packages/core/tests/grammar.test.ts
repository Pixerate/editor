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
  resolvePrompt,
  evaluatePromptTokens,
  extractVariables,
  getVariableFormFields,
  compareConditionValues,
  conditionSubject,
  parseComparison,
  formatConditionalTag,
  parseConditionExpression,
  evaluateConditionExpression,
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

describe("Grammar: Comparison conditions", () => {
  const run = (text: string, values: Record<string, any>) =>
    resolvePrompt(text, [], { values }).text;

  it("tokenizes a comparison closed by its subject", () => {
    const tokens = tokenizePrompt("{?amount>100}big{/amount}");
    expect(tokens[0]).toEqual({
      type: "conditional",
      raw: "{?amount>100}",
      value: "amount",
      conditional: "if",
      comparison: { operator: ">", operand: "100" },
      start: 0,
      end: 13,
    });
    expect(tokens[2]).toMatchObject({ type: "conditional", conditional: "end", value: "amount" });
    expect(tokens[2].comparison).toBeUndefined();
    expect(getPromptDiagnostics("{?amount>100}big{/amount}")).toEqual([]);
  });

  it("trims spaces, accepts != and quoted operands", () => {
    const [open] = tokenizePrompt('{?status != "on hold"}x{/status}');
    expect(open).toMatchObject({
      value: "status",
      comparison: { operator: "<>", operand: "on hold" },
    });
    const [empty] = tokenizePrompt('{!note=""}x{/note}');
    expect(empty).toMatchObject({
      conditional: "unless",
      value: "note",
      comparison: { operator: "=", operand: "" },
    });
  });

  it.each([
    ["=", "5", "5.0", true],
    ["=", "7", "7", true],
    ["<>", "5", "6", true],
    ["<", "9", "10", true],
    [">", "10", "9", true],
    ["<=", "10", "10", true],
    [">=", "9", "10", false],
    ["<", "-2.5", "1e1", true],
  ] as const)("compares numbers numerically: %s %s %s", (op, left, right, expected) => {
    expect(compareConditionValues(left, op, right)).toBe(expected);
  });

  it("compares text case-insensitively when either side is not a number", () => {
    expect(compareConditionValues("PAID", "=", "paid")).toBe(true);
    expect(compareConditionValues("apple", "<", "Banana")).toBe(true);
    // As text, "10" sorts before "9x".
    expect(compareConditionValues("10", ">", "9x")).toBe(false);
    expect(compareConditionValues("", "=", "")).toBe(true);
    expect(compareConditionValues("0x10", "=", "16")).toBe(false);
  });

  it("keeps or drops sections by comparing the supplied value", () => {
    const prompt = "Total{?amount>100} (large){/amount}{!amount>100} (small){/amount}";
    expect(run(prompt, { amount: "250" })).toBe("Total (large)");
    expect(run(prompt, { amount: 99.5 })).toBe("Total (small)");
    expect(run(prompt, { amount: "100" })).toBe("Total (small)");
    expect(run(prompt, {})).toBe("Total (small)");
    expect(run("{?status=paid}Thanks{/status}", { status: "Paid" })).toBe("Thanks");
    expect(run("{?status=paid}Thanks{/status}", { status: "due" })).toBe("");
    expect(run('{?note=""}none{/note}', {})).toBe("none");
    expect(run("{?n<>0}nonzero{/n}", { n: "0.0" })).toBe("");
  });

  it("nests comparisons with presence sections and variables", () => {
    const prompt =
      "{?vip}VIP {?spend>=1000}gold {name}{/spend}{/vip}{?spend<1000}std{/spend}";
    expect(run(prompt, { vip: "y", spend: "1500", name: "Ada" })).toBe("VIP gold Ada");
    expect(run(prompt, { vip: "y", spend: "10" })).toBe("VIP std");
    expect(run(prompt, { spend: "2000" })).toBe("");
  });

  it("leaves comparisons as written without values and maps them", () => {
    const prompt = "A{?x>1}B{/x}C";
    expect(resolveTemplates(prompt, [])).toBe(prompt);
    const { text, map } = resolvePrompt(prompt, [], { values: { x: 2 } });
    expect(text).toBe("ABC");
    expect(mapResolvedOffsetToRaw(1, map)).toBe(7);
    expect(map.find((s) => s.source === "conditional")).toMatchObject({
      variableName: "x",
    });
  });

  it("evaluates comparisons in evaluatePromptTokens", () => {
    const tokens = evaluatePromptTokens("{?n>=3}many{/n}{?n<3}few{/n}", { n: "4" });
    expect(tokens.map((t) => t.value).join("")).toBe("many");
  });

  it("still treats {?a>1}…{/a>1} as a presence check on a variable named a>1", () => {
    const tokens = tokenizePrompt("{?a>1}x{/a>1}");
    expect(tokens[0]).toMatchObject({ value: "a>1", conditional: "if" });
    expect(tokens[0].comparison).toBeUndefined();
    expect(run("{?a>1}x{/a>1}", { "a>1": "yes", a: "0" })).toBe("x");
    expect(run("{?a>1}x{/a>1}", { a: "5" })).toBe("");
  });

  it.each([
    ["{?amount>}x{/amount}", "Missing value"],
    ["{?amount=>5}x{/amount}", "Unexpected"],
    ["{?amount==5}x{/amount}", "Unexpected"],
    ['{?amount="5}x{/amount}', "Unterminated"],
  ])("reports %s as an invalid condition and keeps it literal", (input, message) => {
    const { tokens, diagnostics } = tokenizePromptWithDiagnostics(input);
    expect(tokens).toEqual([
      { type: "text", raw: input, value: input, start: 0, end: input.length },
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: "invalid-condition", name: "amount", start: 0 });
    expect(diagnostics[0].message).toContain(message);
    expect(resolvePrompt(input, [], { values: { amount: 9 } }).text).toBe(input);
  });

  it("parses comparisons and subjects", () => {
    expect(conditionSubject("amount >= 3")).toBe("amount");
    expect(conditionSubject("amount")).toBeUndefined();
    expect(conditionSubject(">3")).toBeUndefined();
    expect(conditionSubject("a!b=3")).toBeUndefined();
    expect(parseComparison("x <= -1")).toEqual({
      subject: "x",
      comparison: { operator: "<=", operand: "-1" },
    });
    expect(parseComparison("x=")?.error).toMatch(/Missing value/);
    expect(parseComparison("plain")).toBeUndefined();
  });

  it("formats conditional tags for display", () => {
    expect(formatConditionalTag({ conditional: "if", value: "x" })).toBe("{?x}");
    expect(formatConditionalTag({ conditional: "end", value: "x" })).toBe("{/x}");
    expect(
      formatConditionalTag({
        conditional: "unless",
        value: "s",
        comparison: { operator: "<>", operand: " on hold" },
      }),
    ).toBe('{!s<>" on hold"}');
    expect(
      formatConditionalTag({ conditional: "if", value: "n", comparison: { operator: ">", operand: "3" } }),
    ).toBe("{?n>3}");
  });

  it("parses and evaluates standalone condition expressions", () => {
    const vip = parseConditionExpression("vip");
    const notVip = parseConditionExpression("!vip");
    const big = parseConditionExpression("? amount > 10");
    const notPaid = parseConditionExpression("!status=paid");
    for (const e of [vip, notVip, big, notPaid]) expect("error" in e).toBe(false);
    const values = { vip: "y", amount: "12", status: "PAID" };
    expect(evaluateConditionExpression(vip as any, values)).toBe(true);
    expect(evaluateConditionExpression(notVip as any, values)).toBe(false);
    expect(evaluateConditionExpression(big as any, values)).toBe(true);
    expect(evaluateConditionExpression(notPaid as any, values)).toBe(false);
    expect(parseConditionExpression("")).toEqual({ error: "Empty condition" });
    expect("error" in parseConditionExpression("amount>")).toBe(true);
    expect("error" in parseConditionExpression("=5")).toBe(true);
  });

  it("pairs a comparison with the nearest matching open tag", () => {
    expect(
      matchConditionalTags([
        { conditional: "if", name: "a" },
        { conditional: "if", name: "a>1" },
        { conditional: "end", name: "a" },
        { conditional: "end", name: "a" },
      ]).map((m) => [m.partner, m.error, m.comparison?.subject]),
    ).toEqual([
      [3, undefined, undefined],
      [2, undefined, "a"],
      [1, undefined, "a"],
      [0, undefined, undefined],
    ]);
  });

  it("reports comparison subjects from the variable helpers", () => {
    const prompt = "{?amount>100}Dear {name}{/amount}{?a>1}x{/a>1}";
    expect(extractVariableNames(prompt)).toEqual(["amount", "name", "a>1"]);
    expect(extractVariables(prompt)[0]).toMatchObject({
      name: "amount",
      usedInCondition: true,
      usedInComparison: true,
      usedAsValue: false,
    });
    const fields = getVariableFormFields(prompt);
    expect(fields.find((f) => f.name === "amount")?.conditionOnly).toBe(false);
    expect(fields.find((f) => f.name === "a>1")?.conditionOnly).toBe(true);
  });
});

describe("Grammar: Comparison conditions are backwards compatible", () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  // Before comparisons, `=`, `<` and `>` were ordinary name characters.
  // Swapping them for symbols that cannot form a comparison reproduces the
  // old behaviour, which the new grammar must match on accepted prompts.
  const swap: Record<string, string> = { "=": "①", "<": "②", ">": "③" };
  const neutralize = (s: string) => s.replace(/[=<>]/g, (c) => swap[c]);
  const restore = (s: string) =>
    s.replace(/[①-③]/g, (c) => Object.keys(swap).find((k) => swap[k] === c)!);
  const neutralTokens = (tokens: any[]) =>
    tokens.map((t) => ({ ...t, raw: neutralize(t.raw), value: neutralize(t.value) }));

  const pieces = [
    "{?x}",
    "{/x}",
    "{!x}",
    "{?a>1}",
    "{/a>1}",
    "{!a>1}",
    "{?b=c}",
    "{/b=c}",
    "{?a <= 2}",
    "{/a <= 2}",
    "{/a}",
    "{/b}",
    "{a}",
    "{b|d}",
    "{{t}}",
    "a<b",
    "=",
    " ",
    "text",
  ];
  const templates: Template[] = [{ name: "t", body: "T{?x}{a}{/x}" }];
  const randomInput = (r: () => number) =>
    Array.from(
      { length: 1 + Math.floor(r() * 8) },
      () => pieces[Math.floor(r() * pieces.length)],
    ).join("");

  it("tokenizes and resolves every prompt the old grammar accepted exactly as before", () => {
    const r = rng(2026);
    let checked = 0;
    for (let n = 0; n < 4000; n++) {
      const input = randomInput(r);
      const legacy = neutralize(input);
      if (getPromptDiagnostics(legacy).length > 0) continue;
      checked++;
      expect(neutralTokens(tokenizePrompt(input))).toEqual(tokenizePrompt(legacy));
      expect(getPromptDiagnostics(input)).toEqual([]);
      const values: Record<string, string> = {
        x: r() > 0.5 ? "1" : "",
        a: r() > 0.5 ? "5" : "0",
        "a>1": r() > 0.5 ? "yes" : "",
        "b=c": r() > 0.5 ? "yes" : "",
        "a <= 2": "y",
      };
      const legacyValues = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [neutralize(k), v]),
      );
      expect(resolvePrompt(input, templates, { values }).text).toBe(
        restore(resolvePrompt(legacy, templates, { values: legacyValues }).text),
      );
      expect(resolveTemplates(input, templates)).toBe(
        restore(resolveTemplates(legacy, templates)),
      );
      expect(extractVariableNames(input)).toEqual(
        extractVariableNames(legacy).map(restore),
      );
    }
    expect(checked).toBeGreaterThan(250);
  });

  it("only gives new meaning to prompts the old grammar reported as unbalanced", () => {
    const r = rng(99);
    let changed = 0;
    for (let n = 0; n < 1500; n++) {
      const input = randomInput(r);
      const hasComparison = tokenizePrompt(input).some((t) => t.comparison);
      const invalid = getPromptDiagnostics(input).some(
        (d) => d.code === "invalid-condition",
      );
      if (hasComparison || invalid) {
        changed++;
        expect(getPromptDiagnostics(neutralize(input)).length).toBeGreaterThan(0);
      }
    }
    expect(changed).toBeGreaterThan(20);
  });
});
