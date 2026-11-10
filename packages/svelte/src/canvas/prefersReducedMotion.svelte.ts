const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Follows `prefers-reduced-motion: reduce`: `current` is true while the user asks for reduced
 * motion. Create it in a component (it listens until the component is destroyed).
 */
export function createPrefersReducedMotion(): { readonly current: boolean } {
	const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : null;
	let reduced = $state(query?.matches ?? false);
	$effect(() => {
		if (!query) return;
		const update = () => (reduced = query.matches);
		update();
		query.addEventListener?.('change', update);
		return () => query.removeEventListener?.('change', update);
	});
	return {
		get current() {
			return reduced;
		}
	};
}
