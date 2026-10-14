import React from 'react';
import { useJobProgress, type UseJobProgressOptions } from './useGenerationPlan';

export interface JobProgressProps extends UseJobProgressOptions {
  /** Text shown before the time label, e.g. the model name. */
  title?: string;
  /** Extra classes for the root. */
  className?: string;
}

/**
 * Headless-styled progress bar for a generation job that reports no progress
 * of its own: time-based percent (held at 95% until `done`) with a
 * "~2m left" / "Almost done…" label. Exposes `role="progressbar"`.
 */
export const JobProgress: React.FC<JobProgressProps> = ({ title, className = '', ...options }) => {
  const progress = useJobProgress(options);
  return (
    <div className={`flex flex-col gap-1 text-sm ${className}`} data-job-progress="" data-done={options.done ? '' : undefined}>
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        {title && <span className="truncate text-foreground">{title}</span>}
        <span data-job-progress-label="" aria-live="polite">
          {progress.label}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={title ?? 'Generation progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-valuetext={`${progress.percent}%, ${progress.label}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${progress.percent}%`, background: 'var(--primary, currentColor)' }}
        />
      </div>
    </div>
  );
};
