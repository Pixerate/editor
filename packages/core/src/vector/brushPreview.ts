/**
 * `preview_brush` for the vector host: a sample stroke of any brush `VECTOR_PROFILE` admits, drawn
 * the way a vector brushstroke paints it. Dry brushes are the canvas swatch
 * (`renderCanvasBrushPreview`, loaded on first use); wet paint (watercolour, gouache, wet oils) runs
 * the brushstroke's wet simulation (`WetBrushstrokeJob`) and shows the paint settled, as the
 * document does once it has settled (`VECTOR_WET_STEPS` steps: seconds on the TypeScript kernel, run
 * in slices that yield to the event loop, so a brush editor stays responsive); the Mixer Brush, smudge and
 * blender act on a backdrop (`renderBackdropBrushstroke`): two bands of colour, the paint over
 * ochre, as the paint editor's thumbnails show them, when the brush moves or picks up paint.
 */
import type { BrushPreviewRenderer } from '../brushes/tools.js';
import type { Brush } from '../brushes/types.js';
import { checkBrush, VECTOR_PROFILE } from '../brushes/profiles.js';
import { resolveBrush } from '../brushes/resolve.js';
import { brushPreviewPoints, renderCanvasBrushPreview } from '../canvas/brushstroke.js';
import type { BrushstrokeImage, BrushstrokeProfilePath } from '../paint/brushstroke.js';
import type { PaintBrush } from '../paint-editor/brushes.js';
import { bytesToBase64, encodePng } from '../raster/png.js';
import type { RasterRect } from '../raster/surface.js';
import { isVectorBrushstrokeEngine, vectorBrushstrokeBrushError } from './brushstroke.js';
import { renderBackdropBrushstroke, usesVectorBackdrop, vectorMediaEngine, WetBrushstrokeJob } from './brushstrokeMedia.js';

/** The second band under brushes that move paint (the paint editor thumbnails' ochre). */
const OCHRE = [232, 196, 64, 255] as const;
/** The seed of the preview stroke (the canvas swatch's). */
const SEED = 7;
/** How long the wet simulation runs before yielding to the event loop, in ms. */
const SLICE_MS = 16;

function rgba(hex: string): [number, number, number, number] {
	const n = parseInt(/^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '1f2937', 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

/** The canvas swatch's S across the preview, swelling in the middle, for a tip of `size`. */
function previewStroke(width: number, height: number, size: number): BrushstrokeProfilePath {
	return { points: brushPreviewPoints(width, height, size), pressure: [0.35, 1, 0.5] };
}

/** Whether a backdrop brush is shown over two bands (it moves or picks up paint), as the paint thumbnails do. */
const wantsBands = (brush: PaintBrush): boolean => brush.engine === 'smudge' || brush.engine === 'blender' || (brush.engine === 'mixer' && !brush.loadsColor) || brush.behavior.pickup > 0;

/** `stroke` drawn source-over onto `out` (`width` × `height`, straight alpha); the stroke renders at scale 1. */
function drawOver(out: Uint8ClampedArray, width: number, height: number, stroke: BrushstrokeImage): void {
	if (!stroke.bounds) return;
	const { image } = stroke;
	const ox = Math.round(stroke.bounds.x);
	const oy = Math.round(stroke.bounds.y);
	for (let y = 0; y < image.height; y++) {
		const ty = y + oy;
		if (ty < 0 || ty >= height) continue;
		for (let x = 0; x < image.width; x++) {
			const tx = x + ox;
			if (tx < 0 || tx >= width) continue;
			const s = (y * image.width + x) * 4;
			const sa = image.data[s + 3] / 255;
			if (sa === 0) continue;
			const d = (ty * width + tx) * 4;
			const da = out[d + 3] / 255;
			const a = sa + da * (1 - sa);
			for (let c = 0; c < 3; c++) out[d + c] = Math.round((image.data[s + c] * sa + out[d + c] * da * (1 - sa)) / a);
			out[d + 3] = Math.round(a * 255);
		}
	}
}

/**
 * The brush library tools' renderer for the vector host
 * (`createBrushLibraryToolProvider(library, { profile: VECTOR_PROFILE, renderPreview: renderVectorBrushPreview })`,
 * and the vector editor's `brushPreview`): every brush a vector brushstroke paints, on a
 * transparent background (moving brushes over two bands of colour). Throws, saying why, for a brush
 * the vector host can't paint.
 */
export const renderVectorBrushPreview: BrushPreviewRenderer = async (brush: Brush, { width, height, color }) => {
	const engine = resolveBrush(brush);
	if (!checkBrush(brush, VECTOR_PROFILE).ok || !isVectorBrushstrokeEngine(engine)) {
		throw new Error(vectorBrushstrokeBrushError(brush.id, [brush]) ?? `Brush '${brush.id}' (${brush.name}) can't paint a vector brushstroke: its engine does not paint brushstrokes.`);
	}
	const media = vectorMediaEngine(engine);
	if (!media) return renderCanvasBrushPreview(brush, { width, height, color });
	const size = Math.max(1.5, Math.min(engine.tip.size, height * 0.55));
	const sized: PaintBrush = { ...engine, tip: { ...engine.tip, size } };
	const input = previewStroke(width, height, size);
	const paint = rgba(color);
	const out = new Uint8ClampedArray(width * height * 4);
	let stroke: BrushstrokeImage;
	if (usesVectorBackdrop(media)) {
		const bands = wantsBands(sized);
		const half = Math.ceil(height / 2);
		if (bands) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.set(y < half ? paint : OCHRE, (y * width + x) * 4);
		const backdrop = (rect: RasterRect) => {
			const data = new Uint8ClampedArray(rect.width * rect.height * 4);
			for (let y = 0; y < rect.height; y++) {
				const py = rect.y + y;
				if (py < 0 || py >= height) continue;
				for (let x = 0; x < rect.width; x++) {
					const px = rect.x + x;
					if (px >= 0 && px < width) data.set(out.subarray((py * width + px) * 4, (py * width + px) * 4 + 4), (y * rect.width + x) * 4);
				}
			}
			return data;
		};
		stroke = renderBackdropBrushstroke(input, sized, { color: paint, seed: SEED, backdrop: bands ? backdrop : null });
	} else {
		const job = new WetBrushstrokeJob(input, sized, { color: paint, seed: SEED });
		while (!job.run(SLICE_MS)) await new Promise((resolve) => setTimeout(resolve, 0));
		stroke = job.image();
	}
	drawOver(out, width, height, stroke);
	return { data: bytesToBase64(encodePng(width, height, out)), mimeType: 'image/png' };
};
