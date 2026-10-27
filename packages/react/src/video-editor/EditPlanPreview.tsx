import React, { useState } from 'react';
import { describeVideoEditPlan, formatVideoSeconds, type VideoEditorController } from '@pixerate/editor/video-editor';
import { useVideoEditorState } from './useVideoEditor';

export interface EditPlanPreviewProps {
  controller: VideoEditorController;
  /** Allow accepting plans (default true; discarding is always allowed). */
  editable?: boolean;
  className?: string;
}

const btn = 'rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-40';

/**
 * Proposed edit plans waiting for review (from agents, cleanup or text edits): each with its title,
 * what it would do (length change, clips added, changed and removed, new problems), a strip of the
 * timeline showing the stretches it cuts (click one to go there) and Accept / Discard. Accepting
 * applies the plan as one undo step; a plan made before other edits is checked again first. Renders
 * nothing when no plan is open.
 */
export function EditPlanPreview({ controller, editable = true, className = '' }: EditPlanPreviewProps) {
  const state = useVideoEditorState(controller);
  const [message, setMessage] = useState<string | null>(null);
  if (!state.plans.length) return null;
  const total = Math.max(1, state.duration);
  return (
    <section className={`flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-2 text-xs ${className}`} aria-label="Proposed edits" data-edit-plans="">
      {state.plans.map((plan) => {
        const s = plan.summary;
        const stale = controller.isPlanStale(plan.id);
        return (
          <article key={plan.id} className="flex flex-col gap-1" data-edit-plan={plan.id}>
            <div className="flex items-center gap-2">
              <h3 className="flex-1 font-semibold">{plan.title}</h3>
              <span className={`tabular-nums ${s.durationDelta < 0 ? 'text-emerald-600' : 'text-muted-foreground'}`} data-plan-delta="">
                {s.durationDelta < 0 ? '−' : s.durationDelta > 0 ? '+' : '±'}
                {formatVideoSeconds(Math.abs(s.durationDelta))}
              </span>
            </div>
            {plan.description && <p className="text-muted-foreground">{plan.description}</p>}
            <p className="text-muted-foreground" data-plan-summary="">
              {describeVideoEditPlan(plan)} · {formatVideoSeconds(s.durationBefore)} → {formatVideoSeconds(s.durationAfter)}
            </p>
            {plan.ranges && plan.ranges.length > 0 && (
              <div className="relative h-3 w-full overflow-hidden rounded bg-muted" aria-label="Stretches the plan cuts" data-plan-strip="">
                {plan.ranges.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    className="absolute top-0 h-full bg-rose-500/70 hover:bg-rose-600"
                    style={{ left: `${(r.from / total) * 100}%`, width: `${Math.max(0.4, ((r.to - r.from) / total) * 100)}%` }}
                    title={`${r.reason ? `${r.reason}: ` : ''}${r.text ?? ''} (${formatVideoSeconds(r.from)})`}
                    aria-label={`Go to ${r.reason ?? 'cut'} at ${formatVideoSeconds(r.from)}`}
                    onClick={() => controller.seek(r.from)}
                  />
                ))}
              </div>
            )}
            {s.newIssues.length > 0 && <p className="text-amber-600">It would add {s.newIssues.length} problem{s.newIssues.length > 1 ? 's' : ''}: {s.newIssues[0].message}</p>}
            {stale && <p className="text-amber-600" data-plan-stale="">The project changed since this plan was made; it is checked again when accepted.</p>}
            <div className="flex gap-1">
              <button
                type="button"
                className={btn}
                disabled={!editable || state.readOnly}
                data-accept-plan=""
                onClick={() => {
                  const r = controller.applyPlan(plan.id);
                  setMessage(r.ok ? null : r.error);
                }}
              >
                Accept plan
              </button>
              <button type="button" className={btn} data-discard-plan="" onClick={() => (controller.discardPlan(plan.id), setMessage(null))}>
                Discard
              </button>
            </div>
          </article>
        );
      })}
      {message && (
        <p className="text-red-500" role="alert" data-plan-error="">
          {message}
        </p>
      )}
    </section>
  );
}
