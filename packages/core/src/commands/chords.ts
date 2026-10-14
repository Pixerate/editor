// Portions ported from filmcraft-main/crates/engine/src/shortcuts.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Keyboard chords in a platform-neutral notation.
 *
 * | token | macOS | Windows / Linux |
 * |---|---|---|
 * | `Mod` | ⌘ Command | Ctrl |
 * | `Ctrl` | ⌃ Control | Ctrl (same key as `Mod`: conflicts are reported) |
 * | `Meta` / `Cmd` | ⌘ Command | Win / Super |
 * | `Alt` / `Option` | ⌥ Option | Alt |
 * | `Shift` | ⇧ Shift | Shift |
 *
 * Keys are stored as `KeyboardEvent.code` values (`KeyZ`, `Digit1`, `BracketRight`,
 * `PageDown`), so Option/Alt chords work on macOS (where Option changes `event.key`).
 */

export type Platform = 'mac' | 'windows' | 'linux';

export const PLATFORMS: readonly Platform[] = ['mac', 'windows', 'linux'];

/** A parsed chord. `mod` is the platform's primary modifier. */
export interface Chord {
	/** `KeyboardEvent.code` of the key, e.g. `KeyZ`. */
	key: string;
	mod?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	alt?: boolean;
	shift?: boolean;
}

/** The modifiers a chord needs on one platform (`mod` resolved to `meta` or `ctrl`). */
export interface EffectiveChord {
	key: string;
	ctrl: boolean;
	meta: boolean;
	alt: boolean;
	shift: boolean;
}

/** The current platform from `navigator` (`linux` when unknown, e.g. in Node). */
export function detectPlatform(): Platform {
	const nav = typeof navigator !== 'undefined' ? navigator : undefined;
	const text = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
	if (/Mac|iPod|iPhone|iPad/.test(nav?.platform || nav?.userAgent || '')) return 'mac';
	if (/Win/.test(text)) return 'windows';
	return 'linux';
}

// Characters and names → `KeyboardEvent.code`.
const NAMED_KEYS: Record<string, string> = {
	'[': 'BracketLeft',
	']': 'BracketRight',
	'-': 'Minus',
	'=': 'Equal',
	plus: 'Equal',
	',': 'Comma',
	'.': 'Period',
	'/': 'Slash',
	'\\': 'Backslash',
	';': 'Semicolon',
	"'": 'Quote',
	'`': 'Backquote',
	enter: 'Enter',
	return: 'Enter',
	'↩': 'Enter',
	escape: 'Escape',
	esc: 'Escape',
	'⎋': 'Escape',
	space: 'Space',
	spacebar: 'Space',
	' ': 'Space',
	tab: 'Tab',
	'⇥': 'Tab',
	backspace: 'Backspace',
	'⌫': 'Backspace',
	delete: 'Delete',
	del: 'Delete',
	'⌦': 'Delete',
	insert: 'Insert',
	home: 'Home',
	end: 'End',
	pageup: 'PageUp',
	pgup: 'PageUp',
	pagedown: 'PageDown',
	pgdn: 'PageDown',
	up: 'ArrowUp',
	arrowup: 'ArrowUp',
	'↑': 'ArrowUp',
	down: 'ArrowDown',
	arrowdown: 'ArrowDown',
	'↓': 'ArrowDown',
	left: 'ArrowLeft',
	arrowleft: 'ArrowLeft',
	'←': 'ArrowLeft',
	right: 'ArrowRight',
	arrowright: 'ArrowRight',
	'→': 'ArrowRight',
	bracketleft: 'BracketLeft',
	bracketright: 'BracketRight',
	minus: 'Minus',
	equal: 'Equal',
	comma: 'Comma',
	period: 'Period',
	slash: 'Slash',
	backslash: 'Backslash',
	semicolon: 'Semicolon',
	quote: 'Quote',
	backquote: 'Backquote'
};

const CODE_TEXT: Record<string, string> = {
	BracketLeft: '[',
	BracketRight: ']',
	Minus: '-',
	Equal: '=',
	Comma: ',',
	Period: '.',
	Slash: '/',
	Backslash: '\\',
	Semicolon: ';',
	Quote: "'",
	Backquote: '`',
	ArrowUp: 'Up',
	ArrowDown: 'Down',
	ArrowLeft: 'Left',
	ArrowRight: 'Right'
};

const MAC_KEY_GLYPHS: Record<string, string> = {
	Backspace: '⌫',
	Delete: '⌦',
	Enter: '↩',
	Escape: '⎋',
	Tab: '⇥',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	PageUp: 'Page Up',
	PageDown: 'Page Down',
	Space: 'Space'
};

const KNOWN_CODES = new Set([
	...Object.values(NAMED_KEYS),
	'Enter',
	'Escape',
	'Space',
	'Tab',
	'Backspace',
	'Delete',
	'Insert',
	'Home',
	'End',
	'PageUp',
	'PageDown'
]);

/** `KeyboardEvent.code` for a key token (`Z`, `1`, `]`, `PageDown`, `F5`, `KeyZ`), or `null`. */
export function keyToCode(token: string): string | null {
	if (!token) return null;
	if (/^[a-z]$/i.test(token)) return `Key${token.toUpperCase()}`;
	if (/^[0-9]$/.test(token)) return `Digit${token}`;
	if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase();
	if (/^Key[A-Z]$/.test(token) || /^Digit[0-9]$/.test(token) || /^Numpad\w+$/.test(token)) return token;
	if (KNOWN_CODES.has(token)) return token;
	return NAMED_KEYS[token] ?? NAMED_KEYS[token.toLowerCase().replace(/[\s_]/g, '')] ?? null;
}

/** Neutral text for a code: `KeyZ` → `Z`, `BracketRight` → `]`, `ArrowUp` → `Up`. */
export function codeToKeyText(code: string): string {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	return CODE_TEXT[code] ?? code;
}

const GLYPH_MODIFIERS: Record<string, string> = { '⌘': 'Meta+', '⌃': 'Ctrl+', '⌥': 'Alt+', '⇧': 'Shift+' };

/**
 * Parses chord text (`Mod+Shift+Z`, `Alt+]`, `⌥⇧⌘K`, `CmdOrCtrl+K`). Throws on unknown
 * modifiers or keys. The last `+`-separated token is the key (`+` itself is `Plus`).
 */
export function parseChord(text: string): Chord {
	const source = text.trim();
	if (!source) throw new Error('Empty shortcut.');
	let expanded = '';
	for (const ch of source) expanded += GLYPH_MODIFIERS[ch] ?? ch;
	const parts = expanded
		.split('+')
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length === 0) throw new Error(`"${text}" has no key.`);
	const chord: Chord = { key: '' };
	parts.forEach((part, index) => {
		const low = part.toLowerCase();
		const isLast = index === parts.length - 1;
		if (low === 'mod' || low === 'cmdorctrl' || low === 'commandorcontrol' || low === 'primary') chord.mod = true;
		else if (low === 'ctrl' || low === 'control' || low === 'ctl') chord.ctrl = true;
		else if (low === 'meta' || low === 'cmd' || low === 'command' || low === 'super' || low === 'win') chord.meta = true;
		else if (low === 'alt' || low === 'option' || low === 'opt') chord.alt = true;
		else if (low === 'shift') chord.shift = true;
		else if (isLast) {
			const code = keyToCode(part);
			if (!code) throw new Error(`Unknown key "${part}" in shortcut "${text}".`);
			chord.key = code;
		} else throw new Error(`Unknown modifier "${part}" in shortcut "${text}".`);
	});
	if (!chord.key) throw new Error(`"${text}" has no key.`);
	return chord;
}

/** Canonical platform-neutral text: `Mod+Ctrl+Meta+Alt+Shift+<key>`. */
export function chordToString(chord: Chord): string {
	const parts: string[] = [];
	if (chord.mod) parts.push('Mod');
	if (chord.ctrl) parts.push('Ctrl');
	if (chord.meta) parts.push('Meta');
	if (chord.alt) parts.push('Alt');
	if (chord.shift) parts.push('Shift');
	parts.push(codeToKeyText(chord.key));
	return parts.join('+');
}

/** Canonical spelling of chord text (`shift+cmdorctrl+z` → `Mod+Shift+Z`). Throws when invalid. */
export function normalizeChord(text: string): string {
	return chordToString(parseChord(text));
}

const toChord = (chord: string | Chord): Chord => (typeof chord === 'string' ? parseChord(chord) : chord);

/** The modifiers a chord needs on `platform`: `Mod` is ⌘ (meta) on macOS and Ctrl elsewhere. */
export function effectiveChord(chord: string | Chord, platform: Platform): EffectiveChord {
	const c = toChord(chord);
	const mac = platform === 'mac';
	return {
		key: c.key,
		ctrl: !!c.ctrl || (!mac && !!c.mod),
		meta: !!c.meta || (mac && !!c.mod),
		alt: !!c.alt,
		shift: !!c.shift
	};
}

/** Identity of an effective chord, for conflict detection (`Ctrl+Shift+KeyZ`). */
export function effectiveChordKey(chord: string | Chord, platform: Platform): string {
	const e = effectiveChord(chord, platform);
	return [e.ctrl && 'Ctrl', e.meta && 'Meta', e.alt && 'Alt', e.shift && 'Shift', e.key].filter(Boolean).join('+');
}

/**
 * Display text: `⌥⇧⌘K` on macOS, `Ctrl+Alt+Shift+K` on Windows / Linux (`Meta` shows as
 * `Win` / `Super`). Invalid text is returned unchanged.
 */
export function formatShortcut(chord: string | Chord, platform: Platform = detectPlatform()): string {
	let c: Chord;
	try {
		c = toChord(chord);
	} catch {
		return String(chord);
	}
	const e = effectiveChord(c, platform);
	if (platform === 'mac') {
		const mods = `${e.ctrl ? '⌃' : ''}${e.alt ? '⌥' : ''}${e.shift ? '⇧' : ''}${e.meta ? '⌘' : ''}`;
		return mods + (MAC_KEY_GLYPHS[c.key] ?? codeToKeyText(c.key));
	}
	const parts: string[] = [];
	if (e.ctrl) parts.push('Ctrl');
	if (e.meta) parts.push(platform === 'windows' ? 'Win' : 'Super');
	if (e.alt) parts.push('Alt');
	if (e.shift) parts.push('Shift');
	const key = c.key === 'PageUp' ? 'Page Up' : c.key === 'PageDown' ? 'Page Down' : codeToKeyText(c.key);
	parts.push(key);
	return parts.join('+');
}

/** Minimal keyboard event surface (DOM `KeyboardEvent` satisfies it). */
export interface KeyboardEventLike {
	key?: string;
	code?: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	target?: EventTarget | null | unknown;
	defaultPrevented?: boolean;
	preventDefault?: () => void;
}

/** `event.code`, or one derived from `event.key` for synthetic events without a code. */
export function eventCode(event: KeyboardEventLike): string {
	if (event.code) return event.code;
	return codeFromKey(event.key ?? '') ?? event.key ?? '';
}

/**
 * The key code a shortcut event is matched by: `event.code` (layout-independent, so
 * Option/Alt chords work on macOS and punctuation chords follow the physical key),
 * except that a letter key producing a different Latin letter without Alt (AZERTY,
 * QWERTZ, Dvorak) uses the produced letter, as browsers and operating systems do.
 */
export function shortcutCode(event: KeyboardEventLike): string {
	const code = eventCode(event);
	const key = event.key ?? '';
	if (!event.altKey && /^Key[A-Z]$/.test(code) && /^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
	return code;
}

/** The code a printable `event.key` names on a US layout (`z` → `KeyZ`, `]` → `BracketRight`). */
export function codeFromKey(key: string): string | null {
	if (!key) return null;
	if (key.length === 1) return /^[a-z0-9]$/i.test(key) || key in NAMED_KEYS ? keyToCode(key) : null;
	return keyToCode(key);
}

/**
 * Whether a keyboard event comes from a text-entry element: `<input>`, `<textarea>`,
 * `<select>`, a `contenteditable` element (or a descendant) or a ProseMirror editor.
 * Falls back to `document.activeElement` when the event has no element target.
 */
export function isEditableEventTarget(event: { target?: unknown }): boolean {
	type ElementLike = {
		tagName?: unknown;
		isContentEditable?: boolean;
		closest?: (selector: string) => unknown;
		getAttribute?: (name: string) => string | null;
	};
	let target = (event.target ?? null) as ElementLike | null;
	// Window / document targets are not editable; without a target, check the focused element.
	if (!target) target = typeof document !== 'undefined' ? (document.activeElement as ElementLike | null) : null;
	if (!target || typeof target.tagName !== 'string') return false;
	const tag = target.tagName.toUpperCase();
	return !!(
		tag === 'INPUT' ||
		tag === 'TEXTAREA' ||
		tag === 'SELECT' ||
		target.isContentEditable ||
		target.getAttribute?.('contenteditable') === 'true' ||
		target.closest?.('[contenteditable="true"]') ||
		target.closest?.('.ProseMirror')
	);
}
