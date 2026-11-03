import React, { useMemo, useState } from 'react';
import { brushEditorSections, PAINT_PROFILE, setBrushEditorValue, type Brush, type BrushEditorControl, type BrushHostProfile } from '@pixerate/editor/brushes';
import { ErrorLine, PaintSlider, PixelCanvas, button, chip } from './shared';

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

export interface BrushEditorProps {
  /** The brush being edited, as facets. */
  brush: Brush;
  /** What the host renders (default the paint editor): other controls are left out. */
  profile?: BrushHostProfile;
  /** Called with the whole brush after each change (normalised). */
  onChange: (brush: Brush) => void;
  /** A live preview stroke of `brush` (e.g. `controller.brushThumbnail`). */
  preview?: Pixels | null;
  /** With it, a name field and "Save brush" save the brush under that name. */
  onSaveAs?: (name: string) => unknown;
  /** Extra controls a host adds to a section (e.g. the sticker picker for stamps). */
  renderExtra?: (section: string) => React.ReactNode;
  className?: string;
}

/**
 * Edits a brush by its facets (`brushEditorSections`): Medium, Shape, Marks, Feel, Behaviour,
 * Light, Motion and Colour, each control a facet, with a live preview stroke and "Save as". Only
 * what the host profile renders is shown; settings it paints without carry a note.
 */
export const BrushEditor: React.FC<BrushEditorProps> = ({ brush, profile = PAINT_PROFILE, onChange, preview, onSaveAs, renderExtra, className }) => {
  const sections = useMemo(() => brushEditorSections(brush, profile), [brush, profile]);
  const [problems, setProblems] = useState<string | null>(null);
  const [name, setName] = useState('');
  const set = (path: string, value: unknown) => {
    const r = setBrushEditorValue(brush, path, value);
    setProblems(r.problems.length ? r.problems.join(' ') : null);
    if (r.brush !== brush) onChange(r.brush);
  };
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`} data-testid="brush-editor">
      {preview !== undefined && <PixelCanvas pixels={preview} label="Brush preview" className="rounded" style={{ width: '100%', aspectRatio: preview ? `${preview.width} / ${preview.height}` : '4 / 1' }} />}
      {sections.map((s) => (
        <section key={s.id} className="flex flex-col gap-1.5" data-section={s.id} {...(s.id === 'behaviour' ? { 'data-testid': 'brush-engine' } : {})}>
          <span className="font-medium text-slate-300">{s.title}</span>
          {s.controls.map((c) => (
            <EditorControl key={c.path} control={c} onSet={set} />
          ))}
          {renderExtra?.(s.id)}
        </section>
      ))}
      {onSaveAs && (
        <div className="flex flex-wrap items-center gap-1">
          <input value={name} placeholder="Brush name" aria-label="Brush name" onChange={(e) => setName(e.target.value)} className="w-28 rounded bg-slate-800 px-1.5 py-0.5" />
          <button
            type="button"
            className={button}
            disabled={!name.trim()}
            onClick={async () => {
              try {
                await onSaveAs(name.trim());
                setName('');
                setProblems(null);
              } catch (e) {
                setProblems((e as Error).message);
              }
            }}
          >
            Save brush
          </button>
        </div>
      )}
      <ErrorLine error={problems} />
    </div>
  );
};

const EditorControl: React.FC<{ control: BrushEditorControl; onSet: (path: string, value: unknown) => void }> = ({ control: c, onSet }) => {
  const note = c.note ? <span className="text-[10px] text-amber-400">{c.note}</span> : null;
  switch (c.kind) {
    case 'slider':
      return (
        <div title={c.note}>
          <PaintSlider control={c} value={c.value} onChange={(v) => onSet(c.path, v)} />
          {note}
        </div>
      );
    case 'choice':
      return (
        <label className="flex items-center justify-between gap-2" title={c.note}>
          <span className="text-slate-400">{c.label}</span>
          <select aria-label={c.ariaLabel} value={c.value} onChange={(e) => onSet(c.path, e.target.value)} className="max-w-[60%] rounded bg-slate-800 px-1 py-0.5">
            {c.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      );
    case 'toggle':
      return (
        <label className="flex items-center gap-2" title={c.note}>
          <input type="checkbox" aria-label={c.ariaLabel} checked={c.value} onChange={(e) => onSet(c.path, e.target.checked)} /> {c.label}
        </label>
      );
    case 'text':
      return (
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-400">{c.label}</span>
          {/* Keyed by its value: another brush's value replaces what was typed. */}
          <input key={c.value} aria-label={c.ariaLabel} defaultValue={c.value} placeholder={c.placeholder} onBlur={(e) => e.target.value !== c.value && onSet(c.path, e.target.value.trim().toLowerCase())} className="w-28 rounded bg-slate-800 px-1.5 py-0.5" />
        </label>
      );
    case 'colour':
      return (
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-400">{c.label}</span>
          <span className="flex items-center gap-1">
            <input type="color" aria-label={c.ariaLabel} value={c.value ?? '#000000'} onChange={(e) => onSet(c.path, e.target.value)} className="h-5 w-8" />
            {c.value && (
              <button type="button" className={button} onClick={() => onSet(c.path, undefined)}>
                None
              </button>
            )}
          </span>
        </div>
      );
    case 'palette':
      return (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={c.ariaLabel}>
          <span className="text-slate-400">{c.label}</span>
          {c.value.map((col, i) => (
            <button key={`${col}-${i}`} type="button" title={`Remove ${col}`} aria-label={`Remove ${col}`} className="h-4 w-4 rounded ring-1 ring-slate-700" style={{ background: col }} onClick={() => onSet(c.path, c.value.filter((_, j) => j !== i))} />
          ))}
          {c.value.length < c.max && <input type="color" aria-label="Add a palette colour" onChange={(e) => onSet(c.path, [...c.value, e.target.value])} className="h-4 w-6" />}
        </div>
      );
    case 'stamps':
      return (
        <div className="flex flex-wrap gap-1" role="group" aria-label={c.ariaLabel} title={`Up to ${c.max}`}>
          {c.options.map((o) => {
            const on = c.value.includes(o.value);
            return (
              <button key={o.value} type="button" aria-pressed={on} className={chip(on)} onClick={() => onSet(c.path, on ? c.value.filter((v) => v !== o.value) : [...c.value, o.value].slice(-c.max))}>
                {o.label}
              </button>
            );
          })}
        </div>
      );
  }
};
