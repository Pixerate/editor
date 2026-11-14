import { createLinkFocus, type LinkFocusModel, type LinkFocusOptions, type LinkFocusState } from '@pixerate/editor/tools';

export interface LinkFocusBinding {
	readonly model: LinkFocusModel;
	/** The model's state, reactive. */
	readonly state: LinkFocusState;
	/** The focused key and its links, reactive, for a live region. */
	readonly description: string;
	/** Spread on a mark's element (the key it focuses). */
	mark(key: string): { onpointerenter: () => void; onfocus: () => void; 'data-link-focus': string };
	/** Spread on the picture's container: arrow keys, Home, End, Escape, and clearing on leave. */
	readonly root: { onkeydown: (event: KeyboardEvent) => void; onpointerleave: () => void; onfocusout: (event: FocusEvent) => void };
	/** Opacity for the mark at `index`: 1 when lit, the model's `dim` otherwise. */
	opacity(index: number): number;
	/** Stops following the model. */
	destroy(): void;
}

/**
 * Focus across linked marks (#812) with Svelte 5 runes: follows a `createLinkFocus` model (pass
 * one, or the options to create it). Hovering or focusing a mark lights it and everything linked to
 * it; arrow keys walk the keys, Escape clears, and leaving the picture clears too.
 */
export function linkFocusOf(input: LinkFocusModel | LinkFocusOptions): LinkFocusBinding {
	const model: LinkFocusModel = 'getState' in input ? input : createLinkFocus(input);
	let current = $state.raw(model.getState());
	const unsubscribe = model.subscribe((next) => {
		current = next;
	});
	const root = {
		onkeydown: (event: KeyboardEvent) => {
			if (model.handleKey(event)) event.preventDefault();
		},
		onpointerleave: () => {
			model.clear();
		},
		onfocusout: (event: FocusEvent) => {
			const container = event.currentTarget as Element | null;
			if (!container?.contains(event.relatedTarget as Node | null)) model.clear();
		}
	};
	return {
		model,
		get state() {
			return current;
		},
		get description() {
			return model.describe(current.focus);
		},
		mark: (key) => ({ onpointerenter: () => model.focus(key), onfocus: () => model.focus(key), 'data-link-focus': key }),
		root,
		opacity: (index) => (current.lit[index] ? 1 : model.dim),
		destroy: () => {
			unsubscribe();
		}
	};
}
