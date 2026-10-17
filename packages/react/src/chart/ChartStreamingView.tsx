import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CSS_VARIABLE_CHART_THEME,
  ChartStream,
  blendChartScenes,
  easeChartTween,
  layoutChart,
  layoutSparkline,
  type ChartScene,
  type ChartSparklineOptions,
  type ChartStreamFormat,
  type ChartTheme,
  type ChartValue,
} from '@pixerate/editor/chart';
import { ChartSceneSvg } from './ChartCanvas';

export interface ChartStreamingViewProps {
  /** Mermaid (xychart-beta, pie, radar-beta) or a JSON chart spec, as far as it has arrived. */
  source: string;
  /** Nothing more will arrive: the final chart is drawn at once and problems are reported. */
  complete?: boolean;
  format?: ChartStreamFormat;
  width?: number;
  height?: number;
  theme?: Partial<ChartTheme>;
  /** How often a new layout is adopted while streaming (ms, default 300). */
  adoptInterval?: number;
  /** Tween length between layouts (ms, default 450; 0 to switch at once). */
  tween?: number;
  /** Shown before anything can be drawn. */
  placeholder?: React.ReactNode;
  /** Called with the parse problems once `complete`. */
  onIssues?: (issues: { message: string; line?: number }[]) => void;
  className?: string;
}

/**
 * Draws a chart whose source is still arriving (e.g. from a model): series appear as their
 * values come in, the value axis only grows so it does not jump, and each new layout tweens
 * from the last. Read-only; load the final spec into a `ChartController` to edit it.
 */
export function ChartStreamingView({ source, complete = false, format = 'auto', width = 640, height = 360, theme, adoptInterval = 300, tween = 450, placeholder, onIssues, className }: ChartStreamingViewProps) {
  const stream = useMemo(() => new ChartStream(format), [format]);
  const fullTheme = useMemo(() => ({ ...CSS_VARIABLE_CHART_THEME, ...theme }), [theme]);
  const [scene, setScene] = useState<ChartScene | null>(null);
  const shown = useRef<ChartScene | null>(null);
  const lastAdopt = useRef(0);
  const frame = useRef<number | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const adopt = () => {
      const read = stream.update(source, complete);
      if (complete && onIssues) onIssues(read.issues);
      if (!read.spec) return;
      const next = layoutChart(read.spec, { width, height, theme: fullTheme, valueDomain: read.valueDomain });
      const from = shown.current;
      lastAdopt.current = Date.now();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (!from || tween <= 0 || typeof requestAnimationFrame === 'undefined') {
        shown.current = next;
        setScene(next);
        return;
      }
      const start = performance.now();
      const step = () => {
        const t = easeChartTween((performance.now() - start) / tween);
        const s = blendChartScenes(from, next, t);
        shown.current = s;
        setScene(s);
        frame.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      frame.current = requestAnimationFrame(step);
    };
    if (pending.current) clearTimeout(pending.current);
    const wait = complete ? 0 : Math.max(0, adoptInterval - (Date.now() - lastAdopt.current));
    if (wait === 0) adopt();
    else pending.current = setTimeout(adopt, wait);
    return () => {
      if (pending.current) clearTimeout(pending.current);
    };
  }, [source, complete, stream, width, height, fullTheme, adoptInterval, tween, onIssues]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  return (
    <div className={className} data-chart-streaming={complete ? 'complete' : 'streaming'} aria-busy={!complete}>
      {scene ? <ChartSceneSvg scene={scene} label={complete ? undefined : 'Chart loading'} /> : (placeholder ?? <div style={{ height }} className="flex items-center justify-center text-xs text-muted-foreground">Drawing chart…</div>)}
    </div>
  );
}

export interface ChartSparklineProps extends Omit<ChartSparklineOptions, 'width' | 'height'> {
  values: readonly ChartValue[];
  width?: number;
  height?: number;
  /** Accessible label (default: first and last value). */
  label?: string;
  className?: string;
}

/** A word-sized chart: line, column or win/loss. */
export function ChartSparkline({ values, width = 80, height = 20, label, className, ...options }: ChartSparklineProps) {
  const scene = useMemo(() => layoutSparkline(values, { ...options, width, height }), [values, width, height, options.kind, options.color, options.negativeColor, options.markers, options.highLow, options.min, options.max]);
  const present = values.filter((v): v is number => v !== null);
  return <ChartSceneSvg scene={scene} label={label ?? (present.length ? `Trend from ${present[0]} to ${present[present.length - 1]}` : 'No data')} className={`inline-block align-middle ${className ?? ''}`} />;
}
