// Reference lines and bands, callouts, highlight and the note: the annotations Ursula's chart
// documents carry (src/chart/types.ts `referenceLines`, `referenceBands`, `callouts`, `highlight`, `note`).
import { truncate, type LayoutCtx } from './layout-shared.js';
import type { ScaleInfo } from './layout-cartesian.js';
import type { ChartMark, ChartMarkRole, ChartRect, ChartReferenceAxis, ChartSelection, ChartSpec } from './types.js';

const axisOf = (item: { axis?: ChartReferenceAxis }): ChartReferenceAxis => item.axis ?? 'y';

/** Chart families that draw reference lines, bands and callouts. */
export const chartAnnotationFamily = (family: string) => family === 'cartesian' || family === 'xy';

/** Values the reference lines and bands on `axis` need the axis to reach. */
export function referenceValues(spec: Pick<ChartSpec, 'referenceLines' | 'referenceBands'>, axis: ChartReferenceAxis): number[] {
	const out: number[] = [];
	for (const l of spec.referenceLines) if (axisOf(l) === axis) out.push(l.value);
	for (const b of spec.referenceBands) if (axisOf(b) === axis) out.push(b.from, b.to);
	return out;
}

/** One axis the references can be drawn on: its scale, and whether values run up the screen (`vertical`). */
export interface ReferenceAxis {
	info: ScaleInfo;
	vertical: boolean;
}

/**
 * Draws the reference bands (`layer` `bands`, under the data) or lines (`lines`, over it) on
 * the axes given. References on an axis the chart does not have are skipped with a warning.
 */
export function drawReferences(ctx: LayoutCtx, plot: ChartRect, axes: Partial<Record<ChartReferenceAxis, ReferenceAxis>>, layer: 'bands' | 'lines') {
	const { spec, theme, marks, fs, measure } = ctx;
	const items = layer === 'bands' ? spec.referenceBands : spec.referenceLines;
	const missing = new Set<ChartReferenceAxis>();
	items.forEach((item, i) => {
		const axis = axes[axisOf(item)];
		if (!axis) {
			missing.add(axisOf(item));
			return;
		}
		const { info, vertical } = axis;
		const color = item.color ?? theme.text;
		const lo = vertical ? plot.y : plot.x;
		const hi = vertical ? plot.y + plot.height : plot.x + plot.width;
		const inside = (p: number) => Number.isFinite(p) && p >= lo - 0.5 && p <= hi + 0.5;
		// Values a log axis cannot place (0 or less) have no pixel.
		const at = (v: number) => (info.logBase && !(v > 0) ? NaN : info.raw(v));
		if ('from' in item) {
			const a = at(item.from);
			const b = at(item.to);
			if (!Number.isFinite(a) || !Number.isFinite(b)) return;
			const p0 = Math.max(lo, Math.min(a, b));
			const p1 = Math.min(hi, Math.max(a, b));
			if (p1 <= p0) return;
			const rect = vertical ? { x: plot.x, y: p0, width: plot.width, height: p1 - p0 } : { x: p0, y: plot.y, width: p1 - p0, height: plot.height };
			marks.push({ kind: 'rect', key: `reference-band-${i}`, role: 'reference-band', ...rect, fill: color, opacity: item.color ? 0.16 : 0.07 });
			if (item.label) {
				const text = truncate(item.label, (vertical ? plot.width : rect.width) - 8, fs - 1, measure);
				marks.push({ kind: 'text', key: `reference-label-band-${i}`, role: 'reference-label', x: rect.x + 4, y: rect.y + 3, text, anchor: 'start', baseline: 'top', size: fs - 1, fill: color, opacity: 0.85 });
			}
			return;
		}
		const p = at(item.value);
		if (!inside(p)) {
			ctx.warn('annotations-skipped', `The reference line at ${item.value} is outside the ${axisOf(item) === 'x' ? 'x' : 'value'} axis range and is not drawn.`);
			return;
		}
		const line = vertical ? { x1: plot.x, y1: p, x2: plot.x + plot.width, y2: p } : { x1: p, y1: plot.y, x2: p, y2: plot.y + plot.height };
		marks.push({ kind: 'line', key: `reference-line-${i}`, role: 'reference-line', ...line, stroke: color, strokeWidth: 1.25, dash: '5 3', opacity: 0.8 });
		if (item.label) {
			const text = truncate(item.label, (vertical ? plot.width : plot.width / 2) - 8, fs - 1, measure);
			const label = vertical ? { x: plot.x + plot.width - 4, y: p - 3, anchor: 'end' as const, baseline: 'bottom' as const } : { x: p + 4, y: plot.y + 2, anchor: 'start' as const, baseline: 'top' as const };
			marks.push({ kind: 'text', key: `reference-label-line-${i}`, role: 'reference-label', ...label, text, size: fs - 1, weight: 500, fill: color });
		}
	});
	for (const axis of missing)
		ctx.warn('annotations-skipped', axis === 'x' ? 'Reference lines and bands on the x axis need a scatter or bubble chart with numeric x values; they are not drawn.' : 'Reference lines and bands on the secondary axis need a series on that axis; they are not drawn.');
}

/** Where a callout points: the end of a bar, or the top of a point. */
function anchorOf(mark: ChartMark, horizontal: boolean): { x: number; y: number } | null {
	if (mark.kind === 'rect') return horizontal ? { x: mark.x + mark.width, y: mark.y + mark.height / 2 } : { x: mark.x + mark.width / 2, y: mark.y };
	if (mark.kind === 'circle') return { x: mark.cx, y: mark.cy - mark.r };
	return null;
}

/** Draws each series' callouts: a boxed label with a leader line to its bar or point, kept inside the plot and clear of the other callouts. */
export function drawCallouts(ctx: LayoutCtx, plot: ChartRect) {
	const { spec, marks, theme, fs, measure } = ctx;
	const horizontal = spec.orientation === 'horizontal';
	const placed: ChartRect[] = [];
	const overlaps = (a: ChartRect) => placed.some((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height);
	let unplaced = 0;
	for (const s of spec.series) {
		if (s.hidden || !s.callouts) continue;
		s.callouts.forEach((label, i) => {
			if (!label) return;
			const mark = marks.find((m) => (m.role === 'bar' || m.role === 'point') && m.target?.kind === 'point' && m.target.seriesId === s.id && m.target.index === i);
			const anchor = mark ? anchorOf(mark, horizontal && mark.kind === 'rect') : null;
			if (!anchor) {
				unplaced++;
				return;
			}
			const size = fs - 1;
			const text = truncate(label, plot.width * 0.6, size, measure);
			const w = measure(text, size, 600) + 10;
			const h = size + 8;
			const sideways = horizontal && mark!.kind === 'rect';
			let bx = sideways ? anchor.x + 14 : anchor.x - w / 2;
			let by = sideways ? anchor.y - h / 2 : anchor.y - h - 14;
			const clamp = () => {
				bx = Math.max(plot.x, Math.min(plot.x + plot.width - w, bx));
				by = Math.max(plot.y - fs / 2, Math.min(plot.y + plot.height - h, by));
			};
			clamp();
			// No room above the tallest bar (or right of the longest): put the label on the other side of the anchor.
			const covers = anchor.x >= bx - 2 && anchor.x <= bx + w + 2 && anchor.y >= by - 2 && anchor.y <= by + h + 2;
			if (covers) {
				if (sideways) bx = anchor.x - w - 14;
				else by = anchor.y + 14;
				clamp();
			}
			for (let k = 0; k < 6 && overlaps({ x: bx, y: by, width: w, height: h }); k++) {
				if (sideways) by += h + 2;
				else by -= h + 2;
				clamp();
			}
			const box = { x: bx, y: by, width: w, height: h };
			placed.push(box);
			const target: ChartSelection = { kind: 'point', seriesId: s.id, index: i };
			// The leader runs from the anchor to the nearest edge of the box.
			const ex = Math.max(bx, Math.min(bx + w, anchor.x));
			const ey = Math.max(by, Math.min(by + h, anchor.y));
			if (Math.hypot(ex - anchor.x, ey - anchor.y) > 2) marks.push({ kind: 'line', key: `callout-leader-${s.id}-${i}`, role: 'callout', x1: anchor.x, y1: anchor.y, x2: ex, y2: ey, stroke: theme.axis, strokeWidth: 1 });
			marks.push({ kind: 'rect', key: `callout-box-${s.id}-${i}`, role: 'callout', ...box, fill: theme.surface, stroke: theme.axis, strokeWidth: 1, radius: 3, target });
			marks.push({ kind: 'text', key: `callout-${s.id}-${i}`, role: 'callout', x: bx + w / 2, y: by + h / 2, text, anchor: 'middle', baseline: 'middle', size, weight: 600, fill: theme.text, target });
		});
	}
	if (unplaced) ctx.warn('annotations-skipped', `${unplaced} callout${unplaced === 1 ? ' points' : 's point'} at a gap or a hidden value and ${unplaced === 1 ? 'is' : 'are'} not drawn.`);
}

const MUTED: ReadonlySet<ChartMarkRole> = new Set(['node', 'bar', 'line', 'area', 'point', 'slice', 'cell', 'box', 'whisker', 'outlier', 'connector', 'trendline', 'trendline-label', 'error-bar', 'data-label', 'legend-swatch', 'legend-label']);

/**
 * Mutes every data mark that `spec.highlight` does not name. A point stays bright when its
 * category or its series is named; a whole series (line, area, legend entry) when it is named
 * or no series is; a category when it is named or no category is.
 */
export function applyHighlight(ctx: LayoutCtx) {
	const { spec, marks } = ctx;
	if (!spec.highlight.length) return;
	const names = new Set(spec.highlight);
	const categories = new Set<number>();
	spec.categories.forEach((c, i) => names.has(c) && categories.add(i));
	const series = new Set(spec.series.filter((s) => names.has(s.id) || names.has(s.name)).map((s) => s.id));
	const unmatched = spec.highlight.filter((h) => !spec.categories.includes(h) && !spec.series.some((s) => s.id === h || s.name === h));
	if (unmatched.length) ctx.warn('highlight-unmatched', `Highlight names ${unmatched.map((u) => `"${u}"`).join(', ')}, which ${unmatched.length === 1 ? 'is' : 'are'} neither a category nor a series.`);
	if (!categories.size && !series.size) return;
	const bright = (t: ChartSelection): boolean => {
		switch (t.kind) {
			case 'point':
				return series.has(t.seriesId) || categories.has(t.index);
			case 'series':
			case 'trendline':
				return !series.size || series.has(t.seriesId);
			case 'category':
				return !categories.size || categories.has(t.index);
			default:
				return true;
		}
	};
	for (let k = 0; k < marks.length; k++) {
		const m = marks[k];
		if (!m.target || !MUTED.has(m.role) || bright(m.target)) continue;
		marks[k] = { ...m, opacity: (m.opacity ?? 1) * 0.25 };
	}
}

/** Height the note takes at the bottom of the chart (0 without one). */
export const noteHeight = (spec: ChartSpec, fs: number) => (spec.note ? fs * 1.5 : 0);

/** Writes the note along the bottom left, shortened to the width. */
export function drawNote(ctx: LayoutCtx, pad: number) {
	const { spec, marks, theme, fs, measure, width, height } = ctx;
	if (!spec.note) return;
	const text = truncate(spec.note, width - pad * 2, fs - 1, measure);
	if (text !== spec.note) ctx.warn('labels-truncated', 'The note was shortened to fit the width.');
	marks.push({ kind: 'text', key: 'note', role: 'note', x: pad, y: height - pad + 2, text, anchor: 'start', baseline: 'bottom', size: fs - 1, fill: theme.mutedText });
}
