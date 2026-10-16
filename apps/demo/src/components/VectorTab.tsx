import React, { useState } from "react";
import { ellipseSubpath, rectSubpath, starSubpath, type VectorDocument } from "@pixerate/editor/vector";
import { VectorEditor, useVectorCommands, useVectorEditorController, useVectorEditorState } from "@pixerate/editor-react/vector";
import { PenTool } from "lucide-react";
import { demoCommandRegistry } from "../agentTools";

const STARTER: VectorDocument = {
  width: 800,
  height: 500,
  background: "#ffffff",
  nodes: [
    {
      id: "sun",
      type: "path",
      name: "Sun",
      fill: { type: "radial", stops: [{ offset: 0, color: "#fde68a" }, { offset: 1, color: "#f97316" }] },
      stroke: null,
      subpaths: [ellipseSubpath({ x: 560, y: 70, width: 140, height: 140 })],
    },
    {
      id: "hill",
      type: "path",
      name: "Hill",
      fill: "#22c55e",
      stroke: "#166534",
      strokeWidth: 3,
      subpaths: [
        {
          closed: true,
          anchors: [
            { x: 0, y: 500 },
            { x: 0, y: 340, out: { x: 200, y: 220 } },
            { x: 420, y: 330, in: { x: 300, y: 300 }, out: { x: 560, y: 360 }, type: "smooth" },
            { x: 800, y: 300, in: { x: 700, y: 260 } },
            { x: 800, y: 500 },
          ],
        },
      ],
    },
    { id: "card", type: "path", name: "Card", fill: "#e0f2fe", stroke: "#0369a1", strokeWidth: 2, subpaths: [rectSubpath({ x: 80, y: 60, width: 220, height: 140 }, 18)] },
    { id: "star", type: "path", name: "Star", fill: "#facc15", stroke: "#a16207", strokeWidth: 2, subpaths: [starSubpath({ x: 150, y: 90, width: 80, height: 80 }, 5, 0.45)] },
  ],
};

export function VectorTab() {
  const controller = useVectorEditorController({ document: STARTER });
  const state = useVectorEditorState(controller);
  useVectorCommands(demoCommandRegistry, controller);
  const [svg, setSvg] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <PenTool className="h-5 w-5 text-sky-400" />
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Vector editor</h2>
          <p className="text-xs text-slate-400">
            Headless <code>VectorEditorController</code> (<code>@pixerate/editor/vector</code>) with React bindings. Pen (P): click for corners, drag for curves,
            click the first point to close. Direct select (A): drag points and handles, Alt-drag a point for smooth handles, Alt-click a segment to add a point.
            Drags snap to other shapes with labelled smart guides (hold Cmd/Ctrl to bypass, or switch Snap off in the toolbar). Space-drag pans, Cmd/Ctrl+wheel zooms.
          </p>
        </div>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
        <VectorEditor controller={controller} height={520} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>
          {state.document.nodes.length} nodes · {state.selection.length} selected · {Math.round(state.viewport.zoom * 100)}%
        </span>
        <button type="button" className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => setSvg(controller.toSvg())}>
          Export SVG
        </button>
        {svg && (
          <button type="button" className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => setSvg(null)}>
            Hide
          </button>
        )}
      </div>
      {svg && <pre className="max-h-64 overflow-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-[11px] text-slate-300">{svg}</pre>}
    </div>
  );
}
