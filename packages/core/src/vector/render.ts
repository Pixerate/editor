/**
 * Framework-neutral render data for a vector editor: the scene (document-space SVG paths and
 * gradient defs) and the overlay (screen-space selection box, anchors, handles, marquee and
 * pen preview). React, Svelte or plain DOM code turns these into `<svg>` elements.
 */
import { bezierPathToSvg, transformBezierPath, type BezierPath } from '../canvas/pathops/bezier.js';
import { hatchPath } from '../canvas/pathops/hatch.js';
import type { SvgGradientDef } from '../canvas/gradient.js';
import { expandVectorGradientStops, isCentredVectorGradient, isVectorGradient, parseVectorColor, sortedVectorGradientStops, type VectorGradientHandle, type VectorPaintDef } from './gradient.js';
import { getVectorGradientAnnotator, VECTOR_GRADIENT_STOP_GAP } from './gradientTool.js';

export type { SvgGradientDef };
import {
	getAnchorWorld,
	getVectorCornerWidgets,
	getVectorEnvelopeTarget,
	getVectorSelectionBoxGeometry,
	getVectorWidthHandles,
	getVisibleAnchors,
	getVisibleHandles,
	type VectorEditorController,
	type VectorEditorState,
	type VectorSelectionBoxGeometry,
	type VectorWidthPointRef
} from './controller.js';
import { sanitizeWidthProfile, widthProfilePresetId, type VectorWidthPreset } from './width.js';
import {
	findVectorNode,
	walkVectorNodes,
	locateVectorNode,
	subpathsToBezier,
	vectorWorldMatrix,
	collectPathNodes,
	IDENTITY_MATRIX,
	inferAnchorType,
	multiplyMatrices,
	nodeMatrix,
	vectorNodeBounds,
	vectorParentMatrix,
	vectorPathData,
	vectorPathWorldBezier,
	type AffineMatrix
} from './geometry.js';
import { vectorNodeFilterSvg, vectorPaintToSvg, vectorStrokeSvgParts, type VectorRenderStrokeParts } from './svg.js';
import { needsVectorPaintLayers, vectorBlendModeCss, vectorFills, vectorPaintLayerNodes, vectorStrokes, vectorTargetPaint, VECTOR_BLEND_MODE_LABELS } from './paintLayers.js';
import { VECTOR_FILTER_LABELS, VECTOR_FILTER_PARAM_SPECS, type VectorFilterParamSpec, type VectorRenderFilter } from './filters.js';
import { vectorCorners } from './corners.js';
import {
	expandVectorAppearance,
	hasOwnVectorAppearance,
	hasVectorAppearance,
	vectorAppearanceOutline,
	vectorInstanceDrawn,
	vectorEnteredGroups,
	VECTOR_EFFECT_LABELS,
	VECTOR_EFFECT_PARAM_SPECS,
	type VectorEffectParamSpec,
	type VectorEnvelopeParams
} from './appearance.js';
import { layoutVectorText, vectorTextPaintSource, vectorTextBoxOutline, vectorTextCaret, vectorTextGeometryNode, vectorTextHasOutlines, vectorTextSelectionQuads, vectorTextSpans, vectorTextSpanSvg, type VectorRenderTextSpan } from './text.js';
import { applyMatrix } from '../geom/affine.js';
import { vectorConstraintGlyphs } from './constraints/glyphs.js';
import { isVectorMaskActive, isVectorMaskGroup, vectorMaskRenderData, vectorMaskSummary, type VectorMaskRenderData, type VectorMaskSummary } from './mask.js';
import { isVectorFrame, vectorFrameRectPath } from './frames.js';
import { isVectorSymmetryGroup, vectorSymmetryAxes } from './symmetry.js';
import { invertMatrix } from '../geom/affine.js';
import { vectorNodePaintBox, vectorNodesNear } from './spatial.js';
import { vectorTextShaperGeneration } from './text.js';
import { vectorConnectionSites, vectorConnectorTargetAt } from './connectors.js';
import { isVectorMeshGradient, isVectorShadedPaint, vectorFreeformLineSegments, vectorMeshLines } from './shading.js';
import type { VectorFreeformGradient, VectorMeshGradient } from './types.js';
import { vectorMeshEditPoints, vectorMeshGridCurves, VECTOR_WARP_STYLES, VECTOR_WARP_STYLE_LABELS } from './warp.js';
import { VECTOR_EFFECT_TYPES, type VectorEffectType } from './types.js';
import { isVectorBlendGroup, resolveVectorBlendOptions, vectorBlendRailAt, vectorBlendSpine } from './blendGroup.js';
import type { VectorGuideKind, VectorSnapKind } from './snap.js';
import { VECTOR_BLEND_MODES } from './types.js';
import type {
	VectorMaskType,
	VectorAnchorRef,
	VectorBlendMode,
	VectorFilterType,
	VectorStrokeLayer,
	VectorAnchorType,
	VectorArrowAlign,
	VectorArrowhead,
	VectorBlendOptions,
	VectorBlendSpacing,
	VectorBounds,
	VectorCornerKind,
	VectorGradient,
	VectorGradientInterpolation,
	VectorGradientSpread,
	VectorGradientStop,
	VectorGradientType,
	VectorStrokeGradientMode,
	VectorGroupNode,
	VectorHandleRef,
	VectorNode,
	VectorPaint,
	VectorPathfinderOperation,
	VectorPathNode,
	VectorTextNode,
	VectorStrokeAlign,
	VectorTransformHandle,
	VectorWidthPoint,
	Vec2
} from './types.js';

export interface VectorRenderPath {
	kind: 'path';
	id: string;
	/** SVG `transform` (`matrix(…)`) for a rotated node. */
	transform?: string;
	d: string;
	/** `none`, a colour, or `url(#id)` of a gradient in `defs`. */
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeLinecap?: string;
	strokeLinejoin?: string;
	strokeDasharray?: string;
	fillRule: 'nonzero' | 'evenodd';
	opacity: number;
	/**
	 * Set when the stroke takes more than one element: an inside / outside alignment or
	 * arrowheads. Draw `d` with the fill only, then `stroke.d` with the stroke (at
	 * `stroke.width`, clipped or masked as `stroke.clip` says), then each head filled with
	 * `stroke`; group them under `id`, `transform` and `opacity`.
	 */
	strokeParts?: VectorRenderStrokeParts;
	/**
	 * Set when the path paints through its fill and stroke stacks (several layers, or a layer with
	 * its own opacity, blend mode or visibility): draw a `<g>` with `id`, `transform`, `opacity`,
	 * `blendMode` and `filter`, holding each layer in order, bottom to top, as a path of `d` (see
	 * `VectorRenderPaintLayer`). `fill`, `stroke` and `strokeParts` above then describe the top
	 * drawn layers only, for readers that draw one paint.
	 */
	layers?: VectorRenderPaintLayer[];
	/** CSS `mix-blend-mode` of the whole node (absent: normal). */
	blendMode?: string;
	/** `url(#id)` of the node's filter in `filters` (shadows, glows, blurs, feather). */
	filter?: string;
}

/**
 * One drawn layer of a path's paint stack: a fill (`fill` set, `stroke` none) or a stroke with its
 * own settings and parts (`strokeParts` as on `VectorRenderPath`). Draw it with `opacity` and
 * `mix-blend-mode: blendMode` on its element (or on the group of its parts).
 */
export interface VectorRenderPaintLayer {
	kind: 'fill' | 'stroke';
	/** Index in its stack (bottom to top). */
	index: number;
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeLinecap?: string;
	strokeLinejoin?: string;
	strokeDasharray?: string;
	opacity: number;
	blendMode?: string;
	strokeParts?: VectorRenderStrokeParts;
}

export interface VectorRenderGroup {
	kind: 'group';
	id: string;
	/** SVG `transform` (`matrix(…)`) for a rotated group. */
	transform?: string;
	opacity: number;
	/** CSS `mix-blend-mode` of the group (absent: normal). */
	blendMode?: string;
	/** `url(#id)` of the group's filter in `filters`. */
	filter?: string;
	/**
	 * Set on a mask group whose mask is on: `children` are then the masked contents only. Draw them
	 * in an inner `<g>` with `clip-path` / `mask` referencing the `<clipPath>` / `<mask>` that
	 * `mask` describes (`mask.nodes`: the mask drawn into a `<mask>`). The group's own transform,
	 * opacity, blend mode and filter stay on the outer `<g>`, so they apply to the masked result.
	 */
	mask?: VectorRenderMask;
	children: VectorRenderNode[];
}

/** A mask group's mask as render data (see `VectorMaskRenderData`), with the mask drawn as nodes for opacity masks. */
export interface VectorRenderMask extends Omit<VectorMaskRenderData, 'invertFilter'> {
	/** The mask as drawn, for the `<mask>` of an opacity mask (in the group's own space). */
	nodes?: VectorRenderNode[];
}

/**
 * Text drawn as SVG text (when the text shaper gives no glyph outlines; with outlines, text renders
 * as a `VectorRenderPath` or group). Draw a `<g>` with `id`, `transform`, `opacity`, `blendMode` and
 * `filter`, holding one `<text>` per layer, bottom to top, each holding every span as a `<tspan>`.
 */
export interface VectorRenderText {
	kind: 'text';
	id: string;
	transform?: string;
	opacity: number;
	blendMode?: string;
	filter?: string;
	/**
	 * Paint layers, bottom to top: a fill (`fill` set, `stroke` none) or a stroke. Draw each as a
	 * `<text>` with these attributes (and `mix-blend-mode`). `runFills`: spans with their own `fill`
	 * use it on this layer (the top fill).
	 */
	layers: Array<{ kind: 'fill' | 'stroke'; fill: string; stroke: string; strokeWidth: number; strokeLinejoin?: string; strokeDasharray?: string; opacity: number; blendMode?: string; runFills?: boolean }>;
	spans: VectorRenderTextSpan[];
}

export type { VectorRenderTextSpan };

export type VectorRenderNode = VectorRenderPath | VectorRenderGroup | VectorRenderText;

export interface VectorSceneRenderData {
	/** SVG `transform` for the document layer: `translate(x y) scale(zoom)`. */
	transform: string;
	width: number;
	height: number;
	background?: string;
	/**
	 * Paint servers referenced by `fill` / `stroke` values: `<linearGradient>` /
	 * `<radialGradient>` descriptors and `pattern`s (conic, diamond and stroke-mode gradients:
	 * draw each of `gradients`, then each tile filled, inside a `<pattern>`).
	 */
	defs: VectorPaintDef[];
	/** Filters referenced by nodes' `filter` (draw each as an SVG `<filter>`, see `VectorRenderFilter`). */
	filters: VectorRenderFilter[];
	/** Visible nodes, bottom to top. */
	nodes: VectorRenderNode[];
	/** Top-level nodes in the document, left out as off screen (with `viewportSize`), and drawn collapsed (`lod`). */
	stats: { nodes: number; culled: number; collapsed: number };
}

export interface VectorRenderAnchor {
	ref: VectorAnchorRef;
	/** Screen position. */
	x: number;
	y: number;
	type: VectorAnchorType;
	selected: boolean;
	hovered: boolean;
	/** The pen tool closes the path when this anchor is clicked. */
	closes: boolean;
}

export interface VectorRenderHandle {
	ref: VectorHandleRef;
	x: number;
	y: number;
	/** Screen position of the handle's anchor (draw a line to it). */
	anchorX: number;
	anchorY: number;
	hovered: boolean;
}

/** A live corner widget in screen pixels. */
export interface VectorRenderCornerWidget {
	ref: VectorAnchorRef;
	x: number;
	y: number;
	radius: number;
	kind: VectorCornerKind;
	hovered: boolean;
	/** Its corners are being dragged. */
	active: boolean;
}

/**
 * A width point of the width tool in screen pixels: a diamond at (`x`, `y`) on the path and a
 * line across the stroke from `left` to `right`, with a handle at each end.
 */
export interface VectorRenderWidthPoint {
	ref: VectorWidthPointRef;
	x: number;
	y: number;
	left: Vec2;
	right: Vec2;
	selected: boolean;
	/** The part under the pointer, if any. */
	hovered: 'center' | 'left' | 'right' | null;
	/** Being dragged. */
	active: boolean;
}

/** A smart guide line in screen pixels. */
export interface VectorRenderGuideLine {
	kind: VectorGuideKind;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

/** A smart guide label ("anchor", "intersect", "align", "centre", a gap or a size) at a screen position. */
export interface VectorRenderGuideLabel {
	kind: VectorSnapKind;
	x: number;
	y: number;
	text: string;
}

export interface VectorOverlayRenderData {
	/** Outlines (screen-space path data) of hovered and selected nodes. */
	outlines: { id: string; d: string; selected: boolean }[];
	/**
	 * Selection box with resize and rotate handles (select tool). `x / y / width / height` and
	 * each handle's `x / y` are the unrotated box in screen pixels: draw them inside
	 * `<g transform={transform}>`. `corners` and each handle's `screen` are true positions.
	 */
	selectionBox:
		| (VectorBounds & { angle: number; transform: string; corners: Vec2[]; handles: VectorSelectionBoxGeometry['handles']; freeDistort: boolean })
		| null;
	/**
	 * A Free Distort drag (screen space): the quad the selection box's corners make so far (`d`,
	 * closed path data) and its corners clockwise from the top left. The box is hidden meanwhile.
	 */
	distort: { mode: 'distort' | 'perspective' | 'skew'; d: string; corners: Vec2[] } | null;
	/**
	 * The Envelope tool's mesh of the selected envelope (screen space): `grid` is the grid lines as
	 * path data, `anchors` the points where they cross and `handles` the handles along them, each
	 * with the anchor it belongs to (`index` is the point's index in the mesh). Draw anchors as
	 * squares and handles as dots joined to their anchors.
	 */
	envelope: {
		nodeId: string;
		grid: string;
		anchors: { index: number; x: number; y: number; hovered: boolean; active: boolean }[];
		handles: { index: number; x: number; y: number; anchorX: number; anchorY: number; hovered: boolean; active: boolean }[];
	} | null;
	anchors: VectorRenderAnchor[];
	handles: VectorRenderHandle[];
	/** Marquee rectangle, screen space. */
	marquee: VectorBounds | null;
	/** Rubber-band segment from the pen path's last anchor to the pointer, screen space. */
	penPreview: string | null;
	/** Artboard rectangle, screen space. */
	artboard: VectorBounds;
	/** Smart guides of the snap in progress, screen space (empty when nothing snapped). */
	guides: { lines: VectorRenderGuideLine[]; labels: VectorRenderGuideLabel[] };
	/**
	 * The knife or eraser stroke being drawn, screen space: `d` is an open polyline; draw the
	 * eraser's with a round-capped stroke `width` pixels wide (0 for the knife: a thin line).
	 */
	toolStroke: { tool: 'knife' | 'eraser'; d: string; width: number } | null;
	/** The pencil's lazy-mouse string from the pen to the pointer, screen space. */
	pencilString: { x1: number; y1: number; x2: number; y2: number } | null;
	/** Where the scissors would cut (screen space). */
	cutPoint: Vec2 | null;
	/**
	 * Live corner widgets of the direct tool (screen space): drag one to round its corners,
	 * Alt-click to cycle round / inverted / chamfer, click to pick its corner alone.
	 */
	cornerWidgets: VectorRenderCornerWidget[];
	/** Width points of the width tool (screen space). */
	widthPoints: VectorRenderWidthPoint[];
	/**
	 * Where a width-tool drag would add a width point (screen space): draw a dashed line from
	 * `left` to `right` and a hollow diamond at (`x`, `y`).
	 */
	widthSpot: { x: number; y: number; left: Vec2; right: Vec2 } | null;
	/**
	 * Shape Builder and paint bucket highlight (screen space): `faces` are filled paths (fill
	 * them translucent and outline them), `hatches` the 45° hatch lines over each face
	 * (`hatchPath`, a few pixels apart; merge and erase only, empty strings for the paint
	 * bucket: stroke them over the translucent fill), `lines` are the line pieces and outline
	 * edges an erase deletes, `trail` is the drag's polyline. `mode` is `merge`, `erase` (Alt)
	 * or `fill` (paint bucket).
	 */
	builder: { mode: 'merge' | 'erase' | 'fill'; faces: string[]; hatches: string[]; lines: string[]; trail: string | null } | null;
	/**
	 * Blends (screen space): the spine of each selected blend (`d`, draw it dashed; `keys` are
	 * where its keys sit on it; `replaced` when it is a replaced spine) and, with the Blend tool,
	 * the outline of the shape it blends from (`start`, with the clicked anchor) and the anchors
	 * of the first subpath under the pointer (click one to start the blend there).
	 */
	blend: {
		spines: { id: string; d: string; keys: Vec2[]; replaced: boolean }[];
		start: { d: string; anchor: Vec2 | null } | null;
		anchors: { x: number; y: number; hovered: boolean }[];
	};
	/** The gradient tool's annotator over the selection's gradient (screen space), or null. */
	gradient: VectorRenderGradientAnnotator | null;
	/**
	 * Mask indicators (screen space): the outline of the mask of each mask group that is selected
	 * or holds the selection (`d`, draw it dashed), with its type, whether it is inverted, and
	 * whether the mask itself is selected (`editing`).
	 */
	masks: { id: string; maskId: string; d: string; type: VectorMaskType; invert: boolean; enabled: boolean; editing: boolean }[];
	/**
	 * Text editing (screen space): the edited text's frame outline (`frame`, draw it thin and
	 * dashed), the caret (a line, when the selection is collapsed), the selection's quads (`selection`,
	 * filled translucent) and the overflow marker (a small boxed plus at `overflow` when text does
	 * not fit). Also set, without caret, for the selected text while a Type tool is active.
	 */
	text: { nodeId: string; frame: string; caret: { x1: number; y1: number; x2: number; y2: number } | null; selection: string[]; overflow: Vec2 | null; editing: boolean } | null;
	/** The Type tool's area text box being dragged out (screen space). */
	textBox: VectorBounds | null;
	/**
	 * Constraint glyphs of the selected or edited paths (screen space): a label at (`x`, `y`) (a
	 * glyph, or `name = value`), a dimension line for distances, `satisfied` false when the solve
	 * could not meet it (draw it in a warning colour).
	 */
	/**
	 * Name labels of the top-level frames (artboards), screen space: draw `name` just above (x, y),
	 * the frame's top-left corner (bold when `selected`). Clicking a label should select the frame.
	 */
	frames: { id: string; name: string; x: number; y: number; selected: boolean }[];
	/**
	 * Connection sites, screen space, while the Connector tool is on: those of the object under the
	 * pointer (top, right, bottom, left, centre), `active` on the one an end would glue to.
	 */
	connectorSites: { nodeId: string; side: string; x: number; y: number; active: boolean }[];
	/**
	 * Mesh and freeform fills of the selection while the Gradient tool is on, screen space: the
	 * lattice or freeform lines (`lines`, path data) and the points (drag them; `selected` is the one
	 * the panel edits), each with its colour.
	 */
	shading: { nodeId: string; kind: 'mesh' | 'freeform'; lines: string[]; points: { index: number; x: number; y: number; color: string; selected: boolean }[] }[];
	/**
	 * Axes of the symmetry groups that are selected or being drawn into, screen space: each line as
	 * `x1, y1, x2, y2`; `drawing` when new art goes into that group (draw it more strongly).
	 */
	symmetry: { nodeId: string; drawing: boolean; lines: { x1: number; y1: number; x2: number; y2: number }[] }[];
	/** Points acquired for object snap tracking, screen space: draw a small `+` at each. */
	trackingPoints: { x: number; y: number }[];
	/** The distance or coordinate being typed while the pen draws, and where to show it (screen space, by the pointer), or null. */
	typedEntry: { text: string; x: number; y: number } | null;
	constraints: { id: string; kind: string; label: string; x: number; y: number; dimension: { x1: number; y1: number; x2: number; y2: number } | null; satisfied: boolean }[];
	/** A short status, e.g. "W 120 × H 80" or "45°". */
	status: string | null;
}

/**
 * The gradient annotator in screen pixels: draw the `extent` outline (dashed), the bar from
 * `start` to `end`, the handles, each stop's chip (a swatch at `x, y` with a tick to `barX, barY`;
 * `removing`: the dragged stop is off the bar and will be deleted, draw it faded) and the
 * midpoint diamonds.
 */
export interface VectorRenderGradientAnnotator {
	nodeId: string;
	type: VectorGradientType;
	start: { x: number; y: number; hovered: boolean };
	/** `radius` for radial, conic and diamond gradients. */
	end: { x: number; y: number; hovered: boolean; handle: 'end' | 'radius' };
	aspect: { x: number; y: number; hovered: boolean } | null;
	focal: { x: number; y: number; hovered: boolean } | null;
	stops: { index: number; x: number; y: number; barX: number; barY: number; color: string; opacity: number; selected: boolean; hovered: boolean }[];
	midpoints: { index: number; x: number; y: number; hovered: boolean }[];
	extent: string | null;
	removing: boolean;
}

const fmt = (n: number) => Math.round(n * 100) / 100;
const fmtMatrix = (m: AffineMatrix) => `matrix(${m.map((n) => Math.round(n * 1e6) / 1e6).join(' ')})`;
/** Distance between the Shape Builder's hatch lines over a face (screen pixels). */
export const VECTOR_BUILDER_HATCH_GAP = 6;

/** The blend mode and filter of a node, as render data (its filter pushed to `filters`). */
function nodeFinish(node: VectorNode, filters: VectorRenderFilter[], idPrefix: string): { blendMode?: string; filter?: string } {
	const out: { blendMode?: string; filter?: string } = {};
	const blend = vectorBlendModeCss(node.blendMode);
	if (blend) out.blendMode = blend;
	const filter = vectorNodeFilterSvg(node, `${idPrefix}filter-${node.id}`);
	if (filter) {
		filters.push(filter);
		out.filter = `url(#${filter.id})`;
	}
	return out;
}

/** The SVG line attributes of a (layer) node's stroke. */
function lineStyle(node: VectorPathNode) {
	return {
		strokeWidth: node.strokeWidth ?? 1,
		...(node.strokeLinecap ? { strokeLinecap: node.strokeLinecap } : {}),
		...(node.strokeLinejoin ? { strokeLinejoin: node.strokeLinejoin } : {}),
		...(node.strokeDasharray?.length ? { strokeDasharray: node.strokeDasharray.join(' ') } : {})
	};
}

/** The drawn layers of a path's stacks as render data (paint servers pushed to `defs`). */
function renderLayers(node: VectorPathNode, defs: VectorPaintDef[], idPrefix: string): VectorRenderPaintLayer[] {
	const out: VectorRenderPaintLayer[] = [];
	for (const l of vectorPaintLayerNodes(node)) {
		if (!l.drawn) continue;
		const role = l.kind;
		const paint = vectorPaintToSvg(l.layer.paint, `${idPrefix}${role}-${node.id}-${l.index}`, { node: l.node, ...(role === 'stroke' ? { role } : {}) });
		defs.push(...paint.defs);
		const blend = vectorBlendModeCss(l.layer.blendMode);
		const base = { kind: role, index: l.index, opacity: l.layer.opacity ?? 1, ...(blend ? { blendMode: blend } : {}) };
		if (role === 'fill') out.push({ ...base, fill: paint.value, stroke: 'none', strokeWidth: 0 });
		else {
			const strokeParts = vectorStrokeSvgParts(l.node, `${idPrefix}clip-${node.id}-${l.index}`);
			out.push({ ...base, fill: 'none', stroke: paint.value, ...lineStyle(l.node), ...(strokeParts ? { strokeParts } : {}) });
		}
	}
	return out;
}

/** A text node drawn as SVG text (no glyph outlines here). */
function renderText(node: VectorTextNode, defs: VectorPaintDef[], filters: VectorRenderFilter[], idPrefix: string): VectorRenderText {
	const geometry = vectorTextGeometryNode(node);
	const layers: VectorRenderText['layers'] = [];
	const nodes = vectorPaintLayerNodes(geometry);
	const topFill = nodes.filter((l) => l.kind === 'fill' && l.drawn).at(-1);
	for (const l of nodes) {
		if (!l.drawn) continue;
		const paint = vectorPaintToSvg(l.layer.paint, `${idPrefix}${l.kind}-${node.id}-${l.index}`, { node: l.node, ...(l.kind === 'stroke' ? { role: 'stroke' as const } : {}) });
		defs.push(...paint.defs);
		const blend = vectorBlendModeCss(l.layer.blendMode);
		const base = { kind: l.kind, opacity: l.layer.opacity ?? 1, ...(blend ? { blendMode: blend } : {}) };
		if (l.kind === 'fill') layers.push({ ...base, fill: paint.value, stroke: 'none', strokeWidth: 0, ...(l === topFill ? { runFills: true } : {}) });
		else
			layers.push({
				...base,
				fill: 'none',
				stroke: paint.value,
				strokeWidth: l.node.strokeWidth ?? 1,
				...(l.node.strokeLinejoin ? { strokeLinejoin: l.node.strokeLinejoin } : {}),
				...(l.node.strokeDasharray?.length ? { strokeDasharray: l.node.strokeDasharray.join(' ') } : {})
			});
	}
	// Runs with their own fill paint the top fill (or are the only fill when the node has none).
	const spans = vectorTextSpans(node).map((sp, i): VectorRenderTextSpan => {
		let fill: string | undefined;
		if (sp.fill !== undefined) {
			const paint = vectorPaintToSvg(sp.fill, `${idPrefix}run-${node.id}-${i}`, { node: geometry });
			defs.push(...paint.defs);
			fill = paint.value;
		}
		return vectorTextSpanSvg(sp, fill);
	});
	if (!topFill && spans.some((s) => s.fill)) layers.unshift({ kind: 'fill', fill: 'none', stroke: 'none', strokeWidth: 0, opacity: 1, runFills: true });
	return {
		kind: 'text',
		id: node.id,
		...(node.transform ? { transform: fmtMatrix(node.transform) } : {}),
		opacity: node.opacity ?? 1,
		...nodeFinish(node, filters, idPrefix),
		layers,
		spans
	};
}

/**
 * Render data per stored node object (and id prefix and text shaper generation), with the defs and
 * filters it made: a node an edit did not replace comes back as the same object, so the canvases
 * skip redrawing it (React.memo, Svelte's keyed blocks).
 */
const renderCache = new WeakMap<VectorNode, Map<string, { gen: number; node: VectorRenderNode | null; defs: VectorPaintDef[]; filters: VectorRenderFilter[] }>>();

function renderNode(stored: VectorNode, defs: VectorPaintDef[], filters: VectorRenderFilter[], idPrefix: string): VectorRenderNode | null {
	const gen = vectorTextShaperGeneration();
	let byPrefix = renderCache.get(stored);
	const hit = byPrefix?.get(idPrefix);
	if (hit && hit.gen === gen) {
		defs.push(...hit.defs);
		filters.push(...hit.filters);
		return hit.node;
	}
	const d0 = defs.length;
	const f0 = filters.length;
	const node = renderNodeFresh(stored, defs, filters, idPrefix);
	if (!byPrefix) renderCache.set(stored, (byPrefix = new Map()));
	byPrefix.set(idPrefix, { gen, node, defs: defs.slice(d0), filters: filters.slice(f0) });
	return node;
}

function renderNodeFresh(stored: VectorNode, defs: VectorPaintDef[], filters: VectorRenderFilter[], idPrefix: string): VectorRenderNode | null {
	if (stored.visible === false) return null;
	// Text without glyph outlines draws as SVG text; with them it draws as its outlines below.
	if (stored.type === 'text' && !vectorTextHasOutlines()) return renderText(stored, defs, filters, idPrefix);
	// Path effects and live booleans draw as their expanded shapes.
	const node = expandVectorAppearance(stored);
	if (node.type === 'group') {
		const finish = nodeFinish(node, filters, idPrefix);
		const masked = isVectorMaskGroup(node) ? renderMask(node, defs, filters, idPrefix) : null;
		// A mask group without a working mask draws its contents whole (a hidden mask child stays hidden).
		const list = isVectorMaskGroup(node) ? node.children.slice(1) : node.children;
		const children = list.map((c) => renderNode(c, defs, filters, idPrefix)).filter((c): c is VectorRenderNode => !!c);
		return {
			kind: 'group',
			id: node.id,
			...(node.transform ? { transform: fmtMatrix(node.transform) } : {}),
			opacity: node.opacity ?? 1,
			...finish,
			...(masked ? { mask: masked } : {}),
			children
		};
	}
	const finish = nodeFinish(node, filters, idPrefix);
	const common = {
		kind: 'path' as const,
		id: node.id,
		...(node.transform ? { transform: fmtMatrix(node.transform) } : {}),
		d: vectorPathData(node),
		fillRule: node.fillRule ?? ('nonzero' as const),
		opacity: node.opacity ?? 1,
		...finish
	};
	if (needsVectorPaintLayers(node)) {
		const layers = renderLayers(node, defs, idPrefix);
		const fill = layers.filter((l) => l.kind === 'fill').at(-1);
		const stroke = layers.filter((l) => l.kind === 'stroke').at(-1);
		return {
			...common,
			fill: fill?.fill ?? 'none',
			stroke: stroke?.stroke ?? 'none',
			strokeWidth: stroke?.strokeWidth ?? node.strokeWidth ?? 1,
			...(stroke?.strokeLinecap ? { strokeLinecap: stroke.strokeLinecap } : {}),
			...(stroke?.strokeLinejoin ? { strokeLinejoin: stroke.strokeLinejoin } : {}),
			...(stroke?.strokeDasharray ? { strokeDasharray: stroke.strokeDasharray } : {}),
			...(stroke?.strokeParts ? { strokeParts: stroke.strokeParts } : {}),
			layers
		};
	}
	const fill = vectorPaintToSvg(node.fill, `${idPrefix}fill-${node.id}`, { node });
	const stroke = vectorPaintToSvg(node.stroke, `${idPrefix}stroke-${node.id}`, { node, role: 'stroke' });
	defs.push(...fill.defs, ...stroke.defs);
	const strokeParts = stroke.value !== 'none' ? vectorStrokeSvgParts(node, `${idPrefix}clip-${node.id}`) : undefined;
	return {
		...common,
		...(strokeParts ? { strokeParts } : {}),
		fill: fill.value,
		stroke: stroke.value,
		...lineStyle(node)
	};
}

/** A mask group's mask as render data (its inverting filter pushed to `filters`), or null while it is off. */
function renderMask(group: VectorGroupNode, defs: VectorPaintDef[], filters: VectorRenderFilter[], idPrefix: string): VectorRenderMask | null {
	if (!isVectorMaskActive(group)) return null;
	const data = vectorMaskRenderData(group, `${idPrefix}mask-${group.id}`, `${idPrefix}mask-filter-${group.id}`);
	if (!data) return null;
	const { invertFilter, ...mask } = data;
	if (invertFilter) filters.push(invertFilter);
	if (mask.type === 'clip') return mask;
	// The mask draws as itself (shown even when stored hidden would have turned the mask off: it is on here).
	const source = renderNode(group.children[0], defs, filters, idPrefix);
	return { ...mask, nodes: source ? [source] : [] };
}

/** Options of `getVectorSceneRenderData`. */
export interface VectorSceneRenderOptions {
	/** Prefix of the ids of defs and filters (default `ve-`); give each editor on a page its own. */
	idPrefix?: string;
	/**
	 * The canvas size in screen pixels. With it, top-level nodes outside the view are left out and
	 * small live subtrees are simplified (see `lod`); leave it out for exports, which must be exact.
	 */
	viewportSize?: { width: number; height: number };
	/** With `viewportSize`: groups, text and instances smaller than this many screen pixels draw as one rectangle in their main colour (default 2; 0 turns it off). */
	lod?: number;
}

/** A small subtree as one rectangle over its paint box in its main colour (cached per node), or null when it paints nothing solid. */
const collapsedCache = new WeakMap<VectorNode, Map<string, VectorRenderPath | null>>();
function collapsedNode(node: VectorNode, box: { minX: number; minY: number; maxX: number; maxY: number }, prefix: string): VectorRenderPath | null {
	let byPrefix = collapsedCache.get(node);
	if (byPrefix?.has(prefix)) return byPrefix.get(prefix)!;
	let fill: string | null = null;
	const look = (n: VectorNode) => {
		if (fill || n.visible === false) return;
		if (n.type === 'path' || n.type === 'text') {
			const f = n.fill;
			if (typeof f === 'string' && f !== 'none') fill = f;
			else if (isVectorGradient(f)) fill = f.stops[0]?.color ?? null;
		} else if (n.type === 'group') n.children.forEach(look);
		else if (n.type === 'instance') (n.art ?? []).forEach(look);
	};
	look(node);
	const out: VectorRenderPath | null = fill
		? { kind: 'path', id: node.id, d: `M${fmt(box.minX)} ${fmt(box.minY)}H${fmt(box.maxX)}V${fmt(box.maxY)}H${fmt(box.minX)}Z`, fill, stroke: 'none', strokeWidth: 0, fillRule: 'nonzero', opacity: node.opacity ?? 1 }
		: null;
	if (!byPrefix) collapsedCache.set(node, (byPrefix = new Map()));
	byPrefix.set(prefix, out);
	return out;
}

/**
 * The document layer. Render the nodes inside `<g transform={transform}>` and `defs` in a
 * `<defs>` block. Pass a unique `idPrefix` when several editors share a page, and the canvas size
 * (`viewportSize`) to draw only what the view shows.
 */
export function getVectorSceneRenderData(state: Pick<VectorEditorState, 'document' | 'viewport'>, options: VectorSceneRenderOptions = {}): VectorSceneRenderData {
	const defs: VectorPaintDef[] = [];
	const filters: VectorRenderFilter[] = [];
	const prefix = options.idPrefix ?? 've-';
	const v = state.viewport;
	const all = state.document.nodes;
	const stats = { nodes: all.length, culled: 0, collapsed: 0 };
	let nodes: VectorRenderNode[];
	const size = options.viewportSize;
	if (size && size.width > 0 && size.height > 0 && v.zoom > 0) {
		// Only what the view shows: top-level nodes off screen are left out (found through the
		// spatial index on large documents), and live subtrees smaller than `lod` screen pixels
		// draw as one rectangle in their main colour.
		const z = v.zoom;
		const pad = 2 / z;
		const view = { minX: -v.x / z - pad, minY: -v.y / z - pad, maxX: (size.width - v.x) / z + pad, maxY: (size.height - v.y) / z + pad };
		const lod = options.lod ?? 2;
		const near = vectorNodesNear(all, { x: view.minX, y: view.minY, width: view.maxX - view.minX, height: view.maxY - view.minY });
		stats.culled = all.length - near.length;
		nodes = [];
		for (const i of near) {
			const n = all[i];
			const box = vectorNodePaintBox(n);
			if (box && (box.maxX < view.minX || box.minX > view.maxX || box.maxY < view.minY || box.minY > view.maxY)) {
				stats.culled++;
				continue;
			}
			if (box && lod > 0 && n.type !== 'path' && n.visible !== false && Math.max(box.maxX - box.minX, box.maxY - box.minY) * z < lod) {
				const c = collapsedNode(n, box, prefix);
				if (c) {
					stats.collapsed++;
					nodes.push(c);
					continue;
				}
			}
			const r = renderNode(n, defs, filters, prefix);
			if (r) nodes.push(r);
		}
	} else nodes = all.map((n) => renderNode(n, defs, filters, prefix)).filter((n): n is VectorRenderNode => !!n);
	return {
		stats,
		transform: `translate(${fmt(v.x)} ${fmt(v.y)}) scale(${v.zoom})`,
		width: state.document.width,
		height: state.document.height,
		...(state.document.background ? { background: state.document.background } : {}),
		defs,
		filters,
		nodes
	};
}

const toScreen = (state: Pick<VectorEditorState, 'viewport'>, p: Vec2) => ({ x: p.x * state.viewport.zoom + state.viewport.x, y: p.y * state.viewport.zoom + state.viewport.y });

function screenOutline(state: VectorEditorState, node: VectorNode, entered: ReadonlySet<string>): string {
	const v = state.viewport;
	const view: AffineMatrix = [v.zoom, 0, 0, v.zoom, v.x, v.y];
	const parent = vectorParentMatrix(state.document.nodes, node.id) ?? IDENTITY_MATRIX;
	return outlinePaths(node, parent, entered)
		.map((path) => bezierPathToSvg(transformBezierPath(path, view), { precision: 2 }))
		.join(' ');
}

/**
 * Document-space outlines of a subtree: paths as stored (their anchors are what is edited; the
 * scene shows their effects), live groups as drawn unless they are being edited (then their
 * children, as figcraft outlines a boolean group's operands).
 */
function outlinePaths(node: VectorNode, parent: AffineMatrix, entered: ReadonlySet<string>): BezierPath[] {
	if (node.type === 'path') return [vectorPathWorldBezier(node, parent, { effects: false })];
	const m = multiplyMatrices(nodeMatrix(node), parent);
	// Text outlines by its glyph boxes (its frame shows while it is edited).
	if (node.type === 'text') return [transformBezierPath(vectorTextBoxOutline(node), m)];
	// An instance outlines as its art draws (through its drawn group's rigid transform).
	if (node.type === 'instance') {
		const g = vectorInstanceDrawn(node);
		return [transformBezierPath(vectorAppearanceOutline(g), multiplyMatrices(nodeMatrix(g), parent))];
	}
	// A frame outlines as its rectangle.
	if (isVectorFrame(node)) return [transformBezierPath(subpathsToBezier(vectorFrameRectPath(node.frame)), m)];
	// Live and mask groups outline as drawn (masked) unless they are being edited.
	if ((hasOwnVectorAppearance(node) || isVectorMaskActive(node)) && !entered.has(node.id)) return [transformBezierPath(vectorAppearanceOutline(node), m)];
	return node.children.filter((c) => c.visible !== false).flatMap((c) => outlinePaths(c, m, entered));
}

/** The mesh and freeform fills of the selection while the Gradient tool is on (see `VectorOverlayRenderData.shading`). */
function shadingOverlay(state: VectorEditorState): VectorOverlayRenderData['shading'] {
	if (state.tool !== 'gradient') return [];
	const out: VectorOverlayRenderData['shading'] = [];
	const seen = new Set<string>();
	for (const id of state.selection) {
		const root = findVectorNode(state.document.nodes, id);
		if (!root) continue;
		for (const n of collectPathNodes(root)) {
			if (seen.has(n.id) || !isVectorShadedPaint(n.fill)) continue;
			seen.add(n.id);
			const world = vectorWorldMatrix(state.document.nodes, n.id);
			if (!world) continue;
			const sc = (q: Vec2) => toScreen(state, applyMatrix(world, q));
			const curve = (c: readonly Vec2[]) => {
				const [a, b, d, e] = c.map(sc);
				return `M${fmt(a.x)} ${fmt(a.y)}C${fmt(b.x)} ${fmt(b.y)} ${fmt(d.x)} ${fmt(d.y)} ${fmt(e.x)} ${fmt(e.y)}`;
			};
			const fill = n.fill as VectorMeshGradient | VectorFreeformGradient;
			const lines: string[] = [];
			if (isVectorMeshGradient(fill)) {
				const l = vectorMeshLines(fill);
				for (const row of [...l.rows, ...l.columns]) lines.push(row.map(curve).join(''));
			} else (fill.lines ?? []).forEach((_, k) => lines.push(vectorFreeformLineSegments(fill, k).map(curve).join('')));
			const sel = state.shadingPoint && state.shadingPoint.nodeId === n.id ? state.shadingPoint.index : -1;
			out.push({
				nodeId: n.id,
				kind: fill.type,
				lines,
				points: fill.points.map((q, index) => ({ index, ...sc(q), color: isVectorMeshGradient(fill) ? fill.colors[index] : (fill.points[index] as { color: string }).color, selected: index === sel }))
			});
		}
	}
	return out;
}

/** The axes of selected (or drawn-into) symmetry groups (see `VectorOverlayRenderData.symmetry`). */
function symmetryOverlay(state: VectorEditorState): VectorOverlayRenderData['symmetry'] {
	const ids = new Set([...state.selection, ...(state.symmetryTarget ? [state.symmetryTarget] : [])]);
	const out: VectorOverlayRenderData['symmetry'] = [];
	for (const id of ids) {
		const n = findVectorNode(state.document.nodes, id);
		if (!isVectorSymmetryGroup(n)) continue;
		const world = vectorWorldMatrix(state.document.nodes, id);
		if (!world) continue;
		// Long enough to cross the artboard and the art, in the group's space.
		const inv = invertMatrix(world);
		const corners = [
			{ x: 0, y: 0 },
			{ x: state.document.width, y: 0 },
			{ x: 0, y: state.document.height },
			{ x: state.document.width, y: state.document.height }
		].map((p) => applyMatrix(inv, p));
		const { transform: _t, ...own } = n;
		const b = unionBoxes([vectorNodeBounds(own as VectorNode), boundsFromCorners(corners)]);
		if (!b) continue;
		const pad = Math.max(b.width, b.height) * 0.05;
		const lines = vectorSymmetryAxes(n.symmetry, { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad }).map(([a, c]) => {
			const p = toScreen(state, applyMatrix(world, a));
			const q = toScreen(state, applyMatrix(world, c));
			return { x1: p.x, y1: p.y, x2: q.x, y2: q.y };
		});
		out.push({ nodeId: id, drawing: state.symmetryTarget === id, lines });
	}
	return out;
}

function unionBoxes(list: readonly (VectorBounds | null)[]): VectorBounds | null {
	const ok = list.filter((b): b is VectorBounds => !!b);
	if (!ok.length) return null;
	const x = Math.min(...ok.map((b) => b.x));
	const y = Math.min(...ok.map((b) => b.y));
	return { x, y, width: Math.max(...ok.map((b) => b.x + b.width)) - x, height: Math.max(...ok.map((b) => b.y + b.height)) - y };
}

function boundsFromCorners(pts: readonly Vec2[]): VectorBounds {
	const xs = pts.map((p) => p.x);
	const ys = pts.map((p) => p.y);
	return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Connection sites under the pointer while the Connector tool is on (see `VectorOverlayRenderData.connectorSites`). */
function connectorSiteOverlay(state: VectorEditorState): VectorOverlayRenderData['connectorSites'] {
	if (state.tool !== 'connector' || !state.pointer) return [];
	const drawing = state.interaction?.type === 'draw' && state.interaction.tool === 'connector' ? state.interaction.nodeId : undefined;
	const nodes = state.document.nodes;
	const target = vectorConnectorTargetAt(nodes, state.pointer, 12 / state.viewport.zoom, drawing);
	if (!target) return [];
	return vectorConnectionSites(nodes, target.nodeId).map((site) => {
		const p = toScreen(state, site);
		return { nodeId: target.nodeId, side: site.side, x: p.x, y: p.y, active: target.site?.side === site.side };
	});
}

/** Name labels of the top-level frames (see `VectorOverlayRenderData.frames`). */
function frameLabels(state: VectorEditorState): VectorOverlayRenderData['frames'] {
	const out: VectorOverlayRenderData['frames'] = [];
	for (const n of state.document.nodes) {
		if (!isVectorFrame(n) || n.visible === false) continue;
		const corner = applyMatrix(nodeMatrix(n), { x: n.frame.x, y: n.frame.y });
		const p = toScreen(state, corner);
		out.push({ id: n.id, name: n.name ?? 'Frame', x: p.x, y: p.y, selected: state.selection.includes(n.id) });
	}
	return out;
}

/** Constraint glyphs of what is selected or edited (see `VectorOverlayRenderData.constraints`). */
function constraintOverlay(state: VectorEditorState): VectorOverlayRenderData['constraints'] {
	if (!state.document.constraints?.length) return [];
	const ids = new Set([...state.selection, ...(state.editingId ? [state.editingId] : []), ...state.selectedAnchors.map((a) => a.nodeId)]);
	for (const id of [...ids]) {
		const n = findVectorNode(state.document.nodes, id);
		if (n?.type === 'group') walkVectorNodes(n.children, (c) => ids.add(c.id));
	}
	if (!ids.size) return [];
	const conflicts = new Set(state.constraintIssues?.conflicts ?? []);
	return vectorConstraintGlyphs(state.document, ids).map((g) => {
		const at = toScreen(state, g.at);
		const d = g.dimension ? { a: toScreen(state, g.dimension.a), b: toScreen(state, g.dimension.b) } : null;
		return { id: g.id, kind: g.kind, label: g.label, x: at.x, y: at.y - 10, dimension: d ? { x1: d.a.x, y1: d.a.y, x2: d.b.x, y2: d.b.y } : null, satisfied: g.satisfied && !conflicts.has(g.id) };
	});
}

/** The text editing overlay (see `VectorOverlayRenderData.text`). */
function textOverlay(state: VectorEditorState): VectorOverlayRenderData['text'] {
	const edit = state.textEdit;
	const id = edit?.nodeId ?? (state.tool === 'type' || state.tool === 'typePath' ? state.selection.find((s) => findVectorNode(state.document.nodes, s)?.type === 'text') : undefined);
	if (!id) return null;
	const node = findVectorNode(state.document.nodes, id);
	if (node?.type !== 'text') return null;
	const world = vectorWorldMatrix(state.document.nodes, id) ?? IDENTITY_MATRIX;
	const v = state.viewport;
	const m = multiplyMatrices(world, [v.zoom, 0, 0, v.zoom, v.x, v.y]);
	const at = (p: Vec2) => applyMatrix(m, p);
	const frame = bezierPathToSvg(transformBezierPath(vectorTextBoxOutline(node), m), { precision: 2 });
	let caret: NonNullable<VectorOverlayRenderData['text']>['caret'] = null;
	let selection: string[] = [];
	if (edit) {
		const a = Math.min(edit.anchor, edit.focus);
		const b = Math.max(edit.anchor, edit.focus);
		if (a === b) {
			const c = vectorTextCaret(node, edit.focus);
			const top = at(c.top);
			const bottom = at(c.bottom);
			caret = { x1: top.x, y1: top.y, x2: bottom.x, y2: bottom.y };
		} else selection = vectorTextSelectionQuads(node, a, b).map((q) => `M${q.map((p) => at(p)).map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join('L')}Z`);
	}
	const layout = layoutVectorText(node);
	let overflow: Vec2 | null = null;
	if (layout.overflow) {
		const f = node.frame;
		overflow = at(f.kind === 'area' ? { x: f.x + f.width, y: f.y + f.height } : (layout.glyphs.at(-1) ? { x: layout.glyphs.at(-1)!.x, y: layout.glyphs.at(-1)!.y } : { x: 0, y: 0 }));
	}
	return { nodeId: id, frame, caret, selection, overflow, editing: !!edit };
}

/** Live groups being edited in `state` (see `vectorEnteredGroups`). */
export function getVectorEnteredGroups(state: Pick<VectorEditorState, 'document' | 'selection' | 'editingId'>): Set<string> {
	return vectorEnteredGroups(state.document.nodes, state.editingId ? [...state.selection, state.editingId] : state.selection);
}

/** Paths (and text, as a path in its style) of a subtree, for style panels. */
function collect(node: VectorNode): VectorPathNode[] {
	if (node.type === 'path') return [node];
	if (node.type === 'text') return [vectorTextPaintSource(node)];
	if (node.type === 'instance') return [];
	return node.children.flatMap(collect);
}

/** The editing overlay in screen pixels. Render it on top of the scene, untransformed. */
export function getVectorOverlayRenderData(state: VectorEditorState): VectorOverlayRenderData {
	const doc = state.document;
	const z = state.viewport.zoom;
	const outlines: VectorOverlayRenderData['outlines'] = [];
	const entered = getVectorEnteredGroups(state);
	const seen = new Set<string>();
	const outline = (id: string, selected: boolean) => {
		if (seen.has(id)) return;
		const node = findVectorNode(doc.nodes, id);
		if (!node || node.visible === false) return;
		seen.add(id);
		outlines.push({ id, d: screenOutline(state, node, entered), selected });
	};
	for (const id of state.selection) outline(id, true);
	if (state.editingId) outline(state.editingId, true);
	if (state.hover?.nodeId && !state.interaction) outline(state.hover.nodeId, false);

	let selectionBox: VectorOverlayRenderData['selectionBox'] = null;
	if (state.tool === 'select' && state.selectionFrame && state.interaction?.type !== 'marquee' && state.interaction?.type !== 'distort') {
		const g = getVectorSelectionBoxGeometry(state.selectionFrame, state.viewport);
		selectionBox = { ...g.box, angle: g.angle, transform: g.transform, corners: g.corners, handles: g.handles, freeDistort: state.freeDistort };
	}

	const selected = (r: VectorAnchorRef) => state.selectedAnchors.some((a) => a.nodeId === r.nodeId && a.subpath === r.subpath && a.index === r.index);
	const sameAnchor = (a: VectorAnchorRef | undefined, b: VectorAnchorRef) => !!a && a.nodeId === b.nodeId && a.subpath === b.subpath && a.index === b.index;
	const anchors: VectorRenderAnchor[] = getVisibleAnchors(state).map((ref) => {
		const a = getAnchorWorld(doc, ref)!;
		const s = toScreen(state, a);
		const closes = !!state.pen && state.pen.nodeId === ref.nodeId && state.pen.subpath === ref.subpath && ref.index === 0;
		return { ref, x: s.x, y: s.y, type: a.type ?? inferAnchorType(a), selected: selected(ref), hovered: sameAnchor(state.hover?.anchor, ref), closes };
	});
	if (state.tool === 'pen' && !state.pen && state.hover?.anchor) {
		const a = getAnchorWorld(doc, state.hover.anchor);
		if (a) {
			const s = toScreen(state, a);
			anchors.push({ ref: state.hover.anchor, x: s.x, y: s.y, type: a.type ?? 'corner', selected: false, hovered: true, closes: false });
		}
	}

	const handles: VectorRenderHandle[] = getVisibleHandles(state).flatMap((ref) => {
		const a = getAnchorWorld(doc, ref);
		const h = a?.[ref.handle];
		if (!a || !h) return [];
		const s = toScreen(state, h);
		const sa = toScreen(state, a);
		const hovered = !!state.hover?.handle && sameAnchor(state.hover.handle, ref) && state.hover.handle.handle === ref.handle;
		return [{ ref, x: s.x, y: s.y, anchorX: sa.x, anchorY: sa.y, hovered }];
	});

	let marquee: VectorBounds | null = null;
	if (state.interaction?.type === 'marquee') {
		const b = state.interaction.bounds;
		const tl = toScreen(state, b);
		marquee = { x: tl.x, y: tl.y, width: b.width * z, height: b.height * z };
	}

	let penPreview: string | null = null;
	if (state.tool === 'pen' && state.pen && state.pointer && !state.interaction) {
		const node = findVectorNode(doc.nodes, state.pen.nodeId);
		const sp = node?.type === 'path' ? node.subpaths[state.pen.subpath] : undefined;
		const last = sp ? getAnchorWorld(doc, { nodeId: state.pen.nodeId, subpath: state.pen.subpath, index: sp.anchors.length - 1 }) : undefined;
		if (last) {
			const a = toScreen(state, last);
			const p = toScreen(state, state.pointer);
			const c = last.out ? toScreen(state, last.out) : null;
			penPreview = c ? `M${fmt(a.x)} ${fmt(a.y)}Q${fmt(c.x)} ${fmt(c.y)} ${fmt(p.x)} ${fmt(p.y)}` : `M${fmt(a.x)} ${fmt(a.y)}L${fmt(p.x)} ${fmt(p.y)}`;
		}
	}

	const origin = toScreen(state, { x: 0, y: 0 });
	let artboard = { x: origin.x, y: origin.y, width: doc.width * z, height: doc.height * z };
	// Isolation mode: the document's artboard where the dimmed document draws (none without it).
	const se = state.symbolEdit;
	if (se) {
		const m = se.hostTransform;
		if (m) {
			const tl = toScreen(state, { x: m[4], y: m[5] });
			artboard = { x: tl.x, y: tl.y, width: se.host.width * m[0] * z, height: se.host.height * m[3] * z };
		} else artboard = { x: origin.x, y: origin.y, width: 0, height: 0 };
	}

	let status: string | null = null;
	const it = state.interaction;
	if (it?.type === 'rotate') status = `${Math.round(it.angle)}°`;
	else if (it?.type === 'move' || it?.type === 'anchors') status = `Δ ${fmt(it.dx)}, ${fmt(it.dy)}`;
	else if (it?.type === 'scale' || it?.type === 'draw') {
		const b = it.type === 'draw' ? (findVectorNode(doc.nodes, it.nodeId) ? vectorNodeBounds(findVectorNode(doc.nodes, it.nodeId)!) : null) : state.selectionFrame;
		if (b) status = `W ${fmt(b.width)} × H ${fmt(b.height)}`;
	}

	const guides: VectorOverlayRenderData['guides'] = { lines: [], labels: [] };
	if (state.guides) {
		for (const l of state.guides.lines) {
			const a = toScreen(state, { x: l.x1, y: l.y1 });
			const b = toScreen(state, { x: l.x2, y: l.y2 });
			guides.lines.push({ kind: l.kind, x1: fmt(a.x), y1: fmt(a.y), x2: fmt(b.x), y2: fmt(b.y) });
		}
		for (const l of state.guides.labels) {
			const p = toScreen(state, l);
			guides.labels.push({ kind: l.kind, x: fmt(p.x), y: fmt(p.y), text: l.text });
		}
	}

	let toolStroke: VectorOverlayRenderData['toolStroke'] = null;
	if (it?.type === 'stroke') {
		const pts = it.points.map((q) => toScreen(state, q));
		const d = pts.map((q, i) => `${i ? 'L' : 'M'}${fmt(q.x)} ${fmt(q.y)}`).join('') + (pts.length === 1 ? `L${fmt(pts[0].x)} ${fmt(pts[0].y)}` : '');
		toolStroke = { tool: it.tool, d, width: fmt(it.width * z) };
	}
	let pencilString: VectorOverlayRenderData['pencilString'] = null;
	if (it?.type === 'draw' && it.string) {
		const a = toScreen(state, it.string[0]);
		const b = toScreen(state, it.string[1]);
		pencilString = { x1: fmt(a.x), y1: fmt(a.y), x2: fmt(b.x), y2: fmt(b.y) };
	}
	const dragged = it?.type === 'corner' ? it.ref : null;
	const cornerWidgets: VectorRenderCornerWidget[] = getVectorCornerWidgets(state).map((w) => {
		const s = toScreen(state, w);
		return { ref: w.ref, x: fmt(s.x), y: fmt(s.y), radius: w.radius, kind: w.kind, hovered: sameAnchor(state.hover?.corner, w.ref), active: !!dragged };
	});
	if (it?.type === 'corner') status = `R ${fmt(it.radius)}`;
	const cutPoint = state.tool === 'scissors' && state.hover?.segment && !it ? (({ x, y }) => ({ x: fmt(x), y: fmt(y) }))(toScreen(state, state.hover.segment.point)) : null;

	const sc = (p: Vec2) => {
		const q = toScreen(state, p);
		return { x: fmt(q.x), y: fmt(q.y) };
	};
	const sameWidth = (a: VectorWidthPointRef | null | undefined, b: VectorWidthPointRef) => !!a && a.nodeId === b.nodeId && a.index === b.index;
	const widthPoints: VectorRenderWidthPoint[] = getVectorWidthHandles(state).map((h) => {
		const c = sc(h);
		const hw = state.hover?.widthPoint;
		const hovered = hw && sameWidth(hw, h.ref) && hw.subpath === h.ref.subpath ? hw.part : null;
		return { ref: h.ref, x: c.x, y: c.y, left: sc(h.left), right: sc(h.right), selected: h.selected, hovered, active: it?.type === 'width' && sameWidth(it.ref, h.ref) };
	});
	const spot = state.tool === 'width' && !it ? state.hover?.strokeSpot : null;
	const widthSpot = spot ? { ...sc(spot.point), left: sc(spot.left), right: sc(spot.right) } : null;
	if (it?.type === 'width') status = it.mode === 'move' ? 'Move width point' : it.mode === 'copy' ? 'Copy width point' : `W ${fmt(it.width)}`;

	let builder: VectorOverlayRenderData['builder'] = null;
	if (state.builder) {
		const v = state.viewport;
		const view: AffineMatrix = [v.zoom, 0, 0, v.zoom, v.x, v.y];
		const svg = (path: BezierPath) => bezierPathToSvg(path, { precision: 2 });
		const screen = state.builder.faces.map((f) => transformBezierPath(f, view));
		const hatch = state.builder.mode !== 'fill';
		const trail = state.builder.trail && state.builder.trail.length > 1 ? state.builder.trail.map((q, i) => `${i ? 'L' : 'M'}${sc(q).x} ${sc(q).y}`).join('') : null;
		builder = {
			mode: state.builder.mode,
			faces: screen.map(svg),
			hatches: screen.map((f) => (hatch ? svg(hatchPath(f, { gap: VECTOR_BUILDER_HATCH_GAP })) : '')),
			lines: state.builder.lines.map((l) => svg(transformBezierPath(l, view))),
			trail
		};
		if (state.builder.mode !== 'fill' && it?.type === 'builder') {
			const n = state.builder.faces.length;
			status = state.builder.mode === 'erase' ? `Delete ${n} ${n === 1 ? 'face' : 'faces'}` : `Merge ${n} ${n === 1 ? 'face' : 'faces'}`;
		}
	}

	const blend = blendOverlay(state);
	if (state.tool === 'blend' && !it) status = state.blendStart ? 'Click another shape to blend into' : 'Click a shape to blend from';

	let gradient: VectorRenderGradientAnnotator | null = null;
	if (state.tool === 'gradient') {
		gradient = gradientOverlay(state);
		if (!gradient && !it) status = 'Drag across a shape to set a gradient';
		else if (it?.type === 'gradient' && it.removing) status = 'Release to delete the stop';
	}

	let distort: VectorOverlayRenderData['distort'] = null;
	if (it?.type === 'distort') {
		const corners = it.corners.map(sc);
		distort = { mode: it.mode, corners, d: corners.map((c, i) => `${i ? 'L' : 'M'}${c.x} ${c.y}`).join('') + 'Z' };
		status = it.mode === 'skew' ? 'Skew' : it.mode === 'perspective' ? 'Perspective' : 'Distort';
	}

	const envelope = state.tool === 'envelope' ? envelopeOverlay(state) : null;
	if (state.tool === 'envelope' && !envelope && !it) status = 'Select an object with an envelope to edit its mesh';

	let textBox: VectorBounds | null = null;
	if (state.interaction?.type === 'textBox') {
		const b = state.interaction.bounds;
		const tl = toScreen(state, b);
		textBox = { x: tl.x, y: tl.y, width: b.width * z, height: b.height * z };
	}
	return { outlines, selectionBox, distort, anchors, handles, marquee, penPreview, artboard, guides, status, toolStroke, pencilString, cutPoint, cornerWidgets, widthPoints, widthSpot, builder, blend, gradient, envelope, masks: maskOverlay(state), text: textOverlay(state), textBox, constraints: constraintOverlay(state), frames: frameLabels(state), connectorSites: connectorSiteOverlay(state),
		shading: shadingOverlay(state),
		symmetry: symmetryOverlay(state),
		trackingPoints: (state.trackingPoints ?? []).map((p) => toScreen(state, p)),
		typedEntry: state.typedEntry ? { text: state.typedEntry, ...(state.pointer ? toScreen(state, state.pointer) : { x: 0, y: 0 }) } : null
	};
}

/** Mask indicators of the mask groups that are selected or hold the selection (see `VectorOverlayRenderData.masks`). */
function maskOverlay(state: VectorEditorState): VectorOverlayRenderData['masks'] {
	const ids = state.editingId ? [...state.selection, state.editingId] : state.selection;
	if (!ids.length) return [];
	const want = new Set(ids);
	const v = state.viewport;
	const view: AffineMatrix = [v.zoom, 0, 0, v.zoom, v.x, v.y];
	const out: VectorOverlayRenderData['masks'] = [];
	const visit = (list: readonly VectorNode[], parent: AffineMatrix): boolean => {
		let any = false;
		for (const n of list) {
			if (n.type !== 'group') {
				if (want.has(n.id)) any = true;
				continue;
			}
			const m = multiplyMatrices(nodeMatrix(n), parent);
			const inside = visit(n.children, m);
			const hit = want.has(n.id) || inside;
			if (hit) any = true;
			if (!hit || !isVectorMaskGroup(n)) continue;
			const summary = vectorMaskSummary(n)!;
			const d = outlinePaths(n.children[0], m, new Set())
				.map((path) => bezierPathToSvg(transformBezierPath(path, view), { precision: 2 }))
				.join(' ');
			out.push({ id: n.id, maskId: summary.maskId, d, type: summary.type, invert: summary.invert, enabled: summary.enabled, editing: want.has(summary.maskId) });
		}
		return any;
	};
	visit(state.document.nodes, IDENTITY_MATRIX);
	return out;
}

function envelopeOverlay(state: VectorEditorState): VectorOverlayRenderData['envelope'] {
	const target = getVectorEnvelopeTarget(state.document, state.selection);
	if (!target) return null;
	const v = state.viewport;
	const m = multiplyMatrices(target.world, [v.zoom, 0, 0, v.zoom, v.x, v.y]);
	const sc = (p: Vec2) => ({ x: fmt(m[0] * p.x + m[2] * p.y + m[4]), y: fmt(m[1] * p.x + m[3] * p.y + m[5]) });
	const { mesh } = target.frame;
	const grid = vectorMeshGridCurves(mesh)
		.map((c) => {
			const [a, b, cc, d] = c.map(sc);
			return `M${a.x} ${a.y}C${b.x} ${b.y} ${cc.x} ${cc.y} ${d.x} ${d.y}`;
		})
		.join('');
	const hover = state.hover?.envelope?.nodeId === target.node.id ? state.hover.envelope.index : undefined;
	const it = state.interaction;
	const active = it?.type === 'envelope' && it.nodeId === target.node.id ? it.index : undefined;
	const pts = vectorMeshEditPoints(mesh);
	return {
		nodeId: target.node.id,
		grid,
		anchors: pts.anchors.map((index) => ({ index, ...sc(mesh.points[index]), hovered: !it && hover === index, active: active === index })),
		handles: pts.handles.map((h) => {
			const a = sc(mesh.points[h.anchor]);
			return { index: h.index, ...sc(mesh.points[h.index]), anchorX: a.x, anchorY: a.y, hovered: !it && hover === h.index, active: active === h.index };
		})
	};
}

/** Warp choices of an envelope: the fifteen presets, then Mesh. */
export const VECTOR_ENVELOPE_STYLE_OPTIONS: readonly { value: VectorEnvelopeParams['style']; label: string }[] = [
	...VECTOR_WARP_STYLES.map((value) => ({ value, label: VECTOR_WARP_STYLE_LABELS[value] })),
	{ value: 'mesh', label: 'Mesh' }
];

/** What a Distort / Envelope panel shows for the selection. */
export interface VectorEnvelopePanelData {
	/** The one selected node, or null when several are selected. */
	nodeId: string | null;
	count: number;
	/** The selected node's envelope (the first one in its stack), if any. */
	envelope: { effectId: string; enabled: boolean; params: VectorEnvelopeParams } | null;
	/** Some selected node can take an envelope (Make with Warp / Mesh). */
	canMake: boolean;
	/** Make with Top Object: several objects selected and the topmost is a closed path. */
	canMakeWithTopObject: boolean;
	/** Some selected node has an envelope (Release, Expand). */
	canRelease: boolean;
}

/** The Distort / Envelope panel of the selection, or null when nothing is selected. */
export function getVectorEnvelopePanel(state: Pick<VectorEditorState, 'document' | 'selection'>): VectorEnvelopePanelData | null {
	const nodes = state.selection.map((id) => findVectorNode(state.document.nodes, id)).filter((n): n is VectorNode => !!n && !n.blendStep);
	if (!nodes.length) return null;
	const one = nodes.length === 1 ? nodes[0] : null;
	const first = one?.effects?.find((e) => e.type === 'envelope');
	const order = new Map<string, number>();
	walkVectorNodes(state.document.nodes, (n) => order.set(n.id, order.size));
	const top = nodes.length > 1 ? nodes.slice().sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))[nodes.length - 1] : null;
	return {
		nodeId: one?.id ?? null,
		count: nodes.length,
		envelope: first?.type === 'envelope' ? { effectId: first.id, enabled: first.enabled !== false, params: first.params } : null,
		canMake: nodes.some((n) => !n.locked),
		canMakeWithTopObject: top?.type === 'path' && top.subpaths.some((sp) => sp.closed && sp.anchors.length > 1),
		canRelease: nodes.some((n) => !n.locked && !!n.effects?.some((e) => e.type === 'envelope'))
	};
}

function gradientOverlay(state: VectorEditorState): VectorRenderGradientAnnotator | null {
	const a = getVectorGradientAnnotator(state.document, state.selection, state.viewport, state.gradientEdit.target, state.gradientEdit.layer ?? null);
	if (!a) return null;
	const hover = state.interaction ? null : state.hover?.gradient;
	const handleHovered = (h: VectorGradientHandle) => hover?.kind === 'handle' && hover.handle === h;
	const pt = (p: Vec2) => ({ x: fmt(p.x), y: fmt(p.y) });
	const centred = isCentredVectorGradient(a.gradient.type);
	const removing = state.interaction?.type === 'gradient' && !!state.interaction.removing;
	return {
		nodeId: a.nodeId,
		type: a.gradient.type,
		start: { ...pt(a.start), hovered: handleHovered('start') },
		end: { ...pt(a.end), hovered: handleHovered(centred ? 'radius' : 'end'), handle: centred ? 'radius' : 'end' },
		aspect: a.aspect ? { ...pt(a.aspect), hovered: handleHovered('aspect') } : null,
		focal: a.focal ? { ...pt(a.focal), hovered: handleHovered('focal') } : null,
		stops: a.stops.map((s) => ({
			index: s.index,
			...pt(s),
			barX: fmt(s.x - a.normal.x * VECTOR_GRADIENT_STOP_GAP),
			barY: fmt(s.y - a.normal.y * VECTOR_GRADIENT_STOP_GAP),
			color: s.color,
			opacity: s.opacity ?? 1,
			selected: state.gradientEdit.stop === s.index,
			hovered: hover?.kind === 'stop' && hover.index === s.index
		})),
		midpoints: a.midpoints.map((m) => ({ index: m.index, ...pt(m), hovered: hover?.kind === 'midpoint' && hover.index === m.index })),
		extent: a.extent,
		removing
	};
}

/** Blend groups the selection covers (a selected key counts as its blend). */
function selectedBlends(state: Pick<VectorEditorState, 'document' | 'selection'>): VectorGroupNode[] {
	const out = new Map<string, VectorGroupNode>();
	for (const id of state.selection) {
		const node = findVectorNode(state.document.nodes, id);
		const group = isVectorBlendGroup(node) ? node : locateVectorNode(state.document.nodes, id)?.parent;
		if (isVectorBlendGroup(group)) out.set(group.id, group);
	}
	return [...out.values()];
}

function blendOverlay(state: VectorEditorState): VectorOverlayRenderData['blend'] {
	const v = state.viewport;
	const view: AffineMatrix = [v.zoom, 0, 0, v.zoom, v.x, v.y];
	const doc = state.document;
	const sc = (p: Vec2, m: AffineMatrix) => {
		const q = { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
		return { x: fmt(q.x), y: fmt(q.y) };
	};
	const spines = selectedBlends(state).flatMap((g) => {
		const s = vectorBlendSpine(g);
		if (!s) return [];
		const m = multiplyMatrices(vectorWorldMatrix(doc.nodes, g.id) ?? IDENTITY_MATRIX, view);
		const d = bezierPathToSvg(transformBezierPath(subpathsToBezier([s.spine], { corners: false }), m), { precision: 2 });
		const keys = s.stops.map((stop) => {
			const p = vectorBlendRailAt(s.rail, stop).point;
			return sc({ x: p[0], y: p[1] }, m);
		});
		return [{ id: g.id, d, keys, replaced: s.replaced }];
	});
	let start: VectorOverlayRenderData['blend']['start'] = null;
	const anchors: VectorOverlayRenderData['blend']['anchors'] = [];
	if (state.tool === 'blend') {
		const from = state.blendStart ? findVectorNode(doc.nodes, state.blendStart.nodeId) : undefined;
		if (from && state.blendStart) {
			const a = state.blendStart.anchor === null ? undefined : getAnchorWorld(doc, { nodeId: from.id, subpath: 0, index: state.blendStart.anchor });
			start = { d: screenOutline(state, from, new Set()), anchor: a ? sc(a, view) : null };
		}
		const hovered = state.hover?.nodeId ? findVectorNode(doc.nodes, state.hover.nodeId) : undefined;
		if (hovered?.type === 'path' && hovered.subpaths[0]) {
			hovered.subpaths[0].anchors.forEach((_, index) => {
				const a = getAnchorWorld(doc, { nodeId: hovered.id, subpath: 0, index });
				if (a) anchors.push({ ...sc(a, view), hovered: state.hover?.anchor?.index === index });
			});
		}
	}
	return { spines, start, anchors };
}

/** What the Blend controls of a toolbar or style panel show. */
export interface VectorBlendControls {
	/** Ids of the selected blends (a selected key counts as its blend). */
	ids: string[];
	/** The first selected blend's options, or the options new blends get. */
	options: Required<VectorBlendOptions>;
	/** Two or more shapes that share a parent are selected: Blend can run. */
	canBlend: boolean;
	/** One blend and one path are selected: Replace Spine can run. */
	canReplaceSpine: boolean;
	/** The first selected blend follows a replaced spine. */
	hasSpine: boolean;
}

/** State of the Blend controls for the current selection. */
export function getVectorBlendControls(state: Pick<VectorEditorState, 'document' | 'selection' | 'blendDefaults'>): VectorBlendControls {
	const blends = selectedBlends(state);
	const doc = state.document;
	const roots = state.selection.filter((id) => {
		const node = findVectorNode(doc.nodes, id);
		return !!node && !node.blendStep && !node.locked && !state.selection.includes(locateVectorNode(doc.nodes, id)?.parent?.id ?? '');
	});
	const parents = new Set(roots.map((id) => locateVectorNode(doc.nodes, id)?.parent?.id ?? null));
	const paths = roots.filter((id) => findVectorNode(doc.nodes, id)?.type === 'path' && !isVectorBlendGroup(locateVectorNode(doc.nodes, id)?.parent));
	const first = blends[0];
	return {
		ids: blends.map((g) => g.id),
		options: resolveVectorBlendOptions(first ? first.blend : state.blendDefaults),
		canBlend: roots.length >= 2 && parents.size === 1,
		canReplaceSpine: blends.length === 1 && paths.length === 1,
		hasSpine: !!first?.blend?.spine
	};
}

/**
 * Applies blend options from a toolbar: to the selected blends (one undo step) and to the
 * options new blends get, so the controls keep showing what was picked.
 */
export function applyVectorBlendOptions(controller: VectorEditorController, patch: Partial<VectorBlendOptions>): void {
	controller.setBlendDefaults(patch);
	if (getVectorBlendControls(controller.getState()).ids.length) controller.setBlendOptions(patch);
}

/** Labels of the blend spacing modes, for toolbars. */
export const VECTOR_BLEND_SPACING_LABELS: Readonly<Record<VectorBlendSpacing, string>> = { steps: 'Specified Steps', distance: 'Specified Distance', smoothColor: 'Smooth Color' };

// ---------------------------------------------------------------------------
// Event adapters (duck-typed, so they work with DOM, React and Svelte events)
// ---------------------------------------------------------------------------

/** Colours and sizes (screen pixels) the bundled canvases draw the overlay with. */
export const VECTOR_OVERLAY_THEME = {
	accent: '#0ea5e9',
	/** Smart guide lines and labels. */
	guide: '#ff3dfc',
	handleFill: '#ffffff',
	marqueeFill: 'rgba(14, 165, 233, 0.08)',
	/** The eraser's swath while it is dragged. */
	eraserFill: 'rgba(239, 68, 68, 0.25)',
	transformHandleSize: 8,
	anchorSize: 7,
	handleRadius: 3.5,
	/** Radius of a live corner widget (a ring with a dot). */
	cornerWidgetRadius: 4,
	/** Half the diagonal of a width point's diamond. */
	widthPointSize: 5,
	/** Shape Builder faces to merge and paint bucket regions. */
	builderFill: 'rgba(14, 165, 233, 0.22)',
	/** Shape Builder faces and line pieces an Alt gesture deletes. */
	builderErase: '#ef4444',
	builderEraseFill: 'rgba(239, 68, 68, 0.22)',
	/** Opacity of the hatch lines over Shape Builder faces (drawn in the face's outline colour). */
	builderHatchOpacity: 0.6,
	/** Mask indicators: the outline of a selected mask group's mask (dashed; solid while the mask is selected). */
	mask: '#8b5cf6',
	maskDash: '5 3'
} as const;

/** SVG path data of the diamond a width point is drawn with (screen pixels). */
export function vectorDiamondPath(x: number, y: number, r: number = VECTOR_OVERLAY_THEME.widthPointSize): string {
	return `M${fmt(x)} ${fmt(y - r)}L${fmt(x + r)} ${fmt(y)}L${fmt(x)} ${fmt(y + r)}L${fmt(x - r)} ${fmt(y)}Z`;
}

interface ModifierEventLike {
	shiftKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	ctrlKey?: boolean;
}

/** Modifiers of a mouse / pointer / key event (`mod` is Cmd or Ctrl). */
export function toVectorModifiers(event: ModifierEventLike): { shift: boolean; alt: boolean; mod: boolean } {
	return { shift: !!event.shiftKey, alt: !!event.altKey, mod: !!(event.metaKey || event.ctrlKey) };
}

/**
 * A pointer event as `VectorEditorController.pointerDown/Move/Up` input: modifiers, button,
 * and the pressure and pointer type the pencil records as a width profile.
 */
export function toVectorPointerInput(event: ModifierEventLike & { button?: number; pressure?: number; pointerType?: string }) {
	return {
		...toVectorModifiers(event),
		button: event.button,
		...(typeof event.pressure === 'number' ? { pressure: event.pressure } : {}),
		...(event.pointerType ? { pointerType: event.pointerType } : {})
	};
}

/** A key event as `VectorEditorController.keyDown/keyUp` input. */
export function toVectorKeyInput(event: ModifierEventLike & { key: string }) {
	return { key: event.key, ...toVectorModifiers(event) };
}

/** True for targets that should keep their own keys (inputs, textareas, contenteditable). */
export function isVectorTextTarget(target: unknown): boolean {
	const el = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null } | null;
	if (!el || typeof el !== 'object') return false;
	const tag = (el.tagName ?? '').toUpperCase();
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
	return !!el.isContentEditable || el.getAttribute?.('contenteditable') === 'true';
}

// ---------------------------------------------------------------------------
// Style panel helpers
// ---------------------------------------------------------------------------

/** Style shown in a style panel: the first selected path's, with `mixed` flags when paths differ. */
export interface VectorSelectionStyle {
	fill: VectorPaint;
	stroke: VectorPaint;
	strokeWidth: number;
	opacity: number;
	strokeAlign: VectorStrokeAlign;
	startArrow: VectorArrowhead | null;
	endArrow: VectorArrowhead | null;
	arrowAlign: VectorArrowAlign;
	startArrowScale: number;
	endArrowScale: number;
	/** The first path's width profile (null when uniform) and the preset it matches. */
	strokeWidthProfile: VectorWidthPoint[] | null;
	widthProfile: VectorWidthPreset | 'custom';
	/**
	 * Live corners of the selected anchors (direct tool) or of every corner of the selected
	 * paths: the first one's radius and kind, and how many corners there are (0: none to round).
	 */
	cornerRadius: number;
	cornerKind: VectorCornerKind;
	/** Squircle smoothing (0–1) of the first corner. */
	cornerSmoothing: number;
	corners: number;
	/** Some selected path is open, so arrowheads apply. */
	hasOpenPath: boolean;
	mixed: {
		fill: boolean;
		stroke: boolean;
		strokeWidth: boolean;
		opacity: boolean;
		strokeAlign: boolean;
		startArrow: boolean;
		endArrow: boolean;
		arrowAlign: boolean;
		startArrowScale: boolean;
		endArrowScale: boolean;
		widthProfile: boolean;
		cornerRadius: boolean;
		cornerKind: boolean;
	};
	/** Ids of the paths the style applies to. */
	pathIds: string[];
}

export function getVectorSelectionStyle(
	state: Pick<VectorEditorState, 'document' | 'selection'> & Partial<Pick<VectorEditorState, 'selectedAnchors' | 'tool'>>
): VectorSelectionStyle | null {
	const paths: VectorPathNode[] = [];
	for (const id of state.selection) {
		const node = findVectorNode(state.document.nodes, id);
		if (node) paths.push(...collect(node));
	}
	const anchorMode = state.tool === 'direct' && !!state.selectedAnchors?.length;
	if (anchorMode) {
		for (const r of state.selectedAnchors!) {
			if (paths.some((p) => p.id === r.nodeId)) continue;
			const node = findVectorNode(state.document.nodes, r.nodeId);
			if (node?.type === 'path') paths.push(node);
		}
	}
	if (!paths.length) return null;
	const first = paths[0];
	const same = (get: (p: VectorPathNode) => unknown) => paths.every((p) => JSON.stringify(get(p) ?? null) === JSON.stringify(get(first) ?? null));
	// Corners: those of the selected anchors in the direct tool, else every corner of the paths.
	const corners: { radius: number; kind: VectorCornerKind; smoothing: number }[] = [];
	for (const p of paths) {
		for (const c of vectorCorners(p.subpaths)) {
			if (anchorMode && !state.selectedAnchors!.some((r) => r.nodeId === p.id && r.subpath === c.subpath && r.index === c.index)) continue;
			const corner = p.subpaths[c.subpath].anchors[c.index].corner;
			corners.push({ radius: corner?.radius ?? 0, kind: corner?.kind ?? 'round', smoothing: corner?.smoothing ?? 0 });
		}
	}
	const c0 = corners[0] ?? { radius: 0, kind: 'round' as const, smoothing: 0 };
	return {
		fill: first.fill ?? null,
		stroke: first.stroke ?? null,
		strokeWidth: first.strokeWidth ?? 1,
		opacity: first.opacity ?? 1,
		strokeAlign: first.strokeAlign ?? 'center',
		startArrow: first.startArrow ?? null,
		endArrow: first.endArrow ?? null,
		arrowAlign: first.arrowAlign ?? 'extend',
		startArrowScale: first.startArrowScale ?? 1,
		endArrowScale: first.endArrowScale ?? 1,
		strokeWidthProfile: profileOf(first),
		widthProfile: widthProfilePresetId(profileOf(first)),
		cornerRadius: c0.radius,
		cornerKind: c0.kind,
		cornerSmoothing: c0.smoothing,
		corners: corners.length,
		hasOpenPath: paths.some((p) => p.subpaths.some((sp) => !sp.closed && sp.anchors.length > 1)),
		mixed: {
			fill: !same((p) => p.fill),
			stroke: !same((p) => p.stroke),
			strokeWidth: !same((p) => p.strokeWidth ?? 1),
			opacity: !same((p) => p.opacity ?? 1),
			strokeAlign: !same((p) => p.strokeAlign ?? 'center'),
			startArrow: !same((p) => p.startArrow ?? null),
			endArrow: !same((p) => p.endArrow ?? null),
			arrowAlign: !same((p) => p.arrowAlign ?? 'extend'),
			startArrowScale: !same((p) => p.startArrowScale ?? 1),
			endArrowScale: !same((p) => p.endArrowScale ?? 1),
			widthProfile: !same(profileOf),
			cornerRadius: corners.some((c) => c.radius !== c0.radius),
			cornerKind: corners.some((c) => c.kind !== c0.kind)
		},
		pathIds: paths.map((p) => p.id)
	};
}

function profileOf(p: VectorPathNode): VectorWidthPoint[] | null {
	const points = sanitizeWidthProfile(p.strokeWidthProfile);
	return points.length && widthProfilePresetId(points) !== 'uniform' ? points : null;
}

/** Labels of the stroke alignments, corner kinds and arrowheads, for style panels. */
export const VECTOR_STROKE_ALIGN_LABELS: Readonly<Record<VectorStrokeAlign, string>> = { center: 'Center', inside: 'Inside', outside: 'Outside' };
export const VECTOR_CORNER_KIND_LABELS: Readonly<Record<VectorCornerKind, string>> = { round: 'Round', inverted: 'Inverted', chamfer: 'Chamfer' };
export const VECTOR_ARROWHEAD_LABELS: Readonly<Record<VectorArrowhead, string>> = {
	triangle: 'Triangle',
	arrow: 'Arrow',
	open: 'Open arrow',
	circle: 'Circle',
	square: 'Square',
	bar: 'Bar'
};

/** A paint as `#rrggbb` for `<input type="color">`, or null for none, gradients and other CSS colours. */
export function vectorPaintToHex(paint: VectorPaint | undefined): string | null {
	if (typeof paint !== 'string') return null;
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(paint.trim());
	if (!m) return null;
	const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
	return `#${hex.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Gradient editor
// ---------------------------------------------------------------------------

export const VECTOR_GRADIENT_TYPE_LABELS: Readonly<Record<VectorGradientType, string>> = { linear: 'Linear', radial: 'Radial', conic: 'Conic', reflected: 'Reflected', diamond: 'Diamond' };
export const VECTOR_GRADIENT_SPREAD_LABELS: Readonly<Record<VectorGradientSpread, string>> = { pad: 'Pad', reflect: 'Reflect', repeat: 'Repeat' };
export const VECTOR_GRADIENT_INTERPOLATION_LABELS: Readonly<Record<VectorGradientInterpolation, string>> = { srgb: 'sRGB', linear: 'Linear light', oklab: 'Oklab' };
export const VECTOR_STROKE_GRADIENT_MODE_LABELS: Readonly<Record<VectorStrokeGradientMode, string>> = { within: 'Within stroke', along: 'Along stroke', across: 'Across stroke' };

/** What a gradient editor shows for the selection's `target` paint (see `getVectorGradientEditor`). */
export interface VectorGradientEditorData {
	target: 'fill' | 'stroke';
	/** The layer of the `target` stack edited (null: the top one). */
	layer: number | null;
	/** The first selected path's paint is a gradient. */
	gradient: VectorGradient | null;
	/** The paint as a `#rrggbb` colour when it is one (what a new gradient starts from). */
	color: string | null;
	/** Sorted stops; `index` is what `setGradientStop` takes. */
	stops: (VectorGradientStop & { index: number; selected: boolean })[];
	selected: (VectorGradientStop & { index: number; last: boolean }) | null;
	/** A CSS `linear-gradient(to right, …)` of the ramp (midpoints and colour space expanded). */
	preview: string | null;
	type: VectorGradientType | null;
	spread: VectorGradientSpread;
	interpolation: VectorGradientInterpolation;
	smoothness: number;
	strokeMode: VectorStrokeGradientMode;
	/** The selected paths' gradients differ. */
	mixed: boolean;
}

/** The gradient editor of the selection's fill or stroke (`state.gradientEdit.target`), or null with nothing selected. */
export function getVectorGradientEditor(state: Pick<VectorEditorState, 'document' | 'selection' | 'gradientEdit'>): VectorGradientEditorData | null {
	const paths: VectorPathNode[] = [];
	for (const id of state.selection) {
		const node = findVectorNode(state.document.nodes, id);
		if (node) paths.push(...collect(node));
	}
	if (!paths.length) return null;
	const { target, layer } = state.gradientEdit;
	const paint = vectorTargetPaint(paths[0], target, layer ?? null);
	const gradient = isVectorGradient(paint) ? paint : null;
	const sorted = gradient ? sortedVectorGradientStops(gradient) : [];
	const stopIndex = state.gradientEdit.stop;
	const stops = sorted.map((s, index) => ({ ...s, index, selected: index === stopIndex }));
	const sel = stopIndex !== null && sorted[stopIndex] ? { ...sorted[stopIndex], index: stopIndex, last: stopIndex === sorted.length - 1 } : null;
	const preview = gradient
		? `linear-gradient(to right, ${expandVectorGradientStops(gradient)
				.map((s) => {
					const c = parseVectorColor(s.color);
					const a = (c?.[3] ?? 1) * (s.opacity ?? 1);
					const color = c ? `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${Math.round(a * 1000) / 1000})` : s.color;
					return `${color} ${Math.round(s.offset * 10000) / 100}%`;
				})
				.join(', ')})`
		: null;
	return {
		target,
		layer: layer ?? null,
		gradient,
		color: vectorPaintToHex(paint),
		stops,
		selected: sel,
		preview,
		type: gradient?.type ?? null,
		spread: gradient?.spread ?? 'pad',
		interpolation: gradient?.interpolation ?? 'srgb',
		smoothness: gradient?.smoothness ?? 0,
		strokeMode: gradient?.strokeMode ?? 'within',
		mixed: paths.some((p) => JSON.stringify(vectorTargetPaint(p, target, layer ?? null) ?? null) !== JSON.stringify(paint ?? null))
	};
}

// ---------------------------------------------------------------------------
// Toolbar helpers
// ---------------------------------------------------------------------------

/** A path-editing button of the bundled toolbars. */
export interface VectorPathAction {
	id: 'join' | 'average' | 'cut' | 'clean' | 'smooth' | 'outline';
	label: string;
	title: string;
	/** Shortcut after Cmd / Ctrl, if any. */
	shortcut?: string;
	/** Whether it can run with `selected` nodes and `points` selected anchors (direct tool). */
	enabled: (selected: number, points: number) => boolean;
	run: (controller: VectorEditorController) => unknown;
}

/** Join, Average, Cut at Points, Remove Redundant Points, Smooth and Outline Stroke, as the toolbars show them. */
export const VECTOR_PATH_ACTIONS: readonly VectorPathAction[] = [
	{ id: 'join', label: '⋈', title: 'Join', shortcut: 'J', enabled: (s, p) => s + p > 0, run: (c) => c.joinPaths() },
	{ id: 'average', label: '⊹', title: 'Average Points', shortcut: 'Alt+J', enabled: (_s, p) => p > 1, run: (c) => c.averageAnchors('both') },
	{ id: 'cut', label: '✂·', title: 'Cut at Points', enabled: (_s, p) => p > 0, run: (c) => c.cutAtAnchors() },
	{ id: 'clean', label: '⌁', title: 'Remove Redundant Points', enabled: (s, p) => s + p > 0, run: (c) => c.removeRedundantPoints() },
	{ id: 'smooth', label: '∿', title: 'Smooth', enabled: (s, p) => s + p > 0, run: (c) => c.smoothPaths() },
	{ id: 'outline', label: '⊡', title: 'Outline Stroke', enabled: (s) => s > 0, run: (c) => c.outlineStroke() }
];

/** A Pathfinder button of the bundled toolbars. */
export interface VectorPathfinderAction {
	id: VectorPathfinderOperation;
	label: string;
	title: string;
	/** Paths (or groups) it needs selected. */
	min: number;
}

/** Divide, Trim, Merge, Crop, Outline and Minus Back, as the toolbars show them. */
export const VECTOR_PATHFINDER_ACTIONS: readonly VectorPathfinderAction[] = [
	{ id: 'divide', label: '⊞', title: 'Divide', min: 1 },
	{ id: 'trim', label: '⧉', title: 'Trim', min: 2 },
	{ id: 'merge', label: '⧈', title: 'Merge', min: 2 },
	{ id: 'crop', label: '⌗', title: 'Crop', min: 2 },
	{ id: 'outline', label: '⬚', title: 'Outline', min: 1 },
	{ id: 'minusBack', label: '⊖', title: 'Minus Back', min: 2 }
];

/** The on / off path-editing settings the toolbars toggle. */
export const VECTOR_EDIT_TOGGLES: readonly { key: 'keepShapeOnDelete' | 'curvatureMoves' | 'recognizeShapes'; label: string; title: string }[] = [
	{ key: 'keepShapeOnDelete', label: 'Keep', title: 'Keep shape when deleting points' },
	{ key: 'curvatureMoves', label: 'Curv', title: 'Curvature point moves (Alt flips while dragging)' },
	{ key: 'recognizeShapes', label: 'Shapes', title: 'Turn pencil scribbles into shapes' }
];


// ---------------------------------------------------------------------------
// Effects panel
// ---------------------------------------------------------------------------

/** One effect of the listed stack, with what a panel needs to edit it. */
export interface VectorEffectsPanelItem {
	id: string;
	type: VectorEffectType;
	label: string;
	enabled: boolean;
	params: Record<string, unknown>;
	/** The parameters to edit (none for an envelope: `getVectorEnvelopePanel` and the Envelope panels edit it). */
	specs: readonly VectorEffectParamSpec[];
}

/** What an Effects panel shows for the selection. */
export interface VectorEffectsPanelData {
	/** The node whose stack is listed (when one node is selected), else null. */
	nodeId: string | null;
	/** Selected nodes an added effect goes to. */
	count: number;
	/** The listed stack, applied top to bottom. */
	effects: VectorEffectsPanelItem[];
	/** Something selected is live (Expand Appearance applies). */
	expandable: boolean;
}

/** Effect types in menu order, with their names. */
export const VECTOR_EFFECT_MENU: readonly { type: VectorEffectType; label: string }[] = VECTOR_EFFECT_TYPES.map((type) => ({ type, label: VECTOR_EFFECT_LABELS[type] }));

/** The Effects panel of the selection, or null when nothing that takes effects is selected. */
export function getVectorEffectsPanel(state: Pick<VectorEditorState, 'document' | 'selection'>): VectorEffectsPanelData | null {
	const nodes = state.selection.map((id) => findVectorNode(state.document.nodes, id)).filter((n): n is VectorNode => !!n && !n.blendStep);
	if (!nodes.length) return null;
	const one = nodes.length === 1 ? nodes[0] : null;
	return {
		nodeId: one?.id ?? null,
		count: nodes.length,
		effects: (one?.effects ?? []).map((e) => ({
			id: e.id,
			type: e.type,
			label: VECTOR_EFFECT_LABELS[e.type] ?? e.type,
			enabled: e.enabled !== false,
			params: e.params as unknown as Record<string, unknown>,
			// The Envelope panel (`getVectorEnvelopePanel`) edits an envelope's warp and mesh.
			specs: e.type === 'envelope' ? [] : (VECTOR_EFFECT_PARAM_SPECS[e.type] ?? [])
		})),
		expandable: nodes.some(hasVectorAppearance)
	};
}

// ---------------------------------------------------------------------------
// Appearance panel: fill and stroke stacks, blend mode, filters
// ---------------------------------------------------------------------------

/** One fill or stroke layer as an appearance panel lists it. */
export interface VectorAppearancePanelLayer {
	kind: 'fill' | 'stroke';
	/** Index in its stack (0 is the bottom); what `updatePaintLayer` and friends take. */
	index: number;
	paint: VectorPaint;
	/** The paint as `#rrggbb` when it is one (for a colour input). */
	color: string | null;
	/** A CSS `background` showing the paint (a colour, or the gradient's ramp). */
	swatch: string;
	gradient: boolean;
	opacity: number;
	blendMode: VectorBlendMode;
	visible: boolean;
	/** Stroke layers: width and alignment (for the compact row). */
	strokeWidth?: number;
	strokeAlign?: VectorStrokeAlign;
	/** A stroke of a kind this version cannot draw (kept, shown read-only). */
	unknownKind?: string;
	/** The gradient editor and tool work on this layer. */
	editing: boolean;
}

/** What an appearance panel shows for the selection. */
export interface VectorAppearancePanelData {
	/** Selected nodes (blend mode and filters apply to them). */
	nodeIds: string[];
	/** Paths the stacks belong to (groups give every path inside); the first one's stacks are listed. */
	pathIds: string[];
	fills: VectorAppearancePanelLayer[];
	strokes: VectorAppearancePanelLayer[];
	/** The first selected node's blend mode. */
	blendMode: VectorBlendMode;
	mixed: { fills: boolean; strokes: boolean; blendMode: boolean };
	/** The filter stack, listed when one node is selected (`filterNodeId`). */
	filterNodeId: string | null;
	filters: VectorFiltersPanelItem[];
}

/** One filter of the listed stack, with what a panel needs to edit it. */
export interface VectorFiltersPanelItem {
	id: string;
	type: VectorFilterType;
	label: string;
	enabled: boolean;
	params: Record<string, unknown>;
	specs: readonly VectorFilterParamSpec[];
}

/** A CSS background for a paint: the colour, or a left-to-right ramp of a gradient's stops. */
export function vectorPaintSwatch(paint: VectorPaint | undefined): string {
	if (typeof paint === 'string') return paint;
	if (isVectorGradient(paint)) {
		return `linear-gradient(to right, ${expandVectorGradientStops(paint)
			.map((s) => {
				const c = parseVectorColor(s.color);
				const a = (c?.[3] ?? 1) * (s.opacity ?? 1);
				const color = c ? `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${Math.round(a * 1000) / 1000})` : s.color;
				return `${color} ${Math.round(s.offset * 10000) / 100}%`;
			})
			.join(', ')})`;
	}
	return 'transparent';
}

/** The appearance panel of the selection, or null with nothing selected. */
export function getVectorAppearancePanel(state: Pick<VectorEditorState, 'document' | 'selection' | 'gradientEdit'>): VectorAppearancePanelData | null {
	const nodes = state.selection.map((id) => findVectorNode(state.document.nodes, id)).filter((n): n is VectorNode => !!n && !n.blendStep);
	if (!nodes.length) return null;
	const paths: VectorPathNode[] = [];
	for (const n of nodes) for (const p of collect(n)) if (!p.blendStep && !paths.some((q) => q.id === p.id)) paths.push(p);
	const first = paths[0];
	const edit = state.gradientEdit;
	const layer = (kind: 'fill' | 'stroke', l: VectorStrokeLayer, index: number, count: number): VectorAppearancePanelLayer => ({
		kind,
		index,
		paint: l.paint,
		color: vectorPaintToHex(l.paint),
		swatch: vectorPaintSwatch(l.paint),
		gradient: isVectorGradient(l.paint),
		opacity: l.opacity ?? 1,
		blendMode: l.blendMode ?? 'normal',
		visible: l.visible !== false,
		...(kind === 'stroke' ? { strokeWidth: l.strokeWidth ?? 1, strokeAlign: l.strokeAlign ?? 'center' } : {}),
		...((l.kind ?? 'paint') !== 'paint' ? { unknownKind: String(l.kind) } : {}),
		editing: edit.target === kind && (edit.layer === null ? index === count - 1 : edit.layer === index)
	});
	const fills = first ? vectorFills(first) : [];
	const strokes = first ? vectorStrokes(first) : [];
	const same = (get: (p: VectorPathNode) => unknown) => paths.every((p) => JSON.stringify(get(p)) === JSON.stringify(get(first)));
	const one = nodes.length === 1 ? nodes[0] : null;
	return {
		nodeIds: nodes.map((n) => n.id),
		pathIds: paths.map((p) => p.id),
		fills: fills.map((l, i) => layer('fill', l, i, fills.length)),
		strokes: strokes.map((l, i) => layer('stroke', l, i, strokes.length)),
		blendMode: nodes[0].blendMode ?? 'normal',
		mixed: {
			fills: !!first && !same(vectorFills),
			strokes: !!first && !same(vectorStrokes),
			blendMode: nodes.some((n) => (n.blendMode ?? 'normal') !== (nodes[0].blendMode ?? 'normal'))
		},
		filterNodeId: one?.id ?? null,
		filters: (one?.filters ?? []).map((f) => ({
			id: f.id,
			type: f.type,
			label: VECTOR_FILTER_LABELS[f.type] ?? f.type,
			enabled: f.enabled !== false,
			params: f.params as unknown as Record<string, unknown>,
			specs: VECTOR_FILTER_PARAM_SPECS[f.type] ?? []
		}))
	};
}

/** Blend modes in menu order, with their names. */
export const VECTOR_BLEND_MODE_MENU: readonly { mode: VectorBlendMode; label: string }[] = VECTOR_BLEND_MODES.map((mode) => ({ mode, label: VECTOR_BLEND_MODE_LABELS[mode] }));

// ---------------------------------------------------------------------------
// Masks panel
// ---------------------------------------------------------------------------

export const VECTOR_MASK_TYPE_LABELS: Readonly<Record<VectorMaskType, string>> = { clip: 'Clip', alpha: 'Alpha', luminance: 'Luminance' };
/** Mask types for a menu, with a hint each. */
export const VECTOR_MASK_TYPE_OPTIONS: readonly { value: VectorMaskType; label: string; title: string }[] = [
	{ value: 'clip', label: 'Clip', title: 'Clipping mask: the contents show inside the mask\'s outline' },
	{ value: 'luminance', label: 'Luminance', title: 'Opacity mask by brightness: white shows, black hides' },
	{ value: 'alpha', label: 'Alpha', title: 'Opacity mask by opacity: opaque shows, transparent hides' }
];

/** What the mask panel shows for the selection. */
export interface VectorMaskPanelData {
	/** Make Clipping Mask / Make Opacity Mask would work: two or more unlocked objects sharing a parent. */
	canMake: boolean;
	/** Why the make actions are off, for a tooltip (null when they are on). */
	makeHint: string | null;
	/**
	 * The mask group the selection is or is directly inside, with its settings and what of it is
	 * selected (`group` itself, its `mask` or its `contents`); null otherwise.
	 */
	group: (VectorMaskSummary & { id: string; name?: string; editing: 'group' | 'mask' | 'contents' }) | null;
}

/** The mask panel's data for the selection, or null with nothing selected. */
export function getVectorMaskPanel(state: Pick<VectorEditorState, 'document' | 'selection'>): VectorMaskPanelData | null {
	const doc = state.document;
	if (!state.selection.length) return null;
	const locs = state.selection.map((id) => locateVectorNode(doc.nodes, id));
	let makeHint: string | null = null;
	if (state.selection.length < 2) makeHint = 'Select two or more objects: the topmost becomes the mask.';
	else if (locs.some((l) => !l)) makeHint = 'Select objects in the document.';
	else if (locs.some((l) => l!.list[l!.index].locked || l!.list[l!.index].blendStep)) makeHint = 'Unlock the selected objects first.';
	else if (locs.some((l) => (l!.parent?.id ?? null) !== (locs[0]!.parent?.id ?? null))) makeHint = 'Select objects at one level (sharing a parent).';
	let group: VectorMaskPanelData['group'] = null;
	const first = locs[0];
	const node = first ? first.list[first.index] : null;
	const owner = isVectorMaskGroup(node) ? node : isVectorMaskGroup(first?.parent) ? first!.parent : null;
	if (owner && state.selection.every((id) => id === owner.id || owner.children.some((c) => c.id === id))) {
		const summary = vectorMaskSummary(owner)!;
		const editing = state.selection.includes(owner.id) ? 'group' : state.selection.includes(summary.maskId) ? 'mask' : 'contents';
		group = { ...summary, id: owner.id, ...(owner.name ? { name: owner.name } : {}), editing };
	}
	return { canMake: makeHint === null, makeHint, group };
}
