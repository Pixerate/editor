import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  CSS_VARIABLE_CHART_THEME,
  chartClientToScene,
  chartTextBaseline,
  chartTooltipAt,
  chartTextTransform,
  describeChartSelection,
  handleChartKey,
  layoutChart,
  sameChartTooltip,
  startChartPointDrag,
  type ChartController,
  type ChartMark,
  type ChartPointDrag,
  type ChartPresence,
  type ChartScene,
  type ChartTextMeasure,
  type ChartTheme,
  type ChartTooltip,
  type ChartTooltipMode,
} from '@pixerate/editor/chart';
import { useChartState } from './useChartEditor';

export interface ChartCanvasProps {
  controller: ChartController;
  /** Scene width; with `responsive` this is only the fallback before the container is measured (default 640). */
  width?: number;
  /** Scene height in pixels (default 400). */
  height?: number;
  /** Follow the container's width (default `true`). */
  responsive?: boolean;
  /** Colours and type (default: shadcn-style CSS variables). */
  theme?: Partial<ChartTheme>;
  /** Click to select, drag bars and points, keyboard editing (default `true`). */
  editable?: boolean;
  /** Text width for layout (default: an estimate). */
  measureText?: ChartTextMeasure;
  emptyMessage?: string;
  className?: string;
  /** Agent cursors to draw over the chart (see `ChartDirector`). */
  presence?: ChartPresence;
  /** Receives the scene as drawn (e.g. for `ChartDirector`'s `scene`). */
  sceneRef?: { current: ChartScene | null };
  /** Show a tooltip on hover: `point` (or `true`) for the bar, point or slice under the pointer, `category` for every series in the category under it (default off). */
  tooltip?: boolean | ChartTooltipMode;
  /** Draws the tooltip's content instead of the category label and one row per series. */
  renderTooltip?: (tooltip: ChartTooltip) => React.ReactNode;
}

/** SVG attributes for one mark (colours go in `style` so CSS variables work). */
export function renderChartMark(mark: ChartMark, fontFamily: string, interactive: boolean): React.ReactNode {
  const common = {
    'data-role': mark.role,
    'data-chart-key': mark.target ? mark.key : undefined,
    'data-selected': mark.selected ? '' : undefined,
    opacity: mark.opacity,
    pointerEvents: mark.role === 'selection' || mark.role === 'drag-readout' || (!mark.target && mark.role !== 'background') ? ('none' as const) : undefined,
    cursor: interactive && mark.target && mark.role !== 'background' ? 'pointer' : undefined,
  };
  switch (mark.kind) {
    case 'rect':
      return <rect key={mark.key} {...common} x={mark.x} y={mark.y} width={mark.width} height={mark.height} rx={mark.radius} style={{ fill: mark.fill, stroke: mark.stroke, strokeWidth: mark.strokeWidth }} />;
    case 'path':
      return (
        <path
          key={mark.key}
          {...common}
          d={mark.d}
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeDasharray={mark.dash}
          style={{ fill: mark.fill ?? 'none', stroke: mark.stroke, strokeWidth: mark.strokeWidth }}
        />
      );
    case 'circle':
      return <circle key={mark.key} {...common} cx={mark.cx} cy={mark.cy} r={mark.r} style={{ fill: mark.fill, stroke: mark.stroke, strokeWidth: mark.strokeWidth }} />;
    case 'line':
      return <line key={mark.key} {...common} x1={mark.x1} y1={mark.y1} x2={mark.x2} y2={mark.y2} strokeDasharray={mark.dash} style={{ stroke: mark.stroke, strokeWidth: mark.strokeWidth }} />;
    case 'text':
      return (
        <text
          key={mark.key}
          {...common}
          x={mark.x}
          y={mark.y}
          textAnchor={mark.anchor}
          dominantBaseline={chartTextBaseline(mark.baseline)}
          transform={chartTextTransform(mark)}
          style={{ fill: mark.fill, fontSize: mark.size, fontWeight: mark.weight, fontFamily, userSelect: 'none' }}
        >
          {mark.text}
        </text>
      );
  }
}

/** Agent cursors and notes, drawn in scene coordinates inside the chart's SVG. */
export function ChartPresenceLayer({ presence }: { presence: ChartPresence }) {
  const { actors } = useSyncExternalStore(presence.subscribe, presence.getState, presence.getState);
  return (
    <g data-chart-presence="" pointerEvents="none">
      {actors.map((a) => (
        <g key={a.id} transform={`translate(${a.x} ${a.y})`} data-actor={a.id}>
          <path d="M0,0 L0,14 L4,10.5 L7,17 L9.5,16 L6.5,9.5 L11.5,9.5 Z" style={{ fill: a.color, stroke: '#ffffff', strokeWidth: 1 }} transform={a.pressed ? 'scale(0.9)' : undefined} />
          <g transform="translate(13 16)">
            <rect x={0} y={0} rx={4} height={18} width={Math.max(28, (a.message ?? a.name).length * 6.4 + 12)} style={{ fill: a.color }} />
            <text x={6} y={9} dominantBaseline="central" style={{ fill: '#ffffff', fontSize: 11, fontWeight: 600, fontFamily: 'inherit' }}>
              {a.message ?? a.name}
            </text>
          </g>
        </g>
      ))}
    </g>
  );
}

/** The default tooltip content: the category label, then a swatch, name and value per series. */
function ChartTooltipContent({ tooltip }: { tooltip: ChartTooltip }) {
  return (
    <>
      {tooltip.title && <div className="mb-1 font-medium">{tooltip.title}</div>}
      {tooltip.items.map((item) => (
        <div key={item.seriesId} className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: item.color }} />
          <span style={{ color: 'var(--muted-foreground, #64748b)' }}>{item.name}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums">{item.text}</span>
        </div>
      ))}
    </>
  );
}

/** A laid-out scene as an SVG (no interaction): for read-only views, streaming and exports. */
export function ChartSceneSvg({ scene, label, className }: { scene: ChartScene; label?: string; className?: string }) {
  return (
    <svg width={scene.width} height={scene.height} viewBox={`0 0 ${scene.width} ${scene.height}`} role="img" aria-label={label} className={`block max-w-full ${className ?? ''}`}>
      {scene.marks.map((m) => renderChartMark(m, scene.theme.fontFamily, false))}
    </svg>
  );
}

interface Frozen {
  valueDomain: ChartPointDrag['valueDomain'];
  valueDomain2: ChartPointDrag['valueDomain2'] | null;
  xDomain: ChartPointDrag['xDomain'] | null;
  readout: ChartPointDrag['target'];
}

/**
 * Draws a chart controller's spec as SVG. Click a mark to select it, drag a bar or point to
 * change its value (one undo step; Alt for fine steps, Shift to keep one axis on scatter
 * charts, Ctrl / ⌘ to skip snapping, Escape to cancel), and with the chart focused use
 * ← → ↑ ↓, Delete and Escape (see `handleChartKey`).
 */
export function ChartCanvas({ controller, width = 640, height = 400, responsive = true, theme, editable = true, measureText, emptyMessage, className, presence, sceneRef, tooltip = false, renderTooltip }: ChartCanvasProps) {
  const state = useChartState(controller);
  const wrapper = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<ChartPointDrag | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  // Frozen while a point is dragged so the axes do not rescale under the pointer.
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const tooltipMode: ChartTooltipMode | null = tooltip === true ? 'point' : tooltip || null;
  const [tip, setTip] = useState<ChartTooltip | null>(null);
  // In wrapper pixels; `flip` puts the tooltip left of the pointer near the right edge.
  const [tipAt, setTipAt] = useState({ left: 0, top: 0, flip: false });

  useEffect(() => {
    const el = wrapper.current;
    if (!responsive || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setMeasured(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [responsive]);

  const sceneWidth = (responsive && measured) || width;
  const fullTheme = useMemo(() => ({ ...CSS_VARIABLE_CHART_THEME, ...theme }), [theme]);
  const scene = useMemo(
    () =>
      layoutChart(state.spec, {
        width: sceneWidth,
        height,
        theme: fullTheme,
        selection: editable ? state.selection : null,
        measureText,
        emptyMessage,
        valueDomain: frozen?.valueDomain,
        valueDomain2: frozen?.valueDomain2,
        xDomain: frozen?.xDomain,
        readout: frozen?.readout,
        raceFrame: state.raceFrame,
      }),
    [state.spec, state.selection, state.raceFrame, sceneWidth, height, fullTheme, editable, measureText, emptyMessage, frozen],
  );
  if (sceneRef) sceneRef.current = scene;
  const byKey = useMemo(() => new Map(scene.marks.map((m) => [m.key, m])), [scene]);

  useEffect(() => () => drag.current?.end(), []);

  const scenePoint = (e: React.PointerEvent) => chartClientToScene(scene, svg.current!.getBoundingClientRect(), e.clientX, e.clientY);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editable || e.button !== 0) return;
    const key = (e.target as Element).closest?.('[data-chart-key]')?.getAttribute('data-chart-key');
    const target = key ? byKey.get(key)?.target : undefined;
    controller.select(target ?? null);
    drag.current = startChartPointDrag(controller, scene, target, scenePoint(e));
    if (drag.current) {
      const d = drag.current;
      setTip(null);
      setFrozen({ valueDomain: d.valueDomain, valueDomain2: d.valueDomain2 ?? null, xDomain: d.xDomain ?? null, readout: d.target });
      svg.current?.setPointerCapture?.(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current) drag.current.move(scenePoint(e), { fine: e.altKey, lockAxis: e.shiftKey, noSnap: e.ctrlKey || e.metaKey });
    hover(e);
  };
  const hover = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!tooltipMode || drag.current || !wrapper.current) {
      setTip(null);
      return;
    }
    const next = chartTooltipAt(state.spec, scene, scenePoint(e), { mode: tooltipMode, measureText });
    setTip((prev) => (sameChartTooltip(prev, next) ? prev : next));
    if (!next) return;
    const box = wrapper.current.getBoundingClientRect();
    const left = e.clientX - box.left;
    setTipAt({ left, top: e.clientY - box.top, flip: left > box.width * 0.6 });
  };
  const endDrag = () => {
    drag.current?.end();
    drag.current = null;
    setFrozen(null);
  };
  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (drag.current && e.key === 'Escape') {
      drag.current.cancel();
      drag.current = null;
      setFrozen(null);
      e.preventDefault();
      return;
    }
    if (editable && handleChartKey(controller, scene, e)) e.preventDefault();
  };

  const label = state.spec.title || 'Chart';
  return (
    <div ref={wrapper} className={`relative w-full ${className ?? ''}`} data-chart-canvas="">
      <svg
        ref={svg}
        width={sceneWidth}
        height={height}
        viewBox={`0 0 ${scene.width} ${scene.height}`}
        role="img"
        aria-label={editable ? `${label}. ${describeChartSelection(controller, state.selection)}` : label}
        tabIndex={editable ? 0 : undefined}
        className="block max-w-full touch-none select-none rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setTip(null)}
        onKeyDown={onKeyDown}
      >
        {scene.marks.map((m) => renderChartMark(m, scene.theme.fontFamily, editable))}
        {presence && <ChartPresenceLayer presence={presence} />}
      </svg>
      {tip && (
        <div
          role="tooltip"
          data-chart-tooltip=""
          className="pointer-events-none absolute z-10 min-w-32 rounded-md border px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: tipAt.left,
            top: tipAt.top,
            transform: `translate(${tipAt.flip ? 'calc(-100% - 12px)' : '12px'}, calc(-100% - 8px))`,
            background: 'var(--popover, var(--background, #ffffff))',
            color: 'var(--popover-foreground, var(--foreground, #0f172a))',
            borderColor: 'var(--border, #e2e8f0)',
            fontFamily: scene.theme.fontFamily,
          }}
        >
          {renderTooltip ? renderTooltip(tip) : <ChartTooltipContent tooltip={tip} />}
        </div>
      )}
    </div>
  );
}
