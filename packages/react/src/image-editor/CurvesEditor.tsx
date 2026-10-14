import React, { useRef, useState } from 'react';
import type { CurvePoint, ImageHistogram } from '@pixerate/editor/image-editor';
import {
  boxToCurvePoint,
  curvePointToBox,
  curveSvgPath,
  hitTestCurvePoint,
  histogramPath,
  insertCurvePoint,
  moveCurvePoint,
  removeCurvePoint,
} from '@pixerate/editor/image-editor';

export interface CurvesEditorProps {
  points: CurvePoint[];
  /** `commit` is true for the first change of a gesture (one undo step), false for the drag moves. */
  onChange: (points: CurvePoint[], commit: boolean) => void;
  histogram?: ImageHistogram | null;
  channel?: 'master' | 'red' | 'green' | 'blue';
  size?: number;
}

const BOX = 256;
const STROKE = { master: '#e2e8f0', red: '#ef4444', green: '#22c55e', blue: '#3b82f6' };

/**
 * Curves editor over the histogram: click to add a point, drag to move it, double-click to
 * remove it.
 */
export const CurvesEditor: React.FC<CurvesEditorProps> = ({ points, onChange, histogram, channel = 'master', size = 200 }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const toBox = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return { x: 0, y: 0 };
    return { x: ((e.clientX - rect.left) / rect.width) * BOX, y: ((e.clientY - rect.top) / rect.height) * BOX };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = toBox(e);
    let index = hitTestCurvePoint(points, x, y, BOX, BOX, 10);
    if (index === -1) {
      const inserted = insertCurvePoint(points, boxToCurvePoint(x, y, BOX, BOX));
      onChange(inserted.points, true);
      index = inserted.index;
    } else {
      onChange(points, true);
    }
    setDrag(index);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag === null) return;
    onChange(moveCurvePoint(points, drag, boxToCurvePoint(toBox(e).x, toBox(e).y, BOX, BOX)), false);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = toBox(e);
    const index = hitTestCurvePoint(points, x, y, BOX, BOX, 10);
    if (index !== -1 && points.length > 2) onChange(removeCurvePoint(points, index), true);
  };

  const histChannel = channel === 'master' ? 'luminance' : channel;
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${BOX} ${BOX}`}
      width={size}
      height={size}
      role="application"
      aria-label={`${channel} curve`}
      data-testid="curves-editor"
      className="rounded bg-slate-950/70 touch-none select-none cursor-crosshair"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
      onDoubleClick={onDoubleClick}
    >
      {histogram && histogram.samples > 0 && (
        <path d={histogramPath(histogram, histChannel, BOX, BOX)} fill="rgba(148, 163, 184, 0.25)" />
      )}
      {[64, 128, 192].map((v) => (
        <g key={v} stroke="rgba(148, 163, 184, 0.2)" strokeWidth={1}>
          <line x1={v} y1={0} x2={v} y2={BOX} />
          <line x1={0} y1={v} x2={BOX} y2={v} />
        </g>
      ))}
      <line x1={0} y1={BOX} x2={BOX} y2={0} stroke="rgba(148, 163, 184, 0.35)" strokeDasharray="4 4" />
      <path d={curveSvgPath(points, BOX, BOX)} fill="none" stroke={STROKE[channel]} strokeWidth={2} />
      {points.map((p, i) => {
        const b = curvePointToBox(p, BOX, BOX);
        return (
          <circle
            key={i}
            cx={b.x}
            cy={b.y}
            r={5}
            fill={drag === i ? STROKE[channel] : '#0f172a'}
            stroke={STROKE[channel]}
            strokeWidth={2}
            aria-label={`Point ${p.input} to ${p.output}`}
          />
        );
      })}
    </svg>
  );
};
