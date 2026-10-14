import {
	bindCanvasToken,
	detachTokenBindings,
	getEffectiveTokenModes,
	resolveCanvasTokens,
	setCanvasTokenMode,
	type CanvasTokenOptions
} from '@pixerate/editor/canvas';
import type { TokenModeContext, TokenState, TokenStore } from '@pixerate/editor/tokens';
import type { CanvasNode } from './types.js';

export interface CreateCanvasTokensOptions<TNode extends CanvasNode = CanvasNode> extends Omit<CanvasTokenOptions, 'modes'> {
	store: TokenStore;
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	/** Modes for nodes without an explicit mode up their tree, or a getter for reactive modes. */
	modes?: TokenModeContext | (() => TokenModeContext | undefined);
}

/**
 * Headless Svelte 5 rune keeping token-bound node properties resolved. Token edits, undo and
 * redo re-resolve the nodes; deleting a variable detaches the nodes bound to it, keeping their
 * values. Call `resolve()` after changing the nodes yourself (e.g. pasting bound nodes, or
 * switching the root `modes`); `bind` and `setMode` resolve on their own.
 */
export function createCanvasTokens<TNode extends CanvasNode = CanvasNode>(options: CreateCanvasTokensOptions<TNode>) {
	const { store } = options;
	let state = $state.raw<TokenState>(store.getState());
	const opts = (): CanvasTokenOptions => ({
		modes: typeof options.modes === 'function' ? options.modes() : options.modes,
		properties: options.properties
	});
	const commit = (next: TNode[]) => {
		if (next !== options.getNodes()) options.setNodes(next);
	};
	const resolve = () => commit(resolveCanvasTokens(options.getNodes() as any, store.getState(), opts()) as TNode[]);

	const unsubscribe = store.subscribe((event) => {
		state = event.state;
		let nodes = options.getNodes() as any[];
		if (event.deletedVariableIds.length > 0) nodes = detachTokenBindings(nodes, event.previous, event.deletedVariableIds, opts());
		commit(resolveCanvasTokens(nodes, event.state, opts()) as TNode[]);
	});

	return {
		/** The token store's state (reactive). */
		get state() {
			return state;
		},
		/** Binds (or with `null` unbinds) a property of the nodes; throws `TokenError` when refused. */
		bind(ids: Iterable<string>, propertyKey: string, variableId: string | null) {
			commit(bindCanvasToken(options.getNodes() as any[], ids, propertyKey, variableId, store.getState(), opts()) as TNode[]);
		},
		/** Sets (or with `null` clears) an explicit mode on frames / groups; descendants follow. */
		setMode(ids: Iterable<string>, collectionId: string, modeId: string | null) {
			commit(setCanvasTokenMode(options.getNodes() as any[], ids, collectionId, modeId, store.getState(), opts()) as TNode[]);
		},
		/** The modes a node is in (its own, inherited, then the root `modes`). */
		modesOf(nodeId: string): Record<string, string> {
			const nodes = options.getNodes() as any[];
			const node = nodes.find((n) => n.id === nodeId);
			return node ? getEffectiveTokenModes(node, nodes, store.getState(), opts()) : {};
		},
		/** Re-resolves every bound property (after changing nodes or root modes). */
		resolve,
		destroy: unsubscribe
	};
}

export type SvelteCanvasTokens = ReturnType<typeof createCanvasTokens>;
