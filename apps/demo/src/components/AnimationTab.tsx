import React, { useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard } from "lucide-react";
import { createVectorEffect, ellipseSubpath, rectSubpath, starSubpath, type VectorDocument } from "@pixerate/editor/vector";
import { AnimationEditorController, fromFlairVectorEffect, toLottie, type FlairVectorEffect, type LottieAnimation, type MotionScene } from "@pixerate/editor/animation-editor";
import { AnimationEditor, useAnimationEditorController, useAnimationEditorState, useAnimationEditorTools } from "@pixerate/editor-react/animation-editor";
import { VectorEditor, useVectorEditorController } from "@pixerate/editor-react/vector";
import { demoToolRegistry } from "../agentTools";
import { AgentScriptPanel } from "./AgentScriptPanel";
import { ANIMATION_SCRIPTS } from "../agentScripts";
import bookmark from "../flair-samples/bookmark.json";
import checkbox from "../flair-samples/checkbox.json";
import powerButton from "../flair-samples/power-button.json";
import zapIcon from "../flair-samples/zap-icon.json";

/** Effects from Flair's catalog (`@pixerate/flair/catalog`), saved as JSON so the demo needs no Flair dependency. */
const FLAIR_SAMPLES = [checkbox, bookmark, powerButton, zapIcon] as unknown as FlairVectorEffect[];

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
      label: "Tile irises in, becomes a star",
      run: [
        { type: "enter", targets: ["tile"], style: "iris" },
        { type: "morph", targets: ["tile"], into: "star" },
        { type: "effect", targets: ["ring"], effect: "wobble", param: "time", to: 2, duration: 900, with: "previous" },
      ],
    },
    {
      id: "focus",
      label: "Close on the badge",
      camera: { frame: "ring", padding: 40 },
      run: [
        { type: "pulse", targets: ["badge"], count: 2, duration: 800 },
        { type: "color-pulse", targets: ["ring"], paint: "stroke", color: "#f59e0b", count: 2, duration: 800, with: "previous" },
      ],
      hold: 800,
    },
  ],
};

const button = "rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-40";

type Exported = { kind: "flair"; effect: FlairVectorEffect } | { kind: "lottie"; lottie: LottieAnimation; notes: string[] } | { kind: "json"; scene: MotionScene };

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Plays an exported Flair effect by importing it back: what Flair gets, as the editor reads it. */
function FlairPreview({ effect }: { effect: FlairVectorEffect }) {
  const controller = useMemo(() => {
    const { scene } = fromFlairVectorEffect(effect);
    return new AnimationEditorController({ scene: { ...scene, loop: "loop" }, readOnly: true });
  }, [effect]);
  useEffect(() => {
    controller.play();
    return () => controller.destroy();
  }, [controller]);
  return <AnimationEditor controller={controller} editable={false} showIssues={false} />;
}

/** Plays exported Lottie JSON with lottie-web (loaded on demand, demo only). */
function LottiePreview({ lottie }: { lottie: LottieAnimation }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let anim: { destroy(): void } | null = null;
    let cancelled = false;
    import("lottie-web")
      .then(({ default: player }) => {
        if (cancelled || !host.current) return;
        anim = player.loadAnimation({ container: host.current, renderer: "svg", loop: true, autoplay: true, animationData: structuredClone(lottie) });
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [lottie]);
  return (
    <div>
      <div ref={host} className="w-full overflow-hidden rounded-md border border-slate-800 bg-slate-950" style={{ aspectRatio: `${lottie.w} / ${lottie.h}` }} data-lottie-preview="" />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

/**
 * Vector animation: the whole hand editor (stage picking, scrubber, command list and inspector,
 * shot and scene settings), agent tools, Flair import and Flair / Lottie export with previews.
 */
export function AnimationTab() {
  const controller = useAnimationEditorController({ scene: SCENE });
  const state = useAnimationEditorState(controller);
  useAnimationEditorTools(demoToolRegistry, controller, { id: "animation", namespace: "animation" });
  const [accent, setAccent] = useState("#f43f5e");
  const [exported, setExported] = useState<Exported | null>(null);
  const [message, setMessage] = useState<{ title: string; lines: string[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const vector = useVectorEditorController({ document: ARTWORK });
  const agentStage = useRef<HTMLDivElement>(null);
  const errors = state.issues.filter((i) => i.severity === "error").length;
  const accentControl = state.scene.controls?.find((c) => c.name === "accent");
  // Everything enters later, so a stage at 0 s is empty: open on the badge once it has popped in.
  useEffect(() => controller.seek(1800), [controller]);

  const loadFlair = (id: string) => {
    const effect = FLAIR_SAMPLES.find((e) => e.id === id);
    if (!effect) return;
    const { scene, notes } = fromFlairVectorEffect(effect);
    const result = controller.load(scene, { clearHistory: false });
    setExported(null);
    setMessage(result.ok ? { title: `Loaded “${effect.name}” from Flair (undo to go back)`, lines: notes } : { title: "Could not load it", lines: [result.error] });
    if (result.ok) controller.select({ shot: scene.shots[0]?.id ?? "" });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Clapperboard className="h-5 w-5 text-rose-400" />
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Vector animation</h2>
          <p className="text-xs text-slate-400">
            Headless <code>AnimationEditorController</code> (<code>@pixerate/editor/animation-editor</code>) with the React controls from{" "}
            <code>@pixerate/editor-react/animation-editor</code>. Scrub the ruler, pick a shot, then add, reorder and edit its commands; click an element on the stage to pick
            it (shift-click toggles it as a target of the selected command). Every change is one undo step (⌘Z). Agents use the same edits through the{" "}
            <code>animation__*</code> tools.
          </p>
        </div>
      </div>
      <div className="relative rounded-xl border border-slate-800 bg-slate-900/50 p-3" ref={agentStage}>
        <AnimationEditor controller={controller} values={accentControl ? { accent } : undefined} />
      </div>
      <AgentScriptPanel scripts={ANIMATION_SCRIPTS} stage={agentStage} hint="Plays a scripted agent turn with the animation__* tools: a new shot, its commands, a reorder, a check, then playback." />
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>
          {state.shots.length} shots · {(state.duration / 1000).toFixed(1)} s · {errors} errors · {state.issues.length - errors} warnings and notes
        </span>
        {accentControl && (
          <label className="flex items-center gap-1">
            {accentControl.label ?? "Accent"} <input type="color" value={accent} onChange={(e) => setAccent(e.currentTarget.value)} />
          </label>
        )}
        <select className="rounded border border-slate-700 bg-slate-900 px-2 py-1" aria-label="Load from Flair" value="" onChange={(e) => loadFlair(e.target.value)} data-load-flair="">
          <option value="">Load from Flair…</option>
          {FLAIR_SAMPLES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({e.category})
            </option>
          ))}
        </select>
        <button type="button" className={button} onClick={() => { controller.load(SCENE, { clearHistory: true }); setMessage(null); }}>
          Reset demo scene
        </button>
        <button type="button" className={button} onClick={() => setExported({ kind: "flair", effect: controller.toFlairEffect({ category: "icon", tags: ["demo"] }) })} data-export="flair">
          Export Flair
        </button>
        <button type="button" className={button} onClick={() => { const out = toLottie(state.scene); setExported({ kind: "lottie", lottie: out.lottie, notes: out.notes }); }} data-export="lottie">
          Export Lottie
        </button>
        <button type="button" className={button} onClick={() => setExported({ kind: "json", scene: state.scene })}>
          Scene JSON
        </button>
        <button type="button" className={button} onClick={() => setEditing((e) => !e)}>
          {editing ? "Hide artwork editor" : "Edit artwork"}
        </button>
      </div>
      {message && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300" data-import-notes="">
          <div className="flex items-center gap-2">
            <span className="font-medium">{message.title}</span>
            <button type="button" className={`${button} ml-auto`} onClick={() => setMessage(null)}>
              Dismiss
            </button>
          </div>
          {message.lines.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">
              {message.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editing && (
        <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
          <VectorEditor controller={vector} height={360} />
          <button
            type="button"
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
            onClick={() => {
              const result = controller.setArtwork(vector.getState().document);
              setMessage(result.ok ? null : { title: "The artwork was not used", lines: [result.error] });
            }}
          >
            Use this artwork
          </button>
        </div>
      )}
      {exported && (
        <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-300 lg:grid-cols-2" data-export-preview={exported.kind}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">{exported.kind === "flair" ? "Flair vector effect (re-imported preview)" : exported.kind === "lottie" ? "Lottie (played by lottie-web)" : "Scene JSON"}</span>
              <button
                type="button"
                className={`${button} ml-auto`}
                onClick={() =>
                  exported.kind === "flair"
                    ? download(`${exported.effect.id}.flair.json`, exported.effect)
                    : exported.kind === "lottie"
                      ? download(`${state.scene.name}.lottie.json`, exported.lottie)
                      : download(`${state.scene.name}.scene.json`, exported.scene)
                }
              >
                Download
              </button>
              <button type="button" className={button} onClick={() => setExported(null)}>
                Close
              </button>
            </div>
            {exported.kind === "flair" && <FlairPreview effect={exported.effect} />}
            {exported.kind === "lottie" && <LottiePreview lottie={exported.lottie} />}
            {exported.kind === "lottie" && exported.notes.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-slate-400">
                {exported.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-300">
            {JSON.stringify(exported.kind === "flair" ? exported.effect : exported.kind === "lottie" ? exported.lottie : exported.scene, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
