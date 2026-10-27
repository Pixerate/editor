import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument.js';
import { checkTokenAlias, parseTokenState } from './model.js';
import type { TokenState } from './types.js';
import type { TokenStore } from './store.js';

/**
 * The save / load / undo contract for a `TokenStore` (kind `tokens`, document: the
 * `TokenState` of collections, modes and variables). A recorded load (agents) is one undo step
 * and refuses a state with any problem; opening a file (`history: "reset"`) keeps what
 * `parseTokenState` can read and reports the rest in the `LoadReport`.
 */
export function createTokensEditorDocument(store: TokenStore): EditorDocument<TokenState> {
	return defineEditorDocument<TokenState>({
		kind: 'tokens',
		get: () => store.toJSON(),
		load: (document, { history }) => {
			const { state, issues } = parseTokenState(document);
			if (history === 'record') {
				for (const variable of state.variables) {
					for (const value of Object.values(variable.valuesByMode)) {
						if (typeof value !== 'object' || value === null) continue;
						const error = checkTokenAlias(state, variable, value.alias);
						if (error) issues.push({ message: error.message, variableId: variable.id });
					}
				}
				if (issues.length) {
					const found = issues.map((i) => `${i.message}${i.variableId ? ` (${i.variableId})` : i.collectionId ? ` (${i.collectionId})` : ''}.`).join(' ');
					throw new Error(`${found} A tokens document is { collections: [{ id, name, modes }], variables: [{ id, collectionId, name, type, valuesByMode }] } as get_tokens_document returns it.`);
				}
				store.replaceState(state, { record: true, reason: 'Load tokens' });
				return;
			}
			store.replaceState(state, { reason: 'load' });
			return { problems: issues.map((i) => ({ section: i.variableId ?? i.collectionId ?? 'tokens', message: i.message })) };
		},
		subscribe: (listener) => store.subscribe(() => listener()),
		history: {
			undo: () => store.undo(),
			redo: () => store.redo(),
			getState: () => ({ canUndo: store.canUndo(), canRedo: store.canRedo() })
		}
	});
}
