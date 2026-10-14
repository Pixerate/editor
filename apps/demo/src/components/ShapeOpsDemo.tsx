import React, { useCallback, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, applyNodeChanges, type Node, type NodeChange } from "@xyflow/react";
import {
  useCanvasArrange,
  ShapeNode,
  countPathSegments,
  type ShapeDescription,
  type ShapeOperation,
  type StrokeJoin,
} from "@pixerate/editor-react/canvas";
import { useHistory, useRegisterCommands } from "@pixerate/editor-react";
import { createShapeCommands } from "@pixerate/editor/commands";
import { Circle, Redo2, Undo2 } from "lucide-react";
import { demoCommandRegistry } from "../agentTools";

type ShapeNodeData = { label: string; shape: ShapeDescription };
type DemoShapeNode = Node<ShapeNodeData, "shape">;

const NODE_TYPES = { shape: ShapeNode };

const shape = (id: string, x: number, y: number, w: number, h: number, s: ShapeDescription): DemoShapeNode => ({
  id,
  type: "shape",
  position: { x, y },
  width: w,
  height: h,
  selected: true,
  data: { label: id, shape: s },
});

/** Two overlapping circles (and a stroked rounded square) to try curve-preserving booleans on. */
function twoCircles(): DemoShapeNode[] {
  return [
    shape("circle-a", 0, 0, 160, 160, { kind: "ellipse", fill: "#60a5fa", opacity: 0.85 }),
    shape("circle-b", 100, 20, 160, 160, { kind: "ellipse", fill: "#f472b6", opacity: 0.85 }),
    {
      ...shape("square", 320, 30, 120, 120, { kind: "rect", cornerRadius: 24, fill: "#1e293b", stroke: "#facc15", strokeWidth: 10 }),
      selected: false,
    },
  ];
}

const OPERATIONS: ShapeOperation[] = ["unite", "intersect", "subtract", "exclude", "divide"];

const ShapeOpsCanvas: React.FC = () => {
  const [nodes, setNodes] = useState<DemoShapeNode[]>(twoCircles);
  const [join, setJoin] = useState<StrokeJoin>("round");
  const [status, setStatus] = useState("Select shapes, then combine, offset or outline them.");
  const history = useHistory({ maxDepth: 50 });
  const arrange = useCanvasArrange<DemoShapeNode>({ nodes, setNodes, history: history.manager });

  // The same operations in the command palette (and for agents).
  const commands = useMemo(() => createShapeCommands(arrange, { prefix: "shapes.", scope: null }), [arrange]);
  useRegisterCommands(demoCommandRegistry, commands);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const describe = (label: string, result: { ok: boolean; reason?: string; engine?: string }) => {
    if (!result.ok) return setStatus(`${label}: refused (${result.reason}).`);
    // Read the nodes after React applied the change.
    setTimeout(() => {
      const counts = nodesRef.current
        .filter((n) => n.selected)
        .map((n) => (n.data.shape.kind === "path" ? countPathSegments(n.data.shape.d) : null))
        .filter(Boolean) as { lines: number; cubics: number; quads: number }[];
      const cubics = counts.reduce((s, c) => s + c.cubics, 0);
      const lines = counts.reduce((s, c) => s + c.lines, 0);
      setStatus(`${label}${result.engine ? ` (${result.engine} engine)` : ""}: ${cubics} curves, ${lines} lines.`);
    }, 0);
  };

  const onNodesChange = useCallback(
    (changes: NodeChange<DemoShapeNode>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    []
  );

  const btn =
    "px-2.5 py-1 text-xs rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 capitalize";
  const selected = nodes.filter((n) => n.selected).length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Shape operations">
        <Circle className="w-4 h-4 text-sky-400" />
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-1">Curved booleans</span>
        <button type="button" className={btn} onClick={() => setNodes(twoCircles())}>
          Two circles
        </button>
        {OPERATIONS.map((op) => (
          <button
            key={op}
            type="button"
            className={btn}
            disabled={selected < 2}
            onClick={() => describe(op, arrange.combineShapes(op))}
          >
            {op}
          </button>
        ))}
        <div className="w-px h-5 bg-slate-800 mx-1" />
        <select
          className="text-xs rounded-lg border border-slate-700 bg-slate-800 text-slate-200 px-1.5 py-1"
          value={join}
          onChange={(e) => setJoin(e.target.value as StrokeJoin)}
          aria-label="Offset join"
        >
          <option value="round">Round joins</option>
          <option value="miter">Miter joins</option>
          <option value="bevel">Bevel joins</option>
        </select>
        <button type="button" className={btn} disabled={selected < 1} onClick={() => describe("Offset +12", arrange.offsetShapes(12, undefined, { join }))}>
          Offset +12
        </button>
        <button type="button" className={btn} disabled={selected < 1} onClick={() => describe("Offset −12", arrange.offsetShapes(-12, undefined, { join }))}>
          Offset −12
        </button>
        <button
          type="button"
          className={btn}
          disabled={!arrange.canOutlineStroke()}
          onClick={() => describe("Outline stroke", arrange.outlineStroke(undefined, { join }))}
        >
          Outline stroke
        </button>
        <button type="button" className={btn} disabled={!history.canUndo} onClick={() => history.undo()} aria-label="Undo shape operation">
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <button type="button" className={btn} disabled={!history.canRedo} onClick={() => history.redo()} aria-label="Redo shape operation">
          <Redo2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="h-[300px] rounded-xl overflow-hidden border border-slate-800 bg-slate-950 relative" data-testid="shape-ops-pane">
        <ReactFlow
          nodes={nodes}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.25 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
        </ReactFlow>
      </div>
      <p className="text-xs text-slate-500" role="status">
        {status} Booleans keep the circles' arcs as exact cubic curves; Offset grows or shrinks the selection; Outline stroke
        turns the yellow stroke into a filled shape. Each is one undo step.
      </p>
    </div>
  );
};

export const ShapeOpsDemo: React.FC = () => (
  <ReactFlowProvider>
    <ShapeOpsCanvas />
  </ReactFlowProvider>
);
