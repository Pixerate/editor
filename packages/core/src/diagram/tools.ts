import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import { diagramShapes, diagramSupportsGroups, type DiagramController } from './controller.js';
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
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const ID = { type: 'string', minLength: 1, description: 'A node id from get_diagram (e.g. "A").' } as const;
const IDS = (what: string) => ({ type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: what }) as const;
const EDGE_ID = { type: 'string', minLength: 1, description: 'An edge id from get_diagram (e.g. "L_A_B_0").' } as const;
const LABEL = (what: string) => ({ type: 'string', description: what }) as const;
const object = (properties: Record<string, JsonSchema>, required: string[] = []) => ({
	type: 'object' as const,
	properties,
	...(required.length ? { required } : {}),
	additionalProperties: false
});

/** What an agent needs to know about a document: ids, labels, shapes, structure. */
export function describeDiagram(doc: MermaidDocument) {
	const { graph } = doc;
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
			...(n.data?.synthetic ? { synthetic: true } : {})
		})),
		edges: graph.edges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			...(e.label ? { label: e.label } : {}),
			pattern: e.pattern,
			arrowEnd: e.arrowEnd
		})),
		groups: graph.groups.map((g) => ({
			id: g.id,
			label: g.label,
			...(g.parentId ? { parentId: g.parentId } : {}),
			...(g.direction ? { direction: g.direction } : {})
		})),
		shapes: diagramShapes(doc.family),
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
	const apply = (ops: EditOp | EditOp[], label: string) => {
		const result = controller.apply(ops, label);
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
			'Returns the diagram: its Mermaid family (flowchart, state, class, er; other families are text only), direction, nodes (id, label, shape, parentId), edges (id, source, target, label), groups (subgraphs / composite states), the shapes nodes can take, stored canvas positions, any parse diagnostics and the selection. Use the ids it returns with the write tools.',
		inputSchema: object({ includeSource: { type: 'boolean', description: 'Also return the Mermaid text (default false).' } }),
		annotations: { title: 'Read the diagram', ...READ },
		handler: ({ includeSource = false }) => {
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
		handler: ({ withLayout = true }) => {
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
			'Replaces the whole diagram with Mermaid text (one undo step). Flowchart, state, class and ER diagrams become editable on the canvas; other families are kept as text. Returns the family, node and edge counts and any parse diagnostics. Prefer the per-operation tools for small changes: they keep the rest of the text as written.',
		inputSchema: object({ source: { type: 'string', minLength: 1, description: 'Mermaid text, starting with a header such as "flowchart LR".' } }, ['source']),
		annotations: { title: 'Replace the diagram with Mermaid', ...DESTRUCTIVE },
		handler: ({ source }) => {
			// A fenced block (```mermaid … ```) is unwrapped; a bare diagram is taken as written.
			const fenced = /^\s*(`{3,}|~{3,})/m.test(source) ? findMermaidSources(source) : [];
			if (fenced.length > 1) throw new Error(`The text holds ${fenced.length} diagrams; pass one (find_mermaid_diagrams lists them).`);
			const text = fenced[0]?.source ?? source;
			if (detectFamily(text) === 'unknown')
				throw new Error('The text has no Mermaid header (e.g. "flowchart LR", "stateDiagram-v2", "classDiagram", "erDiagram"); nothing was changed.');
			const result = controller.load(text);
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
				id: { type: 'string', pattern: '^[A-Za-z0-9_][\\w.-]*$', description: 'Mermaid id (default: the next free "N<number>").' },
				shape: { type: 'string', description: 'One of the shapes get_diagram lists (default "rect"). Flowchart and state diagrams only.' },
				parentId: { type: 'string', description: 'Group (subgraph) to add the node to.' },
				from: { type: 'string', description: 'An existing node to connect to the new node.' },
				edgeLabel: LABEL('Label of the edge from "from" (needs "from").'),
				x: { type: 'number', description: 'Left edge in canvas px (needs y).' },
				y: { type: 'number', description: 'Top edge in canvas px (needs x).' }
			},
			['label']
		),
		annotations: { title: 'Add a node', ...WRITE },
		handler: ({ label, id, shape, parentId, from, edgeLabel, x, y }) => {
			requireEditable();
			if ((x === undefined) !== (y === undefined)) throw new Error('Give both x and y, or neither to place the node automatically.');
			if (edgeLabel !== undefined && from === undefined) throw new Error('edgeLabel needs "from", the node the edge starts at.');
			const nodeId = id ?? controller.nextId();
			const before = edgeIds();
			const ops: EditOp[] = [
				{ type: 'addNode', node: { id: nodeId, label, ...(shape ? { shape } : {}), ...(parentId ? { parentId } : {}) }, ...(x !== undefined ? { position: [x, y] as const } : {}) }
			];
			if (from !== undefined) ops.push({ type: 'addEdge', edge: { source: from, target: nodeId, ...(edgeLabel ? { label: edgeLabel } : {}) } });
			const d = apply(ops, 'Add node');
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
		handler: ({ ids }) => {
			requireEditable();
			const before = doc().graph.edges.map((e) => e.id);
			const d = apply({ type: 'removeNodes', ids }, ids.length === 1 ? 'Delete node' : 'Delete nodes');
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
		handler: ({ id, label }) => {
			requireEditable();
			const isGroup = doc().graph.groups.some((g) => g.id === id);
			const d = apply(isGroup ? { type: 'renameGroup', id, label } : { type: 'renameNode', id, label }, 'Rename');
			return { node: nodeOut(d, id) };
		}
	};

	const setShape: AgentTool = {
		name: 'set_diagram_node_shape',
		title: 'Change a node\'s shape',
		description: 'Changes a node\'s shape (flowchart and state diagrams). Use one of the shapes get_diagram lists. Returns the node.',
		inputSchema: object({ id: ID, shape: { type: 'string', minLength: 1, description: 'Shape name, e.g. "rect", "rounded", "diam", "cyl", "circle".' } }, ['id', 'shape']),
		annotations: { title: 'Change a node\'s shape', ...WRITE_IDEMPOTENT },
		handler: ({ id, shape }) => {
			requireEditable();
			return { node: nodeOut(apply({ type: 'setNodeShape', id, shape }, 'Change shape'), id) };
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
		handler: ({ id, styles }) => {
			requireEditable();
			const d = apply({ type: 'setNodeStyles', id, styles }, 'Style node');
			return { id, styles: d.graph.nodes.find((n) => n.id === id)?.styles ?? [] };
		}
	};

	const connect: AgentTool = {
		name: 'connect_diagram_nodes',
		title: 'Connect two nodes',
		description: 'Draws an edge from one existing node to another, with an optional label. Returns the new edge with its id.',
		inputSchema: object({ source: { ...ID, description: 'Node the edge starts at.' }, target: { ...ID, description: 'Node the edge ends at.' }, label: LABEL('Edge label (optional).') }, ['source', 'target']),
		annotations: { title: 'Connect two nodes', ...WRITE },
		handler: ({ source, target, label }) => {
			requireEditable();
			const before = edgeIds();
			const d = apply({ type: 'addEdge', edge: { source, target, ...(label ? { label } : {}) } }, 'Connect');
			return { edge: newEdges(before, d)[0] ?? null };
		}
	};

	const removeEdges: AgentTool = {
		name: 'remove_diagram_edges',
		title: 'Remove edges',
		description: 'Deletes edges by id; the nodes stay. Returns the removed ids.',
		inputSchema: object({ ids: IDS('Edge ids from get_diagram.') }, ['ids']),
		annotations: { title: 'Remove edges', ...DESTRUCTIVE },
		handler: ({ ids }) => {
			requireEditable();
			apply({ type: 'removeEdges', ids }, ids.length === 1 ? 'Delete edge' : 'Delete edges');
			return { removed: ids };
		}
	};

	const labelEdge: AgentTool = {
		name: 'set_diagram_edge_label',
		title: 'Label an edge',
		description: 'Sets an edge\'s label; an empty string removes it. Returns the edge.',
		inputSchema: object({ id: EDGE_ID, label: LABEL('The new label ("" removes it).') }, ['id', 'label']),
		annotations: { title: 'Label an edge', ...WRITE_IDEMPOTENT },
		handler: ({ id, label }) => {
			requireEditable();
			const d = apply({ type: 'setEdgeLabel', id, label }, 'Label edge');
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
		handler: ({ id, source, target }) => {
			requireEditable();
			const index = doc().graph.edges.findIndex((e) => e.id === id);
			const d = apply({ type: 'reconnectEdge', id, source, target }, 'Reconnect edge');
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
		handler: ({ direction }) => {
			requireEditable();
			return { direction: apply({ type: 'setDirection', direction }, 'Change direction').graph.direction };
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
		handler: ({ nodeIds, label, id }) => {
			requireEditable();
			if (!diagramSupportsGroups(doc().family)) throw new Error(`${doc().family} diagrams have no groups.`);
			const groupId = id ?? controller.nextId('G');
			apply({ type: 'groupNodes', groupId, label, nodeIds }, 'Group');
			return { group: { id: groupId, label, nodeIds } };
		}
	};

	const ungroup: AgentTool = {
		name: 'ungroup_diagram_group',
		title: 'Ungroup',
		description: 'Removes a group and keeps its nodes (they move to the group\'s parent). Returns the ids that were in it.',
		inputSchema: object({ id: { type: 'string', minLength: 1, description: 'A group id from get_diagram.' } }, ['id']),
		annotations: { title: 'Ungroup', ...DESTRUCTIVE },
		handler: ({ id }) => {
			requireEditable();
			const members = [...doc().graph.nodes, ...doc().graph.groups].filter((x) => x.parentId === id).map((x) => x.id);
			apply({ type: 'ungroup', groupId: id }, 'Ungroup');
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
		handler: ({ moves }) => {
			const list = moves as Array<{ id: string; x: number; y: number }>;
			requireEditable();
			apply({ type: 'moveNodes', moves: pinned(list.map((m) => ({ id: m.id, position: [m.x, m.y] as const }))) }, 'Move');
			return { moved: moves };
		}
	};

	const undo: AgentTool = {
		name: 'undo_diagram',
		title: 'Undo a diagram edit',
		description: 'Undoes the last diagram edit. Returns whether something was undone and its label.',
		inputSchema: object({}),
		annotations: { title: 'Undo a diagram edit', ...WRITE },
		handler: () => {
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
		handler: () => {
			const label = controller.getState().redoLabel;
			const redone = controller.redo();
			return { redone, ...(redone ? { label } : {}) };
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
	const writes = [loadMermaid, addNode, removeElements, renameNode, setShape, setStyle, connect, removeEdges, labelEdge, reconnect, setDirection, group, ungroup, move, undo, redo];

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
