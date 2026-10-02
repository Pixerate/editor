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
