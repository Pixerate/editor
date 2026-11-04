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
  useCanvasEditorDocument,
  useCanvasCapture,
  useCanvasMeasure,
  useCanvasDraw,
  CanvasDrawLayer,
  CanvasGuidesLayer,
  ShapeNode,
  CanvasEffectsPanel,
  CanvasEffectsProvider,
  useCanvasEffects,
  useCanvasEffectsTools,
  ShapeNodeZoomProvider,
  useCanvasBrushes,
  useCanvasPlaybackSurface,
  useCanvasExplosion,
  createCanvasExplosionToolProvider,
  createCanvasProposalToolProvider,
  useCanvasProposals,
  PresenceLayer,
  type CanvasBrushPaint,
  DEFAULT_ARRANGE_SHORTCUTS,
  type AlignEdge,
  type CanvasNode,
  type FreehandTool,
} from "@pixerate/editor-react/canvas";
import { createCanvasGestureRecorder, createCanvasStickerHost, renderCanvasBrushPreview, type CanvasEdge } from "@pixerate/editor/canvas";
import { CANVAS_PROFILE, createBrushLibraryToolProvider } from "@pixerate/editor/brushes";
import { BrushLibraryBrowser, useBrushLibrary } from "@pixerate/editor-react/brushes";
import { demoBrushLibrary } from "../demoBrushes";
import { createOriginMiddleware } from "@pixerate/editor/tools";
import { useAgentToolProvider, useHistory, useHistoryShortcuts, useRegisterCommands } from "@pixerate/editor-react";
import { createArrangeCommands, createDrawCommands, createHistoryCommands } from "@pixerate/editor/commands";
import { createEditorMcpToolProvider, type AgentStep } from "@pixerate/editor/agent";
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
  Network,
  Plus,
  Sparkles,
  Sticker as StickerIcon,
} from "lucide-react";
import { StickerInsertPanel } from "@pixerate/editor-react/stickers";
import { createStickerToolProvider } from "@pixerate/editor/stickers";
import { demoStickers } from "../demoStickers";
import {
  type ShapeDescription,
  CANVAS_GRADIENT_PRESETS,
  type CanvasGradientDef,
} from "@pixerate/editor-react/canvas";
import { demoCommandRegistry, demoPlayback, demoToolRegistry } from "../agentTools";
import { EditorDocumentAutosave, useDemoDocumentTools } from "./EditorDocumentAutosave";
import { useDemoEffects } from "../demoEffects";
import { resolveEffectValues } from "@pixerate/editor/effects";
import type { CanvasShapeEffect } from "@pixerate/editor/canvas";
import { EffectsProviderSwitch } from "./EffectsProviderSwitch";
import { CanvasPaintLayerRecipe } from "./CanvasPaintLayerRecipe";
import { AutoLayoutDemo } from "./AutoLayoutDemo";
import { MermaidDiagramDemo } from "./MermaidDiagramDemo";
import { TokensDemo } from "./TokensDemo";
import { ShapeOpsDemo } from "./ShapeOpsDemo";
import { AnimationDemo } from "./AnimationDemo";
import { ComponentsDemo } from "./ComponentsDemo";
import { AgentScriptPanel } from "./AgentScriptPanel";
import { EditorPage, EditorPanel } from "./EditorPage";
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

/** Gradient paint choices for brushed freehand strokes (`style.paint`, a `PaintSource`). */
const BRUSH_PAINTS: { id: string; name: string; paint: CanvasBrushPaint }[] = [
  {
    id: "along",
    name: "Colour to yellow",
    paint: { type: "gradient", stops: [{ offset: 0, color: "paint" }, { offset: 1, color: "#facc15" }], map: { by: "distance", length: 240, repeat: "mirror" } },
  },
  {
    id: "sunset",
    name: "Sunset",
    paint: {
      type: "gradient",
      stops: [{ offset: 0, color: "#7c3aed" }, { offset: 0.5, color: "#e11d48" }, { offset: 1, color: "#f59e0b" }],
      space: "oklab",
      map: { by: "distance", length: 400, repeat: "mirror" },
    },
  },
  {
    id: "tip",
    name: "Loaded tip",
    paint: { type: "gradient", stops: [{ offset: 0, color: "#1d4ed8" }, { offset: 1, color: "#facc15" }], map: { by: "across-tip" } },
  },
  {
    id: "pressure",
    name: "By pressure",
    paint: { type: "gradient", stops: [{ offset: 0, color: "#93c5fd" }, { offset: 1, color: "#1e3a8a" }], map: { by: "pressure" } },
  },
];

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

/**
 * The star that shows provider effects: filled with a generator from whichever effects library is
 * picked (effects draw on shape nodes only, so the boxes never show one).
 */
const EFFECT_STAR_ID = "effect-star";
/** The generator the star gets from each library, by provider id (else the library's first generator). */
const EFFECT_STAR_FILLS: Record<string, string> = { fake: "fake.gradient", flair: "aurora" };
const EFFECT_STAR_EFFECT: CanvasShapeEffect = { effect: "fake.gradient", provider: "fake", name: "Gradient", mode: "fill", values: { from: "#f97316", to: "#7c3aed", angle: 45, spin: 0 } };

const INITIAL_NODES: BoxNode[] = [
  box("brief", "Brief", 40, 60, 140, 60, "#f43f5e"),
  box("research", "Research", 260, 20, 160, 80, "#8b5cf6"),
  box("sketch", "Sketches", 250, 170, 120, 60, "#0ea5e9"),
  box("review", "Review", 500, 110, 140, 70, "#10b981"),
  box("ship", "Ship it", 720, 70, 120, 120, "#f59e0b"),
  box("notes", "Sticky note", 520, 280, 180, 60, "#64748b"),
  shapeNode(EFFECT_STAR_ID, "Effect star", 760, 250, 140, 140, { kind: "star", points: 5, innerRadius: 0.5, fill: "#f59e0b33", stroke: "#f59e0b", strokeWidth: 2, strokeLinejoin: "round", effect: EFFECT_STAR_EFFECT }),
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
    brushLibrary: demoBrushLibrary,
    // The demo is always dark, so chalk is white.
    colorScheme: "dark",
  });
  // Dry paint brushes for freehand strokes; the paint engine loads when this list is first read.
  // Picking a brush sets the size to the preset's own; the slider then changes the brush size.
  const [brushId, setBrushId] = useState("");
  const [brushSize, setBrushSize] = useState<number | undefined>(undefined);
  const [brushMenuOpen, setBrushMenuOpen] = useState(false);
  // The presets and the demo library's saved brushes the canvas can paint (a brush saved in the
  // Paint tab shows here); a saved brush's facets go into the stroke style, so strokes keep a copy.
  const brushes = useCanvasBrushes({ swatches: { width: 96, height: 22, color: "#e2e8f0" }, library: demoBrushLibrary });
  const brushEntries = useBrushLibrary(demoBrushLibrary, { profile: CANVAS_PROFILE });
  const pickBrush = useCallback((id: string) => {
    setBrushId(id);
    setBrushSize(brushes.brushes.find((b) => b.id === id)?.size);
    setBrushMenuOpen(false);
    // Picking a brush with a default colour (the ballpoint's blue, chalk's white) paints in it.
    if (id) draw.selectBrush(id).catch(() => {});
  }, [brushes.brushes, draw]);
  useEffect(() => {
    const brushSpec = brushes.brushes.find((b) => b.id === brushId)?.spec;
    if ((draw.tool === "pen" || draw.tool === "highlighter") && ((draw.style.brush ?? "") !== brushId || draw.style.brushSize !== brushSize || draw.style.brushSpec !== brushSpec)) {
      draw.setStyle({ brush: brushId || undefined, brushSize: brushId ? brushSize : undefined, brushSpec });
    }
  }, [draw, brushId, brushSize, brushes.brushes]);
  const currentBrush = brushes.brushes.find((b) => b.id === brushId);
  // Gradient paint for brushed strokes, sampled dab by dab (the stroke colour fills "paint" stops).
  const [brushPaintId, setBrushPaintId] = useState("");
  useEffect(() => {
    const paint = BRUSH_PAINTS.find((p) => p.id === brushPaintId)?.paint;
    if ((draw.tool === "pen" || draw.tool === "highlighter") && draw.style.paint !== paint) draw.setStyle({ paint });
  }, [draw, brushPaintId]);

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

  // The demo-wide effects provider (built-in test effects, or Flair): effect fills and overlays on
  // shapes, and transitions between scenes.
  const { provider: effects, source: effectsSource } = useDemoEffects();
  const canvasScripts = useMemo(() => CANVAS_SCRIPTS.filter((s) => s.id !== (effectsSource === "flair" ? "canvas-effects" : "canvas-effects-flair")), [effectsSource]);
  const effectNodesRef = useRef(nodes);
  effectNodesRef.current = nodes;
  const scenes = useCanvasScenes({
    getViewport: flow.getViewport,
    setViewport: flow.setViewport,
    wrap: true,
    transitions: { provider: effects, element: () => agentStage.current },
  });
  const canvasEffects = useCanvasEffects<BoxNode>({ getNodes: () => effectNodesRef.current, setNodes, history: history.manager, scenes: scenes.store, effects });
  // Stickers go in as shape nodes from their outline (canvasstickers__insert_sticker), one undo step each.
  const stickerHost = useMemo(() => createCanvasStickerHost<BoxNode>({ getNodes: () => effectNodesRef.current, setNodes, history: history.manager }), [setNodes, history.manager]);
  const stickerTools = useMemo(() => createStickerToolProvider({ provider: () => demoStickers, insert: stickerHost, id: "canvas-stickers", namespace: "canvasstickers" }), [stickerHost]);
  useAgentToolProvider(demoToolRegistry, stickerTools);
  // The shared brush library's tools for the canvas profile (canvasbrushes__*): list, create and
  // check the brushes canvas.drawFreehand takes; previews are canvas strokes.
  const canvasBrushTools = useMemo(() => createBrushLibraryToolProvider(demoBrushLibrary, { profile: CANVAS_PROFILE, renderPreview: renderCanvasBrushPreview, id: "canvas-brushes", namespace: "canvasbrushes" }), []);
  useAgentToolProvider(demoToolRegistry, canvasBrushTools);
  useCanvasEffectsTools(demoToolRegistry, canvasEffects, { id: "canvas-effects", namespace: "canvasfx" });
  // Switching libraries re-fills the demo star with one of the new library's generators, as long as
  // it still holds the effect the demo gave it (an effect someone applied stays, drawn as a hatch).
  const starSeed = useRef<CanvasShapeEffect>(EFFECT_STAR_EFFECT);
  useEffect(() => {
    if (!effects) return;
    let cancelled = false;
    const star = () => effectNodesRef.current.find((n) => n.id === EFFECT_STAR_ID);
    const effectOf = (n: BoxNode | undefined) => (n?.data as { shape?: ShapeDescription } | undefined)?.shape?.effect;
    const was = effectOf(star());
    if (!was || was.provider === effects.id || JSON.stringify(was) !== JSON.stringify(starSeed.current)) return;
    void (async () => {
      const preferred = EFFECT_STAR_FILLS[effects.id];
      const generators = await effects.list({ use: "generator" });
      const id = generators.find((g) => g.id === preferred)?.id ?? generators[0]?.id;
      if (!id) return;
      const d = await effects.describe(id);
      if (cancelled || JSON.stringify(effectOf(star())) !== JSON.stringify(starSeed.current)) return;
      const next: CanvasShapeEffect = { effect: d.id, provider: effects.id, name: d.name, mode: "fill", values: resolveEffectValues(d) as CanvasShapeEffect["values"] };
      starSeed.current = next;
      // Not an undo step: the demo's choice of library, not an edit.
      setNodes((prev) => prev.map((n) => (n.id === EFFECT_STAR_ID ? { ...n, data: { ...n.data, shape: { ...(n.data as { shape: ShapeDescription }).shape, effect: next } } } : n)));
    })().catch((e) => console.warn("The demo star could not take an effect from", effects.name, e));
    return () => {
      cancelled = true;
    };
  }, [effects, setNodes]);

  // Save / load / undo for the whole canvas (canvas__get_canvas_document, …) and autosave.
  const canvasDocument = useCanvasEditorDocument<BoxNode, Edge>({ nodes, edges, setNodes, setEdges, history: history.manager, scenes: scenes.store });
  useDemoDocumentTools(canvasDocument, { namespace: "canvas", skill: "pixerate-canvas" });
  // React Flow moves dragged nodes itself; record each finished drag as one undo step.
  const graphRef = useRef({ nodes, edges });
  graphRef.current = { nodes, edges };
  const dragUndo = useMemo(
    () =>
      createCanvasGestureRecorder<BoxNode, Edge>({
        getNodes: () => graphRef.current.nodes,
        setNodes,
        getEdges: () => graphRef.current.edges,
        setEdges,
        history: history.manager,
      }),
    [history.manager],
  );

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
      // canvas.drawFreehand (optionally brushed, with a pressure profile), canvas.listBrushes and the
      // annotation gestures (canvas.circle, canvas.arrow, …), which take { nodeId } through nodeBounds.
      ...createDrawCommands(draw, { scope: null }),
    ],
    [history.manager, arrange, draw.drawStroke, draw.listBrushes, draw.nodeBounds],
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

  // The canvas edit tools (canvas__get_editor_state, canvas__canvas_add_node, ...). Each call
  // applies as one undo step; the arrange commands (commands__run_command canvas.alignMiddle, ...)
  // come from the command registry above. Both play on the canvas surface below.
  const live = useRef({ nodes, edges });
  live.current = { nodes, edges };
  const provider = useMemo(
    () =>
      createEditorMcpToolProvider<BoxNode>({
        id: "canvas",
        namespace: "canvas",
        surfaces: { canvas: true, prompt: false },
        getSnapshot: () => ({ canvas: { nodes: live.current.nodes, edges: live.current.edges as CanvasEdge[], selectedNodeIds: live.current.nodes.filter((n) => n.selected).map((n) => n.id) } }),
        applySteps: (steps: AgentStep<BoxNode>[]) => {
          const before = live.current;
          let next = before;
          for (const step of steps) {
            if (step.type === "step:canvas_add_node") next = { ...next, nodes: [...next.nodes, { ...step.node, type: step.node.type ?? "box" } as BoxNode] };
            else if (step.type === "step:canvas_add_edge") next = { ...next, edges: [...next.edges, step.edge as Edge] };
            else if (step.type === "step:canvas_remove_nodes") {
              const gone = new Set(step.nodeIds);
              next = { nodes: next.nodes.filter((n) => !gone.has(n.id)), edges: next.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)) };
            } else if (step.type === "step:canvas_update_node") next = { ...next, nodes: next.nodes.map((n) => (n.id === step.id ? { ...n, data: { ...n.data, ...step.data } } : n)) };
            else if (step.type === "step:canvas_move_nodes") next = { ...next, nodes: next.nodes.map((n) => (step.positions[n.id] ? { ...n, position: step.positions[n.id]! } : n)) };
            else if (step.type === "step:canvas_select") next = { ...next, nodes: next.nodes.map((n) => ({ ...n, selected: step.nodeIds.includes(n.id) })) };
          }
          if (next === before) return;
          const apply = (state: typeof before) => {
            // Update the live copy at once, so the agent's cursor finds what it just made.
            live.current = state;
            setNodes(state.nodes);
            setEdges(state.edges);
          };
          history.manager.execute({ name: "Agent edit", execute: () => apply(next), undo: () => apply(before) });
        },
      }),
    [history.manager]
  );
  useAgentToolProvider(demoToolRegistry, provider, { playback: demoPlayback });

  // Agent suggestions: canvas__propose_nodes stages ghost nodes that the user accepts (one undo
  // step, recorded as the agent's) or dismisses in the strip under the canvas.
  const proposals = useCanvasProposals<BoxNode, Edge>({ nodes, edges, setNodes, setEdges, history: history.manager, defaultNodeType: "box" });
  const proposalTools = useMemo(
    () => createCanvasProposalToolProvider(proposals.store, { id: "canvas-proposals", namespace: "canvas" }),
    [proposals.store]
  );
  useAgentToolProvider(demoToolRegistry, proposalTools);
  // Steps the canvas tools make are recorded as the calling agent's (agent:<id>), not the user's.
  useEffect(
    () => demoToolRegistry.use(createOriginMiddleware({ histories: (call) => (call.provider.id.startsWith("canvas") ? history.manager : undefined) })),
    [history.manager]
  );

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

  // Explode a card into its steps: neighbours slide aside, collapse puts them back. Agents get
  // canvas__list_explodable_nodes / canvas__explode_node / canvas__collapse_node.
  // React Flow edge labels are ReactNodes; core CanvasEdge labels are strings, so edges stay loose.
  const explosion = useCanvasExplosion<BoxNode, any>({ nodes, edges, setNodes, setEdges });
  const explosionRef = useRef(explosion);
  explosionRef.current = explosion;
  const isExplosionStep = (id: string) => id.includes(":step");
  const explodeCard = useCallback((id: string) => {
    const parent = live.current.nodes.find((n) => n.id === id);
    if (!parent) return false;
    const width = parent.measured?.width ?? parent.width ?? 140;
    const childNodes = ["Plan", "Do", "Check"].map((step, i) =>
      box(`${id}:step${i + 1}`, `${parent.data.label}: ${step}`, parent.position.x + width + 40, parent.position.y - 50 + i * 50, 130, 40, parent.data.color)
    );
    return explosionRef.current.explodeNode(id, { childNodes, duration: 450, directionalOptions: { direction: "right", gap: 40 } });
  }, []);
  const explosionTools = useMemo(
    () =>
      createCanvasExplosionToolProvider<BoxNode>(
        {
          getNodes: () => live.current.nodes,
          canExplode: (n) => (isExplosionStep(n.id) ? "A step has no steps of its own." : n.type === "box" ? true : "Only cards explode."),
          exploded: () => explosionRef.current.explodedNodeIds,
          explode: explodeCard,
          collapse: (id) => explosionRef.current.collapseNode(id, { duration: 350 }),
          multiple: true,
        },
        { id: "canvas-explosion", namespace: "canvas" }
      ),
    [explodeCard]
  );
  useAgentToolProvider(demoToolRegistry, explosionTools);
  const selectedCard = nodes.length && selectedCount === 1 ? nodes.find((n) => n.selected && n.type === "box" && !isExplosionStep(n.id)) : undefined;
  // The agent's cursor on the canvas: every canvas__* and canvas.* call is acted out here.
  const agentPresence = useCanvasPlaybackSurface(demoPlayback, "canvas", {
    getNodes: () => live.current.nodes,
    getEdges: () => live.current.edges as CanvasEdge[],
    viewport,
    container: agentStage,
  });
  const btn =
    "p-2 rounded hover:bg-slate-800 transition-colors text-slate-300 disabled:opacity-40 disabled:hover:bg-transparent";
  const needs = (min: number) => selectedCount < min;

  return (
    <div className="space-y-3">
      <EditorDocumentAutosave doc={canvasDocument} name="Canvas" />
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
            brushId ? (
              <input
                type="range"
                min={1}
                max={120}
                value={brushSize ?? currentBrush?.size ?? 10}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                className="w-16 accent-sky-500 cursor-pointer"
                title={`Brush size: ${brushSize ?? currentBrush?.size}px`}
                aria-label="Brush size"
              />
            ) : (
              <input
                type="range"
                min={draw.tool === "highlighter" ? 12 : 1}
                max={draw.tool === "highlighter" ? 48 : 16}
                value={draw.style.width}
                onChange={(e) => draw.setStyle({ width: Number(e.target.value) })}
                className="w-16 accent-sky-500 cursor-pointer"
                title={`Stroke width: ${draw.style.width}px`}
              />
            )
          )}
          {draw.tool !== "select" && draw.tool !== "eraser" && (
            <div className="relative">
              <button
                type="button"
                className="flex items-center gap-1.5 bg-slate-800 text-slate-200 text-xs rounded px-1.5 py-1"
                onClick={() => setBrushMenuOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={brushMenuOpen}
                aria-label="Freehand brush"
                title="Brush: a plain vector stroke, or a dry paint brush (pressure and tilt from a pen)"
              >
                {currentBrush?.swatch ? <img src={currentBrush.swatch} alt="" className="h-4 w-12 object-contain" /> : null}
                <span>{currentBrush?.name ?? "Vector stroke"}</span>
              </button>
              {brushMenuOpen && (
                <div className="absolute z-50 mt-1 w-64 max-h-96 overflow-auto bg-slate-900 border border-slate-700 rounded shadow-lg p-1.5 flex flex-col gap-1.5 text-xs text-slate-200">
                  <button type="button" aria-pressed={!brushId} className="w-full text-left text-xs text-slate-200 px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700" onClick={() => pickBrush("")}>
                    Vector stroke
                  </button>
                  {/* The shared brush library, filtered by the canvas profile; thumbnails are canvas swatches. */}
                  <BrushLibraryBrowser entries={brushEntries} activeId={brushId || undefined} profile={CANVAS_PROFILE} onSelect={pickBrush} thumbnail={(id) => brushes.brushes.find((b) => b.id === id)?.swatch} thumbnailWidth={96} thumbnailHeight={22} />
                </div>
              )}
            </div>
          )}
          {draw.tool !== "select" && draw.tool !== "eraser" && brushId && (
            <select
              value={brushPaintId}
              onChange={(e) => setBrushPaintId(e.target.value)}
              className="bg-slate-800 text-slate-200 text-xs rounded px-1 py-1 max-w-[8.5rem]"
              title="Brush paint: the stroke colour, or gradient paint that changes colour along the stroke"
              aria-label="Brush paint"
            >
              <option value="">Stroke colour</option>
              {BRUSH_PAINTS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
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
        <button
          type="button"
          className={btn}
          disabled={!selectedCard}
          onClick={() => {
            if (!selectedCard) return;
            if (explosion.getSnapshot(selectedCard.id)) explosion.collapseNode(selectedCard.id, { duration: 350 });
            else explodeCard(selectedCard.id);
          }}
          title="Explode the selected card into steps, or collapse it"
          aria-label="Explode or collapse card"
          aria-pressed={!!selectedCard && explosion.isExploded(selectedCard.id)}
        >
          <Network className="w-4 h-4" />
        </button>
        <div className="w-px h-5 bg-slate-800 mx-1" />
        <button type="button" className={btn} disabled={!history.canUndo} onClick={() => history.undo()} title="Undo (Mod+Z)" aria-label="Undo">
          <Undo2 className="w-4 h-4" />
        </button>
        <button type="button" className={btn} disabled={!history.canRedo} onClick={() => history.redo()} title="Redo (Mod+Shift+Z)" aria-label="Redo">
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      <div className="h-[600px] rounded-xl overflow-hidden border border-slate-800 bg-slate-950 relative" data-testid="canvas-pane" ref={agentStage}>
        <CanvasEffectsProvider provider={effects}>
        <ShapeNodeZoomProvider zoom={viewport.zoom}>
        <ReactFlow
          nodes={proposals.view.nodes}
          edges={proposals.view.edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={() => dragUndo.begin()}
          // The drop's final position lands in state after this handler, so record a frame later.
          onNodeDragStop={() => requestAnimationFrame(() => dragUndo.end("Move"))}
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
        </CanvasEffectsProvider>
        <PresenceLayer presence={agentPresence} viewport={viewport} />
      </div>
      {proposals.proposals.length > 0 && (
        <div className="bg-violet-950/40 border border-violet-800/60 rounded-xl p-3 flex flex-col gap-2" aria-label="Suggestions">
          <span className="text-xs font-semibold uppercase tracking-wider text-violet-300">Suggestions</span>
          {proposals.proposals.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-xs text-slate-200" data-proposal-id={p.id}>
              <span className="font-medium">{p.title}</span>
              {p.rationale && <span className="text-slate-400 truncate">{p.rationale}</span>}
              <span className="text-slate-500">({p.origin})</span>
              <span className="ml-auto flex gap-1.5">
                <button type="button" className="px-2 py-0.5 rounded border border-violet-600 bg-violet-600/30 hover:bg-violet-600/50" onClick={() => proposals.accept(p.id)}>
                  Accept
                </button>
                <button type="button" className="px-2 py-0.5 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700" onClick={() => proposals.reject(p.id)}>
                  Dismiss
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <EffectsProviderSwitch />
      {(() => {
        const selectedShape = nodes.find((n) => n.selected && (n.data as { shape?: unknown }).shape);
        return (
          <EditorPanel id="effects" label="Effects" icon={Sparkles}>
          <CanvasEffectsPanel
            controller={canvasEffects}
            nodeId={selectedShape?.id ?? null}
            shape={((selectedShape?.data as { shape?: never } | undefined)?.shape) ?? null}
            sceneId={scenes.currentId}
            className="text-slate-200"
          />
          </EditorPanel>
        );
      })()}
      <AgentScriptPanel scripts={canvasScripts} hint="Plays a scripted agent turn: get_editor_state returns the ids that the arrange commands and canvas_connect take. The library acts every call out on the canvas (agent playback), with no targets in the script." />

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

      <EditorPanel id="stickers" label="Stickers" icon={StickerIcon}>
        <StickerInsertPanel provider={demoStickers} host={stickerHost} />
      </EditorPanel>
      <EditorPanel id="tips" label="Tips">
      <p className="text-xs leading-relaxed text-slate-400">
        Drag a node near another to see smart guides (edges, centres, equal spacing) and snapping; resize a selected node
        from its handles to snap its edges (10px grid otherwise). Hold Alt / Option and hover a node to measure distances
        from the selection. Shift-click or drag a selection box to select several nodes. Use toolbar buttons to insert shapes
        (Rectangle, Circle, Star) or a sample drawing, or pick Pen (P), Highlighter (H), or Eraser (E) to sketch directly onto the canvas.
        Shortcuts: Alt+A/H/D/W/V/S align, Alt+Shift+H/V distribute, Mod+L lock, Mod+]/[ layer order, PageDown/PageUp scenes, Mod+Z undo.
      </p>
      </EditorPanel>
    </div>
  );
};

const CANVAS_VIEWS = [
  {
    id: "whiteboard",
    label: "Whiteboard",
    render: () => (
      <ReactFlowProvider>
        <CanvasDemo />
      </ReactFlowProvider>
    ),
  },
  { id: "mermaid", label: "Mermaid diagrams", render: () => <MermaidDiagramDemo /> },
  { id: "components", label: "Components", render: () => <ComponentsDemo /> },
  { id: "auto-layout", label: "Auto layout", render: () => <AutoLayoutDemo /> },
  { id: "tokens", label: "Design tokens", render: () => <TokensDemo /> },
  { id: "booleans", label: "Shape booleans", render: () => <ShapeOpsDemo /> },
  { id: "keyframes", label: "Keyframes", render: () => <AnimationDemo /> },
  { id: "paint-layer", label: "Paint layer", render: () => <CanvasPaintLayerRecipe /> },
];

export const CanvasTab: React.FC = () => (
  <EditorPage
    tab="canvas"
    title="Canvas"
    icon={Shapes}
    description="An infinite canvas for diagrams and whiteboards: arrange, draw, connect, theme and animate nodes on React Flow."
    views={CANVAS_VIEWS}
  />
);
