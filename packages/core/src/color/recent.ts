/**
 * Recent colours history list manager.
 */

import { normalizeColor } from './format.js';

/**
 * Normalises a colour and pushes it to the front of a recents list, removing duplicates
 * and trimming to `max` items. Returns the original list unchanged if the colour cannot be read.
 */
export function pushRecentColor(list: readonly string[], color: string, max = 12): string[] {
	const normal = normalizeColor(color);
	if (!normal) return list.slice();
	const next = [normal, ...list.filter((c) => normalizeColor(c) !== normal)];
	return next.slice(0, max);
}
