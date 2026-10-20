import React, { useRef, useState } from "react";
import { createOutlineTextShaper, createVectorEffect, ellipseSubpath, loadOpenTypeFont, rectSubpath, setSubpathCorners, starSubpath, type OpenTypeFont, type VectorDocument, type VectorEffect } from "@pixerate/editor/vector";
import { VectorEditor, useVectorCommands, useVectorEditorController, useVectorEditorState } from "@pixerate/editor-react/vector";
import { PenTool } from "lucide-react";
import { demoCommandRegistry } from "../agentTools";
import { AgentScriptPanel } from "./AgentScriptPanel";
import { VECTOR_SCRIPTS } from "../agentScripts";

/** A live path effect for the sample document (defaults filled in). */
const effect = (type: VectorEffect["type"], id: string, params: Record<string, unknown>) => createVectorEffect(type, id, params)!;

const STARTER: VectorDocument = {
  width: 800,
  height: 500,
  background: "#ffffff",
  // A symbol: double-click a tree to edit them all (isolation mode); Esc or Done to leave.
  symbols: [
    {
      id: "tree",
      name: "Tree",
      nodes: [
        { id: "trunk", type: "path", name: "Trunk", fill: "#78350f", stroke: null, subpaths: [rectSubpath({ x: -3, y: 0, width: 6, height: 18 })] },
        { id: "crown", type: "path", name: "Crown", fill: "#15803d", stroke: "#14532d", strokeWidth: 1.5, subpaths: [ellipseSubpath({ x: -14, y: -26, width: 28, height: 32 })] },
      ],
    },
  ],
  nodes: [
    {
      id: "sun",
      type: "path",
      name: "Sun",
      // A radial gradient with an off-centre focal point (Gradient tool, G: Alt-drag the centre to move it).
      fill: {
        type: "radial",
        start: { x: 0.5, y: 0.5 },
        end: { x: 1, y: 0.5 },
        focal: { x: 0.4, y: 0.38 },
        stops: [{ offset: 0, color: "#fef9c3" }, { offset: 0.45, color: "#fde68a", midpoint: 0.4 }, { offset: 1, color: "#f97316" }],
      },
      stroke: null,
      subpaths: [ellipseSubpath({ x: 560, y: 70, width: 140, height: 140 })],
      // Path effects: the rays are a smooth Zig Zag of the circle (the anchors stay a circle).
      effects: [effect("zigzag", "rays", { size: 7, ridges: 3, smooth: true })],
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
    {
      id: "card",
      type: "path",
      name: "Card",
      // Mixed in Oklab with a midpoint: SVG gets extra stops so it looks the same.
      fill: { type: "linear", angle: 135, interpolation: "oklab", stops: [{ offset: 0, color: "#e0f2fe", midpoint: 0.35 }, { offset: 1, color: "#38bdf8" }] },
      stroke: "#0369a1",
      strokeWidth: 2,
      subpaths: [rectSubpath({ x: 80, y: 60, width: 220, height: 140 }, 18)],
    },
    {
      id: "star",
      type: "path",
      name: "Star",
      fill: "#facc15",
      stroke: "#a16207",
      strokeWidth: 4,
      strokeAlign: "inside",
      subpaths: [setSubpathCorners(starSubpath({ x: 150, y: 90, width: 80, height: 80 }, 5, 0.45), 3)],
    },
    {
      id: "arrow",
      type: "path",
      name: "Arrow",
      fill: null,
      // A gradient along the stroke, from the tail to the head.
      stroke: { type: "linear", strokeMode: "along", stops: [{ offset: 0, color: "#334155" }, { offset: 1, color: "#0ea5e9" }] },
      strokeWidth: 3,
      strokeLinecap: "round",
      startArrow: "circle",
      endArrow: "triangle",
      arrowAlign: "tip",
      subpaths: [{ closed: false, anchors: [{ x: 340, y: 250, out: { x: 420, y: 180 } }, { x: 540, y: 170, in: { x: 470, y: 120 } }] }],
    },
    {
      // A live blend: edit either key (A) and the steps follow; the dashed spine shows when selected.
      id: "blend",
      type: "group",
      name: "Blend",
      blend: {
        steps: 6,
        orientToSpine: true,
        spine: { closed: false, anchors: [{ x: 345, y: 60, out: { x: 390, y: 0 } }, { x: 525, y: 60, in: { x: 480, y: 0 } }] },
      },
      children: [
        { id: "blend-a", type: "path", name: "Blend start", fill: "#0ea5e9", stroke: null, subpaths: [rectSubpath({ x: 331, y: 46, width: 28, height: 28 }, 4)] },
        { id: "blend-b", type: "path", name: "Blend end", fill: "#f43f5e", stroke: null, subpaths: [starSubpath({ x: 505, y: 40, width: 40, height: 40 }, 5, 0.45)] },
      ],
    },
    {
      // A repeater turns one petal into a flower, fading round; Trim Paths below it draws the petals on.
      id: "flower",
      type: "path",
      name: "Flower",
      fill: "#fb7185",
      stroke: "#9f1239",
      strokeWidth: 1.5,
      subpaths: [ellipseSubpath({ x: 110, y: 372, width: 20, height: 44 })],
      effects: [
        effect("repeater", "petals", { copies: 8, rotation: 45, position: { x: 0, y: 0 }, anchor: { x: 0, y: 24 }, endOpacity: 55 }),
        effect("trim", "draw-on", { start: 0, end: 100, mode: "individual" }),
      ],
    },
    {
      // A live boolean: the hole is its own editable shape (select the badge, then pick an operand).
      id: "badge",
      type: "group",
      name: "Live boolean",
      liveBoolean: "subtract",
      children: [
        { id: "badge-card", type: "path", name: "Badge", fill: "#a855f7", stroke: "#581c87", strokeWidth: 2, subpaths: [rectSubpath({ x: 200, y: 400, width: 110, height: 70 }, 14)] },
        { id: "badge-hole", type: "path", name: "Hole", fill: "#000000", stroke: null, subpaths: [ellipseSubpath({ x: 238, y: 418, width: 34, height: 34 })] },
      ],
    },
    {
      // Conic, diamond and reflected gradients have no SVG element: they render as patterns of gradient tiles.
      id: "wheel",
      type: "path",
      name: "Colour wheel",
      fill: {
        type: "conic",
        angle: 0,
        interpolation: "oklab",
        stops: ["#ef4444", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#d946ef", "#ef4444"].map((color, i) => ({ offset: i / 6, color })),
      },
      stroke: "#ffffff",
      strokeWidth: 2,
      subpaths: [ellipseSubpath({ x: 716, y: 306, width: 60, height: 60 })],
    },
    {
      id: "gem",
      type: "path",
      name: "Gem",
      fill: { type: "diamond", r: 0.25, spread: "reflect", stops: [{ offset: 0, color: "#eef2ff" }, { offset: 1, color: "#6366f1" }] },
      stroke: "#3730a3",
      strokeWidth: 2,
      subpaths: [rectSubpath({ x: 640, y: 428, width: 56, height: 56 }, 8)],
    },
    {
      id: "ribbon",
      type: "path",
      name: "Ribbon",
      fill: { type: "reflected", angle: 180, stops: [{ offset: 0, color: "#fef3c7" }, { offset: 1, color: "#b45309" }] },
      stroke: null,
      subpaths: [rectSubpath({ x: 330, y: 292, width: 120, height: 26 }, 13)],
    },
    {
      // A live envelope warp: the stripes stay editable. Change the warp in the Envelope panel, or pick
      // the Envelope tool (U) and drag its mesh (it becomes a mesh envelope); Expand bakes it.
      id: "flag",
      type: "group",
      name: "Warped flag",
      children: [
        { id: "flag-top", type: "path", name: "Stripe", fill: "#0ea5e9", stroke: null, subpaths: [rectSubpath({ x: 580, y: 230, width: 180, height: 18 })] },
        { id: "flag-mid", type: "path", name: "Stripe", fill: "#ffffff", stroke: null, subpaths: [rectSubpath({ x: 580, y: 248, width: 180, height: 18 })] },
        { id: "flag-low", type: "path", name: "Stripe", fill: "#f43f5e", stroke: null, subpaths: [rectSubpath({ x: 580, y: 266, width: 180, height: 18 })] },
      ],
      effects: [effect("envelope", "warp", { style: "flag", bend: 25 })],
    },
    {
      // An appearance stack: two fills (a gradient multiplied over a colour), an outer and an
      // inner stroke, and a drop shadow. Edit the layers in the style panel's Fills / Strokes.
      id: "sticker",
      type: "path",
      name: "Sticker",
      fill: { type: "linear", angle: 135, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#f97316" }] },
      fills: [
        { paint: "#fde047" },
        { paint: { type: "linear", angle: 135, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#f97316" }] }, blendMode: "multiply" },
      ],
      stroke: "#ffffff",
      strokeWidth: 2,
      strokeAlign: "inside",
      strokes: [
        { paint: "#7c2d12", strokeWidth: 6, strokeAlign: "outside" },
        { paint: "#ffffff", strokeWidth: 2, strokeAlign: "inside" },
      ],
      filters: [{ id: "shadow", type: "dropShadow", params: { color: "#000000", opacity: 0.3, offsetX: 0, offsetY: 4, blur: 6, spread: 0 } }],
      subpaths: [rectSubpath({ x: 14, y: 430, width: 56, height: 50 }, 10)],
    },
    {
      // A clipping mask: the circle (the bottom child) clips the stripes above it. The group's drop
      // shadow follows the clipped silhouette. Select it and use the Mask panel: Edit mask opens
      // the circle for anchor editing, Contents selects the stripes (drag them inside the frame).
      id: "porthole",
      type: "group",
      name: "Clip group",
      mask: { type: "clip" },
      filters: [{ id: "porthole-shadow", type: "dropShadow", params: { color: "#000000", opacity: 0.3, offsetX: 0, offsetY: 3, blur: 6, spread: 0 } }],
      children: [
        { id: "porthole-mask", type: "path", name: "Clip", fill: null, stroke: null, subpaths: [ellipseSubpath({ x: 475, y: 250, width: 60, height: 60 })] },
        ...["#1d4ed8", "#38bdf8", "#e0f2fe", "#fbbf24"].map((fill, i) => ({
          id: `porthole-stripe-${i}`,
          type: "path" as const,
          name: "Stripe",
          fill,
          stroke: null,
          subpaths: [rectSubpath({ x: 460, y: 240 + i * 20, width: 90, height: 20 })],
        })),
      ],
    },
    {
      // An opacity mask: a white-to-black gradient (luminance) fades the panel out towards the bottom.
      id: "fade",
      type: "group",
      name: "Opacity mask",
      mask: { type: "luminance" },
      children: [
        {
          id: "fade-mask",
          type: "path",
          name: "Fade",
          fill: { type: "linear", angle: 180, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] },
          stroke: null,
          subpaths: [rectSubpath({ x: 14, y: 220, width: 56, height: 90 })],
        },
        { id: "fade-panel", type: "path", name: "Panel", fill: "#0ea5e9", stroke: "#0c4a6e", strokeWidth: 2, subpaths: [rectSubpath({ x: 14, y: 220, width: 56, height: 90 }, 8)] },
      ],
    },
    {
      // Point text (Type tool, T: click to type, drag for area text; double-click text to edit it).
      id: "title",
      type: "text",
      name: "Title",
      text: "Pixerate vectors",
      font: { fontFamily: "Georgia, serif", fontWeight: 700, fontSize: 30 },
      runs: [{ length: 8, style: { fill: "#0369a1" } }],
      fill: "#0f172a",
      stroke: null,
      frame: { kind: "point", x: 340, y: 50 },
    },
    {
      // Area text wraps inside its box (drag a box with the Type tool).
      id: "blurb",
      type: "text",
      name: "Blurb",
      text: "Text lays out with the same engine as the image editor's type layers, so it wraps, aligns and styles the same in React, Svelte and for agents.",
      font: { fontFamily: "sans-serif", fontWeight: 400, fontSize: 12 },
      paragraph: { align: "justify" },
      fill: "#334155",
      stroke: null,
      frame: { kind: "area", x: 90, y: 215, width: 200, height: 70 },
    },
    {
      // Text on a path (Type on a Path, Q: click a path); load a font below for outlines.
      id: "arc-text",
      type: "text",
      name: "Path text",
      text: "along the hill",
      font: { fontFamily: "sans-serif", fontWeight: 600, fontSize: 16, tracking: 80 },
      paragraph: { align: "center" },
      fill: "#14532d",
      stroke: null,
      frame: { kind: "path", path: { closed: false, anchors: [{ x: 20, y: 330, out: { x: 160, y: 250 } }, { x: 380, y: 318, in: { x: 260, y: 290 } }] }, baseline: "descender" },
    },
    // Instances of the Tree symbol: scaled and skewed copies that follow the symbol.
    { id: "tree-1", type: "instance", name: "Tree", symbolId: "tree", transform: [1, 0, 0, 1, 610, 300] },
    { id: "tree-2", type: "instance", name: "Tree", symbolId: "tree", transform: [1.4, 0, 0, 1.4, 660, 292] },
    { id: "tree-3", type: "instance", name: "Tree", symbolId: "tree", transform: [0.8, 0, -0.15, 0.8, 715, 298], overrides: { fill: "#65a30d" } },
    {
      id: "brush",
      type: "path",
      name: "Tapered stroke",
      fill: null,
      stroke: "#7c3aed",
      strokeWidth: 12,
      strokeLinecap: "round",
      // Thin at both ends, swelling in the middle: drag it with the Width tool (W) to reshape.
      strokeWidthProfile: [
        { t: 0, left: 0, right: 0 },
        { t: 0.35, left: 1.2, right: 0.8 },
        { t: 1, left: 0, right: 0 },
      ],
      subpaths: [
        {
          closed: false,
          anchors: [
            { x: 340, y: 430, out: { x: 420, y: 360 } },
            { x: 520, y: 400, in: { x: 470, y: 450 }, out: { x: 570, y: 350 }, type: "smooth" },
            { x: 700, y: 380, in: { x: 640, y: 330 } },
          ],
        },
      ],
    },
  ],
};

export function VectorTab() {
  const controller = useVectorEditorController({ document: STARTER });
  const state = useVectorEditorState(controller);
  useVectorCommands(demoCommandRegistry, controller);
  const [svg, setSvg] = useState<string | null>(null);
  const agentStage = useRef<HTMLDivElement>(null);
  // Fonts read from files make text draw as glyph outlines (Create Outlines, effects on text).
  const [fonts, setFonts] = useState<OpenTypeFont[]>([]);
  const [fontError, setFontError] = useState<string | null>(null);
  const loadFonts = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const loaded = await Promise.all(Array.from(files).map((f) => loadOpenTypeFont(f)));
      const next = [...fonts, ...loaded];
      setFonts(next);
      setFontError(null);
      controller.setTextShaper(createOutlineTextShaper(next));
    } catch (e) {
      setFontError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <PenTool className="h-5 w-5 text-sky-400" />
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Vector editor</h2>
          <p className="text-xs text-slate-400">
            Headless <code>VectorEditorController</code> (<code>@pixerate/editor/vector</code>) with React bindings. Pen (P): click for corners, drag for curves,
            click the first point to close. Direct select (A): drag points and handles, Alt-drag a point for smooth handles, Alt-click a segment to add a point. Width (W): drag a stroke to taper it (Alt: one side); pen pressure shapes pencil strokes.
            Distort (toolbar): drag a corner of the selection box in perspective (Shift+Alt+Cmd/Ctrl: symmetric, Cmd/Ctrl-drag a side: skew). Envelope tool (U): drag the mesh of a warped object.
            Type (T): click for point text, drag for area text, double-click text to edit; Type on a Path (Q): click a path. Without loaded fonts, text draws as SVG text in the browser's fonts.
            Symbols: select objects and press F8 (or New in the Symbols panel); double-click an instance to edit the symbol. Masks: select two or more objects and press Cmd/Ctrl+7 (or Clip / Opacity in the Mask panel); the topmost masks the others. Cmd/Ctrl+Alt+7 releases.
            Drags snap to other shapes with labelled smart guides (hold Cmd/Ctrl to bypass, or switch Snap off in the toolbar). Space-drag pans, Cmd/Ctrl+wheel zooms.
          </p>
        </div>
      </div>
      <div className="relative rounded-xl border border-slate-800 bg-slate-900/50 p-3" ref={agentStage}>
        <VectorEditor controller={controller} height={520} />
      </div>
      <AgentScriptPanel scripts={VECTOR_SCRIPTS} stage={agentStage} hint="Plays a scripted agent turn through commands__run_command with the vector.* commands (the same ones in the command palette)." />
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>
          {state.document.nodes.length} nodes · {state.selection.length} selected · {Math.round(state.viewport.zoom * 100)}%
        </span>
        <button type="button" className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => setSvg(controller.toSvg())}>
          Export SVG
        </button>
        <button
          type="button"
          className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800"
          title="Export the drawing as Lottie JSON (path effects stay live as Lottie modifiers)"
          onClick={() => {
            const { lottie, notes } = controller.toLottie({ name: "Vector" });
            setSvg(JSON.stringify(lottie, null, 2) + (notes.length ? `\n\n/* ${notes.join("\n   ")} */` : ""));
          }}
        >
          Export Lottie
        </button>
        <button
          type="button"
          className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800"
          title="Download the drawing as a vector PDF (a page per artboard when there are frames)"
          onClick={() => {
            const hasBoards = controller.getFrames().some((f) => f.artboard);
            const { bytes, notes } = controller.toPdf({ pages: hasBoards ? "artboards" : "document", title: "Vector" });
            const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "vector.pdf";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setFontError(notes.length ? `PDF: ${notes.join(" ")}` : null);
          }}
        >
          Export PDF
        </button>
        <label className="cursor-pointer rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" title="Import the first frame of a Lottie JSON animation as editable shapes">
          Import Lottie…
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) {
                const r = controller.importLottie(await file.text());
                setFontError(r.ok ? null : r.message);
              }
            }}
          />
        </label>
        <label className="cursor-pointer rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" title="Load TTF, OTF or WOFF fonts: text then draws as glyph outlines, so Create Outlines and effects on text work">
          Load fonts…
          <input type="file" accept=".ttf,.otf,.woff,.ttc,font/ttf,font/otf,font/woff" multiple className="hidden" onChange={(e) => void loadFonts(e.target.files)} />
        </label>
        {fonts.length > 0 && (
          <button
            type="button"
            className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800"
            onClick={() => {
              setFonts([]);
              controller.setTextShaper(null);
            }}
          >
            Browser fonts ({fonts.map((f) => f.family).join(", ")} loaded)
          </button>
        )}
        {fontError && <span className="text-red-400">{fontError}</span>}
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
