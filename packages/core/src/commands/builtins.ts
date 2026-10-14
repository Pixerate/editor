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
