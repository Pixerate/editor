import React from 'react';
import type { StyleCheckReport, StyleFinding } from '@pixerate/editor/tools';

export interface StyleFindingsProps {
  /** A check report (`useStyleFindings(...).report`, or a `check_*_style` tool result). Renders nothing while `null`. */
  report: StyleCheckReport | null | undefined;
  /** Called when a finding with a `target` is clicked, e.g. to select that series in the chart. */
  onSelect?: (finding: StyleFinding) => void;
  /** Heading (default "House style"). */
  title?: string;
  className?: string;
}

const SEVERITY_CLASS: Record<StyleFinding['severity'], string> = {
  error: 'text-destructive',
  warning: 'text-amber-600',
  info: 'text-muted-foreground',
};

/** The house-style findings for the current state, with the checks that could not run. */
export function StyleFindings({ report, onSelect, title = 'House style', className = '' }: StyleFindingsProps) {
  if (!report) return null;
  const { findings, ran, skipped } = report;
  return (
    <section data-style-findings="" aria-label={title} className={`flex flex-col gap-1.5 text-xs text-foreground ${className}`}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {findings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {findings.map((finding, i) => {
            const selectable = finding.target !== undefined && !!onSelect;
            const body = (
              <>
                <span data-style-severity={finding.severity} className={`shrink-0 font-semibold uppercase text-[10px] ${SEVERITY_CLASS[finding.severity]}`}>
                  {finding.severity}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span data-style-message="">{finding.message}</span>
                  <span className="text-[10px] text-muted-foreground">
                    <code>{finding.check}</code>
                    {finding.layer && <> · {finding.layer}</>}
                  </span>
                </span>
              </>
            );
            return (
              <li key={`${finding.check}-${i}`} data-style-finding={finding.check}>
                {selectable ? (
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 rounded border border-border px-2 py-1 text-left hover:bg-muted"
                    onClick={() => onSelect!(finding)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex items-start gap-2 rounded border border-border px-2 py-1">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {findings.length === 0 && ran.length > 0 && (
        <p data-style-clear="" className="text-emerald-600">
          All clear: {ran.length} {ran.length === 1 ? 'check' : 'checks'} passed.
        </p>
      )}
      {findings.length === 0 && ran.length === 0 && skipped.length === 0 && (
        <p className="text-muted-foreground">No house-style checks apply.</p>
      )}
      {skipped.length > 0 && (
        <ul data-style-skipped="" aria-label="Skipped checks" className="flex flex-col gap-0.5 text-muted-foreground">
          {skipped.map((s) => (
            <li key={s.check} data-style-skipped-check={s.check}>
              Skipped <code>{s.check}</code>: {s.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
