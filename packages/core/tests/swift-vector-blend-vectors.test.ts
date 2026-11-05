import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bezierToSubpaths,
  correspondMorphContours,
  createVectorEffect,
  createVectorMorph,
  evalVectorMesh,
  expandVectorAppearance,
  expandVectorBlend,
  generateVectorBlendChildren,
  interpolateRigidMatrix,
  interpolateVectorPaint,
  interpolateVectorStyle,
  interpolateWidthProfiles,
  isValidVectorMesh,
  normalizeVectorEffectParams,
  releaseVectorBlend,
  resizeVectorMesh,
  resolveVectorBlendOptions,
  sanitizeVectorSymmetry,
  splitVectorMeshU,
  splitVectorMeshV,
  subpathToMorphContour,
  transformVectorEffects,
  transformVectorSymmetry,
  vectorBlendColorDistance,
  vectorBlendKeyTargets,
  vectorBlendRail,
  vectorBlendRailAt,
  vectorBlendStepCount,
  vectorEnvelopeFrame,
  vectorIdentityMesh,
  vectorMeshFromOutline,
  vectorMeshOutline,
  vectorSymmetryAxes,
  vectorSymmetryDrawn,
  vectorSymmetryMatrices,
  vectorWarpPresetGrid,
  vectorWarpPresetMesh,
  type VectorGroupNode,
  type VectorMorphOptions,
  type VectorNode,
  type VectorPathNode,
  type VectorSubpath,
  type VectorSymmetryGroup,
  type VectorWarpMesh,
} from "../src/vector/index.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";
import { createVectorConformanceHost } from "../src/vector/contract.js";
import { createFakeEffectProvider } from "../src/effects";

/**
 * Test vectors the Swift vector blends, envelopes and symmetry (`packages/swift`,
 * `PixerateVector`, #624) check themselves against: morphs and paint interpolation (`blend.ts`),
 * live blend groups (`blendGroup.ts`), warp presets and meshes (`geom/warp.ts`, `vector/warp.ts`),
 * the Envelope effect (`appearance.ts`) and symmetry groups (`symmetry.ts`). Computed here from the
 * TS core (the spec); a drift from the committed file fails this test (run with
 * UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change, then rerun the Swift tests).
 *
 * Numbers compare within relative 1e-9 where they went through trig (`trig: true`) and exactly
 * otherwise; strings (colours, ids) always exactly. Key order is not compared. Nodes go in as
 * their JSON. A paint result of `undefined` is written as the string "undefined".
 *
 * `commands` replays agent commands (`run_command` on `createVectorConformanceHost`) for their
 * failures and edge cases: `{ setup, steps: [{ id, params?, result }], svg, render, imported,
 * after, document }`, where a result is the command's JSON result or `{ error }` with the tool's
 * error text, and `svg` / `render` are `{ length, sha256 }` of the exported SVG and of the render
 * data's JSON (object keys sorted).
 *
 * Shape: `{ version, entries: [{ fn, trig, ...inputs, out }], commands }`.
 */
const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateVectorTests/Fixtures/vector-blend-vectors.json",
);

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const vec = (
  fn: string,
  trig: boolean,
  inputs: Entry,
  compute: () => unknown,
): Entry => ({ fn, trig, ...inputs, out: json(compute()) });

const path = (
  id: string,
  d: string,
  style: Record<string, unknown> = {},
): VectorPathNode =>
  ({
    id,
    type: "path",
    subpaths: bezierToSubpaths(d),
    ...style,
  }) as VectorPathNode;

const ELLIPSE =
  "M40 10C56.57 10 70 23.43 70 40C70 56.57 56.57 70 40 70C23.43 70 10 56.57 10 40C10 23.43 23.43 10 40 10Z";
const RECT = "M200 20L260 20L260 80L200 80Z";
const STAR =
  "M100 0L112 38L152 38L120 62L132 100L100 76L68 100L80 62L48 38L88 38Z";
const HEX = "M300 50L325 7L375 7L400 50L375 93L325 93Z";
const OPEN = "M0 200C40 160 80 240 120 200";
const OPEN2 = "M200 220L260 180L320 230";
const RING = "M500 0L600 0L600 100L500 100Z M520 20L520 80L580 80L580 20Z";
const ROUNDED = (() => {
  const sp = bezierToSubpaths("M0 0L80 0L80 60L0 60Z");
  sp[0].anchors.forEach((a) => (a.corner = { radius: 12 }));
  return sp;
})();

const STOPS = [
  { offset: 0, color: "#ef4444" },
  { offset: 0.5, color: "#22c55e", midpoint: 0.3 },
  { offset: 1, color: "#3b82f6", opacity: 0.4 },
];

function morphVectors(): Entry[] {
  const out: Entry[] = [];
  const ts = [0, 0.25, 0.5, 1];
  const morph = (
    a: VectorNode,
    b: VectorNode,
    options: VectorMorphOptions & Record<string, unknown> = {},
  ) =>
    vec("interpolateVectorPaths", true, { a, b, ts, options }, () => {
      const m = createVectorMorph(a, b, options);
      return ts.map((t) => m.at(t));
    });
  const e = path("e", ELLIPSE, {
    fill: "#2563eb",
    stroke: "#111827",
    strokeWidth: 2,
  });
  const r = path("r", RECT, {
    fill: "#e11d48",
    stroke: null,
    strokeWidth: 4,
    opacity: 0.5,
  });
  out.push(morph(e, r));
  out.push(morph(e, r, { linear: true }));
  out.push(morph(e, r, { starts: [2, 1] }));
  out.push(
    morph(
      path("s", STAR, { fill: "#facc15" }),
      path("h", HEX, { fill: "rgba(0,0,0,0.5)" }),
    ),
  );
  out.push(
    morph(path("s", STAR), path("h", HEX), {
      minSegments: 4,
      shapeContext: false,
    }),
  );
  out.push(
    morph(path("s", STAR), path("h", HEX), {
      spacing: 5,
      maxSegments: 60,
      rigidity: 0.5,
    }),
  );
  out.push(morph(path("s", STAR), path("h", HEX), { matchStart: false }));
  // Open paths, open into closed, and starts on the last anchor of an open path.
  out.push(
    morph(
      path("o", OPEN, {
        stroke: "#000",
        strokeWidth: 1,
        strokeDasharray: [4, 2],
        startArrow: "arrow",
        strokeWidthProfile: [
          { t: 0, left: 0.2, right: 0.2 },
          { t: 1, left: 1, right: 2 },
        ],
      }),
      path("p", OPEN2, {
        stroke: "#f00",
        strokeWidth: 5,
        strokeLinecap: "round",
        endArrowScale: 2,
      }),
    ),
  );
  out.push(morph(path("o", OPEN), path("p", OPEN2), { starts: [null, 2] }));
  out.push(morph(path("o", OPEN), path("p", ELLIPSE)));
  // Holes, live corners, and turned and placed shapes.
  out.push(
    morph(
      path("ring", RING, { fill: "#000", fillRule: "evenodd" }),
      path("e", ELLIPSE),
    ),
  );
  out.push(
    morph(
      {
        id: "c",
        type: "path",
        subpaths: ROUNDED,
        fill: "#0ea5e9",
      } as VectorPathNode,
      path("r", RECT, { transform: [0, 1, -1, 0, 300, 0] }),
    ),
  );
  out.push(
    morph(
      path("a", STAR, { transform: [0.8, 0.6, -0.6, 0.8, 10, 20] }),
      path("b", STAR, { transform: [-1, 0, 0, -1, 400, 300] }),
    ),
  );
  // Groups: paths pair in stacking order, extras grow from a point.
  const g1: VectorGroupNode = {
    id: "g1",
    type: "group",
    opacity: 0.8,
    children: [
      path("g1a", ELLIPSE, { fill: "#f00" }),
      path("g1b", RECT, { fill: "#0f0", opacity: 0.5 }),
    ],
  };
  const g2: VectorGroupNode = {
    id: "g2",
    type: "group",
    transform: [1, 0, 0, 1, 50, 60],
    children: [path("g2a", HEX, { fill: "#00f" })],
  };
  out.push(morph(g1, g2));
  out.push(morph(g2, g1));
  out.push(morph(path("x", STAR), g1));
  return out;
}

function paintVectors(): Entry[] {
  const out: Entry[] = [];
  const ts = [0, 0.3, 0.5, 0.7, 1];
  const linear = { type: "linear", stops: STOPS };
  const radial = {
    type: "radial",
    stops: STOPS.slice(0, 2),
    cx: 0.3,
    cy: 0.6,
    r: 0.4,
    spread: "reflect",
  };
  const pairs: [unknown, unknown][] = [
    ["#ff0000", "#0000ff"],
    ["#f00", "rgba(0, 0, 255, 0.25)"],
    [null, "#22c55e"],
    ["#22c55e", "none"],
    [null, null],
    ["none", undefined],
    [
      linear,
      {
        type: "linear",
        stops: STOPS.map((s) => ({ ...s, color: "#000" })),
        angle: 45,
      },
    ],
    [linear, { type: "linear", stops: STOPS.slice(1), interpolation: "oklab" }],
    [linear, radial],
    [
      { ...radial, focal: { x: 0.2, y: 0.2 } },
      {
        type: "radial",
        stops: STOPS.slice(1),
        start: { x: 0.5, y: 0.5 },
        end: { x: 1, y: 0.5 },
        focalRadius: 0.2,
      },
    ],
    [
      {
        type: "linear",
        stops: STOPS,
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        units: "userSpaceOnUse",
      },
      {
        type: "linear",
        stops: STOPS,
        start: { x: 0, y: 0 },
        end: { x: 1, y: 0 },
      },
    ],
    [
      { type: "conic", stops: STOPS, smoothness: 0.5, strokeMode: "along" },
      { type: "conic", stops: STOPS, angle: 270 },
    ],
    ["#ff8800", linear],
    [linear, null],
    [linear, "bad colour"],
  ];
  out.push(
    vec(
      "interpolateVectorPaint",
      false,
      {
        pairs: json(
          pairs.map((p) => p.map((x) => (x === undefined ? "undefined" : x))),
        ),
        ts,
      },
      () =>
        pairs.map(([a, b]) =>
          ts.map((t) => {
            const v = interpolateVectorPaint(a as never, b as never, t);
            return v === undefined ? "undefined" : v;
          }),
        ),
    ),
  );
  const styles: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      {
        fill: "#fff",
        strokeWidth: 3,
        strokeDasharray: [5],
        strokeLinejoin: "round",
        startArrow: "arrow",
        endArrowScale: 3,
      },
      {
        fill: "#000",
        stroke: "#f00",
        strokeDasharray: [2, 4, 6, 8],
        fillRule: "evenodd",
        strokeAlign: "inside",
      },
    ],
    [{ strokeDasharray: [3, 1] }, {}],
    [{ strokeDasharray: [3, 1, 2] }, { strokeDasharray: [1, 1] }],
    [
      { strokeWidthProfile: [{ t: 0.5, left: 2, right: 0.5 }] },
      {
        strokeWidthProfile: [
          { t: 0.2, left: 1, right: 1 },
          { t: 0.2000001, left: 3, right: 3 },
        ],
      },
    ],
  ];
  out.push(
    vec("interpolateVectorStyle", false, { pairs: styles, ts }, () =>
      styles.map(([a, b]) => ts.map((t) => interpolateVectorStyle(a, b, t))),
    ),
  );
  const matrices: [number[], number[]][] = [
    [
      [1, 0, 0, 1, 0, 0],
      [0, 1, -1, 0, 10, 20],
    ],
    [
      [-0.9, 0.1, -0.1, -0.9, 5, 5],
      [0.9, -0.1, 0.1, 0.9, 0, 0],
    ],
    [
      [2, 0, 0.5, 1, 0, 0],
      [0, 0, 0, 0, 3, 4],
    ],
  ];
  out.push(
    vec("interpolateRigidMatrix", true, { pairs: matrices, ts }, () =>
      matrices.map(([a, b]) =>
        ts.map((t) => interpolateRigidMatrix(a as never, b as never, t)),
      ),
    ),
  );
  out.push(
    vec(
      "interpolateWidthProfiles",
      false,
      { a: [{ t: 0.3, left: 2, right: 1 }], b: null, ts },
      () =>
        ts.map((t) =>
          interpolateWidthProfiles([{ t: 0.3, left: 2, right: 1 }], null, t),
        ),
    ),
  );
  return out;
}

function contourVectors(): Entry[] {
  const out: Entry[] = [];
  const cases: [string[], string[], VectorMorphOptions][] = [
    [[ELLIPSE], [RECT], {}],
    [[STAR], [HEX], { starts: [3, 4] }],
    [[RING], [ELLIPSE], {}],
    [[OPEN], [OPEN2], { starts: [3, null] }],
    [[HEX], [OPEN2], {}],
    [["M0 0L10 0"], ["M0 0L0 0Z"], {}],
  ];
  for (const [a, b, options] of cases)
    out.push(
      vec("correspondMorphContours", true, { a, b, options }, () => {
        const contours = (list: string[]) =>
          list
            .flatMap((d) => bezierToSubpaths(d))
            .map((sp) => subpathToMorphContour(sp)!);
        return correspondMorphContours(contours(a), contours(b), options);
      }),
    );
  return out;
}

const blendGroup = (
  blend: Record<string, unknown>,
  keys: VectorNode[],
  extra: Record<string, unknown> = {},
): VectorGroupNode =>
  ({
    id: "b",
    type: "group",
    name: "Blend",
    ...extra,
    blend,
    children: keys,
  }) as VectorGroupNode;

function blendVectors(): Entry[] {
  const out: Entry[] = [];
  const k1 = path("k1", ELLIPSE, { fill: "#2563eb" });
  const k2 = path("k2", RECT, { fill: "#e11d48" });
  const k3 = path("k3", STAR, { fill: "#2563eb", stroke: "#000" });
  out.push(
    vec(
      "resolveVectorBlendOptions",
      false,
      {
        values: [null, {}, { spacing: "distance", steps: null, linear: true }],
      },
      () =>
        [null, {}, { spacing: "distance", steps: null, linear: true }].map(
          (v) => resolveVectorBlendOptions(v as never),
        ),
    ),
  );
  out.push(
    vec(
      "vectorBlendColorDistance",
      false,
      {
        pairs: [
          [k1, k2],
          [k1, k3],
          [k2, { id: "g", type: "group", children: [] }],
        ],
      },
      () => [
        vectorBlendColorDistance(k1, k2),
        vectorBlendColorDistance(k1, k3),
        vectorBlendColorDistance(k2, { id: "g", type: "group", children: [] }),
      ],
    ),
  );
  const counts: [VectorNode, VectorNode, unknown, number][] = [
    [k1, k2, null, 100],
    [k1, k2, { steps: 2.6 }, 100],
    [k1, k2, { steps: Infinity }, 100],
    [k1, k2, { spacing: "distance", distance: 7 }, 100],
    [k1, k2, { spacing: "distance", distance: 0 }, 100],
    [k1, k2, { spacing: "distance" }, 5],
    [k1, k2, { spacing: "smoothColor" }, 100],
    [k1, k3, { spacing: "smoothColor" }, 100],
  ];
  out.push(
    vec("vectorBlendStepCount", false, { cases: counts }, () =>
      counts.map(([a, b, o, l]) => vectorBlendStepCount(a, b, o as never, l)),
    ),
  );
  const rails: VectorSubpath[] = [
    bezierToSubpaths("M40 150C140 80 260 220 360 150")[0],
    bezierToSubpaths("M0 0L100 0L100 100Z")[0],
    bezierToSubpaths("M0 0L0 0")[0],
  ];
  out.push(
    vec(
      "vectorBlendRail",
      true,
      { rails, at: [-5, 0, 33.3, 120, 1000, Number.NaN] },
      () =>
        rails.map((sp) => {
          const rail = vectorBlendRail(sp);
          return (
            rail && {
              rail,
              at: [-5, 0, 33.3, 120, 1000, Number.NaN].map((s) =>
                vectorBlendRailAt(rail, s),
              ),
            }
          );
        }),
    ),
  );
  const spine = bezierToSubpaths("M40 150C140 80 260 220 360 150")[0];
  const loop = bezierToSubpaths(
    "M0 0C100 -50 200 50 300 0C200 150 100 150 0 100Z",
  )[0];
  const groups: VectorGroupNode[] = [
    blendGroup({ steps: 3 }, [k1, k2]),
    blendGroup({ steps: 2, orientToSpine: true, spine }, [k1, k2, k3]),
    blendGroup({ steps: 2, spine }, [k1, k2]),
    blendGroup(
      { spacing: "distance", distance: 60, orientToSpine: true, spine: loop },
      [k1, k2],
    ),
    blendGroup(
      { spacing: "smoothColor", linear: true, starts: { k1: 1, k4: 3 } },
      [k1, path("k4", RECT, { fill: "#3070f0" })],
    ),
    blendGroup({ steps: 2 }, [
      k1,
      {
        id: "kg",
        type: "group",
        children: [
          path("kg1", HEX, { fill: "#0f0" }),
          path("kg2", STAR, { fill: "#00f" }),
        ],
      } as VectorGroupNode,
    ]),
    blendGroup({ steps: 2 }, [k1]),
  ];
  out.push(
    vec("generateVectorBlendChildren", true, { groups }, () =>
      groups.map(generateVectorBlendChildren),
    ),
  );
  out.push(
    vec("vectorBlendKeyTargets", true, { groups }, () =>
      groups.map(vectorBlendKeyTargets),
    ),
  );
  // Expand and release take the groups above with their steps generated (in the Swift too).
  const live = (g: VectorGroupNode) => ({
    ...g,
    children: generateVectorBlendChildren(g),
  });
  const some = [groups[0], groups[2], groups[5]];
  out.push(
    vec("expandVectorBlend", true, { groups: some }, () =>
      some.map((g) => {
        let n = 0;
        return expandVectorBlend(live(g), () => `e${++n}`);
      }),
    ),
  );
  const placed = [
    {
      ...groups[1],
      transform: [0, 1, -1, 0, 100, 0],
      opacity: 0.5,
    } as VectorGroupNode,
    { ...groups[0], opacity: 1 } as VectorGroupNode,
    groups[3],
  ];
  out.push(
    vec("releaseVectorBlend", true, { groups: placed }, () =>
      placed.map((g) => {
        let n = 0;
        return releaseVectorBlend(live(g), () => `r${++n}`);
      }),
    ),
  );
  return out;
}

const STYLES = [
  "arc",
  "arcLower",
  "arcUpper",
  "arch",
  "bulge",
  "shellLower",
  "shellUpper",
  "flag",
  "wave",
  "fish",
  "rise",
  "fisheye",
  "inflate",
  "squeeze",
  "twist",
] as const;

function warpVectors(): Entry[] {
  const out: Entry[] = [];
  const cases: [string, number, number, number, boolean, number][] = [];
  for (const s of STYLES) {
    cases.push([s, 0.5, 0, 0, false, 0.5]);
    cases.push([s, -0.3, 0.2, -0.4, true, 2]);
  }
  cases.push(
    ["arc", 0, 0.5, 0, false, 1],
    ["twist", -1, 0, 0.7, false, 1],
    ["nope", 0.5, 0, 0, false, 1],
  );
  out.push(
    vec("vectorWarpPresetGrid", true, { cases }, () =>
      cases.map((c) =>
        vectorWarpPresetGrid(c[0] as never, c[1], c[2], c[3], c[4], c[5]),
      ),
    ),
  );
  const box = { x: 10, y: 20, width: 200, height: 100 };
  const presets = [
    { style: "arc", bend: 40 },
    { style: "flag", bend: 0, horizontal: 30, vertical: -20 },
    { style: "bulge", bend: 0 },
    { style: "wave", bend: 250, orientation: "vertical" },
    { style: "nope", bend: 20 },
  ];
  out.push(
    vec("vectorWarpPresetMesh", true, { presets, bounds: box }, () =>
      presets.map((p) => vectorWarpPresetMesh(p as never, box)),
    ),
  );
  const arc = vectorWarpPresetMesh({ style: "arc", bend: 40 }, box)!;
  const meshes: [VectorWarpMesh, number, number][] = [
    [arc, 2, 3],
    [arc, 1, 1],
    [resizeVectorMesh(arc, 3, 1), 2, 2],
    [vectorIdentityMesh(box, 2, 2), 4, 4],
    [arc, 0.4, 70],
  ];
  out.push(
    vec("resizeVectorMesh", true, { cases: meshes }, () =>
      meshes.map(([m, c, r]) => resizeVectorMesh(m, c, r)),
    ),
  );
  const uv = [
    [0, 0],
    [0.5, 0.5],
    [1, 1],
    [-0.2, 1.3],
    [0.33, 0.9],
  ];
  const twoByTwo = resizeVectorMesh(arc, 2, 2);
  out.push(
    vec("evalVectorMesh", true, { meshes: [arc, twoByTwo], uv }, () =>
      [arc, twoByTwo].map((m) => uv.map(([s, t]) => evalVectorMesh(m, s, t))),
    ),
  );
  out.push(
    vec(
      "splitVectorMesh",
      true,
      { mesh: twoByTwo, at: [0.25, 0.5, 0.995, 0.75] },
      () =>
        [0.25, 0.5, 0.995, 0.75].map((s) => ({
          u: splitVectorMeshU(twoByTwo, s),
          v: splitVectorMeshV(twoByTwo, s),
        })),
    ),
  );
  const candidates = [
    null,
    {},
    arc,
    { ...arc, us: [0, 0.5] },
    { ...arc, vs: [0, 1, 1] },
    { ...arc, points: arc.points.slice(1) },
    { ...arc, points: [...arc.points.slice(1), { x: 1, y: Number.NaN }] },
  ];
  out.push(
    vec("isValidVectorMesh", false, { values: json(candidates) }, () =>
      json(candidates).map((m) => isValidVectorMesh(m)),
    ),
  );
  const outlines: [VectorSubpath, number, number][] = [
    [bezierToSubpaths(ELLIPSE)[0], 4, 4],
    [bezierToSubpaths(STAR)[0], 2, 3],
    [bezierToSubpaths("M0 0L100 0L100 100L0 100Z")[0], 1, 1],
    [
      {
        ...bezierToSubpaths("M0 0L100 0L100 100L0 100Z")[0],
        anchors: bezierToSubpaths("M0 0L100 0L100 100L0 100Z")[0]
          .anchors.slice()
          .reverse(),
      },
      2,
      2,
    ],
    [bezierToSubpaths(OPEN)[0], 4, 4],
    [bezierToSubpaths("M0 0L100 0L100 0Z")[0], 4, 4],
  ];
  out.push(
    vec("vectorMeshFromOutline", false, { cases: outlines }, () =>
      outlines.map(([sp, c, r]) => vectorMeshFromOutline(sp, c, r)),
    ),
  );
  out.push(
    vec("vectorMeshOutline", true, { meshes: [arc, twoByTwo] }, () =>
      [arc, twoByTwo].map(vectorMeshOutline),
    ),
  );
  return out;
}

function envelopeVectors(): Entry[] {
  const out: Entry[] = [];
  const box = { x: 0, y: 0, width: 100, height: 60 };
  const mesh = vectorIdentityMesh(box, 1, 1);
  const params: [
    Record<string, unknown> | null,
    Record<string, unknown> | undefined,
  ][] = [
    [null, undefined],
    [{ style: "flag", bend: 150, rows: 3.6, columns: 0 }, undefined],
    [{ style: "mesh", mesh }, undefined],
    [{ style: "mesh", mesh: { ...mesh, us: [0, 2] } }, undefined],
    [
      { style: "mesh", rows: 3 },
      {
        style: "mesh",
        bend: 50,
        horizontal: 0,
        vertical: 0,
        orientation: "horizontal",
        rows: 1,
        columns: 1,
        mesh,
      },
    ],
    [{ style: "arc", mesh }, undefined],
    [
      { columns: 2 },
      {
        style: "mesh",
        bend: 50,
        horizontal: 0,
        vertical: 0,
        orientation: "horizontal",
        rows: 1,
        columns: 1,
        mesh,
      },
    ],
  ];
  out.push(
    vec(
      "normalizeVectorEffectParams",
      false,
      { cases: json(params.map(([p, b]) => ({ params: p, base: b ?? null }))) },
      () =>
        params.map(([p, b]) =>
          normalizeVectorEffectParams("envelope", p, b as never),
        ),
    ),
  );
  const enveloped = (
    id: string,
    d: string,
    p: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    path(id, d, {
      fill: "#7c3aed",
      ...extra,
      effects: [createVectorEffect("envelope", "fx1", p)],
    });
  const nodes: VectorNode[] = [
    enveloped("a", RECT, { style: "arc", bend: 40 }),
    enveloped(
      "b",
      ELLIPSE,
      { style: "wave", bend: -30, horizontal: 20, orientation: "vertical" },
      { transform: [0.8, 0.6, -0.6, 0.8, 0, 0] },
    ),
    enveloped("c", STAR, {
      style: "mesh",
      rows: 2,
      columns: 2,
      mesh: resizeVectorMesh(
        vectorWarpPresetMesh(
          { style: "fisheye", bend: 60 },
          { x: 48, y: 0, width: 104, height: 100 },
        )!,
        2,
        2,
      ),
    }),
    path("d", HEX, {
      fill: "#000",
      effects: [
        { id: "fx1", type: "roundCorners", params: { radius: 10 } },
        createVectorEffect("envelope", "fx2", { style: "bulge", bend: 50 }),
      ],
    }),
    {
      id: "g",
      type: "group",
      effects: [
        createVectorEffect("envelope", "fx1", { style: "rise", bend: 30 }),
      ],
      children: [
        path("g1", RECT, { fill: "#f00" }),
        path("g2", ELLIPSE, { fill: "#0f0" }),
      ],
    } as VectorGroupNode,
    enveloped("e", "M0 0L100 0", { style: "arc", bend: 40 }),
  ];
  out.push(
    vec("expandVectorAppearance", true, { nodes }, () =>
      nodes.map(expandVectorAppearance),
    ),
  );
  out.push(
    vec("vectorEnvelopeFrame", true, { nodes }, () =>
      nodes.map((n) =>
        vectorEnvelopeFrame(
          n,
          n.effects?.find((e) => e.type === "envelope")?.id,
        ),
      ),
    ),
  );
  const matrices = [
    [2, 0, 0, 0.5, 10, 0],
    [1, 0, 0.5, 1, 0, 0],
    [-1, 0, 0, 1, 0, 0],
  ];
  out.push(
    vec(
      "transformVectorEffects",
      true,
      { nodes: nodes.slice(0, 4), matrices },
      () =>
        nodes
          .slice(0, 4)
          .map((n) =>
            matrices.map((m) =>
              transformVectorEffects(n.effects!, m as never, n),
            ),
          ),
    ),
  );
  return out;
}

function symmetryVectors(): Entry[] {
  const out: Entry[] = [];
  const settings = [
    { mode: "vertical", center: { x: 100, y: 50 } },
    { mode: "horizontal", center: { x: 100, y: 50 }, rotation: 30 },
    { mode: "diagonal", center: { x: 0, y: 0 } },
    { mode: "dual", center: { x: 10, y: 20 }, rotation: 15 },
    { mode: "radial", center: { x: 200, y: 120 }, copies: 5 },
    {
      mode: "radial",
      center: { x: 200, y: 120 },
      copies: 4,
      mirror: true,
      rotation: 10,
    },
    { mode: "radial", center: { x: 0, y: 0 } },
  ];
  out.push(
    vec("vectorSymmetryMatrices", true, { settings }, () =>
      settings.map((s) => vectorSymmetryMatrices(s as never)),
    ),
  );
  const box = { x: 0, y: 0, width: 300, height: 200 };
  out.push(
    vec(
      "vectorSymmetryAxes",
      true,
      {
        settings: [
          ...settings,
          { mode: "vertical", center: { x: 400, y: 50 } },
        ],
        box,
      },
      () =>
        [...settings, { mode: "vertical", center: { x: 400, y: 50 } }].map(
          (s) => vectorSymmetryAxes(s as never, box),
        ),
    ),
  );
  const raw = [
    null,
    7,
    { mode: "spiral", center: { x: 0, y: 0 } },
    { mode: "radial" },
    { mode: "radial", center: { x: 1, y: Number.NaN } },
    {
      mode: "radial",
      center: { x: 1, y: 2 },
      rotation: -370,
      copies: 99.4,
      mirror: true,
    },
    {
      mode: "vertical",
      center: { x: 1, y: 2 },
      rotation: 720,
      copies: 3,
      mirror: true,
    },
    { mode: "dual", center: { x: 1, y: 2, z: 3 }, rotation: 45.5 },
  ];
  out.push(
    vec("sanitizeVectorSymmetry", false, { values: json(raw) }, () =>
      json(raw).map((v) => sanitizeVectorSymmetry(v)),
    ),
  );
  const transforms = [
    [0, 1, -1, 0, 10, 20],
    [-1, 0, 0, 1, 0, 0],
    [1, 0, 0, 1, 5, 5],
  ];
  out.push(
    vec(
      "transformVectorSymmetry",
      true,
      { settings: settings.slice(0, 3), matrices: transforms },
      () =>
        settings
          .slice(0, 3)
          .map((s) =>
            transforms.map((m) =>
              transformVectorSymmetry(s as never, m as never),
            ),
          ),
    ),
  );
  const groups: VectorSymmetryGroup[] = [
    {
      id: "s",
      type: "group",
      symmetry: settings[5] as never,
      children: [path("t", "M150 40L180 60L150 80Z", { fill: "#0ea5e9" })],
    } as VectorSymmetryGroup,
    {
      id: "s2",
      type: "group",
      transform: [1, 0, 0, 1, 20, 0],
      symmetry: settings[3] as never,
      children: [
        {
          id: "in",
          type: "group",
          children: [
            path("u", RECT),
            path("v", STAR, { transform: [0, 1, -1, 0, 0, 0] }),
          ],
        } as VectorGroupNode,
      ],
    } as VectorSymmetryGroup,
  ];
  out.push(
    vec("vectorSymmetryDrawn", true, { groups }, () =>
      groups.map(vectorSymmetryDrawn),
    ),
  );
  out.push(
    vec("expandVectorAppearance", true, { nodes: groups }, () =>
      groups.map(expandVectorAppearance),
    ),
  );
  return out;
}

/** Agent commands: blends, envelopes and symmetry, with their failures. */
const STEPS: [string, Record<string, unknown>?][] = [
  [
    "vector.addShape",
    { kind: "ellipse", x: 20, y: 20, width: 40, height: 40, fill: "#2563eb" },
  ],
  [
    "vector.addShape",
    {
      kind: "star",
      x: 200,
      y: 20,
      width: 60,
      height: 60,
      fill: { type: "linear", stops: STOPS },
    },
  ],
  [
    "vector.addShape",
    {
      kind: "rect",
      x: 20,
      y: 200,
      width: 50,
      height: 30,
      fill: "#e11d48",
      stroke: null,
    },
  ],
  // Blends and their failures.
  ["vector.blend", { ids: ["n1"] }],
  ["vector.blend", { ids: ["n1", "n2"], spacing: "bogus" }],
  ["vector.blend", { ids: ["n1", "n2"], steps: 0 }],
  ["vector.blend", { ids: ["n1", "n9"] }],
  [
    "vector.blend",
    {
      ids: ["n2", "n1", "n3"],
      keepOrder: true,
      steps: 2,
      starts: { n2: 3, n9: 1 },
    },
  ],
  ["vector.list"],
  ["vector.blendOptions", { ids: ["n1"] }],
  ["vector.blendOptions", { ids: ["n2"], distance: -1 }],
  [
    "vector.blendOptions",
    { ids: ["n2"], spacing: "distance", distance: 45, orientToSpine: true },
  ],
  ["vector.select", { ids: ["n4~2"] }],
  ["vector.blendOptions", { linear: true }],
  ["vector.addPath", { d: "M30 150C100 60 220 260 300 120", stroke: "#111" }],
  ["vector.replaceSpine", { ids: ["n4"] }],
  ["vector.replaceSpine", { ids: ["n4", "n5"] }],
  ["vector.list"],
  ["vector.transform", { ids: ["n4"], dx: 10, dy: 5, rotate: 15 }],
  [
    "vector.distort",
    {
      ids: ["n4"],
      corners: [
        { x: 20, y: 0 },
        { x: 330, y: 20 },
        { x: 320, y: 260 },
        { x: 0, y: 240 },
      ],
    },
  ],
  ["vector.list"],
  ["vector.exportSvg"],
  ["vector.releaseBlend", { ids: ["n4"] }],
  ["vector.list"],
  ["vector.blend", { ids: ["n1", "n3"], steps: 3 }],
  ["vector.expandBlend", { ids: ["n1"] }],
  ["vector.list"],
  ["vector.releaseBlend", { ids: ["n1"] }],
  ["vector.blend", { ids: ["n1", "n3"], spacing: "distance", distance: 80 }],
  ["vector.expandBlend"],
  ["vector.list"],
  // Envelopes.
  [
    "vector.addShape",
    { kind: "polygon", x: 300, y: 200, width: 80, height: 60, fill: "#16a34a" },
  ],
  [
    "vector.envelope",
    { ids: ["n12"], preset: "bulge", bend: 30, horizontal: 10 },
  ],
  ["vector.envelope", { ids: ["n12"], preset: "arc", mesh: { rows: 2 } }],
  [
    "vector.envelope",
    { ids: ["n12"], mesh: { rows: 1, columns: 1, points: [{ x: 0, y: 0 }] } },
  ],
  ["vector.envelope", { ids: ["n12"], mesh: { rows: 2, columns: 3 } }],
  ["vector.getAppearance", { id: "n12" }],
  ["vector.envelope", { ids: ["n12"], release: true }],
  [
    "vector.addShape",
    { kind: "rect", x: 100, y: 230, width: 60, height: 40, fill: "#facc15" },
  ],
  [
    "vector.addShape",
    {
      kind: "ellipse",
      x: 90,
      y: 220,
      width: 80,
      height: 60,
      fill: "none",
      stroke: "#000",
    },
  ],
  [
    "vector.envelope",
    { ids: ["n15", "n16"], topObject: true, mesh: { rows: 2, columns: 2 } },
  ],
  [
    "vector.updateEffect",
    { nodeId: "n15", effectId: "fx1", params: { rows: 1 } },
  ],
  [
    "vector.addShape",
    { kind: "rect", x: 200, y: 230, width: 60, height: 40, fill: "#0ea5e9" },
  ],
  ["vector.envelope", { ids: ["n17"], preset: "flag", bend: 40 }],
  [
    "vector.updateEffect",
    { nodeId: "n17", effectId: "fx1", params: { style: "mesh", rows: 2 } },
  ],
  ["vector.envelope", { ids: ["n12"], preset: "arc", bend: 40 }],
  ["vector.skew", { ids: ["n12"], ax: 20 }],
  [
    "vector.distort",
    {
      ids: ["n15"],
      corners: [
        { x: 80, y: 220 },
        { x: 180, y: 210 },
        { x: 170, y: 290 },
        { x: 90, y: 280 },
      ],
    },
  ],
  ["vector.list"],
  ["vector.exportSvg"],
  ["vector.envelope", { ids: ["n17"], expand: true }],
  ["vector.envelope", { ids: ["n13", "n17"], topObject: true }],
  // Symmetry.
  ["vector.makeSymmetry", { ids: ["n13"], mode: "dual", rotation: 30 }],
  ["vector.makeSymmetry", { ids: ["n99"], mode: "radial" }],
  [
    "vector.makeSymmetry",
    { ids: [], mode: "radial", copies: 8, mirror: true, name: "Mandala" },
  ],
  ["vector.setSymmetry", {}],
  ["vector.setSymmetry", { ids: ["n13"], copies: 3 }],
  [
    "vector.setSymmetry",
    { ids: ["n18"], center: { x: 120, y: 80 }, rotation: -45 },
  ],
  ["vector.enterSymmetry", { id: "n18" }],
  ["vector.enterSymmetry", { id: "n19" }],
  ["vector.exitSymmetry"],
  ["vector.exitSymmetry"],
  ["vector.makeSymmetry", { ids: ["n6"], mode: "vertical" }],
  ["vector.list"],
  ["vector.transform", { ids: ["n18"], sx: 1.5, rotate: 90 }],
  ["vector.enterSymmetry", { id: "n18" }],
  ["vector.releaseSymmetry", { ids: ["n19"] }],
  ["vector.releaseSymmetry", { ids: ["n18"], expand: true }],
  ["vector.releaseSymmetry", { ids: ["n18"] }],
  ["vector.select", { ids: ["n6"] }],
  ["vector.setSymmetry", { mirror: true, mode: "diagonal" }],
  ["vector.list"],
];

async function commandVectors() {
  const setup = { width: 400, height: 300 };
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
  const digest = (text: string) => ({
    length: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
  });
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
  const exported = (await run("vector.exportSvg")).result.svg as string;
  const render = digest(JSON.stringify(canon(json(host.render()))));
  const document = json(host.document());
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
    document,
    imported,
    after,
  };
}

async function vectors() {
  return {
    version: 1,
    entries: [
      ...morphVectors(),
      ...paintVectors(),
      ...contourVectors(),
      ...blendVectors(),
      ...warpVectors(),
      ...envelopeVectors(),
      ...symmetryVectors(),
    ],
    commands: await commandVectors(),
  };
}

describe("Swift vector blend, envelope and symmetry test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    const now = json(await vectors());
    if (process.env.UPDATE_SWIFT_VECTORS)
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    // Numbers within relative 1e-9 (trig differs across CPUs in the last bit).
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
