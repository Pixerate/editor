import {
	GENERATION_REQUEST_FIELDS,
	REFERENCE_ROLES,
	isReferenceRoleName,
	mediaTypeMatches,
	normalizeReferenceRole,
	seedCapability,
	supportedReferenceRoles,
	supportedModes,
	textFieldCapability,
	type EnumCapability,
	type ExtraParamSpec,
	type GenerationParamValue,
	type GenerationReference,
	type GenerationRequest,
	type ModelCapabilities,
	type ReferenceRole,
	type ReferenceRoleCapability
} from './capabilities.js';

/**
 * How the planner treats values the model does not support:
 *
 * - `error`: nothing is changed; every mismatch is an error.
 * - `nearest`: snap to the closest supported value (ties go to the higher
 *   value), clamp ranges, truncate lists, drop unsupported fields and
 *   unsupported references.
 * - `downgrade`: like `nearest`, but ties go to the lower value.
 * - `upgrade`: like `nearest`, but never drops references the model cannot
 *   use (that would lose intent), so those are errors.
 *
 * "Lower" means a narrower aspect ratio, fewer pixels, an earlier quality
 * option, a smaller number.
 */
export type PlanStrategy = 'error' | 'upgrade' | 'downgrade' | 'nearest';

export type PlanAdjustmentKind = 'snapped' | 'clamped' | 'truncated' | 'dropped' | 'defaulted';

export interface PlanAdjustment {
	/** Request path, e.g. `aspectRatio`, `params.guidance`, `references.style_ref`. */
	field: string;
	from: unknown;
	to: unknown;
	reason: string;
	kind: PlanAdjustmentKind;
}

export interface PlanError {
	field: string;
	value: unknown;
	message: string;
}

export interface GenerationPlan {
	/** `true` when there are no errors and `request` can be sent. */
	ok: boolean;
	/** The adjusted request (always a copy; the input is never mutated). */
	request: GenerationRequest;
	adjustments: PlanAdjustment[];
	errors: PlanError[];
	/** Model the plan was made for. */
	model: string;
	strategy: PlanStrategy;
}

export interface PlanOptions {
	/** Default `nearest`. */
	strategy?: PlanStrategy;
	/**
	 * The prompt with templates and variables resolved. Measured against
	 * `prompt.maxLength` when the model counts resolved text (the default).
	 */
	resolvedPrompt?: string;
	/** Fill missing fields that have a capability `default` (reported as `defaulted`). */
	fillDefaults?: boolean;
	/** Override whether references with unsupported roles may be dropped (default: `nearest` and `downgrade` only). */
	dropUnsupportedReferences?: boolean;
	/**
	 * Assets mentioned in the prompt (e.g. from `extractMentions(text, { details: true, roles: true })`
	 * joined with your asset library). They are appended to `request.references`
	 * and validated per role like any other reference. A mention without a role
	 * gets `defaultMentionRole`, or the first role of the model that accepts its
	 * media type (reported as `defaulted`).
	 */
	mentions?: readonly PlanAssetMention[];
	/** Role for mentions that have none (see `mentions`). */
	defaultMentionRole?: ReferenceRole;
}

/** An asset mention handed to the planner (see {@link PlanOptions.mentions}). */
export interface PlanAssetMention {
	/** Asset id. */
	id: string;
	role?: ReferenceRole | null;
	mediaType?: string;
	contentHash?: string;
	url?: string;
	/** The mention text, used in messages (default: the id). */
	label?: string;
}

const EPSILON = 1e-9;

/** Numeric rank of an aspect ratio such as `16:9` (log of width / height). */
export function aspectRatioRank(value: string): number | undefined {
	const match = /^\s*(\d+(?:\.\d+)?)\s*[:x/×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(value));
	if (!match) return undefined;
	const w = Number(match[1]);
	const h = Number(match[2]);
	if (!(w > 0) || !(h > 0)) return undefined;
	return Math.log(w / h);
}

/**
 * Numeric rank of a resolution: `1024x768` (pixels), `720p` (16:9 pixels at
 * that height) or `2k` (square of that many kibi-pixels). Log scale.
 */
export function resolutionRank(value: string): number | undefined {
	const text = String(value).trim().toLowerCase();
	let pixels: number | undefined;
	let match = /^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)$/.exec(text);
	if (match) pixels = Number(match[1]) * Number(match[2]);
	else if ((match = /^(\d+(?:\.\d+)?)p$/.exec(text))) pixels = (Number(match[1]) ** 2 * 16) / 9;
	else if ((match = /^(\d+(?:\.\d+)?)k$/.exec(text))) pixels = (Number(match[1]) * 1024) ** 2;
	return pixels && pixels > 0 ? Math.log(pixels) : undefined;
}

/** Megapixels of a resolution string, when it can be parsed. */
export function resolutionMegapixels(value: string): number | undefined {
	const rank = resolutionRank(value);
	return rank === undefined ? undefined : Math.exp(rank) / 1_000_000;
}

/** Common quality names, low → high. Used to compare values missing from a model's options. */
export const QUALITY_LADDER: Readonly<Record<string, number>> = {
	draft: 0,
	preview: 0,
	low: 1,
	fast: 1,
	turbo: 1,
	standard: 2,
	normal: 2,
	medium: 2,
	balanced: 2,
	high: 3,
	hd: 3,
	quality: 3,
	ultra: 4,
	max: 5,
	best: 5
};

export function qualityRank(value: string): number | undefined {
	return QUALITY_LADDER[String(value).trim().toLowerCase()];
}

const numberRank = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * Picks the option closest to `value` by `rank`. Ties go to the lower or
 * higher rank. Returns `undefined` when `value` or no option can be ranked.
 */
export function snapToOption<T>(
	value: unknown,
	options: readonly T[],
	rank: (value: any) => number | undefined,
	tie: 'lower' | 'higher'
): T | undefined {
	const target = rank(value);
	if (target === undefined) return undefined;
	let best: { option: T; distance: number; rank: number } | undefined;
	for (const option of options) {
		const r = rank(option);
		if (r === undefined) continue;
		const distance = Math.abs(r - target);
		if (
			!best ||
			distance < best.distance - EPSILON ||
			(Math.abs(distance - best.distance) <= EPSILON && (tie === 'lower' ? r < best.rank : r > best.rank))
		) {
			best = { option, distance, rank: r };
		}
	}
	return best?.option;
}

/** Truncates to `max` UTF-16 units without splitting a surrogate pair. */
function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max;
	const code = text.charCodeAt(end - 1);
	if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
	return text.slice(0, end);
}

function cloneRequest(request: GenerationRequest): GenerationRequest {
	const copy: GenerationRequest = { ...request };
	if (request.references) copy.references = request.references.map((ref) => ({ ...ref }));
	if (request.params) copy.params = { ...request.params };
	return copy;
}

const describe = (value: unknown) => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value));
const list = (options: readonly unknown[]) => options.map(describe).join(', ');

class Planner {
	readonly adjustments: PlanAdjustment[] = [];
	readonly errors: PlanError[] = [];
	readonly tie: 'lower' | 'higher';
	readonly strict: boolean;

	constructor(
		readonly caps: ModelCapabilities,
		readonly request: GenerationRequest,
		readonly options: PlanOptions,
		readonly strategy: PlanStrategy
	) {
		this.tie = strategy === 'downgrade' ? 'lower' : 'higher';
		this.strict = strategy === 'error';
	}

	adjust(field: string, from: unknown, to: unknown, kind: PlanAdjustmentKind, reason: string) {
		this.adjustments.push({ field, from, to, kind, reason });
	}

	error(field: string, value: unknown, message: string) {
		this.errors.push({ field, value, message });
	}

	/** Removes an unsupported field (or reports it under `error`). */
	unsupported(field: keyof GenerationRequest, message: string) {
		const value = this.request[field];
		if (this.strict) {
			this.error(field, value, message);
			return;
		}
		delete this.request[field];
		this.adjust(field, value, undefined, 'dropped', message);
	}

	defaulted(field: string, value: unknown, set: () => void) {
		if (!this.options.fillDefaults || value === undefined) return;
		set();
		this.adjust(field, undefined, value, 'defaulted', 'Filled with the model default.');
	}

	planText(field: 'prompt' | 'negativePrompt' | 'systemPrompt', maxLength: number | undefined, measured?: string) {
		const value = this.request[field];
		if (value === undefined || maxLength === undefined) return;
		if (typeof value !== 'string') {
			this.error(field, value, `Expected text.`);
			return;
		}
		const text = measured ?? value;
		if (text.length <= maxLength) return;
		if (this.strict || measured !== undefined) {
			this.error(
				field,
				text.length,
				`${measured !== undefined ? 'Resolved text' : 'Text'} is ${text.length} characters; the model accepts at most ${maxLength}.`
			);
			return;
		}
		const next = truncateText(value, maxLength);
		this.request[field] = next;
		this.adjust(field, value.length, next.length, 'truncated', `Truncated to the model's ${maxLength}-character limit.`);
	}

	planEnum(
		field: 'aspectRatio' | 'resolution' | 'quality',
		cap: EnumCapability<string> | undefined,
		rank: (value: string) => number | undefined,
		label: string
	) {
		const value = this.request[field];
		if (value === undefined) {
			if (cap) this.defaulted(field, cap.default, () => (this.request[field] = cap.default));
			return;
		}
		if (!cap || cap.options.length === 0) {
			this.unsupported(field, `The model does not take a ${label}.`);
			return;
		}
		if (cap.options.includes(value)) return;
		if (this.strict) {
			this.error(field, value, `${describe(value)} is not a supported ${label}; supported: ${list(cap.options)}.`);
			return;
		}
		const snapped = snapToOption(value, cap.options, rank, this.tie);
		const next = snapped ?? cap.default ?? cap.options[0];
		this.request[field] = next;
		this.adjust(
			field,
			value,
			next,
			'snapped',
			snapped !== undefined
				? `${describe(value)} is not supported; using the nearest ${label}.`
				: `${describe(value)} is not supported; using ${cap.default !== undefined ? 'the default' : 'the first option'}.`
		);
	}

	/** Clamps/rounds/snaps a number. Returns the next value or `undefined` after an error. */
	planNumber(
		field: string,
		value: unknown,
		spec: { min?: number; max?: number; step?: number; integer?: boolean; options?: readonly number[] },
		label: string
	): { value: number; changed: boolean } | undefined {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			this.error(field, value, `Expected a number for ${label}.`);
			return undefined;
		}
		const options = spec.options?.filter(
			(o) => (spec.min === undefined || o >= spec.min) && (spec.max === undefined || o <= spec.max)
		);
		if (options && options.length > 0) {
			if (options.includes(value)) return { value, changed: false };
			if (this.strict) {
				this.error(field, value, `${value} is not a supported ${label}; supported: ${list(options)}.`);
				return undefined;
			}
			const next = snapToOption(value, options, numberRank, this.tie)!;
			this.adjust(field, value, next, 'snapped', `${value} is not supported; using the nearest ${label}.`);
			return { value: next, changed: true };
		}
		let next = value;
		if (spec.step !== undefined && spec.step > 0) {
			const base = spec.min ?? 0;
			const steps = (next - base) / spec.step;
			const rounded = Math.abs(steps - Math.trunc(steps) - 0.5) < EPSILON
				? this.tie === 'lower' ? Math.floor(steps) : Math.ceil(steps)
				: Math.round(steps);
			next = Number((base + rounded * spec.step).toPrecision(12));
		}
		if (spec.integer && !Number.isInteger(next)) {
			const frac = next - Math.floor(next);
			next = Math.abs(frac - 0.5) < EPSILON ? (this.tie === 'lower' ? Math.floor(next) : Math.ceil(next)) : Math.round(next);
		}
		let kind: PlanAdjustmentKind = 'snapped';
		if (spec.min !== undefined && next < spec.min) {
			next = spec.min;
			kind = 'clamped';
		}
		if (spec.max !== undefined && next > spec.max) {
			next = spec.max;
			kind = 'clamped';
		}
		if (next === value) return { value, changed: false };
		const range = `${spec.min ?? '-∞'}–${spec.max ?? '∞'}`;
		if (this.strict) {
			this.error(
				field,
				value,
				kind === 'clamped' ? `${label} must be within ${range}.` : `${value} is not a valid ${label} (try ${next}).`
			);
			return undefined;
		}
		this.adjust(
			field,
			value,
			next,
			kind,
			kind === 'clamped' ? `Clamped to the supported range ${range}.` : `Rounded to a supported ${label}.`
		);
		return { value: next, changed: true };
	}

	planCount() {
		const value = this.request.count;
		const cap = this.caps.count;
		if (value === undefined) {
			if (cap) this.defaulted('count', cap.default, () => (this.request.count = cap.default));
			return;
		}
		if (!cap) {
			if (value === 1) return;
			this.unsupported('count', 'The model produces one output per request.');
			return;
		}
		const result = this.planNumber('count', value, { min: 1, max: cap.max, integer: true, options: cap.options }, 'output count');
		if (result) this.request.count = result.value;
	}

	planDuration() {
		const value = this.request.duration;
		const cap = this.caps.duration;
		if (value === undefined) {
			if (cap) this.defaulted('duration', cap.default, () => (this.request.duration = cap.default));
			return;
		}
		if (!cap) {
			this.unsupported('duration', 'The model does not take a duration.');
			return;
		}
		const result = this.planNumber('duration', value, cap, 'duration');
		if (result) this.request.duration = result.value;
	}

	planSeed() {
		const value = this.request.seed;
		if (value === undefined) return;
		const cap = seedCapability(this.caps.seed);
		if (!cap) {
			this.unsupported('seed', 'The model does not take a seed.');
			return;
		}
		const result = this.planNumber('seed', value, { ...cap, integer: true }, 'seed');
		if (result) this.request.seed = result.value;
	}

	planMode() {
		const mode = this.request.mode;
		if (mode === undefined) return;
		const modes = supportedModes(this.caps);
		if (!modes.includes(mode)) {
			this.error('mode', mode, `The model does not support ${describe(mode)}; supported: ${list(modes)}.`);
		}
	}

	roleCapability(role: ReferenceRole): ReferenceRoleCapability | undefined {
		const cap = this.caps.references?.roles[role];
		if (cap && cap.max > 0) return cap;
		if (role === 'mask' && this.caps.inpainting) return { max: 1 };
		return undefined;
	}

	/** Turns `options.mentions` into references (appended after the request's own). */
	addMentions() {
		const mentions = this.options.mentions;
		if (!mentions?.length) return;
		const refs = [...(this.request.references ?? [])];
		for (const mention of mentions) {
			if (!mention || typeof mention.id !== 'string' || mention.id === '') continue;
			let role = mention.role ?? undefined;
			if (!role) {
				role = this.options.defaultMentionRole ?? this.inferRole(mention.mediaType);
				this.adjust(
					`references.${role}`,
					undefined,
					role,
					'defaulted',
					`@${mention.label ?? mention.id} has no role; using ${role}.`
				);
			}
			refs.push({
				id: mention.id,
				role,
				...(mention.url !== undefined ? { url: mention.url } : {}),
				...(mention.mediaType !== undefined ? { mediaType: mention.mediaType } : {}),
				...(mention.contentHash !== undefined ? { contentHash: mention.contentHash } : {})
			});
		}
		this.request.references = refs;
	}

	/** First role of the model (other than `mask`) whose `accepts` matches `mediaType`. */
	inferRole(mediaType: string | undefined): ReferenceRole {
		for (const role of supportedReferenceRoles(this.caps)) {
			if (role === 'mask') continue;
			const cap = this.roleCapability(role);
			if (cap && (mediaType === undefined || mediaTypeMatches(mediaType, cap.accepts))) return role;
		}
		return 'image_ref';
	}

	planReferences() {
		const refs = this.request.references;
		const allowDrop =
			!this.strict &&
			(this.options.dropUnsupportedReferences ?? (this.strategy === 'nearest' || this.strategy === 'downgrade'));
		const byRole = new Map<ReferenceRole, GenerationReference[]>();
		const kept: GenerationReference[] = [];
		const unsupported = new Map<string, number>();
		for (const [index, original] of (refs ?? []).entries()) {
			let ref = original;
			if (!ref || typeof ref.id !== 'string' || ref.id === '' || !isReferenceRoleName(ref.role)) {
				this.error(`references.${index}`, ref, 'Each reference needs an `id` and a valid `role`.');
				continue;
			}
			if (!this.roleCapability(ref.role)) {
				const alias = normalizeReferenceRole(ref.role, this.caps);
				if (alias !== ref.role && this.roleCapability(alias)) {
					if (this.strict) {
						this.error(`references.${ref.role}`, ref.role, `The model calls this role ${describe(alias)}.`);
						continue;
					}
					this.adjust(
						`references.${ref.role}`,
						ref.role,
						alias,
						'snapped',
						`Using the model's ${alias} role for ${describe(ref.role)}.`
					);
					ref = { ...ref, role: alias };
				} else {
					unsupported.set(ref.role, (unsupported.get(ref.role) ?? 0) + 1);
					continue;
				}
			}
			const cap = this.roleCapability(ref.role)!;
			if (ref.mediaType !== undefined && !mediaTypeMatches(ref.mediaType, cap.accepts)) {
				const message = `${describe(ref.id)} is ${describe(ref.mediaType)}; ${ref.role} accepts ${list(cap.accepts ?? [])}.`;
				if (allowDrop) this.adjust(`references.${ref.role}`, ref.id, undefined, 'dropped', message);
				else this.error(`references.${ref.role}`, ref.id, message);
				continue;
			}
			const group = byRole.get(ref.role) ?? [];
			if (group.some((other) => other.id === ref.id)) {
				this.adjust(`references.${ref.role}`, ref.id, undefined, 'dropped', `Duplicate reference "${ref.id}" removed.`);
				continue;
			}
			group.push(ref);
			byRole.set(ref.role, group);
			kept.push(ref);
		}

		for (const [role, count] of unsupported) {
			const message =
				this.caps.media === 'text' || !this.caps.references
					? `The ${this.caps.media} model "${this.caps.id}" does not accept reference inputs (${role}).`
					: `The model does not accept ${role} references.`;
			if (allowDrop) this.adjust(`references.${role}`, count, 0, 'dropped', message);
			else this.error(`references.${role}`, count, message);
		}

		// Per-role limits (built-in roles first, then the model's own roles).
		const removed = new Set<GenerationReference>();
		const custom = supportedReferenceRoles(this.caps).filter(
			(role) => !(REFERENCE_ROLES as readonly string[]).includes(role)
		);
		for (const role of [...REFERENCE_ROLES, ...custom]) {
			const cap = this.roleCapability(role);
			const group = byRole.get(role) ?? [];
			if (!cap) continue;
			if (group.length > cap.max) {
				if (this.strict) {
					this.error(`references.${role}`, group.length, `At most ${cap.max} ${role} reference(s) are supported.`);
				} else {
					group.slice(cap.max).forEach((ref) => removed.add(ref));
					this.adjust(
						`references.${role}`,
						group.length,
						cap.max,
						'truncated',
						`Kept the first ${cap.max} ${role} reference(s); the model accepts no more.`
					);
				}
			}
			if (cap.min !== undefined && group.length < cap.min) {
				this.error(`references.${role}`, group.length, `At least ${cap.min} ${role} reference(s) are required.`);
			}
		}
		let next = kept.filter((ref) => !removed.has(ref));

		// Total limit.
		const maxTotal = this.caps.references?.maxTotal;
		if (maxTotal !== undefined && next.length > maxTotal) {
			if (this.strict) {
				this.error('references', next.length, `At most ${maxTotal} references are supported in total.`);
			} else {
				this.adjust(
					'references',
					next.length,
					maxTotal,
					'truncated',
					`Kept the first ${maxTotal} references; the model accepts no more in total.`
				);
				next = next.slice(0, maxTotal);
			}
		}

		if (this.request.mode === 'inpaint' && !next.some((ref) => ref.role === 'mask')) {
			this.error('references.mask', 0, 'Inpainting needs a `mask` reference.');
		}

		if (refs === undefined) return;
		if (!this.strict) {
			if (next.length > 0) this.request.references = next;
			else delete this.request.references;
		}
	}

	planParam(name: string, spec: ExtraParamSpec | undefined, value: GenerationParamValue): GenerationParamValue | undefined {
		const field = `params.${name}`;
		if (!spec) {
			if (this.strict) this.error(field, value, `Unknown parameter "${name}".`);
			else this.adjust(field, value, undefined, 'dropped', `The model has no "${name}" parameter.`);
			return undefined;
		}
		const label = spec.label ?? name;
		if (spec.type === 'boolean') {
			if (typeof value !== 'boolean') this.error(field, value, `Expected true or false for ${label}.`);
			return value;
		}
		if (spec.type === 'enum') {
			if (spec.options.includes(value as string | number)) return value;
			if (this.strict) {
				this.error(field, value, `${describe(value)} is not a supported ${label}; supported: ${list(spec.options)}.`);
				return value;
			}
			const numeric = spec.options.every((o) => typeof o === 'number');
			const snapped = numeric ? snapToOption(value, spec.options, numberRank, this.tie) : undefined;
			const next = snapped ?? spec.default ?? spec.options[0];
			this.adjust(
				field,
				value,
				next,
				'snapped',
				snapped !== undefined ? `Using the nearest supported ${label}.` : `${describe(value)} is not supported; using ${spec.default !== undefined ? 'the default' : 'the first option'}.`
			);
			return next;
		}
		const result = this.planNumber(field, value, { ...spec, integer: spec.type === 'integer' }, label);
		return result ? result.value : value;
	}

	planParams() {
		const params = this.request.params;
		const specs = this.caps.params ?? {};
		const next: Record<string, GenerationParamValue> = {};
		for (const [name, value] of Object.entries(params ?? {})) {
			if (value === undefined) continue;
			const planned = this.planParam(name, specs[name], value);
			if (planned !== undefined) next[name] = planned;
			else if (this.strict) next[name] = value;
		}
		if (this.options.fillDefaults) {
			for (const [name, spec] of Object.entries(specs)) {
				if (next[name] === undefined && spec.default !== undefined) {
					next[name] = spec.default;
					this.adjust(`params.${name}`, undefined, spec.default, 'defaulted', 'Filled with the model default.');
				}
			}
		}
		if (Object.keys(next).length > 0) this.request.params = next;
		else delete this.request.params;
	}

	run(): void {
		const { caps, request } = this;
		for (const key of Object.keys(request)) {
			if ((GENERATION_REQUEST_FIELDS as readonly string[]).includes(key)) continue;
			const value = (request as any)[key];
			if (this.strict) this.error(key, value, `Unknown request field "${key}".`);
			else {
				delete (request as any)[key];
				this.adjust(key, value, undefined, 'dropped', `Unknown request field "${key}".`);
			}
		}

		if (request.model !== undefined && request.model !== caps.id) {
			this.error('model', request.model, `The request targets "${request.model}" but the plan is for "${caps.id}".`);
		}
		request.model = caps.id;

		// Text fields.
		const promptCap = caps.prompt ?? {};
		if (promptCap.required && !(request.prompt ?? '').trim()) {
			this.error('prompt', request.prompt, 'A prompt is required.');
		}
		const countResolved = promptCap.countResolved ?? true;
		const measured =
			countResolved && this.options.resolvedPrompt !== undefined && this.options.resolvedPrompt !== request.prompt
				? this.options.resolvedPrompt
				: undefined;
		this.planText('prompt', promptCap.maxLength, measured);
		for (const field of ['negativePrompt', 'systemPrompt'] as const) {
			if (request[field] === undefined) continue;
			const cap = textFieldCapability(caps[field]);
			if (!cap) {
				this.unsupported(field, `The model does not take a ${field === 'negativePrompt' ? 'negative' : 'system'} prompt.`);
				continue;
			}
			this.planText(field, cap.maxLength);
		}

		this.planEnum('aspectRatio', caps.aspectRatios, aspectRatioRank, 'aspect ratio');
		this.planEnum('resolution', caps.resolutions, resolutionRank, 'resolution');
		this.planEnum('quality', caps.quality, qualityRank, 'quality');
		this.planCount();
		this.planDuration();
		this.planSeed();
		this.planMode();
		this.addMentions();
		this.planReferences();
		this.planParams();
	}
}

/**
 * Plans `request` against a model's capabilities before sending it: snaps
 * enum values (aspect ratio, resolution, quality, count/duration choices) to
 * the nearest supported option, clamps ranges, truncates text and reference
 * lists over their limits, drops unsupported fields, and reports every change
 * in `adjustments` and every unfixable problem in `errors`.
 *
 * Pure and deterministic: the input is not mutated and the same input always
 * gives the same plan.
 */
export function planGenerationRequest(
	request: GenerationRequest,
	caps: ModelCapabilities,
	options: PlanOptions = {}
): GenerationPlan {
	const strategy = options.strategy ?? 'nearest';
	const planner = new Planner(caps, cloneRequest(request ?? {}), options, strategy);
	planner.run();
	return {
		ok: planner.errors.length === 0,
		request: planner.request,
		adjustments: planner.adjustments,
		errors: planner.errors,
		model: caps.id,
		strategy
	};
}
