import React, { useEffect, useMemo, useState } from 'react';
import { addBrushSourceFromFile, brushPreviewColours, checkBrushEdit, newBrushFor, saveBrushEdit, type Brush, type BrushHostProfile, type BrushLibrary, type BrushPreviewRenderer, type BrushSource } from '@pixerate/editor/brushes';
import { button } from '../paint-editor/shared';
import { BrushEditor } from './BrushEditor';

export interface BrushLibraryEditorProps {
  /** The shared brush library: saves go here, so every editor on it gets the brush. */
  library: BrushLibrary;
  /** The brush to edit (a library id); `null` or absent starts a new brush for the host. */
  brushId?: string | null;
  /** The host the brush is edited for: the editor shows only what it uses. */
  profile: BrushHostProfile;
  /** Draws the preview stroke (the host's renderer, as for `preview_brush`). Without it there is no preview. */
  renderPreview?: BrushPreviewRenderer;
  /**
   * What a transparent preview is shown on (#rrggbb, default white); the renderer's own `paper`
   * wins. The preview colour is chosen to read on it (`brushPreviewColours`).
   */
  previewPaper?: string;
  /** A fixed preview colour instead (overrides the brush's own and the contrast check). */
  previewColor?: string;
  /** Called with the brush as saved (a copy has a new id): e.g. pick it in the host. */
  onSaved?: (brush: Brush) => void;
  /** With it, a Close button. */
  onClose?: () => void;
  className?: string;
}

/**
 * `BrushEditor` on a brush library for one host: loads the brush, edits a draft and saves it with
 * `saveBrushEdit`. Images added for an image tip or grain are stored in the library as sources. A saved brush is changed in place, a built-in is saved as a copy, "Save brush"
 * saves under a new name, and "New brush" starts from the current one with only what the host
 * uses. Facets the host can't use are kept on save; a new brush must pass the host's check.
 */
export const BrushLibraryEditor: React.FC<BrushLibraryEditorProps> = ({ library, brushId, profile, renderPreview, previewPaper = '#ffffff', previewColor, onSaved, onClose, className }) => {
  const [original, setOriginal] = useState<Brush | null>(null);
  const [builtin, setBuiltin] = useState(false);
  const [draft, setDraft] = useState<Brush | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [sources, setSources] = useState<BrushSource[]>([]);

  // The library's image sources, for image tips and grain (kept current as sources are added).
  useEffect(() => {
    let live = true;
    const read = () => void library.listSources().then((list) => live && setSources(list), () => undefined);
    read();
    const off = library.subscribe(read);
    return () => {
      live = false;
      off();
    };
  }, [library]);

  useEffect(() => {
    let live = true;
    setStatus(null);
    void (async () => {
      const entry = brushId ? await library.get(brushId) : null;
      if (!live) return;
      setOriginal(entry?.brush ?? null);
      setBuiltin(!!entry?.builtin);
      setDraft(entry?.brush ?? newBrushFor(profile));
    })();
    return () => {
      live = false;
    };
  }, [library, brushId, profile]);

  // The preview colour reads on what the preview is drawn on: the renderer's paper, or the box behind it.
  const paper = renderPreview?.paper ?? previewPaper;
  const colours = useMemo(() => (draft ? brushPreviewColours(draft, { paper, profile }) : null), [draft, paper, profile]);
  const colour = previewColor ?? colours?.color ?? '#475569';
  useEffect(() => {
    if (!draft || !renderPreview) return;
    let live = true;
    Promise.resolve(renderPreview(draft, { width: 240, height: 60, color: colour.slice(0, 7) }))
      .then((img) => live && setPreview(img.data ? `data:${img.mimeType};base64,${img.data}` : null))
      .catch(() => live && setPreview(null));
    return () => {
      live = false;
    };
  }, [draft, renderPreview, colour]);

  const check = useMemo(() => (draft ? checkBrushEdit(original, draft, profile) : null), [original, draft, profile]);
  if (!draft) return null;

  const save = async (name?: string) => {
    const saved = await saveBrushEdit(library, { original, brush: draft, profile, ...(name !== undefined ? { name } : {}) });
    setOriginal(saved.brush);
    setBuiltin(false);
    setDraft(saved.brush);
    setStatus(`Saved “${saved.brush.name}”${saved.kept.length ? `, keeping what ${profile.name} can't use` : ''}.`);
    onSaved?.(saved.brush);
  };
  const errors = check?.issues.filter((i) => i.severity === 'error') ?? [];

  return (
    <div className={`flex flex-col gap-2 text-xs text-slate-200 ${className ?? ''}`} data-testid="brush-library-editor">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium" data-testid="brush-library-editor-title">
          {original ? `${draft.name}${builtin ? ' (built in: saves a copy)' : ''}` : 'New brush'}
        </span>
        <span className="flex gap-1">
          <button
            type="button"
            className={button}
            title={`A new brush from this one, with only what ${profile.name} uses`}
            onClick={() => {
              setOriginal(null);
              setBuiltin(false);
              setDraft(newBrushFor(profile, draft));
              setStatus(null);
            }}
          >
            New brush
          </button>
          {onClose && (
            <button type="button" className={button} onClick={onClose}>
              Close
            </button>
          )}
        </span>
      </div>
      <BrushEditor
        brush={draft}
        profile={profile}
        preview={renderPreview ? preview : undefined}
        previewBackground={colours?.background}
        onChange={(next) => {
          setDraft(next);
          setStatus(null);
        }}
        onSave={original ? () => save() : undefined}
        saveLabel={builtin ? 'Save a copy' : 'Save'}
        onSaveAs={(name) => save(name)}
        sources={sources}
        onAddSource={async (file) => (await addBrushSourceFromFile(library, file)).ref}
      />
      {errors.length > 0 && (
        <ul className="text-[11px] text-rose-400" data-testid="brush-library-editor-issues">
          {errors.map((i) => (
            <li key={i.facet}>
              {i.reason} {i.fix}
            </li>
          ))}
        </ul>
      )}
      {status && (
        <p role="status" className="text-[11px] text-emerald-400">
          {status}
        </p>
      )}
    </div>
  );
};
