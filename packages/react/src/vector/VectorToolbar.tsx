import React from 'react';
import {
  VECTOR_TOOLS,
  VECTOR_TOOL_GLYPHS,
  VECTOR_TOOL_SHORTCUTS,
  getVectorSelectionStyle,
  vectorPaintToHex,
  vectorToolLabel,
  type VectorEditorController,
  type VectorTool,
} from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';

export interface VectorToolbarProps {
  controller: VectorEditorController;
  /** Tools to show (default: all). */
  tools?: readonly VectorTool[];
  /** Undo / redo buttons (default `true`). */
  showHistory?: boolean;
  /** Boolean, group, arrange and align buttons (default `true`). */
  showArrange?: boolean;
  className?: string;
}

/** Tool picker plus undo, boolean operations, grouping, stacking and alignment. */
export function VectorToolbar({ controller, tools = VECTOR_TOOLS, showHistory = true, showArrange = true, className }: VectorToolbarProps) {
  const state = useVectorEditorState(controller);
  const count = state.selection.length;
  const groupSelected = state.selection.some((id) => controller.getNode(id)?.type === 'group');
  const act = (label: string, title: string, run: () => unknown, disabled = false) => (
    <button key={label} type="button" className={buttonClass} title={title} aria-label={title} disabled={disabled} onClick={() => void run()}>
      {label}
    </button>
  );
  return (
    <div role="toolbar" aria-label="Vector tools" className={`flex flex-wrap items-center gap-1 ${className ?? ''}`}>
      <div className="flex items-center gap-1" role="group" aria-label="Tools">
        {tools.map((tool) => (
          <button
            key={tool}
            type="button"
            data-vector-tool={tool}
            className={buttonClass}
            aria-pressed={state.tool === tool}
            title={`${vectorToolLabel(tool)} (${VECTOR_TOOL_SHORTCUTS[tool]})`}
            aria-label={vectorToolLabel(tool)}
            onClick={() => controller.setTool(tool)}
          >
            {VECTOR_TOOL_GLYPHS[tool]}
          </button>
        ))}
      </div>
      {showHistory && (
        <div className="ml-1 flex items-center gap-1" role="group" aria-label="History">
          {act('↶', state.canUndo ? `Undo ${state.undoLabel}` : 'Undo', () => controller.undo(), !state.canUndo)}
          {act('↷', state.canRedo ? `Redo ${state.redoLabel}` : 'Redo', () => controller.redo(), !state.canRedo)}
        </div>
      )}
      {showArrange && (
        <>
          <div className="ml-1 flex items-center gap-1" role="group" aria-label="Combine">
            {act('∪', 'Union', () => controller.booleanOp('union'), count < 2)}
            {act('−', 'Subtract', () => controller.booleanOp('subtract'), count < 2)}
            {act('∩', 'Intersect', () => controller.booleanOp('intersect'), count < 2)}
            {act('⊻', 'Exclude', () => controller.booleanOp('exclude'), count < 2)}
            {act('G', 'Group', () => controller.group(), count < 1)}
            {act('U', 'Ungroup', () => controller.ungroup(), !groupSelected)}
          </div>
          <div className="ml-1 flex items-center gap-1" role="group" aria-label="Arrange">
            {act('⇈', 'Bring to Front', () => controller.arrange('front'), count < 1)}
            {act('⇊', 'Send to Back', () => controller.arrange('back'), count < 1)}
            {act('⇤', 'Align Left', () => controller.align('left'), count < 1)}
            {act('↔', 'Align Center', () => controller.align('center'), count < 1)}
            {act('⇥', 'Align Right', () => controller.align('right'), count < 1)}
            {act('⤒', 'Align Top', () => controller.align('top'), count < 1)}
            {act('↕', 'Align Middle', () => controller.align('middle'), count < 1)}
            {act('⤓', 'Align Bottom', () => controller.align('bottom'), count < 1)}
          </div>
        </>
      )}
    </div>
  );
}

export interface VectorStylePanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Fill, stroke, stroke width and opacity of the selection; with nothing selected it edits
 * the defaults for new shapes.
 */
export function VectorStylePanel({ controller, className }: VectorStylePanelProps) {
  const state = useVectorEditorState(controller);
  const style = getVectorSelectionStyle(state);
  const source = style ?? { fill: state.defaults.fill ?? null, stroke: state.defaults.stroke ?? null, strokeWidth: state.defaults.strokeWidth ?? 1, opacity: 1 };
  const apply = (patch: Record<string, unknown>) => {
    if (style) controller.setStyle(patch);
    else controller.setDefaults(patch);
  };
  const paintRow = (key: 'fill' | 'stroke', label: string) => {
    const paint = source[key];
    const hex = vectorPaintToHex(paint);
    const on = paint !== null && paint !== 'none';
    return (
      <div className="flex items-center gap-2" data-vector-style={key}>
        <label className="flex w-16 items-center gap-1.5 text-xs text-foreground">
          <input type="checkbox" checked={on} aria-label={`${label} on`} onChange={(e) => apply({ [key]: e.target.checked ? (hex ?? '#000000') : null })} />
          {label}
        </label>
        <input
          type="color"
          aria-label={`${label} colour`}
          className="h-7 w-10 cursor-pointer rounded border border-border bg-background disabled:opacity-40"
          disabled={!on}
          value={hex ?? '#000000'}
          onChange={(e) => apply({ [key]: e.target.value })}
        />
        {on && !hex && <span className="truncate text-[11px] text-muted-foreground">{typeof paint === 'string' ? paint : 'Gradient'}</span>}
        {style?.mixed[key] && <span className="text-[11px] text-muted-foreground">Mixed</span>}
      </div>
    );
  };
  return (
    <div className={`space-y-2 ${className ?? ''}`} aria-label={style ? 'Selection style' : 'New shape style'}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{style ? 'Selection' : 'New shapes'}</p>
      {paintRow('fill', 'Fill')}
      {paintRow('stroke', 'Stroke')}
      <label className="flex items-center gap-2 text-xs text-foreground">
        <span className="w-16">Width</span>
        <input
          type="number"
          min={0}
          step={0.5}
          aria-label="Stroke width"
          className="h-7 w-20 rounded border border-border bg-background px-1.5 text-xs"
          value={source.strokeWidth}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (Number.isFinite(n) && n >= 0) apply({ strokeWidth: n });
          }}
        />
      </label>
      {style && (
        <label className="flex items-center gap-2 text-xs text-foreground">
          <span className="w-16">Opacity</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            aria-label="Opacity"
            className="h-4 flex-1 accent-primary"
            value={source.opacity}
            onChange={(e) => apply({ opacity: parseFloat(e.target.value) })}
          />
        </label>
      )}
    </div>
  );
}
