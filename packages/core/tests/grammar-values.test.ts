import { describe, it, expect } from "vitest";
import {
  resolvePrompt,
  resolveTemplates,
  resolveTemplatesWithMapping,
  resolveVariables,
  mapResolvedOffsetToRaw,
  mapRawOffsetToResolved,
  evaluatePromptTokens,
  extractVariables,
  getVariableFormFields,
  compactVariableValues,
  isPromptValueSet,
  TEMPLATE_LOOP_ERROR,
  type SourceMapSegment,
  type Template,
} from "../src/grammar";

/**
 * Checks that a source map tiles both the raw and the resolved text without
 * gaps or overlaps, and that raw segments copy text verbatim.
 */
function expectWellFormedMap(raw: string, resolved: string, map: SourceMapSegment[]) {
  let rawPos = 0;
  let resolvedPos = 0;
  for (const seg of map) {
    expect(seg.rawStart).toBe(rawPos);
    expect(seg.resolvedStart).toBe(resolvedPos);
    expect(seg.rawEnd).toBeGreaterThanOrEqual(seg.rawStart);
    expect(seg.resolvedEnd).toBeGreaterThanOrEqual(seg.resolvedStart);
    if (seg.source === "raw") {
      expect(resolved.slice(seg.resolvedStart, seg.resolvedEnd)).toBe(
        raw.slice(seg.rawStart, seg.rawEnd),
      );
    }
    if (seg.source === "conditional") {
      expect(seg.resolvedEnd).toBe(seg.resolvedStart);
    }
    rawPos = seg.rawEnd;
    resolvedPos = seg.resolvedEnd;
  }
  expect(rawPos).toBe(raw.length);
  expect(resolvedPos).toBe(resolved.length);
}

describe("Resolution with values: variables and defaults", () => {
  it("substitutes supplied values and falls back to defaults", () => {
    const prompt = "A photo of {subject|a red fox} in {place|the woods|Where?}";
    expect(resolveTemplates(prompt, [], { values: { subject: "an owl" } })).toBe(
      "A photo of an owl in the woods",
    );
    expect(resolveTemplates(prompt, [], { values: {} })).toBe(
      "A photo of a red fox in the woods",
    );
  });

  it("leaves variables without a value or default as placeholders", () => {
    expect(resolveTemplates("Hi {name}, {x|}!", [], { values: {} })).toBe("Hi {name}, !");
  });

  it("keeps everything as written when no values are passed", () => {
    const prompt = "{?s}{s|oil}{/s} {name}";
    expect(resolveTemplates(prompt, [])).toBe(prompt);
    expect(resolvePrompt(prompt).text).toBe(prompt);
  });

  it("treats null/undefined as unset but an explicit empty string as a value", () => {
    expect(resolveVariables("[{a|dflt}]", { a: null })).toBe("[dflt]");
    expect(resolveVariables("[{a|dflt}]", { a: undefined })).toBe("[dflt]");
    expect(resolveVariables("[{a|dflt}]", { a: "" })).toBe("[]");
    expect(resolveVariables("[{a}]", { a: 0 })).toBe("[0]");
  });

  it("does not interpret $ patterns in values", () => {
    expect(resolveVariables("{p}", { p: "$& $' $$" })).toBe("$& $' $$");
  });

  it("resolveVariables keeps its original behaviour for plain variables", () => {
    expect(resolveVariables("Hello { user }, {missing}", { user: "Al" })).toBe(
      "Hello Al, {missing}",
    );
    expect(resolveVariables("", {})).toBe("");
  });

  it("does not treat values as grammar (no re-tokenizing of substitutions)", () => {
    expect(resolveVariables("{a}", { a: "{b} {{t}}" })).toBe("{b} {{t}}");
    expect(resolveTemplates("{a}", [{ name: "t", body: "T" }], { values: { a: "{{t}}" } })).toBe(
      "{{t}}",
    );
  });
});

describe("Resolution with values: conditional sections", () => {
  const prompt = "A fox{?style} in the style of {style}{/style}{!style}, photographed{/style}.";

  it("keeps {?name} bodies only when the value is set", () => {
    expect(resolveVariables(prompt, { style: "Monet" })).toBe(
      "A fox in the style of Monet.",
    );
    expect(resolveVariables(prompt, {})).toBe("A fox, photographed.");
  });

  it("treats blank, null and false values as unset", () => {
    for (const style of ["", "   ", null, undefined, false]) {
      expect(resolveVariables(prompt, { style })).toBe("A fox, photographed.");
    }
    expect(isPromptValueSet(0)).toBe(true);
    expect(isPromptValueSet(true)).toBe(true);
  });

  it("does not consider defaults when evaluating a condition", () => {
    expect(resolveVariables("{?s}[{s|oil}]{/s}", {})).toBe("");
  });

  it("nests sections", () => {
    const nested = "{?a}A{?b}B{/b}{!b}-{/b}{/a}{!a}none{/a}";
    expect(resolveVariables(nested, { a: 1, b: 1 })).toBe("AB");
    expect(resolveVariables(nested, { a: 1 })).toBe("A-");
    expect(resolveVariables(nested, { b: 1 })).toBe("none");
  });

  it("keeps unbalanced tags as literal text and reports them", () => {
    const { text, diagnostics } = resolvePrompt("x {?a} y {/b} {name|n}", [], {
      values: { a: "1" },
    });
    expect(text).toBe("x {?a} y {/b} n");
    expect(diagnostics.map((d) => d.code)).toEqual(["unclosed-section", "unexpected-close"]);
  });

  it("evaluates sections inside template bodies and reports their diagnostics", () => {
    const templates: Template[] = [
      { name: "style", body: "{?artist} by {artist}{/artist}" },
      { name: "broken", body: "oops {/x}" },
    ];
    const { text, diagnostics } = resolvePrompt("Art{{style}} {{broken}} {{broken}}", templates, {
      values: { artist: "Hokusai" },
    });
    expect(text).toBe("Art by Hokusai oops {/x} oops {/x}");
    // Reported once, relative to the template body.
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unexpected-close",
        templateName: "broken",
        start: 5,
        end: 9,
      }),
    ]);
  });

  it("requires sections to open and close within the same body", () => {
    const templates: Template[] = [{ name: "open", body: "{?a}inside" }];
    const { text, diagnostics } = resolvePrompt("{{open}} out{/a}", templates, {
      values: {},
    });
    expect(text).toBe("{?a}inside out{/a}");
    expect(diagnostics).toHaveLength(2);
  });

  it("does not expand templates inside removed sections, so they cannot loop", () => {
    const templates: Template[] = [
      { name: "list", body: "item{?more}, {{list}}{/more}" },
    ];
    expect(resolveTemplates("{{list}}", templates, { values: {} })).toBe("item");
    expect(resolveTemplates("{{list}}", templates, { values: { more: "y" } })).toBe(
      `item, ${TEMPLATE_LOOP_ERROR}`,
    );
  });

  it("still detects loops and depth limits inside kept sections", () => {
    const templates: Template[] = [
      { name: "a", body: "a{?go}>{{b}}{/go}" },
      { name: "b", body: "b{?go}>{{a}}{/go}" },
    ];
    expect(resolveTemplates("{{a}}", templates, { values: { go: 1 } })).toBe(
      `a>b>${TEMPLATE_LOOP_ERROR}`,
    );
    expect(
      resolveTemplates("{{a}}", templates, { values: { go: 1 }, maxDepth: 1 }),
    ).toBe("a>[Template max depth exceeded]");
  });

  it("fills variables inside template bodies and honors version bindings", () => {
    const templates: Template[] = [
      {
        name: "subject",
        versions: [
          { id: "v1", version: "1", body: "{animal|cat}" },
          { id: "v2", version: "2", body: "a {colour|red} {animal|fox}" },
        ],
      },
    ];
    expect(resolveTemplates("{{subject}}", templates, { values: { animal: "owl" } })).toBe(
      "a red owl",
    );
    expect(
      resolveTemplates("{{subject}}", templates, {
        values: {},
        bindings: { subject: "v1" },
      }),
    ).toBe("cat");
  });
});

describe("Resolution with values: source maps", () => {
  it("maps substituted values and defaults to their tags", () => {
    const raw = "A {s|fox} B {t} C";
    const { text, map } = resolveTemplatesWithMapping(raw, [], undefined, {
      values: { t: "owl" },
    });
    expect(text).toBe("A fox B owl C");
    expect(map).toEqual([
      { resolvedStart: 0, resolvedEnd: 2, source: "raw", rawStart: 0, rawEnd: 2 },
      {
        resolvedStart: 2,
        resolvedEnd: 5,
        source: "variable",
        rawStart: 2,
        rawEnd: 9,
        variableName: "s",
        valueSource: "default",
      },
      { resolvedStart: 5, resolvedEnd: 8, source: "raw", rawStart: 9, rawEnd: 12 },
      {
        resolvedStart: 8,
        resolvedEnd: 11,
        source: "variable",
        rawStart: 12,
        rawEnd: 15,
        variableName: "t",
        valueSource: "value",
      },
      { resolvedStart: 11, resolvedEnd: 13, source: "raw", rawStart: 15, rawEnd: 17 },
    ]);
    expectWellFormedMap(raw, text, map);

    // Inside a substituted value maps to the start of its tag.
    expect(mapResolvedOffsetToRaw(3, map)).toBe(2);
    expect(mapResolvedOffsetToRaw(9, map)).toBe(12);
    // Raw text after the tags maps across the length change.
    expect(mapRawOffsetToResolved(16, map)).toBe(12);
    expect(mapResolvedOffsetToRaw(12, map)).toBe(16);
    expect(mapRawOffsetToResolved(raw.length, map)).toBe(text.length);
    expect(mapResolvedOffsetToRaw(text.length, map)).toBe(raw.length);
  });

  it("maps kept sections with empty segments for their tags", () => {
    const raw = "A{?x}B{x}{/x}C";
    const { text, map } = resolvePrompt(raw, [], { values: { x: "yy" } });
    expect(text).toBe("AByyC");
    expect(map.map((s) => [s.source, s.rawStart, s.rawEnd, s.resolvedStart, s.resolvedEnd])).toEqual([
      ["raw", 0, 1, 0, 1],
      ["conditional", 1, 5, 1, 1],
      ["raw", 5, 6, 1, 2],
      ["variable", 6, 9, 2, 4],
      ["conditional", 9, 13, 4, 4],
      ["raw", 13, 14, 4, 5],
    ]);
    expectWellFormedMap(raw, text, map);
    expect(map[1].variableName).toBe("x");

    // "B" sits at raw 5 / resolved 1; "C" at raw 13 / resolved 4.
    expect(mapResolvedOffsetToRaw(1, map)).toBe(5);
    expect(mapRawOffsetToResolved(5, map)).toBe(1);
    expect(mapResolvedOffsetToRaw(4, map)).toBe(13);
    expect(mapRawOffsetToResolved(13, map)).toBe(4);
    // Offsets inside a removed tag collapse onto where it was.
    expect(mapRawOffsetToResolved(3, map)).toBe(1);
    expect(mapRawOffsetToResolved(11, map)).toBe(4);
  });

  it("maps removed sections to a single empty segment", () => {
    const raw = "Start{?x} gone {{t}}{/x} end";
    const { text, map } = resolvePrompt(raw, [{ name: "t", body: "T" }], { values: {} });
    expect(text).toBe("Start end");
    expect(map).toEqual([
      { resolvedStart: 0, resolvedEnd: 5, source: "raw", rawStart: 0, rawEnd: 5 },
      {
        resolvedStart: 5,
        resolvedEnd: 5,
        source: "conditional",
        rawStart: 5,
        rawEnd: 24,
        variableName: "x",
      },
      { resolvedStart: 5, resolvedEnd: 9, source: "raw", rawStart: 24, rawEnd: 28 },
    ]);
    expectWellFormedMap(raw, text, map);
    expect(mapResolvedOffsetToRaw(5, map)).toBe(24);
    expect(mapRawOffsetToResolved(15, map)).toBe(5);
  });

  it("maps a trailing removed section and an all-removed prompt", () => {
    const raw = "ab{?x}cd{/x}";
    const { text, map } = resolvePrompt(raw, [], { values: {} });
    expect(text).toBe("ab");
    expectWellFormedMap(raw, text, map);
    expect(mapResolvedOffsetToRaw(2, map)).toBe(raw.length);
    expect(mapRawOffsetToResolved(raw.length, map)).toBe(2);

    const gone = resolvePrompt("{!x}z{/x}", [], { values: { x: "1" } });
    expect(gone.text).toBe("");
    expectWellFormedMap("{!x}z{/x}", "", gone.map);
    expect(mapResolvedOffsetToRaw(0, gone.map)).toBe(9);
  });

  it("returns a single empty segment for empty input", () => {
    expect(resolvePrompt("", [], { values: {} }).map).toEqual([
      { resolvedStart: 0, resolvedEnd: 0, source: "raw", rawStart: 0, rawEnd: 0 },
    ]);
  });

  it("maps templates whose bodies use values as one template segment", () => {
    const raw = "X {{t}} {?on}Y{/on}";
    const { text, map } = resolveTemplatesWithMapping(
      raw,
      [{ name: "t", body: "<{v|d}>" }],
      undefined,
      { values: { v: "val", on: true } },
    );
    expect(text).toBe("X <val> Y");
    expectWellFormedMap(raw, text, map);
    expect(map[1]).toMatchObject({
      source: "template",
      templateName: "t",
      rawStart: 2,
      rawEnd: 7,
      resolvedStart: 2,
      resolvedEnd: 7,
    });
  });

  it("keeps unknown template tags as separate raw segments, as before", () => {
    const { map } = resolveTemplatesWithMapping("a {{nope}} b", [{ name: "t", body: "T" }]);
    expect(map.map((s) => [s.rawStart, s.rawEnd])).toEqual([
      [0, 2],
      [2, 10],
      [10, 12],
    ]);
  });

  it("produces well-formed maps for random prompts", () => {
    let seed = 99;
    const r = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const templates: Template[] = [
      { name: "a", body: "A{?x}{{b}}{/x}" },
      { name: "b", body: "{y|B}" },
    ];
    const pieces = ["{?x}", "{/x}", "{!y}", "{/y}", "{x}", "{y|dy}", "{{a}}", "{{b}}", "{{zz}}", "txt", " ", "__i__"];
    for (let n = 0; n < 300; n++) {
      const raw = Array.from({ length: 1 + Math.floor(r() * 12) }, () => pieces[Math.floor(r() * pieces.length)]).join("");
      for (const values of [{}, { x: "X" }, { y: "Y" }, { x: "X", y: "" }]) {
        const { text, map } = resolvePrompt(raw, templates, { values });
        expectWellFormedMap(raw, text, map);
        expect(resolveTemplates(raw, templates, { values })).toBe(text);
        for (let o = 0; o <= raw.length; o++) {
          const resolved = mapRawOffsetToResolved(o, map);
          expect(resolved).toBeGreaterThanOrEqual(0);
          expect(resolved).toBeLessThanOrEqual(text.length);
        }
        for (let o = 0; o <= text.length; o++) {
          const back = mapResolvedOffsetToRaw(o, map);
          expect(back).toBeGreaterThanOrEqual(0);
          expect(back).toBeLessThanOrEqual(raw.length);
        }
      }
    }
  });
});

describe("evaluatePromptTokens", () => {
  it("returns plain tokens without values", () => {
    const tokens = evaluatePromptTokens("{?a}x{/a}");
    expect(tokens.map((t) => t.type)).toEqual(["conditional", "text", "conditional"]);
  });

  it("drops removed sections and tags, and annotates variables", () => {
    const tokens = evaluatePromptTokens(
      "{?a}[{a}]{/a}{?b}gone{/b} {c|dc} {d}",
      { a: "A" },
    );
    expect(tokens.map((t) => [t.type, t.raw, t.resolvedValue, t.valueSource])).toEqual([
      ["text", "[", undefined, undefined],
      ["variable", "{a}", "A", "value"],
      ["text", "]", undefined, undefined],
      ["text", " ", undefined, undefined],
      ["variable", "{c|dc}", "dc", "default"],
      ["text", " ", undefined, undefined],
      ["variable", "{d}", undefined, undefined],
    ]);
  });
});

describe("Variable extraction and fill-in form fields", () => {
  const templates: Template[] = [
    { name: "style", body: "{?artist}by {artist|Hokusai|Which artist?}{/artist} {{self}}" },
    { name: "self", body: "{{style}} {mood}" },
  ];

  it("extracts variables with defaults, descriptions and usage", () => {
    const vars = extractVariables(
      "{subject|a red fox|Describe the main subject} {{style}} {subject} {!night}day{/night}",
      { templates },
    );
    expect(vars).toEqual([
      {
        name: "subject",
        defaultValue: "a red fox",
        description: "Describe the main subject",
        usedAsValue: true,
        usedInCondition: false,
        occurrences: 2,
        templates: [],
      },
      {
        name: "artist",
        defaultValue: "Hokusai",
        description: "Which artist?",
        usedAsValue: true,
        usedInCondition: true,
        occurrences: 2,
        templates: ["style"],
      },
      {
        name: "mood",
        usedAsValue: true,
        usedInCondition: false,
        occurrences: 1,
        templates: ["self"],
      },
      {
        name: "night",
        usedAsValue: false,
        usedInCondition: true,
        occurrences: 1,
        templates: [],
      },
    ]);
  });

  it("does not search templates unless given, and ignores unbalanced tags", () => {
    expect(extractVariables("{{style}} {?x} {y}").map((v) => v.name)).toEqual(["y"]);
    expect(extractVariables("")).toEqual([]);
  });

  it("builds form fields labelled by description with defaults as placeholders", () => {
    expect(getVariableFormFields("{subject|a red fox|Describe it} {mood} {?hd}4k{/hd}")).toEqual([
      {
        name: "subject",
        label: "Describe it",
        placeholder: "a red fox",
        defaultValue: "a red fox",
        description: "Describe it",
        required: false,
        conditionOnly: false,
      },
      { name: "mood", label: "mood", placeholder: "", required: true, conditionOnly: false },
      { name: "hd", label: "hd", placeholder: "", required: false, conditionOnly: true },
    ]);
  });

  it("compactVariableValues drops blank inputs so defaults apply", () => {
    const values = compactVariableValues({ a: "", b: "  ", c: "x", d: null });
    expect(values).toEqual({ c: "x" });
    expect(resolveVariables("{a|A}{c}", values)).toBe("Ax");
  });
});
