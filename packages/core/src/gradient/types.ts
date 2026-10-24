/**
 * CSS-shaped gradient model types.
 *
 * Gradients are opt-in: `@pixerate/editor/color` never imports gradient code.
 */

export type GradientType = 'linear' | 'radial' | 'conic';
export type GradientInterpolation = 'srgb' | 'srgb-linear' | 'oklab' | 'oklch';

export interface GradientStop {
	/** Stable id, unique within the gradient (e.g. "s1"). Assigned by the model when missing. */
	id: string;
	/** 0–1 along the gradient. */
	offset: number;
	/**
	 * Any CSS colour, or a dual colour as `light-dark(a, b)` (Phase 5). Stored normalised by
	 * `normalizeGradient`: hex, or `light-dark(#a, #b)` when the halves differ.
	 */
	color: string;
	/** 0.05–0.95: where between this stop and the next the colours are half mixed (default 0.5, CSS colour hint). */
	midpoint?: number;
}

export interface Gradient {
	type: GradientType;
	stops: GradientStop[]; // at least 2
	/** Linear and conic: degrees, CSS convention (0 = to top, 90 = to right, default 180 = to bottom). */
	angle?: number;
	/** Radial and conic: centre, 0–1 of the box (default 0.5, 0.5). */
	center?: { x: number; y: number };
	/** Radial: 'circle' or 'ellipse' (default 'ellipse', CSS farthest-corner). */
	shape?: 'circle' | 'ellipse';
	/** Default 'oklab'. */
	interpolation?: GradientInterpolation;
	/** Repeat the stop pattern (CSS repeating-*-gradient). Default false. */
	repeating?: boolean;
}

export type GradientShape = 'circle' | 'ellipse';

export interface GradientCheckOptions {
	surface?: string;
	text?: string;
	fontSize?: number;
	bold?: boolean;
}

