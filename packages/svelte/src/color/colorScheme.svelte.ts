import type { ColorScheme, ColorValue } from '@pixerate/editor/color';
import { resolveColor } from '@pixerate/editor/color';

export interface ColorSchemeOptions {
	/** Explicit scheme override ('light' or 'dark') */
	override?: ColorScheme | null;
	/** Attribute on document.documentElement to monitor for theme changes (default: 'data-theme') */
	attribute?: string;
}

export interface ColorSchemeStore {
	readonly current: ColorScheme;
	destroy(): void;
}

/**
 * Headless Svelte 5 rune tracking active colour scheme across media query and document attribute.
 */
export function createColorScheme(options: ColorSchemeOptions = {}): ColorSchemeStore {
	let system = $state<ColorScheme>('light');
	let attrValue = $state<ColorScheme | null>(null);

	const attributeName = options.attribute ?? 'data-theme';

	function readSystem(): ColorScheme {
		if (typeof window === 'undefined' || !window.matchMedia) return 'light';
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	}

	function readAttribute(): ColorScheme | null {
		if (typeof document === 'undefined') return null;
		const val = document.documentElement.getAttribute(attributeName)?.toLowerCase();
		if (val === 'dark' || val === 'light') return val;
		return null;
	}

	system = readSystem();
	attrValue = readAttribute();

	let mqlListener: ((e: MediaQueryListEvent) => void) | null = null;
	let observer: MutationObserver | null = null;

	if (typeof window !== 'undefined' && window.matchMedia) {
		const mql = window.matchMedia('(prefers-color-scheme: dark)');
		mqlListener = (e: MediaQueryListEvent) => {
			system = e.matches ? 'dark' : 'light';
		};
		if (mql.addEventListener) {
			mql.addEventListener('change', mqlListener);
		} else {
			mql.addListener(mqlListener);
		}
	}

	if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
		observer = new MutationObserver(() => {
			attrValue = readAttribute();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: [attributeName]
		});
	}

	function destroy() {
		if (mqlListener && typeof window !== 'undefined' && window.matchMedia) {
			const mql = window.matchMedia('(prefers-color-scheme: dark)');
			if (mql.removeEventListener) {
				mql.removeEventListener('change', mqlListener);
			} else {
				mql.removeListener(mqlListener);
			}
			mqlListener = null;
		}
		if (observer) {
			observer.disconnect();
			observer = null;
		}
	}

	const current = $derived<ColorScheme>(
		options.override ?? attrValue ?? system
	);

	return {
		get current() {
			return current;
		},
		destroy
	};
}

/**
 * Pure helper resolving a ColorValue against a specific scheme.
 */
export function resolvedColor(value: ColorValue, scheme: ColorScheme): string | null {
	return resolveColor(value, scheme);
}
