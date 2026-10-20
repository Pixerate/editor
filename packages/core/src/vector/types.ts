import type { CanvasGradientDef } from '../canvas/gradient.js';
import type { WarpMesh, WarpStyle } from '../geom/types.js';

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
	/**
	 * Corner smoothing (squircle, as in Figma and iOS), 0–1, round corners between straight sides
	 * only: the cut reaches (1 + smoothing) times as far along each side and eases into a shorter arc,
	 * so curvature builds up gradually. Default 0 (a circular arc).
	 */
	smoothing?: number;
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
	/**
	 * A stable id, unique within its path, given when a constraint refers to the anchor (see
	 * `VectorConstraint`). Edits that move or restyle the anchor keep it; edits that rebuild a path
	 * drop it, and constraints on a dropped anchor are removed.
	 */
	id?: string;
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
export type VectorPaint = string | VectorGradient | VectorMeshGradient | VectorFreeformGradient | CanvasGradientDef | null;

/**
 * A gradient mesh (Illustrator's Gradient Mesh, PDF shading types 6 and 7): a lattice of
 * `(rows + 1) × (columns + 1)` points in the node's own space, row by row, each with a colour.
 * Each cell is a smooth patch whose sides are curves through the lattice and whose colour blends
 * between its four corners. Outside the patches the paint is transparent.
 */
export interface VectorMeshGradient {
	type: 'mesh';
	rows: number;
	columns: number;
	/** Lattice points, row by row (`(rows + 1) × (columns + 1)` of them). */
	points: Vec2[];
	/** A CSS colour per point. */
	colors: string[];
	/** Opacity per point (0–1, default 1 each). */
	opacities?: number[];
}

/** One colour point of a freeform gradient. */
export interface VectorFreeformPoint {
	x: number;
	y: number;
	color: string;
	/** 0–1, default 1. */
	opacity?: number;
	/** Radius of the disc of pure colour round the point, as a fraction of half the box's longer side (0–1, default 0). */
	spread?: number;
}

/**
 * A freeform gradient (Illustrator's Freeform Gradient): colour points placed anywhere in the
 * node's own space, blended across the shape by distance, and optional smooth lines through some
 * of them that carry their colours along their length.
 */
export interface VectorFreeformGradient {
	type: 'freeform';
	points: VectorFreeformPoint[];
	/** Each line runs smoothly through the points at these indices, in order. */
	lines?: number[][];
}

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

/**
 * Blend modes of paint layers and nodes: the set SVG and CSS `mix-blend-mode` draw, named as the
 * image editor names them (`@pixerate/editor/image-editor` `BlendMode`). `linear-dodge` draws as
 * CSS `plus-lighter`. The image editor's other modes (linear burn, vivid light, pigment, …) have
 * no SVG equivalent and are not offered.
 */
export type VectorBlendMode =
	| 'normal'
	| 'darken'
	| 'multiply'
	| 'color-burn'
	| 'lighten'
	| 'screen'
	| 'color-dodge'
	| 'linear-dodge'
	| 'overlay'
	| 'soft-light'
	| 'hard-light'
	| 'difference'
	| 'exclusion'
	| 'hue'
	| 'saturation'
	| 'color'
	| 'luminosity';
/** Every vector blend mode, in the image editor's (Photoshop's) menu order. */
export const VECTOR_BLEND_MODES: readonly VectorBlendMode[] = [
	'normal',
	'darken',
	'multiply',
	'color-burn',
	'lighten',
	'screen',
	'color-dodge',
	'linear-dodge',
	'overlay',
	'soft-light',
	'hard-light',
	'difference',
	'exclusion',
	'hue',
	'saturation',
	'color',
	'luminosity'
];

/** One fill of a path's fill stack (`VectorStyle.fills`). */
export interface VectorPaintLayer {
	/** A colour, a gradient, or `null` for none. */
	paint: VectorPaint;
	/** 0–1, default 1. Multiplies the paint's own alpha. */
	opacity?: number;
	/** How the layer mixes with what is under it (the layers below, then the backdrop). Default `normal`. */
	blendMode?: VectorBlendMode;
	/** Hidden layers are kept but not drawn or hit. Default true. */
	visible?: boolean;
}

/** The settings each stroke layer has of its own (the stroke shorthand fields of `VectorStyle`). */
export type VectorStrokeSettings = Pick<
	VectorStyle,
	| 'strokeWidth'
	| 'strokeLinecap'
	| 'strokeLinejoin'
	| 'strokeDasharray'
	| 'strokeAlign'
	| 'startArrow'
	| 'endArrow'
	| 'arrowAlign'
	| 'startArrowScale'
	| 'endArrowScale'
	| 'strokeWidthProfile'
>;

/**
 * What a stroke layer draws. Only `paint` (a paint along the outline, the default) exists today.
 * Other kinds are the extension point for strokes drawn some other way, such as a raster
 * brushstroke from `@pixerate/editor/paint` laid along the path: a layer with an unknown kind is
 * kept through edits, load and SVG round trips, listed to agents, and skipped when drawing and
 * hit-testing.
 */
export type VectorStrokeLayerKind = 'paint';

/** One stroke of a path's stroke stack (`VectorStyle.strokes`): a paint plus its own stroke settings. */
export interface VectorStrokeLayer extends VectorPaintLayer, VectorStrokeSettings {
	/** Default `paint`. See `VectorStrokeLayerKind`. */
	kind?: VectorStrokeLayerKind;
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
	/**
	 * The fill stack, bottom to top. Absent: `fill` alone is the stack (one layer, or none without
	 * a paint). Present: it is the truth, and `fill` mirrors its top layer's paint. The shorthand
	 * stays writable: setting `fill` to a paint repaints the top layer, `null` clears the stack.
	 * Stacks of one plain layer (full opacity, `normal`, visible) are stored as the shorthand.
	 */
	fills?: VectorPaintLayer[] | null;
	/**
	 * The stroke stack, bottom to top, drawn over every fill. Like `fills`: absent, `stroke` and the
	 * stroke settings above are the one stroke; present, they mirror its top layer, and writing them
	 * edits that layer (`stroke: null` clears the stack).
	 */
	strokes?: VectorStrokeLayer[] | null;
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
	/** How the whole node (all its paint, filters included) mixes with what is under it. Default `normal`. */
	blendMode?: VectorBlendMode;
	/**
	 * Visual filters (drop and inner shadows, glows, blurs, feather), applied to everything the
	 * node draws. Unlike path `effects` they never change geometry: bounds, hit-testing and
	 * booleans ignore them.
	 */
	filters?: VectorFilter[] | null;
	/**
	 * How the node follows its frame when the frame is resized (`VectorGroupNode.frame`): per
	 * axis, pinned to the start (default `left` / `top`), the end, both (it stretches), the centre,
	 * or scaled with the frame. Ignored outside frames.
	 */
	resizing?: VectorResizing | null;
}

/** Horizontal resizing constraint of a frame's child (see `VectorNodeBase.resizing`). */
export type VectorHorizontalResizing = 'left' | 'right' | 'leftRight' | 'center' | 'scale';
/** Vertical resizing constraint of a frame's child (see `VectorNodeBase.resizing`). */
export type VectorVerticalResizing = 'top' | 'bottom' | 'topBottom' | 'center' | 'scale';
export const VECTOR_HORIZONTAL_RESIZING: readonly VectorHorizontalResizing[] = ['left', 'right', 'leftRight', 'center', 'scale'];
export const VECTOR_VERTICAL_RESIZING: readonly VectorVerticalResizing[] = ['top', 'bottom', 'topBottom', 'center', 'scale'];

/** A frame child's resizing constraints (Figma's "constraints"). */
export interface VectorResizing {
	/** Default `left`. */
	horizontal?: VectorHorizontalResizing;
	/** Default `top`. */
	vertical?: VectorVerticalResizing;
}

/**
 * Makes a group a frame (an artboard when top-level): a rectangle in the group's own space with an
 * optional fill drawn below the children, which by default it clips. Resizing the frame moves and
 * resizes its children by their `resizing` constraints instead of scaling them.
 */
export interface VectorFrame {
	x: number;
	y: number;
	width: number;
	height: number;
	/** The frame's background, drawn below its children (default none). */
	fill?: VectorPaint;
	/** Clip the children to the frame (default true). */
	clip?: boolean;
}

/** A shape made of one or more subpaths (holes and compound shapes included). */
export interface VectorPathNode extends VectorNodeBase, VectorStyle {
	type: 'path';
	subpaths: VectorSubpath[];
	/**
	 * Makes the path a connector: an open line whose ends may be glued to other objects'
	 * connection sites. Its geometry is routed again after every edit, so it follows them.
	 */
	connector?: VectorConnector | null;
}

/**
 * Where a connector end meets an object: the middle of a side of the object's own (unrotated)
 * bounds, its centre, or `auto` (the side facing the connector's other end, chosen on every route).
 */
export type VectorConnectorSide = 'top' | 'right' | 'bottom' | 'left' | 'center' | 'auto';
export const VECTOR_CONNECTOR_SIDES: readonly VectorConnectorSide[] = ['auto', 'top', 'right', 'bottom', 'left', 'center'];

/** How a connector runs between its ends: a straight line, right-angled elbows or an S-curve. */
export type VectorConnectorRoute = 'straight' | 'elbow' | 'curved';
export const VECTOR_CONNECTOR_ROUTES: readonly VectorConnectorRoute[] = ['straight', 'elbow', 'curved'];

/** A glued connector end. */
export interface VectorConnectorEnd {
	nodeId: string;
	/** Default `auto`. */
	side?: VectorConnectorSide;
}

/** A connector's settings (`VectorPathNode.connector`). An end that is not glued stays where it is. */
export interface VectorConnector {
	start?: VectorConnectorEnd | null;
	end?: VectorConnectorEnd | null;
	/** Default `straight`. */
	route?: VectorConnectorRoute;
	/** Corner radius of an elbow route's bends (document units, default 0). */
	radius?: number;
	/** How far an elbow or curve leaves a glued end straight out of its side before turning (document units, default 16). */
	gap?: number;
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

/**
 * How a mask group's mask (its first, bottom child) hides the rest: `clip` (a clipping mask: the
 * mask's outline, fully opaque; its paint is not drawn), `alpha` (an opacity mask by the mask's
 * drawn alpha: soft edges, gradients and opacity count) or `luminance` (by its brightness times
 * its alpha: white shows, black hides).
 */
export type VectorMaskType = 'clip' | 'alpha' | 'luminance';
export const VECTOR_MASK_TYPES: readonly VectorMaskType[] = ['clip', 'alpha', 'luminance'];

/** A group's mask settings (`VectorGroupNode.mask`). */
export interface VectorMask {
	type: VectorMaskType;
	/** Show the contents where the mask hides them and hide them where it shows them. Default false. */
	invert?: boolean;
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
	/**
	 * Makes the group a mask group: its first (bottom) child is the mask and the children above it
	 * show only where the mask lets them (see `VectorMaskType`). Hit-testing, bounds, snapping and
	 * booleans use the masked result. A hidden mask child turns the mask off (the contents draw
	 * whole). The group's own opacity, blend mode and filters apply to the masked result, and its
	 * path effects to the contents (not the mask). Ignored on blends and live booleans.
	 */
	mask?: VectorMask | null;
	/**
	 * Makes the group a frame (see `VectorFrame`): it draws its fill below the children, clips them,
	 * selects and snaps by its rectangle, and lays its children out by their `resizing` constraints
	 * when resized. Ignored on blends, live booleans and mask groups.
	 */
	frame?: VectorFrame | null;
	/**
	 * Makes the group a live symmetry group: it draws its children and their mirrored (or rotated)
	 * copies, regenerated whenever a child changes. Ignored on blends, live booleans, mask groups
	 * and frames.
	 */
	symmetry?: VectorSymmetry | null;
}

/**
 * How a symmetry group repeats its children: mirrored across a `vertical`, `horizontal` or
 * `diagonal` axis, across both axes (`dual`: four quarters), or `radial`ly round the centre
 * (`copies` turns, each mirrored too with `mirror`, like a kaleidoscope).
 */
export type VectorSymmetryMode = 'vertical' | 'horizontal' | 'dual' | 'diagonal' | 'radial';
export const VECTOR_SYMMETRY_MODES: readonly VectorSymmetryMode[] = ['vertical', 'horizontal', 'dual', 'diagonal', 'radial'];

/** A symmetry group's settings (`VectorGroupNode.symmetry`). */
export interface VectorSymmetry {
	mode: VectorSymmetryMode;
	/** Where the axes cross (the group's own space). */
	center: Vec2;
	/** Turn of the axes, degrees clockwise (default 0). */
	rotation?: number;
	/** Radial: how many turns round the circle (2–64, default 6). */
	copies?: number;
	/** Radial: mirror each turn too (default false). */
	mirror?: boolean;
}

/**
 * The character style of text (a font and how it is set). Sizes are document units; `tracking` is in
 * 1/1000 em. Paint comes from the node's fills and strokes (and a run's own `fill`).
 */
export interface VectorCharacterStyle {
	/** Family name ("Inter"); a family the shaper lacks draws in a fallback and is listed as missing. */
	fontFamily: string;
	/** CSS weight, 1–1000 (400 regular, 700 bold). */
	fontWeight: number;
	/** Default false. */
	italic?: boolean;
	fontSize: number;
	/** Letter spacing in 1/1000 em (default 0). */
	tracking?: number;
	/** Baseline-to-baseline distance; absent: auto (`autoLeading` × size). */
	leading?: number;
	/** Raises (positive) or lowers the text (default 0). */
	baselineShift?: number;
	underline?: boolean;
	strikethrough?: boolean;
}

/** Character style fields a run can set over the node's own style, plus its own fill. */
export type VectorTextRunStyle = Partial<VectorCharacterStyle> & {
	/** The run's fill: replaces the paint of the node's top fill for these characters. */
	fill?: VectorPaint;
};

/** A style over `length` UTF-16 code units of the text, in order. */
export interface VectorTextRun {
	length: number;
	style: VectorTextRunStyle;
}

export type VectorTextAlign = 'left' | 'center' | 'right' | 'justify';
export const VECTOR_TEXT_ALIGNS: readonly VectorTextAlign[] = ['left', 'center', 'right', 'justify'];

/** Paragraph settings of a text node (all its paragraphs). Lengths in document units. */
export interface VectorParagraphStyle {
	/** Default `left`. `justify` stretches every line of area text but a paragraph's last; on a path it spreads the text over the path. */
	align?: VectorTextAlign;
	/** Auto leading as a multiple of the font size (default 1.2). */
	autoLeading?: number;
	firstLineIndent?: number;
	startIndent?: number;
	endIndent?: number;
	spaceBefore?: number;
	spaceAfter?: number;
}

/** Where text on a path sits across the path: its baseline, ascender, descender or centre on the line. */
export type VectorPathTextBaseline = 'baseline' | 'ascender' | 'descender' | 'center';
export const VECTOR_PATH_TEXT_BASELINES: readonly VectorPathTextBaseline[] = ['baseline', 'ascender', 'descender', 'center'];

/**
 * Where a text node's text goes, in the node's own space:
 * - `point`: one line per paragraph, the first baseline starting at (`x`, `y`);
 * - `area`: lines wrapped inside the box at (`x`, `y`) of `width` × `height` (lines that do not fit
 *   are hidden: the text overflows);
 * - `path`: one line set along `path` (paragraph breaks become spaces), from `start` to `end`
 *   (distances from the path's ends), turned with the path (`orientation: 'rotate'`) or upright.
 *   `flip` runs the text the other way, on the other side.
 */
export type VectorTextFrame =
	| { kind: 'point'; x: number; y: number }
	| { kind: 'area'; x: number; y: number; width: number; height: number }
	| {
			kind: 'path';
			path: VectorSubpath;
			/** Margin from the path's start (default 0). */
			start?: number;
			/** Margin from the path's end (default 0). */
			end?: number;
			flip?: boolean;
			/** Default `rotate`. */
			orientation?: 'rotate' | 'upright';
			/** Default `baseline`. */
			baseline?: VectorPathTextBaseline;
	  };

/**
 * Text: a string with a character style, optional styled runs and a paragraph style, set in a
 * frame. It paints with the node's fills and strokes like a path. Layout and glyphs come from the
 * editor's text shaper (`setVectorTextShaper`); with an outline shaper the text draws as glyph
 * outlines (so path effects, envelopes, booleans and Create Outlines work), otherwise as SVG text.
 */
export interface VectorTextNode extends VectorNodeBase, VectorStyle {
	type: 'text';
	text: string;
	/** The base character style. */
	font: VectorCharacterStyle;
	/** Runs over the text, each overriding some fields of `font` (absent: one style throughout). */
	runs?: VectorTextRun[] | null;
	paragraph?: VectorParagraphStyle | null;
	frame: VectorTextFrame;
}

/**
 * Per-instance changes to a symbol's art: every fill and / or stroke of the art painted with one
 * paint (a tint), and art nodes (by their id in the symbol) hidden.
 */
export interface VectorInstanceOverrides {
	fill?: VectorPaint;
	stroke?: VectorPaint;
	/** Ids of nodes of the symbol's art (top-level or nested) not drawn in this instance. */
	hidden?: string[];
}

/**
 * A placed copy of a symbol (`VectorDocument.symbols`): it draws the symbol's art through its
 * `transform`, which, unlike other nodes', may scale and skew. Editing the symbol changes every
 * instance.
 */
export interface VectorInstanceNode extends VectorNodeBase {
	type: 'instance';
	symbolId: string;
	/** Strokes (and other lengths of the art's paint) scale with the instance (default true, as in Illustrator). */
	scaleStrokes?: boolean;
	overrides?: VectorInstanceOverrides | null;
	/**
	 * The symbol's art, resolved by the editor (the same array as the symbol's `nodes`). Not part of
	 * the stored document: `VectorEditorController.toJSON` and SVG export leave it out, and loading
	 * resolves it again (`resolveVectorSymbols`).
	 */
	art?: VectorNode[];
}

export type VectorNode = VectorPathNode | VectorGroupNode | VectorTextNode | VectorInstanceNode;

/** A symbol: reusable art its instances draw. */
export interface VectorSymbol {
	id: string;
	name: string;
	/** The art, bottom to top, in the symbol's own space (its origin is the registration point instances are placed by). */
	nodes: VectorNode[];
}

/** A vector drawing: an artboard and its nodes, bottom to top. */
export interface VectorDocument {
	width: number;
	height: number;
	/** Artboard colour (default: transparent). */
	background?: string;
	nodes: VectorNode[];
	/** Symbols the document's instances draw (see `VectorInstanceNode`). */
	symbols?: VectorSymbol[];
	/** Constraints between anchors, segments and circles, solved after every edit. */
	constraints?: VectorConstraint[];
	/** Named values the constraints' expressions use. */
	parameters?: VectorParameter[];
}

/**
 * Constraint kinds (CAD-style parametric drawing). Geometric: `coincident` (two points, a point on
 * a segment's line, or a point on a circle), `collinear` (two segments on one line), `concentric`
 * (two circles, or a circle's centre on a point), `fix`, `parallel`, `perpendicular`, `horizontal`
 * / `vertical` (a segment, or two points level), `tangent` (a segment and a circle, two circles, or
 * G1 at an anchor: its handles in line), `smooth` (G2 at an anchor: G1 and equal curvature),
 * `symmetric` (two points about a segment's line) and `equal` (segment lengths or radii).
 * Dimensional (with a `value`): `distance`, `angle` (degrees), `radius` and `diameter`.
 */
export type VectorConstraintKind =
	| 'coincident'
	| 'collinear'
	| 'concentric'
	| 'fix'
	| 'parallel'
	| 'perpendicular'
	| 'horizontal'
	| 'vertical'
	| 'tangent'
	| 'smooth'
	| 'symmetric'
	| 'equal'
	| 'distance'
	| 'angle'
	| 'radius'
	| 'diameter';
export const VECTOR_CONSTRAINT_KINDS: readonly VectorConstraintKind[] = [
	'coincident',
	'collinear',
	'concentric',
	'fix',
	'parallel',
	'perpendicular',
	'horizontal',
	'vertical',
	'tangent',
	'smooth',
	'symmetric',
	'equal',
	'distance',
	'angle',
	'radius',
	'diameter'
];

/**
 * What a constraint refers to: an anchor of a path (by its stable `id`), one of the anchor's
 * handles, the segment from the anchor to the next one, or (no `anchor`) a whole path as a circle
 * (its centre and radius, for closed round paths).
 */
export interface VectorGeomRef {
	nodeId: string;
	/** The anchor's `id` (see `VectorAnchor.id`). */
	anchor?: string;
	/** With `anchor`: the handle instead of the anchor point. */
	handle?: 'in' | 'out';
	/** With `anchor`: the segment from it to the next anchor. */
	segment?: boolean;
	/** Without `anchor`: the path as a circle. */
	circle?: boolean;
}

/** A constraint kept by the document and solved after every edit. */
export interface VectorConstraint {
	id: string;
	kind: VectorConstraintKind;
	refs: VectorGeomRef[];
	/** Dimensional constraints: the value as an expression (document units, degrees for angles), e.g. `"40"` or `"w / 2"`. */
	value?: string;
	/** Dimensional constraints: a name other expressions can use (`d1`, `ang2`). */
	name?: string;
	/** `distance`: measured along the line between (default), or only horizontally or vertically. */
	axis?: 'aligned' | 'horizontal' | 'vertical';
}

/** A named value constraints' expressions can use. */
export interface VectorParameter {
	name: string;
	/** An expression (numbers, other names, `+ - * /`, parentheses, `pi`). */
	value: string;
	description?: string;
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
 * starts the blend there). `envelope` edits the mesh of the selection's envelope: drag its
 * anchors and handles, or inside a patch to pull the surface. `type` adds point text (click) or
 * area text (drag) and edits text it clicks; `typePath` sets text along the path it clicks. `frame`
 * drags out a frame (`VectorGroupNode.frame`), taking in the top-level objects it fully encloses.
 * `connector` drags a connector between objects, gluing each end to the side it starts or ends on.
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
	| 'gradient'
	| 'envelope'
	| 'type'
	| 'typePath'
	| 'frame'
	| 'connector';

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
	'gradient',
	'envelope',
	'type',
	'typePath',
	'frame',
	'connector'
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
 * (Merge Paths), `repeater` and `envelope` (an envelope distortion: a warp preset or a mesh).
 */
export type VectorEffectType = 'trim' | 'roundCorners' | 'puckerBloat' | 'twist' | 'zigzag' | 'wiggle' | 'offset' | 'merge' | 'repeater' | 'envelope';
export const VECTOR_EFFECT_TYPES: readonly VectorEffectType[] = ['trim', 'roundCorners', 'puckerBloat', 'twist', 'zigzag', 'wiggle', 'offset', 'merge', 'repeater', 'envelope'];

/** Warp presets (Photoshop's fifteen, in menu order); shared with the image editor (`src/geom`). */
export type VectorWarpStyle = WarpStyle;

/**
 * A grid of bicubic Bézier patches mapping a source box onto the plane. `us` / `vs` are the patch
 * boundaries as fractions of the box (increasing, first 0, last 1); `points` is the
 * `(3·(us.length − 1) + 1) × (3·(vs.length − 1) + 1)` control grid, row by row, in the node's own
 * space. Neighbouring patches share their edge row: anchors sit where both indices are multiples
 * of 3, handles where one is. Shared with the image editor (`src/geom`).
 */
export type VectorWarpMesh = WarpMesh;

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
	/**
	 * Envelope distortion: the paths above it are mapped from their combined bounds through a warp
	 * preset (bend and horizontal / vertical distortion in percent) or, with style `mesh`, through
	 * `mesh` (null: the flat mesh of `columns × rows` patches over the bounds). The bounds are
	 * taken afresh each time, so editing the contents keeps the envelope.
	 */
	envelope: {
		style: VectorWarpStyle | 'mesh';
		bend: number;
		horizontal: number;
		vertical: number;
		orientation: 'horizontal' | 'vertical';
		/** Patches of the mesh (a preset turns into a mesh of this size when it is edited). */
		rows: number;
		columns: number;
		mesh: VectorWarpMesh | null;
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

/**
 * Visual filters: `dropShadow` (the node's silhouette, offset and blurred, under it),
 * `innerShadow` (a shadow cast inside the edges), `outerGlow` / `innerGlow` (an unoffset glow
 * outside or inside the edges), `layerBlur` (the whole node blurred) and `feather` (edges faded
 * to transparent).
 */
export type VectorFilterType = 'dropShadow' | 'innerShadow' | 'outerGlow' | 'innerGlow' | 'layerBlur' | 'feather';
export const VECTOR_FILTER_TYPES: readonly VectorFilterType[] = ['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'layerBlur', 'feather'];

/** A shadow or glow: colour, offset, blur and spread in the node's own units. */
interface VectorShadowParams {
	color: string;
	/** 0–1: multiplies the colour's own alpha. */
	opacity: number;
	/** Blur radius (the SVG / CSS standard deviation is half of it). */
	blur: number;
	/** Grows the silhouette before blurring (inner effects: chokes it inwards). */
	spread: number;
}

/** Parameters of each filter type. Lengths are in the node's own units. */
export interface VectorFilterParamsMap {
	dropShadow: VectorShadowParams & { offsetX: number; offsetY: number };
	innerShadow: VectorShadowParams & { offsetX: number; offsetY: number };
	outerGlow: VectorShadowParams;
	innerGlow: VectorShadowParams;
	layerBlur: { radius: number };
	/** Fades the edges over `radius` inwards. */
	feather: { radius: number };
}

/** One entry of a node's filter stack. */
export type VectorFilter = {
	[K in VectorFilterType]: {
		/** Unique within the node. */
		id: string;
		type: K;
		/** Disabled filters are skipped. Default true. */
		enabled?: boolean;
		params: VectorFilterParamsMap[K];
	};
}[VectorFilterType];
