import type { ChartController } from './controller.js';
import { chartValueAtPoint, snapChartValue } from './layout.js';
import { isCartesianChart } from './spec.js';
import type { ChartScene, ChartSelection } from './types.js';

/** Scene coordinates of a pointer, given the rendered element's box (the scene is scaled to fit it). */
export function chartClientToScene(scene: Pick<ChartScene, 'width' | 'height'>, box: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } {
	const sx = box.width ? scene.width / box.width : 1;
	const sy = box.height ? scene.height / box.height : 1;
	return { x: (clientX - box.left) * sx, y: (clientY - box.top) * sy };
}

/** Whether a point can be dragged to a new value in this scene (cartesian, not percent-stacked, not hidden). */
export function canDragChartPoint(controller: ChartController, scene: ChartScene, target: ChartSelection | undefined): target is Extract<ChartSelection, { kind: 'point' }> {
	if (target?.kind !== 'point' || !scene.valueScale || scene.percent) return false;
	const spec = controller.getSpec();
	if (!isCartesianChart(spec.type)) return false;
	const series = controller.getSeries(target.seriesId);
	return !!series && !series.hidden && series.values[target.index] !== null;
}

export interface ChartPointDrag {
	/**
	 * The value axis range when the drag started. Pass it to `layoutChart` (`valueDomain`)
	 * until `end()` so the axis does not rescale under the pointer.
	 */
	readonly valueDomain: { min: number; max: number };
	/** Moves the value with the pointer (scene coordinates). */
	move(point: { x: number; y: number }): void;
	/** Ends the drag (one undo step for the whole drag). */
	end(): void;
}

/**
 * Starts dragging a bar or point: the value follows the pointer along the value axis,
 * snapped to a tenth of the tick step (`step` overrides), and the whole drag is one undo
 * step. Works for stacked bars too (the drag changes the segment by the distance moved).
 * Returns `null` when the target cannot be dragged.
 */
export function startChartPointDrag(controller: ChartController, scene: ChartScene, target: ChartSelection | undefined, start: { x: number; y: number }, options: { step?: number } = {}): ChartPointDrag | null {
	if (!canDragChartPoint(controller, scene, target)) return null;
	const { seriesId, index } = target;
	const startValue = controller.getSeries(seriesId)!.values[index] ?? 0;
	const startAt = chartValueAtPoint(scene, start);
	if (startAt === undefined) return null;
	controller.beginGesture(`drag:${seriesId}:${index}`);
	let ended = false;
	const [min, max] = scene.valueScale!.domain;
	return {
		valueDomain: { min, max },
		move(point) {
			if (ended) return;
			const at = chartValueAtPoint(scene, point);
			if (at === undefined) return;
			controller.setValue(seriesId, index, snapChartValue(scene, startValue + (at - startAt), options.step), { label: `Drag ${controller.getSeries(seriesId)?.name ?? 'value'}` });
		},
		end() {
			if (ended) return;
			ended = true;
			controller.endGesture();
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
 * (← →) and change its value (↑ ↓, a tenth of the tick step; Shift: a whole step), Delete /
 * Backspace deletes the selection, Escape clears it. Returns `true` when the key was used
 * (call `preventDefault`).
 */
export function handleChartKey(controller: ChartController, scene: ChartScene | null, event: ChartKeyInput): boolean {
	if (event.metaKey || event.ctrlKey || event.altKey) return false;
	const { selection, spec } = controller.getState();
	switch (event.key) {
		case 'Escape':
			if (!selection) return false;
			controller.select(null);
			return true;
		case 'Delete':
		case 'Backspace':
			if (!selection || selection.kind === 'chart') return false;
			controller.deleteSelection();
			return true;
		case 'ArrowLeft':
		case 'ArrowRight': {
			if (selection?.kind !== 'point' && selection?.kind !== 'category') return false;
			const n = spec.categories.length;
			const index = Math.max(0, Math.min(n - 1, selection.index + (event.key === 'ArrowRight' ? 1 : -1)));
			controller.select({ ...selection, index });
			return true;
		}
		case 'ArrowUp':
		case 'ArrowDown': {
			if (selection?.kind !== 'point' || scene?.percent) return false;
			const ticks = scene?.valueScale?.ticks ?? [];
			const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
			const delta = (event.shiftKey ? step : step / 10) * (event.key === 'ArrowUp' ? 1 : -1);
			controller.nudgeValue(selection.seriesId, selection.index, delta);
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
			return selection.axis === 'x' ? 'Category axis' : 'Value axis';
		case 'series':
			return `Series "${controller.getSeries(selection.seriesId)?.name ?? selection.seriesId}"`;
		case 'category':
			return `Category "${spec.categories[selection.index] ?? selection.index}"`;
		case 'point': {
			const series = controller.getSeries(selection.seriesId);
			const value = series?.values[selection.index];
			return `${series?.name ?? selection.seriesId} · ${spec.categories[selection.index] ?? selection.index}: ${value ?? 'blank'}`;
		}
	}
}
