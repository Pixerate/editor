import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bezierToSubpaths,
  expandVectorAppearance,
  getVectorSceneRenderData,
  isVectorMasterPage,
  parseVectorSvg,
  resolveVectorMasterPages,
  rerouteVectorConnectors,
  routeVectorConnector,
  sanitizeVectorConnector,
  sanitizeVectorFrame,
  sanitizeVectorPerspective,
  sanitizeVectorResizing,
  stripVectorMasterArt,
  transformVectorNode,
  vectorConnectionSites,
  vectorConnectorWorldAnchors,
  vectorDocumentToSvg,
  vectorFrameChildMatrix,
  vectorFrameDocument,
  vectorFrameDrawn,
  vectorMasterPages,
  vectorNodeBounds,
  vectorPages,
  vectorPerspectiveFlatToPlane,
  vectorPerspectiveGridLines,
  vectorPerspectiveMapPath,
  vectorPerspectivePlaneMap,
  vectorPerspectivePlaneToFlat,
  vectorPerspectivePlanes,
  vectorPerspectivePreset,
  vectorPolarAngles,
  findVectorNode,
  subpathsToBezier,
  type VectorDocument,
  type VectorNode,
  type VectorPathNode,
  type VectorPerspective,
} from "../src/vector/index.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";
import { createVectorConformanceHost } from "../src/vector/contract.js";
import { createFakeEffectProvider } from "../src/effects";

/**
 * Test vectors the Swift vector frames, pages, connectors, snapping options and perspective grids
 * (`packages/swift`, `PixerateVector`, #624) check themselves against: frames as drawn, their
 * children's resizing, bounds, transforms and masks (`frames.ts`), master pages (`pages.ts`),
 * connection sites, routes and rerouting (`connectors.ts`), polar angles (`snap.ts`), perspective
 * planes, maps and grid lines (`perspective.ts`), and SVG export, import and render data of frames
 * and connectors. Computed here from the TS core (the spec); a drift from the committed file fails
 * this test (run with UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change, then rerun
 * the Swift tests).
 *
 * Numbers compare exactly where `trig` is false and within relative 1e-9 where the inputs went
 * through `Math.sin` / `Math.cos` (rotated frames and objects); strings always exactly. Key order
 * is not compared.
 *
 * `commands` replays agent commands (`run_command` on `createVectorConformanceHost`): `{ setup,
 * steps: [{ id, params?, result }], document, svg, render }`, where a result is the command's JSON
 * result or `{ error }` with the tool's error text.
 *
 * Shape: `{ version, entries: [{ fn, trig, ...inputs, out }], commands }`.
 */
const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateVectorTests/Fixtures/vector-frame-vectors.json",
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
    out = { error: (e as Error).message };
  }
  return { fn, trig, ...inputs, out: json(out) };
};

const path = (
  id: string,
  d: string,
  extra: Record<string, unknown> = {},
): VectorPathNode =>
  ({
    id,
    type: "path",
    subpaths: bezierToSubpaths(d),
    ...extra,
  }) as VectorPathNode;

const rect = (x: number, y: number, w: number, h: number) =>
  `M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z`;
const ROT = (deg: number, cx = 0, cy = 0) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
};

/** Frames of several kinds: filled, unfilled, unclipped, rotated, with effects and with master art. */
const FRAMES: [string, boolean, VectorNode][] = [
  [
    "filled",
    false,
    {
      id: "f1",
      type: "group",
      name: "Card",
      frame: { x: 10, y: 20, width: 100, height: 60, fill: "#f3f4f6" },
      children: [
        path("a", rect(20, 30, 30, 20), {
          fill: "#2563eb",
          resizing: { horizontal: "scale", vertical: "bottom" },
        }),
        path("b", rect(60, 30, 40, 40), {
          fill: "#e11d48",
          resizing: { horizontal: "leftRight", vertical: "topBottom" },
        }),
        path("c", "M15 25 L105 75", {
          stroke: "#000",
          fill: null,
          resizing: { horizontal: "center", vertical: "center" },
        }),
        path("d", rect(80, 60, 20, 10), {
          fill: "#16a34a",
          resizing: { horizontal: "right" },
        }),
      ],
    } as VectorNode,
  ],
  [
    "unfilled, clipped",
    false,
    {
      id: "f2",
      type: "group",
      frame: { x: 0, y: 0, width: 50, height: 50 },
      children: [path("e", rect(30, 30, 40, 40), { fill: "#000" })],
    } as VectorNode,
  ],
  [
    "unclipped, fill none",
    false,
    {
      id: "f3",
      type: "group",
      frame: { x: 0, y: 0, width: 50, height: 50, fill: "none", clip: false },
      children: [path("g", rect(30, 30, 40, 40), { fill: "#000" })],
    } as VectorNode,
  ],
  [
    "rotated",
    true,
    {
      id: "f4",
      type: "group",
      transform: ROT(30, 50, 50),
      frame: { x: 0, y: 0, width: 100, height: 80, fill: "#fff" },
      children: [
        path("h", rect(10, 10, 20, 20), {
          fill: "#000",
          resizing: { horizontal: "scale", vertical: "scale" },
        }),
      ],
    } as VectorNode,
  ],
  [
    "with master art",
    false,
    {
      id: "f5",
      type: "group",
      frame: { x: 0, y: 0, width: 80, height: 40, fill: "#fff", masterId: "m" },
      masterArt: [
        path("f5~master~x", rect(0, 30, 80, 10), {
          fill: "#888",
          locked: true,
        }),
      ],
      children: [],
    } as unknown as VectorNode,
  ],
];

function frameVectors(): Entry[] {
  const out: Entry[] = [];
  const parents = [
    [1, 0, 0, 1, 0, 0],
    [2, 0, 0, 0.5, 10, -5],
  ];
  for (const [name, trig, node] of FRAMES) {
    out.push(
      vec("vectorFrameDrawn", trig, { name, node }, () =>
        vectorFrameDrawn(node as never),
      ),
    );
    out.push(
      vec("expandVectorAppearance", trig, { name, node }, () =>
        expandVectorAppearance(node),
      ),
    );
    out.push(
      vec("vectorNodeBounds", trig, { name, node, parents }, () =>
        parents.map((p) => vectorNodeBounds(node, p as never)),
      ),
    );
  }
  // Resizing a frame lays its children out by their constraints (and a skew scales them).
  const matrices = [
    [1.5, 0, 0, 1, -5, 0],
    [1, 0, 0, 2, 0, -20],
    [0.5, 0, 0, 0.5, 30, 30],
    [1, 0, 0, 1, 15, -7],
    [1, 0.2, 0, 1, 0, 0],
    [-1, 0, 0, 1, 120, 0],
  ];
  out.push(
    vec(
      "transformVectorNode",
      false,
      { name: "filled", node: FRAMES[0][2], matrices },
      () => matrices.map((m) => transformVectorNode(FRAMES[0][2], m as never)),
    ),
  );
  out.push(
    vec(
      "transformVectorNode",
      false,
      { name: "unclipped", node: FRAMES[2][2], matrices },
      () => matrices.map((m) => transformVectorNode(FRAMES[2][2], m as never)),
    ),
  );
  // Every constraint on both axes, a degenerate box and a shrinking frame.
  const rules = [
    "left",
    "right",
    "leftRight",
    "center",
    "scale",
    undefined,
    "bogus",
  ];
  const vrules = [
    "top",
    "bottom",
    "topBottom",
    "center",
    "scale",
    undefined,
    "bogus",
  ];
  const boxes = [
    { x: 20, y: 30, width: 30, height: 20 },
    { x: 40, y: 40, width: 0, height: 0 },
  ];
  const sizes = [
    [
      { x: 10, y: 20, width: 100, height: 60 },
      { x: 10, y: 20, width: 160, height: 90 },
    ],
    [
      { x: 10, y: 20, width: 100, height: 60 },
      { x: 0, y: 0, width: 20, height: 10 },
    ],
    [
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 5, y: 5, width: 10, height: 10 },
    ],
  ];
  out.push(
    vec("vectorFrameChildMatrix", false, { rules, vrules, boxes, sizes }, () =>
      rules.map((h, i) =>
        boxes.map((box) =>
          sizes.map(([from, to]) =>
            vectorFrameChildMatrix(
              h || vrules[i]
                ? ({ horizontal: h, vertical: vrules[i] } as never)
                : null,
              box,
              from,
              to,
            ),
          ),
        ),
      ),
    ),
  );
  // A frame as a clip mask covers its fill and children, clipped.
  const masked: VectorNode = {
    id: "mg",
    type: "group",
    mask: { type: "clip" },
    children: [
      FRAMES[0][2],
      path("under", rect(0, 0, 200, 200), { fill: "#f00" }),
    ],
  } as VectorNode;
  out.push(
    vec(
      "vectorNodeBounds",
      false,
      { name: "frame mask", node: masked, parents: [[1, 0, 0, 1, 0, 0]] },
      () => [vectorNodeBounds(masked)],
    ),
  );
  out.push(
    vec(
      "expandVectorAppearance",
      false,
      { name: "frame mask", node: masked },
      () => expandVectorAppearance(masked),
    ),
  );
  return out;
}

function sanitizeVectors(): Entry[] {
  const frames = [
    null,
    "x",
    { x: 1, y: 2, width: 3, height: 4 },
    { x: 1, y: 2, width: -3, height: 4 },
    { x: 1, y: 2, width: 3, height: Infinity },
    {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      fill: "#fff",
      clip: false,
      master: true,
      masterId: "m",
      extra: 1,
    },
    {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      fill: { type: "linear", stops: [] },
      clip: true,
      master: false,
      masterId: "",
    },
    { x: 1, y: 2, width: 3, height: 4, fill: 5, masterId: 7 },
  ];
  const resizing = [
    null,
    {},
    { horizontal: "left" },
    { vertical: "topBottom" },
    { horizontal: "nope", vertical: "scale" },
    { horizontal: "center", vertical: "bottom", x: 1 },
    { horizontal: 3 },
  ];
  const connectors = [
    null,
    {},
    {
      start: { nodeId: "a", side: "top" },
      end: { nodeId: "b", side: "auto" },
      route: "elbow",
      radius: 4,
      gap: 0,
    },
    {
      start: { nodeId: "" },
      end: { side: "left" },
      route: "straight",
      radius: 0,
      gap: -1,
    },
    {
      start: { nodeId: "a", side: "middle" },
      end: null,
      route: "zigzag",
      radius: Infinity,
      gap: 3,
    },
    { end: { nodeId: "z", side: "center" }, route: "curved" },
  ];
  const perspectives = [
    null,
    { vanishingPoints: [], origin: { x: 0, y: 0 } },
    { vanishingPoints: [{ x: 10, y: 0 }], origin: { x: 0, y: 0 } },
    {
      vanishingPoints: [
        { x: 10, y: 0 },
        { x: -10, y: 0 },
        { x: 0, y: 50 },
        { x: 1, y: 1 },
      ],
      origin: { x: 0, y: 0 },
    },
    { vanishingPoints: [{ x: 0, y: 0 }], origin: { x: 0, y: 0 } },
    { vanishingPoints: [{ x: 10, y: "0" }], origin: { x: 0, y: 0 } },
    {
      vanishingPoints: [{ x: 10, y: 0, z: 1 }],
      origin: { x: 1, y: 2, w: 0 },
      gridSize: 5000,
      extent: 0.4,
      visible: false,
    },
    {
      vanishingPoints: [
        { x: 10, y: 0 },
        { x: -50, y: 2 },
      ],
      origin: { x: 1, y: 2 },
      gridSize: -1,
      extent: 300.6,
      visible: true,
    },
    {
      vanishingPoints: [{ x: 10, y: 0 }],
      origin: { x: 1, y: 2 },
      gridSize: 12.5,
      extent: 7.5,
    },
  ];
  return [
    vec("sanitizeVectorFrame", false, { values: frames }, () =>
      frames.map((f) => sanitizeVectorFrame(f)),
    ),
    vec("sanitizeVectorResizing", false, { values: resizing }, () =>
      resizing.map((r) => sanitizeVectorResizing(r)),
    ),
    vec("sanitizeVectorConnector", false, { values: connectors }, () =>
      connectors.map((c) => sanitizeVectorConnector(c)),
    ),
    vec("sanitizeVectorPerspective", false, { values: perspectives }, () =>
      perspectives.map((p) => sanitizeVectorPerspective(p)),
    ),
    vec(
      "vectorPolarAngles",
      false,
      {
        cases: [
          [45, []],
          [30, [45, -10, 405, 400]],
          [0, [90]],
          [-5, []],
          [7, []],
          [360, [0, 180.0000000001]],
          [0.5, []],
          [Infinity, [12]],
        ],
      },
      () =>
        (
          [
            [45, []],
            [30, [45, -10, 405, 400]],
            [0, [90]],
            [-5, []],
            [7, []],
            [360, [0, 180.0000000001]],
            [0.5, []],
            [Infinity, [12]],
          ] as [number, number[]][]
        ).map(([i, a]) => vectorPolarAngles(i, a)),
    ),
  ];
}

/** Objects to connect: plain, in a moved group, rotated, hidden, a connector and an empty group. */
const CONNECT_NODES: VectorNode[] = [
  path("p", rect(10, 10, 40, 30), { fill: "#00f" }),
  {
    id: "g",
    type: "group",
    transform: [1, 0, 0, 1, 100, 50],
    children: [path("q", rect(0, 0, 20, 20), { fill: "#0f0" })],
  } as VectorNode,
  path("r", rect(200, 100, 40, 20), {
    fill: "#f00",
    transform: ROT(90, 220, 110),
  }),
  path("hidden", rect(0, 200, 10, 10), { visible: false }),
  path("k1", "M0 0 L10 10", {
    fill: null,
    stroke: "#000",
    connector: {
      start: { nodeId: "p", side: "right" },
      end: { nodeId: "q" },
      route: "elbow",
      radius: 6,
    },
  }),
  path("k2", "M300 300 L320 330", {
    fill: null,
    stroke: "#000",
    connector: { start: { nodeId: "p" }, end: null, route: "curved", gap: 30 },
  }),
  path("k3", "M0 0 L1 1", {
    fill: null,
    stroke: "#000",
    connector: {
      start: { nodeId: "gone", side: "top" },
      end: { nodeId: "p", side: "bottom" },
    },
  }),
  path("k4", "M0 0 L1 1", {
    fill: null,
    stroke: "#000",
    connector: {
      start: { nodeId: "r", side: "left" },
      end: { nodeId: "p", side: "center" },
      route: "elbow",
    },
  }),
  path("k5", "M0 0 L1 1", {
    fill: null,
    stroke: "#000",
    connector: { start: { nodeId: "k5" }, end: { nodeId: "hidden" } },
  }),
  { id: "empty", type: "group", children: [] } as VectorNode,
  {
    id: "inner",
    type: "group",
    transform: [2, 0, 0, 2, 0, 0],
    children: [
      path("k6", "M5 5 L6 6", {
        fill: null,
        stroke: "#000",
        connector: {
          start: { nodeId: "p", side: "top" },
          end: { nodeId: "q", side: "bottom" },
          route: "curved",
        },
      }),
    ],
  } as VectorNode,
];

function connectorVectors(): Entry[] {
  const out: Entry[] = [];
  const ids = ["p", "q", "g", "r", "hidden", "k1", "empty", "nope"];
  const trigIds = new Set(["r"]);
  for (const id of ids)
    out.push(
      vec(
        "vectorConnectionSites",
        trigIds.has(id),
        { nodes: CONNECT_NODES, id },
        () => vectorConnectionSites(CONNECT_NODES, id),
      ),
    );
  // Every pair of end kinds, each route, with and without radius / gap.
  const E = (x: number, y: number, nx: number, ny: number, glued: boolean) => ({
    x,
    y,
    nx,
    ny,
    glued,
  });
  const ends = [
    [E(0, 0, 1, 0, true), E(100, 50, -1, 0, true)],
    [E(0, 0, 1, 0, true), E(100, 50, 0, -1, true)],
    [E(0, 0, 0, 1, true), E(100, 50, 0, -1, true)],
    [E(0, 0, 0, -1, true), E(100, 50, 0, 1, true)],
    [E(0, 0, -1, 0, true), E(100, 50, 1, 0, true)],
    [E(0, 0, 0, 0, false), E(100, 50, 0, 0, false)],
    [E(0, 0, 0, 0, false), E(-30, 80, 0, 1, true)],
    [E(0, 0, 0, 0, true), E(0, 0, 0, 0, false)],
    [E(0, 0, 0.6, 0.8, true), E(40, -20, -0.8, 0.6, true)],
  ];
  const options = [{}, { radius: 5 }, { gap: 0 }, { gap: 40, radius: 3 }];
  for (const route of ["straight", "elbow", "curved"] as const)
    out.push(
      vec("vectorConnectorWorldAnchors", false, { route, ends, options }, () =>
        ends.map(([a, b]) =>
          options.map((o) => vectorConnectorWorldAnchors(a, b, route, o)),
        ),
      ),
    );
  const cids = ["k1", "k2", "k3", "k4", "k5", "k6", "p"];
  out.push(
    vec("routeVectorConnector", true, { nodes: CONNECT_NODES, ids: cids }, () =>
      cids.map((id) => routeVectorConnector(CONNECT_NODES, id)),
    ),
  );
  const doc = { width: 400, height: 400, nodes: CONNECT_NODES };
  const once = rerouteVectorConnectors(doc);
  out.push(vec("rerouteVectorConnectors", true, { doc }, () => once));
  out.push(
    vec("rerouteVectorConnectors", true, { name: "again", doc: once }, () => ({
      same: rerouteVectorConnectors(once) === once,
      doc: rerouteVectorConnectors(once),
    })),
  );
  return out;
}

const GRIDS: VectorPerspective[] = [
  {
    vanishingPoints: [{ x: 200, y: 100 }],
    origin: { x: 200, y: 250 },
    gridSize: 25,
    extent: 4,
  },
  {
    vanishingPoints: [
      { x: 50, y: 100 },
      { x: 350, y: 100 },
    ],
    origin: { x: 200, y: 250 },
  },
  {
    vanishingPoints: [
      { x: -100, y: 120 },
      { x: 500, y: 110 },
      { x: 210, y: 900 },
    ],
    origin: { x: 190, y: 260 },
    gridSize: 30,
    extent: 3,
  },
  {
    vanishingPoints: [
      { x: 350, y: 100 },
      { x: 50, y: 100 },
      { x: 200, y: -500 },
    ],
    origin: { x: 200, y: 250 },
    gridSize: 40,
    extent: 2,
  },
];

function perspectiveVectors(): Entry[] {
  const out: Entry[] = [];
  const planes = ["floor", "left", "right", "side", "front"] as const;
  const samples = [
    { x: 200, y: 250 },
    { x: 220, y: 230 },
    { x: 150, y: 200 },
    { x: 260, y: 100 },
    { x: 200, y: -2000 },
    { x: 1000, y: 250 },
  ];
  const paths = [
    rect(200, 210, 40, 40),
    "M180 250 C190 200 230 200 240 250",
    rect(100, -800, 30, 30),
  ];
  for (const grid of GRIDS) {
    out.push(
      vec("vectorPerspectivePlanes", false, { grid }, () =>
        vectorPerspectivePlanes(grid),
      ),
    );
    out.push(
      vec("vectorPerspectivePlaneMap", false, { grid }, () =>
        planes.map((p) => vectorPerspectivePlaneMap(grid, p)),
      ),
    );
    out.push(
      vec("vectorPerspectiveFlatToPlane", false, { grid, samples }, () =>
        planes.map((p) => {
          const f = vectorPerspectiveFlatToPlane(grid, p);
          return f ? samples.map((q) => f(q)) : null;
        }),
      ),
    );
    out.push(
      vec("vectorPerspectivePlaneToFlat", false, { grid, samples }, () =>
        planes.map((p) => {
          const f = vectorPerspectivePlaneToFlat(grid, p);
          return f ? samples.map((q) => f(q)) : null;
        }),
      ),
    );
    out.push(
      vec("vectorPerspectiveMapPath", false, { grid, paths }, () =>
        planes.map((p) =>
          paths.map((d) => {
            const r = vectorPerspectiveMapPath(
              grid,
              p,
              subpathsToBezier(bezierToSubpaths(d)),
            );
            return r ? bezierToSubpaths(r) : null;
          }),
        ),
      ),
    );
    out.push(
      vec("vectorPerspectiveGridLines", false, { grid }, () =>
        planes.map((p) => vectorPerspectiveGridLines(grid, p)),
      ),
    );
  }
  out.push(
    vec(
      "vectorPerspectivePreset",
      false,
      {
        cases: [
          [1, 800, 600],
          [2, 400, 300],
          [3, 100, 37],
        ],
      },
      () => [
        vectorPerspectivePreset(1, 800, 600),
        vectorPerspectivePreset(2, 400, 300),
        vectorPerspectivePreset(3, 100, 37),
      ],
    ),
  );
  return out;
}

/** Master pages, pages and their drawn art; one frame on its own; SVG and render data of frames. */
function pageVectors(): Entry[] {
  const out: Entry[] = [];
  const master: VectorNode = {
    id: "m",
    type: "group",
    name: "Master",
    frame: { x: 0, y: 300, width: 200, height: 100, master: true },
    children: [
      path("footer", rect(0, 380, 200, 20), {
        fill: "#888",
        resizing: { horizontal: "leftRight", vertical: "bottom" },
      }),
      path("logo", rect(10, 310, 20, 20), { fill: "#000" }),
      path("ghost", rect(50, 310, 20, 20), { fill: "#000", visible: false }),
      {
        id: "badge",
        type: "group",
        resizing: { horizontal: "right" },
        children: [path("dot", rect(170, 310, 20, 20), { fill: "#f00" })],
      } as VectorNode,
      { id: "nothing", type: "group", children: [] } as VectorNode,
    ],
  } as VectorNode;
  const doc: VectorDocument = {
    width: 600,
    height: 500,
    background: "#eeeeee",
    nodes: [
      {
        id: "p1",
        type: "group",
        name: "One",
        frame: {
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          fill: "#fff",
          masterId: "m",
        },
        children: [path("t1", rect(20, 20, 50, 50), { fill: "#2563eb" })],
      } as VectorNode,
      path("loose", rect(250, 250, 10, 10), { fill: "#000" }),
      {
        id: "p2",
        type: "group",
        frame: {
          x: 240,
          y: 0,
          width: 300,
          height: 160,
          fill: "#fff",
          masterId: "m",
        },
        children: [],
      } as VectorNode,
      {
        id: "p3",
        type: "group",
        frame: { x: 0, y: 150, width: 100, height: 100, masterId: "missing" },
        children: [],
      } as VectorNode,
      master,
    ],
    symbols: [{ id: "s", name: "S", nodes: [path("sp", rect(0, 0, 5, 5))] }],
  };
  const resolved = resolveVectorMasterPages(doc);
  out.push(vec("resolveVectorMasterPages", false, { doc }, () => resolved));
  out.push(
    vec(
      "resolveVectorMasterPages",
      false,
      { name: "again", doc: resolved },
      () => ({
        same: resolveVectorMasterPages(resolved) === resolved,
        doc: resolveVectorMasterPages(resolved),
      }),
    ),
  );
  out.push(
    vec("stripVectorMasterArt", false, { doc: resolved }, () =>
      stripVectorMasterArt(resolved),
    ),
  );
  out.push(
    vec("pageLists", false, { doc }, () => ({
      pages: vectorPages(doc).map((p) => p.id),
      masters: vectorMasterPages(doc).map((m) => m.id),
      isMaster: doc.nodes.map((n) => isVectorMasterPage(n)),
    })),
  );
  out.push(
    vec(
      "vectorFrameDocument",
      false,
      { doc, ids: ["p1", "p2", "m", "loose", "nope"] },
      () =>
        ["p1", "p2", "m", "loose", "nope"].map((id) =>
          vectorFrameDocument(doc, id, findVectorNode),
        ),
    ),
  );
  // SVG export (pages with master art, an unclipped frame, connectors, a frame with effects) and import.
  const svgDoc: VectorDocument = {
    ...doc,
    nodes: [
      ...doc.nodes,
      FRAMES[2][2],
      {
        ...FRAMES[1][2],
        effects: [{ id: "fx", type: "roundCorners", params: { radius: 3 } }],
      } as VectorNode,
      path("link", "M0 0 L1 1", {
        fill: null,
        stroke: "#333",
        strokeWidth: 2,
        connector: {
          start: { nodeId: "t1", side: "right" },
          end: { nodeId: "loose" },
          route: "elbow",
          radius: 4,
        },
      }),
    ],
  };
  const routed = { ...svgDoc, nodes: rerouteVectorConnectors(svgDoc).nodes };
  const svg = vectorDocumentToSvg(routed);
  out.push(vec("vectorDocumentToSvg", false, { doc: routed }, () => svg));
  out.push(vec("parseVectorSvg", false, { svg }, () => parseVectorSvg(svg)));
  const rotated: VectorDocument = {
    width: 200,
    height: 200,
    nodes: [FRAMES[3][2]],
  };
  const rsvg = vectorDocumentToSvg(rotated);
  out.push(vec("vectorDocumentToSvg", true, { doc: rotated }, () => rsvg));
  out.push(
    vec("parseVectorSvg", true, { svg: rsvg }, () => parseVectorSvg(rsvg)),
  );
  out.push(
    vec("getVectorSceneRenderData", false, { doc: routed }, () =>
      getVectorSceneRenderData({
        document: routed,
        viewport: { x: 0, y: 0, zoom: 1 },
      } as never),
    ),
  );
  return out;
}

const STEPS: [string, Record<string, unknown>?][] = [
  [
    "vector.addShape",
    { kind: "rect", x: 20, y: 20, width: 60, height: 40, fill: "#2563eb" },
  ],
  [
    "vector.addShape",
    { kind: "ellipse", x: 120, y: 30, width: 40, height: 40, fill: "#e11d48" },
  ],
  ["vector.listPages"],
  ["vector.addPage", { name: "Cover" }],
  ["vector.addPage", { masterId: "nope" }],
  ["vector.addPage", { after: "nope" }],
  ["vector.addPage"],
  ["vector.addMasterPage", { assignTo: ["n1"] }],
  ["vector.addMasterPage", { name: "Footer", assignTo: "all" }],
  [
    "vector.addPath",
    { d: "M0 360 L400 360 L400 380 L0 380 Z", parentId: "n5", fill: "#999" },
  ],
  [
    "vector.setResizing",
    { ids: ["n6"], horizontal: "leftRight", vertical: "bottom" },
  ],
  ["vector.addPage", { name: "Inserted", after: "n3", masterId: null }],
  ["vector.listPages"],
  ["vector.setPageMaster", { masterId: null, ids: ["n4"] }],
  ["vector.setPageMaster", { masterId: "n3", ids: ["n4"] }],
  ["vector.setPageMaster", { masterId: "n5", ids: ["n5"] }],
  ["vector.setPageMaster", { masterId: "n5" }],
  ["vector.movePage", { id: "n4", index: 0 }],
  ["vector.movePage", { id: "n4", index: 7 }],
  ["vector.movePage", { id: "n5", index: 0 }],
  ["vector.goToPage", { id: "n5" }],
  ["vector.goToPage", { id: "n1" }],
  ["vector.addFrame", { x: 500, y: 500, width: 100, height: 80 }],
  [
    "vector.addFrame",
    {
      x: 500,
      y: 600,
      width: 100,
      height: 80,
      name: "Clear",
      fill: null,
      clip: false,
    },
  ],
  [
    "vector.addShape",
    {
      kind: "star",
      x: 520,
      y: 520,
      width: 30,
      height: 30,
      fill: "#facc15",
      parentId: "n8",
    },
  ],
  [
    "vector.addShape",
    {
      kind: "rect",
      x: 560,
      y: 540,
      width: 20,
      height: 20,
      fill: "#16a34a",
      parentId: "n8",
    },
  ],
  ["vector.setResizing", { ids: ["n10"], horizontal: "right" }],
  ["vector.setResizing", { ids: ["n10"], vertical: "center" }],
  ["vector.setResizing", { ids: ["n8"], horizontal: "left" }],
  ["vector.setResizing", { ids: ["n10"] }],
  ["vector.setFrame", { ids: ["n8"], x: 480, height: 120, fill: "#fafafa" }],
  ["vector.setFrame", { ids: ["n8"], clip: false, fill: null }],
  ["vector.setFrame", { ids: ["n10"], width: 5 }],
  ["vector.setFrame", { ids: ["n8"] }],
  ["vector.select", { ids: ["n10"] }],
  ["vector.setFrame", { width: 140 }],
  ["vector.listFrames"],
  [
    "vector.frameSelection",
    { ids: ["n9", "n10"], padding: 4, fill: "#ffffff", clip: false },
  ],
  ["vector.frameSelection", { ids: ["n9", "n1"] }],
  ["vector.frameSelection", { ids: ["n2"], name: "Ring" }],
  ["vector.exportFrameSvg", { id: "n8", precision: 2 }],
  ["vector.exportFrameSvg", { id: "n2" }],
  ["vector.listConnectionSites", { id: "n2" }],
  ["vector.listConnectionSites", { id: "nope" }],
  [
    "vector.connect",
    {
      start: { nodeId: "n12" },
      end: { nodeId: "n8", side: "top" },
      endArrow: null,
    },
  ],
  [
    "vector.connect",
    {
      start: { nodeId: "n9", side: "right" },
      end: { x: 700, y: 700 },
      route: "elbow",
      radius: 8,
      gap: 10,
      startArrow: null,
      endArrow: null,
      name: "Wire",
      stroke: "#334155",
      strokeWidth: 3,
    },
  ],
  ["vector.connect", { start: { nodeId: "n12" }, end: { nodeId: "n12" } }],
  ["vector.connect", { start: { nodeId: "n13" }, end: { nodeId: "n8" } }],
  [
    "vector.connect",
    { start: { nodeId: "n6" }, end: { nodeId: "n9" }, route: "curved" },
  ],
  ["vector.listConnectors"],
  ["vector.transform", { ids: ["n12"], dx: 40, dy: 100 }],
  ["vector.listConnectors"],
  ["vector.setConnector", { ids: ["n13"], route: "curved", gap: 0 }],
  ["vector.setConnector", { ids: ["n14"], start: null, radius: 0 }],
  ["vector.setConnector", { ids: ["n14"], end: { nodeId: "n14" } }],
  ["vector.setConnector", { ids: ["n1"], route: "elbow" }],
  ["vector.setConnector", { ids: ["n13"] }],
  ["vector.delete", { ids: ["n15"] }],
  ["vector.delete", { ids: ["n8"] }],
  ["vector.listConnectors"],
  ["vector.getSnapOptions"],
  ["vector.setSnapOptions", { polarIncrement: 30, additionalAngles: [45] }],
  ["vector.setSnapOptions", { additionalAngles: [45] }],
  ["vector.setSnapOptions", {}],
  [
    "vector.setSnapOptions",
    {
      grid: 8,
      threshold: 3,
      tracking: false,
      trackPolar: true,
      polarRelative: true,
    },
  ],
  ["vector.getPerspective"],
  ["vector.setPerspectivePlane", { plane: "floor" }],
  ["vector.attachToPerspective", { ids: ["n12"], plane: "floor" }],
  [
    "vector.setPerspective",
    {
      vanishingPoints: [{ x: 300, y: 100 }],
      origin: { x: 300, y: 400 },
      gridSize: 25,
      extent: 6,
    },
  ],
  ["vector.setPerspectivePlane", { plane: "left" }],
  ["vector.setPerspectivePlane", { plane: "side" }],
  ["vector.attachToPerspective", { ids: ["n12"], plane: "front" }],
  ["vector.attachToPerspective", { ids: ["n2"], plane: "floor" }],
  [
    "vector.setPerspective",
    {
      vanishingPoints: [
        { x: 0, y: 100 },
        { x: 900, y: 100 },
      ],
      origin: { x: 450, y: 700 },
      visible: false,
    },
  ],
  ["vector.attachToPerspective", { ids: ["n6"], plane: "right" }],
  ["vector.getPerspective"],
  ["vector.removePerspective"],
  ["vector.getPerspective"],
  ["vector.list"],
];

async function commandVectors() {
  const setup = { width: 400, height: 400 };
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
  const svg = (await run("vector.exportSvg")) as { result?: { svg?: string } };
  return {
    setup,
    steps,
    document: json(host.document()),
    svg: svg.result?.svg ?? svg,
    render: json(host.render?.()),
  };
}

async function vectors() {
  return {
    version: 1,
    entries: [
      ...frameVectors(),
      ...sanitizeVectors(),
      ...connectorVectors(),
      ...perspectiveVectors(),
      ...pageVectors(),
    ],
    commands: await commandVectors(),
  };
}

describe("Swift vector frame test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    const now = json(await vectors());
    if (process.env.UPDATE_SWIFT_VECTORS)
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    // Numbers within relative 1e-9 (trig differs across CPUs in the last bit).
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
