import { useEffect, useMemo, useState } from 'react';
import {
  estimateJobProgress,
  planGenerationRequest,
  type GenerationPlan,
  type GenerationRequest,
  type JobProgressEstimate,
  type ModelCapabilities,
  type PlanOptions,
} from '@pixerate/editor/generation';

/**
 * Plans `request` against `capabilities` (see `planGenerationRequest`) and
 * returns the adjusted request, adjustments and errors. Recomputed only when
 * the request, capabilities or options change by value, so inline objects are fine.
 */
export function useGenerationPlan(
  request: GenerationRequest,
  capabilities: ModelCapabilities,
  options: PlanOptions = {},
): GenerationPlan {
  const key = JSON.stringify([request, capabilities, options]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => planGenerationRequest(request, capabilities, options), [key]);
}

export interface UseJobProgressOptions {
  startedAt: number | Date | string;
  expectedMs?: number;
  done?: boolean;
  /** Fixed current time (disables ticking; useful for SSR and tests). */
  now?: number | Date | string;
  /** Re-render interval while running in ms (default 1000). */
  intervalMs?: number;
}

/** Ticking `estimateJobProgress` for a running job; stops ticking when `done`. */
export function useJobProgress(options: UseJobProgressOptions): JobProgressEstimate {
  const { startedAt, expectedMs, done, now, intervalMs = 1000 } = options;
  const [tick, setTick] = useState(() => Date.now());
  const ticking = !done && now === undefined;
  useEffect(() => {
    if (!ticking) return;
    setTick(Date.now());
    const id = setInterval(() => setTick(Date.now()), Math.max(16, intervalMs));
    return () => clearInterval(id);
  }, [ticking, intervalMs]);
  return estimateJobProgress({ startedAt, expectedMs, done, now: now ?? tick });
}
