import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import type { PresenceActorInfo } from '../animation/presence.js';
import { diagramShapes, diagramSupportsGroups, type DiagramController } from './controller.js';
import { checkFieldData, describeFields, familyUI, pickFieldData } from './families/index.js';
import { DIAGRAM_ORDER_AXIS, planDiagramReorder } from './reorder.js';
import { getFamilyLayout } from './layout-registry.js';

/** The family's own layout (families positioned by their data), or null. */
function getFamilyLayoutFor(d: MermaidDocument) {
	const layout = getFamilyLayout(d.family);
	return layout ? layout(d.graph, d.meta, { measure: () => ({ width: 160, height: 56 }) }) : null;
}
import type { DiagramDirector } from './director.js';
import { detectFamily } from './document.js';
import { findMermaidSources } from './source/find.js';
import { DIRECTIONS, type EditOp, type MermaidDocument, type Point } from './types.js';

export interface DiagramToolProviderOptions {
	/** Provider id (unique per registry). Default `diagram`. */
	id?: string;
	/** Always prefix tool names with `<namespace>__`. */
	namespace?: string;
	/**
	 * The diagram cannot be edited: write tools are hidden and `get_diagram` says why. A
	 * string is the reason ("The report is locked"). The controller's own `readOnly` counts too.
	 */
	readOnly?: boolean | string | (() => boolean | string);
	/**
	 * Where the canvas shows each node now (absolute top-left), e.g. `() => canvas.layout.positions`.
	 * When given, a move pins every node that has no stored position yet, so moving one
	 * node of an auto-laid diagram does not shift the others.
	 */
	getPositions?: () => Readonly<Record<string, Point>>;
	/**
	 * Draws the diagram as standalone SVG (e.g. `(o) => mermaidToSvg(controller.getDocument(), o)`
	 * from `@pixerate/editor/canvas`). Enables `render_diagram`.
	 */
	renderSvg?: (options: { maxWidth?: number; maxHeight?: number }) => { svg: string; width: number; height: number };
	/** Turns that SVG into PNG (e.g. `rasterizeSvg`), so `render_diagram` can return an image. */
	rasterize?: (svg: string, size: { width: number; height: number }) => Promise<{ data: string; mimeType: string }> | { data: string; mimeType: string };
	/**
	 * Acts out every write with a visible cursor (see `DiagramDirector`): it moves to the node,
	 * clicks, drags, connects and types, and a whole-diagram load is drawn statement by
	 * statement. Each call is still one undo step. Without it, edits apply at once.
	 */
	director?: DiagramDirector;
	/** Who the cursor belongs to (default `{ id: 'agent', name: 'Agent' }`). */
	actor?: PresenceActorInfo;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const ID = { type: 'string', minLength: 1, description: 'A node id from get_diagram (e.g. "A").' } as const;
const IDS = (what: string) => ({ type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: what }) as const;
const EDGE_ID = { type: 'string', minLength: 1, description: 'An edge id from get_diagram (e.g. "L_A_B_0").' } as const;
const LABEL = (what: string) => ({ type: 'string', description: what }) as const;
/** A field value: string, number, boolean, array (numbers, lines, tags) or null to clear. */
const FIELD_VALUE = { type: ['string', 'number', 'boolean', 'array', 'null'] } as const;
const object = (properties: Record<string, JsonSchema>, required: string[] = []) => ({
	type: 'object' as const,
	properties,
	...(required.length ? { required } : {}),
	additionalProperties: false
});

/** What an agent needs to know about a document: ids, labels, shapes, structure. */
export function describeDiagram(doc: MermaidDocument) {
	const { graph } = doc;
	const ui = familyUI(doc.family);
	const settings = pickFieldData(ui?.diagramFields, graph.data);
	return {
		family: doc.family,
		editable: doc.tier === 'editable',
		direction: graph.direction,
		...(graph.title ? { title: graph.title } : {}),
		nodes: graph.nodes.map((n) => ({
			id: n.id,
			label: n.label,
			shape: n.shape,
			...(n.parentId ? { parentId: n.parentId } : {}),
			...(n.classes.length ? { classes: n.classes } : {}),
			...(n.styles.length ? { styles: n.styles } : {}),
			...(n.data?.synthetic ? { synthetic: true } : {}),
			...(ui?.nodeFields && Object.keys(pickFieldData(ui.nodeFields, n.data)).length ? { data: pickFieldData(ui.nodeFields, n.data) } : {})
		})),
		edges: graph.edges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			...(e.label ? { label: e.label } : {}),
			pattern: e.pattern,
			arrowEnd: e.arrowEnd,
			...(ui?.edgeFields && Object.keys(pickFieldData(ui.edgeFields, e.data)).length ? { data: pickFieldData(ui.edgeFields, e.data) } : {})
		})),
		groups: graph.groups.map((g) => ({
			id: g.id,
			label: g.label,
			...(g.parentId ? { parentId: g.parentId } : {}),
			...(g.direction ? { direction: g.direction } : {})
		})),
		shapes: diagramShapes(doc.family),
		...(Object.keys(settings).length ? { settings } : {}),
		...(ui && (ui.nodeFields?.length || ui.edgeFields?.length || ui.diagramFields?.length)
			? {
					fields: {
						...(ui.nodeFields?.length ? { node: describeFields(ui.nodeFields) } : {}),
						...(ui.edgeFields?.length ? { edge: describeFields(ui.edgeFields) } : {}),
						...(ui.diagramFields?.length ? { diagram: describeFields(ui.diagramFields) } : {})
					}
				}
			: {}),
		positions: Object.fromEntries(Object.entries(doc.meta.layout ?? {}).map(([id, [x, y]]) => [id, { x: Math.round(x), y: Math.round(y) }])),
		...(doc.diagnostics.length ? { diagnostics: doc.diagnostics.map((d) => ({ severity: d.severity, message: d.message, ...(d.line ? { line: d.line } : {}) })) } : {})
	};
}

/**
 * Agent tools for a Mermaid diagram (`DiagramController`), for a `ToolRegistry`: one
 * tool per operation with strict schemas. Reads (`get_diagram`, `export_diagram_mermaid`,
 * `find_mermaid_diagrams`) are always there; writes are hidden while the diagram is
 * read-only. Every write is checked against the current diagram first (unknown ids,
 * taken ids, shapes the family does not have), applies as one undo step, and returns
 * what it created or changed. Untouched Mermaid statements are kept byte for byte.
 */
export function createDiagramToolProvider(controller: DiagramController, options: DiagramToolProviderOptions = {}): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (r) return typeof r === 'string' ? r : 'This diagram is read-only.';
		return controller.getState().readOnly ? 'This diagram is read-only.' : null;
	};
	const doc = () => controller.getDocument();
	const actor = options.actor ?? { id: 'agent', name: 'Agent' };
	const apply = async (ops: EditOp | EditOp[], label: string) => {
		const result = options.director ? await options.director.perform(actor, Array.isArray(ops) ? ops : [ops], label) : controller.apply(ops, label);
		if (!result.ok) throw new Error(result.message);
		return result.document;
	};
	const edgeIds = () => new Set(doc().graph.edges.map((e) => e.id));
	const newEdges = (before: Set<string>, after: MermaidDocument) =>
		after.graph.edges.filter((e) => !before.has(e.id)).map((e) => ({ id: e.id, source: e.source, target: e.target, ...(e.label ? { label: e.label } : {}) }));
	const nodeOut = (d: MermaidDocument, id: string) => {
		const n = d.graph.nodes.find((x) => x.id === id) ?? d.graph.groups.find((x) => x.id === id);
		return n ? { id: n.id, label: n.label, ...('shape' in n ? { shape: n.shape } : {}), ...(n.parentId ? { parentId: n.parentId } : {}) } : { id };
	};
	/** Moves plus the current positions of nodes not stored yet (see `getPositions`). */
	const pinned = (moves: Array<{ id: string; position: Point }>) => {
		const shown = options.getPositions?.();
		if (!shown) return moves;
		const stored = doc().meta.layout ?? {};
		const taken = new Set(moves.map((m) => m.id));
		return [...moves, ...Object.entries(shown).filter(([id]) => !taken.has(id) && !stored[id]).map(([id, position]) => ({ id, position }))];
	};
	const requireEditable = () => {
		if (doc().tier !== 'editable')
			throw new Error(`This ${doc().family} diagram can only be changed as Mermaid text; use load_diagram_mermaid.`);
	};

	const getDiagram: AgentTool = {
		name: 'get_diagram',
		title: 'Read the diagram',
		description:
			'Returns the diagram: its Mermaid family (flowchart, state, class, er, pie, mindmap, quadrant, c4, architecture, sequence, gitGraph, gantt, timeline, journey, xychart, radar; sankey, block, packet, kanban and treemap are text only), direction, title, nodes (id, label, shape, parentId, data), edges (id, source, target, label, data), groups (subgraphs, composite states, sections, boxes…), the shapes nodes can take, diagram settings, the data fields each family offers ("fields": node, edge and diagram field keys with their types), stored canvas positions, any parse diagnostics and the selection. Use the ids and field keys it returns with the write tools.',
		inputSchema: object({ includeSource: { type: 'boolean', description: 'Also return the Mermaid text (default false).' } }),
		annotations: { title: 'Read the diagram', ...READ },
		handler: async ({ includeSource = false }) => {
			const reason = readOnlyReason();
			return {
				...describeDiagram(doc()),
				selection: controller.getState().selection,
				...(includeSource ? { source: doc().source } : {}),
				...(reason ? { readOnly: reason } : {})
			};
		}
	};

	const exportMermaid: AgentTool = {
		name: 'export_diagram_mermaid',
		title: 'Export the diagram as Mermaid',
		description:
			'Returns the diagram as Mermaid text. Canvas positions are kept in a "%% @pixerate {…}" comment that Mermaid ignores; pass withLayout false to leave it out.',
		inputSchema: object({ withLayout: { type: 'boolean', description: 'Keep the %% @pixerate layout comment (default true).' } }),
		annotations: { title: 'Export the diagram as Mermaid', ...READ },
		handler: async ({ withLayout = true }) => {
			const source = doc().source;
			return { family: doc().family, source: withLayout ? source : source.replace(/^[ \t]*%%\s*@(?:pixerate|ursula)\s+\{.*\}[ \t]*(\r?\n|$)/gm, '') };
		}
	};

	const findDiagrams: AgentTool = {
		name: 'find_mermaid_diagrams',
		title: 'Find Mermaid diagrams in text',
		description:
			'Finds the Mermaid diagrams in a piece of text (Markdown with ```mermaid blocks, a chat reply, or a bare diagram) without changing anything. Returns each diagram\'s source, family and title; pass a source to load_diagram_mermaid to open it.',
		inputSchema: object({ text: { type: 'string', description: 'The text to search.' } }, ['text']),
		annotations: { title: 'Find Mermaid diagrams in text', ...READ },
		handler: ({ text }) => ({ diagrams: findMermaidSources(text) })
	};

	const loadMermaid: AgentTool = {
		name: 'load_diagram_mermaid',
		title: 'Replace the diagram with Mermaid',
		description:
			'Replaces the whole diagram with Mermaid text (one undo step). Flowchart, state, class, ER, pie, mindmap, quadrant, C4, architecture, sequence, gitGraph, Gantt, timeline, journey, XY and radar diagrams become editable; sankey, block, packet, kanban and treemap are kept as text. Returns the family, node and edge counts and any parse diagnostics. Prefer the per-operation tools for small changes: they keep the rest of the text as written.',
		inputSchema: object({ source: { type: 'string', minLength: 1, description: 'Mermaid text, starting with a header such as "flowchart LR".' } }, ['source']),
		annotations: { title: 'Replace the diagram with Mermaid', ...DESTRUCTIVE },
		handler: async ({ source }) => {
			// A fenced block (```mermaid … ```) is unwrapped; a bare diagram is taken as written.
			const fenced = /^\s*(`{3,}|~{3,})/m.test(source) ? findMermaidSources(source) : [];
			if (fenced.length > 1) throw new Error(`The text holds ${fenced.length} diagrams; pass one (find_mermaid_diagrams lists them).`);
			const text = fenced[0]?.source ?? source;
			if (detectFamily(text) === 'unknown')
				throw new Error('The text has no Mermaid header (e.g. "flowchart LR", "stateDiagram-v2", "classDiagram", "erDiagram"); nothing was changed.');
			const result = options.director ? await options.director.playSource(actor, text) : controller.load(text);
			if (!result.ok) throw new Error(result.message);
			const d = result.document;
			return {
				family: d.family,
				editable: d.tier === 'editable',
				nodes: d.graph.nodes.length,
				edges: d.graph.edges.length,
				groups: d.graph.groups.length,
				...(d.diagnostics.length ? { diagnostics: d.diagnostics.map((x) => x.message) } : {})
			};
		}
	};

	const addNode: AgentTool = {
		name: 'add_diagram_node',
		title: 'Add a node',
		description:
			'Adds a node to the diagram, optionally inside a group and connected from an existing node. Without a position the canvas places it beside its neighbours. Returns the node and any edge created.',
		inputSchema: object(
			{
				label: LABEL('Text shown in the node.'),
				id: { type: 'string', pattern: '^[A-Za-z0-9_][\\w.-]*$', description: 'Mermaid id (default: the next free id for the family, e.g. "n3", "slice4", "task2").' },
				shape: { type: 'string', description: 'One of the shapes get_diagram lists (default: the family\'s usual node, e.g. "rect").' },
				data: { type: 'object', additionalProperties: FIELD_VALUE, description: 'Values for the family\'s node fields (get_diagram "fields.node"), e.g. {"value": 40} for a pie slice. Defaults fill in the rest.' },
				parentId: { type: 'string', description: 'Group (subgraph) to add the node to.' },
				from: { type: 'string', description: 'An existing node to connect to the new node.' },
				edgeLabel: LABEL('Label of the edge from "from" (needs "from").'),
				x: { type: 'number', description: 'Left edge in canvas px (needs y).' },
				y: { type: 'number', description: 'Top edge in canvas px (needs x).' }
			},
			['label']
		),
		annotations: { title: 'Add a node', ...WRITE },
		handler: async ({ label, id, shape, parentId, from, edgeLabel, x, y, data }) => {
			requireEditable();
			if ((x === undefined) !== (y === undefined)) throw new Error('Give both x and y, or neither to place the node automatically.');
			if (edgeLabel !== undefined && from === undefined) throw new Error('edgeLabel needs "from", the node the edge starts at.');
			const ui = familyUI(doc().family);
			const nodeId = id ?? (ui && !['flowchart', 'state', 'class', 'er'].includes(ui.family) ? ui.nextId(doc().graph) : controller.nextId());
			const defaults = ui?.newNode?.(doc().graph, parentId) ?? {};
			const nodeShape = shape ?? defaults.shape;
			const nodeData = { ...(defaults.data ?? {}), ...(data ? checkFieldData(ui?.nodeFields, data, `a ${doc().family} node`, nodeShape) : {}) };
			const before = edgeIds();
			const ops: EditOp[] = [
				{
					type: 'addNode',
					node: { ...defaults, id: nodeId, label, ...(nodeShape ? { shape: nodeShape } : {}), ...(parentId ? { parentId } : {}), ...(Object.keys(nodeData).length ? { data: nodeData } : {}) },
					...(x !== undefined ? { position: [x, y] as const } : {})
				}
			];
			if (from !== undefined) ops.push({ type: 'addEdge', edge: { source: from, target: nodeId, ...(edgeLabel ? { label: edgeLabel } : {}) } });
			const d = await apply(ops, 'Add node');
			const edges = newEdges(before, d);
			return { node: nodeOut(d, nodeId), ...(edges.length ? { edge: edges[0] } : {}) };
		}
	};

	const removeElements: AgentTool = {
		name: 'remove_diagram_nodes',
		title: 'Remove nodes or groups',
		description:
			'Deletes nodes with every edge that touches them. A group id removes the group but keeps its contents. Returns the removed ids and the ids of the edges that went with them.',
		inputSchema: object({ ids: IDS('Node or group ids from get_diagram.') }, ['ids']),
		annotations: { title: 'Remove nodes or groups', ...DESTRUCTIVE },
		handler: async ({ ids }) => {
			requireEditable();
			const before = doc().graph.edges.map((e) => e.id);
			const d = await apply({ type: 'removeNodes', ids }, ids.length === 1 ? 'Delete node' : 'Delete nodes');
			const after = new Set(d.graph.edges.map((e) => e.id));
			return { removed: ids, removedEdges: before.filter((id) => !after.has(id)) };
		}
	};

	const renameNode: AgentTool = {
		name: 'rename_diagram_node',
		title: 'Rename a node or group',
		description: 'Changes the label of a node or group. Returns the node with its new label.',
		inputSchema: object({ id: { ...ID, description: 'A node or group id from get_diagram.' }, label: LABEL('The new label.') }, ['id', 'label']),
		annotations: { title: 'Rename a node or group', ...WRITE_IDEMPOTENT },
		handler: async ({ id, label }) => {
			requireEditable();
			const isGroup = doc().graph.groups.some((g) => g.id === id);
			const d = await apply(isGroup ? { type: 'renameGroup', id, label } : { type: 'renameNode', id, label }, 'Rename');
			return { node: nodeOut(d, id) };
		}
	};

	const setShape: AgentTool = {
		name: 'set_diagram_node_shape',
		title: 'Change a node\'s shape',
		description: 'Changes a node\'s shape (flowchart and state diagrams). Use one of the shapes get_diagram lists. Returns the node.',
		inputSchema: object({ id: ID, shape: { type: 'string', minLength: 1, description: 'Shape name, e.g. "rect", "rounded", "diam", "cyl", "circle".' } }, ['id', 'shape']),
		annotations: { title: 'Change a node\'s shape', ...WRITE_IDEMPOTENT },
		handler: async ({ id, shape }) => {
			requireEditable();
			return { node: nodeOut(await apply({ type: 'setNodeShape', id, shape }, 'Change shape'), id) };
		}
	};

	const setStyle: AgentTool = {
		name: 'set_diagram_node_style',
		title: 'Style a node',
		description:
			'Replaces a node\'s inline Mermaid styles (written as a `style` statement), e.g. ["fill:#fde68a", "stroke:#b45309", "stroke-width:2px"]. An empty list removes them. Returns the node with its styles.',
		inputSchema: object(
			{ id: ID, styles: { type: 'array', items: { type: 'string', pattern: '^[\\w-]+:[^,;]+$' }, description: 'CSS-like "property:value" pairs.' } },
			['id', 'styles']
		),
		annotations: { title: 'Style a node', ...WRITE_IDEMPOTENT },
		handler: async ({ id, styles }) => {
			requireEditable();
			const d = await apply({ type: 'setNodeStyles', id, styles }, 'Style node');
			return { id, styles: d.graph.nodes.find((n) => n.id === id)?.styles ?? [] };
		}
	};

	const connect: AgentTool = {
		name: 'connect_diagram_nodes',
		title: 'Connect two nodes',
		description: 'Draws an edge from one existing node to another, with an optional label. Returns the new edge with its id.',
		inputSchema: object({ source: { ...ID, description: 'Node the edge starts at.' }, target: { ...ID, description: 'Node the edge ends at.' }, label: LABEL('Edge label (optional).') }, ['source', 'target']),
		annotations: { title: 'Connect two nodes', ...WRITE },
		handler: async ({ source, target, label }) => {
			requireEditable();
			const before = edgeIds();
			const d = await apply({ type: 'addEdge', edge: { source, target, ...(label ? { label } : {}) } }, 'Connect');
			return { edge: newEdges(before, d)[0] ?? null };
		}
	};

	const removeEdges: AgentTool = {
		name: 'remove_diagram_edges',
		title: 'Remove edges',
		description: 'Deletes edges by id; the nodes stay. Returns the removed ids.',
		inputSchema: object({ ids: IDS('Edge ids from get_diagram.') }, ['ids']),
		annotations: { title: 'Remove edges', ...DESTRUCTIVE },
		handler: async ({ ids }) => {
			requireEditable();
			await apply({ type: 'removeEdges', ids }, ids.length === 1 ? 'Delete edge' : 'Delete edges');
			return { removed: ids };
		}
	};

	const labelEdge: AgentTool = {
		name: 'set_diagram_edge_label',
		title: 'Label an edge',
		description: 'Sets an edge\'s label; an empty string removes it. Returns the edge.',
		inputSchema: object({ id: EDGE_ID, label: LABEL('The new label ("" removes it).') }, ['id', 'label']),
		annotations: { title: 'Label an edge', ...WRITE_IDEMPOTENT },
		handler: async ({ id, label }) => {
			requireEditable();
			const d = await apply({ type: 'setEdgeLabel', id, label }, 'Label edge');
			const e = d.graph.edges.find((x) => x.id === id);
			return { edge: e ? { id: e.id, source: e.source, target: e.target, label: e.label ?? '' } : { id, label } };
		}
	};

	const reconnect: AgentTool = {
		name: 'reconnect_diagram_edge',
		title: 'Reconnect an edge',
		description: 'Moves an edge to new endpoints, keeping its label and style. Returns the edge (its id may change with its endpoints).',
		inputSchema: object({ id: EDGE_ID, source: { ...ID, description: 'New start node.' }, target: { ...ID, description: 'New end node.' } }, ['id', 'source', 'target']),
		annotations: { title: 'Reconnect an edge', ...WRITE },
		handler: async ({ id, source, target }) => {
			requireEditable();
			const index = doc().graph.edges.findIndex((e) => e.id === id);
			const d = await apply({ type: 'reconnectEdge', id, source, target }, 'Reconnect edge');
			const e = d.graph.edges.find((x) => x.id === id) ?? d.graph.edges.find((x, i) => i === index && x.source === source && x.target === target) ?? d.graph.edges.find((x) => x.source === source && x.target === target);
			return { edge: e ? { id: e.id, source: e.source, target: e.target, ...(e.label ? { label: e.label } : {}) } : null };
		}
	};

	const setDirection: AgentTool = {
		name: 'set_diagram_direction',
		title: 'Set the layout direction',
		description: 'Sets the direction the diagram flows in: TB / TD (top to bottom), BT, LR (left to right) or RL. Returns the direction.',
		inputSchema: object({ direction: { type: 'string', enum: [...DIRECTIONS], description: 'TB, TD, BT, LR or RL.' } }, ['direction']),
		annotations: { title: 'Set the layout direction', ...WRITE_IDEMPOTENT },
		handler: async ({ direction }) => {
			requireEditable();
			return { direction: (await apply({ type: 'setDirection', direction }, 'Change direction')).graph.direction };
		}
	};

	const group: AgentTool = {
		name: 'group_diagram_nodes',
		title: 'Group nodes',
		description: 'Puts nodes into a new group (a flowchart subgraph, composite state or class namespace). Returns the group id.',
		inputSchema: object(
			{
				nodeIds: IDS('Node ids to put in the group.'),
				label: LABEL('Group title.'),
				id: { type: 'string', pattern: '^[A-Za-z0-9_][\\w.-]*$', description: 'Group id (default: the next free "G<number>").' }
			},
			['nodeIds', 'label']
		),
		annotations: { title: 'Group nodes', ...WRITE },
		handler: async ({ nodeIds, label, id }) => {
			requireEditable();
			if (!diagramSupportsGroups(doc().family)) throw new Error(`${doc().family} diagrams have no groups.`);
			const groupId = id ?? controller.nextId('G');
			await apply({ type: 'groupNodes', groupId, label, nodeIds }, 'Group');
			return { group: { id: groupId, label, nodeIds } };
		}
	};

	const ungroup: AgentTool = {
		name: 'ungroup_diagram_group',
		title: 'Ungroup',
		description: 'Removes a group and keeps its nodes (they move to the group\'s parent). Returns the ids that were in it.',
		inputSchema: object({ id: { type: 'string', minLength: 1, description: 'A group id from get_diagram.' } }, ['id']),
		annotations: { title: 'Ungroup', ...DESTRUCTIVE },
		handler: async ({ id }) => {
			requireEditable();
			const members = [...doc().graph.nodes, ...doc().graph.groups].filter((x) => x.parentId === id).map((x) => x.id);
			await apply({ type: 'ungroup', groupId: id }, 'Ungroup');
			return { ungrouped: id, members };
		}
	};

	const move: AgentTool = {
		name: 'move_diagram_nodes',
		title: 'Move nodes',
		description:
			'Moves nodes or groups on the canvas to absolute positions (top-left, canvas px). Positions are stored in the %% @pixerate comment; the Mermaid statements do not change. Returns the new positions.',
		inputSchema: object(
			{
				moves: {
					type: 'array',
					minItems: 1,
					description: 'One entry per node.',
					items: object({ id: { ...ID, description: 'Node or group id.' }, x: { type: 'number', description: 'Left edge in px.' }, y: { type: 'number', description: 'Top edge in px.' } }, ['id', 'x', 'y'])
				}
			},
			['moves']
		),
		annotations: { title: 'Move nodes', ...WRITE_IDEMPOTENT },
		handler: async ({ moves }) => {
			const list = moves as Array<{ id: string; x: number; y: number }>;
			requireEditable();
			await apply({ type: 'moveNodes', moves: pinned(list.map((m) => ({ id: m.id, position: [m.x, m.y] as const }))) }, 'Move');
			return { moved: moves };
		}
	};

	const undo: AgentTool = {
		name: 'undo_diagram',
		title: 'Undo a diagram edit',
		description: 'Undoes the last diagram edit. Returns whether something was undone and its label.',
		inputSchema: object({}),
		annotations: { title: 'Undo a diagram edit', ...WRITE },
		handler: async () => {
			const label = controller.getState().undoLabel;
			const undone = controller.undo();
			return { undone, ...(undone ? { label } : {}) };
		}
	};

	const redo: AgentTool = {
		name: 'redo_diagram',
		title: 'Redo a diagram edit',
		description: 'Redoes the last undone diagram edit. Returns whether something was redone and its label.',
		inputSchema: object({}),
		annotations: { title: 'Redo a diagram edit', ...WRITE },
		handler: async () => {
			const label = controller.getState().redoLabel;
			const redone = controller.redo();
			return { redone, ...(redone ? { label } : {}) };
		}
	};

	const fieldsOf = (kind: 'node' | 'edge' | 'diagram') => {
		const ui = familyUI(doc().family);
		return kind === 'node' ? ui?.nodeFields : kind === 'edge' ? ui?.edgeFields : ui?.diagramFields;
	};

	const setNodeData: AgentTool = {
		name: 'set_diagram_node_data',
		title: 'Set a node\'s data fields',
		description:
			'Sets values of a node\'s data fields: a pie slice\'s value, a Gantt task\'s start and end, a quadrant point\'s x and y, a journey task\'s score, an XY series\' values, a C4 element\'s technology… Field keys and types are listed in get_diagram "fields.node"; null clears a field. Returns the node with its data.',
		inputSchema: object(
			{
				id: ID,
				data: { type: 'object', additionalProperties: FIELD_VALUE, description: 'Field key → value, e.g. {"value": 40} or {"x": 0.3, "y": 0.8}. null clears the field.' }
			},
			['id', 'data']
		),
		annotations: { title: 'Set a node\'s data fields', ...WRITE_IDEMPOTENT },
		handler: async ({ id, data }) => {
			requireEditable();
			const node = doc().graph.nodes.find((n) => n.id === id);
			if (!node) throw new Error(`There is no node "${id}"; call get_diagram for the node ids.`);
			const patch = checkFieldData(fieldsOf('node'), data, `a ${doc().family} node`, node.shape);
			const d = await apply({ type: 'setNodeData', id, data: patch }, 'Edit data');
			const after = d.graph.nodes.find((n) => n.id === id);
			return { node: { ...nodeOut(d, id), data: pickFieldData(fieldsOf('node'), after?.data) } };
		}
	};

	const setEdgeData: AgentTool = {
		name: 'set_diagram_edge_data',
		title: 'Set an edge\'s data fields',
		description:
			'Sets values of an edge\'s data fields: a sequence message\'s activation, a C4 relation\'s technology, an architecture edge\'s sides… Field keys and types are listed in get_diagram "fields.edge"; null clears a field. Returns the edge with its data.',
		inputSchema: object(
			{
				id: EDGE_ID,
				data: { type: 'object', additionalProperties: FIELD_VALUE, description: 'Field key → value. null clears the field.' }
			},
			['id', 'data']
		),
		annotations: { title: 'Set an edge\'s data fields', ...WRITE_IDEMPOTENT },
		handler: async ({ id, data }) => {
			requireEditable();
			if (!doc().graph.edges.some((e) => e.id === id)) throw new Error(`There is no edge "${id}"; call get_diagram for the edge ids.`);
			const patch = checkFieldData(fieldsOf('edge'), data, `a ${doc().family} edge`);
			const d = await apply({ type: 'setEdgeData', id, data: patch }, 'Edit data');
			const edge = d.graph.edges.find((e) => e.id === id);
			return { edge: { id, ...(edge ? { source: edge.source, target: edge.target } : {}), data: pickFieldData(fieldsOf('edge'), edge?.data) } };
		}
	};

	const setSettings: AgentTool = {
		name: 'set_diagram_settings',
		title: 'Change diagram settings',
		description:
			'Sets diagram-level fields: a pie chart\'s showData, a Gantt chart\'s dateFormat and excludes, a quadrant chart\'s axis labels, an XY chart\'s categories and axis range, sequence autonumbering… Field keys and types are listed in get_diagram "fields.diagram"; null clears a field. Returns all settings.',
		inputSchema: object(
			{ data: { type: 'object', additionalProperties: FIELD_VALUE, description: 'Field key → value. null clears the field.' } },
			['data']
		),
		annotations: { title: 'Change diagram settings', ...WRITE_IDEMPOTENT },
		handler: async ({ data }) => {
			requireEditable();
			const patch = checkFieldData(fieldsOf('diagram'), data, `a ${doc().family} diagram`);
			const d = await apply({ type: 'setGraphData', data: patch }, 'Edit settings');
			return { settings: pickFieldData(fieldsOf('diagram'), d.graph.data) };
		}
	};

	const setTitle: AgentTool = {
		name: 'set_diagram_title',
		title: 'Set the diagram title',
		description: 'Sets the title shown above the diagram (a title statement, or frontmatter for families without one), or removes it with null. Returns the title.',
		inputSchema: object({ title: { type: ['string', 'null'], description: 'The new title, or null to remove it.' } }, ['title']),
		annotations: { title: 'Set the diagram title', ...WRITE_IDEMPOTENT },
		handler: async ({ title }) => {
			requireEditable();
			const d = await apply({ type: 'setTitle', title: title === null || title === '' ? undefined : title }, 'Set title');
			return { title: d.graph.title ?? null };
		}
	};

	const orderOf = (d: MermaidDocument) => {
		const axis = DIAGRAM_ORDER_AXIS[d.family];
		if (!axis) return d.graph.nodes.map((n) => n.id);
		const k = axis === 'x' ? 0 : 1;
		const layout = getFamilyLayoutFor(d);
		return d.graph.nodes.filter((n) => layout?.positions[n.id]).sort((a, b) => layout!.positions[a.id]![k] - layout!.positions[b.id]![k]).map((n) => n.id);
	};

	const reorderNode: AgentTool = {
		name: 'reorder_diagram_node',
		title: 'Move a node earlier or later',
		description:
			'Moves a sequence participant, journey task, timeline period or Gantt task to just before another node, or to the end (before: null). Placing it next to a node in another section or box moves it there. Same as dragging it sideways (up or down for Gantt). Returns the new order of node ids and the node\'s parent.',
		inputSchema: object(
			{
				id: ID,
				before: { type: ['string', 'null'], description: 'The node id to place it in front of, or null to move it to the end.' }
			},
			['id', 'before']
		),
		annotations: { title: 'Move a node earlier or later', ...WRITE_IDEMPOTENT },
		handler: async ({ id, before }) => {
			requireEditable();
			const ops = planDiagramReorder(doc(), id, before);
			const d = ops.length ? await apply(ops, 'Reorder') : doc();
			const node = d.graph.nodes.find((n) => n.id === id);
			return { order: orderOf(d), ...(node?.parentId ? { parentId: node.parentId } : {}) };
		}
	};

	const setParent: AgentTool = {
		name: 'set_diagram_node_parent',
		title: 'Move nodes into or out of a group',
		description:
			'Moves existing nodes into an existing group (a subgraph, composite state, namespace, C4 boundary, architecture group, sequence box or section), or out of every group with parentId null. Same as dropping them into or out of the group on the canvas. Use group_diagram_nodes to create a new group. Returns the nodes with their parents.',
		inputSchema: object(
			{
				ids: IDS('Node ids from get_diagram.'),
				parentId: { type: ['string', 'null'], description: 'A group id from get_diagram, or null to take the nodes out of their groups.' }
			},
			['ids', 'parentId']
		),
		annotations: { title: 'Move nodes into or out of a group', ...WRITE_IDEMPOTENT },
		handler: async ({ ids, parentId }) => {
			requireEditable();
			if (!diagramSupportsGroups(doc().family)) throw new Error(`${doc().family} diagrams have no groups.`);
			const d = await apply({ type: 'setNodeParent', ids, parentId: parentId ?? undefined }, parentId ? 'Move into group' : 'Move out of group');
			return { nodes: ids.map((id: string) => nodeOut(d, id)) };
		}
	};

	const renderDiagram: AgentTool = {
		name: 'render_diagram',
		title: 'Render the diagram',
		description:
			'Draws the diagram without changing it, to check it visually: standalone SVG text by default, or a PNG image (format "png") when the host can rasterize. Positions match the canvas.',
		inputSchema: object({
			format: { type: 'string', enum: ['svg', 'png'], description: 'svg (default) or png (only when the host supports it).' },
			maxWidth: { type: 'number', minimum: 16, description: 'Fit within this width in px (default: natural size).' },
			maxHeight: { type: 'number', minimum: 16, description: 'Fit within this height in px (default: natural size).' }
		}),
		annotations: { title: 'Render the diagram', ...READ },
		handler: async ({ format = 'svg', maxWidth, maxHeight }) => {
			if (doc().tier !== 'editable') throw new Error(`A ${doc().family} diagram is kept as Mermaid text and cannot be drawn here; use export_diagram_mermaid.`);
			const drawn = options.renderSvg!({ maxWidth, maxHeight });
			if (format === 'png') {
				if (!options.rasterize) throw new Error('This host cannot make PNG images; call render_diagram with format "svg".');
				const image = await options.rasterize(drawn.svg, { width: drawn.width, height: drawn.height });
				return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
			}
			return { format: 'svg', width: drawn.width, height: drawn.height, svg: drawn.svg };
		}
	};

	const reads = [getDiagram, exportMermaid, findDiagrams, ...(options.renderSvg ? [renderDiagram] : [])];
	const writes = [loadMermaid, addNode, removeElements, renameNode, setShape, setStyle, setNodeData, connect, removeEdges, labelEdge, setEdgeData, reconnect, setDirection, setTitle, setSettings, group, ungroup, setParent, reorderNode, move, undo, redo];

	return {
		id: options.id ?? 'diagram',
		namespace: options.namespace,
		tools: () => (readOnlyReason() ? reads : [...reads, ...writes]),
		subscribe: (notify) => {
			let last = readOnlyReason();
			return controller.subscribe(() => {
				const now = readOnlyReason();
				if (now !== last) {
					last = now;
					notify();
				}
			});
		}
	};
}
