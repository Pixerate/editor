import { getLatestVersion, getTemplateBody, resolvePrompt } from '../grammar/engine.js';
import type { SourceMapSegment } from '../grammar/sourcemap.js';
import type { PromptValues, Template } from '../grammar/tokens.js';
import { toAssetResolver, type AssetLookup } from './assets.js';
import {
	GENERATION_REQUEST_FIELDS,
	seedCapability,
	type GenerationReference,
	type GenerationRequest,
	type ModelCapabilities,
	type ReferenceRole
} from './capabilities.js';
import { hashCapabilities, hashText, stableStringify } from './hash.js';
import { planGenerationRequest, type GenerationPlan, type PlanAssetMention, type PlanStrategy } from './plan.js';
import {
	createProvenance,
	parseProvenance,
	pinnedTemplatesToTemplates,
	ProvenanceParseError,
	type CreateProvenanceOptions,
	type GenerationProvenance,
	type PinnedTemplate
} from './provenance.js';

export const GENERATION_RECORD_FORMAT = 'pixerate.generation-record';
export const GENERATION_RECORD_VERSION = 1;

/** How a record came about. */
export type GenerationRecordKind = 'generate' | 'recreate' | 'variation';

/** A template the generation used, with a hash of the exact body. */
export interface RecordedTemplate {
	name: string;
	templateId?: string;
	versionId?: string;
	version?: string | number;
	/** {@link hashText} of the body that was used. */
	hash: string;
}

/** An asset the generation used, by role, with its content hash at the time. */
export interface RecordedAsset {
	id: string;
	role: ReferenceRole;
	contentHash?: string;
	mediaType?: string;
	url?: string;
}

/**
 * Everything needed to reproduce one generation. The prompt, templates,
 * values, resolved prompt, source map, planned request and adjustments live
 * in `provenance` (see `createProvenance`); the record adds hashes for
 * change detection, the user's original settings, assets and lineage.
 */
export interface GenerationRecord {
	format: typeof GENERATION_RECORD_FORMAT;
	version: typeof GENERATION_RECORD_VERSION;
	id: string;
	/** The record this one was recreated or varied from. */
	parentId?: string;
	kind: GenerationRecordKind;
	provenance: GenerationProvenance;
	/** One entry per template in `provenance.templates`, same order. */
	templates: RecordedTemplate[];
	/** {@link hashText} of `provenance.resolvedPrompt`. */
	promptHash: string;
	/** {@link hashCapabilities} of the model when the record was made (absent when only an id was known). */
	capabilityHash?: string;
	/** The request as the user set it, before planning (snapping, clamping, dropping). */
	settings: GenerationRequest;
	/** Strategy the request was planned with. */
	strategy: PlanStrategy;
	/** Seed used: the one the provider reported, else the planned one. */
	seed?: number;
	assets: RecordedAsset[];
	/** Asset mentions that were planned as references (kept apart from `settings`). */
	mentions?: PlanAssetMention[];
	/** ISO timestamp (same as `provenance.createdAt`). */
	createdAt: string;
	updatedAt?: string;
}

export interface CreateGenerationRecordOptions
	extends Omit<CreateProvenanceOptions, 'model' | 'plan' | 'request' | 'adjustments'> {
	/** The model (needed for the capability hash and for planning when `plan` is absent). */
	model: ModelCapabilities | string;
	/** The user's settings before planning. */
	request?: GenerationRequest;
	/** The plan that was sent. Without it the request is planned here (needs capabilities). */
	plan?: GenerationPlan;
	/** Strategy for planning here, and recorded for recreating (default: the plan's, else `nearest`). */
	strategy?: PlanStrategy;
	/** Asset mentions to plan as references (see `PlanOptions.mentions`). */
	mentions?: readonly PlanAssetMention[];
	/** Fills in content hashes and media types of referenced assets. */
	assets?: AssetLookup;
	/** Seed the provider actually used, when it differs from the planned one (e.g. random). */
	seed?: number;
	id?: string;
	parentId?: string;
	kind?: GenerationRecordKind;
}

let idCounter = 0;
/** A unique record id (`crypto.randomUUID` when available). */
export function createGenerationRecordId(): string {
	const uuid = (globalThis as any).crypto?.randomUUID?.();
	if (typeof uuid === 'string') return `gen_${uuid}`;
	idCounter = (idCounter + 1) % 1_679_616;
	const random = Math.floor(Math.random() * 2 ** 48).toString(36).padStart(10, '0');
	return `gen_${Date.now().toString(36)}${idCounter.toString(36).padStart(4, '0')}${random}`;
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function recordTemplates(pinned: readonly PinnedTemplate[]): RecordedTemplate[] {
	return pinned.map((p) => ({
		name: p.name,
		...(p.templateId !== undefined ? { templateId: p.templateId } : {}),
		...(p.versionId !== undefined ? { versionId: p.versionId, version: p.version } : {}),
		hash: hashText(p.body)
	}));
}

function recordAssets(references: readonly GenerationReference[] | undefined, lookup?: AssetLookup): RecordedAsset[] {
	const resolve = toAssetResolver(lookup);
	return (references ?? []).map((ref) => {
		const info = resolve?.(ref.id);
		const contentHash = ref.contentHash ?? info?.contentHash;
		const mediaType = ref.mediaType ?? info?.mediaType;
		const url = ref.url ?? info?.url;
		return {
			id: ref.id,
			role: ref.role,
			...(contentHash !== undefined ? { contentHash } : {}),
			...(mediaType !== undefined ? { mediaType } : {}),
			...(url !== undefined ? { url } : {})
		};
	});
}

/**
 * Records a generation so it can be listed, explained and recreated. Builds
 * the provenance (pinned template bodies, values, resolved prompt and source
 * map, planned request, adjustments) and adds a hash per template body, the
 * capability hash of the model, the user's original settings, the seed, the
 * referenced assets with their roles and content hashes, and the parent
 * record. Plans the request when no `plan` is given and `model` is a
 * capability object.
 */
export function createGenerationRecord(options: CreateGenerationRecordOptions): GenerationRecord {
	const {
		model,
		request: settingsInput,
		plan: planInput,
		strategy: strategyInput,
		mentions,
		assets,
		seed: seedInput,
		id,
		parentId,
		kind,
		...provenanceOptions
	} = options;
	const caps = typeof model === 'string' ? undefined : model;
	const settings: GenerationRequest = clone(settingsInput ?? planInput?.request ?? {});
	let plan = planInput;
	if (!plan && caps) {
		const resolved = resolvePrompt(options.rawPrompt, options.templates ?? [], {
			bindings: options.bindings,
			values: options.values,
			maxDepth: options.maxDepth
		});
		plan = planGenerationRequest(settings, caps, {
			strategy: strategyInput ?? 'nearest',
			resolvedPrompt: resolved.text,
			...(mentions ? { mentions } : {})
		});
	}
	const provenance = createProvenance({
		...provenanceOptions,
		model,
		...(plan ? { plan } : { request: settings })
	});
	const seed = seedInput ?? provenance.request.seed;
	return {
		format: GENERATION_RECORD_FORMAT,
		version: GENERATION_RECORD_VERSION,
		id: id ?? createGenerationRecordId(),
		...(parentId !== undefined ? { parentId } : {}),
		kind: kind ?? (parentId !== undefined ? 'recreate' : 'generate'),
		provenance,
		templates: recordTemplates(provenance.templates),
		promptHash: hashText(provenance.resolvedPrompt),
		...(caps ? { capabilityHash: hashCapabilities(caps) } : {}),
		settings,
		strategy: strategyInput ?? plan?.strategy ?? 'nearest',
		...(seed !== undefined ? { seed } : {}),
		assets: recordAssets(provenance.request.references, assets),
		...(mentions?.length ? { mentions: clone([...mentions]) } : {}),
		createdAt: provenance.createdAt
	};
}

/** Returns a copy of `record` with outputs and completion time added (e.g. when the job finishes). */
export function completeGenerationRecord(
	record: GenerationRecord,
	update: { outputIds?: string[]; completedAt?: Date | number | string; seed?: number; meta?: Record<string, unknown> }
): GenerationRecord {
	const next = clone(record);
	const now = new Date(update.completedAt ?? Date.now()).toISOString();
	if (update.outputIds) next.provenance.outputIds = [...update.outputIds];
	next.provenance.completedAt = now;
	if (update.meta) next.provenance.meta = { ...(next.provenance.meta ?? {}), ...clone(update.meta) };
	if (update.seed !== undefined) next.seed = update.seed;
	next.updatedAt = now;
	return next;
}

/** Versioned JSON for storage. */
export function serializeGenerationRecord(record: GenerationRecord): string {
	return JSON.stringify(record);
}

const isObject = (value: unknown): value is Record<string, any> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

/** Parses and checks a serialized record. Throws `ProvenanceParseError`. */
export function parseGenerationRecord(input: string | unknown): GenerationRecord {
	let data: unknown = input;
	if (typeof input === 'string') {
		try {
			data = JSON.parse(input);
		} catch {
			throw new ProvenanceParseError('Generation record is not valid JSON.');
		}
	}
	if (!isObject(data) || data.format !== GENERATION_RECORD_FORMAT) {
		throw new ProvenanceParseError('Not a generation record.');
	}
	if (typeof data.version !== 'number' || data.version > GENERATION_RECORD_VERSION) {
		throw new ProvenanceParseError(`Unsupported generation record version ${JSON.stringify(data.version)}.`);
	}
	const checks: [string, boolean][] = [
		['id', typeof data.id === 'string' && data.id !== ''],
		['templates', Array.isArray(data.templates) && data.templates.every((t: any) => isObject(t) && typeof t.name === 'string' && typeof t.hash === 'string')],
		['assets', Array.isArray(data.assets) && data.assets.every((a: any) => isObject(a) && typeof a.id === 'string' && typeof a.role === 'string')],
		['settings', isObject(data.settings)],
		['promptHash', typeof data.promptHash === 'string'],
		['createdAt', typeof data.createdAt === 'string']
	];
	const bad = checks.find(([, ok]) => !ok);
	if (bad) throw new ProvenanceParseError(`Invalid generation record field "${bad[0]}".`);
	const provenance = parseProvenance(data.provenance);
	return {
		...(data as GenerationRecord),
		kind: data.kind === 'recreate' || data.kind === 'variation' ? data.kind : 'generate',
		strategy: ['nearest', 'upgrade', 'downgrade', 'error'].includes(data.strategy) ? data.strategy : 'nearest',
		provenance
	};
}

/** True for a {@link GenerationRecord} (as opposed to bare provenance). */
export function isGenerationRecord(value: unknown): value is GenerationRecord {
	return isObject(value) && value.format === GENERATION_RECORD_FORMAT;
}

// ------------------------------------------------------------------ recreate

/**
 * `exact`: the same resolved prompt (pinned template bodies), the planned
 * settings that were sent, the same seed. `latest`: the raw prompt resolved
 * against today's templates (latest versions) and the user's original
 * settings planned against today's capabilities, with the same seed.
 */
export type RecreateMode = 'exact' | 'latest';

export type DriftType =
	| 'template-changed'
	| 'template-missing'
	| 'prompt-changed'
	| 'model-missing'
	| 'model-changed'
	| 'setting-unsupported'
	| 'setting-changed'
	| 'asset-missing'
	| 'asset-changed';

export interface DriftItem {
	type: DriftType;
	/** `error` items make `ok` false (the request cannot reproduce the record). */
	severity: 'info' | 'warning' | 'error';
	message: string;
	/** Template name (template drift). */
	template?: string;
	/** Request path, e.g. `resolution`, `params.guidance`, `references` (setting drift). */
	field?: string;
	/** Asset id and role (asset drift). */
	assetId?: string;
	role?: ReferenceRole;
	modelId?: string;
	/** Recorded and current value, version or hash. */
	from?: unknown;
	to?: unknown;
	/** Whether the change is in the returned request (`latest` mode), or only reported (`exact`). */
	applied?: boolean;
}

export interface RecreateOptions {
	/** Current templates (to detect edits, and to resolve in `latest` mode). */
	templates?: readonly Template[];
	/** Current model capabilities: one model, or a list to find the record's model in. */
	capabilities?: ModelCapabilities | readonly ModelCapabilities[];
	/** Default `exact`. */
	mode?: RecreateMode;
	/** Current assets, to report missing or changed assets. */
	assets?: AssetLookup;
	/** Planning strategy (default: the record's). */
	strategy?: PlanStrategy;
}

export interface RecreateResult {
	mode: RecreateMode;
	/** No `error` drift and (when capabilities were given) the plan has no errors. */
	ok: boolean;
	/** The request to send (re-planned when capabilities were given). */
	request: GenerationRequest;
	/** The plan against current capabilities (absent without capabilities or when the model is gone). */
	plan?: GenerationPlan;
	rawPrompt: string;
	resolvedPrompt: string;
	sourceMap: SourceMapSegment[];
	values: PromptValues | null;
	/** Templates and bindings the prompt was resolved with. */
	templates: Template[];
	bindings: Record<string, string>;
	drift: DriftItem[];
	/** The record this request comes from. */
	parentId: string;
	kind: Exclude<GenerationRecordKind, 'generate'>;
	/** Options for {@link createGenerationRecord} once the new generation has run. */
	recordOptions: CreateGenerationRecordOptions;
}

/** Changes for {@link variationRequest}. */
export interface VariationOverrides {
	/** New seed, `null` for none, or absent for a random one different from the record's. */
	seed?: number | null;
	/** Values merged over the recorded ones. */
	values?: PromptValues;
	/** Settings merged over the recreated request (`params` are merged too). */
	settings?: Partial<GenerationRequest>;
	/** A different raw prompt. */
	rawPrompt?: string;
	/** Random source in [0, 1) for the seed (default `Math.random`). */
	random?: () => number;
}

const SKIPPED_SETTING_FIELDS = new Set(['model', 'prompt', 'references', 'params', 'seed']);

function findModel(
	capabilities: RecreateOptions['capabilities'],
	modelId: string
): { given: boolean; caps?: ModelCapabilities } {
	if (!capabilities) return { given: false };
	const list = Array.isArray(capabilities) ? capabilities : [capabilities as ModelCapabilities];
	return { given: true, caps: list.find((m) => m.id === modelId) };
}

const sameValue = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const show = (value: unknown) => (value === undefined ? 'unset' : typeof value === 'string' ? `"${value}"` : JSON.stringify(value));
const refKey = (ref: { id: string; role: string }) => `${ref.role}:${ref.id}`;

function templateDrift(record: GenerationRecord, current: readonly Template[] | undefined, mode: RecreateMode): DriftItem[] {
	if (!current) return [];
	const byName = new Map(current.map((t) => [t.name, t]));
	const drift: DriftItem[] = [];
	for (const recorded of record.templates) {
		const template = byName.get(recorded.name);
		const fromVersion = recorded.version ?? recorded.versionId;
		if (!template) {
			drift.push({
				type: 'template-missing',
				severity: 'warning',
				template: recorded.name,
				from: fromVersion,
				applied: false,
				message: `Template "${recorded.name}" no longer exists; the recorded body is used.`
			});
			continue;
		}
		const body = getTemplateBody(template, {});
		const hash = body === undefined ? undefined : hashText(body);
		if (hash === recorded.hash) continue;
		const latest = getLatestVersion(template);
		const toVersion = template.versions?.length ? latest?.version ?? latest?.id : undefined;
		const versions =
			fromVersion !== undefined || toVersion !== undefined
				? ` (${fromVersion ?? 'unversioned'} → ${toVersion ?? 'unversioned'})`
				: '';
		drift.push({
			type: 'template-changed',
			severity: mode === 'latest' ? 'info' : 'warning',
			template: recorded.name,
			from: { version: fromVersion, hash: recorded.hash },
			to: { version: toVersion, hash },
			applied: mode === 'latest',
			message:
				mode === 'latest'
					? `Template "${recorded.name}" changed since this generation${versions}; using the current version.`
					: `Template "${recorded.name}" changed since this generation${versions}; recreating with the recorded version.`
		});
	}
	return drift;
}

function randomSeed(caps: ModelCapabilities | undefined, previous: number | undefined, random: () => number): number | undefined {
	const cap = caps ? seedCapability(caps.seed) : {};
	if (!cap) return undefined;
	const min = Math.ceil(cap.min ?? 0);
	const max = Math.floor(cap.max ?? 2 ** 31 - 1);
	if (max < min) return min;
	let seed = previous;
	for (let attempt = 0; attempt < 8 && (seed === undefined || seed === previous); attempt++) {
		seed = min + Math.floor(random() * (max - min + 1));
	}
	if (seed === previous && max > min) seed = previous === max ? min : previous! + 1;
	return seed;
}

function rebuild(
	record: GenerationRecord,
	options: RecreateOptions,
	kind: 'recreate' | 'variation',
	overrides?: VariationOverrides
): RecreateResult {
	const mode = options.mode ?? 'exact';
	const provenance = record.provenance;
	const drift: DriftItem[] = templateDrift(record, options.templates, mode);
	const rawPrompt = overrides?.rawPrompt ?? provenance.rawPrompt;
	const values: PromptValues | null =
		overrides?.values !== undefined ? { ...(provenance.values ?? {}), ...overrides.values } : provenance.values ? clone(provenance.values) : null;

	// Templates and bindings to resolve with.
	const pinned = pinnedTemplatesToTemplates(provenance.templates);
	let templates: Template[];
	let bindings: Record<string, string>;
	if (mode === 'latest' && options.templates) {
		const currentNames = new Set(options.templates.map((t) => t.name));
		const fallback = pinned.filter((t) => !currentNames.has(t.name));
		templates = [...options.templates.map((t) => ({ ...t })), ...fallback];
		bindings = {};
		for (const t of fallback) {
			if (provenance.bindings[t.name] !== undefined) bindings[t.name] = provenance.bindings[t.name];
		}
	} else {
		templates = pinned;
		bindings = { ...provenance.bindings };
	}
	const resolved = resolvePrompt(rawPrompt, templates, { bindings, ...(values ? { values } : {}) });
	const sourceMap = resolved.map.map((segment) => {
		const { locked: _locked, ...rest } = segment as SourceMapSegment & { locked?: boolean };
		return rest;
	});
	if (resolved.text !== provenance.resolvedPrompt && !overrides) {
		drift.push({
			type: 'prompt-changed',
			severity: 'info',
			from: provenance.resolvedPrompt,
			to: resolved.text,
			applied: true,
			message: 'The resolved prompt differs from the recorded one.'
		});
	}

	// The request to start from.
	const base: GenerationRequest = clone(mode === 'exact' ? provenance.request : record.settings);
	const recordedPlanned = provenance.request;
	if (base.prompt === undefined || base.prompt === provenance.resolvedPrompt) base.prompt = resolved.text;
	else if (base.prompt === provenance.rawPrompt) base.prompt = rawPrompt;
	if (mode === 'latest' && record.mentions?.length) {
		// Mentions were planned as references; give them the role they were planned with.
		const plannedRole = new Map((recordedPlanned.references ?? []).map((ref) => [ref.id, ref.role]));
		base.references = [
			...(base.references ?? []),
			...record.mentions.map((m) => ({
				id: m.id,
				role: m.role || plannedRole.get(m.id) || 'image_ref',
				...(m.url !== undefined ? { url: m.url } : {}),
				...(m.mediaType !== undefined ? { mediaType: m.mediaType } : {}),
				...(m.contentHash !== undefined ? { contentHash: m.contentHash } : {})
			}))
		];
	} else if (mode === 'latest' && base.references === undefined && recordedPlanned.references) {
		base.references = clone(recordedPlanned.references);
	}
	if (record.seed !== undefined) base.seed = record.seed;
	base.model = provenance.modelId;

	const { given, caps } = findModel(options.capabilities, provenance.modelId);
	if (overrides) {
		if (overrides.settings) {
			const { params, ...rest } = overrides.settings;
			Object.assign(base, clone(rest));
			if (params) base.params = { ...(base.params ?? {}), ...clone(params) };
		}
		if (overrides.seed === null) delete base.seed;
		else base.seed = overrides.seed ?? randomSeed(caps, record.seed, overrides.random ?? Math.random);
		if (base.seed === undefined) delete base.seed;
	}

	// Assets.
	const resolveAsset = toAssetResolver(options.assets);
	if (resolveAsset && base.references) {
		const recordedById = new Map(record.assets.map((a) => [refKey(a), a]));
		const kept: GenerationReference[] = [];
		for (const ref of base.references) {
			const info = resolveAsset(ref.id);
			if (!info) {
				drift.push({
					type: 'asset-missing',
					severity: 'error',
					assetId: ref.id,
					role: ref.role,
					message: `Asset "${ref.id}" (${ref.role}) is no longer available.`
				});
				continue;
			}
			const recordedHash = recordedById.get(refKey(ref))?.contentHash ?? ref.contentHash;
			if (recordedHash !== undefined && info.contentHash !== undefined && recordedHash !== info.contentHash) {
				drift.push({
					type: 'asset-changed',
					severity: 'warning',
					assetId: ref.id,
					role: ref.role,
					from: recordedHash,
					to: info.contentHash,
					applied: true,
					message: `Asset "${ref.id}" (${ref.role}) has changed since this generation.`
				});
			}
			const next: GenerationReference = { ...ref };
			if (info.contentHash !== undefined) next.contentHash = info.contentHash;
			if (next.mediaType === undefined && info.mediaType !== undefined) next.mediaType = info.mediaType;
			kept.push(next);
		}
		if (kept.length) base.references = kept;
		else delete base.references;
	}

	// Model and settings.
	let plan: GenerationPlan | undefined;
	let request = base;
	if (given && !caps) {
		drift.push({
			type: 'model-missing',
			severity: 'error',
			modelId: provenance.modelId,
			message: `Model "${provenance.modelId}" is no longer available.`
		});
	} else if (caps) {
		const capabilityHash = hashCapabilities(caps);
		if (record.capabilityHash !== undefined && record.capabilityHash !== capabilityHash) {
			drift.push({
				type: 'model-changed',
				severity: 'warning',
				modelId: caps.id,
				from: record.capabilityHash,
				to: capabilityHash,
				message: `The capabilities of "${caps.name ?? caps.id}" changed since this generation.`
			});
		}
		plan = planGenerationRequest(base, caps, {
			strategy: options.strategy ?? record.strategy,
			resolvedPrompt: resolved.text
		});
		request = plan.request;
		const severity = mode === 'exact' && !overrides ? 'warning' : 'info';
		const type: DriftType = mode === 'exact' && !overrides ? 'setting-unsupported' : 'setting-changed';
		const describeChange = (field: string, from: unknown, to: unknown) => {
			const adjustment = plan!.adjustments.find((a) => a.field === field || a.field.startsWith(`${field}.`));
			drift.push({
				type,
				severity,
				field,
				from,
				to,
				applied: true,
				message:
					type === 'setting-unsupported'
						? `${field} ${show(from)} is no longer supported; using ${show(to)}.${adjustment ? ` ${adjustment.reason}` : ''}`
						: `${field} was ${show(from)}, now ${show(to)}.${adjustment ? ` ${adjustment.reason}` : ''}`
			});
		};
		if (!overrides) {
			for (const field of GENERATION_REQUEST_FIELDS) {
				if (SKIPPED_SETTING_FIELDS.has(field)) continue;
				const from = (recordedPlanned as any)[field];
				const to = (request as any)[field];
				if (!sameValue(from, to)) describeChange(field, from, to);
			}
			const paramNames = new Set([...Object.keys(recordedPlanned.params ?? {}), ...Object.keys(request.params ?? {})]);
			for (const name of [...paramNames].sort()) {
				const from = recordedPlanned.params?.[name];
				const to = request.params?.[name];
				if (!sameValue(from, to)) describeChange(`params.${name}`, from, to);
			}
			if (!sameValue(record.seed ?? recordedPlanned.seed, request.seed)) describeChange('seed', record.seed ?? recordedPlanned.seed, request.seed);
			const missing = new Set(drift.filter((d) => d.type === 'asset-missing').map((d) => `${d.role}:${d.assetId}`));
			const fromRefs = (recordedPlanned.references ?? []).map(refKey).filter((key) => !missing.has(key));
			const toRefs = (request.references ?? []).map(refKey);
			if (!sameValue(fromRefs, toRefs)) describeChange('references', fromRefs, toRefs);
		}
		for (const error of plan.errors) {
			drift.push({
				type: 'setting-unsupported',
				severity: 'error',
				field: error.field,
				from: error.value,
				message: error.message
			});
		}
	}

	const ok = !drift.some((d) => d.severity === 'error') && (plan ? plan.ok : true);
	const recordOptions: CreateGenerationRecordOptions = {
		rawPrompt,
		templates,
		bindings,
		...(values ? { values } : {}),
		model: caps ?? provenance.modelId,
		request,
		...(plan ? { plan } : {}),
		strategy: options.strategy ?? record.strategy,
		parentId: record.id,
		kind
	};
	return {
		mode,
		ok,
		request,
		...(plan ? { plan } : {}),
		rawPrompt,
		resolvedPrompt: resolved.text,
		sourceMap,
		values,
		templates,
		bindings,
		drift,
		parentId: record.id,
		kind,
		recordOptions
	};
}

/**
 * Rebuilds the request of a recorded generation.
 *
 * - With a {@link GenerationRecord}: returns a {@link RecreateResult} with the
 *   re-planned request and a drift report: templates edited or deleted since,
 *   model capabilities changed or the model gone, settings no longer
 *   supported (or, in `latest` mode, planned differently), assets missing or
 *   changed. `mode: 'exact'` (default) reproduces the recorded prompt and
 *   settings; `mode: 'latest'` uses current templates and re-plans the
 *   original settings. Template edits are always reported; only `latest`
 *   applies them.
 * - With bare {@link GenerationProvenance} (the original API): returns the
 *   planned request that was sent, with the prompt as resolved at the time.
 */
export function recreateRequest(provenance: GenerationProvenance): GenerationRequest;
export function recreateRequest(record: GenerationRecord, options?: RecreateOptions): RecreateResult;
export function recreateRequest(
	input: GenerationProvenance | GenerationRecord,
	options?: RecreateOptions
): GenerationRequest | RecreateResult {
	if (isGenerationRecord(input)) return rebuild(input, options ?? {}, 'recreate');
	const provenance = input as GenerationProvenance;
	const request = clone(provenance.request);
	request.model = provenance.modelId;
	if (request.prompt === undefined) request.prompt = provenance.resolvedPrompt;
	return request;
}

/**
 * A request for a variation of a recorded generation: the same prompt,
 * settings and assets (as {@link recreateRequest} would rebuild them, `exact`
 * mode by default) with a new seed (random within the model's range unless
 * given) and any overrides. Setting drift is not reported for the fields you
 * change; template, model and asset drift are.
 */
export function variationRequest(
	record: GenerationRecord,
	overrides: VariationOverrides = {},
	options: RecreateOptions = {}
): RecreateResult {
	return rebuild(record, options, 'variation', overrides);
}

/** Short display labels for drift types (history panels, badges). */
export const DRIFT_TYPE_LABELS: Readonly<Record<DriftType, string>> = {
	'template-changed': 'Template changed',
	'template-missing': 'Template deleted',
	'prompt-changed': 'Prompt changed',
	'model-missing': 'Model unavailable',
	'model-changed': 'Model changed',
	'setting-unsupported': 'Setting unsupported',
	'setting-changed': 'Setting changed',
	'asset-missing': 'Asset missing',
	'asset-changed': 'Asset changed'
};

/** Drift items that block an exact reproduction (`severity: 'error'`). */
export function blockingDrift(drift: readonly DriftItem[]): DriftItem[] {
	return drift.filter((d) => d.severity === 'error');
}
