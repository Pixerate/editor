import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
	brushstrokeScaleBucket,
	isBrushedShape,
	listCanvasBrushes,
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
 * The paint engine loads on the first brushed shape.
 */
export function useShapeBrushstroke(shape: ShapeDescription | null | undefined, width?: number, height?: number): CanvasBrushstrokeImage | null {
	const zoom = useContext(ShapeNodeZoomContext);
	const brushed = isBrushedShape(shape) ? shape : null;
	const vb = brushed?.viewBox;
	const nodeScale = vb && width && height && vb[2] > 0 && vb[3] > 0 ? Math.max(width / vb[2], height / vb[3]) : 1;
	const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
	const scale = brushstrokeScaleBucket(zoom * nodeScale, dpr);
	const [image, setImage] = useState<CanvasBrushstrokeImage | null>(null);
	useEffect(() => {
		if (!brushed) {
			setImage(null);
			return;
		}
		let live = true;
		renderShapeBrushstroke(brushed, { scale }).then(
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
	}, [brushed, scale]);
	return image;
}

/** The dry paint presets a freehand stroke can be brushed with (loads the paint engine on mount). */
export function useCanvasBrushes(): { brushes: CanvasBrushPreset[]; loading: boolean; error: string | null } {
	const [state, setState] = useState<{ brushes: CanvasBrushPreset[]; loading: boolean; error: string | null }>({ brushes: [], loading: true, error: null });
	useEffect(() => {
		let live = true;
		listCanvasBrushes().then(
			(brushes) => live && setState({ brushes, loading: false, error: null }),
			(error) => live && setState({ brushes: [], loading: false, error: error instanceof Error ? error.message : String(error) })
		);
		return () => {
			live = false;
		};
	}, []);
	return useMemo(() => state, [state]);
}
