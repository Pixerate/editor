import { isEventFromTextInput } from './clipboard.js';

/**
 * Canvas arrangement actions that have keyboard shortcuts.
 */
export type CanvasArrangeAction =
	| 'alignLeft'
	| 'alignCenter'
	| 'alignRight'
	| 'alignTop'
	| 'alignMiddle'
	| 'alignBottom'
	| 'distributeHorizontal'
	| 'distributeVertical'
	| 'lock'
	| 'unlock'
	| 'bringForward'
	| 'sendBackward'
	| 'bringToFront'
	| 'sendToBack'
	| 'nextScene'
	| 'previousScene';

export interface ArrangeShortcutBinding {
	action: CanvasArrangeAction;
	/** `KeyboardEvent.code` (layout- and Option-independent, e.g. `KeyA`, `BracketRight`). */
	code: string;
	mod?: boolean;
	alt?: boolean;
	shift?: boolean;
	/** Human readable label, e.g. for menus. `Mod` is ⌘ on macOS and Ctrl elsewhere. */
	label: string;
}

/**
 * Default bindings. Align/distribute follow Figma (Option/Alt + letter), layer order follows
 * the common `Mod+]` / `Mod+[` convention, lock follows Keynote/Freeform (`Mod+L`,
 * `Mod+Alt+L` to unlock) and scenes step with PageDown / PageUp.
 */
export const DEFAULT_ARRANGE_SHORTCUTS: readonly ArrangeShortcutBinding[] = [
	{ action: 'alignLeft', code: 'KeyA', alt: true, label: 'Alt+A' },
	{ action: 'alignCenter', code: 'KeyH', alt: true, label: 'Alt+H' },
	{ action: 'alignRight', code: 'KeyD', alt: true, label: 'Alt+D' },
	{ action: 'alignTop', code: 'KeyW', alt: true, label: 'Alt+W' },
	{ action: 'alignMiddle', code: 'KeyV', alt: true, label: 'Alt+V' },
	{ action: 'alignBottom', code: 'KeyS', alt: true, label: 'Alt+S' },
	{ action: 'distributeHorizontal', code: 'KeyH', alt: true, shift: true, label: 'Alt+Shift+H' },
	{ action: 'distributeVertical', code: 'KeyV', alt: true, shift: true, label: 'Alt+Shift+V' },
	{ action: 'lock', code: 'KeyL', mod: true, label: 'Mod+L' },
	{ action: 'unlock', code: 'KeyL', mod: true, alt: true, label: 'Mod+Alt+L' },
	{ action: 'bringForward', code: 'BracketRight', mod: true, label: 'Mod+]' },
	{ action: 'sendBackward', code: 'BracketLeft', mod: true, label: 'Mod+[' },
	{ action: 'bringToFront', code: 'BracketRight', mod: true, alt: true, label: 'Mod+Alt+]' },
	{ action: 'sendToBack', code: 'BracketLeft', mod: true, alt: true, label: 'Mod+Alt+[' },
	{ action: 'nextScene', code: 'PageDown', label: 'PageDown' },
	{ action: 'previousScene', code: 'PageUp', label: 'PageUp' }
];

const KEY_TO_CODE: Record<string, string> = {
	']': 'BracketRight',
	'[': 'BracketLeft',
	PageDown: 'PageDown',
	PageUp: 'PageUp'
};

function eventCode(event: KeyboardEvent): string {
	if (event.code) return event.code;
	// Synthetic events (and some test environments) omit `code`; derive it from `key`.
	if (KEY_TO_CODE[event.key]) return KEY_TO_CODE[event.key];
	if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
	return event.key;
}

/**
 * Resolves a keydown event to an arrange action, or `null`. Events from text inputs,
 * textareas, selects, contenteditable and ProseMirror are ignored (see `isEventFromTextInput`).
 * `Mod` is ⌘ or Ctrl.
 */
export function matchArrangeShortcut(
	event: KeyboardEvent,
	bindings: readonly ArrangeShortcutBinding[] = DEFAULT_ARRANGE_SHORTCUTS
): CanvasArrangeAction | null {
	if (isEventFromTextInput(event)) return null;
	const code = eventCode(event);
	const mod = event.metaKey || event.ctrlKey;
	for (const binding of bindings) {
		if (
			binding.code === code &&
			!!binding.mod === mod &&
			!!binding.alt === event.altKey &&
			!!binding.shift === event.shiftKey
		) {
			return binding.action;
		}
	}
	return null;
}
