import { niceScale, type NiceScale } from './scale.js';
import type { ChartAxis, ChartMark, ChartMarker, ChartRect, ChartScene, ChartSelection, ChartSpec, ChartTheme, ChartValueScale, ChartWarning } from './types.js';

export type ChartTextMeasure = (text: string, size: number, weight?: number) => number;

export interface ChartLayoutOptions {
	width: number;
	height: number;
	theme?: Partial<ChartTheme>;
	/** Highlighted in the scene (selection outlines, `selected` flags). */
	selection?: ChartSelection | null;
	/** Text width in pixels (default: an estimate from the character count). */
	measureText?: ChartTextMeasure;
	/** Shown when there is nothing to draw (default "No data"). */
	emptyMessage?: string;
	/**
	 * Fixes the value axis to this range (over `yAxis.min` / `yAxis.max`). Canvases pass
	 * `ChartPointDrag.valueDomain` during a drag so the axis does not rescale under the pointer.
	 */
	valueDomain?: { min: number; max: number } | null;
	/** Fixes the secondary value axis the same way (`ChartPointDrag.valueDomain2`). */
	valueDomain2?: { min: number; max: number } | null;
	/** Fixes the numeric x axis of a scatter or bubble chart (`ChartPointDrag.xDomain`). */
	xDomain?: { min: number; max: number } | null;
	/** Shows the value of this point next to it (a `drag-readout` text mark, kept inside the plot). */
	readout?: { seriesId: string; index: number } | null;
}

/** A DOM-free text width estimate (average glyph ≈ 0.56 em, bold ≈ 0.6 em). */
export const estimateChartTextWidth: ChartTextMeasure = (text, size, weight = 400) => text.length * size * (weight >= 600 ? 0.6 : 0.56);

/** Whether two selections point at the same thing. */
export function sameChartSelection(a: ChartSelection | null | undefined, b: ChartSelection | null | undefined): boolean {
	if (!a || !b || a.kind !== b.kind) return false;
	switch (a.kind) {
		case 'axis':
			return a.axis === (b as typeof a).axis;
		case 'series':
			return a.seriesId === (b as typeof a).seriesId;
		case 'point':
		case 'trendline':
			return a.seriesId === (b as typeof a).seriesId && a.index === (b as typeof a).index;
		case 'category':
			return a.index === (b as typeof a).index;
		default:
			return true;
	}
}

/**
 * Black or white text for a label drawn on `fill` (#rgb, #rrggbb or rgb()), by perceived
 * luminance (0.299 R + 0.587 G + 0.114 B). Unparseable colours (CSS variables) get white.
 */
export function contrastingTextColor(fill: string): string {
	let rgb: number[] | null = null;
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(fill.trim());
	if (hex) {
		const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
		rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	} else {
		const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(fill.trim());
		if (fn) rgb = fn.slice(1, 4).map(Number);
	}
	if (!rgb) return '#ffffff';
	const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
	return luminance > 0.5 ? '#0f172a' : '#ffffff';
}

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** Shared state while one scene is laid out. */
export interface LayoutCtx {
	spec: ChartSpec;
	options: ChartLayoutOptions;
	theme: ChartTheme;
	measure: ChartTextMeasure;
	fs: number;
	width: number;
	height: number;
	marks: ChartMark[];
	warnings: ChartWarning[];
	selection: ChartSelection | null;
	isSelected(target: ChartSelection): boolean;
	seriesSelected(id: string): boolean;
	outline(key: string, box: ChartRect): void;
	warn(code: ChartWarning['code'], message: string): void;
}

/** What a family layout adds to the scene. */
export interface FamilyResult {
	plot: ChartRect;
	valueScale?: ChartValueScale;
	valueScale2?: ChartValueScale;
	xScale?: ChartValueScale;
	percent?: boolean;
}

export type ChartSceneBase = Omit<ChartScene, 'marks' | 'warnings' | 'theme' | 'width' | 'height'>;

export interface Pt {
	c: number;
	v: number;
}

/** Path through points (in category/value pixel space) with the chosen curve; `map` turns them into x/y. */
export function curvePath(points: Pt[], curve: ChartSpec['curve'], map: (p: Pt) => [number, number], moveFirst = true): string {
	if (!points.length) return '';
	const xy = points.map(map);
	let d = `${moveFirst ? 'M' : 'L'}${r2(xy[0][0])},${r2(xy[0][1])}`;
	if (points.length === 1) return d;
	if (curve === 'step') {
		for (let i = 1; i < points.length; i++) {
			const mid = (points[i - 1].c + points[i].c) / 2;
			const a = map({ c: mid, v: points[i - 1].v });
			const b = map({ c: mid, v: points[i].v });
			d += `L${r2(a[0])},${r2(a[1])}L${r2(b[0])},${r2(b[1])}L${r2(xy[i][0])},${r2(xy[i][1])}`;
		}
		return d;
	}
	if (curve === 'smooth' && points.length > 2) {
		// Monotone cubic (Fritsch–Carlson): smooth, never overshoots the data.
		const n = points.length;
		const dc = points.slice(1).map((p, i) => p.c - points[i].c);
		const slope = points.slice(1).map((p, i) => (dc[i] === 0 ? 0 : (p.v - points[i].v) / dc[i]));
		const tangent = points.map((_, i) => {
			if (i === 0) return slope[0];
			if (i === n - 1) return slope[n - 2];
			const a = slope[i - 1];
			const b = slope[i];
			if (a * b <= 0) return 0;
			const wa = 2 * dc[i] + dc[i - 1];
			const wb = dc[i] + 2 * dc[i - 1];
			return (wa + wb) / (wa / a + wb / b);
		});
		for (let i = 1; i < n; i++) {
			const h = dc[i - 1] / 3;
			const p0 = points[i - 1];
			const p1 = points[i];
			const a = map({ c: p0.c + h, v: p0.v + tangent[i - 1] * h });
			const b = map({ c: p1.c - h, v: p1.v - tangent[i] * h });
			d += `C${r2(a[0])},${r2(a[1])} ${r2(b[0])},${r2(b[1])} ${r2(xy[i][0])},${r2(xy[i][1])}`;
		}
		return d;
	}
	for (let i = 1; i < xy.length; i++) d += `L${r2(xy[i][0])},${r2(xy[i][1])}`;
	return d;
}

export function arcPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
	const full = end - start >= Math.PI * 2 - 1e-9;
	if (full) end = start + Math.PI * 2 - 1e-4;
	const p = (r: number, a: number) => `${r2(cx + r * Math.sin(a))},${r2(cy - r * Math.cos(a))}`;
	const large = end - start > Math.PI ? 1 : 0;
	let d = `M${p(outer, start)}A${r2(outer)},${r2(outer)} 0 ${large} 1 ${p(outer, end)}`;
	if (inner > 0) d += `L${p(inner, end)}A${r2(inner)},${r2(inner)} 0 ${large} 0 ${p(inner, start)}Z`;
	else d += `L${r2(cx)},${r2(cy)}Z`;
	return d;
}

export function truncate(text: string, maxWidth: number, size: number, measure: ChartTextMeasure): string {
	if (measure(text, size) <= maxWidth) return text;
	let out = text;
	while (out.length > 1 && measure(`${out}…`, size) > maxWidth) out = out.slice(0, -1);
	return `${out}…`;
}

/** The outline of a point marker centred on (cx, cy) with "radius" r, as an SVG path. */
export function markerPath(shape: Exclude<ChartMarker, 'circle' | 'none'>, cx: number, cy: number, r: number): string {
	switch (shape) {
		case 'square':
			return `M${r2(cx - r)},${r2(cy - r)}H${r2(cx + r)}V${r2(cy + r)}H${r2(cx - r)}Z`;
		case 'diamond': {
			const d = r * 1.3;
			return `M${r2(cx)},${r2(cy - d)}L${r2(cx + d)},${r2(cy)}L${r2(cx)},${r2(cy + d)}L${r2(cx - d)},${r2(cy)}Z`;
		}
		case 'triangle': {
			const d = r * 1.3;
			return `M${r2(cx)},${r2(cy - d)}L${r2(cx + d * 0.87)},${r2(cy + d * 0.5)}L${r2(cx - d * 0.87)},${r2(cy + d * 0.5)}Z`;
		}
		case 'cross': {
			const d = r;
			return `M${r2(cx - d)},${r2(cy - d)}L${r2(cx + d)},${r2(cy + d)}M${r2(cx - d)},${r2(cy + d)}L${r2(cx + d)},${r2(cy - d)}`;
		}
	}
}

/** The tick count for an axis `length` pixels long (about one per 56 px, 2–10). */
export const tickCount = (length: number) => Math.max(2, Math.min(10, Math.round(length / 56)));

/**
 * A value scale over [lo, hi] for an axis `length` pixels long: the axis' fixed ends and
 * step win, then `frozen` (a drag in progress) fixes both ends. `headroom` adds 5% above a
 * maximum that lands exactly on the top tick (lines and points would touch the frame).
 */
export function axisScale(lo: number, hi: number, length: number, axis: ChartAxis, frozen?: { min: number; max: number } | null, headroom = false): NiceScale {
	const fixedMin = frozen && Number.isFinite(frozen.min) ? frozen.min : axis.min;
	const fixedMax = frozen && Number.isFinite(frozen.max) ? frozen.max : axis.max;
	const step = axis.step;
	if (step && step > 0 && Number.isFinite(lo) && Number.isFinite(hi)) {
		let min = fixedMin ?? Math.floor(lo / step + 1e-9) * step;
		let max = fixedMax ?? Math.ceil(hi / step - 1e-9) * step;
		if (!(max > min)) max = min + step;
		const first = Math.ceil(min / step - 1e-9);
		const last = Math.floor(max / step + 1e-9);
		if (last - first <= 200) {
			const clean = (n: number) => (Math.abs(n) < 1e-12 ? 0 : Number(n.toPrecision(12)));
			min = clean(min);
			max = clean(max);
			const ticks: number[] = [];
			for (let i = first; i <= last; i++) ticks.push(clean(i * step));
			return { min, max, step, ticks };
		}
	}
	let scale = niceScale(lo, hi, tickCount(length), fixedMin, fixedMax);
	const roomy = hi + (hi - lo) * 0.05;
	if (headroom && fixedMax === null && hi !== 0 && hi > lo && scale.max === hi && Number.isFinite(roomy)) scale = niceScale(lo, roomy, tickCount(length), fixedMin, fixedMax);
	return scale;
}

/** Liang–Barsky: the part of segment a→b inside `rect`, or null. */
export function clipSegment(a: [number, number], b: [number, number], rect: ChartRect): [[number, number], [number, number]] | null {
	let t0 = 0;
	let t1 = 1;
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const checks: [number, number][] = [
		[-dx, a[0] - rect.x],
		[dx, rect.x + rect.width - a[0]],
		[-dy, a[1] - rect.y],
		[dy, rect.y + rect.height - a[1]]
	];
	for (const [p, q] of checks) {
		if (p === 0) {
			if (q < 0) return null;
			continue;
		}
		const r = q / p;
		if (p < 0) {
			if (r > t1) return null;
			if (r > t0) t0 = r;
		} else {
			if (r < t0) return null;
			if (r < t1) t1 = r;
		}
	}
	return [
		[a[0] + t0 * dx, a[1] + t0 * dy],
		[a[0] + t1 * dx, a[1] + t1 * dy]
	];
}

/** A polyline clipped to `rect` as path data (separate runs where it leaves and re-enters). */
export function clippedPolyline(points: [number, number][], rect: ChartRect): string {
	let d = '';
	let open = false;
	let last: [number, number] | null = null;
	for (let i = 1; i < points.length; i++) {
		const seg = clipSegment(points[i - 1], points[i], rect);
		if (!seg) {
			open = false;
			continue;
		}
		const [p, q] = seg;
		if (!open || !last || Math.abs(last[0] - p[0]) > 0.01 || Math.abs(last[1] - p[1]) > 0.01) d += `M${r2(p[0])},${r2(p[1])}`;
		d += `L${r2(q[0])},${r2(q[1])}`;
		last = q;
		open = true;
	}
	return d;
}
