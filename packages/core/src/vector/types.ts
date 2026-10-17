import type { CanvasGradientDef } from '../canvas/gradient.js';

/** An affine matrix `[a, b, c, d, e, f]`: `x' = a·x + c·y + e`, `y' = b·x + d·y + f` (SVG order). */
export type VectorMatrix = readonly [number, number, number, number, number, number];

/** A point in document coordinates. */
export interface Vec2 {
	x: number;
	y: number;
}

/**
 * How an anchor's handles relate:
 * - `corner`: handles move independently (or are absent).
 * - `smooth`: handles stay on one line through the anchor, lengths independent.
 * - `symmetric`: handles stay on one line with equal lengths.
 */
export type VectorAnchorType = 'corner' | 'smooth' | 'symmetric';

/**
 * Live corner shapes: `round` (an arc tangent to both sides), `inverted` (an arc centred on
 * the corner, cut into the shape) and `chamfer` (a straight bevel).
 */
export type VectorCornerKind = 'round' | 'inverted' | 'chamfer';

export const VECTOR_CORNER_KINDS: readonly VectorCornerKind[] = ['round', 'inverted', 'chamfer'];

/**
 * A live corner: drawn rounded (or cut) at render, hit-test, bounds, boolean, outline and export
 * time while the stored anchor stays sharp. The radius shrinks to fit when the sides are short:
 * the cut reaches at most halfway along each side.
 */
export interface VectorCorner {
	radius: number;
	/** Default `round`. */
	kind?: VectorCornerKind;
}

/**
 * One anchor of a subpath. Handles are absolute document positions; a missing (or `null`)
 * handle sits on the anchor, so a segment with no handles at either end is a straight line.
 */
export interface VectorAnchor {
	x: number;
	y: number;
	/** Control point of the segment arriving at this anchor. */
	in?: Vec2 | null;
	/** Control point of the segment leaving this anchor. */
	out?: Vec2 | null;
	/** Default `corner`. */
	type?: VectorAnchorType;
	/** Live corner radius. Ignored on smooth / symmetric anchors and the ends of open subpaths. */
	corner?: VectorCorner | null;
}

/** A chain of anchors joined by line or cubic Bézier segments. */
export interface VectorSubpath {
	anchors: VectorAnchor[];
	/** Joins the last anchor back to the first. */
	closed: boolean;
}

/**
 * Gradient styles: `linear` (start → end), `radial` (centred on the start, reaching the end;
 * focal point and aspect), `conic` (an angle sweep around the start, from the end's direction
 * towards the aspect handle's: clockwise on screen), `reflected` (linear mirrored about the
 * start) and `diamond` (`|u| + |v|` in the gradient's frame: a rhombus through the end and the
 * aspect handle).
 */
export type VectorGradientType = 'linear' | 'radial' | 'conic' | 'reflected' | 'diamond';
export const VECTOR_GRADIENT_TYPES: readonly VectorGradientType[] = ['linear', 'radial', 'conic', 'reflected', 'diamond'];

/** What a gradient paints past its ends: the end colours, mirrored periods or repeated periods. */
export type VectorGradientSpread = 'pad' | 'reflect' | 'repeat';
export const VECTOR_GRADIENT_SPREADS: readonly VectorGradientSpread[] = ['pad', 'reflect', 'repeat'];

/** Where colours mix between stops: sRGB (SVG's own), linear light or Oklab. */
export type VectorGradientInterpolation = 'srgb' | 'linear' | 'oklab';
export const VECTOR_GRADIENT_INTERPOLATIONS: readonly VectorGradientInterpolation[] = ['srgb', 'linear', 'oklab'];

/**
 * The space a gradient's points are in: fractions of the shape's bounding box (SVG's
 * `objectBoundingBox`, the default) or the node's own coordinates (`userSpaceOnUse`).
 */
export type VectorGradientUnits = 'objectBoundingBox' | 'userSpaceOnUse';

/**
 * How a gradient lies on a stroke: `within` (laid over the stroke's area like a fill), `along`
 * (t runs from 0 at the start of each subpath to 1 at its end) or `across` (from the stroke's
 * left edge to its right edge, looking along the path).
 */
export type VectorStrokeGradientMode = 'within' | 'along' | 'across';
export const VECTOR_STROKE_GRADIENT_MODES: readonly VectorStrokeGradientMode[] = ['within', 'along', 'across'];

/** A colour stop. `opacity` multiplies the colour's own alpha. */
export interface VectorGradientStop {
	/** 0–1. */
	offset: number;
	color: string;
	/** 0–1, default 1. */
	opacity?: number;
	/**
	 * Where, between this stop and the next (0–1 of the way), the colour is half-way between
	 * them. Default 0.5 (an even mix).
	 */
	midpoint?: number;
}

/**
 * A gradient paint. `CanvasGradientDef` (the canvas package's linear `angle` / radial
 * `cx, cy, r` gradients) is a valid value: those fields are the shorthand form. Explicit
 * geometry (`start` / `end`, in `units`) wins over the shorthand.
 */
export interface VectorGradient {
	type: VectorGradientType;
	stops: VectorGradientStop[];
	/**
	 * Shorthand direction in degrees, CSS style (0 points up, clockwise): a linear or reflected
	 * gradient's direction across the box (default 180), a conic gradient's start angle or a
	 * diamond's turn (default 90).
	 */
	angle?: number;
	/** Shorthand centre and radius of radial, conic and diamond gradients (fractions of the box, default 0.5). */
	cx?: number;
	cy?: number;
	r?: number;
	/** Where t = 0: a linear gradient's start, the centre of the other styles. */
	start?: Vec2;
	/** Where t = 1 along the gradient's main axis (a radial gradient's radius). */
	end?: Vec2;
	/**
	 * The end of the secondary axis (radial, conic and diamond): its distance from `start` over
	 * the main axis' length is the aspect ratio. Absent: square to the main axis, as long.
	 */
	width?: Vec2 | null;
	/** A radial gradient's focal point (where t = 0); absent: the centre. */
	focal?: Vec2 | null;
	/** Radius of the focal circle as a fraction of the radius (SVG `fr`, default 0). */
	focalRadius?: number;
	/** Space of `start`, `end`, `width` and `focal` (default `objectBoundingBox`). */
	units?: VectorGradientUnits;
	/** Default `pad`. */
	spread?: VectorGradientSpread;
	/** Default `srgb`. */
	interpolation?: VectorGradientInterpolation;
	/**
	 * 0–1: how far the colours follow a smooth spline through the stops instead of straight
	 * lines (Photoshop's Smoothness). Default 0.
	 */
	smoothness?: number;
	/** On a stroke: how the gradient lies on it (default `within`). Ignored on fills. */
	strokeMode?: VectorStrokeGradientMode;
}

/** A fill or stroke: any CSS colour, a gradient, or `null` / `'none'` for no paint. */
export type VectorPaint = string | VectorGradient | CanvasGradientDef | null;

export type VectorFillRule = 'nonzero' | 'evenodd';
export type VectorLineCap = 'butt' | 'round' | 'square';
export type VectorLineJoin = 'miter' | 'round' | 'bevel';
/**
 * Where the stroke sits on the outline: centred on it, inside the shape or outside it. Only
 * shapes whose subpaths are all closed have an inside; open paths always stroke centred.
 */
export type VectorStrokeAlign = 'center' | 'inside' | 'outside';
/** Arrowheads and end markers for the ends of open paths. */
export type VectorArrowhead = 'triangle' | 'arrow' | 'open' | 'circle' | 'square' | 'bar';
export const VECTOR_ARROWHEADS: readonly VectorArrowhead[] = ['triangle', 'arrow', 'open', 'circle', 'square', 'bar'];
/**
 * `extend`: the head's tip sits past the end point and the path keeps its length; `tip`: the
 * tip sits on the end point and the stroke is shortened under the head.
 */
export type VectorArrowAlign = 'extend' | 'tip';

/**
 * One point of a variable-width stroke profile. `t` is the position along the subpath by
 * length (0 at its start, 1 at its end); `left` and `right` are how far the stroke reaches on
 * each side, as multiples of half the stroke width (looking along the path on screen, y down).
 * A uniform stroke has 1 on both sides. Two points at the same `t` make a step.
 */
export interface VectorWidthPoint {
	t: number;
	left: number;
	right: number;
}

/** Paint and stroke settings of a path. */
export interface VectorStyle {
	fill?: VectorPaint;
	stroke?: VectorPaint;
	/** Default 1. */
	strokeWidth?: number;
	strokeLinecap?: VectorLineCap;
	strokeLinejoin?: VectorLineJoin;
	strokeDasharray?: number[];
	/** Default `nonzero`. */
	fillRule?: VectorFillRule;
	/** Default `center`. */
	strokeAlign?: VectorStrokeAlign;
	/** Head at the start of the first subpath when it is open, or none. */
	startArrow?: VectorArrowhead | null;
	/** Head at the end of the last subpath when it is open, or none. */
	endArrow?: VectorArrowhead | null;
	/** Default `extend`. */
	arrowAlign?: VectorArrowAlign;
	/** Size of the start head as a multiple of the stroke width (default 1: a head 4 widths long). */
	startArrowScale?: number;
	/** Size of the end head (default 1). */
	endArrowScale?: number;
	/**
	 * Variable width: side scales along each subpath, interpolated with a monotone cubic (see
	 * `widthProfileAt`). Absent, empty or `null` strokes at a uniform width. A profiled stroke is
	 * drawn as its filled outline.
	 */
	strokeWidthProfile?: VectorWidthPoint[] | null;
}

interface VectorNodeBase {
	id: string;
	name?: string;
	/** Default true. */
	visible?: boolean;
	/** Locked nodes are drawn but cannot be picked or edited on the canvas. */
	locked?: boolean;
	/** 0–1, default 1. */
	opacity?: number;
	/**
	 * Placement in the parent's space: a rigid matrix (rotation + translation). Anchors and
	 * children are in the node's own space. Omitted for unrotated nodes, whose positions are
	 * stored directly. Scale and skew are never stored here — `transformVectorNode` bakes
	 * them into the geometry, so stroke widths and the rotated selection box stay exact.
	 */
	transform?: VectorMatrix;
	/**
	 * An in-between a blend group generated from its keys. Steps are rebuilt whenever a key or
	 * the blend options change, and are locked (clicks select the blend group).
	 */
	blendStep?: boolean;
	/**
	 * Live path effects, applied top to bottom: each acts on every path above it (the node's own
	 * outline, or a group's children, then the result of the effects before it), and effects after a
	 * repeater act on its copies. The stored anchors and children never change.
	 */
	effects?: VectorEffect[] | null;
	/**
	 * As an operand of a live boolean group: how it combines with the result of the operands below
	 * it. Absent: the group's `liveBoolean` operation.
	 */
	booleanOperation?: VectorBooleanOperation | null;
}

/** A shape made of one or more subpaths (holes and compound shapes included). */
export interface VectorPathNode extends VectorNodeBase, VectorStyle {
	type: 'path';
	subpaths: VectorSubpath[];
}

/**
 * How a blend spaces its in-betweens: a number of `steps` between each pair of keys, a fixed
 * `distance` between steps along the spine, or `smoothColor` (as many steps as the colours
 * need for a smooth ramp; by distance when the colours match).
 */
export type VectorBlendSpacing = 'steps' | 'distance' | 'smoothColor';
export const VECTOR_BLEND_SPACINGS: readonly VectorBlendSpacing[] = ['steps', 'distance', 'smoothColor'];

/** Settings of a blend. */
export interface VectorBlendOptions {
	/** Default `steps`. */
	spacing?: VectorBlendSpacing;
	/** Steps between each pair of keys with `steps` spacing (default 5). */
	steps?: number;
	/** Distance between steps along the spine with `distance` spacing (default 20). */
	distance?: number;
	/** Turn the steps with the spine's direction (default `false`: they keep the keys' orientation). */
	orientToSpine?: boolean;
	/** Move anchors in straight lines instead of the rotation-aware morph (default `false`). */
	linear?: boolean;
}

/** A live blend: the group's keys plus how the in-betweens are made and laid out. */
export interface VectorBlend extends VectorBlendOptions {
	/**
	 * A replaced spine in the group's space: the steps follow it instead of the straight lines
	 * between the keys' centres (the keys sit along it, spread evenly by arc length).
	 */
	spine?: VectorSubpath | null;
	/** The anchor of each key's first subpath its blend starts from, by key id (the Blend tool's clicks). */
	starts?: Record<string, number>;
}

/** A group of nodes that select and transform together. */
export interface VectorGroupNode extends VectorNodeBase {
	type: 'group';
	children: VectorNode[];
	/**
	 * Makes the group a live blend: its children that are not `blendStep`s are the keys, in
	 * stacking order, and the steps between them are regenerated whenever a key changes.
	 */
	blend?: VectorBlend | null;
	/**
	 * Makes the group a live boolean: its children stay editable operands, folded bottom to top
	 * (each by its own `booleanOperation` or this one), and the group draws as the result in the
	 * bottom operand's style.
	 */
	liveBoolean?: VectorBooleanOperation | null;
}

export type VectorNode = VectorPathNode | VectorGroupNode;

/** A vector drawing: an artboard and its nodes, bottom to top. */
export interface VectorDocument {
	width: number;
	height: number;
	/** Artboard colour (default: transparent). */
	background?: string;
	nodes: VectorNode[];
}

/** An axis-aligned rectangle. */
export interface VectorBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Identifies one anchor of a path node. */
export interface VectorAnchorRef {
	nodeId: string;
	subpath: number;
	index: number;
}

/** Identifies one handle of an anchor. */
export interface VectorHandleRef extends VectorAnchorRef {
	handle: 'in' | 'out';
}

/**
 * Canvas tools. `direct` edits anchors, handles and segments; the shape tools drag out a new
 * shape; `scissors` cuts a path at a point, `knife` cuts filled shapes along a freehand stroke,
 * `eraser` rubs out the area under one and `width` drags a stroke's width at a point.
 * `shapeBuilder` merges (Alt: deletes) the faces the selected shapes make, and `paintBucket`
 * fills the region the visible outlines enclose around a click with a new shape. `blend`
 * blends the shape clicked first into the one clicked next (clicking an anchor of a closed path
 * starts the blend there).
 */
export type VectorTool =
	| 'select'
	| 'direct'
	| 'pen'
	| 'pencil'
	| 'rect'
	| 'ellipse'
	| 'polygon'
	| 'star'
	| 'line'
	| 'scissors'
	| 'knife'
	| 'eraser'
	| 'width'
	| 'shapeBuilder'
	| 'paintBucket'
	| 'blend'
	| 'gradient';

export const VECTOR_TOOLS: readonly VectorTool[] = [
	'select',
	'direct',
	'pen',
	'pencil',
	'rect',
	'ellipse',
	'polygon',
	'star',
	'line',
	'scissors',
	'knife',
	'eraser',
	'width',
	'shapeBuilder',
	'paintBucket',
	'blend',
	'gradient'
];

/** Keyboard modifiers held during a pointer event. */
export interface VectorModifiers {
	shift?: boolean;
	alt?: boolean;
	/** Cmd on macOS, Ctrl elsewhere. */
	mod?: boolean;
}

/** The eight resize handles of a selection box and the rotation handle. */
export type VectorTransformHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export const VECTOR_TRANSFORM_HANDLES: readonly VectorTransformHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rotate'];

/** Pan and zoom of the canvas: `screen = document × zoom + (x, y)`. */
export interface VectorViewport {
	/** Screen position of the document origin, in screen pixels. */
	x: number;
	y: number;
	zoom: number;
}

/** What the next shape and pen path are drawn with. */
export interface VectorDefaults extends VectorStyle {
	/** Sides of the polygon tool (default 6). */
	polygonSides?: number;
	/** Points of the star tool (default 5). */
	starPoints?: number;
	/** Inner radius of the star tool as a fraction of the outer one (default 0.5). */
	starInnerRatio?: number;
	/** Live corner radius the rectangle, polygon and star tools give their corners (default 0). */
	cornerRadius?: number;
	/** Corner kind of those tools (default `round`). */
	cornerKind?: VectorCornerKind;
}

export type VectorAlign = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type VectorDistribute = 'horizontal' | 'vertical';
export type VectorBooleanOperation = 'union' | 'subtract' | 'intersect' | 'exclude';
/**
 * Pathfinder operations: `divide` (every face its own shape), `trim` (hidden parts removed),
 * `merge` (Trim, then touching parts of one fill joined), `crop` (the top shape crops the others),
 * `outline` (outlines cut into open strokes where they meet) and `minusBack` (the top shape minus
 * everything below it).
 */
export type VectorPathfinderOperation = 'divide' | 'trim' | 'merge' | 'crop' | 'outline' | 'minusBack';
export const VECTOR_PATHFINDER_OPERATIONS: readonly VectorPathfinderOperation[] = ['divide', 'trim', 'merge', 'crop', 'outline', 'minusBack'];
export type VectorArrange = 'front' | 'forward' | 'backward' | 'back';
/** Average: line anchors up on a horizontal line (same y), a vertical one (same x), or both. */
export type VectorAverageAxis = 'horizontal' | 'vertical' | 'both';

/**
 * Live path effects (After Effects' path operators): `trim` (Trim Paths), `roundCorners`,
 * `puckerBloat`, `twist`, `zigzag`, `wiggle` (Wiggle Paths), `offset` (Offset Paths), `merge`
 * (Merge Paths) and `repeater`.
 */
export type VectorEffectType = 'trim' | 'roundCorners' | 'puckerBloat' | 'twist' | 'zigzag' | 'wiggle' | 'offset' | 'merge' | 'repeater';
export const VECTOR_EFFECT_TYPES: readonly VectorEffectType[] = ['trim', 'roundCorners', 'puckerBloat', 'twist', 'zigzag', 'wiggle', 'offset', 'merge', 'repeater'];

/** Merge Paths modes: a compound path (no boolean), union, the first minus the others, intersection or exclusion. */
export type VectorMergeMode = 'merge' | 'add' | 'subtract' | 'intersect' | 'exclude';
export const VECTOR_MERGE_MODES: readonly VectorMergeMode[] = ['merge', 'add', 'subtract', 'intersect', 'exclude'];

/** Parameters of each effect type. Lengths are in the node's own units, angles in degrees, percentages 0–100. */
export interface VectorEffectParamsMap {
	trim: {
		/** Start and end of the kept part, percent of the length (swapped when start > end). */
		start: number;
		end: number;
		/** Shifts both, in degrees (360° = once round). */
		offset: number;
		/**
		 * `simultaneous`: every path trimmed by the same fractions of its own length;
		 * `individual`: the paths laid end to end in stacking order and trimmed as one length.
		 */
		mode: 'simultaneous' | 'individual';
	};
	roundCorners: { radius: number };
	/** Percent, −100 (pucker: spiky) to 100 (bloat: bulging). */
	puckerBloat: { amount: number };
	twist: {
		/** Turn at the farthest point from the centre (none at the centre). */
		angle: number;
		/** The centre as an offset from the middle of the paths' bounds. */
		center: Vec2;
	};
	zigzag: {
		/** How far the points move to either side. */
		size: number;
		/** Ridges per segment. */
		ridges: number;
		/** Rounded waves instead of sharp zig zags. */
		smooth: boolean;
	};
	wiggle: {
		/** Largest displacement. */
		size: number;
		/** Points added per segment. */
		detail: number;
		smooth: boolean;
		/** Wiggles per second. */
		speed: number;
		/** Percent: how much neighbouring points move together. */
		correlation: number;
		/** Degrees (360° = one wiggle). */
		phase: number;
		/** The same seed (and time) always gives the same wiggle. */
		seed: number;
		/** Seconds: where along the wiggle's motion it is drawn. */
		time: number;
	};
	offset: {
		/** Grows (positive) or shrinks (negative) the shapes. */
		amount: number;
		join: VectorLineJoin;
		miterLimit: number;
		/** Copies, copy i offset by `amount · (i + 1 + copyOffset)`. */
		copies: number;
		copyOffset: number;
	};
	merge: { mode: VectorMergeMode };
	repeater: {
		/** Copies, the original included; a fraction fades the last copy. */
		copies: number;
		/** Shifts the copies along: copy i is transformed `i + offset` times. */
		offset: number;
		/** Each step: move, about `anchor` turn by `rotation` and scale by `scale` percent. */
		position: Vec2;
		/** Offset from the middle of the paths' bounds. */
		anchor: Vec2;
		rotation: number;
		scale: Vec2;
		/** Percent opacity of the first and last copies (in between interpolated). */
		startOpacity: number;
		endOpacity: number;
		/** `below`: each copy draws under the one before it; `above`: over it. */
		composite: 'below' | 'above';
	};
}

/** One entry of an effect stack. */
export type VectorEffect = {
	[K in VectorEffectType]: {
		/** Unique within the node. */
		id: string;
		type: K;
		/** Disabled effects are skipped. Default true. */
		enabled?: boolean;
		params: VectorEffectParamsMap[K];
	};
}[VectorEffectType];

/** Identifies one segment of a path node: from anchor `segment` to the next. */
export interface VectorSegmentRef {
	nodeId: string;
	subpath: number;
	segment: number;
}
