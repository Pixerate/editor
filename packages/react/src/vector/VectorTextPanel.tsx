import React, { useId } from 'react';
import {
  VECTOR_FONT_WEIGHTS,
  VECTOR_TEXT_ALIGN_OPTIONS,
  applyVectorParagraphStyle,
  applyVectorTextOrientation,
  applyVectorTextStyle,
  getVectorTextPanel,
  type VectorEditorController,
  type VectorTextAlign,
} from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
const inputClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const labelClass = 'w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

export interface VectorTextPanelProps {
  controller: VectorEditorController;
  className?: string;
}

const num = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Character and paragraph style of text: family, weight, size, italic, underline, strike-through,
 * tracking, leading, alignment, horizontal / vertical orientation (with upright Latin in vertical
 * text) and point / area text. It edits the selected characters while text
 * is being edited, else the selected text, else the defaults for new text. Type on a Path turns a
 * selected path into path text, and Create Outlines turns text into paths (with an outline
 * shaper). Each change is one undo step.
 */
export function VectorTextPanel({ controller, className }: VectorTextPanelProps) {
  const state = useVectorEditorState(controller);
  const listId = `vector-fonts-${useId().replace(/:/g, '')}`;
  const panel = getVectorTextPanel(state);
  if (!panel) return null;
  const f = panel.font;
  const style = (patch: Record<string, unknown>, merge?: string) => applyVectorTextStyle(controller, patch, merge ? { merge } : {});
  const where = panel.target === 'range' ? 'Selected characters' : panel.target === 'nodes' ? 'Selected text' : 'New text';
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-text-panel={panel.target} aria-label="Text">
      <div className="flex items-center gap-1">
        <span className={labelClass}>Text</span>
        <span className="text-[11px] text-muted-foreground">{where}</span>
      </div>
      <div className="flex items-center gap-1">
        <input
          aria-label="Font family"
          className={inputClass}
          list={listId}
          placeholder="Mixed"
          defaultValue={f.fontFamily ?? ''}
          key={`family:${f.fontFamily}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== f.fontFamily) style({ fontFamily: v });
          }}
        />
        <datalist id={listId}>
          {panel.families.map((fam) => (
            <option key={fam} value={fam} />
          ))}
        </datalist>
      </div>
      <div className="flex items-center gap-1">
        <select aria-label="Font weight" className={inputClass} value={f.fontWeight ?? ''} onChange={(e) => style({ fontWeight: Number(e.target.value) })}>
          {f.fontWeight === null && <option value="">Mixed</option>}
          {VECTOR_FONT_WEIGHTS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
          {f.fontWeight !== null && !VECTOR_FONT_WEIGHTS.some((w) => w.value === f.fontWeight) && <option value={f.fontWeight}>{f.fontWeight}</option>}
        </select>
        <input
          type="number"
          aria-label="Font size"
          title="Font size"
          className={`${inputClass} w-14 flex-none`}
          min={0.5}
          step={1}
          placeholder="—"
          value={f.fontSize === null ? '' : Math.round(f.fontSize * 100) / 100}
          onChange={(e) => {
            const v = num(e.target.value);
            if (v !== null && v >= 0.5) style({ fontSize: v }, 'text-size');
          }}
          onBlur={() => controller.endMergedEdit()}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className={buttonClass} aria-label="Bold" aria-pressed={(f.fontWeight ?? 0) >= 600} onClick={() => style({ fontWeight: (f.fontWeight ?? 400) >= 600 ? 400 : 700 })}>
          <b>B</b>
        </button>
        <button type="button" className={buttonClass} aria-label="Italic" aria-pressed={f.italic === true} onClick={() => style({ italic: !f.italic })}>
          <i>I</i>
        </button>
        <button type="button" className={buttonClass} aria-label="Underline" aria-pressed={f.underline === true} onClick={() => style({ underline: !f.underline })}>
          <u>U</u>
        </button>
        <button type="button" className={buttonClass} aria-label="Strike through" aria-pressed={f.strikethrough === true} onClick={() => style({ strikethrough: !f.strikethrough })}>
          <s>S</s>
        </button>
      </div>
      {panel.target !== 'defaults' && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Orientation">
          <button
            type="button"
            className={buttonClass}
            aria-pressed={panel.orientation === 'horizontal'}
            title="Horizontal text: lines left to right"
            onClick={() => applyVectorTextOrientation(controller, 'horizontal')}
          >
            Horizontal
          </button>
          <button
            type="button"
            className={buttonClass}
            aria-pressed={panel.orientation === 'vertical'}
            disabled={!panel.canOrient}
            title={panel.canOrient ? 'Vertical text: columns top to bottom, right to left' : 'Text on a path cannot be vertical'}
            onClick={() => applyVectorTextOrientation(controller, 'vertical')}
          >
            Vertical
          </button>
          {panel.orientation === 'vertical' && (
            <button
              type="button"
              className={buttonClass}
              aria-pressed={f.upright === true}
              title="Set Latin upright, one letter under the other (else turned sideways)"
              onClick={() => style({ upright: !f.upright })}
            >
              Upright Latin
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-1">
        <label className="flex flex-1 items-center gap-1 text-xs text-foreground" title="Tracking (1/1000 em)">
          <span className="text-[11px] text-muted-foreground">VA</span>
          <input
            type="number"
            aria-label="Tracking"
            className={inputClass}
            step={10}
            placeholder="—"
            value={f.tracking ?? ''}
            onChange={(e) => style({ tracking: num(e.target.value) ?? 0 }, 'text-tracking')}
            onBlur={() => controller.endMergedEdit()}
          />
        </label>
        <label className="flex flex-1 items-center gap-1 text-xs text-foreground" title="Leading (empty: auto)">
          <span className="text-[11px] text-muted-foreground">↕</span>
          <input
            type="number"
            aria-label="Leading"
            className={inputClass}
            min={0}
            step={1}
            placeholder="Auto"
            value={f.leading ?? ''}
            onChange={(e) => style({ leading: num(e.target.value) }, 'text-leading')}
            onBlur={() => controller.endMergedEdit()}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Alignment">
        {VECTOR_TEXT_ALIGN_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            className={buttonClass}
            aria-label={`Align ${o.label}`}
            aria-pressed={panel.align === o.value}
            onClick={() => applyVectorParagraphStyle(controller, { align: o.value as VectorTextAlign })}
          >
            {o.label}
          </button>
        ))}
      </div>
      {panel.target !== 'defaults' && panel.ids.length === 1 && (
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={buttonClass}
            aria-pressed={panel.frame === 'point'}
            title="Point text: no wrapping"
            onClick={() => controller.setTextFrame(panel.ids[0], { kind: 'point' })}
          >
            Point
          </button>
          <button
            type="button"
            className={buttonClass}
            aria-pressed={panel.frame === 'area'}
            title="Area text: wraps in a box"
            onClick={() => controller.setTextFrame(panel.ids[0], { kind: 'area' })}
          >
            Area
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={buttonClass}
          data-vector-text-action="type-on-path"
          disabled={!panel.pathId}
          title={panel.pathId ? 'Type on a Path: set text along the selected path' : 'Select a path to set text along it'}
          onClick={() => {
            const r = controller.typeOnPath(panel.pathId!, { text: 'Text on a path' });
            if (r.ok && r.id) controller.editText(r.id, { anchor: 0, focus: 'Text on a path'.length });
          }}
        >
          Type on path
        </button>
        <button
          type="button"
          className={buttonClass}
          data-vector-text-action="create-outlines"
          disabled={panel.target !== 'nodes' || !panel.outlines}
          title={panel.outlines ? 'Create Outlines: turn the text into paths' : 'Create Outlines needs a font with outlines (load one)'}
          onClick={() => controller.createOutlines({ ids: panel.ids })}
        >
          Create outlines
        </button>
      </div>
    </div>
  );
}
