import React, { useState } from 'react';
import type { ImageEditorController, MaskEdgeReport, MaskEdgeTarget, SelectionMask } from '@pixerate/editor/image-editor';
import { MASK_EDGE_THRESHOLDS } from '@pixerate/editor/image-editor';

export interface MaskEdgeCheckProps {
  controller: ImageEditorController;
  /** The current selection (`state.selection`): a report on an older selection is cleared. */
  selection?: SelectionMask | null;
  /** What to check (default the selection); masks need `layerId`. */
  target?: MaskEdgeTarget;
  layerId?: string;
  className?: string;
}

const button =
  'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';

/**
 * Check Edge: measures the selection's (or a mask's) edge, as the `inspect_mask_edge` tool does,
 * and lists the scores (flagged past the thresholds), holes, islands and findings with fixes.
 */
export const MaskEdgeCheck: React.FC<MaskEdgeCheckProps> = ({ controller, selection, target = 'selection', layerId, className = '' }) => {
  const sel = selection === undefined ? controller.getSelection() : selection;
  const [result, setResult] = useState<{ report: MaskEdgeReport; for: SelectionMask | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = result && (target !== 'selection' || result.for === sel) ? result.report : null;
  const check = () => {
    setError(null);
    try {
      setResult({ report: controller.inspectMaskEdge(target, { layerId }), for: sel });
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const T = MASK_EDGE_THRESHOLDS;
  const rows = report
    ? [
        { label: 'Halo', value: report.haloScore, bad: report.haloScore >= T.halo },
        { label: 'Edge alignment', value: report.edgeAlignment, bad: report.edgeAlignment < T.alignment },
        { label: 'Jaggedness', value: report.jaggedness, bad: report.jaggedness >= T.jaggedness },
        { label: 'Soft edge', value: report.softFraction, bad: report.softFraction >= T.soft },
      ]
    : [];
  return (
    <div data-testid="mask-edge-check" className={`flex flex-col gap-1.5 text-xs ${className}`}>
      <button type="button" className={`${button} self-start`} disabled={target === 'selection' && !sel} onClick={check}>
        Check Edge
      </button>
      {report && (
        <>
          <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5">
            {rows.map((r) => (
              <React.Fragment key={r.label}>
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className={`font-mono text-right ${r.bad ? 'text-destructive' : 'text-foreground'}`}>{r.value}</dd>
              </React.Fragment>
            ))}
            <dt className="text-muted-foreground">Holes / islands</dt>
            <dd className={`font-mono text-right ${report.holes.count || report.islands.count ? 'text-destructive' : 'text-foreground'}`}>
              {report.holes.count} / {report.islands.count}
            </dd>
          </dl>
          {report.issues.length ? (
            <ul data-testid="mask-edge-issues" className="list-disc pl-4 flex flex-col gap-1 text-foreground">
              {report.issues.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">The edge looks clean.</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
