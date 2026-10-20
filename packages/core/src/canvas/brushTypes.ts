/**
 * The data types of brushed freehand strokes, with no imports, so shape types and commands can name
 * them without reaching the paint engine's types.
 */

/** Tip settings for a brushed stroke (the paint engine's brush settings; `size` defaults to the stroke width). */
export interface CanvasBrushSettings {
	/** Diameter in canvas units (default: the stroke width). */
	size?: number;
	/** 0 (soft) .. 1 (hard, default). */
	hardness?: number;
	/** Dab spacing as a fraction of the diameter (0.01..10, default 0.1). */
	spacing?: number;
	/** Tip angle in degrees (default 0). */
	angle?: number;
	/** Tip roundness 0.01..1 (default 1). */
	roundness?: number;
	/** Stroke opacity ceiling 0..1 (default 1). */
	opacity?: number;
	/** Build-up per dab 0..1 (default 1). */
	flow?: number;
	/** Pressure controls size (default true). */
	pressureSize?: boolean;
	/** Pressure controls opacity (default false). */
	pressureOpacity?: boolean;
}

/**
 * A brush for a freehand stroke: the id of a dry paint preset (`ink-pen`, `pencil-hb`, `marker`, …;
 * `listCanvasBrushes` lists them) or tip settings. The stroke width sets the brush size unless
 * tip settings give one.
 */
export type CanvasBrush = string | CanvasBrushSettings;

/**
 * What makes a path shape a brushed stroke: the brush, plus pen profiles spread evenly along the
 * path's length (first value at the start, last at the end).
 */
export interface CanvasBrushstroke {
	brush: CanvasBrush;
	/** Pressure 0..1 along the length (default full pressure). */
	pressure?: number[];
	/** Pointer Events pen tilt in degrees (−90..90) along the length. */
	tiltX?: number[];
	tiltY?: number[];
}

/** A dry paint preset that can brush a canvas stroke. */
export interface CanvasBrushPreset {
	id: string;
	name: string;
	category: string;
	/** The preset's own tip diameter in pixels (the stroke width replaces it). */
	size: number;
}
