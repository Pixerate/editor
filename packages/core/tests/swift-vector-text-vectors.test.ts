import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bezierToSubpaths,
  createVectorMorph,
  expandVectorAppearance,
  getVectorSceneRenderData,
  getVectorTextShaper,
  layoutVectorText,
  parseVectorSvg,
  patchVectorCharacterStyle,
  patchVectorParagraphStyle,
  pathTextFrameFromBezier,
  replaceVectorText,
  sanitizeVectorTextFields,
  sanitizeVectorTextFrame,
  setVectorTextShaper,
  styleVectorText,
  transformVectorNode,
  vectorDocumentToSvg,
  vectorNodeBounds,
  vectorTextBoxOutline,
  vectorTextCaret,
  vectorTextGeometryNode,
  vectorTextIndexAt,
  vectorTextName,
  vectorTextPaths,
  vectorTextRange,
  vectorTextSelectionQuads,
  vectorTextSpans,
  vectorTextSpanSvg,
  type VectorDocument,
  type VectorNode,
  type VectorTextNode,
} from "../src/vector/index.js";
import {
  createMetricTextShaper,
  layoutText,
  type TextBlock,
} from "../src/text/index.js";
import type { BezierPath } from "../src/canvas/pathops/bezier.js";
import type { TextFont, TextShaper } from "../src/text/types.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";
import { createVectorConformanceHost } from "../src/vector/contract.js";
import { createFakeEffectProvider } from "../src/effects";

/**
 * Test vectors the Swift vector text (`packages/swift`, `PixerateVector`, #624) checks itself
 * against: the shared layout engine with the metric shaper (`layoutText`: fonts, sizes, tracking,
 * leading, alignments, wrapping, indents, vertical text), text node layout for point, area and path
 * text (`layoutVectorText`), glyph boxes and outlines (`vectorTextPaths`), bounds, transforms,
 * edits and validation, carets, spans, SVG export, import and render data, blends of text, and a
 * replay of the text commands. Computed here from the TS core (the spec); a drift from the
 * committed file fails this test (run with UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended
 * change, then rerun the Swift tests).
 *
 * `shaper` is `metric` (the conformance shaper) or `outline`: a fake outline shaper (the metric
 * advances, each glyph a box with a curved top) that exercises the outline paths; the Swift test
 * builds the same one. Numbers compare exactly where `trig` is false and within relative 1e-9 where
 * they went through `Math.sin` / `Math.cos` / `Math.atan2` (text on a path, vertical glyph boxes);
 * strings always exactly. Key order is not compared.
 *
 * Shape: `{ version, entries: [{ fn, shaper, trig, ...inputs, out }], commands, outlineCommands }`.
 */
const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateVectorTests/Fixtures/vector-text-vectors.json",
);

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

/** The fake outline shaper: metric advances, each glyph a box with a quadratic top (taller for vertical alternates). */
function fakeOutlineShaper(): TextShaper {
  const metric = createMetricTextShaper();
  return {
    id: "fake-outline",
    resolve: (font) =>
      font.family === "Missing"
        ? { family: "sans-serif", available: false }
        : { family: font.family, available: true },
    metrics: (font) => metric.metrics(font),
    measure: (text, font) => metric.measure(text, font),
    outline(
      text: string,
      font: TextFont,
      x: number,
      y: number,
      options?: { vertical?: boolean },
    ): BezierPath {
      const carets = metric.measure(text, font);
      const h = font.size * (options?.vertical ? 0.9 : 0.7);
      const out: BezierPath = [];
      for (let k = 0; k < text.length; k++) {
        const x0 = x + carets[k];
        const x1 = x + carets[k + 1];
        if (!(x1 > x0)) continue;
        out.push(
          { type: "M", x: x0, y },
          { type: "L", x: x1, y },
          { type: "Q", x1, y1: y - h, x: (x0 + x1) / 2, y: y - h },
          { type: "Z" },
        );
      }
      return out;
    },
    families: () => ["sans-serif", "serif", "Fake"],
  };
}

const SHAPERS: Record<string, () => TextShaper> = {
  metric: () => createMetricTextShaper(),
  outline: fakeOutlineShaper,
};

const vec = (
  fn: string,
  shaper: "metric" | "outline",
  trig: boolean,
  inputs: Entry,
  compute: () => unknown,
): Entry => {
  setVectorTextShaper(SHAPERS[shaper]());
  let out: unknown;
  try {
    out = compute();
  } catch (e) {
    out = { error: (e as Error).message };
  }
  return { fn, shaper, trig, ...inputs, out: json(out) };
};

const style = (o: Record<string, unknown> = {}) => ({
  fontFamily: "sans-serif",
  fontWeight: 400,
  fontSize: 24,
  color: "#000000",
  ...o,
});

/** Text blocks for the shared engine. */
const BLOCKS: [string, TextBlock][] = [
  [
    "point, one style",
    {
      text: "Hello world",
      runs: [{ length: 11, style: style() }],
      paragraphs: [{ length: 11, style: {} }],
      frame: { kind: "point" },
    },
  ],
  [
    "point, runs, paragraphs, origin top",
    {
      text: "Big and small\nSecond line\n\nAfter an empty one",
      runs: [
        { length: 3, style: style({ fontSize: 40, fontWeight: 700 }) },
        { length: 10, style: style({ tracking: 120, baselineShift: 4 }) },
        {
          length: 12,
          style: style({ fontFamily: "serif", italic: true, leading: 50 }),
        },
        { length: 99, style: style({ fontSize: 12, color: "#ff0000" }) },
      ],
      paragraphs: [
        {
          length: 45,
          style: { align: "center", spaceBefore: 6, spaceAfter: 3 },
        },
      ],
      frame: { kind: "point", origin: "top" },
    },
  ],
  [
    "box, wrapping, justify, indents",
    {
      text: "The quick brown fox jumps over the lazy dog and keeps running far away.\nShort tail",
      runs: [{ length: 200, style: style({ fontSize: 18 }) }],
      paragraphs: [
        {
          length: 200,
          style: {
            align: "justify",
            firstLineIndent: 12,
            startIndent: 4,
            endIndent: 8,
            autoLeading: 1.5,
          },
        },
      ],
      frame: { kind: "box", width: 180, height: 90 },
    },
  ],
  [
    "box, right, hyphens and long words",
    {
      text: "well-known supercalifragilisticexpialidocious words   with  spaces",
      runs: [{ length: 66, style: style({ fontSize: 16, fontWeight: 600 }) }],
      paragraphs: [{ length: 66, style: { align: "right" } }],
      frame: { kind: "box", width: 120, height: 200 },
    },
  ],
  [
    "box, CJK wraps between characters",
    {
      text: "日本語のテキストは文字の間で折り返します。漢字かな",
      runs: [{ length: 30, style: style({ fontSize: 20 }) }],
      paragraphs: [{ length: 30, style: {} }],
      frame: { kind: "box", width: 100, height: 100 },
    },
  ],
  [
    "vertical point, CJK upright, Latin sideways",
    {
      text: "縦書き（テスト）、ABC 123。ー",
      runs: [
        { length: 8, style: style({ fontSize: 30 }) },
        {
          length: 9,
          style: style({ fontSize: 30, upright: true, tracking: 40 }),
        },
      ],
      paragraphs: [{ length: 17, style: {} }],
      frame: { kind: "point" },
      orientation: "vertical",
    },
  ],
  [
    "vertical box, columns wrap at the height",
    {
      text: "縦の段落が右から左へ並びます\nLatin text too",
      runs: [{ length: 30, style: style({ fontSize: 20, underline: true }) }],
      paragraphs: [{ length: 30, style: { align: "center" } }],
      frame: { kind: "box", width: 120, height: 110 },
      orientation: "vertical",
    },
  ],
  [
    "surrogate pairs and an empty text",
    {
      text: "a😀b𠀋c",
      runs: [{ length: 7, style: style({ fontSize: 10 }) }],
      paragraphs: [{ length: 7, style: {} }],
      frame: { kind: "point" },
    },
  ],
  [
    "empty",
    {
      text: "",
      runs: [],
      paragraphs: [{ length: 0, style: {} }],
      frame: { kind: "point" },
    },
  ],
];

const text = (
  id: string,
  extra: Partial<VectorTextNode> & {
    text: string;
    frame: VectorTextNode["frame"];
  },
): VectorTextNode =>
  ({
    id,
    type: "text",
    name: vectorTextName(extra.text),
    fill: "#000000",
    stroke: null,
    strokeWidth: 1,
    font: { fontFamily: "sans-serif", fontWeight: 400, fontSize: 24 },
    ...extra,
  }) as VectorTextNode;

const CURVE = {
  closed: false,
  anchors: [
    { x: 20, y: 200, out: { x: 120, y: 120 } },
    { x: 300, y: 220, in: { x: 200, y: 300 } },
  ],
};
const CIRCLE = {
  closed: true,
  anchors: bezierToSubpaths(
    "M100 50 C127.6 50 150 72.4 150 100 C150 127.6 127.6 150 100 150 C72.4 150 50 127.6 50 100 C50 72.4 72.4 50 100 50 Z",
  )[0].anchors,
};

/** Text nodes of every kind. */
const NODES: [string, boolean, VectorTextNode][] = [
  [
    "point",
    false,
    text("p", { text: "Hello vector", frame: { kind: "point", x: 20, y: 40 } }),
  ],
  [
    "point with runs and fills",
    false,
    text("r", {
      text: "Red bold, then plain\nand a second paragraph",
      frame: { kind: "point", x: 10, y: 30 },
      runs: [
        { length: 3, style: { fill: "#ff0000", fontWeight: 700 } },
        { length: 6, style: { fontSize: 30, tracking: 60, underline: true } },
        {
          length: 11,
          style: {
            fill: {
              type: "linear",
              stops: [
                { offset: 0, color: "#00ff00" },
                { offset: 1, color: "#0000ff" },
              ],
            },
            strikethrough: true,
          },
        },
      ],
      paragraph: { align: "right", spaceBefore: 5 },
    }),
  ],
  [
    "area, center, overflow",
    false,
    text("a", {
      text: "An area of text that wraps across several lines in its frame.",
      frame: { kind: "area", x: 20, y: 80, width: 160, height: 120 },
      paragraph: { align: "center" },
    }),
  ],
  [
    "area, justify",
    false,
    text("j", {
      text: "Justified lines stretch their spaces to fill the box, but the last line does not.",
      frame: { kind: "area", x: 0, y: 0, width: 150, height: 300 },
      paragraph: { align: "justify", autoLeading: 1.4 },
    }),
  ],
  [
    "vertical point",
    true,
    text("v", {
      text: "縦書きABC。",
      frame: { kind: "point", x: 200, y: 20 },
      orientation: "vertical",
      runs: [
        { length: 3, style: {} },
        { length: 3, style: { upright: true } },
      ],
    }),
  ],
  [
    "vertical area",
    true,
    text("w", {
      text: "縦の段落が右から左へ並びます Latin",
      frame: { kind: "area", x: 50, y: 50, width: 100, height: 120 },
      orientation: "vertical",
    }),
  ],
  [
    "path",
    true,
    text("t", {
      text: "Along the curve",
      frame: { kind: "path", path: CURVE },
      font: { fontFamily: "sans-serif", fontWeight: 400, fontSize: 16 },
    }),
  ],
  [
    "path, centre, ascender, flip, margins",
    true,
    text("u", {
      text: "Centred\nand flipped",
      frame: {
        kind: "path",
        path: CURVE,
        start: 20,
        end: 10,
        flip: true,
        baseline: "ascender",
      },
      paragraph: { align: "center" },
    }),
  ],
  [
    "path, upright, descender, right",
    true,
    text("q", {
      text: "Upright letters",
      frame: {
        kind: "path",
        path: CURVE,
        orientation: "upright",
        baseline: "descender",
      },
      paragraph: { align: "right" },
      runs: [{ length: 7, style: { fill: "#123456", underline: true } }],
    }),
  ],
  [
    "path, closed circle, justify, centre baseline",
    true,
    text("c", {
      text: "Round and round the circle",
      frame: { kind: "path", path: CIRCLE, baseline: "center" },
      paragraph: { align: "justify" },
      font: { fontFamily: "serif", fontWeight: 700, fontSize: 14 },
    }),
  ],
  [
    "path overflows",
    true,
    text("o", {
      text: "This text is far too long to fit along such a short path at this size",
      frame: {
        kind: "path",
        path: {
          closed: false,
          anchors: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
          ],
        },
      },
    }),
  ],
  [
    "empty point",
    false,
    text("e", { text: "", frame: { kind: "point", x: 5, y: 6 } }),
  ],
  [
    "empty path",
    true,
    text("f", { text: "", frame: { kind: "path", path: CURVE } }),
  ],
  [
    "missing font",
    false,
    text("m", {
      text: "Fallback",
      frame: { kind: "point", x: 0, y: 20 },
      font: { fontFamily: "Missing", fontWeight: 400, fontSize: 20 },
    }),
  ],
  [
    "stack fills and transform",
    false,
    text("s", {
      text: "Stacked",
      frame: { kind: "point", x: 10, y: 10 },
      transform: [1, 0, 0, 1, 30, 40],
      fills: [{ paint: "#111111" }, { paint: "#eeeeee", opacity: 0.5 }],
      strokes: [{ paint: "#ff00ff", strokeWidth: 2 }],
      fill: "#eeeeee",
      stroke: "#ff00ff",
      opacity: 0.8,
    } as Partial<VectorTextNode> & {
      text: string;
      frame: VectorTextNode["frame"];
    }),
  ],
];

/** A text layout as compared: everything but the shared engine's objects. */
const layoutOut = (node: VectorTextNode) => {
  const l = layoutVectorText(node);
  return {
    shaper: l.shaper,
    glyphs: l.glyphs,
    fragments: l.fragments.map(({ laid: _l, ...f }) => f),
    lines: l.lines,
    origin: l.origin,
    text: l.text,
    bounds: l.bounds,
    overflow: l.overflow,
    missingFonts: l.missingFonts,
  };
};

const MATRICES = [
  [2, 0, 0, 2, 10, 20],
  [1, 0, 0.5, 1, 0, 0],
  [0.5, 0, 0, 3, -5, 5],
  [0, 1, -1, 0, 100, 0],
  [-1, 0, 0, 1, 0, 0],
];

function nodeVectors(): Entry[] {
  const out: Entry[] = [];
  for (const shaper of ["metric", "outline"] as const) {
    for (const [name, trig, node] of NODES) {
      const t = trig || shaper === "outline";
      out.push(
        vec("layoutVectorText", shaper, t, { name, node }, () =>
          layoutOut(node),
        ),
      );
      out.push(
        vec("vectorTextPaths", shaper, t, { name, node }, () =>
          vectorTextPaths(node),
        ),
      );
      out.push(
        vec("vectorNodeBounds", shaper, true, { name, node }, () => [
          vectorNodeBounds(node),
          vectorNodeBounds(node, [1, 0, 0, 1, 7, 9]),
        ]),
      );
      out.push(
        vec("expandVectorAppearance", shaper, true, { name, node }, () =>
          expandVectorAppearance(node),
        ),
      );
      out.push(
        vec("vectorTextGeometryNode", shaper, t, { name, node }, () =>
          vectorTextGeometryNode(node),
        ),
      );
      out.push(
        vec("vectorTextSpans", shaper, t, { name, node }, () =>
          vectorTextSpans(node).map((sp) => ({
            span: sp,
            svg: vectorTextSpanSvg(
              sp,
              sp.fill === undefined ? undefined : "url(#x)",
            ),
          })),
        ),
      );
    }
  }
  for (const [name, trig, node] of NODES) {
    out.push(
      vec(
        "transformVectorNode",
        "metric",
        true,
        { name, node, matrices: MATRICES },
        () => MATRICES.map((m) => transformVectorNode(node, m as never)),
      ),
    );
    out.push(
      vec("vectorTextBoxOutline", "metric", trig, { name, node }, () =>
        vectorTextBoxOutline(node),
      ),
    );
    const n = node.text.length;
    const indices = [0, 1, Math.floor(n / 2), n - 1, n].filter(
      (i, k, a) => i >= 0 && a.indexOf(i) === k,
    );
    out.push(
      vec("vectorTextCaret", "metric", true, { name, node, indices }, () =>
        indices.map((i) => vectorTextCaret(node, i)),
      ),
    );
    const points = [
      { x: 0, y: 0 },
      { x: 30, y: 40 },
      { x: 120, y: 90 },
      { x: 210, y: 60 },
      { x: 160, y: 200 },
    ];
    out.push(
      vec("vectorTextIndexAt", "metric", true, { name, node, points }, () =>
        points.map((p) => vectorTextIndexAt(node, p)),
      ),
    );
    const ranges = [
      [0, n],
      [1, Math.max(1, n - 2)],
      [2, 2],
    ];
    out.push(
      vec(
        "vectorTextSelectionQuads",
        "metric",
        true,
        { name, node, ranges },
        () => ranges.map(([a, b]) => vectorTextSelectionQuads(node, a, b)),
      ),
    );
  }
  return out;
}

function blockVectors(): Entry[] {
  return BLOCKS.map(([name, block]) =>
    vec("layoutText", "metric", false, { name, block }, () =>
      layoutText(block, getVectorTextShaper()),
    ),
  );
}

function editVectors(): Entry[] {
  const out: Entry[] = [];
  const base = NODES[1][2];
  const plain = NODES[0][2];
  const edits: [number, number, string][] = [
    [0, 0, "Pre "],
    [0, 3, "Blue"],
    [5, 12, ""],
    [18, 24, "X\r\nY\rZ"],
    [42, 42, " end"],
  ];
  for (const node of [base, plain]) {
    const len = node.text.length;
    out.push(
      vec(
        "replaceVectorText",
        "metric",
        false,
        { node, edits: edits.filter(([a, b]) => b <= len) },
        () =>
          edits
            .filter(([, b]) => b <= len)
            .map(([a, b, s]) => replaceVectorText(node, a, b, s)),
      ),
    );
  }
  const patches: [number, number, Record<string, unknown>][] = [
    [0, 99, { fontSize: 30, tracking: 50 }],
    [0, 99, { fill: "#00ff00" }],
    [0, 99, { fontWeight: "bold", italic: true, fill: null }],
    [2, 8, { fontWeight: 700, fontSize: 30, tracking: 50 }],
    [2, 8, { fontSize: 24, underline: false }],
    [4, 6, { fill: "#abcdef", baselineShift: 3 }],
    [4, 6, { fill: null }],
    [5, 5, { fontSize: 50 }],
    [0, 4, { tracking: null, leading: 40, upright: true }],
    [0, 4, { fontSize: 1e9 }],
    [0, 4, { colour: "#000" }],
    [0, 4, { italic: "yes" }],
    [0, 4, { fontFamily: "  " }],
  ];
  for (const node of [base, plain]) {
    out.push(
      vec("styleVectorText", "metric", false, { node, patches }, () =>
        patches.map(([a, b, p]) => {
          try {
            return styleVectorText(node, a, Math.min(b, node.text.length), p);
          } catch (e) {
            return { error: (e as Error).message };
          }
        }),
      ),
    );
  }
  const charPatches: Record<string, unknown>[] = [
    { fontFamily: " Inter ", fontWeight: "normal", fontSize: 12.5 },
    { fontWeight: 450.6, tracking: 0, leading: 0, baselineShift: -4 },
    { italic: true, underline: null, strikethrough: false },
    { fontSize: 0.1 },
    { fontWeight: "heavy" },
    { tracking: "wide" },
    { nope: 1 },
  ];
  out.push(
    vec(
      "patchVectorCharacterStyle",
      "metric",
      false,
      { patches: charPatches },
      () =>
        charPatches.map((p) => {
          try {
            return patchVectorCharacterStyle(
              {
                fontFamily: "sans-serif",
                fontWeight: 400,
                fontSize: 24,
                italic: true,
              },
              p,
              "font",
            );
          } catch (e) {
            return { error: (e as Error).message };
          }
        }),
    ),
  );
  const paraPatches: Record<string, unknown>[] = [
    { align: "center", autoLeading: 1.2, spaceBefore: 0, firstLineIndent: 10 },
    { align: "left", startIndent: null },
    { align: "middle" },
    { autoLeading: 20 },
    { spacing: 1 },
  ];
  out.push(
    vec(
      "patchVectorParagraphStyle",
      "metric",
      false,
      { patches: paraPatches },
      () =>
        paraPatches.map((p) => {
          try {
            return patchVectorParagraphStyle(
              { align: "right", startIndent: 5 },
              p,
            );
          } catch (e) {
            return { error: (e as Error).message };
          }
        }),
    ),
  );
  const frames: unknown[] = [
    { kind: "point", x: 1, y: 2, extra: true },
    { kind: "area", x: 1, y: 2, width: 3, height: 4 },
    { kind: "area", x: 1, y: 2, width: -3, height: 4 },
    {
      kind: "path",
      path: {
        closed: 1,
        anchors: [
          { x: 0, y: 0, type: "smooth" },
          { x: 5, y: 5, in: { x: 1, y: 1 } },
        ],
      },
      start: 0,
      end: 4,
      flip: 1,
      orientation: "upright",
      baseline: "center",
    },
    { kind: "path", path: { anchors: [{ x: 0, y: 0 }] } },
    { kind: "path", path: CURVE, orientation: "sideways" },
    { kind: "path", path: CURVE, baseline: "top" },
    { kind: "path", path: CURVE, start: null },
    { kind: "circle" },
    null,
    "point",
  ];
  out.push(
    vec("sanitizeVectorTextFrame", "metric", false, { values: frames }, () =>
      frames.map((f) => {
        try {
          return sanitizeVectorTextFrame(f);
        } catch (e) {
          return { error: (e as Error).message };
        }
      }),
    ),
  );
  const fields: Record<string, unknown>[] = [
    {
      text: "a\r\nb\rc",
      font: { fontSize: 30 },
      runs: [
        { length: 1, style: { fill: "#f00", fontWeight: 700 } },
        { length: "x" },
        null,
        { length: 9, style: {} },
      ],
      paragraph: { align: "center" },
      frame: { kind: "area", x: 0, y: 0, width: 10, height: 10 },
      orientation: "vertical",
    },
    { text: 5, runs: [{ length: 2, style: {} }], paragraph: { align: "left" } },
    { text: "x", orientation: "diagonal" },
    { text: "x", font: { fontWeight: 0 } },
  ];
  out.push(
    vec("sanitizeVectorTextFields", "metric", false, { values: fields }, () =>
      fields.map((f) => {
        try {
          return sanitizeVectorTextFields(f);
        } catch (e) {
          return { error: (e as Error).message };
        }
      }),
    ),
  );
  const ranges: [unknown, unknown][] = [
    [undefined, undefined],
    [2, 5],
    [5, 2],
    [-1, 3],
    [0, 99],
    [1.5, 3],
  ];
  out.push(
    vec(
      "vectorTextRange",
      "metric",
      false,
      {
        text: "Hello world",
        ranges: ranges.map(([a, b]) => [a ?? null, b ?? null]),
      },
      () =>
        ranges.map(([a, b]) => {
          try {
            return vectorTextRange("Hello world", a, b);
          } catch (e) {
            return { error: (e as Error).message };
          }
        }),
    ),
  );
  const names = [
    "  Hello\n\tworld  ",
    "",
    "   ",
    "A rather long name that goes on and on",
    "日本語テキスト",
  ];
  out.push(
    vec("vectorTextName", "metric", false, { values: names }, () =>
      names.map(vectorTextName),
    ),
  );
  const paths = [
    "M0 0 L10 0 L10 10",
    "M0 0 C10 0 20 10 30 10 Q40 0 50 10 Z",
    "M5 5",
    "M0 0 L1 1 M5 5 L6 6",
  ];
  out.push(
    vec("pathTextFrameFromBezier", "metric", false, { values: paths }, () =>
      paths.map((d) => pathTextFrameFromBezier(d as never)),
    ),
  );
  return out;
}

function documentVectors(): Entry[] {
  const out: Entry[] = [];
  const doc: VectorDocument = {
    width: 400,
    height: 300,
    nodes: NODES.map(([, , n]) => n),
  };
  for (const shaper of ["metric", "outline"] as const) {
    out.push(
      vec("vectorDocumentToSvg", shaper, true, { doc }, () =>
        vectorDocumentToSvg(doc),
      ),
    );
    out.push(
      vec("getVectorSceneRenderData", shaper, true, { doc }, () =>
        getVectorSceneRenderData({
          document: doc,
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      ),
    );
    setVectorTextShaper(SHAPERS[shaper]());
    const svg = vectorDocumentToSvg(doc);
    out.push(
      vec("parseVectorSvg", shaper, true, { svg }, () => parseVectorSvg(svg)),
    );
  }
  setVectorTextShaper(fakeOutlineShaper());
  const fx: VectorDocument = {
    width: 200,
    height: 200,
    nodes: [
      {
        ...NODES[0][2],
        effects: [{ id: "e1", type: "roundCorners", params: { radius: 2 } }],
      } as VectorNode,
    ],
  };
  out.push(
    vec(
      "vectorDocumentToSvg",
      "outline",
      true,
      { name: "text with effects", doc: fx },
      () => vectorDocumentToSvg(fx),
    ),
  );
  const fxSvg = vectorDocumentToSvg(fx);
  out.push(
    vec(
      "parseVectorSvg",
      "outline",
      true,
      { name: "text with effects", svg: fxSvg },
      () => parseVectorSvg(fxSvg),
    ),
  );
  const foreign = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="10 20" y="30" font-family="\'Helvetica Neue\', Arial" font-size="18" font-weight="bold" fill="#333" text-anchor="middle">  Hello   <tspan x="10" dy="20">second</tspan> line </text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><g transform="translate(5 5) scale(2)" fill="red" stroke="blue" stroke-width="2"><text style="font-style: italic; font-size: 12px"><tspan x="3" y="4">Only tspan</tspan></text><text>   </text></g></svg>',
  ];
  out.push(
    vec(
      "parseVectorSvg",
      "metric",
      false,
      { name: "foreign text", values: foreign },
      () => foreign.map((s) => parseVectorSvg(s)),
    ),
  );
  const keys: [VectorNode, VectorNode][] = [
    [
      NODES[0][2],
      {
        ...NODES[0][2],
        id: "p2",
        frame: { kind: "point", x: 200, y: 200 },
        font: { fontFamily: "sans-serif", fontWeight: 700, fontSize: 36 },
      } as VectorNode,
    ],
    [
      NODES[1][2],
      {
        id: "box",
        type: "path",
        fill: "#000",
        subpaths: bezierToSubpaths("M0 0 L50 0 L50 50 Z"),
      } as VectorNode,
    ],
  ];
  for (const shaper of ["metric", "outline"] as const) {
    out.push(
      vec(
        "createVectorMorph",
        shaper,
        true,
        { keys, ts: [0, 0.25, 0.5, 1] },
        () =>
          keys.map(([a, b]) => {
            const m = createVectorMorph(a, b);
            return [0, 0.25, 0.5, 1].map((t) => m.at(t));
          }),
      ),
    );
  }
  return out;
}

const STEPS: [string, Record<string, unknown>?][] = [
  ["vector.listFonts"],
  [
    "vector.addText",
    {
      text: "Hello vector",
      x: 20,
      y: 40,
      font: { fontFamily: "sans-serif", fontSize: 24 },
    },
  ],
  [
    "vector.addText",
    {
      text: "An area of text that wraps across several lines in its frame.",
      x: 20,
      y: 80,
      width: 160,
      height: 120,
      paragraph: { align: "center" },
      fill: "#123456",
      stroke: "#ff0000",
      strokeWidth: 3,
      name: "Area",
    },
  ],
  [
    "vector.addText",
    {
      text: "On a path",
      path: "M10 250 Q 150 150 300 250",
      start: 5,
      flip: true,
      baseline: "center",
      fill: {
        type: "linear",
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 1, color: "#0000ff" },
        ],
      },
    },
  ],
  [
    "vector.addText",
    {
      text: "縦書き\nVertical",
      x: 360,
      y: 20,
      textOrientation: "vertical",
      font: { fontSize: 20, upright: true },
    },
  ],
  ["vector.addText", { text: "bad", start: 3 }],
  ["vector.addText", { text: "bad", width: 3 }],
  [
    "vector.addText",
    { text: "bad", path: "M0 0 L10 0", textOrientation: "vertical" },
  ],
  ["vector.addText", { text: "bad", font: { fontSize: 0.1 } }],
  ["vector.addText", { text: "bad", parentId: "n1" }],
  ["vector.getText", { id: "n3" }],
  ["vector.getText", { id: "nope" }],
  ["vector.setText", { id: "n1", text: "Hi", start: 0, end: 5 }],
  ["vector.setText", { id: "n1", text: "x", start: 4, end: 2 }],
  [
    "vector.setText",
    { id: "n2", text: "Replaced\nwith two paragraphs", start: 0 },
  ],
  [
    "vector.setTextStyle",
    { id: "n1", start: 0, end: 2, fontWeight: 700, fontSize: 30, tracking: 50 },
  ],
  [
    "vector.setTextStyle",
    { id: "n1", start: 3, end: 9, fill: "#00ff00", underline: true },
  ],
  ["vector.setTextStyle", { id: "n1", fontFamily: "serif", fill: "#222222" }],
  ["vector.setTextStyle", { id: "n1" }],
  [
    "vector.setTextStyle",
    { id: "n1", start: 0, end: 2, fontSize: 24, tracking: null },
  ],
  [
    "vector.setParagraphStyle",
    { id: "n2", align: "right", spaceBefore: 4, autoLeading: 1.5 },
  ],
  [
    "vector.setParagraphStyle",
    { id: "n2", align: "justify", firstLineIndent: 10 },
  ],
  ["vector.setParagraphStyle", { id: "n2" }],
  ["vector.setTextFrame", { id: "n2", kind: "area", width: 200, height: 100 }],
  ["vector.setTextFrame", { id: "n2", kind: "point" }],
  ["vector.setTextFrame", { id: "n2", kind: "area" }],
  [
    "vector.setTextFrame",
    { id: "n1", kind: "path", path: "M0 0 C 50 -40 100 40 150 0", end: 4 },
  ],
  ["vector.setTextFrame", { id: "n1", start: 6, orientation: "upright" }],
  ["vector.setTextFrame", { id: "n1", kind: "path" }],
  ["vector.setTextFrame", { id: "n1", kind: "point", x: 30, y: 60 }],
  ["vector.setTextFrame", { id: "n4", kind: "point" }],
  ["vector.setTextFrame", { id: "n4", kind: "path", path: "M0 0 L 10 10" }],
  ["vector.setTextFrame", { id: "n4" }],
  ["vector.setTextOrientation", { id: "n1", orientation: "vertical" }],
  ["vector.setTextOrientation", { id: "n3", orientation: "vertical" }],
  ["vector.setTextOrientation", { id: "n1", orientation: "horizontal" }],
  ["vector.setTextOrientation", { id: "n4", orientation: "horizontal" }],
  [
    "vector.addPath",
    { d: "M20 260 C 120 200 260 300 380 240", stroke: "#111827" },
  ],
  [
    "vector.typeOnPath",
    {
      pathId: "n5",
      text: "Along the curve",
      font: { fontSize: 16 },
      paragraph: { align: "center" },
      baseline: "ascender",
    },
  ],
  ["vector.typeOnPath", { pathId: "n1" }],
  ["vector.addShape", { kind: "rect", x: 0, y: 0, width: 10, height: 10 }],
  ["vector.typeOnPath", { pathId: "n7", text: "Round", fill: "#ff00ff" }],
  ["vector.createOutlines", { ids: ["n1"] }],
  ["vector.createOutlines", { ids: ["n7"] }],
  ["vector.transform", { ids: ["n1"], sx: 2, sy: 1.5 }],
  ["vector.transform", { ids: ["n2"], rotate: 30 }],
  ["vector.transform", { ids: ["n3"], dx: 10, dy: -5, sx: 0.5 }],
  ["vector.skew", { ids: ["n4"], ax: 15 }],
  ["vector.addFrame", { x: 0, y: 300, width: 200, height: 100 }],
  ["vector.addText", { text: "In a frame", x: 20, y: 340, parentId: "n9" }],
  [
    "vector.addText",
    {
      text: "Area in a frame",
      x: 100,
      y: 320,
      width: 80,
      height: 40,
      parentId: "n9",
    },
  ],
  [
    "vector.setResizing",
    { ids: ["n10"], horizontal: "center", vertical: "bottom" },
  ],
  ["vector.setResizing", { ids: ["n11"], horizontal: "leftRight" }],
  ["vector.setFrame", { ids: ["n9"], width: 300, height: 150 }],
  ["vector.addMasterPage", { assignTo: "all" }],
  [
    "vector.addText",
    { text: "Page {page} of {pages}", x: 10, y: 320, parentId: "n12" },
  ],
  ["vector.addText", { text: "Key A", x: 20, y: 500 }],
  ["vector.addText", { text: "Key B", x: 220, y: 560, font: { fontSize: 40 } }],
  ["vector.blend", { ids: ["n14", "n15"], steps: 2 }],
  ["vector.getText", { id: "n10" }],
  ["vector.getText", { id: "n11" }],
  ["vector.getText", { id: "n13" }],
  ["vector.list"],
];

async function commandVectors(
  shaper: "metric" | "outline",
  steps: [string, Record<string, unknown>?][],
) {
  const setup = { width: 400, height: 600 };
  const host = createVectorConformanceHost(setup, {
    effects: createFakeEffectProvider(),
  });
  setVectorTextShaper(SHAPERS[shaper]());
  const out: Entry[] = [];
  const run = async (id: string, params?: Record<string, unknown>) => {
    const r = await host.callTool(
      "run_command",
      params ? { id, params } : { id },
    );
    const text = (r.content[0] as { text: string }).text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  for (const [id, params] of steps)
    out.push({
      id,
      ...(params ? { params } : {}),
      result: await run(id, params),
    });
  const svg = (await run("vector.exportSvg")) as { result?: { svg?: string } };
  const result = {
    shaper,
    setup,
    steps: out,
    document: json(host.document()),
    svg: svg.result?.svg ?? svg,
    render: json(host.render?.()),
  };
  host.dispose?.();
  return result;
}

const OUTLINE_STEPS: [string, Record<string, unknown>?][] = [
  ["vector.listFonts"],
  ["vector.addText", { text: "Outlined", x: 20, y: 40 }],
  ["vector.addText", { text: "Two fills", x: 20, y: 100, fill: "#000000" }],
  [
    "vector.setTextStyle",
    { id: "n2", start: 0, end: 3, fill: "#ff0000", strikethrough: true },
  ],
  ["vector.addText", { text: "Path", path: "M0 200 L 200 150" }],
  ["vector.setTextStyle", { id: "n3", underline: true }],
  ["vector.list"],
  ["vector.createOutlines", { ids: ["n1", "n2", "n3"] }],
  ["vector.list"],
];

async function vectors() {
  const shaper = getVectorTextShaper();
  try {
    return {
      version: 1,
      entries: [
        ...blockVectors(),
        ...nodeVectors(),
        ...editVectors(),
        ...documentVectors(),
      ],
      commands: await commandVectors("metric", STEPS),
      outlineCommands: await commandVectors("outline", OUTLINE_STEPS),
    };
  } finally {
    setVectorTextShaper(shaper);
  }
}

describe("Swift vector text test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    const now = json(await vectors());
    if (process.env.UPDATE_SWIFT_VECTORS)
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    // Numbers within relative 1e-9 (trig differs across CPUs in the last bit).
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
