import React, { useEffect, useMemo, useState } from 'react';
import type { ImageEditorController, ImageHistogram } from '@pixerate/editor/image-editor';
import { histogramPath } from '@pixerate/editor/image-editor';

export interface HistogramProps {
  histogram: ImageHistogram | null;
  /** `rgb` overlays the three channels on the luminance; a single channel draws just that one. */
  channel?: 'rgb' | 'luminance' | 'red' | 'green' | 'blue';
  height?: number;
  className?: string;
  style?: React.CSSProperties;
}

const FILL: Record<'luminance' | 'red' | 'green' | 'blue', string> = {
  luminance: 'rgba(148, 163, 184, 0.45)',
  red: 'rgba(239, 68, 68, 0.45)',
  green: 'rgba(34, 197, 94, 0.45)',
  blue: 'rgba(59, 130, 246, 0.45)',
};

const W = 256;

/** SVG histogram of an image (see `computeHistogram` / `controller.subscribeHistogram`). */
export const Histogram: React.FC<HistogramProps> = ({ histogram, channel = 'rgb', height = 64, className = '', style }) => {
  const channels = channel === 'rgb' ? (['luminance', 'red', 'green', 'blue'] as const) : ([channel] as const);
  const paths = useMemo(
    () => (histogram && histogram.samples > 0 ? channels.map((c) => ({ c, d: histogramPath(histogram, c, W, height) })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [histogram, channel, height]
  );
  const clipLow = histogram && histogram.samples ? Math.max(...histogram.shadows) / histogram.samples : 0;
  const clipHigh = histogram && histogram.samples ? Math.max(...histogram.highlights) / histogram.samples : 0;
  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={histogram ? `Histogram of ${histogram.samples} pixels` : 'Histogram (no data)'}
      data-testid="image-editor-histogram"
      className={`w-full rounded bg-slate-950/60 ${className}`}
      style={{ height, ...style }}
    >
      {paths.map(({ c, d }) => (
        <path key={c} d={d} fill={FILL[c]} stroke="none" />
      ))}
      {clipLow > 0.005 && <rect x={0} y={0} width={3} height={height} fill="#3b82f6" data-testid="histogram-clip-shadows" />}
      {clipHigh > 0.005 && <rect x={W - 3} y={0} width={3} height={height} fill="#ef4444" data-testid="histogram-clip-highlights" />}
    </svg>
  );
};

/** The preview histogram of an image editor, updated after every render. */
export function useImageHistogram(controller: ImageEditorController): ImageHistogram | null {
  const [histogram, setHistogram] = useState<ImageHistogram | null>(() => controller.getHistogram());
  useEffect(() => controller.subscribeHistogram(setHistogram), [controller]);
  return histogram;
}
