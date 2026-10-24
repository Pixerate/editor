import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import { GRADIENT_INTERPOLATIONS, type GradientController } from './controller.js';
import {
	GRADIENT_PRESETS,
	checkGradient,
	gradientToCss,
	gradientToSvgDef,
	isDualGradient
} from './model.js';
import type {
	GradientCheckOptions,
	GradientInterpolation,
	GradientShape,
	GradientType
} from './types.js';

export interface GradientToolProviderOptions {
	/** Provider id (unique per registry). Default `gradient`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Read-only reason string or boolean, or getter. Write tools are suppressed if read-only. */
	readOnly?: boolean | string | (() => boolean | string);
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const readTool = (title: string) => ({ ...READ, title });
const writeTool = (title: string, destructive = false) => ({ ...WRITE, destructiveHint: destructive, title });
const writeIdempotentTool = (title: string) => ({ ...WRITE_IDEMPOTENT, title });

const fail = (message: string): never => {
	throw new Error(message);
};

export function createGradientToolProvider(
	controller: GradientController,
	options: GradientToolProviderOptions = {}
): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (r) return typeof r === 'string' ? r : 'The gradient is read-only.';
		return controller.readOnlyReason;
	};

	const tools: AgentTool[] = [
		{
			name: 'get_gradient',
			title: 'Get Gradient',
			description:
				'Returns the current gradient model, its CSS string representation, SVG definition markup, whether it contains light-dark() dual colours, and the currently selected stop id.',
			inputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false
			},
			annotations: readTool('Get Gradient'),
			handler: async () => {
				const g = controller.getGradient();
				const ro = readOnlyReason();
				return {
					gradient: g,
					css: gradientToCss(g),
					svgDef: gradientToSvgDef(g, 'gradient-preview'),
					isDual: isDualGradient(g),
					selectedStopId: controller.getSelectedStopId(),
					readOnly: ro !== null,
					...(ro ? { readOnlyReason: ro } : {})
				};
			}
		},
		{
			name: 'check_gradient',
			title: 'Check Gradient',
			description:
				'Evaluates the current gradient for perceptual defects: stops placed too close causing sharp edges, out-of-gamut colours in sRGB, color banding risks, and contrast against background or text across the gradient ramp.',
			inputSchema: {
				type: 'object',
				properties: {
					surface: {
						description: 'Optional background/surface colour to evaluate contrast against.'
					},
					text: {
						description: 'Optional text colour to evaluate WCAG 2.1 AA/AAA contrast against across all points on the gradient ramp.'
					},
					fontSize: {
						type: 'number',
						description: 'Font size in points or pixels for WCAG text contrast threshold calculation (default 14).'
					},
					bold: {
						type: 'boolean',
						description: 'Whether the text is bold for WCAG threshold calculation.'
					}
				},
				additionalProperties: false
			},
			annotations: readTool('Check Gradient'),
			handler: async (args) => {
				const g = controller.getGradient();
				const checkOpts: GradientCheckOptions = {};
				if (args.surface !== undefined) checkOpts.surface = args.surface as any;
				if (args.text !== undefined) checkOpts.text = args.text as any;
				if (typeof args.fontSize === 'number') checkOpts.fontSize = args.fontSize;
				if (typeof args.bold === 'boolean') checkOpts.bold = args.bold;
				const res = checkGradient(g, checkOpts);
				return {
					pass: res.issues.length === 0,
					issueCount: res.issues.length,
					...res
				};
			}
		},
		{
			name: 'list_gradient_presets',
			title: 'List Gradient Presets',
			description: 'Returns the collection of built-in gradient presets with their name, category, and CSS representations.',
			inputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false
			},
			annotations: readTool('List Gradient Presets'),
			handler: async () => {
				return {
					presets: Object.entries(GRADIENT_PRESETS).map(([id, gradient]) => ({
						id,
						name: id,
						css: gradientToCss(gradient),
						gradient
					}))
				};
			}
		}
	];

	if (!readOnlyReason()) {
		tools.push(
			{
				name: 'set_gradient',
				title: 'Set Gradient',
				description:
					'Replaces the entire gradient with a new gradient object or a standard CSS gradient string (e.g. "linear-gradient(90deg, #ff0000, #0000ff)"). Exactly one of "gradient" or "css" must be provided.',
				inputSchema: {
					type: 'object',
					properties: {
						gradient: {
							type: 'object',
							description: 'Gradient object with stops, type, angle, etc.'
						},
						css: {
							type: 'string',
							description: 'CSS gradient string to parse and apply.'
						}
					},
					oneOf: [
						{ required: ['gradient'] },
						{ required: ['css'] }
					],
					additionalProperties: false
				},
				annotations: writeIdempotentTool('Set Gradient'),
				handler: async (args) => {
					if (args.gradient !== undefined && args.css !== undefined) {
						fail('Provide either "gradient" or "css", not both.');
					}
					if (args.gradient === undefined && args.css === undefined) {
						fail('Provide either "gradient" or "css".');
					}
					const val = args.gradient !== undefined ? args.gradient : args.css;
					const res = controller.setGradient(val);
					if (!res.ok) fail(res.message);
					const current = controller.getGradient();
					return {
						gradient: current,
						css: gradientToCss(current)
					};
				}
			},
			{
				name: 'set_gradient_geometry',
				title: 'Set Gradient Geometry',
				description:
					'Updates the geometry of the gradient: type (linear/radial/conic), angle in degrees, center (0 to 1), shape (circle/ellipse), interpolation space or repeating mode. Pass only the fields to change. All fields are checked first and applied as one undo step; an invalid field (e.g. shape on a linear gradient) changes nothing. Returns the resulting gradient and its CSS.',
				inputSchema: {
					type: 'object',
					properties: {
						type: {
							type: 'string',
							enum: ['linear', 'radial', 'conic'],
							description: 'The geometry type of the gradient.'
						},
						angle: {
							type: 'number',
							description: 'The angle in degrees for linear or conic gradients (0 = up/top, 90 = right).'
						},
						center: {
							type: 'object',
							description: 'Center { x, y } as fractions of the box (0 to 1) for radial or conic gradients. Default { x: 0.5, y: 0.5 }.',
							properties: {
								x: { type: 'number', minimum: 0, maximum: 1, description: 'Horizontal center, 0 (left) to 1 (right).' },
								y: { type: 'number', minimum: 0, maximum: 1, description: 'Vertical center, 0 (top) to 1 (bottom).' }
							},
							required: ['x', 'y'],
							additionalProperties: false
						},
						shape: {
							type: 'string',
							enum: ['circle', 'ellipse'],
							description: 'Radial gradient shape.'
						},
						interpolation: {
							type: 'string',
							enum: [...GRADIENT_INTERPOLATIONS],
							description: 'Colour interpolation space. "oklab" (the default) gives smooth perceptual blends; "oklch" keeps chroma through hue changes.'
						},
						repeating: {
							type: 'boolean',
							description: 'Whether the gradient pattern repeats outside the defined stops.'
						}
					},
					minProperties: 1,
					additionalProperties: false
				},
				annotations: writeIdempotentTool('Set Gradient Geometry'),
				handler: async (args) => {
					if (!['type', 'angle', 'center', 'shape', 'interpolation', 'repeating'].some((k) => args[k] !== undefined)) {
						fail('Pass at least one of type, angle, center, shape, interpolation or repeating.');
					}
					const r = controller.setGeometry(
						{
							type: args.type as GradientType | undefined,
							angle: args.angle as number | undefined,
							center: args.center as { x: number; y: number } | undefined,
							shape: args.shape as GradientShape | undefined,
							interpolation: args.interpolation as GradientInterpolation | undefined,
							repeating: args.repeating as boolean | undefined
						},
						'Update Gradient Geometry'
					);
					if (!r.ok) fail(r.message);
					const current = controller.getGradient();
					return {
						gradient: current,
						css: gradientToCss(current)
					};
				}
			},
			{
				name: 'add_gradient_stop',
				title: 'Add Gradient Stop',
				description:
					'Adds a new color stop to the gradient. If color is not specified, it is sampled from the gradient at that offset.',
				inputSchema: {
					type: 'object',
					properties: {
						offset: {
							type: 'number',
							description: 'Offset along the gradient ramp from 0 to 1.'
						},
						color: {
							type: 'string',
							description: 'CSS color string, hex, hsl, oklch, or light-dark() expression for the stop.'
						}
					},
					required: ['offset'],
					additionalProperties: false
				},
				annotations: writeTool('Add Gradient Stop'),
				handler: async (args) => {
					const res = controller.addStop(args.offset as number, args.color as string | undefined);
					if (!res.ok) fail(res.message);
					return {
						stop: (res as { ok: true; stop: any }).stop,
						gradient: controller.getGradient(),
						css: gradientToCss(controller.getGradient())
					};
				}
			},
			{
				name: 'update_gradient_stop',
				title: 'Update Gradient Stop',
				description:
					'Updates an existing color stop: changes its color, its offset (position 0..1), or its transition midpoint (0..1).',
				inputSchema: {
					type: 'object',
					properties: {
						id: {
							type: 'string',
							description: 'ID of the stop to update.'
						},
						color: {
							type: 'string',
							description: 'New color string.'
						},
						offset: {
							type: 'number',
							description: 'New offset between 0 and 1.'
						},
						midpoint: {
							type: 'number',
							description: 'Transition midpoint to the next stop (0 to 1, default 0.5).'
						}
					},
					required: ['id'],
					additionalProperties: false
				},
				annotations: writeIdempotentTool('Update Gradient Stop'),
				handler: async (args) => {
					const patch: Record<string, unknown> = {};
					if (args.color !== undefined) patch.color = args.color;
					if (args.offset !== undefined) patch.offset = args.offset;
					if (args.midpoint !== undefined) patch.midpoint = args.midpoint;
					const res = controller.updateStop(args.id as string, patch);
					if (!res.ok) fail(res.message);
					return {
						stop: controller.getGradient().stops.find((s) => s.id === args.id),
						gradient: controller.getGradient(),
						css: gradientToCss(controller.getGradient())
					};
				}
			},
			{
				name: 'remove_gradient_stop',
				title: 'Remove Gradient Stop',
				description: 'Removes a color stop by its ID. Gradients must retain at least two stops.',
				inputSchema: {
					type: 'object',
					properties: {
						id: {
							type: 'string',
							description: 'ID of the stop to remove.'
						}
					},
					required: ['id'],
					additionalProperties: false
				},
				annotations: writeTool('Remove Gradient Stop', true),
				handler: async (args) => {
					const res = controller.removeStop(args.id as string);
					if (!res.ok) fail(res.message);
					return {
						removedId: args.id,
						gradient: controller.getGradient(),
						css: gradientToCss(controller.getGradient())
					};
				}
			},
			{
				name: 'reverse_gradient',
				title: 'Reverse Gradient',
				description: 'Reverses the order and offsets of all stops in the gradient ramp.',
				inputSchema: {
					type: 'object',
					properties: {},
					additionalProperties: false
				},
				annotations: writeTool('Reverse Gradient'),
				handler: async () => {
					const res = controller.reverse();
					if (!res.ok) fail(res.message);
					return {
						gradient: controller.getGradient(),
						css: gradientToCss(controller.getGradient())
					};
				}
			},
			{
				name: 'distribute_gradient_stops',
				title: 'Distribute Gradient Stops',
				description: 'Evenly distributes all color stops between 0 and 1 along the gradient ramp.',
				inputSchema: {
					type: 'object',
					properties: {},
					additionalProperties: false
				},
				annotations: writeTool('Distribute Gradient Stops'),
				handler: async () => {
					const res = controller.distribute();
					if (!res.ok) fail(res.message);
					return {
						gradient: controller.getGradient(),
						css: gradientToCss(controller.getGradient())
					};
				}
			},
			{
				name: 'apply_gradient_preset',
				title: 'Apply Gradient Preset',
				description: 'Applies one of the built-in gradient presets by its ID.',
				inputSchema: {
					type: 'object',
					properties: {
						id: {
							type: 'string',
							description: 'Preset ID (e.g. "sunset", "ocean", "neon-glow", "mesh-aurora").'
						}
					},
					required: ['id'],
					additionalProperties: false
				},
				annotations: writeIdempotentTool('Apply Gradient Preset'),
				handler: async (args) => {
					const gradient = GRADIENT_PRESETS[args.id as string];
					if (!gradient) {
						fail(`Unknown gradient preset "${args.id}". Use list_gradient_presets to inspect available presets.`);
					}
					const res = controller.setGradient(gradient, `Apply Preset: ${args.id}`);
					if (!res.ok) fail(res.message);
					return {
						preset: args.id,
						gradient: controller.getGradient(),
						css: gradientToCss(controller.getGradient())
					};
				}
			}
		);
	}

	return {
		id: options.id ?? 'gradient',
		namespace: options.namespace !== undefined ? options.namespace : options.id ?? 'gradient',
		title: 'Gradient',
		description: 'Inspect, edit, validate, and check colour gradients.',
		skill: 'pixerate-color',
		tools: () => tools
	};
}
