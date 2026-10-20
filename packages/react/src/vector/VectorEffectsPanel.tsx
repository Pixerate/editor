import React from 'react';
import {
  VECTOR_EFFECT_MENU,
  getVectorEffectsPanel,
  vectorPaintToHex,
  type VectorEditorController,
  type VectorEffectParamSpec,
  type VectorEffectsPanelItem,
  type VectorEffectType,
} from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
const numberClass = 'h-7 w-16 rounded border border-border bg-background px-1.5 text-xs';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
/** Parameter names sit on their own line in a narrow panel, the controls below. */
const labelClass = 'w-full truncate text-[11px] text-muted-foreground';

export interface VectorEffectsPanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * The live path effects of the selection: add effects (to every selected node), and for one
 * selected node list its stack (applied top to bottom) to turn on and off, reorder, remove and
 * edit. Slider drags and typing are one undo step each. Expand Appearance bakes the effects and
 * live booleans into plain paths.
 */
export function VectorEffectsPanel({ controller, className }: VectorEffectsPanelProps) {
  const state = useVectorEditorState(controller);
  const panel = getVectorEffectsPanel(state);
  if (!panel) return null;
  const nodeId = panel.nodeId;
  const end = () => controller.endMergedEdit();
  const set = (e: VectorEffectsPanelItem, key: string, value: unknown, merge: boolean) => {
    if (nodeId) controller.updateEffect(nodeId, e.id, { params: { [key]: value } }, { merge });
  };
  const number = (e: VectorEffectsPanelItem, spec: VectorEffectParamSpec & { kind: 'number' }) => {
    const value = Number(e.params[spec.key] ?? 0);
    const label = `${e.label} ${spec.label}`;
    const onChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
      const n = parseFloat(ev.target.value);
      if (Number.isFinite(n)) set(e, spec.key, n, true);
    };
    return (
      <label key={spec.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-effect-param={spec.key}>
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
        <input
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          aria-label={label}
          className={numberClass}
          value={Math.round(value * 1000) / 1000}
          onChange={onChange}
          onBlur={end}
        />
      </label>
    );
  };
  const vec2 = (e: VectorEffectsPanelItem, spec: VectorEffectParamSpec) => {
    const v = (e.params[spec.key] as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
    const field = (axis: 'x' | 'y') => (
      <input
        type="number"
        step={spec.kind === 'vec2' ? spec.step : 1}
        aria-label={`${e.label} ${spec.label} ${axis}`}
        className={numberClass}
        value={Math.round(v[axis] * 1000) / 1000}
        onChange={(ev) => {
          const n = parseFloat(ev.target.value);
          if (Number.isFinite(n)) set(e, spec.key, { ...v, [axis]: n }, true);
        }}
        onBlur={end}
      />
    );
    return (
      <div key={spec.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-effect-param={spec.key}>
        <span className={labelClass}>{spec.label}</span>
        {field('x')}
        {field('y')}
      </div>
    );
  };
  const param = (e: VectorEffectsPanelItem, spec: VectorEffectParamSpec) => {
    if (spec.kind === 'number') return number(e, spec);
    if (spec.kind === 'vec2') return vec2(e, spec);
    if (spec.kind === 'boolean')
      return (
        <label key={spec.key} className="flex items-center gap-2 text-xs text-foreground" data-vector-effect-param={spec.key}>
          <span className="min-w-0 flex-1 truncate">{spec.label}</span>
          <input type="checkbox" aria-label={`${e.label} ${spec.label}`} checked={!!e.params[spec.key]} onChange={(ev) => set(e, spec.key, ev.target.checked, false)} />
        </label>
      );
    if (spec.kind === 'color') {
      // A colour, or none (the checkbox): none keeps the shape's own colour.
      const c = e.params[spec.key] as string | null;
      return (
        <div key={spec.key} className="flex items-center gap-2 text-xs text-foreground" data-vector-effect-param={spec.key}>
          <span className={labelClass}>{spec.label}</span>
          <input type="checkbox" aria-label={`${e.label} ${spec.label} on`} checked={c !== null} onChange={(ev) => set(e, spec.key, ev.target.checked ? '#ffffff' : null, false)} />
          <input type="color" aria-label={`${e.label} ${spec.label}`} className="h-6 w-8 cursor-pointer rounded border border-border bg-background disabled:opacity-40" disabled={c === null} value={vectorPaintToHex(c ?? '#ffffff') ?? '#ffffff'} onChange={(ev) => set(e, spec.key, ev.target.value, true)} onBlur={end} />
        </div>
      );
    }
    if (spec.kind !== 'select') return null;
    return (
      <label key={spec.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-effect-param={spec.key}>
        <span className={labelClass}>{spec.label}</span>
        <select aria-label={`${e.label} ${spec.label}`} className={selectClass} value={String(e.params[spec.key] ?? '')} onChange={(ev) => set(e, spec.key, ev.target.value, false)}>
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-effects="" aria-label="Effects">
      <div className="flex items-center gap-2">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Effects</span>
        <select
          aria-label="Add effect"
          className={selectClass}
          value=""
          onChange={(ev) => {
            if (ev.target.value) controller.addEffect(ev.target.value as VectorEffectType);
          }}
        >
          <option value="">Add effect…</option>
          {VECTOR_EFFECT_MENU.map((m) => (
            <option key={m.type} value={m.type}>
              {m.label}
            </option>
          ))}
        </select>
        <button type="button" className={buttonClass} title="Expand Appearance" aria-label="Expand Appearance" disabled={!panel.expandable} onClick={() => controller.expandAppearance()}>
          Expand
        </button>
      </div>
      {panel.count > 1 && <p className="text-[11px] text-muted-foreground">Select one object to edit its effects.</p>}
      {nodeId &&
        panel.effects.map((e, i) => (
          <div key={e.id} className="space-y-1 rounded border border-border p-1.5" data-vector-effect={e.id} data-vector-effect-type={e.type}>
            <div className="flex items-center gap-1">
              <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-foreground">
                <input type="checkbox" aria-label={`${e.label} on`} checked={e.enabled} onChange={(ev) => controller.updateEffect(nodeId, e.id, { enabled: ev.target.checked })} />
                <span className="truncate">{e.label}</span>
              </label>
              <button type="button" className={buttonClass} title="Move up" aria-label={`Move ${e.label} up`} disabled={i === 0} onClick={() => controller.moveEffect(nodeId, e.id, i - 1)}>
                ↑
              </button>
              <button
                type="button"
                className={buttonClass}
                title="Move down"
                aria-label={`Move ${e.label} down`}
                disabled={i === panel.effects.length - 1}
                onClick={() => controller.moveEffect(nodeId, e.id, i + 1)}
              >
                ↓
              </button>
              <button type="button" className={buttonClass} title="Remove" aria-label={`Remove ${e.label}`} onClick={() => controller.removeEffect(nodeId, e.id)}>
                ×
              </button>
            </div>
            {e.specs.map((spec) => param(e, spec))}
          </div>
        ))}
    </div>
  );
}
