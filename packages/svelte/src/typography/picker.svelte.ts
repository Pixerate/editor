import type { FontPickerModel, FontPickerState } from '@pixerate/editor/typography';

export interface FontPickerBinding {
	/** The model's state, reactive. */
	readonly state: FontPickerState;
	readonly model: FontPickerModel;
	/** Stops following the model. */
	destroy(): void;
}

/**
 * Follows a {@link FontPickerModel} with Svelte 5 runes: `binding.state` updates whenever the model
 * changes (from the UI or from its agent tools). Call `destroy()` when the component unmounts.
 */
export function fontPickerOf(model: FontPickerModel): FontPickerBinding {
	let current = $state.raw(model.getState());
	const unsubscribe = model.subscribe((next) => {
		current = next;
	});
	return {
		get state() {
			return current;
		},
		model,
		destroy: () => {
			unsubscribe();
		}
	};
}
