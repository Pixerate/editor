import type { GenerationRequest, ModelCapabilities } from './capabilities.js';
import { resolutionMegapixels } from './plan.js';

export interface JobProgressInput {
	/** Start time (ms since epoch, `Date` or ISO string). */
	startedAt: number | Date | string;
	/** Current time (default `Date.now()`). */
	now?: number | Date | string;
	/** Expected total duration in ms. Without it progress eases towards 95%. */
	expectedMs?: number;
	/** The job finished. */
	done?: boolean;
}

export interface JobProgressEstimate {
	/** 0–100. Never above 95 until `done`. */
	percent: number;
	/** E.g. `~2m left`, `~40s left`, `Almost done…`, `Starting…`, `Done`. */
	label: string;
	elapsedMs: number;
	/** Estimated ms left (`undefined` without `expectedMs`). */
	remainingMs?: number;
	/** Running longer than expected. */
	overdue: boolean;
}

/** Highest percentage shown before a job reports completion. */
export const MAX_PENDING_PERCENT = 95;
/** Remaining time under which the label switches to "Almost done…". */
const ALMOST_DONE_MS = 5_000;
/** Time constant for jobs without an expected duration. */
const UNKNOWN_DURATION_TAU_MS = 30_000;

const toMs = (value: number | Date | string) => (typeof value === 'number' ? value : new Date(value).getTime());

/** `~45s left`, `~2m left`, `~1h 5m left`. Minutes and seconds round up. */
export function formatRemaining(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	if (seconds < 60) return `~${Math.max(1, seconds)}s left`;
	const minutes = Math.ceil(ms / 60_000);
	if (minutes < 60) return `~${minutes}m left`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `~${hours}h ${rest}m left` : `~${hours}h left`;
}

/**
 * Progress for a job that reports no progress of its own: linear in elapsed
 * time over `expectedMs`, held at 95% until `done` (so the bar never sits at
 * 100% while still waiting), with a "~2m left" style label that turns into
 * "Almost done…" near or past the expected end. Pure: pass `now` to test.
 */
export function estimateJobProgress(input: JobProgressInput): JobProgressEstimate {
	const started = toMs(input.startedAt);
	const now = toMs(input.now ?? Date.now());
	const elapsedMs = Math.max(0, now - started);
	if (input.done) return { percent: 100, label: 'Done', elapsedMs, remainingMs: 0, overdue: false };
	if (!Number.isFinite(started) || now <= started) {
		return { percent: 0, label: 'Starting…', elapsedMs: 0, ...(input.expectedMs ? { remainingMs: input.expectedMs } : {}), overdue: false };
	}
	const expected = input.expectedMs;
	if (!expected || !(expected > 0)) {
		const percent = MAX_PENDING_PERCENT * (1 - Math.exp(-elapsedMs / UNKNOWN_DURATION_TAU_MS));
		return { percent: Math.floor(percent), label: 'Working…', elapsedMs, overdue: false };
	}
	const remainingMs = Math.max(0, expected - elapsedMs);
	const percent = Math.min(MAX_PENDING_PERCENT, Math.floor((elapsedMs / expected) * 100));
	return {
		percent,
		label: remainingMs <= ALMOST_DONE_MS ? 'Almost done…' : formatRemaining(remainingMs),
		elapsedMs,
		remainingMs,
		overdue: elapsedMs > expected
	};
}

/**
 * Expected duration of a request from the model's `timing`: `baseMs`, plus
 * `perItemMs` per output beyond the first, `perSecondMs` per second of
 * duration and `perMegapixelMs` per megapixel of resolution. `undefined` when
 * the model has no timing.
 */
export function expectedDurationFor(caps: ModelCapabilities, request: GenerationRequest = {}): number | undefined {
	const timing = caps.timing;
	if (!timing) return undefined;
	const count = request.count ?? caps.count?.default ?? 1;
	const duration = request.duration ?? caps.duration?.default ?? 0;
	const resolution = request.resolution ?? caps.resolutions?.default;
	const megapixels = resolution ? (resolutionMegapixels(resolution) ?? 0) : 0;
	return Math.round(
		timing.baseMs +
			(timing.perItemMs ?? 0) * Math.max(0, count - 1) +
			(timing.perSecondMs ?? 0) * duration +
			(timing.perMegapixelMs ?? 0) * megapixels
	);
}
