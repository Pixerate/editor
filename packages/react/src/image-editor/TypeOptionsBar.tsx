import React, { useEffect, useState } from 'react';
import type { ImageEditorController, TextAlign, TextEditSession, TextOrientation, TextStyle, TypeToolOptions } from '@pixerate/editor/image-editor';
import { TEXT_ALIGNS, TEXT_ORIENTATIONS } from '@pixerate/editor/image-editor';
import { imageChipClass } from './styles';
import { ImageColor } from './controls/controls.js';

export interface TypeOptionsBarProps {
  controller: ImageEditorController;
  options: TypeToolOptions;
  onChange: (options: TypeToolOptions) => void;
  /** The text being edited on the canvas: changes style its selection (or all of it). */
  session?: TextEditSession | null;
  className?: string;
}


const ALIGN_LABELS: Record<TextAlign, string> = { left: 'Left', center: 'Centre', right: 'Right', justify: 'Justify' };
const ORIENTATION_LABELS: Record<TextOrientation, string> = { horizontal: 'Horizontal', vertical: 'Vertical' };

/**
 * The type tool's options: font family (from the editor's fonts), size, bold, italic, colour,
 * alignment and orientation (horizontal or vertical type, with upright Latin in vertical text). While text is being edited they style the selection (or the whole text); with a
 * type layer active they style all of it; otherwise they set what the next text uses.
 */
export const TypeOptionsBar: React.FC<TypeOptionsBarProps> = ({ controller, options, onChange, session, className }) => {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  useEffect(() => session?.subscribe(() => setTick((n) => n + 1)), [session]);
  const [error, setError] = useState<string | null>(null);
  const active = controller.getActiveLayer();
  const typeId = !session && active?.type === 'type' ? active.id : null;
  const here: Partial<TextStyle> = session?.alive ? session.styleHere() : {};
  const shown: TypeToolOptions = {
    ...options,
    ...(here.fontFamily ? { fontFamily: here.fontFamily } : {}),
    ...(here.fontSize ? { fontSize: here.fontSize } : {}),
    ...(here.fontWeight ? { fontWeight: here.fontWeight } : {}),
    ...(session?.alive ? { italic: Boolean(here.italic), color: here.color ?? options.color } : {}),
  };
  const fonts = controller.listFonts();
  const missing = active?.type === 'type' ? active.missingFonts ?? [] : [];
  // The orientation of the text being edited or the active type layer, else the tool's.
  const editedId = session?.alive ? session.layerId : typeId;
  const edited = editedId ? controller.getLayer(editedId) : null;
  const orientation: TextOrientation = edited?.type === 'type' ? (edited.orientation ?? 'horizontal') : (options.orientation ?? 'horizontal');

  const orient = (next: TextOrientation) => {
    onChange({ ...options, orientation: next });
    try {
      setError(null);
      if (editedId) controller.setTextOrientation(editedId, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const upright = () => {
    try {
      setError(null);
      if (session?.alive) session.setStyle({ upright: !here.upright });
      else if (typeId) controller.setTextStyle(typeId, { upright: !(edited?.type === 'type' && edited.runs[0]?.style.upright) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const style = (change: Partial<TypeToolOptions>) => {
    onChange({ ...options, ...change });
    const s: Record<string, unknown> = {};
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'italic', 'color'] as const) if (k in change) s[k] = change[k];
    const p = change.align ? { align: change.align } : null;
    try {
      setError(null);
      if (session?.alive) {
        if (Object.keys(s).length) session.setStyle(s as Partial<TextStyle>);
        if (p) session.setParagraph(p);
        if (session.error) setError(session.error);
      } else if (typeId) {
        if (Object.keys(s).length) controller.setTextStyle(typeId, s);
        if (p) controller.setParagraphStyle(typeId, p);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={`flex flex-col gap-2 text-xs text-foreground ${className ?? ''}`} data-testid="type-options">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          Font
          <input
            list="pixerate-type-fonts"
            aria-label="Font family"
            value={shown.fontFamily}
            onChange={(e) => e.target.value.trim() && style({ fontFamily: e.target.value })}
            className="w-32 rounded border border-border bg-background px-1 py-0.5"
          />
          <datalist id="pixerate-type-fonts">
            {fonts.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        <label className="flex items-center gap-1">
          Size
          <input
            type="number"
            aria-label="Font size"
            min={1}
            max={2000}
            value={Math.round(shown.fontSize * 10) / 10}
            onChange={(e) => Number(e.target.value) > 0 && style({ fontSize: Number(e.target.value) })}
            className="w-16 rounded border border-border bg-background px-1 py-0.5"
          />
        </label>
        <button type="button" aria-pressed={shown.fontWeight >= 600} className={`${imageChipClass(shown.fontWeight >= 600)} font-bold`} onClick={() => style({ fontWeight: shown.fontWeight >= 600 ? 400 : 700 })}>
          B
        </button>
        <button type="button" aria-pressed={shown.italic} className={`${imageChipClass(shown.italic)} italic`} onClick={() => style({ italic: !shown.italic })}>
          I
        </button>
        <ImageColor label="Text colour" value={shown.color} onChange={(color) => style({ color })} />
      </div>
      <div className="flex gap-1" role="toolbar" aria-label="Alignment">
        {TEXT_ALIGNS.map((a) => (
          <button key={a} type="button" aria-pressed={options.align === a} className={imageChipClass(options.align === a)} onClick={() => style({ align: a })}>
            {ALIGN_LABELS[a]}
          </button>
        ))}
      </div>
      <div className="flex gap-1" role="toolbar" aria-label="Orientation">
        {TEXT_ORIENTATIONS.map((o) => (
          <button key={o} type="button" aria-pressed={orientation === o} className={imageChipClass(orientation === o)} onClick={() => orient(o)}>
            {ORIENTATION_LABELS[o]}
          </button>
        ))}
        {orientation === 'vertical' && editedId && (
          <button
            type="button"
            aria-pressed={Boolean(session?.alive ? here.upright : edited?.type === 'type' && edited.runs[0]?.style.upright)}
            className={imageChipClass(Boolean(session?.alive ? here.upright : edited?.type === 'type' && edited.runs[0]?.style.upright))}
            title="Set Latin upright, one letter under the other (else turned sideways)"
            onClick={upright}
          >
            Upright Latin
          </button>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">Click to type point text (vertical: a column down from the click), drag for a paragraph box, click text to edit it. Esc finishes.</p>
      {missing.length > 0 && (
        <p role="status" className="text-amber-600" data-testid="type-missing-fonts">
          Missing {missing.length === 1 ? 'font' : 'fonts'}: {missing.join(', ')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
