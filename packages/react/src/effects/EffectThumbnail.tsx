import React, { useEffect, useRef, useState } from 'react';
import { renderEffectThumbnail, type EffectProvider, type EffectSummary } from '@pixerate/editor/effects';

export interface EffectThumbnailProps {
  provider: EffectProvider;
  effect: EffectSummary;
  /** Pixel size of the preview (default 96 × 54). */
  width?: number;
  height?: number;
  className?: string;
}

/**
 * A preview of an effect drawn by the provider's own renderer (filters on a sample picture,
 * transitions half way, generators mid-way through). Motion effects, camera moves and failures
 * show a label.
 */
const LABELS: Partial<Record<EffectSummary['kind'], string>> = { motion: 'Motion', camera: 'Camera' };

export function EffectThumbnail({ provider, effect, width = 96, height = 54, className = '' }: EffectThumbnailProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(effect.kind in LABELS);
  useEffect(() => {
    if (effect.kind in LABELS) return;
    let live = true;
    renderEffectThumbnail(provider, effect, { width, height }).then(
      (pixels) => {
        const ctx = live ? ref.current?.getContext('2d') : null;
        if (!ctx || typeof ImageData === 'undefined') return;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [provider, effect, width, height]);
  return (
    <div
      className={`relative overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#8884_0_25%,transparent_0_50%)] bg-[length:12px_12px] ${className}`}
      style={{ aspectRatio: `${width} / ${height}` }}
      data-effect-thumbnail={effect.id}
    >
      {failed ? (
        <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">{LABELS[effect.kind] ?? 'No preview'}</span>
      ) : (
        <canvas ref={ref} width={width} height={height} className="h-full w-full" aria-hidden="true" />
      )}
    </div>
  );
}
