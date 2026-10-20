import { getContext, setContext } from 'svelte';
import { brushstrokeScaleBucket, listCanvasBrushes, renderCanvasBrushSwatch, type CanvasBrushPreset, type CanvasBrushSwatchOptions } from '@pixerate/editor/canvas';

const ZOOM_KEY = Symbol('pixerate-shape-node-zoom');

/**
 * Tells brushed `ShapeNode`s the canvas zoom so their paint stays sharp. Call it in the component
 * that renders `<SvelteFlow>`, with a getter of the live zoom. Nodes re-render only when the zoom
 * crosses a bucket (powers of √2).
 */
export function setShapeNodeZoom(getZoom: () => number): void {
	setContext(ZOOM_KEY, () => brushstrokeScaleBucket(getZoom()));
}

/** The bucketed canvas zoom for brushed shape nodes (1 when no `setShapeNodeZoom` is above). */
export function getShapeNodeZoom(): () => number {
	return getContext<(() => number) | undefined>(ZOOM_KEY) ?? (() => 1);
}

/**
 * The dry paint presets a freehand stroke can be brushed with (loads the paint engine); with
 * `swatches`, each with a preview image (`renderCanvasBrushSwatch`) for a brush menu.
 */
export function createCanvasBrushes(options: { swatches?: CanvasBrushSwatchOptions } = {}) {
	let brushes = $state.raw<Array<CanvasBrushPreset & { swatch?: string }>>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	const opts = options.swatches;
	listCanvasBrushes()
		.then(async (list) => (opts ? Promise.all(list.map(async (b) => ({ ...b, swatch: await renderCanvasBrushSwatch(b.id, opts) }))) : list))
		.then(
		(list) => {
			brushes = list;
			loading = false;
		},
		(e) => {
			error = e instanceof Error ? e.message : String(e);
			loading = false;
		}
	);
	return {
		get brushes() {
			return brushes;
		},
		get loading() {
			return loading;
		},
		get error() {
			return error;
		}
	};
}
