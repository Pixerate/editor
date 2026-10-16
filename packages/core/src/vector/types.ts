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
}

/** A chain of anchors joined by line or cubic Bézier segments. */
export interface VectorSubpath {
	anchors: VectorAnchor[];
	/** Joins the last anchor back to the first. */
	closed: boolean;
}

/** A fill or stroke: any CSS colour, a gradient, or `null` / `'none'` for no paint. */
export type VectorPaint = string | CanvasGradientDef | null;

export type VectorFillRule = 'nonzero' | 'evenodd';
export type VectorLineCap = 'butt' | 'round' | 'square';
export type VectorLineJoin = 'miter' | 'round' | 'bevel';

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
}

/** A shape made of one or more subpaths (holes and compound shapes included). */
export interface VectorPathNode extends VectorNodeBase, VectorStyle {
	type: 'path';
	subpaths: VectorSubpath[];
}

/** A group of nodes that select and transform together. */
export interface VectorGroupNode extends VectorNodeBase {
	type: 'group';
	children: VectorNode[];
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
 * shape; `scissors` cuts a path at a point, `knife` cuts filled shapes along a freehand stroke
 * and `eraser` rubs out the area under one.
 */
export type VectorTool = 'select' | 'direct' | 'pen' | 'pencil' | 'rect' | 'ellipse' | 'polygon' | 'star' | 'line' | 'scissors' | 'knife' | 'eraser';

export const VECTOR_TOOLS: readonly VectorTool[] = ['select', 'direct', 'pen', 'pencil', 'rect', 'ellipse', 'polygon', 'star', 'line', 'scissors', 'knife', 'eraser'];

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
	/** Corner radius of the rectangle tool (default 0). */
	cornerRadius?: number;
}

export type VectorAlign = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type VectorDistribute = 'horizontal' | 'vertical';
export type VectorBooleanOperation = 'union' | 'subtract' | 'intersect' | 'exclude';
export type VectorArrange = 'front' | 'forward' | 'backward' | 'back';
/** Average: line anchors up on a horizontal line (same y), a vertical one (same x), or both. */
export type VectorAverageAxis = 'horizontal' | 'vertical' | 'both';

/** Identifies one segment of a path node: from anchor `segment` to the next. */
export interface VectorSegmentRef {
	nodeId: string;
	subpath: number;
	segment: number;
}
