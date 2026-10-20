import type { SchemaValidationError } from '../tools/schema.js';

export type EffectErrorCode = 'unknown_effect' | 'invalid_values' | 'unsupported' | 'disposed' | 'no_provider';

export const EFFECT_ERROR_CODES: readonly EffectErrorCode[] = ['unknown_effect', 'invalid_values', 'unsupported', 'disposed', 'no_provider'];

/**
 * Base of every effects error. Check `code` (or use `isEffectError`) rather than `instanceof`
 * across packages, since a provider may be bundled with its own copy of this class.
 */
export class EffectError extends Error {
	readonly code: EffectErrorCode;
	readonly effectId?: string;

	constructor(code: EffectErrorCode, message: string, effectId?: string) {
		super(message);
		this.name = 'EffectError';
		this.code = code;
		this.effectId = effectId;
	}
}

/** No effect has this id. */
export class UnknownEffectError extends EffectError {
	constructor(effectId: string, providerName?: string) {
		super(
			'unknown_effect',
			`Unknown effect "${effectId}"${providerName ? ` in ${providerName}` : ''}. Call search_effects or list() for valid ids.`,
			effectId
		);
		this.name = 'UnknownEffectError';
	}
}

/** Control values do not match the effect's control schema (unknown control, wrong type, out of range). */
export class EffectControlError extends EffectError {
	readonly details: readonly SchemaValidationError[];

	constructor(effectId: string, details: readonly SchemaValidationError[]) {
		const lines = details.map((d) => `- ${d.path || '/'}: ${d.message}`).join('\n');
		super('invalid_values', `Invalid values for effect "${effectId}":\n${lines}`, effectId);
		this.name = 'EffectControlError';
		this.details = details;
	}
}

/** The provider cannot do this (a vector effect asked for pixels, a size above `maxSize`, a missing input...). */
export class EffectUnsupportedError extends EffectError {
	constructor(message: string, effectId?: string) {
		super('unsupported', message, effectId);
		this.name = 'EffectUnsupportedError';
	}
}

/** The renderer was disposed. Create a new one. */
export class EffectDisposedError extends EffectError {
	constructor(effectId: string) {
		super('disposed', `The renderer for "${effectId}" was disposed. Create a new renderer.`, effectId);
		this.name = 'EffectDisposedError';
	}
}

/** No effects provider is registered with this editor. */
export class NoEffectsProviderError extends EffectError {
	constructor() {
		super('no_provider', 'No effects provider is registered with this editor. The host must call setEffectsProvider(provider) first.');
		this.name = 'NoEffectsProviderError';
	}
}

/** True for any effects error, including one thrown by another copy of this module. */
export function isEffectError(error: unknown): error is EffectError {
	if (error instanceof EffectError) return true;
	const code = error instanceof Error ? (error as unknown as { code?: unknown }).code : undefined;
	return typeof code === 'string' && EFFECT_ERROR_CODES.includes(code as EffectErrorCode);
}
