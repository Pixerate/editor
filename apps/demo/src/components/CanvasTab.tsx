import React, { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  useViewport,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  useCanvasArrange,
  useCanvasArrangeShortcuts,
  useCanvasScenes,
  CanvasGuidesLayer,
  DEFAULT_ARRANGE_SHORTCUTS,
  type AlignEdge,
} from "@pixerate/editor-react/canvas";
import { useAgentToolProvider, useHistory, useHistoryShortcuts } from "@pixerate/editor-react";
import type { AgentTool, AgentToolProvider } from "@pixerate/editor/agent";
import {
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  Lock,
  Unlock,
  BringToFront,
  SendToBack,
  ArrowUp,
  ArrowDown,
  Undo2,
  Redo2,
  Camera,
  ChevronLeft,
  ChevronRight,
  X,
  Shapes,
  MoveHorizontal,
  MoveVertical,
} from "lucide-react";
import { demoToolRegistry } from "../agentTools";

type BoxData = { label: string; color: string; locked?: boolean };
type BoxNode = Node<BoxData, "box">;

/** A plain card that shows a lock badge for locked nodes. */
const BoxNodeView: React.FC<NodeProps<BoxNode>> = ({ data, selected }) => (
  <div
    className={`h-full w-full rounded-lg border-2 px-3 py-2 text-xs font-medium text-slate-100 shadow-lg flex items-center justify-center text-center ${
      selected ? "ring-2 ring-white/70" : ""
    }`}
    style={{ background: `${data.color}33`, borderColor: data.color }}
  >
    <Handle type="target" position={Position.Left} />
    <span>{data.label}</span>
    {data.locked && (
      <Lock className="absolute top-1 right-1 w-3 h-3 text-slate-300" aria-label="Locked" />
    )}
    <Handle type="source" position={Position.Right} />
  </div>
);

const NODE_TYPES = { box: BoxNodeView };

const box = (
  id: string,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string
): BoxNode => ({
  id,
  type: "box",
  position: { x, y },
  data: { label, color },
  style: { width, height },
});

const INITIAL_NODES: BoxNode[] = [
  box("brief", "Brief", 40, 60, 140, 60, "#f43f5e"),
  box("research", "Research", 260, 20, 160, 80, "#8b5cf6"),
  box("sketch", "Sketches", 250, 170, 120, 60, "#0ea5e9"),
  box("review", "Review", 500, 110, 140, 70, "#10b981"),
  box("ship", "Ship it", 720, 70, 120, 120, "#f59e0b"),
  box("notes", "Sticky note", 520, 280, 180, 60, "#64748b"),
];

const INITIAL_EDGES: Edge[] = [
  { id: "e1", source: "brief", target: "research" },
  { id: "e2", source: "brief", target: "sketch" },
  { id: "e3", source: "research", target: "review" },
  { id: "e4", source: "sketch", target: "review" },
  { id: "e5", source: "review", target: "ship" },
];

const ALIGN_BUTTONS: Array<{ edge: AlignEdge; label: string; icon: React.ElementType }> = [
  { edge: "left", label: "Align left", icon: AlignStartVertical },
  { edge: "center", label: "Align center", icon: AlignCenterVertical },
  { edge: "right", label: "Align right", icon: AlignEndVertical },
  { edge: "top", label: "Align top", icon: AlignStartHorizontal },
  { edge: "middle", label: "Align middle", icon: AlignCenterHorizontal },
  { edge: "bottom", label: "Align bottom", icon: AlignEndHorizontal },
];

const shortcutLabel = (action: string) =>
  DEFAULT_ARRANGE_SHORTCUTS.find((b) => b.action === action)?.label;

const CanvasDemo: React.FC = () => {
  const [nodes, setNodes] = useState<BoxNode[]>(INITIAL_NODES);
  const [edges, setEdges] = useState<Edge[]>(INITIAL_EDGES);
  const history = useHistory({ maxDepth: 100 });
  useHistoryShortcuts(history.manager);
  const flow = useReactFlow<BoxNode>();
  const viewport = useViewport();

  const arrange = useCanvasArrange<BoxNode>({
    nodes,
    setNodes,
    history: history.manager,
    zoom: viewport.zoom,
  });

  const scenes = useCanvasScenes({
    getViewport: flow.getViewport,
    setViewport: flow.setViewport,
    wrap: true,
  });

  useCanvasArrangeShortcuts({ arrange, scenes });

  const onNodesChange = useCallback(
    (changes: NodeChange<BoxNode>[]) =>
      setNodes((current) => applyNodeChanges(arrange.snapPositionChanges(changes), current)),
    [arrange]
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current)),
    []
  );

  const selectedCount = nodes.filter((n) => n.selected).length;

  // A tiny custom provider so agents can inspect and align the canvas.
  const provider = useMemo<AgentToolProvider>(() => {
    const listNodes: AgentTool = {
      name: "list_nodes",
      description: "Lists canvas nodes with their positions and lock state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: () => ({
        nodes: flow.getNodes().map((n) => ({
          id: n.id,
          label: n.data.label,
          position: n.position,
          locked: !!n.data.locked,
        })),
      }),
    };
    const alignNodesTool: AgentTool = {
      name: "align_nodes",
      description: "Aligns nodes to an edge of their combined bounds.",
      inputSchema: {
        type: "object",
        properties: {
          edge: { type: "string", enum: ["left", "center", "right", "top", "middle", "bottom"] },
          ids: { type: "array", items: { type: "string" } },
        },
        required: ["edge", "ids"],
        additionalProperties: false,
      },
      handler: ({ edge, ids }) => {
        arrange.align(edge as AlignEdge, ids as string[]);
        return `Aligned ${(ids as string[]).length} nodes (${edge}).`;
      },
    };
    return { id: "canvas", namespace: "canvas", tools: [listNodes, alignNodesTool] };
  }, [arrange, flow]);
  useAgentToolProvider(demoToolRegistry, provider);

  const btn =
    "p-2 rounded hover:bg-slate-800 transition-colors text-slate-300 disabled:opacity-40 disabled:hover:bg-transparent";
  const needs = (min: number) => selectedCount < min;

  return (
    <div className="space-y-3">
      <div
        className="bg-slate-900/80 border border-slate-800 rounded-xl p-2 flex flex-wrap items-center gap-1 shadow-md"
        role="toolbar"
        aria-label="Arrange"
      >
        <div className="flex items-center gap-2 px-2 mr-1">
          <Shapes className="w-4 h-4 text-sky-400" />
          <span className="text-xs text-slate-400">{selectedCount} selected</span>
        </div>
        {ALIGN_BUTTONS.map(({ edge, label, icon: Icon }) => (
          <button
            key={edge}
            type="button"
            className={btn}
            disabled={needs(2)}
            onClick={() => arrange.align(edge)}
            title={`${label} (${shortcutLabel(`align${edge[0].toUpperCase()}${edge.slice(1)}`)})`}
            aria-label={label}
          >
            <Icon className="w-4 h-4" />
          </button>
        ))}
        <div className="w-px h-5 bg-slate-800 mx-1" />
        <button type="button" className={btn} disabled={needs(3)} onClick={() => arrange.distribute("horizontal")} title="Distribute horizontally (Alt+Shift+H)" aria-label="Distribute horizontally">
          <AlignHorizontalSpaceAround className="w-4 h-4" />
        </button>
        <button type="button" className={btn} disabled={needs(3)} onClick={() => arrange.distribute("vertical")} title="Distribute vertically (Alt+Shift+V)" aria-label="Distribute vertically">
          <AlignVerticalSpaceAround className="w-4 h-4" />
        </button>
        <button type="button" className={btn} disabled={needs(2)} onClick={() => arrange.matchSize("width")} title="Make same width" aria-label="Make same width">
          <MoveHorizontal className="w-4 h-4" />
        </button>
        <button type="button" className={btn} disabled={needs(2)} onClick={() => arrange.matchSize("height")} title="Make same height" aria-label="Make same height">
          <MoveVertical className="w-4 h-4" />
        </button>
        <div className="w-px h-5 bg-slate-800 mx-1" />
        <button type="button" className={btn} disabled={needs(1)} onClick={() => arrange.lock()} title="Lock (Mod+L)" aria-label="Lock">
          <Lock className="w-4 h-4" />
        </button>
        <button type="button" className={btn} disabled={needs(1)} onClick={() => arrange.unlock()} title="Unlock (Mod+Alt+L)" aria-label="Unlock">
          <Unlock className="w-4 h-4" />
        </button>
        <div className="w-px h-5 bg-slate-800 mx-1" />
        <button type="button" className={btn} disabled={needs(1)} onClick={() => arrange.bringToFront()} title="Bring to front (Mod+Alt+])" aria-label="Bring to front">
          <BringToFront className="w-4 h-4" />
        </button>
        <button type="button" className={btn} disabled={needs(1)} onClick={() => arrange.bringForward()} title="Bring forward (Mod+])" aria-label="Bring forward">
          <ArrowUp className="w-4 h-4" />
        </button>
        <button type="button" className={btn} disabled={needs(1)} onClick={() => arrange.sendBackward()} title="Send backward (Mod+[)" aria-label="Send backward">
          <ArrowDown className="w-4 h-4" />
        </button>
        <button type="button" className={btn} disabled={needs(1)} onClick={() => arrange.sendToBack()} title="Send to back (Mod+Alt+[)" aria-label="Send to back">
          <SendToBack className="w-4 h-4" />
        </button>
        <div className="w-px h-5 bg-slate-800 mx-1" />
        <button type="button" className={btn} disabled={!history.canUndo} onClick={() => history.undo()} title="Undo (Mod+Z)" aria-label="Undo">
          <Undo2 className="w-4 h-4" />
        </button>
        <button type="button" className={btn} disabled={!history.canRedo} onClick={() => history.redo()} title="Redo (Mod+Shift+Z)" aria-label="Redo">
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      <div className="h-[520px] rounded-xl overflow-hidden border border-slate-800 bg-slate-950 relative" data-testid="canvas-pane">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          colorMode="dark"
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <CanvasGuidesLayer guides={arrange.guides} viewport={viewport} />
        </ReactFlow>
      </div>

      {/* Scene strip */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 flex flex-wrap items-center gap-2" aria-label="Scenes">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-1">Scenes</span>
        <button
          type="button"
          onClick={() => scenes.capture(`Scene ${scenes.scenes.length + 1}`)}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200"
        >
          <Camera className="w-3.5 h-3.5" /> Capture view
        </button>
        <button type="button" className={btn} onClick={() => scenes.previous()} disabled={scenes.scenes.length === 0} title="Previous scene (PageUp)" aria-label="Previous scene">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button type="button" className={btn} onClick={() => scenes.next()} disabled={scenes.scenes.length === 0} title="Next scene (PageDown)" aria-label="Next scene">
          <ChevronRight className="w-4 h-4" />
        </button>
        {scenes.scenes.length === 0 && (
          <span className="text-xs text-slate-500 italic">Pan or zoom, then capture the view as a scene.</span>
        )}
        {scenes.scenes.map((scene) => (
          <span
            key={scene.id}
            className={`flex items-center gap-1 rounded-lg border text-xs ${
              scene.id === scenes.currentId
                ? "border-sky-500/60 bg-sky-500/10 text-sky-200"
                : "border-slate-700 bg-slate-900 text-slate-300"
            }`}
          >
            <button type="button" className="pl-2.5 py-1" onClick={() => scenes.goTo(scene.id)} data-scene-id={scene.id}>
              {scene.name}
            </button>
            <button type="button" className="pr-1.5 py-1 text-slate-500 hover:text-slate-200" onClick={() => scenes.remove(scene.id)} aria-label={`Remove ${scene.name}`}>
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>

      <p className="text-xs text-slate-500">
        Drag a node near another to see smart guides (edges, centres, equal spacing) and snapping. Shift-click or drag a
        selection box to select several nodes. Shortcuts: Alt+A/H/D/W/V/S align, Alt+Shift+H/V distribute, Mod+L lock,
        Mod+]/[ layer order, PageDown/PageUp scenes, Mod+Z undo.
      </p>
    </div>
  );
};

export const CanvasTab: React.FC = () => (
  <ReactFlowProvider>
    <CanvasDemo />
  </ReactFlowProvider>
);
