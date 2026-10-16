import React, { useRef, useState } from 'react';
import { VECTOR_OVERLAY_THEME as THEME, type VectorEditorController, type VectorWidthPointEdit } from '@pixerate/editor/vector';

export interface VectorWidthPointEditorProps {
  controller: VectorEditorController;
  /** The point being edited (`state.widthPointEdit`). */
  edit: VectorWidthPointEdit;
  /** Accent colour of the Apply button (default sky blue). */
  accentColor?: string;
  className?: string;
  style?: React.CSSProperties;
}

const round = (v: number, digits: number) => String(Math.round(v * 10 ** digits) / 10 ** digits);

const fieldStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 };
const inputStyle: React.CSSProperties = { width: 72, font: 'inherit', padding: '1px 4px' };

/**
 * Width Point Edit: the position (percent along the path) and the left / right side widths
 * (document units) of the width point a width-tool double-click opened. Apply (or Enter) sets
 * them with `commitWidthPointEdit`; Cancel or Escape closes it. `<VectorCanvas>` shows it next
 * to the point; use it on its own to place it elsewhere.
 */
export function VectorWidthPointEditor({ controller, edit, accentColor = THEME.accent, className, style }: VectorWidthPointEditorProps) {
  const [position, setPosition] = useState(() => round(edit.t * 100, 2));
  const [left, setLeft] = useState(() => round(edit.left, 3));
  const [right, setRight] = useState(() => round(edit.right, 3));
  const formRef = useRef<HTMLFormElement | null>(null);
  // Hand the keyboard back to the canvas around it.
  const refocus = () => (formRef.current?.closest('svg') as SVGSVGElement | null)?.focus?.({ preventScroll: true });
  const close = () => {
    refocus();
    controller.closeWidthPointEdit();
  };
  const num = (v: string) => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const apply = () => {
    const t = num(position);
    refocus();
    controller.commitWidthPointEdit({ t: t === undefined ? undefined : Math.min(Math.max(t, 0), 100) / 100, left: num(left), right: num(right) });
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <form
      ref={formRef}
      data-vector-width-point-editor=""
      aria-label="Width point"
      className={className}
      style={{
        display: 'grid',
        gap: 4,
        padding: 8,
        background: '#ffffff',
        border: '1px solid rgba(0,0,0,0.15)',
        borderRadius: 6,
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        font: '12px system-ui, sans-serif',
        color: '#18181b',
        ...style,
      }}
      // Keep the canvas from treating clicks, keys and clipboard use in here as editing gestures.
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onDoubleClick={stop}
      onCopy={stop}
      onCut={stop}
      onPaste={stop}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <label style={fieldStyle}>
        Position %
        <input aria-label="Width point position" type="number" min={0} max={100} step="any" value={position} onChange={(e) => setPosition(e.target.value)} style={inputStyle} autoFocus />
      </label>
      <label style={fieldStyle}>
        Left
        <input aria-label="Width point left side" type="number" min={0} step="any" value={left} onChange={(e) => setLeft(e.target.value)} style={inputStyle} />
      </label>
      <label style={fieldStyle}>
        Right
        <input aria-label="Width point right side" type="number" min={0} step="any" value={right} onChange={(e) => setRight(e.target.value)} style={inputStyle} />
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginTop: 2 }}>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" style={{ background: accentColor, color: '#ffffff', border: 'none', borderRadius: 4, padding: '2px 8px' }}>
          {edit.index === null ? 'Add' : 'Apply'}
        </button>
      </div>
    </form>
  );
}
