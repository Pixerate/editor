// Recipe: an infinite paint layer under an xyflow canvas, with dry and wet brushes, built only from
// public helpers in @pixerate/editor/raster and /paint. Not a library feature: copy and adapt it.
import React, { useEffect, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, useViewport, type Node } from "@xyflow/react";
import { SurfaceViewportRenderer, drawSurfaceToViewport, emptySurface, screenToWorld, visibleSurfaceRect, worldToSurface, type TiledSurface } from "@pixerate/editor/raster";
import { WetMedium, WetWorld, dabRect, paintPathStroke, pathStrokeDabs, pointerStrokeSamples, rasterizeDab, type PathSample } from "@pixerate/editor/paint";

// The wet simulation has a fixed extent (at most 16384 px a side), so it covers 8192² around the
// origin; dry paint lives on an unbounded tiled surface with the same mapping.
const MAPPING = { origin: { x: -4096, y: -4096 }, pixelsPerUnit: 1 };
const PAPER = { absorption: 0.6, permeability: 0.5, roughness: 0.4, color: [255, 255, 255] as [number, number, number], heightAt: () => 0.5 };
const NODES: Node[] = [
  { id: "a", position: { x: 40, y: 40 }, data: { label: "Untick Paint to move nodes" } },
  { id: "b", position: { x: 260, y: 160 }, data: { label: "Pan and zoom the paint" } },
];
const hexRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
const canvasFactory = (w: number, h: number) => Object.assign(document.createElement("canvas"), { width: w, height: h });

function PaintLayer({ mode, wet, color, size }: { mode: boolean; wet: boolean; color: string; size: number }) {
  const viewport = useViewport();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef<{ dry: TiledSurface; world: WetWorld; medium: WetMedium; last: PathSample | null; dryR: SurfaceViewportRenderer; wetR: SurfaceViewportRenderer } | null>(null);
  const view = useRef(viewport);
  view.current = viewport;

  useEffect(() => {
    const world = new WetWorld(8192, 8192, PAPER, { threads: 0 });
    world.ensureLane("wet");
    const medium = new WetMedium(world, "wet", { water: 0.08, mass: 0.06, body: 0 });
    state.current = { dry: emptySurface(4), world, medium, last: null, dryR: new SurfaceViewportRenderer(canvasFactory), wetR: new SurfaceViewportRenderer(canvasFactory) };
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const s = state.current, canvas = canvasRef.current;
      if (!s || !canvas) return;
      const { clientWidth: w, clientHeight: h } = canvas, dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) Object.assign(canvas, { width: w * dpr, height: h * dpr });
      // Simulate only the wet tiles in view (plus a tile of margin); the rest wait until seen.
      if (world.isActive()) world.stepRegionSync(2, visibleSurfaceRect(MAPPING, view.current, w, h, 256));
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawSurfaceToViewport(ctx, s.dry, MAPPING, view.current, { width: w, height: h, renderer: s.dryR });
      drawSurfaceToViewport(ctx, world.display("wet").surface, MAPPING, view.current, { width: w, height: h, renderer: s.wetR });
    };
    tick();
    return () => (cancelAnimationFrame(frame), world.destroy());
  }, []);

  // Pointer → surface pixels: client → screen (canvas-relative) → world → surface.
  const toSurface = (cx: number, cy: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const p = screenToWorld(view.current, cx - r.left, cy - r.top);
    return worldToSurface(MAPPING, p.x, p.y);
  };
  const brush = { size: size * MAPPING.pixelsPerUnit, hardness: wet ? 0.5 : 0.8, spacing: 0.15 };

  const stroke = (samples: PathSample[]) => {
    const s = state.current!;
    const continuing = s.last !== null;
    const path = continuing ? [s.last!, ...samples] : samples;
    s.last = samples[samples.length - 1];
    if (!wet) {
      const rgb = hexRgb(color).map((v) => Math.round(v * 255));
      s.dry = paintPathStroke(s.dry, path, { brush, color: [rgb[0], rgb[1], rgb[2], 255] }).surface;
      return;
    }
    // Wet: lay each dab's water and pigment into the simulation (skipping the joint's dab, which the
    // previous event laid).
    for (const d of pathStrokeDabs(path, { brush }).slice(continuing ? 1 : 0)) {
      const rect = dabRect(d, brush.hardness);
      const cov = new Float32Array(rect.width * rect.height);
      rasterizeDab(d, brush.hardness, rect, cov);
      s.medium.deposit(rect, cov, d.opacity, hexRgb(color), null);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: mode ? 10 : 0, pointerEvents: mode ? "auto" : "none", touchAction: "none" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        state.current!.last = null;
        stroke(pointerStrokeSamples(e.nativeEvent, toSurface));
      }}
      onPointerMove={(e) => e.buttons === 1 && stroke(pointerStrokeSamples(e.nativeEvent, toSurface))}
      onPointerUp={() => (state.current!.last = null)}
    />
  );
}

export function CanvasPaintLayerRecipe() {
  const [mode, setMode] = useState(true);
  const [wet, setWet] = useState(true);
  const [color, setColor] = useState("#2563eb");
  const [size, setSize] = useState(24);
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 space-y-2" aria-label="Paint layer recipe">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
        <strong className="text-slate-200">Recipe: paint layer under the canvas</strong>
        <label><input type="checkbox" checked={mode} onChange={(e) => setMode(e.target.checked)} /> Paint (off: edit nodes)</label>
        <label><input type="checkbox" checked={wet} onChange={(e) => setWet(e.target.checked)} /> Wet (watercolour)</label>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Paint colour" />
        <input type="range" min={4} max={80} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Brush size" />
      </div>
      <div className="h-[420px] rounded-lg overflow-hidden border border-slate-800 bg-white relative">
        <ReactFlowProvider>
          <PaintLayer mode={mode} wet={wet} color={color} size={size} />
          <ReactFlow defaultNodes={NODES} colorMode="light" proOptions={{ hideAttribution: true }} style={{ background: "transparent" }}>
            <Background color="#cbd5e1" />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}
