import React, { useCallback, useMemo, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, applyNodeChanges, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import {
  ShapeNode,
  TokenBindingPicker,
  TokenModeSwitcher,
  useCanvasTokens,
  applyNodeUpdates,
  layoutAll,
  bindCanvasToken,
} from "@pixerate/editor-react/canvas";
import { TokensPanel, useTokenStore, useTokens } from "@pixerate/editor-react/tokens";
import { EditorDocumentAutosave, useDemoEditorDocument } from "./EditorDocumentAutosave";
import { createTokensEditorDocument, createTokensStyleToolProvider, type TokenStore } from "@pixerate/editor/tokens";
import { StyleFindings, useAgentToolProvider, useStyleFindings } from "@pixerate/editor-react";
import { demoToolRegistry } from "../agentTools";
import { demoStyles } from "../houseStyles";
import { Moon, Palette, Sun } from "lucide-react";

type DemoNode = Node<Record<string, any>, "card" | "label" | "shape">;

const CardView: React.FC<NodeProps<DemoNode>> = ({ selected }) => (
  <div className={`h-full w-full ${selected ? "outline outline-2 outline-sky-400" : ""}`} style={{ borderRadius: "inherit" }} />
);
const LabelView: React.FC<NodeProps<DemoNode>> = ({ data }) => <div className="h-full w-full whitespace-nowrap">{data.label}</div>;
const ShapeView: React.FC<NodeProps<DemoNode>> = (props) => <ShapeNode {...(props as any)} />;
const NODE_TYPES = { card: CardView, label: LabelView, shape: ShapeView };

/** A Brand palette, and a Theme collection (Light / Dark) that aliases it. */
function seed(store: TokenStore) {
  store.transact("seed", () => {
    const brand = store.createCollection("Brand", ["Default"]);
    const blue = store.createVariable({ collectionId: brand.id, name: "blue/500", type: "color", value: "#3b82f6" });
    const sky = store.createVariable({ collectionId: brand.id, name: "blue/300", type: "color", value: "#93c5fd" });
    const theme = store.createCollection("Theme", ["Light", "Dark"]);
    const c = (name: string, light: unknown, dark: unknown) =>
      store.createVariable({ collectionId: theme.id, name, type: "color", values: { Light: light, Dark: dark } });
    c("color/surface", "#ffffff", "#0f172a");
    c("color/text", "#0f172a", "#e2e8f0");
    c("color/border", "#cbd5e1", "#334155");
    c("color/accent", { alias: blue.id }, { alias: sky.id });
    store.createVariable({ collectionId: theme.id, name: "radius/card", type: "number", value: 12, unit: "px", scopes: ["CORNER_RADIUS"] });
    store.createVariable({ collectionId: theme.id, name: "space/card", type: "number", values: { Light: 16, Dark: 20 }, unit: "px", scopes: ["GAP"] });
    store.createVariable({ collectionId: theme.id, name: "font/title", type: "number", value: 16, unit: "px", scopes: ["FONT_SIZE"] });
  });
}

function initialNodes(store: TokenStore): DemoNode[] {
  const state = store.getState();
  const id = (name: string) => state.variables.find((v) => v.name === name)!.id;
  let nodes: DemoNode[] = [
    {
      id: "card",
      type: "card",
      selected: true,
      position: { x: 0, y: 0 },
      width: 220,
      height: 10,
      style: { backgroundColor: "#ffffff", borderStyle: "solid", borderWidth: 1 },
      data: { layout: { mode: "vertical", sizing: { width: "fixed", height: "hug" } } },
    },
    { id: "title", type: "label", parentId: "card", position: { x: 0, y: 0 }, width: 180, height: 22, style: {}, data: { label: "Design tokens" } },
    { id: "body", type: "label", parentId: "card", position: { x: 0, y: 0 }, width: 180, height: 18, style: { fontSize: 12 }, data: { label: "Bound to Theme variables" } },
    { id: "button", type: "shape", parentId: "card", position: { x: 0, y: 0 }, width: 96, height: 28, data: { shape: { kind: "rect", fill: "#000000" } } },
  ];
  const bind = (ids: string[], key: string, name: string) => (nodes = bindCanvasToken(nodes, ids, key, id(name), state));
  bind(["card"], "fill", "color/surface");
  bind(["card"], "stroke", "color/border");
  bind(["card"], "cornerRadius", "radius/card");
  bind(["card"], "padding", "space/card");
  bind(["card"], "gap", "space/card");
  bind(["title", "body"], "textColor", "color/text");
  bind(["title"], "fontSize", "font/title");
  bind(["button"], "fill", "color/accent");
  bind(["button"], "cornerRadius", "radius/card");
  return applyNodeUpdates(nodes, layoutAll(nodes));
}

const TokensCanvas: React.FC = () => {
  const store = useTokenStore();
  const [nodes, setNodes] = useState<DemoNode[]>(() => {
    if (store.getState().collections.length === 0) {
      seed(store);
      store.replaceState(store.getState(), { reason: "seed" }); // the seed is not an undo step
    }
    return initialNodes(store);
  });
  const selected = nodes.filter((n) => n.selected).map((n) => n.id);
  const tokens = useCanvasTokens({ store, nodes, setNodes });
  const theme = tokens.state.collections.find((c) => c.name === "Theme")!;
  const cardMode = tokens.modesOf("card")[theme.id] ?? theme.modes[0].id;
  const dark = theme.modes.find((m) => m.name === "Dark");
  const isDark = !!dark && cardMode === dark.id;

  // Auto layout reacts to bound gap / padding: relayout whenever node data changes.
  const laidOut = useMemo(() => applyNodeUpdates(nodes, layoutAll(nodes)), [nodes]);
  const onNodesChange = useCallback(
    (changes: NodeChange<DemoNode>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  // App theming from the same tokens: the panel takes the card's mode.
  const { cssVariables } = useTokens(store, { modes: { [theme.id]: cardMode } });
  const editorDocument = useDemoEditorDocument(store, createTokensEditorDocument, { namespace: "tokens", skill: "pixerate-tokens" });
  useAgentToolProvider(demoToolRegistry, useMemo(() => createTokensStyleToolProvider(store, demoStyles), [store]));
  const houseStyle = useStyleFindings(demoStyles, "tokens", tokens.state);

  const btn = "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200";
  return (
    <div className="space-y-2">
      <EditorDocumentAutosave doc={editorDocument} name="Design tokens" />
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Design tokens">
        <Palette className="w-4 h-4 text-sky-400" />
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-1">Design tokens</span>
        <button
          type="button"
          className={btn}
          aria-pressed={isDark}
          onClick={() => dark && tokens.setMode(["card"], theme.id, isDark ? theme.modes.find((m) => m.name === "Light")!.id : dark.id)}
        >
          {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />} {isDark ? "Light card" : "Dark card"}
        </button>
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <div className="h-[260px] rounded-xl overflow-hidden border border-slate-800 bg-slate-950" data-testid="tokens-pane">
          <ReactFlow nodes={laidOut} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} colorMode="dark" fitView fitViewOptions={{ padding: 0.4 }} proOptions={{ hideAttribution: true }}>
            <Background />
          </ReactFlow>
        </div>
        <div className="space-y-3 rounded-xl border border-slate-800 p-3" style={{ ...(cssVariables as React.CSSProperties), background: "var(--color-surface)", color: "var(--color-text)" }}>
          <div>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider opacity-70">Mode ({selected[0] ?? "nothing"} selected)</h4>
            <TokenModeSwitcher state={tokens.state} nodes={nodes} nodeIds={selected} onChange={setNodes} />
          </div>
          <div>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider opacity-70">Bindings</h4>
            <TokenBindingPicker
              state={tokens.state}
              nodes={nodes}
              selectedIds={selected}
              onChange={setNodes}
              properties={["fill", "stroke", "textColor", "fontSize", "cornerRadius", "gap", "padding", "opacity"]}
            />
          </div>
        </div>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-slate-200">
        <TokensPanel store={store} />
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-slate-200" data-testid="tokens-house-style">
        <StyleFindings report={houseStyle.report} title="House style (org: Acme)" />
      </div>
      <p className="text-xs text-slate-500">
        The card's fill, border, radius, padding, gap and text are bound to Theme variables; the button's fill aliases the
        Brand palette. Toggle the card's mode, edit values in the panel (modes are columns), or select a node to rebind it.
      </p>
    </div>
  );
};

export const TokensDemo: React.FC = () => (
  <ReactFlowProvider>
    <TokensCanvas />
  </ReactFlowProvider>
);
