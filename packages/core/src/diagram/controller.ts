import { HistoryManager } from '../history/HistoryManager.js';
import type { Command } from '../history/types.js';
import { applyEdits, parseMermaid } from './document.js';
import { FLOWCHART_SHAPES } from './flowchart/shapes.js';
import { STATE_SHAPES } from './lines-grammar/state.js';
import { familyUI } from './families/index.js';
import { DIRECTIONS, type DiagramFamily, type EditOp, type MermaidDocument } from './types.js';

/** Families that can be edited statement by statement; every other family is kept as text. */
export const EDITABLE_DIAGRAM_FAMILIES = [
	'flowchart',
	'state',
	'class',
	'er',
	'pie',
	'mindmap',
	'quadrant',
	'c4',
	'architecture',
	'sequence',
	'gitGraph',
	'gantt',
	'timeline',
	'journey',
	'xychart',
	'radar'
] as const;

/**
 * The shapes a node of `family` can take (`setNodeShape`), as canonical names. Empty when
 * the family has nothing to choose between (class boxes, ER entities, pie slices…).
 */
export function diagramShapes(family: DiagramFamily): string[] {
	if (family === 'flowchart') return FLOWCHART_SHAPES.map((shape) => shape.name);
	if (family === 'state') return STATE_SHAPES.map((shape) => shape.name);
	if (family === 'class' || family === 'er') return [];
	const shapes = familyUI(family)?.shapes ?? [];
	return shapes.length > 1 ? shapes.map((shape) => shape.value) : [];
}

/** Whether the family has groups (subgraphs, composite states, namespaces, boxes, sections…). */
export function diagramSupportsGroups(family: DiagramFamily): boolean {
	return familyUI(family)?.groups.supported ?? false;
}

/** Whether the family has a direction (`setDirection`): false for families whose positions follow their data (pie, sequence, Gantt…). */
export function diagramSupportsDirection(family: DiagramFamily): boolean {
	return familyUI(family)?.directions !== false;
}

const quote = (ids: Iterable<string>) => [...ids].map((id) => `"${id}"`).join(', ');

/**
 * Checks an edit against the document before it is applied. Returns a sentence saying
 * what is wrong and how to fix it, or `null` when the edit is valid. Ids are checked
 * against nodes, groups and edges; shapes against {@link diagramShapes}.
 */
export function validateDiagramEdit(doc: MermaidDocument, op: EditOp): string | null {
	const { graph, family } = doc;
	if (op.type === 'replaceSource') return null;
	if (doc.tier !== 'editable')
		return `This ${family} diagram can only be edited as Mermaid text; replace the source instead.`;
	const nodes = new Set(graph.nodes.map((n) => n.id));
	const groups = new Set(graph.groups.map((g) => g.id));
	const edges = new Set(graph.edges.map((e) => e.id));
	const anyIds = () => (nodes.size ? `existing node ids are ${quote([...nodes].slice(0, 20))}` : 'the diagram has no nodes yet');
	const node = (id: string, allowGroup = false) =>
		nodes.has(id) || (allowGroup && groups.has(id)) ? null : `There is no node "${id}"; ${anyIds()}.`;
	const group = (id: string | undefined) =>
		id === undefined || groups.has(id)
			? null
			: `There is no group "${id}"; ${groups.size ? `existing groups are ${quote(groups)}` : 'the diagram has no groups'}.`;
	const edge = (id: string) =>
		edges.has(id)
			? null
			: `There is no edge "${id}"; ${edges.size ? `existing edge ids are ${quote([...edges].slice(0, 20))}` : 'the diagram has no edges yet'}.`;
	const shape = (name: string | undefined) => {
		if (name === undefined) return null;
		const shapes = diagramShapes(family);
		if (!shapes.length) return `Nodes of a ${family} diagram have no shapes to choose from.`;
		return shapes.includes(name) ? null : `Unknown shape "${name}"; use one of ${quote(shapes)}.`;
	};
	const free = (id: string) =>
		!/^[A-Za-z0-9_][\w.-]*$/.test(id)
			? `Id "${id}" is not a valid Mermaid id; use letters, digits, "_", "-" or ".".`
			: nodes.has(id) || groups.has(id)
				? `Id "${id}" is already used; choose another.`
				: null;
	const first = (...problems: (string | null)[]) => problems.find((p) => p) ?? null;

	switch (op.type) {
		case 'addNode':
			return first(free(op.node.id), shape(op.node.shape), group(op.node.parentId));
		case 'removeNodes':
			return first(...op.ids.map((id) => node(id, true)));
		case 'renameNode':
			return node(op.id, true);
		case 'setNodeShape':
			return first(node(op.id), shape(op.shape));
		case 'setNodeClasses':
		case 'setNodeStyles':
		case 'setNodeLink':
		case 'setNodeData':
		case 'resizeNode':
			return node(op.id, true);
		case 'moveNodes':
			return first(...op.moves.map((m) => node(m.id, true)));
		case 'addEdge':
			return first(node(op.edge.source, true), node(op.edge.target, true));
		case 'removeEdges':
			return first(...op.ids.map(edge));
		case 'setEdgeLabel':
		case 'setEdgeStyle':
		case 'setEdgeData':
			return edge(op.id);
		case 'reconnectEdge':
			return first(edge(op.id), node(op.source, true), node(op.target, true));
		case 'groupNodes':
			if (!diagramSupportsGroups(family)) return `${family} diagrams have no groups.`;
			return first(free(op.groupId), ...op.nodeIds.map((id) => node(id, true)), group(op.parentId));
		case 'ungroup':
			return group(op.groupId);
		case 'renameGroup':
		case 'setGroupDirection':
			return group(op.id);
		case 'setNodeParent':
			return first(...op.ids.map((id) => node(id, true)), group(op.parentId));
		case 'setDirection':
			if (!diagramSupportsDirection(family)) return `${family} diagrams have no direction.`;
			return (DIRECTIONS as readonly string[]).includes(op.direction)
				? null
				: `Unknown direction "${op.direction}"; use one of ${quote(DIRECTIONS)}.`;
		default:
			return null;
	}
}

export interface DiagramControllerOptions {
	/** Starting Mermaid source (default: an empty `flowchart TD`). */
	source?: string;
	/** History to record into, e.g. one shared with the rest of the app (default: a new one). */
	history?: HistoryManager;
	/** Refuse edits (read tools still work). */
	readOnly?: boolean;
	/** Called after the source changes (edit, undo, redo, load). */
	onChange?: (source: string, document: MermaidDocument) => void;
}

/** A snapshot of the controller. The same object is returned until something changes. */
export interface DiagramState {
	document: MermaidDocument;
	/** The Mermaid text, always in step with `document`. */
	source: string;
	family: DiagramFamily;
	/** True for families with an adapter (see {@link EDITABLE_DIAGRAM_FAMILIES}) that are not read-only. */
	editable: boolean;
	readOnly: boolean;
	/** Selected node, group or edge ids. */
	selection: readonly string[];
	/** The problem with the last rejected edit, if any. */
	issue: string | null;
	canUndo: boolean;
	canRedo: boolean;
	undoLabel: string;
	redoLabel: string;
	/** Bumped on every change. */
	revision: number;
}

export type DiagramActionResult =
	| { ok: true; document: MermaidDocument }
	| { ok: false; message: string };

/**
 * Headless state for a Mermaid diagram editor: the parsed document, a selection and
 * undoable statement-level edits. Every `apply` is one undo step and only rewrites the
 * statements it touches, so untouched text (comments, directives, formatting) survives.
 * Canvas positions go into the `%% @pixerate {…}` comment. Drags merge into one undo
 * step between `beginGesture` and `endGesture`. `getState()` returns the same object
 * until something changes, so it works with `useSyncExternalStore` and Svelte runes.
 */
export class DiagramController {
	readonly history: HistoryManager;
	private doc: MermaidDocument;
	private selection: string[] = [];
	private issue: string | null = null;
	private readOnly: boolean;
	private revision = 0;
	private applying = false;
	private gestureKey: string | null = null;
	private gestureCount = 0;
	private readonly onChange?: DiagramControllerOptions['onChange'];
	private readonly listeners = new Set<(state: DiagramState) => void>();
	private unsubscribeHistory?: () => void;
	private state!: DiagramState;

	constructor(options: DiagramControllerOptions = {}) {
		this.history = options.history ?? new HistoryManager();
		this.onChange = options.onChange;
		this.readOnly = options.readOnly ?? false;
		this.doc = parseMermaid(options.source ?? 'flowchart TD\n');
		this.state = this.computeState();
		this.connect();
	}

	private connect() {
		this.unsubscribeHistory?.();
		this.unsubscribeHistory = this.history.subscribe((h) => {
			const s = this.state;
			if (this.applying || (s.canUndo === h.canUndo && s.canRedo === h.canRedo && s.undoLabel === h.undoName && s.redoLabel === h.redoName)) return;
			this.notify(false);
		});
	}

	/** Stops listening to the history (subscribing again reconnects). */
	destroy() {
		this.unsubscribeHistory?.();
		this.unsubscribeHistory = undefined;
	}

	/** The current snapshot (stable until the next change). */
	getState = (): DiagramState => this.state;

	/** Calls `listener` after every change. Returns an unsubscribe function. */
	subscribe = (listener: (state: DiagramState) => void): (() => void) => {
		if (!this.unsubscribeHistory) this.connect();
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** The current document (immutable; edit through the controller). */
	getDocument(): MermaidDocument {
		return this.doc;
	}

	getSource(): string {
		return this.doc.source;
	}

	private computeState(): DiagramState {
		const h = this.history.getState();
		return {
			document: this.doc,
			source: this.doc.source,
			family: this.doc.family,
			editable: this.doc.tier === 'editable' && !this.readOnly,
			readOnly: this.readOnly,
			selection: this.selection,
			issue: this.issue,
			canUndo: h.canUndo,
			canRedo: h.canRedo,
			undoLabel: h.undoName,
			redoLabel: h.redoName,
			revision: this.revision
		};
	}

	private notify(sourceChanged: boolean) {
		this.revision++;
		this.state = this.computeState();
		if (sourceChanged) this.onChange?.(this.doc.source, this.doc);
		const state = this.state;
		this.listeners.forEach((listener) => {
			try {
				listener(state);
			} catch (error) {
				console.error('[DiagramController] Error in state listener:', error);
			}
		});
	}

	private setDocument(doc: MermaidDocument) {
		this.applying = true;
		try {
			this.doc = doc;
			const ids = new Set([...doc.graph.nodes, ...doc.graph.groups, ...doc.graph.edges].map((x) => x.id));
			this.selection = this.selection.filter((id) => ids.has(id));
		} finally {
			this.applying = false;
		}
		this.notify(true);
	}

	private commit(label: string, next: MermaidDocument) {
		const before = this.doc;
		this.issue = null;
		if (next.source === before.source) {
			this.notify(false);
			return;
		}
		const command: Command = {
			name: label,
			tag: 'diagram',
			execute: () => this.setDocument(next),
			undo: () => this.setDocument(before),
			redo: () => this.setDocument(next),
			byteSize: (before.source.length + next.source.length) * 2
		};
		if (this.gestureKey !== null) this.history.executeMerged(command, { key: `diagram.gesture:${this.gestureKey}:${this.gestureCount}` });
		else this.history.execute(command);
	}

	private reject(message: string): DiagramActionResult {
		this.issue = message;
		this.notify(false);
		return { ok: false, message };
	}

	/**
	 * Applies edits as one undo step. All-or-nothing: every edit is checked against the
	 * document as it stands after the edits before it, and nothing changes when one fails.
	 */
	apply(ops: EditOp | EditOp[], label = 'Edit diagram'): DiagramActionResult {
		const list = Array.isArray(ops) ? ops : [ops];
		if (this.readOnly) return this.reject('The diagram is read-only.');
		let doc = this.doc;
		for (const op of list) {
			const problem = validateDiagramEdit(doc, op);
			if (problem) return this.reject(problem);
			doc = applyEdits(doc, [op]);
		}
		this.commit(label, doc);
		return { ok: true, document: this.doc };
	}

	/**
	 * Replaces the whole source. `clearHistory` drops the undo stack (opening a file);
	 * otherwise the replacement is one undo step.
	 */
	load(source: string, options: { clearHistory?: boolean } = {}): DiagramActionResult {
		const next = parseMermaid(source, { metaCarrier: this.doc.metaCarrier });
		if (options.clearHistory) {
			this.history.clear();
			this.issue = null;
			this.selection = [];
			this.setDocument(next);
			return { ok: true, document: next };
		}
		if (this.readOnly) return this.reject('The diagram is read-only.');
		this.commit('Replace diagram', next);
		return { ok: true, document: this.doc };
	}

	setReadOnly(readOnly: boolean) {
		if (this.readOnly === readOnly) return;
		this.readOnly = readOnly;
		this.notify(false);
	}

	/** Selects node, group or edge ids (unknown ids are dropped). */
	select(ids: readonly string[]) {
		const known = new Set([...this.doc.graph.nodes, ...this.doc.graph.groups, ...this.doc.graph.edges].map((x) => x.id));
		const next = ids.filter((id) => known.has(id));
		if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
		this.selection = next;
		this.notify(false);
	}

	/** Edits until `endGesture` (e.g. the moves of one drag) fold into one undo step. */
	beginGesture(key: string) {
		this.gestureKey = key;
		this.gestureCount++;
	}

	endGesture() {
		this.gestureKey = null;
	}

	undo(): boolean {
		return this.history.undo();
	}

	redo(): boolean {
		return this.history.redo();
	}

	/** A node id not used by any node or group: `prefix` followed by the next free number. */
	nextId(prefix = 'N'): string {
		const used = new Set([...this.doc.graph.nodes, ...this.doc.graph.groups].map((x) => x.id));
		let i = 1;
		while (used.has(`${prefix}${i}`)) i++;
		return `${prefix}${i}`;
	}
}
