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

/** A gradient stop of brushed stroke paint (the paint engine's `PaintGradientStop`). */
export interface CanvasBrushPaintStop {
	/** 0..1 along the gradient. */
	offset: number;
	/** `#rrggbb`, or `paint` (the stroke colour) / `secondary` (white). */
	color: string;
	/** 0..1 (default 1): multiplies the brush's flow where this colour is laid. */
	opacity?: number;
	/** Where between this stop and the next (0.05..0.95) the colours are half mixed (default 0.5). */
	midpoint?: number;
}

/**
 * What moves a brushed stroke along its gradient. `distance` is in canvas units of the path
 * (default 300, mirrored), so the colours keep their place at every zoom. Canvas strokes carry no
 * timing, so the paint engine's `velocity` and `time` mappings are refused.
 */
export type CanvasBrushPaintMapping =
	| { by: 'distance'; length?: number; repeat?: 'clamp' | 'repeat' | 'mirror'; unit?: 'px' | 'dabs' }
	| { by: 'pressure' }
	| { by: 'tilt' }
	| { by: 'direction' }
	| { by: 'across-tip' }
	| { by: 'random'; every?: number };

/**
 * What a brushed stroke paints with, instead of its stroke colour (the paint engine's
 * `PaintSource`, described structurally so the canvas types never import the paint engine): one
 * colour, or gradient paint sampled dab by dab. The stroke colour still gives the alpha and fills
 * `paint` stops.
 */
export type CanvasBrushPaint =
	| { type: 'color'; color: string }
	| {
			type: 'gradient';
			/** 2..16 stops sorted by offset. */
			stops: CanvasBrushPaintStop[];
			/** How neighbouring stops mix (default `pigment`). */
			space?: 'pigment' | 'oklab' | 'srgb';
			/** Default: distance, 300 canvas units, mirror. */
			map?: CanvasBrushPaintMapping;
			/** 0 (hard steps) .. 1 (smooth, default). */
			softness?: number;
	  };

/**
 * What makes a path shape a brushed stroke: the brush, plus pen profiles spread evenly along the
 * path's length (first value at the start, last at the end).
 */
export interface CanvasBrushstroke {
	brush: CanvasBrush;
	/** Gradient paint (or one colour) instead of the stroke colour. */
	paint?: CanvasBrushPaint;
	/** Pressure 0..1 along the length (default full pressure). */
	pressure?: number[];
	/** Pointer Events pen tilt in degrees (−90..90) along the length. */
	tiltX?: number[];
	tiltY?: number[];
	/**
	 * Character seed. A stroke with one renders the brush's character: its seeded size, angle,
	 * opacity and scatter jitter and the paper grain it catches (charcoal, pastel and pencil get
	 * their look from these). New strokes get one; older strokes without it render plain dabs at
	 * the stroke width, exactly as before.
	 */
	seed?: number;
	/**
	 * Brush diameter in path units. Missing: the preset's own size (tip settings: their `size`, else
	 * the stroke width) for strokes with a `seed`, the stroke width for older ones.
	 */
	size?: number;
	/** The paper the grain comes from (default the built-in sanded grain); `null` for no grain. */
	paper?: CanvasBrushPaper | null;
}

/** Paper for a brushed stroke's grain (the paint engine's `BrushstrokePaper`). */
export interface CanvasBrushPaper {
	/** Grain pattern (default `sanded`: a fine, even tooth). */
	pattern?: 'smooth' | 'cold-pressed' | 'hot-pressed' | 'rough' | 'vellum' | 'laid' | 'ingres' | 'sanded' | 'canvas' | 'linen' | 'gesso';
	/** Grain seed (default 1). */
	seed?: number;
	/** Grain scale in canvas units, 1 the pattern's natural size (0.25..8, default 1). */
	scale?: number;
	/** Grain depth 0..1, times the brush's grain response (default 0.5). */
	depth?: number;
}

/** A dry paint preset that can brush a canvas stroke. */
export interface CanvasBrushPreset {
	id: string;
	name: string;
	category: string;
	/** The preset's own tip diameter in canvas units: a new brushed stroke's default size. */
	size: number;
}
