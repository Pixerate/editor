import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  arrowheadInset,
  arrowheadWeight,
  dashIntervals,
  generateWidthProfile,
  hitTestVectorStroke,
  insertWidthPoint,
  isUniformWidthProfile,
  mirrorWidthProfile,
  nearestStrokePosition,
  pressureWidthProfile,
  readVectorBrushstrokePaint,
  removeWidthPoints,
  reverseWidthProfile,
  sanitizeVectorBrushstroke,
  sanitizeVectorBrushstrokePaper,
  sanitizeWidthProfile,
  setWidthPoint,
  strokePositionPoint,
  taperWaveFactor,
  variableStrokeOutline,
  variableStrokeRings,
  vectorBrushstrokeBrushError,
  vectorBrushstrokeBrushes,
  vectorBrushstrokeCharacterError,
  vectorBrushstrokeDefaultColour,
  vectorBrushstrokePaintError,
  vectorBrushstrokeReach,
  vectorStrokeOutlinePath,
  vectorStrokeParts,
  vectorStrokeReach,
  widthProfileAt,
  widthProfileMaxScale,
  widthProfilePreset,
  widthProfilePresetId,
  VECTOR_WIDTH_PRESET_IDS,
  type VectorStrokeLayer,
  type VectorStyle,
  type VectorWidthPoint,
} from "../src/vector/index.js";
import { toBezierPath, type BezierPath } from "../src/canvas/pathops/bezier.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";
import { createVectorConformanceHost } from "../src/vector/contract.js";
import { createFakeEffectProvider } from "../src/effects";

/**
 * Test vectors the Swift vector strokes (`packages/swift`, `PixerateVector`, #624) check
 * themselves against: width profiles (`width.ts`), variable-width outlines (`varstroke.ts`),
 * stroke parts, arrowheads, aligned outlines and hit-testing (`stroke.ts`) and the brushstroke
 * data (`brushstroke.ts`). Computed here from the TS core (the spec); a drift from the committed
 * file fails this test (run with UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change,
 * then rerun the Swift tests).
 *
 * Numbers compare within relative 1e-9 where they went through trig (`trig: true`: round joins
 * and caps, waves, curve fitting) and exactly otherwise. Key order is not compared.
 *
 * `commands` replays agent commands (`run_command` on `createVectorConformanceHost`) for their
 * failures and edge cases: `{ setup, steps: [{ id, params?, result }], document }`, where a
 * result is the command's JSON result or `{ error }` with the tool's error text.
 *
 * Shape: `{ version, entries: [{ fn, trig, ...inputs, out }], commands }`. Paths go in as SVG
 * path data `d` and come out as command arrays (`["M",x,y]`, `["L",x,y]`, `["C",…]`, `["Z"]`).
 */
const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateVectorTests/Fixtures/vector-stroke-vectors.json",
);

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const vec = (
  fn: string,
  trig: boolean,
  inputs: Entry,
  compute: () => unknown,
): Entry => ({ fn, trig, ...inputs, out: json(compute()) });
const P = (path: BezierPath) =>
  path.map((c) => {
    switch (c.type) {
      case "M":
      case "L":
        return [c.type, c.x, c.y];
      case "Q":
        return ["Q", c.x1, c.y1, c.x, c.y];
      case "C":
        return ["C", c.x1, c.y1, c.x2, c.y2, c.x, c.y];
      default:
        return ["Z"];
    }
  });
const B = (d: string) => toBezierPath(d);
const sym = (t: number, s: number): VectorWidthPoint => ({
  t,
  left: s,
  right: s,
});

const CURVE = "M20 100C80 20 160 180 260 100";
const ZIG = "M10 10L60 40L110 10L160 40";
const RECT = "M10 10L90 10L90 60L10 60Z";
const TWO = "M0 0L50 0M0 30C20 10 40 50 60 30";
const UTURN = "M0 0L40 0L40 0.000000000001L0 20";

const PROFILES: VectorWidthPoint[][] = [
  [],
  [sym(0, 0), sym(0.5, 1), sym(1, 0)],
  [sym(0, 0.3), sym(0.25, 1), sym(0.5, 0.3), sym(0.75, 1), sym(1, 0.3)],
  [
    { t: 0, left: 0, right: 0 },
    { t: 0.5, left: 1, right: 1 },
    { t: 0.5, left: 2.5, right: 1 },
    { t: 1, left: 0, right: 0 },
  ],
  [
    { t: 0.2, left: 2, right: 0.5 },
    { t: 0.9, left: 0.1, right: 3 },
  ],
];

function widthVectors(): Entry[] {
  const out: Entry[] = [];
  const raw: unknown[] = [
    null,
    "nope",
    [
      { t: 0.5, left: 2 },
      { t: 2, right: 3 },
      { t: -1, left: -4, right: 2000 },
    ],
    [
      { t: 0.5, left: 1, right: 1 },
      { t: 0.5, left: 3, right: 3 },
      { t: 0.1, left: 2, right: 2 },
    ],
    [
      { t: "x", left: 1 },
      { left: 1 },
      7,
      { t: 0.3 },
      { t: Number.NaN, left: 1 },
    ],
    Array.from({ length: 70 }, (_, i) => ({
      t: (70 - i) / 70,
      left: i / 10,
      right: 1,
    })),
  ];
  for (const points of raw)
    out.push(
      vec("sanitizeWidthProfile", false, { points }, () =>
        sanitizeWidthProfile(points as never),
      ),
    );
  const ts = [-0.5, 0, 0.1, 0.25, 0.4999, 0.5, 0.5001, 0.7, 0.95, 1, 1.5];
  for (const profile of PROFILES) {
    out.push(
      vec("widthProfileAt", false, { profile, ts }, () =>
        ts.map((t) => widthProfileAt(profile, t)),
      ),
    );
    out.push(
      vec("widthProfileMisc", false, { profile }, () => ({
        uniform: isUniformWidthProfile(profile),
        max: widthProfileMaxScale(profile),
        preset: widthProfilePresetId(profile),
        reversed: reverseWidthProfile(profile),
        mirrored: mirrorWidthProfile(profile),
      })),
    );
  }
  out.push(
    vec(
      "widthProfilePreset",
      false,
      { ids: [...VECTOR_WIDTH_PRESET_IDS, "bogus"] },
      () =>
        [...VECTOR_WIDTH_PRESET_IDS, "bogus"].map((id) =>
          widthProfilePreset(id),
        ),
    ),
  );
  const inserts: Entry[] = [
    { points: null, t: 0.3 },
    { points: PROFILES[1], t: 0.5, left: 2 },
    { points: PROFILES[1], t: 0.5, left: 2, right: 0.5, step: true },
    { points: PROFILES[2], t: 0.6 },
    { points: PROFILES[4], t: 1.4, right: 5000 },
  ];
  for (const e of inserts)
    out.push(
      vec("insertWidthPoint", false, e, () =>
        insertWidthPoint(
          e.points as VectorWidthPoint[] | null,
          e.t as number,
          {
            left: e.left as number | undefined,
            right: e.right as number | undefined,
          },
          { step: !!e.step },
        ),
      ),
    );
  const sets: Entry[] = [
    { points: PROFILES[2], index: 2, t: 0.9 },
    { points: PROFILES[2], index: 0, left: 4, right: -1 },
    { points: PROFILES[2], index: 9, t: 0.2 },
    { points: PROFILES[4], index: 1, t: 0.1, right: 2 },
  ];
  for (const e of sets)
    out.push(
      vec("setWidthPoint", false, e, () =>
        setWidthPoint(e.points as VectorWidthPoint[], e.index as number, {
          t: e.t as number | undefined,
          left: e.left as number | undefined,
          right: e.right as number | undefined,
        }),
      ),
    );
  out.push(
    vec(
      "removeWidthPoints",
      false,
      { points: PROFILES[2], indices: [0, 3, 9] },
      () => removeWidthPoints(PROFILES[2], [0, 3, 9]),
    ),
  );
  const gens: Entry[] = [
    {
      taper: {
        startLength: 0.3,
        endLength: 0.2,
        startWidth: 0.1,
        startEase: 0.5,
      },
    },
    { taper: { startLength: 0.8, endLength: 0.6, endWidth: 0.4, endEase: 1 } },
    { wave: { amount: 0.6, cycles: 3, phase: 45 } },
    { taper: { endLength: 0.5 }, wave: { cycles: 2 }, tolerance: 0.05 },
    { wave: { amount: 0 } },
  ];
  for (const e of gens) {
    out.push(
      vec("generateWidthProfile", !!e.wave, e, () =>
        generateWidthProfile(e as never),
      ),
    );
    out.push(
      vec("taperWaveFactor", !!e.wave, { ...e, ts }, () =>
        ts.map((t) => taperWaveFactor(t, e.taper as never, e.wave as never)),
      ),
    );
  }
  const pressures = [
    [
      { t: 0, pressure: 0.2 },
      { t: 0.3, pressure: 0.9 },
      { t: 0.6, pressure: 0.5 },
      { t: 1, pressure: 0.01 },
    ],
    [
      { t: 0, pressure: 0.5 },
      { t: 1, pressure: 0.5 },
    ],
    [
      { t: -1, pressure: 2 },
      { t: 0.5, pressure: Number.NaN },
      { t: 2, pressure: 0.25 },
    ],
  ];
  for (const samples of pressures)
    out.push(
      vec("pressureWidthProfile", false, { samples }, () =>
        pressureWidthProfile(samples),
      ),
    );
  return out;
}

function varStrokeVectors(): Entry[] {
  const out: Entry[] = [];
  const cases: Entry[] = [
    { d: CURVE, width: 8, profile: PROFILES[3] },
    { d: CURVE, width: 8, profile: PROFILES[1], cap: "round" },
    { d: ZIG, width: 10, profile: PROFILES[2], join: "miter" },
    { d: ZIG, width: 10, profile: PROFILES[4], join: "round", cap: "square" },
    { d: ZIG, width: 30, profile: PROFILES[1], join: "bevel", miterLimit: 1.5 },
    { d: RECT, width: 6, profile: PROFILES[4] },
    { d: RECT, width: 6, profile: PROFILES[1], join: "round", tolerance: 0.2 },
    {
      d: TWO,
      width: 5,
      profile: PROFILES[2],
      dash: [12, 6, 3],
      dashOffset: -4,
      cap: "round",
    },
    { d: CURVE, width: 6, profile: PROFILES[1], dash: [0, 10], cap: "round" },
    { d: UTURN, width: 6, profile: PROFILES[4] },
    { d: "M0 0L0 0", width: 6, profile: PROFILES[1] },
  ];
  for (const c of cases) {
    const { d, ...options } = c;
    out.push(
      vec("variableStrokeRings", true, c, () =>
        variableStrokeRings(B(d as string), options as never),
      ),
    );
    out.push(
      vec("variableStrokeOutline", true, c, () =>
        P(variableStrokeOutline(B(d as string), options as never)),
      ),
    );
  }
  const dashes: [number[], number, number][] = [
    [[10, 5], 0, 40],
    [[10, 5, 2], 3, 60],
    [[4, 4], -7, 30],
    [[0, 0], 0, 10],
    [[5, -2, Number.NaN, 3], 0, 20],
    [[1, 1], 0, 0],
  ];
  for (const [pattern, offset, len] of dashes)
    out.push(
      vec("dashIntervals", false, { pattern, offset, len }, () =>
        dashIntervals(pattern, offset, len),
      ),
    );
  const points: [number, number][] = [
    [50, 60],
    [140, 120],
    [0, 0],
    [260, 130],
    [120, 100],
  ];
  for (const d of [CURVE, ZIG, TWO]) {
    out.push(
      vec("nearestStrokePosition", false, { d, points }, () =>
        points.map((p) => nearestStrokePosition(B(d), p)),
      ),
    );
    out.push(
      vec("strokePositionPoint", false, { d, ts: [0, 0.3, 0.5, 1, 2] }, () =>
        [0, 1, 5].map((i) =>
          [0, 0.3, 0.5, 1, 2].map((t) => strokePositionPoint(B(d), i, t)),
        ),
      ),
    );
  }
  return out;
}

const STYLES: Partial<VectorStyle>[] = [
  {
    strokeWidth: 8,
    startArrow: "triangle",
    endArrow: "circle",
    strokeWidthProfile: PROFILES[3],
  },
  {
    strokeWidth: 4,
    startArrow: "arrow",
    endArrow: "open",
    arrowAlign: "tip",
    startArrowScale: 2,
  },
  {
    strokeWidth: 3,
    startArrow: "square",
    endArrow: "bar",
    strokeLinecap: "round",
    endArrowScale: 0.01,
  },
  {
    strokeWidth: 6,
    startArrow: "bar",
    arrowAlign: "tip",
    strokeLinecap: "square",
    strokeLinejoin: "round",
  },
  { strokeWidth: 6, strokeAlign: "inside" },
  {
    strokeWidth: 6,
    strokeAlign: "outside",
    strokeLinejoin: "bevel",
    strokeWidthProfile: PROFILES[4],
  },
  {
    strokeWidth: 5,
    strokeAlign: "inside",
    strokeDasharray: [10, 4],
    fillRule: "evenodd",
  },
  {
    strokeWidth: 2,
    endArrow: "triangle",
    arrowAlign: "tip",
    strokeWidthProfile: PROFILES[1],
    endArrowScale: 3,
  },
  { strokeWidthProfile: [sym(0, 1), sym(1, 1)], endArrow: "arrow" },
];

function strokeVectors(): Entry[] {
  const out: Entry[] = [];
  const paths = [CURVE, ZIG, RECT, TWO];
  for (const style of STYLES) {
    out.push(
      vec("strokeMisc", false, { style }, () => ({
        reach: vectorStrokeReach(style as VectorStyle),
        start: arrowheadWeight(style as VectorStyle, "start"),
        end: arrowheadWeight(style as VectorStyle, "end"),
      })),
    );
    for (const d of paths) {
      out.push(
        vec("vectorStrokeParts", false, { d, style }, () => {
          const p = vectorStrokeParts(B(d), style as VectorStyle);
          return {
            ...p,
            line: P(p.line),
            heads: p.heads.map((h) => ({ ...h, path: P(h.path) })),
          };
        }),
      );
    }
  }
  const outlines: [string, number][] = [
    [CURVE, 0],
    [ZIG, 1],
    [ZIG, 2],
    [ZIG, 3],
    [RECT, 4],
    [RECT, 5],
    [RECT, 6],
    [CURVE, 7],
    [TWO, 0],
    [TWO, 8],
  ];
  for (const [d, i] of outlines)
    out.push(
      vec("vectorStrokeOutlinePath", true, { d, style: STYLES[i] }, () =>
        P(vectorStrokeOutlinePath(B(d), STYLES[i] as VectorStyle)),
      ),
    );
  const hits: [number, number][] = [
    [20, 100],
    [12, 105],
    [140, 104],
    [140, 112],
    [262, 100],
    [276, 100],
    [10, 10],
    [13, 30],
    [6, 30],
    [50, 45],
    [161, 41],
  ];
  for (const [d, i] of [
    [CURVE, 0],
    [ZIG, 3],
    [RECT, 4],
    [RECT, 5],
    [ZIG, 2],
  ] as [string, number][]) {
    for (const tolerance of [0, 2])
      out.push(
        vec(
          "hitTestVectorStroke",
          false,
          { d, style: STYLES[i], points: hits, tolerance },
          () =>
            hits.map((p) =>
              hitTestVectorStroke(
                B(d),
                { x: p[0], y: p[1] },
                STYLES[i] as VectorStyle,
                tolerance,
              ),
            ),
        ),
      );
  }
  const kinds = [
    "triangle",
    "arrow",
    "open",
    "circle",
    "square",
    "bar",
  ] as const;
  out.push(
    vec("arrowheadInset", false, { kinds }, () =>
      kinds.map((k) => [arrowheadInset(k, 3, 0), arrowheadInset(k, 0.5, 4)]),
    ),
  );
  return out;
}

function brushstrokeVectors(): Entry[] {
  const out: Entry[] = [];
  out.push(
    vec("vectorBrushstrokeBrushes", false, {}, () =>
      vectorBrushstrokeBrushes().map((b) => ({
        id: b.id,
        name: b.name,
        category: b.category,
        size: b.tip.size,
      })),
    ),
  );
  const values: unknown[] = [
    null,
    { brushId: 7 },
    { brushId: "nope" },
    {
      brushId: "pencil-hb",
      size: 900,
      pressure: [0.2, 4, "x", -1],
      seed: 12.6,
      paper: null,
    },
    {
      brushId: "chalk",
      size: -3,
      pressure: [],
      seed: -5,
      paper: { pattern: "rough", seed: 3.2, scale: 20, depth: -1 },
    },
    {
      brushId: "marker",
      paint: {
        type: "gradient",
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 1, color: "paint" },
        ],
      },
      paper: { pattern: "bogus" },
    },
    { brushId: "ink-pen", paint: { type: "color", color: "#0f0" }, seed: 3e10 },
    { brushId: "ink-pen", paint: { type: "gradient", stops: [] } },
  ];
  for (const value of values)
    out.push(
      vec("sanitizeVectorBrushstroke", false, { value }, () =>
        sanitizeVectorBrushstroke(value),
      ),
    );
  const ids = [
    "pencil-hb",
    "chalk",
    "ballpoint",
    "highlighter",
    "eraser-soft",
    "spray-can",
    "pencil-h",
    "multicolor-flat",
    "zzz",
    "wet-smudge",
  ];
  out.push(
    vec("vectorBrushstrokeBrushError", false, { ids }, () =>
      ids.map((id) => vectorBrushstrokeBrushError(id)),
    ),
  );
  out.push(
    vec("vectorBrushstrokeDefaultColour", false, { ids }, () =>
      ids.map((id) => [
        vectorBrushstrokeDefaultColour(id, [], "light"),
        vectorBrushstrokeDefaultColour(id, [], "dark"),
      ]),
    ),
  );
  const paints: unknown[] = [
    "#ff0000",
    "red",
    { type: "color", color: "#abc" },
    {
      type: "gradient",
      stops: [
        { offset: 0, color: "#ff0000" },
        { offset: 1, color: "#0000ff" },
      ],
      map: { by: "velocity" },
    },
    {
      type: "gradient",
      stops: [
        { offset: 0, color: "#ff0000" },
        { offset: 1, color: "#0000ff" },
      ],
      map: { by: "time" },
    },
    {
      type: "gradient",
      stops: [
        { offset: 0.5, color: "#ff0000" },
        { offset: 0.2, color: "#0000ff" },
      ],
    },
    {
      type: "gradient",
      stops: [
        { offset: 0, color: "#ff0000" },
        { offset: 1, color: "secondary", opacity: 0.5, midpoint: 0.3 },
      ],
      space: "oklab",
      softness: 0.2,
      map: { by: "random", every: 3.4 },
    },
    { type: "bogus" },
  ];
  out.push(
    vec("vectorBrushstrokePaintError", false, { paints }, () =>
      paints.map((p) => [
        vectorBrushstrokePaintError(p),
        readVectorBrushstrokePaint(p),
      ]),
    ),
  );
  const characters: Entry[] = [
    {},
    { seed: 3 },
    { seed: 1.5 },
    { seed: -1 },
    { seed: 3, paper: null },
    { paper: [] },
    { paper: { pattern: "rough", grit: 2 } },
    { paper: { pattern: "nope" } },
    { paper: { seed: 2.5 } },
    { paper: { scale: 9 } },
    { paper: { depth: 2 } },
    { paper: { pattern: "canvas", seed: 4, scale: 2, depth: 0.5 } },
  ];
  out.push(
    vec("vectorBrushstrokeCharacterError", false, { characters }, () =>
      characters.map((c) => vectorBrushstrokeCharacterError(c)),
    ),
  );
  const papers: unknown[] = [
    null,
    {},
    { pattern: "linen", seed: 2.4, scale: 0.1, depth: 3 },
    { pattern: "x", scale: -1 },
  ];
  out.push(
    vec("sanitizeVectorBrushstrokePaper", false, { papers }, () =>
      papers.map((p) => sanitizeVectorBrushstrokePaper(p)),
    ),
  );
  const layers: unknown[] = [
    { kind: "brushstroke", paint: "#000", brush: { brushId: "pencil-hb" } },
    {
      kind: "brushstroke",
      paint: "#000",
      brush: { brushId: "chalk", size: 40 },
    },
    {
      kind: "brushstroke",
      paint: "#000",
      brush: { brushId: "nope", size: 40 },
    },
    { kind: "paint", paint: "#000" },
  ];
  out.push(
    vec("vectorBrushstrokeReach", false, { layers }, () =>
      layers.map((l) => vectorBrushstrokeReach(l as VectorStrokeLayer)),
    ),
  );
  return out;
}

const STEPS: [string, Record<string, unknown>?][] = [
  ["vector.addPath", { d: CURVE, stroke: "#111827", strokeWidth: 6 }],
  [
    "vector.addShape",
    { kind: "rect", x: 30, y: 120, width: 80, height: 50, fill: "#2563eb" },
  ],
  ["vector.addPath", { d: ZIG, stroke: "#16a34a", strokeWidth: 4 }],
  ["vector.setWidthProfile", { ids: ["n1"] }],
  ["vector.setWidthProfile", { ids: ["n1"], preset: "bogus" }],
  ["vector.setWidthProfile", { ids: ["nope"], preset: "bulge" }],
  ["vector.setWidthProfile", { ids: ["n1"], preset: "pressure" }],
  ["vector.setWidthProfile", { ids: ["n1"], preset: "uniform" }],
  [
    "vector.setWidthProfile",
    {
      ids: ["n1"],
      points: [
        { t: 0.8, left: 2, right: 1 },
        { t: 0.1, left: 0.5, right: 0.5 },
      ],
    },
  ],
  ["vector.setWidthProfile", { ids: ["n1"], points: null }],
  [
    "vector.setWidthProfile",
    { ids: ["n1", "n3"], taper: { startLength: 0.2, endLength: 0.3 } },
  ],
  ["vector.setWidthProfile", { ids: ["n3"], wave: { amount: 0.5, cycles: 2 } }],
  ["vector.setWidthProfile", { ids: ["n1"], taper: {} }],
  ["vector.setWidthProfile", { ids: ["n1"], preset: "taperEnd" }],
  ["vector.setWidthPoint", { id: "n1", t: 0.4, left: 9 }],
  ["vector.setWidthPoint", { id: "n1", index: 1, t: 0.95 }],
  ["vector.setWidthPoint", { id: "n1", index: 0, right: 1.5 }],
  ["vector.setWidthPoint", { id: "n1", index: 0, t: 0 }],
  ["vector.setWidthPoint", { id: "n1", index: 7 }],
  ["vector.setWidthPoint", { id: "n1", left: 3 }],
  ["vector.setWidthPoint", { id: "n2", index: 0 }],
  ["vector.setWidthPoint", { id: "nope", t: 0.5 }],
  ["vector.setWidthPoint", { id: "n1", t: -1 }],
  ["vector.setStyle", { ids: ["n2"], strokeWidth: 0 }],
  ["vector.setWidthPoint", { id: "n2", t: 0.5 }],
  [
    "vector.setStyle",
    { ids: ["n1"], startArrow: "arrow", endArrow: "bar", arrowAlign: "tip" },
  ],
  ["vector.setCorners", { ids: ["n2"] }],
  ["vector.setCorners", { ids: ["n2"], smoothing: 0.5 }],
  ["vector.setCorners", { ids: ["n2"], radius: 8, smoothing: 0.4 }],
  ["vector.setCorners", { ids: ["n2"], kind: "inverted" }],
  ["vector.setCorners", { ids: ["n2"], smoothing: 1 }],
  [
    "vector.setCorners",
    { anchors: [{ nodeId: "n2", subpath: 0, index: 1 }], radius: 0 },
  ],
  [
    "vector.setCorners",
    { anchors: [{ nodeId: "n2", subpath: 0, index: 9 }], radius: 4 },
  ],
  ["vector.setCorners", { ids: ["n3"], radius: 6, kind: "chamfer" }],
  ["vector.list"],
  [
    "vector.setStyle",
    { ids: ["n2"], stroke: "#ef4444", strokeWidth: 4, strokeAlign: "outside" },
  ],
  [
    "vector.addStroke",
    {
      ids: ["n2"],
      paint: "#000000",
      strokeWidth: 1,
      strokeDasharray: [6, 3],
      opacity: 0.5,
      blendMode: "multiply",
    },
  ],
  ["vector.outlineStroke", { ids: ["n2"] }],
  ["vector.outlineStroke", { ids: ["n6"] }],
  ["vector.outlineStroke", { ids: ["n1", "n3"] }],
  ["vector.addPath", { d: "M20 20L120 40", stroke: "#7c3aed", strokeWidth: 3 }],
  ["vector.listBrushes"],
  ["vector.addBrushstroke", { ids: ["n8"], brushId: "nope" }],
  ["vector.addBrushstroke", { ids: ["n8"], brushId: "impasto-brush" }],
  ["vector.addBrushstroke", { ids: ["n8"], brushId: "pencil-h" }],
  ["vector.addBrushstroke", { ids: ["n8"], brushId: "pencil-hb", size: 600 }],
  [
    "vector.addBrushstroke",
    { ids: ["n8"], brushId: "pencil-hb", paper: { pattern: "nope" } },
  ],
  [
    "vector.addBrushstroke",
    {
      ids: ["n8"],
      brushId: "pencil-hb",
      paint: {
        type: "gradient",
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 1, color: "#00ff00" },
        ],
        map: { by: "velocity" },
      },
    },
  ],
  [
    "vector.addBrushstroke",
    { ids: ["n8"], brushId: "pencil-hb", color: "nope" },
  ],
  ["vector.addBrushstroke", { ids: ["n8"], brushId: "ballpoint" }],
  ["vector.setColorScheme", { scheme: "dark" }],
  [
    "vector.addBrushstroke",
    {
      ids: ["n8"],
      brushId: "chalk",
      index: 0,
      opacity: 0.4,
      pressure: [0.2, 1, 0.2],
    },
  ],
  ["vector.setColorLocked", { locked: true }],
  [
    "vector.addBrushstroke",
    { ids: ["n8"], brushId: "highlighter", seed: 5, paper: null },
  ],
  ["vector.setColorLocked", { locked: false }],
  [
    "vector.addBrushstroke",
    { ids: ["n8"], brushId: "crayon", keepColour: true, color: "#123456" },
  ],
  ["vector.setBrushstroke", { id: "n8", index: 1 }],
  ["vector.setBrushstroke", { id: "n8", index: 9, size: 4 }],
  ["vector.setBrushstroke", { id: "n8", index: 1, size: 4 }],
  ["vector.setBrushstroke", { id: "n8", index: 2, brushId: "nope" }],
  ["vector.setBrushstroke", { id: "n8", index: 2, size: 700 }],
  ["vector.setBrushstroke", { id: "n8", index: 2, seed: 2.5 }],
  ["vector.setBrushstroke", { id: "n8", index: 2, paint: { type: "bogus" } }],
  [
    "vector.setBrushstroke",
    {
      id: "n8",
      index: 2,
      brushId: "ballpoint",
      size: null,
      pressure: null,
      seed: 9,
      paper: { pattern: "canvas" },
    },
  ],
  [
    "vector.setBrushstroke",
    {
      id: "n8",
      index: 2,
      brushId: "fineliner",
      keepColour: true,
      opacity: 0.3,
      paint: { type: "color", color: "#00ff00" },
    },
  ],
  [
    "vector.setBrushstroke",
    { id: "n8", index: 0, color: "#ff00ff", seed: null, paint: null },
  ],
  ["vector.setColorScheme", { scheme: "light" }],
  ["vector.listBrushes"],
  ["vector.list"],
];

/** SVG the TS exports for a profiled, arrowed stroke (Swift exports of those are not ported; its import is). */
async function profiledSvg(): Promise<string> {
  const host = createVectorConformanceHost(
    { width: 300, height: 200 },
    { effects: createFakeEffectProvider() },
  );
  await host.callTool("run_command", {
    id: "vector.addPath",
    params: { d: ZIG, stroke: "#0f766e", strokeWidth: 5, endArrow: "triangle" },
  });
  await host.callTool("run_command", {
    id: "vector.setWidthPoint",
    params: { id: "n1", t: 0.3, left: 6, right: 1.5 },
  });
  const r = await host.callTool("run_command", { id: "vector.exportSvg" });
  return JSON.parse((r.content[0] as { text: string }).text).result.svg;
}

async function commandVectors() {
  const setup = { width: 300, height: 200 };
  const svg = await profiledSvg();
  const host = createVectorConformanceHost(setup, {
    effects: createFakeEffectProvider(),
  });
  const steps: Entry[] = [];
  for (const [id, params] of [
    ...STEPS,
    ["vector.importSvg", { svg }] as [string, Record<string, unknown>],
    ["vector.list"] as [string],
  ]) {
    const r = await host.callTool(
      "run_command",
      params ? { id, params } : { id },
    );
    const text = (r.content[0] as { text: string }).text;
    steps.push({
      id,
      ...(params ? { params } : {}),
      result: r.isError ? { error: text } : JSON.parse(text),
    });
  }
  return { setup, steps, document: json(host.document()) };
}

async function vectors() {
  return {
    version: 1,
    entries: [
      ...widthVectors(),
      ...varStrokeVectors(),
      ...strokeVectors(),
      ...brushstrokeVectors(),
    ],
    commands: await commandVectors(),
  };
}

describe("Swift vector stroke test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    const now = json(await vectors());
    if (process.env.UPDATE_SWIFT_VECTORS)
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    // Numbers within relative 1e-9 (trig differs across CPUs in the last bit).
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
