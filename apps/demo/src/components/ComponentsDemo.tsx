import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, applyNodeChanges, useReactFlow, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import {
  CanvasComponentsPanel,
  CanvasInstanceInspector,
  useCanvasComponents,
  bindCanvasComponentProperty,
  combineCanvasComponentsAsVariants,
  createCanvasComponent,
  createCanvasInstance,
  getCanvasComponentDragId,
  isCanvasComponent,
  isCanvasComponentSet,
  isCanvasInstance,
  setCanvasComponentProperty,
  syncCanvasComponents,
  type CanvasComponentResult,
} from "@pixerate/editor-react/canvas";
import { useAgentToolProvider, useHistory, useRegisterCommands } from "@pixerate/editor-react";
import { createComponentCommands } from "@pixerate/editor/commands";
import { createCanvasComponentToolProvider } from "@pixerate/editor/agent";
import { demoCommandRegistry, demoToolRegistry } from "../agentTools";
import { Component, Redo2, Undo2, Unlink, RotateCcw, Crosshair, Paintbrush, Plus } from "lucide-react";

type DemoNode = Node<Record<string, any>, "frame" | "label">;

const FrameView: React.FC<NodeProps<DemoNode>> = ({ data, selected }) => {
  const kind = isCanvasComponentSet({ data } as any) ? "set" : isCanvasComponent({ data } as any) ? "main" : isCanvasInstance({ data } as any) ? "instance" : "";
  return (
    <div className={`relative h-full w-full ${selected ? "outline outline-2 outline-sky-400" : ""}`} style={{ borderRadius: "inherit" }}>
      {kind ? (
        <span
          className={`absolute -top-4 left-0 whitespace-nowrap text-[9px] ${kind === "instance" ? "text-sky-300" : "text-violet-300"}`}
          data-component-kind={kind}
        >
          {kind === "instance" ? "◇ " : "◆ "}
          {kind === "set" ? data.label : kind === "main" ? data.label : "Instance"}
        </span>
      ) : null}
    </div>
  );
};
const LabelView: React.FC<NodeProps<DemoNode>> = ({ data }) => <div className="h-full w-full whitespace-nowrap font-medium">{data.label}</div>;
const NODE_TYPES = { frame: FrameView, label: LabelView };

const STYLES = {
  Primary: { bg: "#2563eb", text: "#ffffff" },
  Secondary: { bg: "#e2e8f0", text: "#0f172a" },
} as const;
const SIZES = {
  Small: { w: 96, h: 32, font: 12, pad: [12, 8] },
  Large: { w: 132, h: 44, font: 15, pad: [18, 12] },
} as const;

function ok(result: CanvasComponentResult<DemoNode>): DemoNode[] {
  if (!result.ok) throw new Error(result.reason);
  return result.nodes;
}

/** A Button component set (Style × Size) with a Label text property, and three instances. */
function initialNodes(): DemoNode[] {
  let nodes: DemoNode[] = [];
  const variants: string[] = [];
  (["Primary", "Secondary"] as const).forEach((style, row) => {
    (["Small", "Large"] as const).forEach((size, col) => {
      const id = `button-${style}-${size}`.toLowerCase();
      const s = SIZES[size];
      nodes.push(
        {
          id,
          type: "frame",
          position: { x: col * 170, y: row * 70 },
          width: s.w,
          height: s.h,
          style: { backgroundColor: STYLES[style].bg, borderRadius: 8 },
          data: { label: `Style=${style}, Size=${size}` },
        },
        {
          id: `${id}-label`,
          type: "label",
          parentId: id,
          position: { x: s.pad[0], y: s.pad[1] },
          style: { color: STYLES[style].text, fontSize: s.font },
          data: { label: "Button", name: "Label" },
        },
      );
      variants.push(id);
    });
  });
  for (const id of variants) nodes = ok(createCanvasComponent(nodes, [id]));
  nodes = ok(combineCanvasComponentsAsVariants(nodes, variants, { id: "button", name: "Button" }));
  nodes = ok(setCanvasComponentProperty(nodes, "button", "Label", { type: "text", default: "Button" }));
  for (const id of variants) nodes = ok(bindCanvasComponentProperty(nodes, `${id}-label`, "data.label", "Label"));
  const place = (id: string, x: number, props: Record<string, string>) => {
    nodes = ok(createCanvasInstance(nodes, "button", { id, position: { x, y: 220 }, properties: props }));
  };
  place("buy", 0, { Style: "Primary", Size: "Large", Label: "Buy now" });
  place("cancel", 170, { Style: "Secondary", Size: "Large", Label: "Cancel" });
  place("more", 340, { Style: "Primary", Size: "Small" });
  // A text override on an instance layer (not a property value): it survives main edits.
  // `syncCanvasComponents` records it as an override, as the hook does for edits on the canvas.
  nodes = syncCanvasComponents(nodes, nodes.map((n) => (n.parentId === "more" && n.type === "label" ? { ...n, data: { ...n.data, label: "Learn more" } } : n)));
  return nodes;
}

const ComponentsCanvas: React.FC = () => {
  const [nodes, setNodes] = useState<DemoNode[]>(initialNodes);
  const history = useHistory({ maxDepth: 100 });
  const flow = useReactFlow<DemoNode>();
  const [error, setError] = useState<string | null>(null);
  const components = useCanvasComponents<DemoNode>({
    nodes,
    setNodes,
    history: history.manager,
    onReveal: (node) => flow.fitView({ nodes: [{ id: node.id }], padding: 1, duration: 300 }),
  });
  const selected = nodes.filter((n) => n.selected).map((n) => n.id);
  // "+ Variant" duplicates the selected Button variant, else the set's default one.
  const selectedVariant = nodes.find((n) => n.selected && n.parentId === "button" && isCanvasComponent(n))?.id;
  // Palette and agent access: the same actions as commands (with disabled reasons) and tools.
  const commands = useMemo(() => createComponentCommands(components, { scope: null }), [components]);
  useRegisterCommands(demoCommandRegistry, commands);
  useEffect(() => demoCommandRegistry.invalidate(), [nodes]);
  const provider = useMemo(() => createCanvasComponentToolProvider(components, { id: "canvas-components", namespace: "components" }), [components]);
  useAgentToolProvider(demoToolRegistry, provider);
  const onNodesChange = useCallback((changes: NodeChange<DemoNode>[]) => setNodes((current) => applyNodeChanges(changes, current)), []);
  const report = (result: { ok: boolean; reason?: string } | undefined) => setError(result && !result.ok ? result.reason ?? null : null);

  // Editing a main: recolour the primary variants; every instance follows (overrides stay).
  const recolour = () => {
    const next = nodes.map((n) =>
      n.id.startsWith("button-primary") && !n.parentId?.startsWith("button-primary")
        ? { ...n, style: { ...n.style, backgroundColor: n.style?.backgroundColor === "#2563eb" ? "#7c3aed" : "#2563eb" } }
        : n,
    );
    const before = nodes;
    history.manager.execute({
      name: "Recolour main",
      execute: () => setNodes(next),
      undo: () => setNodes(before),
    });
  };

  const onDrop = (event: React.DragEvent) => {
    const id = getCanvasComponentDragId(event.dataTransfer);
    if (!id) return;
    event.preventDefault();
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    report(components.createInstance(id, { position }));
  };

  const can = useMemo(
    () => ({
      create: components.canCreateComponent(),
      detach: components.canDetachInstance(),
      reset: components.canResetOverrides(),
      main: components.canGoToMainComponent(),
      variant: components.canAddVariant("button"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes],
  );
  const btn = "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40";
  const tip = (v: true | string, label: string) => (v === true ? label : `${label} — ${v}`);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Components">
        <Component className="w-4 h-4 text-violet-400" />
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-1">Components</span>
        <button type="button" className={btn} disabled={can.create !== true} title={tip(can.create, "Create component (Mod+Alt+K)")} onClick={() => report(components.createComponent())}>
          <Component className="w-3.5 h-3.5" /> Create component
        </button>
        <button type="button" className={btn} disabled={can.detach !== true} title={tip(can.detach, "Detach instance")} onClick={() => report(components.detachInstance())}>
          <Unlink className="w-3.5 h-3.5" /> Detach
        </button>
        <button type="button" className={btn} disabled={can.reset !== true} title={tip(can.reset, "Reset all changes")} onClick={() => report(components.resetOverrides())}>
          <RotateCcw className="w-3.5 h-3.5" /> Reset
        </button>
        <button type="button" className={btn} disabled={can.main !== true} title={tip(can.main, "Go to main component")} onClick={() => components.goToMainComponent()}>
          <Crosshair className="w-3.5 h-3.5" /> Go to main
        </button>
        <button
          type="button"
          className={btn}
          disabled={can.variant !== true}
          title={tip(can.variant, "Add a variant to the Button set (duplicates the selected or default variant)")}
          onClick={() => report(components.addVariant("button", selectedVariant ? { from: selectedVariant } : {}))}
          data-testid="add-button-variant"
        >
          <Plus className="w-3.5 h-3.5" /> Variant
        </button>
        <button type="button" className={btn} onClick={recolour} title="Edit the Primary mains: every instance follows">
          <Paintbrush className="w-3.5 h-3.5" /> Recolour Primary main
        </button>
        <button type="button" className={btn} disabled={!history.canUndo} onClick={() => history.undo()} aria-label="Undo">
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <button type="button" className={btn} disabled={!history.canRedo} onClick={() => history.redo()} aria-label="Redo">
          <Redo2 className="w-3.5 h-3.5" />
        </button>
        {error ? <span className="text-xs text-amber-300" role="status">{error}</span> : null}
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
        <div
          className="h-[360px] rounded-xl overflow-hidden border border-slate-800 bg-slate-950"
          data-testid="components-pane"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        >
          <ReactFlow nodes={nodes} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} colorMode="dark" fitView fitViewOptions={{ padding: 0.2 }} proOptions={{ hideAttribution: true }}>
            <Background />
          </ReactFlow>
        </div>
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-3 text-slate-200">
          <div>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Assets</h4>
            <CanvasComponentsPanel nodes={nodes} onInsert={(id) => report(components.createInstance(id))} components={components} onError={setError} />
          </div>
          <div>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Instance</h4>
            <CanvasInstanceInspector nodes={nodes} nodeId={selected[0]} components={components} onError={setError} />
            {selected.length === 0 ? <p className="text-xs text-slate-500">Select an instance (or a layer in one).</p> : null}
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        A Button component set (Style × Size) with a Label text property. Pick variants and labels in the inspector, see the
        overrides there (each resets on its own), recolour the Primary mains to see instances follow, or drag a component from Assets
        onto the canvas. "+ Variant" duplicates a variant into the set (instances' pickers show the new value); rename
        properties and values with ⚙, and edit or remove a variant from its ⋯ menu (instances switch to the closest variant).
      </p>
    </div>
  );
};

export const ComponentsDemo: React.FC = () => (
  <ReactFlowProvider>
    <ComponentsCanvas />
  </ReactFlowProvider>
);
