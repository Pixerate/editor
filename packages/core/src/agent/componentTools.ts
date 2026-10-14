import type { ComponentCommandTarget } from '../commands/builtins.js';
import type { AgentTool, AgentToolProvider } from './registry.js';
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
 * `detach_instance`, `go_to_main_component` and `restore_main_component`. Refused actions come
 * back as tool errors carrying the reason.
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
	return { id: options.id, namespace: options.namespace, tools };
}
