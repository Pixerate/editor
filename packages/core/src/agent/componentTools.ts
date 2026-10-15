import { hasVariantCommands, type ComponentCommandTarget } from '../commands/builtins.js';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { ToolProviderOptions } from './providers.js';

const IDS = { type: 'array', items: { type: 'string' }, description: 'Node ids (default: the selection).' } as const;
const ID = { type: 'string', description: 'An instance, or a layer inside one (default: the first selected node).' } as const;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

type Outcome = { ok: true; ids: string[] } | { ok: false; reason: string };
const check = (result: Outcome) => {
	if (!result.ok) throw new Error(result.reason);
	return { ids: result.ids };
};

/**
 * Agent tools for canvas components and instances, backed by a components controller
 * (`createCanvasComponentsController`): `list_components`, `inspect_instance`,
 * `create_component`, `combine_as_variants`, `create_instance`, `set_instance_properties`
 * (variants and component properties), `swap_instance`, `reset_overrides`, `push_overrides`,
 * `detach_instance`, `go_to_main_component`, `restore_main_component` and (when the controller
 * has them) the variant editors `add_variant`, `remove_variant`, `set_variant_properties`,
 * `rename_variant_property` and `rename_variant_value`. Refused actions come back as tool errors
 * carrying the reason.
 */
export function createCanvasComponentToolProvider(
	controller: ComponentCommandTarget,
	options: ToolProviderOptions = { id: 'canvas-components' }
): AgentToolProvider {
	const tool = (
		name: string,
		description: string,
		properties: Record<string, unknown>,
		handler: AgentTool['handler'],
		extra: { required?: string[]; readOnly?: boolean } = {}
	): AgentTool => ({
		name,
		description,
		inputSchema: { type: 'object', properties: properties as never, ...(extra.required ? { required: extra.required } : {}), additionalProperties: false },
		annotations: extra.readOnly ? READ : WRITE,
		handler
	});
	const tools: AgentTool[] = [
		tool('list_components', 'Lists components (id, name, variant values, instance count) and component sets with their variant options.', {}, () => controller.list(), {
			readOnly: true
		}),
		tool(
			'inspect_instance',
			'Describes an instance: its main component, variant, component property values (with types) and the overrides of its layers.',
			{ id: ID },
			({ id }) => {
				const info = controller.inspect(id);
				if (!info) throw new Error('Not an instance (or a layer inside one).');
				return info;
			},
			{ readOnly: true }
		),
		tool('create_component', 'Turns the given frame into a main component, or wraps the given layers in a new one.', { ids: IDS }, ({ ids }) =>
			check(controller.createComponent(ids))
		),
		tool('combine_as_variants', 'Wraps sibling components in a component set (variants named "Property=Value, …").', { ids: IDS }, ({ ids }) =>
			check(controller.combineAsVariants(ids))
		),
		tool(
			'create_instance',
			'Places an instance of a component or component set, optionally inside a frame, at a position, with property values.',
			{
				componentId: { type: 'string' },
				parentId: { type: 'string' },
				x: { type: 'number' },
				y: { type: 'number' },
				properties: { type: 'object', additionalProperties: true, description: 'Variant and component property values.' }
			},
			({ componentId, parentId, x, y, properties }) =>
				check(
					controller.createInstance(componentId, {
						...(parentId !== undefined ? { parentId } : {}),
						...(x !== undefined || y !== undefined ? { position: { x: x ?? 0, y: y ?? 0 } } : {}),
						...(properties ? { properties } : {})
					})
				),
			{ required: ['componentId'] }
		),
		tool(
			'set_instance_properties',
			'Sets property values of instances: variant properties switch the variant (keeping compatible overrides), booleans toggle layers, text sets text, instance swap takes a component id.',
			{ properties: { type: 'object', additionalProperties: true }, ids: IDS },
			({ properties, ids }) => check(controller.setInstanceProperties(properties, ids)),
			{ required: ['properties'] }
		),
		tool(
			'swap_instance',
			'Makes instances show another component (or a set’s default variant), keeping overrides of layers with matching names.',
			{ componentId: { type: 'string' }, ids: IDS },
			({ componentId, ids }) => check(controller.swapInstance(componentId, ids)),
			{ required: ['componentId'] }
		),
		tool(
			'reset_overrides',
			'Resets overrides: of a whole instance (default), of one layer, or one override group such as "data.label" or "shape.fill".',
			{ id: ID, group: { type: 'string' } },
			({ id, group }) => check(controller.resetOverrides(id, group))
		),
		tool('push_overrides', 'Copies an instance’s overrides to its main component (and so to every other instance).', { id: ID }, ({ id }) =>
			check(controller.pushOverrides(id))
		),
		tool('detach_instance', 'Turns instances into plain frames that keep their current look.', { ids: IDS }, ({ ids }) => check(controller.detachInstance(ids))),
		tool('go_to_main_component', 'Selects the main component of an instance and returns its id.', { id: ID }, ({ id }) => {
			const main = controller.goToMainComponent(id);
			if (!main) throw new Error('The main component was not found.');
			return { id: main };
		}),
		tool('restore_main_component', 'Turns an instance whose main component was deleted back into the main component.', { id: ID }, ({ id }) =>
			check(controller.restoreMainComponent(id))
		)
	];
	if (hasVariantCommands(controller)) {
		const SET = { type: 'string', description: 'Component set, or one of its variants (default: the selection’s set).' };
		const VARIANT = { type: 'string', description: 'Variant id (default: the first selected variant).' };
		const VALUES = { type: 'object', additionalProperties: { type: 'string' }, description: 'Variant property → value, e.g. { "Size": "Medium" }.' };
		tools.push(
			tool(
				'add_variant',
				'Adds a variant to a component set by duplicating one (default: the set’s default variant) with new property values. Unnamed properties keep the source’s values; new property names are added to every variant ("Default"). A combination another variant has is refused. Without values the next "VariantN" is used.',
				{ setId: SET, from: { type: 'string', description: 'Variant to duplicate.' }, variant: VALUES, x: { type: 'number' }, y: { type: 'number' } },
				({ setId, from, variant, x, y }) =>
					check(
						controller.addVariant(setId, {
							...(from !== undefined ? { from } : {}),
							...(variant ? { variant } : {}),
							...(x !== undefined || y !== undefined ? { position: { x: x ?? 0, y: y ?? 0 } } : {})
						})
					)
			),
			tool(
				'remove_variant',
				'Removes a variant from its component set (not the last one). Its instances switch to the closest remaining variant, keeping overrides.',
				{ id: VARIANT },
				({ id }) => check(controller.removeVariant(id))
			),
			tool(
				'set_variant_properties',
				'Sets a variant’s property values (merged with its current ones); new property names are added to every variant. A combination another variant has is refused.',
				{ values: VALUES, id: VARIANT },
				({ values, id }) => check(controller.setVariantProperties(values, id)),
				{ required: ['values'] }
			),
			tool(
				'rename_variant_property',
				'Renames a variant property across a component set (instances keep their variant).',
				{ name: { type: 'string' }, newName: { type: 'string' }, setId: SET },
				({ name, newName, setId }) => check(controller.renameVariantProperty(name, newName, setId)),
				{ required: ['name', 'newName'] }
			),
			tool(
				'rename_variant_value',
				'Renames a value of a variant property across a component set (instances keep their variant).',
				{ property: { type: 'string' }, value: { type: 'string' }, newValue: { type: 'string' }, setId: SET },
				({ property, value, newValue, setId }) => check(controller.renameVariantValue(property, value, newValue, setId)),
				{ required: ['property', 'value', 'newValue'] }
			)
		);
	}
	return { id: options.id, namespace: options.namespace, tools };
}
