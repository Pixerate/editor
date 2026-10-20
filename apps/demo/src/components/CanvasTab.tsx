import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  NodeResizer,
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
  useCanvasCapture,
  useCanvasMeasure,
  useCanvasDraw,
  CanvasDrawLayer,
  CanvasGuidesLayer,
  ShapeNode,
  ShapeNodeZoomProvider,
  useCanvasBrushes,
  DEFAULT_ARRANGE_SHORTCUTS,
  type AlignEdge,
  type CanvasNode,
  type FreehandTool,
} from "@pixerate/editor-react/canvas";
import { useAgentToolProvider, useHistory, useHistoryShortcuts, useRegisterCommands } from "@pixerate/editor-react";
import { createArrangeCommands, createDrawCommands, createHistoryCommands } from "@pixerate/editor/commands";
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
  Pen,
  Highlighter,
  Eraser,
  MousePointer,
  Square,
  Circle,
  Star,
  Brush,
  Plus,
} from "lucide-react";
import {
  type ShapeDescription,
  CANVAS_GRADIENT_PRESETS,
  type CanvasGradientDef,
} from "@pixerate/editor-react/canvas";
import { demoCommandRegistry, demoToolRegistry } from "../agentTools";
import { AutoLayoutDemo } from "./AutoLayoutDemo";
import { MermaidDiagramDemo } from "./MermaidDiagramDemo";
import { TokensDemo } from "./TokensDemo";
import { ShapeOpsDemo } from "./ShapeOpsDemo";
import { AnimationDemo } from "./AnimationDemo";
import { ComponentsDemo } from "./ComponentsDemo";
import { AgentScriptPanel } from "./AgentScriptPanel";
import { CANVAS_SCRIPTS } from "../agentScripts";

type BoxData = { label: string; color: string; locked?: boolean; shape?: any };
type BoxNode = Node<BoxData, string>;

/** A plain card that shows a lock badge for locked nodes. */
const BoxNodeView: React.FC<NodeProps<BoxNode>> = ({ data, selected }) => (
  <>
  <NodeResizer isVisible={!!selected && !data.locked} minWidth={40} minHeight={30} color="#94a3b8" />
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
  </>
);

const NODE_TYPES = { box: BoxNodeView, shape: ShapeNode };

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

const shapeNode = (
  id: string,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  shape: ShapeDescription
): BoxNode => ({
  id,
  type: "shape",
  position: { x, y },
  width,
  height,
  style: { width, height },
  data: { label, color: (shape as any).stroke ?? (shape as any).fill ?? "#38bdf8", shape },
});

let nextNodeId = 1;
const getUniqueNodeId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${nextNodeId++}`;

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
    guides: { gridSize: 10 },
  });
  const [activeGradientKey, setActiveGradientKey] = useState<string | null>(null);

  const draw = useCanvasDraw<BoxNode>({
    nodes,
    setNodes,
    history: history.manager,
    initialTool: "select",
  });
  // Dry paint brushes for freehand strokes; the paint engine loads when this list is first read.
  const [brushId, setBrushId] = useState("");
  const brushes = useCanvasBrushes();
  useEffect(() => {
    if ((draw.tool === "pen" || draw.tool === "highlighter") && (draw.style.brush ?? "") !== brushId) {
      draw.setStyle({ brush: brushId || undefined });
    }
  }, [draw, brushId]);

  const selectColor = useCallback((color: string) => {
    setActiveGradientKey(null);
    draw.setStyle({ color, gradient: undefined });
  }, [draw]);

  const selectGradient = useCallback((key: string) => {
    setActiveGradientKey(key);
    const grad = CANVAS_GRADIENT_PRESETS[key];
    if (grad) {
      draw.setStyle({ color: grad.stops[0]?.color ?? '#38bdf8', gradient: grad });
    }
  }, [draw]);

  // Hold Alt / Option and hover a node to measure distances from the selection.
  const measure = useCanvasMeasure<BoxNode>({ nodes });

  const scenes = useCanvasScenes({
    getViewport: flow.getViewport,
    setViewport: flow.setViewport,
    wrap: true,
  });

  useCanvasArrangeShortcuts({ arrange, scenes });

  // Palette / agent commands. The hooks above keep handling the keys; the palette shows them.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const commands = useMemo(
    () => [
      ...createHistoryCommands(history.manager, { prefix: "canvas.history." }),
      ...createArrangeCommands(arrange, {
        scope: null,
        getSelectedIds: () => nodesRef.current.filter((n) => n.selected).map((n) => n.id),
        scenes: { next: () => scenesRef.current.next(), previous: () => scenesRef.current.previous() },
      }),
      // canvas.drawFreehand (optionally brushed, with a pressure profile) and canvas.listBrushes.
      ...createDrawCommands(draw, { scope: null }),
    ],
    [history.manager, arrange, draw.drawStroke, draw.listBrushes],
  );
  useRegisterCommands(demoCommandRegistry, commands);
  useEffect(() => demoCommandRegistry.invalidate(), [nodes, history.canUndo, history.canRedo]);

  const addNodeWithUndo = useCallback((node: BoxNode) => {
    history.manager.execute({
      name: "add-node",
      execute: () => {
        setNodes((prev) => [...prev, node]);
      },
      undo: () => {
        setNodes((prev) => prev.filter((n) => n.id !== node.id));
      },
    });
  }, [history.manager]);

  const activeGradDef = activeGradientKey ? CANVAS_GRADIENT_PRESETS[activeGradientKey] : null;

  const addShape = useCallback((kind: "rect" | "ellipse" | "star") => {
    const vp = flow.getViewport();
    // Canvas coordinates centered roughly in view
    const cx = (-vp.x + 400) / (vp.zoom || 1);
    const cy = (-vp.y + 240) / (vp.zoom || 1);

    const fillVal = activeGradDef ? activeGradDef : `${draw.style.color}33`;
    const strokeVal = activeGradDef ? activeGradDef : (draw.style.color as string);

    if (kind === "rect") {
      const node = shapeNode(
        getUniqueNodeId("shape-rect"),
        "Rectangle",
        cx - 60,
        cy - 40,
        120,
        80,
        {
          kind: "rect",
          cornerRadius: 8,
          fill: fillVal,
          stroke: strokeVal,
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }
      );
      addNodeWithUndo(node);
    } else if (kind === "ellipse") {
      const node = shapeNode(
        getUniqueNodeId("shape-ellipse"),
        "Circle",
        cx - 50,
        cy - 50,
        100,
        100,
        {
          kind: "ellipse",
          fill: fillVal,
          stroke: strokeVal,
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }
      );
      addNodeWithUndo(node);
    } else if (kind === "star") {
      const node = shapeNode(
        getUniqueNodeId("shape-star"),
        "Star",
        cx - 50,
        cy - 50,
        100,
        100,
        {
          kind: "star",
          points: 5,
          innerRadius: 0.5,
          fill: fillVal,
          stroke: strokeVal,
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }
      );
      addNodeWithUndo(node);
    }
  }, [flow, addNodeWithUndo, activeGradDef, draw.style.color]);

  const addSampleDrawing = useCallback(() => {
    const vp = flow.getViewport();
    const cx = (-vp.x + 360) / (vp.zoom || 1);
    const cy = (-vp.y + 220) / (vp.zoom || 1);

    // Decorative smooth spiral / wave stroke
    const d = "M 10 70 C 30 10, 70 10, 90 70 C 110 130, 150 130, 170 70 C 190 10, 230 10, 250 70";
    const strokeVal = activeGradDef ? activeGradDef : (draw.style.color as string);
    const node = shapeNode(
      getUniqueNodeId("drawing"),
      "Wave Drawing",
      cx - 130,
      cy - 40,
      260,
      80,
      {
        kind: "path",
        d,
        viewBox: [0, 0, 260, 80],
        stroke: strokeVal,
        strokeWidth: 4,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        fill: "none",
        opacity: 0.95,
      }
    );
    addNodeWithUndo(node);
  }, [flow, addNodeWithUndo, activeGradDef, draw.style.color]);

  const onNodesChange = useCallback(
    (changes: NodeChange<BoxNode>[]) =>
      setNodes((current) => applyNodeChanges(arrange.snapResizeChanges(arrange.snapPositionChanges(changes)), current)),
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

  const agentStage = useRef<HTMLDivElement>(null);
  // canvas__capture_view: screenshots of the viewport, all nodes, the selection, nodes by id or a rect.
  const capture = useCanvasCapture<BoxNode>({
    id: "canvas-capture",
    namespace: "canvas",
    element: () => agentStage.current?.querySelector<HTMLElement>(".react-flow"),
    getViewport: flow.getViewport,
    getNodes: flow.getNodes,
  });
  useAgentToolProvider(demoToolRegistry, capture);
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
        <button
          type="button"
          className={`${btn} ${draw.tool === "select" ? "bg-slate-800 text-sky-400 font-medium" : ""}`}
          onClick={() => draw.setTool("select")}
          title="Select / Move mode (V)"
          aria-label="Select mode"
        >
          <MousePointer className="w-4 h-4" />
        </button>
        <button
          type="button"
          className={`${btn} ${draw.tool === "pen" ? "bg-slate-800 text-sky-400 font-medium" : ""}`}
          onClick={() => draw.setTool("pen")}
          title="Pen tool (P)"
          aria-label="Pen tool"
        >
          <Pen className="w-4 h-4" />
        </button>
        <button
          type="button"
          className={`${btn} ${draw.tool === "highlighter" ? "bg-slate-800 text-amber-400 font-medium" : ""}`}
          onClick={() => draw.setTool("highlighter")}
          title="Highlighter tool (H)"
          aria-label="Highlighter tool"
        >
          <Highlighter className="w-4 h-4" />
        </button>
        <button
          type="button"
          className={`${btn} ${draw.tool === "eraser" ? "bg-slate-800 text-rose-400 font-medium" : ""}`}
          onClick={() => draw.setTool("eraser")}
          title="Eraser tool (E)"
          aria-label="Eraser tool"
        >
          <Eraser className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-slate-800">
          <input
            type="color"
            value={typeof draw.style.color === 'string' ? draw.style.color : '#3b82f6'}
            onChange={(e) => selectColor(e.target.value)}
            className="w-5 h-5 rounded cursor-pointer bg-transparent border-0 p-0"
            title="Solid color"
          />
          <div className="flex items-center gap-1 bg-slate-950/60 p-0.5 rounded border border-slate-800" title="Choose color or gradient">
            {Object.entries(CANVAS_GRADIENT_PRESETS).map(([key, grad]) => {
              const bg = `linear-gradient(${grad.angle ?? 90}deg, ${grad.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(', ')})`;
              const isSelected = activeGradientKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectGradient(key)}
                  className={`w-4 h-4 rounded-full transition-transform hover:scale-110 ${
                    isSelected ? 'ring-2 ring-white scale-110' : 'opacity-80 hover:opacity-100'
                  }`}
                  style={{ background: bg }}
                  title={`Gradient: ${key.charAt(0).toUpperCase() + key.slice(1)}`}
                  aria-label={`Gradient: ${key}`}
                />
              );
            })}
          </div>
          {draw.tool !== "select" && draw.tool !== "eraser" && (
            <input
              type="range"
              min={draw.tool === "highlighter" ? 12 : 1}
              max={draw.tool === "highlighter" ? 48 : draw.style.brush ? 60 : 16}
              value={draw.style.width}
              onChange={(e) => draw.setStyle({ width: Number(e.target.value) })}
              className="w-16 accent-sky-500 cursor-pointer"
              title={`Stroke width: ${draw.style.width}px`}
            />
          )}
          {draw.tool !== "select" && draw.tool !== "eraser" && (
            <select
              value={brushId}
              onChange={(e) => setBrushId(e.target.value)}
              className="bg-slate-800 text-slate-200 text-xs rounded px-1 py-1 max-w-[8.5rem]"
              title="Brush: a plain vector stroke, or a dry paint brush (pressure and tilt from a pen)"
              aria-label="Freehand brush"
            >
              <option value="">Vector stroke</option>
              {brushes.brushes.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="w-px h-5 bg-slate-800 mx-1" />
        <div className="flex items-center gap-0.5 bg-slate-800/60 rounded p-0.5" title="Insert shapes into canvas">
          <button
            type="button"
            className={`${btn} p-1.5`}
            onClick={() => addShape("rect")}
            title="Add Rectangle Shape"
            aria-label="Add Rectangle Shape"
          >
            <Square className="w-4 h-4 text-sky-400" />
          </button>
          <button
            type="button"
            className={`${btn} p-1.5`}
            onClick={() => addShape("ellipse")}
            title="Add Circle Shape"
            aria-label="Add Circle Shape"
          >
            <Circle className="w-4 h-4 text-purple-400" />
          </button>
          <button
            type="button"
            className={`${btn} p-1.5`}
            onClick={() => addShape("star")}
            title="Add Star Shape"
            aria-label="Add Star Shape"
          >
            <Star className="w-4 h-4 text-amber-400" />
          </button>
          <button
            type="button"
            className={`${btn} p-1.5`}
            onClick={addSampleDrawing}
            title="Add Sample Freehand Drawing"
            aria-label="Add Sample Freehand Drawing"
          >
            <Brush className="w-4 h-4 text-pink-400" />
          </button>
        </div>
        <div className="w-px h-5 bg-slate-800 mx-1" />
        <button type="button" className={btn} disabled={!history.canUndo} onClick={() => history.undo()} title="Undo (Mod+Z)" aria-label="Undo">
          <Undo2 className="w-4 h-4" />
        </button>
        <button type="button" className={btn} disabled={!history.canRedo} onClick={() => history.redo()} title="Redo (Mod+Shift+Z)" aria-label="Redo">
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      <div className="h-[520px] rounded-xl overflow-hidden border border-slate-800 bg-slate-950 relative" data-testid="canvas-pane" ref={agentStage}>
        <ShapeNodeZoomProvider zoom={viewport.zoom}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeMouseEnter={measure.onNodeMouseEnter}
          onNodeMouseLeave={measure.onNodeMouseLeave}
          colorMode="dark"
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <CanvasGuidesLayer guides={[...arrange.guides, ...measure.guides]} viewport={viewport} />
          <CanvasDrawLayer draw={draw} viewport={viewport} />
        </ReactFlow>
        </ShapeNodeZoomProvider>
      </div>
      <AgentScriptPanel scripts={CANVAS_SCRIPTS} stage={agentStage} hint="Plays a scripted agent turn with the canvas__* tools: list_nodes returns the ids that align_nodes takes." />

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
        Drag a node near another to see smart guides (edges, centres, equal spacing) and snapping; resize a selected node
        from its handles to snap its edges (10px grid otherwise). Hold Alt / Option and hover a node to measure distances
        from the selection. Shift-click or drag a selection box to select several nodes. Use toolbar buttons to insert shapes
        (Rectangle, Circle, Star) or a sample drawing, or pick Pen (P), Highlighter (H), or Eraser (E) to sketch directly onto the canvas.
        Shortcuts: Alt+A/H/D/W/V/S align, Alt+Shift+H/V distribute, Mod+L lock, Mod+]/[ layer order, PageDown/PageUp scenes, Mod+Z undo.
      </p>

      <MermaidDiagramDemo />

      <AutoLayoutDemo />

      <TokensDemo />
      <ShapeOpsDemo />
      <AnimationDemo />
      <ComponentsDemo />
    </div>
  );
};

export const CanvasTab: React.FC = () => (
  <ReactFlowProvider>
    <CanvasDemo />
  </ReactFlowProvider>
);
