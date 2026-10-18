// @vitest-environment jsdom
// Ported from Ursula (src/treemap/treemap.test.ts).
import { describe, expect, it } from "vitest";
import { parseMermaid } from "../src/diagram/document.js";
import { parseTreemap, treemapValue } from "../src/diagram/treemap/index.js";

const BUDGET = `treemap-beta
"Budget"
    "Operations"
        "Salaries": 700000
        "Equipment": 200000
    "Marketing"
        "Digital": 1,200
        "Events" , 300.5
`;

describe("parseTreemap", () => {
  it("nests sections and leaves by indentation", () => {
    const result = parseTreemap(BUDGET);
    expect(result).toEqual({
      data: {
        items: [
          {
            name: "Budget",
            children: [
              {
                name: "Operations",
                children: [
                  { name: "Salaries", value: 700000 },
                  { name: "Equipment", value: 200000 },
                ],
              },
              {
                name: "Marketing",
                children: [
                  { name: "Digital", value: 1200 },
                  { name: "Events", value: 300.5 },
                ],
              },
            ],
          },
        ],
      },
    });
    if (!("data" in result)) throw new Error("expected data");
    expect(treemapValue(result.data.items[0]!)).toBe(901500.5);
  });

  it("reads several roots, titles, classes, single quotes and comments", () => {
    const source = [
      "treemap",
      "title Cloud spend",
      "accTitle: Spend",
      "accDescr {",
      "  Spend by team",
      "}",
      "classDef big fill:#f00;",
      "'Platform':::big",
      '  "Compute": 40 %% the most',
      '  "Storage": 10:::big',
      '"Data %% team"',
      '\t"Pipelines": 5',
    ].join("\n");
    expect(parseTreemap(source)).toEqual({
      data: {
        title: "Cloud spend",
        accTitle: "Spend",
        accDescr: "Spend by team",
        items: [
          {
            name: "Platform",
            className: "big",
            children: [
              { name: "Compute", value: 40 },
              { name: "Storage", value: 10, className: "big" },
            ],
          },
          { name: "Data %% team", children: [{ name: "Pipelines", value: 5 }] },
        ],
      },
    });
  });

  it("attaches a less-indented item to the nearest section above it", () => {
    const result = parseTreemap('treemap-beta\n"A"\n      "A1": 1\n   "B"\n      "B1": 2\n');
    expect(result).toEqual({
      data: {
        items: [
          {
            name: "A",
            children: [
              { name: "A1", value: 1 },
              { name: "B", children: [{ name: "B1", value: 2 }] },
            ],
          },
        ],
      },
    });
  });

  it("reports what Mermaid rejects, with the line", () => {
    expect(parseTreemap("treemap-beta\nSales: 10\n")).toEqual({
      error: 'Names must be in quotes, e.g. `"Sales": 120`.',
      line: 2,
    });
    expect(parseTreemap('treemap-beta\n"A"\n  "B": -3\n')).toMatchObject({ line: 3 });
    expect(parseTreemap('treemap-beta\n"A": _\n')).toMatchObject({ error: '"_" is not a number.' });
    expect(parseTreemap("treemap-beta\ntitle Empty\n")).toMatchObject({
      error: expect.stringMatching(/^No items/),
    });
    expect(parseTreemap("sankey-beta\nA,B,1\n")).toMatchObject({
      error: expect.stringMatching(/^Not a treemap/),
    });
  });

  it("keeps the document a verbatim passthrough", () => {
    const doc = parseMermaid(BUDGET);
    expect(doc.family).toBe("treemap");
    expect(doc.tier).toBe("render-only");
    expect(doc.source).toBe(BUDGET);
  });
});
