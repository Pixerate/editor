import React, { useMemo, useRef, useState } from 'react';
import { BRUSH_ROTATIONS, BRUSH_SLIDERS, downloadBytes, patchPath, readPath, type BrushRotation, type PaintEditorController } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, PaintSlider, PixelCanvas, button, panel, useAttempt } from './shared';

export interface BrushPanelProps {
  controller: PaintEditorController;
  /** Thumbnail size in px (default 112 × 32). */
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  className?: string;
}

/**
 * The brush library (thumbnails rendered from a test stroke on the current paper, grouped by
 * category) and the active brush's settings: size, opacity, flow, hardness, spacing, roundness,
 * angle, paper grain, position and pressure smoothing, dynamics and rotation mode. Save the edited
 * brush, import and export libraries as JSON.
 */
export const BrushPanel: React.FC<BrushPanelProps> = ({ controller, thumbnailWidth = 112, thumbnailHeight = 32, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const [saveName, setSaveName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const { brush, brushes } = state;
  const paper = state.document.paper;
  const thumbs = useMemo(
    () => new Map(brushes.map((b) => [b.id, controller.brushThumbnail(b.id, { width: thumbnailWidth, height: thumbnailHeight, color: '#26324a' })])),
    // Thumbnails follow the library and the paper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, brushes, paper, thumbnailWidth, thumbnailHeight]
  );
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'brush';

  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="brush-panel">
      <div className="grid grid-cols-2 gap-1" role="listbox" aria-label="Brushes">
        {brushes.map((b) => (
          <button
            key={b.id}
            type="button"
            role="option"
            aria-selected={brush.id === b.id}
            title={`${b.name} (${b.category})`}
            className={`flex flex-col items-start gap-0.5 rounded p-1 text-left ${brush.id === b.id ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'bg-slate-900 hover:bg-slate-800'}`}
            onClick={() => controller.setBrush({ id: b.id })}
          >
            <PixelCanvas pixels={thumbs.get(b.id) ?? null} label={`${b.name} thumbnail`} className="rounded" style={{ width: '100%', aspectRatio: `${thumbnailWidth} / ${thumbnailHeight}` }} />
            <span className="truncate text-[10px] text-slate-300">{b.name}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        {BRUSH_SLIDERS.map((c) => (
          <PaintSlider key={c.path} control={c} value={readPath(brush, c.path)} onChange={(v) => controller.setBrush(patchPath(brush as never, c.path, v) as never)} />
        ))}
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-400">Rotation</span>
          <select aria-label="Brush rotation" value={brush.rotation} onChange={(e) => controller.setBrush({ rotation: e.target.value as BrushRotation })} className="rounded bg-slate-800 px-1 py-0.5">
            {BRUSH_ROTATIONS.map((r) => (
              <option key={r} value={r}>
                {r === 'stroke' ? 'Follow stroke' : r === 'barrel' ? 'Pen barrel' : 'Fixed'}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={brush.tip.pressureSize} onChange={(e) => controller.setBrush({ tip: { pressureSize: e.target.checked } })} /> Pressure → size
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={brush.tip.pressureOpacity} onChange={(e) => controller.setBrush({ tip: { pressureOpacity: e.target.checked } })} /> Pressure → opacity
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <input value={saveName} placeholder="Brush name" aria-label="Brush name" onChange={(e) => setSaveName(e.target.value)} className="w-28 rounded bg-slate-800 px-1.5 py-0.5" />
        <button type="button" className={button} disabled={!saveName.trim()} onClick={() => attempt(() => (controller.saveBrush({ id: slug(saveName), name: saveName.trim() }), setSaveName('')))}>
          Save brush
        </button>
        <button type="button" className={button} onClick={() => attempt(() => downloadBytes(JSON.stringify(controller.exportBrushes(), null, 2), 'brushes.json', 'application/json'))}>
          Export
        </button>
        <button type="button" className={button} onClick={() => fileRef.current?.click()}>
          Import…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          aria-label="Import brushes"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) attempt(async () => controller.importBrushes(JSON.parse(await f.text())));
            e.target.value = '';
          }}
        />
      </div>
      <ErrorLine error={error} />
    </div>
  );
};
