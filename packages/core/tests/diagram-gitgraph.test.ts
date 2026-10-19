// @vitest-environment jsdom
// Ported from Ursula (src/gitgraph/gitgraph.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { registerDiagramAdapter } from "../src/diagram/registry.js";
import { ensureDiagramLayout } from "../src/canvas/mermaid/layout.js";
import { expectValidMermaid, mermaidDb } from "./helpers/mermaid";
import type { DiagramAdapter, MermaidDocument } from "../src/diagram/types.js";
import { gitGraphGeometry } from "../src/diagram/gitgraph/geometry.js";
import { gitGraphAdapter } from "../src/diagram/gitgraph/index.js";

registerDiagramAdapter(gitGraphAdapter as DiagramAdapter<unknown>);

const SRC = `gitGraph
  commit id: "init"
  branch develop
  checkout develop
  commit id: "feat: editor"
  commit id: "feat: thumbnails"
  branch feature/er-grammar
  checkout feature/er-grammar
  commit id: "er grammar"
  checkout develop
  merge feature/er-grammar
  checkout main
  merge develop tag: "v0.1.0"
  checkout develop
  commit id: "fix: routing"
`;

interface GitDb {
  getCommits: () => Map<
    string,
    { id: string; message: string; tags: string[]; type: number; branch: string; parents: string[] }
  >;
  getBranchesAsObjArray: () => { name: string }[];
}

/** Mermaid's commits in sequence order, with random ids replaced by `?`. */
async function mermaidView(src: string) {
  const db = await mermaidDb<GitDb>(src);
  const commits = [...db.getCommits().values()];
  return {
    branches: db.getBranchesAsObjArray().map((b) => b.name),
    commits: commits.map((c) => [c.branch, c.parents.length, c.tags[0]]),
  };
}

function ursulaView(doc: MermaidDocument) {
  return {
    branches: doc.graph.groups.map((g) => g.id),
    commits: doc.graph.nodes.map((n) => [
      n.data?.branch,
      doc.graph.edges.filter((e) => e.target === n.id).length,
      n.data?.tag,
    ]),
  };
}

const nodeIds = (doc: MermaidDocument) => doc.graph.nodes.map((n) => n.id);

describe("gitGraph adapter", () => {
  it("round-trips untouched", () => {
    const doc = parseMermaid(SRC);
    expect(doc.family).toBe("gitGraph");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(SRC);
  });

  it("simulates commits, merges and branches", async () => {
    const doc = parseMermaid(SRC);
    expect(doc.graph.direction).toBe("LR");
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.shape, n.parentId])).toEqual([
      ["init", "init", "commit", "main"],
      ["feat: editor", "feat: editor", "commit", "develop"],
      ["feat: thumbnails", "feat: thumbnails", "commit", "develop"],
      ["er grammar", "er grammar", "commit", "feature/er-grammar"],
      ["c5", "c5", "merge-commit", "develop"],
      ["c6", "c6", "merge-commit", "main"],
      ["fix: routing", "fix: routing", "commit", "develop"],
    ]);
    expect(doc.graph.nodes[5]!.data).toMatchObject({
      branch: "main",
      tag: "v0.1.0",
      kind: "merge",
      details: ["main", "tag: v0.1.0"],
    });
    expect(doc.graph.edges.map((e) => [e.id, e.data?.merge])).toEqual([
      ["L_init_feat: editor_0", false],
      ["L_feat: editor_feat: thumbnails_0", false],
      ["L_feat: thumbnails_er grammar_0", false],
      ["L_feat: thumbnails_c5_0", false],
      ["L_er grammar_c5_0", true],
      ["L_init_c6_0", false],
      ["L_c5_c6_0", true],
      ["L_c5_fix: routing_0", false],
    ]);
    expect(doc.graph.groups.map((g) => g.id)).toEqual(["main", "develop", "feature/er-grammar"]);
    expect(ursulaView(doc)).toEqual(await mermaidView(SRC));
  });

  it("reads attributes in any order, cherry-picks and the header direction", async () => {
    const src =
      'gitGraph TB:\n  commit\n  commit type: HIGHLIGHT msg: "second" tag: "t"\n  branch hotfix order: 1\n  commit id: "fix"\n  checkout main\n  cherry-pick id: "fix" tag: "picked"\n';
    const doc = parseMermaid(src);
    expect(serializeMermaid(doc)).toBe(src);
    expect(doc.graph.direction).toBe("TB");
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.data?.kind])).toEqual([
      ["c1", "c1", "commit"],
      ["c2", "second", "commit"],
      ["fix", "fix", "commit"],
      ["c4", "c4", "cherry-pick"],
    ]);
    expect(doc.graph.nodes[1]!.data).toMatchObject({ type: "HIGHLIGHT", msg: "second", tag: "t" });
    expect(doc.graph.nodes[3]!.data).toMatchObject({ from: "fix", branch: "main", tag: "picked" });
    expect(doc.graph.groups[1]!.data).toEqual({ order: 1 });
    expect(
      doc.graph.edges.filter((e) => e.target === "c4").map((e) => [e.source, e.pattern]),
    ).toEqual([
      ["c2", "solid"],
      ["fix", "dotted"],
    ]);
    const unpicked = applyEdit(doc, { type: "removeEdges", ids: ["L_fix_c4_0"] });
    expect(unpicked.source).not.toContain("cherry-pick");
    expect(ursulaView(doc)).toEqual(await mermaidView(src));
  });

  it("adds commits on a branch, checking it out when needed", async () => {
    const doc = parseMermaid(SRC);
    const onMain = applyEdit(doc, {
      type: "addNode",
      node: { id: "commit8", label: "release", parentId: "main" },
      position: [5, 5],
    });
    expect(onMain.source.endsWith('  checkout main\n  commit id: "release"\n')).toBe(true);
    expect(onMain.graph.nodes.at(-1)).toMatchObject({ id: "release", parentId: "main" });
    // Positions follow the commit order: the drop position is not stored.
    expect(onMain.meta.layout?.release).toBeUndefined();
    await expectValidMermaid(onMain.source);

    const again = applyEdit(onMain, {
      type: "addNode",
      node: { id: "x", label: "release", parentId: "main" },
    });
    expect(again.source.endsWith('  commit id: "release"\n  commit id: "release_2"\n')).toBe(true);

    // A commit id as parent selects that commit's branch; default label "New commit".
    const bySelection = applyEdit(doc, {
      type: "addNode",
      node: { id: "x", parentId: "fix: routing" },
    });
    expect(
      bySelection.source.endsWith('  commit id: "fix: routing"\n  commit id: "New commit"\n'),
    ).toBe(true);
    expect(ursulaView(bySelection)).toEqual(await mermaidView(bySelection.source));
  });

  it("renames commits and updates cherry-pick references", async () => {
    const src =
      'gitGraph\n  commit\n  branch b\n  commit id: "x"\n  checkout main\n  cherry-pick id: "x"\n';
    const doc = parseMermaid(src);
    const renamed = applyEdit(doc, { type: "renameNode", id: "x", label: "feature" });
    expect(renamed.source).toBe(
      'gitGraph\n  commit\n  branch b\n  commit id: "feature"\n  checkout main\n  cherry-pick id: "feature"\n',
    );
    await expectValidMermaid(renamed.source);
    const named = applyEdit(renamed, { type: "renameNode", id: "c1", label: "root" });
    expect(named.source).toContain('  commit id: "root"\n');
    expect(nodeIds(named)).toEqual(["root", "feature", "c3"]);
    expect(applyEdit(named, { type: "renameNode", id: "c3", label: "nope" })).toBe(named);
  });

  it("edits tag, type and message", async () => {
    const doc = parseMermaid(SRC);
    const tagged = applyEdit(doc, { type: "setNodeData", id: "init", data: { tag: "v0" } });
    expect(tagged.source).toContain('  commit id: "init" tag: "v0"\n');
    const typed = applyEdit(tagged, {
      type: "setNodeData",
      id: "init",
      data: { type: "REVERSE", msg: "first" },
    });
    expect(typed.source).toContain('  commit id: "init" tag: "v0" type: REVERSE msg: "first"\n');
    expect(typed.graph.nodes[0]!.data).toMatchObject({ tag: "v0", type: "REVERSE", msg: "first" });
    await expectValidMermaid(typed.source);
    const cleared = applyEdit(typed, {
      type: "setNodeData",
      id: "init",
      data: { tag: "", type: "NORMAL", msg: "" },
    });
    expect(cleared.source).toBe(SRC);

    const mergeTag = applyEdit(doc, { type: "setNodeData", id: "c6", data: { tag: "v1.0.0" } });
    expect(mergeTag.source).toContain('  merge develop tag: "v1.0.0"\n');
    await expectValidMermaid(mergeTag.source);
  });

  it("removes commits and drops merges that became invalid", async () => {
    const doc = parseMermaid(SRC);
    const removed = applyEdit(doc, { type: "removeNodes", ids: ["fix: routing"] });
    expect(removed.source).toBe(SRC.replace('  commit id: "fix: routing"\n', ""));
    // Without its only commit the feature branch cannot be merged any more.
    const noFeature = applyEdit(doc, { type: "removeNodes", ids: ["er grammar"] });
    expect(noFeature.source).not.toContain("merge feature/er-grammar");
    expect(noFeature.source).toContain('  merge develop tag: "v0.1.0"\n');
    await expectValidMermaid(noFeature.source);
    expect(ursulaView(noFeature)).toEqual(await mermaidView(noFeature.source));

    const mergeGone = applyEdit(doc, { type: "removeNodes", ids: ["c6"] });
    expect(mergeGone.source).not.toContain("merge develop");
    await expectValidMermaid(mergeGone.source);
  });

  it("merges branch tips with addEdge and removes merge links", async () => {
    const src =
      'gitGraph\n  commit id: "a"\n  branch dev\n  commit id: "b"\n  checkout main\n  commit id: "c"\n';
    const doc = parseMermaid(src);
    const merged = applyEdit(doc, { type: "addEdge", edge: { source: "b", target: "c" } });
    expect(merged.source).toBe(`${src}  merge dev\n`);
    expect(merged.graph.nodes.at(-1)).toMatchObject({ shape: "merge-commit", parentId: "main" });
    await expectValidMermaid(merged.source);

    const back = applyEdit(merged, { type: "addEdge", edge: { source: "c4", target: "b" } });
    expect(back.source).toBe(`${src}  merge dev\n  checkout dev\n  merge main\n`);
    await expectValidMermaid(back.source);

    // Not branch tips, or same branch: refused.
    expect(applyEdit(doc, { type: "addEdge", edge: { source: "a", target: "c" } })).toBe(doc);
    expect(applyEdit(doc, { type: "addEdge", edge: { source: "a", target: "b" } })).toBe(doc);

    const mergeEdge = merged.graph.edges.find((e) => e.data?.merge)!;
    expect(mergeEdge.id).toBe("L_b_c4_0");
    const unmerged = applyEdit(merged, { type: "removeEdges", ids: [mergeEdge.id] });
    expect(unmerged.source).toBe(src);
    expect(applyEdit(merged, { type: "removeEdges", ids: ["L_a_b_0"] })).toBe(merged);
  });

  it("creates and renames branches; refuses to ungroup", async () => {
    const doc = parseMermaid(SRC);
    const branched = applyEdit(doc, {
      type: "groupNodes",
      groupId: "g",
      label: "Release 2",
      nodeIds: ["init"],
    });
    expect(branched.source.endsWith("  branch Release-2\n  checkout Release-2\n")).toBe(true);
    expect(branched.graph.groups.map((g) => g.id)).toContain("Release-2");
    expect(branched.graph.nodes[0]!.parentId).toBe("main");
    await expectValidMermaid(branched.source);

    const renamed = applyEdit(doc, { type: "renameGroup", id: "develop", label: "dev" });
    expect(renamed.source).toBe(
      SRC.replace(/branch develop/g, "branch dev")
        .replace(/checkout develop/g, "checkout dev")
        .replace(/merge develop/g, "merge dev"),
    );
    expect(renamed.graph.nodes[1]!.parentId).toBe("dev");
    await expectValidMermaid(renamed.source);

    expect(applyEdit(doc, { type: "renameGroup", id: "main", label: "trunk" })).toBe(doc);
    expect(applyEdit(doc, { type: "ungroup", groupId: "develop" })).toBe(doc);
  });

  it("sets the direction and title", async () => {
    const doc = parseMermaid(SRC);
    const tb = applyEdit(doc, { type: "setDirection", direction: "TD" });
    expect(tb.source.startsWith("gitGraph TB:\n")).toBe(true);
    expect(tb.graph.direction).toBe("TB");
    const bt = applyEdit(tb, { type: "setDirection", direction: "BT" });
    expect(bt.source.startsWith("gitGraph BT:\n")).toBe(true);
    await expectValidMermaid(bt.source);
    const titled = applyEdit(doc, { type: "setTitle", title: "Release flow" });
    expect(titled.source.startsWith("---\ntitle: Release flow\n---\ngitGraph\n")).toBe(true);
    expect(titled.graph.title).toBe("Release flow");
    await expectValidMermaid(titled.source);
  });

  it("keeps unknown lines verbatim", async () => {
    const src =
      '%%{init: {"gitGraph": {"mainBranchName": "main"}}}%%\ngitGraph\n  accTitle: History\n  %% a comment\n  commit id: "a"\n  switch main\n  commit id: "b"\n';
    const doc = parseMermaid(src);
    expect(serializeMermaid(doc)).toBe(src);
    const next = applyEdit(doc, { type: "setNodeData", id: "b", data: { tag: "v1" } });
    expect(next.source).toBe(src.replace('commit id: "b"', 'commit id: "b" tag: "v1"'));
    await expectValidMermaid(next.source);
  });

  it("lays commits out where Mermaid draws them, ignoring stored positions", async () => {
    const doc = parseMermaid(SRC);
    const layout = await ensureDiagramLayout(
      doc.graph,
      { v: 1, layout: { c6: [999, 999] } },
      { family: "gitGraph" },
    );
    const centre = (id: string) => [
      layout.positions[id]![0] + layout.sizes[id]!.width / 2,
      layout.positions[id]![1] + layout.sizes[id]!.height / 2,
    ];
    // 50px per commit along x, 90px per branch lane (Mermaid's rotated-label spacing).
    expect(centre("init")).toEqual([10, -2]);
    expect(centre("feat: editor")).toEqual([60, 88]);
    expect(centre("er grammar")).toEqual([160, 178]);
    expect(centre("c6")).toEqual([260, -2]);
    // Branch name pills end 35px left of the lanes, centred on them.
    expect(layout.positions.main![0] + layout.sizes.main!.width).toBe(-35);
    expect(layout.positions.develop![1] + layout.sizes.develop!.height / 2).toBe(88);

    const vertical = await ensureDiagramLayout(
      { ...doc.graph, direction: "BT" },
      { v: 1 },
      {
        family: "gitGraph",
      },
    );
    expect(vertical.positions.init![1]).toBeGreaterThan(vertical.positions["fix: routing"]![1]);
    expect(vertical.positions.init![0]).toBe(vertical.positions.c6![0]);
  });

  it("routes parent links with Mermaid's arcs and colours", () => {
    const geo = gitGraphGeometry(parseMermaid(SRC).graph);
    const arrow = (id: string) => geo.arrows.get(id)!;
    // Branching off curves down into the new lane, coloured like the child's branch.
    expect(arrow("L_init_feat: editor_0")).toEqual({
      edgeId: "L_init_feat: editor_0",
      path: "M 10 -2 L 10 68 A 20 20, 0, 0, 0, 30 88 L 60 88",
      color: 1,
    });
    // A merge runs along the merged branch and curves up into the target, in the merged colour.
    expect(arrow("L_er grammar_c5_0")).toMatchObject({
      path: "M 160 178 L 190 178 A 20 20, 0, 0, 0, 210 158 L 210 88",
      color: 2,
    });
    expect(arrow("L_init_c6_0").path).toBe("M 10 -2 L 260 -2");
    expect(geo.lanes.map((l) => [l.branch, l.line.y1, l.line.x2])).toEqual([
      ["main", -2, 350],
      ["develop", 88, 350],
      ["feature/er-grammar", 178, 350],
    ]);
    const c6 = geo.commits.get("c6")!;
    expect([c6.symbol, c6.label, c6.tags, c6.tip]).toEqual(["MERGE", undefined, ["v0.1.0"], true]);
    expect(geo.commits.get("init")).toMatchObject({ symbol: "NORMAL", label: "init", tip: false });

    // A commit on the curving branch in between: Mermaid reroutes through a free lane.
    const rerouted = gitGraphGeometry(
      parseMermaid(
        'gitGraph\n  commit id: "a"\n  branch dev\n  commit id: "b"\n  checkout main\n  commit id: "c" type: HIGHLIGHT\n  checkout dev\n  commit id: "d" type: REVERSE\n  merge main\n',
      ).graph,
    );
    expect(rerouted.arrows.get("L_c_c5_0")).toMatchObject({
      path: "M 110 -2 L 110 33 A 10 10, 0, 0, 0, 120 43 L 200 43 A 10 10, 0, 0, 1, 210 53 L 210 88",
      color: 0,
    });
    expect([...rerouted.commits.values()].map((c) => c.symbol)).toEqual([
      "NORMAL",
      "NORMAL",
      "HIGHLIGHT",
      "REVERSE",
      "MERGE",
    ]);
  });

  it("orders lanes like Mermaid and labels cherry-picks", () => {
    const geo = gitGraphGeometry(
      parseMermaid(
        'gitGraph TB:\n  commit id: "a"\n  branch late order: 3\n  commit id: "b"\n  checkout main\n  branch early\n  commit id: "c"\n  cherry-pick id: "b"\n',
      ).graph,
    );
    expect(geo.lanes.map((l) => l.branch)).toEqual(["main", "early", "late"]);
    expect(geo.direction).toBe("TB");
    const pick = [...geo.commits.values()].at(-1)!;
    expect([pick.symbol, pick.label, pick.tags]).toEqual([
      "CHERRY_PICK",
      undefined,
      ["cherry-pick:b"],
    ]);
    // Vertical: commits go down 50px at a time from y = 40, lanes are columns.
    expect(geo.commits.get("a")).toMatchObject({ x: 0, y: 40 });
    expect(geo.commits.get("c")!.y).toBe(140);
  });

  it("never stores dragged positions", () => {
    const doc = parseMermaid(SRC);
    const next = applyEdit(doc, { type: "moveNodes", moves: [{ id: "init", position: [1, 2] }] });
    expect(next.meta.layout?.init).toBeUndefined();
    expect(next.source).toBe(SRC);
  });
});
