import React, { useCallback, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  applyNodeChanges,
  useViewport,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  useCanvasAutoLayout,
  CanvasGuidesLayer,
  applyNodeUpdates,
  layoutAll,
  type AutoLayout,
  type AutoLayoutChild,
} from "@pixerate/editor-react/canvas";
import { useHistory } from "@pixerate/editor-react";
import { LayoutGrid, Plus, Redo2, Undo2 } from "lucide-react";

type ItemData = { label: string; color: string; layout?: AutoLayout; childLayout?: AutoLayoutChild };
type ItemNode = Node<ItemData, "frame" | "item">;

const FrameView: React.FC<NodeProps<ItemNode>> = ({ data, selected }) => (
  <div
    className={`h-full w-full rounded-xl border border-dashed ${selected ? "border-sky-400" : "border-slate-600"} bg-slate-900/60`}
  >
    <span className="absolute -top-5 left-1 text-[10px] uppercase tracking-wider text-slate-500">{data.label}</span>
  </div>
);

const ItemView: React.FC<NodeProps<ItemNode>> = ({ data, selected }) => (
  <div
    className={`h-full w-full rounded-lg border-2 text-xs text-slate-100 flex items-center justify-center ${selected ? "ring-2 ring-white/70" : ""}`}
    style={{ background: `${data.color}33`, borderColor: data.color }}
  >
    {data.label}
  </div>
);

const NODE_TYPES = { frame: FrameView, item: ItemView };

const frame = (id: string, label: string, x: number, y: number, layout: AutoLayout): ItemNode => ({
  id,
  type: "frame",
  position: { x, y },
  data: { label, color: "", layout },
  width: 10,
  height: 10,
});

let counter = 0;
const item = (parentId: string, label: string, width: number, height: number, color: string, childLayout?: AutoLayoutChild): ItemNode => ({
  id: `${parentId}-${++counter}`,
  type: "item",
  parentId,
  position: { x: 0, y: 0 },
  data: { label, color, childLayout },
  width,
  height,
});

function initialNodes(): ItemNode[] {
  const nodes: ItemNode[] = [
    // A vertical card stack that hugs its height; cards fill its width.
    frame("cards", "Card stack (vertical, hug)", 0, 0, {
      mode: "vertical",
      gap: 10,
      padding: 12,
      sizing: { width: "fixed", height: "hug" },
    }),
    item("cards", "Brief", 120, 40, "#f43f5e", { sizing: { width: "fill" } }),
    item("cards", "Research notes", 120, 60, "#8b5cf6", { sizing: { width: "fill" } }),
    item("cards", "Review", 120, 40, "#10b981", { sizing: { width: "fill" } }),
    // A horizontal toolbar that hugs both axes, centred across.
    frame("toolbar", "Toolbar (horizontal, hug)", 280, 0, {
      mode: "horizontal",
      gap: 6,
      padding: 8,
      alignCross: "center",
      sizing: { width: "hug", height: "hug" },
    }),
    item("toolbar", "B", 32, 32, "#0ea5e9"),
    item("toolbar", "I", 32, 32, "#0ea5e9"),
    item("toolbar", "Link", 56, 24, "#f59e0b"),
  ];
  // The card stack is 220 wide; cards share it.
  nodes[0] = { ...nodes[0], width: 220 };
  return applyNodeUpdates(nodes, layoutAll(nodes));
}

const AutoLayoutCanvas: React.FC = () => {
  const [nodes, setNodes] = useState<ItemNode[]>(initialNodes);
  const history = useHistory({ maxDepth: 50 });
  const viewport = useViewport();
  const autoLayout = useCanvasAutoLayout<ItemNode>({ nodes, setNodes, history: history.manager });

  const onNodesChange = useCallback(
    (changes: NodeChange<ItemNode>[]) => setNodes((current) => applyNodeChanges(autoLayout.noteChanges(changes), current)),
    [autoLayout]
  );

  const btn = "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Auto layout">
        <LayoutGrid className="w-4 h-4 text-sky-400" />
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-1">Auto layout</span>
        <button type="button" className={btn} onClick={() => autoLayout.addNode(item("cards", "New card", 120, 40, "#64748b", { sizing: { width: "fill" } }))}>
          <Plus className="w-3.5 h-3.5" /> Card
        </button>
        <button type="button" className={btn} onClick={() => autoLayout.addNode(item("toolbar", "U", 32, 32, "#0ea5e9"), { index: 0 })}>
          <Plus className="w-3.5 h-3.5" /> Tool
        </button>
        <button type="button" className={btn} disabled={!history.canUndo} onClick={() => history.undo()} aria-label="Undo auto layout">
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <button type="button" className={btn} disabled={!history.canRedo} onClick={() => history.redo()} aria-label="Redo auto layout">
          <Redo2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="h-[280px] rounded-xl overflow-hidden border border-slate-800 bg-slate-950 relative" data-testid="auto-layout-pane">
        <ReactFlow
          nodes={nodes}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.3 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <CanvasGuidesLayer guides={autoLayout.guides} viewport={viewport} />
        </ReactFlow>
      </div>
      <p className="text-xs text-slate-500">
        Drag a card or tool within its frame to reorder it; delete a selected item (Backspace) and the frame hugs what is
        left. Adding and reordering are single undo steps (the buttons above).
      </p>
    </div>
  );
};

export const AutoLayoutDemo: React.FC = () => (
  <ReactFlowProvider>
    <AutoLayoutCanvas />
  </ReactFlowProvider>
);
