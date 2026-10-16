import type { CommandSpec } from '../commands/registry.js';
import type { VectorEditorController, VectorShapeInput } from './controller.js';
import { vectorNodeBounds, vectorPathData } from './geometry.js';
import type { VectorAlign, VectorArrange, VectorBooleanOperation, VectorNode, VectorStyle, VectorTool } from './types.js';
import { VECTOR_TOOLS } from './types.js';

export interface VectorCommandOptions {
	/** Id prefix (default `vector.`); use one per editor when several are registered. */
	prefix?: string;
	/** Palette group (default `Vector`). */
	group?: string;
	/** Command scope. Omit for global commands. */
	scope?: string;
}

/** A node as listed for agents. */
export interface VectorNodeListing {
	id: string;
	type: 'path' | 'group';
	name?: string;
	depth: number;
	bounds: { x: number; y: number; width: number; height: number } | null;
	visible: boolean;
	locked: boolean;
	selected: boolean;
	fill?: unknown;
	stroke?: unknown;
	strokeWidth?: number;
	/** SVG path data (paths only). */
	d?: string;
	children?: number;
}

const fail = (message: string): never => {
	throw new Error(message);
};

const IDS = { type: 'array', items: { type: 'string' }, description: 'Node ids (default: the selection).' } as const;

const PAINT = {
	description: 'A CSS colour, `null` for none, or a gradient `{ type: "linear", angle, stops: [{ offset, color }] }`.'
} as const;

const STYLE_PROPS = {
	fill: PAINT,
	stroke: PAINT,
	strokeWidth: { type: 'number', minimum: 0 },
	strokeLinecap: { type: 'string', enum: ['butt', 'round', 'square'] },
	strokeLinejoin: { type: 'string', enum: ['miter', 'round', 'bevel'] },
	strokeDasharray: { type: 'array', items: { type: 'number' } },
	fillRule: { type: 'string', enum: ['nonzero', 'evenodd'] }
} as const;

const pickStyle = (params: Record<string, unknown>): VectorStyle => {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(STYLE_PROPS)) if (params[key] !== undefined) out[key] = params[key];
	return out as VectorStyle;
};

const check = (result: { ok: boolean; message?: string }) => {
	if (!result.ok) fail(result.message ?? 'The command failed.');
};

/**
 * Palette and agent commands for a vector editor: list, select, add shapes and paths, style,
 * transform, align, arrange, group, boolean operations and SVG import / export. Register them
 * in a `CommandRegistry` and agents get them through `createCommandToolProvider`. Failures
 * throw sentences, which the registry returns as `{ ok: false, code: 'failed', message }`.
 */
export function createVectorCommands(controller: VectorEditorController, options: VectorCommandOptions = {}): CommandSpec[] {
	const prefix = options.prefix ?? 'vector.';
	const group = options.group ?? 'Vector';
	const base = { group, ...(options.scope ? { scope: options.scope } : {}) };
	const hasSelection = () => (controller.getState().selection.length ? true : 'Nothing is selected.');
	const ids = (params: { ids?: string[] } | undefined) => {
		const list = params?.ids ?? controller.getState().selection;
		for (const id of list) if (!controller.getNode(id)) fail(`There is no node "${id}".`);
		if (!list.length) fail('Nothing is selected; pass ids.');
		return list;
	};
	const enabledFor = (_: unknown, params: { ids?: string[] } | undefined) => (params?.ids?.length ? true : hasSelection());

	const list = (): { width: number; height: number; nodes: VectorNodeListing[]; selection: readonly string[]; tool: VectorTool } => {
		const state = controller.getState();
		const out: VectorNodeListing[] = [];
		const visit = (nodes: readonly VectorNode[], depth: number) => {
			for (const n of nodes) {
				const b = vectorNodeBounds(n);
				out.push({
					id: n.id,
					type: n.type,
					...(n.name ? { name: n.name } : {}),
					depth,
					bounds: b && { x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100, width: Math.round(b.width * 100) / 100, height: Math.round(b.height * 100) / 100 },
					visible: n.visible !== false,
					locked: !!n.locked,
					selected: state.selection.includes(n.id),
					...(n.type === 'path'
						? { fill: n.fill ?? null, stroke: n.stroke ?? null, strokeWidth: n.strokeWidth ?? 1, d: vectorPathData(n, 2) }
						: { children: n.children.length })
				});
				if (n.type === 'group') visit(n.children, depth + 1);
			}
		};
		visit(state.document.nodes, 0);
		return { width: state.document.width, height: state.document.height, nodes: out, selection: state.selection, tool: state.tool };
	};

	return [
		{
			...base,
			id: `${prefix}list`,
			label: 'List Vector Nodes',
			readOnly: true,
			keywords: ['layers', 'shapes', 'document', 'outline'],
			description: 'Lists every node (paths and groups, depth first) with bounds, style, path data and selection.',
			run: list
		},
		{
			...base,
			id: `${prefix}select`,
			label: 'Select Nodes',
			keywords: ['pick', 'choose'],
			description: 'Selects nodes by id (empty list clears the selection).',
			params: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, add: { type: 'boolean' } }, required: ['ids'] },
			run: (_ctx: unknown, params: { ids: string[]; add?: boolean }) => {
				for (const id of params.ids) if (!controller.getNode(id)) fail(`There is no node "${id}".`);
				if (!params.ids.length && !params.add) controller.clearSelection();
				else controller.select(params.ids, { add: params.add });
				return { selection: controller.getState().selection };
			}
		},
		{
			...base,
			id: `${prefix}addShape`,
			label: 'Add Shape…',
			keywords: ['rectangle', 'ellipse', 'circle', 'polygon', 'star', 'line', 'draw'],
			description: 'Adds a rectangle, ellipse, polygon, star or line in document units, using the current default style unless overridden.',
			params: {
				type: 'object',
				properties: {
					kind: { type: 'string', enum: ['rect', 'ellipse', 'polygon', 'star', 'line'] },
					x: { type: 'number' },
					y: { type: 'number' },
					width: { type: 'number', description: 'For a line: the x offset of its end.' },
					height: { type: 'number', description: 'For a line: the y offset of its end.' },
					cornerRadius: { type: 'number', minimum: 0 },
					sides: { type: 'integer', minimum: 3 },
					points: { type: 'integer', minimum: 3 },
					innerRatio: { type: 'number', minimum: 0, maximum: 1 },
					name: { type: 'string' },
					...STYLE_PROPS
				},
				required: ['kind', 'x', 'y', 'width', 'height']
			},
			undoable: true,
			run: (_ctx: unknown, params: VectorShapeInput) => ({ id: controller.addShape(params) })
		},
		{
			...base,
			id: `${prefix}addPath`,
			label: 'Add Path…',
			keywords: ['svg', 'path data', 'bezier', 'curve'],
			description: 'Adds a path from SVG path data (`d`), in document units.',
			params: { type: 'object', properties: { d: { type: 'string' }, name: { type: 'string' }, ...STYLE_PROPS }, required: ['d'] },
			undoable: true,
			run: (_ctx: unknown, params: { d: string; name?: string } & Record<string, unknown>) => {
				const id = controller.addPath(params.d, { ...pickStyle(params), ...(params.name ? { name: params.name } : {}) });
				const node = controller.getNode(id);
				if (node?.type === 'path' && !node.subpaths.length) {
					controller.undo();
					fail('The path data has no points.');
				}
				return { id };
			}
		},
		{
			...base,
			id: `${prefix}setStyle`,
			label: 'Set Style…',
			keywords: ['fill', 'stroke', 'colour', 'color', 'gradient', 'width'],
			description: 'Sets fill, stroke and stroke settings of nodes (groups apply to every path inside).',
			params: { type: 'object', properties: { ids: IDS, ...STYLE_PROPS } },
			enabled: enabledFor,
			undoable: true,
			run: (_ctx: unknown, params: { ids?: string[] } & Record<string, unknown>) => {
				const style = pickStyle(params);
				if (!Object.keys(style).length) fail('Pass at least one style property.');
				check(controller.setStyle(style, ids(params)));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}transform`,
			label: 'Transform…',
			keywords: ['move', 'translate', 'scale', 'resize', 'rotate', 'flip'],
			description: 'Moves (dx, dy), scales (sx, sy) and/or rotates (degrees clockwise) nodes around their combined centre, in that order.',
			params: {
				type: 'object',
				properties: { ids: IDS, dx: { type: 'number' }, dy: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, rotate: { type: 'number' } }
			},
			enabled: enabledFor,
			undoable: true,
			run: (_ctx: unknown, params: { ids?: string[]; dx?: number; dy?: number; sx?: number; sy?: number; rotate?: number }) => {
				const target = ids(params);
				if (params.dx || params.dy) check(controller.translate(params.dx ?? 0, params.dy ?? 0, { ids: target }));
				if (params.sx !== undefined || params.sy !== undefined) check(controller.scale(params.sx ?? 1, params.sy ?? params.sx ?? 1, { ids: target }));
				if (params.rotate) check(controller.rotate(params.rotate, { ids: target }));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}delete`,
			label: 'Delete',
			keywords: ['remove'],
			description: 'Deletes nodes.',
			params: { type: 'object', properties: { ids: IDS } },
			enabled: enabledFor,
			undoable: true,
			run: (_ctx: unknown, params: { ids?: string[] } | undefined) => {
				check(controller.removeNodes(ids(params)));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}boolean`,
			label: 'Boolean Operation…',
			keywords: ['union', 'unite', 'subtract', 'intersect', 'exclude', 'combine', 'pathfinder'],
			description: 'Combines two or more paths with union, subtract (upper shapes from the lowest), intersect or exclude.',
			params: { type: 'object', properties: { operation: { type: 'string', enum: ['union', 'subtract', 'intersect', 'exclude'] }, ids: IDS }, required: ['operation'] },
			undoable: true,
			run: (_ctx: unknown, params: { operation: VectorBooleanOperation; ids?: string[] }) => {
				const id = controller.booleanOp(params.operation, { ids: ids(params) });
				if (!id) fail('Select at least two overlapping paths (the result was empty).');
				return { id };
			}
		},
		{
			...base,
			id: `${prefix}align`,
			label: 'Align…',
			keywords: ['left', 'right', 'center', 'top', 'bottom', 'middle'],
			description: 'Aligns nodes to their combined bounds, or to the artboard (`to: "artboard"`, or when only one node is given).',
			params: {
				type: 'object',
				properties: { edge: { type: 'string', enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] }, to: { type: 'string', enum: ['selection', 'artboard'] }, ids: IDS },
				required: ['edge']
			},
			undoable: true,
			run: (_ctx: unknown, params: { edge: VectorAlign; to?: 'selection' | 'artboard'; ids?: string[] }) => {
				check(controller.align(params.edge, { ids: ids(params), to: params.to }));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}distribute`,
			label: 'Distribute…',
			keywords: ['space', 'evenly', 'gaps'],
			description: 'Spaces three or more nodes with equal gaps.',
			params: { type: 'object', properties: { direction: { type: 'string', enum: ['horizontal', 'vertical'] }, ids: IDS }, required: ['direction'] },
			undoable: true,
			run: (_ctx: unknown, params: { direction: 'horizontal' | 'vertical'; ids?: string[] }) => {
				check(controller.distribute(params.direction, { ids: ids(params) }));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}arrange`,
			label: 'Arrange…',
			keywords: ['order', 'front', 'back', 'forward', 'backward', 'z-index', 'stack'],
			description: 'Changes stacking order within each node’s parent.',
			params: { type: 'object', properties: { order: { type: 'string', enum: ['front', 'forward', 'backward', 'back'] }, ids: IDS }, required: ['order'] },
			undoable: true,
			run: (_ctx: unknown, params: { order: VectorArrange; ids?: string[] }) => {
				check(controller.arrange(params.order, { ids: ids(params) }));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}group`,
			label: 'Group',
			shortcut: 'Mod+G',
			description: 'Groups nodes that share a parent.',
			params: { type: 'object', properties: { ids: IDS, name: { type: 'string' } } },
			enabled: enabledFor,
			undoable: true,
			run: (_ctx: unknown, params: { ids?: string[]; name?: string } | undefined) => {
				const id = controller.group({ ids: ids(params), name: params?.name });
				if (!id) fail('Only nodes that share a parent can be grouped.');
				return { id };
			}
		},
		{
			...base,
			id: `${prefix}ungroup`,
			label: 'Ungroup',
			shortcut: 'Mod+Shift+G',
			description: 'Replaces groups with their children.',
			params: { type: 'object', properties: { ids: IDS } },
			enabled: enabledFor,
			undoable: true,
			run: (_ctx: unknown, params: { ids?: string[] } | undefined) => {
				check(controller.ungroup({ ids: ids(params) }));
				return { selection: controller.getState().selection };
			}
		},
		{
			...base,
			id: `${prefix}setTool`,
			label: 'Choose Tool…',
			keywords: ['pen', 'pencil', 'select', 'rectangle', 'ellipse'],
			description: 'Switches the canvas tool.',
			params: { type: 'object', properties: { tool: { type: 'string', enum: [...VECTOR_TOOLS] } }, required: ['tool'] },
			run: (_ctx: unknown, params: { tool: VectorTool }) => {
				controller.setTool(params.tool);
				return { tool: params.tool };
			}
		},
		{
			...base,
			id: `${prefix}exportSvg`,
			label: 'Export SVG',
			readOnly: true,
			keywords: ['download', 'save', 'markup'],
			description: 'Returns the document as SVG markup.',
			params: { type: 'object', properties: { precision: { type: 'integer', minimum: 0, maximum: 8 } } },
			run: (_ctx: unknown, params: { precision?: number } | undefined) => ({ svg: controller.toSvg({ precision: params?.precision }) })
		},
		{
			...base,
			id: `${prefix}importSvg`,
			label: 'Import SVG…',
			keywords: ['open', 'load', 'paste', 'markup'],
			description: 'Adds the shapes of SVG markup on top of the document (or replaces it with `replace: true`).',
			params: { type: 'object', properties: { svg: { type: 'string' }, replace: { type: 'boolean' } }, required: ['svg'] },
			undoable: true,
			run: (_ctx: unknown, params: { svg: string; replace?: boolean }) => {
				check(params.replace ? controller.loadSvg(params.svg) : controller.importSvg(params.svg));
				return { nodes: controller.getState().document.nodes.length, selection: controller.getState().selection };
			}
		}
	];
}
