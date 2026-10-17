// The label ladder follows `ruler_steps` in filmcraft-main/crates/ui-egui/src/panels/timeline.rs (the first
// step on a ladder that keeps labels a minimum distance apart) (MIT OR Apache-2.0, © ArtCraft Team and
// contributors), adapted to calendar units. See THIRD_PARTY_NOTICES.md.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Reads a category label as a UTC date: `2024`, `2024-03`, `2024-03-05`, ISO date-times,
 * `2024/03/05`, `Mar 2024` and `5 Mar 2024`. Returns milliseconds since the epoch, or `null`.
 */
export function parseChartDate(label: string): number | null {
	const text = label.trim();
	let m = /^(\d{4})$/.exec(text);
	if (m) return Date.UTC(Number(m[1]), 0, 1);
	m = /^(\d{4})[-/](\d{1,2})$/.exec(text);
	if (m) return valid(Number(m[1]), Number(m[2]) - 1, 1);
	m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
	if (m) {
		if (m[4] !== undefined) {
			const t = Date.parse(text.replace(' ', 'T').replace(/\//g, '-') + (m[7] ? '' : 'Z'));
			return Number.isFinite(t) ? t : null;
		}
		return valid(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	}
	m = /^(?:(\d{1,2})\s+)?([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(text);
	if (m) {
		const month = MONTHS.findIndex((x) => x.toLowerCase() === m![2].toLowerCase());
		if (month >= 0) return valid(Number(m[3]), month, m[1] ? Number(m[1]) : 1);
	}
	return null;
}

function valid(y: number, mo: number, d: number): number | null {
	const t = Date.UTC(y, mo, d);
	const date = new Date(t);
	return date.getUTCFullYear() === y && date.getUTCMonth() === mo && date.getUTCDate() === d ? t : null;
}

/** Calendar steps from fine to coarse. */
export const CHART_DATE_STEPS = [
	{ unit: 'day', count: 1 },
	{ unit: 'day', count: 2 },
	{ unit: 'week', count: 1 },
	{ unit: 'week', count: 2 },
	{ unit: 'month', count: 1 },
	{ unit: 'month', count: 3 },
	{ unit: 'month', count: 6 },
	{ unit: 'year', count: 1 },
	{ unit: 'year', count: 2 },
	{ unit: 'year', count: 5 },
	{ unit: 'year', count: 10 },
	{ unit: 'year', count: 25 },
	{ unit: 'year', count: 50 },
	{ unit: 'year', count: 100 }
] as const;

export type ChartDateStep = (typeof CHART_DATE_STEPS)[number];

/** Which bucket of `step` a time falls in (equal buckets share a label). */
function bucket(t: number, step: ChartDateStep): number {
	const d = new Date(t);
	const y = d.getUTCFullYear();
	switch (step.unit) {
		case 'day':
			return Math.floor(Math.floor(t / 86400000) / step.count);
		case 'week':
			// Weeks start on Monday (1970-01-05 was one).
			return Math.floor(Math.floor((t / 86400000 - 4) / 7) / step.count);
		case 'month':
			return Math.floor((y * 12 + d.getUTCMonth()) / step.count);
		case 'year':
			return Math.floor(y / step.count);
	}
}

/** A label for a date at `step`: years as `2024`, months as `Mar 2024` (`Mar` within a year), days as `5 Mar`. */
export function formatChartDate(t: number, step: ChartDateStep, previous: number | null = null): string {
	const d = new Date(t);
	const y = d.getUTCFullYear();
	const mo = MONTHS[d.getUTCMonth()];
	const sameYear = previous !== null && new Date(previous).getUTCFullYear() === y;
	if (step.unit === 'year') return String(y);
	if (step.unit === 'month') return sameYear ? mo : `${mo} ${y}`;
	return sameYear ? `${d.getUTCDate()} ${mo}` : `${d.getUTCDate()} ${mo} ${y}`;
}

export interface ChartDateLabels {
	/** The calendar step chosen. */
	step: ChartDateStep;
	/** Category indexes that get a label (the first category in each bucket). */
	indexes: number[];
	/** Label text by category index. */
	labels: Map<number, string>;
}

/**
 * Picks the finest calendar step whose labels fit along a category axis. Categories are
 * evenly spaced (`band` pixels each), so a label goes on the first category of each bucket,
 * and the step is the first on the ladder whose neighbouring labels are at least their own
 * width plus `gap` apart. Returns `null` when fewer than half the categories read as dates.
 */
export function chartDateLabels(categories: readonly string[], band: number, measure: (text: string) => number, gap = 10): ChartDateLabels | null {
	const times = categories.map(parseChartDate);
	if (times.filter((t) => t !== null).length < Math.max(1, categories.length / 2)) return null;
	// Steps much finer than the data's own spacing would only relabel the same points.
	const present = times.filter((t): t is number => t !== null).sort((x, y) => x - y);
	const gaps = present.slice(1).map((t, i) => t - present[i]).filter((g) => g > 0).sort((x, y) => x - y);
	const spacing = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
	const DAY = 86400000;
	const length = (step: ChartDateStep) => step.count * (step.unit === 'day' ? DAY : step.unit === 'week' ? 7 * DAY : step.unit === 'month' ? 30 * DAY : 365 * DAY);
	for (const step of CHART_DATE_STEPS) {
		if (length(step) < spacing * 0.5 && step !== CHART_DATE_STEPS[CHART_DATE_STEPS.length - 1]) continue;
		const indexes: number[] = [];
		const labels = new Map<number, string>();
		let last: number | null = null;
		let lastTime: number | null = null;
		times.forEach((t, i) => {
			if (t === null) return;
			const b = bucket(t, step);
			if (b === last) return;
			last = b;
			indexes.push(i);
			labels.set(i, formatChartDate(t, step, lastTime));
			lastTime = t;
		});
		let fits = true;
		for (let k = 1; k < indexes.length && fits; k++) {
			const a = labels.get(indexes[k - 1])!;
			const b = labels.get(indexes[k])!;
			if ((indexes[k] - indexes[k - 1]) * band < (measure(a) + measure(b)) / 2 + gap) fits = false;
		}
		if (fits || step === CHART_DATE_STEPS[CHART_DATE_STEPS.length - 1]) return { step, indexes, labels };
	}
	return null;
}
