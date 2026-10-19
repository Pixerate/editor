import React from 'react';
import {
  VECTOR_BLEND_MODE_MENU,
  VECTOR_FILTER_MENU,
  VECTOR_STROKE_ALIGN_LABELS,
  getVectorAppearancePanel,
  type VectorAppearancePanelLayer,
  type VectorBlendMode,
  type VectorEditorController,
  type VectorFilterParamSpec,
  type VectorFilterType,
  type VectorFiltersPanelItem,
  type VectorStrokeAlign,
} from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
const numberClass = 'h-7 w-14 rounded border border-border bg-background px-1.5 text-xs';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const headingClass = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
const labelClass = 'w-full truncate text-[11px] text-muted-foreground';

export interface VectorAppearancePanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * The appearance of the selection: its fill and stroke stacks (listed top first; add, remove,
 * reorder, show / hide, paint, opacity and blend mode per layer, width and alignment per
 * stroke), the node blend mode, and for one selected node its filters (drop and inner shadows,
 * glows, blurs, feather). The pencil on a layer points the gradient editor and tool at it.
 * Slider drags and typing are one undo step each.
 */
export function VectorAppearancePanel({ controller, className }: VectorAppearancePanelProps) {
  const state = useVectorEditorState(controller);
  const panel = getVectorAppearancePanel(state);
  if (!panel) return null;
  const end = () => controller.endMergedEdit();
  const ids = panel.pathIds;
  const update = (l: VectorAppearancePanelLayer, patch: Record<string, unknown>, merge = false) => controller.updatePaintLayer(l.kind, l.index, patch, { ids, merge });

  const layerRow = (l: VectorAppearancePanelLayer, count: number) => {
    const name = `${l.kind === 'fill' ? 'Fill' : 'Stroke'} ${l.index + 1}`;
    if (l.unknownKind)
      return (
        <div key={`${l.kind}-${l.index}`} className="text-[11px] text-muted-foreground" data-vector-layer={`${l.kind}-${l.index}`}>
          {name}: {l.unknownKind} (not drawn by this version)
        </div>
      );
    return (
      <div key={`${l.kind}-${l.index}`} className="space-y-1 rounded border border-border p-1" data-vector-layer={`${l.kind}-${l.index}`} data-vector-layer-editing={l.editing ? '' : undefined}>
        <div className="flex items-center gap-1">
          <input type="checkbox" aria-label={`${name} visible`} title="Show" checked={l.visible} onChange={(e) => update(l, { visible: e.target.checked })} />
          {l.gradient ? (
            <button
              type="button"
              aria-label={`${name} gradient`}
              title="Edit this gradient"
              className="h-7 w-10 rounded border border-border"
              style={{ background: l.swatch }}
              onClick={() => controller.setGradientTarget(l.kind, l.index)}
            />
          ) : (
            <input
              type="color"
              aria-label={`${name} colour`}
              className="h-7 w-10 cursor-pointer rounded border border-border bg-background"
              value={l.color ?? '#000000'}
              onChange={(e) => update(l, { paint: e.target.value }, true)}
              onBlur={end}
            />
          )}
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            aria-label={`${name} opacity`}
            title="Opacity %"
            className={numberClass}
            value={Math.round(l.opacity * 100)}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n)) update(l, { opacity: Math.min(100, Math.max(0, n)) / 100 }, true);
            }}
            onBlur={end}
          />
          <select aria-label={`${name} blend mode`} className={selectClass} value={l.blendMode} onChange={(e) => update(l, { blendMode: e.target.value })}>
            {VECTOR_BLEND_MODE_MENU.map((m) => (
              <option key={m.mode} value={m.mode}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {l.kind === 'stroke' && (
          <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                step={0.5}
                aria-label={`${name} width`}
                title="Width"
                className={numberClass}
                value={l.strokeWidth ?? 1}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (Number.isFinite(n) && n >= 0) update(l, { strokeWidth: n }, true);
                }}
                onBlur={end}
              />
              <select aria-label={`${name} alignment`} className={selectClass} value={l.strokeAlign ?? 'center'} onChange={(e) => update(l, { strokeAlign: e.target.value as VectorStrokeAlign })}>
                {(Object.keys(VECTOR_STROKE_ALIGN_LABELS) as VectorStrokeAlign[]).map((a) => (
                  <option key={a} value={a}>
                    {VECTOR_STROKE_ALIGN_LABELS[a]}
                  </option>
                ))}
              </select>
          </div>
        )}
        <div className="flex items-center gap-1">
          <span className="flex-1" />
          <button type="button" className={buttonClass} title="Edit gradient" aria-label={`Edit ${name} gradient`} aria-pressed={l.editing} onClick={() => controller.setGradientTarget(l.kind, l.index)}>
            ✎
          </button>
          <button type="button" className={buttonClass} title="Move up" aria-label={`Move ${name} up`} disabled={l.index === count - 1} onClick={() => controller.movePaintLayer(l.kind, l.index, l.index + 1, { ids })}>
            ↑
          </button>
          <button type="button" className={buttonClass} title="Move down" aria-label={`Move ${name} down`} disabled={l.index === 0} onClick={() => controller.movePaintLayer(l.kind, l.index, l.index - 1, { ids })}>
            ↓
          </button>
          <button type="button" className={buttonClass} title="Remove" aria-label={`Remove ${name}`} onClick={() => controller.removePaintLayer(l.kind, l.index, { ids })}>
            ×
          </button>
        </div>
      </div>
    );
  };

  const stack = (kind: 'fill' | 'stroke', layers: VectorAppearancePanelLayer[], mixed: boolean) => (
    <div className="space-y-1" data-vector-stack={kind}>
      <div className="flex items-center gap-2">
        <span className={`flex-1 ${headingClass}`}>{kind === 'fill' ? 'Fills' : 'Strokes'}</span>
        {mixed && <span className="text-[11px] text-muted-foreground">Mixed</span>}
        <button
          type="button"
          className={buttonClass}
          title={kind === 'fill' ? 'Add fill' : 'Add stroke'}
          aria-label={kind === 'fill' ? 'Add fill' : 'Add stroke'}
          disabled={!ids.length}
          onClick={() => controller.addPaintLayer(kind, {}, { ids })}
        >
          +
        </button>
      </div>
      {/* Top layer first, as it draws. */}
      {[...layers].reverse().map((l) => layerRow(l, layers.length))}
    </div>
  );

  const filterNode = panel.filterNodeId;
  const setFilter = (f: VectorFiltersPanelItem, key: string, value: unknown, merge: boolean) => {
    if (filterNode) controller.updateFilter(filterNode, f.id, { params: { [key]: value } }, { merge });
  };
  const filterParam = (f: VectorFiltersPanelItem, spec: VectorFilterParamSpec) => {
    const label = `${f.label} ${spec.label}`;
    if (spec.kind === 'color')
      return (
        <label key={spec.key} className="flex items-center gap-2 text-xs text-foreground" data-vector-filter-param={spec.key}>
          <span className="w-14 truncate text-[11px] text-muted-foreground">{spec.label}</span>
          <input
            type="color"
            aria-label={label}
            className="h-7 w-10 cursor-pointer rounded border border-border bg-background"
            value={/^#[0-9a-f]{6}$/i.test(String(f.params[spec.key])) ? String(f.params[spec.key]) : '#000000'}
            onChange={(e) => setFilter(f, spec.key, e.target.value, true)}
            onBlur={end}
          />
        </label>
      );
    if (spec.kind !== 'number') return null;
    const value = Number(f.params[spec.key] ?? 0);
    const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = parseFloat(e.target.value);
      if (Number.isFinite(n)) setFilter(f, spec.key, n, true);
    };
    return (
      <label key={spec.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-filter-param={spec.key}>
        <span className={labelClass}>{spec.label}</span>
        {spec.slider && (
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            aria-label={`${label} slider`}
            className="h-4 min-w-0 flex-1 accent-primary"
            value={value}
            onChange={onChange}
            onPointerUp={end}
            onKeyUp={end}
            onBlur={end}
          />
        )}
        <input type="number" min={spec.min} max={spec.max} step={spec.step} aria-label={label} className={numberClass} value={Math.round(value * 1000) / 1000} onChange={onChange} onBlur={end} />
      </label>
    );
  };

  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-appearance="" aria-label="Appearance">
      {ids.length > 0 && stack('stroke', panel.strokes, panel.mixed.strokes)}
      {ids.length > 0 && stack('fill', panel.fills, panel.mixed.fills)}
      <label className="flex items-center gap-2 text-xs text-foreground" data-vector-style="blendMode">
        <span className="w-16">Blend</span>
        <select aria-label="Blend mode" className={selectClass} value={panel.blendMode} onChange={(e) => controller.setBlendMode(e.target.value as VectorBlendMode, { ids: panel.nodeIds })}>
          {VECTOR_BLEND_MODE_MENU.map((m) => (
            <option key={m.mode} value={m.mode}>
              {m.label}
            </option>
          ))}
        </select>
        {panel.mixed.blendMode && <span className="text-[11px] text-muted-foreground">Mixed</span>}
      </label>
      <div className="space-y-2" data-vector-filters="">
        <div className="flex items-center gap-2">
          <span className={`w-16 ${headingClass}`}>Filters</span>
          <select
            aria-label="Add filter"
            className={selectClass}
            value=""
            onChange={(e) => {
              if (e.target.value) controller.addFilter(e.target.value as VectorFilterType, { ids: panel.nodeIds });
            }}
          >
            <option value="">Add filter…</option>
            {VECTOR_FILTER_MENU.map((m) => (
              <option key={m.type} value={m.type}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {!filterNode && <p className="text-[11px] text-muted-foreground">Select one object to edit its filters.</p>}
        {filterNode &&
          panel.filters.map((f, i) => (
            <div key={f.id} className="space-y-1 rounded border border-border p-1.5" data-vector-filter={f.id} data-vector-filter-type={f.type}>
              <div className="flex items-center gap-1">
                <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-foreground">
                  <input type="checkbox" aria-label={`${f.label} on`} checked={f.enabled} onChange={(e) => controller.updateFilter(filterNode, f.id, { enabled: e.target.checked })} />
                  <span className="truncate">{f.label}</span>
                </label>
                <button type="button" className={buttonClass} title="Move up" aria-label={`Move ${f.label} up`} disabled={i === 0} onClick={() => controller.moveFilter(filterNode, f.id, i - 1)}>
                  ↑
                </button>
                <button type="button" className={buttonClass} title="Move down" aria-label={`Move ${f.label} down`} disabled={i === panel.filters.length - 1} onClick={() => controller.moveFilter(filterNode, f.id, i + 1)}>
                  ↓
                </button>
                <button type="button" className={buttonClass} title="Remove" aria-label={`Remove ${f.label}`} onClick={() => controller.removeFilter(filterNode, f.id)}>
                  ×
                </button>
              </div>
              {f.specs.map((spec) => filterParam(f, spec))}
            </div>
          ))}
      </div>
    </div>
  );
}
