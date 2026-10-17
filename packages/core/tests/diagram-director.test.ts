// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import {
  DiagramController,
  DiagramDirector,
  PresenceStore,
  changedItems,
  createDiagramToolProvider,
  createInstantPresenceClock,
  draftFrames,
  parseMermaid,
  planDiagramEdit,
  planDiagramEdits,
} from "../src/diagram";
import { mermaidToCanvas } from "../src/canvas";
import { ChartController, ChartDirector, ChartPresence, createInstantChartClock } from "../src/chart";
import { expectValidMermaid } from "./helpers/mermaid";

const FLOW = "flowchart TD\n  A[Start] --> B{Valid?}\n  B -->|yes| C[Done]\n  B -->|no| A\n";

const setup = (source = FLOW, options: { linger?: number } = {}) => {
  const controller = new DiagramController({ source });
  const presence = new PresenceStore();
  const clock = createInstantPresenceClock();
  const placement = () => mermaidToCanvas(controller.getDocument()).layout;
  const director = new DiagramDirector(controller, presence, { placement, clock, linger: options.linger ?? 0 });
  const frames: Array<{ x: number; y: number; message?: string; pressed: boolean }> = [];
  presence.subscribe((s) => {
    const a = s.actors[0];
    if (a) frames.push({ x: a.x, y: a.y, message: a.message, pressed: a.pressed });
  });
  return { controller, presence, clock, director, placement, frames };
};

// Ported from Ursula (src/remote/draft.test.ts), flowchart cases.
describe("draftFrames", () => {
  it("grows a blank flowchart statement by statement and ends on the target", () => {
    const frames = draftFrames("flowchart TD\n", FLOW)!;
    expect(frames.length).toBe(3);
    expect(frames.at(-1)).toBe(FLOW);
    expect(frames.map((f) => parseMermaid(f).graph.edges.length)).toEqual([1, 2, 3]);
    for (const f of frames) expect(parseMermaid(f).diagnostics).toEqual([]);
  });

  it("continues from an existing diagram the target extends", () => {
    const frames = draftFrames("flowchart TD\n  A[Start] --> B{Valid?}\n", FLOW)!;
    expect(frames.map((f) => parseMermaid(f).graph.edges.length)).toEqual([2, 3]);
  });

  it("ignores the layout comment when comparing", () => {
    const start = 'flowchart TD\n  %% @pixerate {"v":1,"layout":{"A":[0,0]}}\n  A[Start] --> B{Valid?}\n';
    expect(draftFrames(start, FLOW)!.at(-1)).toBe(FLOW);
  });

  it("returns null when the target changes existing lines or the family", () => {
    expect(draftFrames("flowchart TD\n  X --> Y\n", FLOW)).toBeNull();
    expect(draftFrames("flowchart TD\n", "stateDiagram-v2\n  [*] --> A\n")).toBeNull();
    expect(draftFrames(FLOW, FLOW)).toBeNull();
  });

  it("samples long drafts down to maxFrames, keeping the target last", () => {
    const long = "flowchart LR\n" + Array.from({ length: 30 }, (_, i) => `  n${i} --> n${i + 1}`).join("\n") + "\n";
    const frames = draftFrames("flowchart LR\n", long, { maxFrames: 5 })!;
    expect(frames).toHaveLength(5);
    expect(frames.at(-1)).toBe(long);
  });

  it("lists new and relabelled nodes and groups", () => {
    const before = parseMermaid("flowchart TD\n  A --> B").graph;
    const after = parseMermaid("flowchart TD\n  A[Renamed] --> B --> C\n  subgraph G\n    B\n  end").graph;
    expect(changedItems(before, after).sort()).toEqual(["A", "B", "C", "G"]);
  });
});

describe("planDiagramEdit", () => {
  it("plans connects as a drag from source to target, then the commit", () => {
    const { placement, controller } = setup();
    const steps = planDiagramEdit(controller.getDocument(), placement(), { type: "addEdge", edge: { source: "C", target: "A", label: "again" } });
    expect(steps.map((s) => s.type)).toEqual(["move", "press", "move", "release", "type", "commit"]);
    const layout = placement();
    expect((steps[0] as any).to.x).toBeCloseTo(layout.positions.C![0] + layout.sizes.C!.width / 2);
  });

  it("places a new node beside the node it is connected from, and is pure", () => {
    const { placement } = setup();
    const ops = [
      { type: "addNode" as const, node: { id: "D", label: "Retry" } },
      { type: "addEdge" as const, edge: { source: "C", target: "D" } },
    ];
    const a = planDiagramEdits(FLOW, placement(), ops);
    const b = planDiagramEdits(FLOW, placement(), ops);
    expect(a).toEqual(b);
    // TD: one rank below C, clear of every drawn node.
    const layout = placement();
    const to = (a[0]![0] as any).to;
    expect(to.y).toBeGreaterThan(layout.positions.C![1] + layout.sizes.C!.height);
    for (const [id, [x, y]] of Object.entries(layout.positions)) {
      const size = layout.sizes[id]!;
      const overlaps = to.x - 80 < x + size.width && to.x + 80 > x && to.y - 28 < y + size.height && to.y + 28 > y;
      expect(overlaps, id).toBe(false);
    }
    expect(a[0]!.map((s) => s.type)).toEqual(["move", "press", "release", "type", "commit"]);
  });

  it("drags each moved node and speeds up with speed", () => {
    const { placement, controller } = setup();
    const slow = planDiagramEdit(controller.getDocument(), placement(), { type: "moveNodes", moves: [{ id: "A", position: [400, 0] }] });
    const fast = planDiagramEdit(controller.getDocument(), placement(), { type: "moveNodes", moves: [{ id: "A", position: [400, 0] }] }, 2);
    expect(slow.map((s) => s.type)).toEqual(["move", "press", "drag", "release", "commit"]);
    expect((fast[2] as any).ms).toBe(Math.round((slow[2] as any).ms / 2));
  });
});

describe("DiagramDirector", () => {
  it("acts out an edit with the cursor and commits it as one undo step", async () => {
    const { controller, director, clock, frames } = setup();
    const result = await director.perform({ id: "agent", name: "Agent" }, [
      { type: "addNode", node: { id: "D", label: "Retry" } },
      { type: "addEdge", edge: { source: "C", target: "D", label: "again" } },
    ]);
    expect(result.ok).toBe(true);
    expect(controller.getSource()).toContain("C -->|again| D");
    expect(frames.some((f) => f.pressed)).toBe(true);
    expect(frames.some((f) => f.message === "Retry")).toBe(true);
    expect(clock.elapsed()).toBeGreaterThan(1000);
    // The new node landed where the cursor clicked, and the rest stayed put.
    const before = mermaidToCanvas(parseMermaid(FLOW)).layout.positions;
    const after = mermaidToCanvas(controller.getDocument()).layout.positions;
    expect(after.A).toEqual([Math.round(before.A![0]), Math.round(before.A![1])]);
    expect(after.D![1]).toBeGreaterThan(after.C![1]);
    controller.undo();
    expect(controller.getSource()).toBe(FLOW);
  });

  it("drags a node live and keeps the others in place", async () => {
    const { controller, director, placement } = setup();
    const before = placement().positions;
    const seen: number[] = [];
    controller.subscribe(() => seen.push(controller.getDocument().meta.layout?.A?.[0] ?? NaN));
    await director.perform({ id: "agent" }, [{ type: "moveNodes", moves: [{ id: "A", position: [before.A![0] + 300, before.A![1]] }] }]);
    const after = placement().positions;
    expect(after.A![0]).toBeCloseTo(before.A![0] + 300, 0);
    expect(Math.abs(after.B![0] - before.B![0])).toBeLessThanOrEqual(1);
    // Intermediate positions were shown while dragging.
    expect(new Set(seen.filter((x) => !Number.isNaN(x))).size).toBeGreaterThan(3);
    controller.undo();
    expect(controller.getSource()).toBe(FLOW);
  });

  it("refuses a batch that does not apply before the cursor moves", async () => {
    const { controller, director, frames } = setup();
    const result = await director.perform({ id: "agent" }, [
      { type: "renameNode", id: "A", label: "x" },
      { type: "renameNode", id: "Z", label: "y" },
    ]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).message).toMatch(/There is no node "Z"/);
    expect(frames).toEqual([]);
    expect(controller.getSource()).toBe(FLOW);
  });

  it("rolls back a call whose target was deleted while the cursor moved", async () => {
    const { controller, presence, director } = setup();
    let deleted = false;
    presence.subscribe((s) => {
      if (!deleted && s.actors[0]?.pressed) {
        deleted = true;
        controller.apply({ type: "removeNodes", ids: ["C"] }, "User delete");
      }
    });
    const result = await director.perform({ id: "agent" }, [
      { type: "renameNode", id: "A", label: "Begin" },
      { type: "addEdge", edge: { source: "C", target: "A" } },
    ]);
    expect(result.ok).toBe(false);
    expect((result as any).message).toMatch(/There is no node "C"/);
    expect(controller.getSource()).not.toContain("Begin");
  });

  it("draws a whole-diagram write statement by statement as one undo step", async () => {
    const { controller, director } = setup("flowchart TD\n");
    const sizes: number[] = [];
    controller.subscribe(() => sizes.push(controller.getDocument().graph.edges.length));
    const result = await director.playSource({ id: "agent" }, FLOW);
    expect(result.ok).toBe(true);
    expect(controller.getSource()).toBe(FLOW);
    expect([...new Set(sizes)]).toEqual([1, 2, 3]);
    controller.undo();
    expect(controller.getSource()).toBe("flowchart TD\n");
  });

  it("queues calls per actor and hides the cursor after it lingers", async () => {
    const { director, presence } = setup(FLOW, { linger: 500 });
    const a = director.perform({ id: "a", name: "Ada" }, [{ type: "renameNode", id: "A", label: "One" }]);
    const b = director.perform({ id: "a", name: "Ada" }, [{ type: "renameNode", id: "B", label: "Two" }]);
    await Promise.all([a, b]);
    expect(presence.getState().actors).toEqual([]);
  });
});

describe("diagram tools with a director", () => {
  it("act out writes and still return what they created", async () => {
    const { controller, director, frames } = setup();
    const registry = new ToolRegistry();
    registry.register(createDiagramToolProvider(controller, { director, actor: { id: "bot", name: "Bot" } }));
    const added: any = await registry.callTool("add_diagram_node", { label: "Retry", from: "C" });
    expect(added.isError).toBeFalsy();
    expect(added.structuredContent.node).toMatchObject({ id: "N1", label: "Retry" });
    expect(added.structuredContent.edge).toMatchObject({ source: "C", target: "N1" });
    expect(frames.length).toBeGreaterThan(10);
    const bad: any = await registry.callTool("rename_diagram_node", { id: "nope", label: "x" });
    expect(bad.isError).toBe(true);
    const loaded: any = await registry.callTool("load_diagram_mermaid", { source: controller.getSource() + "  N1 --> A\n" });
    expect(loaded.structuredContent.edges).toBe(5);
    await expectValidMermaid(controller.getSource());
    expect((await registry.callTool("undo_diagram", {}) as any).structuredContent.undone).toBe(true);
  });
});

describe("ChartDirector on the shared presence queue", () => {
  it("still acts out chart edits and now hides the cursor after it lingers", async () => {
    const controller = new ChartController({ spec: { type: "bar", categories: ["a", "b"], series: [{ id: "s", name: "S", values: [1, 2] }] } });
    const presence = new ChartPresence();
    const director = new ChartDirector(controller, presence, { scene: () => ({ marks: [], plot: { x: 0, y: 0, width: 100, height: 100 } }) as any, clock: createInstantChartClock(), linger: 100 });
    const [result] = await director.perform({ id: "agent" }, [{ kind: "setValue", seriesId: "s", index: 0, value: 5 }]);
    expect(result!.ok).toBe(true);
    expect(controller.getSpec().series[0]!.values[0]).toBe(5);
    expect(presence.getState().actors).toEqual([]);
  });
});
