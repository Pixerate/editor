// Bar chart races (Ursula's chart documents, src/chart/types.ts `BarRaceChartSpec`): each
// category is a time point, each series a name, and a frame is a moment between time points.
import type { ChartSeries, ChartSpec } from './types.js';

/** A series' value at time point `index`: its own, else the last value before it (0 before the first). */
export function chartRaceValueAt(series: Pick<ChartSeries, 'values'>, index: number): number {
	for (let i = Math.min(index, series.values.length - 1); i >= 0; i--) {
		const v = series.values[i];
		if (v !== null && v !== undefined && Number.isFinite(v)) return v;
	}
	return 0;
}

/** The moment `frame` stands for: the time points either side and how far between them (0–1). */
export function chartRaceMoment(count: number, frame: number | null | undefined): { from: number; to: number; t: number; at: number } {
	const last = Math.max(0, count - 1);
	const at = frame === null || frame === undefined || !Number.isFinite(frame) ? last : Math.max(0, Math.min(last, frame));
	const from = Math.floor(at);
	const to = Math.min(last, from + 1);
	return { from, to, t: at - from, at };
}

export interface ChartRaceEntry {
	seriesId: string;
	name: string;
	/** The value at the moment (between time points, eased from one to the next). */
	value: number;
	/** 0-based place at the moment, fractional while two names swap. */
	position: number;
	/** 0-based place at the nearest time point. */
	rank: number;
}

/**
 * Every visible series at a moment, best first: its value between the two time points and its
 * position, which slides from its rank at one time point to its rank at the next so bars swap
 * smoothly. Ties keep the series order.
 */
export function chartRaceRanking(spec: Pick<ChartSpec, 'series' | 'categories'>, frame: number | null | undefined): ChartRaceEntry[] {
	const visible = spec.series.filter((s) => !s.hidden);
	const { from, to, t } = chartRaceMoment(spec.categories.length, frame);
	const rankAt = (i: number) => {
		const order = visible.map((s, k) => ({ id: s.id, v: chartRaceValueAt(s, i), k })).sort((a, b) => b.v - a.v || a.k - b.k);
		return new Map(order.map((o, r) => [o.id, r] as const));
	};
	const r0 = rankAt(from);
	const r1 = rankAt(to);
	const near = t < 0.5 ? r0 : r1;
	return visible
		.map((s) => {
			const a = chartRaceValueAt(s, from);
			const b = chartRaceValueAt(s, to);
			return { seriesId: s.id, name: s.name, value: a + (b - a) * t, position: r0.get(s.id)! + (r1.get(s.id)! - r0.get(s.id)!) * t, rank: near.get(s.id)! };
		})
		.sort((a, b) => a.position - b.position || b.value - a.value);
}
