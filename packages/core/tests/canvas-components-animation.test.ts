import { describe, it, expect } from "vitest";
import {
  animateNode,
  applyAnimation,
  createCanvasComponent,
  createCanvasInstance,
  getComponentSourceId,
  syncCanvasComponents,
  type CanvasNode,
} from "../src/canvas";

// Keyframes live in node.data.animation and component overrides in node.data, so
// animation has to propagate from a main component to its instances like any other
// layer data, and an instance's own animation has to survive main edits.
const nodes = (): CanvasNode[] => [
  { id: "card", type: "group", position: { x: 0, y: 0 }, width: 200, height: 100, data: { label: "Card" } },
  { id: "dot", type: "shape", parentId: "card", position: { x: 170, y: 10 }, width: 20, height: 20, data: { label: "Dot", shape: { kind: "rect", fill: "#ff0000" } } },
];

function run(current: CanvasNode[], op: (n: CanvasNode[]) => { ok: boolean; nodes?: CanvasNode[] }) {
  const result = op(current);
  expect(result.ok).toBe(true);
  return syncCanvasComponents(current, result.nodes!);
}

const instanceLayer = (all: CanvasNode[], instanceId: string, sourceId: string) =>
  all.find((n) => n.parentId === instanceId && getComponentSourceId(n) === sourceId)!;

describe("components with keyframe animation", () => {
  it("instances inherit the main's animation and keep their own animation as an override", () => {
    let doc = run(nodes(), (n) => createCanvasComponent(n, ["card"]) as any);
    doc = run(doc, (n) => createCanvasInstance(n, "card", { id: "inst", position: { x: 0, y: 200 } }) as any);

    // Animate the main's Dot: the instance's Dot follows.
    doc = syncCanvasComponents(doc, animateNode(doc, "dot", { to: { opacity: 0.2 }, from: { opacity: 1 }, duration: 1000 }).nodes);
    const dot = instanceLayer(doc, "inst", "dot");
    expect(dot.data.animation).toEqual(doc.find((n) => n.id === "dot")!.data.animation);
    const mid = applyAnimation(doc, 500);
    expect(mid.find((n) => n.id === dot.id)!.style?.opacity).toBeCloseTo(0.6, 2);

    // Give the instance's Dot its own animation; a later main edit keeps it.
    doc = syncCanvasComponents(doc, animateNode(doc, dot.id, { to: { opacity: 0 }, from: { opacity: 1 }, duration: 2000 }).nodes);
    const own = instanceLayer(doc, "inst", "dot").data.animation;
    doc = syncCanvasComponents(doc, doc.map((n) => (n.id === "dot" ? { ...n, data: { ...n.data, shape: { ...(n.data.shape as object), fill: "#00ff00" } } } : n)));
    const after = instanceLayer(doc, "inst", "dot");
    expect(after.data.animation).toEqual(own);
    expect((after.data.shape as { fill: string }).fill).toBe("#00ff00");
  });
});
