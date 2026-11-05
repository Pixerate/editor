import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bezierToSubpaths,
  expandVectorAppearance,
  generateVectorBlendChildren,
  getVectorSymbolEditBackground,
  getVectorSymbolsPanel,
  parseVectorSvg,
  prefixVectorIds,
  resolveVectorSymbols,
  scaleVectorStrokeWidths,
  stripVectorSymbolArt,
  tintVectorNode,
  transformVectorNode,
  vectorDocumentToSvg,
  vectorInstanceDrawn,
  vectorNodeBounds,
  vectorSymbolUses,
  VectorEditorController,
  type VectorDocument,
  type VectorInstanceNode,
  type VectorNode,
  type VectorPathNode,
  type VectorSymbol,
} from "../src/vector/index.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";
import { createVectorConformanceHost } from "../src/vector/contract.js";
import { createFakeEffectProvider } from "../src/effects";

/**
 * Test vectors the Swift vector symbols and instances (`packages/swift`, `PixerateVector`, #624)
 * check themselves against: resolving and stripping symbol art, symbol cycles, what an instance
 * draws (placement, scaled strokes, overrides, hidden art), instances in geometry, blends, SVG
 * export and import (`symbols.ts`, `appearance.ts`, `geometry.ts`, `svg.ts`). Computed here from
 * the TS core (the spec); a drift from the committed file fails this test (run with
 * UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change, then rerun the Swift tests).
 *
 * Numbers compare within relative 1e-9 where they went through trig (`trig: true`) and exactly
 * otherwise; strings (colours, ids, SVG) always exactly. Key order is not compared. Nodes and
 * documents go in as their JSON.
 *
 * `commands` replays agent commands (`run_command` on `createVectorConformanceHost`) for their
 * failures and edge cases: `{ setup, steps: [{ id, params?, result }], svg, render, document,
 * imported, after }`, where a result is the command's JSON result or `{ error }` with the tool's
 * error text, and `svg` / `render` are `{ length, sha256 }` of the exported SVG and of the render
 * data's JSON (object keys sorted).
 *
 * Shape: `{ version, entries: [{ fn, trig, ...inputs, out }], commands }`.
 */
const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateVectorTests/Fixtures/vector-symbol-vectors.json",
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

const RECT = "M-20 -10L20 -10L20 10L-20 10Z";
const TRI = "M0 -15L15 10L-15 10Z";

/** Symbols: a plain one, one with stacks and a group, one using another, and a cycle. */
const SYMBOLS: VectorSymbol[] = [
  {
    id: "dot",
    name: "Dot",
    nodes: [
      path("body", RECT, { fill: "#2563eb", stroke: "#111827", strokeWidth: 2 }),
      path("mark", TRI, { fill: "#facc15" }),
    ],
  },
  {
    id: "badge",
    name: "Badge",
    nodes: [
      {
        id: "g",
        type: "group",
        children: [
          path("ring", RECT, {
            fill: null,
            stroke: "#000",
            strokeWidth: 3,
            strokes: [
              { paint: "#000", strokeWidth: 3 },
              { paint: "#f00", strokeWidth: 1, opacity: 0.5 },
            ],
          }),
          path("plain", TRI, { fill: "#0f0" }),
        ],
      } as VectorNode,
      {
        id: "inner",
        type: "instance",
        symbolId: "dot",
        transform: [0.5, 0, 0, 0.5, 30, 0],
      } as VectorInstanceNode,
    ],
  },
  {
    id: "loopA",
    name: "Loop A",
    nodes: [
      { id: "a1", type: "instance", symbolId: "loopB" } as VectorInstanceNode,
      path("a2", TRI, { fill: "#999" }),
    ],
  },
  {
    id: "loopB",
    name: "Loop B",
    nodes: [{ id: "b1", type: "instance", symbolId: "loopA" } as VectorInstanceNode],
  },
];

const inst = (
  id: string,
  symbolId: string,
  extra: Partial<VectorInstanceNode> = {},
): VectorInstanceNode => ({ id, type: "instance", symbolId, ...extra });

const DEG = Math.PI / 180;
const rot = (deg: number, tx: number, ty: number, sx = 1, sy = 1) => {
  // Rounded to floats so the fixture does not depend on the machine's sin / cos.
  const c = Math.fround(Math.cos(deg * DEG));
  const s = Math.fround(Math.sin(deg * DEG));
  return [c * sx, s * sx, -s * sy, c * sy, tx, ty];
};

/** Instances of every kind, resolved (they carry their art). */
function instances(): VectorInstanceNode[] {
  const list: VectorInstanceNode[] = [
    inst("i1", "dot"),
    inst("i2", "dot", { transform: [1, 0, 0, 1, 100, 50], name: "Moved" }),
    inst("i3", "dot", { transform: [2, 0, 0, 2, 50, 50] }),
    inst("i4", "dot", { transform: [2, 0, 0, 0.5, 50, 50], scaleStrokes: false }),
    inst("i5", "dot", { transform: [1, 0, 0.5, 1, 0, 0], opacity: 0.5, blendMode: "multiply" }),
    inst("i6", "dot", { transform: rot(30, 40, 60, 1.5, 1.5), locked: true }),
    inst("i7", "dot", { transform: [-1, 0, 0, 1, 10, 0], overrides: { fill: "#16a34a" } }),
    inst("i8", "badge", { overrides: { stroke: "#ff00ff", hidden: ["plain"] }, visible: false }),
    inst("i9", "badge", { transform: [3, 0, 0, 3, 0, 0], overrides: { fill: { type: "linear", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] } as never } }),
    inst("i10", "missing"),
    inst("i11", "loopA"),
    inst("i12", "dot", { effects: [{ id: "fx1", type: "roundCorners", params: { radius: 4 } }] as never, booleanOperation: "subtract", blendStep: true }),
  ];
  const doc = resolveVectorSymbols({ width: 200, height: 200, nodes: list, symbols: SYMBOLS });
  return doc.nodes as VectorInstanceNode[];
}

// i6 is rotated; i12's Round Corners effect places its arcs with trig.
const trigIds = new Set(["i6", "i12"]);

function symbolVectors(): Entry[] {
  const out: Entry[] = [];
  const doc: VectorDocument = {
    width: 200,
    height: 200,
    nodes: [
      inst("i1", "dot"),
      { id: "grp", type: "group", children: [inst("i2", "badge"), inst("i3", "nope")] } as VectorNode,
      inst("i4", "loopB"),
    ],
    symbols: SYMBOLS,
  };
  out.push(vec("resolveVectorSymbols", false, { doc }, () => resolveVectorSymbols(doc)));
  out.push(vec("resolveVectorSymbols", false, { doc: { width: 1, height: 1, nodes: [path("p", TRI)] } }, () => resolveVectorSymbols({ width: 1, height: 1, nodes: [path("p", TRI)] })));
  out.push(vec("stripVectorSymbolArt", false, { doc: resolveVectorSymbols(doc) }, () => stripVectorSymbolArt(resolveVectorSymbols(doc))));
  const pairs: [string, string][] = [
    ["badge", "dot"],
    ["dot", "badge"],
    ["loopA", "loopA"],
    ["loopA", "loopB"],
    ["badge", "badge"],
    ["missing", "dot"],
  ];
  out.push(vec("vectorSymbolUses", false, { symbols: SYMBOLS, pairs }, () => pairs.map(([a, b]) => vectorSymbolUses(SYMBOLS, a, b))));

  const styled: VectorNode[] = [
    path("s1", TRI, { stroke: "#000" }),
    path("s2", TRI, { strokeWidth: 4 }),
    path("s3", TRI, { fill: "#f00" }),
    path("s4", TRI, { stroke: "#000", strokeWidth: 2, strokes: [{ paint: "#000" }, { paint: "#0f0", strokeWidth: 3 }] }),
    path("s5", TRI, { fill: "none", stroke: null, fills: [{ paint: "#123" }, { paint: "#456", opacity: 0.5 }] }),
    { id: "g", type: "group", children: [path("s6", TRI, { stroke: "#000", fill: "#fff" }), inst("s7", "dot", { overrides: { stroke: "#00f" } })] } as VectorNode,
    inst("s8", "dot"),
  ];
  const ks = [1, 0, -1, 2.5, 0.5];
  out.push(vec("scaleVectorStrokeWidths", false, { nodes: styled, ks }, () => styled.map((n) => ks.map((k) => scaleVectorStrokeWidths(n, k)))));
  const overrides = [{}, { fill: "#16a34a" }, { stroke: "#ff00ff" }, { fill: null, stroke: "#000" }, { fill: { type: "radial", stops: [{ offset: 0, color: "#000" }] } }];
  out.push(vec("tintVectorNode", false, { nodes: styled, overrides }, () => styled.map((n) => overrides.map((o) => tintVectorNode(n, o as never)))));
  out.push(vec("prefixVectorIds", false, { nodes: styled }, () => prefixVectorIds(styled, "inst")));

  for (const i of instances()) {
    const trig = trigIds.has(i.id);
    out.push(vec("vectorInstanceDrawn", trig, { node: i }, () => vectorInstanceDrawn(i)));
    out.push(vec("expandVectorAppearance", trig, { node: i }, () => expandVectorAppearance(i)));
    const parents = [
      [1, 0, 0, 1, 0, 0],
      [1, 0, 0, 1, 7, -3],
      [2, 0, 0, 0.5, 0, 0],
    ];
    out.push(vec("vectorNodeBounds", trig, { node: i, parents }, () => parents.map((p) => vectorNodeBounds(i, p as never))));
    const ms = [
      [1, 0, 0, 1, 10, 20],
      [2, 0, 0, 3, 0, 0],
      [1, 0, 0.25, 1, 0, 0],
    ];
    out.push(vec("transformVectorNode", trig, { node: i, matrices: ms }, () => ms.map((m) => transformVectorNode(i, m as never))));
  }

  // Blends with instance keys: they blend as their art.
  const all = instances();
  const blend = {
    id: "bl",
    type: "group",
    blend: { steps: 2 },
    children: [all[1], { ...all[2], id: "k2", transform: [1, 0, 0, 1, 160, 120] }],
  } as unknown as VectorNode;
  out.push(vec("generateVectorBlendChildren", false, { group: blend }, () => generateVectorBlendChildren(blend as never)));

  // SVG export and import of symbols and instances (no trig: plain placements only).
  const svgDoc: VectorDocument = {
    width: 300,
    height: 200,
    nodes: [
      inst("u1", "dot", { transform: [1, 0, 0, 1, 50, 50] }),
      inst("u2", "dot", { transform: [2, 0, 0, 2, 150, 60], opacity: 0.5, name: "Big" }),
      inst("u3", "badge", { transform: [1, 0, 0, 1, 100, 150], overrides: { fill: "#16a34a", hidden: ["plain"] } }),
      inst("u4", "dot", { transform: [1, 0, 0, 1, 250, 150], scaleStrokes: false, visible: false }),
      inst("u5", "dot", { transform: [1, 0, 0, 1, 20, 20], effects: [{ id: "fx1", type: "roundCorners", params: { radius: 4 } }] as never }),
      inst("u6", "missing"),
    ],
    symbols: [...SYMBOLS.slice(0, 2), { id: "unused", name: "Unused", nodes: [path("q", TRI, { fill: "#abc" })] }],
  };
  const svg = vectorDocumentToSvg(svgDoc);
  out.push(vec("vectorDocumentToSvg", false, { doc: svgDoc }, () => svg));
  out.push(vec("vectorDocumentToSvg", false, { doc: svgDoc, includeHidden: true }, () => vectorDocumentToSvg(svgDoc, { includeHidden: true })));
  out.push(vec("parseVectorSvg", false, { svg }, () => parseVectorSvg(svg)));
  // Foreign `<use>`: of a plain element, of a `<symbol>` without our data, with x / y, and a self reference.
  const foreign = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><rect id="r" x="0" y="0" width="10" height="10" fill="#f00" transform="translate(5 5)"/><symbol id="s"><circle cx="5" cy="5" r="5" fill="#00f"/><use href="#s"/></symbol></defs><use href="#r" x="20" y="30"/><use xlink:href="#s" transform="scale(2)"/><use href="#nothing"/><use href="#r"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><g id="g1"><path d="M0 0L10 0L10 10Z" fill="#000"/></g><use href="#g1" x="20" opacity="0.5" display="none"/></svg>',
  ];
  out.push(vec("parseVectorSvg", false, { svgs: foreign }, () => foreign.map((s) => parseVectorSvg(s))));
  return out;
}

/**
 * The symbols panel and the dimmed host behind a symbol in isolation, on a controller: before
 * and while editing. The background's `transform` starts with the view, which the Swift
 * controller does not have (it compares the `matrix(…)` part only).
 */
function panelVectors(): Entry[] {
  let n = 0;
  const document: VectorDocument = {
    width: 200,
    height: 100,
    nodes: [
      path("p1", RECT, { fill: "#2563eb", stroke: "#000", strokeWidth: 2 }),
      path("p2", TRI, { fill: "#facc15" }),
    ],
  };
  const c = new VectorEditorController({ document, createId: () => `c${++n}` });
  const made = c.makeSymbol({ ids: ["p1"], name: "Box" });
  const placed = c.placeSymbol(made.symbolId!, { transform: [2, 0, 0, 2, 150, 50] as never });
  c.select([placed.id!]);
  c.setInstanceOptions({ stroke: "#f00", hidden: [] });
  const before = getVectorSymbolsPanel(c.getState());
  c.select(["p2"]);
  const selected = getVectorSymbolsPanel(c.getState());
  c.editSymbol(placed.id!);
  const editing = getVectorSymbolsPanel(c.getState(), { idPrefix: "x-" });
  const background = getVectorSymbolEditBackground(c.getState());
  return [vec("symbolsPanel", false, { document }, () => ({ before, selected, editing, background }))];
}

const STEPS: [string, Record<string, unknown>?][] = [
  ["vector.addShape", { kind: "rect", x: 20, y: 20, width: 40, height: 30, fill: "#2563eb" }],
  ["vector.addShape", { kind: "ellipse", x: 80, y: 20, width: 30, height: 30, fill: "#e11d48", strokeWidth: 4 }],
  ["vector.addShape", { kind: "star", x: 140, y: 20, width: 40, height: 40, fill: "#facc15" }],
  ["vector.group", { ids: ["n3"] }],
  ["vector.listSymbols"],
  // Make Symbol failures.
  ["vector.makeSymbol", { ids: [] }],
  ["vector.makeSymbol", { ids: ["n99"] }],
  ["vector.makeSymbol", { ids: ["n1", "n3"] }],
  ["vector.makeSymbol", { ids: ["n1", "n2"], name: "  Pair  " }],
  ["vector.makeSymbol", { ids: ["n3"] }],
  ["vector.listSymbols"],
  ["vector.list"],
  // Placing, with x / y, a transform, both, and a scaling transform.
  ["vector.placeSymbol", { symbolId: "symbol-n5" }],
  ["vector.placeSymbol", { symbolId: "symbol-n5", x: 50, y: 150, name: "Second" }],
  ["vector.placeSymbol", { symbolId: "symbol-n5", transform: [2, 0, 0, 0.5, 200, 150] }],
  ["vector.placeSymbol", { symbolId: "symbol-n5", x: 1, transform: [1, 0, 0, 1, 0, 0] }],
  ["vector.placeSymbol", { symbolId: "symbol-n5", transform: [1, 0, 0, 1, 0, 0] }],
  ["vector.placeSymbol", { symbolId: "symbol-n7", transform: [1, 0, 0.5, 1, 240, 60] }],
  ["vector.placeSymbol", { symbolId: "symbol-n7", transform: [0.8, 0.6, -0.6, 0.8, 100, 100] }],
  ["vector.list"],
  // Instance options.
  ["vector.setInstanceOptions", { ids: ["n10"] }],
  ["vector.setInstanceOptions", { ids: ["n1"], scaleStrokes: false }],
  ["vector.setInstanceOptions", { ids: ["n99"], scaleStrokes: false }],
  ["vector.setInstanceOptions", { ids: ["n11"], hidden: ["nope"] }],
  ["vector.setInstanceOptions", { ids: ["n11"], hidden: ["n2"], stroke: "#ff00ff", scaleStrokes: false }],
  ["vector.setInstanceOptions", { ids: ["n11", "n12"], fill: { type: "linear", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] } }],
  ["vector.setInstanceOptions", { ids: ["n12"], fill: null, hidden: [] }],
  ["vector.setInstanceOptions", { ids: ["n12"], scaleStrokes: true }],
  ["vector.select", { ids: ["n11"] }],
  ["vector.setInstanceOptions", { hidden: null }],
  ["vector.list"],
  // Replace, rename.
  ["vector.replaceSymbol", { ids: ["n11"], symbolId: "nope" }],
  ["vector.replaceSymbol", { ids: ["n1"], symbolId: "symbol-n5" }],
  ["vector.replaceSymbol", { ids: ["n11"], symbolId: "symbol-n7" }],
  ["vector.renameSymbol", { symbolId: "symbol-n7", name: "   " }],
  ["vector.renameSymbol", { symbolId: "nope", name: "X" }],
  ["vector.renameSymbol", { symbolId: "symbol-n7", name: " Star " }],
  // Isolation mode: errors, nesting, edits that every instance follows.
  ["vector.editSymbol", { id: "nope" }],
  ["vector.editSymbol", { id: "n4" }],
  ["vector.exitSymbolEdit"],
  ["vector.editSymbol", { id: "n12" }],
  ["vector.listSymbols"],
  ["vector.placeSymbol", { symbolId: "symbol-n5" }],
  ["vector.placeSymbol", { symbolId: "symbol-n7", x: 0, y: 40 }],
  ["vector.replaceSymbol", { ids: ["n15"], symbolId: "symbol-n7" }],
  ["vector.replaceSymbol", { ids: ["n15"], symbolId: "symbol-n5" }],
  ["vector.deleteSymbol", { symbolId: "symbol-n7" }],
  ["vector.renameSymbol", { symbolId: "symbol-n5", name: "Pair (edited)" }],
  ["vector.addShape", { kind: "rect", x: -5, y: -5, width: 10, height: 10, fill: "#000" }],
  ["vector.list"],
  ["vector.editSymbol", { id: "symbol-n7" }],
  ["vector.list"],
  ["vector.exitSymbolEdit"],
  ["vector.exitSymbolEdit"],
  ["vector.listSymbols"],
  ["vector.list"],
  // Delete, detach.
  ["vector.deleteSymbol", { symbolId: "nope" }],
  ["vector.deleteSymbol", { symbolId: "symbol-n7" }],
  ["vector.detachInstance", { ids: ["n1"] }],
  ["vector.detachInstance", { ids: ["n10", "n10"] }],
  ["vector.list"],
  ["vector.deleteSymbol", { symbolId: "symbol-n7", detach: true }],
  ["vector.listSymbols"],
  ["vector.list"],
  ["vector.makeSymbol", { ids: ["n10"], name: "Again" }],
  ["vector.blend", { ids: ["n9", "n12"], steps: 2 }],
  ["vector.list"],
];

async function commandVectors() {
  const setup = { width: 300, height: 200 };
  const host = createVectorConformanceHost(setup, { effects: createFakeEffectProvider() });
  const steps: Entry[] = [];
  const run = async (id: string, params?: Record<string, unknown>) => {
    const r = await host.callTool("run_command", params ? { id, params } : { id });
    const text = (r.content[0] as { text: string }).text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  for (const [id, params] of STEPS) steps.push({ id, ...(params ? { params } : {}), result: await run(id, params) });
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
  const imported = await run("vector.importSvg", { svg: exported, replace: true });
  const after = await run("vector.list");
  const afterSymbols = await run("vector.listSymbols");
  return { setup, steps, svg: digest(exported), render, document, imported, after, afterSymbols };
}

async function vectors() {
  return { version: 1, entries: [...symbolVectors(), ...panelVectors()], commands: await commandVectors() };
}

describe("Swift vector symbol test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    const now = json(await vectors());
    if (process.env.UPDATE_SWIFT_VECTORS) writeFileSync(FILE, JSON.stringify(now) + "\n");
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    // Numbers within relative 1e-9 (trig differs across CPUs in the last bit).
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
