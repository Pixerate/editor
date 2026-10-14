// Types
export * from './types.js';

// Graph management rune & pure functions
export {
	createCanvasGraph,
	calculateGraphDifferences,
	replaceNodeInGraph,
	type CreateCanvasGraphOptions
} from './createCanvasGraph.svelte.js';

// Layout calculations
export {
	getLayoutedNodes,
	getCenteredNodePosition,
	centerNodes,
	ensureLayout,
	placeBeside,
	estimateNodeSize,
	flowSide
} from './createCanvasLayout.js';

// Clipboard rune & helpers
export {
	createCanvasClipboard,
	isEventFromTextInput,
	isValidCanvasNode,
	isValidUrl,
	type CreateCanvasClipboardOptions
} from './createCanvasClipboard.svelte.js';

// Docking & drag interactions rune
export {
	createCanvasDocking,
	type CreateCanvasDockingOptions,
	type DockStrategy
} from './createCanvasDocking.svelte.js';

// Shortcuts manager
export {
	createCanvasShortcuts
} from './createCanvasShortcuts.js';

// Interaction modes & presets
export {
	createCanvasInteractions,
	defaultSvelteFlowPreset,
	miroCompatiblePreset,
	restorePanelPointerEvents,
	type CreateCanvasInteractionsOptions
} from './createCanvasInteractions.svelte.js';

// Trajectory calculation & multi-node transitions
export {
	linearTrajectory,
	linearPositionTrajectory,
	createFanOutTrajectory,
	createBezierTrajectory,
	runMultiNodeTransition
} from './createCanvasTrajectory.js';

// Spatial layout displacement
export {
	computeNodesBoundingBox,
	calculateDirectionalDisplacement,
	calculateReflowDisplacement
} from './createCanvasDisplacement.js';

// Node explosion & collapse rune
export {
	createCanvasExplosion,
	type CanvasGraphTarget,
	type CreateCanvasExplosionOptions
} from './createCanvasExplosion.svelte.js';

// Node synchronization & handle normalization
export {
	createCanvasNodeSync,
	preserveNodeMeasurements,
	normalizeNodeHandles,
	type HandleConfig,
	type NodeMeasurement,
	type CreateCanvasNodeSyncOptions
} from './createCanvasNodeSync.svelte.js';

// Multi-node drag coordination rune
export {
	createCanvasMultiDrag,
	type MultiDragState,
	type MultiDragFollowerOffset,
	type CreateCanvasMultiDragOptions,
	type FollowerTransform
} from './createCanvasMultiDrag.svelte.js';

// Drag selection helpers & presets
export {
	getMarqueeSelectionPreset,
	handleDeselectOnEscape,
	type CanvasSelectionOptions
} from './createCanvasSelection.svelte.js';

// Viewport floating scrollbar component
export { default as FloatingHorizontalScrollbar } from './FloatingHorizontalScrollbar.svelte';

// Agent presence visual layer
export { default as AgentPresenceLayer } from './AgentPresenceLayer.svelte';

// Streaming canvas rune
export {
	createStreamingCanvas,
	type CreateStreamingCanvasOptions
} from './createStreamingCanvas.svelte.js';

// Arrangement (align / distribute / size / lock / z-order), smart guides and scenes
export {
	createCanvasArrange,
	createCanvasArrangeShortcuts,
	type CanvasArrange,
	type CreateCanvasArrangeOptions,
	type CanvasArrangeShortcutsOptions
} from './createCanvasArrange.svelte.js';
export {
	createCanvasScenes,
	type CanvasScenes,
	type CreateCanvasScenesOptions
} from './createCanvasScenes.svelte.js';
export { default as CanvasGuidesLayer } from './CanvasGuidesLayer.svelte';

// Distance measuring (Alt-hover), resize / grid snapping and curve fitting
export {
	createCanvasMeasure,
	type CanvasMeasure,
	type CreateCanvasMeasureOptions
} from './createCanvasMeasure.svelte.js';
export {
	measureBetween,
	measureToLine,
	measureSelection,
	measureLabel,
	isMeasureModifierHeld,
	snapToGrid,
	snapResize,
	snapNodeResize,
	inferResizeHandle,
	resizeHandleAxes,
	getResizingNodeRect,
	RESIZE_HANDLES,
	fitCubics,
	fitCubicRun,
	fitPathData,
	fitFreehandPath,
	cubicsToPathData,
	cubicPointAt,
	isStraightCubic,
	type MeasureGuide,
	type MeasureSelectionResult,
	type MeasureSelectionOptions,
	type ResizeHandle,
	type SnapResizeOptions,
	type SnapResizeResult,
	type SnapNodeResizeOptions,
	type SnapNodeResizeResult,
	type CubicSegment,
	type FitCubicsOptions,
	type FitPathDataOptions
} from '@pixerate/editor/canvas';
export {
	alignNodes,
	distributeNodes,
	matchSize,
	reorderNodes,
	applyNodeUpdates,
	invertNodeUpdates,
	lockNodes,
	unlockNodes,
	toggleLockNodes,
	isLocked,
	getNodeSize,
	getNodeRect,
	getAbsolutePosition,
	readStyleSize,
	withStyleSize,
	computeSnapGuides,
	createGuideIndex,
	createNodeGuideIndex,
	snapNodeDrag,
	findConnectorSnap,
	nearestHandlePositions,
	handlePoint,
	positionToSide,
	sideToPosition,
	oppositePosition,
	CONNECTION_LINE_TYPES,
	CanvasScenesStore,
	createCanvasScenesStore,
	parseCanvasScenes,
	fitViewportToRect,
	fitViewportToNodes,
	matchArrangeShortcut,
	DEFAULT_ARRANGE_SHORTCUTS,
	type AlignEdge,
	type DistributeAxis,
	type DistributeMode,
	type SizeDimension,
	type ZOrderOperation,
	type CanvasNodeUpdate,
	type GuideLine,
	type GuideIndex,
	type SnapGuidesOptions,
	type SnapResult,
	type ConnectorSnap,
	type ConnectorSnapTarget,
	type CanvasConnectionLineType,
	type CanvasScene,
	type CanvasScenesState,
	type CanvasViewport,
	type CanvasArrangeAction,
	type ArrangeShortcutBinding
} from '@pixerate/editor/canvas';

export { default as ShapeNode } from './ShapeNode.svelte';

// Shape nodes and boolean operations (Unite / Intersect / Subtract / Exclude / Divide)
export {
	combineShapeNodes,
	canCombineShapeNodes,
	applyShapeCombination,
	revertShapeCombination,
	shapeNodeToPolygon,
	isShapeNode,
	getNodeShape,
	SHAPE_DATA_KEY,
	SHAPE_NODE_TYPE,
	SHAPE_OPERATIONS,
	SHAPE_KINDS,
	isShapeDescription,
	shapeToPolygon,
	getShapeSvg,
	getShapeRenderData,
	parseSvgPath,
	flattenSvgPath,
	polygonToSvgPath,
	simplifyRing,
	polygonBoolean,
	unionPolygons,
	intersectPolygons,
	subtractPolygons,
	xorPolygons,
	dividePolygons,
	polygonArea,
	multiPolygonArea,
	multiPolygonBounds,
	ringSignedArea,
	pointInRings,
	pointInMultiPolygon,
	type ShapeOperation,
	type ShapeDescription,
	type ShapeKind,
	type ShapePaint,
	type ShapeSize,
	type ShapeRenderData,
	type RectShape,
	type EllipseShape,
	type RegularPolygonShape,
	type StarShape,
	type PathShape,
	type PathCommand,
	type FlattenOptions,
	type PolygonToPathOptions,
	type CombineShapeNodesOptions,
	type CombineShapeNodesResult,
	type CombineShapeNodesRefusal,
	type ShapeNodePolygonOptions,
	type MultiPolygon,
	type PolygonWithHoles,
	type PolygonRing,
	type PolygonFillRule,
	type PolygonOperand,
	type PolygonInput,
	type PolygonPiece,
	type PolygonBooleanOperation,
	type PolygonBooleanOptions
} from '@pixerate/editor/canvas';

// Clock and view helpers from core
export {
	realClock,
	ManualClock,
	layoutBounds,
	canvasHeight,
	estimateCanvasHeight,
	blendLayout,
	connectedOnly,
	type Clock,
	type CanvasHeightOptions
} from '@pixerate/editor/canvas';


// Auto layout (Figma-style stacks, wrap, grid, hug / fill / fixed) and constraints
export {
	layoutFrame,
	layoutAll,
	layoutUp,
	layoutUpMany,
	applyConstraints,
	getAutoLayout,
	getChildLayout,
	getLayoutSizing,
	getAutoLayoutGrid,
	getAutoLayoutInsertTarget,
	getFlowChildren,
	getLayoutParent,
	isAutoLayoutFrame,
	makeSizingCoherent,
	moveLayoutChild,
	mergeNodeUpdates,
	relayoutUpdates,
	resolvePadding,
	clampLayoutSize,
	createCanvasAutoLayoutController,
	AUTO_LAYOUT_DATA_KEY,
	CHILD_LAYOUT_DATA_KEY,
	type AutoLayout,
	type AutoLayoutChild,
	type AutoLayoutMode,
	type AutoLayoutSizing,
	type AutoLayoutSizingPair,
	type AutoLayoutSize,
	type AutoLayoutAlignMain,
	type AutoLayoutAlignCross,
	type AutoLayoutAlignContent,
	type AutoLayoutPadding,
	type AutoLayoutGrid,
	type AutoLayoutGridTrack,
	type AutoLayoutGridArea,
	type AutoLayoutGridCell,
	type AutoLayoutGridGeometry,
	type AutoLayoutCellAlign,
	type AutoLayoutConstraints,
	type AutoLayoutHorizontalConstraint,
	type AutoLayoutVerticalConstraint,
	type AutoLayoutMeasure,
	type AutoLayoutOptions,
	type AutoLayoutInsertTarget,
	type CanvasAutoLayoutController,
	type CanvasAutoLayoutControllerOptions
} from '@pixerate/editor/canvas';

export {
	createCanvasAutoLayout,
	type CanvasAutoLayout,
	type CreateCanvasAutoLayoutOptions
} from './createCanvasAutoLayout.svelte.js';
