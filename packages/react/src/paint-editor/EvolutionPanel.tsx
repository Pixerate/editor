import React, { useState, useSyncExternalStore } from 'react';
import {
  EVOLUTION_SLIDERS,
  exportProposalContactSheetPng,
  evolutionStrokeRefusal,
  normalizeMutationRates,
  paintProposalGhost,
  proposalGenomeStrokes,
  type EvolutionMutationRates,
  type PaintEditorController,
  type PaintProposals,
} from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, PaintSlider, PixelCanvas, button, chip, panel, useAttempt } from './shared';

export interface EvolutionPanelProps {
  controller: PaintEditorController;
  /** Optional proposals store (defaults to `controller.proposals`). */
  proposals?: PaintProposals;
  className?: string;
}

/**
 * Evolutionary strokes: pick recorded dry strokes, adjust mutation rates (`geometry`, `color`,
 * `brush`, `seed`), and breed a grid of mutated stroke proposals. Variants can be bred further
 * (single parent mutation or two-parent crossover), accepted as a single undo step, dismissed, or
 * exported as a contact sheet.
 */
export const EvolutionPanel: React.FC<EvolutionPanelProps> = ({ controller, proposals, className }) => {
  const state = usePaintEditorState(controller);
  const store = proposals ?? controller.proposals;
  const proposalState = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [error, attempt] = useAttempt();

  const [selectedStrokes, setSelectedStrokes] = useState<string[]>([]);
  const [selectedProposals, setSelectedProposals] = useState<string[]>([]);
  const [count, setCount] = useState(4);
  const [seed, setSeed] = useState(1);
  const [mutation, setMutation] = useState<Required<EvolutionMutationRates>>(() => normalizeMutationRates());
  const [contactSheetUrl, setContactSheetUrl] = useState<string | null>(null);

  const eligibleStrokes = state.document.strokes.filter((s) => !evolutionStrokeRefusal(s.brush));
  const activeStrokeIds = selectedStrokes.filter((id) => eligibleStrokes.some((s) => s.id === id));
  const effectiveStrokeIds =
    activeStrokeIds.length > 0
      ? activeStrokeIds
      : state.selectedStroke && eligibleStrokes.some((s) => s.id === state.selectedStroke)
        ? [state.selectedStroke]
        : eligibleStrokes.length > 0
          ? [eligibleStrokes[eligibleStrokes.length - 1]!.id]
          : [];

  const variants = proposalState.proposals.filter((p) => proposalGenomeStrokes(p).length > 0);
  const activeProposalIds = selectedProposals.filter((id) => variants.some((v) => v.id === id));

  const toggleStroke = (id: string) => {
    setSelectedStrokes((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev.slice(-15), id]));
  };

  const toggleProposal = (id: string) => {
    setSelectedProposals((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev.slice(-1), id]));
  };

  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="evolution-panel">
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-300">Evolution ({eligibleStrokes.length})</span>
        <div className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            <span>Count</span>
            <input
              type="number"
              aria-label="Variant count"
              min={2}
              max={12}
              value={count}
              onChange={(e) => setCount(Math.max(2, Math.min(12, Number(e.target.value) || 4)))}
              className="w-11 rounded bg-slate-800 px-1 py-0.5 text-right font-mono text-slate-200"
            />
          </label>
        </div>
      </div>

      {eligibleStrokes.length > 0 && (
        <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto" role="listbox" aria-label="Parent strokes">
          {eligibleStrokes.map((s, i) => {
            const on = effectiveStrokeIds.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={on}
                title={`${i + 1}. ${s.brush.name} (${s.id})`}
                className={`h-5 w-5 rounded ring-1 ${on ? 'ring-indigo-400' : 'ring-slate-700'}`}
                style={{ background: s.color }}
                onClick={() => toggleStroke(s.id)}
              />
            );
          })}
        </div>
      )}

      {EVOLUTION_SLIDERS.map((c) => {
        const key = c.path as keyof EvolutionMutationRates;
        return (
          <PaintSlider
            key={c.path}
            control={c}
            value={mutation[key]}
            onChange={(v) => setMutation((prev) => ({ ...prev, [key]: v }))}
          />
        );
      })}

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={button}
          disabled={effectiveStrokeIds.length === 0 || state.stroking}
          onClick={() =>
            attempt(() => {
              controller.breedStrokes({ strokeIds: effectiveStrokeIds, count, mutation, seed });
              setSeed((s) => s + 1);
            })
          }
        >
          Breed strokes
        </button>
        {activeProposalIds.length === 2 && (
          <button
            type="button"
            className={button}
            disabled={state.stroking}
            onClick={() =>
              attempt(() => {
                controller.breedProposal({ proposalIds: activeProposalIds, count, mutation, seed });
                setSeed((s) => s + 1);
              })
            }
          >
            Cross over (2)
          </button>
        )}
        {variants.length > 0 && (
          <button
            type="button"
            className={button}
            onClick={() =>
              attempt(() => {
                const sheet = exportProposalContactSheetPng(controller, variants);
                setContactSheetUrl(`data:image/png;base64,${sheet.base64}`);
              })
            }
          >
            Contact sheet
          </button>
        )}
      </div>

      {variants.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5" data-testid="evolution-grid">
          {variants.map((p) => {
            const g = paintProposalGhost(p);
            const picked = activeProposalIds.includes(p.id);
            return (
              <div
                key={p.id}
                data-testid={`evolution-variant-${p.id}`}
                className={`flex flex-col gap-1 rounded border p-1.5 ${picked ? 'border-indigo-500 bg-slate-800/90' : 'border-slate-800 bg-slate-950/60'}`}
              >
                <div className="flex items-center justify-between gap-1">
                  <button
                    type="button"
                    aria-pressed={picked}
                    className={chip(picked)}
                    onClick={() => toggleProposal(p.id)}
                  >
                    {p.title}
                  </button>
                </div>
                {g && (
                  <div className="flex h-16 items-center justify-center overflow-hidden rounded bg-slate-900/80 p-1">
                    <PixelCanvas pixels={g} label={p.title} className="max-h-full max-w-full object-contain" />
                  </div>
                )}
                {p.rationale && (
                  <span className="line-clamp-2 text-[10px] text-slate-400" title={p.rationale}>
                    {p.rationale}
                  </span>
                )}
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    className={button}
                    disabled={state.stroking}
                    onClick={() =>
                      attempt(() => {
                        controller.breedProposal({ proposalIds: [p.id], count, mutation, seed });
                        setSeed((s) => s + 1);
                      })
                    }
                  >
                    Breed from
                  </button>
                  <button type="button" className={button} onClick={() => attempt(() => store.accept(p.id))}>
                    Accept
                  </button>
                  <button type="button" className={button} onClick={() => attempt(() => store.reject(p.id))}>
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {contactSheetUrl && (
        <img src={contactSheetUrl} alt="Variant contact sheet" className="w-full rounded border border-slate-800" data-testid="evolution-contact-sheet" />
      )}

      <ErrorLine error={error} />
    </div>
  );
};
