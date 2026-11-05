import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyVectorGradientPatch,
  createVectorEffect,
  createVectorFilter,
  defaultVectorGradient,
  expandVectorAppearance,
  getVectorSceneRenderData,
  vectorDocumentToSvg,
  parseVectorColor,
  resolveVectorLenses,
  sanitizeVectorEffects,
  sanitizeVectorFilters,
  sanitizeVectorLens,
  transformVectorNode,
  vectorAppearanceNodes,
  vectorFilterMarkup,
  vectorFilterSvg,
  vectorLensDrawn,
  vectorMaskSummary,
  vectorNodeBounds,
  VECTOR_EFFECT_TYPES,
  type VectorEffectType,
  type VectorLensNode,
  type VectorNode,
  type VectorPathNode,
} from "../src/vector/index.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";
import { createVectorConformanceHost } from "../src/vector/contract.js";
import { createFakeEffectProvider } from "../src/effects";

/**
 * Test vectors the Swift vector appearance (`packages/swift`, `PixerateVector`, #624) checks
 * itself against: path effects expanded (`appearance.ts`, `pathEffects.ts`), masked shapes and
 * bounds (`mask.ts`), filters (`filters.ts`), lenses (`lens.ts`) and gradient edits
 * (`gradient.ts`). Computed here from the TS core (the spec); a drift from the committed file
 * fails this test (run with UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change, then
 * rerun the Swift tests).
 *
 * Numbers compare within relative 1e-9 where they went through trig (`trig: true`: rotations,
 * round joins and corners, sweeps) and exactly otherwise. Key order is not compared: the Swift
 * port builds these objects with the TS keys, but spreads that set a key to `undefined` keep
 * places JSON drops.
 *
 * `commands` replays agent commands (`run_command` on `createVectorConformanceHost`) for their
 * failures and edge cases: `{ setup, steps: [{ id, params?, result }], document }`, where a
 * result is the command's JSON result or `{ error }` with the tool's error text.
 *
 * Shape: `{ version, entries: [{ fn, trig, ...inputs, out }], commands }`.
 */
const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateVectorTests/Fixtures/vector-appearance-vectors.json",
);

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const vec = (
  fn: string,
  trig: boolean,
  inputs: Entry,
  compute: () => unknown,
): Entry => ({ fn, trig, ...inputs, out: json(compute()) });

const rect = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  style: Partial<VectorPathNode> = {},
): VectorPathNode => ({
  id,
  type: "path",
  fill: "#2563eb",
  stroke: "#111827",
  strokeWidth: 2,
  ...style,
  subpaths: [
    {
      closed: true,
      anchors: [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
    },
  ],
});
const curve: VectorPathNode = {
  id: "c",
  type: "path",
  fill: null,
  stroke: "#000000",
  strokeWidth: 1,
  subpaths: [
    {
      closed: false,
      anchors: [
        { x: 0, y: 0, out: { x: 30, y: -40 } },
        { x: 80, y: 10, in: { x: 60, y: 50 } },
        { x: 120, y: 0 },
      ],
    },
  ],
};

/** Every effect type on a rectangle and an open curve, with parameters that exercise it. */
const EFFECTS: [VectorEffectType, Record<string, unknown>, boolean][] = [
  ["trim", { start: 10, end: 70, offset: 30 }, false],
  ["trim", { start: 20, end: 90, mode: "individual" }, false],
  ["roundCorners", { radius: 12 }, true],
  ["puckerBloat", { amount: 40 }, false],
  ["puckerBloat", { amount: -60 }, false],
  ["twist", { angle: 60, center: { x: 5, y: -3 } }, true],
  ["zigzag", { size: 4, ridges: 3, smooth: true }, false],
  ["zigzag", { size: 2, ridges: 5 }, false],
  [
    "wiggle",
    { size: 6, detail: 4, seed: 7, time: 0.5, correlation: 30 },
    false,
  ],
  ["offset", { amount: 5, join: "round", copies: 2 }, true],
  ["offset", { amount: -4, join: "miter" }, true],
  [
    "repeater",
    { copies: 2.5, rotation: 15, scale: { x: 90, y: 80 }, startOpacity: 50 },
    true,
  ],
  [
    "repeater",
    { copies: 3, composite: "above", position: { x: 0, y: 70 } },
    true,
  ],
  [
    "contour",
    { steps: 3, offset: 5, fillColor: "#ff0000", acceleration: 40 },
    true,
  ],
  [
    "contour",
    { direction: "outside", steps: 2, offset: 4, strokeColor: "#00ff00" },
    true,
  ],
  ["blockShadow", { distance: 30, endOpacity: 20 }, true],
  ["blockShadow", { angle: 120, distance: 12, color: null }, true],
];

function effectVectors(): Entry[] {
  const out: Entry[] = [];
  for (const [type, params, trig] of EFFECTS) {
    for (const base of [rect("r", 0, 0, 100, 60), curve]) {
      const node = {
        ...base,
        effects: [createVectorEffect(type, "fx1", params)!],
      } as VectorNode;
      out.push(
        vec("expandVectorAppearance", trig, { node }, () =>
          expandVectorAppearance(node),
        ),
      );
      out.push(
        vec("vectorNodeBounds", trig, { node }, () => vectorNodeBounds(node)),
      );
    }
  }
  // A stack: effects apply top to bottom; a disabled one is skipped.
  const stacked = {
    ...rect("r", 0, 0, 100, 60),
    effects: sanitizeVectorEffects([
      { type: "zigzag", params: { size: 3, ridges: 1 } },
      { type: "roundCorners", enabled: false },
      { type: "puckerBloat", params: { amount: 10 } },
    ]),
  } as VectorNode;
  out.push(
    vec("expandVectorAppearance", false, { node: stacked }, () =>
      expandVectorAppearance(stacked),
    ),
  );
  // Merge Paths over a group's children.
  for (const mode of ["merge", "add", "subtract", "intersect", "exclude"]) {
    const group = {
      id: "g",
      type: "group",
      effects: [createVectorEffect("merge", "fx1", { mode })!],
      children: [
        rect("a", 0, 0, 100, 60),
        rect("b", 50, 30, 100, 60, { fill: "#e11d48" }),
      ],
    } as VectorNode;
    out.push(
      vec("expandVectorAppearance", false, { node: group }, () =>
        expandVectorAppearance(group),
      ),
    );
  }
  // Defaults and sanitising.
  out.push(
    vec("createVectorEffect", false, { types: VECTOR_EFFECT_TYPES }, () =>
      VECTOR_EFFECT_TYPES.map((t) => createVectorEffect(t, `fx-${t}`)),
    ),
  );
  const raw = [
    {
      type: "zigzag",
      params: { size: 300, ridges: 2.5, smooth: "yes", extra: 1 },
    },
    { type: "nope" },
    { id: "a", type: "twist", params: { center: { x: 1 } } },
    {
      id: "a",
      type: "contour",
      params: { fillColor: "nope", strokeColor: "#123", join: "odd" },
      enabled: false,
    },
  ];
  out.push(
    vec("sanitizeVectorEffects", false, { effects: raw }, () =>
      sanitizeVectorEffects(raw),
    ),
  );
  // Effects carried through a baked transform.
  const moved = {
    ...rect("r", 0, 0, 100, 60),
    effects: [
      createVectorEffect("twist", "fx1", {
        angle: 30,
        center: { x: 5, y: 2 },
      })!,
      createVectorEffect("repeater", "fx2", {
        rotation: 10,
        position: { x: 20, y: 5 },
        anchor: { x: 3, y: 4 },
      })!,
    ],
  } as VectorNode;
  for (const m of [
    [-2, 0, 0, 1, 10, 0],
    [1, 0.5, 0, 1, 0, 0],
  ] as const)
    out.push(
      vec("transformVectorNode", false, { node: moved, m }, () =>
        transformVectorNode(moved, [...m]),
      ),
    );
  return out;
}

function maskVectors(): Entry[] {
  const out: Entry[] = [];
  const mask = rect("m", 30, -20, 50, 60, {
    fill: "#000000",
    stroke: "#18181b",
    strokeWidth: 4,
  });
  const line: VectorPathNode = {
    id: "l",
    type: "path",
    fill: null,
    stroke: "#000",
    strokeWidth: 1,
    subpaths: [
      {
        closed: false,
        anchors: [
          { x: -10, y: 20 },
          { x: 120, y: 20 },
        ],
      },
    ],
  };
  for (const settings of [
    { type: "clip" },
    { type: "clip", invert: true },
    { type: "luminance" },
    { type: "alpha", invert: true },
  ] as const) {
    const group = {
      id: "g",
      type: "group",
      mask: settings,
      children: [mask, rect("r", 0, 0, 100, 60), line],
    } as VectorNode;
    out.push(
      vec("vectorNodeBounds", false, { node: group }, () =>
        vectorNodeBounds(group),
      ),
    );
    out.push(
      vec("vectorAppearanceNodes", false, { node: group }, () =>
        vectorAppearanceNodes(group),
      ),
    );
    out.push(
      vec("vectorMaskSummary", false, { node: group }, () =>
        vectorMaskSummary(group),
      ),
    );
  }
  // A hidden mask turns it off; effects of the group act on the contents only.
  const off = {
    id: "g",
    type: "group",
    mask: { type: "clip" },
    children: [{ ...mask, visible: false }, rect("r", 0, 0, 100, 60)],
  } as VectorNode;
  out.push(
    vec("vectorNodeBounds", false, { node: off }, () => vectorNodeBounds(off)),
  );
  const effected = {
    id: "g",
    type: "group",
    mask: { type: "clip" },
    effects: [createVectorEffect("puckerBloat", "fx1", { amount: 20 })!],
    children: [mask, rect("r", 0, 0, 100, 60)],
  } as VectorNode;
  out.push(
    vec("expandVectorAppearance", false, { node: effected }, () =>
      expandVectorAppearance(effected),
    ),
  );
  out.push(
    vec("vectorNodeBounds", false, { node: effected }, () =>
      vectorNodeBounds(effected),
    ),
  );
  return out;
}

function filterVectors(): Entry[] {
  const out: Entry[] = [];
  const stacks = [
    [
      createVectorFilter("dropShadow", "f1", {
        offsetX: 3,
        blur: 6,
        spread: 2,
      }),
      createVectorFilter("innerGlow", "f2", {}),
      createVectorFilter("feather", "f3", {}),
      createVectorFilter("layerBlur", "f4", {}),
    ],
    [
      createVectorFilter("innerShadow", "f1", {
        offsetX: -2,
        offsetY: 0,
        spread: 3,
        blur: 0,
      }),
      createVectorFilter("outerGlow", "f2", { opacity: 0 }),
    ],
    [{ ...createVectorFilter("dropShadow", "f1")!, enabled: false }],
    sanitizeVectorFilters([
      { type: "outerGlow", params: { blur: 900, color: "  #fff ", bogus: 1 } },
      { type: "nope" },
      { id: "x", type: "layerBlur", params: { radius: 2 } },
    ]),
  ];
  for (const filters of stacks) {
    const bounds = { x: 0, y: 0, width: 100, height: 60 };
    out.push(
      vec("vectorFilterSvg", false, { filters, bounds }, () => {
        const f = vectorFilterSvg(filters as never, "vf", bounds);
        return f && { filter: f, markup: vectorFilterMarkup(f) };
      }),
    );
  }
  return out;
}

function lensVectors(): Entry[] {
  const out: Entry[] = [];
  const under = [
    rect("u", 0, 0, 100, 60),
    rect("v", 60, 20, 40, 40, {
      fill: {
        type: "linear",
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 1, color: "rgba(0, 0, 255, 0.5)" },
        ],
      } as never,
      fills: [
        { paint: "#ff0000" },
        { paint: "#00ff00", opacity: 0.5 },
      ] as never,
    }),
  ];
  const lenses = [
    { type: "magnify", amount: 2 },
    { type: "fisheye", amount: -40 },
    { type: "invert", amount: 50 },
    { type: "heatMap", amount: 30 },
    { type: "tintedGrayscale" },
    { type: "wireframe", amount: 60 },
    { type: "transparency", amount: 25 },
  ];
  for (const lens of lenses) {
    const node = {
      ...rect("L", 30, -20, 50, 60, {
        fill: "#000000",
        stroke: "#18181b",
        strokeWidth: 4,
      }),
      transform: [1, 0, 0, 1, 5, 5],
      lens: sanitizeVectorLens(lens)!,
    } as VectorNode;
    const doc = resolveVectorLenses({
      width: 200,
      height: 200,
      nodes: [...under, node],
    });
    out.push(
      vec("vectorLensDrawn", true, { nodes: [...under, node] }, () =>
        vectorLensDrawn(doc.nodes[doc.nodes.length - 1] as VectorLensNode),
      ),
    );
  }
  out.push(
    vec("sanitizeVectorLens", false, { lenses }, () =>
      [
        ...lenses,
        { type: "magnify", amount: 99 },
        { type: "colorAdd", color: "nope" },
        { type: "bogus" },
      ].map(sanitizeVectorLens),
    ),
  );
  return out;
}

function gradientVectors(): Entry[] {
  const out: Entry[] = [];
  const colors = [
    "rgb(10 20 30 / 50%)",
    "#abc",
    "#abcd",
    "#AABBCCFF",
    "rgba(1,2,3,0.25)",
    " black ",
    "transparent",
    "nope",
    "rgb(1,2)",
    "#12345",
  ];
  out.push(
    vec("parseVectorColor", false, { colors }, () =>
      colors.map(parseVectorColor),
    ),
  );
  const cases: [unknown, Record<string, unknown>][] = [
    [
      "#ff0000",
      {
        aspect: 0.5,
        reverse: true,
        stops: [
          { offset: 0.2, color: "#00f", midpoint: 0.3 },
          { offset: 0.9, color: "rgb(10, 20, 30)" },
        ],
      },
    ],
    [
      { type: "linear", angle: 30, stops: [{ offset: 0, color: "#fff" }] },
      { type: "radial", cx: 0.2 },
    ],
    [
      {
        type: "radial",
        focal: { x: 0.4, y: 0.4 },
        stops: [
          { offset: 0, color: "#fff" },
          { offset: 1, color: "#000" },
        ],
      },
      { type: "conic", start: { x: 0.1, y: 0.2 } },
    ],
    [
      null,
      { type: "diamond", angle: 10, spread: "reflect", interpolation: "oklab" },
    ],
    [
      {
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        stops: [{ offset: 0, color: "#fff" }],
      },
      { width: null, stops: [] },
    ],
  ];
  for (const [from, patch] of cases) {
    out.push(
      vec("applyVectorGradientPatch", false, { from, patch }, () =>
        applyVectorGradientPatch(
          defaultVectorGradient(
            (patch.type as never) ?? "linear",
            from as never,
          ),
          patch as never,
        ),
      ),
    );
  }
  return out;
}

function renderVectors(): Entry[] {
  const nodes = [
    {
      ...rect("a", 10, 10, 80, 50),
      filters: [
        createVectorFilter("dropShadow", "filter1", { blur: 6, offsetX: 2 }),
        createVectorFilter("layerBlur", "filter2", { radius: 3 }),
      ],
    },
    {
      ...rect("b", 120, 10, 60, 60, {
        strokeLinejoin: "round",
        strokeWidth: 6,
      }),
      fills: [{ paint: "#ff0000" }, { paint: "#00ff00", opacity: 0.5 }],
      filters: [
        { ...createVectorFilter("innerGlow", "filter1")!, enabled: false },
      ],
    },
    {
      id: "g",
      type: "group",
      blendMode: "multiply",
      transform: [1, 0, 0, 1, 5, 100],
      filters: [createVectorFilter("outerGlow", "filter1", { spread: 3 })],
      children: [
        {
          ...rect("c", 0, 0, 50, 40),
          effects: [createVectorEffect("zigzag", "fx1", { size: 3 })],
        },
        {
          ...rect("d", 60, 0, 40, 40, {
            strokeLinejoin: "bevel",
            strokeWidth: 3,
          }),
          opacity: 0.5,
        },
      ],
    },
  ] as VectorNode[];
  const doc = { width: 300, height: 200, nodes };
  return [
    vec("getVectorSceneRenderData", false, { nodes }, () =>
      getVectorSceneRenderData({
        document: doc,
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    ),
    vec("vectorDocumentToSvg", false, { nodes }, () =>
      vectorDocumentToSvg(doc),
    ),
  ];
}

const STEPS: [string, Record<string, unknown>?][] = [
  [
    "vector.addShape",
    {
      kind: "rect",
      x: 0,
      y: 0,
      width: 50,
      height: 40,
      fills: [
        {
          paint: {
            type: "linear",
            stops: [
              { offset: 0, color: "#f00" },
              { offset: 1, color: "#00f" },
            ],
          },
        },
        { paint: "#0f0", opacity: 0.5, blendMode: "multiply" },
      ],
    },
  ],
  ["vector.addShape", { kind: "line", x: 0, y: 60, width: 50, height: 0 }],
  [
    "vector.addShape",
    {
      kind: "ellipse",
      x: 100,
      y: 0,
      width: 60,
      height: 60,
      stroke: {
        type: "radial",
        cx: 0.3,
        stops: [
          { offset: 0, color: "#fff" },
          { offset: 1, color: "#000" },
        ],
      },
    },
  ],
  ["vector.getAppearance", { id: "n1" }],
  ["vector.updateFill", { nodeId: "n1", index: 5, opacity: 0.2 }],
  ["vector.updateFill", { nodeId: "n1", index: 0 }],
  ["vector.updateFill", { nodeId: "n2", index: 0, opacity: 0.2 }],
  [
    "vector.updateStroke",
    { nodeId: "n1", index: 0, strokeLinecap: "round", strokeDasharray: [4, 2] },
  ],
  [
    "vector.updateStroke",
    { nodeId: "n1", index: 0, strokeDasharray: [], visible: false, opacity: 1 },
  ],
  ["vector.addStroke", { ids: ["n1"], paint: { type: "radial", stops: [] } }],
  [
    "vector.addStroke",
    { ids: ["n1", "n2"], paint: "#123456", index: 0, strokeAlign: "inside" },
  ],
  [
    "vector.setStyle",
    {
      ids: ["n1"],
      strokes: [
        { paint: "#123456", strokeWidth: 4 },
        { paint: "#abcdef", strokeWidth: 1, opacity: 0.5 },
      ],
    },
  ],
  [
    "vector.setStyle",
    { ids: ["n1"], fills: [{ paint: "#123", blendMode: "bogus" }] },
  ],
  [
    "vector.setStyle",
    {
      ids: ["n2"],
      fill: { type: "conic", angle: 20, stops: [{ offset: 0, color: "#f00" }] },
    },
  ],
  ["vector.setStyle", { ids: ["n2"], stroke: { type: "linear" } }],
  ["vector.addFilter", { type: "layerBlur", params: { blur: 3 }, ids: ["n1"] }],
  ["vector.addFilter", { type: "outerGlow", ids: ["n1", "n2"], index: 0 }],
  [
    "vector.addFilter",
    { type: "innerShadow", params: { spread: 2 }, ids: ["n1"], index: 0 },
  ],
  ["vector.moveFilter", { nodeId: "n1", filterId: "filter1", index: 9 }],
  [
    "vector.updateFilter",
    { nodeId: "n1", filterId: "filter9", enabled: false },
  ],
  ["vector.updateFilter", { nodeId: "n1", filterId: "filter1" }],
  [
    "vector.updateFilter",
    {
      nodeId: "n1",
      filterId: "filter1",
      params: { opacity: 0.3, color: " red " },
    },
  ],
  ["vector.removeFilter", { nodeId: "n2", filterId: "filter1" }],
  ["vector.setBlendMode", { blendMode: "normal", ids: ["n1"] }],
  ["vector.setBlendMode", { blendMode: "linear-dodge", ids: ["n1", "n2"] }],
  ["vector.addEffect", { type: "repeater", ids: ["n1"] }],
  [
    "vector.addEffect",
    { type: "twist", params: { angle: 20 }, ids: ["n1"], index: 0 },
  ],
  [
    "vector.updateEffect",
    { nodeId: "n1", effectId: "fx1", params: { copies: 2 }, index: 3 },
  ],
  ["vector.updateEffect", { nodeId: "n1", effectId: "fx7", enabled: false }],
  ["vector.removeEffect", { nodeId: "n1", effectId: "fx2" }],
  ["vector.expandAppearance", { ids: ["n1"] }],
  ["vector.list"],
  ["vector.expandAppearance", { ids: ["n2"] }],
  ["vector.makeClippingMask", { ids: ["n1"] }],
  ["vector.makeOpacityMask", { ids: ["n1", "n2"], maskId: "n9" }],
  [
    "vector.makeOpacityMask",
    { ids: ["n1", "n2"], maskId: "n1", invert: true, type: "alpha" },
  ],
  ["vector.setMaskOptions", {}],
  ["vector.setMaskOptions", { enabled: false }],
  ["vector.list"],
  ["vector.setMaskOptions", { enabled: true, type: "clip", invert: false }],
  ["vector.list"],
  ["vector.releaseMask", { ids: ["n2"] }],
  ["vector.releaseMask"],
  ["vector.setLens", { ids: ["n2"], type: "magnify" }],
  ["vector.setLens", { ids: ["n3"], amount: 3 }],
  ["vector.setLens", { ids: ["n3"], type: "magnify", amount: 30 }],
  ["vector.setLens", { ids: ["n3"], type: "fisheye", color: "nope" }],
  ["vector.setLens", { ids: ["n3"], type: "colorAdd", amount: 20 }],
  ["vector.setLens", { ids: ["n3"], amount: 70, color: "#00ff00" }],
  ["vector.setLens", { ids: ["n3"] }],
  ["vector.removeLens", { ids: ["n3", "n2"] }],
  [
    "vector.setGradient",
    { ids: ["n3"], target: "stroke", reverse: true, aspect: 0.5 },
  ],
  ["vector.setGradient", { ids: ["n3"], type: "radial", stops: [] }],
  [
    "vector.setGradient",
    { ids: ["n2"], type: "reflected", stops: [{ offset: 0.5, color: "#f00" }] },
  ],
];

async function commandVectors() {
  const setup = { width: 300, height: 200 };
  const host = createVectorConformanceHost(setup, {
    effects: createFakeEffectProvider(),
  });
  const steps: Entry[] = [];
  for (const [id, params] of STEPS) {
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
      ...effectVectors(),
      ...maskVectors(),
      ...filterVectors(),
      ...lensVectors(),
      ...gradientVectors(),
      ...renderVectors(),
    ],
    commands: await commandVectors(),
  };
}

describe("Swift vector appearance test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    const now = json(await vectors());
    if (process.env.UPDATE_SWIFT_VECTORS)
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    // Numbers within relative 1e-9 (trig differs across CPUs in the last bit).
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
