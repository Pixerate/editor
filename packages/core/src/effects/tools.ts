/**
 * The agent tools for provider effects, shared by every editor that takes an `EffectProvider`:
 * `search_effects`, `describe_effect`, `list_applied_effects`, `apply_effect`, `update_effect` and
 * `remove_effect`. An editor supplies an `EffectToolHost` (what its targets are and how to change
 * them as one undo step each) and may add tools of its own (`extraTools`).
 *
 * Without a provider the read tools say so (and `list_applied_effects` still lists what a
 * document holds), and the write tools refuse with the reason. On a read-only surface the write
 * tools are hidden.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import { isEffectError } from './errors.js';
import { countEffectTags, hasEffectTags, normaliseEffectTag } from './helpers.js';
import { EFFECT_KINDS, EFFECT_USES, type EffectDescription, type EffectProvider, type EffectSummary, type EffectUse } from './types.js';

/** One effect applied to a target, as the tools report it. */
export interface AppliedEffectInfo {
	/** Its id on the target: what `update_effect` and `remove_effect` take. */
	id: string;
	effect: string;
	name?: string;
	provider?: string;
	/** What it is on the target (e.g. `clip effect`, `effect clip`, `transition`, `smart filter`, `effect layer`). */
	role: string;
	enabled: boolean;
	/** 0–1, or keyframes, where the role has an opacity. */
	opacity?: unknown;
	/** Its saved control values (numbers may be keyframes where the editor allows them). */
	values: Record<string, unknown>;
	/** Its place in the target's stack (0 = applied first), for stacked roles. */
	index?: number;
}

export interface EffectTargetEffects {
	target: string;
	/** A label for the target (a clip or layer name). */
	name?: string;
	effects: AppliedEffectInfo[];
}

export interface EffectChangeResult {
	target: string;
	/** What was added, changed or removed. */
	effect: AppliedEffectInfo;
	/** The target's effects afterwards. */
	effects: AppliedEffectInfo[];
	/** Other things the change made (a new clip or layer id, ...). */
	[extra: string]: unknown;
}

/** What an editor gives the shared effect tools. */
export interface EffectToolHost {
	/** Provider id (unique per registry). */
	id: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Toolset title, description and skill (see `AgentToolProvider`). */
	title?: string;
	description?: string;
	skill?: string;
	/** Words for the editor's targets, e.g. `{ noun: 'clip', id: 'A clip id from get_video_project (e.g. "c1").' }`. */
	target: { noun: string; id: string };
	/** The uses `apply_effect` takes on a target (others go through `extraTools`). */
	applyUses: readonly EffectUse[];
	/** Text added to `apply_effect`'s description: where the effect goes and how it is drawn. */
	applyDetails: string;
	/** The current provider, or `null`. */
	provider(): EffectProvider | null;
	/** Why edits are refused now (read-only), or `null`. */
	readOnlyReason(): string | null;
	/** Every target with effects, or one target (throws for an unknown id, naming valid ones). */
	list(target?: string): EffectTargetEffects[];
	apply(target: string, effect: string, args: { values?: Record<string, unknown>; index?: number; enabled?: boolean; opacity?: number }): Promise<EffectChangeResult>;
	update(target: string, instance: string, changes: { values?: Record<string, unknown>; index?: number; enabled?: boolean; opacity?: number }): Promise<EffectChangeResult>;
	remove(target: string, instance: string): Promise<EffectChangeResult>;
	/** Editor-specific effect tools (transitions, effect clips, effect layers, keyframes). */
	extraTools?: (context: EffectToolContext) => AgentTool[];
	/** Lets the tool list follow the provider and read-only changes. */
	subscribe?: (notify: () => void) => () => void;
}

/** Shared pieces for `extraTools`. */
export interface EffectToolContext {
	/** The provider, or a thrown error saying none is registered. */
	requireProvider(): EffectProvider;
	/** The schema of a `values` argument. */
	valuesSchema(what: string, keyframes?: boolean): JsonSchema;
	/** The schema of an `effect` argument for effects with one of `uses`. */
	effectIdSchema(uses: readonly EffectUse[]): JsonSchema;
	readonly annotations: typeof ANNOTATIONS;
}

const ANNOTATIONS = {
	read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	writeIdempotent: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
} as const;

const NO_PROVIDER = 'No effects provider is registered with this editor, so there are no effects to search, describe or apply. The host app must register one (setEffectsProvider); effects already in the document are kept and shown as placeholders.';

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema & { type: 'object' } => ({
	type: 'object',
	properties,
	...(required.length ? { required } : {}),
	additionalProperties: false
});

/** The catalog fetched once per provider, so tool schemas can list effect ids. */
interface Catalog {
	provider: EffectProvider;
	effects: readonly EffectSummary[] | null;
}

/** Most effect ids listed in an `effect` argument's enum; larger catalogs are searched instead. */
const ENUM_LIMIT = 60;
/** Most tags `search_effects` lists from its matches. */
const TAG_LIMIT = 40;

/** Catalog tags close to an unknown one (one contains the other, or they share a stem), the most used first. */
function nearestTags(tag: string, known: readonly { tag: string; count: number }[]): string[] {
	const t = normaliseEffectTag(tag);
	const stem = t.slice(0, 4);
	return known.filter((k) => k.tag.includes(t) || t.includes(k.tag) || (stem.length === 4 && k.tag.startsWith(stem))).slice(0, 5).map((k) => k.tag);
}

const summaryOut = (e: EffectSummary) => ({
	id: e.id,
	name: e.name,
	kind: e.kind,
	category: e.category,
	uses: e.uses,
	...(e.description ? { description: e.description } : {}),
	...(e.tags?.length ? { tags: e.tags } : {}),
	transparent: e.transparent,
	loop: e.loop,
	...(e.duration !== undefined ? { duration: e.duration } : {})
});

/** The agent tools for provider effects in one editor (see the module comment). */
export function createEffectToolProvider(host: EffectToolHost): AgentToolProvider {
	let catalog: Catalog | null = null;
	const listeners = new Set<() => void>();
	const notify = () => listeners.forEach((l) => l());

	/** Fetches the catalog of a new provider in the background; the tool list changes when it lands. */
	const catalogFor = (provider: EffectProvider | null): readonly EffectSummary[] | null => {
		if (!provider) return null;
		if (catalog?.provider !== provider) {
			const entry: Catalog = { provider, effects: null };
			catalog = entry;
			Promise.resolve()
				.then(() => provider.list())
				.then((effects) => {
					if (catalog === entry) {
						entry.effects = effects;
						notify();
					}
				})
				.catch(() => {});
		}
		return catalog.effects;
	};

	const requireProvider = (): EffectProvider => {
		const p = host.provider();
		if (!p) throw new Error(NO_PROVIDER);
		return p;
	};
	const writable = () => {
		const reason = host.readOnlyReason();
		if (reason) throw new Error(reason);
		return requireProvider();
	};
	/** Turns provider errors into messages a model can act on. */
	const explain = async <T>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			if (isEffectError(error)) throw new Error(error.message);
			throw error;
		}
	};

	const valuesSchema = (what: string, keyframes = false): JsonSchema => ({
		type: 'object',
		description: `${what}: control name → value, as listed by describe_effect (its "controls" schema: types, ranges, units and defaults). Only the given controls change; colours are "#rrggbb".${keyframes ? ' A number control may instead be keyframes { keys: [{ t: ms from the start, v, ease }] }.' : ''} Unknown controls and out-of-range values are refused with the valid ones.`
	});
	const effectIdSchema = (uses: readonly EffectUse[]): JsonSchema => {
		const effects = catalogFor(host.provider())?.filter((e) => (e.kind !== 'motion' || uses.includes('motion')) && e.uses.some((u) => uses.includes(u)));
		const base = `An effect id from search_effects (use ${uses.map((u) => `"${u}"`).join(' or ')}).`;
		return effects && effects.length && effects.length <= ENUM_LIMIT
			? { type: 'string', enum: effects.map((e) => e.id), description: `${base} One of: ${effects.map((e) => `${e.id} (${e.name})`).join(', ')}.` }
			: { type: 'string', minLength: 1, description: base };
	};
	const context: EffectToolContext = { requireProvider: writable, valuesSchema, effectIdSchema, annotations: ANNOTATIONS };

	const TARGET = { type: 'string', minLength: 1, description: host.target.id } as const;
	const INSTANCE = { type: 'string', minLength: 1, description: `The effect's id on the ${host.target.noun}, from list_applied_effects or apply_effect.` } as const;
	const INDEX = { type: 'integer', minimum: 0, description: `Place in the ${host.target.noun}'s effect stack: 0 is applied first (default: the end, applied last).` } as const;
	const OPACITY = { type: 'number', minimum: 0, maximum: 1, description: 'How much of the effect shows over its input, 0–1 (default 1).' } as const;
	const ENABLED = { type: 'boolean', description: 'false turns the effect off but keeps it (default true).' } as const;

	const readTools = (): AgentTool[] => [
		{
			name: 'search_effects',
			title: 'Search effects',
			description: `Searches the effects provider's catalog. Every word of query must appear in an effect's id, name, category, tags or description; filter by kind (shader, vector, motion), category, use (${EFFECT_USES.join(', ')}) or tags (effects carrying every one). For this editor, apply_effect takes uses ${host.applyUses.join(' or ')}. Returns { provider, effects: [{ id, name, kind, category, uses, description, tags, transparent, loop, duration (ms) }], total, tags: [{ tag, count }] }: tags lists the tags of every match, the most used first, so a broad search (or none) shows the tags to narrow by. A tag the catalog does not have comes back in unknownTags with the nearest ones. With no provider registered it returns available: false and the reason. Call describe_effect next for an effect's controls.`,
			inputSchema: object({
				query: { type: 'string', description: 'Words to match (default: every effect).' },
				kind: { type: 'string', enum: [...EFFECT_KINDS], description: 'shader (pixels), vector (animated SVG) or motion (animates vector art).' },
				category: { type: 'string', minLength: 1, description: 'The provider\'s category, e.g. "gradient", "light", "transition".' },
				use: { type: 'string', enum: [...EFFECT_USES], description: 'What the effect is for: filter changes a picture, transition blends two, generator draws a background, overlay draws over content, title draws a title, motion animates vector art, interactive reacts to input.' },
				tags: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Only effects carrying every one of these tags, as search_effects lists them (any case; spaces count as hyphens).' },
				limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Most effects to return (default 20).' }
			}),
			annotations: { title: 'Search effects', ...ANNOTATIONS.read },
			handler: async (args) => {
				const p = host.provider();
				if (!p) return { available: false, reason: NO_PROVIDER, effects: [], total: 0 };
				const tags = args.tags as string[] | undefined;
				// Filtered here too: a provider with its own search may not know tags.
				const found = (await explain(async () => p.search((args.query as string | undefined) ?? '', { kind: args.kind, category: args.category, use: args.use, tags }))).filter((e) => hasEffectTags(e, tags));
				const limit = (args.limit as number | undefined) ?? 20;
				const out: Record<string, unknown> = { available: true, provider: { id: p.id, name: p.name, capabilities: p.capabilities }, effects: found.slice(0, limit).map(summaryOut), total: found.length, tags: countEffectTags(found).slice(0, TAG_LIMIT) };
				if (tags?.length && !found.length) {
					const known = countEffectTags(await explain(async () => p.list()));
					const have = new Set(known.map((k) => k.tag));
					const unknown = tags.filter((t) => !have.has(normaliseEffectTag(t)));
					if (unknown.length) out.unknownTags = unknown.map((tag) => ({ tag, nearest: nearestTags(tag, known) }));
				}
				return out;
			}
		},
		{
			name: 'describe_effect',
			title: 'Describe an effect',
			description: 'Returns one effect\'s controls as a strict JSON Schema (each control described, with its type, range and units), its defaults, presets (named sets of values) and inputs, plus its summary. Use the control names and ranges for apply_effect and update_effect values. With no provider registered it returns available: false and the reason.',
			inputSchema: object({ effect: { type: 'string', minLength: 1, description: 'An effect id from search_effects or list_applied_effects.' } }, ['effect']),
			annotations: { title: 'Describe an effect', ...ANNOTATIONS.read },
			handler: async (args) => {
				const p = host.provider();
				if (!p) return { available: false, reason: NO_PROVIDER };
				const d: EffectDescription = await explain(async () => p.describe(args.effect as string));
				return { available: true, ...summaryOut(d), controls: d.controls, defaults: d.defaults, presets: d.presets, inputs: d.inputs, appliesHere: (d.kind !== 'motion' || host.applyUses.includes('motion')) && d.uses.some((u) => host.applyUses.includes(u)) };
			}
		},
		{
			name: 'list_applied_effects',
			title: 'List applied effects',
			description: `Lists the effects in the document: for each ${host.target.noun} that has any (or the one given), its effects in order with id, effect id, name, role, enabled, opacity and saved values. available is false for an effect the current provider does not have (or when none is registered): it is kept and drawn as a placeholder, and can still be removed. Works without a provider.`,
			inputSchema: object({ target: { ...TARGET, description: `${host.target.id} Leave out to list every ${host.target.noun} with effects.` } }),
			annotations: { title: 'List applied effects', ...ANNOTATIONS.read },
			handler: async (args) => {
				const p = host.provider();
				const known = new Set((p ? await explain(async () => p.list()) : []).map((e) => e.id));
				const targets = host.list(args.target as string | undefined).map((t) => ({ ...t, effects: t.effects.map((e) => ({ ...e, available: known.has(e.effect) })) }));
				return { provider: p ? { id: p.id, name: p.name } : null, ...(p ? {} : { reason: NO_PROVIDER }), targets };
			}
		}
	];

	const writeTools = (): AgentTool[] => [
		{
			name: 'apply_effect',
			title: 'Apply an effect',
			description: `Adds a provider effect to a ${host.target.noun}. ${host.applyDetails} values are checked against describe_effect's controls first; nothing changes if any is wrong. One undo step. Returns the effect with its new id (for update_effect and remove_effect) and the ${host.target.noun}'s effects. Refused when no provider is registered.`,
			inputSchema: object(
				{
					target: TARGET,
					effect: effectIdSchema(host.applyUses),
					values: valuesSchema('Control values over the effect\'s defaults', true),
					index: INDEX,
					enabled: ENABLED,
					opacity: OPACITY
				},
				['target', 'effect']
			),
			annotations: { title: 'Apply an effect', ...ANNOTATIONS.write },
			handler: async (args) => {
				writable();
				return explain(() => host.apply(args.target as string, args.effect as string, { values: args.values, index: args.index, enabled: args.enabled, opacity: args.opacity }));
			}
		},
		{
			name: 'update_effect',
			title: 'Change an applied effect',
			description: `Changes one applied effect on a ${host.target.noun}: its values (merged over the current ones; null resets a control to its default), enabled, opacity or place in the stack. Values are checked against describe_effect's controls first. One undo step. Returns the effect as it is now and the ${host.target.noun}'s effects. Refused when no provider is registered.`,
			inputSchema: object(
				{
					target: TARGET,
					effect: INSTANCE,
					values: { ...valuesSchema('Control values to change', true), description: `${valuesSchema('Control values to change', true).description} null resets a control to its default.` },
					enabled: ENABLED,
					opacity: OPACITY,
					index: { ...INDEX, description: `Move it to this place in the ${host.target.noun}'s stack (0 = applied first).` }
				},
				['target', 'effect']
			),
			annotations: { title: 'Change an applied effect', ...ANNOTATIONS.writeIdempotent },
			handler: async (args) => {
				writable();
				if (args.values === undefined && args.enabled === undefined && args.opacity === undefined && args.index === undefined) throw new Error('Give at least one of values, enabled, opacity or index to change.');
				return explain(() => host.update(args.target as string, args.effect as string, { values: args.values, enabled: args.enabled, opacity: args.opacity, index: args.index }));
			}
		},
		{
			name: 'remove_effect',
			title: 'Remove an applied effect',
			description: `Removes one applied effect from a ${host.target.noun} (an effect the provider no longer has included). One undo step. Returns what was removed and the ${host.target.noun}'s remaining effects. Refused when no provider is registered.`,
			inputSchema: object({ target: TARGET, effect: INSTANCE }, ['target', 'effect']),
			annotations: { title: 'Remove an applied effect', ...ANNOTATIONS.destructive },
			handler: async (args) => {
				writable();
				return explain(() => host.remove(args.target as string, args.effect as string));
			}
		}
	];

	return {
		id: host.id,
		...(host.namespace !== undefined ? { namespace: host.namespace } : {}),
		...(host.title ? { title: host.title } : {}),
		...(host.description ? { description: host.description } : {}),
		...(host.skill ? { skill: host.skill } : {}),
		tools: () => {
			const extra = host.extraTools?.(context) ?? [];
			if (host.readOnlyReason()) return [...readTools(), ...extra.filter((t) => t.annotations?.readOnlyHint)];
			return [...readTools(), ...writeTools(), ...extra];
		},
		subscribe: (l) => {
			listeners.add(l);
			const off = host.subscribe?.(l);
			return () => {
				listeners.delete(l);
				off?.();
			};
		}
	};
}
