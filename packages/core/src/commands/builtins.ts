import type { HistoryState } from '../history/types.js';
import type { CanvasArrangeAction } from '../canvas/arrangeShortcuts.js';
import type { AlignEdge, DistributeAxis, DistributeMode, ZOrderOperation } from '../canvas/arrange.js';
import { DEFAULT_ARRANGE_SHORTCUTS } from '../canvas/arrangeShortcuts.js';
import type { CommandParamsSchema, CommandSpec } from './registry.js';
import { ShortcutMap, type ShortcutBinding } from './shortcuts.js';
import type { KeyboardEventLike, Platform } from './chords.js';

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Minimal history surface (`HistoryManager` satisfies it). */
export interface HistoryCommandTarget {
	undo(): boolean | void;
	redo(): boolean | void;
	getState(): Pick<HistoryState, 'canUndo' | 'canRedo'> & Partial<Pick<HistoryState, 'undoName' | 'redoName'>>;
}

/** Default history bindings: `Mod+Z` undo; `Mod+Shift+Z` redo, plus `Mod+Y` off macOS. */
export const DEFAULT_HISTORY_SHORTCUTS: readonly ShortcutBinding[] = [
	{ command: 'undo', chord: 'Mod+Z' },
	{ command: 'redo', chord: 'Mod+Shift+Z' },
	{ command: 'redo', chord: 'Mod+Y', platforms: ['windows', 'linux'] }
];

export interface HistoryCommandOptions {
	/** Id prefix (default `history.`). */
	prefix?: string;
	group?: string;
	scope?: string;
}

/** `history.undo` / `history.redo` commands for a `HistoryManager` (disabled with a reason when empty). */
export function createHistoryCommands(history: HistoryCommandTarget, options: HistoryCommandOptions = {}): CommandSpec[] {
	const prefix = options.prefix ?? 'history.';
	const group = options.group ?? 'Edit';
	const shortcutsOf = (command: 'undo' | 'redo') =>
		DEFAULT_HISTORY_SHORTCUTS.filter((b) => b.command === command).map(({ command: _c, ...rest }) => rest);
	return [
		{
			id: `${prefix}undo`,
			label: 'Undo',
			group,
			keywords: ['revert', 'back'],
			description: 'Reverts the last change.',
			shortcut: shortcutsOf('undo'),
			...(options.scope ? { scope: options.scope } : {}),
			enabled: () => (history.getState().canUndo ? true : 'Nothing to undo.'),
			run: () => {
				history.undo();
				return { undone: true, state: history.getState() };
			}
		},
		{
			id: `${prefix}redo`,
			label: 'Redo',
			group,
			keywords: ['repeat', 'forward'],
			description: 'Re-applies the last undone change.',
			shortcut: shortcutsOf('redo'),
			...(options.scope ? { scope: options.scope } : {}),
			enabled: () => (history.getState().canRedo ? true : 'Nothing to redo.'),
			run: () => {
				history.redo();
				return { redone: true, state: history.getState() };
			}
		}
	];
}

let historyShortcutMap: ShortcutMap | null = null;

/**
 * Resolves a keydown event to `undo` / `redo` with the default history bindings
 * (`Mod` is ⌘ on macOS and Ctrl elsewhere). Events from text inputs and
 * contenteditable elements are ignored unless `allowInEditable`.
 */
export function matchHistoryShortcut(
	event: KeyboardEventLike,
	options: { platform?: Platform; allowInEditable?: boolean } = {}
): 'undo' | 'redo' | null {
	historyShortcutMap ??= new ShortcutMap(DEFAULT_HISTORY_SHORTCUTS);
	return (historyShortcutMap.resolve(event, options)?.command as 'undo' | 'redo' | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Canvas arrange
// ---------------------------------------------------------------------------

/** Minimal arrange controller surface (`createCanvasArrangeController` satisfies it). */
export interface ArrangeCommandTarget {
	align(edge: AlignEdge, ids?: Iterable<string>): unknown;
	distribute(axis: DistributeAxis, mode?: DistributeMode, ids?: Iterable<string>): unknown;
	reorder(operation: ZOrderOperation, ids?: Iterable<string>): unknown;
	lock(ids?: Iterable<string>): unknown;
	unlock(ids?: Iterable<string>): unknown;
}

export interface ArrangeCommandOptions {
	/** Id prefix (default `canvas.`). */
	prefix?: string;
	group?: string;
	/** Scope of the commands and their shortcuts (default `canvas`). Pass `null` for global. */
	scope?: string | null;
	/** Current selection, used for enablement ("Select at least two nodes"). */
	getSelectedIds?: () => string[];
	/** Scene navigation (`nextScene` / `previousScene`); those commands are only added when given. */
	scenes?: { next(): unknown; previous(): unknown };
	/** Use these bindings instead of `DEFAULT_ARRANGE_SHORTCUTS`. */
	bindings?: readonly { action: CanvasArrangeAction; label: string }[];
}

const ARRANGE_LABELS: Record<CanvasArrangeAction, string> = {
	alignLeft: 'Align Left',
	alignCenter: 'Align Horizontal Centers',
	alignRight: 'Align Right',
	alignTop: 'Align Top',
	alignMiddle: 'Align Vertical Centers',
	alignBottom: 'Align Bottom',
	distributeHorizontal: 'Distribute Horizontally',
	distributeVertical: 'Distribute Vertically',
	lock: 'Lock',
	unlock: 'Unlock',
	bringForward: 'Bring Forward',
	sendBackward: 'Send Backward',
	bringToFront: 'Bring to Front',
	sendToBack: 'Send to Back',
	nextScene: 'Next Scene',
	previousScene: 'Previous Scene'
};

const IDS_PARAMS: CommandParamsSchema = {
	type: 'object',
	properties: {
		ids: {
			type: 'array',
			items: { type: 'string' },
			description: 'Node ids to act on (default: the selection).'
		}
	}
};

/**
 * Commands for the canvas arrange actions (`canvas.alignLeft`, `canvas.bringToFront`, …)
 * with the default arrange shortcuts. Each accepts `{ ids? }`; enablement checks the
 * named ids, or the selection when none are named.
 */
export function createArrangeCommands(controller: ArrangeCommandTarget, options: ArrangeCommandOptions = {}): CommandSpec[] {
	const prefix = options.prefix ?? 'canvas.';
	const group = options.group ?? 'Arrange';
	const scope = options.scope === null ? undefined : options.scope ?? 'canvas';
	const bindings = options.bindings ?? DEFAULT_ARRANGE_SHORTCUTS;
	const count = (params?: { ids?: string[] }) => params?.ids?.length ?? options.getSelectedIds?.().length;
	const needs = (min: number, what: string) => (_: unknown, params?: { ids?: string[] }) => {
		const n = count(params);
		if (n === undefined || n >= min) return true;
		return min === 1 ? `Select a ${what} first.` : `Select at least ${min} ${what}s.`;
	};

	const run: Record<CanvasArrangeAction, (ids?: string[]) => unknown> = {
		alignLeft: (ids) => controller.align('left', ids),
		alignCenter: (ids) => controller.align('center', ids),
		alignRight: (ids) => controller.align('right', ids),
		alignTop: (ids) => controller.align('top', ids),
		alignMiddle: (ids) => controller.align('middle', ids),
		alignBottom: (ids) => controller.align('bottom', ids),
		distributeHorizontal: (ids) => controller.distribute('horizontal', 'gaps', ids),
		distributeVertical: (ids) => controller.distribute('vertical', 'gaps', ids),
		lock: (ids) => controller.lock(ids),
		unlock: (ids) => controller.unlock(ids),
		bringForward: (ids) => controller.reorder('bringForward', ids),
		sendBackward: (ids) => controller.reorder('sendBackward', ids),
		bringToFront: (ids) => controller.reorder('bringToFront', ids),
		sendToBack: (ids) => controller.reorder('sendToBack', ids),
		nextScene: () => options.scenes?.next(),
		previousScene: () => options.scenes?.previous()
	};

	const actions = Object.keys(ARRANGE_LABELS) as CanvasArrangeAction[];
	return actions
		.filter((action) => options.scenes || (action !== 'nextScene' && action !== 'previousScene'))
		.map((action): CommandSpec => {
			const isScene = action === 'nextScene' || action === 'previousScene';
			const enabled = isScene
				? undefined
				: action.startsWith('align')
					? needs(2, 'node')
					: action.startsWith('distribute')
						? needs(3, 'node')
						: needs(1, 'node');
			return {
				id: `${prefix}${action}`,
				label: ARRANGE_LABELS[action],
				group: isScene ? 'Scenes' : group,
				keywords: isScene ? ['scene', 'slide', 'page'] : action.startsWith('align') ? ['align'] : ['arrange', 'layer', 'order'],
				...(scope ? { scope } : {}),
				shortcut: bindings.filter((b) => b.action === action).map((b) => b.label),
				...(isScene ? {} : { params: IDS_PARAMS }),
				...(enabled ? { enabled } : {}),
				run: (_ctx: unknown, params: { ids?: string[] }) => run[action](params?.ids)
			};
		});
}

// ---------------------------------------------------------------------------
// Canvas shape operations
// ---------------------------------------------------------------------------

/** Shape operations surface of the arrange controller (`createCanvasArrangeController` satisfies it). */
export interface ShapeCommandTarget {
	combineShapes(operation: 'unite' | 'intersect' | 'subtract' | 'exclude' | 'divide', ids?: Iterable<string>): unknown;
	canCombineShapes(ids?: Iterable<string>): boolean;
	offsetShapes(distance: number, ids?: Iterable<string>, options?: { join?: 'miter' | 'round' | 'bevel'; miterLimit?: number }): unknown;
	canOffsetShapes(ids?: Iterable<string>): boolean;
	outlineStroke(
		ids?: Iterable<string>,
		options?: { join?: 'miter' | 'round' | 'bevel'; cap?: 'butt' | 'round' | 'square'; miterLimit?: number }
	): unknown;
	canOutlineStroke(ids?: Iterable<string>): boolean;
}

export interface ShapeCommandOptions {
	/** Id prefix (default `canvas.`). */
	prefix?: string;
	group?: string;
	/** Scope (default `canvas`). Pass `null` for global. */
	scope?: string | null;
	/** Offset distance used when `canvas.offsetPath` is run without one (default 10). */
	defaultOffset?: number;
}

const SHAPE_COMMANDS = [
	{ op: 'unite', label: 'Unite Shapes', keywords: ['union', 'merge', 'boolean', 'combine'] },
	{ op: 'intersect', label: 'Intersect Shapes', keywords: ['intersection', 'boolean', 'combine'] },
	{ op: 'subtract', label: 'Subtract Shapes', keywords: ['difference', 'minus front', 'boolean', 'combine'] },
	{ op: 'exclude', label: 'Exclude Shapes', keywords: ['xor', 'boolean', 'combine'] },
	{ op: 'divide', label: 'Divide Shapes', keywords: ['split', 'pathfinder', 'boolean'] }
] as const;

const JOIN_PARAM = { type: 'string', enum: ['miter', 'round', 'bevel'], description: 'Corner style (default miter).' } as const;

/**
 * Palette / context-menu / agent commands for the shape operations: `canvas.unite`,
 * `canvas.intersect`, `canvas.subtract`, `canvas.exclude`, `canvas.divide`,
 * `canvas.offsetPath` (`{ distance, join?, miterLimit?, ids? }`) and `canvas.outlineStroke`
 * (`{ join?, cap?, miterLimit?, ids? }`). Each is one undoable step when the controller has a
 * history; enablement explains why a command cannot run.
 */
export function createShapeCommands(controller: ShapeCommandTarget, options: ShapeCommandOptions = {}): CommandSpec[] {
	const prefix = options.prefix ?? 'canvas.';
	const group = options.group ?? 'Shape';
	const scope = options.scope === null ? undefined : options.scope ?? 'canvas';
	const base = { group, ...(scope ? { scope } : {}) };
	const combine = SHAPE_COMMANDS.map(
		({ op, label, keywords }): CommandSpec => ({
			...base,
			id: `${prefix}${op}`,
			label,
			keywords: [...keywords],
			description: `${label.split(' ')[0]}s the selected shapes into a new path (curves are kept).`,
			params: IDS_PARAMS,
			enabled: (_ctx: unknown, params?: { ids?: string[] }) =>
				controller.canCombineShapes(params?.ids) ? true : 'Select at least two unlocked shapes.',
			run: (_ctx: unknown, params: { ids?: string[] }) => controller.combineShapes(op, params?.ids)
		})
	);
	return [
		...combine,
		{
			...base,
			id: `${prefix}offsetPath`,
			label: 'Offset Path…',
			keywords: ['inset', 'outset', 'grow', 'shrink', 'expand', 'contract'],
			description: 'Grows (positive distance) or shrinks (negative) the selected shapes.',
			params: {
				type: 'object',
				properties: {
					distance: { type: 'number', description: `Offset in canvas units (default ${options.defaultOffset ?? 10}).` },
					join: JOIN_PARAM,
					miterLimit: { type: 'number', description: 'Miter limit (default 4).' },
					ids: IDS_PARAMS.properties!.ids
				}
			},
			enabled: (_ctx: unknown, params?: { ids?: string[] }) =>
				controller.canOffsetShapes(params?.ids) ? true : 'Select an unlocked shape.',
			run: (_ctx: unknown, params: { distance?: number; join?: 'miter' | 'round' | 'bevel'; miterLimit?: number; ids?: string[] }) =>
				controller.offsetShapes(params?.distance ?? options.defaultOffset ?? 10, params?.ids, {
					...(params?.join ? { join: params.join } : {}),
					...(params?.miterLimit !== undefined ? { miterLimit: params.miterLimit } : {})
				})
		},
		{
			...base,
			id: `${prefix}outlineStroke`,
			label: 'Outline Stroke',
			keywords: ['expand stroke', 'stroke to path', 'convert stroke'],
			description: 'Converts the strokes of the selected shapes to filled shapes.',
			params: {
				type: 'object',
				properties: {
					join: JOIN_PARAM,
					cap: { type: 'string', enum: ['butt', 'round', 'square'], description: 'Line cap (default butt).' },
					miterLimit: { type: 'number', description: 'Miter limit (default 4).' },
					ids: IDS_PARAMS.properties!.ids
				}
			},
			enabled: (_ctx: unknown, params?: { ids?: string[] }) =>
				controller.canOutlineStroke(params?.ids) ? true : 'Select an unlocked shape with a stroke.',
			run: (
				_ctx: unknown,
				params: { join?: 'miter' | 'round' | 'bevel'; cap?: 'butt' | 'round' | 'square'; miterLimit?: number; ids?: string[] }
			) =>
				controller.outlineStroke(params?.ids, {
					...(params?.join ? { join: params.join } : {}),
					...(params?.cap ? { cap: params.cap } : {}),
					...(params?.miterLimit !== undefined ? { miterLimit: params.miterLimit } : {})
				})
		}
	];
}

// ---------------------------------------------------------------------------
// Canvas components and instances
// ---------------------------------------------------------------------------

type ComponentActionResult = { ok: true; ids: string[] } | { ok: false; reason: string };

/** Components surface of the components controller (`createCanvasComponentsController` satisfies it). */
export interface ComponentCommandTarget {
	createComponent(ids?: Iterable<string>): ComponentActionResult;
	canCreateComponent(ids?: Iterable<string>): true | string;
	combineAsVariants(ids?: Iterable<string>): ComponentActionResult;
	canCombineAsVariants(ids?: Iterable<string>): true | string;
	createInstance(componentId: string, options?: { parentId?: string; position?: { x: number; y: number }; properties?: Record<string, boolean | string> }): ComponentActionResult;
	canCreateInstance(componentId?: string, parentId?: string): true | string;
	detachInstance(ids?: Iterable<string>): ComponentActionResult;
	canDetachInstance(ids?: Iterable<string>): true | string;
	resetOverrides(id?: string, group?: string): ComponentActionResult;
	canResetOverrides(id?: string): true | string;
	pushOverrides(id?: string): ComponentActionResult;
	canPushOverrides(id?: string): true | string;
	swapInstance(componentId: string, ids?: Iterable<string>): ComponentActionResult;
	canSwapInstance(componentId?: string, ids?: Iterable<string>): true | string;
	setInstanceProperties(properties: Record<string, unknown>, ids?: Iterable<string>): ComponentActionResult;
	canSetInstanceProperties(ids?: Iterable<string>): true | string;
	restoreMainComponent(id?: string): ComponentActionResult;
	canRestoreMainComponent(id?: string): true | string;
	goToMainComponent(id?: string): string | undefined;
	canGoToMainComponent(id?: string): true | string;
	list(): unknown;
	inspect(id?: string): unknown;
}

export interface ComponentCommandOptions {
	/** Id prefix (default `canvas.`). */
	prefix?: string;
	group?: string;
	/** Scope (default `canvas`). Pass `null` for global. */
	scope?: string | null;
}

const outcome = (result: ComponentActionResult) => {
	if (!result.ok) throw new Error(result.reason);
	return { ids: result.ids };
};

const ID_PARAM = { type: 'string', description: 'Instance (or layer inside one) to act on (default: the first selected node).' } as const;

/**
 * Palette / context-menu / agent commands for components and instances:
 * `canvas.createComponent`, `canvas.combineAsVariants`, `canvas.createInstance`
 * (`{ componentId, parentId?, x?, y?, properties? }`), `canvas.detachInstance`,
 * `canvas.resetOverrides` (`{ id?, group? }`), `canvas.pushOverrides`, `canvas.goToMainComponent`,
 * `canvas.swapInstance` (`{ componentId, ids? }`), `canvas.setInstanceProperties`
 * (`{ properties, ids? }`: variant and component property values), `canvas.restoreMainComponent`
 * and the read-only `canvas.listComponents` / `canvas.inspectInstance`. Each action is one
 * undoable step when the controller has a history; enablement explains why it cannot run.
 */
export function createComponentCommands(controller: ComponentCommandTarget, options: ComponentCommandOptions = {}): CommandSpec[] {
	const prefix = options.prefix ?? 'canvas.';
	const group = options.group ?? 'Components';
	const scope = options.scope === null ? undefined : options.scope ?? 'canvas';
	const base = { group, ...(scope ? { scope } : {}) };
	const idParams: CommandParamsSchema = { type: 'object', properties: { id: ID_PARAM } };
	return [
		{
			...base,
			id: `${prefix}createComponent`,
			label: 'Create Component',
			keywords: ['component', 'symbol', 'main component', 'reusable'],
			description: 'Turns the selected frame into a main component, or wraps the selection in one.',
			params: IDS_PARAMS,
			shortcut: 'Mod+Alt+K',
			enabled: (_ctx: unknown, params?: { ids?: string[] }) => controller.canCreateComponent(params?.ids),
			run: (_ctx: unknown, params: { ids?: string[] }) => outcome(controller.createComponent(params?.ids))
		},
		{
			...base,
			id: `${prefix}combineAsVariants`,
			label: 'Combine as Variants',
			keywords: ['component set', 'variant', 'variants'],
			description: 'Wraps the selected components in a component set.',
			params: IDS_PARAMS,
			enabled: (_ctx: unknown, params?: { ids?: string[] }) => controller.canCombineAsVariants(params?.ids),
			run: (_ctx: unknown, params: { ids?: string[] }) => outcome(controller.combineAsVariants(params?.ids))
		},
		{
			...base,
			id: `${prefix}createInstance`,
			label: 'Create Instance',
			keywords: ['instance', 'insert component', 'use component'],
			description: 'Places an instance of a component (or a component set’s default variant).',
			params: {
				type: 'object',
				properties: {
					componentId: { type: 'string', description: 'Component or component set id.' },
					parentId: { type: 'string', description: 'Frame to place it in (default: the canvas).' },
					x: { type: 'number', description: 'X in the parent’s space (default: next to the main).' },
					y: { type: 'number', description: 'Y in the parent’s space.' },
					properties: { type: 'object', description: 'Variant and component property values.', additionalProperties: true }
				},
				required: ['componentId']
			},
			enabled: (_ctx: unknown, params?: { componentId?: string; parentId?: string }) =>
				params?.componentId === undefined ? true : controller.canCreateInstance(params.componentId, params.parentId),
			run: (_ctx: unknown, params: { componentId: string; parentId?: string; x?: number; y?: number; properties?: Record<string, boolean | string> }) =>
				outcome(
					controller.createInstance(params.componentId, {
						...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
						...(params.x !== undefined || params.y !== undefined ? { position: { x: params.x ?? 0, y: params.y ?? 0 } } : {}),
						...(params.properties ? { properties: params.properties } : {})
					})
				)
		},
		{
			...base,
			id: `${prefix}detachInstance`,
			label: 'Detach Instance',
			keywords: ['unlink', 'break instance'],
			description: 'Turns the selected instances into plain frames that keep their look.',
			params: IDS_PARAMS,
			shortcut: 'Mod+Alt+B',
			enabled: (_ctx: unknown, params?: { ids?: string[] }) => controller.canDetachInstance(params?.ids),
			run: (_ctx: unknown, params: { ids?: string[] }) => outcome(controller.detachInstance(params?.ids))
		},
		{
			...base,
			id: `${prefix}resetOverrides`,
			label: 'Reset All Changes',
			keywords: ['reset instance', 'reset overrides', 'revert'],
			description: 'Resets the overrides of an instance (or of a layer, or one override group) to its main.',
			params: {
				type: 'object',
				properties: {
					id: ID_PARAM,
					group: { type: 'string', description: 'One override group to reset, e.g. "data.label" or "shape.fill" (default: all).' }
				}
			},
			enabled: (_ctx: unknown, params?: { id?: string }) => controller.canResetOverrides(params?.id),
			run: (_ctx: unknown, params: { id?: string; group?: string }) => outcome(controller.resetOverrides(params?.id, params?.group))
		},
		{
			...base,
			id: `${prefix}pushOverrides`,
			label: 'Push Changes to Main Component',
			keywords: ['push overrides', 'update main component'],
			description: 'Copies the instance’s overrides to its main component and every other instance.',
			params: idParams,
			enabled: (_ctx: unknown, params?: { id?: string }) => controller.canPushOverrides(params?.id),
			run: (_ctx: unknown, params: { id?: string }) => outcome(controller.pushOverrides(params?.id))
		},
		{
			...base,
			id: `${prefix}goToMainComponent`,
			label: 'Go to Main Component',
			keywords: ['main component', 'find main', 'reveal'],
			description: 'Selects the main component of the selected instance.',
			params: idParams,
			enabled: (_ctx: unknown, params?: { id?: string }) => controller.canGoToMainComponent(params?.id),
			run: (_ctx: unknown, params: { id?: string }) => {
				const main = controller.goToMainComponent(params?.id);
				if (!main) throw new Error('The main component was not found.');
				return { id: main };
			}
		},
		{
			...base,
			id: `${prefix}swapInstance`,
			label: 'Swap Instance…',
			keywords: ['replace instance', 'swap component'],
			description: 'Makes the selected instances show another component, keeping matching overrides.',
			params: {
				type: 'object',
				properties: {
					componentId: { type: 'string', description: 'Component or component set to swap to.' },
					ids: IDS_PARAMS.properties!.ids
				},
				required: ['componentId']
			},
			enabled: (_ctx: unknown, params?: { componentId?: string; ids?: string[] }) => controller.canSwapInstance(params?.componentId, params?.ids),
			run: (_ctx: unknown, params: { componentId: string; ids?: string[] }) => outcome(controller.swapInstance(params.componentId, params?.ids))
		},
		{
			...base,
			id: `${prefix}setInstanceProperties`,
			label: 'Set Instance Properties…',
			keywords: ['variant', 'switch variant', 'component property', 'toggle'],
			description: 'Sets variant properties (switching variants) and component property values of the selected instances.',
			params: {
				type: 'object',
				properties: {
					properties: { type: 'object', description: 'Property name → value (variant value, boolean, text or component id).', additionalProperties: true },
					ids: IDS_PARAMS.properties!.ids
				},
				required: ['properties']
			},
			enabled: (_ctx: unknown, params?: { ids?: string[] }) => controller.canSetInstanceProperties(params?.ids),
			run: (_ctx: unknown, params: { properties: Record<string, unknown>; ids?: string[] }) =>
				outcome(controller.setInstanceProperties(params.properties, params?.ids))
		},
		{
			...base,
			id: `${prefix}restoreMainComponent`,
			label: 'Restore Main Component',
			keywords: ['missing main', 'recover component'],
			description: 'Turns an instance whose main was deleted back into the main component.',
			params: idParams,
			enabled: (_ctx: unknown, params?: { id?: string }) => controller.canRestoreMainComponent(params?.id),
			run: (_ctx: unknown, params: { id?: string }) => outcome(controller.restoreMainComponent(params?.id))
		},
		{
			...base,
			id: `${prefix}listComponents`,
			label: 'List Components',
			keywords: ['components', 'variants', 'assets'],
			description: 'Lists the components and component sets (with their variant options).',
			readOnly: true,
			run: () => controller.list()
		},
		{
			...base,
			id: `${prefix}inspectInstance`,
			label: 'Inspect Instance',
			keywords: ['instance', 'overrides', 'properties'],
			description: 'Describes an instance: its main, variant, property values and overrides.',
			params: idParams,
			readOnly: true,
			enabled: (_ctx: unknown, params?: { id?: string }) => (controller.inspect(params?.id) ? true : 'Select an instance.'),
			run: (_ctx: unknown, params: { id?: string }) => controller.inspect(params?.id) ?? null
		}
	];
}

// ---------------------------------------------------------------------------
// Spreadsheet table actions
// ---------------------------------------------------------------------------

/** Spreadsheet controller surface used by `createSpreadsheetCommands`. */
export interface SpreadsheetCommandTarget {
	selectedRange: unknown;
	getFilterState(): { enabled: boolean; rules: readonly unknown[] };
	toggleFilters(): void;
	clearFilters(): void;
	unhideAll(): void;
	mergeCells(): boolean;
	unmergeCells(): boolean;
	transposeRange(): boolean;
}

export interface SpreadsheetCommandOptions {
	/** Id prefix (default `spreadsheet.`). */
	prefix?: string;
	/** Scope (default `spreadsheet`). Pass `null` for global. */
	scope?: string | null;
}

/** Palette / agent commands for common spreadsheet table actions (no default shortcuts). */
export function createSpreadsheetCommands(
	controller: SpreadsheetCommandTarget,
	options: SpreadsheetCommandOptions = {}
): CommandSpec[] {
	const prefix = options.prefix ?? 'spreadsheet.';
	const scope = options.scope === null ? undefined : options.scope ?? 'spreadsheet';
	const hasRange = () => (controller.selectedRange ? true : 'Select a range first.');
	const base = { group: 'Table', ...(scope ? { scope } : {}) };
	return [
		{ ...base, id: `${prefix}toggleFilters`, label: 'Toggle Filters', keywords: ['filter'], run: () => controller.toggleFilters() },
		{
			...base,
			id: `${prefix}clearFilters`,
			label: 'Clear Filters',
			keywords: ['filter', 'reset'],
			enabled: () => (controller.getFilterState().rules.length > 0 ? true : 'No filters to clear.'),
			run: () => controller.clearFilters()
		},
		{ ...base, id: `${prefix}unhideAll`, label: 'Unhide All Rows and Columns', keywords: ['show', 'hidden'], run: () => controller.unhideAll() },
		{ ...base, id: `${prefix}mergeCells`, label: 'Merge Cells', keywords: ['combine'], enabled: hasRange, run: () => controller.mergeCells() },
		{ ...base, id: `${prefix}unmergeCells`, label: 'Unmerge Cells', keywords: ['split'], enabled: hasRange, run: () => controller.unmergeCells() },
		{ ...base, id: `${prefix}transposeRange`, label: 'Transpose Range', keywords: ['rotate', 'swap rows columns'], enabled: hasRange, run: () => controller.transposeRange() }
	];
}
