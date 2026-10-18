// @vitest-environment jsdom
// Ported from Ursula (src/sankey/sankey.test.ts).
import { describe, expect, it } from "vitest";
import { parseMermaid } from "../src/diagram/document.js";
import { parseSankey } from "../src/diagram/sankey/index.js";

describe("parseSankey", () => {
  it("reads links and nodes in order of first appearance", () => {
    const result = parseSankey("sankey-beta\n\nSolar,Grid,60\nWind,Grid,40.5\nGrid,Homes,80\n");
    expect(result).toEqual({
      data: {
        nodes: ["Solar", "Grid", "Wind", "Homes"],
        links: [
          { source: "Solar", target: "Grid", value: 60 },
          { source: "Wind", target: "Grid", value: 40.5 },
          { source: "Grid", target: "Homes", value: 80 },
        ],
      },
    });
  });

  it("accepts the `sankey` header, frontmatter, comments and padding", () => {
    const source = [
      "---",
      "title: Energy",
      "---",
      "sankey",
      '  %% @ursula {"v":1}',
      "   A , B , 3 ",
      "",
      "",
      "B,C,1e2",
    ].join("\n");
    const result = parseSankey(source);
    expect(result).toEqual({
      data: {
        nodes: ["A", "B", "C"],
        links: [
          { source: "A", target: "B", value: 3 },
          { source: "B", target: "C", value: 100 },
        ],
      },
    });
    expect(parseMermaid(source).family).toBe("sankey");
  });

  it("reads quoted fields with commas, escaped quotes and line breaks", () => {
    const source = 'sankey-beta\n"Sales, EMEA","The ""big"" one",5\n"Two\nlines",X,1\n';
    expect(parseSankey(source)).toEqual({
      data: {
        nodes: ["Sales, EMEA", 'The "big" one', "Two\nlines", "X"],
        links: [
          { source: "Sales, EMEA", target: 'The "big" one', value: 5 },
          { source: "Two\nlines", target: "X", value: 1 },
        ],
      },
    });
  });

  it("reports what Mermaid rejects, with the line", () => {
    expect(parseSankey("sankey-beta\nA,B\n")).toEqual({
      error: "Expected three fields (source,target,value), found 2.",
      line: 2,
    });
    expect(parseSankey("sankey-beta\nA,B,1\nA,B,1,2\n")).toMatchObject({ line: 3 });
    expect(parseSankey("sankey-beta\nA,B,lots\n")).toMatchObject({
      error: '"lots" is not a number.',
    });
    expect(parseSankey('sankey-beta\n"A,B,1\n')).toMatchObject({
      error: "A quoted field is never closed.",
    });
    expect(parseSankey('sankey-beta\nA"x,B,1\n')).toMatchObject({ line: 2 });
    expect(parseSankey('sankey-beta\n"A" x,B,1\n')).toMatchObject({ line: 2 });
    expect(parseSankey("sankey-beta\n%% nothing yet\n")).toMatchObject({
      error: expect.stringMatching(/^No links/),
    });
    expect(parseSankey('pie\n  "A" : 1\n')).toMatchObject({
      error: expect.stringMatching(/^Not a sankey/),
    });
  });

  it("keeps the document a verbatim passthrough", () => {
    const source = "sankey-beta\nA,B,1\n";
    const doc = parseMermaid(source);
    expect(doc.tier).toBe("render-only");
    expect(doc.source).toBe(source);
    expect(parseSankey(doc.source)).toHaveProperty("data");
  });
});
