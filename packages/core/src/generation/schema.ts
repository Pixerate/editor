import type { JsonSchema } from '../agent/schema.js';
import {
	REFERENCE_ROLE_LABELS,
	seedCapability,
	supportedModes,
	supportedReferenceRoles,
	textFieldCapability,
	type EnumCapability,
	type ExtraParamSpec,
	type ModelCapabilities
} from './capabilities.js';

function enumSchema(cap: EnumCapability<string>, description: string): JsonSchema {
	return {
		type: 'string',
		enum: [...cap.options],
		...(cap.default !== undefined ? { default: cap.default } : {}),
		description
	};
}

function paramSchema(name: string, spec: ExtraParamSpec): JsonSchema {
	const description = spec.description ?? spec.label ?? name;
	if (spec.type === 'boolean') {
		return { type: 'boolean', description, ...(spec.default !== undefined ? { default: spec.default } : {}) };
	}
	if (spec.type === 'enum') {
		const numeric = spec.options.every((o) => typeof o === 'number');
		return {
			type: numeric ? 'number' : 'string',
			enum: [...spec.options],
			description,
			...(spec.default !== undefined ? { default: spec.default } : {})
		};
	}
	return {
		type: spec.type,
		description: spec.step !== undefined ? `${description} (step ${spec.step})` : description,
		...(spec.min !== undefined ? { minimum: spec.min } : {}),
		...(spec.max !== undefined ? { maximum: spec.max } : {}),
		...(spec.default !== undefined ? { default: spec.default } : {})
	};
}

/**
 * JSON Schema for a request to one model: enums for choices, `minimum` /
 * `maximum` for ranges, `maxItems` for reference lists and `description`s that
 * spell out limits the schema cannot express (per-role reference counts,
 * resolved-prompt length). Unsupported fields are absent and
 * `additionalProperties` is `false`, so `validateJsonSchema` rejects them.
 */
export function capabilitiesToJsonSchema(caps: ModelCapabilities): JsonSchema & { type: 'object' } {
	const properties: Record<string, JsonSchema> = {
		model: { type: 'string', const: caps.id, description: 'Model id.' }
	};
	const required: string[] = [];

	const prompt = caps.prompt ?? {};
	const countResolved = prompt.countResolved ?? true;
	properties.prompt = {
		type: 'string',
		description:
			prompt.maxLength !== undefined
				? `Prompt text. At most ${prompt.maxLength} characters${countResolved ? ' after templates and variables are resolved' : ''}.`
				: 'Prompt text.',
		...(prompt.maxLength !== undefined && !countResolved ? { maxLength: prompt.maxLength } : {}),
		...(prompt.required ? { minLength: 1 } : {})
	};
	if (prompt.required) required.push('prompt');

	const negative = textFieldCapability(caps.negativePrompt);
	if (negative) {
		properties.negativePrompt = {
			type: 'string',
			description: 'What to avoid in the output.',
			...(negative.maxLength !== undefined ? { maxLength: negative.maxLength } : {})
		};
	}
	const system = textFieldCapability(caps.systemPrompt);
	if (system) {
		properties.systemPrompt = {
			type: 'string',
			description: 'System instructions.',
			...(system.maxLength !== undefined ? { maxLength: system.maxLength } : {})
		};
	}

	if (caps.aspectRatios?.options.length) properties.aspectRatio = enumSchema(caps.aspectRatios, 'Aspect ratio (width:height).');
	if (caps.resolutions?.options.length) properties.resolution = enumSchema(caps.resolutions, 'Output resolution, low to high.');
	if (caps.quality?.options.length) properties.quality = enumSchema(caps.quality, 'Quality level, low to high.');

	if (caps.count) {
		const options = caps.count.options?.filter((o) => o >= 1 && o <= caps.count!.max);
		properties.count = options?.length
			? { type: 'integer', enum: options, description: 'Number of outputs.' }
			: { type: 'integer', minimum: 1, maximum: caps.count.max, description: 'Number of outputs.' };
		if (caps.count.default !== undefined) properties.count.default = caps.count.default;
	}

	if (caps.duration) {
		const d = caps.duration;
		const options = d.options?.filter((o) => (d.min === undefined || o >= d.min) && (d.max === undefined || o <= d.max));
		properties.duration = options?.length
			? { type: 'number', enum: options, description: 'Duration in seconds.' }
			: {
					type: 'number',
					description: d.step !== undefined ? `Duration in seconds (step ${d.step}).` : 'Duration in seconds.',
					...(d.min !== undefined ? { minimum: d.min } : {}),
					...(d.max !== undefined ? { maximum: d.max } : {})
				};
		if (d.default !== undefined) properties.duration.default = d.default;
	}

	const seed = seedCapability(caps.seed);
	if (seed) {
		properties.seed = {
			type: 'integer',
			description: 'Random seed for reproducible output.',
			...(seed.min !== undefined ? { minimum: seed.min } : {}),
			...(seed.max !== undefined ? { maximum: seed.max } : {})
		};
	}

	const modes = supportedModes(caps);
	if (modes.length > 1) {
		properties.mode = { type: 'string', enum: modes, default: 'generate', description: 'Generate, edit a source, or inpaint with a mask.' };
	}

	const roles = supportedReferenceRoles(caps);
	if (caps.inpainting && !roles.includes('mask')) roles.push('mask');
	if (roles.length > 0) {
		const limits = roles.map((role) => {
			const cap = caps.references?.roles[role] ?? { max: 1 };
			const min = cap.min ? `${cap.min}–` : 'up to ';
			return `${role} (${cap.label ?? REFERENCE_ROLE_LABELS[role]}): ${min}${cap.max}`;
		});
		const perRoleTotal = roles.reduce((sum, role) => sum + (caps.references?.roles[role]?.max ?? 1), 0);
		const maxItems = Math.min(caps.references?.maxTotal ?? Infinity, perRoleTotal);
		properties.references = {
			type: 'array',
			description: `Reference inputs by role. Limits: ${limits.join('; ')}${
				caps.references?.maxTotal !== undefined ? `; at most ${caps.references.maxTotal} in total` : ''
			}.`,
			maxItems,
			items: {
				type: 'object',
				properties: {
					id: { type: 'string', minLength: 1, description: 'Asset id.' },
					role: { type: 'string', enum: roles },
					url: { type: 'string' }
				},
				required: ['id', 'role'],
				additionalProperties: false
			}
		};
		if (roles.some((role) => (caps.references?.roles[role]?.min ?? 0) > 0)) required.push('references');
	}

	const params = Object.entries(caps.params ?? {});
	if (params.length > 0) {
		properties.params = {
			type: 'object',
			description: 'Model-specific parameters.',
			properties: Object.fromEntries(params.map(([name, spec]) => [name, paramSchema(name, spec)])),
			additionalProperties: false
		};
	}

	return {
		type: 'object',
		title: caps.name ?? caps.id,
		description: `${caps.description ? `${caps.description} ` : ''}(${caps.media} model "${caps.id}")`,
		properties,
		...(required.length ? { required } : {}),
		additionalProperties: false
	};
}
