import { HistoryManager } from '../history/HistoryManager.js';
import type { Command } from '../history/types.js';
import { fitCubics } from '../canvas/curveFit.js';
import { pathBoolean } from '../canvas/pathops/boolean.js';
import { pathfinder as runPathfinder } from '../canvas/pathops/pathfinder.js';
import type { PlanarMap } from '../canvas/pathops/planar.js';
import { bezierPathBounds, bezierPathToSvg, transformBezierPath, type BezierPath } from '../canvas/pathops/bezier.js';
import type { Point } from '../canvas/types.js';
import {
	bezierToSubpaths,
	boundsFromPoints,
	boundsIntersect,
	cloneVectorDocument,
	cloneVectorNode,
	collectPathNodes,
	collectPaintedNodes,
	convertAnchor,
	ellipseSubpath,
	findVectorNode,
	hitTestVectorNode,
	hitTestVectorNodes,
	insertAnchor,
	lineSubpath,
	locateVectorNode,
	moveAnchorHandle,
	nearestSegment,
	hasPaint,
	nodeMatrix,
	invertMatrix,
	applyMatrix,
	applyMatrixLinear,
	multiplyMatrices,
	matrixRotation,
	vectorWorldMatrix,
	vectorParentMatrix,
	vectorPathWorldBezier,
	IDENTITY_MATRIX,
	polygonSubpath,
	rectSubpath,
	removeAnchors,
	reverseSubpath,
	rotateMatrix,
	scaleMatrix,
	starSubpath,
	subpathsToBezier,
	transformVectorNode,
	translateAnchor,
	translateMatrix,
	unionBounds,
	vectorNodeBounds,
	walkVectorNodes,
	type AffineMatrix
} from './geometry.js';
import {
	cornerBisectorPoint,
	cornerRadiusChange,
	fitCornerRadius,
	nextVectorCornerKind,
	setAnchorCorner,
	setSubpathCorners,
	vectorCorners,
	type VectorCornerInfo
} from './corners.js';
import { strokeWidthProfileOf, vectorStrokeOutlinePath, vectorStrokeParts } from './stroke.js';
import { nearestStrokePosition, strokePositionPoint } from './varstroke.js';
import {
	generateWidthProfile,
	insertWidthPoint,
	pressureWidthProfile,
	removeWidthPoints,
	reverseWidthProfile,
	sanitizeWidthProfile,
	setWidthPoint,
	widthProfileAt,
	widthProfileMaxScale,
	widthProfilePreset,
	type VectorTaperOptions,
	type VectorWaveOptions,
	type VectorWidthPreset,
	VECTOR_WIDTH_PROFILE_MAX_POINTS,
	VECTOR_WIDTH_SAME_T
} from './width.js';
import { parseVectorSvg, vectorDocumentToSvg, vectorPathLocalBounds, type VectorSvgExportOptions } from './svg.js';
import {
	applyVectorGradientPatch,
	defaultVectorGradient,
	insertVectorGradientStop,
	isVectorGradient,
	sanitizeVectorGradient,
	moveVectorGradientHandle,
	moveVectorGradientStop,
	removeVectorGradientStop,
	setVectorGradientVector,
	sortedVectorGradientStops,
	vectorGradientMidpointFromPosition,
	type VectorGradientHandle,
	type VectorGradientPatch
} from './gradient.js';
import {
	getVectorGradientAnnotator,
	hitVectorGradientAnnotator,
	vectorGradientBarPosition,
	VECTOR_GRADIENT_OFF_BAR,
	VECTOR_GRADIENT_STOP_GAP,
	type VectorGradientAnnotator,
	type VectorGradientPart,
	type VectorGradientTarget
} from './gradientTool.js';
import {
	expandVectorBlend,
	isVectorBlendGroup,
	refreshVectorBlends,
	releaseVectorBlend,
	vectorBlendKeyTargets
} from './blendGroup.js';
import {
	createVectorEffect,
	expandVectorAppearance,
	hasOwnVectorAppearance,
	hasVectorAppearance,
	isVectorLiveBoolean,
	normalizeVectorEffectParams,
	vectorAppearanceOutline,
	vectorEnteredGroups,
	vectorEnvelopeFrame,
	vectorNodeEnvelope,
	vectorInstanceDrawn,
	type VectorEnvelopeParams,
	VECTOR_EFFECT_LABELS
} from './appearance.js';
import { isIdentityMatrix } from '../geom/affine.js';
import { vectorNodesNear } from './spatial.js';
import { isVectorMaskActive, isVectorMaskGroup, isVectorMaskType, vectorMaskedGeometry } from './mask.js';
import {
	isVectorConnector,
	rerouteVectorConnectors,
	routeVectorConnector,
	vectorConnectionSites,
	vectorConnectorTargetAt,
	type VectorConnectionSite
} from './connectors.js';
import { VECTOR_CONNECTOR_ROUTES, VECTOR_CONNECTOR_SIDES, type VectorArrowhead, type VectorConnector, type VectorConnectorEnd, type VectorConnectorRoute, type VectorConnectorSide } from './types.js';
import {
	autoVectorFreeformGradient,
	createVectorMeshGradient,
	isVectorFreeformGradient,
	isVectorMeshGradient,
	isVectorShadedPaint,
	mapVectorShadedPaint,
	removeVectorFreeformPoint,
	sampleVectorFreeform,
	sanitizeVectorShadedPaint,
	vectorFreeformField,
	vectorFreeformSpreadScale,
	vectorRgbaToCss,
	VECTOR_MESH_MAX
} from './shading.js';
import { parseVectorColor } from './gradient.js';
import { parseVectorLottie, vectorDocumentToLottie, type VectorLottieExport, type VectorLottieExportOptions, type VectorLottieImport, type VectorLottieImportOptions } from './lottie.js';
import { traceVectorImage, type VectorTraceOptions, type VectorTracePixels } from './trace.js';
import { pointInBezierPath } from '../canvas/pathops/bezier.js';
import type { VectorFreeformGradient, VectorFreeformPoint, VectorMeshGradient } from './types.js';
import { vectorBoundsInside, isVectorFrame, vectorFrameDocument, type VectorFrameGroup } from './frames.js';
import { VECTOR_HORIZONTAL_RESIZING, VECTOR_VERTICAL_RESIZING, type VectorFrame, type VectorHorizontalResizing, type VectorResizing, type VectorVerticalResizing } from './types.js';
import type { TextShaper } from '../text/types.js';
import { resolveVectorSymbols, stripVectorSymbolArt, vectorSymbolUses } from './symbols.js';
import {
	addVectorConstraint,
	findVectorAnchorById,
	purgeVectorConstraints,
	solveVectorConstraints,
	vectorConstraintDof,
	vectorConstraintEnv,
	VectorConstraintError,
	VECTOR_DIMENSIONAL_KINDS,
	type VectorDofReport
} from './constraints/solve.js';
import { autoConstrainVector, withVectorAnchorIds, type VectorInferOptions } from './constraints/auto.js';
import { checkVectorExpression, isValidVectorParameterName } from './constraints/expr.js';
import {
	DEFAULT_VECTOR_FONT,
	getVectorTextShaper,
	layoutVectorText,
	pathTextFrameFromBezier,
	patchVectorCharacterStyle,
	patchVectorParagraphStyle,
	replaceVectorText,
	sanitizeVectorTextFrame,
	setVectorTextShaper,
	styleVectorText,
	vectorTextCaret,
	vectorTextHasOutlines,
	vectorTextIndexAt,
	vectorTextName,
	vectorTextPaths,
	vectorTextPaintSource,
	vectorTextRange,
	VectorTextError,
	type VectorTextLayout
} from './text.js';
import { applyVectorHomography, vectorHomography, vectorHomographyKeepsQuad } from './perspective.js';
import { distortVectorNode, vectorBoxCorners, vectorDistortQuad, vectorShearForSide, vectorSkewMatrix, VECTOR_DISTORT_TOLERANCE, type VectorDistortMode } from './distort.js';
import {
	dragVectorMeshPoint,
	pullVectorMesh,
	resizeVectorMesh,
	vectorMeshEditPoints,
	vectorMeshFromOutline,
	vectorMeshOutline,
	vectorMeshParamAt
} from './warp.js';
import { constrainToLeave, VECTOR_CONSTRUCTION_ANGLES, VECTOR_MAX_TRACKING_POINTS, VectorSnapTargets, vectorAngleDirection, vectorTrackingPaths, type VectorSnapGuides, type VectorSnapLeave, type VectorTrackingPoint } from './snap.js';
import {
	bendSegment as bendSubpathSegment,
	curvatureMoveAnchor,
	cutSubpathAt,
	joinSubpaths,
	removeAnchorsKeepingShape,
	removeRedundantPoints as removeRedundantSubpathPoints,
	smoothSubpath,
	splitSubpathAt
} from './pathEdit.js';
import { eraseFromFill, eraseFromOutline, eraserRegion, knifePath, polylineBounds, simplifyPolyline } from './pathCut.js';
import { LazyMouse, recognizeInkShape, vectorInkShapeName, type VectorInkShape } from './ink.js';
import {
	addBuilderHit,
	planShapeBuilder,
	samplePolyline,
	vectorFillMap,
	vectorPathEntries,
	vectorPathfinderShape,
	vectorResultStyle,
	vectorBuilderErasedEdges,
	vectorShapeBuilderHit,
	vectorShapeBuilderMap,
	type VectorBuilderTouched,
	type VectorShapeBuilderMap
} from './builder.js';
import { VECTOR_BLEND_MODES, type VectorBlendMode, type VectorFilter, type VectorFilterType, type VectorGradient, type VectorPaintLayer, type VectorStrokeLayer, type VectorWarpMesh } from './types.js';
import {
	isVectorBlendMode,
	newVectorStrokeLayer,
	normalizeVectorPaintStacks,
	VECTOR_STROKE_SETTING_KEYS,
	sanitizeVectorFills,
	sanitizeVectorStrokeSettings,
	sanitizeVectorStrokes,
	vectorFills,
	vectorPaintLayerNodes,
	vectorStrokes,
	vectorTargetPaint,
	withVectorFills,
	withVectorStrokes,
	withVectorTargetPaint
} from './paintLayers.js';
import { createVectorFilter, isVectorFilterType, normalizeVectorFilterParams, VECTOR_FILTER_LABELS } from './filters.js';
import type {
	Vec2,
	VectorEffect,
	VectorEffectType,
	VectorAlign,
	VectorAnchor,
	VectorAnchorRef,
	VectorAnchorType,
	VectorArrange,
	VectorAverageAxis,
	VectorBlend,
	VectorBlendOptions,
	VectorBooleanOperation,
	VectorBounds,
	VectorCornerKind,
	VectorDefaults,
	VectorDistribute,
	VectorDocument,
	VectorGroupNode,
	VectorHandleRef,
	VectorMask,
	VectorMaskType,
	VectorModifiers,
	VectorNode,
	VectorPathfinderOperation,
	VectorPathNode,
	VectorSegmentRef,
	VectorStyle,
	VectorSubpath,
	VectorTool,
	VectorTransformHandle,
	VectorViewport,
	VectorWidthPoint,
	VectorCharacterStyle,
	VectorParagraphStyle,
	VectorTextAlign,
	VectorTextFrame,
	VectorTextNode,
	VectorMatrix,
	VectorSymbol,
	VectorInstanceNode,
	VectorInstanceOverrides,
	VectorPaint,
	VectorConstraint,
	VectorConstraintKind,
	VectorGeomRef,
	VectorParameter
} from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VectorSnapOptions {
	/** Grid size in document units (0 = off, default 0). Points and boxes that snap to no object snap to it. */
	grid: number;
	/**
	 * Snap to other objects (default true): anchors, paths and their intersections, bounding-box
	 * edges and centres, the artboard, construction angles, equal spacing and matching sizes.
	 */
	objects: boolean;
	/** Show smart guide lines and labels while snapping (default true). */
	guides: boolean;
	/** How near a target pulls, in screen pixels (default 5). */
	threshold: number;
	/** Construction guide angles through the point a drawn point leaves from, in degrees (default 0, 45, 90, 135). Polar tracking: see `vectorPolarAngles`. */
	angles: readonly number[];
	/**
	 * Object snap tracking (default true): resting the pointer on an anchor, centre or crossing
	 * while drawing acquires it (again releases it); acquired points send alignment paths, an open
	 * path's end its extension, and points snap where paths cross, cross the drawing or onto them.
	 */
	tracking?: boolean;
	/** Acquired points send paths along every polar angle (`angles`) instead of only horizontal and vertical (default false). */
	trackPolar?: boolean;
	/** The pen measures polar angles from its last segment's direction instead of the page's x axis (default false). */
	polarRelative?: boolean;
}

/** Snap options new editors start with. Hold Cmd / Ctrl (`mod`) during a drag to bypass snapping. */
export const DEFAULT_VECTOR_SNAP: Readonly<VectorSnapOptions> = { grid: 0, objects: true, guides: true, threshold: 5, angles: VECTOR_CONSTRUCTION_ANGLES, tracking: true, trackPolar: false, polarRelative: false };

/** How path-editing gestures and the pencil, knife and eraser behave. */
export interface VectorPathEditOptions {
	/**
	 * Deleting anchors refits the neighbouring handles so the shape stays (default true). Off,
	 * the neighbours are joined with their handles as they are.
	 */
	keepShapeOnDelete: boolean;
	/**
	 * Dragging one anchor with the direct tool bends its two segments like the Curvature tool,
	 * keeping the segments beyond still (default false). Alt held during the drag flips it.
	 */
	curvatureMoves: boolean;
	/** Pencil lazy-mouse smoothing, 0–1: the pulled string is up to 100 screen pixels long (default 0, off). */
	pencilSmoothing: number;
	/** Pencil strokes that look like a line, rectangle, ellipse or polygon become that shape (default false). */
	recognizeShapes: boolean;
	/** Eraser diameter in document units (default 10). */
	eraserSize: number;
	/**
	 * Record pointer pressure on pencil strokes as a width profile: `pen` (default) for pen input
	 * only, `all` for any pointer that reports pressure, `off` never.
	 */
	pencilPressure: 'pen' | 'all' | 'off';
	/**
	 * Paint bucket: gaps up to this distance (document units) between loose ends of outlines are
	 * closed when finding the region to fill (default 0, off).
	 */
	fillGap: number;
}

/** The gap the toolbars' "Close gaps" toggle sets (document units). */
export const VECTOR_FILL_GAP = 6;

/** Path-editing options new editors start with. */
export const DEFAULT_VECTOR_PATH_EDIT: Readonly<VectorPathEditOptions> = {
	keepShapeOnDelete: true,
	curvatureMoves: false,
	pencilSmoothing: 0,
	recognizeShapes: false,
	eraserSize: 10,
	pencilPressure: 'pen',
	fillGap: 0
};

/** Longest pencil lazy-mouse string (at smoothing 1), in screen pixels. */
export const VECTOR_PENCIL_STRING_PX = 100;

export interface VectorEditorOptions {
	document?: VectorDocument;
	/** History to record into, e.g. one shared with the rest of the app (default: a new one). */
	history?: HistoryManager;
	/** Starting tool (default `select`). */
	tool?: VectorTool;
	/** Style and settings for new shapes and paths. */
	defaults?: VectorDefaults;
	viewport?: Partial<VectorViewport>;
	snap?: Partial<VectorSnapOptions>;
	editing?: Partial<VectorPathEditOptions>;
	/** Pick distance for anchors, handles and outlines in screen pixels (default 6). */
	hitRadius?: number;
	/** Id factory for new nodes. */
	createId?: () => string;
	/** Called after the document changes (edits, undo, redo, load). */
	onChange?: (document: VectorDocument) => void;
	/** Start in Free Distort mode (see `setFreeDistort`). */
	freeDistort?: boolean;
	/**
	 * The text shaper text nodes lay out with (see `setVectorTextShaper`; it is shared by every
	 * editor on the page). Default: the browser's fonts, or estimated metrics outside a browser.
	 */
	textShaper?: TextShaper | null;
	/** Font and alignment new text gets (default 24 px sans-serif, left). */
	textDefaults?: Partial<VectorTextDefaults>;
}

/** Font and alignment of new text. */
export interface VectorTextDefaults extends VectorCharacterStyle {
	align?: VectorTextAlign;
}

/** Text to add (`addText`): point text at (`x`, `y`), area text with `width` and `height`, or text on `path`. */
export interface VectorTextInput extends VectorStyle {
	text: string;
	/** Point text: the first baseline's start; area text: the box's top left. */
	x?: number;
	y?: number;
	/** Area text: the box (both needed). */
	width?: number;
	height?: number;
	/** Text on a path: SVG path data or a subpath (document units); `x`, `y`, `width` and `height` are then ignored. */
	path?: string | VectorSubpath;
	/** Text on a path: margins from the path's start and end, side, orientation and baseline. */
	pathOptions?: Omit<Extract<VectorTextFrame, { kind: 'path' }>, 'kind' | 'path'>;
	font?: Partial<VectorCharacterStyle>;
	paragraph?: VectorParagraphStyle;
	name?: string;
}

/** A constraint reference from loose input: an anchor by `subpath` / `index` (or its `id` as `anchor`), its handle, its segment, or a path as a circle. */
export interface VectorConstraintRefInput {
	nodeId: string;
	subpath?: number;
	index?: number;
	anchor?: string;
	handle?: 'in' | 'out';
	segment?: boolean;
	circle?: boolean;
}

/** A constraint to add (`addConstraint`). */
export interface VectorConstraintInput {
	kind: VectorConstraintKind;
	refs: VectorConstraintRefInput[];
	value?: string | number;
	name?: string;
	axis?: 'aligned' | 'horizontal' | 'vertical';
}

/** The text being edited on the canvas: the node and the selection in UTF-16 code units (`anchor` where it started, `focus` the caret). */
export interface VectorTextEditState {
	nodeId: string;
	anchor: number;
	focus: number;
}

/** A pointer event as the controller needs it. Positions are in screen pixels relative to the canvas. */
export interface VectorPointerInput extends VectorModifiers {
	/** 0 = primary, 1 = middle (pans), 2 = secondary. Default 0. */
	button?: number;
	/** `PointerEvent.pressure` (0–1), recorded on pencil strokes. */
	pressure?: number;
	/** `PointerEvent.pointerType` (`mouse`, `pen`, `touch`). */
	pointerType?: string;
}

/** One width point of a path's stroke profile; `subpath` is the subpath it is shown on. */
export interface VectorWidthPointRef {
	nodeId: string;
	index: number;
	subpath: number;
}

/** A spot on a stroke (width tool): where a drag would add a width point. Positions in document units. */
export interface VectorStrokeSpot {
	nodeId: string;
	subpath: number;
	/** Position along the subpath by length, 0–1. */
	t: number;
	point: Vec2;
	/** Ends of the stroke's width across the path there. */
	left: Vec2;
	right: Vec2;
}

/**
 * The width point being edited numerically (double-click with the width tool): `index` is the
 * point's, or null for a new point at `t` (a double-click on a stroke away from its points).
 * `left` / `right` are side widths in document units (how far the stroke reaches on each side),
 * `point` is where it sits on the path, in document space.
 */
export interface VectorWidthPointEdit {
	nodeId: string;
	subpath: number;
	index: number | null;
	t: number;
	left: number;
	right: number;
	point: Vec2;
}

/** A key press as the controller needs it. */
export interface VectorKeyInput extends VectorModifiers {
	/** `KeyboardEvent.key`. */
	key: string;
}

/** What the pointer is over. */
export interface VectorHover {
	nodeId: string | null;
	anchor?: VectorAnchorRef;
	handle?: VectorHandleRef;
	/** A segment under the pointer (direct tool and scissors); `point` is in document space. */
	segment?: { nodeId: string; subpath: number; segment: number; t: number; point: Vec2 };
	transformHandle?: VectorTransformHandle;
	/** A live corner widget (direct tool): the corner's anchor. */
	corner?: VectorAnchorRef;
	/** A width point (width tool): its centre or the end of its left / right side. */
	widthPoint?: VectorWidthPointRef & { part: 'center' | 'left' | 'right' };
	/** A spot on a stroke away from its width points (width tool). */
	strokeSpot?: VectorStrokeSpot;
	/** A part of the gradient annotator (gradient tool). */
	gradient?: VectorGradientPart;
	/** A control point of the selected envelope's mesh (`index`), or a spot inside it (`index` null): Envelope tool. */
	envelope?: { nodeId: string; index: number | null };
}

/** The drag in progress, for overlays and status text. */
export type VectorInteraction =
	| { type: 'marquee'; bounds: VectorBounds }
	| { type: 'move'; dx: number; dy: number }
	| { type: 'scale'; handle: VectorTransformHandle; sx: number; sy: number }
	| { type: 'rotate'; angle: number }
	| { type: 'anchors'; dx: number; dy: number }
	| { type: 'handle'; ref: VectorHandleRef }
	| { type: 'bend'; ref: VectorSegmentRef }
	| { type: 'corner'; ref: VectorAnchorRef; radius: number }
	| { type: 'draw'; tool: VectorTool; nodeId: string; bounds: VectorBounds; string?: [Vec2, Vec2] }
	| { type: 'stroke'; tool: 'knife' | 'eraser'; points: Vec2[]; width: number }
	| { type: 'builder'; mode: 'merge' | 'erase'; points: Vec2[] }
	| { type: 'width'; ref: VectorWidthPointRef; mode: 'width' | 'move' | 'copy'; width: number }
	| { type: 'pen'; nodeId: string }
	/** A gradient tool drag: drawing a new vector, or a handle, stop, midpoint or the bar (`removing`: a stop dragged off the bar). */
	| { type: 'gradient'; part: 'create' | VectorGradientPart['kind']; handle?: VectorGradientHandle; removing?: boolean }
	/** Free Distort: the selection box's corners as dragged so far (document space, clockwise from the top left). */
	| { type: 'distort'; mode: VectorDistortMode | 'skew'; corners: Vec2[] }
	/** Envelope tool: a mesh point (`index`) or the surface (`index` null) being dragged. */
	| { type: 'envelope'; nodeId: string; index: number | null }
	/** The Type tool dragging out an area text box (document space). */
	| { type: 'textBox'; bounds: VectorBounds }
	/** Selecting text by dragging over it. */
	| { type: 'textSelect'; nodeId: string }
	| { type: 'pan' };

/** A snapshot of the editor. The same object is returned until something changes. */
export interface VectorEditorState {
	document: VectorDocument;
	tool: VectorTool;
	/** Selected node ids (top-level nodes or group members picked with the direct tool). */
	selection: readonly string[];
	/** Selected anchors (direct tool). */
	selectedAnchors: readonly VectorAnchorRef[];
	/** The selected width points (width tool, all on one path); Delete removes them. */
	selectedWidthPoints: readonly VectorWidthPointRef[];
	/** The width point open for numeric editing (double-click with the width tool), if any. */
	widthPointEdit: VectorWidthPointEdit | null;
	/** The path whose anchors are being edited, if any. */
	editingId: string | null;
	/** Axis-aligned bounds of the selected nodes in document units. */
	selectionBounds: VectorBounds | null;
	/** The selection box, rotated with the selection when its nodes share a rotation. */
	selectionFrame: VectorSelectionFrame | null;
	viewport: VectorViewport;
	defaults: Readonly<Required<Pick<VectorDefaults, 'polygonSides' | 'starPoints' | 'starInnerRatio' | 'cornerRadius'>> & Pick<VectorDefaults, 'cornerKind'> & VectorStyle>;
	snap: VectorSnapOptions;
	editing: VectorPathEditOptions;
	/** Smart guides of the snap in progress, in document units (null when there are none). */
	guides: VectorSnapGuides | null;
	hitRadius: number;
	hover: VectorHover | null;
	/** A CSS cursor for the canvas. */
	cursor: string;
	interaction: VectorInteraction | null;
	/** The path the pen tool is adding to. */
	pen: { nodeId: string; subpath: number } | null;
	/** Last pointer position in document units (for the pen preview), or null when outside. */
	pointer: Vec2 | null;
	/** Shape Builder and paint bucket highlight: faces, line pieces and the gesture's trail. */
	builder: VectorBuilderPreview | null;
	/** The Blend tool's first click: the shape (and anchor of its first subpath) the next click blends from. */
	blendStart: VectorBlendStart | null;
	/** Options new blends get. */
	blendDefaults: VectorBlendOptions;
	/** The paint the gradient tool and gradient editor work on, and the selected stop (index into the sorted stops). */
	/** The paint the gradient tool and editor work on: `target`, and `layer` of its stack (null: the top layer, through the shorthand). */
	gradientEdit: { target: VectorGradientTarget; stop: number | null; layer: number | null };
	/**
	 * Free Distort mode of the selection box: dragging a corner distorts in perspective (each corner
	 * on its own; Shift+Alt+Mod: symmetric perspective), a side moves its two corners, and Mod-dragging
	 * a side skews along it (Alt: about the centre).
	 */
	freeDistort: boolean;
	/** The text being edited on the canvas, or null. Typing goes to `textInput`, keys to `keyDown`. */
	textEdit: VectorTextEditState | null;
	/** Font and alignment new text gets. */
	textDefaults: VectorTextDefaults;
	/**
	 * Isolation mode: `document` is then the art of symbol `symbolId`, in the symbol's own space.
	 * `host` is the whole document with that art (draw it dimmed behind, through `hostTransform`,
	 * which lines the instance it was entered from up with the art).
	 */
	symbolEdit: { symbolId: string; name: string; instanceId: string | null; host: VectorDocument; hostTransform: VectorMatrix | null } | null;
	/** Constraints the last solve could not satisfy (`conflicts`) or interpret (`skipped`), or null when all hold. */
	constraintIssues: { conflicts: string[]; skipped: { id: string; message: string }[] } | null;
	/** Points acquired for object snap tracking (document units), oldest first. */
	trackingPoints: readonly VectorTrackingPoint[];
	/** A distance or coordinate being typed while the pen draws (Enter places the point), or null. */
	typedEntry: string | null;
	/** The selected point of a mesh or freeform fill (Gradient tool), or null. */
	shadingPoint: { nodeId: string; index: number; kind: 'mesh' | 'freeform' } | null;
	canUndo: boolean;
	canRedo: boolean;
	undoLabel: string;
	redoLabel: string;
	/** Bumped on every change. */
	revision: number;
}

export type VectorActionResult = { ok: true } | { ok: false; message: string };

/** What Make Clipping Mask / Make Opacity Mask return: the new group's id, or why not. */
export type VectorMaskResult = { ok: true; id: string } | { ok: false; message: string };

/** A connector as `getConnectors` lists it. */
export interface VectorConnectorListing {
	id: string;
	name?: string;
	route: VectorConnectorRoute;
	radius?: number;
	/** Each end: the glued object, its side setting and the side in use, and where the end is (document units). */
	start: { nodeId?: string; side?: VectorConnectorSide; resolvedSide?: string | null; x?: number; y?: number };
	end: { nodeId?: string; side?: VectorConnectorSide; resolvedSide?: string | null; x?: number; y?: number };
}

/** A frame as `getFrames` lists it. */
export interface VectorFrameListing {
	id: string;
	name: string;
	/** The group holding it (null for an artboard: a top-level frame). */
	parentId: string | null;
	artboard: boolean;
	/** Its rectangle in its own space, fill and clip. */
	frame: VectorFrame;
	/** Its rectangle in document space (axis-aligned). */
	bounds: VectorBounds | null;
	/** Its children, bottom to top, with their resizing constraints. */
	children: { id: string; type: VectorNode['type']; name?: string; horizontal: VectorHorizontalResizing; vertical: VectorVerticalResizing }[];
}

/** The shape the Blend tool blends from (its first click). */
export interface VectorBlendStart {
	nodeId: string;
	/** The clicked anchor of its first subpath, or null for the shape as a whole. */
	anchor: number | null;
}

/** Blend settings and options of `VectorEditorController.blend`. */
export interface VectorBlendInput extends VectorBlendOptions {
	/** Nodes to blend (default: the selection), in stacking order unless `keepOrder`. */
	ids?: readonly string[];
	/** Blend in the order given instead of stacking order. */
	keepOrder?: boolean;
	/** Start anchor of each key's first subpath, by key id. */
	starts?: Record<string, number>;
	name?: string;
}

const BLEND_OPTION_KEYS = ['spacing', 'steps', 'distance', 'orientToSpine', 'linear'] as const;

/** The blend options in `input`, valid ones only. */
function blendOptionsOf(input: Partial<VectorBlendOptions>): VectorBlendOptions {
	const out: VectorBlendOptions = {};
	if (input.spacing === 'steps' || input.spacing === 'distance' || input.spacing === 'smoothColor') out.spacing = input.spacing;
	if (typeof input.steps === 'number' && Number.isFinite(input.steps)) out.steps = Math.min(1000, Math.max(1, Math.round(input.steps)));
	if (typeof input.distance === 'number' && Number.isFinite(input.distance) && input.distance > 0) out.distance = input.distance;
	if (typeof input.orientToSpine === 'boolean') out.orientToSpine = input.orientToSpine;
	if (typeof input.linear === 'boolean') out.linear = input.linear;
	return out;
}

/**
 * What the Shape Builder or paint bucket highlights, in document units: the faces (filled paths
 * as SVG path data) under the pointer or touched by the drag, the line pieces an erase would
 * delete, and the drag's trail. `mode` is `merge`, `erase` (Alt) or `fill` (paint bucket).
 */
export interface VectorBuilderPreview {
	mode: 'merge' | 'erase' | 'fill';
	faces: BezierPath[];
	lines: BezierPath[];
	trail: Vec2[] | null;
}

/** Result of a Shape Builder gesture. */
export interface VectorShapeBuilderResult {
	ok: boolean;
	message?: string;
	/** Id of the merged shape (none when erasing). */
	merged: string | null;
	faces: number;
	lines: number;
	/** Outline edges erased (cut out of the paths they lie on). */
	edges: number;
}

/** A face of the Shape Builder map (document units). */
export interface VectorShapeBuilderFace {
	index: number;
	/** SVG path data. */
	d: string;
	area: number;
	/** Ids of the paths whose fill covers it, bottom to top (empty for an area only outlines enclose). */
	sources: string[];
	/** A point inside it. */
	point: Vec2 | null;
}

export interface AddVectorNodeOptions {
	/** Group to add into (default: the root). */
	parentId?: string;
	/** Position in the parent's list (default: on top). */
	index?: number;
	/** Select the new node (default true). */
	select?: boolean;
	/** Undo step label. */
	label?: string;
}

/** A shape description for `addShape` (and the agent command of the same name). */
export interface VectorShapeInput extends VectorStyle {
	kind: 'rect' | 'ellipse' | 'polygon' | 'star' | 'line';
	x: number;
	y: number;
	width: number;
	height: number;
	/** Live corner radius of a rectangle, polygon or star (default: the editor default). */
	cornerRadius?: number;
	cornerKind?: VectorCornerKind;
	sides?: number;
	points?: number;
	innerRatio?: number;
	name?: string;
}

/** Every field of `VectorStyle`, in the order style panels and commands list them. */
export const VECTOR_STYLE_KEYS = [
	'fill',
	'stroke',
	'strokeWidth',
	'strokeLinecap',
	'strokeLinejoin',
	'strokeDasharray',
	'fillRule',
	'strokeAlign',
	'startArrow',
	'endArrow',
	'arrowAlign',
	'startArrowScale',
	'endArrowScale',
	'strokeWidthProfile',
	'fills',
	'strokes'
] as const satisfies readonly (keyof VectorStyle)[];

/** Clipboard payload type written by `copy()`. */
export const VECTOR_CLIPBOARD_TYPE = 'pixerate/vector';

const DEFAULT_DEFAULTS = {
	fill: '#d4d4d8',
	stroke: '#18181b',
	strokeWidth: 2,
	polygonSides: 6,
	starPoints: 5,
	starInnerRatio: 0.5,
	cornerRadius: 0
};

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 64;
/** Screen distance of the rotation handle above the selection box. */
export const VECTOR_ROTATE_HANDLE_OFFSET = 24;

// ---------------------------------------------------------------------------
// Helpers shared with the render module
// ---------------------------------------------------------------------------

const sameRef = (a: VectorAnchorRef, b: VectorAnchorRef) => a.nodeId === b.nodeId && a.subpath === b.subpath && a.index === b.index;

/** Ids of the path nodes whose anchors are shown (the edited path plus selected paths). */
export function getEditablePathIds(state: Pick<VectorEditorState, 'document' | 'selection' | 'editingId' | 'tool' | 'pen'>): string[] {
	if (state.tool !== 'direct' && state.tool !== 'pen') return [];
	const ids = new Set<string>();
	if (state.pen) ids.add(state.pen.nodeId);
	if (state.tool === 'direct') {
		if (state.editingId) ids.add(state.editingId);
		for (const id of state.selection) {
			const node = findVectorNode(state.document.nodes, id);
			if (node && !node.locked) for (const p of collectPathNodes(node)) if (!p.locked) ids.add(p.id);
		}
	}
	return [...ids].filter((id) => findVectorNode(state.document.nodes, id)?.type === 'path');
}

/** Every anchor drawn on the canvas. */
export function getVisibleAnchors(state: Pick<VectorEditorState, 'document' | 'selection' | 'editingId' | 'tool' | 'pen'>): VectorAnchorRef[] {
	const out: VectorAnchorRef[] = [];
	for (const id of getEditablePathIds(state)) {
		const node = findVectorNode(state.document.nodes, id) as VectorPathNode;
		node.subpaths.forEach((sp, s) => sp.anchors.forEach((_, i) => out.push({ nodeId: id, subpath: s, index: i })));
	}
	return out;
}

/**
 * Handles drawn on the canvas: those of selected anchors and of the segments next to them
 * (direct tool), or of the last anchor of the pen path.
 */
export function getVisibleHandles(
	state: Pick<VectorEditorState, 'document' | 'selection' | 'editingId' | 'tool' | 'pen' | 'selectedAnchors'>
): VectorHandleRef[] {
	const out: VectorHandleRef[] = [];
	const seen = new Set<string>();
	const push = (node: VectorPathNode, s: number, i: number, handle: 'in' | 'out') => {
		const sp = node.subpaths[s];
		const a = sp?.anchors[i];
		if (!a || !a[handle]) return;
		const key = `${node.id}:${s}:${i}:${handle}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ nodeId: node.id, subpath: s, index: i, handle });
	};
	if (state.tool === 'pen' && state.pen) {
		const node = findVectorNode(state.document.nodes, state.pen.nodeId);
		const sp = node?.type === 'path' ? node.subpaths[state.pen.subpath] : undefined;
		if (node?.type === 'path' && sp) {
			const last = sp.anchors.length - 1;
			push(node, state.pen.subpath, last, 'in');
			push(node, state.pen.subpath, last, 'out');
		}
		return out;
	}
	if (state.tool !== 'direct') return out;
	const editable = new Set(getEditablePathIds(state));
	for (const ref of state.selectedAnchors) {
		if (!editable.has(ref.nodeId)) continue;
		const node = findVectorNode(state.document.nodes, ref.nodeId) as VectorPathNode;
		const sp = node.subpaths[ref.subpath];
		if (!sp) continue;
		const n = sp.anchors.length;
		push(node, ref.subpath, ref.index, 'in');
		push(node, ref.subpath, ref.index, 'out');
		const prev = ref.index > 0 ? ref.index - 1 : sp.closed ? n - 1 : -1;
		const next = ref.index < n - 1 ? ref.index + 1 : sp.closed ? 0 : -1;
		if (prev >= 0) push(node, ref.subpath, prev, 'out');
		if (next >= 0) push(node, ref.subpath, next, 'in');
	}
	return out;
}

/** Live corner widgets sit at least this far inside their corner (screen px along each side of a right angle). */
export const VECTOR_CORNER_WIDGET_INSET = 10;

/** A live corner widget of the direct tool: drag it to round the corners, Alt-click to change their kind. */
export interface VectorCornerWidget {
	ref: VectorAnchorRef;
	/** Document position of the widget. */
	x: number;
	y: number;
	/** The radius stored on the anchor and the radius drawn (no larger than fits). */
	radius: number;
	drawnRadius: number;
	kind: VectorCornerKind;
	/** The corner in its node's own space. */
	corner: VectorCornerInfo;
}

/**
 * The live corner widgets the direct tool shows: on each editable path, at its selected corner
 * anchors (or at every corner when none of its anchors is selected). Corners whose sides are
 * shorter than three insets on screen hide theirs. Dragging one sets the radius of all of them.
 * Ported from ArtCraft vectorcraft `crates/tools/src/corners.rs` (MIT OR Apache-2.0, see
 * THIRD_PARTY_NOTICES.md), as is the `corner` drag below.
 */
export function getVectorCornerWidgets(
	state: Pick<VectorEditorState, 'document' | 'selection' | 'editingId' | 'tool' | 'pen' | 'selectedAnchors' | 'viewport'>
): VectorCornerWidget[] {
	if (state.tool !== 'direct' || state.pen) return [];
	const zoom = state.viewport.zoom;
	const out: VectorCornerWidget[] = [];
	for (const id of getEditablePathIds(state)) {
		const node = findVectorNode(state.document.nodes, id) as VectorPathNode;
		const picked = state.selectedAnchors.filter((r) => r.nodeId === id);
		const m = vectorWorldMatrix(state.document.nodes, id) ?? IDENTITY_MATRIX;
		for (const c of vectorCorners(node.subpaths)) {
			if (picked.length && !picked.some((r) => r.subpath === c.subpath && r.index === c.index)) continue;
			const side = Math.min(c.lu, c.lv);
			if (side * zoom < 3 * VECTOR_CORNER_WIDGET_INSET) continue;
			const a = node.subpaths[c.subpath].anchors[c.index];
			const radius = a.corner?.radius ?? 0;
			const drawn = fitCornerRadius(c, radius);
			// On the bisector at the centre of the arc as drawn, at least the inset in and at most half the shorter side.
			const k = Math.min(Math.max(drawn / c.sin, VECTOR_CORNER_WIDGET_INSET / (zoom * Math.sqrt(1 + c.cos))), side / 2);
			const p = applyMatrix(m, cornerBisectorPoint(c, k));
			out.push({ ref: { nodeId: id, subpath: c.subpath, index: c.index }, x: p.x, y: p.y, radius, drawnRadius: drawn, kind: a.corner?.kind ?? 'round', corner: c });
		}
	}
	return out;
}

/**
 * The line a path's stroke follows (node space; shortened under `tip` arrowheads) and the
 * distance a side scale of 1 reaches from it (half the drawn width: twice the stroke width for
 * inside / outside strokes). Null for paths without a visible stroke.
 */
export function vectorStrokeWidthGeometry(node: VectorPathNode): { line: BezierPath; unit: number } | null {
	if (!hasPaint(node.stroke) || !((node.strokeWidth ?? 1) > 0)) return null;
	const parts = vectorStrokeParts(subpathsToBezier(node.subpaths), node);
	return parts.line.length ? { line: parts.line, unit: parts.drawWidth / 2 } : null;
}

/** A width point of the width tool, in document units. */
export interface VectorWidthHandle {
	ref: VectorWidthPointRef;
	/** The point on the path. */
	x: number;
	y: number;
	/** Ends of its left and right sides. */
	left: Vec2;
	right: Vec2;
	t: number;
	/** Side scales (multiples of half the stroke width). */
	leftScale: number;
	rightScale: number;
	selected: boolean;
}

/**
 * Moves the points at `indices` of `profile` by `dt` along the path (kept in 0–1) and re-sorts
 * it (stably, so steps keep their order); `renumber` maps each old index to its new one.
 */
function shiftWidthPoints(profile: readonly VectorWidthPoint[], indices: readonly number[], dt: number): { points: VectorWidthPoint[]; renumber: Map<number, number> } {
	const moving = new Set(indices);
	const tagged = profile.map((p, i) => ({ p: moving.has(i) ? { ...p, t: Math.min(Math.max(p.t + dt, 0), 1) } : { ...p }, i }));
	tagged.sort((a, b) => a.p.t - b.p.t || a.i - b.i);
	return { points: tagged.map((x) => x.p), renumber: new Map(tagged.map((x, k) => [x.i, k])) };
}

/**
 * The width points the width tool shows: every profile point on every subpath of the stroke
 * under the pointer, the selected paths and the stroke being edited. Ported from ArtCraft
 * vectorcraft `crates/tools/src/distort/width.rs` (MIT OR Apache-2.0, see
 * THIRD_PARTY_NOTICES.md), as are the `width` drag and hover below.
 */
export function getVectorWidthHandles(
	state: Pick<VectorEditorState, 'document' | 'selection' | 'tool' | 'hover' | 'interaction' | 'selectedWidthPoints'>
): VectorWidthHandle[] {
	if (state.tool !== 'width') return [];
	const ids = new Set<string>();
	for (const id of state.selection) {
		const n = findVectorNode(state.document.nodes, id);
		if (n) for (const p of collectPathNodes(n)) ids.add(p.id);
	}
	if (state.hover?.nodeId) ids.add(state.hover.nodeId);
	if (state.interaction?.type === 'width') ids.add(state.interaction.ref.nodeId);
	for (const r of state.selectedWidthPoints) ids.add(r.nodeId);
	const out: VectorWidthHandle[] = [];
	for (const id of ids) {
		const node = findVectorNode(state.document.nodes, id);
		if (node?.type !== 'path' || node.visible === false || !node.strokeWidthProfile?.length) continue;
		const g = vectorStrokeWidthGeometry(node);
		if (!g) continue;
		const profile = sanitizeWidthProfile(node.strokeWidthProfile);
		const m = vectorWorldMatrix(state.document.nodes, id) ?? IDENTITY_MATRIX;
		const contours = node.subpaths.length;
		for (let sp = 0; sp < contours; sp++) {
			profile.forEach((w, index) => {
				const at = strokePositionPoint(g.line, sp, w.t);
				if (!at) return;
				const n = { x: at.tangent[1], y: -at.tangent[0] };
				const c = { x: at.point[0], y: at.point[1] };
				const p = applyMatrix(m, c);
				const l = applyMatrix(m, { x: c.x + n.x * w.left * g.unit, y: c.y + n.y * w.left * g.unit });
				const r = applyMatrix(m, { x: c.x - n.x * w.right * g.unit, y: c.y - n.y * w.right * g.unit });
				out.push({
					ref: { nodeId: id, index, subpath: sp },
					x: p.x,
					y: p.y,
					left: l,
					right: r,
					t: w.t,
					leftScale: w.left,
					rightScale: w.right,
					selected: state.selectedWidthPoints.some((r) => r.nodeId === id && r.index === index)
				});
			});
		}
	}
	return out;
}

/** Looks up an anchor (positions in its node's own space). */
export function getAnchor(doc: VectorDocument, ref: VectorAnchorRef): VectorAnchor | undefined {
	const node = findVectorNode(doc.nodes, ref.nodeId);
	return node?.type === 'path' ? node.subpaths[ref.subpath]?.anchors[ref.index] : undefined;
}

/** An anchor with its position and handles in document space (its node's transforms applied). */
export function getAnchorWorld(doc: VectorDocument, ref: VectorAnchorRef): { x: number; y: number; in?: Vec2; out?: Vec2; type?: VectorAnchorType } | undefined {
	const a = getAnchor(doc, ref);
	if (!a) return undefined;
	const m = vectorWorldMatrix(doc.nodes, ref.nodeId) ?? IDENTITY_MATRIX;
	const p = applyMatrix(m, a);
	return { x: p.x, y: p.y, ...(a.in ? { in: applyMatrix(m, a.in) } : {}), ...(a.out ? { out: applyMatrix(m, a.out) } : {}), ...(a.type ? { type: a.type } : {}) };
}

/**
 * The selection box: `angle` is the shared rotation of the selected nodes (0 when they
 * differ), `x / y / width / height` the bounds in the box's own frame (document space
 * rotated by −angle). A frame point `q` is at `rotateMatrix(angle)` applied to `q`.
 */
export interface VectorSelectionFrame {
	x: number;
	y: number;
	width: number;
	height: number;
	angle: number;
}

/** The selection frame of nodes `ids` (see `VectorSelectionFrame`), or null when they have no points. */
export function getVectorSelectionFrame(doc: VectorDocument, ids: readonly string[]): VectorSelectionFrame | null {
	const nodes = ids.map((id) => ({ node: findVectorNode(doc.nodes, id), parent: vectorParentMatrix(doc.nodes, id) ?? IDENTITY_MATRIX })).filter((n) => n.node);
	if (!nodes.length) return null;
	const angles = nodes.map((n) => matrixRotation(multiplyMatrices(nodeMatrix(n.node!), n.parent)));
	const same = angles.every((a) => Math.abs(normalizeAngle(a - angles[0])) < 1e-6);
	const angle = same ? angles[0] : 0;
	const unrotate = rotateMatrix(-angle);
	const b = unionBounds(nodes.map((n) => vectorNodeBounds(n.node!, multiplyMatrices(n.parent, unrotate))));
	return b ? { ...b, angle } : null;
}

const normalizeAngle = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Screen positions of the selection box handles for a box given in screen pixels. */
export function getTransformHandlePositions(box: VectorBounds): { handle: VectorTransformHandle; x: number; y: number }[] {
	const { x, y, width: w, height: h } = box;
	return [
		{ handle: 'nw', x, y },
		{ handle: 'n', x: x + w / 2, y },
		{ handle: 'ne', x: x + w, y },
		{ handle: 'e', x: x + w, y: y + h / 2 },
		{ handle: 'se', x: x + w, y: y + h },
		{ handle: 's', x: x + w / 2, y: y + h },
		{ handle: 'sw', x, y: y + h },
		{ handle: 'w', x, y: y + h / 2 },
		{ handle: 'rotate', x: x + w / 2, y: y - VECTOR_ROTATE_HANDLE_OFFSET }
	];
}

/**
 * Screen geometry of a selection box. `box` and each handle's `x / y` are the unrotated box
 * in screen pixels; draw them inside a group with `transform` (a `rotate(angle cx cy)`),
 * or use `screen` for the true on-screen positions (hit-testing).
 */
export interface VectorSelectionBoxGeometry {
	box: VectorBounds;
	angle: number;
	transform: string;
	handles: { handle: VectorTransformHandle; x: number; y: number; screen: Vec2 }[];
	/** The four corners on screen, clockwise from the top left. */
	corners: Vec2[];
}

export function getVectorSelectionBoxGeometry(frame: VectorSelectionFrame, viewport: VectorViewport): VectorSelectionBoxGeometry {
	const z = viewport.zoom;
	const box = { x: frame.x * z + viewport.x, y: frame.y * z + viewport.y, width: frame.width * z, height: frame.height * z };
	const rot = rotateMatrix(frame.angle, { x: viewport.x, y: viewport.y });
	const toScreen = (p: Vec2): Vec2 => (frame.angle ? applyMatrix(rot, p) : { x: p.x, y: p.y });
	const handles = getTransformHandlePositions(box).map((h) => ({ ...h, screen: toScreen(h) }));
	const corners = [
		{ x: box.x, y: box.y },
		{ x: box.x + box.width, y: box.y },
		{ x: box.x + box.width, y: box.y + box.height },
		{ x: box.x, y: box.y + box.height }
	].map(toScreen);
	const r = (n: number) => Math.round(n * 1000) / 1000;
	return { box, angle: frame.angle, transform: frame.angle ? `rotate(${r(frame.angle)} ${r(viewport.x)} ${r(viewport.y)})` : '', handles, corners };
}

/**
 * The node the Envelope tool edits: the one selected node with an enabled envelope, with the
 * envelope's mesh and box (node space) and the node → document matrix. Null otherwise.
 */
export function getVectorEnvelopeTarget(
	doc: VectorDocument,
	selection: readonly string[]
): { node: VectorNode; frame: { effectId: string; bounds: VectorBounds; mesh: VectorWarpMesh }; world: AffineMatrix } | null {
	if (selection.length !== 1) return null;
	const node = findVectorNode(doc.nodes, selection[0]);
	if (!node || !vectorNodeEnvelope(node)) return null;
	const frame = vectorEnvelopeFrame(node);
	return frame ? { node, frame, world: vectorWorldMatrix(doc.nodes, node.id) ?? IDENTITY_MATRIX } : null;
}

const RESIZE_CURSOR_ORDER = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
const HANDLE_ANGLES: Partial<Record<VectorTransformHandle, number>> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };

/** The resize cursor for a handle of a box rotated by `angle` degrees. */
export function vectorResizeCursor(handle: VectorTransformHandle, angle = 0): string {
	if (handle === 'rotate') return 'grab';
	const a = (((HANDLE_ANGLES[handle]! + angle) % 180) + 180) % 180;
	return RESIZE_CURSOR_ORDER[Math.round(a / 45) % 4];
}


const TOOL_LABELS: Record<VectorTool, string> = {
	select: 'Select',
	direct: 'Direct Select',
	pen: 'Pen',
	pencil: 'Pencil',
	rect: 'Rectangle',
	ellipse: 'Ellipse',
	polygon: 'Polygon',
	star: 'Star',
	line: 'Line',
	scissors: 'Scissors',
	knife: 'Knife',
	eraser: 'Eraser',
	width: 'Width',
	shapeBuilder: 'Shape Builder',
	paintBucket: 'Paint Bucket',
	blend: 'Blend',
	gradient: 'Gradient',
	envelope: 'Envelope Mesh',
	type: 'Type',
	typePath: 'Type on a Path',
	frame: 'Frame',
	connector: 'Connector'
};

const TOOL_KEYS: Record<string, VectorTool> = {
	v: 'select',
	a: 'direct',
	p: 'pen',
	n: 'pencil',
	r: 'rect',
	o: 'ellipse',
	y: 'polygon',
	s: 'star',
	l: 'line',
	c: 'scissors',
	k: 'knife',
	e: 'eraser',
	w: 'width',
	m: 'shapeBuilder',
	b: 'paintBucket',
	j: 'blend',
	g: 'gradient',
	u: 'envelope',
	t: 'type',
	q: 'typePath',
	f: 'frame',
	x: 'connector'
};

export function vectorToolLabel(tool: VectorTool): string {
	return TOOL_LABELS[tool];
}

/** Keyboard shortcut of each tool (single letters, no modifiers). */
export const VECTOR_TOOL_SHORTCUTS: Readonly<Record<VectorTool, string>> = {
	select: 'V',
	direct: 'A',
	pen: 'P',
	pencil: 'N',
	rect: 'R',
	ellipse: 'O',
	polygon: 'Y',
	star: 'S',
	line: 'L',
	scissors: 'C',
	knife: 'K',
	eraser: 'E',
	width: 'W',
	shapeBuilder: 'M',
	paintBucket: 'B',
	blend: 'J',
	gradient: 'G',
	envelope: 'U',
	type: 'T',
	typePath: 'Q',
	frame: 'F',
	connector: 'X'
};

/** Short glyphs for tool buttons (pair them with `vectorToolLabel` for the accessible name). */
export const VECTOR_TOOL_GLYPHS: Readonly<Record<VectorTool, string>> = {
	select: '↖',
	direct: '⌖',
	pen: '✒',
	pencil: '✎',
	rect: '▭',
	ellipse: '◯',
	polygon: '⬡',
	star: '☆',
	line: '╱',
	scissors: '✂',
	knife: '⟋',
	eraser: '⌫',
	width: '⇹',
	shapeBuilder: '⊕',
	paintBucket: '◍',
	blend: '⧓',
	gradient: '◐',
	envelope: '⌗',
	type: 'T',
	typePath: '𝒯',
	frame: '⬚',
	connector: '⤳'
};

/** Tools that drag out a shape (they snap while hovering). */
const SHAPE_TOOLS: ReadonlySet<VectorTool> = new Set(['rect', 'ellipse', 'polygon', 'star', 'line', 'frame']);

const BOOLEAN_OPS: Record<VectorBooleanOperation, 'union' | 'difference' | 'intersection' | 'xor'> = {
	union: 'union',
	subtract: 'difference',
	intersect: 'intersection',
	exclude: 'xor'
};

const BOOLEAN_LABELS: Record<VectorBooleanOperation, string> = { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' };

/** Names of the Pathfinder operations (undo steps, groups and buttons). */
export const VECTOR_PATHFINDER_LABELS: Readonly<Record<VectorPathfinderOperation, string>> = {
	divide: 'Divide',
	trim: 'Trim',
	merge: 'Merge',
	crop: 'Crop',
	outline: 'Outline',
	minusBack: 'Minus Back'
};

/** Replaces nodes by id anywhere in the tree (structural sharing for untouched branches). */
/**
 * Every path with its fill and stroke stacks reconciled (see `normalizeVectorPaintStacks`): the
 * same array, and the same node objects, where nothing changes.
 */
function normalizeVectorTree(nodes: readonly VectorNode[], prefer: 'stack' | 'shorthand'): VectorNode[] {
	let changed = false;
	const out = nodes.map((n) => {
		let next: VectorNode = n.type === 'path' || n.type === 'text' ? normalizeVectorPaintStacks(n, prefer) : n;
		if (next.type === 'group') {
			const children = normalizeVectorTree(next.children, prefer);
			if (children !== next.children) next = { ...next, children };
		}
		if (next !== n) changed = true;
		return next;
	});
	return changed ? out : (nodes as VectorNode[]);
}

/** A document as loaded: a copy, stacks preferred over stale shorthands. */
function loadedDocument(doc: VectorDocument): VectorDocument {
	const copy = cloneVectorDocument(stripVectorSymbolArt(doc));
	const nodes = normalizeVectorTree(copy.nodes, 'stack');
	const symbols = copy.symbols?.map((s) => ({ ...s, nodes: normalizeVectorTree(s.nodes, 'stack') }));
	return resolveVectorSymbols({ ...copy, nodes, ...(symbols ? { symbols } : {}) });
}

function mapTree(nodes: readonly VectorNode[], fn: (node: VectorNode) => VectorNode | null): VectorNode[] {
	let changed = false;
	const out: VectorNode[] = [];
	for (const node of nodes) {
		let next = fn(node);
		if (next && next.type === 'group') {
			const children = mapTree(next.children, fn);
			if (children !== next.children) next = { ...next, children };
		}
		if (next !== node) changed = true;
		if (next) out.push(next);
	}
	return changed ? out : (nodes as VectorNode[]);
}

/** Replaces node `id` anywhere in the tree with `replacements` (none removes it). */
function spliceTree(nodes: readonly VectorNode[], id: string, replacements: readonly VectorNode[]): VectorNode[] {
	let changed = false;
	const out: VectorNode[] = [];
	for (const node of nodes) {
		if (node.id === id) {
			changed = true;
			out.push(...replacements);
			continue;
		}
		if (node.type === 'group') {
			const children = spliceTree(node.children, id, replacements);
			if (children !== node.children) {
				changed = true;
				out.push({ ...node, children });
				continue;
			}
		}
		out.push(node);
	}
	return changed ? out : (nodes as VectorNode[]);
}

const toPoint = (p: Vec2): Point => [p.x, p.y];

/** A node's place and state (transform, visibility, lock, operand operation), for a node taking its place. */
const placementOf = (n: VectorNode) => ({
	...(n.transform ? { transform: n.transform } : {}),
	...(n.visible === false ? { visible: false } : {}),
	...(n.locked ? { locked: true } : {}),
	...(n.booleanOperation ? { booleanOperation: n.booleanOperation } : {})
});

const isRoot = (m: AffineMatrix) => m === IDENTITY_MATRIX || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);

let idCounter = 0;
const defaultCreateId = () => `vn-${Date.now().toString(36)}${(++idCounter).toString(36)}`;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

interface Snapshot {
	doc: VectorDocument;
	selection: string[];
	anchors: VectorAnchorRef[];
	editingId: string | null;
	pen: { nodeId: string; subpath: number } | null;
	/** The symbol being edited in isolation when the snapshot was taken (`doc` is then its art). */
	symbolEdit: SymbolEditContext | null;
}

/** Isolation mode: `doc` holds a symbol's art; `host` is the document it belongs to. */
interface SymbolEditContext {
	symbolId: string;
	/** The instance it was entered from (its placement lines the art up with the document), if any. */
	instanceId: string | null;
	host: VectorDocument;
	/** Where the instance put the symbol's origin, and its scale (√|det|): the view follows them in and out. */
	origin: Vec2 | null;
	scale: number;
}

/** Snap targets of a drag, gathered on its first move that needs them. */
type DragTargets = { targets?: VectorSnapTargets };

type Drag =
	| ({ kind: 'move'; start: Vec2; origin: VectorBounds | null; before: Snapshot; base: VectorDocument; moved: boolean; duplicated: boolean; clickId: string | null } & DragTargets)
	| ({ kind: 'scale'; handle: VectorTransformHandle; start: Vec2; frame: VectorSelectionFrame; before: Snapshot; base: VectorDocument; op?: string } & DragTargets)
	| {
			kind: 'envelope';
			nodeId: string;
			effectId: string;
			/** The mesh at the start (node space) and the document it belongs to. */
			base: VectorWarpMesh;
			baseDoc: VectorDocument;
			before: Snapshot;
			index: number | null;
			s: number;
			t: number;
			start: Vec2;
			moved: boolean;
	  }
	| { kind: 'rotate'; start: Vec2; center: Vec2; before: Snapshot; base: VectorDocument }
	| { kind: 'marquee'; start: Vec2; base: string[]; baseAnchors: VectorAnchorRef[]; anchorsMode: boolean }
	| ({ kind: 'anchors'; start: Vec2; before: Snapshot; base: VectorDocument; moved: boolean; clickRef: VectorAnchorRef | null; lead: VectorAnchorRef | null } & DragTargets)
	| ({ kind: 'handle'; ref: VectorHandleRef; before: Snapshot; base: VectorDocument } & DragTargets)
	| { kind: 'bend'; ref: VectorSegmentRef; t: number; start: Vec2; before: Snapshot; base: VectorDocument; moved: boolean }
	| { kind: 'corner'; widget: VectorCornerWidget; refs: VectorAnchorRef[]; start: Vec2; before: Snapshot; base: VectorDocument; moved: boolean; alt: boolean; shift: boolean }
	| { kind: 'stroke'; tool: 'knife' | 'eraser'; points: Vec2[]; before: Snapshot }
	| { kind: 'builder'; erase: boolean; points: Vec2[]; touched: VectorBuilderTouched; map: VectorShapeBuilderMap }
	| { kind: 'pull'; ref: VectorAnchorRef; before: Snapshot; base: VectorDocument; label: string; outOnly: boolean; closing: boolean; altBreaks: boolean }
	| ({ kind: 'shape'; tool: VectorTool; start: Vec2; nodeId: string; before: Snapshot } & DragTargets)
	| { kind: 'connector'; nodeId: string; start: Vec2; before: Snapshot }
	| { kind: 'shading'; nodeId: string; index: number; start: Vec2; before: Snapshot; moved: boolean; alt: boolean }
	| { kind: 'textBox'; start: Vec2; moved: boolean }
	| { kind: 'textSelect'; nodeId: string }
	| { kind: 'pencil'; nodeId: string; points: Point[]; before: Snapshot; lazy: LazyMouse; pressures: number[] | null; pressure: number }
	| {
			kind: 'width';
			ref: VectorWidthPointRef;
			/** `copy`: Alt-drag a centre to slide a copy of the point. */
			mode: 'width' | 'move' | 'copy';
			side: 'both' | 'left' | 'right';
			/** The index the drag started on (the source of a copy). */
			source: number;
			/** Other selected points of the path that move or widen with it (indices into `profile`). */
			group: number[];
			/** Shift-click (adding the point): a click without a move keeps the other selected points. */
			shift: boolean;
			/** Old index → new index after a group move re-sorted the profile. */
			renumber: Map<number, number> | null;
			/** The stroke line's point and left normal where the drag started (node space). */
			origin: Vec2;
			normal: Vec2;
			/** Half the drawn stroke width: side scale 1 reaches this far. */
			unit: number;
			profile: VectorWidthPoint[];
			before: Snapshot;
			base: VectorDocument;
			start: Vec2;
			moved: boolean;
			created: boolean;
	  }
	| {
			kind: 'gradient';
			/** What was grabbed: null draws a new vector over `targets`. */
			part: VectorGradientPart | null;
			nodeId: string | null;
			targets: string[];
			annotator: VectorGradientAnnotator | null;
			start: Vec2;
			startDoc: Vec2;
			before: Snapshot;
			base: VectorDocument;
			moved: boolean;
			/** The dragged stop's index now (null once dragged off the bar). */
			stop: number | null;
	  }
	| { kind: 'pan'; start: Vec2; viewport: VectorViewport };

/**
 * Headless state for a vector editor: a document of paths and groups, select / direct /
 * pen / pencil / shape tools driven by pointer and key events, undo, transforms, boolean
 * operations, alignment, grouping, SVG import / export and a viewport. Any UI forwards
 * pointer events (in canvas pixels) and renders `getState()`; `getState()` returns the same
 * object until something changes, so it works with `useSyncExternalStore` and Svelte runes.
 */
export class VectorEditorController {
	readonly history: HistoryManager;
	private doc: VectorDocument;
	private selection: string[] = [];
	private anchors: VectorAnchorRef[] = [];
	private widthPoints: VectorWidthPointRef[] = [];
	private widthEdit: VectorWidthPointEdit | null = null;
	private editingId: string | null = null;
	private pen: { nodeId: string; subpath: number } | null = null;
	private tool: VectorTool;
	private defaults: VectorEditorState['defaults'];
	private viewport: VectorViewport;
	private snap: VectorSnapOptions;
	private editing: VectorPathEditOptions;
	private hitRadius: number;
	private hover: VectorHover | null = null;
	private pointer: Vec2 | null = null;
	private drag: Drag | null = null;
	private interaction: VectorInteraction | null = null;
	private guides: VectorSnapGuides | null = null;
	/** Whether the last `snapDrawn` landed on an object (guides may be hidden). */
	private snappedToObject = false;
	/** Drawing targets for hovering the pen and shape tools, kept while the document and the excluded path stay the same. */
	private hoverTargets: { doc: VectorDocument; exclude: string; targets: VectorSnapTargets } | null = null;
	private spaceHeld = false;
	private clipboard: VectorNode[] | null = null;
	/** Shape Builder map of the selection, kept while the document and the selection stay the same. */
	private builderCache: { doc: VectorDocument; key: string; map: VectorShapeBuilderMap | null } | null = null;
	/** Paint bucket map of the visible outlines. */
	private fillCache: { doc: VectorDocument; gap: number; map: PlanarMap | null } | null = null;
	private builderPreview: VectorBuilderPreview | null = null;
	private blendStart: VectorBlendStart | null = null;
	/** Options new blends get (the toolbars edit them along with the selected blend's). */
	private blendDefaults: VectorBlendOptions = {};
	private gradientEdit: VectorEditorState['gradientEdit'] = { target: 'fill', stop: null, layer: null };
	private freeDistort = false;
	/** The text edit session: selection, the snapshot before a text node it created (until the first change), the merge key of its undo step. */
	private textEdit: (VectorTextEditState & { before: Snapshot | null; key: string; created: boolean }) | null = null;
	private textEditCount = 0;
	private symbolEdit: SymbolEditContext | null = null;
	/** The document as last solved: what differs from it was just edited, so the solver moves it least. */
	private lastSolved: VectorDocument | null = null;
	private constraintIssues: VectorEditorState['constraintIssues'] = null;
	private textDefaults: VectorTextDefaults = { ...DEFAULT_VECTOR_FONT };
	/** What the highlight shows, to skip notifying when the pointer stays over the same face. */
	private builderHoverKey: string | null = null;
	private readonly createId: () => string;
	private readonly onChange?: (document: VectorDocument) => void;
	private readonly listeners = new Set<(state: VectorEditorState) => void>();
	private readonly cleanups: Array<() => void> = [];
	private applying = false;
	/** Set while a commit records a change that was already applied, so `restore` still reports it. */
	private committing = false;
	private revision = 0;
	private state!: VectorEditorState;

	constructor(options: VectorEditorOptions = {}) {
		this.history = options.history ?? new HistoryManager();
		this.doc = options.document ? loadedDocument(options.document) : { width: 800, height: 600, nodes: [] };
		this.doc = this.refreshed(this.doc);
		this.tool = options.tool ?? 'select';
		this.defaults = { ...DEFAULT_DEFAULTS, ...(options.defaults ?? {}) } as VectorEditorState['defaults'];
		this.viewport = { x: 0, y: 0, zoom: 1, ...(options.viewport ?? {}) };
		this.snap = { ...DEFAULT_VECTOR_SNAP, ...(options.snap ?? {}) };
		this.editing = { ...DEFAULT_VECTOR_PATH_EDIT, ...(options.editing ?? {}) };
		this.hitRadius = options.hitRadius ?? 6;
		this.createId = options.createId ?? defaultCreateId;
		this.onChange = options.onChange;
		this.freeDistort = !!options.freeDistort;
		if (options.textShaper !== undefined) setVectorTextShaper(options.textShaper);
		if (options.textDefaults) this.textDefaults = { ...this.textDefaults, ...options.textDefaults };
		this.state = this.computeState();
		this.connect();
	}

	/** Listens to the history (once; again after `destroy`). */
	private connect(): void {
		if (this.cleanups.length) return;
		this.cleanups.push(
			this.history.subscribe((h) => {
				if (!this.applying && this.historyDiffers(h)) this.notify();
			})
		);
		// Catch up on history changes made while disconnected.
		if (this.historyDiffers(this.history.getState())) this.state = this.computeState();
	}

	private historyDiffers(h: ReturnType<HistoryManager['getState']>): boolean {
		const s = this.state;
		return s.canUndo !== h.canUndo || s.canRedo !== h.canRedo || s.undoLabel !== h.undoName || s.redoLabel !== h.redoName;
	}

	/**
	 * Stops listening to the history and drops all listeners. A later `subscribe` reconnects, so a
	 * controller torn down by React StrictMode's double effect keeps working when it is reused.
	 */
	destroy(): void {
		if (this.dwellTimer) clearTimeout(this.dwellTimer);
		this.dwellTimer = null;
		this.cleanups.splice(0).forEach((fn) => fn());
		this.listeners.clear();
	}

	// -------------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------------

	/** The current snapshot (stable until the next change). */
	getState = (): VectorEditorState => this.state;

	/** Calls `listener` after every change. Returns an unsubscribe function. */
	subscribe = (listener: (state: VectorEditorState) => void): (() => void) => {
		this.connect();
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getDocument(): VectorDocument {
		return this.doc;
	}

	getNode(id: string): VectorNode | undefined {
		return findVectorNode(this.doc.nodes, id);
	}

	private computeState(): VectorEditorState {
		const h = this.history.getState();
		return {
			document: this.doc,
			tool: this.tool,
			selection: this.selection,
			selectedAnchors: this.anchors,
			selectedWidthPoints: this.widthPoints,
			widthPointEdit: this.widthEdit,
			editingId: this.editingId,
			selectionBounds: this.boundsOf(this.selection),
			selectionFrame: this.frameOf(this.selectedRoots()),
			viewport: this.viewport,
			defaults: this.defaults,
			snap: this.snap,
			editing: this.editing,
			guides: this.guides,
			hitRadius: this.hitRadius,
			hover: this.hover,
			cursor: this.cursorFor(),
			interaction: this.interaction,
			pen: this.pen,
			pointer: this.pointer,
			builder: this.builderPreview,
			blendStart: this.blendStart,
			blendDefaults: this.blendDefaults,
			gradientEdit: this.gradientEdit,
			freeDistort: this.freeDistort,
			textEdit: this.textEdit ? { nodeId: this.textEdit.nodeId, anchor: this.textEdit.anchor, focus: this.textEdit.focus } : null,
			textDefaults: this.textDefaults,
			symbolEdit: this.symbolEditState(),
			constraintIssues: this.constraintIssues,
			trackingPoints: this.trackingPoints,
			typedEntry: this.typed,
			shadingPoint: this.getShadingSelection(),
			canUndo: h.canUndo,
			canRedo: h.canRedo,
			undoLabel: h.undoName,
			redoLabel: h.redoName,
			revision: this.revision
		};
	}

	/** `doc` with its blends' steps brought up to date (the same object when they already are). */
	private refreshed(doc: VectorDocument): VectorDocument {
		// Shorthand fills and strokes written by any edit go to the top layer of their stack.
		const nodes = refreshVectorBlends(normalizeVectorTree(doc.nodes, 'shorthand'));
		let out = nodes === doc.nodes ? doc : { ...doc, nodes };
		// In isolation mode the edited symbol's art is the document's nodes.
		const edit = this.symbolEdit;
		if (edit && out.symbols?.some((s) => s.id === edit.symbolId && s.nodes !== out.nodes)) {
			out = { ...out, symbols: out.symbols.map((s) => (s.id === edit.symbolId ? { ...s, nodes: out.nodes } : s)) };
		}
		// Instances draw their symbols' art.
		out = resolveVectorSymbols(out);
		// Connectors follow what they are glued to (after the constraints have moved it).
		return rerouteVectorConnectors(this.solved(out));
	}

	/**
	 * `doc` with its constraints solved (geometry edited since the last solve moving least) and
	 * constraints on deleted anchors removed; the same object when nothing changes.
	 */
	private solved(doc: VectorDocument): VectorDocument {
		if (!doc.constraints?.length) {
			this.constraintIssues = null;
			this.lastSolved = doc;
			return doc;
		}
		if (this.lastSolved && doc.nodes === this.lastSolved.nodes && doc.constraints === this.lastSolved.constraints && doc.parameters === this.lastSolved.parameters) return doc;
		const purged = purgeVectorConstraints(doc).document;
		const r = solveVectorConstraints(purged, this.lastSolved);
		this.constraintIssues = r.conflicts.length || r.skipped.length ? { conflicts: [...new Set(r.conflicts)], skipped: r.skipped } : null;
		this.lastSolved = r.document;
		return r.document;
	}

	private notify(docChanged = false) {
		// Blends regenerate their steps after every edit of a key (drags included).
		const fresh = this.refreshed(this.doc);
		if (fresh !== this.doc) this.doc = fresh;
		if (this.blendStart && !this.getNode(this.blendStart.nodeId)) this.blendStart = null;
		this.revision++;
		this.state = this.computeState();
		if (docChanged) this.onChange?.(this.storedDocument());
		const state = this.state;
		this.listeners.forEach((listener) => {
			try {
				listener(state);
			} catch (error) {
				console.error('[VectorEditorController] Error in state listener:', error);
			}
		});
	}

	private boundsOf(ids: readonly string[]): VectorBounds | null {
		return unionBounds(
			ids.map((id) => {
				const n = this.getNode(id);
				return n ? vectorNodeBounds(n, vectorParentMatrix(this.doc.nodes, id) ?? IDENTITY_MATRIX) : null;
			})
		);
	}

	private frameOf(ids: readonly string[]): VectorSelectionFrame | null {
		return getVectorSelectionFrame(this.doc, ids);
	}

	/** Local → document matrix of a node in `doc` (default: the current document). */
	private worldOf(id: string, doc: VectorDocument = this.doc): AffineMatrix {
		return vectorWorldMatrix(doc.nodes, id) ?? IDENTITY_MATRIX;
	}

	/** A document point in node `id`'s own space. */
	private toLocal(id: string, p: Vec2, doc: VectorDocument = this.doc): Vec2 {
		return applyMatrix(invertMatrix(this.worldOf(id, doc)), p);
	}

	private cursorFor(): string {
		if (this.drag?.kind === 'pan' || this.spaceHeld) return this.drag ? 'grabbing' : 'grab';
		if (this.drag?.kind === 'rotate') return 'grabbing';
		if (this.drag?.kind === 'move') return 'move';
		const h = this.hover;
		switch (this.tool) {
			case 'select':
				if (h?.transformHandle && this.freeDistort && h.transformHandle !== 'rotate') return 'crosshair';
				if (h?.transformHandle) return vectorResizeCursor(h.transformHandle, this.frameOf(this.selectedRoots())?.angle ?? 0);
				return h?.nodeId ? 'move' : 'default';
			case 'type':
				return 'text';
			case 'typePath':
				return h?.nodeId ? 'text' : 'crosshair';
			case 'envelope':
				if (this.drag?.kind === 'envelope') return 'grabbing';
				if (h?.envelope) return h.envelope.index === null ? 'grab' : 'pointer';
				return h?.nodeId ? 'pointer' : 'default';
			case 'direct':
				if (h?.anchor || h?.handle || h?.corner) return 'pointer';
				if (h?.segment) return 'copy';
				return h?.nodeId ? 'move' : 'default';
			case 'pen':
				return h?.anchor ? 'pointer' : 'crosshair';
			case 'width':
				if (this.drag?.kind === 'width') return this.drag.mode === 'width' ? 'ew-resize' : 'grabbing';
				if (h?.widthPoint) return h.widthPoint.part === 'center' ? 'grab' : 'ew-resize';
				return h?.strokeSpot ? 'copy' : 'default';
			case 'shapeBuilder':
				if (!this.builderPreview?.faces.length && !this.builderPreview?.lines.length) return 'crosshair';
				return this.builderPreview.mode === 'erase' ? 'not-allowed' : 'cell';
			case 'paintBucket':
				return this.builderPreview ? 'cell' : 'crosshair';
			case 'blend':
				return h?.nodeId ? (this.blendStart && this.blendStart.nodeId !== h.nodeId ? 'copy' : 'pointer') : 'crosshair';
			case 'gradient': {
				const part = this.drag?.kind === 'gradient' ? this.drag.part : h?.gradient;
				if (!part) return 'crosshair';
				if (part.kind === 'bar') return this.drag ? 'grabbing' : 'copy';
				if (part.kind === 'handle' && part.handle === 'start') return this.drag ? 'grabbing' : 'move';
				return 'pointer';
			}
			default:
				return 'crosshair';
		}
	}

	// -------------------------------------------------------------------------
	// Undoable changes
	// -------------------------------------------------------------------------

	private snapshot(): Snapshot {
		return { doc: this.doc, selection: this.selection, anchors: this.anchors, editingId: this.editingId, pen: this.pen, symbolEdit: this.symbolEdit };
	}

	private restore(s: Snapshot) {
		const docChanged = s.doc !== this.doc || this.committing;
		// Undo / redo can renumber width points: drop the ones that are gone and close the editor.
		if (!this.committing) this.widthEdit = null;
		this.committing = false;
		this.applying = true;
		try {
			this.doc = s.doc;
			// Undo and redo step in and out of isolation mode with the edits made there (the view follows).
			const was = this.symbolEdit;
			this.symbolEdit = s.symbolEdit ?? null;
			if (was !== this.symbolEdit) {
				if (was?.origin) this.viewport = this.viewOutOf(was);
				if (this.symbolEdit?.origin) this.viewport = this.viewInto(this.symbolEdit);
			}
			this.selection = s.selection.filter((id) => this.getNode(id));
			this.anchors = s.anchors.filter((r) => getAnchor(this.doc, r));
			this.editingId = s.editingId && this.getNode(s.editingId) ? s.editingId : null;
			this.pen = s.pen && (this.getNode(s.pen.nodeId) as VectorPathNode | undefined)?.subpaths?.[s.pen.subpath] ? s.pen : null;
			if (this.textEdit) {
				const t = this.getNode(this.textEdit.nodeId);
				if (t?.type !== 'text') this.textEdit = null;
				else {
					const n = t.text.length;
					this.textEdit = { ...this.textEdit, anchor: Math.min(this.textEdit.anchor, n), focus: Math.min(this.textEdit.focus, n), before: null };
				}
			}
			if (this.widthPoints.length) {
				const kept = this.widthPoints.filter((r) => {
					const n = this.getNode(r.nodeId);
					return n?.type === 'path' && !!n.strokeWidthProfile?.[r.index];
				});
				if (kept.length !== this.widthPoints.length) this.widthPoints = kept;
			}
		} finally {
			this.applying = false;
		}
		this.notify(docChanged);
	}

	/**
	 * Records the change from `before` to the current state as one undo step. Consecutive
	 * changes with the same `merge` key (a slider drag) fold into one step.
	 */
	private commit(name: string, before: Snapshot, merge?: string) {
		this.doc = this.refreshed(this.doc);
		const after = this.snapshot();
		if (before.doc === after.doc) {
			this.notify();
			return;
		}
		const command: Command = {
			name,
			execute: () => this.restore(after),
			undo: () => this.restore(before),
			redo: () => this.restore(after),
			...(merge ? { tag: merge } : {})
		};
		this.committing = true;
		if (merge) this.history.executeMerged(command, { key: merge });
		else this.history.execute(command);
		this.committing = false;
	}

	/** Runs `fn` (which updates fields) and records it as one undo step (merged by `merge` key). */
	private change(name: string, fn: () => void, merge?: string): void {
		const before = this.snapshot();
		fn();
		this.commit(name, before, merge);
	}

	/** Ends a merged edit (a slider released): the next change starts a new undo step. */
	endMergedEdit(): void {
		this.history.endGesture();
	}

	private setDoc(nodes: VectorNode[]) {
		if (nodes !== this.doc.nodes) this.doc = { ...this.doc, nodes };
	}

	private replaceNode(id: string, next: VectorNode | null) {
		this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === id ? next : n)));
	}

	private freshIds<T extends VectorNode>(node: T): T {
		const copy = cloneVectorNode(node);
		const used = new Set<string>();
		walkVectorNodes(this.doc.nodes, (n) => used.add(n.id));
		const next = () => {
			let id = this.createId();
			while (used.has(id)) id = this.createId();
			used.add(id);
			return id;
		};
		const assign = (n: VectorNode) => {
			n.id = next();
			if (n.type === 'group') n.children.forEach(assign);
		};
		assign(copy);
		return copy;
	}

	private newId(): string {
		let id = this.createId();
		while (this.getNode(id)) id = this.createId();
		return id;
	}

	// -------------------------------------------------------------------------
	// Viewport
	// -------------------------------------------------------------------------

	screenToDocument(p: Vec2): Vec2 {
		const v = this.viewport;
		return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
	}

	documentToScreen(p: Vec2): Vec2 {
		const v = this.viewport;
		return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
	}

	setViewport(viewport: Partial<VectorViewport>): void {
		const next = { ...this.viewport, ...viewport };
		next.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.zoom));
		if (next.x === this.viewport.x && next.y === this.viewport.y && next.zoom === this.viewport.zoom) return;
		this.viewport = next;
		this.notify();
	}

	/** Zooms by `factor` keeping the document point under `screen` in place. */
	zoomAt(screen: Vec2, factor: number): void {
		const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.viewport.zoom * factor));
		const doc = this.screenToDocument(screen);
		this.setViewport({ zoom, x: screen.x - doc.x * zoom, y: screen.y - doc.y * zoom });
	}

	panBy(dx: number, dy: number): void {
		this.setViewport({ x: this.viewport.x + dx, y: this.viewport.y + dy });
	}

	/** Fits the artboard (or `bounds`) into a canvas of `size` screen pixels. */
	zoomToFit(size: { width: number; height: number }, options: { padding?: number; bounds?: VectorBounds } = {}): void {
		const padding = options.padding ?? 40;
		const b = options.bounds ?? { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
		const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((size.width - padding * 2) / (b.width || 1), (size.height - padding * 2) / (b.height || 1))));
		this.setViewport({ zoom, x: (size.width - b.width * zoom) / 2 - b.x * zoom, y: (size.height - b.height * zoom) / 2 - b.y * zoom });
	}

	/** Zoom at the canvas centre-ish: positive `delta` zooms out (wheel convention). Use with `wheel`. */
	wheel(screen: Vec2, delta: { x: number; y: number }, mods: VectorModifiers = {}): void {
		if (mods.mod) this.zoomAt(screen, Math.exp(-delta.y * 0.01));
		else this.panBy(-(mods.shift ? delta.y : delta.x), -(mods.shift ? 0 : delta.y));
	}

	// -------------------------------------------------------------------------
	// Settings
	// -------------------------------------------------------------------------

	setTool(tool: VectorTool): void {
		if (tool === this.tool) return;
		if (tool !== 'type' && tool !== 'typePath') this.endTextEdit();
		this.finishPath();
		this.cancelDrag();
		this.clearTracking(false);
		this.tool = tool;
		this.hover = null;
		this.guides = null;
		this.widthPoints = [];
		this.widthEdit = null;
		this.builderPreview = null;
		this.builderHoverKey = null;
		this.blendStart = null;
		if (tool !== 'direct') {
			this.anchors = [];
			this.editingId = null;
		}
		this.notify();
	}

	setDefaults(defaults: Partial<VectorDefaults>): void {
		this.defaults = { ...this.defaults, ...defaults };
		this.notify();
	}

	setSnap(snap: Partial<VectorSnapOptions>): void {
		this.snap = { ...this.snap, ...snap };
		if (!this.snap.guides || !this.snap.objects) this.guides = null;
		this.notify();
	}

	/** Changes how deleting, dragging anchors, the pencil and the eraser behave. */
	setEditing(editing: Partial<VectorPathEditOptions>): void {
		const next = { ...this.editing, ...editing };
		next.pencilSmoothing = Math.min(1, Math.max(0, Number.isFinite(next.pencilSmoothing) ? next.pencilSmoothing : 0));
		if (!(next.eraserSize > 0)) next.eraserSize = this.editing.eraserSize;
		this.editing = next;
		this.notify();
	}

	/** Turns object snapping on or off (the toolbar's snapping toggle). */
	toggleSnapping(on: boolean = !this.snap.objects): void {
		this.setSnap({ objects: on });
	}

	private gridValue(v: number): number {
		const g = this.snap.grid;
		return g > 0 ? Math.round(v / g) * g : v;
	}

	private snapPoint(p: Vec2): Vec2 {
		return { x: this.gridValue(p.x), y: this.gridValue(p.y) };
	}

	/** The pull distance in document units. */
	private snapTolerance(): number {
		return this.snap.threshold / this.viewport.zoom;
	}

	private setGuides(guides: VectorSnapGuides | null) {
		this.guides = guides && this.snap.guides && (guides.lines.length || guides.labels.length) ? guides : null;
	}

	/**
	 * Where a drawn or dragged point `p` goes: onto the smart guide `targets` (gathered by
	 * `gather` when missing), else onto the grid, kept to `leave`'s constraint. Cmd / Ctrl
	 * bypasses snapping.
	 */
	private snapDrawn(p: Vec2, leave: VectorSnapLeave | null, input: VectorModifiers, targets: () => VectorSnapTargets): Vec2 {
		this.snappedToObject = false;
		this.lastSnap = null;
		if (input.mod) {
			this.setGuides(null);
			return constrainToLeave(leave, p);
		}
		if (this.snap.objects) {
			const withAngles = leave ? { ...leave, angles: leave.angles ?? this.snap.angles } : null;
			const tracking = this.snap.tracking !== false ? vectorTrackingPaths(this.trackingPoints, this.snap.trackPolar ? this.snap.angles.flatMap((a) => [a, a + 180]) : undefined) : [];
			const res = targets().snapFrom(p, withAngles, this.snapTolerance(), tracking);
			this.lastSnap = res.kind ? { kind: res.kind, point: res.point } : null;
			if (res.kind) {
				this.snappedToObject = true;
				this.setGuides(res);
				// An axis lined up with nothing still goes to the grid.
				return leave?.constrain ? res.point : { x: res.x ? res.point.x : this.gridValue(res.point.x), y: res.y ? res.point.y : this.gridValue(res.point.y) };
			}
		}
		this.setGuides(null);
		return constrainToLeave(leave, this.snapPoint(p));
	}

	/** Drawing targets for the pen and shape tools, reused while the document stays the same. */
	private drawingTargets(exclude: string | null): VectorSnapTargets {
		const key = exclude ?? '';
		const cached = this.hoverTargets;
		if (cached && cached.doc === this.doc && cached.exclude === key) return cached.targets;
		const targets = VectorSnapTargets.forDrawing(this.doc, exclude ? [exclude] : []);
		this.hoverTargets = { doc: this.doc, exclude: key, targets };
		return targets;
	}

	/** Where the pointer at `p` would place a point with the pen or a shape tool (and the guides showing why). */
	private hoverSnap(p: Vec2, input: VectorModifiers): Vec2 {
		if (this.tool === 'pen') {
			const sp = this.pen ? (this.getNode(this.pen.nodeId) as VectorPathNode | undefined)?.subpaths[this.pen.subpath] : undefined;
			if (this.pen && sp && this.hover?.anchor) {
				this.setGuides(null);
				return p;
			}
			const last = this.pen && sp ? getAnchorWorld(this.doc, { nodeId: this.pen.nodeId, subpath: this.pen.subpath, index: sp.anchors.length - 1 }) : undefined;
			const leave = last ? { at: { x: last.x, y: last.y }, constrain: input.shift ? ('angle' as const) : null, ...this.penAngles() } : null;
			const q = this.snapDrawn(p, leave, input, () => this.drawingTargets(this.pen?.nodeId ?? null));
			this.dwell();
			return q;
		}
		if (SHAPE_TOOLS.has(this.tool)) {
			const q = this.snapDrawn(p, null, input, () => this.drawingTargets(null));
			this.dwell();
			return q;
		}
		this.setGuides(null);
		return p;
	}

	// -------------------------------------------------------------------------
	// Document
	// -------------------------------------------------------------------------

	/** Replaces the document. Undoable unless `{ history: false }` (then history is cleared). */
	setDocument(doc: VectorDocument, options: { history?: boolean; label?: string } = {}): void {
		this.cancelDrag();
		const next = loadedDocument(doc);
		if (options.history === false) {
			this.doc = next;
			this.selection = [];
			this.anchors = [];
			this.editingId = null;
			this.pen = null;
			this.history.clear();
			this.notify(true);
			return;
		}
		this.change(options.label ?? 'Replace Document', () => {
			this.doc = next;
			this.selection = [];
			this.anchors = [];
			this.editingId = null;
			this.pen = null;
		});
	}

	/** Changes the artboard size or background. */
	setArtboard(patch: Partial<Pick<VectorDocument, 'width' | 'height' | 'background'>>): void {
		this.change('Change Artboard', () => {
			this.doc = { ...this.doc, ...patch };
		});
	}

	/** Replaces the document with parsed SVG markup (one undo step). */
	loadSvg(svg: string, options: { history?: boolean } = {}): VectorActionResult {
		try {
			const doc = parseVectorSvg(svg, { createId: () => this.createId() });
			this.setDocument(doc, { history: options.history, label: 'Import SVG' });
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Adds the nodes of SVG markup on top of the document, selected. */
	importSvg(svg: string): VectorActionResult {
		try {
			const parsed = parseVectorSvg(svg);
			const nodes = parsed.nodes.map((n) => this.freshIds(n));
			if (!nodes.length) return { ok: false, message: 'The SVG has no shapes the editor can read.' };
			this.change('Import SVG', () => {
				this.setDoc([...this.doc.nodes, ...nodes]);
				this.selection = nodes.map((n) => n.id);
				this.anchors = [];
			});
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	toSvg(options?: VectorSvgExportOptions): string {
		return vectorDocumentToSvg(this.storedDocument(), options);
	}

	toJSON(): VectorDocument {
		return cloneVectorDocument(stripVectorSymbolArt(this.storedDocument()));
	}

	/** Adds a node (ids are kept unless taken). Returns its id. */
	addNode(node: VectorNode, options: AddVectorNodeOptions = {}): string {
		const taken = (() => {
			let clash = false;
			walkVectorNodes([node], (n) => {
				if (this.getNode(n.id)) clash = true;
			});
			return clash;
		})();
		const next = taken ? this.freshIds(node) : cloneVectorNode(node);
		this.change(options.label ?? `Add ${next.type === 'group' ? 'Group' : (next.name ?? 'Path')}`, () => {
			const insert = (list: VectorNode[]) => {
				const copy = list.slice();
				copy.splice(options.index ?? copy.length, 0, next);
				return copy;
			};
			if (options.parentId) {
				this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === options.parentId && n.type === 'group' ? { ...n, children: insert(n.children) } : n)));
			} else this.setDoc(insert(this.doc.nodes));
			if (options.select !== false) {
				this.selection = [next.id];
				this.anchors = [];
			}
		});
		return next.id;
	}

	/** Builds a path node for a shape with the current defaults (not added). */
	createShapeNode(input: VectorShapeInput): VectorPathNode {
		const b = { x: input.x, y: input.y, width: input.width, height: input.height };
		const d = this.defaults;
		let subpath: VectorSubpath;
		switch (input.kind) {
			case 'rect':
				subpath = rectSubpath(b);
				break;
			case 'ellipse':
				subpath = ellipseSubpath(b);
				break;
			case 'polygon':
				subpath = polygonSubpath(b, input.sides ?? d.polygonSides);
				break;
			case 'star':
				subpath = starSubpath(b, input.points ?? d.starPoints, input.innerRatio ?? d.starInnerRatio);
				break;
			case 'line':
				subpath = lineSubpath({ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height });
				break;
		}
		const radius = input.cornerRadius ?? d.cornerRadius;
		const kind = input.cornerKind ?? d.cornerKind;
		// Live corners: the shape keeps its sharp anchors, so the radius stays editable.
		if ((input.kind === 'rect' || input.kind === 'polygon' || input.kind === 'star') && radius > 0) subpath = setSubpathCorners(subpath, radius, kind);
		const names = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', line: 'Line' };
		const style = this.styleFor(input.kind === 'line');
		const own: VectorStyle = {};
		for (const key of VECTOR_STYLE_KEYS) {
			if (input[key] !== undefined) (own as any)[key] = input[key];
		}
		// Given style edits the defaults' top layers; given stacks replace theirs.
		return withStyle({ id: this.newId(), type: 'path', name: input.name ?? names[input.kind], ...style, subpaths: [subpath] }, own) as VectorPathNode;
	}

	/** Adds a shape drawn with the current defaults. Returns its id. */
	addShape(input: VectorShapeInput, options: AddVectorNodeOptions = {}): string {
		const node = this.createShapeNode(input);
		return this.addNode(node, { label: `Add ${node.name}`, ...options });
	}

	/** Adds a path from SVG path data. Returns its id. */
	addPath(d: string, style: VectorStyle & { name?: string } = {}, options: AddVectorNodeOptions = {}): string {
		const subpaths = bezierToSubpaths(d);
		const { name, ...own } = style;
		const node = withStyle({ id: this.newId(), type: 'path', name: name ?? 'Path', ...this.styleFor(false), subpaths }, own) as VectorPathNode;
		return this.addNode(node, { label: 'Add Path', ...options });
	}

	private styleFor(open: boolean): VectorStyle {
		const d = this.defaults;
		const out: VectorStyle = { fill: open ? null : (d.fill ?? null), stroke: d.stroke ?? null, strokeWidth: d.strokeWidth ?? 1 };
		if (d.strokeLinecap) out.strokeLinecap = d.strokeLinecap;
		if (d.strokeLinejoin) out.strokeLinejoin = d.strokeLinejoin;
		if (d.strokeDasharray) out.strokeDasharray = d.strokeDasharray;
		if (d.fillRule) out.fillRule = d.fillRule;
		if (d.strokeAlign && d.strokeAlign !== 'center') out.strokeAlign = d.strokeAlign;
		for (const key of ['startArrow', 'endArrow', 'arrowAlign', 'startArrowScale', 'endArrowScale'] as const) if (d[key]) (out as any)[key] = d[key];
		if (d.strokeWidthProfile?.length) out.strokeWidthProfile = d.strokeWidthProfile.map((p) => ({ ...p }));
		// Default stacks: new shapes get every layer (open paths no fills).
		let styled: VectorStyle = out;
		if (Array.isArray(d.fills)) styled = withVectorFills(styled, open ? [] : d.fills);
		if (Array.isArray(d.strokes)) styled = withVectorStrokes(styled, d.strokes);
		return styled;
	}

	/** Merges `patch` into a node (paths take style and geometry; groups name / visibility / opacity). */
	updateNode(id: string, patch: Partial<VectorPathNode> | Partial<VectorGroupNode>, options: { label?: string } = {}): VectorActionResult {
		const node = this.getNode(id);
		if (!node) return { ok: false, message: `There is no node "${id}".` };
		const { id: _id, type: _type, ...rest } = patch as any;
		this.change(options.label ?? 'Edit Node', () => this.replaceNode(id, { ...node, ...rest } as VectorNode));
		return { ok: true };
	}

	/** Applies style (and opacity) to the selected (or given) nodes; groups pass it to every path inside. */
	setStyle(style: VectorStyle & { opacity?: number }, ids: readonly string[] = this.selection, options: { label?: string } = {}): VectorActionResult {
		const targets = new Set<string>();
		for (const id of ids) {
			const node = this.getNode(id);
			if (!node) return { ok: false, message: `There is no node "${id}".` };
			for (const p of collectPaintedNodes(node)) targets.add(p.id);
		}
		if (!targets.size) return { ok: false, message: 'Nothing is selected.' };
		this.change(options.label ?? 'Change Style', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (targets.has(n.id) ? withStyle(n as VectorPathNode, style) : n)));
		});
		return { ok: true };
	}

	/**
	 * Sets the variable-width profile of the selected (or given) paths: a preset id
	 * (`uniform` removes the profile), points, or a parametric taper / wave. Returns an error for
	 * an unknown preset.
	 */
	setWidthProfile(
		profile: VectorWidthPreset | readonly VectorWidthPoint[] | { taper?: VectorTaperOptions; wave?: VectorWaveOptions } | null,
		options: { ids?: readonly string[] } = {}
	): VectorActionResult {
		let points: VectorWidthPoint[];
		if (profile === null) points = [];
		else if (typeof profile === 'string') {
			const preset = widthProfilePreset(profile);
			if (!preset) return { ok: false, message: `There is no width profile "${profile}".` };
			points = preset;
		} else if (Array.isArray(profile)) points = sanitizeWidthProfile(profile);
		else {
			const p = profile as { taper?: VectorTaperOptions; wave?: VectorWaveOptions };
			points = p.taper || p.wave ? generateWidthProfile(p) : [];
		}
		this.widthPoints = [];
		this.widthEdit = null;
		return this.setStyle({ strokeWidthProfile: points.length ? points : null }, options.ids ?? this.selection, { label: points.length ? 'Width Profile' : 'Uniform Width' });
	}

	// -------------------------------------------------------------------------
	// Gradients
	// -------------------------------------------------------------------------

	/** Which paint (fill or stroke) the gradient tool and editor work on. */
	setGradientTarget(target: VectorGradientTarget, layer: number | null = null): void {
		if (target === this.gradientEdit.target && layer === this.gradientEdit.layer) return;
		this.gradientEdit = { target, stop: null, layer };
		this.notify();
	}

	/** Selects a stop of the gradient being edited (index into its sorted stops), or none. */
	selectGradientStop(index: number | null): void {
		if (index === this.gradientEdit.stop) return;
		this.gradientEdit = { ...this.gradientEdit, stop: index };
		this.notify();
	}

	/** The gradient tool's annotator for the selection (screen pixels), or null when its paint is not a gradient. */
	getGradientAnnotator(): VectorGradientAnnotator | null {
		return getVectorGradientAnnotator(this.doc, this.selection, this.viewport, this.gradientEdit.target, this.gradientEdit.layer);
	}

	/** Unlocked paths of `ids` (default: the selection). */
	private gradientPaths(ids: readonly string[] = this.selection): VectorPathNode[] {
		const out = new Map<string, VectorPathNode>();
		for (const id of ids) {
			const node = this.getNode(id);
			if (node && !node.locked) for (const p of collectPathNodes(node)) if (!p.locked) out.set(p.id, p);
		}
		return [...out.values()];
	}

	/**
	 * Edits the gradient of the `target` paint (default: the editor's) of the selected (or given)
	 * paths with `patch`: a colour or no paint becomes a gradient (`patch.type`, default linear,
	 * from the colour to white). Consecutive edits with the same `merge` key are one undo step.
	 */
	setGradient(patch: VectorGradientPatch, options: { ids?: readonly string[]; target?: VectorGradientTarget; layer?: number | null; label?: string; merge?: string } = {}): VectorActionResult {
		const target = options.target ?? this.gradientEdit.target;
		const layer = options.layer !== undefined ? options.layer : options.target === undefined ? this.gradientEdit.layer : null;
		const paths = this.gradientPaths(options.ids ?? this.selection);
		if (!paths.length) return { ok: false, message: 'Nothing is selected.' };
		const next = new Map<string, VectorPathNode>();
		let first: VectorGradient | null = null;
		for (const path of paths) {
			const paint = vectorTargetPaint(path, target, layer);
			const base = isVectorGradient(paint) ? paint : defaultVectorGradient(patch.type ?? 'linear', paint);
			const g = applyVectorGradientPatch(base, patch);
			if (!g) return { ok: false, message: 'That is not a valid gradient: it needs at least one stop with an offset and a colour.' };
			first ??= g;
			next.set(path.id, withVectorTargetPaint(path, target, layer, g));
		}
		this.change(options.label ?? 'Gradient', () => this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n)), options.merge);
		const stops = (first as VectorGradient | null)?.stops.length ?? 0;
		if (this.gradientEdit.stop !== null && this.gradientEdit.stop >= stops) this.gradientEdit = { ...this.gradientEdit, stop: null };
		return { ok: true };
	}

	/** Applies `fn` to every target gradient of the selection (paths whose paint is not a gradient are skipped). */
	private editGradients(label: string, fn: (stops: VectorGradient['stops']) => VectorGradient['stops'] | null, merge?: string): VectorActionResult {
		const { target, layer } = this.gradientEdit;
		const paths = this.gradientPaths().filter((p) => isVectorGradient(vectorTargetPaint(p, target, layer)));
		if (!paths.length) return { ok: false, message: 'The selection has no gradient.' };
		const next = new Map<string, VectorPathNode>();
		for (const path of paths) {
			const g = vectorTargetPaint(path, target, layer) as VectorGradient;
			const stops = fn(sortedVectorGradientStops(g));
			if (!stops) return { ok: false, message: 'A gradient keeps at least two stops.' };
			next.set(path.id, withVectorTargetPaint(path, target, layer, { ...g, stops }));
		}
		this.change(label, () => this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n)), merge);
		return { ok: true };
	}

	/** Changes stop `index` (colour, opacity, offset or midpoint) of the selection's gradients; selects it. */
	setGradientStop(index: number, patch: { color?: string; opacity?: number; offset?: number; midpoint?: number }, options: { merge?: string } = {}): VectorActionResult {
		let moved = index;
		const result = this.editGradients(
			'Gradient Stop',
			(stops) => {
				if (!stops[index]) return stops;
				let next = stops.map((s, i) => {
					if (i !== index) return s;
					const out = { ...s };
					if (patch.color !== undefined) out.color = patch.color;
					if (patch.opacity !== undefined && Number.isFinite(patch.opacity)) {
						const o = Math.min(1, Math.max(0, patch.opacity));
						if (o < 1) out.opacity = o;
						else delete out.opacity;
					}
					if (patch.midpoint !== undefined && Number.isFinite(patch.midpoint)) {
						const m = Math.min(0.95, Math.max(0.05, patch.midpoint));
						if (Math.abs(m - 0.5) > 1e-3) out.midpoint = m;
						else delete out.midpoint;
					}
					return out;
				});
				if (patch.offset !== undefined && Number.isFinite(patch.offset)) ({ stops: next, index: moved } = moveVectorGradientStop(next, index, patch.offset));
				return next;
			},
			options.merge
		);
		if (result.ok) this.selectGradientStop(moved);
		return result;
	}

	/** Adds a stop at `offset` (painting what the gradient paints there) to the selection's gradients and selects it. */
	addGradientStop(offset: number): VectorActionResult {
		let index = 0;
		const { target, layer } = this.gradientEdit;
		const result = this.editGradients('Add Gradient Stop', (stops) => {
			const path = this.gradientPaths().find((p) => isVectorGradient(vectorTargetPaint(p, target, layer)));
			const r = insertVectorGradientStop({ ...(vectorTargetPaint(path!, target, layer) as VectorGradient), stops }, offset);
			index = r.index;
			return r.stops;
		});
		if (result.ok) this.selectGradientStop(index);
		return result;
	}

	/** Removes stop `index` of the selection's gradients (never below two stops). */
	removeGradientStop(index: number): VectorActionResult {
		const result = this.editGradients('Delete Gradient Stop', (stops) => removeVectorGradientStop(stops, index));
		if (result.ok) this.selectGradientStop(null);
		return result;
	}

	/** Reverses the selection's gradients (stops and midpoints). */
	reverseGradient(): VectorActionResult {
		return this.setGradient({ reverse: true }, { label: 'Reverse Gradient' });
	}

	/** `doc` with path `id`'s `target` paint replaced. */
	private withGradient(doc: VectorDocument, id: string, target: VectorGradientTarget, g: VectorGradient): VectorDocument {
		const layer = this.gradientEdit.layer;
		return { ...doc, nodes: mapTree(doc.nodes, (n) => (n.id === id && n.type === 'path' ? withVectorTargetPaint(n, target, layer, g) : n)) };
	}

	private downGradient(screen: Vec2, p: Vec2, input: VectorPointerInput) {
		const before = this.snapshot();
		// A mesh or freeform fill: its points drag; a click in a freeform shape adds one.
		const shaded = this.shadedUnder(screen);
		if (shaded) {
			this.shadingSel = shaded.index >= 0 ? { nodeId: shaded.nodeId, index: shaded.index } : null;
			this.drag = { kind: 'shading', nodeId: shaded.nodeId, index: shaded.index, start: screen, before, moved: false, alt: !!input.alt };
			this.interaction = { type: 'gradient', part: 'handle' };
			this.notify();
			return;
		}
		const a = this.getGradientAnnotator();
		let part = a ? hitVectorGradientAnnotator(a, screen) : null;
		if (a && part) {
			// Alt on a radial gradient's centre grabs its focal point (they sit together until moved).
			if (part.kind === 'handle' && part.handle === 'start' && input.alt && a.gradient.type === 'radial') part = { kind: 'handle', handle: 'focal' };
			if (part.kind === 'stop') this.gradientEdit = { ...this.gradientEdit, stop: part.index };
			this.drag = { kind: 'gradient', part, nodeId: a.nodeId, targets: [a.nodeId], annotator: a, start: screen, startDoc: p, before, base: this.doc, moved: false, stop: part.kind === 'stop' ? part.index : null };
			this.interaction = { type: 'gradient', part: part.kind, ...(part.kind === 'handle' ? { handle: part.handle } : {}) };
			this.notify();
			return;
		}
		// Elsewhere a drag draws a new vector over the path under the pointer (selecting it) or the selection.
		const hit = this.hitPath(p);
		if (hit && !this.gradientPaths().some((n) => n.id === hit.id)) {
			this.selection = [hit.id];
			this.gradientEdit = { ...this.gradientEdit, stop: null };
		}
		const targets = this.gradientPaths().map((n) => n.id);
		if (!targets.length) {
			if (this.selection.length) this.clearSelection();
			return;
		}
		this.drag = { kind: 'gradient', part: null, nodeId: null, targets, annotator: null, start: screen, startDoc: p, before, base: this.doc, moved: false, stop: null };
		this.interaction = { type: 'gradient', part: 'create' };
		this.notify();
	}

	private moveGradient(drag: Extract<Drag, { kind: 'gradient' }>, screen: Vec2, p: Vec2, input: VectorPointerInput) {
		if (!drag.moved && Math.hypot(screen.x - drag.start.x, screen.y - drag.start.y) < 3) return;
		drag.moved = true;
		const target = this.gradientEdit.target;
		const base = drag.base;
		const constrained = (from: Vec2, to: Vec2) => {
			if (!input.shift) return to;
			const ang = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
			const len = Math.hypot(to.x - from.x, to.y - from.y);
			return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
		};
		if (!drag.part) {
			const end = constrained(drag.startDoc, p);
			let doc = base;
			for (const id of drag.targets) {
				const node = findVectorNode(base.nodes, id) as VectorPathNode | undefined;
				if (!node) continue;
				const paint = vectorTargetPaint(node, target, this.gradientEdit.layer);
				const g = isVectorGradient(paint) ? paint : defaultVectorGradient('linear', paint);
				doc = this.withGradient(doc, id, target, setVectorGradientVector(g, vectorPathLocalBounds(node), this.toLocal(id, drag.startDoc, base), this.toLocal(id, end, base)));
			}
			this.doc = doc;
			this.notify(true);
			return;
		}
		const id = drag.nodeId!;
		const node = findVectorNode(base.nodes, id) as VectorPathNode;
		const g = vectorTargetPaint(node, target, this.gradientEdit.layer) as VectorGradient;
		const bounds = vectorPathLocalBounds(node);
		const local = (q: Vec2) => this.toLocal(id, q, base);
		const part = drag.part;
		let next: VectorGradient = g;
		if (part.kind === 'handle') {
			let to = p;
			// Shift keeps the vector at 45° steps from the start.
			if (part.handle === 'end' || part.handle === 'radius') to = constrained(this.screenToDocument(drag.annotator!.start), p);
			next = moveVectorGradientHandle(g, bounds, part.handle, local(to), local(drag.startDoc));
		} else if (part.kind === 'bar') {
			next = moveVectorGradientHandle(g, bounds, 'start', local(p), local(drag.startDoc));
		} else {
			const a = drag.annotator!;
			const pos = vectorGradientBarPosition(a, screen);
			const stops = sortedVectorGradientStops(g);
			if (part.kind === 'stop') {
				const off = Math.abs(pos.across - VECTOR_GRADIENT_STOP_GAP) > VECTOR_GRADIENT_OFF_BAR;
				const removed = off ? removeVectorGradientStop(stops, part.index) : null;
				if (removed) {
					next = { ...g, stops: removed };
					drag.stop = null;
				} else {
					const r = moveVectorGradientStop(stops, part.index, Math.min(1, Math.max(0, pos.offset)));
					next = { ...g, stops: r.stops };
					drag.stop = r.index;
				}
				this.interaction = { type: 'gradient', part: 'stop', ...(removed ? { removing: true } : {}) };
				this.gradientEdit = { ...this.gradientEdit, stop: drag.stop };
			} else {
				const m = vectorGradientMidpointFromPosition(stops, part.index, pos.offset);
				if (m !== null) next = { ...g, stops: stops.map((s, i) => (i !== part.index ? s : Math.abs(m - 0.5) < 1e-3 ? (({ midpoint: _m, ...rest }) => rest)(s) : { ...s, midpoint: m })) };
			}
		}
		this.doc = this.withGradient(base, id, target, next);
		this.notify(true);
	}

	private upGradient(drag: Extract<Drag, { kind: 'gradient' }>) {
		const part = drag.part;
		if (!drag.moved) {
			if (part?.kind === 'bar') {
				this.addGradientStop(part.offset);
				return;
			}
			this.notify();
			return;
		}
		const label = !part
			? 'Gradient'
			: part.kind === 'stop'
				? drag.stop === null
					? 'Delete Gradient Stop'
					: 'Move Gradient Stop'
				: part.kind === 'midpoint'
					? 'Gradient Midpoint'
					: part.kind === 'bar' || (part.kind === 'handle' && part.handle === 'start')
						? 'Move Gradient'
						: 'Gradient Handle';
		return this.commit(label, drag.before);
	}

	/** Removes one width point of a path's profile. */
	removeWidthPoint(ref: Pick<VectorWidthPointRef, 'nodeId' | 'index'>): VectorActionResult {
		return this.removeWidthPoints([ref]);
	}

	/** Removes width points (default: the selected ones — the width tool's Delete), as one undo step. */
	removeWidthPoints(refs: readonly Pick<VectorWidthPointRef, 'nodeId' | 'index'>[] = this.widthPoints): VectorActionResult {
		const byNode = new Map<string, number[]>();
		for (const r of refs) {
			const node = this.getNode(r.nodeId);
			if (node?.type !== 'path' || !node.strokeWidthProfile?.[r.index]) continue;
			byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r.index]);
		}
		if (!byNode.size) return { ok: false, message: 'There is no such width point.' };
		const count = [...byNode.values()].reduce((n, l) => n + new Set(l).size, 0);
		this.widthPoints = [];
		this.widthEdit = null;
		this.change(count > 1 ? 'Delete Width Points' : 'Delete Width Point', () => {
			for (const [id, indices] of byNode) {
				const node = this.getNode(id) as VectorPathNode;
				const rest = removeWidthPoints(sanitizeWidthProfile(node.strokeWidthProfile), indices);
				this.replaceNode(id, withStyle(node, { strokeWidthProfile: rest.length ? rest : null }));
			}
		});
		return { ok: true };
	}

	/** Selects width points (width tool); points on other paths than the first are dropped. */
	selectWidthPoints(refs: readonly VectorWidthPointRef[]): void {
		const first = refs[0]?.nodeId;
		const next: VectorWidthPointRef[] = [];
		for (const r of refs) {
			if (r.nodeId !== first || next.some((q) => q.index === r.index)) continue;
			const n = this.getNode(r.nodeId);
			if (n?.type === 'path' && n.strokeWidthProfile?.[r.index]) next.push({ nodeId: r.nodeId, index: r.index, subpath: r.subpath ?? 0 });
		}
		this.widthPoints = next;
		this.notify();
	}

	/**
	 * Sets one width point numerically: `index` names an existing point of path `nodeId`, null
	 * (or left out) adds one at `values.t`. `left` / `right` are side widths in document units
	 * (how far the stroke reaches on each side of the path), `t` the position along each subpath
	 * (0–1). A point moved onto another one's `t` makes a step there. Selects the point and
	 * refreshes an open width-point editor; one undo step. Ported from ArtCraft vectorcraft's
	 * Width Point Edit dialog (`crates/tools/src/distort/width.rs`, MIT OR Apache-2.0).
	 */
	setWidthPoint(target: { nodeId: string; index?: number | null }, values: { t?: number; left?: number; right?: number }): VectorActionResult {
		const node = this.getNode(target.nodeId);
		if (node?.type !== 'path') return { ok: false, message: 'There is no such path.' };
		const g = vectorStrokeWidthGeometry(node);
		if (!g || !(g.unit > 0)) return { ok: false, message: 'The path has no visible stroke.' };
		const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
		const t = num(values.t);
		const left = num(values.left);
		const right = num(values.right);
		const scale = (w: number | undefined) => (w === undefined ? undefined : Math.max(0, w) / g.unit);
		const profile = sanitizeWidthProfile(node.strokeWidthProfile);
		let points: VectorWidthPoint[];
		let index: number;
		const existing = target.index ?? null;
		if (existing === null) {
			if (t === undefined) return { ok: false, message: 'A new width point needs a position t.' };
			if (profile.length >= VECTOR_WIDTH_PROFILE_MAX_POINTS) return { ok: false, message: 'The profile has too many width points.' };
			({ points, index } = insertWidthPoint(profile.length ? profile : null, t, { left: scale(left), right: scale(right) }, { step: true }));
		} else {
			const p = profile[existing];
			if (!p) return { ok: false, message: 'There is no such width point.' };
			const sides = { left: scale(left) ?? p.left, right: scale(right) ?? p.right };
			const tt = t === undefined ? p.t : Math.min(Math.max(t, 0), 1);
			if (Math.abs(tt - p.t) <= VECTOR_WIDTH_SAME_T) {
				points = setWidthPoint(profile, existing, sides);
				index = existing;
			} else {
				// Free to pass its neighbours: take it out and put it back at its new place.
				const rest = removeWidthPoints(profile, [existing]);
				if (rest.length) ({ points, index } = insertWidthPoint(rest, tt, sides, { step: true }));
				else {
					points = [{ t: tt, ...sides }];
					index = 0;
				}
			}
		}
		const subpath = this.widthEdit?.nodeId === node.id ? this.widthEdit.subpath : this.widthPoints.find((r) => r.nodeId === node.id)?.subpath ?? 0;
		const edit = this.widthEdit;
		this.change('Width Point', () => this.replaceNode(node.id, withStyle(node, { strokeWidthProfile: points })));
		this.widthPoints = [{ nodeId: node.id, index, subpath }];
		if (edit?.nodeId === node.id && (edit.index === existing || existing === null)) this.widthEdit = this.widthEditFor(node.id, subpath, index, null);
		this.notify();
		return { ok: true };
	}

	/**
	 * Opens the width-point editor (what a double-click with the width tool does) on a width
	 * point, or on a spot of a stroke (`t` without `index`: applying it adds a point there).
	 * Returns false when the path has no visible stroke.
	 */
	openWidthPointEdit(target: { nodeId: string; subpath?: number; index?: number | null; t?: number }): boolean {
		const edit = this.widthEditFor(target.nodeId, target.subpath ?? 0, target.index ?? null, target.t ?? null);
		if (!edit) return false;
		this.widthEdit = edit;
		this.widthPoints = edit.index === null ? [] : [{ nodeId: edit.nodeId, index: edit.index, subpath: edit.subpath }];
		this.notify();
		return true;
	}

	/** Closes the width-point editor without changing anything. */
	closeWidthPointEdit(): void {
		if (!this.widthEdit) return;
		this.widthEdit = null;
		this.notify();
	}

	/** Applies `values` to the width point being edited (see `setWidthPoint`) and closes the editor. */
	commitWidthPointEdit(values: { t?: number; left?: number; right?: number }): VectorActionResult {
		const edit = this.widthEdit;
		if (!edit) return { ok: false, message: 'No width point is being edited.' };
		const r = this.setWidthPoint({ nodeId: edit.nodeId, index: edit.index }, edit.index === null ? { t: edit.t, ...values } : values);
		if (r.ok) this.closeWidthPointEdit();
		return r;
	}

	/** The editor's view of point `index` (or of the stroke at `t` when index is null) of `nodeId`. */
	private widthEditFor(nodeId: string, subpath: number, index: number | null, t: number | null): VectorWidthPointEdit | null {
		const node = this.getNode(nodeId);
		if (node?.type !== 'path') return null;
		const g = vectorStrokeWidthGeometry(node);
		if (!g) return null;
		const profile = sanitizeWidthProfile(node.strokeWidthProfile);
		const p = index === null ? null : profile[index];
		if (index !== null && !p) return null;
		const tt = p ? p.t : Math.min(Math.max(t ?? 0, 0), 1);
		const sides = p ?? widthProfileAt(profile.length ? profile : null, tt);
		const sp = Math.min(Math.max(0, subpath), Math.max(0, node.subpaths.length - 1));
		const at = strokePositionPoint(g.line, sp, tt);
		const round = (v: number) => Math.round(v * 1e6) / 1e6;
		const q = at ? applyMatrix(this.worldOf(nodeId), { x: at.point[0], y: at.point[1] }) : { x: 0, y: 0 };
		const point = { x: round(q.x), y: round(q.y) };
		return { nodeId, subpath: sp, index, t: round(tt), left: round(sides.left * g.unit), right: round(sides.right * g.unit), point };
	}

	/**
	 * Sets the live corner radius (and optionally the kind) of anchors: `refs`, else the selected
	 * anchors (direct tool), else every anchor of the `ids` / selected paths. Radius 0 makes the
	 * corners sharp again. Corners shrink to fit when drawn, so any radius is accepted.
	 */
	setCornerRadius(radius: number, options: { kind?: VectorCornerKind; smoothing?: number; refs?: readonly VectorAnchorRef[]; ids?: readonly string[] } = {}): VectorActionResult {
		if (!Number.isFinite(radius) || radius < 0) return { ok: false, message: 'The radius must be a number of at least 0.' };
		if (options.smoothing !== undefined && !(options.smoothing >= 0 && options.smoothing <= 1)) return { ok: false, message: 'Corner smoothing must be from 0 to 1.' };
		const refs = this.cornerTargets(options);
		if (!refs.length) return { ok: false, message: 'Nothing is selected.' };
		this.change(radius > 0 ? 'Corner Radius' : 'Sharpen Corners', () => {
			this.doc = this.updateAnchors(this.doc, refs, (a) => setAnchorCorner(a, radius, options.kind, options.smoothing));
		});
		return { ok: true };
	}

	/** Sets corner smoothing (squircle, 0–1) of the same anchors as `setCornerRadius`, keeping their radii. */
	setCornerSmoothing(smoothing: number, options: { refs?: readonly VectorAnchorRef[]; ids?: readonly string[]; merge?: string } = {}): VectorActionResult {
		if (!(smoothing >= 0 && smoothing <= 1)) return { ok: false, message: 'Corner smoothing must be from 0 to 1.' };
		const refs = this.cornerTargets(options).filter((r) => (getAnchor(this.doc, r)?.corner?.radius ?? 0) > 0);
		if (!refs.length) return { ok: false, message: 'Give the corners a radius first: smoothing shapes rounded corners.' };
		this.change(
			'Corner Smoothing',
			() => {
				this.doc = this.updateAnchors(this.doc, refs, (a) => setAnchorCorner(a, a.corner?.radius ?? 0, undefined, smoothing));
			},
			options.merge
		);
		return { ok: true };
	}

	/** Sets the live corner kind of the same anchors as `setCornerRadius`, keeping their radii. */
	setCornerKind(kind: VectorCornerKind, options: { refs?: readonly VectorAnchorRef[]; ids?: readonly string[] } = {}): VectorActionResult {
		const refs = this.cornerTargets(options);
		if (!refs.length) return { ok: false, message: 'Nothing is selected.' };
		this.change('Corner Kind', () => {
			this.doc = this.updateAnchors(this.doc, refs, (a) => setAnchorCorner(a, a.corner?.radius ?? 0, kind));
		});
		return { ok: true };
	}

	/** Anchors a corner change applies to (see `setCornerRadius`). */
	private cornerTargets(options: { refs?: readonly VectorAnchorRef[]; ids?: readonly string[] }): VectorAnchorRef[] {
		if (options.refs) return options.refs.filter((r) => getAnchor(this.doc, r));
		if (!options.ids && this.tool === 'direct' && this.anchors.length) return this.anchors.slice();
		const out: VectorAnchorRef[] = [];
		for (const id of options.ids ?? this.selection) {
			const node = this.getNode(id);
			if (!node) continue;
			for (const p of collectPathNodes(node)) {
				if (p.locked) continue;
				p.subpaths.forEach((sp, s) => sp.anchors.forEach((_, i) => out.push({ nodeId: p.id, subpath: s, index: i })));
			}
		}
		return out;
	}

	/**
	 * Outline Stroke: replaces each selected (or given) path's stroke with a filled path of the
	 * area it paints (alignment, joins, caps, dashes and arrowheads included), placed above a copy
	 * of the path that keeps the fill (left out when there is none). Returns the new paths' ids.
	 */
	outlineStroke(options: { ids?: readonly string[] } = {}): string[] {
		const roots = options.ids ?? this.selectedRoots();
		const strokesOf = (p: VectorPathNode) => vectorPaintLayerNodes(p).filter((l) => l.kind === 'stroke' && l.drawn && (l.node.strokeWidth ?? 1) > 0);
		const paths: VectorPathNode[] = [];
		for (const id of roots) {
			const node = this.getNode(id);
			if (node) for (const p of collectPathNodes(node)) if (!p.locked && strokesOf(p).length) paths.push(p);
		}
		if (!paths.length) return [];
		const created: string[] = [];
		const replace = new Map<string, VectorNode[]>();
		for (const p of paths) {
			const { effects, ...rest } = cloneVectorNode(p);
			const unstroked = withVectorStrokes(rest as VectorPathNode, []);
			for (const key of VECTOR_STROKE_SETTING_KEYS) delete unstroked[key];
			const list: VectorNode[] = vectorFills(p).length ? [{ ...unstroked, ...(effects ? { effects } : {}) }] : [];
			// One filled path per stroke layer, bottom to top, painted (and blended) like it.
			const layers = strokesOf(p);
			for (const l of layers) {
				// In the node's own space: the new paths keep its transform.
				// As drawn: path effects applied (the outline itself carries none).
				const outline = bezierToSubpaths(vectorStrokeOutlinePath(vectorAppearanceOutline(p), l.node));
				if (!outline.length) continue;
				const id = this.newId();
				const { strokes: _s, fills: _f, ...plain } = unstroked;
				const name = layers.length > 1 ? `${p.name ?? 'Path'} Stroke ${l.index + 1}` : `${p.name ?? 'Path'} Stroke`;
				const fill: VectorPaintLayer = { paint: l.layer.paint };
				if (l.layer.opacity !== undefined) fill.opacity = l.layer.opacity;
				if (l.layer.blendMode) fill.blendMode = l.layer.blendMode;
				list.push(withVectorFills({ ...plain, id, name, subpaths: outline, stroke: null, fillRule: 'nonzero' } as VectorPathNode, [fill]));
				created.push(id);
			}
			replace.set(p.id, list);
		}
		if (!created.length) return [];
		this.change('Outline Stroke', () => {
			let nodes = this.doc.nodes;
			for (const [id, list] of replace) nodes = spliceTree(nodes, id, list);
			this.setDoc(nodes);
			this.selection = created;
			this.anchors = [];
			this.editingId = null;
		});
		return created;
	}

	// -------------------------------------------------------------------------
	// Fill and stroke stacks, blend modes, filters
	// -------------------------------------------------------------------------

	/** Paths of the selected (or given) nodes whose stacks can be edited (groups give every path inside; blend steps are left out). */
	private stackTargets(ids: readonly string[] | undefined): VectorPathNode[] | string {
		const list = ids ?? this.selection;
		if (!list.length) return 'Nothing is selected.';
		const out = new Map<string, VectorPathNode>();
		for (const id of list) {
			const node = this.getNode(id);
			if (!node) return `There is no node "${id}".`;
			for (const p of collectPaintedNodes(node)) if (!p.blendStep) out.set(p.id, p as VectorPathNode);
		}
		if (!out.size) return 'The selection has no paths or text (fills and strokes belong to them).';
		return [...out.values()];
	}

	/** Applies `fn` to the `kind` stack of every target path as one undo step (an error string from any path cancels it). */
	private editStacks(
		kind: 'fill' | 'stroke',
		ids: readonly string[] | undefined,
		label: string,
		fn: (stack: VectorStrokeLayer[], path: VectorPathNode) => VectorStrokeLayer[] | string,
		merge?: string
	): VectorActionResult {
		const targets = this.stackTargets(ids);
		if (typeof targets === 'string') return { ok: false, message: targets };
		const next = new Map<string, VectorNode>();
		for (const path of targets) {
			const stack = kind === 'fill' ? vectorFills(path) : vectorStrokes(path);
			const result = fn(stack.map((l) => ({ ...l })), path);
			if (typeof result === 'string') return { ok: false, message: result };
			next.set(path.id, kind === 'fill' ? withVectorFills(path, result) : withVectorStrokes(path, result));
		}
		this.change(label, () => this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n)), merge);
		return { ok: true };
	}

	/**
	 * Reads a layer patch from untrusted input: paint, opacity, blend mode, visibility and (strokes)
	 * the stroke settings, where `null` removes a setting. Returns an error string for invalid values.
	 */
	private layerPatch(kind: 'fill' | 'stroke', patch: Record<string, unknown>): { set: Partial<VectorStrokeLayer>; unset: string[] } | string {
		const set: Record<string, unknown> = {};
		const unset: string[] = [];
		if ('paint' in patch) {
			const paint = patch.paint;
			if (paint === null || (typeof paint === 'string' && paint.trim())) set.paint = paint === null ? null : (paint as string).trim();
			else {
				const g = sanitizeVectorGradient(paint);
				if (!g) return 'paint must be a CSS colour, a gradient { type, stops: [{ offset, color }] } or null.';
				set.paint = g;
			}
		}
		if (patch.opacity !== undefined) {
			if (typeof patch.opacity !== 'number' || !Number.isFinite(patch.opacity)) return 'opacity must be a number from 0 to 1.';
			const o = Math.min(1, Math.max(0, patch.opacity));
			if (o < 1) set.opacity = o;
			else unset.push('opacity');
		}
		if (patch.blendMode !== undefined) {
			if (!isVectorBlendMode(patch.blendMode)) return `Unknown blend mode "${String(patch.blendMode)}". Use one of: ${VECTOR_BLEND_MODES.join(', ')}.`;
			if (patch.blendMode !== 'normal') set.blendMode = patch.blendMode;
			else unset.push('blendMode');
		}
		if (patch.visible !== undefined) {
			if (typeof patch.visible !== 'boolean') return 'visible must be true or false.';
			if (patch.visible) unset.push('visible');
			else set.visible = false;
		}
		if (kind === 'stroke') {
			const settings = sanitizeVectorStrokeSettings(patch);
			for (const key of VECTOR_STROKE_SETTING_KEYS) {
				if (!(key in patch) || patch[key] === undefined) continue;
				if (patch[key] === null || (key === 'strokeDasharray' && Array.isArray(patch[key]) && !(patch[key] as unknown[]).length)) unset.push(key);
				else if (settings[key] === undefined) return `Invalid ${key}: ${JSON.stringify(patch[key])}.`;
				else set[key] = settings[key];
			}
		}
		return { set: set as Partial<VectorStrokeLayer>, unset };
	}

	/**
	 * Adds a fill or stroke layer to the selected (or given) paths (groups: every path inside), at
	 * the top of the stack or at `index` (0 is the bottom). A new stroke takes the settings of the
	 * stack's top stroke unless `layer` gives them. One undo step.
	 */
	addPaintLayer(kind: 'fill' | 'stroke', layer: Record<string, unknown> = {}, options: { ids?: readonly string[]; index?: number } = {}): VectorActionResult {
		const patch = this.layerPatch(kind, layer);
		if (typeof patch === 'string') return { ok: false, message: patch };
		return this.editStacks(kind, options.ids, kind === 'fill' ? 'Add Fill' : 'Add Stroke', (stack, path) => {
			const base: VectorStrokeLayer = kind === 'fill' ? { paint: '#808080' } : newVectorStrokeLayer(path, {});
			const added = { ...base, ...patch.set } as VectorStrokeLayer;
			for (const key of patch.unset) delete (added as unknown as Record<string, unknown>)[key];
			const at = options.index === undefined ? stack.length : Math.min(stack.length, Math.max(0, Math.round(options.index)));
			return [...stack.slice(0, at), added, ...stack.slice(at)];
		});
	}

	/**
	 * Changes layer `index` (0 is the bottom) of the fill or stroke stack of the selected (or given)
	 * paths: paint, opacity, blend mode, visibility and, for strokes, any stroke setting (`null`
	 * removes it). Fails, changing nothing, when a path has no layer `index`. With `merge` (true, or
	 * a key), consecutive edits of the layer fold into one undo step (a slider drag).
	 */
	updatePaintLayer(kind: 'fill' | 'stroke', index: number, patch: Record<string, unknown>, options: { ids?: readonly string[]; merge?: boolean | string } = {}): VectorActionResult {
		const parsed = this.layerPatch(kind, patch);
		if (typeof parsed === 'string') return { ok: false, message: parsed };
		const merge = options.merge === true ? `paint-layer:${kind}:${index}` : options.merge || undefined;
		return this.editStacks(
			kind,
			options.ids,
			kind === 'fill' ? 'Edit Fill' : 'Edit Stroke',
			(stack, path) => {
				if (!stack[index]) return `Path "${path.id}" has no ${kind} ${index} (it has ${stack.length}; 0 is the bottom).`;
				const layer = { ...stack[index], ...parsed.set } as VectorStrokeLayer;
				for (const key of parsed.unset) delete (layer as unknown as Record<string, unknown>)[key];
				return stack.map((l, i) => (i === index ? layer : l));
			},
			merge
		);
	}

	/** Removes layer `index` of the fill or stroke stack of the selected (or given) paths. */
	removePaintLayer(kind: 'fill' | 'stroke', index: number, options: { ids?: readonly string[] } = {}): VectorActionResult {
		return this.editStacks(kind, options.ids, kind === 'fill' ? 'Remove Fill' : 'Remove Stroke', (stack, path) =>
			stack[index] ? stack.filter((_, i) => i !== index) : `Path "${path.id}" has no ${kind} ${index} (it has ${stack.length}; 0 is the bottom).`
		);
	}

	/** Moves layer `from` of the fill or stroke stack to position `to` (0 is the bottom) on the selected (or given) paths. */
	movePaintLayer(kind: 'fill' | 'stroke', from: number, to: number, options: { ids?: readonly string[] } = {}): VectorActionResult {
		return this.editStacks(kind, options.ids, kind === 'fill' ? 'Reorder Fills' : 'Reorder Strokes', (stack, path) => {
			if (!stack[from]) return `Path "${path.id}" has no ${kind} ${from} (it has ${stack.length}; 0 is the bottom).`;
			const out = stack.slice();
			const [layer] = out.splice(from, 1);
			out.splice(Math.min(out.length, Math.max(0, Math.round(to))), 0, layer);
			return out;
		});
	}

	/** Replaces the whole fill or stroke stack of the selected (or given) paths (malformed layers are dropped). */
	setPaintLayers(kind: 'fill' | 'stroke', layers: readonly unknown[], options: { ids?: readonly string[] } = {}): VectorActionResult {
		const clean = kind === 'fill' ? sanitizeVectorFills(layers) : sanitizeVectorStrokes(layers);
		return this.editStacks(kind, options.ids, kind === 'fill' ? 'Set Fills' : 'Set Strokes', () => clean as VectorStrokeLayer[]);
	}

	/** Sets the blend mode of the selected (or given) nodes (paths or groups); `normal` removes it. */
	setBlendMode(mode: VectorBlendMode, options: { ids?: readonly string[] } = {}): VectorActionResult {
		if (!isVectorBlendMode(mode)) return { ok: false, message: `Unknown blend mode "${String(mode)}". Use one of: ${VECTOR_BLEND_MODES.join(', ')}.` };
		const ids = options.ids ?? this.selectedRoots();
		if (!ids.length) return { ok: false, message: 'Nothing is selected.' };
		for (const id of ids) if (!this.getNode(id)) return { ok: false, message: `There is no node "${id}".` };
		const set = new Set(ids);
		this.change('Blend Mode', () =>
			this.setDoc(
				mapTree(this.doc.nodes, (n) => {
					if (!set.has(n.id) || (n.blendMode ?? 'normal') === mode) return n;
					const { blendMode: _b, ...rest } = n;
					return (mode === 'normal' ? rest : { ...rest, blendMode: mode }) as VectorNode;
				})
			)
		);
		return { ok: true };
	}

	/**
	 * Adds a filter of `type` to the selected (or given) nodes, at the end of each stack (or at
	 * `index`), with default parameters merged with `params`. One undo step; returns the new filter
	 * ids (one per node, in order), empty for an unknown type or nothing selected.
	 */
	addFilter(type: VectorFilterType, options: { ids?: readonly string[]; params?: Record<string, unknown>; index?: number } = {}): string[] {
		if (!isVectorFilterType(type)) return [];
		const targets = this.effectTargets(options.ids);
		if (!targets.length) return [];
		const created: string[] = [];
		const next = new Map<string, VectorNode>();
		for (const node of targets) {
			const list = node.filters ?? [];
			let k = list.length + 1;
			while (list.some((f) => f.id === `filter${k}`)) k++;
			const filter = createVectorFilter(type, `filter${k}`, options.params)!;
			const at = options.index === undefined ? list.length : Math.min(list.length, Math.max(0, Math.round(options.index)));
			next.set(node.id, { ...node, filters: [...list.slice(0, at), filter, ...list.slice(at)] } as VectorNode);
			created.push(filter.id);
		}
		this.change(`Add ${VECTOR_FILTER_LABELS[type]}`, () => this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n)));
		return created;
	}

	private editFilters(nodeId: string, label: string, fn: (filters: VectorFilter[]) => VectorFilter[] | string, merge?: string): VectorActionResult {
		const node = this.getNode(nodeId);
		if (!node) return { ok: false, message: `There is no node "${nodeId}".` };
		const result = fn(node.filters ?? []);
		if (typeof result === 'string') return { ok: false, message: result };
		this.change(label, () => this.replaceNode(nodeId, (result.length ? { ...node, filters: result } : (({ filters: _f, ...rest }) => rest)(node)) as VectorNode), merge);
		return { ok: true };
	}

	/**
	 * Turns a filter on or off and changes its parameters (invalid values are ignored). With
	 * `merge`, consecutive updates of the same filter fold into one undo step.
	 */
	updateFilter(nodeId: string, filterId: string, patch: { enabled?: boolean; params?: Record<string, unknown> }, options: { merge?: boolean | string } = {}): VectorActionResult {
		const merge = options.merge === true ? `filter:${nodeId}:${filterId}` : options.merge || undefined;
		const current = this.getNode(nodeId)?.filters?.find((f) => f.id === filterId);
		return this.editFilters(
			nodeId,
			`Edit ${current ? VECTOR_FILTER_LABELS[current.type] : 'Filter'}`,
			(list) => {
				const i = list.findIndex((f) => f.id === filterId);
				if (i < 0) return `Node "${nodeId}" has no filter "${filterId}".`;
				const f = list[i];
				const params = patch.params ? normalizeVectorFilterParams(f.type, patch.params, f.params as never) : f.params;
				const next = { ...f, params, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) } as VectorFilter;
				if (next.enabled !== false) delete (next as { enabled?: boolean }).enabled;
				return list.map((x, j) => (j === i ? next : x));
			},
			merge
		);
	}

	/** Removes a filter from a node's stack. */
	removeFilter(nodeId: string, filterId: string): VectorActionResult {
		return this.editFilters(nodeId, 'Remove Filter', (list) => (list.some((f) => f.id === filterId) ? list.filter((f) => f.id !== filterId) : `Node "${nodeId}" has no filter "${filterId}".`));
	}

	/** Moves a filter to position `index` of its node's stack. */
	moveFilter(nodeId: string, filterId: string, index: number): VectorActionResult {
		return this.editFilters(nodeId, 'Reorder Filters', (list) => {
			const i = list.findIndex((f) => f.id === filterId);
			if (i < 0) return `Node "${nodeId}" has no filter "${filterId}".`;
			const out = list.slice();
			const [f] = out.splice(i, 1);
			out.splice(Math.min(out.length, Math.max(0, Math.round(index))), 0, f);
			return out;
		});
	}

	// -------------------------------------------------------------------------
	// Path effects
	// -------------------------------------------------------------------------

	/** Selected (or given) nodes that can carry effects: the roots of the selection. */
	private effectTargets(ids?: readonly string[]): VectorNode[] {
		return (ids ?? this.selectedRoots()).map((id) => this.getNode(id)).filter((n): n is VectorNode => !!n && !n.blendStep);
	}

	/**
	 * Adds an effect of `type` to the selected (or given) nodes, at the bottom of each stack (or
	 * at `index`), with default parameters merged with `params`. A repeater's copies start one
	 * shape width apart. One undo step; returns the new effect ids (one per node, in order).
	 */
	addEffect(type: VectorEffectType, options: { ids?: readonly string[]; params?: Record<string, unknown>; index?: number } = {}): string[] {
		const targets = this.effectTargets(options.ids);
		if (!targets.length || !createVectorEffect(type, '')) return [];
		const created: string[] = [];
		const next = new Map<string, VectorNode>();
		for (const node of targets) {
			const list = node.effects ?? [];
			let k = list.length + 1;
			while (list.some((e) => e.id === `fx${k}`)) k++;
			const params: Record<string, unknown> = { ...(options.params ?? {}) };
			if (type === 'repeater' && params.position === undefined) {
				const b = bezierPathBounds(vectorAppearanceOutline(node));
				if (b && b.maxX - b.minX > 0) params.position = { x: Math.round((b.maxX - b.minX) * 1.25 * 100) / 100, y: 0 };
			}
			const effect = createVectorEffect(type, `fx${k}`, params)!;
			const at = options.index === undefined ? list.length : Math.min(list.length, Math.max(0, Math.round(options.index)));
			next.set(node.id, { ...node, effects: [...list.slice(0, at), effect, ...list.slice(at)] } as VectorNode);
			created.push(effect.id);
		}
		this.change(`Add ${VECTOR_EFFECT_LABELS[type]}`, () => this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n)));
		return created;
	}

	private editEffects(nodeId: string, label: string, fn: (effects: VectorEffect[]) => VectorEffect[] | string, merge?: string): VectorActionResult {
		const node = this.getNode(nodeId);
		if (!node) return { ok: false, message: `There is no node "${nodeId}".` };
		const result = fn(node.effects ?? []);
		if (typeof result === 'string') return { ok: false, message: result };
		this.change(label, () => this.replaceNode(nodeId, (result.length ? { ...node, effects: result } : (({ effects: _e, ...rest }) => rest)(node)) as VectorNode), merge);
		return { ok: true };
	}

	/**
	 * Turns an effect on or off and changes its parameters (unknown or invalid values are
	 * ignored). With `merge` (true, or a key of your own), consecutive updates of the same effect
	 * fold into one undo step, as a slider drag should; call `endMergedEdit` when it ends.
	 */
	updateEffect(nodeId: string, effectId: string, patch: { enabled?: boolean; params?: Record<string, unknown> }, options: { merge?: boolean | string } = {}): VectorActionResult {
		const merge = options.merge === true ? `effect:${nodeId}:${effectId}` : options.merge || undefined;
		const node = this.getNode(nodeId);
		const current = node?.effects?.find((e) => e.id === effectId);
		const label = current ? VECTOR_EFFECT_LABELS[current.type] ?? 'Effect' : 'Effect';
		return this.editEffects(
			nodeId,
			`Edit ${label}`,
			(list) => {
				const i = list.findIndex((e) => e.id === effectId);
				if (i < 0) return `Node "${nodeId}" has no effect "${effectId}".`;
				const e = list[i];
				const raw = patch.params && e.type === 'envelope' && node ? this.envelopeParams(node, e, patch.params) : patch.params;
				const params = raw ? normalizeVectorEffectParams(e.type, raw, e.params as never) : e.params;
				const next = { ...e, params, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) } as VectorEffect;
				if (next.enabled !== false) delete (next as { enabled?: boolean }).enabled;
				return list.map((x, j) => (j === i ? next : x));
			},
			merge
		);
	}

	/** Removes an effect from a node's stack. */
	removeEffect(nodeId: string, effectId: string): VectorActionResult {
		return this.editEffects(nodeId, 'Remove Effect', (list) => (list.some((e) => e.id === effectId) ? list.filter((e) => e.id !== effectId) : `Node "${nodeId}" has no effect "${effectId}".`));
	}

	/** Moves an effect to position `index` of its stack (0 is applied first). */
	moveEffect(nodeId: string, effectId: string, index: number): VectorActionResult {
		return this.editEffects(nodeId, 'Reorder Effects', (list) => {
			const i = list.findIndex((e) => e.id === effectId);
			if (i < 0) return `Node "${nodeId}" has no effect "${effectId}".`;
			const to = Math.min(list.length - 1, Math.max(0, Math.round(index)));
			const out = list.slice();
			const [e] = out.splice(i, 1);
			out.splice(to, 0, e);
			return out;
		});
	}

	/**
	 * Expand Appearance: bakes the path effects and live booleans of the selected (or given)
	 * nodes, and of everything inside them, into plain paths. A node keeps its id (a group when
	 * it draws as several shapes); the shapes it made get new ids. Returns the ids of the expanded
	 * nodes (empty when none was live).
	 */
	expandAppearance(options: { ids?: readonly string[] } = {}): string[] {
		const roots = (options.ids ?? this.selectedRoots()).map((id) => this.getNode(id)).filter((n): n is VectorNode => !!n && hasVectorAppearance(n));
		if (!roots.length) return [];
		const fresh = (n: VectorNode): VectorNode => {
			const id = n.id.includes('~fx') ? this.newId() : n.id;
			return n.type === 'group' ? { ...n, id, children: n.children.map(fresh) } : { ...n, id };
		};
		const bake = (n: VectorNode): VectorNode => {
			if (!hasVectorAppearance(n)) return n;
			if (!hasOwnVectorAppearance(n)) return { ...(n as VectorGroupNode), children: (n as VectorGroupNode).children.map(bake) };
			let e = expandVectorAppearance(n);
			// A live group that draws as one shape becomes that path, in the group's place.
			if (e.type === 'group' && e.children.length === 1 && e.children[0].type === 'path') {
				const { id: _id, opacity, name, ...child } = e.children[0];
				const k = (e.opacity ?? 1) * (opacity ?? 1);
				e = { ...child, id: e.id, name: e.name ?? name, ...placementOf(e), ...(k < 1 ? { opacity: k } : {}) } as VectorPathNode;
			}
			return fresh(e);
		};
		const next = new Map(roots.map((n) => [n.id, bake(n)]));
		this.change('Expand Appearance', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n));
			this.anchors = [];
			this.editingId = null;
		});
		return roots.map((n) => n.id);
	}

	rename(id: string, name: string): VectorActionResult {
		return this.updateNode(id, { name }, { label: 'Rename' });
	}

	setVisible(id: string, visible: boolean): VectorActionResult {
		return this.updateNode(id, { visible }, { label: visible ? 'Show' : 'Hide' });
	}

	setLocked(id: string, locked: boolean): VectorActionResult {
		const result = this.updateNode(id, { locked }, { label: locked ? 'Lock' : 'Unlock' });
		if (locked && result.ok && this.selection.includes(id)) {
			this.selection = this.selection.filter((s) => s !== id);
			this.notify();
		}
		return result;
	}

	/** Removes nodes by id. */
	removeNodes(ids: readonly string[], options: { label?: string } = {}): VectorActionResult {
		const drop = new Set(ids.filter((id) => this.getNode(id)));
		if (!drop.size) return { ok: false, message: 'Nothing to delete.' };
		this.change(options.label ?? 'Delete', () => {
			// Deleting a mask releases its group (the next child must not become the mask).
			this.setDoc(mapTree(this.doc.nodes, (n) => (drop.has(n.id) ? null : isVectorMaskGroup(n) && drop.has(n.children[0].id) ? { ...n, mask: null } : n)));
			this.selection = this.selection.filter((id) => !drop.has(id) && this.getNode(id));
			this.anchors = this.anchors.filter((r) => getAnchor(this.doc, r));
			if (this.editingId && !this.getNode(this.editingId)) this.editingId = null;
			if (this.pen && !this.getNode(this.pen.nodeId)) this.pen = null;
		});
		return { ok: true };
	}

	// -------------------------------------------------------------------------
	// Selection
	// -------------------------------------------------------------------------

	select(ids: readonly string[], options: { add?: boolean; toggle?: boolean } = {}): void {
		const valid = ids.filter((id) => this.getNode(id));
		let next: string[];
		if (options.toggle) {
			const set = new Set(this.selection);
			for (const id of valid) set.has(id) ? set.delete(id) : set.add(id);
			next = [...set];
		} else next = options.add ? [...new Set([...this.selection, ...valid])] : valid;
		this.selection = next;
		if (!options.add && !options.toggle) this.anchors = this.anchors.filter((r) => next.includes(r.nodeId));
		this.notify();
	}

	selectAll(): void {
		if (this.tool === 'direct' && this.editingId) {
			this.anchors = getVisibleAnchors(this.view());
		} else {
			this.selection = this.doc.nodes.filter((n) => !n.locked && n.visible !== false).map((n) => n.id);
		}
		this.notify();
	}

	clearSelection(): void {
		if (!this.selection.length && !this.anchors.length && !this.editingId) return;
		this.selection = [];
		this.anchors = [];
		this.editingId = null;
		this.notify();
	}

	selectAnchors(refs: readonly VectorAnchorRef[], options: { add?: boolean } = {}): void {
		const valid = refs.filter((r) => getAnchor(this.doc, r));
		this.anchors = options.add ? [...this.anchors, ...valid.filter((r) => !this.anchors.some((a) => sameRef(a, r)))] : valid;
		if (valid.length && !this.editingId) this.editingId = valid[0].nodeId;
		this.notify();
	}

	/** Top-level ids of the selection (members of selected groups are covered by the group). */
	private selectedRoots(): string[] {
		return this.selection.filter((id) => {
			let covered = false;
			const loc = locateVectorNode(this.doc.nodes, id);
			let parent = loc?.parent ?? null;
			while (parent) {
				if (this.selection.includes(parent.id)) covered = true;
				parent = locateVectorNode(this.doc.nodes, parent.id)?.parent ?? null;
			}
			return !covered;
		});
	}

	// -------------------------------------------------------------------------
	// Transforms
	// -------------------------------------------------------------------------

	/** `m`, given in a frame rotated by `angle`, as a document-space matrix. */
	private inFrame(angle: number, m: AffineMatrix): AffineMatrix {
		if (!angle) return m;
		return multiplyMatrices(multiplyMatrices(rotateMatrix(-angle), m), rotateMatrix(angle));
	}

	/** The selection frame's corners in document space, clockwise from the top left. */
	private frameCorners(frame: VectorSelectionFrame): Vec2[] {
		const rot = rotateMatrix(frame.angle);
		return vectorBoxCorners(frame).map((c) => (frame.angle ? applyMatrix(rot, c) : c));
	}

	/** `doc` with nodes `ids` sent through `f` (a map of document space), each in its own space (see `distortVectorNode`). */
	private distorted(doc: VectorDocument, ids: ReadonlySet<string>, f: (p: Vec2) => Vec2, tolerance = VECTOR_DISTORT_TOLERANCE): VectorDocument {
		const visit = (list: readonly VectorNode[], parent: AffineMatrix): VectorNode[] => {
			let changed = false;
			const out = list.map((n) => {
				let next = n;
				if (ids.has(n.id) && !n.locked) next = distortVectorNode(n, parent, f, tolerance);
				else if (n.type === 'group') {
					const children = visit(n.children, multiplyMatrices(nodeMatrix(n), parent));
					if (children !== n.children) next = { ...n, children };
				}
				if (next !== n) changed = true;
				return next;
			});
			return changed ? out : (list as VectorNode[]);
		};
		const nodes = visit(doc.nodes, IDENTITY_MATRIX);
		return nodes === doc.nodes ? doc : { ...doc, nodes };
	}

	/**
	 * Free Distort mode of the selection box (`state.freeDistort`): dragging a corner distorts the
	 * selection in perspective, each corner on its own (Shift+Alt+Mod: symmetric perspective, the
	 * corner beside it moving the other way); dragging a side moves its two corners; Mod-dragging a
	 * side skews along it (Alt: about the centre). Each drag is one undo step.
	 */
	setFreeDistort(on: boolean): void {
		if (this.freeDistort === on) return;
		this.freeDistort = on;
		this.notify();
	}

	/**
	 * Distorts the selected (or given) nodes so the corners of their selection box (clockwise from
	 * the top left, in the box's own rotation) land on `corners` (document space): a projective map,
	 * so straight lines stay straight. Curves are followed within `tolerance` (document units).
	 * One undo step.
	 */
	distort(corners: readonly Vec2[], options: { ids?: readonly string[]; tolerance?: number } = {}): VectorActionResult {
		const ids = options.ids ?? this.selectedRoots();
		const frame = this.frameOf(ids);
		if (!frame) return { ok: false, message: 'Nothing is selected.' };
		if (!(frame.width > 0 && frame.height > 0)) return { ok: false, message: 'The selection has no area to distort.' };
		const from = this.frameCorners(frame);
		const h = corners.length === 4 ? vectorHomography(from, corners) : null;
		if (!h || !vectorHomographyKeepsQuad(h, from)) return { ok: false, message: 'The four corners must make a convex quadrilateral, clockwise from the top left.' };
		this.change('Distort', () => {
			this.doc = this.distorted(this.doc, new Set(ids), (p) => applyVectorHomography(h, p) ?? p, options.tolerance);
		});
		return { ok: true };
	}

	/**
	 * Skews the selected (or given) nodes along the selection box's own axes by `ax` degrees
	 * horizontally (x' = x + tan(ax)·y: vertical lines lean right for positive angles) and `ay`
	 * vertically, about `origin` (default: the box centre, document space). One undo step.
	 */
	skew(ax: number, ay = 0, options: { ids?: readonly string[]; origin?: Vec2 } = {}): VectorActionResult {
		const frame = this.frameOf(options.ids ?? this.selectedRoots());
		if (!frame) return { ok: false, message: 'Nothing is selected.' };
		if (![ax, ay].every((v) => Number.isFinite(v) && Math.abs(v) < 89.9)) return { ok: false, message: 'Skew angles must be between −89.9° and 89.9°.' };
		const origin = applyMatrix(rotateMatrix(-frame.angle), options.origin ?? this.frameCenter(frame));
		return this.transform(this.inFrame(frame.angle, vectorSkewMatrix(ax, ay, origin)), { ids: options.ids, label: 'Skew' });
	}

	/** A selection box handle dragged in Free Distort mode. */
	private moveDistort(drag: Extract<Drag, { kind: 'scale' }>, p: Vec2, input: VectorPointerInput) {
		const angle = drag.frame.angle;
		const unrotate = (v: Vec2) => (angle ? applyMatrix(rotateMatrix(-angle), v) : v);
		const q = unrotate(p);
		const q0 = unrotate(drag.start);
		const d = { x: q.x - q0.x, y: q.y - q0.y };
		const ids = new Set(this.selectedRoots());
		const from = this.frameCorners(drag.frame);
		const corner = drag.handle.length === 2;
		this.setGuides(null);
		if (!corner && input.mod) {
			const m = this.inFrame(angle, vectorShearForSide(drag.frame, drag.handle, d, !!input.alt));
			drag.op = 'Skew';
			this.doc = this.transformed(drag.base, ids, m);
			this.interaction = { type: 'distort', mode: 'skew', corners: from.map((c) => applyMatrix(m, c)) };
			this.notify(true);
			return;
		}
		const mode: VectorDistortMode = corner && input.mod && input.alt && input.shift ? 'perspective' : 'distort';
		const rot = rotateMatrix(angle);
		const quad = vectorDistortQuad(drag.frame, drag.handle, d, mode).map((c) => (angle ? applyMatrix(rot, c) : c));
		const h = vectorHomography(from, quad);
		// A quad that folds over keeps the last good shape.
		if (!h || !vectorHomographyKeepsQuad(h, from)) return;
		drag.op = mode === 'perspective' ? 'Perspective' : 'Distort';
		this.doc = this.distorted(drag.base, ids, (pt) => applyVectorHomography(h, pt) ?? pt);
		this.interaction = { type: 'distort', mode, corners: quad };
		this.notify(true);
	}

	// -------------------------------------------------------------------------
	// Envelopes
	// -------------------------------------------------------------------------

	/** Selected (or given) roots that can carry an envelope. */
	private envelopeTargets(ids?: readonly string[]): VectorNode[] {
		return this.effectTargets(ids).filter((n) => !n.locked);
	}

	/** Envelope parameters for `node` after `patch`: a preset switched to a mesh becomes the mesh it stood for. */
	private envelopeParams(node: VectorNode, current: Extract<VectorEffect, { type: 'envelope' }> | null, patch: Record<string, unknown>): Record<string, unknown> {
		if (patch.style !== 'mesh' || patch.mesh !== undefined || !current || current.params.style === 'mesh') return patch;
		const frame = vectorEnvelopeFrame(node, current.id);
		if (!frame) return patch;
		const rows = typeof patch.rows === 'number' ? patch.rows : current.params.rows;
		const columns = typeof patch.columns === 'number' ? patch.columns : current.params.columns;
		return { ...patch, mesh: resizeVectorMesh(frame.mesh, columns, rows) };
	}

	/**
	 * Gives the selected (or given) nodes an envelope distortion, or changes the one they have: a
	 * warp preset (`style` with `bend`, `horizontal` and `vertical` in percent and `orientation`) or
	 * a mesh (`style: 'mesh'` with `rows` and `columns`, and optionally its `mesh` points). The
	 * envelope stays live (an `envelope` effect: edit it with the Envelope tool, Expand Appearance
	 * bakes it). One undo step (with `merge`, consecutive changes fold into one, as a slider drag
	 * should). Returns the envelope of each node.
	 */
	envelope(params: Partial<VectorEnvelopeParams> = {}, options: { ids?: readonly string[]; merge?: boolean } = {}): { nodeId: string; effectId: string }[] {
		const targets = this.envelopeTargets(options.ids);
		if (!targets.length) return [];
		const out: { nodeId: string; effectId: string }[] = [];
		const next = new Map<string, VectorNode>();
		const raw = params as Record<string, unknown>;
		for (const node of targets) {
			const list = node.effects ?? [];
			const current = (list.find((e) => e.type === 'envelope') as Extract<VectorEffect, { type: 'envelope' }> | undefined) ?? null;
			if (current) {
				const p = normalizeVectorEffectParams('envelope', this.envelopeParams(node, current, raw), current.params)!;
				const { enabled: _e, ...rest } = current;
				next.set(node.id, { ...node, effects: list.map((e) => (e === current ? { ...rest, params: p } : e)) } as VectorNode);
				out.push({ nodeId: node.id, effectId: current.id });
			} else {
				let k = list.length + 1;
				while (list.some((e) => e.id === `fx${k}`)) k++;
				const effect = createVectorEffect('envelope', `fx${k}`, raw)!;
				next.set(node.id, { ...node, effects: [...list, effect] } as VectorNode);
				out.push({ nodeId: node.id, effectId: effect.id });
			}
		}
		const made = out.some((o) => !targets.find((n) => n.id === o.nodeId)?.effects?.some((e) => e.id === o.effectId));
		const merge = options.merge ? `envelope:${out.map((o) => o.nodeId).join(',')}` : undefined;
		this.change(made ? (params.style === 'mesh' ? 'Make Envelope with Mesh' : 'Make Envelope with Warp') : 'Edit Envelope', () => this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n)), merge);
		return out;
	}

	/**
	 * Make with Top Object: the topmost selected object's outline (a closed path) becomes the envelope
	 * of the other selected objects (grouped when there are several; they must share a parent), as a
	 * mesh of `columns × rows` patches whose border follows the outline. The top object is used up.
	 * One undo step; returns the id of the enveloped node.
	 */
	makeEnvelopeWithTopObject(options: { ids?: readonly string[]; rows?: number; columns?: number } = {}): VectorActionResult & { nodeId?: string } {
		const ids = options.ids ?? this.selectedRoots();
		if (ids.length < 2) return { ok: false, message: 'Select the objects and, on top of them, the shape to use as the envelope.' };
		const order = new Map<string, number>();
		walkVectorNodes(this.doc.nodes, (n) => order.set(n.id, order.size));
		const sorted = ids.filter((id) => order.has(id)).sort((a, b) => order.get(a)! - order.get(b)!);
		const topId = sorted[sorted.length - 1];
		const top = this.getNode(topId);
		const outline = top?.type === 'path' ? top.subpaths.find((sp) => sp.closed && sp.anchors.length > 1) : undefined;
		if (!top || !outline) return { ok: false, message: 'The top object must be a path with a closed outline.' };
		const contents = sorted.slice(0, -1).map((id) => this.getNode(id)!);
		if (contents.some((n) => n.locked)) return { ok: false, message: 'Locked objects cannot be enveloped.' };
		const parents = contents.map((n) => locateVectorNode(this.doc.nodes, n.id)?.parent?.id ?? null);
		if (parents.some((p) => p !== parents[0])) return { ok: false, message: 'The objects to envelope must be in the same group.' };
		// The node that gets the envelope: the one object, or a new group of them in place of the topmost.
		const target: VectorNode =
			contents.length === 1 ? contents[0] : { id: this.newId(), type: 'group', name: 'Envelope', children: contents.map((n) => n) };
		const parentToDoc = parents[0] ? this.worldOf(parents[0]) : IDENTITY_MATRIX;
		const targetToDoc = multiplyMatrices(nodeMatrix(target), parentToDoc);
		const toLocal = multiplyMatrices(this.worldOf(topId), invertMatrix(targetToDoc));
		const local = {
			closed: true,
			anchors: outline.anchors.map((a) => ({
				...applyMatrix(toLocal, a),
				...(a.in ? { in: applyMatrix(toLocal, a.in) } : {}),
				...(a.out ? { out: applyMatrix(toLocal, a.out) } : {})
			}))
		};
		const mesh = vectorMeshFromOutline(local, options.columns ?? 4, options.rows ?? 4);
		if (!mesh) return { ok: false, message: 'The top object’s outline is too small to use as an envelope.' };
		const list = target.effects ?? [];
		let k = list.length + 1;
		while (list.some((e) => e.id === `fx${k}`)) k++;
		const effect = createVectorEffect('envelope', `fx${k}`, { style: 'mesh', mesh })!;
		const enveloped = { ...target, effects: [...list, effect] } as VectorNode;
		this.change('Make Envelope with Top Object', () => {
			let nodes = spliceTree(this.doc.nodes, topId, []);
			if (contents.length === 1) nodes = spliceTree(nodes, target.id, [enveloped]);
			else {
				const last = contents[contents.length - 1].id;
				for (const n of contents.slice(0, -1)) nodes = spliceTree(nodes, n.id, []);
				nodes = spliceTree(nodes, last, [enveloped]);
			}
			this.setDoc(nodes);
			this.selection = [target.id];
			this.anchors = [];
			this.editingId = null;
		});
		return { ok: true, nodeId: target.id };
	}

	/**
	 * Release: the selected (or given) nodes lose their envelope, and its shape (the mesh's border)
	 * comes back as a path above each of them. One undo step; returns the new paths' ids.
	 */
	releaseEnvelope(options: { ids?: readonly string[] } = {}): string[] {
		const targets = this.envelopeTargets(options.ids).filter((n) => n.effects?.some((e) => e.type === 'envelope'));
		if (!targets.length) return [];
		const created: string[] = [];
		const replace = new Map<string, VectorNode[]>();
		for (const node of targets) {
			const effect = node.effects!.find((e) => e.type === 'envelope')!;
			const frame = vectorEnvelopeFrame(node, effect.id);
			const rest = node.effects!.filter((e) => e !== effect);
			const { effects: _e, ...plain } = node;
			const kept = (rest.length ? { ...plain, effects: rest } : plain) as VectorNode;
			if (!frame) {
				replace.set(node.id, [kept]);
				continue;
			}
			const id = this.newId();
			created.push(id);
			const shape: VectorPathNode = {
				id,
				type: 'path',
				name: 'Envelope',
				...(node.transform ? { transform: node.transform } : {}),
				subpaths: [vectorMeshOutline(frame.mesh)],
				fill: null,
				stroke: '#808080',
				strokeWidth: 1
			};
			replace.set(node.id, [kept, shape]);
		}
		this.change('Release Envelope', () => {
			let nodes = this.doc.nodes;
			for (const [id, list] of replace) nodes = spliceTree(nodes, id, list);
			this.setDoc(nodes);
			this.selection = [...targets.map((n) => n.id), ...created];
			this.anchors = [];
		});
		return created;
	}

	/** The selected node the Envelope tool edits, with its mesh (node space) and node → document matrix. */
	private envelopeTarget() {
		const target = getVectorEnvelopeTarget(this.doc, this.selection);
		return target && !target.node.locked ? target : null;
	}

	/** The envelope mesh point under `screen` (handles first), or a spot inside the mesh. */
	private hitEnvelope(screen: Vec2, p: Vec2): { target: NonNullable<ReturnType<VectorEditorController['envelopeTarget']>>; index: number | null; s: number; t: number } | null {
		const target = this.envelopeTarget();
		if (!target) return null;
		const { mesh } = target.frame;
		const pts = vectorMeshEditPoints(mesh);
		let best: number | null = null;
		let bestD = Infinity;
		for (const index of [...pts.handles.map((h) => h.index), ...pts.anchors]) {
			const s = this.documentToScreen(applyMatrix(target.world, mesh.points[index]));
			const d = Math.hypot(s.x - screen.x, s.y - screen.y);
			// Handles come first, so an anchor wins only when it is clearly nearer.
			if (d <= this.hitRadius && d < bestD - 0.5) {
				best = index;
				bestD = d;
			}
		}
		if (best !== null) return { target, index: best, s: 0, t: 0 };
		const local = applyMatrix(invertMatrix(target.world), p);
		const at = vectorMeshParamAt(mesh, local);
		if (at.distance > this.tolerance()) return null;
		return { target, index: null, s: at.s, t: at.t };
	}

	private downEnvelope(screen: Vec2, p: Vec2, input: VectorPointerInput) {
		const hit = this.hitEnvelope(screen, p);
		if (hit) {
			const { node, frame } = hit.target;
			this.drag = {
				kind: 'envelope',
				nodeId: node.id,
				effectId: frame.effectId,
				base: frame.mesh,
				baseDoc: this.doc,
				before: this.snapshot(),
				index: hit.index,
				s: hit.s,
				t: hit.t,
				start: this.toLocal(node.id, p),
				moved: false
			};
			this.interaction = { type: 'envelope', nodeId: node.id, index: hit.index };
			this.notify();
			return;
		}
		// Elsewhere: pick the object to edit.
		const node = hitTestVectorNodes(this.doc.nodes, p, this.tolerance(), { entered: this.enteredGroups() });
		if (node) this.selection = input.shift ? (this.selection.includes(node.id) ? this.selection.filter((id) => id !== node.id) : [...this.selection, node.id]) : [node.id];
		else if (!input.shift) this.selection = [];
		this.anchors = [];
		this.notify();
	}

	private moveEnvelope(drag: Extract<Drag, { kind: 'envelope' }>, p: Vec2) {
		const local = this.toLocal(drag.nodeId, p, drag.baseDoc);
		const d = { x: local.x - drag.start.x, y: local.y - drag.start.y };
		if (!drag.moved && Math.hypot(d.x, d.y) * this.viewport.zoom < 1) return;
		drag.moved = true;
		const mesh = drag.index !== null ? dragVectorMeshPoint(drag.base, drag.index, d) : pullVectorMesh(drag.base, drag.s, drag.t, d);
		const nodes = mapTree(drag.baseDoc.nodes, (n) => {
			if (n.id !== drag.nodeId) return n;
			const effects = (n.effects ?? []).map((e) =>
				e.id === drag.effectId && e.type === 'envelope'
					? { ...e, params: { ...e.params, style: 'mesh' as const, mesh, columns: mesh.us.length - 1, rows: mesh.vs.length - 1 } }
					: e
			);
			return { ...n, effects } as VectorNode;
		});
		this.doc = { ...drag.baseDoc, nodes };
		this.notify(true);
	}

	/** Applies a matrix to the selected (or given) nodes as one undo step. */
	transform(matrix: AffineMatrix, options: { ids?: readonly string[]; label?: string } = {}): VectorActionResult {
		const ids = new Set(options.ids ?? this.selectedRoots());
		if (!ids.size) return { ok: false, message: 'Nothing is selected.' };
		this.change(options.label ?? 'Transform', () => {
			this.doc = this.transformed(this.doc, ids, matrix);
		});
		return { ok: true };
	}

	/** `doc` with nodes `ids` moved by `m`, given in document space. */
	private transformed(doc: VectorDocument, ids: ReadonlySet<string>, m: AffineMatrix): VectorDocument {
		const visit = (list: readonly VectorNode[], parent: AffineMatrix): VectorNode[] => {
			let changed = false;
			const out = list.map((n) => {
				let next = n;
				if (ids.has(n.id) && !n.locked) {
					// `m` in the node's parent space: parent → document, m, document → parent.
					const local = isRoot(parent) ? m : multiplyMatrices(multiplyMatrices(parent, m), invertMatrix(parent));
					next = transformVectorNode(n, local);
				} else if (n.type === 'group') {
					const children = visit(n.children, multiplyMatrices(nodeMatrix(n), parent));
					if (children !== n.children) next = { ...n, children };
				}
				if (next !== n) changed = true;
				return next;
			});
			return changed ? out : (list as VectorNode[]);
		};
		const nodes = visit(doc.nodes, IDENTITY_MATRIX);
		return nodes === doc.nodes ? doc : { ...doc, nodes };
	}

	translate(dx: number, dy: number, options: { ids?: readonly string[] } = {}): VectorActionResult {
		if (this.tool === 'direct' && this.anchors.length && !options.ids) {
			this.change('Move Points', () => {
				this.doc = this.movedAnchors(this.doc, this.anchors, dx, dy);
			});
			return { ok: true };
		}
		return this.transform(translateMatrix(dx, dy), { ids: options.ids, label: 'Move' });
	}

	/** The selection frame's centre in document space. */
	private frameCenter(frame: VectorSelectionFrame): Vec2 {
		return applyMatrix(rotateMatrix(frame.angle), { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
	}

	/**
	 * Scales along the selection box's own axes (rotated with the selection when its nodes
	 * share a rotation) around `origin` (default: the box centre, in document space).
	 */
	scale(sx: number, sy: number = sx, options: { ids?: readonly string[]; origin?: Vec2 } = {}): VectorActionResult {
		const frame = this.frameOf(options.ids ?? this.selectedRoots());
		if (!frame) return { ok: false, message: 'Nothing is selected.' };
		const origin = applyMatrix(rotateMatrix(-frame.angle), options.origin ?? this.frameCenter(frame));
		return this.transform(this.inFrame(frame.angle, scaleMatrix(sx, sy, origin)), { ids: options.ids, label: 'Scale' });
	}

	/** Rotates clockwise by `degrees` around `origin` (default: the selection centre). */
	rotate(degrees: number, options: { ids?: readonly string[]; origin?: Vec2 } = {}): VectorActionResult {
		const frame = this.frameOf(options.ids ?? this.selectedRoots());
		if (!frame) return { ok: false, message: 'Nothing is selected.' };
		const origin = options.origin ?? this.frameCenter(frame);
		return this.transform(rotateMatrix(degrees, origin), { ids: options.ids, label: 'Rotate' });
	}

	/** Sets each selected (or given) node's rotation to `degrees`, turning it around its own centre. */
	setRotation(degrees: number, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const ids = options.ids ?? this.selectedRoots();
		if (!ids.length) return { ok: false, message: 'Nothing is selected.' };
		this.change('Set Rotation', () => {
			for (const id of ids) {
				const frame = this.frameOf([id]);
				if (!frame) continue;
				const delta = normalizeAngle(degrees - frame.angle);
				if (Math.abs(delta) > 1e-9) this.doc = this.transformed(this.doc, new Set([id]), rotateMatrix(delta, this.frameCenter(frame)));
			}
		});
		return { ok: true };
	}

	/** Mirrors along the selection box's own axes. */
	flip(axis: 'horizontal' | 'vertical', options: { ids?: readonly string[] } = {}): VectorActionResult {
		const frame = this.frameOf(options.ids ?? this.selectedRoots());
		if (!frame) return { ok: false, message: 'Nothing is selected.' };
		const c = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
		const m = axis === 'horizontal' ? scaleMatrix(-1, 1, c) : scaleMatrix(1, -1, c);
		return this.transform(this.inFrame(frame.angle, m), { ids: options.ids, label: axis === 'horizontal' ? 'Flip Horizontal' : 'Flip Vertical' });
	}

	/**
	 * Aligns the selected nodes to their combined bounds, or to the artboard when one node is
	 * selected (or `to: 'artboard'`).
	 */
	align(edge: VectorAlign, options: { ids?: readonly string[]; to?: 'selection' | 'artboard' } = {}): VectorActionResult {
		const ids = options.ids ?? this.selectedRoots();
		if (!ids.length) return { ok: false, message: 'Nothing is selected.' };
		const target = options.to === 'artboard' || ids.length === 1 ? { x: 0, y: 0, width: this.doc.width, height: this.doc.height } : this.boundsOf(ids)!;
		this.change(`Align ${edge[0].toUpperCase()}${edge.slice(1)}`, () => {
			for (const id of ids) {
				const b = this.boundsOf([id]);
				if (!b) continue;
				let dx = 0;
				let dy = 0;
				if (edge === 'left') dx = target.x - b.x;
				if (edge === 'center') dx = target.x + target.width / 2 - (b.x + b.width / 2);
				if (edge === 'right') dx = target.x + target.width - (b.x + b.width);
				if (edge === 'top') dy = target.y - b.y;
				if (edge === 'middle') dy = target.y + target.height / 2 - (b.y + b.height / 2);
				if (edge === 'bottom') dy = target.y + target.height - (b.y + b.height);
				if (dx || dy) this.doc = this.transformed(this.doc, new Set([id]), translateMatrix(dx, dy));
			}
		});
		return { ok: true };
	}

	/** Spaces three or more selected nodes evenly (equal gaps). */
	distribute(direction: VectorDistribute, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const ids = options.ids ?? this.selectedRoots();
		const items = ids.map((id) => ({ id, b: this.boundsOf([id]) })).filter((i): i is { id: string; b: VectorBounds } => !!i.b);
		if (items.length < 3) return { ok: false, message: 'Select at least three objects to distribute.' };
		const horizontal = direction === 'horizontal';
		const pos = (b: VectorBounds) => (horizontal ? b.x : b.y);
		const size = (b: VectorBounds) => (horizontal ? b.width : b.height);
		items.sort((a, b) => pos(a.b) - pos(b.b));
		const first = items[0].b;
		const last = items[items.length - 1].b;
		const total = pos(last) + size(last) - pos(first);
		const gap = (total - items.reduce((s, i) => s + size(i.b), 0)) / (items.length - 1);
		this.change(horizontal ? 'Distribute Horizontally' : 'Distribute Vertically', () => {
			let cursor = pos(first);
			for (const item of items) {
				const d = cursor - pos(item.b);
				if (Math.abs(d) > 1e-9) this.doc = this.transformed(this.doc, new Set([item.id]), horizontal ? translateMatrix(d, 0) : translateMatrix(0, d));
				cursor += size(item.b) + gap;
			}
		});
		return { ok: true };
	}

	// -------------------------------------------------------------------------
	// Structure
	// -------------------------------------------------------------------------

	/** Copies the selection (offset by `offset`, default 10, 10) on top of each original. */
	duplicate(options: { ids?: readonly string[]; offset?: Vec2 } = {}): string[] {
		const ids = options.ids ?? this.selectedRoots();
		const offset = options.offset ?? { x: 10, y: 10 };
		const created: string[] = [];
		if (!ids.length) return created;
		this.change('Duplicate', () => {
			this.doc = this.withDuplicates(this.doc, ids, offset, created);
			this.selection = created;
			this.anchors = [];
		});
		return created;
	}

	private withDuplicates(doc: VectorDocument, ids: readonly string[], offset: Vec2, created: string[]): VectorDocument {
		const set = new Set(ids);
		const m = translateMatrix(offset.x, offset.y);
		const insert = (list: readonly VectorNode[]): VectorNode[] => {
			const out: VectorNode[] = [];
			for (const node of list) {
				const n = node.type === 'group' ? { ...node, children: insert(node.children) } : node;
				out.push(n);
				if (set.has(node.id)) {
					const copy = transformVectorNode(this.freshIds(node), m);
					created.push(copy.id);
					out.push(copy);
				}
			}
			return out;
		};
		return { ...doc, nodes: insert(doc.nodes) };
	}

	/** Groups the selected nodes (they must share a parent). Returns the group id. */
	group(options: { ids?: readonly string[]; name?: string } = {}): string | null {
		const ids = options.ids ?? this.selectedRoots();
		if (!ids.length) return null;
		const locs = ids.map((id) => locateVectorNode(this.doc.nodes, id));
		if (locs.some((l) => !l)) return null;
		const parent = locs[0]!.parent?.id ?? null;
		if (locs.some((l) => (l!.parent?.id ?? null) !== parent)) return null;
		const id = this.newId();
		this.change('Group', () => {
			const set = new Set(ids);
			const regroup = (list: readonly VectorNode[]): VectorNode[] => {
				const members = list.filter((n) => set.has(n.id));
				const top = Math.max(...members.map((m) => list.indexOf(m)));
				const out: VectorNode[] = [];
				list.forEach((n, i) => {
					if (i === top) out.push({ id, type: 'group', name: options.name ?? 'Group', children: members });
					if (!set.has(n.id)) out.push(n);
				});
				return out;
			};
			if (parent === null) this.setDoc(regroup(this.doc.nodes));
			else this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === parent && n.type === 'group' ? { ...n, children: regroup(n.children) } : n)));
			this.selection = [id];
			this.anchors = [];
		});
		return id;
	}

	/** Replaces selected groups with their children. */
	ungroup(options: { ids?: readonly string[] } = {}): VectorActionResult {
		const groups = (options.ids ?? this.selection).map((id) => this.getNode(id)).filter((n): n is VectorGroupNode => n?.type === 'group');
		if (!groups.length) return { ok: false, message: 'Select a group to ungroup.' };
		const set = new Set(groups.map((g) => g.id));
		this.change('Ungroup', () => {
			const flatten = (list: readonly VectorNode[]): VectorNode[] => {
				const out: VectorNode[] = [];
				let changed = false;
				for (const n of list) {
					if (set.has(n.id) && n.type === 'group') {
						changed = true;
						const opacity = n.opacity;
						const m = nodeMatrix(n);
						out.push(
							...n.children
								.map((c) => (c.blendStep ? (({ blendStep: _s, locked: _l, ...rest }) => rest as VectorNode)(c) : c))
								.map((c) => (c.booleanOperation ? (({ booleanOperation: _b, ...rest }) => rest as VectorNode)(c) : c))
								.map((c) => (n.transform ? transformVectorNode(c, m) : c))
								.map((c) => (opacity !== undefined && opacity < 1 ? { ...c, opacity: (c.opacity ?? 1) * opacity } : c))
						);
					} else if (n.type === 'group') {
						const children = flatten(n.children);
						if (children !== n.children) changed = true;
						out.push(children !== n.children ? { ...n, children } : n);
					} else out.push(n);
				}
				return changed ? out : (list as VectorNode[]);
			};
			this.setDoc(flatten(this.doc.nodes));
			this.selection = groups.flatMap((g) => g.children.map((c) => c.id));
		});
		return { ok: true };
	}

	/** Changes stacking order within each node's parent. */
	arrange(op: VectorArrange, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const set = new Set(options.ids ?? this.selectedRoots());
		if (!set.size) return { ok: false, message: 'Nothing is selected.' };
		const reorder = (list: readonly VectorNode[]): VectorNode[] => {
			const out = list.map((n) => (n.type === 'group' ? { ...n, children: reorder(n.children) } : n));
			if (op === 'front') return [...out.filter((n) => !set.has(n.id)), ...out.filter((n) => set.has(n.id))];
			if (op === 'back') return [...out.filter((n) => set.has(n.id)), ...out.filter((n) => !set.has(n.id))];
			if (op === 'forward') {
				for (let i = out.length - 2; i >= 0; i--) if (set.has(out[i].id) && !set.has(out[i + 1].id)) [out[i], out[i + 1]] = [out[i + 1], out[i]];
			} else {
				for (let i = 1; i < out.length; i++) if (set.has(out[i].id) && !set.has(out[i - 1].id)) [out[i], out[i - 1]] = [out[i - 1], out[i]];
			}
			return out;
		};
		const labels = { front: 'Bring to Front', forward: 'Bring Forward', backward: 'Send Backward', back: 'Send to Back' };
		this.change(labels[op], () => this.setDoc(reorder(this.doc.nodes)));
		return { ok: true };
	}

	/**
	 * Combines the selected paths (two or more) into one with a boolean operation. `subtract`
	 * removes the upper shapes from the lowest one. The result takes the lowest shape's style
	 * and place. Shapes take part as drawn (path effects and live booleans applied).
	 *
	 * With `live`, the operands stay editable instead: a lone live boolean group gets the
	 * operation (its operands follow it again), operands of live boolean groups get it as their
	 * own, and anything else (two or more nodes with one parent) is wrapped in a new live boolean
	 * group. Returns the result's (or the live group's) id, or null.
	 */
	booleanOp(op: VectorBooleanOperation, options: { ids?: readonly string[]; live?: boolean } = {}): string | null {
		const roots = options.ids ?? this.selectedRoots();
		if (options.live) return this.liveBooleanOp(op, roots);
		const entries = vectorPathEntries(this.doc, roots, { locked: true });
		if (entries.length < 2) return null;
		const result = pathBoolean(
			BOOLEAN_OPS[op],
			entries.map((e) => ({
				path: vectorPathWorldBezier({ ...e.node, subpaths: e.node.subpaths.filter((s) => s.anchors.length > 1).map((s) => ({ ...s, closed: true })) }, e.parent),
				fillRule: e.node.fillRule ?? 'nonzero'
			}))
		);
		const base = entries[0].node;
		const anchorRoot = roots.find((r) => this.holds(r, base.id)) ?? base.id;
		const subpaths = bezierToSubpaths(this.intoParentSpace(anchorRoot, result.path));
		if (result.error || !subpaths.length) return null;
		const id = this.newId();
		const { transform: _t, effects: _e, booleanOperation: _b, ...baseRest } = cloneVectorNode(base);
		const node: VectorPathNode = { ...baseRest, id, name: BOOLEAN_LABELS[op], subpaths };
		const drop = new Set([...entries.map((e) => e.node.id), ...roots]);
		this.change(BOOLEAN_LABELS[op], () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === anchorRoot ? node : drop.has(n.id) ? null : n)));
			this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return id;
	}

	/** Whether stored node `rootId` holds `id` as drawn (`id` may be an expanded path inside it). */
	private holds(rootId: string, id: string): boolean {
		const n = this.getNode(rootId);
		return !!n && (!!findVectorNode([n], id) || !!findVectorNode([expandVectorAppearance(n)], id) || !!findVectorNode([vectorMaskedGeometry(n)], id));
	}

	private liveBooleanOp(op: VectorBooleanOperation, roots: readonly string[]): string | null {
		const nodes = roots.map((id) => this.getNode(id));
		if (!nodes.length || nodes.some((n) => !n)) return null;
		const label = `Live ${BOOLEAN_LABELS[op]}`;
		const lone = nodes.length === 1 ? nodes[0] : null;
		if (isVectorLiveBoolean(lone)) {
			const children = lone.children.map((c) => (c.booleanOperation ? (({ booleanOperation: _b, ...rest }) => rest as VectorNode)(c) : c));
			this.change(label, () => this.replaceNode(lone.id, { ...lone, liveBoolean: op, children }));
			return lone.id;
		}
		const parents = roots.map((id) => locateVectorNode(this.doc.nodes, id)?.parent ?? null);
		if (parents.every((g) => isVectorLiveBoolean(g))) {
			const set = new Set(roots);
			this.change(label, () =>
				this.setDoc(
					mapTree(this.doc.nodes, (n) => {
						if (n.type !== 'group' || !n.liveBoolean || !n.children.some((c) => set.has(c.id))) return n;
						const group = n;
						const children = group.children.map((c) => {
							if (!set.has(c.id)) return c;
							const { booleanOperation: _b, ...rest } = c;
							return (op === group.liveBoolean ? rest : { ...rest, booleanOperation: op }) as VectorNode;
						});
						return { ...group, children };
					})
				)
			);
			return parents[0]!.id;
		}
		if (nodes.length < 2) return null;
		const parent = parents[0]?.id ?? null;
		if (parents.some((g) => (g?.id ?? null) !== parent)) return null;
		const id = this.newId();
		this.change(label, () => {
			const set = new Set(roots);
			const wrap = (list: readonly VectorNode[]): VectorNode[] => {
				const members = list.filter((n) => set.has(n.id)).map((c) => (c.booleanOperation ? (({ booleanOperation: _b, ...rest }) => rest as VectorNode)(c) : c));
				const top = Math.max(...list.map((n, i) => (set.has(n.id) ? i : -1)));
				const out: VectorNode[] = [];
				list.forEach((n, i) => {
					if (i === top) out.push({ id, type: 'group', name: BOOLEAN_LABELS[op], liveBoolean: op, children: members });
					if (!set.has(n.id)) out.push(n);
				});
				return out;
			};
			if (parent === null) this.setDoc(wrap(this.doc.nodes));
			else this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === parent && n.type === 'group' ? { ...n, children: wrap(n.children) } : n)));
			this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return id;
	}

	/** Joins the selected paths into one compound path (subpaths kept, lowest style). */
	combine(options: { ids?: readonly string[] } = {}): string | null {
		const roots = options.ids ?? this.selectedRoots();
		const entries = vectorPathEntries(this.doc, roots, { locked: true });
		if (entries.length < 2) return null;
		const paths = entries.map((e) => e.node);
		const id = this.newId();
		const first = roots.find((r) => this.holds(r, paths[0].id)) ?? paths[0].id;
		const subpaths = entries.flatMap((e) => bezierToSubpaths(this.intoParentSpace(first, vectorPathWorldBezier(e.node, e.parent))));
		const { transform: _t, effects: _e, booleanOperation: _b, ...baseRest } = cloneVectorNode(paths[0]);
		const node: VectorPathNode = { ...baseRest, id, name: 'Compound Path', subpaths };
		const drop = new Set([...paths.map((p) => p.id), ...roots]);
		this.change('Combine', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === first ? node : drop.has(n.id) ? null : n)));
			this.selection = [id];
			this.anchors = [];
		});
		return id;
	}

	/** A document-space path mapped into the parent space of node `id`. */
	private intoParentSpace(id: string, path: BezierPath): BezierPath {
		const parent = vectorParentMatrix(this.doc.nodes, id) ?? IDENTITY_MATRIX;
		return isRoot(parent) ? path : transformBezierPath(path, invertMatrix(parent));
	}

	/** Splits selected compound paths into one path per subpath. */
	breakApart(options: { ids?: readonly string[] } = {}): VectorActionResult {
		const paths = (options.ids ?? this.selection).map((id) => this.getNode(id)).filter((n): n is VectorPathNode => n?.type === 'path' && n.subpaths.length > 1);
		if (!paths.length) return { ok: false, message: 'Select a compound path to break apart.' };
		const created: string[] = [];
		const set = new Set(paths.map((p) => p.id));
		this.change('Break Apart', () => {
			const split = (list: readonly VectorNode[]): VectorNode[] =>
				list.flatMap((n): VectorNode[] => {
					if (n.type === 'group') return [{ ...n, children: split(n.children) }];
					if (n.type !== 'path' || !set.has(n.id)) return [n];
					return n.subpaths.map((sp, i) => {
						const id = i === 0 ? n.id : this.newId();
						created.push(id);
						return { ...n, id, subpaths: [sp] };
					});
				});
			this.setDoc(split(this.doc.nodes));
			this.selection = created;
		});
		return { ok: true };
	}

	// -------------------------------------------------------------------------
	// Pathfinder, Shape Builder and paint bucket
	// -------------------------------------------------------------------------

	/**
	 * Pathfinder: Divide, Trim, Merge, Crop, Outline or Minus Back over the selected (or given)
	 * paths, in document space (rotated nodes and groups included, live corners cut). Unfilled
	 * stroked paths take part as the area their stroke paints (Divide: open ones cut instead).
	 * The results replace the operands at the place of the top-most one, grouped when there are
	 * several; each keeps the style of the operand whose area it is. Returns the new path ids,
	 * or an empty list when nothing came out.
	 */
	pathfinder(op: VectorPathfinderOperation, options: { ids?: readonly string[] } = {}): string[] {
		const roots = options.ids ?? this.selectedRoots();
		const entries = vectorPathEntries(this.doc, roots);
		if (entries.length < (op === 'divide' || op === 'outline' ? 1 : 2)) return [];
		const shapes = entries.map((e) => vectorPathfinderShape(e, op));
		const result = runPathfinder(op, shapes);
		if (result.error || !result.pieces.length) return [];
		const last = entries[entries.length - 1].node.id;
		const topRoot = [...roots].reverse().find((r) => this.holds(r, last)) ?? last;
		const nodes: VectorPathNode[] = [];
		for (const piece of result.pieces) {
			const subpaths = bezierToSubpaths(this.intoParentSpace(topRoot, piece.path)).map((sp) => (piece.open ? { ...sp, closed: false } : sp));
			if (!subpaths.length) continue;
			const source = entries[piece.source].node;
			const style = vectorResultStyle(source, shapes[piece.source].paint, op === 'outline');
			nodes.push({ ...style, type: 'path', id: this.newId(), name: source.name ?? 'Path', subpaths });
		}
		if (!nodes.length) return [];
		const label = VECTOR_PATHFINDER_LABELS[op];
		const container: VectorNode = nodes.length > 1 ? { id: this.newId(), type: 'group', name: label, children: nodes } : nodes[0];
		const drop = new Set([...entries.map((e) => e.node.id), ...roots]);
		this.change(label, () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === topRoot ? container : drop.has(n.id) ? null : n)));
			this.selection = [container.id];
			this.anchors = [];
			this.editingId = null;
		});
		return nodes.map((n) => n.id);
	}

	/** The Shape Builder map of the selected (or given) paths, cached per document and selection. */
	// -------------------------------------------------------------------------
	// Blends
	// -------------------------------------------------------------------------

	/** Selected (or given) blend groups; a selected key or step counts as its blend. */
	private blendTargets(ids?: readonly string[]): (VectorGroupNode & { blend: VectorBlend })[] {
		const out = new Map<string, VectorGroupNode & { blend: VectorBlend }>();
		for (const id of ids ?? this.selection) {
			const node = this.getNode(id);
			const group = isVectorBlendGroup(node) ? node : locateVectorNode(this.doc.nodes, id)?.parent;
			if (isVectorBlendGroup(group)) out.set(group.id, group);
		}
		return [...out.values()];
	}

	/**
	 * Blends two or more selected (or given) paths or groups: they become the keys of a live
	 * blend group (bottom to top, or in the order given with `keepOrder`) whose in-betweens are
	 * regenerated whenever a key or the options change. The keys must share a parent. Returns
	 * the blend group's id, or null.
	 */
	blend(input: VectorBlendInput = {}): string | null {
		const ids = [...new Set(input.ids ?? this.selectedRoots())].filter((id) => {
			const n = this.getNode(id);
			return !!n && !n.blendStep && !n.locked;
		});
		if (ids.length < 2) return null;
		const locs = ids.map((id) => locateVectorNode(this.doc.nodes, id)!);
		const parent = locs[0].parent?.id ?? null;
		if (locs.some((l) => (l.parent?.id ?? null) !== parent)) return null;
		const order = input.keepOrder ? ids : ids.slice().sort((a, b) => locs[ids.indexOf(a)].index - locs[ids.indexOf(b)].index);
		const blend: VectorBlend = blendOptionsOf({ ...this.blendDefaults, ...input });
		if (input.starts) {
			const starts = Object.fromEntries(Object.entries(input.starts).filter(([k, v]) => order.includes(k) && Number.isInteger(v) && v >= 0));
			if (Object.keys(starts).length) blend.starts = starts;
		}
		const id = this.newId();
		this.change('Blend', () => {
			const set = new Set(order);
			const regroup = (list: readonly VectorNode[]): VectorNode[] => {
				const members = order.map((m) => list.find((n) => n.id === m)!);
				const top = Math.max(...members.map((m) => list.indexOf(m)));
				const out: VectorNode[] = [];
				list.forEach((n, i) => {
					if (i === top) out.push({ id, type: 'group', name: input.name ?? 'Blend', blend, children: members });
					if (!set.has(n.id)) out.push(n);
				});
				return out;
			};
			if (parent === null) this.setDoc(regroup(this.doc.nodes));
			else this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === parent && n.type === 'group' ? { ...n, children: regroup(n.children) } : n)));
			this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return id;
	}

	// -------------------------------------------------------------------------
	// Masks
	// -------------------------------------------------------------------------

	/**
	 * Make Clipping Mask (`clip`) / Make Opacity Mask (`alpha`, `luminance`): groups the selected (or
	 * given) objects into a mask group whose mask is the topmost of them (or `maskId`), moved to the
	 * bottom of the group. They must be two or more, unlocked, with one parent. One undo step.
	 * Returns the group's id, or why it could not.
	 */
	makeMask(type: VectorMaskType, options: { ids?: readonly string[]; maskId?: string; invert?: boolean; name?: string } = {}): VectorMaskResult {
		if (!isVectorMaskType(type)) return { ok: false, message: `Unknown mask type "${type}": use clip, alpha or luminance.` };
		const ids = [...new Set(options.ids ?? this.selectedRoots())];
		if (ids.length < 2) return { ok: false, message: 'Select at least two objects: the topmost becomes the mask, the ones below show through it.' };
		for (const id of ids) {
			const n = this.getNode(id);
			if (!n) return { ok: false, message: `There is no node "${id}".` };
			if (n.locked) return { ok: false, message: `"${id}" is locked; unlock it first.` };
			if (n.blendStep) return { ok: false, message: `"${id}" is a blend step; select its blend instead.` };
		}
		const locs = ids.map((id) => locateVectorNode(this.doc.nodes, id)!);
		const parent = locs[0].parent?.id ?? null;
		if (locs.some((l) => (l.parent?.id ?? null) !== parent)) return { ok: false, message: 'The objects must share a parent (group them, or pick objects at one level).' };
		const order = ids.slice().sort((a, b) => locs[ids.indexOf(a)].index - locs[ids.indexOf(b)].index);
		const maskId = options.maskId ?? order[order.length - 1];
		if (!order.includes(maskId)) return { ok: false, message: `The mask "${maskId}" must be one of the objects (${order.map((id) => `"${id}"`).join(', ')}).` };
		const id = this.newId();
		const mask: VectorMask = options.invert ? { type, invert: true } : { type };
		this.change(type === 'clip' ? 'Make Clipping Mask' : 'Make Opacity Mask', () => {
			const set = new Set(order);
			const regroup = (list: readonly VectorNode[]): VectorNode[] => {
				const members = order.map((m) => list.find((n) => n.id === m)!);
				const top = Math.max(...members.map((m) => list.indexOf(m)));
				const children = [members.find((m) => m.id === maskId)!, ...members.filter((m) => m.id !== maskId)];
				const out: VectorNode[] = [];
				list.forEach((n, i) => {
					if (i === top) out.push({ id, type: 'group', name: options.name ?? (type === 'clip' ? 'Clip Group' : 'Opacity Mask'), mask, children });
					if (!set.has(n.id)) out.push(n);
				});
				return out;
			};
			if (parent === null) this.setDoc(regroup(this.doc.nodes));
			else this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === parent && n.type === 'group' ? { ...n, children: regroup(n.children) } : n)));
			this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return { ok: true, id };
	}

	// -----------------------------------------------------------------------------------------
	// Lottie

	/**
	 * The document (or the selected / given nodes) as a Lottie animation (Bodymovin JSON): path
	 * effects stay live as shape modifiers, gradients are gradient fills; `notes` lists what was
	 * approximated or left out.
	 */
	toLottie(options: VectorLottieExportOptions & { ids?: readonly string[] } = {}): VectorLottieExport {
		const doc = this.storedDocument();
		const nodes = options.ids ? options.ids.map((id) => this.getNode(id)).filter((n): n is VectorNode => !!n) : undefined;
		return vectorDocumentToLottie(resolveVectorSymbols(doc), { ...options, ...(nodes ? { nodes: resolveVectorSymbols({ ...doc, nodes }).nodes } : {}) });
	}

	/**
	 * Adds one frame of a Lottie animation (JSON text or object) on top of the document as a group,
	 * or replaces the document with it (`replace`, taking its size). One undo step. Returns the new
	 * nodes' ids and what was approximated or left out.
	 */
	importLottie(input: unknown, options: VectorLottieImportOptions & { replace?: boolean } = {}): VectorActionResult & { ids?: string[]; notes?: string[] } {
		let parsed: VectorLottieImport;
		try {
			parsed = parseVectorLottie(input, { ...options, idPrefix: `${this.newId()}-` });
		} catch (e) {
			return { ok: false, message: `Not a Lottie animation this editor can read: ${(e as Error).message}` };
		}
		if (!parsed.document.nodes.length) return { ok: false, message: 'The Lottie animation has nothing to draw at that frame (no visible shape layers).' };
		const ids = parsed.document.nodes.map((n) => n.id);
		this.change('Import Lottie', () => {
			if (options.replace) this.doc = { ...this.doc, width: parsed.document.width, height: parsed.document.height, nodes: parsed.document.nodes };
			else this.setDoc([...this.doc.nodes, ...parsed.document.nodes]);
			this.selection = ids;
			this.anchors = [];
			this.editingId = null;
		});
		return { ok: true, ids, notes: parsed.notes };
	}

	// -----------------------------------------------------------------------------------------
	// Image tracing

	/**
	 * Image Trace: traces RGBA `pixels` into paths (see `traceVectorImage`) and adds them as one
	 * group, the image placed with its top-left at `x, y` (default 0, 0) and `width` wide (default:
	 * one unit per pixel; the height follows). One undo step; selects the group. Returns its id and
	 * the traced paths' ids, bottom to top.
	 */
	traceImage(pixels: VectorTracePixels, options: VectorTraceOptions & { x?: number; y?: number; width?: number; name?: string } = {}): VectorActionResult & { id?: string; ids?: string[] } {
		if (options.threshold !== undefined && !(options.threshold >= 0 && options.threshold <= 1)) return { ok: false, message: 'threshold must be from 0 to 1.' };
		if (options.colors !== undefined && !(Number.isInteger(options.colors) && options.colors >= 2 && options.colors <= 32)) return { ok: false, message: 'colors must be a whole number from 2 to 32.' };
		if (options.tolerance !== undefined && !(options.tolerance > 0)) return { ok: false, message: 'tolerance must be above 0 (pixels).' };
		if (options.width !== undefined && !(options.width > 0)) return { ok: false, message: 'width must be above 0.' };
		if (options.color !== undefined && !parseVectorColor(options.color)) return { ok: false, message: `"${options.color}" is not a colour.` };
		let traced: VectorPathNode[];
		try {
			traced = traceVectorImage(pixels, options);
		} catch (e) {
			return { ok: false, message: (e as Error).message };
		}
		if (!traced.length) return { ok: false, message: 'Nothing to trace: no shape reached the threshold (try another threshold, the alpha channel, or colour mode).' };
		const k = (options.width ?? pixels.width) / pixels.width;
		const m: AffineMatrix = [k, 0, 0, k, options.x ?? 0, options.y ?? 0];
		const children = traced.map((n) => ({ ...transformVectorNode(n, m), id: this.newId() }));
		const id = this.newId();
		this.change('Image Trace', () => {
			this.setDoc([...this.doc.nodes, { id, type: 'group', name: options.name ?? 'Image Trace', children }]);
			this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return { ok: true, id, ids: children.map((c) => c.id) };
	}

	// -----------------------------------------------------------------------------------------
	// Gradient meshes and freeform gradients

	/** The selected point of a mesh or freeform fill (Gradient tool), or null. */
	private shadingSel: { nodeId: string; index: number } | null = null;

	/** Selected paths with a mesh or freeform fill. */
	private shadedPaths(): VectorPathNode[] {
		return this.gradientPaths().filter((n) => isVectorShadedPaint(n.fill));
	}

	/** The shaded fill's point under `screen` (index), or a freeform shape under it (index -1), or null. */
	private shadedUnder(screen: Vec2): { nodeId: string; index: number } | null {
		const p = this.screenToDocument(screen);
		for (const n of this.shadedPaths()) {
			const world = this.worldOf(n.id);
			const fill = n.fill as VectorMeshGradient | VectorFreeformGradient;
			const z = this.viewport.zoom;
			let best = -1;
			let bestD = 8;
			fill.points.forEach((q, k) => {
				const w = applyMatrix(world, q);
				const d = Math.hypot(w.x - p.x, w.y - p.y) * z;
				if (d <= bestD) {
					best = k;
					bestD = d;
				}
			});
			if (best >= 0) return { nodeId: n.id, index: best };
			if (isVectorFreeformGradient(fill) && hitTestVectorNode(n, p, 0, this.parentMatrixOf(n.id))) return { nodeId: n.id, index: -1 };
		}
		return null;
	}

	private parentMatrixOf(id: string): AffineMatrix {
		return vectorParentMatrix(this.doc.nodes, id) ?? IDENTITY_MATRIX;
	}

	private moveShading(drag: Extract<Drag, { kind: 'shading' }>, screen: Vec2, p: Vec2) {
		if (drag.index < 0) return;
		if (!drag.moved && Math.hypot(screen.x - drag.start.x, screen.y - drag.start.y) < 3) return;
		drag.moved = true;
		const node = this.getNode(drag.nodeId) as VectorPathNode | undefined;
		if (!node || !isVectorShadedPaint(node.fill)) return;
		const local = this.toLocal(drag.nodeId, p);
		const fill = mapVectorShadedPaint(node.fill, (q) => q);
		const moved = isVectorMeshGradient(fill)
			? { ...fill, points: fill.points.map((q, k) => (k === drag.index ? { x: local.x, y: local.y } : q)) }
			: { ...fill, points: fill.points.map((q, k) => (k === drag.index ? { ...q, x: local.x, y: local.y } : q)) };
		this.replaceNode(drag.nodeId, normalizeVectorPaintStacks({ ...node, fill: moved }, 'shorthand'));
		this.notify(true);
	}

	private upShading(drag: Extract<Drag, { kind: 'shading' }>) {
		if (drag.moved) return this.commit(this.getNode(drag.nodeId) && isVectorMeshGradient((this.getNode(drag.nodeId) as VectorPathNode).fill) ? 'Move Mesh Point' : 'Move Freeform Point', drag.before);
		const at = this.screenToDocument(drag.start);
		if (drag.index < 0) {
			// A click in a freeform shape adds a point there, in the colour it shows.
			const r = this.addFreeformPoint(drag.nodeId, at);
			if (r.ok) {
				this.shadingSel = { nodeId: drag.nodeId, index: r.index! };
				this.notify();
			}
			return;
		}
		if (drag.alt && isVectorFreeformGradient((this.getNode(drag.nodeId) as VectorPathNode).fill)) {
			// Alt-click removes a freeform point.
			if (this.removeFreeformPoint(drag.nodeId, drag.index).ok) {
				this.shadingSel = null;
				this.notify();
			}
			return;
		}
		this.notify();
	}

	/** The selected point of a mesh or freeform fill (Gradient tool), with its paint's kind, or null. */
	getShadingSelection(): { nodeId: string; index: number; kind: 'mesh' | 'freeform' } | null {
		const sel = this.shadingSel;
		const node = sel ? (this.getNode(sel.nodeId) as VectorPathNode | undefined) : undefined;
		if (!sel || node?.type !== 'path' || !isVectorShadedPaint(node.fill) || sel.index >= node.fill.points.length) return null;
		return { ...sel, kind: node.fill.type };
	}


	/** The path `id` (or a message why it cannot take a mesh or freeform fill). */
	private shadingTarget(id: string): VectorPathNode | string {
		const n = this.getNode(id);
		if (!n) return `There is no node "${id}".`;
		if (n.type !== 'path') return `"${id}" is a ${n.type}: meshes and freeform gradients fill paths.`;
		if (n.locked) return `"${id}" is locked; unlock it first.`;
		return n;
	}

	/** Sets each node's fill in one undo step. */
	private setFills(label: string, fills: Map<string, VectorPaint>, merge?: string) {
		this.change(
			label,
			() => {
				this.setDoc(mapTree(this.doc.nodes, (n) => (fills.has(n.id) && n.type === 'path' ? normalizeVectorPaintStacks({ ...n, fill: fills.get(n.id)! } as VectorPathNode, 'shorthand') : n)));
			},
			merge
		);
	}

	/**
	 * Gives paths (default: the selection) a gradient mesh over their own bounds: `rows` ×
	 * `columns` patches (1–32) with points evenly spread, coloured by `colors` (one per point, row by
	 * row), the four `corners` (top-left, top-right, bottom-right, bottom-left) blended, or the
	 * current fill colour. One undo step.
	 */
	setMeshGradient(input: { rows: number; columns: number; colors?: readonly string[]; corners?: readonly [string, string, string, string] }, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const { rows, columns } = input;
		if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows > VECTOR_MESH_MAX || columns > VECTOR_MESH_MAX)
			return { ok: false, message: `rows and columns must be whole numbers from 1 to ${VECTOR_MESH_MAX}.` };
		const n = (rows + 1) * (columns + 1);
		if (input.colors && input.colors.length !== n) return { ok: false, message: `colors needs ${n} colours ((rows + 1) × (columns + 1), row by row); got ${input.colors.length}.` };
		if (input.corners && input.corners.length !== 4) return { ok: false, message: 'corners needs four colours: top-left, top-right, bottom-right, bottom-left.' };
		const bad = [...(input.colors ?? []), ...(input.corners ?? [])].find((c) => !parseVectorColor(c));
		if (bad !== undefined) return { ok: false, message: `"${bad}" is not a colour.` };
		const ids = options.ids ?? this.selection;
		if (!ids.length) return { ok: false, message: 'Select a path first.' };
		const fills = new Map<string, VectorPaint>();
		for (const id of ids) {
			const t = this.shadingTarget(id);
			if (typeof t === 'string') return { ok: false, message: t };
			const b = vectorPathLocalBounds(t);
			if (!b || !(b.width > 0 && b.height > 0)) return { ok: false, message: `"${id}" has no area to fill.` };
			const base = typeof t.fill === 'string' && parseVectorColor(t.fill) ? t.fill : '#ffffff';
			fills.set(id, createVectorMeshGradient(b, rows, columns, input.colors ? { colors: input.colors } : input.corners ? { corners: input.corners } : { colors: Array.from({ length: n }, () => base) }));
		}
		this.setFills('Gradient Mesh', fills);
		return { ok: true };
	}

	/**
	 * Gives paths (default: the selection) a freeform gradient: `points` in document units (each
	 * `{ x, y, color, opacity?, spread? }`) with optional `lines` through them, or, without points,
	 * four or more points placed inside each path and coloured along `colors` (default the current
	 * fill to white). One undo step.
	 */
	setFreeformGradient(input: { points?: readonly VectorFreeformPoint[]; lines?: readonly number[][]; colors?: readonly string[] } = {}, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const ids = options.ids ?? this.selection;
		if (!ids.length) return { ok: false, message: 'Select a path first.' };
		const fills = new Map<string, VectorPaint>();
		for (const id of ids) {
			const t = this.shadingTarget(id);
			if (typeof t === 'string') return { ok: false, message: t };
			const b = vectorPathLocalBounds(t);
			if (!b) return { ok: false, message: `"${id}" has no area to fill.` };
			let f: VectorFreeformGradient | null;
			if (input.points?.length) {
				f = sanitizeVectorShadedPaint({ type: 'freeform', points: input.points.map((q) => ({ ...q, ...this.toLocal(id, q) })), ...(input.lines ? { lines: input.lines } : {}) }) as VectorFreeformGradient | null;
				if (!f) return { ok: false, message: 'Each point needs x, y (numbers) and a colour.' };
				if (input.lines && (f.lines?.length ?? 0) !== input.lines.length) return { ok: false, message: `Each line needs two or more point indices from 0 to ${input.points.length - 1}, none twice in a row.` };
			} else {
				const bad = (input.colors ?? []).find((c) => !parseVectorColor(c));
				if (bad !== undefined) return { ok: false, message: `"${bad}" is not a colour.` };
				const outline = subpathsToBezier(t.subpaths);
				const inside = (q: Vec2) => pointInBezierPath(outline, [q.x, q.y], t.fillRule ?? 'nonzero');
				const base = typeof t.fill === 'string' && parseVectorColor(t.fill) ? t.fill : '#000000';
				f = autoVectorFreeformGradient(b, input.colors?.length ? input.colors : [base, '#ffffff'], inside);
			}
			fills.set(id, f);
		}
		this.setFills('Freeform Gradient', fills);
		return { ok: true };
	}

	/** The mesh or freeform fill of path `id` with its points in document units, or null. */
	getShading(id: string): (VectorMeshGradient | VectorFreeformGradient) | null {
		const n = this.getNode(id);
		if (n?.type !== 'path' || !isVectorShadedPaint(n.fill)) return null;
		const world = this.worldOf(id);
		return mapVectorShadedPaint(n.fill, (q) => applyMatrix(world, q));
	}

	/** Checks a shading point edit: the path, its shaded fill and the index. */
	private shadingPoint(id: string, index: number, kind: 'mesh' | 'freeform'): { node: VectorPathNode; paint: VectorMeshGradient | VectorFreeformGradient } | string {
		const t = this.shadingTarget(id);
		if (typeof t === 'string') return t;
		const paint = t.fill;
		if (kind === 'mesh' ? !isVectorMeshGradient(paint) : !isVectorFreeformGradient(paint))
			return `"${id}" has no ${kind === 'mesh' ? 'gradient mesh' : 'freeform gradient'} fill (add one with ${kind === 'mesh' ? 'vector.setMeshGradient' : 'vector.setFreeformGradient'}).`;
		const p = paint as VectorMeshGradient | VectorFreeformGradient;
		if (!Number.isInteger(index) || index < 0 || index >= p.points.length) return `Point ${index} is out of range: the ${kind} has ${p.points.length} points (0 to ${p.points.length - 1}).`;
		return { node: t, paint: p };
	}

	/**
	 * Changes point `index` (row by row) of path `id`'s gradient mesh: moves it to `x, y` (document
	 * units) and / or sets its `color` and `opacity`. One undo step (merged while `merge` is the same key).
	 */
	setMeshPoint(id: string, index: number, patch: { x?: number; y?: number; color?: string; opacity?: number }, options: { merge?: string } = {}): VectorActionResult {
		const r = this.shadingPoint(id, index, 'mesh');
		if (typeof r === 'string') return { ok: false, message: r };
		if (patch.color !== undefined && !parseVectorColor(patch.color)) return { ok: false, message: `"${patch.color}" is not a colour.` };
		if ((patch.x === undefined) !== (patch.y === undefined)) return { ok: false, message: 'Give both x and y to move the point.' };
		const m = r.paint as VectorMeshGradient;
		const at = patch.x !== undefined ? this.toLocal(id, { x: patch.x, y: patch.y! }) : m.points[index];
		const next: VectorMeshGradient = {
			...m,
			points: m.points.map((q, k) => (k === index ? { x: at.x, y: at.y } : q)),
			colors: m.colors.map((c, k) => (k === index && patch.color !== undefined ? patch.color : c))
		};
		if (patch.opacity !== undefined) {
			const ops = m.opacities ?? m.points.map(() => 1);
			next.opacities = ops.map((o, k) => (k === index ? Math.min(1, Math.max(0, patch.opacity!)) : o));
		}
		this.setFills('Edit Mesh Point', new Map([[id, next]]), options.merge);
		return { ok: true };
	}

	/** Adds a point to path `id`'s freeform gradient at `x, y` (document units), coloured `color` (default: the colour there now). One undo step. Returns its index. */
	addFreeformPoint(id: string, point: { x: number; y: number; color?: string; opacity?: number; spread?: number }): VectorActionResult & { index?: number } {
		const t = this.shadingTarget(id);
		if (typeof t === 'string') return { ok: false, message: t };
		if (!isVectorFreeformGradient(t.fill)) return { ok: false, message: `"${id}" has no freeform gradient fill (add one with vector.setFreeformGradient).` };
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ok: false, message: 'x and y must be numbers.' };
		if (point.color !== undefined && !parseVectorColor(point.color)) return { ok: false, message: `"${point.color}" is not a colour.` };
		const local = this.toLocal(id, point);
		const f = t.fill;
		const b = vectorPathLocalBounds(t);
		const here = sampleVectorFreeform(vectorFreeformField(f, b ? vectorFreeformSpreadScale(b) : 1), local);
		const next: VectorFreeformGradient = {
			...f,
			points: [
				...f.points,
				{
					x: local.x,
					y: local.y,
					color: point.color ?? vectorRgbaToCss([here[0], here[1], here[2], 1]),
					...(point.opacity !== undefined && point.opacity < 1 ? { opacity: Math.max(0, point.opacity) } : {}),
					...(point.spread ? { spread: Math.min(1, Math.max(0, point.spread)) } : {})
				}
			]
		};
		this.setFills('Add Freeform Point', new Map([[id, next]]));
		return { ok: true, index: next.points.length - 1 };
	}

	/** Changes point `index` of path `id`'s freeform gradient: position (document units), colour, opacity, spread. One undo step (merged while `merge` is the same key). */
	setFreeformPoint(id: string, index: number, patch: { x?: number; y?: number; color?: string; opacity?: number; spread?: number }, options: { merge?: string } = {}): VectorActionResult {
		const r = this.shadingPoint(id, index, 'freeform');
		if (typeof r === 'string') return { ok: false, message: r };
		if (patch.color !== undefined && !parseVectorColor(patch.color)) return { ok: false, message: `"${patch.color}" is not a colour.` };
		if ((patch.x === undefined) !== (patch.y === undefined)) return { ok: false, message: 'Give both x and y to move the point.' };
		const f = r.paint as VectorFreeformGradient;
		const at = patch.x !== undefined ? this.toLocal(id, { x: patch.x, y: patch.y! }) : null;
		const next: VectorFreeformGradient = {
			...f,
			points: f.points.map((q, k) => {
				if (k !== index) return q;
				const out: VectorFreeformPoint = { ...q, ...(at ? { x: at.x, y: at.y } : {}), ...(patch.color !== undefined ? { color: patch.color } : {}) };
				if (patch.opacity !== undefined) {
					if (patch.opacity >= 1) delete out.opacity;
					else out.opacity = Math.max(0, patch.opacity);
				}
				if (patch.spread !== undefined) {
					if (patch.spread <= 0) delete out.spread;
					else out.spread = Math.min(1, patch.spread);
				}
				return out;
			})
		};
		this.setFills('Edit Freeform Point', new Map([[id, next]]), options.merge);
		return { ok: true };
	}

	/** Removes point `index` of path `id`'s freeform gradient (never the last one); lines through it close up. One undo step. */
	removeFreeformPoint(id: string, index: number): VectorActionResult {
		const r = this.shadingPoint(id, index, 'freeform');
		if (typeof r === 'string') return { ok: false, message: r };
		const next = removeVectorFreeformPoint(r.paint as VectorFreeformGradient, index);
		if (!next) return { ok: false, message: 'A freeform gradient keeps at least one point.' };
		this.setFills('Remove Freeform Point', new Map([[id, next]]));
		return { ok: true };
	}

	/** Replaces the lines of path `id`'s freeform gradient: each a list of two or more point indices it runs through. One undo step. */
	setFreeformLines(id: string, lines: readonly number[][]): VectorActionResult {
		const t = this.shadingTarget(id);
		if (typeof t === 'string') return { ok: false, message: t };
		if (!isVectorFreeformGradient(t.fill)) return { ok: false, message: `"${id}" has no freeform gradient fill (add one with vector.setFreeformGradient).` };
		const f = sanitizeVectorShadedPaint({ ...t.fill, lines }) as VectorFreeformGradient;
		if ((f.lines?.length ?? 0) !== lines.length) return { ok: false, message: `Each line needs two or more point indices from 0 to ${t.fill.points.length - 1}, none twice in a row.` };
		const { lines: _l, ...rest } = t.fill;
		this.setFills('Freeform Lines', new Map([[id, lines.length ? { ...rest, lines: f.lines } : rest]]));
		return { ok: true };
	}

	// -----------------------------------------------------------------------------------------
	// Object snap tracking and typed entry (after cadcraft's snap/tracking.rs and its direct
	// distance entry)

	private trackingPoints: VectorTrackingPoint[] = [];
	private lastSnap: { kind: string; point: Vec2 } | null = null;
	private dwellTimer: ReturnType<typeof setTimeout> | null = null;
	private dwellAt: Vec2 | null = null;
	private dwellToggled: Vec2 | null = null;
	private typed: string | null = null;

	/** How long (ms) the pointer rests on a point before it is acquired or released for tracking. */
	static readonly TRACKING_DWELL_MS = 400;

	/** The pen's polar angles: measured from its last segment with `polarRelative`, else the page's (`snap.angles`). */
	private penAngles(): { angles?: readonly number[] } {
		if (!this.snap.polarRelative || !this.pen) return {};
		const node = this.getNode(this.pen.nodeId) as VectorPathNode | undefined;
		const sp = node?.subpaths[this.pen.subpath];
		if (!sp || sp.anchors.length < 2) return {};
		const n = sp.anchors.length;
		const a = getAnchorWorld(this.doc, { nodeId: this.pen.nodeId, subpath: this.pen.subpath, index: n - 2 })!;
		const b = getAnchorWorld(this.doc, { nodeId: this.pen.nodeId, subpath: this.pen.subpath, index: n - 1 })!;
		if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return {};
		const base = (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
		return { angles: this.snap.angles.map((x) => x + base) };
	}

	/** Pointer rested on the snapped anchor, centre or crossing: starts (or keeps) the dwell that acquires it. */
	private dwell(): void {
		const hit = this.snap.tracking !== false && this.lastSnap && (this.lastSnap.kind === 'anchor' || this.lastSnap.kind === 'centre' || this.lastSnap.kind === 'intersect') ? this.lastSnap.point : null;
		const same = (a: Vec2 | null, b: Vec2 | null) => !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;
		if (!hit) {
			this.dwellAt = null;
			this.dwellToggled = null;
			if (this.dwellTimer) clearTimeout(this.dwellTimer);
			this.dwellTimer = null;
			return;
		}
		if (same(hit, this.dwellToggled) || same(hit, this.dwellAt)) return;
		this.dwellToggled = null;
		this.dwellAt = hit;
		if (this.dwellTimer) clearTimeout(this.dwellTimer);
		this.dwellTimer = setTimeout(() => {
			this.dwellTimer = null;
			const at = this.dwellAt;
			this.dwellAt = null;
			if (!at) return;
			this.toggleTracking(at);
			this.dwellToggled = at;
			this.notify();
		}, VectorEditorController.TRACKING_DWELL_MS);
	}

	/** The direction an open path's end at `p` (document space) would extend in, or null when no open path ends there. */
	private extensionAt(p: Vec2): Vec2 | null {
		let out: Vec2 | null = null;
		walkVectorNodes(this.doc.nodes, (n) => {
			if (out || n.type !== 'path' || n.visible === false) return;
			n.subpaths.forEach((sp, s) => {
				if (out || sp.closed || sp.anchors.length < 2) return;
				for (const end of [0, sp.anchors.length - 1]) {
					const a = getAnchorWorld(this.doc, { nodeId: n.id, subpath: s, index: end })!;
					if (Math.hypot(a.x - p.x, a.y - p.y) > 1e-6) continue;
					const nextIndex = end === 0 ? 1 : end - 1;
					const handle = end === 0 ? a.out : a.in;
					const b = handle && Math.hypot(handle.x - a.x, handle.y - a.y) > 1e-9 ? handle : getAnchorWorld(this.doc, { nodeId: n.id, subpath: s, index: nextIndex })!;
					const d = { x: a.x - b.x, y: a.y - b.y };
					if (Math.hypot(d.x, d.y) > 1e-9) out = d;
					return;
				}
			});
		});
		return out;
	}

	private toggleTracking(p: Vec2): void {
		const i = this.trackingPoints.findIndex((t) => Math.hypot(t.x - p.x, t.y - p.y) < 1e-9);
		if (i >= 0) this.trackingPoints = this.trackingPoints.filter((_, k) => k !== i);
		else {
			const ext = this.extensionAt(p);
			this.trackingPoints = [...this.trackingPoints, { x: p.x, y: p.y, ...(ext ? { extension: ext } : {}) }].slice(-VECTOR_MAX_TRACKING_POINTS);
		}
	}

	/**
	 * Acquires the point at `x, y` (document units) for object snap tracking, or releases it when
	 * it is acquired already, as resting the pointer on it does. An open path's end also sends its
	 * extension. At most seven are kept, the oldest dropped. Returns the acquired points.
	 */
	acquireTrackingPoint(p: Vec2): readonly VectorTrackingPoint[] {
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return this.trackingPoints;
		this.toggleTracking(p);
		this.notify();
		return this.trackingPoints;
	}

	/** Releases every acquired tracking point. */
	clearTracking(notify = true): void {
		const had = this.trackingPoints.length > 0;
		this.trackingPoints = [];
		this.dwellAt = null;
		this.dwellToggled = null;
		if (this.dwellTimer) clearTimeout(this.dwellTimer);
		this.dwellTimer = null;
		if (had && notify) this.notify();
	}

	/** A key typed while the pen draws: digits and `. , < @ -` build a typed entry, Enter places it, Backspace and Escape edit or drop it. */
	private typedKey(input: VectorKeyInput): boolean {
		if (input.mod || this.tool !== 'pen' || !this.pen || this.drag) return false;
		const key = input.key;
		if (this.typed === null) {
			if (!/^[0-9.@-]$/.test(key)) return false;
			this.typed = key;
			this.notify();
			return true;
		}
		if (/^[0-9.,<@-]$/.test(key)) this.typed += key;
		else if (key === 'Backspace') this.typed = this.typed.length > 1 ? this.typed.slice(0, -1) : null;
		else if (key === 'Escape') this.typed = null;
		else if (key === 'Enter') {
			const text = this.typed;
			this.typed = null;
			const r = this.placePenPoint(text);
			if (!r.ok) this.notify();
			return true;
		} else return false;
		this.notify();
		return true;
	}

	/**
	 * Places the pen's next point from typed text, as CAD direct distance entry does: `120` is that
	 * far from the last point toward the pointer (along the path it tracks), `120<30` that far at 30°
	 * (counter-clockwise on the page, from the last segment with `snap.polarRelative`), `@40,-10`
	 * an offset from the last point and `200,150` a position. One undo step. Fails without a path
	 * being drawn with the pen.
	 */
	placePenPoint(text: string): VectorActionResult {
		const pen = this.pen;
		const node = pen ? (this.getNode(pen.nodeId) as VectorPathNode | undefined) : undefined;
		const sp = pen && node ? node.subpaths[pen.subpath] : undefined;
		if (!pen || !node || !sp?.anchors.length) return { ok: false, message: 'Start a path with the pen first: typed entry places its next point.' };
		const last = getAnchorWorld(this.doc, { nodeId: pen.nodeId, subpath: pen.subpath, index: sp.anchors.length - 1 })!;
		const num = '(-?(?:\\d+\\.?\\d*|\\.\\d+))';
		const t = text.replace(/\s+/g, '');
		let target: Vec2 | null = null;
		let m: RegExpMatchArray | null;
		if ((m = t.match(new RegExp(`^@${num},${num}$`)))) target = { x: last.x + parseFloat(m[1]), y: last.y + parseFloat(m[2]) };
		else if ((m = t.match(new RegExp(`^${num},${num}$`)))) target = { x: parseFloat(m[1]), y: parseFloat(m[2]) };
		else if ((m = t.match(new RegExp(`^${num}<${num}$`)))) {
			const base = this.snap.polarRelative ? (this.penAngles().angles?.[0] ?? this.snap.angles[0] ?? 0) - (this.snap.angles[0] ?? 0) : 0;
			const dir = vectorAngleDirection(parseFloat(m[2]) + base);
			const len = parseFloat(m[1]);
			target = { x: last.x + dir.x * len, y: last.y + dir.y * len };
		} else if ((m = t.match(new RegExp(`^${num}$`)))) {
			const toward = this.pointer;
			const d = toward ? Math.hypot(toward.x - last.x, toward.y - last.y) : 0;
			if (!toward || d < 1e-9) return { ok: false, message: 'Point the pointer the way the distance should go (or type length<angle).' };
			const len = parseFloat(m[1]);
			target = { x: last.x + ((toward.x - last.x) / d) * len, y: last.y + ((toward.y - last.y) / d) * len };
		}
		if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return { ok: false, message: `Cannot read "${text}": type a distance (120), length<angle (120<30), an offset (@40,-10) or a position (200,150).` };
		const local = this.toLocal(pen.nodeId, target);
		const anchors = [...sp.anchors, { x: local.x, y: local.y }];
		this.change('Add Point', () => {
			this.replaceNode(pen.nodeId, { ...node, subpaths: node.subpaths.map((s2, i) => (i === pen.subpath ? { ...s2, anchors } : s2)) });
			this.anchors = [{ nodeId: pen.nodeId, subpath: pen.subpath, index: anchors.length - 1 }];
		});
		return { ok: true };
	}

	/**
	 * Adds an open (or closed) path drawn by dimensions, the way a CAD user types them: from
	 * `start`, each step goes `length` at `angle` degrees (counter-clockwise on the page), by an
	 * offset `dx, dy`, or to a position `x, y` (document units). Default style. One undo step;
	 * selects it. Returns its id and the anchors placed.
	 */
	addPathByDimensions(input: { start: Vec2; steps: readonly ({ length: number; angle: number } | { dx: number; dy: number } | { x: number; y: number })[]; closed?: boolean; name?: string }): VectorMaskResult & { anchors?: Vec2[] } {
		if (!input.start || !Number.isFinite(input.start.x) || !Number.isFinite(input.start.y)) return { ok: false, message: 'start must be { x, y } in document units.' };
		if (!input.steps?.length) return { ok: false, message: 'Give at least one step.' };
		const pts: Vec2[] = [{ x: input.start.x, y: input.start.y }];
		for (const [i, step] of input.steps.entries()) {
			const at = pts[pts.length - 1];
			const st = step as Record<string, number>;
			let q: Vec2 | null = null;
			if ('length' in st && 'angle' in st) {
				const dir = vectorAngleDirection(st.angle);
				q = { x: at.x + dir.x * st.length, y: at.y + dir.y * st.length };
			} else if ('dx' in st && 'dy' in st) q = { x: at.x + st.dx, y: at.y + st.dy };
			else if ('x' in st && 'y' in st) q = { x: st.x, y: st.y };
			if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) return { ok: false, message: `Step ${i} must be { length, angle }, { dx, dy } or { x, y } with numbers.` };
			pts.push(q);
		}
		const id = this.newId();
		const closed = !!input.closed;
		const node: VectorPathNode = { id, type: 'path', name: input.name ?? 'Path', ...this.styleFor(!closed), subpaths: [{ closed, anchors: pts.map((p) => ({ x: p.x, y: p.y })) }] };
		this.change('Add Path', () => {
			this.setDoc([...this.doc.nodes, node]);
			this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return { ok: true, id, anchors: pts };
	}

	// -----------------------------------------------------------------------------------------
	// Connectors

	/** How near (document units) a connector end snaps to a connection site. */
	private connectorRadius(): number {
		return 12 / this.viewport.zoom;
	}

	private downConnector(p: Vec2) {
		const before = this.snapshot();
		const target = vectorConnectorTargetAt(this.doc.nodes, p, this.connectorRadius());
		const at = target?.site ?? p;
		const node: VectorPathNode = {
			id: this.newId(),
			type: 'path',
			name: 'Connector',
			...this.styleFor(true),
			...(this.defaults.endArrow === undefined ? { endArrow: 'triangle' as const } : {}),
			connector: { start: target ? { nodeId: target.nodeId, ...(target.side && target.side !== 'auto' ? { side: target.side } : {}) } : null, end: null, route: this.connectorRoute },
			subpaths: [{ closed: false, anchors: [{ x: at.x, y: at.y }, { x: at.x, y: at.y }] }]
		};
		this.setDoc([...this.doc.nodes, node]);
		this.drag = { kind: 'connector', nodeId: node.id, start: { x: at.x, y: at.y }, before };
		this.interaction = { type: 'draw', tool: 'connector', nodeId: node.id, bounds: { x: at.x, y: at.y, width: 0, height: 0 } };
		this.notify(true);
	}

	/** The route new connectors get (the Connector tool and `addConnector`). Default straight. */
	private connectorRoute: VectorConnectorRoute = 'straight';

	/** Sets the route the Connector tool draws with. */
	setConnectorRoute(route: VectorConnectorRoute): VectorActionResult {
		if (!VECTOR_CONNECTOR_ROUTES.includes(route)) return { ok: false, message: `Unknown route "${route}": use ${VECTOR_CONNECTOR_ROUTES.join(', ')}.` };
		this.connectorRoute = route;
		this.notify();
		return { ok: true };
	}

	/** The route the Connector tool draws with. */
	getConnectorRoute(): VectorConnectorRoute {
		return this.connectorRoute;
	}

	/** Checks a connector end given by an API caller: the object must exist and not be a connector. */
	private checkConnectorEnd(end: VectorConnectorEnd, self?: string): string | null {
		if (!end || typeof end.nodeId !== 'string') return 'A glued end needs a nodeId.';
		const n = this.getNode(end.nodeId);
		if (!n) return `There is no node "${end.nodeId}".`;
		if (end.nodeId === self) return 'A connector cannot be glued to itself.';
		if (isVectorConnector(n)) return `"${end.nodeId}" is a connector: glue ends to shapes, text, groups or instances.`;
		if (end.side !== undefined && !VECTOR_CONNECTOR_SIDES.includes(end.side)) return `Unknown side "${end.side}": use ${VECTOR_CONNECTOR_SIDES.join(', ')}.`;
		if (!vectorConnectionSites(this.doc.nodes, end.nodeId).length) return `"${end.nodeId}" has no extent (or is hidden) to connect to.`;
		return null;
	}

	/**
	 * Adds a connector from `start` to `end`, each glued to an object (`{ nodeId, side? }`, side
	 * default `auto`) or a free point (`{ x, y }`, document units). It is routed now and after every
	 * later edit, so it follows the objects. Stroked in the default stroke with an arrowhead at the
	 * end unless given. One undo step; selects it.
	 */
	addConnector(input: {
		start: VectorConnectorEnd | Vec2;
		end: VectorConnectorEnd | Vec2;
		route?: VectorConnectorRoute;
		radius?: number;
		gap?: number;
		name?: string;
		stroke?: VectorPaint;
		strokeWidth?: number;
		startArrow?: VectorArrowhead | null;
		endArrow?: VectorArrowhead | null;
	}): VectorMaskResult {
		const glued = (e: VectorConnectorEnd | Vec2): e is VectorConnectorEnd => !!e && typeof (e as VectorConnectorEnd).nodeId === 'string';
		for (const e of [input.start, input.end]) {
			if (glued(e)) {
				const problem = this.checkConnectorEnd(e);
				if (problem) return { ok: false, message: problem };
			} else if (!e || !Number.isFinite((e as Vec2).x) || !Number.isFinite((e as Vec2).y)) return { ok: false, message: 'Each end is { nodeId, side? } or a point { x, y }.' };
		}
		if (glued(input.start) && glued(input.end) && input.start.nodeId === input.end.nodeId) return { ok: false, message: 'Both ends are glued to the same object; connect two different objects.' };
		const route = input.route ?? this.connectorRoute;
		if (!VECTOR_CONNECTOR_ROUTES.includes(route)) return { ok: false, message: `Unknown route "${route}": use ${VECTOR_CONNECTOR_ROUTES.join(', ')}.` };
		if (input.radius !== undefined && !(Number.isFinite(input.radius) && input.radius >= 0)) return { ok: false, message: 'radius must be zero or more.' };
		if (input.gap !== undefined && !(Number.isFinite(input.gap) && input.gap >= 0)) return { ok: false, message: 'gap must be zero or more.' };
		const point = (e: VectorConnectorEnd | Vec2): Vec2 => (glued(e) ? { x: 0, y: 0 } : { x: (e as Vec2).x, y: (e as Vec2).y });
		const endOf = (e: VectorConnectorEnd | Vec2) => (glued(e) ? { nodeId: e.nodeId, ...(e.side && e.side !== 'auto' ? { side: e.side } : {}) } : null);
		const id = this.newId();
		const style = this.styleFor(true);
		const node: VectorPathNode = {
			id,
			type: 'path',
			name: input.name ?? 'Connector',
			...style,
			stroke: input.stroke !== undefined ? input.stroke : (style.stroke ?? '#000000'),
			...(input.strokeWidth !== undefined ? { strokeWidth: input.strokeWidth } : {}),
			...(input.startArrow !== undefined ? { startArrow: input.startArrow } : {}),
			endArrow: input.endArrow !== undefined ? input.endArrow : (style.endArrow ?? 'triangle'),
			connector: {
				start: endOf(input.start),
				end: endOf(input.end),
				...(route !== 'straight' ? { route } : {}),
				...(input.radius ? { radius: input.radius } : {}),
				...(input.gap !== undefined ? { gap: input.gap } : {})
			},
			subpaths: [{ closed: false, anchors: [point(input.start), point(input.end)] }]
		};
		this.change('Connect', () => {
			this.setDoc([...this.doc.nodes, node]);
			this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return { ok: true, id };
	}

	/**
	 * Changes connectors (default: the selected ones): `start` / `end` glue an end to an object
	 * (`{ nodeId, side? }`) or unglue it (`null`, the end staying where it is), and `route`,
	 * `radius`, `gap` set how they run. Plain open paths given by id become connectors. One undo step.
	 */
	setConnector(
		patch: { start?: VectorConnectorEnd | null; end?: VectorConnectorEnd | null; route?: VectorConnectorRoute; radius?: number; gap?: number },
		options: { ids?: readonly string[] } = {}
	): VectorActionResult {
		const ids = options.ids ?? this.selection;
		if (!ids.length) return { ok: false, message: 'Select a connector first.' };
		if (patch.route !== undefined && !VECTOR_CONNECTOR_ROUTES.includes(patch.route)) return { ok: false, message: `Unknown route "${patch.route}": use ${VECTOR_CONNECTOR_ROUTES.join(', ')}.` };
		if (patch.radius !== undefined && !(Number.isFinite(patch.radius) && patch.radius >= 0)) return { ok: false, message: 'radius must be zero or more.' };
		if (patch.gap !== undefined && !(Number.isFinite(patch.gap) && patch.gap >= 0)) return { ok: false, message: 'gap must be zero or more.' };
		for (const id of ids) {
			const n = this.getNode(id);
			if (!n) return { ok: false, message: `There is no node "${id}".` };
			if (n.locked) return { ok: false, message: `"${id}" is locked; unlock it first.` };
			if (!isVectorConnector(n) && !(n.type === 'path' && n.subpaths.length === 1 && !n.subpaths[0].closed && n.subpaths[0].anchors.length >= 2))
				return { ok: false, message: `"${id}" is not a connector or an open path (draw one with vector.connect or the Connector tool).` };
			for (const key of ['start', 'end'] as const) {
				const e = patch[key];
				if (e) {
					const problem = this.checkConnectorEnd(e, id);
					if (problem) return { ok: false, message: problem };
				}
			}
		}
		const set = new Set(ids);
		const endOf = (e: VectorConnectorEnd | null) => (e ? { nodeId: e.nodeId, ...(e.side && e.side !== 'auto' ? { side: e.side } : {}) } : null);
		this.change('Connector', () => {
			this.setDoc(
				mapTree(this.doc.nodes, (n) => {
					if (!set.has(n.id) || n.type !== 'path') return n;
					const c: VectorConnector = { ...(n.connector ?? {}) };
					if (patch.start !== undefined) c.start = endOf(patch.start);
					if (patch.end !== undefined) c.end = endOf(patch.end);
					if (patch.route !== undefined) {
						if (patch.route === 'straight') delete c.route;
						else c.route = patch.route;
					}
					if (patch.radius !== undefined) {
						if (patch.radius > 0) c.radius = patch.radius;
						else delete c.radius;
					}
					if (patch.gap !== undefined) c.gap = patch.gap;
					return { ...n, connector: c };
				})
			);
		});
		return { ok: true };
	}

	/** Every connector: its ends (glued object and resolved side, or the free point) and route. */
	getConnectors(): VectorConnectorListing[] {
		const out: VectorConnectorListing[] = [];
		walkVectorNodes(this.doc.nodes, (n) => {
			if (!isVectorConnector(n)) return;
			const r = routeVectorConnector(this.doc.nodes, n.id);
			const world = vectorWorldMatrix(this.doc.nodes, n.id) ?? IDENTITY_MATRIX;
			const sp = n.subpaths[0];
			const first = sp?.anchors[0];
			const last = sp?.anchors[sp.anchors.length - 1];
			const end = (e: VectorConnectorEnd | null | undefined, side: string | null, a: VectorAnchor | undefined) => {
				const at = a ? applyMatrix(world, a) : null;
				return { ...(e ? { nodeId: e.nodeId, side: e.side ?? 'auto', resolvedSide: side } : {}), ...(at ? { x: at.x, y: at.y } : {}) };
			};
			out.push({
				id: n.id,
				...(n.name ? { name: n.name } : {}),
				route: n.connector.route ?? 'straight',
				...(n.connector.radius ? { radius: n.connector.radius } : {}),
				start: end(n.connector.start, r?.startSide ?? null, first),
				end: end(n.connector.end, r?.endSide ?? null, last)
			});
		});
		return out;
	}

	/** The connection sites of node `id` in document space (top, right, bottom, left, centre), or null when there is no such node. */
	getConnectionSites(id: string): VectorConnectionSite[] | null {
		if (!this.getNode(id)) return null;
		return vectorConnectionSites(this.doc.nodes, id);
	}

	// -----------------------------------------------------------------------------------------
	// Frames (artboards) and resizing constraints

	/** A name for a new frame: "Frame <n>" after the frames there are. */
	private frameName(): string {
		let n = 0;
		walkVectorNodes(this.doc.nodes, (x) => {
			if (isVectorFrame(x)) n++;
		});
		return `Frame ${n + 1}`;
	}

	/**
	 * Adds an empty frame (an artboard when top-level) with its rectangle at `x, y, width, height`
	 * (document units), filled white by default and clipping its contents. With `adopt`, the
	 * top-level objects it fully encloses move into it. One undo step; selects it.
	 */
	addFrame(input: { x: number; y: number; width: number; height: number; name?: string; fill?: VectorPaint; clip?: boolean; adopt?: boolean }): VectorMaskResult {
		const { x, y, width, height } = input;
		if (![x, y, width, height].every(Number.isFinite)) return { ok: false, message: 'x, y, width and height must be numbers.' };
		if (!(width > 0 && height > 0)) return { ok: false, message: 'A frame needs a positive width and height.' };
		const id = this.newId();
		const rect: VectorBounds = { x, y, width, height };
		const adopted = input.adopt ? this.doc.nodes.filter((n) => !n.locked && n.visible !== false && !n.blendStep && vectorBoundsInside(vectorNodeBounds(n), rect)) : [];
		const frame: VectorFrameGroup = {
			id,
			type: 'group',
			name: input.name ?? this.frameName(),
			frame: { x, y, width, height, fill: input.fill === undefined ? '#ffffff' : input.fill, ...(input.clip === false ? { clip: false } : {}) },
			children: adopted
		};
		const taken = new Set(adopted.map((n) => n.id));
		this.change('Add Frame', () => {
			this.setDoc([...this.doc.nodes.filter((n) => !taken.has(n.id)), frame]);
			this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return { ok: true, id };
	}

	/**
	 * Frame Selection: puts the selected (or given) objects, which must share a parent, into a new
	 * frame fitted to their bounds plus `padding` (document units, default 0), in their place in the
	 * stacking order. No fill unless `fill` is given; clips unless `clip: false`. One undo step;
	 * selects the frame.
	 */
	frameSelection(options: { ids?: readonly string[]; padding?: number; name?: string; fill?: VectorPaint; clip?: boolean } = {}): VectorMaskResult {
		const ids = [...new Set(options.ids ?? this.selectedRoots())];
		if (!ids.length) return { ok: false, message: 'Select the objects to frame first.' };
		const padding = options.padding ?? 0;
		if (!(Number.isFinite(padding) && padding >= 0)) return { ok: false, message: 'padding must be zero or more.' };
		for (const id of ids) {
			const n = this.getNode(id);
			if (!n) return { ok: false, message: `There is no node "${id}".` };
			if (n.locked) return { ok: false, message: `"${id}" is locked; unlock it first.` };
			if (n.blendStep) return { ok: false, message: `"${id}" is a blend step; select its blend instead.` };
		}
		const locs = ids.map((id) => locateVectorNode(this.doc.nodes, id)!);
		const parent = locs[0].parent ?? null;
		if (locs.some((l) => (l.parent?.id ?? null) !== (parent?.id ?? null))) return { ok: false, message: 'The objects must share a parent (pick objects at one level).' };
		const b = unionBounds(ids.map((id) => vectorNodeBounds(this.getNode(id)!)));
		if (!b) return { ok: false, message: 'The objects have no extent to frame.' };
		const id = this.newId();
		const order = ids.slice().sort((a, c) => locs[ids.indexOf(a)].index - locs[ids.indexOf(c)].index);
		const set = new Set(order);
		const frame = {
			x: b.x - padding,
			y: b.y - padding,
			width: b.width + 2 * padding,
			height: b.height + 2 * padding,
			...(options.fill !== undefined && options.fill !== null ? { fill: options.fill } : {}),
			...(options.clip === false ? { clip: false } : {})
		};
		this.change('Frame Selection', () => {
			const regroup = (list: readonly VectorNode[]): VectorNode[] => {
				const members = order.map((m) => list.find((n) => n.id === m)!);
				const top = Math.max(...members.map((m) => list.indexOf(m)));
				const out: VectorNode[] = [];
				list.forEach((n, i) => {
					if (i === top) out.push({ id, type: 'group', name: options.name ?? this.frameName(), frame, children: members });
					if (!set.has(n.id)) out.push(n);
				});
				return out;
			};
			if (!parent) this.setDoc(regroup(this.doc.nodes));
			else this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === parent.id && n.type === 'group' ? { ...n, children: regroup(n.children) } : n)));
			this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return { ok: true, id };
	}

	/** Frames among `ids` (default: the selection), or holding one of them directly. */
	private frameTargets(ids?: readonly string[]): VectorFrameGroup[] {
		const out = new Map<string, VectorFrameGroup>();
		for (const id of ids ?? this.selection) {
			const n = this.getNode(id);
			if (isVectorFrame(n)) out.set(n.id, n);
			else if (!ids) {
				const parent = locateVectorNode(this.doc.nodes, id)?.parent;
				if (isVectorFrame(parent)) out.set(parent.id, parent);
			}
		}
		return [...out.values()];
	}

	/**
	 * Changes frames (default: the selected ones, or the frame holding the selection): `x`, `y`,
	 * `width`, `height` move and resize the rectangle (in the frame's own space), and its children
	 * follow their resizing constraints; `fill` (null for none) and `clip` set how it draws.
	 * One undo step (merged while `merge` is the same key).
	 */
	setFrame(patch: { x?: number; y?: number; width?: number; height?: number; fill?: VectorPaint; clip?: boolean }, options: { ids?: readonly string[]; merge?: string } = {}): VectorActionResult {
		for (const k of ['x', 'y', 'width', 'height'] as const) if (patch[k] !== undefined && !Number.isFinite(patch[k])) return { ok: false, message: `${k} must be a number.` };
		if ((patch.width !== undefined && !(patch.width > 0)) || (patch.height !== undefined && !(patch.height > 0))) return { ok: false, message: 'A frame needs a positive width and height.' };
		if (patch.clip !== undefined && typeof patch.clip !== 'boolean') return { ok: false, message: 'clip must be true or false.' };
		if (options.ids) for (const id of options.ids) if (!isVectorFrame(this.getNode(id))) return { ok: false, message: `"${id}" is not a frame (use frameSelection or addFrame to make one).` };
		const frames = this.frameTargets(options.ids);
		if (!frames.length) return { ok: false, message: 'Select a frame (or something in one).' };
		const locked = frames.find((f) => f.locked);
		if (locked) return { ok: false, message: `"${locked.id}" is locked; unlock it first.` };
		const next = new Map<string, VectorNode>();
		for (const f of frames) {
			const from = f.frame;
			const to = { x: patch.x ?? from.x, y: patch.y ?? from.y, width: patch.width ?? from.width, height: patch.height ?? from.height };
			let node: VectorFrameGroup = f;
			if (to.x !== from.x || to.y !== from.y || to.width !== from.width || to.height !== from.height) {
				// The rectangle's map in the frame's own space, carried into its parent's space.
				const sx = from.width > 1e-9 ? to.width / from.width : 1;
				const sy = from.height > 1e-9 ? to.height / from.height : 1;
				const local: AffineMatrix = [sx, 0, 0, sy, to.x - sx * from.x, to.y - sy * from.y];
				const own = nodeMatrix(f);
				node = transformVectorNode(f, multiplyMatrices(multiplyMatrices(invertMatrix(own), local), own));
				// Exact numbers (the map can round); the placement is unchanged.
				node = { ...node, frame: { ...node.frame, ...to }, ...(f.transform ? { transform: f.transform } : {}) };
			}
			const frame = { ...node.frame };
			if (patch.fill !== undefined) {
				if (patch.fill === null || patch.fill === 'none') delete frame.fill;
				else frame.fill = patch.fill;
			}
			if (patch.clip !== undefined) {
				if (patch.clip) delete frame.clip;
				else frame.clip = false;
			}
			next.set(f.id, { ...node, frame });
		}
		this.change(
			'Frame',
			() => {
				this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n));
			},
			options.merge
		);
		return { ok: true };
	}

	/**
	 * Sets the resizing constraints of the selected (or given) objects, which must be children of
	 * frames: how each follows its frame when the frame is resized. A missing axis keeps its value.
	 * One undo step.
	 */
	setResizing(resizing: VectorResizing, options: { ids?: readonly string[] } = {}): VectorActionResult {
		if (resizing.horizontal !== undefined && !VECTOR_HORIZONTAL_RESIZING.includes(resizing.horizontal)) return { ok: false, message: `Unknown horizontal constraint "${resizing.horizontal}": use ${VECTOR_HORIZONTAL_RESIZING.join(', ')}.` };
		if (resizing.vertical !== undefined && !VECTOR_VERTICAL_RESIZING.includes(resizing.vertical)) return { ok: false, message: `Unknown vertical constraint "${resizing.vertical}": use ${VECTOR_VERTICAL_RESIZING.join(', ')}.` };
		if (!resizing.horizontal && !resizing.vertical) return { ok: false, message: 'Pass horizontal, vertical or both.' };
		const ids = options.ids ?? this.selection;
		if (!ids.length) return { ok: false, message: 'Select objects inside a frame first.' };
		for (const id of ids) {
			if (!this.getNode(id)) return { ok: false, message: `There is no node "${id}".` };
			if (!isVectorFrame(locateVectorNode(this.doc.nodes, id)?.parent)) return { ok: false, message: `"${id}" is not directly inside a frame: resizing constraints only apply to a frame's children.` };
		}
		const set = new Set(ids);
		this.change('Constraints', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (set.has(n.id) ? { ...n, resizing: { ...n.resizing, ...resizing } } : n)));
		});
		return { ok: true };
	}

	/** Every frame in the document (top-level ones are artboards), with its rectangle, parent and children's constraints. */
	getFrames(): VectorFrameListing[] {
		const out: VectorFrameListing[] = [];
		const visit = (list: readonly VectorNode[], parent: string | null) => {
			for (const n of list) {
				if (isVectorFrame(n)) {
					out.push({
						id: n.id,
						name: n.name ?? 'Frame',
						parentId: parent,
						artboard: parent === null,
						frame: n.frame,
						bounds: vectorNodeBounds(n, vectorParentMatrix(this.doc.nodes, n.id) ?? IDENTITY_MATRIX),
						children: n.children.map((c) => ({ id: c.id, type: c.type, ...(c.name ? { name: c.name } : {}), horizontal: c.resizing?.horizontal ?? 'left', vertical: c.resizing?.vertical ?? 'top' }))
					});
				}
				if (n.type === 'group') visit(n.children, n.id);
			}
		};
		visit(this.doc.nodes, null);
		return out;
	}

	/** One frame as an SVG document of its own size (its corner at the origin), or null when `id` is not a frame. */
	frameToSvg(id: string, options: VectorSvgExportOptions = {}): string | null {
		const doc = vectorFrameDocument(this.storedDocument(), id, findVectorNode);
		return doc ? vectorDocumentToSvg(doc, options) : null;
	}

	/** Mask groups among `ids` (default: the selection), or holding one of them directly. */
	private maskTargets(ids?: readonly string[]): VectorGroupNode[] {
		const out = new Map<string, VectorGroupNode>();
		for (const id of ids ?? this.selection) {
			const n = this.getNode(id);
			if (isVectorMaskGroup(n)) out.set(n.id, n);
			else {
				const parent = locateVectorNode(this.doc.nodes, id)?.parent;
				if (isVectorMaskGroup(parent)) out.set(parent.id, parent);
			}
		}
		return [...out.values()];
	}

	/**
	 * Release: the selected (or given) mask groups stop masking. The mask goes back on top of the
	 * contents, drawn as itself again. A group with appearance of its own (filters, a blend mode,
	 * path effects) stays a plain group; otherwise it is replaced by its children. One undo step.
	 * Returns the released nodes' ids (the mask last).
	 */
	releaseMask(options: { ids?: readonly string[] } = {}): string[] {
		const groups = this.maskTargets(options.ids);
		if (!groups.length) return [];
		const released: string[] = [];
		this.change('Release Mask', () => {
			for (const g of groups) {
				const [mask, ...contents] = g.children;
				const children = [...contents, mask];
				released.push(...children.map((c) => c.id));
				const { mask: _m, ...rest } = g;
				const keep = !!(g.filters?.length || (g.blendMode && g.blendMode !== 'normal') || g.effects?.length);
				if (keep) {
					this.replaceNode(g.id, { ...rest, children });
					continue;
				}
				const m = nodeMatrix(g);
				const opacity = g.opacity;
				const flat = children
					.map((c) => (g.transform ? transformVectorNode(c, m) : c))
					.map((c) => (opacity !== undefined && opacity < 1 ? { ...c, opacity: (c.opacity ?? 1) * opacity } : c));
				this.setDoc(spliceTree(this.doc.nodes, g.id, flat));
			}
			this.selection = released;
			this.anchors = [];
			this.editingId = null;
		});
		return released;
	}

	/**
	 * Changes the type or inversion of the selected (or given) mask groups, or turns their masks off
	 * (`enabled: false` hides the mask, so the contents draw whole) and on. One undo step.
	 */
	setMaskOptions(patch: Partial<VectorMask> & { enabled?: boolean }, options: { ids?: readonly string[] } = {}): VectorActionResult {
		if (patch.type !== undefined && !isVectorMaskType(patch.type)) return { ok: false, message: `Unknown mask type "${patch.type}": use clip, alpha or luminance.` };
		if (patch.invert !== undefined && typeof patch.invert !== 'boolean') return { ok: false, message: 'invert must be true or false.' };
		if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') return { ok: false, message: 'enabled must be true or false.' };
		const groups = this.maskTargets(options.ids);
		if (!groups.length) return { ok: false, message: 'Select a mask group (made with Make Clipping Mask or Make Opacity Mask).' };
		const set = new Set(groups.map((g) => g.id));
		this.change('Mask Options', () => {
			this.setDoc(
				mapTree(this.doc.nodes, (n) => {
					if (!set.has(n.id) || !isVectorMaskGroup(n)) return n;
					const type = patch.type ?? n.mask.type;
					const invert = patch.invert ?? !!n.mask.invert;
					const [source, ...rest] = n.children;
					const shown = patch.enabled === undefined || patch.enabled === (source.visible !== false) ? source : patch.enabled ? (({ visible: _v, ...r }) => r as VectorNode)(source) : { ...source, visible: false };
					return { ...n, mask: invert ? { type, invert } : { type }, ...(shown !== source ? { children: [shown, ...rest] } : {}) };
				})
			);
		});
		return { ok: true };
	}

	/**
	 * Edit Mask: selects the mask of the selected (or given) mask group, or of the group holding the
	 * selection. A path mask opens in the direct tool for anchor editing (`editPath: false` keeps the
	 * tool). Returns the mask's id, or null.
	 */
	editMask(options: { id?: string; editPath?: boolean } = {}): string | null {
		const group = this.maskTargets(options.id ? [options.id] : undefined)[0];
		if (!group) return null;
		const mask = group.children[0];
		this.selection = [mask.id];
		this.anchors = [];
		this.editingId = null;
		if (mask.type === 'path' && options.editPath !== false && !mask.locked) {
			this.tool = 'direct';
			this.editingId = mask.id;
		}
		this.notify();
		return mask.id;
	}

	/** Edit Contents: selects what the selected (or given) mask group masks. Returns their ids. */
	editMaskContents(options: { id?: string } = {}): string[] {
		const group = this.maskTargets(options.id ? [options.id] : undefined)[0];
		if (!group) return [];
		this.selection = group.children.slice(1).map((c) => c.id);
		this.anchors = [];
		this.editingId = null;
		this.notify();
		return [...this.selection];
	}

	/** Sets the options new blends get (spacing, steps, distance, orientation, morph). */
	setBlendDefaults(patch: Partial<VectorBlendOptions>): void {
		this.blendDefaults = { ...this.blendDefaults, ...blendOptionsOf(patch) };
		this.notify();
	}

	/**
	 * Adds a node as the last key of a blend (it must share the blend's parent); `start` is the
	 * anchor of its first subpath the blend starts from. One undo step.
	 */
	addBlendKey(blendId: string, nodeId: string, options: { start?: number | null } = {}): VectorActionResult {
		const group = this.getNode(blendId);
		const node = this.getNode(nodeId);
		if (!isVectorBlendGroup(group)) return { ok: false, message: `"${blendId}" is not a blend.` };
		if (!node || node.blendStep || node.locked || node.id === blendId) return { ok: false, message: `"${nodeId}" cannot be a key.` };
		const parentOf = (id: string) => locateVectorNode(this.doc.nodes, id)?.parent?.id ?? null;
		if (parentOf(blendId) !== parentOf(nodeId)) return { ok: false, message: 'The new key must sit beside the blend (same parent).' };
		const start = options.start;
		this.change('Blend', () => {
			const blend = start !== null && start !== undefined ? { ...group.blend, starts: { ...group.blend.starts, [nodeId]: start } } : group.blend;
			// The key leaves its place and joins the blend.
			const m = invertMatrix(nodeMatrix(group));
			const key = group.transform ? transformVectorNode(node, m) : node;
			// Two passes: the key must not be removed again from inside the blend.
			const without = mapTree(this.doc.nodes, (n) => (n.id === nodeId ? null : n));
			this.setDoc(spliceTree(without, blendId, [{ ...group, blend, children: [...group.children, key] }]));
			this.selection = [blendId];
			this.anchors = [];
		});
		return { ok: true };
	}

	/** Changes the spacing, steps, distance, orientation or morph of the selected (or given) blends. */
	setBlendOptions(patch: Partial<VectorBlendOptions>, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const groups = this.blendTargets(options.ids);
		if (!groups.length) return { ok: false, message: 'Select a blend.' };
		const clean = blendOptionsOf(patch);
		if (!Object.keys(clean).length) return { ok: false, message: 'No valid blend options were given.' };
		const set = new Set(groups.map((g) => g.id));
		this.change('Blend Options', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (set.has(n.id) && n.type === 'group' && n.blend ? { ...n, blend: { ...n.blend, ...clean } } : n)));
		});
		return { ok: true };
	}

	/** Expand: turns the selected (or given) blends into plain groups of their keys and steps. Returns their ids. */
	expandBlend(options: { ids?: readonly string[] } = {}): string[] {
		const groups = this.blendTargets(options.ids);
		if (!groups.length) return [];
		const set = new Set(groups.map((g) => g.id));
		const used = new Set<string>();
		walkVectorNodes(this.doc.nodes, (n) => used.add(n.id));
		const fresh = () => {
			let id = this.createId();
			while (used.has(id)) id = this.createId();
			used.add(id);
			return id;
		};
		this.change('Expand Blend', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (set.has(n.id) && n.type === 'group' ? expandVectorBlend(n, fresh) : n)));
			this.selection = [...set];
			this.anchors = [];
		});
		return [...set];
	}

	/** Release: replaces the selected (or given) blends with their keys (and a replaced spine as a path). */
	releaseBlend(options: { ids?: readonly string[] } = {}): string[] {
		const groups = this.blendTargets(options.ids);
		if (!groups.length) return [];
		const released: string[] = [];
		this.change('Release Blend', () => {
			for (const g of groups) {
				const nodes = releaseVectorBlend(g, () => this.newId());
				released.push(...nodes.map((n) => n.id));
				this.setDoc(spliceTree(this.doc.nodes, g.id, nodes));
			}
			this.selection = released;
			this.anchors = [];
		});
		return released;
	}

	/**
	 * Replace Spine: the selected blend's steps follow the selected path instead of the straight
	 * lines between its keys. The path's first subpath becomes the spine (the path is removed)
	 * and the keys move onto it, spread evenly by arc length.
	 */
	replaceBlendSpine(options: { ids?: readonly string[] } = {}): VectorActionResult {
		const roots = options.ids ?? this.selectedRoots();
		const groups = this.blendTargets(roots);
		const paths = roots.map((id) => this.getNode(id)).filter((n): n is VectorPathNode => n?.type === 'path' && !n.blendStep && !isVectorBlendGroup(locateVectorNode(this.doc.nodes, n.id)?.parent));
		if (groups.length !== 1 || paths.length !== 1) return { ok: false, message: 'Select one blend and one path to be its spine.' };
		const group = groups[0];
		const path = paths[0];
		const first = path.subpaths.find((sp) => sp.anchors.length >= 2);
		if (!first) return { ok: false, message: 'The spine needs a path with at least two points.' };
		// The path's first subpath in the blend group's own space.
		const m = multiplyMatrices(this.worldOf(path.id), invertMatrix(this.worldOf(group.id)));
		const spine = transformVectorNode<VectorPathNode>({ id: '', type: 'path', subpaths: [first] }, m).subpaths[0];
		this.change('Replace Spine', () => {
			const withSpine: VectorGroupNode = { ...group, blend: { ...group.blend, spine } };
			const targets = vectorBlendKeyTargets(withSpine);
			let k = 0;
			const children = withSpine.children.map((c) => {
				if (c.blendStep) return c;
				const target = targets[k++];
				const b = vectorNodeBounds(c);
				if (!target || !b) return c;
				const dx = target[0] - (b.x + b.width / 2);
				const dy = target[1] - (b.y + b.height / 2);
				return Math.hypot(dx, dy) > 1e-9 ? transformVectorNode(c, translateMatrix(dx, dy)) : c;
			});
			this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === path.id ? null : n.id === group.id ? { ...withSpine, children } : n)));
			this.selection = [group.id];
			this.anchors = [];
			if (this.editingId === path.id) this.editingId = null;
		});
		return { ok: true };
	}

	private shapeBuilderMap(ids?: readonly string[]): VectorShapeBuilderMap | null {
		const roots = ids ?? this.selectedRoots();
		const key = roots.join('\u0000');
		if (this.builderCache?.doc === this.doc && this.builderCache.key === key) return this.builderCache.map;
		// The Shape Builder edits the shapes it takes area from: their stored geometry.
		const entries = roots.length ? vectorPathEntries(this.doc, roots, { expand: false }) : [];
		const map = entries.length ? vectorShapeBuilderMap(entries) : null;
		this.builderCache = { doc: this.doc, key, map };
		return map;
	}

	/** The faces the Shape Builder offers for the selected (or given) paths (document units). */
	getShapeBuilderFaces(options: { ids?: readonly string[] } = {}): VectorShapeBuilderFace[] {
		const m = this.shapeBuilderMap(options.ids);
		if (!m) return [];
		return m.map.faces.map((f, index) => {
			const p = m.map.faceInterior(index);
			return {
				index,
				d: bezierPathToSvg(f.path, { precision: 3 }),
				area: f.area,
				sources: m.map.faceSources(index).map((i) => m.entries[i].node.id),
				point: p ? { x: p[0], y: p[1] } : null
			};
		});
	}

	/** Pick distance of the Shape Builder's erase for line pieces (document units). */
	private builderLineTolerance(): number {
		return Math.max(this.hitRadius, 4) / this.viewport.zoom;
	}

	/**
	 * Shape Builder gesture along `points` (document units; one point is a click) over the faces
	 * the selected (or given) paths make. Merges the faces touched into one shape styled like the
	 * top-most shape over the first face (the current fill for a face only outlines enclose);
	 * with `erase` deletes them, the pieces of unfilled open paths and the edges of other outlines
	 * (cut where paths meet) within `tolerance`: a deleted edge opens a closed subpath there,
	 * splits an open one or takes a subpath it runs all the way round, and edges bounding a face
	 * deleted in the same gesture go with the face. Every shape covering a touched face loses
	 * that area; paths keep their own transforms. One undo step.
	 */
	shapeBuilder(points: readonly Vec2[], options: { ids?: readonly string[]; erase?: boolean; tolerance?: number } = {}): VectorShapeBuilderResult {
		const none = (message: string): VectorShapeBuilderResult => ({ ok: false, message, merged: null, faces: 0, lines: 0, edges: 0 });
		if (!points.length || !points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return none('Give the points of the gesture.');
		const m = this.shapeBuilderMap(options.ids);
		if (!m) return none('Select paths that make faces.');
		const erase = !!options.erase;
		const tol = erase ? (options.tolerance ?? this.builderLineTolerance()) : null;
		const touched: VectorBuilderTouched = { faces: [], lines: [], edges: [] };
		const size = m.map.faces.reduce((s, f) => Math.max(s, f.bounds.maxX - f.bounds.minX, f.bounds.maxY - f.bounds.minY), 1);
		for (const p of samplePolyline(points, Math.max(size / 2000, 0.25 / this.viewport.zoom))) addBuilderHit(touched, vectorShapeBuilderHit(m, p, tol));
		if (!touched.faces.length && !touched.lines.length && !touched.edges.length) return none('There is no face under the pointer.');
		return this.applyShapeBuilder(m, touched, erase);
	}

	private applyShapeBuilder(m: VectorShapeBuilderMap, touched: VectorBuilderTouched, erase: boolean): VectorShapeBuilderResult {
		const plan = planShapeBuilder(m, touched, erase);
		let mergedId: string | null = null;
		const created = new Map<string, string[]>();
		this.change(erase ? 'Shape Builder Delete' : 'Shape Builder', () => {
			let nodes = this.doc.nodes;
			m.entries.forEach((entry, i) => {
				const node = entry.node;
				const toLocal = (path: BezierPath) => transformBezierPath(path, invertMatrix(multiplyMatrices(nodeMatrix(node), entry.parent)));
				const list: VectorNode[] = [];
				const r = plan.replace.get(i);
				if (r === undefined) list.push(node);
				else if (r?.kind === 'fill') list.push({ ...node, fillRule: 'nonzero', subpaths: bezierToSubpaths(toLocal(r.path)) });
				else if (r?.kind === 'outline') list.push({ ...node, subpaths: bezierToSubpaths(toLocal(r.path)) });
				else if (r?.kind === 'pieces') {
					r.paths.forEach((path, k) =>
						list.push({ ...node, id: k === 0 ? node.id : this.newId(), subpaths: bezierToSubpaths(toLocal(path)).map((sp) => ({ ...sp, closed: false })) })
					);
				}
				if (plan.merged && plan.merged.style === i) {
					mergedId = this.newId();
					const merged: VectorPathNode = {
						...vectorResultStyle(node, 'fill'),
						type: 'path',
						id: mergedId,
						name: 'Shape',
						...(node.transform ? { transform: node.transform } : {}),
						subpaths: bezierToSubpaths(toLocal(plan.merged.path))
					};
					if (plan.merged.currentFill || !hasPaint(merged.fill)) merged.fill = hasPaint(this.defaults.fill) ? this.defaults.fill! : '#808080';
					list.push(merged);
				}
				if (r === undefined && list.length === 1) return;
				created.set(node.id, list.map((n) => n.id));
				nodes = spliceTree(nodes, node.id, list);
			});
			this.setDoc(nodes);
			// The shapes stay selected so the next gesture works on them too.
			const selection = this.selection.flatMap((id) => created.get(id) ?? [id]);
			if (mergedId && !selection.includes(mergedId)) selection.push(mergedId);
			this.selection = selection.filter((id, k) => !!this.getNode(id) && selection.indexOf(id) === k);
			this.anchors = [];
			this.editingId = null;
		});
		this.builderCache = null;
		return { ok: true, merged: mergedId, faces: touched.faces.length, lines: touched.lines.length, edges: erase ? vectorBuilderErasedEdges(m, touched).length : 0 };
	}

	/** The paint bucket's map of the visible outlines, cached per document and gap. */
	private fillMap(gap: number): PlanarMap | null {
		if (this.fillCache?.doc === this.doc && this.fillCache.gap === gap) return this.fillCache.map;
		const map = vectorFillMap(this.doc, gap);
		this.fillCache = { doc: this.doc, gap, map };
		return map;
	}

	/**
	 * Paint bucket: the region the visible outlines enclose around `point` (document units),
	 * crossings split and islands left as holes, becomes a new path filled with the current fill
	 * default, placed just below the selection (or on top when nothing is selected). `gap`
	 * (default `editing.fillGap`) closes gaps up to that size between loose ends. Returns the new
	 * path's id, or null when nothing encloses the point.
	 */
	fillRegion(point: Vec2, options: { gap?: number } = {}): string | null {
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
		const region = this.fillMap(options.gap ?? this.editing.fillGap)?.regionAt([point.x, point.y]);
		if (!region?.length) return null;
		// Below the lowest selected node, in its parent.
		let below: string | null = null;
		const roots = new Set(this.selectedRoots());
		walkVectorNodes(this.doc.nodes, (n) => {
			if (!below && roots.has(n.id)) below = n.id;
		});
		const subpaths = bezierToSubpaths(below ? this.intoParentSpace(below, region) : region);
		if (!subpaths.length) return null;
		const id = this.newId();
		const node: VectorPathNode = { id, type: 'path', name: 'Fill', ...this.styleFor(false), stroke: null, fillRule: 'nonzero', subpaths };
		if (!hasPaint(node.fill)) node.fill = '#808080';
		const target = below as string | null;
		this.change('Fill Region', () => {
			if (target) {
				const current = this.getNode(target)!;
				this.setDoc(spliceTree(this.doc.nodes, target, [node, current]));
			} else this.setDoc([...this.doc.nodes, node]);
			if (!target) this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return id;
	}

	/** Updates the Shape Builder / paint bucket highlight for the pointer at `p`; true when it changed. */
	private hoverBuilder(p: Vec2, alt: boolean): boolean {
		if (this.tool === 'paintBucket') {
			const region = this.fillMap(this.editing.fillGap)?.regionAt([p.x, p.y]) ?? null;
			const key = region ? bezierPathToSvg(region, { precision: 2 }) : null;
			if (key === this.builderHoverKey) return false;
			this.builderHoverKey = key;
			this.builderPreview = region ? { mode: 'fill', faces: [region], lines: [], trail: null } : null;
			return true;
		}
		const m = this.selectedRoots().length ? this.shapeBuilderMap() : null;
		const hit = m ? vectorShapeBuilderHit(m, p, alt ? this.builderLineTolerance() : null) : null;
		const key = hit ? `${alt ? 'erase' : 'merge'}:${JSON.stringify(hit)}` : null;
		if (key === this.builderHoverKey) return false;
		this.builderHoverKey = key;
		const touched: VectorBuilderTouched = { faces: [], lines: [], edges: [] };
		addBuilderHit(touched, hit);
		this.builderPreview = hit && m ? this.builderPreviewOf(m, touched, alt, null) : null;
		return true;
	}

	private builderPreviewOf(m: VectorShapeBuilderMap, touched: VectorBuilderTouched, erase: boolean, trail: Vec2[] | null): VectorBuilderPreview {
		const faces = m.map.faces;
		return {
			mode: erase ? 'erase' : 'merge',
			faces: touched.faces.map((f) => faces[f].path),
			// Edges bounding a face touched too go with the face, so they are not shown apart.
			lines: [...touched.lines.map((k) => m.pieces[k].path), ...(erase ? vectorBuilderErasedEdges(m, touched).map((k) => m.edges[k].path) : [])],
			trail
		};
	}

	private downBuilder(p: Vec2, input: VectorPointerInput) {
		this.builderHoverKey = null;
		if (this.tool === 'paintBucket') {
			this.fillRegion(p);
			this.builderPreview = null;
			this.hoverBuilder(p, false);
			this.notify();
			return;
		}
		const m = this.selectedRoots().length ? this.shapeBuilderMap() : null;
		if (!m) return;
		const erase = !!input.alt;
		const touched: VectorBuilderTouched = { faces: [], lines: [], edges: [] };
		addBuilderHit(touched, vectorShapeBuilderHit(m, p, erase ? this.builderLineTolerance() : null));
		this.drag = { kind: 'builder', erase, points: [p], touched, map: m };
		this.interaction = { type: 'builder', mode: erase ? 'erase' : 'merge', points: [p] };
		this.builderPreview = this.builderPreviewOf(m, touched, erase, [p]);
		this.notify();
	}

	private moveBuilder(drag: Extract<Drag, { kind: 'builder' }>, p: Vec2) {
		const last = drag.points[drag.points.length - 1];
		if (Math.hypot(p.x - last.x, p.y - last.y) * this.viewport.zoom < 1) return;
		const tol = drag.erase ? this.builderLineTolerance() : null;
		for (const q of samplePolyline([last, p], 2 / this.viewport.zoom)) addBuilderHit(drag.touched, vectorShapeBuilderHit(drag.map, q, tol));
		drag.points.push(p);
		this.interaction = { type: 'builder', mode: drag.erase ? 'erase' : 'merge', points: drag.points.slice() };
		this.builderPreview = this.builderPreviewOf(drag.map, drag.touched, drag.erase, drag.points.slice());
		this.notify();
	}

	private upBuilder(drag: Extract<Drag, { kind: 'builder' }>) {
		this.builderPreview = null;
		this.builderHoverKey = null;
		if (!drag.touched.faces.length && !drag.touched.lines.length && !drag.touched.edges.length) {
			this.notify();
			return;
		}
		this.applyShapeBuilder(drag.map, drag.touched, drag.erase);
	}

	// -------------------------------------------------------------------------
	// Anchor editing
	// -------------------------------------------------------------------------

	private updateAnchors(doc: VectorDocument, refs: readonly VectorAnchorRef[], fn: (a: VectorAnchor, ref: VectorAnchorRef) => VectorAnchor): VectorDocument {
		const byNode = new Map<string, VectorAnchorRef[]>();
		for (const r of refs) byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r]);
		const nodes = mapTree(doc.nodes, (n) => {
			const list = byNode.get(n.id);
			if (!list || n.type !== 'path' || n.locked) return n;
			const subpaths = n.subpaths.map((sp, s) => {
				const hits = list.filter((r) => r.subpath === s);
				if (!hits.length) return sp;
				return { closed: sp.closed, anchors: sp.anchors.map((a, i) => (hits.some((r) => r.index === i) ? fn(a, { nodeId: n.id, subpath: s, index: i }) : a)) };
			});
			return { ...n, subpaths };
		});
		return nodes === doc.nodes ? doc : { ...doc, nodes };
	}

	/** Moves anchors by a document-space offset (converted into each node's own space). */
	private movedAnchors(doc: VectorDocument, refs: readonly VectorAnchorRef[], dx: number, dy: number): VectorDocument {
		const local = new Map<string, Vec2>();
		for (const r of refs) if (!local.has(r.nodeId)) local.set(r.nodeId, applyMatrixLinear(invertMatrix(this.worldOf(r.nodeId, doc)), { x: dx, y: dy }));
		return this.updateAnchors(doc, refs, (a, ref) => {
			const d = local.get(ref.nodeId)!;
			return translateAnchor(a, d.x, d.y);
		});
	}

	/**
	 * Moves one anchor to a document position. Its handles follow; with `curvature` (default:
	 * the `curvatureMoves` setting) its two segments bend instead, as the Curvature tool does.
	 */
	moveAnchor(ref: VectorAnchorRef, to: Vec2, options: { curvature?: boolean } = {}): VectorActionResult {
		const a = getAnchorWorld(this.doc, ref);
		if (!a) return { ok: false, message: 'There is no such anchor.' };
		const curvature = options.curvature ?? this.editing.curvatureMoves;
		this.change('Move Point', () => {
			this.doc = curvature ? this.curvatureMoved(this.doc, ref, to) : this.movedAnchors(this.doc, [ref], to.x - a.x, to.y - a.y);
		});
		return { ok: true };
	}

	/** `doc` with anchor `ref` moved to document point `to` by a Curvature-tool move. */
	private curvatureMoved(doc: VectorDocument, ref: VectorAnchorRef, to: Vec2): VectorDocument {
		const node = findVectorNode(doc.nodes, ref.nodeId);
		if (node?.type !== 'path' || node.locked || !node.subpaths[ref.subpath]) return doc;
		const q = this.toLocal(ref.nodeId, to, doc);
		const subpaths = node.subpaths.map((sp, i) => (i === ref.subpath ? curvatureMoveAnchor(sp, ref.index, q) : sp));
		const nodes = mapTree(doc.nodes, (n) => (n.id === ref.nodeId ? { ...node, subpaths } : n));
		return { ...doc, nodes };
	}

	/** `doc` with segment `ref` bent through document point `p` at parameter `t`. */
	private bent(doc: VectorDocument, ref: VectorSegmentRef, t: number, p: Vec2): VectorDocument {
		const node = findVectorNode(doc.nodes, ref.nodeId);
		if (node?.type !== 'path' || node.locked || !node.subpaths[ref.subpath]) return doc;
		const q = this.toLocal(ref.nodeId, p, doc);
		const subpaths = node.subpaths.map((sp, i) => (i === ref.subpath ? bendSubpathSegment(sp, ref.segment, t, q) : sp));
		return { ...doc, nodes: mapTree(doc.nodes, (n) => (n.id === ref.nodeId ? { ...node, subpaths } : n)) };
	}

	/**
	 * Bends a segment so the curve passes through document point `to` at parameter `t`
	 * (default 0.5, clamped to 0.05–0.95); see `bendSegment` in `pathEdit`.
	 */
	bendSegment(ref: VectorSegmentRef, to: Vec2, t = 0.5): VectorActionResult {
		const node = this.getNode(ref.nodeId);
		const sp = node?.type === 'path' ? node.subpaths[ref.subpath] : undefined;
		if (!sp || ref.segment < 0 || ref.segment >= (sp.closed ? sp.anchors.length : sp.anchors.length - 1) || sp.anchors.length < 2) return { ok: false, message: 'There is no such segment.' };
		if (node!.locked) return { ok: false, message: 'The path is locked.' };
		this.change('Bend Segment', () => {
			this.doc = this.bent(this.doc, ref, t, to);
		});
		return { ok: true };
	}

	/** Moves one handle to a document position (see `moveAnchorHandle` for how the opposite handle follows). */
	moveHandle(ref: VectorHandleRef, to: Vec2, options: { breakHandles?: boolean } = {}): VectorActionResult {
		if (!getAnchor(this.doc, ref)) return { ok: false, message: 'There is no such anchor.' };
		const local = this.toLocal(ref.nodeId, to);
		this.change('Move Handle', () => {
			this.doc = this.updateAnchors(this.doc, [ref], (a) => moveAnchorHandle(a, ref.handle, local, options.breakHandles));
		});
		return { ok: true };
	}

	/** Converts the selected (or given) anchors between corner, smooth and symmetric. */
	convertAnchors(type: VectorAnchorType, refs: readonly VectorAnchorRef[] = this.anchors): VectorActionResult {
		if (!refs.length) return { ok: false, message: 'Select points to convert.' };
		this.change(type === 'corner' ? 'Make Corner' : 'Make Smooth', () => {
			const nodes = mapTree(this.doc.nodes, (n) => {
				if (n.type !== 'path') return n;
				const mine = refs.filter((r) => r.nodeId === n.id);
				if (!mine.length) return n;
				const subpaths = n.subpaths.map((sp, s) => mine.filter((r) => r.subpath === s).reduce((acc, r) => convertAnchor(acc, r.index, type), sp));
				return { ...n, subpaths };
			});
			this.setDoc(nodes);
		});
		return { ok: true };
	}

	/** Adds an anchor on the nearest segment of `nodeId` to document point `point` (shape unchanged). */
	insertAnchorAt(nodeId: string, point: Vec2): VectorAnchorRef | null {
		const node = this.getNode(nodeId);
		if (node?.type !== 'path') return null;
		const hit = nearestSegment(node, this.toLocal(nodeId, point));
		if (!hit) return null;
		const { subpath, index } = insertAnchor(node.subpaths[hit.subpath], hit.segment, hit.t);
		const ref = { nodeId, subpath: hit.subpath, index };
		this.change('Add Point', () => {
			this.replaceNode(nodeId, { ...node, subpaths: node.subpaths.map((sp, i) => (i === hit.subpath ? subpath : sp)) });
			this.editingId = nodeId;
			this.anchors = [ref];
		});
		return ref;
	}

	/**
	 * Deletes the selected (or given) anchors; subpaths left with one anchor and empty paths go
	 * too. With `keepShape` (default: the `keepShapeOnDelete` setting, on) the neighbours'
	 * handles are refitted so the path keeps its shape; off, the neighbours are joined as they are.
	 */
	deleteAnchors(refs: readonly VectorAnchorRef[] = this.anchors, options: { keepShape?: boolean } = {}): VectorActionResult {
		if (!refs.length) return { ok: false, message: 'Select points to delete.' };
		const keepShape = options.keepShape ?? this.editing.keepShapeOnDelete;
		this.change('Delete Points', () => {
			const nodes = mapTree(this.doc.nodes, (n) => {
				if (n.type !== 'path' || n.locked) return n;
				const mine = refs.filter((r) => r.nodeId === n.id);
				if (!mine.length) return n;
				const subpaths = n.subpaths
					.map((sp, s) => {
						const indices = mine.filter((r) => r.subpath === s).map((r) => r.index);
						if (!indices.length) return sp;
						return keepShape ? removeAnchorsKeepingShape(sp, indices) : removeAnchors(sp, indices);
					})
					.filter((sp) => sp.anchors.length > 1);
				return subpaths.length ? { ...n, subpaths } : null;
			});
			this.setDoc(nodes);
			this.anchors = [];
			this.selection = this.selection.filter((id) => this.getNode(id));
			if (this.editingId && !this.getNode(this.editingId)) this.editingId = null;
			if (this.pen && !this.getNode(this.pen.nodeId)) this.pen = null;
		});
		return { ok: true };
	}

	/** Opens or closes the subpaths that contain selected anchors (or all subpaths of `nodeId`). */
	setClosed(closed: boolean, nodeId?: string): VectorActionResult {
		const targets = nodeId
			? (() => {
					const n = this.getNode(nodeId);
					return n?.type === 'path' ? n.subpaths.map((_, s) => ({ nodeId, subpath: s })) : [];
				})()
			: this.anchors.map((r) => ({ nodeId: r.nodeId, subpath: r.subpath }));
		if (!targets.length) return { ok: false, message: 'Select a path or points.' };
		this.change(closed ? 'Close Path' : 'Open Path', () => {
			this.setDoc(
				mapTree(this.doc.nodes, (n) =>
					n.type === 'path' && targets.some((t) => t.nodeId === n.id)
						? { ...n, subpaths: n.subpaths.map((sp, s) => (targets.some((t) => t.nodeId === n.id && t.subpath === s) ? { ...sp, closed } : sp)) }
						: n
				)
			);
		});
		return { ok: true };
	}

	/** Reverses the direction of every subpath of the selected paths. */
	reversePaths(ids: readonly string[] = this.selection): VectorActionResult {
		const set = new Set(ids.flatMap((id) => (this.getNode(id) ? collectPathNodes(this.getNode(id)!) : [])).map((p) => p.id));
		if (!set.size) return { ok: false, message: 'Select a path.' };
		this.change('Reverse Path', () => {
			this.setDoc(
				mapTree(this.doc.nodes, (n) =>
					n.type === 'path' && set.has(n.id)
						? { ...n, subpaths: n.subpaths.map(reverseSubpath), ...(n.strokeWidthProfile?.length ? { strokeWidthProfile: reverseWidthProfile(n.strokeWidthProfile) } : {}) }
						: n
				)
			);
			this.anchors = [];
		});
		return { ok: true };
	}

	// -------------------------------------------------------------------------
	// Path clean-up, Scissors, Knife and Eraser
	// -------------------------------------------------------------------------

	/** Unlocked path nodes in the given roots (default: the paths being edited, else the selection). */
	private pathTargets(ids?: readonly string[]): VectorPathNode[] {
		const roots = ids ?? (this.tool === 'direct' && this.anchors.length ? [...new Set(this.anchors.map((r) => r.nodeId))] : this.selection);
		const out = new Map<string, VectorPathNode>();
		for (const id of roots) {
			const node = this.getNode(id);
			if (node && !node.locked) for (const p of collectPathNodes(node)) if (!p.locked) out.set(p.id, p);
		}
		// Document order, bottom to top.
		const order: string[] = [];
		walkVectorNodes(this.doc.nodes, (n) => {
			if (out.has(n.id)) order.push(n.id);
		});
		return order.map((id) => out.get(id)!);
	}

	/** Subpaths of node `from` mapped into node `to`'s own space. */
	private subpathsIn(from: VectorPathNode, to: string): VectorSubpath[] {
		const m = multiplyMatrices(this.worldOf(from.id), invertMatrix(this.worldOf(to)));
		if (isRoot(m)) return from.subpaths;
		const map = (p: Vec2) => applyMatrix(m, p);
		return from.subpaths.map((sp) => ({
			closed: sp.closed,
			anchors: sp.anchors.map((a) => ({ ...map(a), ...(a.in ? { in: map(a.in) } : {}), ...(a.out ? { out: map(a.out) } : {}), ...(a.type ? { type: a.type } : {}), ...(a.corner ? { corner: { ...a.corner } } : {}), ...(a.id ? { id: a.id } : {}) }))
		}));
	}

	/**
	 * Replaces a path with pieces: each entry becomes one path (the first keeps the node's id and
	 * place, the others go just above it with the same style). No pieces removes the path.
	 * Returns the ids of the paths now standing in for it.
	 */
	private replaceWithPieces(node: VectorPathNode, pieces: readonly VectorSubpath[][]): string[] {
		const nodes = pieces.filter((p) => p.length).map((subpaths, i) => ({ ...node, id: i === 0 ? node.id : this.newId(), subpaths }) as VectorPathNode);
		this.setDoc(spliceTree(this.doc.nodes, node.id, nodes));
		return nodes.map((n) => n.id);
	}

	/** Clears anchor selections, editing and pen state that no longer point at anything. */
	private dropStaleRefs() {
		this.selection = this.selection.filter((id) => this.getNode(id));
		this.anchors = this.anchors.filter((r) => getAnchor(this.doc, r));
		if (this.editingId && !this.getNode(this.editingId)) this.editingId = null;
		if (this.pen && !this.getNode(this.pen.nodeId)) this.pen = null;
	}

	/**
	 * Join: the open subpaths of the selected (or given) paths become one open path, joined
	 * nearest endpoints first (ends within `tolerance` document units merge into one anchor,
	 * others get a straight segment); a single open subpath is closed. The result replaces the
	 * lowest path, in its space and style. Default tolerance: the pick distance.
	 */
	joinPaths(options: { ids?: readonly string[]; tolerance?: number } = {}): VectorActionResult {
		const paths = this.pathTargets(options.ids);
		if (!paths.length) return { ok: false, message: 'Select paths to join.' };
		const base = paths[0];
		const all = paths.flatMap((p) => this.subpathsIn(p, base.id));
		if (!all.some((sp) => !sp.closed && sp.anchors.length > 1)) return { ok: false, message: 'There are no open paths to join.' };
		const subpaths = joinSubpaths(all, options.tolerance ?? this.tolerance());
		const drop = new Set(paths.slice(1).map((p) => p.id));
		this.change('Join', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === base.id ? { ...base, subpaths } : drop.has(n.id) ? null : n)));
			this.selection = [base.id];
			this.anchors = [];
			if (this.editingId && drop.has(this.editingId)) this.editingId = base.id;
			this.dropStaleRefs();
		});
		return { ok: true };
	}

	/** Average: moves the selected (or given) anchors onto their average position along `axis`, in document space. */
	averageAnchors(axis: VectorAverageAxis = 'both', refs: readonly VectorAnchorRef[] = this.anchors): VectorActionResult {
		const points = refs.map((r) => ({ ref: r, at: getAnchorWorld(this.doc, r) })).filter((p): p is { ref: VectorAnchorRef; at: NonNullable<ReturnType<typeof getAnchorWorld>> } => !!p.at);
		if (points.length < 2) return { ok: false, message: 'Select at least two points to average.' };
		const cx = points.reduce((s, p) => s + p.at.x, 0) / points.length;
		const cy = points.reduce((s, p) => s + p.at.y, 0) / points.length;
		this.change('Average', () => {
			for (const { ref, at } of points) {
				const dx = axis === 'horizontal' ? 0 : cx - at.x;
				const dy = axis === 'vertical' ? 0 : cy - at.y;
				if (dx || dy) this.doc = this.movedAnchors(this.doc, [ref], dx, dy);
			}
		});
		return { ok: true };
	}

	/** Applies `fn` to every subpath of the target paths as one undo step. */
	private editSubpaths(label: string, ids: readonly string[] | undefined, fn: (sp: VectorSubpath, node: VectorPathNode, index: number) => VectorSubpath): VectorActionResult {
		const paths = this.pathTargets(ids);
		if (!paths.length) return { ok: false, message: 'Select a path.' };
		const set = new Set(paths.map((p) => p.id));
		this.change(label, () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (n.type === 'path' && set.has(n.id) ? { ...n, subpaths: n.subpaths.map((sp, i) => fn(sp, n, i)) } : n)));
			this.dropStaleRefs();
		});
		return { ok: true };
	}

	/**
	 * Remove Redundant Points: drops anchors of the selected (or given) paths that can go
	 * without moving the outline more than `tolerance` document units (default 0.5).
	 */
	removeRedundantPoints(options: { ids?: readonly string[]; tolerance?: number } = {}): VectorActionResult {
		const tolerance = options.tolerance ?? 0.5;
		return this.editSubpaths('Remove Redundant Points', options.ids, (sp) => removeRedundantSubpathPoints(sp, tolerance));
	}

	/**
	 * Smooth: pulls handles towards smooth tangents by `amount` (0–1, default 1). With the direct
	 * tool and points selected, only those points change.
	 */
	smoothPaths(options: { ids?: readonly string[]; amount?: number; refs?: readonly VectorAnchorRef[] } = {}): VectorActionResult {
		const refs = options.refs ?? (!options.ids && this.tool === 'direct' && this.anchors.length ? this.anchors : null);
		const ids = options.ids ?? (refs ? [...new Set(refs.map((r) => r.nodeId))] : undefined);
		return this.editSubpaths('Smooth', ids, (sp, node, i) => {
			const only = refs ? new Set(refs.filter((r) => r.nodeId === node.id && r.subpath === i).map((r) => r.index)) : undefined;
			return only && !only.size ? sp : smoothSubpath(sp, options.amount ?? 1, only);
		});
	}

	/** Splits a cut subpath into pieces: separate paths for a one-subpath node, subpaths in place for a compound one. */
	private applyCuts(node: VectorPathNode, cut: (sp: VectorSubpath, index: number) => VectorSubpath[] | null): string[] | null {
		const results = node.subpaths.map((sp, i) => cut(sp, i));
		if (results.every((r) => !r)) return null;
		const subpaths = node.subpaths.flatMap((sp, i) => results[i] ?? [sp]);
		if (node.subpaths.length === 1) return this.replaceWithPieces(node, subpaths.map((sp) => [sp]));
		this.replaceNode(node.id, { ...node, subpaths });
		return [node.id];
	}

	/**
	 * Scissors: cuts path `nodeId` at the outline point nearest document point `point` (at an
	 * anchor when within the pick distance of one). A closed subpath opens there; an open one
	 * splits in two (a one-subpath path becomes two paths). Returns the ids of the paths.
	 */
	cutPathAt(nodeId: string, point: Vec2): string[] | null {
		const node = this.getNode(nodeId);
		if (node?.type !== 'path' || node.locked) return null;
		const local = this.toLocal(nodeId, point);
		const hit = nearestSegment(node, local);
		if (!hit) return null;
		const sp = node.subpaths[hit.subpath];
		const n = sp.anchors.length;
		const near = [hit.segment, (hit.segment + 1) % n].find((i) => Math.hypot(sp.anchors[i].x - hit.point.x, sp.anchors[i].y - hit.point.y) <= this.tolerance());
		if (!sp.closed && n > 1 && (near === 0 || near === n - 1) && !(hit.t > 1e-6 && hit.t < 1 - 1e-6)) return null;
		let ids: string[] | null = null;
		this.change('Cut Path', () => {
			ids = this.applyCuts(node, (s, i) => (i !== hit.subpath ? null : near !== undefined ? cutSubpathAt(s, [near]) : splitSubpathAt(s, hit.segment, hit.t)));
			if (ids) {
				this.selection = ids;
				this.anchors = [];
				if (this.editingId === nodeId) this.editingId = null;
			}
			this.dropStaleRefs();
		});
		return ids;
	}

	/** Scissors on the selected (or given) anchors: each cuts its subpath there (see `cutPathAt`). */
	cutAtAnchors(refs: readonly VectorAnchorRef[] = this.anchors): VectorActionResult {
		const byNode = new Map<string, VectorAnchorRef[]>();
		for (const r of refs) if (getAnchor(this.doc, r)) byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r]);
		if (!byNode.size) return { ok: false, message: 'Select points to cut at.' };
		const created: string[] = [];
		this.change('Cut Path', () => {
			for (const [id, list] of byNode) {
				const node = this.getNode(id) as VectorPathNode;
				if (node.locked) continue;
				const ids = this.applyCuts(node, (sp, i) => {
					const at = list.filter((r) => r.subpath === i).map((r) => r.index);
					const pieces = at.length ? cutSubpathAt(sp, at) : null;
					return pieces && !(pieces.length === 1 && pieces[0].closed === sp.closed) ? pieces : null;
				});
				if (ids) created.push(...ids);
			}
			if (created.length) this.selection = created;
			this.anchors = [];
			this.dropStaleRefs();
		});
		return created.length ? { ok: true } : { ok: false, message: 'Points at the ends of open paths do not cut.' };
	}

	/** Visible, unlocked paths a stroke over `points` can reach: in `ids`, the selection, or (with neither) any whose bounds it crosses. */
	private strokeTargets(points: readonly Vec2[], ids: readonly string[] | undefined, pad: number): VectorPathNode[] {
		const blocked = new Set<string>();
		walkVectorNodes(this.doc.nodes, (n, parent) => {
			if (n.visible === false || n.locked || (parent && blocked.has(parent.id))) blocked.add(n.id);
		});
		const visible = (p: VectorPathNode) => !blocked.has(p.id);
		if (ids?.length || this.selection.length) return this.pathTargets(ids ?? this.selection).filter(visible);
		const box = polylineBounds(points.map(toPoint), pad);
		if (!box) return [];
		const out: VectorPathNode[] = [];
		walkVectorNodes(this.doc.nodes, (n) => {
			if (n.type !== 'path' || !visible(n)) return;
			const b = vectorNodeBounds(n, vectorParentMatrix(this.doc.nodes, n.id) ?? IDENTITY_MATRIX);
			if (b && boundsIntersect(b, box)) out.push(n);
		});
		return out;
	}

	/** A stroke's points in node `id`'s own space. */
	private localPoints(id: string, points: readonly Vec2[]): Point[] {
		const inv = invertMatrix(this.worldOf(id));
		return points.map((p) => toPoint(applyMatrix(inv, p)));
	}

	/**
	 * Knife: cuts closed paths along the polyline `points` (document space) wherever it crosses
	 * them from edge to edge, with no gap between the pieces. It cuts the given paths, the
	 * selection, or (with neither) every path it crosses. Returns the ids of the pieces (empty
	 * when nothing was cut).
	 */
	knife(points: readonly Vec2[], options: { ids?: readonly string[] } = {}): string[] {
		const pts = simplifyPolyline(points.map(toPoint), 0.25 / this.viewport.zoom).map(([x, y]) => ({ x, y }));
		if (pts.length < 2) return [];
		const plan: { node: VectorPathNode; pieces: VectorSubpath[][] }[] = [];
		for (const node of this.strokeTargets(pts, options.ids, 0)) {
			const closed = node.subpaths.filter((sp) => sp.anchors.length > 1);
			if (!closed.length || closed.some((sp) => !sp.closed)) continue;
			const result = knifePath(subpathsToBezier(closed), node.fillRule ?? 'nonzero', this.localPoints(node.id, pts));
			if (result) plan.push({ node, pieces: result.map((path) => bezierToSubpaths(path)) });
		}
		if (!plan.length) return [];
		const created: string[] = [];
		this.change('Knife', () => {
			for (const { node, pieces } of plan) created.push(...this.replaceWithPieces(node, pieces));
			this.selection = created;
			this.anchors = [];
			this.dropStaleRefs();
		});
		return created;
	}

	/**
	 * Eraser: rubs out a round stroke of diameter `size` (default: the `eraserSize` setting)
	 * along `points` (document space). Filled closed paths lose that area (pieces that come
	 * apart become separate paths); outlines are cut where they pass under it. It erases from
	 * the given paths, the selection, or (with neither) every path it reaches. Returns the ids
	 * of the paths it changed or created.
	 */
	erase(points: readonly Vec2[], options: { ids?: readonly string[]; size?: number } = {}): string[] {
		const width = options.size ?? this.editing.eraserSize;
		if (!(width > 0) || !points.length) return [];
		const pts = simplifyPolyline(points.map(toPoint), Math.min(width * 0.05, 0.25 / this.viewport.zoom));
		const region = eraserRegion(pts, width);
		if (!region.length) return [];
		const plan: { node: VectorPathNode; pieces: VectorSubpath[][] }[] = [];
		const rb = bezierPathBounds(region);
		const reach = rb ? [{ x: rb.minX, y: rb.minY }, { x: rb.maxX, y: rb.maxY }] : points;
		for (const node of this.strokeTargets(reach, options.ids, 0)) {
			const local = transformBezierPath(region, invertMatrix(this.worldOf(node.id)));
			const live = node.subpaths.filter((sp) => sp.anchors.length > 1);
			if (!live.length) continue;
			if (hasPaint(node.fill) && live.every((sp) => sp.closed)) {
				const faces = eraseFromFill(subpathsToBezier(live), node.fillRule ?? 'nonzero', local);
				if (faces) plan.push({ node, pieces: faces.map((f) => bezierToSubpaths(f)) });
				continue;
			}
			const results = live.map((sp) => eraseFromOutline(sp, local));
			if (results.every((r) => !r)) continue;
			const subpaths = live.flatMap((sp, i) => results[i] ?? [sp]);
			plan.push({ node, pieces: live.length === 1 ? subpaths.map((sp) => [sp]) : [subpaths] });
		}
		if (!plan.length) return [];
		const changed: string[] = [];
		this.change('Erase', () => {
			for (const { node, pieces } of plan) changed.push(...this.replaceWithPieces(node, pieces));
			this.anchors = [];
			this.dropStaleRefs();
			if (this.selection.length || options.ids) this.selection = [...new Set([...this.selection, ...changed.filter((id) => this.getNode(id))])];
		});
		return changed;
	}

	/** Ends the pen path being drawn (a lone anchor is removed). */
	finishPath(): void {
		if (!this.pen) return;
		const node = this.getNode(this.pen.nodeId) as VectorPathNode | undefined;
		const sp = node?.subpaths[this.pen.subpath];
		const pen = this.pen;
		this.pen = null;
		this.pointer = null;
		if (node && sp && sp.anchors.length < 2) {
			const subpaths = node.subpaths.filter((_, i) => i !== pen.subpath);
			this.change('Delete Path', () => {
				this.replaceNode(node.id, subpaths.length ? { ...node, subpaths } : null);
				if (!subpaths.length) {
					this.selection = this.selection.filter((id) => id !== node.id);
					if (this.editingId === node.id) this.editingId = null;
				}
				this.anchors = [];
			});
			return;
		}
		this.notify();
	}

	// -------------------------------------------------------------------------
	// Clipboard
	// -------------------------------------------------------------------------

	/** Copies the selection. Returns JSON text for the system clipboard (or null). */
	copy(): string | null {
		const nodes = this.selectedRoots()
			.map((id) => this.getNode(id))
			.filter((n): n is VectorNode => !!n)
			.map((n) => cloneVectorNode(n));
		if (!nodes.length) return null;
		this.clipboard = nodes;
		return JSON.stringify({ type: VECTOR_CLIPBOARD_TYPE, nodes });
	}

	cut(): string | null {
		const text = this.copy();
		if (text) this.removeNodes(this.selectedRoots(), { label: 'Cut' });
		return text;
	}

	/**
	 * Pastes `text` (from `copy()`, or SVG markup) or the internal clipboard, offset by 10, 10.
	 * Returns the new ids.
	 */
	paste(text?: string, options: { offset?: Vec2 } = {}): string[] {
		let nodes: VectorNode[] | null = null;
		if (text) {
			const trimmed = text.trim();
			if (trimmed.startsWith('{')) {
				try {
					const data = JSON.parse(trimmed);
					if (data?.type === VECTOR_CLIPBOARD_TYPE && Array.isArray(data.nodes)) nodes = data.nodes;
				} catch {
					nodes = null;
				}
			} else if (/<svg[\s>]/i.test(trimmed)) {
				try {
					nodes = parseVectorSvg(trimmed).nodes;
				} catch {
					nodes = null;
				}
			}
		} else nodes = this.clipboard;
		if (!nodes?.length) return [];
		const offset = options.offset ?? (text && !text.trim().startsWith('{') ? { x: 0, y: 0 } : { x: 10, y: 10 });
		const copies = nodes.map((n) => transformVectorNode(this.freshIds(n), translateMatrix(offset.x, offset.y)));
		this.change('Paste', () => {
			this.setDoc([...this.doc.nodes, ...copies]);
			this.selection = copies.map((n) => n.id);
			this.anchors = [];
		});
		if (!text) this.clipboard = copies.map((n) => cloneVectorNode(n));
		return copies.map((n) => n.id);
	}

	// -------------------------------------------------------------------------
	// Undo
	// -------------------------------------------------------------------------

	undo(): boolean {
		this.cancelDrag();
		this.pen = null;
		return this.history.undo();
	}

	redo(): boolean {
		this.cancelDrag();
		return this.history.redo();
	}

	/** Deletes selected anchors (direct tool) or nodes. */
	deleteSelection(): VectorActionResult {
		if (this.tool === 'direct' && this.anchors.length) return this.deleteAnchors();
		return this.removeNodes(this.selectedRoots());
	}

	// -------------------------------------------------------------------------
	// Pointer input
	// -------------------------------------------------------------------------

	/** The fields the anchor / handle helpers read, without building a full state. */
	private view() {
		return { document: this.doc, selection: this.selection, editingId: this.editingId, tool: this.tool, pen: this.pen, selectedAnchors: this.anchors };
	}

	private tolerance() {
		return this.hitRadius / this.viewport.zoom;
	}

	private hitTransformHandle(screen: Vec2): VectorTransformHandle | null {
		if (this.tool !== 'select' || !this.selection.length) return null;
		const frame = this.frameOf(this.selectedRoots());
		if (!frame) return null;
		const { box, handles } = getVectorSelectionBoxGeometry(frame, this.viewport);
		const r = this.hitRadius + 2;
		// Tiny boxes: only corners and rotation, so the box can still be grabbed.
		const usable = box.width < 2 * r || box.height < 2 * r ? handles.filter((h) => h.handle.length === 2 || h.handle === 'rotate') : handles;
		for (const h of usable) if (Math.hypot(h.screen.x - screen.x, h.screen.y - screen.y) <= r * Math.SQRT2) return h.handle;
		return null;
	}

	private hitHandle(screen: Vec2): VectorHandleRef | null {
		for (const ref of getVisibleHandles(this.view()).reverse()) {
			const a = getAnchorWorld(this.doc, ref);
			const h = a?.[ref.handle];
			if (!h) continue;
			const s = this.documentToScreen(h);
			if (Math.hypot(s.x - screen.x, s.y - screen.y) <= this.hitRadius) return ref;
		}
		return null;
	}

	private cornerView() {
		return { ...this.view(), viewport: this.viewport };
	}

	private hitCornerWidget(screen: Vec2): VectorCornerWidget | null {
		let best: VectorCornerWidget | null = null;
		let bestD = Infinity;
		for (const w of getVectorCornerWidgets(this.cornerView())) {
			const s = this.documentToScreen(w);
			const d = Math.hypot(s.x - screen.x, s.y - screen.y);
			if (d <= this.hitRadius && d < bestD) {
				best = w;
				bestD = d;
			}
		}
		return best;
	}

	private hitAnchor(screen: Vec2, refs: readonly VectorAnchorRef[]): VectorAnchorRef | null {
		let best: VectorAnchorRef | null = null;
		let bestD = Infinity;
		for (const ref of refs) {
			const a = getAnchorWorld(this.doc, ref);
			if (!a) continue;
			const s = this.documentToScreen(a);
			const d = Math.hypot(s.x - screen.x, s.y - screen.y);
			if (d <= this.hitRadius && d < bestD) {
				best = ref;
				bestD = d;
			}
		}
		return best;
	}

	/** Deepest unlocked visible path under `p`. */
	/** Live groups being edited (selected, or holding the selection or the edited path): their children are hit as stored. */
	private enteredGroups(): Set<string> {
		return vectorEnteredGroups(this.doc.nodes, this.editingId ? [...this.selection, this.editingId] : this.selection);
	}

	private hitPath(p: Vec2): VectorPathNode | null {
		const tol = this.tolerance();
		const entered = this.enteredGroups();
		const search = (list: readonly VectorNode[], parent: AffineMatrix): VectorPathNode | null => {
			for (let i = list.length - 1; i >= 0; i--) {
				const n = list[i];
				if (n.visible === false || n.locked) continue;
				if (n.type === 'group') {
					// A live group not being edited is hit where it draws (a click in a subtracted
					// hole goes through), then picks the child under the pointer.
					// A mask group likewise, where its mask lets the contents through.
					if ((hasOwnVectorAppearance(n) || isVectorMaskActive(n)) && !entered.has(n.id) && !hitTestVectorNode(n, p, tol, parent, { entered })) continue;
					const found = search(n.children, multiplyMatrices(nodeMatrix(n), parent));
					if (found) return found;
				} else if (n.type === 'path' && hitTestVectorNode(n, p, tol, parent, { entered })) return n;
			}
			return null;
		};
		return search(this.doc.nodes, IDENTITY_MATRIX);
	}

	/** Endpoints of open subpaths of unlocked visible paths (pen tool resumes from them). */
	private openEndpoints(): VectorAnchorRef[] {
		const out: VectorAnchorRef[] = [];
		walkVectorNodes(this.doc.nodes, (n) => {
			if (n.type !== 'path' || n.locked || n.visible === false) return;
			n.subpaths.forEach((sp, s) => {
				if (sp.closed || sp.anchors.length < 1) return;
				out.push({ nodeId: n.id, subpath: s, index: 0 });
				if (sp.anchors.length > 1) out.push({ nodeId: n.id, subpath: s, index: sp.anchors.length - 1 });
			});
		});
		return out;
	}

	private computeHover(screen: Vec2): VectorHover | null {
		const p = this.screenToDocument(screen);
		switch (this.tool) {
			case 'select': {
				const handle = this.hitTransformHandle(screen);
				if (handle) return { nodeId: null, transformHandle: handle };
				const node = hitTestVectorNodes(this.doc.nodes, p, this.tolerance(), { entered: this.enteredGroups() });
				return node ? { nodeId: node.id } : null;
			}
			case 'direct': {
				const handle = this.hitHandle(screen);
				if (handle) return { nodeId: handle.nodeId, handle };
				const anchor = this.hitAnchor(screen, getVisibleAnchors(this.view()));
				if (anchor) return { nodeId: anchor.nodeId, anchor };
				const widget = this.hitCornerWidget(screen);
				if (widget) return { nodeId: widget.ref.nodeId, corner: widget.ref };
				for (const id of getEditablePathIds(this.view())) {
					const node = this.getNode(id) as VectorPathNode;
					const seg = nearestSegment(node, this.toLocal(id, p));
					if (seg && seg.distance <= this.tolerance()) {
						const point = applyMatrix(this.worldOf(id), seg.point);
						return { nodeId: id, segment: { nodeId: id, subpath: seg.subpath, segment: seg.segment, t: seg.t, point } };
					}
				}
				const path = this.hitPath(p);
				return path ? { nodeId: path.id } : null;
			}
			case 'pen': {
				const refs = this.pen ? [{ nodeId: this.pen.nodeId, subpath: this.pen.subpath, index: 0 }] : this.openEndpoints();
				const anchor = this.hitAnchor(screen, refs);
				return anchor ? { nodeId: anchor.nodeId, anchor } : null;
			}
			case 'scissors': {
				const seg = this.nearestOutline(p);
				return seg ? { nodeId: seg.nodeId, segment: seg } : null;
			}
			case 'blend': {
				const hit = this.blendHit(screen, p);
				if (!hit) return null;
				return hit.anchor === null ? { nodeId: hit.nodeId } : { nodeId: hit.nodeId, anchor: { nodeId: hit.nodeId, subpath: 0, index: hit.anchor } };
			}
			case 'width': {
				const hit = this.hitWidthHandle(screen);
				if (hit) return { nodeId: hit.ref.nodeId, widthPoint: hit.ref };
				const spot = this.strokeSpotAt(p);
				return spot ? { nodeId: spot.nodeId, strokeSpot: spot } : null;
			}
			case 'gradient': {
				const a = this.getGradientAnnotator();
				const part = a ? hitVectorGradientAnnotator(a, screen) : null;
				if (a && part) return { nodeId: a.nodeId, gradient: part };
				const path = this.hitPath(p);
				return path ? { nodeId: path.id } : null;
			}
			case 'type': {
				const hit = this.hitText(p);
				return hit ? { nodeId: hit.id } : null;
			}
			case 'typePath': {
				const hit = this.hitText(p) ?? this.hitPath(p);
				return hit ? { nodeId: hit.id } : null;
			}
			case 'envelope': {
				const hit = this.hitEnvelope(screen, p);
				if (hit) return { nodeId: hit.target.node.id, envelope: { nodeId: hit.target.node.id, index: hit.index } };
				const node = hitTestVectorNodes(this.doc.nodes, p, this.tolerance(), { entered: this.enteredGroups() });
				return node ? { nodeId: node.id } : null;
			}
			default:
				return null;
		}
	}

	private widthView(): Pick<VectorEditorState, 'document' | 'selection' | 'tool' | 'hover' | 'interaction' | 'selectedWidthPoints'> {
		return { document: this.doc, selection: this.selection, tool: this.tool, hover: this.hover, interaction: this.interaction, selectedWidthPoints: this.widthPoints };
	}

	/** The width point centre or side end under `screen` (width tool). */
	private hitWidthHandle(screen: Vec2): { ref: VectorWidthPointRef & { part: 'center' | 'left' | 'right' } } | null {
		const shown = this.hitWidthHandleIn(screen, this.widthView());
		if (shown) return shown;
		// The points of the stroke under the pointer, when no hover has shown them yet.
		const spot = this.strokeSpotAt(this.screenToDocument(screen));
		return spot && spot.nodeId !== this.hover?.nodeId ? this.hitWidthHandleIn(screen, { ...this.widthView(), hover: { nodeId: spot.nodeId } }) : null;
	}

	private hitWidthHandleIn(screen: Vec2, view: Pick<VectorEditorState, 'document' | 'selection' | 'tool' | 'hover' | 'interaction' | 'selectedWidthPoints'>): { ref: VectorWidthPointRef & { part: 'center' | 'left' | 'right' } } | null {
		let best: { ref: VectorWidthPointRef & { part: 'center' | 'left' | 'right' } } | null = null;
		let bestD = Infinity;
		for (const h of getVectorWidthHandles(view)) {
			for (const [part, q] of [['center', h], ['left', h.left], ['right', h.right]] as const) {
				const s = this.documentToScreen(q);
				const d = Math.hypot(s.x - screen.x, s.y - screen.y);
				// Ties go to the centre (listed first), so a zero-width point can still be moved.
				if (d <= this.hitRadius && d < bestD - 1e-9) {
					best = { ref: { ...h.ref, part } };
					bestD = d;
				}
			}
		}
		return best;
	}

	/** The nearest stroked, unlocked visible path whose stroke is under document point `p` (width tool). */
	private strokeSpotAt(p: Vec2): VectorStrokeSpot | null {
		let best: (VectorStrokeSpot & { distance: number }) | null = null;
		const tol = this.tolerance();
		walkVectorNodes(this.doc.nodes, (n) => {
			if (n.type !== 'path' || n.visible === false || n.locked) return;
			if (hiddenOrLocked(this.doc.nodes, n.id)) return;
			const g = vectorStrokeWidthGeometry(n);
			if (!g) return;
			const m = this.worldOf(n.id);
			const local = applyMatrix(invertMatrix(m), p);
			const near = nearestStrokePosition(g.line, [local.x, local.y]);
			if (!near) return;
			const profile = strokeWidthProfileOf(n);
			const w = widthProfileAt(profile, near.t);
			const reach = Math.max(near.side === 'left' ? w.left : w.right, 0) * g.unit + tol;
			if (near.distance > reach || near.distance > widthProfileMaxScale(profile) * g.unit + tol) return;
			if (best && near.distance >= best.distance) return;
			const nx = near.tangent[1];
			const ny = -near.tangent[0];
			const [cx, cy] = near.point;
			best = {
				nodeId: n.id,
				subpath: near.contour,
				t: near.t,
				point: applyMatrix(m, { x: cx, y: cy }),
				left: applyMatrix(m, { x: cx + nx * w.left * g.unit, y: cy + ny * w.left * g.unit }),
				right: applyMatrix(m, { x: cx - nx * w.right * g.unit, y: cy - ny * w.right * g.unit }),
				distance: near.distance
			};
		});
		if (!best) return null;
		const { distance: _d, ...spot } = best as VectorStrokeSpot & { distance: number };
		return spot;
	}

	private downWidth(screen: Vec2, p: Vec2, input: VectorPointerInput) {
		const hit = this.hitWidthHandle(screen);
		const spot = hit ? null : this.strokeSpotAt(p);
		const nodeId = hit?.ref.nodeId ?? spot?.nodeId;
		const node = nodeId ? this.getNode(nodeId) : undefined;
		const g = node?.type === 'path' ? vectorStrokeWidthGeometry(node) : null;
		if (this.widthEdit) this.widthEdit = null;
		if (!node || node.type !== 'path' || !g) {
			// A click away from strokes deselects (Shift keeps the selection).
			if (!input.shift) this.widthPoints = [];
			this.notify();
			return;
		}
		const before = this.snapshot();
		const local = this.toLocal(node.id, p);
		let profile: VectorWidthPoint[];
		let ref: VectorWidthPointRef;
		let mode: 'width' | 'move' | 'copy' = 'width';
		let side: 'both' | 'left' | 'right' = 'both';
		let group: number[] = [];
		let shift = false;
		let t: number;
		let subpath: number;
		if (hit) {
			profile = sanitizeWidthProfile(node.strokeWidthProfile);
			ref = { nodeId: node.id, index: hit.ref.index, subpath: hit.ref.subpath };
			t = profile[ref.index]?.t ?? 0;
			subpath = hit.ref.subpath;
			if (hit.ref.part === 'center') mode = input.alt && profile.length < VECTOR_WIDTH_PROFILE_MAX_POINTS ? 'copy' : 'move';
			else if (input.alt) side = hit.ref.part;
			const same = this.widthPoints.length > 0 && this.widthPoints[0].nodeId === node.id;
			const selected = same && this.widthPoints.some((r) => r.index === ref.index);
			if (input.shift && mode !== 'copy') {
				// Shift-click adds the point to the selection, or takes it out (and drags nothing).
				if (selected) {
					this.widthPoints = this.widthPoints.filter((r) => r.index !== ref.index);
					this.notify();
					return;
				}
				this.widthPoints = same ? [...this.widthPoints, ref] : [ref];
				shift = true;
			} else if (mode === 'copy' || !selected) this.widthPoints = [ref];
			if (mode !== 'copy') group = this.widthPoints.filter((r) => r.index !== ref.index).map((r) => r.index);
		} else {
			const near = nearestStrokePosition(g.line, [local.x, local.y])!;
			const inserted = insertWidthPoint(strokeWidthProfileOf(node), near.t);
			profile = inserted.points;
			subpath = near.contour;
			t = near.t;
			ref = { nodeId: node.id, index: inserted.index, subpath };
			if (input.alt) side = near.side;
			this.widthPoints = [ref];
		}
		const at = strokePositionPoint(g.line, subpath, t);
		if (!at) return;
		const base = { ...this.doc, nodes: mapTree(this.doc.nodes, (n) => (n.id === node.id ? { ...(n as VectorPathNode), strokeWidthProfile: profile } : n)) };
		this.doc = base;
		this.drag = {
			kind: 'width',
			ref,
			mode,
			side,
			source: ref.index,
			group,
			shift,
			renumber: null,
			origin: { x: at.point[0], y: at.point[1] },
			normal: { x: at.tangent[1], y: -at.tangent[0] },
			unit: g.unit,
			profile,
			before,
			base,
			start: p,
			moved: false,
			created: !hit
		};
		const w = profile[ref.index];
		this.interaction = { type: 'width', ref, mode, width: (w.left + w.right) * g.unit };
		this.notify(!hit);
	}

	/**
	 * A width-tool slide to `t` on the dragged point's subpath lands exactly on another width
	 * point (not `skip`) within the pick distance on screen: dropping a point onto another makes
	 * a discontinuous point (two points at one `t`, the width steps there).
	 */
	private snapWidthT(drag: Extract<Drag, { kind: 'width' }>, node: VectorPathNode, line: BezierPath, t: number, skip: number): number {
		const m = this.worldOf(node.id, drag.base);
		const at = strokePositionPoint(line, drag.ref.subpath, t);
		if (!at) return t;
		const here = this.documentToScreen(applyMatrix(m, { x: at.point[0], y: at.point[1] }));
		let best = t;
		let bestD = this.hitRadius;
		drag.profile.forEach((w, i) => {
			if (i === skip || drag.group.includes(i)) return;
			const q = strokePositionPoint(line, drag.ref.subpath, w.t);
			if (!q) return;
			const s = this.documentToScreen(applyMatrix(m, { x: q.point[0], y: q.point[1] }));
			const d = Math.hypot(s.x - here.x, s.y - here.y);
			if (d <= bestD) {
				best = w.t;
				bestD = d;
			}
		});
		return best;
	}

	/** The nearest outline point of any visible, unlocked path within the pick distance of document point `p`. */
	private nearestOutline(p: Vec2): NonNullable<VectorHover['segment']> | null {
		let best: (NonNullable<VectorHover['segment']> & { distance: number }) | null = null;
		const tol = this.tolerance();
		const visit = (list: readonly VectorNode[], parent: AffineMatrix) => {
			for (let i = list.length - 1; i >= 0; i--) {
				const n = list[i];
				if (n.visible === false || n.locked) continue;
				const m = multiplyMatrices(nodeMatrix(n), parent);
				if (n.type === 'group') {
					visit(n.children, m);
					continue;
				}
				if (n.type !== 'path') continue;
				const hit = nearestSegment(n, applyMatrix(invertMatrix(m), p));
				// Node matrices are rigid, so local distances are document distances.
				if (hit && hit.distance <= tol && (!best || hit.distance < best.distance - 1e-9)) {
					best = { nodeId: n.id, subpath: hit.subpath, segment: hit.segment, t: hit.t, point: applyMatrix(m, hit.point), distance: hit.distance };
				}
			}
		};
		visit(this.doc.nodes, IDENTITY_MATRIX);
		if (!best) return null;
		const { distance: _d, ...seg } = best as NonNullable<VectorHover['segment']> & { distance: number };
		return seg;
	}

	private sameHover(a: VectorHover | null, b: VectorHover | null): boolean {
		return JSON.stringify(a) === JSON.stringify(b);
	}

	/** Primary button down on the canvas at `screen` (pixels relative to the canvas). */
	pointerDown(screen: Vec2, input: VectorPointerInput = {}): void {
		this.cancelDrag();
		if (input.button === 1 || this.spaceHeld) {
			this.drag = { kind: 'pan', start: screen, viewport: this.viewport };
			this.interaction = { type: 'pan' };
			this.notify();
			return;
		}
		if (input.button !== undefined && input.button !== 0) return;
		const p = this.screenToDocument(screen);
		this.pointer = p;
		switch (this.tool) {
			case 'select':
				return this.downSelect(screen, p, input);
			case 'direct':
				return this.downDirect(screen, p, input);
			case 'pen':
				return this.downPen(screen, p, input);
			case 'pencil':
				return this.downPencil(p, input);
			case 'width':
				return this.downWidth(screen, p, input);
			case 'shapeBuilder':
			case 'paintBucket':
				return this.downBuilder(p, input);
			case 'blend':
				return this.downBlend(screen, p);
			case 'gradient':
				return this.downGradient(screen, p, input);
			case 'envelope':
				return this.downEnvelope(screen, p, input);
			case 'type':
			case 'typePath':
				return this.downType(p, input);
			case 'scissors': {
				const seg = this.nearestOutline(p);
				if (seg) this.cutPathAt(seg.nodeId, seg.point);
				return;
			}
			case 'knife':
			case 'eraser':
				this.drag = { kind: 'stroke', tool: this.tool, points: [p], before: this.snapshot() };
				this.interaction = { type: 'stroke', tool: this.tool, points: [p], width: this.tool === 'eraser' ? this.editing.eraserSize : 0 };
				this.notify();
				return;
			case 'connector':
				return this.downConnector(p);
			default:
				return this.downShape(p, input);
		}
	}

	/** The shape under the pointer for the Blend tool, and the anchor of its first subpath under it. */
	private blendHit(screen: Vec2, p: Vec2): VectorBlendStart | null {
		const node = hitTestVectorNodes(this.doc.nodes, p, this.tolerance());
		if (!node) return null;
		let anchor: number | null = null;
		if (node.type === 'path' && node.subpaths[0]) {
			const refs = node.subpaths[0].anchors.map((_, index) => ({ nodeId: node.id, subpath: 0, index }));
			anchor = this.hitAnchor(screen, refs)?.index ?? null;
		}
		return { nodeId: node.id, anchor };
	}

	/** Blend tool: the first click picks the shape to blend from, the next one blends it into the shape clicked. */
	private downBlend(screen: Vec2, p: Vec2) {
		const hit = this.blendHit(screen, p);
		const start = this.blendStart;
		if (!hit) {
			if (start) {
				this.blendStart = null;
				this.notify();
			}
			return;
		}
		if (!start || start.nodeId === hit.nodeId) {
			this.blendStart = hit;
			this.selection = [hit.nodeId];
			this.anchors = [];
			this.notify();
			return;
		}
		this.blendStart = null;
		const first = this.getNode(start.nodeId);
		if (isVectorBlendGroup(first)) {
			// Clicking on from a blend adds the shape as its next key.
			if (!this.addBlendKey(first.id, hit.nodeId, { start: hit.anchor }).ok) this.notify();
			return;
		}
		const starts: Record<string, number> = {};
		if (start.anchor !== null) starts[start.nodeId] = start.anchor;
		if (hit.anchor !== null) starts[hit.nodeId] = hit.anchor;
		if (!this.blend({ ids: [start.nodeId, hit.nodeId], keepOrder: true, starts })) this.notify();
	}

	private downSelect(screen: Vec2, p: Vec2, input: VectorPointerInput) {
		const handle = this.hitTransformHandle(screen);
		if (handle) {
			const frame = this.frameOf(this.selectedRoots())!;
			const before = this.snapshot();
			const center = applyMatrix(rotateMatrix(frame.angle), { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
			this.drag =
				handle === 'rotate'
					? { kind: 'rotate', start: p, center, before, base: this.doc }
					: { kind: 'scale', handle, start: p, frame, before, base: this.doc };
			this.interaction = handle === 'rotate' ? { type: 'rotate', angle: 0 } : { type: 'scale', handle, sx: 1, sy: 1 };
			this.notify();
			return;
		}
		const node = hitTestVectorNodes(this.doc.nodes, p, this.tolerance(), { entered: this.enteredGroups() });
		if (node) {
			const selected = this.selection.includes(node.id);
			if (input.shift) {
				this.selection = selected ? this.selection.filter((id) => id !== node.id) : [...this.selection, node.id];
				if (selected) {
					this.notify();
					return;
				}
			} else if (!selected) this.selection = [node.id];
			this.anchors = [];
			const before = this.snapshot();
			this.drag = {
				kind: 'move',
				start: p,
				origin: this.boundsOf(this.selectedRoots()),
				before,
				base: this.doc,
				moved: false,
				duplicated: false,
				clickId: selected && !input.shift ? node.id : null
			};
			this.notify();
			return;
		}
		if (!input.shift) this.selection = [];
		this.drag = { kind: 'marquee', start: p, base: this.selection, baseAnchors: [], anchorsMode: false };
		this.interaction = { type: 'marquee', bounds: { x: p.x, y: p.y, width: 0, height: 0 } };
		this.notify();
	}

	private downDirect(screen: Vec2, p: Vec2, input: VectorPointerInput) {
		const handle = this.hitHandle(screen);
		if (handle) {
			this.drag = { kind: 'handle', ref: handle, before: this.snapshot(), base: this.doc };
			this.interaction = { type: 'handle', ref: handle };
			this.notify();
			return;
		}
		const anchor = this.hitAnchor(screen, getVisibleAnchors(this.view()));
		if (anchor) {
			const selected = this.anchors.some((a) => sameRef(a, anchor));
			this.editingId = anchor.nodeId;
			if (input.alt) {
				// Alt-drag an anchor pulls out fresh symmetric handles.
				this.anchors = [anchor];
				this.drag = { kind: 'pull', ref: anchor, before: this.snapshot(), base: this.doc, label: 'Make Smooth', outOnly: false, closing: false, altBreaks: false };
				this.notify();
				return;
			}
			if (input.shift) {
				this.anchors = selected ? this.anchors.filter((a) => !sameRef(a, anchor)) : [...this.anchors, anchor];
				if (selected) {
					this.notify();
					return;
				}
			} else if (!selected) this.anchors = [anchor];
			this.drag = { kind: 'anchors', start: p, before: this.snapshot(), base: this.doc, moved: false, clickRef: selected && !input.shift ? anchor : null, lead: anchor };
			this.notify();
			return;
		}
		const widget = this.hitCornerWidget(screen);
		if (widget) {
			const refs = getVectorCornerWidgets(this.cornerView()).map((w) => w.ref);
			this.drag = { kind: 'corner', widget, refs, start: p, before: this.snapshot(), base: this.doc, moved: false, alt: !!input.alt, shift: !!input.shift };
			this.notify();
			return;
		}
		for (const id of getEditablePathIds(this.view())) {
			const node = this.getNode(id) as VectorPathNode;
			const seg = nearestSegment(node, this.toLocal(id, p));
			if (!seg || seg.distance > this.tolerance()) continue;
			const sp = node.subpaths[seg.subpath];
			if (input.alt) {
				const before = this.snapshot();
				const { subpath, index } = insertAnchor(sp, seg.segment, seg.t);
				this.replaceNode(id, { ...node, subpaths: node.subpaths.map((s, i) => (i === seg.subpath ? subpath : s)) });
				const ref = { nodeId: id, subpath: seg.subpath, index };
				this.anchors = [ref];
				this.editingId = id;
				this.drag = { kind: 'anchors', start: p, before, base: this.doc, moved: true, clickRef: null, lead: ref };
				this.notify(true);
				return;
			}
			// A click selects the segment's anchors; a drag bends it through the pointer.
			const a = { nodeId: id, subpath: seg.subpath, index: seg.segment };
			const b = { nodeId: id, subpath: seg.subpath, index: (seg.segment + 1) % sp.anchors.length };
			this.anchors = input.shift ? [...this.anchors.filter((r) => !sameRef(r, a) && !sameRef(r, b)), a, b] : [a, b];
			this.editingId = id;
			this.drag = { kind: 'bend', ref: { nodeId: id, subpath: seg.subpath, segment: seg.segment }, t: seg.t, start: p, before: this.snapshot(), base: this.doc, moved: false };
			this.notify();
			return;
		}
		const path = this.hitPath(p);
		if (path) {
			this.editingId = path.id;
			if (!input.shift) this.selection = [path.id];
			else if (!this.selection.includes(path.id)) this.selection = [...this.selection, path.id];
			this.anchors = path.subpaths.flatMap((sp, s) => sp.anchors.map((_, i) => ({ nodeId: path.id, subpath: s, index: i })));
			this.drag = { kind: 'anchors', start: p, before: this.snapshot(), base: this.doc, moved: false, clickRef: null, lead: null };
			this.notify();
			return;
		}
		if (!input.shift) {
			this.anchors = [];
		}
		this.drag = { kind: 'marquee', start: p, base: this.selection, baseAnchors: this.anchors, anchorsMode: getEditablePathIds(this.view()).length > 0 };
		this.interaction = { type: 'marquee', bounds: { x: p.x, y: p.y, width: 0, height: 0 } };
		this.notify();
	}

	private downPen(screen: Vec2, p: Vec2, input: VectorPointerInput) {
		const before = this.snapshot();
		const sp = this.pen ? (this.getNode(this.pen.nodeId) as VectorPathNode | undefined)?.subpaths[this.pen.subpath] : undefined;
		if (this.pen && sp) {
			const pen = this.pen;
			const first = { nodeId: pen.nodeId, subpath: pen.subpath, index: 0 };
			if (sp.anchors.length >= 2 && this.hitAnchor(screen, [first])) {
				const node = this.getNode(pen.nodeId) as VectorPathNode;
				this.replaceNode(pen.nodeId, { ...node, subpaths: node.subpaths.map((s, i) => (i === pen.subpath ? { ...s, closed: true } : s)) });
				this.drag = { kind: 'pull', ref: first, before, base: this.doc, label: 'Close Path', outOnly: false, closing: true, altBreaks: true };
				this.interaction = { type: 'pen', nodeId: pen.nodeId };
				this.notify(true);
				return;
			}
			const last = getAnchorWorld(this.doc, { nodeId: pen.nodeId, subpath: pen.subpath, index: sp.anchors.length - 1 })!;
			const leave = { at: { x: last.x, y: last.y }, constrain: input.shift ? ('angle' as const) : null, ...this.penAngles() };
			let pt = this.snapDrawn(p, leave, input, () => this.drawingTargets(pen.nodeId));
			pt = this.toLocal(pen.nodeId, pt);
			const node = this.getNode(pen.nodeId) as VectorPathNode;
			const anchors = [...sp.anchors, { x: pt.x, y: pt.y }];
			this.replaceNode(pen.nodeId, { ...node, subpaths: node.subpaths.map((s, i) => (i === pen.subpath ? { ...s, anchors } : s)) });
			const ref = { nodeId: pen.nodeId, subpath: pen.subpath, index: anchors.length - 1 };
			this.anchors = [ref];
			this.drag = { kind: 'pull', ref, before, base: this.doc, label: 'Add Point', outOnly: false, closing: false, altBreaks: true };
			this.interaction = { type: 'pen', nodeId: pen.nodeId };
			this.notify(true);
			return;
		}
		const endpoint = this.hitAnchor(screen, this.openEndpoints());
		if (endpoint) {
			let node = this.getNode(endpoint.nodeId) as VectorPathNode;
			let index = endpoint.index;
			if (index === 0 && node.subpaths[endpoint.subpath].anchors.length > 1) {
				node = { ...node, subpaths: node.subpaths.map((s, i) => (i === endpoint.subpath ? reverseSubpath(s) : s)) };
				this.replaceNode(node.id, node);
				index = node.subpaths[endpoint.subpath].anchors.length - 1;
			}
			this.pen = { nodeId: node.id, subpath: endpoint.subpath };
			this.selection = [node.id];
			this.editingId = node.id;
			const ref = { nodeId: node.id, subpath: endpoint.subpath, index };
			this.anchors = [ref];
			this.drag = { kind: 'pull', ref, before, base: this.doc, label: 'Continue Path', outOnly: true, closing: false, altBreaks: true };
			this.interaction = { type: 'pen', nodeId: node.id };
			this.notify(this.doc !== before.doc);
			return;
		}
		const pt = this.snapDrawn(p, null, input, () => this.drawingTargets(null));
		const node: VectorPathNode = { id: this.newId(), type: 'path', name: 'Path', ...this.styleFor(true), subpaths: [{ anchors: [{ x: pt.x, y: pt.y }], closed: false }] };
		this.setDoc([...this.doc.nodes, node]);
		this.pen = { nodeId: node.id, subpath: 0 };
		this.selection = [node.id];
		this.editingId = node.id;
		const ref = { nodeId: node.id, subpath: 0, index: 0 };
		this.anchors = [ref];
		this.drag = { kind: 'pull', ref, before, base: this.doc, label: 'Start Path', outOnly: false, closing: false, altBreaks: true };
		this.interaction = { type: 'pen', nodeId: node.id };
		this.notify(true);
	}

	private downPencil(p: Vec2, input: VectorPointerInput = {}) {
		const before = this.snapshot();
		const node: VectorPathNode = {
			id: this.newId(),
			type: 'path',
			name: 'Pencil',
			...this.styleFor(true),
			strokeLinecap: this.defaults.strokeLinecap ?? 'round',
			strokeLinejoin: this.defaults.strokeLinejoin ?? 'round',
			subpaths: [{ anchors: [{ x: p.x, y: p.y }], closed: false }]
		};
		this.setDoc([...this.doc.nodes, node]);
		const lazy = new LazyMouse((this.editing.pencilSmoothing * VECTOR_PENCIL_STRING_PX) / this.viewport.zoom);
		lazy.push([p.x, p.y]);
		const mode = this.editing.pencilPressure;
		const hasPressure = typeof input.pressure === 'number' && Number.isFinite(input.pressure);
		const record = hasPressure && (mode === 'all' || (mode === 'pen' && input.pointerType === 'pen'));
		const pressure = hasPressure ? input.pressure! : 0.5;
		this.drag = { kind: 'pencil', nodeId: node.id, points: [[p.x, p.y]], before, lazy, pressures: record ? [pressure] : null, pressure };
		this.interaction = { type: 'draw', tool: 'pencil', nodeId: node.id, bounds: { x: p.x, y: p.y, width: 0, height: 0 } };
		this.notify(true);
	}

	private downShape(p: Vec2, input: VectorPointerInput) {
		const before = this.snapshot();
		// The targets are gathered before the new shape joins the document, and kept for the drag.
		const targets = this.drawingTargets(null);
		const start = this.snapDrawn(p, null, input, () => targets);
		// The Frame tool drags out a rectangle that becomes the frame when released.
		const kind = (this.tool === 'frame' ? 'rect' : this.tool) as VectorShapeInput['kind'];
		const node = this.createShapeNode({ kind, x: start.x, y: start.y, width: 0, height: 0 });
		if (this.tool === 'frame') Object.assign(node, { fill: '#ffffff', stroke: '#a3a3a3', strokeWidth: 1 / this.viewport.zoom });
		this.setDoc([...this.doc.nodes, node]);
		this.drag = { kind: 'shape', tool: this.tool, start, nodeId: node.id, before, targets };
		this.interaction = { type: 'draw', tool: this.tool, nodeId: node.id, bounds: { x: start.x, y: start.y, width: 0, height: 0 } };
		this.notify(true);
	}

	/** Pointer moved over the canvas (with or without a button down). */
	pointerMove(screen: Vec2, input: VectorPointerInput = {}): void {
		const p = this.screenToDocument(screen);
		const drag = this.drag;
		if (!drag && (this.tool === 'shapeBuilder' || this.tool === 'paintBucket')) {
			this.pointer = p;
			if (this.hoverBuilder(p, !!input.alt)) this.notify();
			return;
		}
		if (!drag && this.tool === 'connector') {
			// The sites under the pointer show while hovering (see the overlay's connectorSites).
			this.pointer = p;
			this.notify();
			return;
		}
		if (!drag) {
			const hover = this.computeHover(screen);
			const pointerMatters = this.tool === 'pen' && !!this.pen;
			const guides = this.guides;
			this.hover = hover;
			const pointer = this.hoverSnap(p, input);
			if (this.sameHover(hover, this.state.hover) && !pointerMatters && JSON.stringify(guides) === JSON.stringify(this.guides)) return;
			this.pointer = pointer;
			this.notify();
			return;
		}
		this.pointer = p;
		switch (drag.kind) {
			case 'textBox':
				drag.moved ||= Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * this.viewport.zoom > 3;
				this.interaction = { type: 'textBox', bounds: boundsFromPoints(drag.start, p) };
				this.notify();
				return;
			case 'textSelect': {
				const node = this.getNode(drag.nodeId);
				if (node?.type === 'text' && this.textEdit) {
					this.textEdit = { ...this.textEdit, focus: vectorTextIndexAt(node, this.toLocal(node.id, p)) };
					this.notify();
				}
				return;
			}
			case 'pan':
				this.viewport = { ...drag.viewport, x: drag.viewport.x + screen.x - drag.start.x, y: drag.viewport.y + screen.y - drag.start.y };
				this.notify();
				return;
			case 'gradient':
				return this.moveGradient(drag, screen, p, input);
			case 'shading':
				return this.moveShading(drag, screen, p);
			case 'envelope':
				return this.moveEnvelope(drag, p);
			case 'move': {
				let dx = p.x - drag.start.x;
				let dy = p.y - drag.start.y;
				if (!drag.moved && Math.hypot(dx, dy) * this.viewport.zoom < 2) return;
				drag.moved = true;
				if (input.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
				if (input.alt && !drag.duplicated) {
					drag.duplicated = true;
					const created: string[] = [];
					drag.base = this.withDuplicates(drag.base, this.selectedRoots(), { x: 0, y: 0 }, created);
					this.selection = created;
					// The originals stay behind as targets.
					drag.targets = undefined;
				}
				({ dx, dy } = this.snapMove(drag, dx, dy, input));
				this.doc = this.transformed(drag.base, new Set(this.selectedRoots()), translateMatrix(dx, dy));
				this.interaction = { type: 'move', dx, dy };
				this.notify(true);
				return;
			}
			case 'scale': {
				if (this.freeDistort && drag.handle !== 'rotate') return this.moveDistort(drag, p, input);
				// Scale in the box's own (possibly rotated) frame.
				const angle = drag.frame.angle;
				const q = angle ? applyMatrix(rotateMatrix(-angle), p) : p;
				let { sx, sy, origin } = scaleFor(drag.handle, drag.frame, q, input);
				if (this.snap.objects && !input.mod && drag.handle !== 'rotate') {
					drag.targets ??= VectorSnapTargets.forResize(drag.base, this.selectedRoots());
					const res = drag.targets.snapScale(drag.frame, drag.handle, sx, sy, input, this.snapTolerance());
					({ sx, sy } = res);
					this.setGuides(res);
				} else this.setGuides(null);
				const ids = new Set(this.selectedRoots());
				this.doc = this.transformed(drag.base, ids, this.inFrame(angle, scaleMatrix(sx, sy, origin)));
				this.interaction = { type: 'scale', handle: drag.handle, sx, sy };
				this.notify(true);
				return;
			}
			case 'rotate': {
				const a0 = Math.atan2(drag.start.y - drag.center.y, drag.start.x - drag.center.x);
				const a1 = Math.atan2(p.y - drag.center.y, p.x - drag.center.x);
				let angle = ((a1 - a0) * 180) / Math.PI;
				if (input.shift) angle = Math.round(angle / 15) * 15;
				this.doc = this.transformed(drag.base, new Set(this.selectedRoots()), rotateMatrix(angle, drag.center));
				this.interaction = { type: 'rotate', angle };
				this.notify(true);
				return;
			}
			case 'marquee': {
				const bounds = boundsFromPoints(drag.start, p);
				this.interaction = { type: 'marquee', bounds };
				if (drag.anchorsMode) {
					const inside = getVisibleAnchors(this.view()).filter((r) => {
						const a = getAnchorWorld(this.doc, r)!;
						return a.x >= bounds.x && a.x <= bounds.x + bounds.width && a.y >= bounds.y && a.y <= bounds.y + bounds.height;
					});
					this.anchors = [...drag.baseAnchors, ...inside.filter((r) => !drag.baseAnchors.some((b) => sameRef(b, r)))];
				} else {
					const hits = vectorNodesNear(this.doc.nodes, bounds)
						.map((i) => this.doc.nodes[i])
						.filter((n) => !n.locked && n.visible !== false)
						.filter((n) => {
							const b = vectorNodeBounds(n);
							return b && boundsIntersect(b, bounds);
						})
						.map((n) => n.id);
					this.selection = [...new Set([...drag.base, ...hits])];
				}
				this.notify();
				return;
			}
			case 'anchors': {
				let dx = p.x - drag.start.x;
				let dy = p.y - drag.start.y;
				if (!drag.moved && Math.hypot(dx, dy) * this.viewport.zoom < 2) return;
				drag.moved = true;
				const lead = this.leadAnchor(drag);
				if (lead) {
					// The grabbed (or nearest) anchor snaps; the others move with it.
					const leave = input.shift ? { at: lead, constrain: 'axis' as const, curves: false } : null;
					const q = this.snapDrawn({ x: lead.x + dx, y: lead.y + dy }, leave, input, () => (drag.targets ??= VectorSnapTargets.forAnchorDrag(drag.base, this.anchors)));
					dx = q.x - lead.x;
					dy = q.y - lead.y;
				} else if (input.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
				const single = this.anchors.length === 1 ? this.anchors[0] : null;
				const from = single ? getAnchorWorld(drag.base, single) : undefined;
				// A lone point bends its segments with the Curvature setting (Alt held flips it).
				if (single && from && this.editing.curvatureMoves !== !!input.alt) this.doc = this.curvatureMoved(drag.base, single, { x: from.x + dx, y: from.y + dy });
				else this.doc = this.movedAnchors(drag.base, this.anchors, dx, dy);
				this.interaction = { type: 'anchors', dx, dy };
				this.notify(true);
				return;
			}
			case 'handle': {
				const anchor = getAnchorWorld(drag.base, drag.ref);
				const leave = anchor ? { at: { x: anchor.x, y: anchor.y }, constrain: input.shift ? ('angle' as const) : null } : null;
				const pt = this.snapDrawn(p, leave, input, () => (drag.targets ??= VectorSnapTargets.forHandle(drag.base, drag.ref.nodeId)));
				const local = this.toLocal(drag.ref.nodeId, pt, drag.base);
				this.doc = this.updateAnchors(drag.base, [drag.ref], (a) => moveAnchorHandle(a, drag.ref.handle, local, input.alt));
				this.interaction = { type: 'handle', ref: drag.ref };
				this.notify(true);
				return;
			}
			case 'corner': {
				if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * this.viewport.zoom < 3) return;
				drag.moved = true;
				const c = drag.widget.corner;
				const inv = invertMatrix(this.worldOf(drag.widget.ref.nodeId, drag.base));
				const d = applyMatrixLinear(inv, { x: p.x - drag.start.x, y: p.y - drag.start.y });
				const radius = Math.max(0, Math.min(c.maxRadius, drag.widget.drawnRadius + cornerRadiusChange(c, d)));
				this.doc = this.updateAnchors(drag.base, drag.refs, (a) => setAnchorCorner(a, radius));
				this.interaction = { type: 'corner', ref: drag.widget.ref, radius };
				this.notify(true);
				return;
			}
			case 'bend': {
				if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * this.viewport.zoom < 2) return;
				drag.moved = true;
				this.doc = this.bent(drag.base, drag.ref, drag.t, p);
				this.interaction = { type: 'bend', ref: drag.ref };
				this.notify(true);
				return;
			}
			case 'builder':
				return this.moveBuilder(drag, p);
			case 'stroke': {
				const last = drag.points[drag.points.length - 1];
				if (Math.hypot(p.x - last.x, p.y - last.y) * this.viewport.zoom < 1.5) return;
				drag.points.push(p);
				this.interaction = { type: 'stroke', tool: drag.tool, points: drag.points.slice(), width: drag.tool === 'eraser' ? this.editing.eraserSize : 0 };
				this.notify();
				return;
			}
			case 'pull': {
				const anchor = getAnchorWorld(drag.base, drag.ref);
				if (!anchor) return;
				if (Math.hypot(p.x - anchor.x, p.y - anchor.y) * this.viewport.zoom < 2) {
					this.doc = drag.base;
					this.notify(true);
					return;
				}
				this.guides = null;
				let pt = p;
				if (input.shift) pt = constrain45(anchor, pt);
				const side = drag.closing ? 'in' : 'out';
				// Dragging out of the closing anchor pulls its incoming handle toward the pointer's mirror.
				const pos = this.toLocal(drag.ref.nodeId, drag.closing ? { x: 2 * anchor.x - pt.x, y: 2 * anchor.y - pt.y } : pt, drag.base);
				this.doc = this.updateAnchors(drag.base, [drag.ref], (a) => {
					if (drag.outOnly || (drag.altBreaks && input.alt)) return moveAnchorHandle(a, side, pos, true);
					return moveAnchorHandle({ ...a, type: 'symmetric' }, side, pos);
				});
				this.notify(true);
				return;
			}
			case 'connector': {
				const node = this.getNode(drag.nodeId);
				if (!isVectorConnector(node)) return;
				const target = vectorConnectorTargetAt(this.doc.nodes, p, this.connectorRadius(), drag.nodeId);
				const startGlue = node.connector.start;
				const end = target && target.nodeId !== startGlue?.nodeId ? { nodeId: target.nodeId, ...(target.side && target.side !== 'auto' ? { side: target.side } : {}) } : null;
				const first = node.subpaths[0]?.anchors[0] ?? drag.start;
				this.replaceNode(drag.nodeId, { ...node, connector: { ...node.connector, end }, subpaths: [{ closed: false, anchors: [{ x: first.x, y: first.y }, { x: p.x, y: p.y }] }] });
				this.notify(true);
				return;
			}
			case 'shape': {
				const node = this.getNode(drag.nodeId);
				if (node?.type !== 'path') return;
				const leave = { at: drag.start, constrain: input.shift ? (drag.tool === 'line' ? ('angle' as const) : ('square' as const)) : null, curves: false };
				let end = this.snapDrawn(p, leave, input, () => (drag.targets ??= this.drawingTargets(null)));
				if (!this.snappedToObject && drag.tool !== 'line' && !input.shift && !input.mod && this.snap.objects && drag.targets) end = this.matchShapeSize(drag.targets, drag.start, end, input.alt);
				let start = drag.start;
				let bounds: VectorBounds;
				if (drag.tool === 'line') {
					if (input.shift) end = constrain45(start, end);
					if (input.alt) start = { x: 2 * start.x - end.x, y: 2 * start.y - end.y };
					bounds = { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
				} else {
					let w = end.x - start.x;
					let h = end.y - start.y;
					if (input.shift) {
						const s = Math.max(Math.abs(w), Math.abs(h));
						w = Math.sign(w || 1) * s;
						h = Math.sign(h || 1) * s;
					}
					if (input.alt) start = { x: start.x - w, y: start.y - h };
					const x2 = drag.start.x + w;
					const y2 = drag.start.y + h;
					bounds = boundsFromPoints(start, { x: x2, y: y2 });
				}
				const shaped = this.createShapeNode({ kind: (drag.tool === 'frame' ? 'rect' : drag.tool) as VectorShapeInput['kind'], ...bounds });
				this.replaceNode(drag.nodeId, { ...node, subpaths: shaped.subpaths });
				this.interaction = { type: 'draw', tool: drag.tool, nodeId: drag.nodeId, bounds };
				this.notify(true);
				return;
			}
			case 'width': {
				if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * this.viewport.zoom < 2) return;
				drag.moved = true;
				const node = findVectorNode(drag.base.nodes, drag.ref.nodeId) as VectorPathNode;
				const local = this.toLocal(node.id, p, drag.base);
				const src = drag.profile[drag.source];
				let profile: VectorWidthPoint[];
				let index = drag.source;
				if (drag.mode !== 'width') {
					const g = vectorStrokeWidthGeometry(node);
					const near = g ? nearestStrokePosition(g.line, [local.x, local.y], drag.ref.subpath) : null;
					if (!g || !near) return;
					const t = drag.group.length ? near.t : this.snapWidthT(drag, node, g.line, near.t, drag.source);
					if (drag.mode === 'copy') {
						// The source stays; a copy of it slides (and may pass other points).
						({ points: profile, index } = insertWidthPoint(drag.profile, t, { left: src.left, right: src.right }, { step: true }));
					} else if (drag.group.length) {
						const shifted = shiftWidthPoints(drag.profile, [drag.source, ...drag.group], t - src.t);
						profile = shifted.points;
						drag.renumber = shifted.renumber;
						index = shifted.renumber.get(drag.source) ?? drag.source;
					} else profile = setWidthPoint(drag.profile, drag.source, { t });
				} else {
					const off = ((local.x - drag.origin.x) * drag.normal.x + (local.y - drag.origin.y) * drag.normal.y) / drag.unit;
					const patch =
						drag.side === 'both' ? { left: Math.abs(off), right: Math.abs(off) } : drag.side === 'left' ? { left: Math.max(0, off) } : { right: Math.max(0, -off) };
					profile = setWidthPoint(drag.profile, drag.source, patch);
					if (drag.group.length) {
						// Every selected point widens by as much as the dragged one.
						const dl = profile[drag.source].left - src.left;
						const dr = profile[drag.source].right - src.right;
						for (const i of drag.group) profile = setWidthPoint(profile, i, { left: Math.max(0, drag.profile[i].left + dl), right: Math.max(0, drag.profile[i].right + dr) });
					}
				}
				this.doc = { ...drag.base, nodes: mapTree(drag.base.nodes, (n) => (n.id === node.id ? { ...(n as VectorPathNode), strokeWidthProfile: profile } : n)) };
				drag.ref = { ...drag.ref, index };
				const w = profile[index];
				this.interaction = { type: 'width', ref: drag.ref, mode: drag.mode, width: (w.left + w.right) * drag.unit };
				this.notify(true);
				return;
			}
			case 'pencil': {
				const last = drag.points[drag.points.length - 1];
				let moved = false;
				if (typeof input.pressure === 'number' && Number.isFinite(input.pressure)) drag.pressure = input.pressure;
				for (const q of drag.lazy.push([p.x, p.y])) {
					if (Math.hypot(q[0] - last[0], q[1] - last[1]) * this.viewport.zoom < 1.5) continue;
					drag.points.push(q);
					drag.pressures?.push(drag.pressure);
					moved = true;
				}
				const string = drag.lazy.string();
				const node = this.getNode(drag.nodeId);
				if (node?.type !== 'path') return;
				if (!moved) {
					if (string && this.interaction?.type === 'draw') {
						this.interaction = { ...this.interaction, string: [{ x: string[0][0], y: string[0][1] }, { x: string[1][0], y: string[1][1] }] };
						this.notify();
					}
					return;
				}
				this.replaceNode(drag.nodeId, { ...node, subpaths: [{ anchors: drag.points.map(([x, y]) => ({ x, y })), closed: false }] });
				const xs = drag.points.map((q) => q[0]);
				const ys = drag.points.map((q) => q[1]);
				this.interaction = {
					type: 'draw',
					tool: 'pencil',
					nodeId: drag.nodeId,
					bounds: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
					...(string ? { string: [{ x: string[0][0], y: string[0][1] }, { x: string[1][0], y: string[1][1] }] as [Vec2, Vec2] } : {})
				};
				this.notify(true);
				return;
			}
		}
	}

	/** Snaps a move of the selection by (dx, dy): its bounds line up with targets or space evenly, else go to the grid. */
	private snapMove(drag: Extract<Drag, { kind: 'move' }>, dx: number, dy: number, input: VectorModifiers): { dx: number; dy: number } {
		const origin = drag.origin;
		if (input.mod || !origin) {
			this.setGuides(null);
			return { dx, dy };
		}
		// A Shift-locked axis stays put.
		const axes = { x: !input.shift || dx !== 0, y: !input.shift || dy !== 0 };
		let res = null;
		if (this.snap.objects) {
			drag.targets ??= VectorSnapTargets.forMove(drag.base, this.selectedRoots());
			res = drag.targets.snapRect({ ...origin, x: origin.x + dx, y: origin.y + dy }, this.snapTolerance(), { spacing: true, axes });
		}
		this.setGuides(res);
		return {
			dx: res?.x ? dx + res.dx : axes.x ? this.gridValue(origin.x + dx) - origin.x : dx,
			dy: res?.y ? dy + res.dy : axes.y ? this.gridValue(origin.y + dy) - origin.y : dy
		};
	}

	/** The anchor a point drag snaps by, where it started: the grabbed one, else the moving one nearest the press. */
	private leadAnchor(drag: Extract<Drag, { kind: 'anchors' }>): Vec2 | null {
		const ref = drag.lead && this.anchors.some((a) => sameRef(a, drag.lead!)) ? drag.lead : null;
		if (ref) {
			const a = getAnchorWorld(drag.base, ref);
			return a ? { x: a.x, y: a.y } : null;
		}
		let best: Vec2 | null = null;
		for (const r of this.anchors) {
			const a = getAnchorWorld(drag.base, r);
			if (a && (!best || Math.hypot(a.x - drag.start.x, a.y - drag.start.y) < Math.hypot(best.x - drag.start.x, best.y - drag.start.y))) best = { x: a.x, y: a.y };
		}
		return best;
	}

	/** A shape's dragged corner moved so its width or height matches another object's, when one is within reach. */
	private matchShapeSize(targets: VectorSnapTargets, start: Vec2, end: Vec2, fromCentre = false): Vec2 {
		// Dragged from the centre, the shape is twice as large as the drag.
		const k = fromCentre ? 2 : 1;
		const tol = this.snapTolerance() * k;
		const out = { ...end };
		const guides: VectorSnapGuides = { lines: [], labels: [] };
		for (const axis of ['x', 'y'] as const) {
			const d = end[axis] - start[axis];
			const len = Math.abs(d) > 1e-9 ? targets.matchSize(Math.abs(d) * k, tol) : null;
			if (len === null || len <= 0) continue;
			out[axis] = start[axis] + (Math.sign(d) * len) / k;
			const from = { ...out, [axis]: fromCentre ? 2 * start[axis] - out[axis] : start[axis] };
			guides.lines.push({ kind: 'size', x1: from.x, y1: from.y, x2: out.x, y2: out.y });
			guides.labels.push({ kind: 'size', x: (from.x + out.x) / 2, y: (from.y + out.y) / 2, text: `${axis === 'x' ? 'W' : 'H'} ${Math.round(len * 100) / 100}` });
		}
		this.setGuides(guides);
		return out;
	}

	/** Primary button released. */
	pointerUp(screen?: Vec2, input: VectorPointerInput = {}): void {
		// A pen reports no pressure as it lifts: keep the last pressure for the final move.
		if (screen && this.drag && this.drag.kind !== 'pan') this.pointerMove(screen, { ...input, pressure: undefined });
		const drag = this.drag;
		this.drag = null;
		this.interaction = null;
		this.guides = null;
		if (!drag) return;
		switch (drag.kind) {
			case 'textBox':
				return this.upTypeBox(drag);
			case 'textSelect':
				this.notify();
				return;
			case 'pan':
			case 'marquee':
				this.notify();
				return;
			case 'move':
				if (!drag.moved) {
					if (drag.clickId) this.selection = [drag.clickId];
					this.notify();
					return;
				}
				return this.commit(drag.duplicated ? 'Duplicate' : 'Move', drag.before);
			case 'scale':
				return this.commit(drag.op ?? 'Scale', drag.before);
			case 'envelope':
				if (!drag.moved) {
					this.notify();
					return;
				}
				return this.commit('Edit Envelope', drag.before);
			case 'rotate':
				return this.commit('Rotate', drag.before);
			case 'anchors':
				if (!drag.moved) {
					if (drag.clickRef) this.anchors = [drag.clickRef];
					if (drag.before.doc !== this.doc) return this.commit('Add Point', drag.before);
					this.notify();
					return;
				}
				return this.commit(drag.before.doc !== drag.base ? 'Add Point' : 'Move Points', drag.before);
			case 'handle':
				return this.commit('Move Handle', drag.before);
			case 'bend':
				if (!drag.moved) {
					this.notify();
					return;
				}
				return this.commit('Bend Segment', drag.before);
			case 'corner': {
				if (drag.moved) return this.commit('Corner Radius', drag.before);
				if (drag.alt) {
					const kind = nextVectorCornerKind(drag.widget.kind);
					this.doc = this.updateAnchors(drag.base, drag.refs, (a) => setAnchorCorner(a, a.corner?.radius ?? 0, kind));
					return this.commit('Corner Kind', drag.before);
				}
				// A click selects the widget's corner, so the next drag rounds that corner alone.
				const ref = drag.widget.ref;
				const has = this.anchors.some((a) => sameRef(a, ref));
				this.editingId = ref.nodeId;
				this.anchors = drag.shift ? (has ? this.anchors.filter((a) => !sameRef(a, ref)) : [...this.anchors, ref]) : [ref];
				this.notify();
				return;
			}
			case 'width': {
				if (drag.moved) {
					const several = drag.group.length > 0;
					if (drag.mode === 'copy') this.widthPoints = [drag.ref];
					else if (drag.mode === 'move' && several) {
						// Points moved together stay selected (re-sorting may renumber them).
						this.widthPoints = [drag.source, ...drag.group].map((i) => ({ ...drag.ref, index: drag.renumber?.get(i) ?? i }));
					} else if (!several) this.widthPoints = [drag.ref];
					const label = drag.mode === 'copy' ? 'Copy Width Point' : drag.mode === 'move' ? (several ? 'Move Width Points' : 'Move Width Point') : several ? 'Width Points' : 'Width Point';
					return this.commit(label, drag.before);
				}
				// A click adds nothing; on a width point it selects it (just it, among several selected).
				if (drag.created) {
					this.doc = drag.before.doc;
					this.widthPoints = [];
					this.notify(true);
				} else {
					if (!drag.shift && drag.group.length) this.widthPoints = [drag.ref];
					this.notify();
				}
				return;
			}
			case 'builder':
				return this.upBuilder(drag);
			case 'gradient':
				return this.upGradient(drag);
			case 'shading':
				return this.upShading(drag);
			case 'stroke': {
				this.notify();
				if (drag.tool === 'knife') this.knife(drag.points);
				else this.erase(drag.points);
				return;
			}
			case 'pull':
				if (drag.closing) this.pen = null;
				return this.commit(drag.label, drag.before);
			case 'connector': {
				const node = this.getNode(drag.nodeId);
				const b = node ? vectorNodeBounds(node) : null;
				const glued = isVectorConnector(node) && !!node.connector.end;
				if (!b || (!glued && Math.hypot(b.width, b.height) < 2 / this.viewport.zoom)) {
					this.doc = drag.before.doc;
					this.notify(true);
					return;
				}
				this.selection = [drag.nodeId];
				this.anchors = [];
				this.tool = 'select';
				return this.commit('Draw Connector', drag.before);
			}
			case 'shape': {
				const node = this.getNode(drag.nodeId);
				const b = node ? vectorNodeBounds(node) : null;
				const min = 2 / this.viewport.zoom;
				if (!b || (b.width < min && b.height < min)) {
					this.doc = drag.before.doc;
					this.notify(true);
					return;
				}
				if (drag.tool === 'frame') {
					// The rectangle becomes a frame holding the top-level objects it encloses.
					const rest = this.doc.nodes.filter((n) => n.id !== drag.nodeId);
					const adopted = rest.filter((n) => !n.locked && n.visible !== false && !n.blendStep && vectorBoundsInside(vectorNodeBounds(n), b));
					const taken = new Set(adopted.map((n) => n.id));
					const frame: VectorFrameGroup = { id: drag.nodeId, type: 'group', name: this.frameName(), frame: { ...b, fill: '#ffffff' }, children: adopted };
					this.setDoc([...rest.filter((n) => !taken.has(n.id)), frame]);
				}
				this.selection = [drag.nodeId];
				this.anchors = [];
				this.tool = 'select';
				return this.commit(`Draw ${TOOL_LABELS[drag.tool]}`, drag.before);
			}
			case 'pencil': {
				const node = this.getNode(drag.nodeId);
				if (node?.type !== 'path' || drag.points.length < 2) {
					this.doc = drag.before.doc;
					this.notify(true);
					return;
				}
				for (const q of drag.lazy.finish()) {
					drag.points.push(q);
					drag.pressures?.push(drag.pressure);
				}
				const shape = this.editing.recognizeShapes ? recognizeInkShape(drag.points, { minSize: 6 / this.viewport.zoom }) : null;
				if (shape) {
					this.replaceNode(drag.nodeId, { ...node, name: inkShapeLabel(shape), subpaths: [inkShapeSubpath(shape)] });
					this.selection = [drag.nodeId];
					return this.commit(`Draw ${inkShapeLabel(shape)}`, drag.before);
				}
				const fitted = fitCubics(drag.points, 1.5 / this.viewport.zoom, { cornerAngleDeg: 60 });
				const anchors: VectorAnchor[] = [];
				for (const c of fitted) {
					if (!anchors.length) anchors.push({ x: c.p0[0], y: c.p0[1] });
					anchors[anchors.length - 1].out = { x: c.p1[0], y: c.p1[1] };
					anchors.push({ x: c.p3[0], y: c.p3[1], in: { x: c.p2[0], y: c.p2[1] } });
				}
				const subpaths = anchors.length > 1 ? bezierToSubpaths(subpathsToBezier([{ anchors, closed: false }])) : node.subpaths;
				const profile = drag.pressures ? pencilPressureProfile(drag.points, drag.pressures) : [];
				this.replaceNode(drag.nodeId, { ...node, subpaths, ...(profile.length ? { strokeWidthProfile: profile } : {}) });
				this.selection = [drag.nodeId];
				return this.commit('Draw', drag.before);
			}
		}
	}

	/** The pointer left the canvas. */
	pointerLeave(): void {
		if (this.drag) return;
		if (!this.hover && !this.pointer && !this.guides) return;
		this.hover = null;
		this.pointer = null;
		this.guides = null;
		this.notify();
	}

	/** Abandons the drag in progress (Escape, lost capture). */
	cancelDrag(): void {
		const drag = this.drag;
		if (!drag) return;
		this.drag = null;
		this.interaction = null;
		this.guides = null;
		if (drag.kind === 'textBox' || drag.kind === 'textSelect') {
			this.notify();
			return;
		}
		if (drag.kind === 'pan' || drag.kind === 'builder') {
			if (drag.kind === 'builder') this.builderPreview = null;
			this.notify();
			return;
		}
		if (drag.kind === 'marquee') {
			this.selection = drag.base;
			this.anchors = drag.baseAnchors;
			this.notify();
			return;
		}
		this.restore(drag.before);
	}

	/**
	 * Double click: select tool enters path editing, direct tool toggles an anchor or adds one,
	 * width tool opens the width-point editor (`widthPointEdit`).
	 */
	doubleClick(screen: Vec2): void {
		const p = this.screenToDocument(screen);
		if (this.tool === 'select') {
			// Into a symbol instance: Edit Symbol in isolation.
			const instance = this.hitOfType(p, 'instance');
			if (instance) {
				this.editSymbol(instance.id);
				return;
			}
		}
		if (this.tool === 'select' || this.tool === 'type' || this.tool === 'typePath') {
			const text = this.hitText(p);
			if (text) {
				// Into the text: the Type tool, the caret where it was clicked (twice inside the text: the word).
				if (this.tool === 'select') this.setTool('type');
				const index = vectorTextIndexAt(text, this.toLocal(text.id, p));
				if (this.textEdit?.nodeId === text.id) {
					const [a, b] = wordAt(text.text, index);
					this.textEdit = { ...this.textEdit, anchor: a, focus: b };
					this.notify();
				} else this.editText(text.id, { index });
				return;
			}
		}
		if (this.tool === 'select') {
			const path = this.hitPath(p);
			if (!path) return;
			this.tool = 'direct';
			this.selection = [path.id];
			this.editingId = path.id;
			this.anchors = [];
			this.notify();
			return;
		}
		if (this.tool === 'direct') {
			const anchor = this.hitAnchor(screen, getVisibleAnchors(this.view()));
			if (anchor) {
				const a = getAnchor(this.doc, anchor)!;
				this.convertAnchors(a.in || a.out ? 'corner' : 'smooth', [anchor]);
				return;
			}
			const id = this.hover?.segment?.nodeId ?? this.editingId;
			if (id) {
				const node = this.getNode(id) as VectorPathNode | undefined;
				const seg = node ? nearestSegment(node, this.toLocal(id, p)) : null;
				if (seg && seg.distance <= this.tolerance()) this.insertAnchorAt(id, p);
			}
			return;
		}
		if (this.tool === 'width') {
			// Width Point Edit: on a width point, or on a stroke (applying it adds a point there).
			const hit = this.hitWidthHandle(screen);
			if (hit) {
				this.openWidthPointEdit(hit.ref);
				return;
			}
			const spot = this.strokeSpotAt(p);
			if (spot) this.openWidthPointEdit({ nodeId: spot.nodeId, subpath: spot.subpath, t: spot.t });
			return;
		}
		if (this.tool === 'pen') this.finishPath();
	}


	// -------------------------------------------------------------------------
	// Text
	// -------------------------------------------------------------------------

	/**
	 * Sets the text shaper (shared by every vector editor on the page, see `setVectorTextShaper`) and
	 * lays every text node out again with it. Not an undo step.
	 */
	setTextShaper(shaper: TextShaper | null): void {
		setVectorTextShaper(shaper);
		// New node objects so views keyed by the document draw the text again.
		this.doc = { ...this.doc, nodes: mapTree(this.doc.nodes, (n) => (n.type === 'text' ? { ...n } : n)) };
		this.notify(true);
	}

	/** The text shaper in use. */
	getTextShaper(): TextShaper {
		return getVectorTextShaper();
	}

	/** Changes the font and alignment new text gets (validated; throws on a bad value). */
	setTextDefaults(patch: Partial<VectorTextDefaults>): void {
		const { align, ...font } = patch;
		const next: VectorTextDefaults = patchVectorCharacterStyle({ ...this.textDefaults }, font as Record<string, unknown>, 'textDefaults');
		if (align !== undefined) {
			const p = patchVectorParagraphStyle({}, { align });
			if (p.align) next.align = p.align;
			else delete next.align;
		}
		this.textDefaults = next;
		this.notify();
	}

	/** The paint new text gets: black, no stroke (`addText` and the style panel change it). */
	private textStyle(): VectorStyle {
		return { fill: '#000000', stroke: null, strokeWidth: this.defaults.strokeWidth ?? 1 };
	}

	/** Builds a text node from `input` with the text defaults (not added). Throws a `VectorTextError` on bad input. */
	createTextNode(input: VectorTextInput): VectorTextNode {
		if (typeof input.text !== 'string') throw new VectorTextError('text must be a string.');
		const { align, ...defaultFont } = this.textDefaults;
		const font = patchVectorCharacterStyle({ ...defaultFont }, (input.font ?? {}) as Record<string, unknown>, 'font');
		const paragraph = patchVectorParagraphStyle(align ? { align } : {}, (input.paragraph ?? {}) as Record<string, unknown>);
		let frame: VectorTextFrame;
		if (input.path !== undefined) {
			const sp = typeof input.path === 'string' ? pathTextFrameFromBezier(toBezierPathLoose(input.path)) : input.path;
			frame = sanitizeVectorTextFrame({ kind: 'path', path: sp, ...(input.pathOptions ?? {}) });
		} else if (input.width !== undefined || input.height !== undefined) {
			frame = sanitizeVectorTextFrame({ kind: 'area', x: input.x ?? 0, y: input.y ?? 0, width: input.width, height: input.height });
		} else frame = sanitizeVectorTextFrame({ kind: 'point', x: input.x ?? 0, y: input.y ?? 0 });
		const own: VectorStyle = {};
		for (const key of VECTOR_STYLE_KEYS) if (input[key] !== undefined) (own as Record<string, unknown>)[key] = input[key];
		const text = input.text.replace(/\r\n?/g, '\n');
		const node: VectorTextNode = {
			id: this.newId(),
			type: 'text',
			name: input.name ?? vectorTextName(text),
			...this.textStyle(),
			text,
			font,
			...(Object.keys(paragraph).length ? { paragraph } : {}),
			frame
		};
		return withStyle(node as unknown as VectorPathNode, own) as unknown as VectorTextNode;
	}

	/** Adds text (point, area or on a path, see `VectorTextInput`). Returns its id. */
	addText(input: VectorTextInput, options: AddVectorNodeOptions = {}): string {
		const node = this.createTextNode(input);
		return this.addNode(node, { label: 'Add Text', ...options });
	}

	/** The text node `id`, or an error message. */
	private textNode(id: string): VectorTextNode | string {
		const node = this.getNode(id);
		if (!node) return `There is no node "${id}".`;
		if (node.type !== 'text') return `"${id}" is a ${node.type}, not text; vector.list shows each node's type.`;
		if (node.blendStep) return `"${id}" is a blend step; edit the blend's keys instead.`;
		return node;
	}

	/** Replaces text node `id` by `fn(node)` as one undo step (merged with others of `merge`). */
	private editTextNode(id: string, label: string, fn: (node: VectorTextNode) => VectorTextNode, merge?: string): VectorActionResult {
		const node = this.textNode(id);
		if (typeof node === 'string') return { ok: false, message: node };
		let next: VectorTextNode;
		try {
			next = fn(node);
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
		if (next === node) return { ok: true };
		// The edit session's pending creation folds into its first change.
		const pending = this.textEdit?.nodeId === id ? this.textEdit.before : null;
		const before = pending ?? this.snapshot();
		if (pending && this.textEdit) this.textEdit.before = null;
		this.replaceNode(id, next);
		this.commit(label, before, merge);
		return { ok: true };
	}

	/** Replaces [start, end) of text node `id` (default: all of it) with `text`. One undo step. */
	setText(id: string, text: string, range: { start?: number; end?: number } = {}, options: { merge?: string } = {}): VectorActionResult {
		const node = this.textNode(id);
		if (typeof node === 'string') return { ok: false, message: node };
		return this.editTextNode(
			id,
			'Edit Text',
			(n) => {
				const [a, b] = vectorTextRange(n.text, range.start, range.end);
				const next = replaceVectorText(n, a, b, text);
				// A name that followed the text keeps following it.
				return n.name === vectorTextName(n.text) ? { ...next, name: vectorTextName(next.text) } : next;
			},
			options.merge
		);
	}

	/**
	 * Applies character style fields (`fontFamily`, `fontWeight`, `italic`, `fontSize`, `tracking`,
	 * `leading`, `baselineShift`, `underline`, `strikethrough`, `null` to clear) and `fill` to
	 * [start, end) of text node `id` (default: all of it, which changes its own style). One undo step.
	 */
	setTextStyle(id: string, patch: Record<string, unknown>, range: { start?: number; end?: number } = {}, options: { merge?: string } = {}): VectorActionResult {
		return this.editTextNode(
			id,
			'Character Style',
			(n) => {
				const [a, b] = vectorTextRange(n.text, range.start, range.end);
				return styleVectorText(n, a, b, patch);
			},
			options.merge
		);
	}

	/**
	 * Applies character style fields (and `fill`) to the whole of every text node in `ids` (default:
	 * the selected text, including text inside selected groups), or a paragraph patch with
	 * `paragraph`. One undo step for all of them.
	 */
	styleTexts(patch: { style?: Record<string, unknown>; paragraph?: Record<string, unknown> }, options: { ids?: readonly string[]; merge?: string } = {}): VectorActionResult {
		const targets: VectorTextNode[] = [];
		for (const id of options.ids ?? this.selection) {
			const n = this.getNode(id);
			if (!n) return { ok: false, message: `There is no node "${id}".` };
			walkVectorNodes([n], (c) => {
				if (c.type === 'text' && !c.blendStep && !targets.includes(c)) targets.push(c);
			});
		}
		if (!targets.length) return { ok: false, message: 'Select text to style.' };
		const next = new Map<string, VectorNode>();
		try {
			for (const t of targets) {
				let n = t;
				if (patch.style) n = styleVectorText(n, 0, n.text.length, patch.style);
				if (patch.paragraph) {
					const paragraph = patchVectorParagraphStyle(n.paragraph ?? {}, patch.paragraph);
					n = { ...n, paragraph };
					if (!Object.keys(paragraph).length) delete (n as Partial<VectorTextNode>).paragraph;
				}
				next.set(t.id, n);
			}
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
		this.change(patch.paragraph && !patch.style ? 'Paragraph Style' : 'Character Style', () => this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n)), options.merge);
		return { ok: true };
	}

	/** Changes paragraph fields (`align`, `autoLeading`, indents, spacing; `null` clears) of text node `id`. One undo step. */
	setParagraphStyle(id: string, patch: Record<string, unknown>, options: { merge?: string } = {}): VectorActionResult {
		return this.editTextNode(
			id,
			'Paragraph Style',
			(n) => {
				const paragraph = patchVectorParagraphStyle(n.paragraph ?? {}, patch);
				const next = { ...n, paragraph };
				if (!Object.keys(paragraph).length) delete (next as Partial<VectorTextNode>).paragraph;
				return next;
			},
			options.merge
		);
	}

	/**
	 * Changes how text node `id` is set: `point` (keeps where its first line starts), `area` (a box:
	 * `width` / `height` default to its current size, `x` / `y` to its top left) or `path` options
	 * (`start`, `end`, `flip`, `orientation`, `baseline`; a new `path` needs path data or a subpath in
	 * the node's own space). One undo step.
	 */
	setTextFrame(id: string, patch: Record<string, unknown>): VectorActionResult {
		return this.editTextNode(id, 'Text Frame', (n) => {
			const kind = (patch.kind as string | undefined) ?? n.frame.kind;
			const layout = layoutVectorText(n);
			const cur = n.frame;
			const box = layout.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
			let frame: VectorTextFrame;
			if (kind === 'point') {
				const first = layout.lines[0];
				const x = (patch.x as number | undefined) ?? (cur.kind === 'point' ? cur.x : (first?.x ?? box.x));
				const y = (patch.y as number | undefined) ?? (cur.kind === 'point' ? cur.y : (first?.baseline ?? box.y));
				frame = sanitizeVectorTextFrame({ kind: 'point', x, y });
				// Point text has no wrap: the left edge stays where the lines started.
				if (cur.kind !== 'point' && first && n.paragraph?.align && n.paragraph.align !== 'left') frame = sanitizeVectorTextFrame({ kind: 'point', x: box.x, y });
			} else if (kind === 'area') {
				const base = cur.kind === 'area' ? cur : { x: box.x, y: box.y, width: Math.max(box.width, n.font.fontSize), height: Math.max(box.height, n.font.fontSize * 1.2) };
				frame = sanitizeVectorTextFrame({ kind: 'area', x: patch.x ?? base.x, y: patch.y ?? base.y, width: patch.width ?? base.width, height: patch.height ?? base.height });
			} else if (kind === 'path') {
				let path = patch.path ?? (cur.kind === 'path' ? cur.path : undefined);
				if (typeof path === 'string') path = pathTextFrameFromBezier(toBezierPathLoose(path)) ?? undefined;
				if (!path) throw new VectorTextError('Pass path (SVG path data or a subpath) to set text on a path, or use vector.typeOnPath with a path node.');
				const { kind: _k, path: _p, ...options } = patch;
				const keep = cur.kind === 'path' ? { start: cur.start, end: cur.end, flip: cur.flip, orientation: cur.orientation, baseline: cur.baseline } : {};
				frame = sanitizeVectorTextFrame({ ...keep, ...options, kind: 'path', path });
			} else throw new VectorTextError(`kind must be point, area or path, got ${JSON.stringify(kind)}.`);
			return { ...n, frame };
		});
	}

	/**
	 * Turns path `pathId` into text set along it (Type on a Path): a text node in its place, its
	 * anchors the text's path, its paint dropped for the text defaults (or `input`'s). Returns the
	 * text's id, or an error.
	 */
	typeOnPath(pathId: string, input: Partial<VectorTextInput> = {}): VectorActionResult & { id?: string } {
		const node = this.getNode(pathId);
		if (!node) return { ok: false, message: `There is no node "${pathId}".` };
		if (node.type !== 'path' || !node.subpaths.length || node.subpaths[0].anchors.length < 2) return { ok: false, message: `"${pathId}" is not a path with at least two anchors; type on a path needs one.` };
		let text: VectorTextNode;
		try {
			text = this.createTextNode({ ...input, text: input.text ?? '', path: node.subpaths[0] });
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
		const placed: VectorTextNode = { ...text, ...(node.transform ? { transform: node.transform } : {}), ...(node.name && node.name !== 'Path' ? { name: node.name } : {}) };
		this.change('Type on a Path', () => {
			this.replaceNode(pathId, placed);
			this.selection = [placed.id];
			this.anchors = [];
			if (this.editingId === pathId) this.editingId = null;
		});
		return { ok: true, id: placed.id };
	}

	/**
	 * Create Outlines: turns text into paths of its glyph outlines (one compound path, or a group
	 * with one per run fill), keeping its paint, effects, filters and placement. Needs an outline
	 * text shaper. Returns the new nodes' ids, or an error.
	 */
	createOutlines(options: { ids?: readonly string[] } = {}): VectorActionResult & { ids?: string[] } {
		const list = options.ids ?? this.selection;
		const targets: VectorTextNode[] = [];
		for (const id of list) {
			const n = this.getNode(id);
			if (!n) return { ok: false, message: `There is no node "${id}".` };
			if (n.type === 'text') targets.push(n);
			else walkVectorNodes([n], (c) => {
				if (c.type === 'text') targets.push(c);
			});
		}
		if (!targets.length) return { ok: false, message: 'Select text to outline.' };
		if (!vectorTextHasOutlines()) {
			return {
				ok: false,
				message: `The text shaper "${getVectorTextShaper().id}" gives no glyph outlines. Load a font file and set an outline shaper (createOutlineTextShaper with parseOpenTypeFont) to create outlines.`
			};
		}
		const replaced = new Map<string, VectorNode>();
		for (const t of targets) {
			const parts = vectorTextPaths(t).parts;
			const keep = {
				...(t.name ? { name: t.name } : {}),
				...(t.transform ? { transform: t.transform } : {}),
				...(t.visible === false ? { visible: false } : {}),
				...(t.locked ? { locked: true } : {}),
				...(t.opacity !== undefined ? { opacity: t.opacity } : {}),
				...(t.blendMode ? { blendMode: t.blendMode } : {}),
				...(t.filters?.length ? { filters: t.filters } : {}),
				...(t.effects?.length ? { effects: t.effects } : {}),
				...(t.booleanOperation ? { booleanOperation: t.booleanOperation } : {})
			};
			const pathOf = (fill: VectorTextNode['fill'] | undefined, path: BezierPath, id: string): VectorPathNode => {
				const { transform: _t, visible: _v, locked: _l, opacity: _o, blendMode: _b, filters: _f, effects: _e, booleanOperation: _bo, name: _n, ...style } = vectorTextPaintSource(t, fill, bezierToSubpaths(path));
				return { ...style, id };
			};
			if (parts.length <= 1) replaced.set(t.id, { ...pathOf(parts[0]?.fill, parts[0]?.path ?? [], t.id), ...keep });
			else replaced.set(t.id, { id: t.id, type: 'group', ...keep, children: parts.map((p) => ({ ...pathOf(p.fill, p.path, this.newId()), name: 'Outlines' })) });
		}
		if (this.textEdit && replaced.has(this.textEdit.nodeId)) this.endTextEdit();
		this.change('Create Outlines', () => this.setDoc(mapTree(this.doc.nodes, (n) => replaced.get(n.id) ?? n)));
		return { ok: true, ids: [...replaced.keys()] };
	}

	/** The layout of text node `id` (lines, glyphs, bounds, overflow), or null. */
	getTextLayout(id: string): VectorTextLayout | null {
		const node = this.getNode(id);
		return node?.type === 'text' ? layoutVectorText(node) : null;
	}

	// --- Editing on the canvas ------------------------------------------------

	/**
	 * Starts editing text node `id` on the canvas (the caret at `index`, default the end; or a
	 * selection from `anchor` to `focus`). Typing goes to `textInput`, keys to `keyDown`.
	 */
	editText(id: string, options: { index?: number; anchor?: number; focus?: number } = {}): VectorActionResult {
		const node = this.textNode(id);
		if (typeof node === 'string') return { ok: false, message: node };
		if (this.textEdit?.nodeId !== id) this.endTextEdit();
		const n = node.text.length;
		const clamp = (v: number | undefined, d: number) => Math.max(0, Math.min(n, v ?? d));
		const focus = clamp(options.focus ?? options.index, n);
		const anchor = clamp(options.anchor, focus);
		this.textEdit = { nodeId: id, anchor, focus, before: this.textEdit?.nodeId === id ? this.textEdit.before : null, key: this.textEdit?.nodeId === id ? this.textEdit.key : `text-edit:${id}:${++this.textEditCount}`, created: this.textEdit?.nodeId === id ? this.textEdit.created : false };
		this.selection = [id];
		this.anchors = [];
		this.notify();
		return { ok: true };
	}

	/** Moves the caret or selection of the text being edited. */
	selectText(anchor: number, focus: number = anchor): void {
		const t = this.textEdit;
		const node = t ? this.getNode(t.nodeId) : null;
		if (!t || node?.type !== 'text') return;
		const n = node.text.length;
		this.textEdit = { ...t, anchor: Math.max(0, Math.min(n, anchor)), focus: Math.max(0, Math.min(n, focus)) };
		this.notify();
	}

	/**
	 * Ends the text edit session. Text it created and left empty is removed (with no undo step when
	 * nothing was typed); other emptied text is deleted as its own step.
	 */
	endTextEdit(): void {
		const t = this.textEdit;
		if (!t) return;
		this.textEdit = null;
		this.history.endGesture();
		const node = this.getNode(t.nodeId);
		if (node?.type === 'text' && !node.text) {
			if (t.before) {
				this.doc = t.before.doc;
				this.selection = t.before.selection.filter((id) => this.getNode(id));
				this.notify(true);
				return;
			}
			if (t.created) {
				this.change('Delete Text', () => {
					this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === t.nodeId ? null : n)));
					this.selection = this.selection.filter((id) => id !== t.nodeId);
				});
				return;
			}
		}
		this.notify();
	}

	/** Types `text` over the selection of the text being edited (one undo step per session). */
	textInput(text: string): VectorActionResult {
		const t = this.textEdit;
		if (!t) return { ok: false, message: 'No text is being edited.' };
		const a = Math.min(t.anchor, t.focus);
		const b = Math.max(t.anchor, t.focus);
		const clean = text.replace(/\r\n?/g, '\n');
		const r = this.setText(t.nodeId, clean, { start: a, end: b }, { merge: t.key });
		if (r.ok && this.textEdit) {
			this.textEdit = { ...this.textEdit, anchor: a + clean.length, focus: a + clean.length };
			this.notify();
		}
		return r;
	}

	/** Deletes the selection, or one character (a whole surrogate pair) before or after the caret. */
	private textDelete(forward: boolean, word = false): void {
		const t = this.textEdit;
		const node = t ? this.getNode(t.nodeId) : null;
		if (!t || node?.type !== 'text') return;
		let a = Math.min(t.anchor, t.focus);
		let b = Math.max(t.anchor, t.focus);
		if (a === b) {
			if (forward) b = word ? wordEdge(node.text, b, 1) : nextIndex(node.text, b);
			else a = word ? wordEdge(node.text, a, -1) : prevIndex(node.text, a);
		}
		if (a === b) return;
		if (this.setText(t.nodeId, '', { start: a, end: b }, { merge: t.key }).ok && this.textEdit) {
			this.textEdit = { ...this.textEdit, anchor: a, focus: a };
			this.notify();
		}
	}

	/** Keys while text is being edited: caret movement, deleting, Enter, Escape and style shortcuts. */
	private textKey(input: VectorKeyInput): boolean {
		const t = this.textEdit!;
		const node = this.getNode(t.nodeId);
		if (node?.type !== 'text') {
			this.textEdit = null;
			return false;
		}
		const text = node.text;
		const key = input.key;
		const move = (to: number) => {
			const focus = Math.max(0, Math.min(text.length, to));
			this.textEdit = { ...t, focus, anchor: input.shift ? t.anchor : focus };
			this.notify();
			return true;
		};
		const a = Math.min(t.anchor, t.focus);
		const b = Math.max(t.anchor, t.focus);
		const collapsed = a === b;
		if (input.mod) {
			const lower = key.toLowerCase();
			if (lower === 'a') {
				this.textEdit = { ...t, anchor: 0, focus: text.length };
				this.notify();
				return true;
			}
			const toggle = lower === 'b' ? 'bold' : lower === 'i' ? 'italic' : lower === 'u' ? 'underline' : null;
			if (toggle && !collapsed) {
				const style = vectorTextStyleOf(node, a);
				const patch = toggle === 'bold' ? { fontWeight: style.fontWeight >= 600 ? 400 : 700 } : toggle === 'italic' ? { italic: !style.italic } : { underline: !style.underline };
				this.setTextStyle(node.id, patch, { start: a, end: b });
				return true;
			}
			if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') return move(key === 'ArrowLeft' || key === 'ArrowUp' ? 0 : text.length);
			if (key === 'Backspace' || key === 'Delete') {
				this.textDelete(key === 'Delete', true);
				return true;
			}
			// Undo, redo and the clipboard keep working; other shortcuts wait until editing ends.
			return !['z', 'y', 'c', 'x', 'v'].includes(lower);
		}
		switch (key) {
			case 'Escape':
				this.endTextEdit();
				if (this.getNode(t.nodeId)) this.select([t.nodeId]);
				return true;
			case 'Enter':
				if (input.alt || input.shift) return false;
				this.textInput('\n');
				return true;
			case 'Tab':
				this.textInput('\t');
				return true;
			case 'Backspace':
				this.textDelete(false, !!input.alt);
				return true;
			case 'Delete':
				this.textDelete(true, !!input.alt);
				return true;
			case 'ArrowLeft':
				if (!collapsed && !input.shift) return move(a);
				return move(input.alt ? wordEdge(text, t.focus, -1) : prevIndex(text, t.focus));
			case 'ArrowRight':
				if (!collapsed && !input.shift) return move(b);
				return move(input.alt ? wordEdge(text, t.focus, 1) : nextIndex(text, t.focus));
			case 'ArrowUp':
			case 'ArrowDown':
				return move(this.lineMove(node, t.focus, key === 'ArrowUp' ? -1 : 1));
			case 'Home':
			case 'End': {
				const layout = layoutVectorText(node);
				const line = layout.text.lines[vectorTextCaret(node, t.focus).line];
				if (!line) return move(key === 'Home' ? 0 : text.length);
				return move(key === 'Home' ? line.start : line.end);
			}
		}
		// Printable characters normally arrive through `textInput` (the canvases' hidden textarea);
		// typed into the canvas itself, they go in here.
		if (key.length === 1) {
			this.textInput(key);
			return true;
		}
		return false;
	}

	/** The selected characters of the text being edited ('' when the selection is collapsed), or null when not editing. */
	getSelectedText(): string | null {
		const t = this.textEdit;
		const node = t ? this.getNode(t.nodeId) : null;
		if (!t || node?.type !== 'text') return null;
		return node.text.slice(Math.min(t.anchor, t.focus), Math.max(t.anchor, t.focus));
	}

	/** Cut while editing text: returns the selected characters and deletes them (null when not editing). */
	cutText(): string | null {
		const text = this.getSelectedText();
		if (text) this.textInput('');
		return text;
	}

	/** The index one line up or down from `index`, at the same x (start or end of the text past the first or last line). */
	private lineMove(node: VectorTextNode, index: number, dir: -1 | 1): number {
		const layout = layoutVectorText(node);
		if (node.frame.kind === 'path') return dir < 0 ? 0 : node.text.length;
		const c = vectorTextCaret(node, index);
		const lines = layout.text.lines;
		const target = lines[c.line + dir];
		if (!target) return dir < 0 ? 0 : node.text.length;
		return vectorTextIndexAt(node, { x: c.top.x, y: layout.origin.y + target.baseline });
	}

	/** The topmost node of `type` under `p` (inside groups too, hit where it draws), or null. */
	private hitOfType<K extends 'instance'>(p: Vec2, type: K): Extract<VectorNode, { type: K }> | null {
		const tol = this.tolerance();
		const search = (list: readonly VectorNode[], parent: AffineMatrix): Extract<VectorNode, { type: K }> | null => {
			for (let i = list.length - 1; i >= 0; i--) {
				const n = list[i];
				if (n.visible === false || n.locked) continue;
				if (n.type === type) {
					if (hitTestVectorNode(n, p, tol, parent)) return n as Extract<VectorNode, { type: K }>;
				} else if (n.type === 'group' && hitTestVectorNode(n, p, tol, parent)) {
					const found = search(n.children, multiplyMatrices(nodeMatrix(n), parent));
					if (found) return found;
				}
			}
			return null;
		};
		return search(this.doc.nodes, IDENTITY_MATRIX);
	}

	/** The topmost text node under `p` (inside groups too), or null. */
	private hitText(p: Vec2): VectorTextNode | null {
		const tol = this.tolerance();
		const search = (list: readonly VectorNode[], parent: AffineMatrix): VectorTextNode | null => {
			for (let i = list.length - 1; i >= 0; i--) {
				const n = list[i];
				if (n.visible === false || n.locked || n.blendStep) continue;
				if (n.type === 'group') {
					const found = search(n.children, multiplyMatrices(nodeMatrix(n), parent));
					if (found) return found;
				} else if (n.type === 'text') {
					// Text is picked by its glyph boxes or (area text) its frame, so gaps between letters still hit.
					const local = applyMatrix(invertMatrix(multiplyMatrices(nodeMatrix(n), parent)), p);
					const b = layoutVectorText(n).bounds;
					if (b && local.x >= b.x - tol && local.x <= b.x + b.width + tol && local.y >= b.y - tol && local.y <= b.y + b.height + tol) {
						if (n.frame.kind !== 'path' || hitTestVectorNode(n, p, tol + 4, parent)) return n;
					}
				}
			}
			return null;
		};
		return search(this.doc.nodes, IDENTITY_MATRIX);
	}

	/** A text node created for the edit session (no undo step until something is typed). */
	private startNewText(node: VectorTextNode, replace?: string): void {
		this.endTextEdit();
		const before = this.snapshot();
		if (replace) this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === replace ? node : n)));
		else this.setDoc([...this.doc.nodes, node]);
		this.selection = [node.id];
		this.anchors = [];
		this.textEdit = { nodeId: node.id, anchor: 0, focus: 0, before, key: `text-edit:${node.id}:${++this.textEditCount}`, created: true };
		this.notify();
	}

	private downType(p: Vec2, input: VectorPointerInput) {
		const text = this.hitText(p);
		if (text) {
			const index = vectorTextIndexAt(text, this.toLocal(text.id, p));
			if (this.textEdit?.nodeId === text.id) {
				this.textEdit = { ...this.textEdit, focus: index, anchor: input.shift ? this.textEdit.anchor : index };
				this.notify();
			} else this.editText(text.id, { index });
			this.drag = { kind: 'textSelect', nodeId: text.id };
			this.interaction = { type: 'textSelect', nodeId: text.id };
			return;
		}
		if (this.textEdit) {
			// A click outside the text being edited ends the session.
			this.endTextEdit();
			if (this.tool === 'type') {
				this.clearSelection();
				return;
			}
		}
		if (this.tool === 'typePath') {
			const path = this.hitPath(p);
			if (!path || path.subpaths[0]?.anchors.length < 2 || hiddenOrLocked(this.doc.nodes, path.id)) return;
			// The path's own space is the text's: its anchors become the text's path as they are.
			let node: VectorTextNode;
			try {
				node = this.createTextNode({ text: '', path: path.subpaths[0] });
			} catch {
				return;
			}
			this.startNewText({ ...node, ...(path.transform ? { transform: path.transform } : {}) }, path.id);
			return;
		}
		this.drag = { kind: 'textBox', start: p, moved: false };
		this.interaction = { type: 'textBox', bounds: { x: p.x, y: p.y, width: 0, height: 0 } };
		this.notify();
	}

	private upTypeBox(drag: Extract<Drag, { kind: 'textBox' }>) {
		const p = this.pointer ?? drag.start;
		const box = boundsFromPoints(drag.start, p);
		const area = drag.moved && box.width > 2 && box.height > 2;
		const node = this.createTextNode(area ? { text: '', x: box.x, y: box.y, width: box.width, height: box.height } : { text: '', x: drag.start.x, y: drag.start.y });
		this.startNewText(node);
	}


	// -------------------------------------------------------------------------
	// Symbols and instances
	// -------------------------------------------------------------------------

	/** The whole document: in isolation mode, the host with the edited symbol's art. */
	private storedDocument(): VectorDocument {
		const edit = this.symbolEdit;
		if (!edit) return this.doc;
		const symbols = (edit.host.symbols ?? []).map((s) => (s.id === edit.symbolId ? { ...s, nodes: this.doc.nodes } : (this.doc.symbols?.find((x) => x.id === s.id) ?? s)));
		return resolveVectorSymbols({ ...edit.host, symbols });
	}

	private symbolEditState(): VectorEditorState['symbolEdit'] {
		const edit = this.symbolEdit;
		if (!edit) return null;
		const host = this.storedDocument();
		const sym = host.symbols?.find((s) => s.id === edit.symbolId);
		// The document in symbol space, lined up with the instance by its origin and scale (the art
		// shows unrotated and unskewed: a view cannot turn).
		const hostTransform: VectorMatrix | null = edit.origin ? ([1 / edit.scale, 0, 0, 1 / edit.scale, -edit.origin.x / edit.scale + 0, -edit.origin.y / edit.scale + 0] as const) : null;
		return { symbolId: edit.symbolId, name: sym?.name ?? edit.symbolId, instanceId: edit.instanceId, host, hostTransform };
	}

	/** The document's symbols (the stored ones, also while one is being edited). */
	getSymbols(): readonly VectorSymbol[] {
		return this.storedDocument().symbols ?? [];
	}

	/** Ids of the instances of symbol `symbolId` in the whole document (inside other symbols too). */
	getSymbolInstances(symbolId: string): string[] {
		const doc = this.storedDocument();
		const out: string[] = [];
		const visit = (list: readonly VectorNode[]) => {
			for (const n of list) {
				if (n.type === 'instance' && n.symbolId === symbolId) out.push(n.id);
				if (n.type === 'group') visit(n.children);
			}
		};
		visit(doc.nodes);
		for (const s of doc.symbols ?? []) visit(s.nodes);
		return out;
	}

	private newSymbolId(): string {
		const used = new Set(this.getSymbols().map((s) => s.id));
		let id = `symbol-${this.createId()}`;
		while (used.has(id)) id = `symbol-${this.createId()}`;
		return id;
	}

	/**
	 * Make Symbol: turns the selected (or given) objects, which must share a parent, into a new
	 * symbol whose registration point is their centre, and puts an instance in their place. One
	 * undo step. Returns the symbol's and the instance's ids.
	 */
	makeSymbol(options: { ids?: readonly string[]; name?: string } = {}): VectorActionResult & { symbolId?: string; instanceId?: string } {
		const ids = options.ids ?? this.selectedRoots();
		if (!ids.length) return { ok: false, message: 'Select the objects to make a symbol from.' };
		const locs = ids.map((id) => locateVectorNode(this.doc.nodes, id));
		if (locs.some((l) => !l)) return { ok: false, message: `There is no node "${ids[locs.findIndex((l) => !l)]}".` };
		const parent = locs[0]!.parent?.id ?? null;
		if (locs.some((l) => (l!.parent?.id ?? null) !== parent)) return { ok: false, message: 'The objects must share a parent (the same group) to make one symbol.' };
		if (ids.some((id) => hiddenOrLocked(this.doc.nodes, id))) return { ok: false, message: 'Unlock and show the objects first.' };
		const parentMatrix = parent ? this.worldOf(parent) : IDENTITY_MATRIX;
		const box = unionBounds(ids.map((id) => vectorNodeBounds(this.getNode(id)!, IDENTITY_MATRIX)));
		if (!box) return { ok: false, message: 'The objects have no geometry to make a symbol from.' };
		void parentMatrix;
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		const symbolId = this.newSymbolId();
		const instanceId = this.newId();
		const name = options.name?.trim() || `Symbol ${this.getSymbols().length + 1}`;
		const set = new Set(ids);
		this.change('Make Symbol', () => {
			const replace = (list: readonly VectorNode[]): VectorNode[] => {
				const members = list.filter((n) => set.has(n.id));
				const top = Math.max(...members.map((m) => list.indexOf(m)));
				const art = members.map((n) => transformVectorNode(n, translateMatrix(-cx, -cy)));
				this.doc = { ...this.doc, symbols: [...(this.doc.symbols ?? []), { id: symbolId, name, nodes: art }] };
				const out: VectorNode[] = [];
				list.forEach((n, i) => {
					if (i === top) out.push({ id: instanceId, type: 'instance', name, symbolId, transform: translateMatrix(cx, cy) });
					if (!set.has(n.id)) out.push(n);
				});
				return out;
			};
			if (parent === null) this.setDoc(replace(this.doc.nodes));
			else this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === parent && n.type === 'group' ? { ...n, children: replace(n.children) } : n)));
			this.selection = [instanceId];
			this.anchors = [];
		});
		return { ok: true, symbolId, instanceId };
	}

	/**
	 * Places an instance of symbol `symbolId` with its registration point at (`x`, `y`) (default the
	 * artboard's centre), or through `transform`. One undo step. Returns its id.
	 */
	placeSymbol(symbolId: string, options: { x?: number; y?: number; transform?: VectorMatrix; name?: string; parentId?: string } = {}): VectorActionResult & { id?: string } {
		const sym = this.getSymbols().find((s) => s.id === symbolId);
		if (!sym) return { ok: false, message: `There is no symbol "${symbolId}"; vector.listSymbols lists them.` };
		if (this.symbolEdit && (symbolId === this.symbolEdit.symbolId || vectorSymbolUses(this.getSymbols(), symbolId, this.symbolEdit.symbolId))) {
			return { ok: false, message: `"${sym.name}" would contain itself: a symbol cannot hold an instance of itself.` };
		}
		const t = options.transform ?? translateMatrix(options.x ?? this.doc.width / 2, options.y ?? this.doc.height / 2);
		if (!t.every(Number.isFinite)) return { ok: false, message: 'transform must be six finite numbers [a, b, c, d, e, f].' };
		const node: VectorInstanceNode = { id: this.newId(), type: 'instance', name: options.name ?? sym.name, symbolId, ...(isIdentityMatrix(t) ? {} : { transform: [...t] as unknown as VectorMatrix }) };
		const id = this.addNode(node, { label: 'Place Symbol', ...(options.parentId ? { parentId: options.parentId } : {}) });
		return { ok: true, id };
	}

	private instanceTargets(ids: readonly string[] | undefined): VectorInstanceNode[] | string {
		const list = ids ?? this.selection;
		if (!list.length) return 'Select an instance.';
		const out: VectorInstanceNode[] = [];
		for (const id of list) {
			const n = this.getNode(id);
			if (!n) return `There is no node "${id}".`;
			if (n.type !== 'instance') return `"${id}" is a ${n.type}, not a symbol instance.`;
			out.push(n);
		}
		return out;
	}

	/**
	 * Detach: replaces instances by groups of their symbol's art as drawn (placed, strokes scaled,
	 * overrides applied), unlinked from the symbol. One undo step. Returns the groups' ids (the
	 * instances' own).
	 */
	detachInstances(options: { ids?: readonly string[] } = {}): VectorActionResult & { ids?: string[] } {
		const targets = this.instanceTargets(options.ids);
		if (typeof targets === 'string') return { ok: false, message: targets };
		const next = new Map<string, VectorNode>();
		for (const t of targets) {
			const drawn = vectorInstanceDrawn(t);
			const fresh = this.freshIds(drawn);
			next.set(t.id, { ...fresh, id: t.id, name: t.name ?? 'Group' });
		}
		this.change('Detach Instance', () => this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n)));
		return { ok: true, ids: [...next.keys()] };
	}

	/** Replace Symbol: instances draw symbol `symbolId` instead, keeping their placement. One undo step. */
	replaceSymbol(symbolId: string, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const targets = this.instanceTargets(options.ids);
		if (typeof targets === 'string') return { ok: false, message: targets };
		const sym = this.getSymbols().find((s) => s.id === symbolId);
		if (!sym) return { ok: false, message: `There is no symbol "${symbolId}"; vector.listSymbols lists them.` };
		if (this.symbolEdit && (symbolId === this.symbolEdit.symbolId || vectorSymbolUses(this.getSymbols(), symbolId, this.symbolEdit.symbolId))) return { ok: false, message: `"${sym.name}" would contain itself.` };
		const set = new Set(targets.map((t) => t.id));
		this.change('Replace Symbol', () =>
			this.setDoc(
				mapTree(this.doc.nodes, (n) => {
					if (!set.has(n.id) || n.type !== 'instance') return n;
					const { art: _a, ...rest } = n;
					const hidden = n.overrides?.hidden;
					// Hidden art ids belong to the old symbol.
					const overrides = n.overrides ? { ...n.overrides } : null;
					if (overrides && hidden) delete overrides.hidden;
					return { ...rest, symbolId, ...(overrides && Object.keys(overrides).length ? { overrides } : { overrides: undefined }) } as VectorNode;
				})
			)
		);
		return { ok: true };
	}

	/**
	 * Instance options: `scaleStrokes` (strokes of the art scale with the instance), and overrides —
	 * `fill` / `stroke` (every fill or stroke of the art in one paint; `null` clears), `hidden` (art
	 * node ids not drawn). One undo step.
	 */
	setInstanceOptions(patch: { scaleStrokes?: boolean; fill?: VectorPaint | null; stroke?: VectorPaint | null; hidden?: string[] | null }, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const targets = this.instanceTargets(options.ids);
		if (typeof targets === 'string') return { ok: false, message: targets };
		const next = new Map<string, VectorNode>();
		for (const t of targets) {
			const n: VectorInstanceNode = { ...t };
			if (patch.scaleStrokes !== undefined) {
				if (patch.scaleStrokes) delete n.scaleStrokes;
				else n.scaleStrokes = false;
			}
			const o: VectorInstanceOverrides = { ...(t.overrides ?? {}) };
			for (const key of ['fill', 'stroke'] as const) {
				if (patch[key] === undefined) continue;
				if (patch[key] === null) delete o[key];
				else o[key] = patch[key] as VectorPaint;
			}
			if (patch.hidden !== undefined) {
				if (patch.hidden?.length) {
					const known = new Set<string>();
					walkVectorNodes(t.art ?? [], (a) => known.add(a.id));
					const unknown = patch.hidden.filter((id) => !known.has(id));
					if (unknown.length) return { ok: false, message: `The symbol's art has no nodes ${unknown.map((u) => `"${u}"`).join(', ')}; vector.listSymbols lists its node ids.` };
					o.hidden = [...patch.hidden];
				} else delete o.hidden;
			}
			if (Object.keys(o).length) n.overrides = o;
			else delete n.overrides;
			next.set(t.id, n);
		}
		this.change('Instance Options', () => this.setDoc(mapTree(this.doc.nodes, (n) => next.get(n.id) ?? n)));
		return { ok: true };
	}

	/** Renames symbol `symbolId`. One undo step. */
	renameSymbol(symbolId: string, name: string): VectorActionResult {
		const trimmed = name.trim();
		if (!trimmed) return { ok: false, message: 'A symbol needs a name.' };
		if (!this.getSymbols().some((s) => s.id === symbolId)) return { ok: false, message: `There is no symbol "${symbolId}".` };
		this.change('Rename Symbol', () => {
			this.doc = { ...this.doc, symbols: (this.doc.symbols ?? []).map((s) => (s.id === symbolId ? { ...s, name: trimmed } : s)) };
			if (this.symbolEdit) this.symbolEdit = { ...this.symbolEdit, host: { ...this.symbolEdit.host, symbols: (this.symbolEdit.host.symbols ?? []).map((s) => (s.id === symbolId ? { ...s, name: trimmed } : s)) } };
		});
		return { ok: true };
	}

	/**
	 * Deletes symbol `symbolId`. With instances in use it refuses unless `detach` (they become plain
	 * groups first). One undo step.
	 */
	deleteSymbol(symbolId: string, options: { detach?: boolean } = {}): VectorActionResult {
		if (this.symbolEdit) return { ok: false, message: 'Leave the symbol being edited first (exitSymbolEdit).' };
		const sym = this.getSymbols().find((s) => s.id === symbolId);
		if (!sym) return { ok: false, message: `There is no symbol "${symbolId}".` };
		const used = this.getSymbolInstances(symbolId);
		if (used.length && !options.detach) return { ok: false, message: `"${sym.name}" has ${used.length} instance${used.length === 1 ? '' : 's'}; pass detach to turn them into groups, or delete them first.` };
		const before = this.snapshot();
		const detach = (list: VectorNode[]): VectorNode[] =>
			list.map((n) => {
				if (n.type === 'instance' && n.symbolId === symbolId) return { ...this.freshIds(vectorInstanceDrawn(n)), id: n.id, name: n.name ?? 'Group' };
				if (n.type === 'group') return { ...n, children: detach(n.children) };
				return n;
			});
		this.doc = { ...this.doc, nodes: detach(this.doc.nodes), symbols: (this.doc.symbols ?? []).filter((s) => s.id !== symbolId).map((s) => ({ ...s, nodes: detach(s.nodes) })) };
		this.commit('Delete Symbol', before);
		return { ok: true };
	}

	/**
	 * Edit Symbol (isolation mode): the document becomes the art of symbol `id` (or of instance `id`'s
	 * symbol), in its own space; everything else draws dimmed behind it. Edits are ordinary undo
	 * steps; `exitSymbolEdit` returns to the document with every instance updated.
	 */
	editSymbol(id: string): VectorActionResult {
		const node = this.getNode(id);
		const symbolId = node?.type === 'instance' ? node.symbolId : id;
		const host = this.storedDocument();
		const sym = host.symbols?.find((s) => s.id === symbolId);
		if (!sym) return { ok: false, message: node ? `"${id}" is a ${node.type}, not a symbol instance.` : `There is no symbol or instance "${id}".` };
		if (this.symbolEdit) this.exitSymbolEdit();
		this.endTextEdit();
		this.finishPath();
		const fresh = this.storedDocument();
		let origin: Vec2 | null = null;
		let scale = 1;
		const world = node?.type === 'instance' ? vectorWorldMatrix(fresh.nodes, node.id) : null;
		if (world) {
			const det = Math.abs(world[0] * world[3] - world[1] * world[2]);
			if (det > 1e-12) {
				origin = { x: world[4], y: world[5] };
				scale = Math.sqrt(det);
			}
		}
		this.symbolEdit = { symbolId, instanceId: origin ? node!.id : null, host: fresh, origin, scale };
		// The view follows: the art's origin where the instance's was, at its scale.
		if (origin) this.viewport = this.viewInto(this.symbolEdit);
		this.doc = { width: fresh.width, height: fresh.height, ...(fresh.background ? { background: fresh.background } : {}), nodes: sym.nodes, symbols: fresh.symbols };
		this.selection = [];
		this.anchors = [];
		this.editingId = null;
		this.notify();
		return { ok: true };
	}

	/** The view inside isolation mode for the current (document) view. */
	private viewInto(edit: SymbolEditContext): VectorViewport {
		const v = this.viewport;
		if (!edit.origin) return v;
		return { x: v.zoom * edit.origin.x + v.x, y: v.zoom * edit.origin.y + v.y, zoom: v.zoom * edit.scale };
	}

	/** The document's view for the current view inside isolation mode. */
	private viewOutOf(edit: SymbolEditContext): VectorViewport {
		const v = this.viewport;
		if (!edit.origin) return v;
		const zoom = v.zoom / edit.scale;
		return { x: v.x - zoom * edit.origin.x, y: v.y - zoom * edit.origin.y, zoom };
	}

	/** Leaves isolation mode: back to the whole document, the symbol's instances showing the edits. */
	exitSymbolEdit(): void {
		if (!this.symbolEdit) return;
		this.endTextEdit();
		this.finishPath();
		const { instanceId, origin } = this.symbolEdit;
		// Back to the document's view, where it was.
		if (origin) this.viewport = this.viewOutOf(this.symbolEdit);
		this.doc = this.storedDocument();
		this.symbolEdit = null;
		this.selection = instanceId && this.getNode(instanceId) ? [instanceId] : [];
		this.anchors = [];
		this.editingId = null;
		this.history.endGesture();
		this.notify(true);
	}


	// -------------------------------------------------------------------------
	// Constraints
	// -------------------------------------------------------------------------

	/** The document's constraints. */
	getConstraints(): readonly VectorConstraint[] {
		return this.doc.constraints ?? [];
	}

	/** The document's named parameters. */
	getParameters(): readonly VectorParameter[] {
		return this.doc.parameters ?? [];
	}

	/** Degrees of freedom the constraints leave, and whether any are redundant. */
	getConstraintDof(): VectorDofReport {
		return vectorConstraintDof(this.doc);
	}

	/**
	 * References from loose input to stable ones: anchors given by `subpath` / `index` get ids (the
	 * path is updated in `nodes`). Throws on a missing path or anchor.
	 */
	private resolveRefs(refs: readonly VectorConstraintRefInput[], nodes: Map<string, VectorPathNode>): VectorGeomRef[] {
		return refs.map((r, i) => {
			const node = nodes.get(r.nodeId) ?? (this.getNode(r.nodeId) as VectorNode | undefined);
			if (!node) throw new VectorConstraintError(`refs[${i}]: there is no node "${r.nodeId}".`);
			if (node.type !== 'path') throw new VectorConstraintError(`refs[${i}]: "${r.nodeId}" is a ${node.type}; constraints refer to paths.`);
			if (r.circle) return { nodeId: r.nodeId, circle: true };
			let anchor = r.anchor;
			if (anchor === undefined) {
				if (r.subpath === undefined || r.index === undefined) throw new VectorConstraintError(`refs[${i}]: give an anchor (subpath and index, or its id), or circle: true.`);
				const sp = node.subpaths[r.subpath];
				if (!sp?.anchors[r.index]) throw new VectorConstraintError(`refs[${i}]: "${r.nodeId}" has no anchor ${r.index} on subpath ${r.subpath}.`);
				const withIds = withVectorAnchorIds(node);
				nodes.set(node.id, withIds);
				anchor = withIds.subpaths[r.subpath].anchors[r.index].id!;
			} else if (!findVectorAnchorById(node, anchor)) throw new VectorConstraintError(`refs[${i}]: "${r.nodeId}" has no anchor "${anchor}".`);
			return { nodeId: r.nodeId, anchor, ...(r.handle ? { handle: r.handle } : {}), ...(r.segment ? { segment: true } : {}) };
		});
	}

	private newConstraintId(): string {
		const used = new Set((this.doc.constraints ?? []).map((c) => c.id));
		let id = `k${used.size + 1}`;
		for (let n = used.size + 1; used.has(id); n++) id = `k${n}`;
		return id;
	}

	/**
	 * Adds a constraint: refs by anchor (`subpath` / `index`, or its id), handle, segment or circle;
	 * dimensional kinds take a `value` expression (default: what the geometry measures now) and a
	 * `name`. Refuses (changing nothing) one that conflicts with the others or repeats them, naming
	 * them. One undo step. Returns the new constraint's id.
	 */
	addConstraint(input: VectorConstraintInput): VectorActionResult & { id?: string; ids?: string[] } {
		const nodes = new Map<string, VectorPathNode>();
		let refs: VectorGeomRef[];
		try {
			refs = this.resolveRefs(input.refs, nodes);
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
		const id = this.newConstraintId();
		const withIds = nodes.size ? { ...this.doc, nodes: mapTree(this.doc.nodes, (n) => nodes.get(n.id) ?? n) } : this.doc;
		let next: VectorDocument;
		try {
			next = addVectorConstraint(withIds, {
				id,
				kind: input.kind,
				refs,
				...(input.value !== undefined ? { value: String(input.value) } : {}),
				...(input.name ? { name: input.name } : {}),
				...(input.axis && input.axis !== 'aligned' ? { axis: input.axis } : {})
			});
		} catch (e) {
			if (e instanceof VectorConstraintError) return { ok: false, message: e.message, ids: e.ids };
			throw e;
		}
		this.change(`Add ${input.kind[0].toUpperCase()}${input.kind.slice(1)} Constraint`, () => {
			this.doc = next;
			this.lastSolved = next;
		});
		return { ok: true, id };
	}

	/** Removes constraints by id. One undo step. */
	removeConstraints(ids: readonly string[]): VectorActionResult {
		const set = new Set(ids);
		const missing = ids.filter((id) => !(this.doc.constraints ?? []).some((c) => c.id === id));
		if (missing.length) return { ok: false, message: `There is no constraint ${missing.map((m) => `"${m}"`).join(', ')}.` };
		this.change(ids.length === 1 ? 'Remove Constraint' : 'Remove Constraints', () => {
			const kept = (this.doc.constraints ?? []).filter((c) => !set.has(c.id));
			this.doc = { ...this.doc, constraints: kept };
			if (!kept.length) delete this.doc.constraints;
		});
		return { ok: true };
	}

	/**
	 * Sets a dimensional constraint's value expression (by id or name), or a named parameter's
	 * (creating it; `null` removes a parameter), then solves. Refuses (changing nothing) a value
	 * that does not evaluate or that the constraints cannot meet. One undo step.
	 */
	setConstraintValue(key: string, value: string | number | null, options: { merge?: string } = {}): VectorActionResult & { ids?: string[] } {
		const text = value === null ? null : String(value).trim();
		const cons = this.doc.constraints ?? [];
		const c = cons.find((x) => x.id === key || x.name === key);
		let trial: VectorDocument;
		if (c) {
			if (!VECTOR_DIMENSIONAL_KINDS.has(c.kind)) return { ok: false, message: `"${key}" is a ${c.kind} constraint, which has no value.` };
			if (text === null || text === '') return { ok: false, message: 'A dimensional constraint needs a value; remove the constraint instead.' };
			trial = { ...this.doc, constraints: cons.map((x) => (x === c ? { ...x, value: text } : x)) };
		} else {
			if (!isValidVectorParameterName(key)) return { ok: false, message: `"${key}" is not a constraint or a valid parameter name (a letter or _, then letters, digits or _).` };
			const params = this.doc.parameters ?? [];
			if (text === null) {
				if (!params.some((p) => p.name === key)) return { ok: false, message: `There is no parameter "${key}".` };
				trial = { ...this.doc, parameters: params.filter((p) => p.name !== key) };
			} else {
				trial = { ...this.doc, parameters: params.some((p) => p.name === key) ? params.map((p) => (p.name === key ? { ...p, value: text } : p)) : [...params, { name: key, value: text }] };
			}
		}
		try {
			if (text !== null) checkVectorExpression(text);
			// Every dimensional constraint must still evaluate.
			const env = vectorConstraintEnv(trial);
			for (const x of trial.constraints ?? []) if (VECTOR_DIMENSIONAL_KINDS.has(x.kind)) (x.name && env.has(x.name) ? env.value(x.name) : env.eval(x.value ?? ''));
		} catch (e) {
			return { ok: false, message: `${key}: ${e instanceof Error ? e.message : String(e)}` };
		}
		const r = solveVectorConstraints(trial, null);
		if (!r.converged) return { ok: false, message: `The constraints cannot meet ${key} = ${text}: it conflicts with ${[...new Set(r.conflicts)].map((i) => `"${i}"`).join(', ')}.`, ids: r.conflicts };
		this.change(c ? 'Constraint Value' : 'Parameter', () => {
			this.doc = r.document;
			this.lastSolved = r.document;
		}, options.merge);
		return { ok: true };
	}

	/**
	 * Auto-constrain: constraints the paths `ids` (default the selection, or every path) nearly
	 * satisfy, added one by one (redundant or conflicting ones skipped). One undo step. Returns the
	 * ids of the constraints added.
	 */
	autoConstrain(options: { ids?: readonly string[] } & VectorInferOptions = {}): VectorActionResult & { ids?: string[] } {
		const { ids, ...infer } = options;
		const roots = ids ?? (this.selection.length ? this.selection : null);
		if (roots) for (const id of roots) if (!this.getNode(id)) return { ok: false, message: `There is no node "${id}".` };
		const used = new Set((this.doc.constraints ?? []).map((c) => c.id));
		let n = used.size;
		const newId = () => {
			let id = `k${++n}`;
			while (used.has(id)) id = `k${++n}`;
			used.add(id);
			return id;
		};
		const pathIds = roots ? roots.flatMap((id) => collectPathNodes(this.getNode(id)!).map((p) => p.id)) : null;
		const r = autoConstrainVector(this.doc, pathIds, newId, infer);
		if (!r.added.length) return { ok: true, ids: [] };
		this.change('Auto Constrain', () => {
			this.doc = r.document;
			this.lastSolved = r.document;
		});
		return { ok: true, ids: r.added.map((c) => c.id) };
	}

	// -------------------------------------------------------------------------
	// Keyboard input
	// -------------------------------------------------------------------------

	/**
	 * Handles editor shortcuts. Returns true when the key was used (call `preventDefault`).
	 * Do not forward keys typed into text inputs.
	 */
	keyDown(input: VectorKeyInput): boolean {
		if (this.textEdit && this.textKey(input)) return true;
		if (this.typedKey(input)) return true;
		const key = input.key;
		const lower = key.length === 1 ? key.toLowerCase() : key;
		if (key === ' ') {
			if (!this.spaceHeld) {
				this.spaceHeld = true;
				this.notify();
			}
			return true;
		}
		if (input.mod) {
			switch (lower) {
				case 'z':
					input.shift ? this.redo() : this.undo();
					return true;
				case 'y':
					this.redo();
					return true;
				case 'a':
					this.selectAll();
					return true;
				case 'd':
					this.duplicate();
					return true;
				case 'g':
					input.shift ? this.ungroup() : this.group();
					return true;
				case 'j':
					return input.alt ? this.averageAnchors('both').ok : this.joinPaths().ok;
				// Make Clipping Mask; with Alt, Release (Option-7 types ¶ on a Mac).
				case '7':
				case '¶':
					return input.alt || key === '¶' ? this.releaseMask().length > 0 : this.makeMask('clip').ok;
				case ']':
					this.arrange(input.alt ? 'front' : 'forward');
					return true;
				case '[':
					this.arrange(input.alt ? 'back' : 'backward');
					return true;
				case '=':
				case '+':
					this.setViewport({ zoom: this.viewport.zoom * 1.25 });
					return true;
				case '-':
					this.setViewport({ zoom: this.viewport.zoom / 1.25 });
					return true;
				case '0':
					this.setViewport({ zoom: 1 });
					return true;
			}
			return false;
		}
		switch (key) {
			case 'Escape':
				if (this.drag) this.cancelDrag();
				else if (this.trackingPoints.length) this.clearTracking();
				else if (this.widthEdit) this.closeWidthPointEdit();
				else if (this.tool === 'width' && this.widthPoints.length) {
					this.widthPoints = [];
					this.notify();
				}
				else if (this.pen) this.finishPath();
				else if (this.blendStart) {
					this.blendStart = null;
					this.notify();
				} else if (this.tool === 'direct' && this.anchors.length) {
					this.anchors = [];
					this.notify();
				} else if (this.tool !== 'select') this.setTool('select');
				else if (this.symbolEdit && !this.selection.length) this.exitSymbolEdit();
				else this.clearSelection();
				return true;
			case 'Enter':
				if (this.pen) {
					this.finishPath();
					return true;
				}
				if (this.tool === 'select' && this.selection.length === 1 && this.getNode(this.selection[0])?.type === 'path') {
					this.tool = 'direct';
					this.editingId = this.selection[0];
					this.notify();
					return true;
				}
				return false;
			case 'Delete':
			case 'Backspace':
				if (this.tool === 'width' && this.widthPoints.length) return this.removeWidthPoints().ok;
				if (this.tool === 'gradient' && this.gradientEdit.stop !== null) return this.removeGradientStop(this.gradientEdit.stop).ok;
				if (this.pen) {
					const node = this.getNode(this.pen.nodeId) as VectorPathNode;
					const sp = node.subpaths[this.pen.subpath];
					if (sp.anchors.length > 2) this.deleteAnchors([{ nodeId: node.id, subpath: this.pen.subpath, index: sp.anchors.length - 1 }]);
					else {
						this.removeNodes([node.id], { label: 'Delete Path' });
						this.pen = null;
					}
					return true;
				}
				return this.deleteSelection().ok;
			case 'ArrowLeft':
			case 'ArrowRight':
			case 'ArrowUp':
			case 'ArrowDown': {
				const step = input.shift ? 10 : 1;
				const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
				const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
				return this.translate(dx, dy).ok;
			}
		}
		if (key.length === 1 && !input.alt) {
			const tool = TOOL_KEYS[lower];
			if (tool) {
				this.setTool(tool);
				return true;
			}
		}
		return false;
	}

	keyUp(input: VectorKeyInput): void {
		if (input.key === ' ' && this.spaceHeld) {
			this.spaceHeld = false;
			this.notify();
		}
	}
}

/** "Rectangle", "Square", "Ellipse", "Circle", "Line", "Triangle" or "Polygon". */
function inkShapeLabel(shape: VectorInkShape): string {
	const name = vectorInkShapeName(shape);
	return name[0].toUpperCase() + name.slice(1);
}

/** The subpath of a recognised pencil shape. */
function inkShapeSubpath(shape: VectorInkShape): VectorSubpath {
	switch (shape.kind) {
		case 'line':
			return lineSubpath({ x: shape.a[0], y: shape.a[1] }, { x: shape.b[0], y: shape.b[1] });
		case 'rect':
			return rectSubpath(shape);
		case 'ellipse':
			return ellipseSubpath(shape);
		case 'polygon':
			return { anchors: shape.points.map(([x, y]) => ({ x, y })), closed: true };
	}
}

/** Snaps `p` to the nearest 45° direction from `origin`, keeping its distance. */
function constrain45(origin: Vec2, p: Vec2): Vec2 {
	const dx = p.x - origin.x;
	const dy = p.y - origin.y;
	const len = Math.hypot(dx, dy);
	const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
	return { x: origin.x + Math.cos(a) * len, y: origin.y + Math.sin(a) * len };
}

/** Scale factors and origin for dragging a selection-box handle to `p`. */
export function scaleFor(handle: VectorTransformHandle, b: VectorBounds, p: Vec2, mods: VectorModifiers = {}): { sx: number; sy: number; origin: Vec2 } {
	const west = handle.includes('w');
	const east = handle.includes('e');
	const north = handle.startsWith('n');
	const south = handle.startsWith('s');
	const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	const origin = mods.alt ? center : { x: west ? b.x + b.width : east ? b.x : center.x, y: north ? b.y + b.height : south ? b.y : center.y };
	const reachX = mods.alt ? b.width / 2 : b.width;
	const reachY = mods.alt ? b.height / 2 : b.height;
	let sx = west || east ? (reachX > 1e-9 ? ((p.x - origin.x) * (west ? -1 : 1)) / reachX : 1) : 1;
	let sy = north || south ? (reachY > 1e-9 ? ((p.y - origin.y) * (north ? -1 : 1)) / reachY : 1) : 1;
	if (mods.shift) {
		if ((west || east) && (north || south)) {
			const s = Math.max(Math.abs(sx), Math.abs(sy));
			sx = Math.sign(sx || 1) * s;
			sy = Math.sign(sy || 1) * s;
		} else if (west || east) sy = Math.abs(sx);
		else sx = Math.abs(sy);
	}
	return { sx, sy, origin };
}

/** A style applied to a path; a `null` (or empty) width profile removes it. */
function withStyle(node: VectorPathNode, style: VectorStyle & { opacity?: number }): VectorNode {
	const { fills, strokes, ...shorthand } = style;
	let next = { ...node, ...shorthand } as VectorPathNode;
	if ('strokeWidthProfile' in style) {
		const p = style.strokeWidthProfile ? sanitizeWidthProfile(style.strokeWidthProfile) : [];
		if (p.length) next.strokeWidthProfile = p;
		else delete next.strokeWidthProfile;
	}
	// Shorthands edit the top layer of a stack; whole stacks given replace them.
	next = normalizeVectorPaintStacks(next, 'shorthand');
	if (fills !== undefined) next = withVectorFills(next, sanitizeVectorFills(fills ?? []));
	if (strokes !== undefined) next = withVectorStrokes(next, sanitizeVectorStrokes(strokes ?? []));
	return next;
}


/** The resolved character style at `index` of a text node. */
function vectorTextStyleOf(node: VectorTextNode, index: number): VectorCharacterStyle {
	let at = 0;
	for (const r of node.runs ?? []) {
		if (index < at + r.length) {
			const { fill: _f, ...fields } = r.style;
			return { ...node.font, ...fields };
		}
		at += r.length;
	}
	return node.font;
}

const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
/** The index after the character at `i` (a surrogate pair moves two). */
function nextIndex(text: string, i: number): number {
	if (i >= text.length) return text.length;
	return isHighSurrogate(text.charCodeAt(i)) && isLowSurrogate(text.charCodeAt(i + 1)) ? i + 2 : i + 1;
}
/** The index before the character ending at `i`. */
function prevIndex(text: string, i: number): number {
	if (i <= 0) return 0;
	return isLowSurrogate(text.charCodeAt(i - 1)) && isHighSurrogate(text.charCodeAt(i - 2)) ? i - 2 : i - 1;
}
const isWordChar = (c: string) => /[\p{L}\p{N}_'’]/u.test(c);
/** The next word boundary from `i` in direction `dir` (spaces, then a word). */
function wordEdge(text: string, i: number, dir: 1 | -1): number {
	let j = i;
	if (dir > 0) {
		while (j < text.length && !isWordChar(text[j])) j++;
		while (j < text.length && isWordChar(text[j])) j++;
	} else {
		while (j > 0 && !isWordChar(text[j - 1])) j--;
		while (j > 0 && isWordChar(text[j - 1])) j--;
	}
	return j;
}
/** The word around `i` as [start, end) (a single character when it is not part of a word). */
function wordAt(text: string, i: number): [number, number] {
	const at = Math.min(i, text.length - 1);
	if (at < 0) return [0, 0];
	if (!isWordChar(text[at])) return [at, at + 1];
	let a = at;
	let b = at;
	while (a > 0 && isWordChar(text[a - 1])) a--;
	while (b < text.length && isWordChar(text[b])) b++;
	return [a, b];
}

/** SVG path data or Bézier commands read loosely (bad data gives an empty path). */
function toBezierPathLoose(d: string): BezierPath {
	try {
		return subpathsToBezier(bezierToSubpaths(d), { corners: false });
	} catch {
		return [];
	}
}

/** True when node `id` or one of its ancestors is locked or hidden. */
function hiddenOrLocked(nodes: readonly VectorNode[], id: string): boolean {
	const loc = locateVectorNode(nodes as VectorNode[], id);
	if (!loc) return false;
	const n = loc.list[loc.index];
	if (n.locked || n.visible === false) return true;
	return loc.parent ? hiddenOrLocked(nodes, loc.parent.id) : false;
}

/** The width profile of pencil samples and their pressures (positions by length along the samples). */
function pencilPressureProfile(points: readonly Point[], pressures: readonly number[]): VectorWidthPoint[] {
	const n = Math.min(points.length, pressures.length);
	if (n < 2) return [];
	const s = [0];
	for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
	const total = s[n - 1];
	if (!(total > 0)) return [];
	return pressureWidthProfile(s.map((d, i) => ({ t: d / total, pressure: pressures[i] })));
}
