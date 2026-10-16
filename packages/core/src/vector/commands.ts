import type { CommandSpec } from '../commands/registry.js';
import type { VectorEditorController, VectorShapeInput } from './controller.js';
import { vectorNodeBounds, vectorNodeRotation, vectorParentMatrix, vectorPathData, IDENTITY_MATRIX } from './geometry.js';
import type { VectorAlign, VectorAnchorRef, VectorArrange, VectorAverageAxis, VectorBooleanOperation, VectorNode, VectorStyle, VectorTool } from './types.js';
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
	/** Axis-aligned bounds in document units. */
	bounds: { x: number; y: number; width: number; height: number } | null;
	/** Rotation in degrees, clockwise (ancestors' rotations included). */
	rotation: number;
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

const ANCHORS = {
	type: 'array',
	items: {
		type: 'object',
		properties: { nodeId: { type: 'string' }, subpath: { type: 'integer', minimum: 0 }, index: { type: 'integer', minimum: 0 } },
		required: ['nodeId', 'subpath', 'index']
	},
	description: 'Anchors as { nodeId, subpath, index } (default: the selected points).'
} as const;

const POINTS = {
	type: 'array',
	items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
	minItems: 1,
	description: 'Polyline [[x, y], …] in document units.'
} as const;

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
	const anchorsOf = (refs: VectorAnchorRef[] | undefined): VectorAnchorRef[] => {
		if (!refs) return [...controller.getState().selectedAnchors];
		for (const r of refs) {
			const node = controller.getNode(r.nodeId);
			if (node?.type !== 'path' || !node.subpaths[r.subpath]?.anchors[r.index]) fail(`There is no anchor ${r.index} on subpath ${r.subpath} of "${r.nodeId}".`);
		}
		return refs;
	};

	const list = (): { width: number; height: number; nodes: VectorNodeListing[]; selection: readonly string[]; tool: VectorTool } => {
		const state = controller.getState();
		const out: VectorNodeListing[] = [];
		const visit = (nodes: readonly VectorNode[], depth: number) => {
			for (const n of nodes) {
				const parent = vectorParentMatrix(state.document.nodes, n.id) ?? IDENTITY_MATRIX;
				const b = vectorNodeBounds(n, parent);
				out.push({
					id: n.id,
					type: n.type,
					...(n.name ? { name: n.name } : {}),
					depth,
					rotation: Math.round(vectorNodeRotation(n, parent) * 100) / 100,
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
			description:
				'Moves (dx, dy), scales (sx, sy, along the selection box axes) and/or rotates (`rotate`: by degrees clockwise around the combined centre; `angle`: to an absolute rotation, each node around its own centre), in that order.',
			params: {
				type: 'object',
				properties: {
					ids: IDS,
					dx: { type: 'number' },
					dy: { type: 'number' },
					sx: { type: 'number' },
					sy: { type: 'number' },
					rotate: { type: 'number' },
					angle: { type: 'number' }
				}
			},
			enabled: enabledFor,
			undoable: true,
			run: (_ctx: unknown, params: { ids?: string[]; dx?: number; dy?: number; sx?: number; sy?: number; rotate?: number; angle?: number }) => {
				const target = ids(params);
				if (params.dx || params.dy) check(controller.translate(params.dx ?? 0, params.dy ?? 0, { ids: target }));
				if (params.sx !== undefined || params.sy !== undefined) check(controller.scale(params.sx ?? 1, params.sy ?? params.sx ?? 1, { ids: target }));
				if (params.rotate) check(controller.rotate(params.rotate, { ids: target }));
				if (params.angle !== undefined) check(controller.setRotation(params.angle, { ids: target }));
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
			id: `${prefix}deleteAnchors`,
			label: 'Delete Points',
			keywords: ['remove', 'anchor', 'point', 'node'],
			description:
				'Deletes anchors. With `keepShape` (default: the editor setting, on) the neighbouring handles are refitted so the outline keeps its shape; off, the neighbours are joined as they are.',
			params: { type: 'object', properties: { anchors: ANCHORS, keepShape: { type: 'boolean' } } },
			undoable: true,
			run: (_ctx: unknown, params: { anchors?: VectorAnchorRef[]; keepShape?: boolean } | undefined) => {
				check(controller.deleteAnchors(anchorsOf(params?.anchors), { keepShape: params?.keepShape }));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}moveAnchor`,
			label: 'Move Point…',
			keywords: ['anchor', 'drag', 'curvature'],
			description: 'Moves one anchor to (x, y) in document units. `curvature: true` bends its two segments like the Curvature tool instead of carrying its handles along.',
			params: {
				type: 'object',
				properties: { nodeId: { type: 'string' }, subpath: { type: 'integer', minimum: 0 }, index: { type: 'integer', minimum: 0 }, x: { type: 'number' }, y: { type: 'number' }, curvature: { type: 'boolean' } },
				required: ['nodeId', 'subpath', 'index', 'x', 'y']
			},
			undoable: true,
			run: (_ctx: unknown, params: VectorAnchorRef & { x: number; y: number; curvature?: boolean }) => {
				check(controller.moveAnchor({ nodeId: params.nodeId, subpath: params.subpath, index: params.index }, { x: params.x, y: params.y }, { curvature: params.curvature }));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}bendSegment`,
			label: 'Bend Segment…',
			keywords: ['curve', 'segment', 'drag'],
			description: 'Bends segment `segment` (from anchor `segment` to the next) so the curve passes through (x, y) at parameter `t` (default 0.5).',
			params: {
				type: 'object',
				properties: {
					nodeId: { type: 'string' },
					subpath: { type: 'integer', minimum: 0 },
					segment: { type: 'integer', minimum: 0 },
					x: { type: 'number' },
					y: { type: 'number' },
					t: { type: 'number', minimum: 0, maximum: 1 }
				},
				required: ['nodeId', 'subpath', 'segment', 'x', 'y']
			},
			undoable: true,
			run: (_ctx: unknown, params: { nodeId: string; subpath: number; segment: number; x: number; y: number; t?: number }) => {
				check(controller.bendSegment({ nodeId: params.nodeId, subpath: params.subpath, segment: params.segment }, { x: params.x, y: params.y }, params.t));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}join`,
			label: 'Join',
			shortcut: 'Mod+J',
			keywords: ['connect', 'close', 'merge', 'endpoints'],
			description: 'Joins the open subpaths of paths nearest endpoints first (ends within `tolerance` merge); a single open path is closed.',
			params: { type: 'object', properties: { ids: IDS, tolerance: { type: 'number', minimum: 0 } } },
			undoable: true,
			run: (_ctx: unknown, params: { ids?: string[]; tolerance?: number } | undefined) => {
				check(controller.joinPaths({ ids: params?.ids ? ids(params) : undefined, tolerance: params?.tolerance }));
				return { selection: controller.getState().selection };
			}
		},
		{
			...base,
			id: `${prefix}average`,
			label: 'Average Points…',
			shortcut: 'Mod+Alt+J',
			keywords: ['align', 'points', 'anchors', 'collapse'],
			description: 'Moves anchors onto their average position: the same y (`horizontal`), the same x (`vertical`) or the same point (`both`, default).',
			params: { type: 'object', properties: { axis: { type: 'string', enum: ['horizontal', 'vertical', 'both'] }, anchors: ANCHORS } },
			undoable: true,
			run: (_ctx: unknown, params: { axis?: VectorAverageAxis; anchors?: VectorAnchorRef[] } | undefined) => {
				check(controller.averageAnchors(params?.axis ?? 'both', anchorsOf(params?.anchors)));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}removeRedundantPoints`,
			label: 'Remove Redundant Points',
			keywords: ['simplify', 'clean up', 'anchors', 'collinear'],
			description: 'Drops anchors that can go without moving the outline more than `tolerance` document units (default 0.5).',
			params: { type: 'object', properties: { ids: IDS, tolerance: { type: 'number', minimum: 0 } } },
			enabled: enabledFor,
			undoable: true,
			run: (_ctx: unknown, params: { ids?: string[]; tolerance?: number } | undefined) => {
				check(controller.removeRedundantPoints({ ids: params?.ids ? ids(params) : undefined, tolerance: params?.tolerance }));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}smooth`,
			label: 'Smooth Path',
			keywords: ['round', 'soften', 'handles', 'curves'],
			description: 'Pulls the handles of paths (or of the selected points) towards smooth tangents by `amount` (0–1, default 1).',
			params: { type: 'object', properties: { ids: IDS, amount: { type: 'number', minimum: 0, maximum: 1 }, anchors: ANCHORS } },
			undoable: true,
			run: (_ctx: unknown, params: { ids?: string[]; amount?: number; anchors?: VectorAnchorRef[] } | undefined) => {
				check(controller.smoothPaths({ ids: params?.ids ? ids(params) : undefined, amount: params?.amount, refs: params?.anchors }));
				return { ok: true };
			}
		},
		{
			...base,
			id: `${prefix}cut`,
			label: 'Cut Path (Scissors)…',
			keywords: ['scissors', 'split', 'open', 'break'],
			description: 'Scissors: cuts path `nodeId` at the outline point nearest (x, y), or cuts at `anchors`. A closed path opens; an open one splits in two.',
			params: { type: 'object', properties: { nodeId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, anchors: ANCHORS } },
			undoable: true,
			run: (_ctx: unknown, params: { nodeId?: string; x?: number; y?: number; anchors?: VectorAnchorRef[] } | undefined) => {
				if (params?.nodeId !== undefined) {
					if (!controller.getNode(params.nodeId)) fail(`There is no node "${params.nodeId}".`);
					if (params.x === undefined || params.y === undefined) fail('Pass x and y with nodeId.');
					const created = controller.cutPathAt(params.nodeId, { x: params.x!, y: params.y! });
					if (!created) fail('Nothing to cut there (the end of an open path, or a locked path).');
					return { ids: created };
				}
				check(controller.cutAtAnchors(anchorsOf(params?.anchors)));
				return { ids: controller.getState().selection };
			}
		},
		{
			...base,
			id: `${prefix}knife`,
			label: 'Knife…',
			keywords: ['slice', 'cut', 'split', 'divide'],
			description: 'Cuts closed paths along a polyline wherever it crosses them edge to edge (no gap between pieces). Cuts `ids`, else the selection, else every path the line crosses.',
			params: { type: 'object', properties: { points: { ...POINTS, minItems: 2 }, ids: IDS }, required: ['points'] },
			undoable: true,
			run: (_ctx: unknown, params: { points: [number, number][]; ids?: string[] }) => {
				const created = controller.knife(params.points.map(([x, y]) => ({ x, y })), { ids: params.ids ? ids(params) : undefined });
				if (!created.length) fail('The knife did not cross any closed path from edge to edge.');
				return { ids: created };
			}
		},
		{
			...base,
			id: `${prefix}erase`,
			label: 'Erase…',
			keywords: ['eraser', 'rub out', 'remove'],
			description:
				'Erases a round stroke of diameter `size` (default: the eraser size setting) along a polyline: filled shapes lose the area, outlines are cut under it. Erases from `ids`, else the selection, else every path it reaches.',
			params: { type: 'object', properties: { points: POINTS, size: { type: 'number', exclusiveMinimum: 0 }, ids: IDS }, required: ['points'] },
			undoable: true,
			run: (_ctx: unknown, params: { points: [number, number][]; size?: number; ids?: string[] }) => {
				const changed = controller.erase(params.points.map(([x, y]) => ({ x, y })), { size: params.size, ids: params.ids ? ids(params) : undefined });
				if (!changed.length) fail('The eraser did not touch any path.');
				return { ids: changed.filter((id) => controller.getNode(id)) };
			}
		},
		{
			...base,
			id: `${prefix}setEditing`,
			label: 'Path Editing Options…',
			keywords: ['settings', 'curvature', 'pencil', 'smoothing', 'lazy mouse', 'shapes', 'eraser'],
			description:
				'Sets how editing behaves: `keepShapeOnDelete`, `curvatureMoves` (anchor drags bend like the Curvature tool), `pencilSmoothing` (lazy mouse, 0–1), `recognizeShapes` (pencil scribbles become lines, rectangles, ellipses, polygons) and `eraserSize`.',
			params: {
				type: 'object',
				properties: {
					keepShapeOnDelete: { type: 'boolean' },
					curvatureMoves: { type: 'boolean' },
					pencilSmoothing: { type: 'number', minimum: 0, maximum: 1 },
					recognizeShapes: { type: 'boolean' },
					eraserSize: { type: 'number', exclusiveMinimum: 0 }
				}
			},
			run: (_ctx: unknown, params: Record<string, unknown> | undefined) => {
				const patch: Record<string, unknown> = {};
				for (const key of ['keepShapeOnDelete', 'curvatureMoves', 'pencilSmoothing', 'recognizeShapes', 'eraserSize']) if (params?.[key] !== undefined) patch[key] = params[key];
				controller.setEditing(patch);
				return { editing: controller.getState().editing };
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
