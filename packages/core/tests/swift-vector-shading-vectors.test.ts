import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  autoVectorFreeformGradient,
  bezierToSubpaths,
  createVectorMeshGradient,
  expandVectorGradientSpread,
  expandVectorGradientStops,
  nearestVectorShadingPoint,
  removeVectorFreeformPoint,
  sampleVectorFreeform,
  sampleVectorGradient,
  sanitizeVectorShadedPaint,
  spanVectorGradientStops,
  transformVectorShadedPaint,
  vectorFreeformField,
  vectorFreeformLineSegments,
  vectorGradientSvgDefs,
  vectorMeshColorAt,
  vectorMeshLines,
  vectorMeshPointAt,
  vectorPaintToSvg,
  vectorRgbaToCss,
  vectorShadedSvgDefs,
  vectorStrokeGradientDefs,
  type VectorBounds,
  type VectorFreeformGradient,
  type VectorGradient,
  type VectorMatrix,
  type VectorMeshGradient,
  type VectorPathNode,
  type VectorRgba,
} from "../src/vector/index.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";
import { createVectorConformanceHost } from "../src/vector/contract.js";
import { createFakeEffectProvider } from "../src/effects";

/**
 * Test vectors the Swift vector shading (`packages/swift`, `PixerateVector`, #624) checks itself
 * against: gradient meshes and freeform gradients (`shading.ts`), stop expansion, spread periods
 * and the conic / diamond paint servers (`gradient.ts`) and gradients along or across a stroke
 * (`gradientStroke.ts`). Computed here from the TS core (the spec); a drift from the committed
 * file fails this test (run with UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change,
 * then rerun the Swift tests).
 *
 * Numbers compare within relative 1e-9 where they went through trig or square roots
 * (`trig: true`) and exactly otherwise; strings (path data, colours, offsets) always exactly.
 * Key order is not compared.
 *
 * `commands` replays agent commands (`run_command` on `createVectorConformanceHost`) for their
 * failures and edge cases: `{ setup, steps: [{ id, params?, result }], document, svg, render }`,
 * where a result is the command's JSON result or `{ error }` with the tool's error text. The
 * exported SVG and the scene render data hold freeform gradients (a pattern of about a hundred
 * strips of a hundred stops each), so they are stored as `{ length, sha256 }` of the SVG text
 * and of the render data's JSON (object keys sorted); the export is then imported back (`replace: true`) and listed.
 *
 * Shape: `{ version, entries: [{ fn, trig, ...inputs, out }], commands }`. Nodes go in as
 * `{ d, style }` (SVG path data and style fields).
 */
const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateVectorTests/Fixtures/vector-shading-vectors.json",
);

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const vec = (
  fn: string,
  trig: boolean,
  inputs: Entry,
  compute: () => unknown,
): Entry => ({ fn, trig, ...inputs, out: json(compute()) });

const pathNode = (d: string, style: Record<string, unknown> = {}) =>
  ({
    id: "p",
    type: "path",
    subpaths: bezierToSubpaths(d),
    ...style,
  }) as VectorPathNode;

const BOX: VectorBounds = { x: 10, y: 20, width: 120, height: 80 };
const MESH: VectorMeshGradient = {
  type: "mesh",
  rows: 2,
  columns: 2,
  points: [
    { x: 10, y: 20 },
    { x: 70, y: 18 },
    { x: 130, y: 20 },
    { x: 8, y: 60 },
    { x: 80, y: 55 },
    { x: 132, y: 62 },
    { x: 10, y: 100 },
    { x: 70, y: 104 },
    { x: 130, y: 100 },
  ],
  colors: [
    "#ef4444",
    "#22c55e",
    "#3b82f6",
    "#facc15",
    "#ffffff",
    "#a855f7",
    "#14b8a6",
    "#f97316",
    "rgba(17,24,39,0.5)",
  ],
  opacities: [1, 1, 0.5, 1, 0, 1, 1, 1, 1],
};
const FREE: VectorFreeformGradient = {
  type: "freeform",
  points: [
    { x: 20, y: 30, color: "#f97316" },
    { x: 120, y: 90, color: "#0ea5e9", opacity: 0.4 },
    { x: 70, y: 60, color: "#a855f7", spread: 0.3 },
    { x: 110, y: 30, color: "#22c55e" },
  ],
  lines: [
    [0, 2, 1],
    [3, 2],
  ],
};

function shadingVectors(): Entry[] {
  const out: Entry[] = [];
  const raw: unknown[] = [
    null,
    "mesh",
    { type: "mesh", rows: 1, columns: 1 },
    MESH,
    { ...MESH, opacities: [1, 2, -1, 0.5, 0, 1, 1, 1, 1] },
    { ...MESH, opacities: [1, 1] },
    { ...MESH, rows: 1.5 },
    { ...MESH, rows: 33, columns: 1 },
    { ...MESH, colors: [...MESH.colors.slice(0, 8), "nope"] },
    { ...MESH, points: [...MESH.points.slice(0, 8), { x: 1 }] },
    { ...MESH, points: [...MESH.points.slice(0, 8), 7] },
    {
      type: "mesh",
      rows: 1,
      columns: 1,
      points: [
        { x: 0, y: 0, extra: 1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ],
      colors: ["red", "#fff", "#000", "white"],
    },
    FREE,
    { type: "freeform", points: [] },
    { type: "freeform", points: [{ x: 1, y: 2 }] },
    {
      type: "freeform",
      points: [
        { x: 1, y: 2, color: "#fff", opacity: 1.5, spread: 2, extra: true },
        { x: 3, y: 4, color: "black", opacity: -1, spread: -1 },
        { x: 5, y: 6, color: "#123", opacity: 0.25, spread: 0.5 },
      ],
      lines: [
        [0, 1],
        [1, 1, 2],
        [0],
        [0, 3],
        [0, 1.5],
        "x",
        [2, 0, 2],
        [-1, 0],
      ],
    },
    { type: "freeform", points: FREE.points, lines: "nope" },
    { type: "freeform", points: FREE.points, lines: [[0]] },
    { type: "linear", stops: [] },
  ];
  out.push(
    vec("sanitizeVectorShadedPaint", false, { values: raw }, () =>
      raw.map((v) => sanitizeVectorShadedPaint(v)),
    ),
  );
  for (const [rows, columns, colors] of [
    [2, 3, undefined],
    [1, 1, { colors: ["#ff0000", "", "#00ff00", "#0000ff"] }],
    [2, 2, { corners: ["#ff0000", "#00ff00", "rgba(0,0,255,0.5)", "nope"] }],
    [0.4, 40.2, undefined],
    [1.5, 2.5, { corners: ["#000000", "#ffffff", "#ffffff", "#000000"] }],
  ] as [
    number,
    number,
    (
      | { colors?: string[]; corners?: [string, string, string, string] }
      | undefined
    ),
  ][])
    out.push(
      vec(
        "createVectorMeshGradient",
        false,
        { bounds: BOX, rows, columns, ...(colors ?? {}) },
        () => createVectorMeshGradient(BOX, rows, columns, colors),
      ),
    );
  const uv: [number, number, number, number][] = [
    [0, 0, 0, 0],
    [0, 1, 0.5, 0.25],
    [1, 0, 0.3, 0.9],
    [1, 1, 1, 1],
    [1, 1, 0.75, 0.1],
  ];
  out.push(
    vec("vectorMeshSample", false, { mesh: MESH, uv }, () =>
      uv.map(([i, j, u, v]) => ({
        point: vectorMeshPointAt(MESH, i, j, u, v),
        color: vectorMeshColorAt(MESH, i, j, u, v),
      })),
    ),
  );
  out.push(
    vec("vectorMeshLines", false, { mesh: MESH }, () => vectorMeshLines(MESH)),
  );
  const LINES: VectorFreeformGradient = {
    ...FREE,
    lines: [
      [0, 2, 1],
      [3, 2],
      [0, 9],
      [1, 0, 3, 2],
    ],
  };
  out.push(
    vec(
      "vectorFreeformLineSegments",
      false,
      { gradient: LINES, lines: [0, 1, 2, 3, 4] },
      () =>
        [0, 1, 2, 3, 4].map((l) =>
          vectorFreeformLineSegments(LINES, l).map((c) =>
            c.map(({ x, y }) => ({ x, y })),
          ),
        ),
    ),
  );
  const spots = [
    { x: 20, y: 30 },
    { x: 70, y: 60 },
    { x: 75, y: 62 },
    { x: 100, y: 45 },
    { x: 0, y: 0 },
    { x: 130, y: 100 },
    { x: 64.5, y: 59 },
  ];
  for (const [gradient, scale] of [
    [FREE, 60],
    [{ ...FREE, lines: undefined }, 60],
    [{ ...FREE, lines: undefined }, 0],
    [
      {
        type: "freeform",
        points: [{ x: 5, y: 5, color: "#ff0000", spread: 1 }],
      },
      10,
    ],
    [
      {
        type: "freeform",
        points: [
          { x: 5, y: 5, color: "#ff0000" },
          { x: 5, y: 5, color: "#0000ff" },
        ],
        lines: [[0, 1]],
      },
      10,
    ],
  ] as [VectorFreeformGradient, number][])
    out.push(
      vec(
        "sampleVectorFreeform",
        true,
        { gradient, scale, points: spots },
        () => {
          const field = vectorFreeformField(gradient, scale);
          return spots.map((p) => sampleVectorFreeform(field, p));
        },
      ),
    );
  const circleCases: [
    VectorBounds,
    string[],
    { cx: number; cy: number; r: number } | null,
  ][] = [
    [BOX, ["#ff0000", "#0000ff"], null],
    [BOX, [], { cx: 70, cy: 60, r: 40 }],
    [
      { x: 0, y: 0, width: 40, height: 200 },
      ["#ff0000", "#00ff00", "#0000ff"],
      { cx: 20, cy: 100, r: 20 },
    ],
    [
      { x: 0, y: 0, width: 100, height: 100 },
      ["#123456"],
      { cx: 50, cy: 50, r: 50 },
    ],
    [{ x: 0, y: 0, width: 0, height: 50 }, ["#000000", "#ffffff"], null],
    [
      { x: 0, y: 0, width: 10, height: 10 },
      ["#000000", "#ffffff"],
      { cx: 100, cy: 100, r: 1 },
    ],
  ];
  for (const [b, colors, circle] of circleCases)
    out.push(
      vec(
        "autoVectorFreeformGradient",
        true,
        { bounds: b, colors, circle },
        () =>
          autoVectorFreeformGradient(
            b,
            colors,
            circle
              ? (p) => Math.hypot(p.x - circle.cx, p.y - circle.cy) <= circle.r
              : undefined,
          ),
      ),
    );
  for (const index of [-1, 0, 2, 3, 4])
    out.push(
      vec(
        "removeVectorFreeformPoint",
        false,
        {
          gradient: {
            ...FREE,
            lines: [
              [0, 2, 1],
              [3, 2],
              [2, 0, 2, 1],
            ],
          },
          index,
        },
        () =>
          removeVectorFreeformPoint(
            {
              ...FREE,
              lines: [
                [0, 2, 1],
                [3, 2],
                [2, 0, 2, 1],
              ],
            },
            index,
          ),
      ),
    );
  out.push(
    vec(
      "removeVectorFreeformPoint",
      false,
      { gradient: { type: "freeform", points: [FREE.points[0]] }, index: 0 },
      () =>
        removeVectorFreeformPoint(
          { type: "freeform", points: [FREE.points[0]] },
          0,
        ),
    ),
  );
  out.push(
    vec(
      "nearestVectorShadingPoint",
      true,
      {
        paint: FREE,
        queries: [
          [21, 31, 5],
          [70, 60, 0],
          [0, 0, 10],
          [115, 60, 100],
        ],
      },
      () =>
        [
          [21, 31, 5],
          [70, 60, 0],
          [0, 0, 10],
          [115, 60, 100],
        ].map(([x, y, r]) => nearestVectorShadingPoint(FREE, { x, y }, r)),
    ),
  );
  const M: VectorMatrix = [0.8, 0.6, -0.6, 0.8, 12, -4];
  out.push(
    vec(
      "transformVectorShadedPaint",
      false,
      { paints: [MESH, FREE], matrix: M },
      () => [MESH, FREE].map((p) => transformVectorShadedPaint(p, M)),
    ),
  );
  const colours: VectorRgba[] = [
    [1, 0, 0, 1],
    [0.5, 0.25, 0.125, 0.9995],
    [0.5, 0.25, 0.125, 0.9994],
    [-1, 2, 0.5, 0],
    [0.2, 0.4, 0.6, -0.5],
    [0.00196, 0.998, 0.5, 0.3337],
  ];
  out.push(
    vec("vectorRgbaToCss", false, { colours }, () =>
      colours.map((c) => vectorRgbaToCss(c)),
    ),
  );
  for (const [paint, options] of [
    [MESH, { bounds: BOX, meshCells: 2 }],
    [MESH, { meshCells: 1, precision: 1 }],
    [{ ...MESH, rows: 3 }, { bounds: BOX }],
    [FREE, { bounds: BOX, freeformCells: 6 }],
    [
      FREE,
      {
        bounds: BOX,
        area: { x: 0, y: 0, width: 50, height: 150 },
        freeformCells: 4,
        precision: 1,
      },
    ],
    [FREE, {}],
    [
      {
        type: "freeform",
        points: [{ x: 5, y: 5, color: "rgba(255,0,0,0.25)" }],
      },
      { bounds: { x: 0, y: 0, width: 10, height: 10 }, freeformCells: 2 },
    ],
  ] as [VectorMeshGradient | VectorFreeformGradient, Record<string, unknown>][])
    out.push(
      vec("vectorShadedSvgDefs", true, { paint, options }, () =>
        vectorShadedSvgDefs(paint, "s", options),
      ),
    );
  return out;
}

const STOPS = [
  { offset: 0, color: "#ff0000" },
  { offset: 0.4, color: "#00ff00", opacity: 0.5, midpoint: 0.3 },
  { offset: 1, color: "#0000ff" },
];
const GRADIENTS: VectorGradient[] = [
  { type: "linear", stops: STOPS },
  {
    type: "linear",
    stops: [STOPS[0], { ...STOPS[1], midpoint: 0.8 }, STOPS[2]],
  },
  { type: "linear", stops: STOPS, interpolation: "linear" },
  { type: "linear", stops: STOPS, interpolation: "oklab" },
  {
    type: "linear",
    stops: [
      { offset: 0, color: "#000000" },
      { offset: 0.5, color: "#ff8000" },
      { offset: 0.5, color: "#ffffff" },
      { offset: 1, color: "#00ffff" },
    ],
    smoothness: 0.6,
  },
  {
    type: "linear",
    stops: [
      { offset: 0, color: "#000000" },
      { offset: 0.3, color: "#ffffff" },
      { offset: 0.7, color: "#ff0000" },
      { offset: 1, color: "#000000" },
    ],
    smoothness: 1,
    interpolation: "oklab",
  },
  {
    type: "linear",
    stops: [
      { offset: 0.2, color: "#000000" },
      { offset: 0.8, color: "nope" },
    ],
    interpolation: "linear",
  },
  { type: "linear", stops: [{ offset: 0.5, color: "#336699", midpoint: 0.2 }] },
];

function gradientVectors(): Entry[] {
  const out: Entry[] = [];
  for (const g of GRADIENTS)
    out.push(
      vec("expandVectorGradientStops", true, { gradient: g }, () =>
        expandVectorGradientStops(g),
      ),
    );
  out.push(
    vec(
      "expandVectorGradientStops",
      true,
      { gradient: GRADIENTS[3], tolerance: 0.02 },
      () => expandVectorGradientStops(GRADIENTS[3], { tolerance: 0.02 }),
    ),
  );
  const ts = [-0.5, 0, 0.1, 0.28, 0.4, 0.55, 0.9, 1, 2];
  for (const g of GRADIENTS)
    out.push(
      vec("sampleVectorGradient", true, { gradient: g, ts }, () =>
        ts.map((t) => sampleVectorGradient(g, t)),
      ),
    );
  for (const [from, to] of [
    [0, 1],
    [0.2, 0.6],
    [0.6, 0.2],
    [0.5, 0.5],
    [0.9, 1],
  ])
    out.push(
      vec(
        "spanVectorGradientStops",
        true,
        { gradient: GRADIENTS[0], from, to },
        () => spanVectorGradientStops(GRADIENTS[0], from, to),
      ),
    );
  const plain = {
    type: "linear" as const,
    stops: [
      { offset: 0.25, color: "#ff0000" },
      { offset: 0.75, color: "#0000ff", opacity: 0.5 },
    ],
  };
  const spreads: [VectorGradient, VectorBounds | null, VectorBounds][] = [
    [
      { ...plain, spread: "repeat", angle: 90 },
      BOX,
      { x: -50, y: 0, width: 300, height: 100 },
    ],
    [{ ...plain, spread: "reflect", angle: 45 }, BOX, BOX],
    [{ ...plain, type: "reflected" }, BOX, BOX],
    [
      { ...plain, type: "reflected", spread: "repeat", angle: 120 },
      BOX,
      { x: 0, y: 0, width: 200, height: 200 },
    ],
    [{ ...plain, spread: "pad" }, BOX, BOX],
    [
      {
        ...plain,
        spread: "repeat",
        start: { x: 0, y: 0 },
        end: { x: 0.001, y: 0 },
        units: "userSpaceOnUse",
      },
      BOX,
      { x: 0, y: 0, width: 200, height: 10 },
    ],
    [
      { ...plain, spread: "repeat", angle: 90 },
      BOX,
      { x: 20, y: 30, width: 10, height: 10 },
    ],
  ];
  for (const [g, bounds, area] of spreads)
    out.push(
      vec(
        "expandVectorGradientSpread",
        false,
        { gradient: g, bounds, area },
        () => expandVectorGradientSpread(g, bounds, area),
      ),
    );
  const defs: [VectorGradient, Record<string, unknown>][] = [
    [
      { type: "conic", stops: STOPS },
      { bounds: BOX, wedges: 8 },
    ],
    [
      { type: "conic", stops: STOPS, angle: 30, cx: 0.3, cy: 0.6, r: 0.4 },
      { bounds: BOX, wedges: 12, precision: 2 },
    ],
    [{ type: "conic", stops: [] }, { bounds: BOX }],
    [
      {
        type: "conic",
        stops: STOPS,
        start: { x: 5, y: 5 },
        end: { x: 5, y: 5 },
        units: "userSpaceOnUse",
      },
      { bounds: BOX },
    ],
    [{ type: "diamond", stops: STOPS }, { bounds: BOX }],
    [
      { type: "diamond", stops: STOPS, spread: "repeat", r: 0.2 },
      { bounds: BOX, area: { x: 0, y: 0, width: 200, height: 200 } },
    ],
    [
      {
        type: "diamond",
        stops: STOPS,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
        units: "userSpaceOnUse",
      },
      { bounds: BOX },
    ],
    [{ type: "reflected", stops: STOPS }, { bounds: BOX }],
    [
      { type: "reflected", stops: plain.stops, spread: "repeat" },
      { bounds: BOX, area: { x: -100, y: 0, width: 400, height: 100 } },
    ],
    [
      { type: "reflected", stops: plain.stops, spread: "reflect" },
      { bounds: BOX },
    ],
    [
      {
        type: "linear",
        stops: STOPS,
        interpolation: "oklab",
        spread: "repeat",
        angle: 135,
      },
      { bounds: BOX },
    ],
    [
      {
        type: "radial",
        stops: STOPS,
        smoothness: 0.5,
        focal: { x: 0.2, y: 0.3 },
      },
      { bounds: BOX },
    ],
  ];
  for (const [g, options] of defs)
    out.push(
      vec("vectorGradientSvgDefs", true, { gradient: g, options }, () =>
        vectorGradientSvgDefs(g, "g", options),
      ),
    );
  const strokeG: VectorGradient = {
    type: "linear",
    stops: STOPS,
    strokeMode: "along",
  };
  const nodes: [string, Record<string, unknown>][] = [
    ["M10 10L60 40L110 10L160 40", { stroke: "#000", strokeWidth: 6 }],
    [
      "M10 10L90 10L90 60L10 60Z",
      { stroke: "#000", strokeWidth: 4, strokeLinejoin: "round" },
    ],
    [
      "M10 10L90 10L90 60L10 60Z",
      { stroke: "#000", strokeWidth: 4, strokeAlign: "inside" },
    ],
    [
      "M90 10L10 10L10 60L90 60Z",
      {
        stroke: "#000",
        strokeWidth: 4,
        strokeAlign: "outside",
        strokeLinejoin: "bevel",
      },
    ],
    [
      "M20 100C80 20 160 180 260 100",
      {
        stroke: "#000",
        strokeWidth: 8,
        strokeWidthProfile: [
          { t: 0, left: 0, right: 0 },
          { t: 0.5, left: 1.5, right: 0.5 },
          { t: 1, left: 0, right: 0 },
        ],
        strokeLinejoin: "round",
      },
    ],
    ["M0 0L50 0M0 30L0 30", { stroke: "#000" }],
    [
      "M10 10L50 10L10 10.0001",
      { stroke: "#000", strokeWidth: 2, endArrow: "arrow" },
    ],
  ];
  for (const mode of ["along", "across"] as const)
    for (const [d, style] of nodes)
      out.push(
        vec(
          "vectorStrokeGradientDefs",
          true,
          { gradient: { ...strokeG, strokeMode: mode }, node: { d, style } },
          () =>
            vectorStrokeGradientDefs(
              { ...strokeG, strokeMode: mode },
              "k",
              pathNode(d, style),
            ),
        ),
      );
  out.push(
    vec(
      "vectorStrokeGradientDefs",
      true,
      {
        gradient: { ...strokeG, interpolation: "oklab" },
        node: { d: nodes[0][0], style: nodes[0][1] },
        options: { area: BOX, precision: 1 },
      },
      () =>
        vectorStrokeGradientDefs(
          { ...strokeG, interpolation: "oklab" },
          "k",
          pathNode(nodes[0][0], nodes[0][1]),
          { area: BOX, precision: 1 },
        ),
    ),
  );
  const paints: [
    unknown,
    string,
    Record<string, unknown> | null,
    "fill" | "stroke",
  ][] = [
    [null, "a", null, "fill"],
    ["#ff0000", "a", null, "fill"],
    [{ type: "bogus" }, "a", null, "fill"],
    [{ type: "conic", stops: STOPS }, "a", null, "fill"],
    [strokeG, "a", { d: nodes[1][0], style: nodes[1][1] }, "stroke"],
    [strokeG, "a", { d: nodes[1][0], style: nodes[1][1] }, "fill"],
    [
      { type: "diamond", stops: STOPS },
      "a",
      { d: nodes[0][0], style: nodes[0][1] },
      "stroke",
    ],
    [
      MESH,
      "a",
      {
        d: "M10 20L130 20L130 100L10 100Z",
        style: { stroke: "#000", strokeWidth: 2 },
      },
      "stroke",
    ],
    [FREE, "a", null, "fill"],
  ];
  for (const [paint, id, node, role] of paints)
    out.push(
      vec("vectorPaintToSvg", true, { paint, id, node, role }, () =>
        vectorPaintToSvg(paint as never, id, {
          ...(node
            ? {
                node: pathNode(
                  node.d as string,
                  node.style as Record<string, unknown>,
                ),
              }
            : {}),
          role,
        }),
      ),
    );
  return out;
}

const STEPS: [string, Record<string, unknown>?][] = [
  [
    "vector.addShape",
    { kind: "rect", x: 20, y: 20, width: 120, height: 80, fill: "#2563eb" },
  ],
  [
    "vector.addShape",
    { kind: "ellipse", x: 160, y: 20, width: 100, height: 140, fill: "nope" },
  ],
  ["vector.addPath", { d: "M10 150L60 150", stroke: "#000000" }],
  ["vector.group", { ids: ["n3"] }],
  ["vector.addShape", { kind: "rect", x: 200, y: 160, width: 40, height: 30 }],
  ["vector.setMeshGradient", { rows: 1, columns: 1 }],
  ["vector.select", { ids: [] }],
  ["vector.setMeshGradient", { rows: 1, columns: 1 }],
  ["vector.setMeshGradient", { ids: ["n1"], rows: 2.5, columns: 1 }],
  ["vector.setMeshGradient", { ids: ["n1"], rows: 33, columns: 1 }],
  [
    "vector.setMeshGradient",
    { ids: ["n1"], rows: 1, columns: 1, colors: ["#fff"] },
  ],
  [
    "vector.setMeshGradient",
    {
      ids: ["n1"],
      rows: 1,
      columns: 1,
      colors: ["#fff", "#000", "nope", "#fff"],
    },
  ],
  [
    "vector.setMeshGradient",
    {
      ids: ["n1"],
      rows: 1,
      columns: 1,
      corners: ["#fff", "#000", "#fff", "bad"],
    },
  ],
  ["vector.setMeshGradient", { ids: ["nope"], rows: 1, columns: 1 }],
  ["vector.setMeshGradient", { ids: ["n4"], rows: 1, columns: 1 }],
  ["vector.setMeshGradient", { ids: ["n3"], rows: 1, columns: 1 }],
  ["vector.setMeshGradient", { ids: ["n1"], rows: 2, columns: 3 }],
  ["vector.getShading", { id: "n1" }],
  [
    "vector.setMeshGradient",
    {
      ids: ["n1", "n5"],
      rows: 1,
      columns: 2,
      corners: ["#ff0000", "#00ff00", "#0000ff", "rgba(0,0,0,0.5)"],
    },
  ],
  ["vector.transform", { ids: ["n1"], rotate: 30 }],
  ["vector.getShading", { id: "n1" }],
  ["vector.setMeshPoint", { id: "n1", index: 1 }],
  ["vector.setMeshPoint", { id: "n1", index: 9, color: "#fff" }],
  ["vector.setMeshPoint", { id: "n1", index: 1, x: 50 }],
  ["vector.setMeshPoint", { id: "n1", index: 1, color: "nope" }],
  ["vector.setMeshPoint", { id: "n2", index: 0, color: "#fff" }],
  ["vector.setMeshPoint", { id: "n1", index: 1, x: 70, y: 30, opacity: 0.25 }],
  ["vector.setMeshPoint", { id: "n1", index: 4, color: "#000000", opacity: 2 }],
  [
    "vector.setStyle",
    { ids: ["n2"], fill: { type: "mesh", rows: 1, columns: 1 } },
  ],
  [
    "vector.setStyle",
    {
      ids: ["n2"],
      fill: {
        type: "freeform",
        points: [{ x: 0, y: 0, color: "#fff" }],
        lines: [[0, 0]],
      },
    },
  ],
  ["vector.setFreeformGradient", { ids: ["n2"] }],
  ["vector.setFreeformGradient", { ids: ["n2"], colors: ["#ff0000", "nope"] }],
  [
    "vector.setFreeformGradient",
    { ids: ["n2"], colors: ["#ff0000", "#00ff00", "#0000ff"] },
  ],
  [
    "vector.setFreeformGradient",
    { ids: ["n5"], points: [{ x: 210, y: 170, color: "nope" }] },
  ],
  [
    "vector.setFreeformGradient",
    {
      ids: ["n5"],
      points: [
        { x: 210, y: 170, color: "#ff0000" },
        { x: 230, y: 180, color: "#0000ff" },
      ],
      lines: [
        [0, 1],
        [1, 1],
      ],
    },
  ],
  [
    "vector.setFreeformGradient",
    {
      ids: ["n5"],
      points: [
        { x: 210, y: 170, color: "#ff0000", opacity: 1, spread: 0 },
        { x: 230, y: 180, color: "#0000ff", opacity: 0, spread: 1 },
      ],
      lines: [],
    },
  ],
  ["vector.addFreeformPoint", { id: "n5", x: 220, y: 175 }],
  [
    "vector.addFreeformPoint",
    { id: "n5", x: 205, y: 185, color: "#00ff00", opacity: 1, spread: 0 },
  ],
  ["vector.addFreeformPoint", { id: "n5", x: 205, y: 185, color: "bad" }],
  ["vector.addFreeformPoint", { id: "n1", x: 205, y: 185 }],
  ["vector.setFreeformPoint", { id: "n5", index: 1 }],
  ["vector.setFreeformPoint", { id: "n5", index: 1, opacity: 1, spread: 0 }],
  [
    "vector.setFreeformPoint",
    {
      id: "n5",
      index: 0,
      x: 212,
      y: 171,
      color: "#111111",
      opacity: 0.3,
      spread: 0.2,
    },
  ],
  ["vector.setFreeformPoint", { id: "n5", index: 7, color: "#fff" }],
  [
    "vector.setFreeformLines",
    {
      id: "n5",
      lines: [
        [0, 2, 1],
        [3, 0],
      ],
    },
  ],
  ["vector.setFreeformLines", { id: "n5", lines: [[0, 9]] }],
  ["vector.setFreeformLines", { id: "n1", lines: [] }],
  ["vector.removeFreeformPoint", { id: "n5", index: 2 }],
  ["vector.setFreeformLines", { id: "n5", lines: [] }],
  [
    "vector.addFill",
    {
      ids: ["n2"],
      paint: {
        type: "mesh",
        rows: 1,
        columns: 1,
        points: [
          { x: 160, y: 20 },
          { x: 260, y: 20 },
          { x: 160, y: 160 },
          { x: 260, y: 160 },
        ],
        colors: ["#fff", "#000", "#f00", "#0f0"],
      },
    },
  ],
  ["vector.addFill", { ids: ["n2"], paint: { type: "freeform", points: [] } }],
  [
    "vector.addShape",
    {
      kind: "rect",
      x: 30,
      y: 120,
      width: 60,
      height: 60,
      fill: { type: "conic", stops: STOPS },
      stroke: { type: "linear", stops: STOPS, strokeMode: "across" },
    },
  ],
  [
    "vector.addShape",
    {
      kind: "ellipse",
      x: 100,
      y: 120,
      width: 60,
      height: 60,
      fill: { type: "diamond", stops: STOPS, interpolation: "oklab" },
      stroke: { type: "reflected", stops: STOPS, strokeMode: "along" },
    },
  ],
  // Free Distort maps node-space gradient handles and mesh / freeform points; box gradients follow the bounds.
  [
    "vector.setGradient",
    {
      ids: ["n7"],
      target: "fill",
      start: { x: 110, y: 130 },
      end: { x: 150, y: 170 },
      units: "userSpaceOnUse",
    },
  ],
  [
    "vector.distort",
    {
      ids: ["n5"],
      corners: [
        { x: 195, y: 155 },
        { x: 245, y: 160 },
        { x: 240, y: 195 },
        { x: 200, y: 190 },
      ],
    },
  ],
  [
    "vector.distort",
    {
      ids: ["n6", "n7"],
      corners: [
        { x: 30, y: 110 },
        { x: 170, y: 120 },
        { x: 160, y: 185 },
        { x: 25, y: 180 },
      ],
    },
  ],
  ["vector.getShading", { id: "n5" }],
  ["vector.list"],
];

async function commandVectors() {
  const setup = { width: 300, height: 200 };
  const host = createVectorConformanceHost(setup, {
    effects: createFakeEffectProvider(),
  });
  const steps: Entry[] = [];
  const run = async (id: string, params?: Record<string, unknown>) => {
    const r = await host.callTool(
      "run_command",
      params ? { id, params } : { id },
    );
    const text = (r.content[0] as { text: string }).text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  for (const [id, params] of STEPS)
    steps.push({
      id,
      ...(params ? { params } : {}),
      result: await run(id, params),
    });
  // Shaded and patterned paints survive an SVG round trip.
  const digest = (text: string) => ({
    length: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  const exported = (await run("vector.exportSvg")).result.svg as string;
  // Render data keys are compared as sets elsewhere: digest it with every object's keys sorted.
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v;
  const render = digest(JSON.stringify(canon(json(host.render()))));
  const imported = await run("vector.importSvg", {
    svg: exported,
    replace: true,
  });
  const after = await run("vector.list");
  return {
    setup,
    steps,
    svg: digest(exported),
    render,
    imported,
    after,
    document: json(host.document()),
  };
}

async function vectors() {
  return {
    version: 1,
    entries: [...shadingVectors(), ...gradientVectors()],
    commands: await commandVectors(),
  };
}

describe("Swift vector shading test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    const now = json(await vectors());
    if (process.env.UPDATE_SWIFT_VECTORS)
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    // Numbers within relative 1e-9 (trig differs across CPUs in the last bit).
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
