import { describe, it, expect } from "vitest";
import {
  analyzePdfLayout,
  pdfLayoutBlocksToHtml,
  pdfOperatorListToRules,
  pdfTextItemsToRuns,
  type PdfLayoutBlock,
  type PdfLayoutPage,
  type PdfRuleLine,
  type PdfTextRun,
} from "../src";

/** A run at baseline `y`; ~0.5 em per character. */
const run = (text: string, x: number, y: number, extra: Partial<PdfTextRun> = {}): PdfTextRun => {
  const size = extra.fontSize ?? 10;
  return { text, x, y, width: text.length * size * 0.5, fontSize: size, ...extra };
};

/** Lines of prose filling `width` points from `x`, starting at baseline `y`, 12pt apart. */
function prose(words: string[], x: number, y: number, width: number, size = 10): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  let line = "";
  let baseline = y;
  const perLine = Math.floor(width / (size * 0.5));
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > perLine && line) {
      runs.push(run(line, x, baseline, { fontSize: size }));
      baseline -= size * 1.2;
      line = word;
    } else line = next;
  }
  if (line) runs.push(run(line, x, baseline, { fontSize: size }));
  return runs;
}

const words = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const types = (blocks: PdfLayoutBlock[]) => blocks.map((b) => b.type);
const texts = (blocks: PdfLayoutBlock[]) =>
  blocks.map((b) => (b.type === "heading" || b.type === "paragraph" ? b.text : b.type));

describe("analyzePdfLayout: reading order", () => {
  it("reads two columns column by column under a full-width title", () => {
    const left = prose([...words("left", 40), "end."], 50, 700, 240);
    const right = prose([...words("right", 40), "done."], 320, 700, 240);
    const page: PdfLayoutPage = {
      runs: [
        run("A Study of Two Columns", 150, 740, { fontSize: 20 }),
        // Interleave runs as a content stream might.
        ...left.flatMap((r, i) => [r, right[i]].filter(Boolean) as PdfTextRun[]),
      ],
    };
    const { blocks, report } = analyzePdfLayout([page]);
    expect(types(blocks)).toEqual(["heading", "paragraph", "paragraph"]);
    const [, first, second] = blocks as any[];
    expect(first.text.startsWith("left0 left1")).toBe(true);
    expect(first.text).toContain("left39 end.");
    expect(first.text).not.toContain("right");
    expect(second.text.startsWith("right0")).toBe(true);
    expect(report.multiColumnPages).toBe(1);
    expect(report.items.some((i) => i.type === "columns")).toBe(true);
  });

  it("continues a paragraph that flows from the left column into the right one", () => {
    // The left column ends on a full line without a full stop.
    const full = "lorem ipsum dolor sit amet consectetur adipiscing";
    const left = [0, 1, 2, 3, 4].map((i) => run(full, 50, 700 - i * 12));
    const right = prose(["continued", ...words("beta", 28), "end."], 320, 700, 240);
    const { blocks } = analyzePdfLayout([{ runs: [...left, ...right] }]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).text).toContain("adipiscing continued beta0");
  });

  it("finds the columns of a short page under a centred title that crosses the gutter", () => {
    const left = prose([...words("left", 12), "end."], 50, 700, 240);
    const right = prose([...words("right", 12), "done."], 320, 700, 240);
    const { blocks } = analyzePdfLayout([{ runs: [run("Centred Title Text", 230, 740, { fontSize: 12 }), ...left, ...right] }]);
    expect(texts(blocks).slice(1).map((t) => t.split(" ")[0])).toEqual(["left0", "right0"]);
  });

  it("can turn column detection off", () => {
    const left = prose(words("left", 30), 50, 700, 240);
    const right = prose(words("right", 30), 320, 700, 240);
    const { blocks, report } = analyzePdfLayout([{ runs: [...left, ...right] }], { detectColumns: false });
    expect(report.multiColumnPages).toBe(0);
    // Without columns the same baselines are read across.
    expect((blocks[0] as any).text).toMatch(/left0 .* right0/);
  });

  it("does not mistake two-column prose for a table", () => {
    const left = prose(words("l", 80), 50, 700, 240);
    const right = prose(words("r", 80), 320, 700, 240);
    const { blocks } = analyzePdfLayout([{ runs: [...left, ...right] }]);
    expect(types(blocks)).not.toContain("table");
  });
});

describe("analyzePdfLayout: paragraphs", () => {
  it("re-joins hyphenated words and keeps capitalised compounds", () => {
    const { blocks, report } = analyzePdfLayout([
      {
        runs: [
          run("The inter-", 50, 700),
          run("national standard is Well-", 50, 688),
          run("Known among experts.", 50, 676),
        ],
      },
    ]);
    expect(texts(blocks)).toEqual(["The international standard is Well- Known among experts."]);
    expect(report.dehyphenated).toBe(1);
  });

  it("splits paragraphs on gaps, first-line indents and short sentence-final lines", () => {
    const line = "word ".repeat(18).trim();
    const { blocks } = analyzePdfLayout([
      {
        runs: [
          run(line, 50, 700),
          run("ends here.", 50, 688),
          run(line, 50, 676), // after a short line ending a sentence
          run(line, 50, 664),
          run(`  Indented ${line}`.trim(), 70, 652), // first-line indent
          run(line, 50, 640),
          run(line, 50, 610), // vertical gap
        ],
      },
    ]);
    expect(blocks).toHaveLength(4);
    expect(types(blocks)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph"]);
    expect((blocks[2] as any).text.startsWith("Indented")).toBe(true);
  });
});

describe("analyzePdfLayout: headings", () => {
  it("derives heading levels from font size clusters and bold body text", () => {
    const body = (y: number) => prose(words("body", 30).concat("end."), 50, y, 450);
    const { blocks, report } = analyzePdfLayout([
      {
        runs: [
          run("Document Title", 50, 760, { fontSize: 22 }),
          ...body(735),
          run("Section heading", 50, 690, { fontSize: 14 }),
          ...body(670),
          run("Bold run-in heading", 50, 625, { fontName: "ABCDEF+Helvetica-Bold" }),
          ...body(610),
          run("Second section", 50, 565, { fontSize: 14 }),
          ...body(545),
        ],
      },
    ]);
    const headings = blocks.filter((b) => b.type === "heading") as Extract<PdfLayoutBlock, { type: "heading" }>[];
    expect(headings.map((h) => [h.level, h.text])).toEqual([
      [1, "Document Title"],
      [2, "Section heading"],
      [3, "Bold run-in heading"],
      [2, "Second section"],
    ]);
    expect(headings[0].confidence).toBeGreaterThan(headings[2].confidence);
    expect(report.counts.headings).toBe(4);
    expect(report.counts.paragraphs).toBe(4);
    expect(pdfLayoutBlocksToHtml(blocks)).toContain("<h1>Document Title</h1>");
  });

  it("joins a heading wrapped over two lines and keeps bold paragraphs as paragraphs", () => {
    const { blocks } = analyzePdfLayout([
      {
        runs: [
          run("A long heading that wraps", 50, 760, { fontSize: 16 }),
          run("onto a second line", 50, 740, { fontSize: 16 }),
          ...prose(words("x", 30), 50, 715, 450),
          run("This whole paragraph is set in bold type and it fills the full width of the text column", 50, 680, { bold: true }),
          run("the line before ending.", 50, 668, { bold: true }),
          ...prose(words("y", 30), 50, 650, 450),
        ],
      },
    ]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1, text: "A long heading that wraps onto a second line" });
    expect(blocks.filter((b) => b.type === "heading")).toHaveLength(1);
  });
});

describe("analyzePdfLayout: lists", () => {
  it("detects bulleted lists with nesting by indent and hanging continuation lines", () => {
    const { blocks, report } = analyzePdfLayout([
      {
        runs: [
          run("Shopping:", 50, 720),
          run("•", 60, 706),
          run("Fruit", 70, 706),
          run("•", 75, 692),
          run("Apples", 85, 692),
          run("•", 75, 678),
          run("Pears that are ripe and", 85, 678),
          run("ready to eat", 85, 666), // hanging continuation
          run("•", 60, 652),
          run("Bread", 70, 652),
        ],
      },
    ]);
    expect(types(blocks)).toEqual(["paragraph", "list"]);
    const list = blocks[1] as Extract<PdfLayoutBlock, { type: "list" }>;
    expect(list.items).toEqual([
      { text: "Fruit", depth: 0, ordered: false },
      { text: "Apples", depth: 1, ordered: false },
      { text: "Pears that are ripe and ready to eat", depth: 1, ordered: false },
      { text: "Bread", depth: 0, ordered: false },
    ]);
    expect(report.counts.lists).toBe(1);
    expect(pdfLayoutBlocksToHtml([list])).toBe(
      "<ul><li><p>Fruit</p><ul><li><p>Apples</p></li><li><p>Pears that are ripe and ready to eat</p></li></ul></li><li><p>Bread</p></li></ul>",
    );
  });

  it("detects numbered lists with their start number and ignores a lone dash", () => {
    const { blocks } = analyzePdfLayout([
      {
        runs: [
          run("3. Third step", 50, 700),
          run("4. Fourth step", 50, 686),
          run("5. Fifth step", 50, 672),
          run("- not a list on its own", 50, 640),
        ],
      },
    ]);
    expect(types(blocks)).toEqual(["list", "paragraph"]);
    const html = pdfLayoutBlocksToHtml(blocks);
    expect(html).toContain('<ol start="3"><li><p>Third step</p></li>');
    expect(html).toContain("<p>- not a list on its own</p>");
  });

  it("keeps a separate bullet glyph with its text even across a wide gap", () => {
    const { blocks } = analyzePdfLayout([
      { runs: [run("•", 50, 700), run("Item one", 80, 700), run("•", 50, 686), run("Item two", 80, 686), run("•", 50, 672), run("Item three", 80, 672)] },
    ]);
    expect(types(blocks)).toEqual(["list"]);
    expect((blocks[0] as any).items.map((i: any) => i.text)).toEqual(["Item one", "Item two", "Item three"]);
  });
});

/** Horizontal and vertical rules of a full grid. */
function grid(xs: number[], ys: number[]): PdfRuleLine[] {
  const rules: PdfRuleLine[] = [];
  for (const y of ys) rules.push({ x1: xs[0], y1: y, x2: xs[xs.length - 1], y2: y });
  for (const x of xs) rules.push({ x1: x, y1: ys[ys.length - 1], x2: x, y2: ys[0] });
  return rules;
}

describe("analyzePdfLayout: tables", () => {
  it("builds a table from ruling lines with a bold header row", () => {
    const xs = [50, 200, 350, 500];
    const ys = [700, 680, 660, 640];
    const cell = (text: string, c: number, r: number, bold = false) => run(text, xs[c] + 4, ys[r] - 14, { bold });
    const { blocks, report } = analyzePdfLayout([
      {
        runs: [
          run("Before the table.", 50, 730),
          cell("Name", 0, 0, true),
          cell("Unit", 1, 0, true),
          cell("Value", 2, 0, true),
          cell("Alpha", 0, 1),
          cell("kg", 1, 1),
          cell("12", 2, 1),
          cell("Beta", 0, 2),
          cell("m", 1, 2),
          cell("7", 2, 2),
          run("After the table.", 50, 610),
        ],
        rules: grid(xs, ys),
      },
    ]);
    expect(types(blocks)).toEqual(["paragraph", "table", "paragraph"]);
    const table = blocks[1] as Extract<PdfLayoutBlock, { type: "table" }>;
    expect(table.ruled).toBe(true);
    expect(table.headerRows).toBe(1);
    expect(table.rows.map((r) => r.map((c) => c.text))).toEqual([
      ["Name", "Unit", "Value"],
      ["Alpha", "kg", "12"],
      ["Beta", "m", "7"],
    ]);
    expect(report.counts.tables).toBe(1);
    expect(report.items.find((i) => i.type === "table")!.confidence).toBeGreaterThan(0.9);
    expect(pdfLayoutBlocksToHtml([table])).toContain("<tr><th><p>Name</p></th><th><p>Unit</p></th>");
  });

  it("merges ruled cells where a rule is missing (spanning cells)", () => {
    const xs = [50, 200, 350, 500];
    const ys = [700, 680, 660, 640];
    const rules = grid(xs, ys).filter((r) => !(r.x1 === 200 && r.x2 === 200));
    // Re-add the middle vertical rule for the two lower rows only.
    rules.push({ x1: 200, y1: 640, x2: 200, y2: 680 });
    const { blocks } = analyzePdfLayout([
      {
        runs: [
          run("Group heading", 54, 686),
          run("Other", 354, 686),
          run("a", 54, 666),
          run("b", 204, 666),
          run("c", 354, 666),
          run("d", 54, 646),
          run("e", 204, 646),
          run("f", 354, 646),
        ],
        rules,
      },
    ]);
    const table = blocks.find((b) => b.type === "table") as Extract<PdfLayoutBlock, { type: "table" }>;
    expect(table.rows[0]).toEqual([
      { text: "Group heading", colSpan: 2, rowSpan: 1, header: false },
      { text: "Other", colSpan: 1, rowSpan: 1, header: false },
    ]);
    expect(pdfLayoutBlocksToHtml([table])).toContain('<td colspan="2"><p>Group heading</p></td>');
  });

  it("detects a booktabs-style table (horizontal rules only) and its header", () => {
    const rules: PdfRuleLine[] = [
      { x1: 50, y1: 715, x2: 400, y2: 715 },
      { x1: 50, y1: 695, x2: 400, y2: 695 },
      { x1: 50, y1: 640, x2: 400, y2: 640 },
    ];
    const { blocks } = analyzePdfLayout([
      {
        runs: [
          run("Model", 50, 702),
          run("Score", 200, 702),
          run("Year", 320, 702),
          run("Small", 50, 680),
          run("Large", 200, 680),
          run("Old", 320, 680),
          run("Tiny", 50, 665),
          run("Huge", 200, 665),
          run("New", 320, 665),
          run("Mid", 50, 650),
          run("Mid", 200, 650),
          run("Now", 320, 650),
        ],
        rules,
      },
    ]);
    const table = blocks.find((b) => b.type === "table") as Extract<PdfLayoutBlock, { type: "table" }>;
    expect(table).toBeDefined();
    expect(table.columns).toBe(3);
    expect(table.headerRows).toBe(1);
    expect(table.rows).toHaveLength(4);
  });

  it("detects an unruled table from aligned column gaps, with a spanning totals row", () => {
    const row = (y: number, cells: string[]) => cells.map((text, c) => run(text, 50 + c * 120, y));
    const { blocks, report } = analyzePdfLayout([
      {
        runs: [
          ...prose(words("intro", 40).concat("table."), 50, 760, 450),
          ...row(700, ["Meter", "Unit", "Reading"]),
          ...row(686, ["A1", "kWh", "37414.00"]),
          ...row(672, ["A2", "kW", "12.50"]),
          ...row(658, ["A3", "kVA", "9.10"]),
          run("Totals across every meter", 50, 644), // spans the first two columns
          ...prose(words("outro", 40).concat("end."), 50, 610, 450),
        ],
      },
    ]);
    expect(types(blocks)).toEqual(["paragraph", "table", "paragraph"]);
    const table = blocks[1] as Extract<PdfLayoutBlock, { type: "table" }>;
    expect(table.ruled).toBe(false);
    expect(table.columns).toBe(3);
    expect(table.headerRows).toBe(1); // labels over numbers
    expect(table.rows[0].every((c) => c.header)).toBe(true);
    // The row keeps a regular grid: the spanning cell plus an empty one.
    expect(table.rows[4]).toEqual([
      { text: "Totals across every meter", colSpan: 2, rowSpan: 1, header: false },
      { text: "", colSpan: 1, rowSpan: 1, header: false },
    ]);
    expect(report.items.find((i) => i.type === "table")!.detail).toBe("5×3 table, header row");
  });

  it("does not turn two aligned label/value rows into a table", () => {
    const { blocks } = analyzePdfLayout([
      { runs: [run("Invoice:", 50, 700), run("2026-001", 250, 700), run("Date:", 50, 686), run("14 October", 250, 686)] },
    ]);
    expect(types(blocks)).not.toContain("table");
    expect(texts(blocks).join(" ")).toContain("Invoice: 2026-001");
  });

  it("can turn table detection off", () => {
    const row = (y: number, cells: string[]) => cells.map((text, c) => run(text, 50 + c * 120, y));
    const { blocks } = analyzePdfLayout(
      [{ runs: [...row(700, ["a", "b", "c"]), ...row(686, ["d", "e", "f"]), ...row(672, ["g", "h", "i"])] }],
      { detectTables: false },
    );
    expect(types(blocks)).not.toContain("table");
  });
});

describe("analyzePdfLayout: running headers, footers and page numbers", () => {
  it("removes text repeated at the page edges and page numbers", () => {
    const pages: PdfLayoutPage[] = [1, 2, 3].map((n) => ({
      runs: [
        run("ACME Corp — Annual Report 2026", 50, 780, { fontSize: 8 }),
        ...prose(words(["alpha", "beta", "gamma"][n - 1], 30).concat("end."), 50, 700, 450),
        run(`Page ${n} of 3`, 280, 40, { fontSize: 8 }),
      ],
    }));
    const { blocks, report } = analyzePdfLayout(pages);
    expect(blocks.map((b) => (b as any).text).join(" ")).not.toMatch(/ACME|Page \d/);
    expect(report.removed).toEqual({ headers: 3, footers: 0, pageNumbers: 3 });
    expect(blocks).toHaveLength(3);
  });

  it("keeps everything when asked to", () => {
    const pages: PdfLayoutPage[] = [1, 2].map((n) => ({
      runs: [run("Header", 50, 780), ...prose(words("w", 20).concat("end."), 50, 700, 450), run(String(n), 280, 40)],
    }));
    const { report, blocks } = analyzePdfLayout(pages, { removeHeadersAndFooters: false });
    expect(report.removed).toEqual({ headers: 0, footers: 0, pageNumbers: 0 });
    expect(texts(blocks)).toContain("Header");
  });
});

describe("analyzePdfLayout: performance", () => {
  /** A page of prose, a heading, a list and a table, `scale` times over (stacked on one tall page). */
  function bigPage(scale: number): PdfLayoutPage {
    const runs: PdfTextRun[] = [];
    const rules: PdfRuleLine[] = [];
    let y = scale * 400;
    for (let k = 0; k < scale; k++) {
      runs.push(run(`Heading ${k}`, 50, y, { fontSize: 16 }));
      y -= 24;
      runs.push(...prose(words(`w${k}x`, 60).concat("end."), 50, y, 450));
      y -= 120;
      for (let i = 0; i < 4; i++, y -= 14) runs.push(run("•", 50, y), run(`item ${k} ${i}`, 62, y));
      y -= 20;
      const top = y;
      for (let r = 0; r < 4; r++, y -= 20) {
        for (let c = 0; c < 3; c++) runs.push(run(`c${r}${c}`, 54 + c * 100, y - 14));
      }
      rules.push(...grid([50, 150, 250, 350], [top, top - 20, top - 40, top - 60, top - 80]));
      y -= 60;
    }
    return { runs, rules };
  }

  it("grows near-linearly with the number of runs", { timeout: 60_000 }, () => {
    const time = (scale: number) => {
      const page = bigPage(scale);
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        analyzePdfLayout([page]);
        samples.push(performance.now() - start);
      }
      return Math.min(...samples);
    };
    time(20); // warm up
    const small = Math.max(time(50), 1);
    const large = time(200);
    // 4× the input: linear ≈ 4×, quadratic ≈ 16×.
    expect(large / small).toBeLessThan(10);
  });

  it("keeps a staircase of cells from exploding into a huge table", { timeout: 30_000 }, () => {
    const runs: PdfTextRun[] = [];
    for (let i = 0; i < 4000; i++) {
      const row = i >> 1;
      const col = row + (i % 2);
      runs.push(run("x", 10 + col * 20, 100_000 - row * 14));
    }
    const { blocks } = analyzePdfLayout([{ runs }]);
    for (const block of blocks) if (block.type === "table") expect(block.columns).toBeLessThanOrEqual(63);
  });
});

describe("pdf.js helpers", () => {
  it("converts text items to runs with sizes from the transform and resolved fonts", () => {
    const runs = pdfTextItemsToRuns(
      [
        { type: "beginMarkedContent" },
        { str: "Bold", transform: [12, 0, 0, 12, 10, 700], width: 24, fontName: "f1" },
        { str: " ", transform: [12, 0, 0, 12, 34, 700], width: 3, fontName: "f1" },
        { str: "plain", transform: [10, 0, 0, 10, 40, 700], width: 25, fontName: "f2" },
      ],
      (name) => (name === "f1" ? { name: "Arial-BoldMT", bold: true } : undefined),
    );
    expect(runs).toEqual([
      { text: "Bold", x: 10, y: 700, width: 24, fontSize: 12, fontName: "Arial-BoldMT", bold: true, italic: undefined },
      { text: "plain", x: 40, y: 700, width: 25, fontSize: 10, fontName: "f2", bold: undefined, italic: undefined },
    ]);
  });

  it("reads rules from a classic operator list, applying transforms and skipping clips", () => {
    const OPS = { save: 10, restore: 11, transform: 12, moveTo: 13, lineTo: 14, rectangle: 19, stroke: 20, fill: 22, endPath: 28, constructPath: 91 };
    const rules = pdfOperatorListToRules({
      fnArray: [10, 12, 91, 20, 11, 91, 22, 91, 28, 91, 20],
      argsArray: [
        null,
        [1, 0, 0, 1, 100, 0],
        [[13, 14], [0, 500, 200, 500], [0, 500, 200, 500]],
        null,
        null,
        [[19], [50, 400, 300, 0.5], [50, 400, 350, 400.5]], // thin filled bar
        null,
        [[19], [0, 0, 600, 800], null], // clip path
        null,
        [[19], [10, 10, 20, 30], null], // stroked box → four edges
        null,
      ],
    }, OPS);
    expect(rules[0]).toEqual({ x1: 100, y1: 500, x2: 300, y2: 500 });
    expect(rules[1]).toEqual({ x1: 50, y1: 400.25, x2: 350, y2: 400.25 });
    expect(rules).toHaveLength(2 + 4);
    expect(rules.slice(2)).toContainEqual({ x1: 10, y1: 10, x2: 30, y2: 10 });
  });

  it("reads rules from a pdf.js 5 operator list", () => {
    const rules = pdfOperatorListToRules({
      fnArray: [91, 91],
      argsArray: [
        [20, [new Float32Array([0, 10, 20, 1, 110, 20])], null],
        [28, [new Float32Array([0, 0, 0, 1, 0, 100])], null], // endPath: not painted
      ],
    });
    expect(rules).toEqual([{ x1: 10, y1: 20, x2: 110, y2: 20 }]);
  });
});
