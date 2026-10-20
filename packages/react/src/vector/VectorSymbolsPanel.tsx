import React, { useId, useState } from 'react';
import { getVectorSymbolsPanel, vectorPaintToHex, type VectorEditorController } from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';
import { VectorFilterDefs, VectorGradientDefs, VectorSceneNodes } from './VectorCanvas';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const labelClass = 'w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

export interface VectorSymbolsPanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Symbols of the document with previews: New Symbol from the selection, Place, Edit (isolation
 * mode) and Delete per symbol; for a selected instance, Replace, Scale strokes, a fill tint and
 * Detach. Each change is one undo step.
 */
export function VectorSymbolsPanel({ controller, className }: VectorSymbolsPanelProps) {
  const state = useVectorEditorState(controller);
  const uid = useId().replace(/:/g, '');
  const panel = getVectorSymbolsPanel(state, { idPrefix: `vsym${uid}-` });
  const [error, setError] = useState<string | null>(null);
  const report = (r: { ok: boolean; message?: string }) => setError(r.ok ? null : (r.message ?? null));
  const inst = panel.instance;
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-symbols-panel="" aria-label="Symbols">
      <div className="flex items-center gap-1">
        <span className={labelClass}>Symbols</span>
        <button type="button" className={buttonClass} data-vector-symbol-action="make" disabled={!panel.canMake} title="New Symbol from the selection (F8)" onClick={() => report(controller.makeSymbol())}>
          New
        </button>
        {panel.editing && (
          <button type="button" className={buttonClass} data-vector-symbol-action="exit" title="Leave the symbol (Escape)" onClick={() => controller.exitSymbolEdit()}>
            Done
          </button>
        )}
      </div>
      {panel.symbols.length > 0 && (
        <ul className="space-y-1">
          {panel.symbols.map((s) => (
            <li key={s.id} data-vector-symbol={s.id} data-editing={s.editing || undefined} className="flex items-center gap-1">
              <svg viewBox={s.viewBox} width={28} height={28} className="shrink-0 rounded border border-border bg-background" aria-hidden="true">
                <VectorGradientDefs defs={s.scene.defs} />
                <VectorFilterDefs filters={s.scene.filters} />
                <VectorSceneNodes nodes={s.scene.nodes} />
              </svg>
              <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={`${s.name} · ${s.instances} instance${s.instances === 1 ? '' : 's'}`}>
                {s.name} <span className="text-muted-foreground">· {s.instances}</span>
              </span>
              <button type="button" className={buttonClass} aria-label={`Place ${s.name}`} title="Place an instance" onClick={() => report(controller.placeSymbol(s.id))}>
                +
              </button>
              <button type="button" className={buttonClass} aria-label={`Edit ${s.name}`} aria-pressed={s.editing} title="Edit Symbol (isolation mode)" onClick={() => report(controller.editSymbol(s.id))}>
                ✎
              </button>
              <button type="button" className={buttonClass} aria-label={`Delete ${s.name}`} title="Delete the symbol (its instances become groups)" onClick={() => report(controller.deleteSymbol(s.id, { detach: true }))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {inst && (
        <div className="space-y-1" data-vector-instance={inst.id}>
          <div className="flex items-center gap-1">
            <select aria-label="Instance symbol" className={selectClass} value={inst.symbolId} onChange={(e) => report(controller.replaceSymbol(e.target.value, { ids: [inst.id] }))}>
              {panel.symbols.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button type="button" className={buttonClass} title="Break Link to Symbol: a plain group of its art" onClick={() => report(controller.detachInstances({ ids: [inst.id] }))}>
              Detach
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-foreground">
              <input type="checkbox" aria-label="Scale strokes" checked={inst.scaleStrokes} onChange={(e) => report(controller.setInstanceOptions({ scaleStrokes: e.target.checked }, { ids: [inst.id] }))} />
              Scale strokes
            </label>
            <label className="flex items-center gap-1 text-xs text-foreground" title="Paint every fill of the art in this instance">
              Tint
              <input
                type="color"
                aria-label="Instance fill"
                className="h-6 w-8 rounded border border-border"
                value={vectorPaintToHex(inst.fill ?? undefined) ?? '#000000'}
                onChange={(e) => report(controller.setInstanceOptions({ fill: e.target.value }, { ids: [inst.id] }))}
              />
            </label>
            {inst.fill !== null && (
              <button type="button" className={buttonClass} aria-label="Clear tint" onClick={() => report(controller.setInstanceOptions({ fill: null }, { ids: [inst.id] }))}>
                ×
              </button>
            )}
          </div>
        </div>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
