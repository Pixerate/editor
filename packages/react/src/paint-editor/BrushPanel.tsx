import React, { useMemo, useRef, useState } from 'react';
import {
  BLEND_MENU_GROUPS,
  BRUSH_ROTATIONS,
  BRUSH_SLIDERS,
  brushEngineControls,
  brushLoadColor,
  downloadBytes,
  brushTakesPaint,
  patchBrushValue,
  patchPath,
  readPath,
  WET_TOOLS,
  WET_TOOL_LABELS,
  WET_MEDIA,
  WET_MEDIUM_LABELS,
  IMPASTO_TOOLS,
  IMPASTO_TOOL_LABELS,
  PARTICLE_KINDS,
  PARTICLE_KIND_LABELS,
  PARTICLE_RENDERS,
  PARTICLE_RENDER_LABELS,
  STAMP_KINDS,
  STAMP_LABELS,
  toggleStamp,
  type ParticleKind,
  type ParticleRender,
  type ImpastoTool,
  type WetMediumKind,
  type BlendMode,
  type BrushRotation,
  type WetTool,
  type PaintEditorController,
} from '@pixerate/editor/paint-editor';
import { DEFAULT_PAINT_GRADIENT } from '@pixerate/editor/paint-editor';
import { PaintGradientEditor } from './PaintGradientEditor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, PaintSlider, PixelCanvas, button, chip, panel, useAttempt } from './shared';

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
 * angle, paper grain, position and pressure smoothing, dynamics, rotation mode and blend mode;
 * then the engine's own controls (`brushEngineControls`): blender strength and blend distance,
 * smudge strength and length, pick-up and mix ratios, RGB / pigment mixing, dirty brush,
 * the brush's own gradient paint (the multi-colour brush) and the brush load. Save the edited brush, import and export libraries as JSON.
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
  const engine = brushEngineControls(brush);
  const carried = brushLoadColor(state.mixerLoad);
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
        {brush.engine === 'dab' && (
          <label className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Blend</span>
            <select aria-label="Brush blend" value={brush.tip.blend} onChange={(e) => controller.setBrush({ tip: { blend: e.target.value as BlendMode } })} className="rounded bg-slate-800 px-1 py-0.5">
              {BLEND_MENU_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.modes.map((m) => (
                    <option key={m.id} value={m.id} title={m.description}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
      </div>
      {engine && (
        <div className="flex flex-col gap-1.5" data-testid="brush-engine">
          <span className="font-medium text-slate-300">{engine.title}</span>
          {engine.wetTool && (
            <label className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Wet tool</span>
              <select aria-label="Wet tool" value={brush.wet.tool} onChange={(e) => controller.setBrush({ wet: { tool: e.target.value as WetTool } })} className="rounded bg-slate-800 px-1 py-0.5">
                {WET_TOOLS.map((t) => (
                  <option key={t} value={t}>
                    {WET_TOOL_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {engine.wetTool && (
            <label className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Medium</span>
              <select aria-label="Wet medium" value={brush.wet.medium} onChange={(e) => controller.setBrush({ wet: { medium: e.target.value as WetMediumKind } })} className="rounded bg-slate-800 px-1 py-0.5">
                {WET_MEDIA.map((m) => (
                  <option key={m} value={m}>
                    {WET_MEDIUM_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {engine.particleMenus && (
            <>
              <label className="flex items-center justify-between gap-2">
                <span className="text-slate-400">Particles</span>
                <select aria-label="Particle kind" value={brush.particle.kind} onChange={(e) => controller.setBrush({ particle: { kind: e.target.value as ParticleKind } })} className="rounded bg-slate-800 px-1 py-0.5">
                  {PARTICLE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {PARTICLE_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-slate-400">Drawn as</span>
                <select aria-label="Particle render" value={brush.particle.render} onChange={(e) => controller.setBrush({ particle: { render: e.target.value as ParticleRender } })} className="rounded bg-slate-800 px-1 py-0.5">
                  {PARTICLE_RENDERS.map((k) => (
                    <option key={k} value={k}>
                      {PARTICLE_RENDER_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {engine.stickerStamps && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Sticker stamps">
              {STAMP_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={brush.sticker.stamps.includes(k)}
                  className={`px-1.5 py-0.5 rounded text-[10px] ${brush.sticker.stamps.includes(k) ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                  onClick={() => controller.setBrush({ sticker: { stamps: toggleStamp(brush.sticker.stamps, k) } })}
                >
                  {STAMP_LABELS[k]}
                </button>
              ))}
            </div>
          )}
          {engine.impastoTool && (
            <label className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Tool</span>
              <select aria-label="Impasto tool" value={brush.impasto.tool} onChange={(e) => controller.setBrush({ impasto: { tool: e.target.value as ImpastoTool } })} className="rounded bg-slate-800 px-1 py-0.5">
                {IMPASTO_TOOLS.map((t) => (
                  <option key={t} value={t}>
                    {IMPASTO_TOOL_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {engine.sliders.map((c) => (
            <PaintSlider key={c.path} control={c} value={readPath(brush, c.path)} onChange={(v) => controller.setBrush(patchPath(brush as never, c.path, v) as never)} />
          ))}
          {engine.mixingPath && (
            <label className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Mixing</span>
              <select
                aria-label="Brush mixing"
                value={engine.mixingPath === 'blender.mixing' ? brush.blender.mixing : engine.mixingPath === 'smudge.mixing' ? brush.smudge.mixing : brush.behavior.mixing}
                onChange={(e) => controller.setBrush(patchBrushValue(brush, engine.mixingPath!, e.target.value))}
                className="rounded bg-slate-800 px-1 py-0.5"
              >
                <option value="pigment">Pigment</option>
                <option value="rgb">RGB</option>
              </select>
            </label>
          )}
          {engine.dirty && (
            <label className="flex items-center gap-2" title="Keep the colour the brush picked up for the next stroke (needs Pick-up above 0)">
              <input type="checkbox" aria-label="Dirty brush" checked={brush.behavior.dirty} onChange={(e) => controller.setBrush({ behavior: { dirty: e.target.checked } })} /> Dirty brush
            </label>
          )}
          {brushTakesPaint(brush) && (
            <div className="flex flex-col gap-1.5" data-testid="brush-gradient">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-400" title="A gradient of the brush's own, used instead of the paint (the multi-colour brush)">
                  Brush gradient
                </span>
                <button
                  type="button"
                  aria-pressed={brush.paint !== null}
                  className={chip(brush.paint !== null)}
                  onClick={() => attempt(() => controller.setBrush({ paint: brush.paint ? null : DEFAULT_PAINT_GRADIENT }))}
                >
                  {brush.paint ? 'On' : 'Off'}
                </button>
              </div>
              {brush.paint && <PaintGradientEditor value={brush.paint} colors={{ paint: state.color, secondary: state.secondaryColor }} onChange={(g) => attempt(() => controller.setBrush({ paint: g }))} />}
            </div>
          )}
          {engine.load && (
            <div className="flex items-center gap-1">
              <span className="text-slate-400">Carries</span>
              <span aria-label="Brush load" title={carried ?? 'Clean'} className="h-4 w-4 rounded ring-1 ring-slate-700" style={{ background: carried ?? 'transparent' }} />
              {brush.engine === 'mixer' && (
                <button type="button" className={button} onClick={() => controller.loadMixerBrush()}>
                  Load
                </button>
              )}
              <button type="button" className={button} onClick={() => controller.cleanMixerBrush(brush.engine === 'mixer')}>
                Clean
              </button>
            </div>
          )}
        </div>
      )}
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
