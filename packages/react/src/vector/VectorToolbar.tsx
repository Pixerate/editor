import React from 'react';
import {
  VECTOR_TOOLS,
  VECTOR_TOOL_GLYPHS,
  VECTOR_TOOL_SHORTCUTS,
  VECTOR_EDIT_TOGGLES,
  VECTOR_PATH_ACTIONS,
  VECTOR_PATHFINDER_ACTIONS,
  VECTOR_FILL_GAP,
  VECTOR_ARROWHEADS,
  VECTOR_ARROWHEAD_LABELS,
  VECTOR_CORNER_KINDS,
  VECTOR_CORNER_KIND_LABELS,
  VECTOR_STROKE_ALIGN_LABELS,
  VECTOR_WIDTH_PRESETS,
  VECTOR_BLEND_SPACINGS,
  VECTOR_BLEND_SPACING_LABELS,
  applyVectorBlendOptions,
  getVectorBlendControls,
  getVectorSelectionStyle,
  widthProfilePreset,
  widthProfilePresetId,
  vectorPaintToHex,
  vectorToolLabel,
  type VectorArrowhead,
  type VectorBlendSpacing,
  type VectorCornerKind,
  type VectorEditorController,
  type VectorStrokeAlign,
  type VectorTool,
  type VectorWidthPreset,
} from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const VECTOR_SNAP_TITLE = 'Snap to objects';
const modKeyLabel = () => (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '') ? '⌘' : 'Ctrl');

const buttonClass =
  'inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';

export interface VectorToolbarProps {
  controller: VectorEditorController;
  /** Tools to show (default: all). */
  tools?: readonly VectorTool[];
  /** Undo / redo buttons (default `true`). */
  showHistory?: boolean;
  /** Boolean, Pathfinder, group, arrange and align buttons (default `true`). */
  showArrange?: boolean;
  /** The snapping toggle (default `true`). */
  showSnap?: boolean;
  /**
   * Path editing: Join, Average, Cut at Points, Remove Redundant Points, Smooth, the Keep
   * Shape / Curvature / Shapes toggles, and the pencil smoothing and eraser size inputs while
   * those tools are active (default `true`).
   */
  showPathEdit?: boolean;
  /**
   * Blend: Make Blend, spacing (steps, distance or smooth colour), steps / distance, orient to
   * spine, Replace Spine, Expand and Release (default `true`).
   */
  showBlend?: boolean;
  className?: string;
}

/** Tool picker plus undo, snapping, boolean operations, grouping, stacking and alignment. */
export function VectorToolbar({
  controller,
  tools = VECTOR_TOOLS,
  showHistory = true,
  showArrange = true,
  showSnap = true,
  showPathEdit = true,
  showBlend = true,
  className,
}: VectorToolbarProps) {
  const state = useVectorEditorState(controller);
  const count = state.selection.length;
  const points = state.tool === 'direct' ? state.selectedAnchors.length : 0;
  const editing = state.editing;
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
      {showSnap && (
        <div className="ml-1 flex items-center gap-1" role="group" aria-label="Snapping">
          <button
            type="button"
            data-vector-snap=""
            className={buttonClass}
            aria-pressed={state.snap.objects}
            title={`${VECTOR_SNAP_TITLE} (hold ${modKeyLabel()} to bypass)`}
            aria-label={VECTOR_SNAP_TITLE}
            onClick={() => controller.toggleSnapping()}
          >
            Snap
          </button>
        </div>
      )}
      {showPathEdit && (
        <div className="ml-1 flex items-center gap-1" role="group" aria-label="Path editing">
          {VECTOR_PATH_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              data-vector-path-action={a.id}
              className={buttonClass}
              title={a.shortcut ? `${a.title} (${modKeyLabel()}+${a.shortcut})` : a.title}
              aria-label={a.title}
              disabled={!a.enabled(count, points)}
              onClick={() => void a.run(controller)}
            >
              {a.label}
            </button>
          ))}
          {VECTOR_EDIT_TOGGLES.map((t) => (
            <button
              key={t.key}
              type="button"
              data-vector-edit={t.key}
              className={buttonClass}
              aria-pressed={editing[t.key]}
              title={t.title}
              aria-label={t.title}
              onClick={() => controller.setEditing({ [t.key]: !editing[t.key] })}
            >
              {t.label}
            </button>
          ))}
          {state.tool === 'pencil' && (
            <label className="flex items-center gap-1 text-xs text-foreground">
              Smoothing
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                aria-label="Pencil smoothing"
                className="h-4 w-20 accent-primary"
                value={editing.pencilSmoothing}
                onChange={(e) => controller.setEditing({ pencilSmoothing: parseFloat(e.target.value) })}
              />
            </label>
          )}
          {state.tool === 'eraser' && (
            <label className="flex items-center gap-1 text-xs text-foreground">
              Size
              <input
                type="number"
                min={0.5}
                step={1}
                aria-label="Eraser size"
                className="h-7 w-16 rounded border border-border bg-background px-1.5 text-xs"
                value={editing.eraserSize}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (Number.isFinite(n) && n > 0) controller.setEditing({ eraserSize: n });
                }}
              />
            </label>
          )}
          {state.tool === 'paintBucket' && (
            <button
              type="button"
              data-vector-fill-gap=""
              className={buttonClass}
              aria-pressed={editing.fillGap > 0}
              title="Close small gaps between path ends when filling"
              aria-label="Close gaps"
              onClick={() => controller.setEditing({ fillGap: editing.fillGap > 0 ? 0 : VECTOR_FILL_GAP })}
            >
              Gaps
            </button>
          )}
        </div>
      )}
      {showBlend && <VectorBlendControls controller={controller} />}
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
          <div className="ml-1 flex items-center gap-1" role="group" aria-label="Pathfinder">
            {VECTOR_PATHFINDER_ACTIONS.map((a) => (
              <button
                key={a.id}
                type="button"
                data-vector-pathfinder={a.id}
                className={buttonClass}
                title={a.title}
                aria-label={a.title}
                disabled={count < a.min}
                onClick={() => void controller.pathfinder(a.id)}
              >
                {a.label}
              </button>
            ))}
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

/** Blend buttons and options: they edit the selected blends and the options new blends get. */
function VectorBlendControls({ controller }: { controller: VectorEditorController }) {
  const state = useVectorEditorState(controller);
  const blend = getVectorBlendControls(state);
  const o = blend.options;
  const selected = blend.ids.length > 0;
  return (
    <div className="ml-1 flex items-center gap-1" role="group" aria-label="Blend" data-vector-blend-controls="">
      <button type="button" data-vector-blend-action="make" className={buttonClass} title="Make Blend" aria-label="Make Blend" disabled={!blend.canBlend} onClick={() => controller.blend()}>
        ⧓
      </button>
      <select
        aria-label="Blend spacing"
        className="h-7 rounded border border-border bg-background px-1 text-xs"
        value={o.spacing}
        onChange={(e) => applyVectorBlendOptions(controller, { spacing: e.target.value as VectorBlendSpacing })}
      >
        {VECTOR_BLEND_SPACINGS.map((sp) => (
          <option key={sp} value={sp}>
            {VECTOR_BLEND_SPACING_LABELS[sp]}
          </option>
        ))}
      </select>
      {o.spacing !== 'smoothColor' && (
        <input
          type="number"
          min={o.spacing === 'steps' ? 1 : 0.5}
          step={1}
          aria-label={o.spacing === 'steps' ? 'Blend steps' : 'Blend distance'}
          className="h-7 w-16 rounded border border-border bg-background px-1.5 text-xs"
          value={o.spacing === 'steps' ? o.steps : o.distance}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (!Number.isFinite(n) || n <= 0) return;
            applyVectorBlendOptions(controller, o.spacing === 'steps' ? { steps: n } : { distance: n });
          }}
        />
      )}
      <button
        type="button"
        data-vector-blend-action="orient"
        className={buttonClass}
        aria-pressed={o.orientToSpine}
        title="Orient steps to the spine"
        aria-label="Orient to spine"
        onClick={() => applyVectorBlendOptions(controller, { orientToSpine: !o.orientToSpine })}
      >
        ⤿
      </button>
      <button
        type="button"
        data-vector-blend-action="spine"
        className={buttonClass}
        title="Replace Spine (select a blend and a path)"
        aria-label="Replace Spine"
        disabled={!blend.canReplaceSpine}
        onClick={() => controller.replaceBlendSpine()}
      >
        ⌇
      </button>
      <button type="button" data-vector-blend-action="expand" className={buttonClass} title="Expand Blend" aria-label="Expand Blend" disabled={!selected} onClick={() => controller.expandBlend()}>
        ⧉
      </button>
      <button type="button" data-vector-blend-action="release" className={buttonClass} title="Release Blend" aria-label="Release Blend" disabled={!selected} onClick={() => controller.releaseBlend()}>
        ⧄
      </button>
    </div>
  );
}

export interface VectorStylePanelProps {
  controller: VectorEditorController;
  className?: string;
}

const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const numberClass = 'h-7 w-16 rounded border border-border bg-background px-1.5 text-xs';

/**
 * Fill, stroke, stroke width, alignment and width profile, arrowheads, live corner radius and opacity of the
 * selection (corners of the selected points with the direct tool); with nothing selected it
 * edits the defaults for new shapes.
 */
export function VectorStylePanel({ controller, className }: VectorStylePanelProps) {
  const state = useVectorEditorState(controller);
  const style = getVectorSelectionStyle(state);
  const d = state.defaults;
  const source = style ?? {
    fill: d.fill ?? null,
    stroke: d.stroke ?? null,
    strokeWidth: d.strokeWidth ?? 1,
    opacity: 1,
    strokeAlign: d.strokeAlign ?? 'center',
    startArrow: d.startArrow ?? null,
    endArrow: d.endArrow ?? null,
    arrowAlign: d.arrowAlign ?? 'extend',
    startArrowScale: d.startArrowScale ?? 1,
    endArrowScale: d.endArrowScale ?? 1,
    widthProfile: widthProfilePresetId(d.strokeWidthProfile),
    cornerRadius: d.cornerRadius,
    cornerKind: d.cornerKind ?? 'round',
    corners: 1,
    hasOpenPath: true,
  };
  const setCorners = (patch: { radius?: number; kind?: VectorCornerKind }) => {
    if (!style) controller.setDefaults({ ...(patch.radius !== undefined ? { cornerRadius: patch.radius } : {}), ...(patch.kind ? { cornerKind: patch.kind } : {}) });
    else if (patch.radius !== undefined) controller.setCornerRadius(patch.radius);
    else if (patch.kind) controller.setCornerKind(patch.kind);
  };
  const setProfile = (id: VectorWidthPreset) => {
    if (style) controller.setWidthProfile(id);
    else controller.setDefaults({ strokeWidthProfile: widthProfilePreset(id)?.length ? widthProfilePreset(id) : null });
  };
  const mixed = (key: keyof NonNullable<typeof style>['mixed']) => (style?.mixed[key] ? <span className="text-[11px] text-muted-foreground">Mixed</span> : null);
  const arrowRow = (end: 'start' | 'end', label: string) => {
    const key = end === 'start' ? 'startArrow' : 'endArrow';
    const scaleKey = end === 'start' ? 'startArrowScale' : 'endArrowScale';
    return (
      <div className="flex items-center gap-2" data-vector-style={key}>
        <span className="w-16 text-xs text-foreground">{label}</span>
        <select aria-label={`${label} arrowhead`} className={selectClass} value={source[key] ?? ''} onChange={(e) => apply({ [key]: (e.target.value || null) as VectorArrowhead | null })}>
          <option value="">None</option>
          {VECTOR_ARROWHEADS.map((h) => (
            <option key={h} value={h}>
              {VECTOR_ARROWHEAD_LABELS[h]}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0.1}
          step={0.25}
          aria-label={`${label} arrowhead scale`}
          title="Scale (× stroke width)"
          className={numberClass}
          value={source[scaleKey]}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (Number.isFinite(n) && n > 0) apply({ [scaleKey]: n });
          }}
        />
      </div>
    );
  };
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
      <label className="flex items-center gap-2 text-xs text-foreground" data-vector-style="strokeAlign">
        <span className="w-16">Align</span>
        <select aria-label="Stroke alignment" className={selectClass} value={source.strokeAlign} onChange={(e) => apply({ strokeAlign: e.target.value as VectorStrokeAlign })}>
          {(Object.keys(VECTOR_STROKE_ALIGN_LABELS) as VectorStrokeAlign[]).map((a) => (
            <option key={a} value={a}>
              {VECTOR_STROKE_ALIGN_LABELS[a]}
            </option>
          ))}
        </select>
        {mixed('strokeAlign')}
      </label>
      <div className="flex items-center gap-2 text-xs text-foreground" data-vector-style="widthProfile">
        <span className="w-16">Profile</span>
        <select
          aria-label="Width profile"
          className={selectClass}
          value={source.widthProfile}
          onChange={(e) => {
            if (e.target.value !== 'custom') setProfile(e.target.value as VectorWidthPreset);
          }}
        >
          {VECTOR_WIDTH_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {source.widthProfile === 'custom' && (
            <option value="custom" disabled>
              Custom
            </option>
          )}
        </select>
        <button
          type="button"
          className={buttonClass}
          title="Reset to uniform width"
          aria-label="Reset to uniform width"
          disabled={source.widthProfile === 'uniform' && !style?.mixed.widthProfile}
          onClick={() => setProfile('uniform')}
        >
          ═
        </button>
        {mixed('widthProfile')}
      </div>
      {source.hasOpenPath && (
        <>
          {arrowRow('start', 'Start')}
          {arrowRow('end', 'End')}
          {(source.startArrow || source.endArrow) && (
            <label className="flex items-center gap-2 text-xs text-foreground" data-vector-style="arrowAlign">
              <span className="w-16">Heads</span>
              <select aria-label="Arrowhead alignment" className={selectClass} value={source.arrowAlign} onChange={(e) => apply({ arrowAlign: e.target.value })}>
                <option value="extend">Tip past end</option>
                <option value="tip">Tip at end</option>
              </select>
            </label>
          )}
        </>
      )}
      {source.corners > 0 && (
        <div className="flex items-center gap-2" data-vector-style="corners">
          <span className="w-16 text-xs text-foreground">Corners</span>
          <input
            type="number"
            min={0}
            step={1}
            aria-label="Corner radius"
            className={numberClass}
            value={Math.round(source.cornerRadius * 100) / 100}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n) && n >= 0) setCorners({ radius: n });
            }}
          />
          <select aria-label="Corner kind" className={selectClass} value={source.cornerKind} onChange={(e) => setCorners({ kind: e.target.value as VectorCornerKind })}>
            {VECTOR_CORNER_KINDS.map((k) => (
              <option key={k} value={k}>
                {VECTOR_CORNER_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          {mixed('cornerRadius')}
        </div>
      )}
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
