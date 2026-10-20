import React, { useRef, useState } from 'react';
import type { VectorEditorController } from '@pixerate/editor/vector';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const numberClass = 'h-7 w-12 rounded border border-border bg-background px-1.5 text-xs';

export interface VectorTracePanelProps {
  controller: VectorEditorController;
  className?: string;
}

/** Decodes an image file in the browser into RGBA pixels (at most `max` pixels, scaled down to fit). */
async function filePixels(file: File, max = 1_000_000): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, Math.sqrt(max / (bitmap.width * bitmap.height)));
  const width = Math.max(1, Math.round(bitmap.width * k));
  const height = Math.max(1, Math.round(bitmap.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

/**
 * Image Trace: pick an image file and trace it into paths, in one colour (dark areas) or a stacked
 * path per colour. The traced group goes on the artboard at its width. One undo step.
 */
export function VectorTracePanel({ controller, className }: VectorTracePanelProps) {
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'threshold' | 'color'>('threshold');
  const [colors, setColors] = useState(6);
  const [message, setMessage] = useState<string | null>(null);
  const trace = async (file: File) => {
    try {
      const pixels = await filePixels(file);
      const doc = controller.getState().document;
      const width = Math.min(doc.width, pixels.width);
      const r = controller.traceImage(pixels, { mode, colors, width, name: file.name.replace(/\.[^.]+$/, '') || 'Image Trace' });
      setMessage(r.ok ? null : r.message);
    } catch {
      setMessage('That file could not be read as an image.');
    }
  };
  return (
    <div className={`space-y-1 ${className ?? ''}`} data-vector-trace-panel="" aria-label="Image trace">
      <div className="flex items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Trace</span>
        <select aria-label="Trace mode" className={selectClass} value={mode} onChange={(e) => setMode(e.target.value as 'threshold' | 'color')}>
          <option value="threshold">Black &amp; white</option>
          <option value="color">Colours</option>
        </select>
        {mode === 'color' && (
          <input type="number" min={2} max={32} aria-label="Trace colours" title="Colours" className={numberClass} value={colors} onChange={(e) => setColors(Math.max(2, Math.min(32, parseInt(e.target.value, 10) || 2)))} />
        )}
        <button type="button" className={buttonClass} data-vector-trace-action="" title="Image Trace: pick an image to turn into paths" onClick={() => input.current?.click()}>
          Image…
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void trace(file);
          }}
        />
      </div>
      {message && <p className="text-[11px] text-red-600">{message}</p>}
    </div>
  );
}
