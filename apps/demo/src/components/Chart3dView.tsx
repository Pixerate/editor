import React, { useEffect, useRef, useState } from "react";
import type { ChartSpec } from "@pixerate/editor/chart";
import { renderChart3d, type Chart3dLabel } from "@pixerate/editor/three";

/**
 * A chart drawn in 3-D with `@pixerate/editor/three` (#795): a WebGL canvas, drawn once per change
 * (no animation loop), with its labels as HTML on top so the text stays crisp.
 */
export function Chart3dView({ spec, width = 640, height = 400 }: { spec: ChartSpec; width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [labels, setLabels] = useState<Chart3dLabel[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const view = renderChart3d(canvas, spec, { width, height });
      view.render();
      setLabels(view.labels());
      setError("");
      return () => view.dispose();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [spec, width, height]);
  if (error) return <p className="text-xs text-rose-400">3-D view unavailable: {error}</p>;
  return (
    <div className="relative" style={{ width, height }} data-testid="chart-3d">
      <canvas ref={canvasRef} style={{ width, height }} className="rounded-lg" />
      {labels.map((l, i) => (
        <span
          key={i}
          className={`pointer-events-none absolute whitespace-nowrap ${l.kind === "title" ? "text-[15px] font-semibold text-slate-900" : l.kind === "tick" ? "text-[11px] text-slate-500" : "text-[12px] text-slate-700"}`}
          style={{ left: l.x, top: l.y, transform: `translate(${l.anchor === "middle" ? "-50%" : l.anchor === "end" ? "-100%" : "0"}, -50%)` }}
        >
          {l.text}
        </span>
      ))}
    </div>
  );
}
