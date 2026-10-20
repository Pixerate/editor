import React, { useState } from 'react';
import { getVectorConstraintPanel, type VectorConstraintAction, type VectorEditorController } from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
const inputClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const labelClass = 'w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

export interface VectorConstraintsPanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Constraints: the degrees of freedom left, the constraints the selection allows (pick anchors with
 * the direct tool, or round paths), Auto Constrain, the constraints of the selection with their
 * values, and the named parameters. Each change is one undo step.
 */
export function VectorConstraintsPanel({ controller, className }: VectorConstraintsPanelProps) {
  const state = useVectorEditorState(controller);
  const panel = getVectorConstraintPanel(state);
  const [error, setError] = useState<string | null>(null);
  const [param, setParam] = useState({ name: '', value: '' });
  const report = (r: { ok: boolean; message?: string }) => setError(r.ok ? null : (r.message ?? null));
  const add = (a: VectorConstraintAction) => report(controller.addConstraint({ kind: a.kind, refs: a.refs }));
  if (!panel.actions.length && !panel.constraints.length && !state.document.constraints?.length && state.tool !== 'direct') return null;
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-constraints-panel="" data-dof-status={panel.dof.status} aria-label="Constraints">
      <div className="flex items-center gap-1">
        <span className={labelClass}>Constraints</span>
        <span className="flex-1 truncate text-[11px] text-muted-foreground" data-vector-dof="">
          {panel.dof.message}
        </span>
        <button type="button" className={buttonClass} title="Auto Constrain: add what the selection (or the drawing) nearly satisfies" onClick={() => report(controller.autoConstrain())}>
          Auto
        </button>
      </div>
      {panel.actions.length > 0 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Add constraint">
          {panel.actions.map((a) => (
            <button key={a.kind} type="button" className={buttonClass} data-vector-constraint-action={a.kind} title={`Add ${a.label}`} onClick={() => add(a)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {panel.constraints.length > 0 && (
        <ul className="space-y-1">
          {panel.constraints.map((c) => (
            <li key={c.id} data-vector-constraint={c.id} data-satisfied={c.satisfied && !c.conflict ? 'true' : 'false'} className="flex items-center gap-1 text-xs text-foreground">
              <span className={`min-w-0 flex-1 truncate ${c.conflict || !c.satisfied ? 'text-destructive' : ''}`}>
                {c.label}
                {c.name ? ` ${c.name}` : ''}
              </span>
              {c.value !== undefined && (
                <input
                  aria-label={`Value of ${c.name ?? c.id}`}
                  className={`${inputClass} w-16 flex-none`}
                  defaultValue={c.value}
                  key={`${c.id}:${c.value}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  onBlur={(e) => {
                    if (e.target.value.trim() !== c.value) report(controller.setConstraintValue(c.id, e.target.value));
                  }}
                />
              )}
              <button type="button" className={buttonClass} aria-label={`Remove ${c.label} constraint`} onClick={() => report(controller.removeConstraints([c.id]))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-1" aria-label="Parameters">
        {panel.parameters.map((p) => (
          <div key={p.name} className="flex items-center gap-1 text-xs">
            <span className="w-12 truncate font-mono">{p.name}</span>
            <input
              aria-label={`Parameter ${p.name}`}
              className={inputClass}
              defaultValue={p.value}
              key={`${p.name}:${p.value}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              onBlur={(e) => {
                if (e.target.value.trim() !== p.value) report(controller.setConstraintValue(p.name, e.target.value));
              }}
            />
            <span className="w-10 text-right text-muted-foreground">{p.result === null ? '!' : Math.round(p.result * 100) / 100}</span>
          </div>
        ))}
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!param.name.trim()) return;
            const r = controller.setConstraintValue(param.name.trim(), param.value);
            report(r);
            if (r.ok) setParam({ name: '', value: '' });
          }}
        >
          <input aria-label="New parameter name" placeholder="name" className={`${inputClass} w-12 flex-none`} value={param.name} onChange={(e) => setParam({ ...param, name: e.target.value })} />
          <input aria-label="New parameter value" placeholder="value" className={inputClass} value={param.value} onChange={(e) => setParam({ ...param, value: e.target.value })} />
          <button type="submit" className={buttonClass} aria-label="Add parameter">
            +
          </button>
        </form>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
