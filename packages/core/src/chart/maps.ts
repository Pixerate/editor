// Map outlines for choropleth charts. The chart module holds only this registry: the geometry
// lives in `@pixerate/editor/chart-maps` (Natural Earth outlines), so it is loaded only by hosts
// that register it, as Ursula leaves map geometry to its host.
import { shadeChartColor } from './color.js';

/** One region of a map: an id (ISO 3166-1 alpha-3 for countries), a name and its outline. */
export interface ChartMapRegion {
	id: string;
	name: string;
	/** SVG path data in the map's box (absolute M / L / Z commands). */
	d: string;
	/** Where a label or a marker goes, in the map's box. */
	center: [number, number];
	/** Area in square box units (0 for a region too small to outline, drawn as a marker). */
	area: number;
}

export interface ChartMapGeometry {
	/** What `spec.map` names, e.g. `europe`. */
	id: string;
	name: string;
	width: number;
	height: number;
	regions: ChartMapRegion[];
	/** Land in the frame that is not a region (neighbouring countries), drawn as background. */
	land?: string;
	/** Credit to show with the map (Natural Earth asks for none, but welcomes it). */
	attribution?: string;
}

const maps = new Map<string, ChartMapGeometry>();

/** Makes a map available to choropleth charts (`spec.map` = its id). Registering an id again replaces it. */
export function registerChartMap(map: ChartMapGeometry): void {
	maps.set(map.id, map);
}

/** A registered map by id, or undefined. */
export function getChartMap(id: string): ChartMapGeometry | undefined {
	return maps.get(id);
}

/** Every registered map. */
export function listChartMaps(): ChartMapGeometry[] {
	return [...maps.values()];
}

const fold = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/**
 * The region each category names, matched by id (any case) or by name (ignoring case and
 * accents), or null. Several categories may not name the same region: the first wins.
 */
export function matchChartMapRegions(map: ChartMapGeometry, categories: readonly string[]): (ChartMapRegion | null)[] {
	const byKey = new Map<string, ChartMapRegion>();
	for (const r of map.regions) {
		byKey.set(fold(r.id), r);
		byKey.set(fold(r.name), r);
	}
	const taken = new Set<string>();
	return categories.map((c) => {
		const r = byKey.get(fold(c));
		if (!r || taken.has(r.id)) return null;
		taken.add(r.id);
		return r;
	});
}

/**
 * Class breaks for a choropleth: `thresholds` when given (ascending), else `steps` equal
 * intervals between the smallest and largest value. Returns the inner breaks (one fewer than the classes).
 */
export function chartMapBreaks(values: readonly number[], steps: number, thresholds: readonly number[]): number[] {
	if (thresholds.length) return [...thresholds];
	if (!values.length) return [];
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	if (!(hi > lo)) return [];
	const exact = Array.from({ length: steps - 1 }, (_, k) => lo + ((hi - lo) * (k + 1)) / steps);
	// Round to two significant figures for a readable legend, or more where that would merge breaks.
	for (let digits = 2; digits <= 6; digits++) {
		const rounded = exact.map((b) => Number(b.toPrecision(digits)));
		if (rounded.every((b, i) => i === 0 || b > rounded[i - 1])) return rounded;
	}
	return exact;
}

/** The class (0-based) a value falls in: the number of breaks at or below it. */
export const chartMapClass = (value: number, breaks: readonly number[]) => breaks.filter((b) => value >= b).length;

/** A light-to-dark ramp of `count` shades of `base`, one per class. */
export function chartMapRamp(base: string, count: number): string[] {
	if (count <= 1) return [base];
	return Array.from({ length: count }, (_, k) => shadeChartColor(base, 0.82 - (1.17 * k) / (count - 1)));
}
