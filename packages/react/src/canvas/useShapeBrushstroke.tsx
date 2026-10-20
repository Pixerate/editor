import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
	brushstrokeScaleBucket,
	isBrushedShape,
	listCanvasBrushes,
	renderCanvasBrushSwatch,
	type CanvasBrushSwatchOptions,
	renderShapeBrushstroke,
	type CanvasBrushPreset,
	type CanvasBrushstrokeImage,
	type ShapeDescription
} from '@pixerate/editor/canvas';

/** The canvas zoom bucket brushed shape nodes render at (1 without a provider). */
export const ShapeNodeZoomContext = createContext<number>(1);

/**
 * Tells brushed `ShapeNode`s the canvas zoom so their paint stays sharp: wrap the flow in it with
 * the live zoom (`useViewport().zoom`). The zoom is bucketed (powers of √2), so nodes only
 * re-render when it crosses a bucket.
 */
export function ShapeNodeZoomProvider({ zoom, children }: { zoom: number; children?: React.ReactNode }) {
	const bucket = brushstrokeScaleBucket(zoom);
	return <ShapeNodeZoomContext.Provider value={bucket}>{children}</ShapeNodeZoomContext.Provider>;
}

/**
 * The image of a brushed shape (`data.shape.brush`) for a node of `width` × `height`, or null
 * while it renders, for unbrushed shapes, and when the brush cannot render (it then logs why).
 * The paint engine loads on the first brushed shape. `position` is the node's absolute canvas
 * position (React Flow's `positionAbsoluteX` / `positionAbsoluteY`): the paper grain is sampled
 * there, so neighbouring strokes share one sheet of paper.
 */
export function useShapeBrushstroke(shape: ShapeDescription | null | undefined, width?: number, height?: number, position?: { x: number; y: number }): CanvasBrushstrokeImage | null {
	const zoom = useContext(ShapeNodeZoomContext);
	const brushed = isBrushedShape(shape) ? shape : null;
	const vb = brushed?.viewBox;
	const nodeScale = vb && width && height && vb[2] > 0 && vb[3] > 0 ? Math.max(width / vb[2], height / vb[3]) : 1;
	const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
	const scale = brushstrokeScaleBucket(zoom * nodeScale, dpr);
	// Path (0, 0) on the canvas, in whole units so small drags do not re-render.
	const unit = vb && width && vb[2] > 0 ? width / vb[2] : 1;
	const ox = Math.round((position?.x ?? 0) - (vb?.[0] ?? 0) * unit);
	const oy = Math.round((position?.y ?? 0) - (vb?.[1] ?? 0) * unit);
	const [image, setImage] = useState<CanvasBrushstrokeImage | null>(null);
	useEffect(() => {
		if (!brushed) {
			setImage(null);
			return;
		}
		let live = true;
		renderShapeBrushstroke(brushed, { scale, origin: { x: ox, y: oy }, unit }).then(
			(img) => live && setImage(img),
			(error) => {
				if (!live) return;
				setImage(null);
				console.warn('[pixerate] brushed stroke not rendered:', error instanceof Error ? error.message : error);
			}
		);
		return () => {
			live = false;
		};
		// The shape object is replaced on every edit, so it is the right dependency.
	}, [brushed, scale, ox, oy, unit]);
	return image;
}

/**
 * The dry paint presets a freehand stroke can be brushed with (loads the paint engine on mount);
 * with `swatches`, each with a preview image (`renderCanvasBrushSwatch`) for a brush menu.
 */
export function useCanvasBrushes(options: { swatches?: CanvasBrushSwatchOptions } = {}): { brushes: Array<CanvasBrushPreset & { swatch?: string }>; loading: boolean; error: string | null } {
	const [state, setState] = useState<{ brushes: Array<CanvasBrushPreset & { swatch?: string }>; loading: boolean; error: string | null }>({ brushes: [], loading: true, error: null });
	const swatches = options.swatches ? JSON.stringify(options.swatches) : '';
	useEffect(() => {
		let live = true;
		const opts = swatches ? (JSON.parse(swatches) as CanvasBrushSwatchOptions) : null;
		listCanvasBrushes()
			.then(async (list) => (opts ? Promise.all(list.map(async (b) => ({ ...b, swatch: await renderCanvasBrushSwatch(b.id, opts) }))) : list))
			.then(
			(brushes) => live && setState({ brushes, loading: false, error: null }),
			(error) => live && setState({ brushes: [], loading: false, error: error instanceof Error ? error.message : String(error) })
			);
		return () => {
			live = false;
		};
	}, [swatches]);
	return useMemo(() => state, [state]);
}
