import React, { useEffect, useRef, useState } from 'react';
import { readVideoScopesPanel, VIDEO_SCOPE_KINDS, type VideoEditorController, type VideoScopeKind, type VideoScopesPanelReading } from '@pixerate/editor/video-editor';

export interface VideoScopesProps {
  controller: VideoEditorController;
  /** Which scopes to show, in order (default histogram, waveform and vectorscope). */
  scopes?: readonly VideoScopeKind[];
  /** Size of the histogram and waveform in pixels (default 256 × 128); the vectorscope is square, `height` a side. */
  width?: number;
  height?: number;
  className?: string;
}

const LABELS: Record<VideoScopeKind, string> = { histogram: 'Histogram', waveform: 'Luma waveform', vectorscope: 'Vectorscope' };
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/**
 * Colour scopes of what the controller's `<VideoPreview>` draws: a histogram, a luma waveform and a
 * vectorscope, redrawn after each frame, with exposure and clipping figures and notes. Reads the
 * preview through `controller.previewPixels`, so it needs a preview of the same controller.
 */
export function VideoScopes({ controller, scopes = VIDEO_SCOPE_KINDS, width = 256, height = 128, className = '' }: VideoScopesProps) {
  const canvases = useRef<Partial<Record<VideoScopeKind, HTMLCanvasElement | null>>>({});
  const [reading, setReading] = useState<VideoScopesPanelReading>(() => ({ ok: false, message: 'Show the preview to see its scopes.' }));
  const key = scopes.join(',');
  useEffect(() => {
    const feed = controller.previewPixels;
    let frame = 0;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16) as unknown as number;
    const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (id: number) => clearTimeout(id);
    const draw = () => {
      frame = 0;
      const next = readVideoScopesPanel(feed, scopes, { width, height });
      setReading(next);
      if (!next.ok) return;
      for (const kind of scopes) {
        const img = next.images[kind];
        const ctx = canvases.current[kind]?.getContext('2d');
        if (img && ctx && typeof ImageData !== 'undefined') ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      }
    };
    // At most one reading a frame, however often the preview draws.
    const schedule = () => {
      if (!frame) frame = raf(draw);
    };
    schedule();
    const off = feed.subscribe(schedule);
    return () => {
      off();
      if (frame) caf(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, key, width, height]);

  return (
    <div className={`flex flex-col gap-2 text-xs ${className}`} data-video-scopes="">
      <div className="flex flex-wrap gap-2">
        {scopes.map((kind) => {
          const w = kind === 'vectorscope' ? height : width;
          return (
            <figure key={kind} className="m-0 flex min-w-0 max-w-full flex-col gap-1">
              <canvas ref={(el) => void (canvases.current[kind] = el)} width={w} height={height} className="rounded border border-border bg-black" style={{ width: w, maxWidth: '100%', height: 'auto', aspectRatio: `${w} / ${height}` }} aria-label={LABELS[kind]} data-scope={kind} />
              <figcaption className="text-[11px] text-muted-foreground">{LABELS[kind]}</figcaption>
            </figure>
          );
        })}
      </div>
      {reading.ok ? (
        <div className="flex flex-col gap-0.5" data-scope-stats="">
          <div className="tabular-nums">
            Luma {reading.stats.luma.mean.toFixed(2)} mean · {reading.stats.luma.p1.toFixed(2)}–{reading.stats.luma.p99.toFixed(2)} · crushed {pct(reading.stats.clipped.shadows)} · blown {pct(reading.stats.clipped.highlights)} · average{' '}
            <span className="inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: reading.stats.average }} /> {reading.stats.average}
            {!reading.complete && <span className="text-muted-foreground"> · loading</span>}
          </div>
          {reading.notes.map((n) => (
            <div key={n} className="text-amber-500">
              {n}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground" data-scope-message="">
          {reading.message}
        </div>
      )}
    </div>
  );
}
