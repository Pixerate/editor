/**
 * Guards against prototype pollution from untrusted JSON (GHSA-cp6q-959q-f8rh).
 *
 * `JSON.parse('{"__proto__": {...}}')` creates an *own* `__proto__` key. Code
 * that later copies keys with bracket assignment (`out[key] = value`,
 * `Object.assign`) turns it into the copy's prototype, so the copy inherits
 * attacker-chosen properties that `for…in` loops (ProseMirror's
 * `DOMSerializer.renderSpec`, for one) then treat as real ones. TipTap's
 * `mergeAttributes()` did exactly that before `@tiptap/core` 2.27.3 / 3.30.4.
 *
 * This file has no dependencies so the tool layer can use it.
 */

/** Keys that are dropped from untrusted JSON objects. */
export const UNSAFE_JSON_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Whether `key` is one of {@link UNSAFE_JSON_KEYS}. */
export const isUnsafeJsonKey = (key: string): boolean => UNSAFE_JSON_KEYS.has(key);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (value === null || typeof value !== 'object') return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};

function hasUnsafeKeys(value: unknown, seen: Set<object>): boolean {
	if (value === null || typeof value !== 'object' || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => hasUnsafeKeys(item, seen));
	if (!isPlainObject(value)) return false;
	for (const key of Object.keys(value)) {
		if (isUnsafeJsonKey(key) || hasUnsafeKeys(value[key], seen)) return true;
	}
	return false;
}

function strip(value: unknown, seen: Map<object, unknown>): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (seen.has(value)) return seen.get(value);
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		seen.set(value, out);
		for (const item of value) out.push(strip(item, seen));
		return out;
	}
	// Class instances (Date, Map, ProseMirror nodes, …) are not JSON and are left alone.
	if (!isPlainObject(value)) return value;
	const out: Record<string, unknown> = {};
	seen.set(value, out);
	for (const key of Object.keys(value)) {
		if (isUnsafeJsonKey(key)) continue;
		out[key] = strip(value[key], seen);
	}
	return out;
}

/**
 * Returns `value` without own `__proto__`, `constructor` and `prototype` keys
 * at any depth of its plain objects and arrays. Run untrusted JSON through it
 * before handing it to `setContent`, `Node.fromJSON`, `Slice.fromJSON` or any
 * code that merges objects key by key.
 *
 * Returns `value` itself when there is nothing to strip, and a copy otherwise,
 * so the input is never mutated. Non-plain objects (class instances) pass
 * through untouched.
 */
export function stripPrototypeKeys<T>(value: T): T {
	if (!hasUnsafeKeys(value, new Set())) return value;
	return strip(value, new Map()) as T;
}
