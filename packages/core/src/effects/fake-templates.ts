/**
 * The fake provider's sequence templates (`createFakeEffectProvider({ templates: true })`), built
 * only from its own effects, and a small reference of how a provider fills one: `{{slot}}` in any
 * string (a whole-string placeholder takes the typed value), and `{ slot }` subjects.
 *
 * - `fake.title-sequence`: a gradient behind a title with a lower-third bar, then a crossfade to
 *   a second shot with a caption. Text, colour and number slots.
 * - `fake.picture-reveal`: a tinted picture, then a crossfade to the picture with a logo over it.
 *   An image slot with a default and one without (left for the host when not given).
 */

import { UnknownTemplateError } from './errors.js';
import { checkTemplateValues, effectSequenceSlots, EFFECT_SEQUENCE_NAME, isSubjectTemplateSlot, searchTemplateSummaries } from './templates.js';
import type {
	EffectSequence,
	EffectSubject,
	EffectTemplateDescription,
	EffectTemplateOptions,
	EffectTemplateResult,
	EffectTemplateSearchOptions,
	EffectTemplateSlot,
	EffectTemplateSummary,
	EffectTemplateValues
} from './types.js';

/** A template as the fake provider keeps it: slots with their subject defaults, and a sequence with placeholders. */
interface FakeTemplate {
	summary: EffectTemplateSummary;
	slots: (EffectTemplateSlot & { subjectDefault?: string })[];
	/** An `EffectSequence` whose strings may hold `{{slot}}` placeholders. */
	sequence: unknown;
}

const PLACEHOLDER = /\{\{([A-Za-z][\w-]*)\}\}/g;
const WHOLE = /^\{\{([A-Za-z][\w-]*)\}\}$/;

const picture = (label: string, tint: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" width="160" height="90"><rect width="160" height="90" fill="${tint}"/><text x="80" y="50" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#fff">${label}</text></svg>`;

const TEMPLATES: readonly FakeTemplate[] = [
	{
		summary: { id: 'fake.title-sequence', name: 'Title sequence', description: 'A gradient behind a title with a lower-third bar, then a crossfade to a closing shot with a caption.', tags: ['title', 'intro'], shots: 2, durationMs: 4600 },
		slots: [
			{ name: 'title', type: 'text', label: 'Title', default: 'Hello', maxLength: 40 },
			{ name: 'subtitle', type: 'text', label: 'Closing caption', default: 'See you soon', maxLength: 60 },
			{ name: 'accent', type: 'color', label: 'Accent colour', default: '#0ea5e9' },
			{ name: 'holdMs', type: 'number', label: 'Time on each shot (ms)', default: 2000, min: 500, max: 10000, integer: true }
		],
		sequence: {
			name: 'title-sequence',
			title: '{{title}}',
			stage: { width: 1280, height: 720 },
			shots: [
				{
					hold: '{{holdMs}}',
					title: '{{title}}',
					layers: [
						{ id: 'backdrop', effect: 'fake.gradient', role: 'background', values: { from: '{{accent}}' }, until: { shots: 1 } },
						{ id: 'bar', effect: 'fake.bar', role: 'overlay', values: { color: '{{accent}}' }, from: 200 }
					]
				},
				{
					hold: '{{holdMs}}',
					caption: '{{subtitle}}',
					transition: { effect: 'fake.crossfade', ms: 600 },
					layers: [{ id: 'closing', effect: 'fake.gradient', role: 'background', values: { from: '#111827', to: '{{accent}}' } }]
				}
			]
		}
	},
	{
		summary: { id: 'fake.picture-reveal', name: 'Picture reveal', description: 'A tinted picture, then a crossfade to the picture in full colour with a logo over it and a caption.', tags: ['product', 'reveal'], shots: 2, durationMs: 4800 },
		slots: [
			{ name: 'picture', type: 'image', label: 'Picture', description: 'The picture to reveal.', hasDefault: true, subjectDefault: picture('Picture', '#64748b') },
			{ name: 'logo', type: 'image', label: 'Logo', description: 'A logo shown over the second shot; the host fills it when none is given.', hasDefault: false },
			{ name: 'caption', type: 'text', label: 'Caption', default: 'Now in colour', maxLength: 50 },
			{ name: 'holdMs', type: 'number', label: 'Time on each shot (ms)', default: 2000, min: 500, max: 10000, integer: true }
		],
		sequence: {
			name: 'picture-reveal',
			stage: { width: 1280, height: 720 },
			shots: [
				{ hold: '{{holdMs}}', layers: [{ id: 'tinted', effect: 'fake.tint', subject: { slot: 'picture' }, values: { color: '#704214', amount: 0.6 } }] },
				{
					hold: '{{holdMs}}',
					caption: '{{caption}}',
					transition: { effect: 'fake.crossfade', ms: 800 },
					layers: [
						{ id: 'picture', subject: { slot: 'picture' }, role: 'background' },
						{ id: 'logo', subject: { slot: 'logo' }, role: 'overlay', rect: { x: 1040, y: 40, width: 200, height: 112 }, fade: 300 }
					]
				}
			]
		}
	}
];

const describeOf = (t: FakeTemplate): EffectTemplateDescription => ({
	...t.summary,
	slots: t.slots.map(({ subjectDefault: _d, ...slot }) => slot as EffectTemplateSlot)
});

/** A subject slot's value as a subject. */
function subjectOf(type: string, value: unknown): EffectSubject {
	if (typeof value !== 'string') return value as EffectSubject;
	if (value.trimStart().startsWith('<svg') || type === 'svg') return { svg: value };
	return type === 'video' ? { video: value } : { image: value };
}

/** Fills a template's placeholders and subject slots (values already checked). */
function fill(t: FakeTemplate, values: EffectTemplateValues): EffectSequence {
	const slots = new Map(t.slots.map((s) => [s.name, s]));
	const valueOf = (name: string): unknown => {
		const s = slots.get(name)!;
		return values[name] ?? (isSubjectTemplateSlot(s) ? s.subjectDefault : (s as { default: unknown }).default);
	};
	const walk = (v: unknown, key?: string): unknown => {
		if (typeof v === 'string') {
			const whole = WHOLE.exec(v);
			if (whole && slots.has(whole[1])) return valueOf(whole[1]);
			return v.replace(PLACEHOLDER, (m, name: string) => (slots.has(name) ? String(valueOf(name)) : m));
		}
		if (Array.isArray(v)) return v.map((x) => walk(x));
		if (!v || typeof v !== 'object') return v;
		if (key === 'subject' && typeof (v as { slot?: unknown }).slot === 'string') {
			const s = slots.get((v as { slot: string }).slot);
			const value = s ? valueOf(s.name) : undefined;
			return s && value !== undefined ? subjectOf(s.type, value) : v;
		}
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
	};
	return walk(t.sequence) as EffectSequence;
}

/** The template methods of the fake provider. */
export function fakeTemplateMethods() {
	const byId = new Map(TEMPLATES.map((t) => [t.summary.id, t]));
	const get = (id: string) => {
		const t = byId.get(id);
		if (!t) throw new UnknownTemplateError(id, 'the fake provider');
		return t;
	};
	return {
		listTemplates: (options?: EffectTemplateSearchOptions): EffectTemplateSummary[] => searchTemplateSummaries(TEMPLATES.map((t) => t.summary), options).map((s) => structuredClone(s)),
		describeTemplate: (id: string): EffectTemplateDescription => structuredClone(describeOf(get(id))),
		instantiateTemplate(id: string, values: EffectTemplateValues = {}, options: EffectTemplateOptions = {}): EffectTemplateResult {
			const t = get(id);
			const errors = checkTemplateValues(describeOf(t).slots, values);
			if (options.name !== undefined && (typeof options.name !== 'string' || !EFFECT_SEQUENCE_NAME.test(options.name))) errors.push(`The sequence name is lowercase words and dashes (like "${t.summary.id.replace(/^fake\./, '')}").`);
			if (errors.length) return { ok: false, errors };
			const sequence = fill(t, values);
			if (options.name) sequence.name = options.name;
			return { ok: true, sequence, openSlots: effectSequenceSlots(sequence), notes: [] };
		}
	};
}
