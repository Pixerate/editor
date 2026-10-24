import {
	DiagramController,
	createDiagramEditorDocument,
	type DiagramActionResult,
	type DiagramControllerOptions,
	type DiagramState,
	type EditOp,
	type DiagramEditorDocument,
	type MermaidDocument
} from '@pixerate/editor/diagram';
import type { EditorDocument } from '@pixerate/editor/persistence';
import {
	CSS_VARIABLE_DIAGRAM_SCENE_THEME,
	DiagramStream,
	blendDiagramLayout,
	diagramRenameOp,
	familySceneFromLayout,
	easeDiagramTween,
	mermaidMovesFromCanvas,
	mermaidToCanvas,
	type DiagramLayout,
	type DiagramLayoutOptions,
	type DiagramScene,
	type DiagramSceneTheme,
	type MermaidFlowEdge,
	type MermaidFlowNode
} from '@pixerate/editor/canvas';

export interface CreateMermaidDiagramOptions extends DiagramControllerOptions {
	/** Layout spacing and node measuring for new nodes (stored positions always win). */
	layoutOptions?: DiagramLayoutOptions;
	/** Colours for families drawn as scenes (default: the page's CSS colour variables). */
	sceneTheme?: Partial<DiagramSceneTheme>;
}

type Placed = { id: string; position: { x: number; y: number }; parentId?: string };

export interface SvelteMermaidDiagram {
	readonly controller: DiagramController;
	/**
	 * The save / load / undo contract for this diagram: pass it to `createEditorAutosave`
	 * (`@pixerate/editor-svelte/persistence`) or `createDocumentToolProvider`.
	 */
	readonly editorDocument: EditorDocument<DiagramEditorDocument>;
	/** The controller's state (reactive). */
	readonly state: DiagramState;
	readonly document: MermaidDocument;
	/** The Mermaid text (with the `%% @pixerate` layout comment). */
	readonly source: string;
	/** Canvas nodes (groups first, children relative to their group) and edges (reactive). */
	readonly nodes: MermaidFlowNode[];
	readonly edges: MermaidFlowEdge[];
	readonly layout: DiagramLayout;
	/**
	 * The family's own picture (pie, Gantt, sequence, XY, radar…) with the selection marked;
	 * null for families drawn as nodes and edges (flowchart, state, class, ER) and text-only
	 * ones. Render it with `MermaidFamilyScene` (reactive).
	 */
	readonly scene: DiagramScene | null;
	apply(ops: EditOp | EditOp[], label?: string): DiagramActionResult;
	/** Replaces the source; `clearHistory` when opening a different diagram. */
	load(source: string, options?: { clearHistory?: boolean }): DiagramActionResult;
	/** Stores where dragged nodes ended up (pass every canvas node as `all` so groups carry their contents). */
	moveNodes(moved: readonly Placed[], all?: readonly Placed[]): DiagramActionResult | null;
	connect(source: string, target: string, label?: string): DiagramActionResult;
	/** Removes nodes / groups (with their edges) and edges by id, as one undo step. */
	remove(ids: readonly string[]): DiagramActionResult;
	rename(id: string, label: string): DiagramActionResult;
	/** Renames what a scene mark targets: the title (`::title`), a group, an edge or a node. */
	renameTarget(target: string, label: string): DiagramActionResult | null;
	select(ids: readonly string[]): void;
	undo(): void;
	redo(): void;
	/** Stops listening to the controller. */
	destroy(): void;
}

/**
 * Svelte 5 rune: a Mermaid diagram on a Svelte Flow canvas. Subscribes to a
 * `DiagramController` (or creates one from options), lays it out and exposes canvas
 * nodes and edges reactively with bound edits. Parity with React's `useMermaidDiagram`.
 */
export function createMermaidDiagram(
	controllerOrOptions: DiagramController | CreateMermaidDiagramOptions = {},
	/** Layout and scene colours when passing a controller (options carry them otherwise). */
	view: Pick<CreateMermaidDiagramOptions, 'layoutOptions' | 'sceneTheme'> = {}
): SvelteMermaidDiagram {
	const controller = controllerOrOptions instanceof DiagramController ? controllerOrOptions : new DiagramController(controllerOrOptions);
	const layoutOptions = (controllerOrOptions instanceof DiagramController ? undefined : controllerOrOptions.layoutOptions) ?? view.layoutOptions;
	const sceneTheme = (controllerOrOptions instanceof DiagramController ? undefined : controllerOrOptions.sceneTheme) ?? view.sceneTheme;
	let state = $state.raw(controller.getState());
	const canvas = $derived(mermaidToCanvas(state.document, { ...layoutOptions, editable: state.editable }));
	const scene = $derived(
		state.document.tier === 'editable'
			? familySceneFromLayout(state.document.family, state.document.graph, canvas.layout, { theme: { ...CSS_VARIABLE_DIAGRAM_SCENE_THEME, ...sceneTheme }, selection: state.selection })
			: null
	);
	const unsubscribe = controller.subscribe((next) => {
		state = next;
	});
	const editorDocument = createDiagramEditorDocument(controller);
	return {
		controller,
		editorDocument,
		get state() {
			return state;
		},
		get document() {
			return state.document;
		},
		get source() {
			return state.source;
		},
		get nodes() {
			return canvas.nodes;
		},
		get edges() {
			return canvas.edges;
		},
		get layout() {
			return canvas.layout;
		},
		get scene() {
			return scene;
		},
		apply: (ops, label) => controller.apply(ops, label),
		load: (source, options) => controller.load(source, options),
		moveNodes: (moved, all = moved) => {
			const op = mermaidMovesFromCanvas(canvas.layout, moved, all, { stored: controller.getDocument().meta.layout ?? {} });
			return op ? controller.apply(op, 'Move') : null;
		},
		connect: (source, target, label) => controller.apply({ type: 'addEdge', edge: { source, target, ...(label ? { label } : {}) } }, 'Connect'),
		remove: (ids) => {
			const edgeIds = new Set(controller.getDocument().graph.edges.map((e) => e.id));
			const edges = ids.filter((id) => edgeIds.has(id));
			const nodes = ids.filter((id) => !edgeIds.has(id));
			const ops: EditOp[] = [];
			if (edges.length) ops.push({ type: 'removeEdges', ids: edges });
			if (nodes.length) ops.push({ type: 'removeNodes', ids: nodes });
			return controller.apply(ops, 'Delete');
		},
		rename: (id, label) =>
			controller.apply(
				controller.getDocument().graph.groups.some((g) => g.id === id) ? { type: 'renameGroup', id, label } : { type: 'renameNode', id, label },
				'Rename'
			),
		renameTarget: (target, label) => {
			const op = diagramRenameOp(controller.getDocument(), target, label);
			return op ? controller.apply(op, 'Rename') : null;
		},
		select: (ids) => controller.select(ids),
		undo: () => void controller.undo(),
		redo: () => void controller.redo(),
		destroy: () => {
			unsubscribe();
			editorDocument.destroy();
		}
	};
}

export interface CreateMermaidStreamOptions extends DiagramLayoutOptions {
	/** Glide duration between layouts in ms (default 300; 0 jumps). */
	duration?: number;
}

export interface SvelteMermaidStream {
	readonly document: MermaidDocument | null;
	readonly nodes: MermaidFlowNode[];
	readonly edges: MermaidFlowEdge[];
	/** The layout being shown (mid-glide while `settled` is false). */
	readonly layout: DiagramLayout | null;
	readonly settled: boolean;
	/** Feeds the source so far; `complete` once nothing more will arrive. */
	update(source: string, complete?: boolean): void;
	/** Starts over for a new source. */
	reset(): void;
	destroy(): void;
}

/**
 * Svelte 5 rune: draws Mermaid that is still being written (e.g. a model's reply). Nodes
 * appear once an edge places them and glide to their new places as the layout grows.
 * Parity with React's `useMermaidStream`.
 */
export function createMermaidStream(options: CreateMermaidStreamOptions = {}): SvelteMermaidStream {
	const { duration = 300, ...layoutOptions } = options;
	const stream = new DiagramStream(layoutOptions);
	let doc = $state.raw<MermaidDocument | null>(null);
	let shown = $state.raw<DiagramLayout | null>(null);
	let settled = $state(true);
	let frame = 0;
	const stop = () => {
		if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
		frame = 0;
	};
	const canvas = $derived.by(() => {
		if (!doc || !shown) return { nodes: [] as MermaidFlowNode[], edges: [] as MermaidFlowEdge[] };
		const placed = new Set(Object.keys(shown.positions));
		const graph = {
			...doc.graph,
			nodes: doc.graph.nodes.filter((n) => placed.has(n.id)),
			groups: doc.graph.groups.filter((g) => placed.has(g.id)),
			edges: doc.graph.edges.filter((e) => placed.has(e.source) && placed.has(e.target))
		};
		return mermaidToCanvas({ ...doc, graph }, { layout: shown });
	});
	return {
		get document() {
			return doc;
		},
		get nodes() {
			return canvas.nodes;
		},
		get edges() {
			return canvas.edges;
		},
		get layout() {
			return shown;
		},
		get settled() {
			return settled;
		},
		update(source, complete = false) {
			const result = stream.update(source, complete);
			doc = result.document.tier === 'editable' ? result.document : null;
			const target = result.layout;
			if (!result.relaid && shown) return;
			stop();
			const from = shown;
			if (!target || !from || duration <= 0 || typeof requestAnimationFrame !== 'function') {
				shown = target;
				settled = true;
				return;
			}
			const start = performance.now();
			settled = false;
			const step = () => {
				const t = Math.min(1, (performance.now() - start) / duration);
				shown = blendDiagramLayout(from, target, easeDiagramTween(t));
				settled = t >= 1;
				frame = t < 1 ? requestAnimationFrame(step) : 0;
			};
			frame = requestAnimationFrame(step);
		},
		reset() {
			stop();
			stream.reset();
			doc = null;
			shown = null;
			settled = true;
		},
		destroy: stop
	};
}
