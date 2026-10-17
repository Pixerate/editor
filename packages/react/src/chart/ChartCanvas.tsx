import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CSS_VARIABLE_CHART_THEME,
  chartClientToScene,
  chartTextBaseline,
  chartTextTransform,
  describeChartSelection,
  handleChartKey,
  layoutChart,
  startChartPointDrag,
  type ChartController,
  type ChartMark,
  type ChartPointDrag,
  type ChartTextMeasure,
  type ChartTheme,
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
}

/** SVG attributes for one mark (colours go in `style` so CSS variables work). */
function renderMark(mark: ChartMark, fontFamily: string, interactive: boolean): React.ReactNode {
  const common = {
    'data-role': mark.role,
    'data-chart-key': mark.target ? mark.key : undefined,
    'data-selected': mark.selected ? '' : undefined,
    opacity: mark.opacity,
    pointerEvents: mark.role === 'selection' || (!mark.target && mark.role !== 'background') ? ('none' as const) : undefined,
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

/**
 * Draws a chart controller's spec as SVG. Click a mark to select it, drag a bar or point to
 * change its value (one undo step), and with the chart focused use ← → ↑ ↓, Delete and
 * Escape (see `handleChartKey`).
 */
export function ChartCanvas({ controller, width = 640, height = 400, responsive = true, theme, editable = true, measureText, emptyMessage, className }: ChartCanvasProps) {
  const state = useChartState(controller);
  const wrapper = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<ChartPointDrag | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  // Frozen while a point is dragged so the value axis does not rescale under the pointer.
  const [valueDomain, setValueDomain] = useState<ChartPointDrag['valueDomain'] | null>(null);

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
    () => layoutChart(state.spec, { width: sceneWidth, height, theme: fullTheme, selection: editable ? state.selection : null, measureText, emptyMessage, valueDomain }),
    [state.spec, state.selection, sceneWidth, height, fullTheme, editable, measureText, emptyMessage, valueDomain],
  );
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
      setValueDomain(drag.current.valueDomain);
      svg.current?.setPointerCapture?.(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current) drag.current.move(scenePoint(e));
  };
  const endDrag = () => {
    drag.current?.end();
    drag.current = null;
    setValueDomain(null);
  };
  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (editable && handleChartKey(controller, scene, e)) e.preventDefault();
  };

  const label = state.spec.title || 'Chart';
  return (
    <div ref={wrapper} className={`w-full ${className ?? ''}`} data-chart-canvas="">
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
        onKeyDown={onKeyDown}
      >
        {scene.marks.map((m) => renderMark(m, scene.theme.fontFamily, editable))}
      </svg>
    </div>
  );
}
