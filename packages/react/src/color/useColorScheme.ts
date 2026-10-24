import { useSyncExternalStore, useMemo } from 'react';
import type { ColorScheme, ColorValue } from '@pixerate/editor/color';
import { resolveColor } from '@pixerate/editor/color';

export interface UseColorSchemeOptions {
	/** Explicit scheme override ('light' or 'dark'). If provided, takes precedence over document and system. */
	override?: ColorScheme | null;
	/** Attribute on documentElement to watch (e.g. 'data-theme' or 'class'). 'class' checks for presence of 'dark'. */
	attribute?: string;
}

function getSnapshot(attribute?: string): ColorScheme {
	if (typeof window === 'undefined' || typeof document === 'undefined') {
		return 'light';
	}
	if (attribute) {
		const el = document.documentElement;
		if (attribute === 'class') {
			return el.classList.contains('dark') ? 'dark' : 'light';
		}
		const val = el.getAttribute(attribute);
		return val === 'dark' ? 'dark' : 'light';
	}
	if (typeof window.matchMedia === 'function') {
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	}
	return 'light';
}

function getServerSnapshot(): ColorScheme {
	return 'light';
}

/**
 * Returns the active color scheme ('light' or 'dark'), tracking DOM element attributes or system prefers-color-scheme.
 */
export function useColorScheme(options?: UseColorSchemeOptions): ColorScheme {
	const override = options?.override;
	const attribute = options?.attribute;

	const subscribe = useMemo(() => {
		return (callback: () => void) => {
			if (typeof window === 'undefined' || typeof document === 'undefined') {
				return () => {};
			}

			if (attribute) {
				const observer = new MutationObserver(() => {
					callback();
				});
				observer.observe(document.documentElement, {
					attributes: true,
					attributeFilter: [attribute]
				});
				return () => observer.disconnect();
			}

			if (typeof window.matchMedia === 'function') {
				const mql = window.matchMedia('(prefers-color-scheme: dark)');
				const handler = () => callback();
				mql.addEventListener('change', handler);
				return () => mql.removeEventListener('change', handler);
			}

			return () => {};
		};
	}, [attribute]);

	const detected = useSyncExternalStore(
		subscribe,
		() => getSnapshot(attribute),
		getServerSnapshot
	);

	return override ?? detected;
}

/**
 * Resolves a colour value (plain colour, dual colour object, or light-dark() string)
 * to a normalised hex string for the current or specified scheme.
 */
export function useResolvedColor(value: ColorValue, scheme?: ColorScheme): string | null {
	const detectedScheme = useColorScheme();
	const activeScheme = scheme ?? detectedScheme;
	return resolveColor(value, activeScheme);
}
