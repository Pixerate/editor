import React, { useMemo, useState } from 'react';
import { brushEditorScope, brushEditorSections, PAINT_PROFILE, setBrushEditorValue, withBrushSource, type Brush, type BrushEditorControl, type BrushHostProfile, type BrushSource } from '@pixerate/editor/brushes';
import { ErrorLine, PaintSlider, PixelCanvas, button, chip } from '../paint-editor/shared';

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

export interface BrushEditorProps {
  /** The brush being edited, as facets. */
  brush: Brush;
  /**
   * What the host renders (default the paint editor): only its sections, controls and options
   * are shown. Facets of the brush it can't use stay as they are, named in a note.
   */
  profile?: BrushHostProfile;
  /** Called with the whole brush after each change (normalised). */
  onChange: (brush: Brush) => void;
  /** A live preview stroke of `brush`: pixels (e.g. `controller.brushThumbnail`) or an image URL. */
  preview?: Pixels | string | null;
  /** The colour behind an image-URL preview, for transparent previews (see `brushPreviewColours`). */
  previewBackground?: string;
  /** With it, a "Save" button (labelled `saveLabel`) saves the brush in place. */
  onSave?: () => unknown;
  /** The Save button's label (default "Save"; e.g. "Save a copy" for a built-in). */
  saveLabel?: string;
  /** With it, a name field and "Save brush" save the brush under that name. */
  onSaveAs?: (name: string) => unknown;
  /** Extra controls a host adds to a section (e.g. the sticker picker for stamps). */
  renderExtra?: (section: string) => React.ReactNode;
  /** The library's image sources, offered as stamps and as grain. */
  sources?: ReadonlyArray<Pick<BrushSource, 'id' | 'name'>>;
  /**
   * With it, "Add image…" buttons for an image tip and for grain: it stores the picked file as a
   * source (e.g. `addBrushSourceFromFile`) and returns its `source:<id>` ref.
   */
  onAddSource?: (file: File) => Promise<string>;
  className?: string;
}

/**
 * Edits a brush by its facets (`brushEditorSections`): Medium, Shape, Marks, Feel, Behaviour,
 * Light, Specialty (opt-in specialty paint, with how to use each once it is on), Motion and Colour, each control a facet, with a live preview stroke, "Save" and "Save
 * as". It needs no editor controller, so every host that paints uses it. Only what the host
 * profile uses is shown; what the brush has for other hosts is kept and named
 * (`brushEditorScope`). `BrushLibraryEditor` wires it to a brush library.
 */
export const BrushEditor: React.FC<BrushEditorProps> = ({ brush, profile = PAINT_PROFILE, onChange, preview, previewBackground, onSave, saveLabel = 'Save', onSaveAs, renderExtra, sources, onAddSource, className }) => {
  const sections = useMemo(() => brushEditorSections(brush, profile, { sources }), [brush, profile, sources]);
  const scope = useMemo(() => brushEditorScope(brush, profile), [brush, profile]);
  const [problems, setProblems] = useState<string | null>(null);
  const [name, setName] = useState('');
  const save = async (fn: () => unknown, after?: () => void) => {
    try {
      await fn();
      after?.();
      setProblems(null);
    } catch (e) {
      setProblems((e as Error).message);
    }
  };
  const set = (path: string, value: unknown) => {
    const r = setBrushEditorValue(brush, path, value);
    setProblems(r.problems.length ? r.problems.join(' ') : null);
    if (r.brush !== brush) onChange(r.brush);
  };
  /** Stores a picked image as a source and makes it the tip or the grain. */
  const addSource = onAddSource
    ? async (file: File, as: 'tip' | 'grain') => {
        try {
          const r = withBrushSource(brush, await onAddSource(file), as);
          setProblems(r.problems.length ? r.problems.join(' ') : null);
          onChange(r.brush);
        } catch (e) {
          setProblems((e as Error).message);
        }
      }
    : undefined;
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`} data-testid="brush-editor">
      {typeof preview === 'string' ? (
        <img src={preview} alt="Brush preview" className="rounded object-contain" style={{ width: '100%', aspectRatio: '4 / 1', ...(previewBackground ? { background: previewBackground } : {}) }} />
      ) : (
        preview !== undefined && <PixelCanvas pixels={preview} label="Brush preview" className="rounded" style={{ width: '100%', aspectRatio: preview ? `${preview.width} / ${preview.height}` : '4 / 1' }} />
      )}
      {scope.note && (
        <p className="text-[10px] text-amber-400" data-testid="brush-editor-scope" title={`${profile.name} shows only what it can use; these are kept unchanged when you save.`}>
          {scope.note}
        </p>
      )}
      {sections.map((s) => (
        <section key={s.id} className="flex flex-col gap-1.5" data-section={s.id} {...(s.id === 'behaviour' ? { 'data-testid': 'brush-engine' } : {})}>
          <span className="font-medium text-slate-300">{s.title}</span>
          {s.controls.map((c) => (
            <React.Fragment key={c.path}>
              <EditorControl control={c} onSet={set} />
              {c.hint && (
                <p className="text-[10px] leading-snug text-slate-400" data-hint={c.path}>
                  {c.hint}
                </p>
              )}
              {addSource && (c.path === 'tip.stamps' || c.path === 'tip.grain.source') && <AddImage label={c.path === 'tip.stamps' ? 'Add image tip…' : 'Add grain image…'} onFile={(f) => addSource(f, c.path === 'tip.stamps' ? 'tip' : 'grain')} />}
            </React.Fragment>
          ))}
          {renderExtra?.(s.id)}
        </section>
      ))}
      {(onSave || onSaveAs) && (
        <div className="flex flex-wrap items-center gap-1">
          {onSave && (
            <button type="button" className={button} onClick={() => save(onSave)}>
              {saveLabel}
            </button>
          )}
          {onSaveAs && (
            <>
              <input value={name} placeholder="Brush name" aria-label="Brush name" onChange={(e) => setName(e.target.value)} className="w-28 rounded bg-slate-800 px-1.5 py-0.5" />
              <button type="button" className={button} disabled={!name.trim()} onClick={() => save(() => onSaveAs(name.trim()), () => setName(''))}>
                Save brush
              </button>
            </>
          )}
        </div>
      )}
      <ErrorLine error={problems} />
    </div>
  );
};

/** A file picker for an image (PNG, JPEG, WebP…). */
const AddImage: React.FC<{ label: string; onFile: (file: File) => void }> = ({ label, onFile }) => (
  <label className={`${button} cursor-pointer self-start`}>
    {label}
    <input
      type="file"
      accept="image/*"
      aria-label={label}
      className="sr-only"
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) onFile(file);
      }}
    />
  </label>
);

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
    case 'colour': {
      // One colour, or a light / dark pair resolved for the host's colour scheme.
      const set = (light: string, dark: string | null) => onSet(c.path, dark === null ? light : { light, dark });
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">{c.label}</span>
            <span className="flex items-center gap-1">
              <input type="color" aria-label={c.ariaLabel} title={c.dark !== null ? 'On light backgrounds' : undefined} value={c.value ?? '#000000'} onChange={(e) => set(e.target.value, c.dark)} className="h-5 w-8" />
              {c.dark !== null && <input type="color" aria-label={`${c.ariaLabel} (dark)`} title="On dark backgrounds" value={c.dark} onChange={(e) => set(c.value ?? '#000000', e.target.value)} className="h-5 w-8" />}
              {(c.value || c.gradient) && (
                <button type="button" className={button} onClick={() => onSet(c.path, undefined)}>
                  None
                </button>
              )}
            </span>
          </div>
          {c.gradient ? (
            <span className="text-[10px] text-slate-500">A gradient (its own paint).</span>
          ) : (
            <label className="flex items-center gap-2">
              <input type="checkbox" aria-label={`${c.ariaLabel}: light and dark`} checked={c.dark !== null} onChange={(e) => set(c.value ?? '#000000', e.target.checked ? (c.value ?? '#ffffff') : null)} /> Light / dark
            </label>
          )}
        </div>
      );
    }
    case 'palette': {
      const at = (i: number, entry: string | { light: string; dark: string }) => onSet(c.path, c.value.map((x, j) => (j === i ? entry : x)));
      return (
        <div className="flex flex-col gap-1" role="group" aria-label={c.ariaLabel}>
          <span className="text-slate-400">{c.label}</span>
          <div className="flex flex-wrap items-center gap-1">
            {c.value.map((col, i) => {
              const light = typeof col === 'string' ? col : col.light;
              return (
                <span key={i} className="flex items-center gap-0.5 rounded bg-slate-900 p-0.5">
                  <input type="color" aria-label={`Palette colour ${i + 1}`} value={light} onChange={(e) => at(i, typeof col === 'string' ? e.target.value : { ...col, light: e.target.value })} className="h-4 w-5" />
                  {typeof col !== 'string' && <input type="color" aria-label={`Palette colour ${i + 1} (dark)`} value={col.dark} onChange={(e) => at(i, { ...col, dark: e.target.value })} className="h-4 w-5" />}
                  <button type="button" aria-label={`Remove palette colour ${i + 1}`} className="px-0.5 text-slate-400 hover:text-white" onClick={() => onSet(c.path, c.value.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </span>
              );
            })}
            {c.value.length < c.max && (
              <>
                <input type="color" aria-label="Add a palette colour" onChange={(e) => onSet(c.path, [...c.value, e.target.value])} className="h-4 w-6" />
                <button type="button" className={button} onClick={() => onSet(c.path, [...c.value, { light: '#334155', dark: '#e2e8f0' }])}>
                  Add light / dark pair
                </button>
              </>
            )}
          </div>
        </div>
      );
    }
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
