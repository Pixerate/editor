import React, { useEffect, useRef, useState } from "react";
import type { ChartSelection, ChartSpec } from "@pixerate/editor/chart";
import { chartTooltipFor, describeChartSelectionIn, nextChart3dFocus, renderChart3d, type Chart3dLabel, type Chart3dRenderer, type Chart3dStyleInput, type ChartTooltip } from "@pixerate/editor/three";
import { compositeCapture } from "@pixerate/editor/tools";

/**
 * A chart drawn in 3-D with `@pixerate/editor/three` (#795): a WebGL canvas, drawn once per change
 * (no animation loop), with its labels as HTML on top so the text stays crisp. Point at a bar or a
 * line (#808), or focus the chart and use the arrow keys: the focused mark keeps its colour, the
 * rest dim, and the tooltip and description are the flat chart's.
 */
/**
 * Two house styles for 3-D (#810), as `chart.json` would hold them: the `three` section and the
 * theme the labels are drawn in. "Unstyled" is today's look.
 */
const HOUSE_STYLES: Record<string, { label: string; three: Chart3dStyleInput; text: string; muted: string }> = {
  none: { label: "Unstyled", three: {}, text: "#0f172a", muted: "#64748b" },
  matte: {
    label: "Matte paper (warm studio, soft shadows)",
    three: {
      version: 1,
      materials: { mark: { roughness: 1, metalness: 0 }, floor: { color: "#efe6d8", roughness: 1 }, wall: { color: "#faf5ec", roughness: 1 }, highlight: { color: "#ffb347", intensity: 0.15 } },
      light: { preset: "studio", intensity: 1.05, azimuth: -50, elevation: 60 },
      shadow: { enabled: true, softness: 0.8 },
      ambientOcclusion: true,
      background: "#fbf7f0",
    },
    text: "#2b2118",
    muted: "#6b5a49",
  },
  glass: {
    label: "Glass night (rim light, glassy ribbons)",
    three: {
      version: 1,
      materials: { mark: { roughness: 0.25, metalness: 0.35 }, ribbon: { roughness: 0.1, transmission: 0.6, opacity: 0.85 }, floor: { color: "#111827", roughness: 0.4, metalness: 0.2 }, wall: { color: "#0b1220" }, highlight: { color: "#7dd3fc", intensity: 0.2 } },
      light: { preset: "rim", intensity: 1.1 },
      background: "#05080f",
    },
    text: "#e2e8f0",
    muted: "#94a3b8",
  },
};

export function Chart3dView({ spec, width = 640, height = 400 }: { spec: ChartSpec; width?: number; height?: number }) {
  const [styleId, setStyleId] = useState("none");
  const house = HOUSE_STYLES[styleId] ?? HOUSE_STYLES.none;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<Chart3dRenderer | null>(null);
  const [labels, setLabels] = useState<Chart3dLabel[]>([]);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState<ChartSelection | null>(null);
  const [tip, setTip] = useState<ChartTooltip | null>(null);
  const pictureRef = useRef<HTMLDivElement>(null);
  const [exported, setExported] = useState<{ url: string; width: number; height: number } | null>(null);
  // One PNG of the WebGL canvas and its HTML labels (#809), drawn again at 2× for a sharp picture.
  const exportPng = async () => {
    if (!pictureRef.current) return;
    try {
      const shot = await compositeCapture(pictureRef.current, { scale: 2 });
      setExported({ url: shot.image as string, width: shot.width, height: shot.height });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const view = renderChart3d(canvas, spec, { width, height, style: house.three });
      viewRef.current = view;
      view.render();
      setLabels(view.labels());
      setFocus(null);
      setTip(null);
      setError("");
      return () => {
        viewRef.current = null;
        view.dispose();
      };
    } catch (e) {
      setError((e as Error).message);
    }
  }, [spec, width, height, house]);

  // Draw the focus (no clock: one render per change) and place the tooltip.
  const show = (next: ChartSelection | null) => {
    const view = viewRef.current;
    if (!view) return;
    setFocus(next);
    view.focus(next);
    view.render();
    setLabels(view.labels());
    const at = next ? view.anchor(next) : null;
    setTip(next && next.kind === "point" && at ? chartTooltipFor(spec, next.index, next.seriesId, at) : null);
  };
  const same = (a: ChartSelection | null, b: ChartSelection | null) => JSON.stringify(a) === JSON.stringify(b);

  if (error) return <p className="text-xs text-rose-400">3-D view unavailable: {error}</p>;
  return (
    <div className="space-y-2">
    <div
      ref={pictureRef}
      data-picture
      className="relative rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
      style={{ width, height }}
      data-testid="chart-3d"
      tabIndex={0}
      aria-label="3-D chart: point at a mark, or use the arrow keys"
      onPointerMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const next = viewRef.current?.pick(e.clientX - box.left, e.clientY - box.top) ?? null;
        if (!same(next, focus)) show(next);
      }}
      onPointerLeave={() => show(null)}
      onKeyDown={(e) => {
        const view = viewRef.current;
        if (!view) return;
        const next = nextChart3dFocus(view.layout, focus, e.key);
        if (next === undefined) return;
        e.preventDefault();
        show(next);
      }}
    >
      <canvas ref={canvasRef} style={{ width, height }} className="rounded-lg" />
      {labels.map((l, i) => (
        <span
          key={i}
          className={`pointer-events-none absolute whitespace-nowrap ${l.kind === "title" ? "text-[15px] font-semibold" : l.kind === "tick" ? "text-[11px]" : l.focused ? "text-[12px] font-semibold" : "text-[12px]"}`}
          style={{ color: l.kind === "tick" ? house.muted : house.text, left: l.x, top: l.y, transform: `translate(${l.anchor === "middle" ? "-50%" : l.anchor === "end" ? "-100%" : "0"}, -50%)` }}
        >
          {l.text}
        </span>
      ))}
      {tip && (
        <div className="pointer-events-none absolute z-10 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-800 shadow" style={{ left: tip.x, top: tip.y - 8, transform: "translate(-50%, -100%)" }}>
          <div className="font-semibold">{tip.title}</div>
          {tip.items.map((item) => (
            <div key={item.seriesId} className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: item.color }} />
              {item.name}: {item.text}
            </div>
          ))}
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {focus ? describeChartSelectionIn(spec, focus) : ""}
      </p>
    </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <label className="flex items-center gap-1">
          3-D house style
          <select className="rounded border border-slate-300 bg-white px-1 py-0.5 text-slate-800" value={styleId} onChange={(e) => setStyleId(e.currentTarget.value)} data-testid="chart-3d-style">
            {Object.entries(HOUSE_STYLES).map(([id, s]) => (
              <option key={id} value={id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" onClick={exportPng} data-testid="chart-3d-export">
          Export PNG (2×)
        </button>
        {exported && (
          <a href={exported.url} download="chart-3d.png" className="underline" data-testid="chart-3d-download">
            chart-3d.png, {exported.width}×{exported.height}
          </a>
        )}
      </div>
      {exported && <img src={exported.url} alt="The exported 3-D chart with its labels" width={width} height={height} className="rounded-lg border border-slate-200" data-testid="chart-3d-exported" />}
    </div>
  );
}
