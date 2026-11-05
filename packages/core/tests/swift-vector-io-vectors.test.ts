import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getVectorTextShaper,
  lottieValueAt,
  parseVectorLottie,
  quantizeVectorTraceColors,
  setVectorTextShaper,
  stylizeVectorImage,
  traceVectorImage,
  vectorDocumentToLottie,
  vectorDocumentToPdf,
  vectorTraceContours,
  type VectorDocument,
  type VectorStylizeOptions,
  type VectorStylizeStyle,
  type VectorTraceOptions,
  type VectorTracePixels,
} from "../src/vector/index.js";
import { createMetricTextShaper } from "../src/text/index.js";
import { bytesToBase64, pngDataUrl } from "../src/raster/index.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";
import { createVectorConformanceHost } from "../src/vector/contract.js";
import { createFakeEffectProvider } from "../src/effects";

/**
 * Test vectors the Swift vector import and export (`packages/swift`, `PixerateVector`, #624) check
 * themselves against: PDF export (`pdf.ts`, compared byte for byte, compressed and not, with
 * gradients as shadings, pattern tiles, graphics states, clip masks, artboard pages and the notes
 * of what is left out), Lottie export and import (`lottie.ts`: shape items, live path effects,
 * gradients, keyframes and easing, transforms and parenting, precomps, solids and masks, and round
 * trips), image tracing (`trace.ts`: marching squares, simplification, curve fitting, colour
 * quantising) and the bitmap-to-vector styles (`stylize.ts`) on small generated images, and a
 * replay of the commands with their failures. Computed here from the TS core (the spec); a drift
 * from the committed file fails this test (run with UPDATE_SWIFT_VECTORS=1 to rewrite it after an
 * intended change, then rerun the Swift tests).
 *
 * Numbers compare exactly where `trig` is false and within relative 1e-9 where they went through
 * `Math.sin` / `Math.cos` / `Math.atan2` (rotations, stars, turned grids, focal points); strings,
 * and so PDF bytes, always exactly. Key order is not compared.
 *
 * Shape: `{ version, scenes: [{ name, doc, pdf: [{ options, pdf, pages, notes }], lottie, roundTrip }],
 * entries: [{ fn, trig, ...inputs, out }], images: { name: { width, height, data } }, commands }`.
 */
const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateVectorTests/Fixtures/vector-io-vectors.json",
);

type Entry = Record<string, unknown>;
type Step = [string, Record<string, unknown>?];
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

async function runSteps(steps: Step[], setup = { width: 240, height: 200 }) {
  const host = createVectorConformanceHost(setup, {
    effects: createFakeEffectProvider(),
  });
  const results: unknown[] = [];
  for (const [id, params] of steps) {
    const r = await host.callTool(
      "run_command",
      params ? { id, params } : { id },
    );
    const text = (r.content[0] as { text: string }).text;
    results.push(r.isError ? { error: text } : JSON.parse(text));
  }
  return { host, results };
}

const STOPS = [
  { offset: 0, color: "#ff0000" },
  { offset: 0.4, color: "#00aa00" },
  { offset: 1, color: "#0000ff" },
];

/** Scenes built with commands, then patched where no command sets the field. */
const SCENES: {
  name: string;
  trig: boolean;
  steps: Step[];
  patch?: (doc: VectorDocument) => void;
}[] = [
  {
    name: "basic",
    trig: false,
    steps: [
      ["vector.addShape", { kind: "rect", x: 10, y: 10, width: 50, height: 30, fill: "#2563eb" }],
      ["vector.addShape", { kind: "ellipse", x: 50, y: 40, width: 40, height: 40, fill: "#e11d48", stroke: "#111111", strokeWidth: 2, strokeDasharray: [4, 2], strokeLinecap: "round", strokeLinejoin: "bevel" }],
      ["vector.addPath", { d: "M100 100 Q 140 60 180 100 L 180 150 Z", fill: "#22c55e80", fillRule: "evenodd" }],
      ["vector.addShape", { kind: "line", x: 20, y: 160, width: 100, height: 20, stroke: "#333333", strokeWidth: 3, strokeLinecap: "square" }],
    ],
    patch: (doc) => {
      (doc as { background?: string }).background = "#fafafa";
    },
  },
  {
    name: "paint",
    trig: true,
    steps: [
      ["vector.addShape", { kind: "rect", x: 10, y: 10, width: 80, height: 50 }],
      ["vector.setGradient", { ids: ["n1"], type: "linear", angle: 30, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff", opacity: 0.5 }] }],
      ["vector.addShape", { kind: "ellipse", x: 100, y: 10, width: 60, height: 60 }],
      ["vector.setGradient", { ids: ["n2"], type: "radial", stops: STOPS, focal: { x: 120, y: 30 }, units: "userSpaceOnUse", start: { x: 130, y: 40 }, end: { x: 160, y: 40 } }],
      ["vector.addShape", { kind: "star", x: 10, y: 80, width: 60, height: 60, points: 5 }],
      ["vector.setGradient", { ids: ["n3"], type: "conic", stops: STOPS }],
      ["vector.addShape", { kind: "polygon", x: 90, y: 80, width: 60, height: 60, sides: 6 }],
      ["vector.setGradient", { ids: ["n4"], type: "diamond", stops: STOPS, spread: "repeat" }],
      ["vector.addShape", { kind: "rect", x: 170, y: 80, width: 50, height: 50, fill: "#ffcc00", stroke: "#000000", strokeWidth: 4 }],
      ["vector.setGradient", { ids: ["n5"], target: "stroke", type: "linear", stops: STOPS }],
      ["vector.addFill", { ids: ["n5"], paint: "#00ffff", opacity: 0.5, blendMode: "screen" }],
      ["vector.addShape", { kind: "rect", x: 10, y: 150, width: 60, height: 40 }],
      ["vector.setMeshGradient", { ids: ["n6"], rows: 1, columns: 1, corners: ["#ff0000", "#00ff00", "#0000ff", "#ffffff"] }],
      ["vector.addShape", { kind: "rect", x: 90, y: 150, width: 60, height: 40, fill: "#123456" }],
      ["vector.setBlendMode", { ids: ["n7"], blendMode: "linear-dodge" }],
    ],
  },
  {
    name: "structure",
    trig: true,
    steps: [
      ["vector.addShape", { kind: "rect", x: 10, y: 10, width: 60, height: 40, fill: "#ff8800" }],
      ["vector.addShape", { kind: "ellipse", x: 40, y: 30, width: 50, height: 50, fill: "#0088ff" }],
      ["vector.group", { ids: ["n1", "n2"], name: "Pair" }],
      ["vector.setBlendMode", { ids: ["n3"], blendMode: "multiply" }],
      ["vector.addShape", { kind: "rect", x: 120, y: 10, width: 80, height: 60, fill: "#22aa22" }],
      ["vector.addShape", { kind: "ellipse", x: 130, y: 20, width: 60, height: 60, fill: "#000000" }],
      ["vector.makeClippingMask", { ids: ["n4", "n5"] }],
      ["vector.addShape", { kind: "rect", x: 20, y: 110, width: 50, height: 50, fill: "#aa00aa" }],
      ["vector.addFilter", { ids: ["n7"], type: "dropShadow" }],
      ["vector.addShape", { kind: "polygon", x: 100, y: 110, width: 50, height: 50, sides: 5, fill: "#336699" }],
      ["vector.transform", { ids: ["n8"], rotate: 30 }],
      ["vector.addText", { text: "Hello", x: 160, y: 150 }],
    ],
    patch: (doc) => {
      const pair = doc.nodes.find((n) => n.id === "n3") as { opacity?: number };
      pair.opacity = 0.5;
      (doc.nodes.find((n) => n.id === "n8") as { opacity?: number }).opacity = 0.75;
    },
  },
  {
    name: "effects",
    trig: true,
    steps: [
      ["vector.addShape", { kind: "rect", x: 10, y: 10, width: 50, height: 50, fill: "#ff0000", stroke: "#000000", strokeWidth: 2 }],
      ["vector.addEffect", { ids: ["n1"], type: "trim", params: { start: 10, end: 80, offset: 15, mode: "individual" } }],
      ["vector.addShape", { kind: "star", x: 80, y: 10, width: 50, height: 50, fill: "#00aa00" }],
      ["vector.addEffect", { ids: ["n2"], type: "roundCorners", params: { radius: 6 } }],
      ["vector.addEffect", { ids: ["n2"], type: "repeater", params: { copies: 3, position: { x: 10, y: 0 }, rotation: 15 } }],
      ["vector.addEffect", { ids: ["n2"], type: "puckerBloat", params: { amount: 20 } }],
      ["vector.addShape", { kind: "polygon", x: 150, y: 10, width: 60, height: 60, sides: 6, fill: "#0000ff" }],
      ["vector.addEffect", { ids: ["n3"], type: "twist", params: { angle: 40, center: { x: 5, y: -5 } } }],
      ["vector.addEffect", { ids: ["n3"], type: "zigzag", params: { size: 3, ridges: 4, smooth: true } }],
      ["vector.addShape", { kind: "ellipse", x: 10, y: 100, width: 60, height: 40, fill: "#888888" }],
      ["vector.addEffect", { ids: ["n4"], type: "offset", params: { amount: 4, join: "round", copies: 2 } }],
      ["vector.addShape", { kind: "rect", x: 100, y: 100, width: 50, height: 50, fill: "#ffaa00" }],
      ["vector.addShape", { kind: "ellipse", x: 120, y: 120, width: 50, height: 50, fill: "#00aaff" }],
      ["vector.boolean", { operation: "subtract", ids: ["n5", "n6"], live: true }],
      ["vector.addShape", { kind: "rect", x: 180, y: 130, width: 40, height: 40, fill: "#663399" }],
      ["vector.addEffect", { ids: ["n8"], type: "wiggle", params: { size: 3, detail: 4, seed: 7 } }],
      ["vector.addEffect", { ids: ["n8"], type: "merge", params: { mode: "add" } }],
    ],
  },
  {
    name: "artboards",
    trig: false,
    steps: [
      ["vector.addFrame", { x: 0, y: 0, width: 100, height: 80, name: "One", fill: "#ffffff" }],
      ["vector.addShape", { kind: "rect", x: 10, y: 10, width: 120, height: 30, fill: "#ff0000", parentId: "n1" }],
      ["vector.addFrame", { x: 120, y: 0, width: 100, height: 80, name: "Two", fill: "#eeeeee" }],
      ["vector.addShape", { kind: "ellipse", x: 20, y: 20, width: 40, height: 40, fill: "#0000ff", parentId: "n3" }],
    ],
  },
];

const PDF_OPTIONS = [
  { compress: false },
  {},
  { scale: 2, title: "Ünïcode (test) \\ ✓", compress: false },
  { pages: "artboards" as const, compress: false },
];

async function scenes() {
  const out: Entry[] = [];
  for (const scene of SCENES) {
    const { host, results } = await runSteps(scene.steps);
    const doc = json((host.document() as { document: VectorDocument }).document);
    scene.patch?.(doc);
    const pdf = PDF_OPTIONS.map((options) => {
      const r = vectorDocumentToPdf(doc, options);
      return { options, pdf: bytesToBase64(r.bytes), pages: r.pages, notes: r.notes };
    });
    const lottie = vectorDocumentToLottie(doc, { fps: 24, frames: 12, name: scene.name });
    const roundTrip = parseVectorLottie(lottie.lottie, { idPrefix: "rt" });
    out.push({ name: scene.name, trig: scene.trig, steps: results, doc, pdf, lottie, roundTrip });
    host.dispose?.();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lottie import
// ---------------------------------------------------------------------------

const k = (v: unknown) => ({ a: 0, k: v });
const LOTTIES: { name: string; lottie: unknown; frames: number[] }[] = [
  {
    name: "shapes",
    frames: [0],
    lottie: {
      v: "5.7.0", fr: 30, ip: 0, op: 30, w: 200, h: 150,
      layers: [
        {
          ty: 4, ind: 1, nm: "Shapes", ip: 0, op: 30, ks: { p: k([10, 20]), r: k(15), s: k([120, 80]), o: k(80), a: k([5, 5]) },
          shapes: [
            { ty: "el", p: k([40, 40]), s: k([50, 30]) },
            { ty: "sr", sy: 1, pt: k(5), p: k([100, 60]), r: k(10), or: k(30), ir: k(12), os: k(10) },
            { ty: "sr", sy: 2, pt: k(6), p: k([150, 60]), r: k(0), or: k(25) },
            { ty: "st", c: k([0.1, 0.2, 0.3, 1]), o: k(50), w: k(3), lc: 2, lj: 3, d: [{ n: "d", v: k(5) }, { n: "g", v: k(2) }, { n: "o", v: k(1) }] },
            { ty: "fl", c: k([255, 128, 0, 255]), o: k(100), r: 2, bm: 1 },
            { ty: "rc", p: k([20, 120]), s: k([30, 20]), r: k(4) },
            { ty: "gf", o: k(100), s: k([0, 0]), e: k([30, 0]), t: 2, h: k(40), a: k(30), g: { p: 2, k: k([0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0.25]) } },
            { ty: "xx" },
          ],
        },
        { ty: 1, ind: 2, nm: "Solid", ks: {}, sw: 40, sh: 30, sc: "#334455", masksProperties: [{ mode: "a", pt: k({ c: true, v: [[0, 0], [40, 0], [20, 30]], i: [[0, 0], [5, 0], [0, 0]], o: [[0, 0], [0, 5], [0, 0]] }) }, { mode: "s", pt: k({ c: true, v: [[0, 0], [1, 1], [0, 1]] }) }] },
        { ty: 2, ind: 3, nm: "Image" },
        { ty: 5, ind: 4, nm: "Text", td: 1, ef: [{}] },
      ],
    },
  },
  {
    name: "animated",
    frames: [0, 5, 10, 15, 30],
    lottie: {
      v: "5.7.0", fr: 30, ip: 0, op: 60, w: 100, h: 100,
      assets: [
        {
          id: "comp1",
          layers: [{ ty: 4, ind: 1, ks: { p: { a: 1, k: [{ t: 0, s: [0, 0], e: [20, 0] }, { t: 10, s: [20, 0] }] } }, shapes: [{ ty: "rc", p: k([10, 10]), s: k([10, 10]) }, { ty: "fl", c: k([0, 0, 1, 1]) }] }],
        },
      ],
      layers: [
        { ty: 3, ind: 1, nm: "Null", ks: { p: k([50, 50]), r: { a: 1, k: [{ t: 0, s: [0], o: { x: [0.4], y: [0] }, i: { x: [0.6], y: [1] } }, { t: 20, s: [90] }] } } },
        {
          ty: 4, ind: 2, parent: 1, nm: "Child", ks: { o: { a: 1, k: [{ t: 0, s: [100], h: 1 }, { t: 10, s: [40] }] }, p: { s: true, x: k(5), y: k(-5) } },
          shapes: [
            {
              ty: "gr", nm: "Inner", bm: 3,
              it: [
                { ty: "sh", ks: { a: 1, k: [{ t: 0, s: [{ c: false, v: [[0, 0], [10, 0]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] }] }, { t: 10, s: [{ c: true, v: [[0, 0], [10, 0], [5, 8]] }] }] } },
                { ty: "tm", s: k(0), e: { a: 1, k: [{ t: 0, s: [0] }, { t: 30, s: [100] }] }, o: k(0), m: 2 },
                { ty: "rp", c: k(3), o: k(0), m: 1, tr: { p: k([5, 0]), r: k(10), so: k(100), eo: k(50) } },
                { ty: "tr", p: k([1, 2]), o: k(50), sk: k(5) },
              ],
            },
            { ty: "op", a: k(2), lj: 2, ml: k(0) },
            { ty: "mm", mm: 3 },
            { ty: "tw", a: k(30), c: k([4, 4]) },
            { ty: "zz", s: k(2), r: k(3), pt: k(2) },
            { ty: "pb", a: k(-10) },
            { ty: "rd", r: k(2), hd: true },
            { ty: "st", c: k([1, 0, 0, 1]), w: k(1) },
            { ty: "gs", o: k(80), w: k(2), s: k([0, 0]), e: k([10, 10]), t: 1, g: { p: 2, k: k([0, 1, 1, 1, 1, 0, 0, 0]) } },
          ],
        },
        { ty: 0, ind: 3, nm: "Precomp", refId: "comp1", st: 2, ks: { s: k([50, 50]) } },
        { ty: 4, ind: 4, nm: "Late", ip: 20, op: 40, ks: { x: "expression" }, shapes: [{ ty: "rc", p: k([0, 0]), s: k([4, 4]) }] },
      ],
    },
  },
];

function lottieImports(): Entry[] {
  const out: Entry[] = [];
  for (const l of LOTTIES)
    for (const frame of l.frames) {
      const r = parseVectorLottie(l.lottie, { frame, idPrefix: "lt" });
      out.push({ fn: "parseVectorLottie", trig: true, name: l.name, lottie: l.lottie, frame, out: r });
    }
  out.push({ fn: "parseVectorLottie", trig: true, name: "text", lottie: JSON.stringify(LOTTIES[0].lottie), out: parseVectorLottie(JSON.stringify(LOTTIES[0].lottie)) });
  const props = [
    5,
    [1, 2],
    { a: 0, k: 7 },
    { a: 0, k: [3, 4] },
    { a: 1, k: [{ t: 0, s: [0, 10] }, { t: 10, s: [10, 30] }] },
    { a: 1, k: [{ t: 0, s: [0], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } }, { t: 10, s: [100] }] },
    { a: 1, k: [{ t: 0, s: [0], h: 1 }, { t: 10, s: [50] }] },
    { k: [{ t: 0, s: [1], e: [2] }, { t: 10 }] },
    { a: 1, k: [] },
    null,
  ];
  out.push({
    fn: "lottieValueAt",
    trig: false,
    props,
    frames: [-5, 0, 2.5, 5, 10, 20],
    out: props.map((p) => [-5, 0, 2.5, 5, 10, 20].map((f) => lottieValueAt(p, f))),
  });
  for (const bad of ["{", 5, { layers: 3 }, []]) {
    let error: string | null = null;
    try {
      parseVectorLottie(bad);
    } catch (e) {
      error = (e as Error).message;
    }
    // JSON.parse messages are V8's: only that it failed is compared for text that is not JSON.
    out.push({ fn: "parseVectorLottieError", trig: false, input: bad, out: typeof bad === "string" ? "SyntaxError" : error });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function image(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]): VectorTracePixels {
  const data: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.push(...px(x, y));
  return { width, height, data };
}

const IMAGES: Record<string, VectorTracePixels> = {
  // A dark ring with a hole on white, soft edges.
  ring: image(16, 14, (x, y) => {
    const d = Math.hypot(x - 7.5, y - 6.5);
    const v = d > 5.5 || d < 2.5 ? 245 : d > 5 || d < 3 ? 120 : 20;
    return [v, v, v, 255];
  }),
  // Four colour blocks and a transparent corner.
  blocks: image(12, 12, (x, y) => {
    if (x >= 9 && y >= 9) return [0, 0, 0, 0];
    if (x < 6 && y < 6) return [220, 30, 30, 255];
    if (x >= 6 && y < 6) return [30, 200, 60, 255];
    if (x < 6) return [20, 60, 200, 255];
    return [240, 240, 240, 255];
  }),
  // A diagonal gradient with alpha.
  gradient: image(10, 8, (x, y) => [x * 25, y * 30, 128, Math.min(255, 60 + (x + y) * 15)]),
  // Hard pixel edges: an L shape for square corners.
  ell: image(9, 9, (x, y) => ((x >= 2 && x <= 3 && y >= 1 && y <= 7) || (y >= 6 && y <= 7 && x >= 2 && x <= 7) ? [0, 0, 0, 255] : [255, 255, 255, 255])),
};

const TRACES: [string, VectorTraceOptions][] = [
  ["ring", {}],
  ["ring", { threshold: 0.3, tolerance: 0.5, cornerRoundness: 0 }],
  ["ring", { cornerRoundness: 1, minArea: 2, color: "#ff0000" }],
  ["blocks", { mode: "color", colors: 4 }],
  ["blocks", { mode: "color", colors: 2, cornerRoundness: 0.2 }],
  ["blocks", { channel: "alpha", minArea: 0 }],
  ["gradient", { mode: "color", colors: 5, minArea: 1 }],
  ["gradient", { channel: "alpha", threshold: 0.6 }],
  ["ell", { squareCorners: true, cornerRoundness: 0 }],
  ["ell", { squareCorners: true }],
  ["ell", { minArea: 0, tolerance: 0.1 }],
];

const STYLES: [string, VectorStylizeStyle, VectorStylizeOptions, boolean][] = [
  ["blocks", "mosaic", { cell: 2 }, false],
  ["blocks", "mosaic", { cell: 3, shape: "circle", gap: 0.3, colors: 3 }, false],
  ["gradient", "mosaic", { cell: 1.5 }, false],
  ["ring", "halftone", { cell: 2 }, true],
  ["blocks", "halftone", { cell: 2.5, angle: 20, color: null, colors: 4 }, true],
  ["ring", "lowPoly", { cell: 3, seed: 1 }, false],
  ["blocks", "lowPoly", { cell: 2, seed: 42, jitter: 0.5, colors: 3 }, false],
  ["gradient", "lowPoly", { cell: 4, seed: -3.6 }, false],
  ["ring", "hatch", { cell: 2 }, true],
  ["gradient", "hatch", { cell: 1.5, angle: -30, color: "#123456" }, true],
];

function imageEntries(): Entry[] {
  const out: Entry[] = [];
  for (const [img, options] of TRACES) out.push({ fn: "traceVectorImage", trig: false, image: img, options, out: traceVectorImage(IMAGES[img], options) });
  for (const [img, count] of [["blocks", 3], ["gradient", 6], ["ring", 2]] as const) {
    const q = quantizeVectorTraceColors(IMAGES[img], count);
    out.push({ fn: "quantizeVectorTraceColors", trig: false, image: img, count, out: { palette: q.palette, index: [...q.index], counts: q.counts } });
  }
  const field = [0, 0.2, 0.9, 0.9, 0.1, 0.8, 0.3, 0.7, 0.6, 0.6, 0.6, 0.5];
  out.push({ fn: "vectorTraceContours", trig: false, field, w: 4, h: 3, threshold: 0.5, out: vectorTraceContours(field, 4, 3, 0.5) });
  for (const [img, style, options, trig] of STYLES) out.push({ fn: "stylizeVectorImage", trig, image: img, style, options, out: stylizeVectorImage(IMAGES[img], style, options) });
  for (const [style, options] of [["mosaic", { cell: 0.5 }], ["hatch", { cell: 1 }], ["mosaic", { cell: 1 }]] as const) {
    let error: string | null = null;
    try {
      stylizeVectorImage(style === "hatch" ? { width: 400, height: 400, data: new Uint8Array(400 * 400 * 4) } : style === "mosaic" && options.cell === 1 ? { width: 300, height: 300, data: new Uint8Array(300 * 300 * 4) } : IMAGES.ring, style, options);
    } catch (e) {
      error = (e as Error).message;
    }
    out.push({ fn: "stylizeError", trig: false, style, options, out: error });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const url = (img: VectorTracePixels) => pngDataUrl(img.width, img.height, img.data);

function commandSteps(): Step[] {
  return [
    ["vector.addShape", { kind: "rect", x: 10, y: 10, width: 40, height: 30, fill: "#2563eb" }],
    ["vector.exportPdf", { compress: true, title: "Commands" }],
    ["vector.exportPdf", { pages: "artboards", scale: 0.5 }],
    ["vector.exportLottie", { ids: ["n1"], fps: 25, name: "One" }],
    ["vector.exportLottie", { ids: ["nope"] }],
    ["vector.importLottie", { lottie: JSON.stringify(LOTTIES[0].lottie), frame: 0 }],
    ["vector.importLottie", { lottie: { layers: [] } }],
    ["vector.importLottie", { lottie: { nope: 1 } }],
    ["vector.traceImage", { image: url(IMAGES.ring), x: 100, y: 20, width: 32, name: "Ring" }],
    ["vector.traceImage", { image: url(IMAGES.blocks), mode: "color", colors: 3, tolerance: 0.5 }],
    ["vector.traceImage", { image: "data:image/gif;base64,R0lGOD", mode: "color" }],
    ["vector.traceImage", { image: "data:image/png;base64,iVBORw0KGgoAAAAN" }],
    ["vector.traceImage", { image: url(IMAGES.ring), color: "notacolour" }],
    ["vector.traceImage", { image: url({ width: 4, height: 4, data: new Array(64).fill(255) }) }],
    ["vector.mosaicImage", { image: url(IMAGES.blocks), cell: 3, x: 150, y: 150, width: 24 }],
    ["vector.halftoneImage", { image: url(IMAGES.ring), cell: 2, color: null, colors: 2 }],
    ["vector.lowPolyImage", { image: url(IMAGES.gradient), cell: 3, seed: 5, name: "Poly" }],
    ["vector.hatchImage", { image: url(IMAGES.ring), cell: 2, angle: 10 }],
    ["vector.hatchImage", { image: url({ width: 4, height: 4, data: new Array(64).fill(255) }) }],
    ["vector.mosaicImage", { image: url(IMAGES.ring), color: "bad" }],
    ["vector.list"],
  ];
}

async function commands() {
  const setup = { width: 200, height: 200 };
  const steps = commandSteps();
  const { host, results } = await runSteps(steps, setup);
  const out = { setup, steps: steps.map(([id, params], i) => ({ id, ...(params ? { params } : {}), result: results[i] })), document: json(host.document()) };
  host.dispose?.();
  return out;
}

async function vectors() {
  const shaper = getVectorTextShaper();
  setVectorTextShaper(createMetricTextShaper());
  try {
    return {
      version: 1,
      images: Object.fromEntries(Object.entries(IMAGES).map(([k, v]) => [k, { width: v.width, height: v.height, data: [...v.data] }])),
      scenes: await scenes(),
      entries: [...lottieImports(), ...imageEntries()],
      commands: await commands(),
    };
  } finally {
    setVectorTextShaper(shaper);
  }
}

describe("Swift vector import and export test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    const now = json(await vectors());
    if (process.env.UPDATE_SWIFT_VECTORS)
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    // Numbers within relative 1e-9 (trig differs across CPUs in the last bit).
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
