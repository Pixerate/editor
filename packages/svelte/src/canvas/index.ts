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
	isolateCanvasGestures,
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
export { default as AgentCursorPresence } from './AgentCursorPresence.svelte';

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

// Freehand drawing tools (pen, highlighter, eraser)
export {
	createCanvasDraw,
	type CanvasDraw,
	type CreateCanvasDrawOptions
} from './createCanvasDraw.svelte.js';
export { default as CanvasDrawLayer } from './CanvasDrawLayer.svelte';

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

// Curve-preserving path operations, Offset Path and Outline Stroke
export {
	offsetShapeNodes,
	outlineShapeNodeStrokes,
	canOffsetShapeNodes,
	canOutlineShapeNodeStrokes,
	applyShapeReplacement,
	hasVisibleStroke,
	shapeToBezierPath,
	shapeNodeToBezierPath,
	pathBoolean,
	unitePaths,
	intersectPaths,
	subtractPaths,
	excludePaths,
	dividePaths,
	normalizeBezierPath,
	bezierPathArea,
	offsetPath,
	outlineStroke,
	strokeOutlineRings,
	dashContours,
	toBezierPath,
	bezierPathToSvg,
	transformBezierPath,
	bezierPathBounds,
	bezierPathSignedArea,
	bezierPathLength,
	bezierPathPointAtLength,
	pointInBezierPath,
	distanceToBezierPath,
	countPathSegments,
	type BezierCommand,
	type BezierPath,
	type BezierPathInput,
	type PathOperand,
	type PathOperandInput,
	type PathOpsOptions,
	type PathBooleanResult,
	type DividePathsResult,
	type StrokeJoin,
	type StrokeCap,
	type OutlineStrokeOptions,
	type OffsetPathOptions,
	type OffsetShapeNodesOptions,
	type OutlineShapeStrokesOptions,
	type ShapePathEditResult,
	type ShapePathEditRefusal,
	type ShapePathEditOperation
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

// Design tokens: bindings, per-frame modes and inspector controls
export {
	createCanvasTokens,
	type CreateCanvasTokensOptions,
	type SvelteCanvasTokens
} from './createCanvasTokens.svelte.js';
export { default as TokenBindingPicker } from './TokenBindingPicker.svelte';
export { default as TokenModeSwitcher } from './TokenModeSwitcher.svelte';

export {
	bindCanvasToken,
	setCanvasTokenMode,
	resolveCanvasTokens,
	detachTokenBindings,
	pruneCanvasTokenModes,
	inspectNodeTokens,
	getNodeTokenBindings,
	getNodeTokenModes,
	getEffectiveTokenModes,
	getBindableTokenProperties,
	getCanvasTokenProperty,
	getTokenPropertyScope,
	getTokensForProperty,
	readNodeStyleProperty,
	writeNodeStyleProperty,
	CANVAS_TOKEN_PROPERTIES,
	TOKEN_BINDINGS_DATA_KEY,
	TOKEN_MODES_DATA_KEY,
	type CanvasTokenProperty,
	type CanvasTokenOptions,
	type CanvasTokenBindingInfo
} from '@pixerate/editor/canvas';

// Keyframe animation: playback, record mode, timeline and export
export {
	createCanvasAnimation,
	type CreateCanvasAnimationOptions,
	type SvelteCanvasAnimation
} from './createCanvasAnimation.svelte.js';
export { default as AnimationTimeline } from './AnimationTimeline.svelte';

export {
	createCanvasAnimationController,
	AnimationPlayer,
	createAnimationPlayer,
	AnimationEditError,
	ANIMATION_DATA_KEY,
	ANIMATION_TIME_EPSILON,
	ANIMATABLE_PROPERTIES,
	ANIMATION_EASING_PRESETS,
	ANIMATION_EASING_LABELS,
	CUBIC_BEZIER_PRESETS,
	MAX_KEYFRAME_REFS,
	CSS_ANIMATION_PROPERTIES,
	evaluateAnimation,
	evaluateTrack,
	evaluateEasing,
	applyAnimation,
	applyAnimationOverrides,
	interpolateAnimationValue,
	getAnimationDuration,
	wrapAnimationTime,
	cubicBezierAt,
	springAt,
	resolveEasing,
	parseCssEasing,
	easingToCss,
	easingLabel,
	easingFromInfluence,
	isAnimationEasing,
	mixColorsOklab,
	rgbToOklab,
	oklabToRgb,
	parseOklab,
	formatOklab,
	getNodeAnimation,
	getAnimationTrack,
	getAnimatedProperties,
	getAnimatableProperty,
	isNodeAnimated,
	withNodeAnimation,
	normalizeKeyframes,
	isAnimationKeyframe,
	clampAnimationValue,
	setKeyframe,
	addKeyframesAtTime,
	updateKeyframe,
	deleteKeyframes,
	setKeyframeEasing,
	setTrackEnabled,
	removeTrack,
	setMotionPath,
	moveKeyframes,
	scaleKeyframes,
	snapKeyframeDelta,
	snapTimeToFrame,
	getKeyframeTimes,
	copyKeyframes,
	pasteKeyframes,
	parseKeyframeClipboard,
	recordAnimationChanges,
	animateNode,
	getAnimatedValue,
	readAnimatableValue,
	sampleAnimationFrames,
	exportCssAnimation,
	toWebAnimations,
	playWebAnimations,
	getCssPropertyAnimations,
	isCssExportExact,
	getTimelineRows,
	getTimelineTicks,
	isKeyframeSelected,
	timeToX,
	xToTime,
	formatAnimationTime,
	type AnimatableProperty,
	type AnimationValue,
	type AnimationValueType,
	type AnimationKeyframe,
	type AnimationTrack,
	type AnimationMotionPath,
	type NodeAnimation,
	type AnimationEasing,
	type AnimationEasingPreset,
	type CubicBezierEasing,
	type SpringEasing,
	type AnimationLoopMode,
	type AnimationDocument,
	type AnimationOverrides,
	type AnimationFrame,
	type AnimationPlayerState,
	type AnimationPlayerOptions,
	type AnimationHistoryTarget,
	type AnimationKeyframeClipboard,
	type AnimationEditErrorCode,
	type KeyframeRef,
	type KeyframePatch,
	type KeyframeSnap,
	type KeyframeDragState,
	type AnimateNodeOptions,
	type CanvasAnimationController,
	type CanvasAnimationControllerOptions,
	type CanvasAnimationState,
	type CssAnimationExport,
	type CssExportOptions,
	type WebAnimationSpec,
	type TimelineRow,
	type TimelineKeyframe,
	type OklabColor
} from '@pixerate/editor/canvas';

// Components and instances: rune, components panel and instance inspector
export {
	createCanvasComponents,
	type CanvasComponents,
	type CreateCanvasComponentsOptions
} from './createCanvasComponents.svelte.js';
export { default as CanvasComponentsPanel } from './CanvasComponentsPanel.svelte';
export { default as CanvasInstanceInspector } from './CanvasInstanceInspector.svelte';

export {
	createCanvasComponentsController,
	createCanvasComponent,
	combineCanvasComponentsAsVariants,
	createCanvasInstance,
	detachCanvasInstance,
	resetCanvasInstanceOverrides,
	pushCanvasInstanceOverrides,
	swapCanvasInstance,
	setCanvasInstanceProperties,
	setCanvasComponentProperty,
	bindCanvasComponentProperty,
	restoreCanvasMainComponent,
	addCanvasVariant,
	removeCanvasVariant,
	setCanvasVariantProperties,
	renameCanvasVariantProperty,
	renameCanvasVariantValue,
	getNextVariantValues,
	syncCanvasComponents,
	syncCanvasInstance,
	syncAllCanvasInstances,
	listCanvasComponents,
	inspectCanvasInstance,
	getInstanceStatus,
	getNodeOverrides,
	getComponentSourceId,
	getInstanceData,
	getCanvasComponentDragId,
	isCanvasComponent,
	isCanvasComponentSet,
	isCanvasInstance,
	wouldCreateComponentCycle,
	CANVAS_COMPONENT_DRAG_TYPE,
	type CanvasComponentsController,
	type CanvasComponentsControllerOptions,
	type CanvasComponentPropertyDef,
	type CanvasComponentPropertyField,
	type CanvasComponentResult,
	type CanvasComponentSyncOptions,
	type CanvasInstanceInfo,
	type CanvasComponentInfo,
	type CanvasComponentSetInfo,
	type AddCanvasVariantOptions,
	type SetCanvasVariantPropertiesOptions,
	// Freehand drawing exports
	createCanvasDrawController,
	createDefaultStrokeStyle,
	findStrokesAtPoint,
	streamlinePoints,
	strokePointsToPathData,
	strokeToShapeNode,
	computeDragBounds,
	computeDragBoundsFromPoints,
	type CanvasDragBounds,
	type CanvasDragBoundsModifiers,
	type CanvasDrawControllerOptions,
	type FreehandDrawOptions,
	type FreehandStroke,
	type FreehandStrokeStyle,
	type FreehandTool,
	type StrokeToShapeNodeOptions,
	// Gradients
	PIXERATE_BRAND_GRADIENT,
	CANVAS_GRADIENT_PRESETS,
	isCanvasGradient,
	parseCssGradient,
	resolveCanvasGradient,
	angleToSvgLinearCoords,
	gradientToSvgDef,
	type GradientStop,
	type CanvasLinearGradient,
	type CanvasRadialGradient,
	type CanvasGradientDef,
	type SvgGradientStop,
	type SvgGradientDef,
	// Agent presence math & types
	DEFAULT_CURSOR_INACTIVITY_MS,
	CARD_INSPECTION_ZONES,
	hashString,
	getAgentCardAnchor,
	calculateCurvedPath,
	getNaturalMovementTiming,
	getCursorTransitionDuration,
	calculateCursorArrowRotation,
	formatAgentCursorName,
	isAgentCursor,
	type CanvasAgentCursor,
	type CardInspectionZone,
	type CurvedPathOptions
} from '@pixerate/editor/canvas';


// Mermaid diagrams on the canvas (flowchart, state, class, ER as nodes and edges; the other
// families as their own picture with MermaidFamilyScene), with streaming
export { default as MermaidFamilyScene } from './MermaidFamilyScene.svelte';
export { default as MermaidDiagramNode } from './MermaidDiagramNode.svelte';
export { default as MermaidDiagramGroup } from './MermaidDiagramGroup.svelte';
export {
	createMermaidDiagram,
	createMermaidStream,
	type CreateMermaidDiagramOptions,
	type CreateMermaidStreamOptions,
	type SvelteMermaidDiagram,
	type SvelteMermaidStream
} from './createMermaidDiagram.svelte.js';

// Static previews of Mermaid diagrams
export { default as MermaidThumbnail } from './MermaidThumbnail.svelte';

// Agent cursors acting out diagram edits
export { default as DiagramPresenceLayer } from './DiagramPresenceLayer.svelte';
export { createDiagramDirector, type CreateDiagramDirectorOptions, type SvelteDiagramDirector } from './createDiagramDirector.svelte.js';
