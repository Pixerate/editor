import {
	referenceRoleLabel,
	seedCapability,
	supportedModes,
	supportedReferenceRoles,
	textFieldCapability,
	type EnumCapability,
	type GenerationParamValue,
	type GenerationReference,
	type GenerationRequest,
	type ModelCapabilities,
	type ReferenceRole
} from './capabilities.js';

export interface GenerationControlOption {
	value: string | number;
	label: string;
}

/**
 * A UI control derived from capabilities. `key` is a request path:
 * `aspectRatio`, `count`, `params.guidance`, …
 */
export interface GenerationControl {
	key: string;
	label: string;
	/** `select` for choices, `range` for bounded numbers, `number` for open numbers. */
	kind: 'select' | 'range' | 'number' | 'textarea' | 'checkbox';
	valueType: 'string' | 'number' | 'boolean';
	options?: GenerationControlOption[];
	min?: number;
	max?: number;
	step?: number;
	maxLength?: number;
	defaultValue?: string | number | boolean;
	description?: string;
}

export interface ReferenceSlot {
	role: ReferenceRole;
	label: string;
	description?: string;
	min: number;
	max: number;
	/** Media accepted for this role (see `ReferenceRoleCapability.accepts`). */
	accepts?: string[];
	references: GenerationReference[];
	/** More references of this role fit (per role and in total). */
	canAdd: boolean;
}

function enumControl(key: string, label: string, cap: EnumCapability<string> | undefined): GenerationControl | null {
	if (!cap?.options.length) return null;
	return {
		key,
		label,
		kind: 'select',
		valueType: 'string',
		options: cap.options.map((value) => ({ value, label: cap.labels?.[value] ?? value })),
		...(cap.default !== undefined ? { defaultValue: cap.default } : {})
	};
}

/**
 * The settings controls a model supports, in display order. Excludes the
 * prompt (edited by the prompt editor) and references (see
 * {@link getReferenceSlots}).
 */
export function getGenerationControls(caps: ModelCapabilities): GenerationControl[] {
	const controls: (GenerationControl | null)[] = [];
	const modes = supportedModes(caps);
	if (modes.length > 1) {
		controls.push({
			key: 'mode',
			label: 'Mode',
			kind: 'select',
			valueType: 'string',
			options: modes.map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) })),
			defaultValue: 'generate'
		});
	}
	const negative = textFieldCapability(caps.negativePrompt);
	if (negative) controls.push({ key: 'negativePrompt', label: 'Negative prompt', kind: 'textarea', valueType: 'string', maxLength: negative.maxLength });
	const system = textFieldCapability(caps.systemPrompt);
	if (system) controls.push({ key: 'systemPrompt', label: 'System prompt', kind: 'textarea', valueType: 'string', maxLength: system.maxLength });
	controls.push(enumControl('aspectRatio', 'Aspect ratio', caps.aspectRatios));
	controls.push(enumControl('resolution', 'Resolution', caps.resolutions));
	controls.push(enumControl('quality', 'Quality', caps.quality));

	if (caps.count) {
		const options = caps.count.options?.filter((o) => o >= 1 && o <= caps.count!.max);
		controls.push(
			options?.length
				? { key: 'count', label: 'Outputs', kind: 'select', valueType: 'number', options: options.map((o) => ({ value: o, label: String(o) })), defaultValue: caps.count.default }
				: { key: 'count', label: 'Outputs', kind: 'range', valueType: 'number', min: 1, max: caps.count.max, step: 1, defaultValue: caps.count.default ?? 1 }
		);
	}
	if (caps.duration) {
		const d = caps.duration;
		const options = d.options?.filter((o) => (d.min === undefined || o >= d.min) && (d.max === undefined || o <= d.max));
		controls.push(
			options?.length
				? { key: 'duration', label: 'Duration (s)', kind: 'select', valueType: 'number', options: options.map((o) => ({ value: o, label: `${o}s` })), defaultValue: d.default }
				: {
						key: 'duration',
						label: 'Duration (s)',
						kind: d.min !== undefined && d.max !== undefined ? 'range' : 'number',
						valueType: 'number',
						min: d.min,
						max: d.max,
						step: d.step,
						defaultValue: d.default
					}
		);
	}
	const seed = seedCapability(caps.seed);
	if (seed) controls.push({ key: 'seed', label: 'Seed', kind: 'number', valueType: 'number', min: seed.min, max: seed.max, step: 1 });

	for (const [name, spec] of Object.entries(caps.params ?? {})) {
		const base = { key: `params.${name}`, label: spec.label ?? name, ...(spec.description ? { description: spec.description } : {}) };
		if (spec.type === 'boolean') {
			controls.push({ ...base, kind: 'checkbox', valueType: 'boolean', defaultValue: spec.default });
		} else if (spec.type === 'enum') {
			const numeric = spec.options.every((o) => typeof o === 'number');
			controls.push({
				...base,
				kind: 'select',
				valueType: numeric ? 'number' : 'string',
				options: spec.options.map((value) => ({ value, label: String(value) })),
				defaultValue: spec.default
			});
		} else {
			controls.push({
				...base,
				kind: spec.min !== undefined && spec.max !== undefined ? 'range' : 'number',
				valueType: 'number',
				min: spec.min,
				max: spec.max,
				step: spec.step ?? (spec.type === 'integer' ? 1 : undefined),
				defaultValue: spec.default
			});
		}
	}
	return controls.filter((c): c is GenerationControl => c !== null);
}

/** Reads a request value by control key (`params.x` reads a param). */
export function getRequestValue(request: GenerationRequest, key: string): unknown {
	if (key.startsWith('params.')) return request.params?.[key.slice(7)];
	return (request as Record<string, unknown>)[key];
}

/** Returns a copy of `request` with `key` set (`undefined` or `''` removes it). */
export function setRequestValue(request: GenerationRequest, key: string, value: unknown): GenerationRequest {
	const remove = value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));
	if (key.startsWith('params.')) {
		const name = key.slice(7);
		const params = { ...(request.params ?? {}) };
		if (remove) delete params[name];
		else params[name] = value as GenerationParamValue;
		const next: GenerationRequest = { ...request, params };
		if (Object.keys(params).length === 0) delete next.params;
		return next;
	}
	const next = { ...request } as Record<string, unknown>;
	if (remove) delete next[key];
	else next[key] = value;
	return next as GenerationRequest;
}

/** Parses a DOM control's string value into the control's value type. */
export function parseControlValue(control: GenerationControl, raw: string | boolean): string | number | boolean | undefined {
	if (control.valueType === 'boolean') return Boolean(raw);
	if (raw === '' || raw === undefined) return undefined;
	if (control.valueType === 'number') {
		const n = Number(raw);
		return Number.isFinite(n) ? n : undefined;
	}
	return String(raw);
}

/** Reference slots for every role the model accepts, filled from `request`. */
export function getReferenceSlots(caps: ModelCapabilities, request: GenerationRequest = {}): ReferenceSlot[] {
	const roles = supportedReferenceRoles(caps);
	if (caps.inpainting && !roles.includes('mask')) roles.push('mask');
	const refs = request.references ?? [];
	const total = refs.length;
	const maxTotal = caps.references?.maxTotal ?? Infinity;
	return roles.map((role) => {
		const cap = caps.references?.roles[role] ?? { max: 1 };
		const references = refs.filter((ref) => ref.role === role);
		return {
			role,
			label: referenceRoleLabel(role, caps),
			...(cap.description ? { description: cap.description } : {}),
			...('accepts' in cap && cap.accepts?.length ? { accepts: [...cap.accepts] } : {}),
			min: cap.min ?? 0,
			max: cap.max,
			references,
			canAdd: references.length < cap.max && total < maxTotal
		};
	});
}

/** Returns a copy of `request` with a reference appended. */
export function addReference(request: GenerationRequest, reference: GenerationReference): GenerationRequest {
	return { ...request, references: [...(request.references ?? []), { ...reference }] };
}

/** Returns a copy of `request` without the reference `id` in `role`. */
export function removeReference(request: GenerationRequest, role: ReferenceRole, id: string): GenerationRequest {
	const references = (request.references ?? []).filter((ref) => !(ref.role === role && ref.id === id));
	const next: GenerationRequest = { ...request, references };
	if (references.length === 0) delete next.references;
	return next;
}
