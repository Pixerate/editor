import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
	DiagramController,
	type DiagramActionResult,
	type DiagramControllerOptions,
	type DiagramState,
	type EditOp,
	type MermaidDocument
} from '@pixerate/editor/diagram';
import {
	CSS_VARIABLE_DIAGRAM_SCENE_THEME,
	DiagramStream,
	blendDiagramLayout,
	diagramDragLabel,
	diagramRenameOp,
	familySceneFromLayout,
	planDiagramDrag,
	withDiagramDragHandles,
	easeDiagramTween,
	mermaidMovesFromCanvas,
	mermaidToCanvas,
	type DiagramLayout,
	type DiagramDrag,
	type DiagramLayoutOptions,
	type DiagramScene,
	type DiagramSceneTheme,
	type MermaidFlowEdge,
	type MermaidFlowNode
} from '@pixerate/editor/canvas';

export interface UseMermaidDiagramOptions extends DiagramControllerOptions {
	/** Layout spacing and node measuring for new nodes (stored positions always win). */
	layoutOptions?: DiagramLayoutOptions;
	/** Colours for families drawn as scenes (default: the page's CSS colour variables). */
	sceneTheme?: Partial<DiagramSceneTheme>;
}

type Placed = { id: string; position: { x: number; y: number }; parentId?: string };

export interface UseMermaidDiagramResult {
	controller: DiagramController;
	state: DiagramState;
	document: MermaidDocument;
	/** The Mermaid text (with the `%% @pixerate` layout comment). */
	source: string;
	/** Canvas nodes (groups first, children relative to their group) and edges. */
	nodes: MermaidFlowNode[];
	edges: MermaidFlowEdge[];
	layout: DiagramLayout;
	/**
	 * The family's own picture (pie, Gantt, sequence, XY, radar…) with the selection marked;
	 * null for families drawn as nodes and edges (flowchart, state, class, ER) and text-only
	 * ones. Render it with `MermaidFamilyScene`. When editable, its draggable marks carry
	 * `drag` (and a selected Gantt task its grips): pass `drop` as `onDragEnd`.
	 */
	scene: DiagramScene | null;
	apply: (ops: EditOp | EditOp[], label?: string) => DiagramActionResult;
	/** Replaces the source; `clearHistory` when opening a different diagram. */
	load: (source: string, options?: { clearHistory?: boolean }) => DiagramActionResult;
	/** Stores where dragged nodes ended up (pass every canvas node as `all` so groups carry their contents). */
	moveNodes: (moved: readonly Placed[], all?: readonly Placed[]) => DiagramActionResult | null;
	connect: (source: string, target: string, label?: string) => DiagramActionResult;
	/** Removes nodes / groups (with their edges) and edges by id, as one undo step. */
	remove: (ids: readonly string[]) => DiagramActionResult;
	rename: (id: string, label: string) => DiagramActionResult;
	/** Renames what a scene mark targets: the title (`::title`), a group, an edge or a node. */
	renameTarget: (target: string, label: string) => DiagramActionResult | null;
	/** Applies a finished drag on the scene (`planDiagramDrag`) as one undo step; null when it changes nothing. */
	drop: (drag: DiagramDrag) => DiagramActionResult | null;
	select: (ids: readonly string[]) => void;
	undo: () => void;
	redo: () => void;
}

/** The controller's state (re-renders on every change). */
export function useDiagramState(controller: DiagramController): DiagramState {
	return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

/**
 * A Mermaid diagram on a React Flow canvas: subscribes to a `DiagramController` (or creates
 * one from options), lays it out and returns canvas nodes and edges with bound edits. Every
 * edit rewrites only the statements it touches; positions go into `%% @pixerate`.
 */
export function useMermaidDiagram(
	controllerOrOptions: DiagramController | UseMermaidDiagramOptions = {},
	/** Layout and scene colours when passing a controller (options carry them otherwise). */
	view: Pick<UseMermaidDiagramOptions, 'layoutOptions' | 'sceneTheme'> = {}
): UseMermaidDiagramResult {
	const own = useRef<DiagramController | null>(null);
	let controller: DiagramController;
	if (controllerOrOptions instanceof DiagramController) controller = controllerOrOptions;
	else {
		if (!own.current) own.current = new DiagramController(controllerOrOptions);
		controller = own.current;
	}
	const layoutOptions = (controllerOrOptions instanceof DiagramController ? undefined : controllerOrOptions.layoutOptions) ?? view.layoutOptions;
	const sceneTheme = (controllerOrOptions instanceof DiagramController ? undefined : controllerOrOptions.sceneTheme) ?? view.sceneTheme;
	const state = useDiagramState(controller);
	const canvas = useMemo(
		() => mermaidToCanvas(state.document, { ...layoutOptions, editable: state.editable }),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[state.document, state.editable]
	);
	const scene = useMemo(
		() => {
			if (state.document.tier !== 'editable') return null;
			const theme = { ...CSS_VARIABLE_DIAGRAM_SCENE_THEME, ...sceneTheme };
			const drawn = familySceneFromLayout(state.document.family, state.document.graph, canvas.layout, { theme, selection: state.selection });
			return drawn && state.editable ? withDiagramDragHandles(drawn, { theme, selection: state.selection }) : drawn;
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[state.document, canvas.layout, state.selection, state.editable]
	);
	const layoutRef = useRef(canvas.layout);
	layoutRef.current = canvas.layout;

	const actions = useMemo(
		() => ({
			apply: (ops: EditOp | EditOp[], label?: string) => controller.apply(ops, label),
			load: (source: string, options?: { clearHistory?: boolean }) => controller.load(source, options),
			moveNodes: (moved: readonly Placed[], all: readonly Placed[] = moved) => {
				const op = mermaidMovesFromCanvas(layoutRef.current, moved, all, { stored: controller.getDocument().meta.layout ?? {} });
				return op ? controller.apply(op, 'Move') : null;
			},
			connect: (source: string, target: string, label?: string) =>
				controller.apply({ type: 'addEdge', edge: { source, target, ...(label ? { label } : {}) } }, 'Connect'),
			remove: (ids: readonly string[]) => {
				const graph = controller.getDocument().graph;
				const edgeIds = new Set(graph.edges.map((e) => e.id));
				const edges = ids.filter((id) => edgeIds.has(id));
				const nodes = ids.filter((id) => !edgeIds.has(id));
				const ops: EditOp[] = [];
				if (edges.length) ops.push({ type: 'removeEdges', ids: edges });
				if (nodes.length) ops.push({ type: 'removeNodes', ids: nodes });
				return controller.apply(ops, 'Delete');
			},
			rename: (id: string, label: string) =>
				controller.apply(
					controller.getDocument().graph.groups.some((g) => g.id === id) ? { type: 'renameGroup', id, label } : { type: 'renameNode', id, label },
					'Rename'
				),
			renameTarget: (target: string, label: string) => {
				const op = diagramRenameOp(controller.getDocument(), target, label);
				return op ? controller.apply(op, 'Rename') : null;
			},
			drop: (drag: DiagramDrag) => {
				if (!controller.getState().editable) return null;
				const ops = planDiagramDrag(controller.getDocument(), layoutRef.current, drag);
				return ops.length ? controller.apply(ops, diagramDragLabel(drag.kind)) : null;
			},
			select: (ids: readonly string[]) => controller.select(ids),
			undo: () => void controller.undo(),
			redo: () => void controller.redo()
		}),
		[controller]
	);
	return { controller, state, document: state.document, source: state.source, ...canvas, scene, ...actions };
}

export interface UseMermaidStreamOptions extends DiagramLayoutOptions {
	/** True once the whole source has arrived (unconnected nodes are shown then). */
	complete?: boolean;
	/** Glide duration between layouts in ms (default 300; 0 jumps). */
	duration?: number;
}

export interface UseMermaidStreamResult {
	document: MermaidDocument | null;
	nodes: MermaidFlowNode[];
	edges: MermaidFlowEdge[];
	/** The layout being shown (mid-glide while `settled` is false). */
	layout: DiagramLayout | null;
	settled: boolean;
}

/**
 * Draws Mermaid that is still being written (e.g. a model's reply): nodes appear once an
 * edge places them and glide to their new places as the layout grows. Read-only.
 */
export function useMermaidStream(source: string, options: UseMermaidStreamOptions = {}): UseMermaidStreamResult {
	const { complete = false, duration = 300, ...layoutOptions } = options;
	const stream = useRef<DiagramStream | null>(null);
	if (!stream.current) stream.current = new DiagramStream(layoutOptions);
	const result = useMemo(() => stream.current!.update(source, complete), [source, complete]);
	const [shown, setShown] = useState<{ layout: DiagramLayout | null; settled: boolean }>({ layout: result.layout, settled: true });
	const shownRef = useRef(shown.layout);
	shownRef.current = shown.layout;

	useEffect(() => {
		const target = result.layout;
		if (!target) return setShown({ layout: null, settled: true });
		const from = shownRef.current;
		if (!from || duration <= 0 || typeof requestAnimationFrame !== 'function') return setShown({ layout: target, settled: true });
		if (from === target) return;
		let frame = 0;
		const start = performance.now();
		const step = () => {
			const t = Math.min(1, (performance.now() - start) / duration);
			setShown({ layout: blendDiagramLayout(from, target, easeDiagramTween(t)), settled: t >= 1 });
			if (t < 1) frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [result.layout, duration]);

	const doc = result.document.tier === 'editable' ? result.document : null;
	const canvas = useMemo(() => {
		if (!doc || !shown.layout) return { nodes: [], edges: [] };
		// Only what has been placed: labels may run ahead of the layout.
		const placed = new Set(Object.keys(shown.layout.positions));
		const graph = {
			...doc.graph,
			nodes: doc.graph.nodes.filter((n) => placed.has(n.id)),
			groups: doc.graph.groups.filter((g) => placed.has(g.id)),
			edges: doc.graph.edges.filter((e) => placed.has(e.source) && placed.has(e.target))
		};
		return mermaidToCanvas({ ...doc, graph }, { layout: shown.layout });
	}, [doc, shown.layout]);
	return { document: doc, ...canvas, layout: shown.layout, settled: shown.settled };
}

