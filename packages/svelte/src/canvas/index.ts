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
	centerNodes
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

