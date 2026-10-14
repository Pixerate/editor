import React, { useCallback, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, applyNodeChanges, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { AnimationTimeline, ShapeNode, useCanvasAnimation, withNodeAnimation, type CanvasAnimation } from "@pixerate/editor-react/canvas";
import { useHistory, useHistoryShortcuts, useRegisterCommands } from "@pixerate/editor-react";
import { createCanvasAnimationCommands, type AnimationCommandTarget } from "@pixerate/editor/commands";
import { Clapperboard } from "lucide-react";
import { demoCommandRegistry } from "../agentTools";

type DemoNode = Node<Record<string, any>, "card" | "shape">;

const CardView: React.FC<NodeProps<DemoNode>> = ({ data, selected }) => (
  <div
    className={`flex h-full w-full flex-col justify-center rounded-xl px-4 text-white shadow-lg ${selected ? "outline outline-2 outline-sky-400" : ""}`}
    style={{ borderRadius: "inherit" }}
  >
    <div className="text-sm font-semibold">{data.label}</div>
    <div className="text-xs opacity-80">Slides in and fades up</div>
  </div>
);
const ShapeView: React.FC<NodeProps<DemoNode>> = (props) => <ShapeNode {...(props as any)} />;
const NODE_TYPES = { card: CardView, shape: ShapeView };

function initialNodes(): DemoNode[] {
  const card = withNodeAnimation<DemoNode>(
    {
      id: "card",
      type: "card",
      position: { x: 0, y: 40 },
      width: 220,
      height: 80,
      selected: true,
      style: { backgroundColor: "#2563eb", borderRadius: 12 },
      data: { label: "Welcome card" },
    },
    {
      tracks: {
        x: { keyframes: [{ time: 0, value: -260, easing: "ease-out" }, { time: 700, value: 0 }] },
        opacity: { keyframes: [{ time: 0, value: 0, easing: "ease-out" }, { time: 500, value: 1 }] },
        fill: { keyframes: [{ time: 1000, value: "#2563eb", easing: "ease-in-out" }, { time: 1800, value: "#db2777" }] },
      },
    },
  );
  const badge = withNodeAnimation<DemoNode>(
    {
      id: "badge",
      type: "shape",
      position: { x: 260, y: 55 },
      width: 50,
      height: 50,
      data: { label: "Badge", shape: { kind: "star", points: 5, innerRadius: 0.5, fill: "#facc15" } },
    },
    {
      tracks: {
        scale: { keyframes: [{ time: 600, value: 0, easing: "spring" }, { time: 1400, value: 1 }] },
        rotation: { keyframes: [{ time: 600, value: -90, easing: "ease-out-back" }, { time: 1400, value: 0 }] },
        fill: { keyframes: [{ time: 1400, value: "#facc15" }, { time: 2000, value: "#22c55e" }] },
      },
    },
  );
  return [card, badge];
}

/** A stable command target delegating to the latest hook result. */
function useAnimationCommandTarget(animation: CanvasAnimation<DemoNode>): AnimationCommandTarget {
  const ref = useRef(animation);
  ref.current = animation;
  return useMemo<AnimationCommandTarget>(
    () => ({
      getState: () => ref.current.getState(),
      play: () => ref.current.play(),
      pause: () => ref.current.pause(),
      toggle: () => ref.current.toggle(),
      stop: () => ref.current.stop(),
      seek: (t) => ref.current.seek(t),
      toggleRecording: () => ref.current.toggleRecording(),
      addKeyframe: (ids, keys, time) => ref.current.addKeyframe(ids, keys, time),
      deleteKeyframes: () => ref.current.deleteKeyframes(),
      setEasing: (easing, refs) => ref.current.setEasing(easing, refs),
      nextKeyframe: () => ref.current.nextKeyframe(),
      previousKeyframe: () => ref.current.previousKeyframe(),
      animateNode: (id, options) => ref.current.animateNode(id, options),
      exportCss: (id, options) => ref.current.exportCss(id, options),
    }),
    [],
  );
}

const AnimationCanvas: React.FC = () => {
  const [nodes, setNodes] = useState<DemoNode[]>(initialNodes);
  const history = useHistory({ maxDepth: 100 });
  useHistoryShortcuts(history.manager);
  const animation = useCanvasAnimation<DemoNode>({ nodes, setNodes, history: history.manager, loop: "loop", duration: 2400 });
  const target = useAnimationCommandTarget(animation);
  const commands = useMemo(() => createCanvasAnimationCommands(target, { scope: null }), [target]);
  useRegisterCommands(demoCommandRegistry, commands);
  const [css, setCss] = useState<string | null>(null);

  const onNodesChange = useCallback(
    (changes: NodeChange<DemoNode>[]) => animation.applyDisplayChanges(applyNodeChanges(changes, animation.displayNodes)),
    [animation],
  );

  const btn = "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200";
  const selectedId = nodes.find((n) => n.selected)?.id ?? "card";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Animation demo">
        <Clapperboard className="w-4 h-4 text-sky-400" />
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-1">Keyframe animation</span>
        <button type="button" className={btn} onClick={() => setCss(animation.exportCss(selectedId, { loop: "none" }).css)}>
          Export CSS ({selectedId})
        </button>
        <button type="button" className={btn} onClick={() => setNodes(initialNodes())}>
          Reset
        </button>
      </div>
      <div className="h-[220px] rounded-xl overflow-hidden border border-slate-800 bg-slate-950" data-testid="animation-pane">
        <ReactFlow
          nodes={animation.displayNodes}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.3 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
        </ReactFlow>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 p-3 text-slate-200">
        <AnimationTimeline animation={animation} width={480} />
      </div>
      {css ? (
        <pre className="max-h-48 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-300" data-testid="animation-css">
          {css}
        </pre>
      ) : null}
      <p className="text-xs text-slate-500">
        The card slides in and fades up, then shifts colour (mixed in OKLab); the star springs in. Play, scrub the ruler, drag
        diamonds (they snap to other keys, the playhead and frames; Alt turns snapping off, Escape cancels), pick an easing,
        or turn on Rec and drag a node to key its position at the playhead. Mod+Z undoes keyframe edits. The palette and
        agent tools include “Animate Node…”.
      </p>
    </div>
  );
};

export const AnimationDemo: React.FC = () => (
  <ReactFlowProvider>
    <AnimationCanvas />
  </ReactFlowProvider>
);
