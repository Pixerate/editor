/**
 * Helpers for sequence templates and the sequences they fill to (see `EffectSequence`): the
 * values a template takes as a JSON Schema, checking values before asking the provider, checking
 * a sequence before loading it, and which input a layer's subject feeds. Dependency-free.
 */

import type { JsonSchema } from '../tools/schema.js';
import { hasEffectTags } from './helpers.js';
import {
	EFFECT_LAYER_ROLES,
	type EffectDescription,
	type EffectLayer,
	type EffectLayerRole,
	type EffectLayerTime,
	type EffectRect,
	type EffectSequence,
	type EffectSubject,
	type EffectSubjectKind,
	type EffectSummary,
	type EffectTemplateSearchOptions,
	type EffectTemplateSlot,
	type EffectTemplateSummary
} from './types.js';

const SLOT_NAME = /^[A-Za-z][\w-]*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
export const EFFECT_SEQUENCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** True for a subject slot (`image`, `video`, `svg`). */
export const isSubjectTemplateSlot = (slot: Pick<EffectTemplateSlot, 'type'>): boolean => slot.type === 'image' || slot.type === 'video' || slot.type === 'svg';

/** The kind of a subject (`image`, `video`, `svg`, `text`, `slot`), or undefined when it is none of them. */
export function effectSubjectKind(subject: unknown): EffectSubjectKind | undefined {
	if (!isObject(subject)) return undefined;
	for (const k of ['slot', 'image', 'video', 'svg', 'text'] as const) if (typeof subject[k] === 'string') return k;
	return undefined;
}

const typeName = (value: unknown): string =>
	value === null
		? 'null'
		: Array.isArray(value)
			? 'a list'
			: typeof value === 'object'
				? 'an object'
				: typeof value === 'string'
					? `the words ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`
					: `${typeof value === 'number' ? 'the number' : 'the value'} ${String(value)}`;

function range(slot: Extract<EffectTemplateSlot, { type: 'number' }>): string {
	const whole = slot.integer ? 'whole number' : 'number';
	if (slot.min !== undefined && slot.max !== undefined) return `a ${whole} from ${slot.min} to ${slot.max}`;
	if (slot.min !== undefined) return `a ${whole} of at least ${slot.min}`;
	if (slot.max !== undefined) return `a ${whole} of at most ${slot.max}`;
	return `a ${whole}`;
}

/** What a slot takes, in a few words ("words (up to 40 characters)", "a colour like #FF5A36"). */
export function templateSlotTakes(slot: EffectTemplateSlot): string {
	switch (slot.type) {
		case 'text':
			return `words${slot.maxLength !== undefined ? ` (up to ${slot.maxLength} characters)` : ''}`;
		case 'color':
			return `a colour written #RRGGBB, like "${slot.default}"`;
		case 'number':
			return range(slot);
		case 'video':
			return 'a video URL';
		case 'svg':
			return 'SVG markup or an SVG URL';
		default:
			return 'a picture: a URL, a data: URL or <svg> markup';
	}
}

/** The problem with one value for a slot, as a sentence, or undefined when it fits. */
export function templateValueProblem(slot: EffectTemplateSlot, value: unknown): string | undefined {
	const no = (extra = '') => `Slot "${slot.name}" takes ${templateSlotTakes(slot)}${extra}, not ${typeName(value)}.`;
	switch (slot.type) {
		case 'text':
			if (typeof value !== 'string') return no();
			if (slot.maxLength !== undefined && value.length > slot.maxLength) return `Slot "${slot.name}" takes up to ${slot.maxLength} characters; the value has ${value.length}. Shorten it.`;
			return undefined;
		case 'color':
			return typeof value === 'string' && COLOR.test(value) ? undefined : no();
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) return no();
			if (slot.integer && !Number.isInteger(value)) return `Slot "${slot.name}" takes ${range(slot)}; ${value} is not whole.`;
			if ((slot.min !== undefined && value < slot.min) || (slot.max !== undefined && value > slot.max)) return `Slot "${slot.name}" takes ${range(slot)}; ${value} is out of range.`;
			return undefined;
		default: {
			const host = ` (or { "slot": "${slot.name}" } to leave it for the host)`;
			if (typeof value === 'string') return value.trim() ? undefined : no(host);
			const kind = effectSubjectKind(value);
			if (!kind) return no(host);
			if (kind === 'slot') return SLOT_NAME.test((value as { slot: string }).slot) ? undefined : `Slot "${slot.name}" left for the host is { "slot": name }, the name letters, digits, "-" and "_", starting with a letter.`;
			const fits = kind === slot.type || (slot.type === 'image' && kind === 'svg');
			if (!fits) return `Slot "${slot.name}" takes { "${slot.type}": … }${slot.type === 'image' ? ' or { "svg": … }' : ''}, not { "${kind}": … }.`;
			return (value as Record<string, string>)[kind].trim() ? undefined : `Slot "${slot.name}"'s "${kind}" is a non-empty string.`;
		}
	}
}

const slotList = (slots: readonly EffectTemplateSlot[]): string => (slots.length ? `the slots are ${slots.map((s) => `${s.name} (${s.type})`).join(', ')}` : 'the template has no slots');

/**
 * Every problem with `values` for a template's slots, as sentences: unknown slots, wrong types,
 * out-of-range numbers, text too long. Empty when they fit. Slots left out take their defaults.
 */
export function checkTemplateValues(slots: readonly EffectTemplateSlot[], values: unknown): string[] {
	if (values === undefined) return [];
	if (!isObject(values)) return [`Values are an object of slot names to values; ${slotList(slots)}.`];
	const byName = new Map(slots.map((s) => [s.name, s]));
	const errors: string[] = [];
	for (const [name, value] of Object.entries(values)) {
		const slot = byName.get(name);
		if (!slot) errors.push(`There is no slot "${name}"; ${slotList(slots)}.`);
		else if (value !== undefined) {
			const problem = templateValueProblem(slot, value);
			if (problem) errors.push(problem);
		}
	}
	return errors;
}

/** One slot's value as a JSON Schema. */
export function templateSlotSchema(slot: EffectTemplateSlot): JsonSchema {
	const about = `${slot.label}${slot.description ? `: ${slot.description}` : ''}.`;
	switch (slot.type) {
		case 'text':
			return { type: 'string', ...(slot.maxLength !== undefined ? { maxLength: slot.maxLength } : {}), description: `${about} Words${slot.maxLength !== undefined ? `, up to ${slot.maxLength} characters` : ''}. Default ${JSON.stringify(slot.default)}.` };
		case 'color':
			return { type: 'string', pattern: COLOR.source, description: `${about} A colour as #RRGGBB. Default ${slot.default}.` };
		case 'number':
			return {
				type: slot.integer ? 'integer' : 'number',
				...(slot.min !== undefined ? { minimum: slot.min } : {}),
				...(slot.max !== undefined ? { maximum: slot.max } : {}),
				description: `${about} ${range(slot).replace(/^a /, 'A ')}. Default ${slot.default}.`
			};
		default: {
			const key = slot.type;
			const object = (k: string, what: string): JsonSchema => ({ type: 'object', properties: { [k]: { type: 'string', description: what } }, required: [k], additionalProperties: false, description: `{ "${k}": … }` });
			return {
				anyOf: [
					{ type: 'string', minLength: 1, description: key === 'video' ? 'A video URL.' : key === 'svg' ? 'SVG markup or an SVG URL.' : 'A picture URL, a data: URL or <svg> markup.' },
					object(key, key === 'video' ? 'A video URL.' : key === 'svg' ? 'SVG markup or an SVG URL.' : 'A picture URL or a data: URL.'),
					...(key === 'image' ? [object('svg', 'SVG markup.')] : []),
					object('slot', 'A slot name, to leave the subject for the host to fill.')
				],
				description: `${about} ${templateSlotTakes(slot).replace(/^a /, 'A ')}. ${slot.hasDefault ? 'Default: a placeholder picture.' : 'No default: left out, the host fills it.'}`
			};
		}
	}
}

/** The values a template takes as a strict JSON Schema (every slot optional; `additionalProperties: false`). */
export function templateValuesSchema(slots: readonly EffectTemplateSlot[]): JsonSchema & { type: 'object' } {
	return {
		type: 'object',
		properties: Object.fromEntries(slots.map((s) => [s.name, templateSlotSchema(s)])),
		additionalProperties: false,
		description: `Slot values by name; slots left out take their defaults. ${slots.length ? `Slots: ${slots.map((s) => s.name).join(', ')}.` : 'This template has no slots.'}`
	};
}

/** The defaults of a template's text, colour and number slots: an example `values` object to change. */
export function templateDefaultValues(slots: readonly EffectTemplateSlot[]): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	for (const s of slots) if (!isSubjectTemplateSlot(s)) out[s.name] = (s as { default: string | number }).default;
	return out;
}

/** One line on a slot: its name, type, what it takes and its default. */
export function templateSlotSummary(slot: EffectTemplateSlot): string {
	const fallback = isSubjectTemplateSlot(slot) ? ((slot as { hasDefault: boolean }).hasDefault ? 'a placeholder by default' : 'the host fills it when none is given') : `default ${JSON.stringify((slot as { default: unknown }).default)}`;
	return `${slot.name} (${slot.type}): ${slot.label}; takes ${templateSlotTakes(slot)}; ${fallback}.`;
}

/** Templates matching every word of `query` (in name, id, tags or description) and every tag, best first. */
export function searchTemplateSummaries<T extends EffectTemplateSummary>(catalog: readonly T[], options: EffectTemplateSearchOptions = {}): T[] {
	const words = (options.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
	const scored: { t: T; score: number }[] = [];
	for (const t of catalog) {
		if (!hasEffectTags(t, options.tags)) continue;
		let score = 0;
		const name = t.name.toLowerCase();
		const rest = [t.id, ...(t.tags ?? []), t.description].join(' ').toLowerCase();
		if (!words.every((w) => name.includes(w) || rest.includes(w))) continue;
		for (const w of words) score += name.includes(w) ? 2 : 1;
		scored.push({ t, score });
	}
	scored.sort((a, b) => b.score - a.score);
	const out = scored.map((s) => s.t);
	return options.limit !== undefined ? out.slice(0, Math.max(0, options.limit)) : out;
}

// ---------------------------------------------------------------------------
// Layers and sequences
// ---------------------------------------------------------------------------

/** Where a layer sits: its `role`, else `subject` when it has a `rect`, else `background`. */
export const effectLayerRole = (layer: Pick<EffectLayer, 'role' | 'rect'>): EffectLayerRole => layer.role ?? (layer.rect ? 'subject' : 'background');

/**
 * The image input a layer's subject feeds: `source` when the effect has it, else its first image
 * input; undefined when it takes no picture (a generator: then the layer cannot have a subject).
 */
export function effectLayerInput(description: Pick<EffectDescription, 'inputs'>): string | undefined {
	const images = description.inputs.filter((i) => i.kind === 'image');
	return (images.find((i) => i.name === 'source') ?? images.find((i) => i.name !== 'from' && i.name !== 'to'))?.name;
}

/** The uses a layer's effect may have (a transition belongs on `EffectSequenceShot.transition`, a camera move on `camera`). */
export const EFFECT_LAYER_USES = ['generator', 'filter', 'overlay', 'title'] as const;

/** True for an effect a layer can show. */
export const effectLayerOffered = (e: Pick<EffectSummary, 'kind' | 'uses'>): boolean => (e.kind === 'shader' || e.kind === 'vector') && e.uses.some((u) => (EFFECT_LAYER_USES as readonly string[]).includes(u));

const isRect = (r: unknown): r is EffectRect => isObject(r) && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k])) && (r.width as number) > 0 && (r.height as number) > 0;
const isLayerTime = (t: unknown): t is EffectLayerTime => (typeof t === 'number' && Number.isFinite(t) && t >= 0) || (isObject(t) && Number.isInteger(t.shots) && (t.shots as number) >= 1);

/** Problems with one subject, or undefined when it is sound. */
export function effectSubjectProblem(subject: unknown): string | undefined {
	const kind = effectSubjectKind(subject);
	if (!kind) return `a subject is one of { image }, { video }, { svg }, { text } or { slot }, not ${typeName(subject)}`;
	if (!(subject as Record<string, string>)[kind].trim()) return `a subject's "${kind}" is a non-empty string`;
	return undefined;
}

/**
 * Every problem with a sequence's shape, as sentences ("shot 2, layer 1: …"). With `catalog`, also
 * effect ids it does not list, layer effects that cannot be layers and transitions without the
 * use `transition`. Empty when the sequence is sound.
 */
export function checkEffectSequence(sequence: unknown, catalog?: readonly Pick<EffectSummary, 'id' | 'kind' | 'uses'>[]): string[] {
	const problems: string[] = [];
	if (!isObject(sequence)) return ['A sequence is an object with name, stage and shots.'];
	if (typeof sequence.name !== 'string' || !sequence.name) problems.push('The sequence needs a name.');
	const stage = sequence.stage as Record<string, unknown> | undefined;
	if (!isObject(stage) || !(Number(stage.width) > 0) || !(Number(stage.height) > 0)) problems.push('The sequence needs a stage { width, height } in pixels, both > 0.');
	if (!Array.isArray(sequence.shots) || !sequence.shots.length) return [...problems, 'The sequence needs at least one shot.'];
	const byId = catalog ? new Map(catalog.map((e) => [e.id, e])) : undefined;
	const ids = new Set<string>();
	sequence.shots.forEach((shot: unknown, i: number) => {
		const at = `shot ${i + 1}`;
		if (!isObject(shot)) return void problems.push(`${at} is not an object.`);
		if (!(Number.isFinite(shot.hold) && (shot.hold as number) >= 0)) problems.push(`${at}: hold must be ms ≥ 0.`);
		for (const k of ['title', 'caption'] as const) if (shot[k] !== undefined && typeof shot[k] !== 'string') problems.push(`${at}: ${k} must be words.`);
		if (shot.camera !== undefined) {
			const camera = shot.camera as Record<string, unknown>;
			if (!isObject(camera)) problems.push(`${at}: camera must be an object.`);
			else if (camera.framing !== undefined && !isRect(camera.framing)) problems.push(`${at}: camera.framing must be { x, y, width, height } with width and height > 0.`);
		}
		if (!Array.isArray(shot.layers)) problems.push(`${at}: layers must be a list (it may be empty).`);
		else
			shot.layers.forEach((layer: unknown, j: number) => {
				const where = `${at}, layer ${j + 1}`;
				if (!isObject(layer)) return void problems.push(`${where} is not an object.`);
				if (layer.id !== undefined) {
					if (typeof layer.id !== 'string' || !layer.id) problems.push(`${where}: id must be a non-empty string.`);
					else if (ids.has(layer.id)) problems.push(`${where}: id "${layer.id}" is used twice.`);
					else ids.add(layer.id);
				}
				if (layer.effect === undefined && layer.subject === undefined) problems.push(`${where} has neither an effect nor a subject.`);
				if (layer.effect !== undefined && (typeof layer.effect !== 'string' || !layer.effect)) problems.push(`${where}: effect must be an effect id.`);
				else if (typeof layer.effect === 'string' && byId) {
					const e = byId.get(layer.effect);
					if (!e) problems.push(`${where}: the provider has no effect "${layer.effect}".`);
					else if (!effectLayerOffered(e)) problems.push(`${where}: "${layer.effect}" (${e.kind}, ${e.uses.join('/')}) cannot be a layer; a layer's effect is a generator, filter, overlay or title.`);
				}
				if (layer.subject !== undefined) {
					const p = effectSubjectProblem(layer.subject);
					if (p) problems.push(`${where}: ${p}.`);
				}
				if (layer.role !== undefined && !EFFECT_LAYER_ROLES.includes(layer.role as EffectLayerRole)) problems.push(`${where}: role is one of ${EFFECT_LAYER_ROLES.join(', ')}.`);
				if (layer.rect !== undefined && !isRect(layer.rect)) problems.push(`${where}: rect must be { x, y, width, height } with width and height > 0.`);
				for (const k of ['from', 'until'] as const) if (layer[k] !== undefined && !isLayerTime(layer[k])) problems.push(`${where}: ${k} is ms ≥ 0 or { shots: n } with n ≥ 1.`);
				if (layer.opacity !== undefined && !(typeof layer.opacity === 'number' && layer.opacity >= 0 && layer.opacity <= 1)) problems.push(`${where}: opacity is 0–1.`);
				if (layer.fade !== undefined && !(typeof layer.fade === 'number' && layer.fade >= 0)) problems.push(`${where}: fade is ms ≥ 0.`);
				if (layer.values !== undefined && !isObject(layer.values)) problems.push(`${where}: values must be an object of control values.`);
			});
		if (shot.transition !== undefined) {
			const t = shot.transition as Record<string, unknown>;
			if (i === 0) problems.push(`${at} has a transition, but there is no shot before it.`);
			if (!isObject(t) || typeof t.effect !== 'string' || !t.effect) problems.push(`${at}: transition needs an effect id.`);
			else {
				if (t.ms !== undefined && !(typeof t.ms === 'number' && t.ms > 0)) problems.push(`${at}: transition ms must be > 0.`);
				const e = byId?.get(t.effect);
				if (byId && !e) problems.push(`${at}: the provider has no transition "${t.effect}".`);
				else if (e && !e.uses.includes('transition')) problems.push(`${at}: "${t.effect}" is not a transition (its uses are ${e.uses.join(', ')}).`);
			}
		}
	});
	return problems;
}

/** Every effect id a sequence names (layers and transitions), each once. */
export function effectSequenceEffects(sequence: EffectSequence): string[] {
	const out = new Set<string>();
	for (const shot of sequence.shots) {
		for (const l of shot.layers) if (l.effect) out.add(l.effect);
		if (shot.transition) out.add(shot.transition.effect);
	}
	return [...out];
}

/** Subject slots a sequence leaves for the host (`{ slot }` subjects), each once. */
export function effectSequenceSlots(sequence: EffectSequence): string[] {
	const out = new Set<string>();
	for (const shot of sequence.shots) for (const l of shot.layers) if (l.subject && 'slot' in l.subject) out.add((l.subject as Extract<EffectSubject, { slot: string }>).slot);
	return [...out];
}
