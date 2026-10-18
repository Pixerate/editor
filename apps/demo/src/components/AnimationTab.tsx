import React, { useRef, useState } from "react";
import { Clapperboard } from "lucide-react";
import { createVectorEffect, ellipseSubpath, rectSubpath, starSubpath, type VectorDocument } from "@pixerate/editor/vector";
import type { MotionScene } from "@pixerate/editor/animation-editor";
import { AnimationEditor, useAnimationEditorController, useAnimationEditorState, useAnimationEditorTools } from "@pixerate/editor-react/animation-editor";
import { VectorEditor, useVectorEditorController } from "@pixerate/editor-react/vector";
import { demoToolRegistry } from "../agentTools";
import { AgentScriptPanel } from "./AgentScriptPanel";
import { ANIMATION_SCRIPTS } from "../agentScripts";

const ARTWORK: VectorDocument = {
  width: 640,
  height: 360,
  background: "#0f172a",
  nodes: [
    { id: "ring", type: "path", name: "Ring", fill: null, stroke: "#38bdf8", strokeWidth: 6, subpaths: [ellipseSubpath({ x: 220, y: 80, width: 200, height: 200 })], effects: [createVectorEffect("wiggle", "wobble", { size: 4, detail: 8, time: 0 })!] },
    { id: "badge", type: "path", name: "Badge", fill: "#f43f5e", stroke: null, subpaths: [ellipseSubpath({ x: 250, y: 110, width: 140, height: 140 })] },
    { id: "check", type: "path", name: "Check", fill: null, stroke: "#ffffff", strokeWidth: 12, strokeLinecap: "round", strokeLinejoin: "round", subpaths: [{ closed: false, anchors: [{ x: 285, y: 182 }, { x: 310, y: 208 }, { x: 356, y: 156 }] }] },
    { id: "arc", type: "path", name: "Spark path", visible: false, fill: null, stroke: "#94a3b8", subpaths: [{ closed: false, anchors: [{ x: 60, y: 300, out: { x: 160, y: 20 } }, { x: 580, y: 60, in: { x: 420, y: 0 } }] }] },
    { id: "spark", type: "path", name: "Spark", fill: "#fde047", stroke: null, subpaths: [starSubpath({ x: 48, y: 288, width: 24, height: 24 }, 4, 0.35)] },
    { id: "tile", type: "path", name: "Tile", fill: "#a78bfa", stroke: null, subpaths: [rectSubpath({ x: 500, y: 250, width: 70, height: 70 }, 10)] },
    { id: "star", type: "path", name: "Star shape", visible: false, fill: "#facc15", stroke: null, subpaths: [starSubpath({ x: 495, y: 245, width: 80, height: 80 }, 5, 0.45)] },
  ],
};

const SCENE: MotionScene = {
  version: 1,
  name: "Badge reveal",
  description: "A badge pops in, a check draws on, a spark flies and a tile becomes a star.",
  artwork: ARTWORK,
  loop: "loop",
  target: [4, 9],
  controls: [{ name: "accent", type: "color", default: "#f43f5e", label: "Badge colour" }],
  presets: [{ name: "Ocean", values: { accent: "#0ea5e9" } }],
  shots: [
    {
      id: "badge",
      label: "Badge pops in",
      run: [
        { type: "enter", targets: ["ring"], style: "draw", duration: 900 },
        { type: "enter", targets: ["badge"], style: "pop", with: "previous", delay: 300 },
        { type: "enter", targets: ["check"], style: "draw", duration: 500 },
      ],
    },
    {
      id: "spark",
      label: "A spark flies the arc",
      run: [
        { type: "enter", targets: ["spark"], duration: 200 },
        { type: "follow", targets: ["spark"], path: "arc", rotate: true, duration: 1200 },
        { type: "exit", targets: ["spark"], style: "shrink" },
      ],
      hold: 200,
    },
    {
      id: "star",
      label: "Tile becomes a star",
      run: [
        { type: "enter", targets: ["tile"], style: "grow" },
        { type: "morph", targets: ["tile"], into: "star" },
        { type: "effect", targets: ["ring"], effect: "wobble", param: "time", to: 2, duration: 900, with: "previous" },
      ],
    },
    {
      id: "focus",
      label: "Close on the badge",
      camera: { frame: "ring", padding: 40 },
      run: [{ type: "pulse", targets: ["badge"], count: 2, duration: 800 }],
      hold: 800,
    },
  ],
};

/** Vector animation: shots over vector artwork, agent tools, and export to Flair. */
export function AnimationTab() {
  const controller = useAnimationEditorController({ scene: SCENE });
  const state = useAnimationEditorState(controller);
  useAnimationEditorTools(demoToolRegistry, controller, { id: "animation", namespace: "animation" });
  const [accent, setAccent] = useState("#f43f5e");
  const [output, setOutput] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const vector = useVectorEditorController({ document: ARTWORK });
  const agentStage = useRef<HTMLDivElement>(null);
  const errors = state.issues.filter((i) => i.severity === "error").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Clapperboard className="h-5 w-5 text-rose-400" />
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Vector animation</h2>
          <p className="text-xs text-slate-400">
            Headless <code>AnimationEditorController</code> (<code>@pixerate/editor/animation-editor</code>). A scene is vector artwork plus shots of commands (enter, draw, move,
            morph, follow, pulse, live-effect tweens); timing comes from the content. Click a shot to jump to it. Agents use the <code>animation__*</code> tools; export to Flair
            as vector motion or a catalog effect with colour controls.
          </p>
        </div>
      </div>
      <div className="relative rounded-xl border border-slate-800 bg-slate-900/50 p-3" ref={agentStage}>
        <AnimationEditor controller={controller} values={{ accent }} />
      </div>
      <AgentScriptPanel scripts={ANIMATION_SCRIPTS} stage={agentStage} hint="Plays a scripted agent turn with the animation__* tools: a new shot, its commands, a check, then playback." />
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>
          {state.shots.length} shots · {(state.duration / 1000).toFixed(1)} s · {errors} errors · {state.issues.length - errors} warnings and notes
        </span>
        <label className="flex items-center gap-1">
          Badge colour <input type="color" value={accent} onChange={(e) => setAccent(e.currentTarget.value)} />
        </label>
        <button type="button" className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => controller.undo()} disabled={!state.canUndo}>
          Undo
        </button>
        <button type="button" className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => setOutput(JSON.stringify(controller.toFlairEffect({ category: "icon", tags: ["badge", "success"] }), null, 2))}>
          Export Flair effect
        </button>
        <button type="button" className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => setOutput(JSON.stringify(state.scene, null, 2))}>
          Scene JSON
        </button>
        <button type="button" className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => setEditing((e) => !e)}>
          {editing ? "Hide artwork editor" : "Edit artwork"}
        </button>
        {output && (
          <button type="button" className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => setOutput(null)}>
            Hide
          </button>
        )}
      </div>
      {editing && (
        <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
          <VectorEditor controller={vector} height={360} />
          <button
            type="button"
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
            onClick={() => {
              const result = controller.setArtwork(vector.getState().document);
              if (!result.ok) setOutput(result.error);
            }}
          >
            Use this artwork
          </button>
        </div>
      )}
      {output && <pre className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-[11px] text-slate-300">{output}</pre>}
    </div>
  );
}
