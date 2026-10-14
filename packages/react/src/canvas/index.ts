export {
	AgentPresenceLayer,
	type AgentPresenceLayerProps
} from './AgentPresenceLayer.js';

export {
	useStreamingCanvas,
	type UseStreamingCanvasOptions
} from './useStreamingCanvas.js';

export {
	useCanvasGraph,
	type UseCanvasGraphOptions
} from './useCanvasGraph.js';

export {
	useCanvasLayout,
	type UseCanvasLayoutOptions
} from './useCanvasLayout.js';

export {
	useCanvasClipboard,
	type UseCanvasClipboardOptions
} from './useCanvasClipboard.js';

export {
	useCanvasShortcuts,
	type UseCanvasShortcutsOptions
} from './useCanvasShortcuts.js';

export {
	useCanvasDocking,
	type UseCanvasDockingOptions
} from './useCanvasDocking.js';

export {
	useCanvasExplosion,
	type CanvasGraphTarget
} from './useCanvasExplosion.js';

// Arrangement (align / distribute / size / lock / z-order), smart guides and scenes
export {
	useCanvasArrange,
	useCanvasArrangeShortcuts,
	type CanvasArrange,
	type UseCanvasArrangeOptions,
	type UseCanvasArrangeShortcutsOptions
} from './useCanvasArrange.js';

export {
	useCanvasScenes,
	type CanvasScenes,
	type UseCanvasScenesOptions
} from './useCanvasScenes.js';

export {
	CanvasGuidesLayer,
	type CanvasGuidesLayerProps
} from './CanvasGuidesLayer.js';

// Distance measuring (Alt-hover), resize / grid snapping and curve fitting
export {
	useCanvasMeasure,
	type CanvasMeasure,
	type UseCanvasMeasureOptions
} from './useCanvasMeasure.js';

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

export { ShapeNode, type ShapeNodeProps } from './ShapeNode.js';

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

// Re-export shared canvas types & pure math from core
export {
	getLayoutedNodes,
	ensureLayout,
	centerNodes,
	getCenteredNodePosition,
	placeBeside,
	estimateNodeSize,
	flowSide,
	boundsOf,
	centre,
	overlaps,
	linearTrajectory,
	linearPositionTrajectory,
	createFanOutTrajectory,
	createBezierTrajectory,
	runMultiNodeTransition,
	defaultEasing,
	computeNodesBoundingBox,
	calculateDirectionalDisplacement,
	calculateDagreReflowDisplacement,
	isEventFromTextInput,
	isValidCanvasNode,
	isValidUrl,
	serializeCanvasNodes,
	parseCanvasClipboardData,
	remapPastedNodes,
	repositionNodesTo,
	realClock,
	ManualClock,
	layoutBounds,
	canvasHeight,
	estimateCanvasHeight,
	blendLayout,
	connectedOnly,
	type Clock,
	type CanvasHeightOptions,
	type CanvasNode,
	type CanvasEdge,
	type GraphDifferences,
	type CanvasClipboardPayload,
	type CanvasLayoutOptions,
	type IncrementalLayoutOptions,
	type PlaceBesideOptions,
	type TrajectoryPoint,
	type TrajectoryFunction,
	type FanOutTrajectoryOptions,
	type NodeTransition,
	type DisplacementDirection,
	type DirectionalDisplacementOptions,
	type ReflowDisplacementOptions,
	type ExplosionSnapshot,
	type ExplodeNodeOptions,
	type CollapseNodeOptions,
	type DockStrategy,
	type CanvasDockingCallbacks,
	type XYPosition,
	type Rect,
	type Side,
	type Point,
	type Position
} from '@pixerate/editor/canvas';
