import React, { useMemo, useRef } from 'react';
import { brushLoadColor, brushTakesPaint, downloadBytes, toggleStickerRef, DEFAULT_PAINT_GRADIENT, type PaintEditorController } from '@pixerate/editor/paint-editor';
import { brushColourHex, PAINT_PROFILE, type Brush, type BrushLibraryEntry } from '@pixerate/editor/brushes';
import { BrushEditor } from '../brushes/BrushEditor';
import { BrushLibraryBrowser } from '../brushes/BrushLibraryBrowser';
import { PaintGradientEditor } from './PaintGradientEditor';
import { StickerPicker } from './StickerPicker';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, button, chip, panel, useAttempt } from './shared';

export interface BrushPanelProps {
  controller: PaintEditorController;
  /** Thumbnail size in px (default 112 × 32). */
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  className?: string;
}

/**
 * The brush library (`BrushLibraryBrowser`: thumbnails of a test stroke on the current paper,
 * grouped by medium and variety, tools apart) and the active brush in the `BrushEditor`: its
 * facets with a live preview, and "Save brush" into the editor's brush library. The paint
 * editor adds the brush's own gradient, the sticker stamps, what the brush carries (Load /
 * Clean), and import and export of library files.
 */
export const BrushPanel: React.FC<BrushPanelProps> = ({ controller, thumbnailWidth = 112, thumbnailHeight = 32, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const fileRef = useRef<HTMLInputElement>(null);
  const { brush, brushes } = state;
  const paper = state.document.paper;
  const thumbs = useMemo(
    () => new Map(brushes.map((b) => [b.id, controller.brushThumbnail(b.id, { width: thumbnailWidth, height: thumbnailHeight, color: '#26324a' })])),
    // Thumbnails follow the library and the paper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, brushes, paper, thumbnailWidth, thumbnailHeight]
  );
  const entries = useMemo<BrushLibraryEntry[]>(() => brushes.map((b) => ({ brush: controller.getBrushSpec(b.id)!, builtin: Boolean(b.builtin) })), [controller, brushes]);
  // The active brush as facets and its preview follow every change to it.
  const spec = useMemo<Brush>(() => controller.getBrushSpec()!, [controller, brush]);
  // Previewed in the brush's own default colour when it has one, else the paint colour.
  const own = typeof spec.colour?.default === 'string' && /^#[0-9a-f]{6}/i.test(spec.colour.default) ? spec.colour.default.slice(0, 7) : undefined;
  const preview = useMemo(() => controller.brushThumbnail(brush.id, { width: 240, height: 64, color: own }), [controller, brush, paper, state.color, own]);
  const carried = brushLoadColor(state.mixerLoad);
  // The brush's suggested colours, resolved for the colour scheme: one click makes one the paint colour.
  const palette = (spec.colour?.palette ?? []).flatMap((c) => brushColourHex(c, state.colorScheme) ?? []);
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'brush';
  const loads = ['dab', 'mixer', 'impasto'].includes(brush.engine) || (brush.engine === 'wet' && brush.wet.tool === 'paint');

  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="brush-panel">
      <BrushLibraryBrowser entries={entries} activeId={brush.id} onSelect={(id) => controller.setBrush({ id })} thumbnail={(id) => thumbs.get(id) ?? null} thumbnailWidth={thumbnailWidth} thumbnailHeight={thumbnailHeight} />
      <BrushEditor
        brush={spec}
        profile={PAINT_PROFILE}
        preview={preview}
        onChange={(next) => attempt(() => controller.setBrushSpec(next))}
        onSaveAs={(name) => controller.saveBrush({ id: slug(name), name })}
        renderExtra={(section) => {
          if (section === 'shape' && brush.engine === 'sticker')
            return <StickerPicker controller={controller} label="Sticker stamps" selected={brush.sticker.stamps} onPick={(ref) => controller.setBrush({ sticker: { stamps: toggleStickerRef(brush.sticker.stamps, ref) } })} />;
          if (section === 'behaviour' && loads)
            return (
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
            );
          if (section === 'colour')
            return (
              <>
                {palette.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Paint with a palette colour">
                    {palette.map((hex, i) => (
                      <button key={`${hex}-${i}`} type="button" aria-label={`Paint with ${hex}`} title={hex} aria-pressed={state.color === hex} className={`h-5 w-5 rounded ring-1 ${state.color === hex ? 'ring-white' : 'ring-slate-700'}`} style={{ background: hex }} onClick={() => controller.setColor(hex)} />
                    ))}
                  </div>
                )}
                <label className="flex items-center gap-2" title="Choosing a brush with a default colour (the highlighter's yellow) makes it your colour unless this is on">
                  <input type="checkbox" aria-label="Keep my colour" checked={state.colorLocked} onChange={(e) => controller.setColorLocked(e.target.checked)} /> Keep my colour when choosing a brush
                </label>
                {brushTakesPaint(brush) && (
              <div className="flex flex-col gap-1.5" data-testid="brush-gradient">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400" title="A gradient of the brush's own, used instead of the paint (the multi-colour brush)">
                    Brush gradient
                  </span>
                  <button type="button" aria-pressed={brush.paint !== null} className={chip(brush.paint !== null)} onClick={() => attempt(() => controller.setBrush({ paint: brush.paint ? null : DEFAULT_PAINT_GRADIENT }))}>
                    {brush.paint ? 'On' : 'Off'}
                  </button>
                </div>
                {brush.paint && <PaintGradientEditor value={brush.paint} colors={{ paint: state.color, secondary: state.secondaryColor }} onChange={(g) => attempt(() => controller.setBrush({ paint: g }))} />}
              </div>
                )}
              </>
            );
          return null;
        }}
      />
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className={button} onClick={() => attempt(async () => downloadBytes(JSON.stringify(await controller.exportBrushes(), null, 2), 'brushes.json', 'application/json'))}>
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
