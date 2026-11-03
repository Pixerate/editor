import { getContext, setContext } from 'svelte';
import { brushstrokeScaleBucket, listCanvasBrushes, renderCanvasBrushSwatch, type CanvasBrushPreset, type CanvasBrushSwatchOptions } from '@pixerate/editor/canvas';
import type { BrushLibrary } from '@pixerate/editor/brushes';

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
 * The brushes a freehand stroke can be brushed with (loads the paint engine): the dry presets and,
 * with `library`, its saved brushes the canvas can paint (each with its `spec`; pass it as the
 * stroke style's `brushSpec`), read again when the library changes (`dispose` stops that). With
 * `swatches`, each has a preview image (`renderCanvasBrushSwatch`) for a brush menu.
 */
export function createCanvasBrushes(options: { swatches?: CanvasBrushSwatchOptions; library?: Pick<BrushLibrary, 'list' | 'subscribe'> | null } = {}) {
	let brushes = $state.raw<Array<CanvasBrushPreset & { swatch?: string }>>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	const opts = options.swatches;
	const library = options.library ?? undefined;
	const read = () =>
		listCanvasBrushes(library)
			.then(async (list) => (opts ? Promise.all(list.map(async (b) => ({ ...b, swatch: await renderCanvasBrushSwatch(b.id, opts, b.spec) }))) : list))
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
	void read();
	const unsubscribe = library?.subscribe(() => void read());
	return {
		get brushes() {
			return brushes;
		},
		get loading() {
			return loading;
		},
		get error() {
			return error;
		},
		dispose() {
			unsubscribe?.();
		}
	};
}
