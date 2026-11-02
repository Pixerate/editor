/**
 * Agent tools for the provider's sequence templates, shared by the editors that can load an
 * `EffectSequence`: `list_templates`, `describe_template` and `fill_template`. An editor gives
 * them to its effect tool provider (`extraTools`) with an `EffectTemplateToolHost` that says what
 * filling makes there and does it as one undo step.
 */

import type { AgentTool } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import { templateDefaultValues, templateSlotSummary, templateValuesSchema } from './templates.js';
import type { EffectToolContext } from './tools.js';
import type { EffectProvider } from './types.js';

export interface EffectTemplateToolHost {
	/** The current provider, or `null`. */
	provider(): EffectProvider | null;
	/** Added to `fill_template`'s description: what filling makes in this editor and what it returns. */
	fillDetails: string;
	/** Arguments `fill_template` takes in this editor besides `template`, `values` and `name`. */
	fillOptions?: Record<string, JsonSchema>;
	/** Fills the template and loads it as one undo step; returns what it made. Throws a sentence when it cannot. */
	fill(template: string, values: Record<string, unknown>, options: { name?: string; [option: string]: unknown }): Promise<Record<string, unknown>>;
}

const unavailable = (provider: EffectProvider | null): string | null =>
	!provider ? 'No effects provider is registered, so there are no sequence templates.' : !provider.capabilities.supportsTemplates || !provider.listTemplates ? `${provider.name} has no sequence templates (capabilities.supportsTemplates is not set).` : null;

/** The template tools (see the module comment). */
export function effectTemplateTools(host: EffectTemplateToolHost, ctx: EffectToolContext): AgentTool[] {
	const require = (): EffectProvider => {
		const provider = host.provider();
		const reason = unavailable(provider);
		if (reason) throw new Error(reason);
		return provider!;
	};
	return [
		{
			name: 'list_templates',
			title: 'List sequence templates',
			description:
				'Lists the effects provider\'s sequence templates (ready-made scenes of several shots with slots to fill: a product reveal, before and after, a stat countdown…), best match first: { available, templates: [{ id, name, description, tags, shots, durationMs }] }. Then describe_template for a template\'s slots and fill_template to use it. Without a provider that has templates it returns available: false and the reason.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Words to match in the name, id, tags or description (default: every template).' },
					tags: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Only templates carrying every one of these tags.' },
					limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Most templates to return (default all).' }
				},
				additionalProperties: false
			},
			annotations: { title: 'List sequence templates', ...ctx.annotations.read },
			handler: async ({ query, tags, limit }) => {
				const provider = host.provider();
				const reason = unavailable(provider);
				if (reason) return { available: false, reason, templates: [] };
				return { available: true, provider: provider!.name, templates: await provider!.listTemplates!({ ...(query ? { query } : {}), ...(tags ? { tags } : {}), ...(limit ? { limit } : {}) }) };
			}
		},
		{
			name: 'describe_template',
			title: 'Describe a sequence template',
			description:
				'Describes a template\'s slots in the order a form shows them: { id, name, description, shots, slots: [{ name, type (image, video, svg, text, color, number), label, description, default or hasDefault, maxLength, min, max, integer }], slotSummaries (one line each), valuesSchema (the JSON Schema fill_template\'s values follow), exampleValues (the text, colour and number defaults, to change) }. Subject slots (image, video, svg) take a URL, markup, or { "slot": name } to leave them for the host.',
			inputSchema: { type: 'object', properties: { template: { type: 'string', minLength: 1, description: 'A template id from list_templates.' } }, required: ['template'], additionalProperties: false },
			annotations: { title: 'Describe a sequence template', ...ctx.annotations.read },
			handler: async ({ template }) => {
				const d = await require().describeTemplate!(template as string);
				return { ...d, slotSummaries: d.slots.map(templateSlotSummary), valuesSchema: templateValuesSchema(d.slots), exampleValues: templateDefaultValues(d.slots) };
			}
		},
		{
			name: 'fill_template',
			title: 'Fill a sequence template',
			description: `Fills a template's slots and loads the result. ${host.fillDetails} Slots left out take their defaults. Values are checked first: every value that does not fit (an unknown slot, a wrong type, a number out of range, text too long) is refused at once, naming what the slot takes, and nothing changes. One undo step. Subject slots left open draw nothing until filled; the result's openSlots says which.`,
			inputSchema: {
				type: 'object',
				properties: {
					template: { type: 'string', minLength: 1, description: 'A template id from list_templates.' },
					values: { type: 'object', description: 'Slot values by name, following describe_template\'s valuesSchema (default: every slot\'s default).' },
					name: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', description: 'A name for the result: lowercase words and dashes (default the template\'s).' },
					...(host.fillOptions ?? {})
				},
				required: ['template'],
				additionalProperties: false
			},
			annotations: { title: 'Fill a sequence template', ...ctx.annotations.write },
			handler: async ({ template, values, ...options }) => {
				require();
				return host.fill(template as string, (values as Record<string, unknown> | undefined) ?? {}, options);
			}
		}
	];
}
