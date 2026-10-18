import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  applyNodeChanges,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { DiagramPresenceLayer, MermaidDiagramGroup, MermaidDiagramNode, MermaidFamilyScene, MermaidThumbnail, useDiagramDirector, useMermaidDiagram, useMermaidStream, type UseMermaidDiagramResult } from "@pixerate/editor-react/canvas";
import { useAgentToolProvider } from "@pixerate/editor-react";
import {
  DIAGRAM_SCENE_DARK_THEME,
  DIAGRAM_SVG_DARK_THEME,
  diagramFileName,
  diagramTargetLabel,
  downloadDiagramPng,
  mermaidEdgeDash,
  mermaidEdgeMarker,
  mermaidToSvg,
  rasterizeSvg,
  type MermaidFlowEdge,
  type MermaidFlowNode,
} from "@pixerate/editor/canvas";
import { DiagramController, FAMILY_TEMPLATES, FAMILY_TITLES, createDiagramToolProvider, familyUI, findMermaidSources, type DiagramFamily, type FieldSpec } from "@pixerate/editor/diagram";
import { Bot, Download, GitBranch, Play, Redo2, Undo2 } from "lucide-react";
import { demoToolRegistry } from "../agentTools";

const SAMPLES: Record<string, string> = {
  Flowchart: `---
title: Order flow
---
flowchart LR
  %% Comments and formatting survive every edit.
  A[Order placed] --> B{In stock?}
  B -- yes --> C(Pick & pack)
  B -. no .-> D[[Back-order]]
  subgraph W [Warehouse]
    C --> E[(Inventory)]
  end
  D --> F>Notify customer]
  classDef warn fill:#7c2d12,stroke:#fb923c,color:#ffedd5
  class D warn
`,
  State: `stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  Running --> Paused : pause
  Paused --> Running : resume
  Running --> [*] : finish
`,
  Class: `classDiagram
  class Animal {
    +String name
    +move() void
  }
  class Dog {
    +bark() void
  }
  Animal <|-- Dog
  Animal <|-- Cat
`,
  ER: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  CUSTOMER {
    string name
    string email
  }
`,
};

// Every other family Mermaid can edit statement by statement, drawn as its own picture.
for (const family of ["sequence", "gantt", "pie", "quadrant", "xychart", "radar", "timeline", "journey", "mindmap", "gitGraph", "c4", "architecture"] as DiagramFamily[]) {
  SAMPLES[FAMILY_TITLES[family]] = FAMILY_TEMPLATES[family]!;
}

/** Reads a field's input text as the value its type takes (undefined clears it). */
function fieldValue(field: FieldSpec, text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  if (field.type === "number") return Number.isFinite(Number(t)) ? Number(t) : undefined;
  if (field.type === "numbers") return t.split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  if (field.type === "tags" || field.type === "lines") return t.split(field.type === "tags" ? "," : "\n").map((x) => x.trim()).filter(Boolean);
  return t;
}
const fieldText = (value: unknown) => (Array.isArray(value) ? value.join(", ") : value === undefined || value === null ? "" : String(value));

/** Data fields of the selected node and the diagram settings, written with setNodeData / setGraphData. */
const FieldInspector: React.FC<{ diagram: UseMermaidDiagramResult }> = ({ diagram }) => {
  const ui = familyUI(diagram.state.family);
  const node = diagram.document.graph.nodes.find((n) => diagram.state.selection.includes(n.id));
  const nodeFields = (ui?.nodeFields ?? []).filter((f) => !f.shapes || (node && f.shapes.includes(node.shape)));
  const diagramFields = ui?.diagramFields ?? [];
  if (!diagram.state.editable || (!nodeFields.length && !diagramFields.length)) return null;
  const input = (field: FieldSpec, value: unknown, write: (v: unknown) => void) =>
    field.type === "boolean" ? (
      <input type="checkbox" checked={!!value} onChange={(e) => write(e.target.checked)} />
    ) : field.type === "select" ? (
      <select className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5" value={fieldText(value)} onChange={(e) => write(e.target.value || undefined)}>
        <option value="">—</option>
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ) : (
      <input
        key={`${node?.id}:${fieldText(value)}`}
        className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 w-40"
        defaultValue={fieldText(value)}
        placeholder={field.placeholder ?? field.hint}
        onBlur={(e) => e.target.value !== fieldText(value) && write(fieldValue(field, e.target.value))}
      />
    );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-slate-300" aria-label="Diagram data fields">
      {node &&
        nodeFields.map((f) => (
          <label key={`n:${f.key}`} className="flex items-center gap-1.5">
            <span className="text-slate-500">{f.label}</span>
            {input(f, node.data?.[f.key], (v) => diagram.apply({ type: "setNodeData", id: node.id, data: { [f.key]: v } }, "Edit data"))}
          </label>
        ))}
      {diagramFields.map((f) => (
        <label key={`d:${f.key}`} className="flex items-center gap-1.5">
          <span className="text-slate-500">{f.label}</span>
          {input(f, diagram.document.graph.data?.[f.key], (v) => diagram.apply({ type: "setGraphData", data: { [f.key]: v } }, "Edit settings"))}
        </label>
      ))}
    </div>
  );
};

const STREAM_SAMPLE = "Here is the plan:\n\n```mermaid\nflowchart TD\n  brief[Brief] --> research[Research]\n  research --> draft[Draft]\n  draft --> review{Review}\n  review -- changes --> draft\n  review -- approved --> publish[(Publish)]\n  publish --> share([Share])\n```\n";

/** Handle sides follow the diagram's direction. */
const DirectionContext = createContext<string>("TB");
const sides = (direction: string) =>
  direction === "LR"
    ? { target: Position.Left, source: Position.Right }
    : direction === "RL"
      ? { target: Position.Right, source: Position.Left }
      : direction === "BT"
        ? { target: Position.Bottom, source: Position.Top }
        : { target: Position.Top, source: Position.Bottom };

const handleStyle = { opacity: 0, width: 8, height: 8 };

const DiagramNodeView: React.FC<NodeProps> = (props) => {
  const { target, source } = sides(useContext(DirectionContext));
  return (
    <MermaidDiagramNode data={props.data as never} width={props.width} height={props.height} selected={props.selected}>
      <Handle type="target" position={target} style={handleStyle} />
      <Handle type="source" position={source} style={handleStyle} />
    </MermaidDiagramNode>
  );
};

const DiagramGroupView: React.FC<NodeProps> = (props) => <MermaidDiagramGroup data={props.data as never} selected={props.selected} />;

const NODE_TYPES = { "mermaid-node": DiagramNodeView, "mermaid-group": DiagramGroupView };

/** Mermaid edges as React Flow edges: label, arrow heads and line pattern. */
function toReactFlowEdges(edges: MermaidFlowEdge[]): Edge[] {
  return edges.map((e) => {
    const edge = e.data.edge;
    const end = mermaidEdgeMarker(edge.arrowEnd);
    const start = mermaidEdgeMarker(edge.arrowStart);
    const width = edge.pattern === "thick" ? 3 : 1.5;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: "smoothstep",
      selectable: e.selectable,
      style: { stroke: "#94a3b8", strokeWidth: width, strokeDasharray: mermaidEdgeDash(edge.pattern), opacity: edge.pattern === "invisible" ? 0 : 1 },
      labelStyle: { fill: "#e2e8f0", fontSize: 11 },
      labelBgStyle: { fill: "#0f172a" },
      markerEnd: end ? { type: end === "arrow" ? MarkerType.Arrow : MarkerType.ArrowClosed, color: "#94a3b8" } : undefined,
      markerStart: start ? { type: start === "arrow" ? MarkerType.Arrow : MarkerType.ArrowClosed, color: "#94a3b8" } : undefined,
    };
  });
}

const btn = "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40";

const MermaidEditorPane: React.FC = () => {
  const controller = useMemo(() => new DiagramController({ source: SAMPLES.Flowchart }), []);
  const diagram = useMermaidDiagram(controller, { sceneTheme: DIAGRAM_SCENE_DARK_THEME });
  const positions = useRef(diagram.layout.positions);
  const layoutRef = useRef(diagram.layout);
  layoutRef.current = diagram.layout;
  positions.current = diagram.layout.positions;
  // Agent edits (from the tools panel, an MCP client or the button below) are acted out by a cursor.
  const { presence, director } = useDiagramDirector(controller, { placement: () => ({ positions: positions.current, sizes: diagram.layout.sizes }) });
  const provider = useMemo(
    () =>
      createDiagramToolProvider(controller, {
        id: "diagram",
        namespace: "diagram",
        getPositions: () => positions.current,
        // render_diagram: SVG from the canvas layout, PNG through the browser.
        renderSvg: (o) => mermaidToSvg(controller.getDocument(), { ...o, layout: layoutRef.current }),
        rasterize: (svg, size) => rasterizeSvg(svg, size),
        director,
        actor: { id: "agent", name: "Agent" },
      }),
    [controller, director],
  );
  const viewport = useViewport();
  const [acting, setActing] = useState(false);
  const agentEdit = async () => {
    const graph = controller.getDocument().graph;
    const from = graph.nodes.find((n) => !n.data?.synthetic)?.id;
    if (!from) return;
    setActing(true);
    try {
      const added: any = await demoToolRegistry.callTool("diagram__add_diagram_node", { label: "Follow up", from, edgeLabel: "then" });
      const id = added.structuredContent?.node?.id;
      if (id) await demoToolRegistry.callTool("diagram__rename_diagram_node", { id, label: "Follow up with customer" });
    } finally {
      setActing(false);
    }
  };
  useAgentToolProvider(demoToolRegistry, provider);

  // React Flow moves nodes while dragging; the diagram only hears about the drop.
  const [nodes, setNodes] = useState<Node[]>(diagram.nodes as Node[]);
  useEffect(() => setNodes(diagram.nodes as Node[]), [diagram.nodes]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edges = useMemo(() => toReactFlowEdges(diagram.edges), [diagram.edges]);

  // Fit once the panel has its final size, and again when another diagram is opened.
  const flow = useReactFlow();
  const refit = useCallback(() => requestAnimationFrame(() => requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 200 }))), [flow]);
  useEffect(() => void refit(), [refit]);

  const [draft, setDraft] = useState(diagram.source);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(diagram.source);
  }, [diagram.source, focused]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), current));
    const selected = changes.filter((c) => c.type === "select");
    if (selected.length) {
      queueMicrotask(() => diagram.select(nodesRef.current.filter((n) => n.selected).map((n) => n.id)));
    }
  }, [diagram]);

  const sample = Object.entries(SAMPLES).find(([, s]) => s === diagram.source)?.[0] ?? "";
  const pasteFromMarkdown = (text: string) => {
    const found = findMermaidSources(text);
    return found.length ? found[0]!.source : text;
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Mermaid diagram">
          <GitBranch className="w-4 h-4 text-sky-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-1">Mermaid diagram</span>
          <select
            className="text-xs rounded-lg border border-slate-700 bg-slate-800 text-slate-200 px-2 py-1"
            value={sample}
            onChange={(e) => {
              if (!SAMPLES[e.target.value]) return;
              diagram.load(SAMPLES[e.target.value]!, { clearHistory: true });
              refit();
            }}
            aria-label="Sample diagram"
          >
            <option value="" disabled>
              Sample…
            </option>
            {Object.keys(SAMPLES).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={btn}
            disabled={!diagram.state.editable}
            onClick={() => {
              const ui = familyUI(diagram.state.family);
              const graph = diagram.document.graph;
              const from = diagram.state.selection.find((s) => graph.nodes.some((n) => n.id === s));
              if (diagram.scene && ui) {
                // Families drawn from their data: the family picks the id and the defaults.
                const parentId = graph.nodes.find((n) => n.id === from)?.parentId;
                const id = ui.nextId(graph);
                diagram.apply({ type: "addNode", node: { label: `New ${ui.nodeNoun.toLowerCase()}`, ...ui.newNode?.(graph, parentId), id } }, "Add node");
                diagram.select([id]);
                return;
              }
              const id = controller.nextId();
              diagram.apply(
                [{ type: "addNode", node: { id, label: "New step" } }, ...(from ? [{ type: "addEdge" as const, edge: { source: from, target: id } }] : [])],
                "Add node",
              );
            }}
          >
            + {familyUI(diagram.state.family)?.nodeNoun ?? "Node"}
          </button>
          <button type="button" className={btn} disabled={!diagram.state.editable || acting} onClick={agentEdit} title="Calls the diagram__* agent tools; a cursor acts them out">
            <Bot className="w-3.5 h-3.5" /> Agent edit
          </button>
          <button type="button" className={btn} disabled={!diagram.state.canUndo} onClick={diagram.undo} aria-label="Undo diagram edit">
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button type="button" className={btn} disabled={!diagram.state.canRedo} onClick={diagram.redo} aria-label="Redo diagram edit">
            <Redo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className={btn}
            disabled={!diagram.state.editable}
            onClick={() => void downloadDiagramPng(diagram.document, { layout: diagram.layout, theme: DIAGRAM_SVG_DARK_THEME })}
            title="Download the diagram as PNG"
          >
            <Download className="w-3.5 h-3.5" /> PNG
          </button>
          <button
            type="button"
            className={btn}
            disabled={!diagram.state.editable}
            onClick={() => {
              const { svg } = mermaidToSvg(diagram.document, { layout: diagram.layout });
              const link = document.createElement("a");
              link.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
              link.download = diagramFileName(diagram.document, "svg");
              link.click();
              URL.revokeObjectURL(link.href);
            }}
            title="Download the diagram as SVG"
          >
            <Download className="w-3.5 h-3.5" /> SVG
          </button>
          <span className="text-[11px] text-slate-500">
            {diagram.state.family} · {diagram.document.graph.nodes.length} nodes · {diagram.document.graph.edges.length} edges
          </span>
        </div>
        {diagram.scene ? (
          <div className="h-[420px] rounded-xl overflow-auto border border-slate-800 bg-slate-950 p-2 flex items-center justify-center" data-testid="mermaid-pane">
            <MermaidFamilyScene
              scene={diagram.scene}
              style={{ maxHeight: "100%" }}
              selectionColor="#38bdf8"
              markerColor="#94a3b8"
              onSelect={(target) => diagram.select(target && target !== "::title" ? [target] : [])}
              onOpen={(target) => {
                const label = window.prompt(target === "::title" ? "Title" : "Label", diagramTargetLabel(diagram.document, target) ?? "");
                if (label !== null) diagram.renameTarget(target, label);
              }}
            />
          </div>
        ) : (
        <DirectionContext.Provider value={diagram.document.graph.direction.toUpperCase().replace("TD", "TB")}>
          <div className="h-[420px] rounded-xl overflow-hidden border border-slate-800 bg-slate-950 relative" data-testid="mermaid-pane">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onNodeDragStop={(_e, _node, dragged) => diagram.moveNodes(dragged, nodesRef.current)}
              onConnect={(c: Connection) => c.source && c.target && diagram.connect(c.source, c.target)}
              onDelete={({ nodes: n, edges: e }) => diagram.remove([...e.map((x) => x.id), ...n.map((x) => x.id)])}
              onNodeDoubleClick={(_e, node) => {
                const current = (node.data as MermaidFlowNode["data"] & { node?: { label: string }; group?: { label: string } });
                const label = window.prompt("Label", current.node?.label ?? current.group?.label ?? "");
                if (label !== null) diagram.rename(node.id, label);
              }}
              onEdgeDoubleClick={(_e, edge) => {
                const label = window.prompt("Edge label", String(edge.label ?? ""));
                if (label !== null) diagram.apply({ type: "setEdgeLabel", id: edge.id, label }, "Label edge");
              }}
              colorMode="dark"
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.1}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
            <DiagramPresenceLayer presence={presence} viewport={viewport} />
          </div>
        </DirectionContext.Provider>
        )}
        <FieldInspector diagram={diagram} />
        {diagram.state.issue && <p className="text-xs text-amber-400">{diagram.state.issue}</p>}
        <div className="flex flex-wrap gap-2" aria-label="Sample thumbnails">
          {Object.entries(SAMPLES).map(([name, sampleSource]) => (
            <button
              key={name}
              type="button"
              title={`Open the ${name} sample`}
              onClick={() => {
                diagram.load(sampleSource, { clearHistory: true });
                refit();
              }}
              className={`rounded-lg border p-1.5 bg-slate-950 hover:border-sky-500 ${name === sample ? "border-sky-500" : "border-slate-800"}`}
            >
              <MermaidThumbnail source={sampleSource} maxWidth={140} maxHeight={80} theme={DIAGRAM_SVG_DARK_THEME} />
              <div className="text-[10px] text-slate-400 mt-1">{name}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-wider text-slate-400" htmlFor="mermaid-source">
          Mermaid source
        </label>
        <textarea
          id="mermaid-source"
          className="w-full h-[420px] rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-200"
          spellCheck={false}
          value={draft}
          onFocus={() => setFocused(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setFocused(false);
            const next = pasteFromMarkdown(draft);
            if (next !== diagram.source) {
              diagram.load(next);
              refit();
            }
          }}
        />
      </div>
    </div>
  );
};

const MermaidStreamPane: React.FC = () => {
  const [text, setText] = useState("");
  const [complete, setComplete] = useState(true);
  const stream = useMermaidStream(text, { complete, duration: 350 });
  const edges = useMemo(() => toReactFlowEdges(stream.edges), [stream.edges]);
  // Every glide frame makes new node objects; passing back what React Flow measured keeps
  // its handle bounds, so edges do not drop out (see GOTCHAS.md).
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const sized = changes.filter((c): c is Extract<NodeChange, { type: "dimensions" }> => c.type === "dimensions" && !!c.dimensions);
    if (sized.length) setMeasured((m) => ({ ...m, ...Object.fromEntries(sized.map((c) => [c.id, c.dimensions!])) }));
  }, []);
  const nodes = useMemo(() => stream.nodes.map((n) => (measured[n.id] ? { ...n, measured: measured[n.id] } : n)) as Node[], [stream.nodes, measured]);
  const flow = useReactFlow();
  const count = stream.nodes.length;
  useEffect(() => {
    if (!stream.settled || !count) return;
    const frame = requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 250 }));
    return () => cancelAnimationFrame(frame);
  }, [stream.settled, count, flow]);
  const play = () => {
    setComplete(false);
    setMeasured({});
    let i = 0;
    const timer = window.setInterval(() => {
      i = Math.min(STREAM_SAMPLE.length, i + 4);
      setText(STREAM_SAMPLE.slice(0, i));
      if (i >= STREAM_SAMPLE.length) {
        window.clearInterval(timer);
        setComplete(true);
      }
    }, 40);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-1">Streaming view</span>
        <button type="button" className={btn} onClick={play} disabled={!complete}>
          <Play className="w-3.5 h-3.5" /> Stream a model reply
        </button>
        <span className="text-[11px] text-slate-500">{complete ? (text ? "complete" : "idle") : "receiving…"}</span>
      </div>
      <DirectionContext.Provider value={stream.document?.graph.direction.toUpperCase().replace("TD", "TB") ?? "TB"}>
        <div className="h-[300px] rounded-xl overflow-hidden border border-slate-800 bg-slate-950 relative" data-testid="mermaid-stream-pane">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            nodeTypes={NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            minZoom={0.1}
            colorMode="dark"
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
          </ReactFlow>
        </div>
      </DirectionContext.Provider>
    </div>
  );
};

export const MermaidDiagramDemo: React.FC = () => (
  <div className="space-y-4">
    <ReactFlowProvider>
      <MermaidEditorPane />
    </ReactFlowProvider>
    <ReactFlowProvider>
      <MermaidStreamPane />
    </ReactFlowProvider>
    <p className="text-xs text-slate-500">
      Pick a sample or paste Mermaid (a ```mermaid block from Markdown or chat works too). Flowchart, state, class and
      ER diagrams are boxes and connectors: drag nodes, connect handles, double-click to rename, Backspace to delete.
      Sequence, Gantt, pie, quadrant, XY, radar, timeline, journey, mindmap, gitGraph, C4 and architecture diagrams are
      drawn as Mermaid draws them: click to select, double-click to rename, and edit values in the fields below. Either way only the statements you touch are rewritten, and positions are kept
      in a <code>%% @pixerate</code> comment that Mermaid ignores. Agents get the same edits through the{" "}
      <code>diagram__*</code> tools, acted out by a cursor (try "Agent edit"); a diagram the agent loads that extends
      the current one is drawn statement by statement.
    </p>
  </div>
);
