import { describe, it, expect } from "vitest";
import { planAgentCommand, type EditorSnapshot } from "../src/agent";
import { placeInView, overlaps } from "../src/canvas/layout";

function addedNode(steps: ReturnType<typeof planAgentCommand>) {
  const step = steps.find((s) => s.type === "step:canvas_add_node");
  if (!step || step.type !== "step:canvas_add_node")
    throw new Error("no node added");
  return step.node;
}

describe("canvas:add_node placement", () => {
  const view = { x: 1000, y: 500, width: 1200, height: 800 };

  it("places an unanchored node at the centre of the visible area", () => {
    const snapshot: EditorSnapshot = { canvas: { nodes: [], edges: [] } };
    const node = addedNode(
      planAgentCommand(
        {
          type: "canvas:add_node",
          node: { id: "n", width: 96, height: 96, data: {} },
        },
        snapshot,
        { visibleRect: view },
      ),
    );
    expect(node.position).toEqual({ x: 1552, y: 852 });
  });

  it("keeps an unanchored node clear of what is already in view (getter form)", () => {
    const snapshot: EditorSnapshot = {
      canvas: {
        nodes: [
          {
            id: "busy",
            position: { x: 1450, y: 750 },
            width: 300,
            height: 300,
            data: {},
          },
        ],
        edges: [],
      },
    };
    const node = addedNode(
      planAgentCommand(
        {
          type: "canvas:add_node",
          node: { id: "n", width: 200, height: 120, data: {} },
        },
        snapshot,
        { visibleRect: () => view },
      ),
    );
    const placed = { ...node.position, width: 200, height: 120 };
    expect(
      overlaps(placed, { x: 1450, y: 750, width: 300, height: 300 }, 0),
    ).toBe(false);
  });

  it("uses the new node’s own size when placing beside an anchor", () => {
    const snapshot: EditorSnapshot = {
      canvas: {
        nodes: [
          {
            id: "a",
            position: { x: 0, y: 0 },
            width: 200,
            height: 60,
            data: {},
          },
          {
            id: "b",
            position: { x: 248, y: 0 },
            width: 40,
            height: 400,
            data: {},
          },
        ],
        edges: [],
      },
    };
    const small = addedNode(
      planAgentCommand(
        {
          type: "canvas:add_node",
          node: { id: "n", width: 40, height: 40, data: {} },
          nearNodeId: "a",
          side: "below",
        },
        snapshot,
      ),
    );
    expect(small.position.y).toBe(60 + 48);
    expect(small.position.x).toBe(100 - 20);
  });

  it("still falls back beside the last node without a visible area", () => {
    const snapshot: EditorSnapshot = {
      canvas: {
        nodes: [
          {
            id: "a",
            position: { x: 0, y: 0 },
            width: 200,
            height: 60,
            data: {},
          },
        ],
        edges: [],
      },
    };
    const node = addedNode(
      planAgentCommand(
        { type: "canvas:add_node", node: { id: "n", data: {} } },
        snapshot,
      ),
    );
    expect(node.position.x).toBeGreaterThan(200);
  });
});

describe("placeInView", () => {
  it("searches outward in rings when the centre is taken", () => {
    const rects = { c: { x: 400, y: 250, width: 200, height: 100 } };
    const p = placeInView(
      rects,
      { width: 200, height: 100 },
      { x: 0, y: 0, width: 1000, height: 600 },
    );
    expect(overlaps({ ...p, width: 200, height: 100 }, rects.c, 0)).toBe(false);
    expect(Math.hypot(p.x - 400, p.y - 250)).toBeLessThan(400);
  });
});
