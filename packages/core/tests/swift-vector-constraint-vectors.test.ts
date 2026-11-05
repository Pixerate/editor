import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addVectorConstraint,
  autoConstrainVector,
  bezierToSubpaths,
  checkVectorExpression,
  evalVectorExpression,
  formatVectorValue,
  inferVectorConstraints,
  isValidVectorParameterName,
  measureVectorConstraint,
  nextVectorConstraintName,
  purgeVectorConstraints,
  solveVectorConstraints,
  vectorConstraintActions,
  vectorConstraintDof,
  vectorConstraintGlyphs,
  vectorConstraintPanel,
  vectorConstraintResiduals,
  vectorExpressionNames,
  withVectorAnchorIds,
  VectorExprEnv,
  type VectorAnchorRef,
  type VectorConstraint,
  type VectorDocument,
  type VectorNode,
  type VectorPathNode,
} from "../src/vector/index.js";
import {
  nullSpace,
  qr,
  rankQr,
  solveLm,
} from "../src/vector/constraints/lm.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";
import { createVectorConformanceHost } from "../src/vector/contract.js";
import { createFakeEffectProvider } from "../src/effects";

/**
 * Test vectors the Swift vector constraints (`packages/swift`, `PixerateVector`, #624) check
 * themselves against: expressions and parameters (`expr.ts`), the Levenberg–Marquardt solver and
 * its rank tools (`lm.ts`), solving every constraint kind, over-constrained and unsatisfiable
 * systems, adding constraints, degrees of freedom and purging (`solve.ts`), auto-constrain at
 * several tolerances (`auto.ts`) and the glyph and panel data (`glyphs.ts`). Computed here from the
 * TS core (the spec); a drift from the committed file fails this test (run with
 * UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change, then rerun the Swift tests).
 *
 * Numbers compare exactly where `trig` is false and within relative 1e-9 where the outputs went
 * through `Math.atan2` (angle constraints); strings always exactly. Key order is not compared.
 *
 * `commands` replays agent commands (`run_command` on `createVectorConformanceHost`): `{ setup,
 * steps: [{ id, params?, result }], document }`, where a result is the command's JSON result or
 * `{ error }` with the tool's error text.
 *
 * Shape: `{ version, entries: [{ fn, trig, ...inputs, out }], commands }`.
 */
const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateVectorTests/Fixtures/vector-constraint-vectors.json",
);

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const vec = (
  fn: string,
  trig: boolean,
  inputs: Entry,
  compute: () => unknown,
): Entry => {
  let out: unknown;
  try {
    out = compute();
  } catch (e) {
    out = {
      error: (e as Error).message,
      ...((e as { ids?: string[] }).ids
        ? { ids: (e as { ids: string[] }).ids }
        : {}),
    };
  }
  return { fn, trig, ...inputs, out: json(out) };
};

/** A path whose anchors have ids `a1`, `a2`, …. */
const path = (
  id: string,
  d: string,
  extra: Record<string, unknown> = {},
): VectorPathNode =>
  withVectorAnchorIds({
    id,
    type: "path",
    subpaths: bezierToSubpaths(d),
    ...extra,
  } as VectorPathNode);

/** A circle of four cubics (kappa 0.5523), so no trig makes it. */
const circleD = (cx: number, cy: number, r: number) => {
  const k = 0.5523 * r;
  return `M${cx + r} ${cy} C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} Z`;
};

const NODES: VectorNode[] = [
  path("t", "M20 20 L120 30 L110 120 Z", { stroke: "#111" }),
  path("q", "M200 0 L300 3 L304 98 L198 101 Z"),
  path("o", "M10 200 L80 210 L150 190"),
  path("c1", circleD(200, 300, 40)),
  path("c2", circleD(290.5, 304, 49.2)),
  path("c3", circleD(201, 300.4, 20)),
  path("s", "M300 400 C320 360 360 360 380 400 C400 440 450 445 460 400"),
  {
    id: "g",
    type: "group",
    transform: [2, 0, 0, 2, 10, 5],
    children: [path("gp", "M10 10 L60 12 L58 50")],
  } as VectorNode,
  path("h", "M400 20 C420 0 440 0 460 20 L500 60"),
];

const doc = (
  constraints: Partial<VectorConstraint>[],
  extra: Partial<VectorDocument> = {},
): VectorDocument => ({
  width: 600,
  height: 500,
  nodes: json(NODES),
  constraints: constraints.map(
    (c, i) => ({ id: `k${i + 1}`, ...c }) as VectorConstraint,
  ),
  ...extra,
});

const P = (
  nodeId: string,
  anchor: string,
  more: Record<string, unknown> = {},
) => ({ nodeId, anchor, ...more });
const S = (nodeId: string, anchor: string) => ({
  nodeId,
  anchor,
  segment: true,
});
const C = (nodeId: string) => ({ nodeId, circle: true });

/** One system per constraint kind and reference shape (trig: angle rows use atan2). */
const SYSTEMS: [
  string,
  boolean,
  Partial<VectorConstraint>[],
  Partial<VectorDocument>?,
][] = [
  [
    "coincident points",
    false,
    [{ kind: "coincident", refs: [P("t", "a2"), P("q", "a1")] }],
  ],
  [
    "coincident point on segment",
    false,
    [{ kind: "coincident", refs: [P("o", "a2"), S("t", "a3")] }],
  ],
  [
    "coincident segment and point",
    false,
    [{ kind: "coincident", refs: [S("t", "a3"), P("o", "a2")] }],
  ],
  [
    "coincident point on circle",
    false,
    [{ kind: "coincident", refs: [P("o", "a3"), C("c1")] }],
  ],
  [
    "collinear",
    false,
    [{ kind: "collinear", refs: [S("t", "a1"), S("o", "a1")] }],
  ],
  ["concentric", false, [{ kind: "concentric", refs: [C("c1"), C("c3")] }]],
  [
    "concentric with a point",
    false,
    [{ kind: "concentric", refs: [P("o", "a1"), C("c3")] }],
  ],
  [
    "fix and horizontal",
    false,
    [
      { kind: "fix", refs: [P("t", "a1")] },
      { kind: "horizontal", refs: [S("t", "a1")] },
    ],
  ],
  [
    "fix a segment and a circle",
    false,
    [
      { kind: "fix", refs: [S("q", "a1"), C("c1")] },
      { kind: "equal", refs: [S("q", "a1"), S("q", "a2")] },
    ],
  ],
  [
    "parallel",
    false,
    [{ kind: "parallel", refs: [S("q", "a1"), S("q", "a3")] }],
  ],
  [
    "perpendicular",
    false,
    [{ kind: "perpendicular", refs: [S("q", "a1"), S("q", "a2")] }],
  ],
  [
    "vertical points",
    false,
    [{ kind: "vertical", refs: [P("t", "a1"), P("o", "a1")] }],
  ],
  ["vertical segment", false, [{ kind: "vertical", refs: [S("q", "a2")] }]],
  [
    "tangent segment and circle",
    false,
    [{ kind: "tangent", refs: [S("o", "a2"), C("c1")] }],
  ],
  [
    "tangent circle and segment",
    false,
    [{ kind: "tangent", refs: [C("c2"), S("q", "a3")] }],
  ],
  [
    "tangent circles outside",
    false,
    [{ kind: "tangent", refs: [C("c1"), C("c2")] }],
  ],
  [
    "tangent circles inside",
    false,
    [{ kind: "tangent", refs: [C("c1"), C("c3")] }],
  ],
  ["tangent at an anchor", false, [{ kind: "tangent", refs: [P("s", "a2")] }]],
  ["smooth at an anchor", false, [{ kind: "smooth", refs: [P("s", "a2")] }]],
  [
    "symmetric",
    false,
    [{ kind: "symmetric", refs: [P("t", "a1"), P("t", "a3"), S("o", "a1")] }],
  ],
  [
    "equal segments",
    false,
    [{ kind: "equal", refs: [S("t", "a1"), S("t", "a2")] }],
  ],
  ["equal circles", false, [{ kind: "equal", refs: [C("c1"), C("c2")] }]],
  [
    "distance segment",
    false,
    [{ kind: "distance", refs: [S("t", "a1")], value: "80", name: "d1" }],
  ],
  [
    "distance points",
    false,
    [{ kind: "distance", refs: [P("t", "a1"), P("q", "a3")], value: "250" }],
  ],
  [
    "distance point and segment",
    false,
    [{ kind: "distance", refs: [P("o", "a2"), S("t", "a1")], value: "150" }],
  ],
  [
    "distance segment and point",
    false,
    [{ kind: "distance", refs: [S("t", "a1"), P("o", "a2")], value: "150" }],
  ],
  [
    "distance horizontal",
    false,
    [
      {
        kind: "distance",
        refs: [P("t", "a1"), P("t", "a2")],
        value: "60",
        axis: "horizontal",
      },
    ],
  ],
  [
    "distance vertical, flipped",
    false,
    [
      {
        kind: "distance",
        refs: [P("t", "a3"), P("t", "a1")],
        value: "40",
        axis: "vertical",
      },
    ],
  ],
  [
    "angle",
    true,
    [
      {
        kind: "angle",
        refs: [S("t", "a1"), S("t", "a2")],
        value: "60",
        name: "ang1",
      },
    ],
  ],
  [
    "angle reflex",
    true,
    [{ kind: "angle", refs: [S("q", "a1"), S("q", "a2")], value: "120" }],
  ],
  ["radius", false, [{ kind: "radius", refs: [C("c1")], value: "55" }]],
  ["diameter", false, [{ kind: "diameter", refs: [C("c3")], value: "30" }]],
  [
    "handle coincident",
    false,
    [
      {
        kind: "coincident",
        refs: [P("h", "a1", { handle: "out" }), P("o", "a1")],
      },
    ],
  ],
  [
    "inside a scaled group",
    false,
    [
      { kind: "horizontal", refs: [S("gp", "a1")] },
      { kind: "distance", refs: [S("gp", "a2")], value: "50" },
    ],
  ],
  [
    "a square",
    false,
    [
      { kind: "horizontal", refs: [S("q", "a1")] },
      { kind: "vertical", refs: [S("q", "a2")] },
      { kind: "horizontal", refs: [S("q", "a3")] },
      { kind: "vertical", refs: [S("q", "a4")] },
      { kind: "equal", refs: [S("q", "a1"), S("q", "a2")] },
      { kind: "distance", refs: [S("q", "a1")], value: "120" },
      { kind: "fix", refs: [P("q", "a1")] },
    ],
  ],
  [
    "two components",
    false,
    [
      { kind: "horizontal", refs: [S("t", "a1")] },
      { kind: "radius", refs: [C("c1")], value: "30" },
      { kind: "coincident", refs: [P("t", "a3"), P("o", "a3")] },
    ],
  ],
  [
    "redundant (over-constrained but consistent)",
    false,
    [
      { kind: "horizontal", refs: [S("t", "a1")] },
      { kind: "horizontal", refs: [P("t", "a1"), P("t", "a2")] },
    ],
  ],
  [
    "unsatisfiable",
    false,
    [
      { kind: "fix", refs: [S("t", "a1")] },
      { kind: "distance", refs: [S("t", "a1")], value: "10" },
    ],
  ],
  [
    "unsatisfiable, three ways",
    false,
    [
      { kind: "distance", refs: [S("t", "a1")], value: "10" },
      { kind: "distance", refs: [S("t", "a2")], value: "10" },
      { kind: "distance", refs: [S("t", "a3")], value: "100" },
    ],
  ],
  [
    "skipped",
    false,
    [
      { kind: "nope" as never, refs: [P("t", "a1")] },
      { kind: "coincident", refs: [P("t", "a1")] },
      { kind: "distance", refs: [S("t", "a1")] },
      { kind: "distance", refs: [S("t", "a1")], value: "2 *" },
      { kind: "radius", refs: [C("c1")], value: "-3" },
      { kind: "radius", refs: [C("t")], value: "3" },
      { kind: "horizontal", refs: [S("o", "a3")] },
      { kind: "fix", refs: [] },
      { kind: "fix", refs: [P("t", "zz")] },
      { kind: "tangent", refs: [P("o", "a1")] },
      { kind: "smooth", refs: [P("t", "a1"), P("t", "a2")] },
      { kind: "symmetric", refs: [P("t", "a1")] },
      { kind: "collinear", refs: [S("t", "a1")] },
      { kind: "equal", refs: [S("t", "a1"), C("c1")] },
      { kind: "angle", refs: [S("t", "a1")], value: "3" },
      { kind: "concentric", refs: [P("t", "a1"), P("t", "a2")] },
    ],
  ],
  [
    "parameters and expressions",
    false,
    [
      { kind: "distance", refs: [S("q", "a1")], value: "w", name: "top" },
      {
        kind: "distance",
        refs: [S("q", "a2")],
        value: "top / 2 + h",
        name: "side",
      },
      { kind: "radius", refs: [C("c1")], value: "side - 10 * pi / pi" },
    ],
    {
      parameters: [
        { name: "w", value: "90" },
        { name: "h", value: "w / 9" },
      ],
    },
  ],
  [
    "a parameter cycle",
    false,
    [{ kind: "distance", refs: [S("q", "a1")], value: "a" }],
    {
      parameters: [
        { name: "a", value: "b + 1" },
        { name: "b", value: "a" },
      ],
    },
  ],
];

function exprVectors(): Entry[] {
  const deep = `${"(".repeat(70)}1${")".repeat(70)}`;
  const long = Array(600).fill("1").join("+");
  const exprs = [
    "1+2*3",
    "-(2+3)/4",
    "pi*2",
    "PI",
    "Pi / 2",
    "1e3",
    "1.5e-3",
    "1e+2",
    ".5",
    "5.",
    "  7 ",
    "  3 ﻿",
    "1.2.3",
    "1..",
    ".",
    "",
    "   ",
    "(1+2",
    "1/0",
    "1/(2-2)",
    "x+1",
    "2*",
    "@",
    "1 2",
    "--3",
    "+4",
    "-+-4",
    "1e309",
    "3e",
    "3e+",
    "0x10",
    "١",
    "a.b",
    "2*(3+4)*5-6/7",
    "0.1+0.2",
    deep,
    `${"(".repeat(40)}1${")".repeat(40)}`,
    `${"-".repeat(70)}1`,
    long,
    "1/3*3",
    "1e-7*1e-7",
    "1e200*1e200",
  ];
  const names = ["a+b*a", "w/2 - pi", "(x)", "-y_1 + Z9", "2 +", "pi"];
  const valid = [
    "a",
    "_",
    "w1",
    "pi",
    "PI",
    "Pi_",
    "1a",
    "a-b",
    "",
    "a".repeat(64),
    "a".repeat(65),
    "é",
    "a b",
  ];
  const values = [
    0,
    -0,
    1,
    -1,
    1 / 3,
    2 / 3,
    -2 / 3,
    0.0078125,
    -0.0078125,
    0.0234375,
    0.9921875,
    1.0000005,
    5e-7,
    4e-7,
    -4e-7,
    123456.7890125,
    1e20,
    1e21,
    1.5e-7,
    2.5,
    0.1 + 0.2,
    99.9999995,
    0.0000015,
    12.5,
    100,
    1234.5,
    -0.0000004,
    9.9999999,
    Number.MAX_SAFE_INTEGER,
  ];
  const envs: [string, string][][] = [
    [
      ["w", "40"],
      ["h", "w / 2"],
      ["area", "w * h"],
    ],
    [
      ["a", "b"],
      ["b", "a"],
    ],
    [["s", "s + 1"]],
    [["u", "missing * 2"]],
    [["bad", "1 +"]],
    Array.from(
      { length: 70 },
      (_, i) => [`p${i}`, i === 69 ? "1" : `p${i + 1} + 1`] as [string, string],
    ),
  ];
  const envOut = (pairs: [string, string][]) => {
    const env = new VectorExprEnv();
    for (const [n, v] of pairs) env.set(n, v);
    const read = (f: () => number) => {
      try {
        return { value: f() };
      } catch (e) {
        return { error: (e as Error).message };
      }
    };
    return {
      values: pairs.map(([n]) => read(() => env.value(n))),
      eval: read(() => env.eval(`${pairs[0][0]} * 2 + 1`)),
      has: [env.has(pairs[0][0]), env.has("nope")],
    };
  };
  const each = <T>(list: T[], f: (v: T) => unknown) =>
    list.map((v) => {
      try {
        return { value: f(v) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    });
  return [
    vec("evalVectorExpression", false, { exprs }, () =>
      each(exprs, (e) => evalVectorExpression(e)),
    ),
    vec("checkVectorExpression", false, { exprs }, () =>
      each(exprs, (e) => (checkVectorExpression(e), true)),
    ),
    vec("vectorExpressionNames", false, { exprs: names }, () =>
      each(names, (e) => vectorExpressionNames(e)),
    ),
    vec("isValidVectorParameterName", false, { names: valid }, () =>
      valid.map(isValidVectorParameterName),
    ),
    vec("formatVectorValue", false, { values }, () =>
      values.map(formatVectorValue),
    ),
    ...envs.map((pairs) =>
      vec("VectorExprEnv", false, { pairs }, () => envOut(pairs)),
    ),
  ];
}

function lmVectors(): Entry[] {
  const mats: { rows: number; cols: number; m: number[] }[] = [
    { rows: 2, cols: 3, m: [1, 2, 3, 2, 4, 6] },
    { rows: 3, cols: 3, m: [1, 0, 0, 0, 1e-9, 0, 0, 0, 3] },
    { rows: 3, cols: 4, m: [2, -1, 0, 0.5, 1, 1, 1, 1, 3, 0, 1, 1.5] },
    { rows: 4, cols: 2, m: [1, 1, 1, -1, 2, 0, 0, 2] },
    { rows: 0, cols: 3, m: [] },
    { rows: 2, cols: 2, m: [0, 0, 0, 0] },
  ];
  const out: Entry[] = [];
  for (const { rows, cols, m } of mats) {
    out.push(
      vec("constraintRank", false, { rows, cols, m }, () => {
        const ns = nullSpace(Float64Array.from(m), rows, cols);
        return {
          rank: rankQr(Float64Array.from(m), rows, cols),
          nullRank: ns.rank,
          basis: ns.basis,
        };
      }),
    );
  }
  out.push(
    vec(
      "constraintQr",
      false,
      {
        cols: [
          [3, 4, 0],
          [1, 0, 1],
          [6, 8, 0],
        ],
        rel: 0,
        abs: 1e-6,
      },
      () => {
        const r = qr(
          [
            [3, 4, 0],
            [1, 0, 1],
            [6, 8, 0],
          ],
          0,
          1e-6,
        );
        return { rank: r.rank, reflectors: r.reflectors };
      },
    ),
  );
  // A circle through three points, a point at a distance: the residuals as the Swift test builds them.
  const systems: {
    name: string;
    x0: number[];
    free: number[];
    weights: number[];
  }[] = [
    { name: "circle3", x0: [0, 0, 1], free: [0, 1, 2], weights: [1, 1, 1] },
    { name: "circle3", x0: [0, 0, 1], free: [0, 1, 2], weights: [1, 1e6, 1] },
    { name: "distance", x0: [0, 0, 3, 4], free: [2, 3], weights: [1, 1, 1, 1] },
    { name: "distance", x0: [0, 0, 3, 4], free: [], weights: [1, 1, 1, 1] },
    { name: "conflict", x0: [1, 2], free: [0, 1], weights: [1, 1] },
  ];
  for (const s of systems) {
    out.push(
      vec("solveLm", false, s, () =>
        solveLm(lmSystem(s.name), s.x0, s.free, s.weights, 1e-9, 200),
      ),
    );
  }
  return out;
}

/** The residual functions `solveLm` vectors use (the Swift test has the same ones). */
function lmSystem(name: string) {
  const pts = [
    [10, 0],
    [0, 7],
    [-9, 1],
  ];
  switch (name) {
    case "circle3":
      return (x: readonly number[], out: number[]) => {
        for (const [px, py] of pts)
          out.push(Math.hypot(px - x[0], py - x[1]) - x[2]);
      };
    case "distance":
      return (x: readonly number[], out: number[]) => {
        out.push(Math.hypot(x[2] - x[0], x[3] - x[1]) - 10);
      };
    default:
      return (x: readonly number[], out: number[]) => {
        out.push(x[0] + x[1] - 1, x[0] + x[1] - 2);
      };
  }
}

function solveVectors(): Entry[] {
  const out: Entry[] = [];
  for (const [name, trig, cons, extra] of SYSTEMS) {
    const d = doc(cons, extra);
    out.push(
      vec("solve", trig, { name, doc: d }, () => {
        const r = solveVectorConstraints(d);
        return {
          document: r.document,
          converged: r.converged,
          conflicts: r.conflicts,
          skipped: r.skipped,
          dof: vectorConstraintDof(d),
          residuals: Object.fromEntries(vectorConstraintResiduals(d)),
          after: Object.fromEntries(vectorConstraintResiduals(r.document)),
        };
      }),
    );
  }
  // What was just edited moves least: anchor a2 of `t` dragged since the previous solve.
  const previous = doc([
    { kind: "distance", refs: [S("t", "a1")], value: "100" },
    { kind: "fix", refs: [P("t", "a3")] },
  ]);
  const solvedPrev = solveVectorConstraints(previous).document;
  const dragged: VectorDocument = json(solvedPrev);
  (dragged.nodes[0] as VectorPathNode).subpaths[0].anchors[1] = {
    ...(dragged.nodes[0] as VectorPathNode).subpaths[0].anchors[1],
    x: 150,
    y: 60,
  };
  out.push(
    vec(
      "solve",
      false,
      { name: "after a drag", doc: dragged, previous: solvedPrev },
      () => solveVectorConstraints(dragged, solvedPrev),
    ),
  );
  out.push(
    vec(
      "solve",
      false,
      { name: "after a drag, no previous", doc: dragged },
      () => solveVectorConstraints(dragged),
    ),
  );
  // A deleted circle, a path whose anchors are gone, and a segment at an open end.
  const stale = doc([
    { kind: "radius", refs: [C("gone")], value: "4" },
    { kind: "horizontal", refs: [S("t", "a9")] },
    { kind: "horizontal", refs: [S("o", "a3")] },
    { kind: "vertical", refs: [S("o", "a2")] },
    { kind: "radius", refs: [C("t")], value: "4" },
  ]);
  out.push(
    vec("purge", false, { doc: stale }, () => purgeVectorConstraints(stale)),
  );
  return out;
}

function addVectors(): Entry[] {
  const out: Entry[] = [];
  const base = doc(
    [
      { kind: "horizontal", refs: [S("q", "a1")] },
      { kind: "distance", refs: [S("q", "a1")], value: "100", name: "d1" },
    ],
    { parameters: [{ name: "w", value: "40" }] },
  );
  const adds: Partial<VectorConstraint>[] = [
    { kind: "vertical", refs: [S("q", "a2")] },
    { kind: "horizontal", refs: [P("q", "a1"), P("q", "a2")] },
    { kind: "distance", refs: [S("q", "a1")], value: "50" },
    { kind: "distance", refs: [S("q", "a2")] },
    { kind: "distance", refs: [S("q", "a2")], value: " w * 2 ", name: "tall" },
    { kind: "distance", refs: [S("q", "a2")], name: "d1" },
    { kind: "distance", refs: [S("q", "a2")], name: "w" },
    { kind: "distance", refs: [S("q", "a2")], name: "2x" },
    { kind: "angle", refs: [S("q", "a1"), S("q", "a2")] },
    { kind: "radius", refs: [C("c1")] },
    { kind: "diameter", refs: [C("c1")], value: "0" },
    { kind: "radius", refs: [C("q")] },
    { kind: "fix", refs: [P("q", "a1")] },
    { kind: "fix", refs: [S("q", "a1")] },
    { kind: "coincident", refs: [P("q", "a1"), P("nope", "a1")] },
    { kind: "coincident", refs: [P("q", "zz"), P("q", "a1")] },
    { kind: "horizontal", refs: [S("q", "a1")], name: "x", value: "3" },
    { kind: "equal", refs: [S("q", "a1"), S("q", "a3")] },
    { kind: "parallel", refs: [S("q", "a1"), S("q", "a3")] },
  ];
  adds.forEach((c, i) => {
    const input = { id: `n${i + 1}`, ...c } as VectorConstraint;
    out.push(
      vec(
        "addVectorConstraint",
        c.kind === "angle",
        { doc: base, constraint: input },
        () => addVectorConstraint(base, input),
      ),
    );
  });
  // A Fix that repeats a Fix, and a full system that refuses more.
  const fixed = doc([{ kind: "fix", refs: [S("t", "a1")] }]);
  out.push(
    vec(
      "addVectorConstraint",
      false,
      {
        doc: fixed,
        constraint: { id: "x", kind: "fix", refs: [P("t", "a1")] },
      },
      () =>
        addVectorConstraint(fixed, {
          id: "x",
          kind: "fix",
          refs: [P("t", "a1")],
        }),
    ),
  );
  out.push(
    vec(
      "addVectorConstraint",
      false,
      {
        doc: fixed,
        constraint: {
          id: "x",
          kind: "distance",
          refs: [S("t", "a1")],
          value: "3",
        },
      },
      () =>
        addVectorConstraint(fixed, {
          id: "x",
          kind: "distance",
          refs: [S("t", "a1")],
          value: "3",
        }),
    ),
  );
  const measures: Pick<VectorConstraint, "kind" | "refs" | "axis">[] = [
    { kind: "distance", refs: [S("t", "a2")] },
    { kind: "distance", refs: [P("t", "a1"), P("t", "a3")], axis: "vertical" },
    { kind: "angle", refs: [S("t", "a1"), S("t", "a3")] },
    { kind: "diameter", refs: [C("c2")] },
    { kind: "horizontal", refs: [S("t", "a1")] },
  ];
  for (const c of measures)
    out.push(
      vec(
        "measureVectorConstraint",
        c.kind === "angle",
        { doc: base, constraint: c },
        () => measureVectorConstraint(base, c),
      ),
    );
  out.push(
    vec("nextVectorConstraintName", false, { doc: base }, () =>
      (["distance", "angle", "radius", "diameter"] as const).map((k) =>
        nextVectorConstraintName(base, k),
      ),
    ),
  );
  return out;
}

function autoVectors(): Entry[] {
  const out: Entry[] = [];
  const nodes: VectorNode[] = [
    {
      id: "r",
      type: "path",
      subpaths: bezierToSubpaths("M10 10 L110 10.3 L110.2 70 L9.8 70.4 Z"),
    } as VectorPathNode,
    {
      id: "l",
      type: "path",
      subpaths: bezierToSubpaths("M110.3 70.2 L180 71 L180.4 130"),
    } as VectorPathNode,
    {
      id: "z",
      type: "path",
      subpaths: bezierToSubpaths("M10 150 L60 151 M70 150.4 L120 150.9"),
    } as VectorPathNode,
    path("k1", circleD(300, 100, 30)),
    path("k2", circleD(300.3, 100.2, 30.2)),
    path("k3", circleD(360.5, 100, 30)),
    {
      id: "tl",
      type: "path",
      subpaths: bezierToSubpaths("M250 69.8 L350 70"),
    } as VectorPathNode,
    {
      id: "grp",
      type: "group",
      children: [
        {
          id: "inner",
          type: "path",
          subpaths: bezierToSubpaths("M400 10 L400.4 80 L470 80.6"),
        } as VectorPathNode,
      ],
    } as VectorNode,
    {
      id: "cv",
      type: "path",
      subpaths: bezierToSubpaths(
        "M400 200 C420 180 440 180 460 200 L520 200.2",
      ),
    } as VectorPathNode,
  ];
  const d: VectorDocument = { width: 600, height: 400, nodes };
  const options: [string[] | null, Record<string, unknown>][] = [
    [null, {}],
    [null, { distanceTolerance: 0.1, angleTolerance: 0.1 }],
    [null, { distanceTolerance: 2, angleTolerance: 3 }],
    [null, { distanceTolerance: -1, angleTolerance: 90 }],
    [null, { kinds: ["horizontal", "vertical"] }],
    [["r", "l"], {}],
    [["grp"], {}],
    [["k1", "k2", "k3", "tl"], { kinds: ["concentric", "tangent", "equal"] }],
  ];
  for (const [ids, opts] of options) {
    out.push(
      vec("inferVectorConstraints", false, { doc: d, ids, options: opts }, () =>
        inferVectorConstraints(withAll(d), ids, opts),
      ),
    );
    out.push(
      vec("autoConstrainVector", false, { doc: d, ids, options: opts }, () => {
        let n = 0;
        const r = autoConstrainVector(d, ids, () => `k${++n}`, opts);
        return { ...r, calls: n };
      }),
    );
  }
  // Anchor ids: existing ids kept, `a<n>` numbering continues, taken ids skipped.
  const named = {
    id: "p",
    type: "path",
    subpaths: [
      {
        closed: false,
        anchors: [
          { x: 0, y: 0, id: "a7" },
          { x: 1, y: 0 },
          { x: 2, y: 0, id: "a8" },
          { x: 3, y: 0, id: "" },
          { x: 4, y: 0, id: "a010" },
        ],
      },
      {
        closed: true,
        anchors: [
          { x: 0, y: 1 },
          { x: 1, y: 1, id: "a11" },
        ],
      },
    ],
  } as VectorPathNode;
  out.push(
    vec("withVectorAnchorIds", false, { node: named }, () =>
      withVectorAnchorIds(named),
    ),
  );
  return out;
}

/** Every path's anchors given ids (what auto-constrain does first). */
function withAll(d: VectorDocument): VectorDocument {
  const map = (list: VectorNode[]): VectorNode[] =>
    list.map((n) =>
      n.type === "path"
        ? withVectorAnchorIds(n)
        : n.type === "group"
          ? { ...n, children: map(n.children) }
          : n,
    );
  return { ...d, nodes: map(d.nodes) };
}

function glyphVectors(): Entry[] {
  const d = doc(
    [
      { kind: "horizontal", refs: [S("t", "a1")] },
      { kind: "distance", refs: [S("q", "a1")], value: "w", name: "top" },
      { kind: "angle", refs: [S("q", "a2"), S("q", "a3")], value: "3 *" },
      { kind: "radius", refs: [C("c1")], value: "40" },
      {
        kind: "coincident",
        refs: [P("h", "a1", { handle: "out" }), P("o", "a1")],
      },
      { kind: "fix", refs: [P("gone", "a1")] },
      { kind: "concentric", refs: [C("c1"), C("c3")] },
    ],
    {
      parameters: [
        { name: "w", value: "100.256" },
        { name: "bad", value: "w +" },
        { name: "loop", value: "loop" },
      ],
    },
  );
  const anchors = (list: [string, number, number][]): VectorAnchorRef[] =>
    list.map(([nodeId, subpath, index]) => ({ nodeId, subpath, index }));
  const selections: { anchors: VectorAnchorRef[]; nodes: string[] }[] = [
    { anchors: [], nodes: [] },
    { anchors: anchors([["t", 0, 1]]), nodes: [] },
    {
      anchors: anchors([
        ["t", 0, 0],
        ["t", 0, 1],
      ]),
      nodes: [],
    },
    {
      anchors: anchors([
        ["t", 0, 2],
        ["t", 0, 0],
      ]),
      nodes: [],
    },
    {
      anchors: anchors([
        ["t", 0, 0],
        ["q", 0, 2],
      ]),
      nodes: [],
    },
    {
      anchors: anchors([
        ["o", 0, 0],
        ["t", 0, 0],
        ["t", 0, 1],
      ]),
      nodes: [],
    },
    {
      anchors: anchors([
        ["o", 0, 0],
        ["q", 0, 0],
        ["t", 0, 1],
      ]),
      nodes: [],
    },
    {
      anchors: anchors([
        ["q", 0, 0],
        ["q", 0, 2],
        ["q", 0, 1],
        ["q", 0, 3],
      ]),
      nodes: [],
    },
    {
      anchors: anchors([
        ["q", 0, 0],
        ["q", 0, 1],
        ["q", 0, 2],
        ["t", 0, 1],
      ]),
      nodes: [],
    },
    { anchors: anchors([["q", 0, 9]]), nodes: ["c1"] },
    { anchors: [], nodes: ["c1"] },
    { anchors: [], nodes: ["c1", "c2"] },
    { anchors: [], nodes: ["c1", "t"] },
    { anchors: [], nodes: ["g"] },
  ];
  const out: Entry[] = [];
  out.push(
    vec("vectorConstraintGlyphs", true, { doc: d, nodeIds: null }, () =>
      vectorConstraintGlyphs(d),
    ),
  );
  out.push(
    vec("vectorConstraintGlyphs", true, { doc: d, nodeIds: ["q", "h"] }, () =>
      vectorConstraintGlyphs(d, new Set(["q", "h"])),
    ),
  );
  for (const s of selections) {
    out.push(
      vec("vectorConstraintActions", false, { doc: d, ...s }, () =>
        vectorConstraintActions(d, s),
      ),
    );
    out.push(
      vec(
        "vectorConstraintPanel",
        true,
        { doc: d, ...s, conflicts: ["k2"] },
        () => vectorConstraintPanel(d, s, ["k2"]),
      ),
    );
  }
  return out;
}

const STEPS: [string, Record<string, unknown>?][] = [
  ["vector.addPath", { d: "M20 20 L120 30 L110 120 Z" }],
  ["vector.addPath", { d: "M200 50 L300 52 L298 150 L201 148 Z" }],
  [
    "vector.addShape",
    { kind: "ellipse", x: 350, y: 50, width: 80, height: 80 },
  ],
  ["vector.listConstraints"],
  [
    "vector.addConstraint",
    {
      kind: "horizontal",
      refs: [{ nodeId: "n1", subpath: 0, index: 0, segment: true }],
    },
  ],
  [
    "vector.addConstraint",
    {
      kind: "horizontal",
      refs: [
        { nodeId: "n1", anchor: "a1" },
        { nodeId: "n1", anchor: "a2" },
      ],
    },
  ],
  [
    "vector.addConstraint",
    {
      kind: "distance",
      refs: [{ nodeId: "n1", subpath: 0, index: 1, segment: true }],
      value: 120,
    },
  ],
  [
    "vector.addConstraint",
    {
      kind: "distance",
      refs: [{ nodeId: "n1", subpath: 0, index: 2, segment: true }],
      value: "d1 / 2",
      name: "half",
    },
  ],
  [
    "vector.addConstraint",
    {
      kind: "distance",
      refs: [{ nodeId: "n1", subpath: 0, index: 2, segment: true }],
      axis: "horizontal",
    },
  ],
  [
    "vector.addConstraint",
    { kind: "radius", refs: [{ nodeId: "n3", circle: true }], value: "w" },
  ],
  ["vector.setConstraintValue", { key: "w", value: 30 }],
  [
    "vector.addConstraint",
    { kind: "radius", refs: [{ nodeId: "n3", circle: true }], value: "w" },
  ],
  [
    "vector.addConstraint",
    {
      kind: "coincident",
      refs: [
        { nodeId: "n1", subpath: 0, index: 2 },
        { nodeId: "n2", subpath: 0, index: 0 },
      ],
    },
  ],
  [
    "vector.addConstraint",
    { kind: "fix", refs: [{ nodeId: "n1", anchor: "a1" }] },
  ],
  [
    "vector.addConstraint",
    { kind: "fix", refs: [{ nodeId: "n1", anchor: "a1" }] },
  ],
  [
    "vector.addConstraint",
    {
      kind: "tangent",
      refs: [
        { nodeId: "n2", subpath: 0, index: 1, segment: true },
        { nodeId: "n3", circle: true },
      ],
    },
  ],
  [
    "vector.addConstraint",
    {
      kind: "coincident",
      refs: [
        { nodeId: "n1", subpath: 0, index: 7 },
        { nodeId: "n2", subpath: 0, index: 0 },
      ],
    },
  ],
  [
    "vector.addConstraint",
    {
      kind: "coincident",
      refs: [
        { nodeId: "n1", anchor: "zz" },
        { nodeId: "n2", subpath: 0, index: 0 },
      ],
    },
  ],
  [
    "vector.addConstraint",
    {
      kind: "coincident",
      refs: [{ nodeId: "n1" }, { nodeId: "n2", subpath: 0, index: 0 }],
    },
  ],
  ["vector.group", { ids: ["n2"] }],
  [
    "vector.addConstraint",
    {
      kind: "coincident",
      refs: [
        { nodeId: "n4", subpath: 0, index: 0 },
        { nodeId: "n1", subpath: 0, index: 0 },
      ],
    },
  ],
  ["vector.listConstraints"],
  ["vector.setConstraintValue", { key: "d1", value: "150" }],
  ["vector.setConstraintValue", { key: "half", value: "w * 3" }],
  ["vector.setConstraintValue", { key: "k1", value: 3 }],
  ["vector.setConstraintValue", { key: "d1", value: null }],
  ["vector.setConstraintValue", { key: "d1", value: "1 / 0" }],
  ["vector.setConstraintValue", { key: "w", value: "half" }],
  ["vector.setConstraintValue", { key: "2w", value: 3 }],
  ["vector.setConstraintValue", { key: "nope", value: null }],
  ["vector.setConstraintValue", { key: "spare", value: 7 }],
  ["vector.setConstraintValue", { key: "spare", value: null }],
  ["vector.setConstraintValue", { key: "d1", value: 5000 }],
  ["vector.moveAnchor", { nodeId: "n1", subpath: 0, index: 1, x: 200, y: 80 }],
  ["vector.listConstraints"],
  ["vector.transform", { ids: ["n1"], dx: 10, dy: -5 }],
  ["vector.listConstraints"],
  ["vector.removeConstraint", { ids: ["k1", "nope"] }],
  ["vector.removeConstraint", { ids: ["k2", "k4"] }],
  ["vector.autoConstrain", { ids: ["missing"] }],
  ["vector.autoConstrain", { distanceTolerance: 3, angleTolerance: 2 }],
  ["vector.autoConstrain", { ids: ["n1"], kinds: ["vertical"] }],
  ["vector.select", { ids: ["n2"] }],
  ["vector.autoConstrain"],
  ["vector.listConstraints"],
  [
    "vector.deleteAnchors",
    { anchors: [{ nodeId: "n1", subpath: 0, index: 2 }] },
  ],
  ["vector.listConstraints"],
  ["vector.delete", { ids: ["n3"] }],
  ["vector.listConstraints"],
];

async function commandVectors() {
  const setup = { width: 600, height: 400 };
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
  return { setup, steps, document: json(host.document()) };
}

async function vectors() {
  return {
    version: 1,
    entries: [
      ...exprVectors(),
      ...lmVectors(),
      ...solveVectors(),
      ...addVectors(),
      ...autoVectors(),
      ...glyphVectors(),
    ],
    commands: await commandVectors(),
  };
}

describe("Swift vector constraint test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    const now = json(await vectors());
    if (process.env.UPDATE_SWIFT_VECTORS)
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    // Numbers within relative 1e-9 (trig differs across CPUs in the last bit).
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
