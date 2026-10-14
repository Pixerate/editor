import { getLatestVersion, getTemplateBody, resolvePrompt } from '../grammar/engine.js';
import type { SourceMapSegment } from '../grammar/sourcemap.js';
import { tokenizePrompt } from '../grammar/tokenizer.js';
import type { PromptValues, Template } from '../grammar/tokens.js';
import type { GenerationRequest, ModelCapabilities, ReferenceRole } from './capabilities.js';
import type { GenerationPlan, PlanAdjustment } from './plan.js';

export const PROVENANCE_FORMAT = 'pixerate.generation-provenance';
export const PROVENANCE_VERSION = 1;

/** The exact template body a generation used. */
export interface PinnedTemplate {
	name: string;
	templateId?: string;
	/** Version id or version label the body came from (absent for unversioned templates). */
	versionId?: string;
	version?: string | number;
	body: string;
}

/** Everything needed to explain and reproduce one generation. */
export interface GenerationProvenance {
	format: typeof PROVENANCE_FORMAT;
	version: typeof PROVENANCE_VERSION;
	/** Raw prompt as typed, with `{{templates}}` and `{variables}`. */
	rawPrompt: string;
	/** Every template the prompt reached (recursively), pinned to the body used. */
	templates: PinnedTemplate[];
	/** Version bindings in effect (`{ templateName: versionId }`) for every pinned versioned template. */
	bindings: Record<string, string>;
	/** Variable values, or `null` when variables were left unresolved. */
	values: PromptValues | null;
	resolvedPrompt: string;
	sourceMap: SourceMapSegment[];
	modelId: string;
	/** The planned (adjusted) request that was sent. */
	request: GenerationRequest;
	adjustments: PlanAdjustment[];
	references: { id: string; role: ReferenceRole }[];
	/** ISO timestamps. */
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	/** Ids of the outputs this generation produced. */
	outputIds?: string[];
	meta?: Record<string, unknown>;
}

export interface CreateProvenanceOptions {
	rawPrompt: string;
	templates?: Template[];
	/** Template version bindings (`{ templateName: versionIdOrVersion }`). */
	bindings?: Record<string, string>;
	values?: PromptValues;
	model: string | ModelCapabilities;
	/** The plan the request came from (its request and adjustments are recorded) … */
	plan?: GenerationPlan;
	/** … or the request that was sent. */
	request?: GenerationRequest;
	adjustments?: PlanAdjustment[];
	/** Creation time (default `Date.now()`). */
	createdAt?: Date | number | string;
	startedAt?: Date | number | string;
	completedAt?: Date | number | string;
	outputIds?: string[];
	meta?: Record<string, unknown>;
	maxDepth?: number;
}

export class ProvenanceParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProvenanceParseError';
	}
}

const toIso = (value: Date | number | string) => new Date(value).toISOString();
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** Collects the templates a prompt reaches, with the body each one resolves to. */
function pinTemplates(
	rawPrompt: string,
	templates: Template[],
	bindings: Record<string, string>,
	maxDepth: number
): PinnedTemplate[] {
	const byName = new Map(templates.map((t) => [t.name, t]));
	const pinned = new Map<string, PinnedTemplate>();
	const visit = (text: string, depth: number) => {
		if (depth > maxDepth) return;
		for (const token of tokenizePrompt(text)) {
			if (token.type !== 'template' || pinned.has(token.value)) continue;
			const template = byName.get(token.value);
			if (!template) continue;
			// Mirror `getTemplateBody` so the pinned body is the one `resolvePrompt` used.
			const body = getTemplateBody(template, bindings);
			if (body === undefined) continue;
			const bound = bindings[template.name];
			const version =
				bound && template.versions
					? template.versions.find((v) => v.id === bound || v.version === bound)
					: getLatestVersion(template);
			const isVersioned = !!template.versions?.length && !!version;
			pinned.set(template.name, {
				name: template.name,
				...(template.id !== undefined ? { templateId: template.id } : {}),
				...(isVersioned ? { versionId: version!.id, version: version!.version } : {}),
				body
			});
			visit(body, depth + 1);
		}
	};
	visit(rawPrompt, 0);
	return [...pinned.values()];
}

/** Templates that reproduce the pinned bodies exactly (one single-version template each). */
export function pinnedTemplatesToTemplates(pinned: readonly PinnedTemplate[]): Template[] {
	return pinned.map((p) =>
		p.versionId !== undefined
			? {
					...(p.templateId !== undefined ? { id: p.templateId } : {}),
					name: p.name,
					latestVersion: p.version,
					versions: [{ id: p.versionId, version: p.version ?? p.versionId, body: p.body }]
				}
			: { ...(p.templateId !== undefined ? { id: p.templateId } : {}), name: p.name, body: p.body }
	);
}

/**
 * Records what produced an output: the raw prompt, the exact template bodies
 * and versions it reached, variable values, the resolved prompt and its
 * source map, the model, the planned settings and adjustments, and the
 * references by role.
 */
export function createProvenance(options: CreateProvenanceOptions): GenerationProvenance {
	const templates = options.templates ?? [];
	const maxDepth = options.maxDepth ?? 10;
	const resolved = resolvePrompt(options.rawPrompt, templates, {
		bindings: options.bindings,
		values: options.values,
		maxDepth
	});
	const pinned = pinTemplates(options.rawPrompt, templates, options.bindings ?? {}, maxDepth);
	const bindings: Record<string, string> = {};
	for (const p of pinned) if (p.versionId !== undefined) bindings[p.name] = p.versionId;

	const modelId = typeof options.model === 'string' ? options.model : options.model.id;
	const request: GenerationRequest = clone(options.plan?.request ?? options.request ?? {});
	request.model = modelId;
	if (request.prompt === undefined) request.prompt = resolved.text;
	const adjustments = clone(options.adjustments ?? options.plan?.adjustments ?? []);

	return {
		format: PROVENANCE_FORMAT,
		version: PROVENANCE_VERSION,
		rawPrompt: options.rawPrompt,
		templates: pinned,
		bindings,
		values: options.values ? clone(options.values) : null,
		resolvedPrompt: resolved.text,
		sourceMap: resolved.map.map((segment) => {
			const { locked: _locked, ...rest } = segment as SourceMapSegment & { locked?: boolean };
			return rest;
		}),
		modelId,
		request,
		adjustments,
		references: (request.references ?? []).map(({ id, role }) => ({ id, role })),
		createdAt: toIso(options.createdAt ?? Date.now()),
		...(options.startedAt !== undefined ? { startedAt: toIso(options.startedAt) } : {}),
		...(options.completedAt !== undefined ? { completedAt: toIso(options.completedAt) } : {}),
		...(options.outputIds ? { outputIds: [...options.outputIds] } : {}),
		...(options.meta ? { meta: clone(options.meta) } : {})
	};
}

/** Versioned JSON for storage next to an output. */
export function serializeProvenance(provenance: GenerationProvenance): string {
	return JSON.stringify(provenance);
}

const isRecord = (value: unknown): value is Record<string, any> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

/** Parses and checks serialized provenance. Throws {@link ProvenanceParseError}. */
export function parseProvenance(input: string | unknown): GenerationProvenance {
	let data: unknown = input;
	if (typeof input === 'string') {
		try {
			data = JSON.parse(input);
		} catch {
			throw new ProvenanceParseError('Provenance is not valid JSON.');
		}
	}
	if (!isRecord(data) || data.format !== PROVENANCE_FORMAT) {
		throw new ProvenanceParseError('Not a generation provenance record.');
	}
	if (typeof data.version !== 'number' || data.version > PROVENANCE_VERSION) {
		throw new ProvenanceParseError(`Unsupported provenance version ${JSON.stringify(data.version)}.`);
	}
	const checks: [string, boolean][] = [
		['rawPrompt', typeof data.rawPrompt === 'string'],
		['resolvedPrompt', typeof data.resolvedPrompt === 'string'],
		['modelId', typeof data.modelId === 'string'],
		['createdAt', typeof data.createdAt === 'string'],
		['request', isRecord(data.request)],
		['templates', Array.isArray(data.templates) && data.templates.every((t: any) => isRecord(t) && typeof t.name === 'string' && typeof t.body === 'string')],
		['sourceMap', Array.isArray(data.sourceMap)],
		['adjustments', Array.isArray(data.adjustments)],
		['references', Array.isArray(data.references)]
	];
	const bad = checks.find(([, ok]) => !ok);
	if (bad) throw new ProvenanceParseError(`Invalid provenance field "${bad[0]}".`);
	return {
		...(data as GenerationProvenance),
		bindings: isRecord(data.bindings) ? data.bindings : {},
		values: isRecord(data.values) ? data.values : null
	};
}

/**
 * Re-resolves the raw prompt against the pinned template bodies and values,
 * e.g. to check a record or to open it in an editor with its source map.
 */
export function replayProvenancePrompt(provenance: GenerationProvenance): {
	text: string;
	map: SourceMapSegment[];
	matches: boolean;
} {
	const result = resolvePrompt(provenance.rawPrompt, pinnedTemplatesToTemplates(provenance.templates), {
		bindings: provenance.bindings,
		...(provenance.values ? { values: provenance.values } : {})
	});
	return { text: result.text, map: result.map, matches: result.text === provenance.resolvedPrompt };
}
