// Drag behaviour follows effectcraft-main/crates/ui-egui/src/panels/graph.rs and graph_tools.rs (the value axis
// is frozen while a key is dragged, Shift locks to the axis that moved most, `snap_px` picks the nearest
// candidate within a few screen pixels) and lightcraft-main's curve tests (Alt moves a tenth as far)
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import type { ChartController } from './controller.js';
import { chartValueAtPoint, chartXAtPoint, snapChartValue } from './layout.js';
import { linearMap } from './scale.js';
import { chartFamily } from './spec.js';
import type { ChartScene, ChartSelection, ChartValueScale } from './types.js';

/** Scene coordinates of a pointer, given the rendered element's box (the scene is scaled to fit it). */
export function chartClientToScene(scene: Pick<ChartScene, 'width' | 'height'>, box: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } {
	const sx = box.width ? scene.width / box.width : 1;
	const sy = box.height ? scene.height / box.height : 1;
	return { x: (clientX - box.left) * sx, y: (clientY - box.top) * sy };
}

/**
 * Whether a point can be dragged to a new value in this scene: bar, line, area and scatter
 * charts (not percent-stacked), scatter and bubble charts with x values (x and y), and
 * waterfall steps. Hidden series and gaps cannot be dragged.
 */
export function canDragChartPoint(controller: ChartController, scene: ChartScene, target: ChartSelection | undefined): target is Extract<ChartSelection, { kind: 'point' }> {
	if (target?.kind !== 'point' || !scene.valueScale || scene.percent) return false;
	const spec = controller.getSpec();
	const family = chartFamily(spec);
	if (family !== 'cartesian' && family !== 'xy' && family !== 'waterfall') return false;
	const series = controller.getSeries(target.seriesId);
	return !!series && !series.hidden && series.values[target.index] !== null;
}

export interface ChartDragMoveOptions {
	/** Move a tenth as far as the pointer (fine adjustment; Alt). */
	fine?: boolean;
	/** Only change the axis the pointer has moved along most (scatter charts; Shift). */
	lockAxis?: boolean;
	/** Skip snapping to nearby values and ticks (e.g. while Ctrl / Cmd is held). */
	noSnap?: boolean;
}

export interface ChartPointDrag {
	/**
	 * The value axis range when the drag started. Pass it to `layoutChart` (`valueDomain`)
	 * until `end()` so the axis does not rescale under the pointer.
	 */
	readonly valueDomain: { min: number; max: number };
	/** The secondary value axis range when the drag started (`layoutChart`'s `valueDomain2`). */
	readonly valueDomain2?: { min: number; max: number };
	/** The numeric x range of a scatter or bubble chart when the drag started (`xDomain`). */
	readonly xDomain?: { min: number; max: number };
	/** The point being dragged, for `layoutChart`'s `readout`. */
	readonly target: { seriesId: string; index: number };
	/** Moves the value with the pointer (scene coordinates). */
	move(point: { x: number; y: number }, options?: ChartDragMoveOptions): void;
	/** Ends the drag (one undo step for the whole drag). */
	end(): void;
	/** Cancels the drag: the value goes back and no undo step is left (Escape). */
	cancel(): void;
}

export interface ChartSnapOptions {
	/** Values to snap to when the pointer is within `tolerancePx` of them. */
	candidates?: readonly number[];
	/** Screen distance that snaps (default 6). */
	tolerancePx?: number;
	/** Fallback step when no candidate is close (default: a tenth of the tick step). */
	step?: number;
	/** The scale the value is on (default: the scene's value scale). */
	scale?: ChartValueScale;
}

/**
 * Snaps a dragged value: to the nearest candidate (other series at the same category, the
 * neighbouring values, zero, the start value, ticks) within `tolerancePx` screen pixels, or
 * else to a tenth of the tick step.
 */
export function snapChartDragValue(scene: ChartScene, value: number, options: ChartSnapOptions = {}): number {
	const scale = options.scale ?? scene.valueScale;
	const tolerance = options.tolerancePx ?? 6;
	if (scale) {
		const px = (v: number) => linearMap(v, scale.domain, scale.range);
		const at = px(value);
		let best: number | null = null;
		let bestDist = tolerance;
		for (const c of [...(options.candidates ?? []), ...scale.ticks]) {
			if (!Number.isFinite(c)) continue;
			const d = Math.abs(px(c) - at);
			if (d <= bestDist) {
				best = c;
				bestDist = d;
			}
		}
		if (best !== null) return best;
	}
	return snapChartValue(scene, value, options.step, scale?.ticks);
}

/**
 * Starts dragging a bar or point: the value follows the pointer along its value axis (and
 * along x on scatter and bubble charts), snapped to nearby values and then to a tenth of the
 * tick step (`step` overrides), and the whole drag is one undo step. Works for stacked bars
 * too (the drag changes the segment by the distance moved). Returns `null` when the target
 * cannot be dragged.
 */
export function startChartPointDrag(controller: ChartController, scene: ChartScene, target: ChartSelection | undefined, start: { x: number; y: number }, options: { step?: number; tolerancePx?: number } = {}): ChartPointDrag | null {
	if (!canDragChartPoint(controller, scene, target)) return null;
	const { seriesId, index } = target;
	const spec = controller.getSpec();
	const series = controller.getSeries(seriesId)!;
	const secondary = series.axis === 'secondary' && !!scene.valueScale2;
	const scale = secondary ? scene.valueScale2! : scene.valueScale!;
	const xy = chartFamily(spec) === 'xy' && !!scene.xScale;
	const startValue = series.values[index] ?? 0;
	const startX = series.x?.[index] ?? null;
	const startAt = chartValueAtPoint(scene, start, secondary);
	const startAtX = xy ? chartXAtPoint(scene, start) : undefined;
	if (startAt === undefined) return null;
	// Nearby values worth snapping to: zero, where the drag started, other series at this
	// category and this series' neighbours.
	const candidates = [0, startValue];
	if (!xy) {
		for (const s of spec.series) if (s.id !== seriesId && !s.hidden && (s.axis === 'secondary') === secondary) candidates.push(s.values[index] ?? NaN);
		candidates.push(series.values[index - 1] ?? NaN, series.values[index + 1] ?? NaN);
	}
	controller.beginGesture(`drag:${seriesId}:${index}`);
	let ended = false;
	const [min, max] = scene.valueScale!.domain;
	const label = `Drag ${series.name}`;
	return {
		valueDomain: { min, max },
		...(scene.valueScale2 ? { valueDomain2: { min: scene.valueScale2.domain[0], max: scene.valueScale2.domain[1] } } : {}),
		...(xy ? { xDomain: { min: scene.xScale!.domain[0], max: scene.xScale!.domain[1] } } : {}),
		target: { seriesId, index },
		move(point, moveOptions = {}) {
			if (ended) return;
			const at = chartValueAtPoint(scene, point, secondary);
			if (at === undefined) return;
			const factor = moveOptions.fine ? 0.1 : 1;
			let dy = (at - startAt) * factor;
			let dx = 0;
			if (xy && startX !== null && startAtX !== undefined) {
				const atX = chartXAtPoint(scene, point);
				if (atX !== undefined) dx = (atX - startAtX) * factor;
				if (moveOptions.lockAxis) {
					// Keep the axis the pointer moved further along (in pixels).
					if (Math.abs(point.x - start.x) >= Math.abs(point.y - start.y)) dy = 0;
					else dx = 0;
				}
			}
			const snap = (v: number, s: ChartValueScale, c: readonly number[]) => {
				if (moveOptions.noSnap) return Number(v.toPrecision(12));
				if (moveOptions.fine) {
					const unit = options.step ? options.step / 10 : s.ticks.length > 1 ? (s.ticks[1] - s.ticks[0]) / 100 : undefined;
					return snapChartValue(scene, v, unit, s.ticks);
				}
				return snapChartDragValue(scene, v, { candidates: c, tolerancePx: options.tolerancePx, step: options.step, scale: s });
			};
			const y = snap(startValue + dy, scale, candidates);
			if (xy && startX !== null) {
				const x = dx !== 0 ? snap(startX + dx, scene.xScale!, [0, startX]) : startX;
				const xs = [...(series.x ?? [])];
				xs[index] = x;
				controller.setValue(seriesId, index, y, { label });
				if (x !== controller.getSeries(seriesId)?.x?.[index]) controller.updateSeries(seriesId, { x: xs });
			} else controller.setValue(seriesId, index, y, { label });
		},
		end() {
			if (ended) return;
			ended = true;
			controller.endGesture();
		},
		cancel() {
			if (ended) return;
			ended = true;
			controller.cancelGesture();
		}
	};
}

export interface ChartKeyInput {
	key: string;
	shiftKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	ctrlKey?: boolean;
}

/**
 * Keyboard editing on a focused chart: arrows move a point selection between categories
 * (← →) and change its value (↑ ↓, a tenth of the tick step; Shift: a whole step; Alt: a
 * hundredth), Delete / Backspace deletes the selection, Escape cancels a drag or clears the
 * selection. Returns `true` when the key was used (call `preventDefault`).
 */
export function handleChartKey(controller: ChartController, scene: ChartScene | null, event: ChartKeyInput): boolean {
	if (event.metaKey || event.ctrlKey) return false;
	const { selection, spec, gesture } = controller.getState();
	switch (event.key) {
		case 'Escape':
			if (gesture) {
				controller.cancelGesture();
				return true;
			}
			if (!selection) return false;
			controller.select(null);
			return true;
		case 'Delete':
		case 'Backspace':
			if (event.altKey || !selection || selection.kind === 'chart') return false;
			controller.deleteSelection();
			return true;
		case 'ArrowLeft':
		case 'ArrowRight': {
			if (event.altKey || (selection?.kind !== 'point' && selection?.kind !== 'category')) return false;
			const n = spec.categories.length;
			const index = Math.max(0, Math.min(n - 1, selection.index + (event.key === 'ArrowRight' ? 1 : -1)));
			controller.select({ ...selection, index });
			return true;
		}
		case 'ArrowUp':
		case 'ArrowDown': {
			if (selection?.kind !== 'point' || scene?.percent) return false;
			const secondary = controller.getSeries(selection.seriesId)?.axis === 'secondary';
			const ticks = (secondary ? scene?.valueScale2 : null)?.ticks ?? scene?.valueScale?.ticks ?? [];
			const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
			const amount = event.shiftKey ? step : event.altKey ? step / 100 : step / 10;
			controller.nudgeValue(selection.seriesId, selection.index, amount * (event.key === 'ArrowUp' ? 1 : -1));
			return true;
		}
		default:
			return false;
	}
}

/** A short description of the selection for an inspector heading or a screen reader. */
export function describeChartSelection(controller: ChartController, selection: ChartSelection | null = controller.getState().selection): string {
	if (!selection) return 'Nothing selected';
	const spec = controller.getSpec();
	switch (selection.kind) {
		case 'chart':
			return 'Chart';
		case 'title':
			return 'Title';
		case 'subtitle':
			return 'Subtitle';
		case 'legend':
			return 'Legend';
		case 'axis':
			return selection.axis === 'x' ? (chartFamily(spec) === 'xy' ? 'X axis' : 'Category axis') : selection.axis === 'y' ? 'Value axis' : 'Secondary value axis';
		case 'series':
			return `Series "${controller.getSeries(selection.seriesId)?.name ?? selection.seriesId}"`;
		case 'category':
			return `Category "${spec.categories[selection.index] ?? selection.index}"`;
		case 'trendline': {
			const series = controller.getSeries(selection.seriesId);
			const line = series?.trendlines?.[selection.index];
			return `${line ? line.type.replace('-', ' ') : 'Trendline'} trendline on "${series?.name ?? selection.seriesId}"`;
		}
		case 'point': {
			const series = controller.getSeries(selection.seriesId);
			const value = series?.values[selection.index];
			const x = series?.x?.[selection.index];
			if (x !== undefined && x !== null && chartFamily(spec) === 'xy') return `${series?.name ?? selection.seriesId}: (${x}, ${value ?? 'blank'})`;
			return `${series?.name ?? selection.seriesId} · ${spec.categories[selection.index] ?? selection.index}: ${value ?? 'blank'}`;
		}
	}
}

/**
 * The mark under a scene point (topmost first), for hosts without DOM events and for agents
 * that drive the pointer: rects, circles, lines (within 4 px) and text boxes. Returns the
 * mark's `target`, or `{ kind: 'chart' }` over the background, or `null` outside.
 */
export function chartHitTest(scene: ChartScene, point: { x: number; y: number }, measure: (text: string, size: number, weight?: number) => number = (t, s, w = 400) => t.length * s * (w >= 600 ? 0.6 : 0.56)): ChartSelection | null {
	for (let i = scene.marks.length - 1; i >= 0; i--) {
		const m = scene.marks[i];
		if (!m.target || m.role === 'selection' || m.role === 'background') continue;
		let hit = false;
		switch (m.kind) {
			case 'rect':
				hit = point.x >= m.x && point.x <= m.x + m.width && point.y >= m.y && point.y <= m.y + m.height;
				break;
			case 'circle':
				hit = Math.hypot(point.x - m.cx, point.y - m.cy) <= Math.max(m.r, 4) + 2;
				break;
			case 'line': {
				const dx = m.x2 - m.x1;
				const dy = m.y2 - m.y1;
				const len2 = dx * dx + dy * dy;
				const t = len2 ? Math.max(0, Math.min(1, ((point.x - m.x1) * dx + (point.y - m.y1) * dy) / len2)) : 0;
				hit = Math.hypot(point.x - (m.x1 + t * dx), point.y - (m.y1 + t * dy)) <= 4;
				break;
			}
			case 'text': {
				if (m.rotate) break;
				const w = measure(m.text, m.size, m.weight);
				const x0 = m.anchor === 'start' ? m.x : m.anchor === 'end' ? m.x - w : m.x - w / 2;
				const y0 = m.baseline === 'top' ? m.y : m.baseline === 'bottom' ? m.y - m.size : m.y - m.size / 2;
				hit = point.x >= x0 - 2 && point.x <= x0 + w + 2 && point.y >= y0 - 2 && point.y <= y0 + m.size + 2;
				break;
			}
			default:
				break;
		}
		if (hit) return m.target;
	}
	return point.x >= 0 && point.y >= 0 && point.x <= scene.width && point.y <= scene.height ? { kind: 'chart' } : null;
}
