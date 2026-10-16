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

// Freehand drawing tools (pen, highlighter, eraser)
export {
	useCanvasDraw,
	type CanvasDraw,
	type CanvasDrawState,
	type CanvasDrawActions,
	type UseCanvasDrawOptions
} from './useCanvasDraw.js';

export {
	CanvasDrawLayer,
	type CanvasDrawLayerProps
} from './CanvasDrawLayer.js';

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
	useCanvasAutoLayout,
	type CanvasAutoLayout,
	type UseCanvasAutoLayoutOptions
} from './useCanvasAutoLayout.js';

// Design tokens: bindings, per-frame modes and inspector controls
export {
	useCanvasTokens,
	type CanvasTokens,
	type UseCanvasTokensOptions
} from './useCanvasTokens.js';

export {
	TokenBindingPicker,
	TokenModeSwitcher,
	type TokenBindingPickerProps,
	type TokenModeSwitcherProps
} from './TokenBindingPicker.js';

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
	useCanvasAnimation,
	type CanvasAnimation,
	type UseCanvasAnimationOptions
} from './useCanvasAnimation.js';

export { AnimationTimeline, type AnimationTimelineProps } from './AnimationTimeline.js';

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

// Components and instances: hook, components panel and instance inspector
export {
	useCanvasComponents,
	type CanvasComponents,
	type UseCanvasComponentsOptions
} from './useCanvasComponents.js';

export {
	CanvasComponentsPanel,
	CanvasInstanceInspector,
	type CanvasComponentsPanelProps,
	type CanvasComponentsPanelActions,
	type CanvasInstanceInspectorProps,
	type CanvasInstanceInspectorActions
} from './CanvasComponentsPanel.js';

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
	type CanvasDrawControllerOptions,
	type FreehandDrawOptions,
	type FreehandStroke,
	type FreehandStrokeStyle,
	type FreehandTool,
	type StrokeToShapeNodeOptions
} from '@pixerate/editor/canvas';
