import type { ModelCapabilities } from './capabilities.js';

/**
 * Stable JSON: object keys sorted, `undefined` members left out, so equal
 * values always give the same string regardless of key order.
 */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
	if (value && typeof value === 'object') {
		const entries = Object.keys(value as object)
			.filter((key) => (value as any)[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify((value as any)[key])}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

const FNV_PRIME = 0x01000193;

/**
 * A short, stable, synchronous content hash (two independent 32-bit FNV-1a
 * lanes over the UTF-16 code units, 16 hex digits, prefixed with `h1-`).
 * It detects changes; it is not cryptographic, so do not use it to
 * authenticate content.
 */
export function hashText(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x2f0e1d5b;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		a = Math.imul(a ^ (unit & 0xff), FNV_PRIME);
		a = Math.imul(a ^ (unit >>> 8), FNV_PRIME);
		b = Math.imul(b ^ (unit >>> 8), FNV_PRIME);
		b = Math.imul(b ^ (unit & 0xff), FNV_PRIME);
		b ^= b >>> 15;
	}
	// Final avalanche so short inputs still spread over all digits.
	a ^= a >>> 16;
	a = Math.imul(a, 0x85ebca6b);
	a ^= a >>> 13;
	b ^= b >>> 16;
	b = Math.imul(b, 0xc2b2ae35);
	b ^= b >>> 13;
	const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
	return `h1-${hex(a)}${hex(b)}`;
}

/** {@link hashText} of the {@link stableStringify} form of `value`. */
export function hashValue(value: unknown): string {
	return hashText(stableStringify(value));
}

const PRESENTATION_ONLY = new Set(['name', 'description', 'badges', 'icon', 'group', 'timing']);

/**
 * Hash of what a model accepts. Presentation fields (`name`, `description`,
 * `badges`, `icon`, `group`) and `timing` are left out, so renaming a model or
 * changing its progress estimate is not reported as a capability change.
 */
export function hashCapabilities(caps: ModelCapabilities): string {
	const relevant: Record<string, unknown> = {};
	for (const key of Object.keys(caps)) {
		if (!PRESENTATION_ONLY.has(key)) relevant[key] = (caps as any)[key];
	}
	return hashValue(relevant);
}
