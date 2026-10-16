import { HistoryManager } from '../history/HistoryManager.js';
import type { Command } from '../history/types.js';
import { fitCubics } from '../canvas/curveFit.js';
import { pathBoolean } from '../canvas/pathops/boolean.js';
import { transformBezierPath, type BezierPath } from '../canvas/pathops/bezier.js';
import type { Point } from '../canvas/types.js';
import {
	bezierToSubpaths,
	boundsFromPoints,
	boundsIntersect,
	cloneVectorDocument,
	cloneVectorNode,
	collectPathNodes,
	convertAnchor,
	ellipseSubpath,
	findVectorNode,
	hitTestVectorNode,
	hitTestVectorNodes,
	insertAnchor,
	lineSubpath,
	locateVectorNode,
	moveAnchorHandle,
	nearestSegment,
	nodeMatrix,
	invertMatrix,
	applyMatrix,
	applyMatrixLinear,
	multiplyMatrices,
	matrixRotation,
	vectorWorldMatrix,
	vectorParentMatrix,
	vectorPathWorldBezier,
	IDENTITY_MATRIX,
	polygonSubpath,
	rectSubpath,
	removeAnchors,
	reverseSubpath,
	rotateMatrix,
	scaleMatrix,
	starSubpath,
	subpathsToBezier,
	transformVectorNode,
	translateAnchor,
	translateMatrix,
	unionBounds,
	vectorNodeBounds,
	walkVectorNodes,
	type AffineMatrix
} from './geometry.js';
import { parseVectorSvg, vectorDocumentToSvg, type VectorSvgExportOptions } from './svg.js';
import type {
	Vec2,
	VectorAlign,
	VectorAnchor,
	VectorAnchorRef,
	VectorAnchorType,
	VectorArrange,
	VectorBooleanOperation,
	VectorBounds,
	VectorDefaults,
	VectorDistribute,
	VectorDocument,
	VectorGroupNode,
	VectorHandleRef,
	VectorModifiers,
	VectorNode,
	VectorPathNode,
	VectorStyle,
	VectorSubpath,
	VectorTool,
	VectorTransformHandle,
	VectorViewport
} from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VectorSnapOptions {
	/** Grid size in document units (0 = off, default 0). */
	grid: number;
}

export interface VectorEditorOptions {
	document?: VectorDocument;
	/** History to record into, e.g. one shared with the rest of the app (default: a new one). */
	history?: HistoryManager;
	/** Starting tool (default `select`). */
	tool?: VectorTool;
	/** Style and settings for new shapes and paths. */
	defaults?: VectorDefaults;
	viewport?: Partial<VectorViewport>;
	snap?: Partial<VectorSnapOptions>;
	/** Pick distance for anchors, handles and outlines in screen pixels (default 6). */
	hitRadius?: number;
	/** Id factory for new nodes. */
	createId?: () => string;
	/** Called after the document changes (edits, undo, redo, load). */
	onChange?: (document: VectorDocument) => void;
}

/** A pointer event as the controller needs it. Positions are in screen pixels relative to the canvas. */
export interface VectorPointerInput extends VectorModifiers {
	/** 0 = primary, 1 = middle (pans), 2 = secondary. Default 0. */
	button?: number;
}

/** A key press as the controller needs it. */
export interface VectorKeyInput extends VectorModifiers {
	/** `KeyboardEvent.key`. */
	key: string;
}

/** What the pointer is over. */
export interface VectorHover {
	nodeId: string | null;
	anchor?: VectorAnchorRef;
	handle?: VectorHandleRef;
	segment?: { nodeId: string; subpath: number; segment: number; t: number; point: Vec2 };
	transformHandle?: VectorTransformHandle;
}

/** The drag in progress, for overlays and status text. */
export type VectorInteraction =
	| { type: 'marquee'; bounds: VectorBounds }
	| { type: 'move'; dx: number; dy: number }
	| { type: 'scale'; handle: VectorTransformHandle; sx: number; sy: number }
	| { type: 'rotate'; angle: number }
	| { type: 'anchors'; dx: number; dy: number }
	| { type: 'handle'; ref: VectorHandleRef }
	| { type: 'draw'; tool: VectorTool; nodeId: string; bounds: VectorBounds }
	| { type: 'pen'; nodeId: string }
	| { type: 'pan' };

/** A snapshot of the editor. The same object is returned until something changes. */
export interface VectorEditorState {
	document: VectorDocument;
	tool: VectorTool;
	/** Selected node ids (top-level nodes or group members picked with the direct tool). */
	selection: readonly string[];
	/** Selected anchors (direct tool). */
	selectedAnchors: readonly VectorAnchorRef[];
	/** The path whose anchors are being edited, if any. */
	editingId: string | null;
	/** Axis-aligned bounds of the selected nodes in document units. */
	selectionBounds: VectorBounds | null;
	/** The selection box, rotated with the selection when its nodes share a rotation. */
	selectionFrame: VectorSelectionFrame | null;
	viewport: VectorViewport;
	defaults: Readonly<Required<Pick<VectorDefaults, 'polygonSides' | 'starPoints' | 'starInnerRatio' | 'cornerRadius'>> & VectorStyle>;
	snap: VectorSnapOptions;
	hitRadius: number;
	hover: VectorHover | null;
	/** A CSS cursor for the canvas. */
	cursor: string;
	interaction: VectorInteraction | null;
	/** The path the pen tool is adding to. */
	pen: { nodeId: string; subpath: number } | null;
	/** Last pointer position in document units (for the pen preview), or null when outside. */
	pointer: Vec2 | null;
	canUndo: boolean;
	canRedo: boolean;
	undoLabel: string;
	redoLabel: string;
	/** Bumped on every change. */
	revision: number;
}

export type VectorActionResult = { ok: true } | { ok: false; message: string };

export interface AddVectorNodeOptions {
	/** Group to add into (default: the root). */
	parentId?: string;
	/** Position in the parent's list (default: on top). */
	index?: number;
	/** Select the new node (default true). */
	select?: boolean;
	/** Undo step label. */
	label?: string;
}

/** A shape description for `addShape` (and the agent command of the same name). */
export interface VectorShapeInput extends VectorStyle {
	kind: 'rect' | 'ellipse' | 'polygon' | 'star' | 'line';
	x: number;
	y: number;
	width: number;
	height: number;
	cornerRadius?: number;
	sides?: number;
	points?: number;
	innerRatio?: number;
	name?: string;
}

/** Clipboard payload type written by `copy()`. */
export const VECTOR_CLIPBOARD_TYPE = 'pixerate/vector';

const DEFAULT_DEFAULTS = {
	fill: '#d4d4d8',
	stroke: '#18181b',
	strokeWidth: 2,
	polygonSides: 6,
	starPoints: 5,
	starInnerRatio: 0.5,
	cornerRadius: 0
};

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 64;
/** Screen distance of the rotation handle above the selection box. */
export const VECTOR_ROTATE_HANDLE_OFFSET = 24;

// ---------------------------------------------------------------------------
// Helpers shared with the render module
// ---------------------------------------------------------------------------

const sameRef = (a: VectorAnchorRef, b: VectorAnchorRef) => a.nodeId === b.nodeId && a.subpath === b.subpath && a.index === b.index;

/** Ids of the path nodes whose anchors are shown (the edited path plus selected paths). */
export function getEditablePathIds(state: Pick<VectorEditorState, 'document' | 'selection' | 'editingId' | 'tool' | 'pen'>): string[] {
	if (state.tool !== 'direct' && state.tool !== 'pen') return [];
	const ids = new Set<string>();
	if (state.pen) ids.add(state.pen.nodeId);
	if (state.tool === 'direct') {
		if (state.editingId) ids.add(state.editingId);
		for (const id of state.selection) {
			const node = findVectorNode(state.document.nodes, id);
			if (node && !node.locked) for (const p of collectPathNodes(node)) if (!p.locked) ids.add(p.id);
		}
	}
	return [...ids].filter((id) => findVectorNode(state.document.nodes, id)?.type === 'path');
}

/** Every anchor drawn on the canvas. */
export function getVisibleAnchors(state: Pick<VectorEditorState, 'document' | 'selection' | 'editingId' | 'tool' | 'pen'>): VectorAnchorRef[] {
	const out: VectorAnchorRef[] = [];
	for (const id of getEditablePathIds(state)) {
		const node = findVectorNode(state.document.nodes, id) as VectorPathNode;
		node.subpaths.forEach((sp, s) => sp.anchors.forEach((_, i) => out.push({ nodeId: id, subpath: s, index: i })));
	}
	return out;
}

/**
 * Handles drawn on the canvas: those of selected anchors and of the segments next to them
 * (direct tool), or of the last anchor of the pen path.
 */
export function getVisibleHandles(
	state: Pick<VectorEditorState, 'document' | 'selection' | 'editingId' | 'tool' | 'pen' | 'selectedAnchors'>
): VectorHandleRef[] {
	const out: VectorHandleRef[] = [];
	const seen = new Set<string>();
	const push = (node: VectorPathNode, s: number, i: number, handle: 'in' | 'out') => {
		const sp = node.subpaths[s];
		const a = sp?.anchors[i];
		if (!a || !a[handle]) return;
		const key = `${node.id}:${s}:${i}:${handle}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ nodeId: node.id, subpath: s, index: i, handle });
	};
	if (state.tool === 'pen' && state.pen) {
		const node = findVectorNode(state.document.nodes, state.pen.nodeId);
		const sp = node?.type === 'path' ? node.subpaths[state.pen.subpath] : undefined;
		if (node?.type === 'path' && sp) {
			const last = sp.anchors.length - 1;
			push(node, state.pen.subpath, last, 'in');
			push(node, state.pen.subpath, last, 'out');
		}
		return out;
	}
	if (state.tool !== 'direct') return out;
	const editable = new Set(getEditablePathIds(state));
	for (const ref of state.selectedAnchors) {
		if (!editable.has(ref.nodeId)) continue;
		const node = findVectorNode(state.document.nodes, ref.nodeId) as VectorPathNode;
		const sp = node.subpaths[ref.subpath];
		if (!sp) continue;
		const n = sp.anchors.length;
		push(node, ref.subpath, ref.index, 'in');
		push(node, ref.subpath, ref.index, 'out');
		const prev = ref.index > 0 ? ref.index - 1 : sp.closed ? n - 1 : -1;
		const next = ref.index < n - 1 ? ref.index + 1 : sp.closed ? 0 : -1;
		if (prev >= 0) push(node, ref.subpath, prev, 'out');
		if (next >= 0) push(node, ref.subpath, next, 'in');
	}
	return out;
}

/** Looks up an anchor (positions in its node's own space). */
export function getAnchor(doc: VectorDocument, ref: VectorAnchorRef): VectorAnchor | undefined {
	const node = findVectorNode(doc.nodes, ref.nodeId);
	return node?.type === 'path' ? node.subpaths[ref.subpath]?.anchors[ref.index] : undefined;
}

/** An anchor with its position and handles in document space (its node's transforms applied). */
export function getAnchorWorld(doc: VectorDocument, ref: VectorAnchorRef): { x: number; y: number; in?: Vec2; out?: Vec2; type?: VectorAnchorType } | undefined {
	const a = getAnchor(doc, ref);
	if (!a) return undefined;
	const m = vectorWorldMatrix(doc.nodes, ref.nodeId) ?? IDENTITY_MATRIX;
	const p = applyMatrix(m, a);
	return { x: p.x, y: p.y, ...(a.in ? { in: applyMatrix(m, a.in) } : {}), ...(a.out ? { out: applyMatrix(m, a.out) } : {}), ...(a.type ? { type: a.type } : {}) };
}

/**
 * The selection box: `angle` is the shared rotation of the selected nodes (0 when they
 * differ), `x / y / width / height` the bounds in the box's own frame (document space
 * rotated by −angle). A frame point `q` is at `rotateMatrix(angle)` applied to `q`.
 */
export interface VectorSelectionFrame {
	x: number;
	y: number;
	width: number;
	height: number;
	angle: number;
}

/** The selection frame of nodes `ids` (see `VectorSelectionFrame`), or null when they have no points. */
export function getVectorSelectionFrame(doc: VectorDocument, ids: readonly string[]): VectorSelectionFrame | null {
	const nodes = ids.map((id) => ({ node: findVectorNode(doc.nodes, id), parent: vectorParentMatrix(doc.nodes, id) ?? IDENTITY_MATRIX })).filter((n) => n.node);
	if (!nodes.length) return null;
	const angles = nodes.map((n) => matrixRotation(multiplyMatrices(nodeMatrix(n.node!), n.parent)));
	const same = angles.every((a) => Math.abs(normalizeAngle(a - angles[0])) < 1e-6);
	const angle = same ? angles[0] : 0;
	const unrotate = rotateMatrix(-angle);
	const b = unionBounds(nodes.map((n) => vectorNodeBounds(n.node!, multiplyMatrices(n.parent, unrotate))));
	return b ? { ...b, angle } : null;
}

const normalizeAngle = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Screen positions of the selection box handles for a box given in screen pixels. */
export function getTransformHandlePositions(box: VectorBounds): { handle: VectorTransformHandle; x: number; y: number }[] {
	const { x, y, width: w, height: h } = box;
	return [
		{ handle: 'nw', x, y },
		{ handle: 'n', x: x + w / 2, y },
		{ handle: 'ne', x: x + w, y },
		{ handle: 'e', x: x + w, y: y + h / 2 },
		{ handle: 'se', x: x + w, y: y + h },
		{ handle: 's', x: x + w / 2, y: y + h },
		{ handle: 'sw', x, y: y + h },
		{ handle: 'w', x, y: y + h / 2 },
		{ handle: 'rotate', x: x + w / 2, y: y - VECTOR_ROTATE_HANDLE_OFFSET }
	];
}

/**
 * Screen geometry of a selection box. `box` and each handle's `x / y` are the unrotated box
 * in screen pixels; draw them inside a group with `transform` (a `rotate(angle cx cy)`),
 * or use `screen` for the true on-screen positions (hit-testing).
 */
export interface VectorSelectionBoxGeometry {
	box: VectorBounds;
	angle: number;
	transform: string;
	handles: { handle: VectorTransformHandle; x: number; y: number; screen: Vec2 }[];
	/** The four corners on screen, clockwise from the top left. */
	corners: Vec2[];
}

export function getVectorSelectionBoxGeometry(frame: VectorSelectionFrame, viewport: VectorViewport): VectorSelectionBoxGeometry {
	const z = viewport.zoom;
	const box = { x: frame.x * z + viewport.x, y: frame.y * z + viewport.y, width: frame.width * z, height: frame.height * z };
	const rot = rotateMatrix(frame.angle, { x: viewport.x, y: viewport.y });
	const toScreen = (p: Vec2): Vec2 => (frame.angle ? applyMatrix(rot, p) : { x: p.x, y: p.y });
	const handles = getTransformHandlePositions(box).map((h) => ({ ...h, screen: toScreen(h) }));
	const corners = [
		{ x: box.x, y: box.y },
		{ x: box.x + box.width, y: box.y },
		{ x: box.x + box.width, y: box.y + box.height },
		{ x: box.x, y: box.y + box.height }
	].map(toScreen);
	const r = (n: number) => Math.round(n * 1000) / 1000;
	return { box, angle: frame.angle, transform: frame.angle ? `rotate(${r(frame.angle)} ${r(viewport.x)} ${r(viewport.y)})` : '', handles, corners };
}

const RESIZE_CURSOR_ORDER = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
const HANDLE_ANGLES: Partial<Record<VectorTransformHandle, number>> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };

/** The resize cursor for a handle of a box rotated by `angle` degrees. */
export function vectorResizeCursor(handle: VectorTransformHandle, angle = 0): string {
	if (handle === 'rotate') return 'grab';
	const a = (((HANDLE_ANGLES[handle]! + angle) % 180) + 180) % 180;
	return RESIZE_CURSOR_ORDER[Math.round(a / 45) % 4];
}


const TOOL_LABELS: Record<VectorTool, string> = {
	select: 'Select',
	direct: 'Direct Select',
	pen: 'Pen',
	pencil: 'Pencil',
	rect: 'Rectangle',
	ellipse: 'Ellipse',
	polygon: 'Polygon',
	star: 'Star',
	line: 'Line'
};

const TOOL_KEYS: Record<string, VectorTool> = { v: 'select', a: 'direct', p: 'pen', n: 'pencil', r: 'rect', o: 'ellipse', e: 'ellipse', y: 'polygon', s: 'star', l: 'line' };

export function vectorToolLabel(tool: VectorTool): string {
	return TOOL_LABELS[tool];
}

/** Keyboard shortcut of each tool (single letters, no modifiers). */
export const VECTOR_TOOL_SHORTCUTS: Readonly<Record<VectorTool, string>> = {
	select: 'V',
	direct: 'A',
	pen: 'P',
	pencil: 'N',
	rect: 'R',
	ellipse: 'O',
	polygon: 'Y',
	star: 'S',
	line: 'L'
};

/** Short glyphs for tool buttons (pair them with `vectorToolLabel` for the accessible name). */
export const VECTOR_TOOL_GLYPHS: Readonly<Record<VectorTool, string>> = {
	select: '↖',
	direct: '⌖',
	pen: '✒',
	pencil: '✎',
	rect: '▭',
	ellipse: '◯',
	polygon: '⬡',
	star: '☆',
	line: '╱'
};

const BOOLEAN_OPS: Record<VectorBooleanOperation, 'union' | 'difference' | 'intersection' | 'xor'> = {
	union: 'union',
	subtract: 'difference',
	intersect: 'intersection',
	exclude: 'xor'
};

const BOOLEAN_LABELS: Record<VectorBooleanOperation, string> = { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' };

/** Replaces nodes by id anywhere in the tree (structural sharing for untouched branches). */
function mapTree(nodes: readonly VectorNode[], fn: (node: VectorNode) => VectorNode | null): VectorNode[] {
	let changed = false;
	const out: VectorNode[] = [];
	for (const node of nodes) {
		let next = fn(node);
		if (next && next.type === 'group') {
			const children = mapTree(next.children, fn);
			if (children !== next.children) next = { ...next, children };
		}
		if (next !== node) changed = true;
		if (next) out.push(next);
	}
	return changed ? out : (nodes as VectorNode[]);
}

const isRoot = (m: AffineMatrix) => m === IDENTITY_MATRIX || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);

let idCounter = 0;
const defaultCreateId = () => `vn-${Date.now().toString(36)}${(++idCounter).toString(36)}`;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

interface Snapshot {
	doc: VectorDocument;
	selection: string[];
	anchors: VectorAnchorRef[];
	editingId: string | null;
	pen: { nodeId: string; subpath: number } | null;
}

type Drag =
	| { kind: 'move'; start: Vec2; origin: Vec2 | null; before: Snapshot; base: VectorDocument; moved: boolean; duplicated: boolean; clickId: string | null }
	| { kind: 'scale'; handle: VectorTransformHandle; start: Vec2; frame: VectorSelectionFrame; before: Snapshot; base: VectorDocument }
	| { kind: 'rotate'; start: Vec2; center: Vec2; before: Snapshot; base: VectorDocument }
	| { kind: 'marquee'; start: Vec2; base: string[]; baseAnchors: VectorAnchorRef[]; anchorsMode: boolean }
	| { kind: 'anchors'; start: Vec2; before: Snapshot; base: VectorDocument; moved: boolean; clickRef: VectorAnchorRef | null }
	| { kind: 'handle'; ref: VectorHandleRef; before: Snapshot; base: VectorDocument }
	| { kind: 'pull'; ref: VectorAnchorRef; before: Snapshot; base: VectorDocument; label: string; outOnly: boolean; closing: boolean; altBreaks: boolean }
	| { kind: 'shape'; tool: VectorTool; start: Vec2; nodeId: string; before: Snapshot }
	| { kind: 'pencil'; nodeId: string; points: Point[]; before: Snapshot }
	| { kind: 'pan'; start: Vec2; viewport: VectorViewport };

/**
 * Headless state for a vector editor: a document of paths and groups, select / direct /
 * pen / pencil / shape tools driven by pointer and key events, undo, transforms, boolean
 * operations, alignment, grouping, SVG import / export and a viewport. Any UI forwards
 * pointer events (in canvas pixels) and renders `getState()`; `getState()` returns the same
 * object until something changes, so it works with `useSyncExternalStore` and Svelte runes.
 */
export class VectorEditorController {
	readonly history: HistoryManager;
	private doc: VectorDocument;
	private selection: string[] = [];
	private anchors: VectorAnchorRef[] = [];
	private editingId: string | null = null;
	private pen: { nodeId: string; subpath: number } | null = null;
	private tool: VectorTool;
	private defaults: VectorEditorState['defaults'];
	private viewport: VectorViewport;
	private snap: VectorSnapOptions;
	private hitRadius: number;
	private hover: VectorHover | null = null;
	private pointer: Vec2 | null = null;
	private drag: Drag | null = null;
	private interaction: VectorInteraction | null = null;
	private spaceHeld = false;
	private clipboard: VectorNode[] | null = null;
	private readonly createId: () => string;
	private readonly onChange?: (document: VectorDocument) => void;
	private readonly listeners = new Set<(state: VectorEditorState) => void>();
	private readonly cleanups: Array<() => void> = [];
	private applying = false;
	/** Set while a commit records a change that was already applied, so `restore` still reports it. */
	private committing = false;
	private revision = 0;
	private state!: VectorEditorState;

	constructor(options: VectorEditorOptions = {}) {
		this.history = options.history ?? new HistoryManager();
		this.doc = options.document ? cloneVectorDocument(options.document) : { width: 800, height: 600, nodes: [] };
		this.tool = options.tool ?? 'select';
		this.defaults = { ...DEFAULT_DEFAULTS, ...(options.defaults ?? {}) } as VectorEditorState['defaults'];
		this.viewport = { x: 0, y: 0, zoom: 1, ...(options.viewport ?? {}) };
		this.snap = { grid: 0, ...(options.snap ?? {}) };
		this.hitRadius = options.hitRadius ?? 6;
		this.createId = options.createId ?? defaultCreateId;
		this.onChange = options.onChange;
		this.state = this.computeState();
		this.cleanups.push(
			this.history.subscribe((h) => {
				const s = this.state;
				if (this.applying || (s.canUndo === h.canUndo && s.canRedo === h.canRedo && s.undoLabel === h.undoName && s.redoLabel === h.redoName)) return;
				this.notify();
			})
		);
	}

	/** Stops listening to the history. */
	destroy(): void {
		this.cleanups.splice(0).forEach((fn) => fn());
		this.listeners.clear();
	}

	// -------------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------------

	/** The current snapshot (stable until the next change). */
	getState = (): VectorEditorState => this.state;

	/** Calls `listener` after every change. Returns an unsubscribe function. */
	subscribe = (listener: (state: VectorEditorState) => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getDocument(): VectorDocument {
		return this.doc;
	}

	getNode(id: string): VectorNode | undefined {
		return findVectorNode(this.doc.nodes, id);
	}

	private computeState(): VectorEditorState {
		const h = this.history.getState();
		return {
			document: this.doc,
			tool: this.tool,
			selection: this.selection,
			selectedAnchors: this.anchors,
			editingId: this.editingId,
			selectionBounds: this.boundsOf(this.selection),
			selectionFrame: this.frameOf(this.selectedRoots()),
			viewport: this.viewport,
			defaults: this.defaults,
			snap: this.snap,
			hitRadius: this.hitRadius,
			hover: this.hover,
			cursor: this.cursorFor(),
			interaction: this.interaction,
			pen: this.pen,
			pointer: this.pointer,
			canUndo: h.canUndo,
			canRedo: h.canRedo,
			undoLabel: h.undoName,
			redoLabel: h.redoName,
			revision: this.revision
		};
	}

	private notify(docChanged = false) {
		this.revision++;
		this.state = this.computeState();
		if (docChanged) this.onChange?.(this.doc);
		const state = this.state;
		this.listeners.forEach((listener) => {
			try {
				listener(state);
			} catch (error) {
				console.error('[VectorEditorController] Error in state listener:', error);
			}
		});
	}

	private boundsOf(ids: readonly string[]): VectorBounds | null {
		return unionBounds(
			ids.map((id) => {
				const n = this.getNode(id);
				return n ? vectorNodeBounds(n, vectorParentMatrix(this.doc.nodes, id) ?? IDENTITY_MATRIX) : null;
			})
		);
	}

	private frameOf(ids: readonly string[]): VectorSelectionFrame | null {
		return getVectorSelectionFrame(this.doc, ids);
	}

	/** Local → document matrix of a node in `doc` (default: the current document). */
	private worldOf(id: string, doc: VectorDocument = this.doc): AffineMatrix {
		return vectorWorldMatrix(doc.nodes, id) ?? IDENTITY_MATRIX;
	}

	/** A document point in node `id`'s own space. */
	private toLocal(id: string, p: Vec2, doc: VectorDocument = this.doc): Vec2 {
		return applyMatrix(invertMatrix(this.worldOf(id, doc)), p);
	}

	private cursorFor(): string {
		if (this.drag?.kind === 'pan' || this.spaceHeld) return this.drag ? 'grabbing' : 'grab';
		if (this.drag?.kind === 'rotate') return 'grabbing';
		if (this.drag?.kind === 'move') return 'move';
		const h = this.hover;
		switch (this.tool) {
			case 'select':
				if (h?.transformHandle) return vectorResizeCursor(h.transformHandle, this.frameOf(this.selectedRoots())?.angle ?? 0);
				return h?.nodeId ? 'move' : 'default';
			case 'direct':
				if (h?.anchor || h?.handle) return 'pointer';
				if (h?.segment) return 'copy';
				return h?.nodeId ? 'move' : 'default';
			case 'pen':
				return h?.anchor ? 'pointer' : 'crosshair';
			default:
				return 'crosshair';
		}
	}

	// -------------------------------------------------------------------------
	// Undoable changes
	// -------------------------------------------------------------------------

	private snapshot(): Snapshot {
		return { doc: this.doc, selection: this.selection, anchors: this.anchors, editingId: this.editingId, pen: this.pen };
	}

	private restore(s: Snapshot) {
		const docChanged = s.doc !== this.doc || this.committing;
		this.committing = false;
		this.applying = true;
		try {
			this.doc = s.doc;
			this.selection = s.selection.filter((id) => this.getNode(id));
			this.anchors = s.anchors.filter((r) => getAnchor(this.doc, r));
			this.editingId = s.editingId && this.getNode(s.editingId) ? s.editingId : null;
			this.pen = s.pen && (this.getNode(s.pen.nodeId) as VectorPathNode | undefined)?.subpaths?.[s.pen.subpath] ? s.pen : null;
		} finally {
			this.applying = false;
		}
		this.notify(docChanged);
	}

	/** Records the change from `before` to the current state as one undo step. */
	private commit(name: string, before: Snapshot) {
		const after = this.snapshot();
		if (before.doc === after.doc) {
			this.notify();
			return;
		}
		const command: Command = {
			name,
			execute: () => this.restore(after),
			undo: () => this.restore(before),
			redo: () => this.restore(after)
		};
		this.committing = true;
		this.history.execute(command);
		this.committing = false;
	}

	/** Runs `fn` (which updates fields) and records it as one undo step. */
	private change(name: string, fn: () => void): void {
		const before = this.snapshot();
		fn();
		this.commit(name, before);
	}

	private setDoc(nodes: VectorNode[]) {
		if (nodes !== this.doc.nodes) this.doc = { ...this.doc, nodes };
	}

	private replaceNode(id: string, next: VectorNode | null) {
		this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === id ? next : n)));
	}

	private freshIds<T extends VectorNode>(node: T): T {
		const copy = cloneVectorNode(node);
		const used = new Set<string>();
		walkVectorNodes(this.doc.nodes, (n) => used.add(n.id));
		const next = () => {
			let id = this.createId();
			while (used.has(id)) id = this.createId();
			used.add(id);
			return id;
		};
		const assign = (n: VectorNode) => {
			n.id = next();
			if (n.type === 'group') n.children.forEach(assign);
		};
		assign(copy);
		return copy;
	}

	private newId(): string {
		let id = this.createId();
		while (this.getNode(id)) id = this.createId();
		return id;
	}

	// -------------------------------------------------------------------------
	// Viewport
	// -------------------------------------------------------------------------

	screenToDocument(p: Vec2): Vec2 {
		const v = this.viewport;
		return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
	}

	documentToScreen(p: Vec2): Vec2 {
		const v = this.viewport;
		return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
	}

	setViewport(viewport: Partial<VectorViewport>): void {
		const next = { ...this.viewport, ...viewport };
		next.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.zoom));
		if (next.x === this.viewport.x && next.y === this.viewport.y && next.zoom === this.viewport.zoom) return;
		this.viewport = next;
		this.notify();
	}

	/** Zooms by `factor` keeping the document point under `screen` in place. */
	zoomAt(screen: Vec2, factor: number): void {
		const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.viewport.zoom * factor));
		const doc = this.screenToDocument(screen);
		this.setViewport({ zoom, x: screen.x - doc.x * zoom, y: screen.y - doc.y * zoom });
	}

	panBy(dx: number, dy: number): void {
		this.setViewport({ x: this.viewport.x + dx, y: this.viewport.y + dy });
	}

	/** Fits the artboard (or `bounds`) into a canvas of `size` screen pixels. */
	zoomToFit(size: { width: number; height: number }, options: { padding?: number; bounds?: VectorBounds } = {}): void {
		const padding = options.padding ?? 40;
		const b = options.bounds ?? { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
		const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((size.width - padding * 2) / (b.width || 1), (size.height - padding * 2) / (b.height || 1))));
		this.setViewport({ zoom, x: (size.width - b.width * zoom) / 2 - b.x * zoom, y: (size.height - b.height * zoom) / 2 - b.y * zoom });
	}

	/** Zoom at the canvas centre-ish: positive `delta` zooms out (wheel convention). Use with `wheel`. */
	wheel(screen: Vec2, delta: { x: number; y: number }, mods: VectorModifiers = {}): void {
		if (mods.mod) this.zoomAt(screen, Math.exp(-delta.y * 0.01));
		else this.panBy(-(mods.shift ? delta.y : delta.x), -(mods.shift ? 0 : delta.y));
	}

	// -------------------------------------------------------------------------
	// Settings
	// -------------------------------------------------------------------------

	setTool(tool: VectorTool): void {
		if (tool === this.tool) return;
		this.finishPath();
		this.cancelDrag();
		this.tool = tool;
		this.hover = null;
		if (tool !== 'direct') {
			this.anchors = [];
			this.editingId = null;
		}
		this.notify();
	}

	setDefaults(defaults: Partial<VectorDefaults>): void {
		this.defaults = { ...this.defaults, ...defaults };
		this.notify();
	}

	setSnap(snap: Partial<VectorSnapOptions>): void {
		this.snap = { ...this.snap, ...snap };
		this.notify();
	}

	private snapPoint(p: Vec2): Vec2 {
		const g = this.snap.grid;
		if (!g || g <= 0) return p;
		return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
	}

	private snapDelta(dx: number, dy: number, origin: Vec2 | null): { dx: number; dy: number } {
		const g = this.snap.grid;
		if (!g || g <= 0 || !origin) return { dx, dy };
		const target = this.snapPoint({ x: origin.x + dx, y: origin.y + dy });
		return { dx: target.x - origin.x, dy: target.y - origin.y };
	}

	// -------------------------------------------------------------------------
	// Document
	// -------------------------------------------------------------------------

	/** Replaces the document. Undoable unless `{ history: false }` (then history is cleared). */
	setDocument(doc: VectorDocument, options: { history?: boolean; label?: string } = {}): void {
		this.cancelDrag();
		const next = cloneVectorDocument(doc);
		if (options.history === false) {
			this.doc = next;
			this.selection = [];
			this.anchors = [];
			this.editingId = null;
			this.pen = null;
			this.history.clear();
			this.notify(true);
			return;
		}
		this.change(options.label ?? 'Replace Document', () => {
			this.doc = next;
			this.selection = [];
			this.anchors = [];
			this.editingId = null;
			this.pen = null;
		});
	}

	/** Changes the artboard size or background. */
	setArtboard(patch: Partial<Pick<VectorDocument, 'width' | 'height' | 'background'>>): void {
		this.change('Change Artboard', () => {
			this.doc = { ...this.doc, ...patch };
		});
	}

	/** Replaces the document with parsed SVG markup (one undo step). */
	loadSvg(svg: string, options: { history?: boolean } = {}): VectorActionResult {
		try {
			const doc = parseVectorSvg(svg, { createId: () => this.createId() });
			this.setDocument(doc, { history: options.history, label: 'Import SVG' });
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Adds the nodes of SVG markup on top of the document, selected. */
	importSvg(svg: string): VectorActionResult {
		try {
			const parsed = parseVectorSvg(svg);
			const nodes = parsed.nodes.map((n) => this.freshIds(n));
			if (!nodes.length) return { ok: false, message: 'The SVG has no shapes the editor can read.' };
			this.change('Import SVG', () => {
				this.setDoc([...this.doc.nodes, ...nodes]);
				this.selection = nodes.map((n) => n.id);
				this.anchors = [];
			});
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	toSvg(options?: VectorSvgExportOptions): string {
		return vectorDocumentToSvg(this.doc, options);
	}

	toJSON(): VectorDocument {
		return cloneVectorDocument(this.doc);
	}

	/** Adds a node (ids are kept unless taken). Returns its id. */
	addNode(node: VectorNode, options: AddVectorNodeOptions = {}): string {
		const taken = (() => {
			let clash = false;
			walkVectorNodes([node], (n) => {
				if (this.getNode(n.id)) clash = true;
			});
			return clash;
		})();
		const next = taken ? this.freshIds(node) : cloneVectorNode(node);
		this.change(options.label ?? `Add ${next.type === 'group' ? 'Group' : (next.name ?? 'Path')}`, () => {
			const insert = (list: VectorNode[]) => {
				const copy = list.slice();
				copy.splice(options.index ?? copy.length, 0, next);
				return copy;
			};
			if (options.parentId) {
				this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === options.parentId && n.type === 'group' ? { ...n, children: insert(n.children) } : n)));
			} else this.setDoc(insert(this.doc.nodes));
			if (options.select !== false) {
				this.selection = [next.id];
				this.anchors = [];
			}
		});
		return next.id;
	}

	/** Builds a path node for a shape with the current defaults (not added). */
	createShapeNode(input: VectorShapeInput): VectorPathNode {
		const b = { x: input.x, y: input.y, width: input.width, height: input.height };
		const d = this.defaults;
		let subpath: VectorSubpath;
		switch (input.kind) {
			case 'rect':
				subpath = rectSubpath(b, input.cornerRadius ?? d.cornerRadius);
				break;
			case 'ellipse':
				subpath = ellipseSubpath(b);
				break;
			case 'polygon':
				subpath = polygonSubpath(b, input.sides ?? d.polygonSides);
				break;
			case 'star':
				subpath = starSubpath(b, input.points ?? d.starPoints, input.innerRatio ?? d.starInnerRatio);
				break;
			case 'line':
				subpath = lineSubpath({ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height });
				break;
		}
		const names = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', line: 'Line' };
		const style = this.styleFor(input.kind === 'line');
		const own: VectorStyle = {};
		for (const key of ['fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'strokeDasharray', 'fillRule'] as const) {
			if (input[key] !== undefined) (own as any)[key] = input[key];
		}
		return { id: this.newId(), type: 'path', name: input.name ?? names[input.kind], ...style, ...own, subpaths: [subpath] };
	}

	/** Adds a shape drawn with the current defaults. Returns its id. */
	addShape(input: VectorShapeInput, options: AddVectorNodeOptions = {}): string {
		const node = this.createShapeNode(input);
		return this.addNode(node, { label: `Add ${node.name}`, ...options });
	}

	/** Adds a path from SVG path data. Returns its id. */
	addPath(d: string, style: VectorStyle & { name?: string } = {}, options: AddVectorNodeOptions = {}): string {
		const subpaths = bezierToSubpaths(d);
		const node: VectorPathNode = { id: this.newId(), type: 'path', name: style.name ?? 'Path', ...this.styleFor(false), ...style, subpaths };
		return this.addNode(node, { label: 'Add Path', ...options });
	}

	private styleFor(open: boolean): VectorStyle {
		const d = this.defaults;
		const out: VectorStyle = { fill: open ? null : (d.fill ?? null), stroke: d.stroke ?? null, strokeWidth: d.strokeWidth ?? 1 };
		if (d.strokeLinecap) out.strokeLinecap = d.strokeLinecap;
		if (d.strokeLinejoin) out.strokeLinejoin = d.strokeLinejoin;
		if (d.strokeDasharray) out.strokeDasharray = d.strokeDasharray;
		if (d.fillRule) out.fillRule = d.fillRule;
		return out;
	}

	/** Merges `patch` into a node (paths take style and geometry; groups name / visibility / opacity). */
	updateNode(id: string, patch: Partial<VectorPathNode> | Partial<VectorGroupNode>, options: { label?: string } = {}): VectorActionResult {
		const node = this.getNode(id);
		if (!node) return { ok: false, message: `There is no node "${id}".` };
		const { id: _id, type: _type, ...rest } = patch as any;
		this.change(options.label ?? 'Edit Node', () => this.replaceNode(id, { ...node, ...rest } as VectorNode));
		return { ok: true };
	}

	/** Applies style (and opacity) to the selected (or given) nodes; groups pass it to every path inside. */
	setStyle(style: VectorStyle & { opacity?: number }, ids: readonly string[] = this.selection, options: { label?: string } = {}): VectorActionResult {
		const targets = new Set<string>();
		for (const id of ids) {
			const node = this.getNode(id);
			if (!node) return { ok: false, message: `There is no node "${id}".` };
			for (const p of collectPathNodes(node)) targets.add(p.id);
		}
		if (!targets.size) return { ok: false, message: 'Nothing is selected.' };
		this.change(options.label ?? 'Change Style', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (targets.has(n.id) ? ({ ...n, ...style } as VectorNode) : n)));
		});
		return { ok: true };
	}

	rename(id: string, name: string): VectorActionResult {
		return this.updateNode(id, { name }, { label: 'Rename' });
	}

	setVisible(id: string, visible: boolean): VectorActionResult {
		return this.updateNode(id, { visible }, { label: visible ? 'Show' : 'Hide' });
	}

	setLocked(id: string, locked: boolean): VectorActionResult {
		const result = this.updateNode(id, { locked }, { label: locked ? 'Lock' : 'Unlock' });
		if (locked && result.ok && this.selection.includes(id)) {
			this.selection = this.selection.filter((s) => s !== id);
			this.notify();
		}
		return result;
	}

	/** Removes nodes by id. */
	removeNodes(ids: readonly string[], options: { label?: string } = {}): VectorActionResult {
		const drop = new Set(ids.filter((id) => this.getNode(id)));
		if (!drop.size) return { ok: false, message: 'Nothing to delete.' };
		this.change(options.label ?? 'Delete', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (drop.has(n.id) ? null : n)));
			this.selection = this.selection.filter((id) => !drop.has(id) && this.getNode(id));
			this.anchors = this.anchors.filter((r) => getAnchor(this.doc, r));
			if (this.editingId && !this.getNode(this.editingId)) this.editingId = null;
			if (this.pen && !this.getNode(this.pen.nodeId)) this.pen = null;
		});
		return { ok: true };
	}

	// -------------------------------------------------------------------------
	// Selection
	// -------------------------------------------------------------------------

	select(ids: readonly string[], options: { add?: boolean; toggle?: boolean } = {}): void {
		const valid = ids.filter((id) => this.getNode(id));
		let next: string[];
		if (options.toggle) {
			const set = new Set(this.selection);
			for (const id of valid) set.has(id) ? set.delete(id) : set.add(id);
			next = [...set];
		} else next = options.add ? [...new Set([...this.selection, ...valid])] : valid;
		this.selection = next;
		if (!options.add && !options.toggle) this.anchors = this.anchors.filter((r) => next.includes(r.nodeId));
		this.notify();
	}

	selectAll(): void {
		if (this.tool === 'direct' && this.editingId) {
			this.anchors = getVisibleAnchors(this.view());
		} else {
			this.selection = this.doc.nodes.filter((n) => !n.locked && n.visible !== false).map((n) => n.id);
		}
		this.notify();
	}

	clearSelection(): void {
		if (!this.selection.length && !this.anchors.length && !this.editingId) return;
		this.selection = [];
		this.anchors = [];
		this.editingId = null;
		this.notify();
	}

	selectAnchors(refs: readonly VectorAnchorRef[], options: { add?: boolean } = {}): void {
		const valid = refs.filter((r) => getAnchor(this.doc, r));
		this.anchors = options.add ? [...this.anchors, ...valid.filter((r) => !this.anchors.some((a) => sameRef(a, r)))] : valid;
		if (valid.length && !this.editingId) this.editingId = valid[0].nodeId;
		this.notify();
	}

	/** Top-level ids of the selection (members of selected groups are covered by the group). */
	private selectedRoots(): string[] {
		return this.selection.filter((id) => {
			let covered = false;
			const loc = locateVectorNode(this.doc.nodes, id);
			let parent = loc?.parent ?? null;
			while (parent) {
				if (this.selection.includes(parent.id)) covered = true;
				parent = locateVectorNode(this.doc.nodes, parent.id)?.parent ?? null;
			}
			return !covered;
		});
	}

	// -------------------------------------------------------------------------
	// Transforms
	// -------------------------------------------------------------------------

	/** `m`, given in a frame rotated by `angle`, as a document-space matrix. */
	private inFrame(angle: number, m: AffineMatrix): AffineMatrix {
		if (!angle) return m;
		return multiplyMatrices(multiplyMatrices(rotateMatrix(-angle), m), rotateMatrix(angle));
	}

	/** Applies a matrix to the selected (or given) nodes as one undo step. */
	transform(matrix: AffineMatrix, options: { ids?: readonly string[]; label?: string } = {}): VectorActionResult {
		const ids = new Set(options.ids ?? this.selectedRoots());
		if (!ids.size) return { ok: false, message: 'Nothing is selected.' };
		this.change(options.label ?? 'Transform', () => {
			this.doc = this.transformed(this.doc, ids, matrix);
		});
		return { ok: true };
	}

	/** `doc` with nodes `ids` moved by `m`, given in document space. */
	private transformed(doc: VectorDocument, ids: ReadonlySet<string>, m: AffineMatrix): VectorDocument {
		const visit = (list: readonly VectorNode[], parent: AffineMatrix): VectorNode[] => {
			let changed = false;
			const out = list.map((n) => {
				let next = n;
				if (ids.has(n.id) && !n.locked) {
					// `m` in the node's parent space: parent → document, m, document → parent.
					const local = isRoot(parent) ? m : multiplyMatrices(multiplyMatrices(parent, m), invertMatrix(parent));
					next = transformVectorNode(n, local);
				} else if (n.type === 'group') {
					const children = visit(n.children, multiplyMatrices(nodeMatrix(n), parent));
					if (children !== n.children) next = { ...n, children };
				}
				if (next !== n) changed = true;
				return next;
			});
			return changed ? out : (list as VectorNode[]);
		};
		const nodes = visit(doc.nodes, IDENTITY_MATRIX);
		return nodes === doc.nodes ? doc : { ...doc, nodes };
	}

	translate(dx: number, dy: number, options: { ids?: readonly string[] } = {}): VectorActionResult {
		if (this.tool === 'direct' && this.anchors.length && !options.ids) {
			this.change('Move Points', () => {
				this.doc = this.movedAnchors(this.doc, this.anchors, dx, dy);
			});
			return { ok: true };
		}
		return this.transform(translateMatrix(dx, dy), { ids: options.ids, label: 'Move' });
	}

	/** The selection frame's centre in document space. */
	private frameCenter(frame: VectorSelectionFrame): Vec2 {
		return applyMatrix(rotateMatrix(frame.angle), { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
	}

	/**
	 * Scales along the selection box's own axes (rotated with the selection when its nodes
	 * share a rotation) around `origin` (default: the box centre, in document space).
	 */
	scale(sx: number, sy: number = sx, options: { ids?: readonly string[]; origin?: Vec2 } = {}): VectorActionResult {
		const frame = this.frameOf(options.ids ?? this.selectedRoots());
		if (!frame) return { ok: false, message: 'Nothing is selected.' };
		const origin = applyMatrix(rotateMatrix(-frame.angle), options.origin ?? this.frameCenter(frame));
		return this.transform(this.inFrame(frame.angle, scaleMatrix(sx, sy, origin)), { ids: options.ids, label: 'Scale' });
	}

	/** Rotates clockwise by `degrees` around `origin` (default: the selection centre). */
	rotate(degrees: number, options: { ids?: readonly string[]; origin?: Vec2 } = {}): VectorActionResult {
		const frame = this.frameOf(options.ids ?? this.selectedRoots());
		if (!frame) return { ok: false, message: 'Nothing is selected.' };
		const origin = options.origin ?? this.frameCenter(frame);
		return this.transform(rotateMatrix(degrees, origin), { ids: options.ids, label: 'Rotate' });
	}

	/** Sets each selected (or given) node's rotation to `degrees`, turning it around its own centre. */
	setRotation(degrees: number, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const ids = options.ids ?? this.selectedRoots();
		if (!ids.length) return { ok: false, message: 'Nothing is selected.' };
		this.change('Set Rotation', () => {
			for (const id of ids) {
				const frame = this.frameOf([id]);
				if (!frame) continue;
				const delta = normalizeAngle(degrees - frame.angle);
				if (Math.abs(delta) > 1e-9) this.doc = this.transformed(this.doc, new Set([id]), rotateMatrix(delta, this.frameCenter(frame)));
			}
		});
		return { ok: true };
	}

	/** Mirrors along the selection box's own axes. */
	flip(axis: 'horizontal' | 'vertical', options: { ids?: readonly string[] } = {}): VectorActionResult {
		const frame = this.frameOf(options.ids ?? this.selectedRoots());
		if (!frame) return { ok: false, message: 'Nothing is selected.' };
		const c = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
		const m = axis === 'horizontal' ? scaleMatrix(-1, 1, c) : scaleMatrix(1, -1, c);
		return this.transform(this.inFrame(frame.angle, m), { ids: options.ids, label: axis === 'horizontal' ? 'Flip Horizontal' : 'Flip Vertical' });
	}

	/**
	 * Aligns the selected nodes to their combined bounds, or to the artboard when one node is
	 * selected (or `to: 'artboard'`).
	 */
	align(edge: VectorAlign, options: { ids?: readonly string[]; to?: 'selection' | 'artboard' } = {}): VectorActionResult {
		const ids = options.ids ?? this.selectedRoots();
		if (!ids.length) return { ok: false, message: 'Nothing is selected.' };
		const target = options.to === 'artboard' || ids.length === 1 ? { x: 0, y: 0, width: this.doc.width, height: this.doc.height } : this.boundsOf(ids)!;
		this.change(`Align ${edge[0].toUpperCase()}${edge.slice(1)}`, () => {
			for (const id of ids) {
				const b = this.boundsOf([id]);
				if (!b) continue;
				let dx = 0;
				let dy = 0;
				if (edge === 'left') dx = target.x - b.x;
				if (edge === 'center') dx = target.x + target.width / 2 - (b.x + b.width / 2);
				if (edge === 'right') dx = target.x + target.width - (b.x + b.width);
				if (edge === 'top') dy = target.y - b.y;
				if (edge === 'middle') dy = target.y + target.height / 2 - (b.y + b.height / 2);
				if (edge === 'bottom') dy = target.y + target.height - (b.y + b.height);
				if (dx || dy) this.doc = this.transformed(this.doc, new Set([id]), translateMatrix(dx, dy));
			}
		});
		return { ok: true };
	}

	/** Spaces three or more selected nodes evenly (equal gaps). */
	distribute(direction: VectorDistribute, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const ids = options.ids ?? this.selectedRoots();
		const items = ids.map((id) => ({ id, b: this.boundsOf([id]) })).filter((i): i is { id: string; b: VectorBounds } => !!i.b);
		if (items.length < 3) return { ok: false, message: 'Select at least three objects to distribute.' };
		const horizontal = direction === 'horizontal';
		const pos = (b: VectorBounds) => (horizontal ? b.x : b.y);
		const size = (b: VectorBounds) => (horizontal ? b.width : b.height);
		items.sort((a, b) => pos(a.b) - pos(b.b));
		const first = items[0].b;
		const last = items[items.length - 1].b;
		const total = pos(last) + size(last) - pos(first);
		const gap = (total - items.reduce((s, i) => s + size(i.b), 0)) / (items.length - 1);
		this.change(horizontal ? 'Distribute Horizontally' : 'Distribute Vertically', () => {
			let cursor = pos(first);
			for (const item of items) {
				const d = cursor - pos(item.b);
				if (Math.abs(d) > 1e-9) this.doc = this.transformed(this.doc, new Set([item.id]), horizontal ? translateMatrix(d, 0) : translateMatrix(0, d));
				cursor += size(item.b) + gap;
			}
		});
		return { ok: true };
	}

	// -------------------------------------------------------------------------
	// Structure
	// -------------------------------------------------------------------------

	/** Copies the selection (offset by `offset`, default 10, 10) on top of each original. */
	duplicate(options: { ids?: readonly string[]; offset?: Vec2 } = {}): string[] {
		const ids = options.ids ?? this.selectedRoots();
		const offset = options.offset ?? { x: 10, y: 10 };
		const created: string[] = [];
		if (!ids.length) return created;
		this.change('Duplicate', () => {
			this.doc = this.withDuplicates(this.doc, ids, offset, created);
			this.selection = created;
			this.anchors = [];
		});
		return created;
	}

	private withDuplicates(doc: VectorDocument, ids: readonly string[], offset: Vec2, created: string[]): VectorDocument {
		const set = new Set(ids);
		const m = translateMatrix(offset.x, offset.y);
		const insert = (list: readonly VectorNode[]): VectorNode[] => {
			const out: VectorNode[] = [];
			for (const node of list) {
				const n = node.type === 'group' ? { ...node, children: insert(node.children) } : node;
				out.push(n);
				if (set.has(node.id)) {
					const copy = transformVectorNode(this.freshIds(node), m);
					created.push(copy.id);
					out.push(copy);
				}
			}
			return out;
		};
		return { ...doc, nodes: insert(doc.nodes) };
	}

	/** Groups the selected nodes (they must share a parent). Returns the group id. */
	group(options: { ids?: readonly string[]; name?: string } = {}): string | null {
		const ids = options.ids ?? this.selectedRoots();
		if (!ids.length) return null;
		const locs = ids.map((id) => locateVectorNode(this.doc.nodes, id));
		if (locs.some((l) => !l)) return null;
		const parent = locs[0]!.parent?.id ?? null;
		if (locs.some((l) => (l!.parent?.id ?? null) !== parent)) return null;
		const id = this.newId();
		this.change('Group', () => {
			const set = new Set(ids);
			const regroup = (list: readonly VectorNode[]): VectorNode[] => {
				const members = list.filter((n) => set.has(n.id));
				const top = Math.max(...members.map((m) => list.indexOf(m)));
				const out: VectorNode[] = [];
				list.forEach((n, i) => {
					if (i === top) out.push({ id, type: 'group', name: options.name ?? 'Group', children: members });
					if (!set.has(n.id)) out.push(n);
				});
				return out;
			};
			if (parent === null) this.setDoc(regroup(this.doc.nodes));
			else this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === parent && n.type === 'group' ? { ...n, children: regroup(n.children) } : n)));
			this.selection = [id];
			this.anchors = [];
		});
		return id;
	}

	/** Replaces selected groups with their children. */
	ungroup(options: { ids?: readonly string[] } = {}): VectorActionResult {
		const groups = (options.ids ?? this.selection).map((id) => this.getNode(id)).filter((n): n is VectorGroupNode => n?.type === 'group');
		if (!groups.length) return { ok: false, message: 'Select a group to ungroup.' };
		const set = new Set(groups.map((g) => g.id));
		this.change('Ungroup', () => {
			const flatten = (list: readonly VectorNode[]): VectorNode[] => {
				const out: VectorNode[] = [];
				let changed = false;
				for (const n of list) {
					if (set.has(n.id) && n.type === 'group') {
						changed = true;
						const opacity = n.opacity;
						const m = nodeMatrix(n);
						out.push(
							...n.children
								.map((c) => (n.transform ? transformVectorNode(c, m) : c))
								.map((c) => (opacity !== undefined && opacity < 1 ? { ...c, opacity: (c.opacity ?? 1) * opacity } : c))
						);
					} else if (n.type === 'group') {
						const children = flatten(n.children);
						if (children !== n.children) changed = true;
						out.push(children !== n.children ? { ...n, children } : n);
					} else out.push(n);
				}
				return changed ? out : (list as VectorNode[]);
			};
			this.setDoc(flatten(this.doc.nodes));
			this.selection = groups.flatMap((g) => g.children.map((c) => c.id));
		});
		return { ok: true };
	}

	/** Changes stacking order within each node's parent. */
	arrange(op: VectorArrange, options: { ids?: readonly string[] } = {}): VectorActionResult {
		const set = new Set(options.ids ?? this.selectedRoots());
		if (!set.size) return { ok: false, message: 'Nothing is selected.' };
		const reorder = (list: readonly VectorNode[]): VectorNode[] => {
			const out = list.map((n) => (n.type === 'group' ? { ...n, children: reorder(n.children) } : n));
			if (op === 'front') return [...out.filter((n) => !set.has(n.id)), ...out.filter((n) => set.has(n.id))];
			if (op === 'back') return [...out.filter((n) => set.has(n.id)), ...out.filter((n) => !set.has(n.id))];
			if (op === 'forward') {
				for (let i = out.length - 2; i >= 0; i--) if (set.has(out[i].id) && !set.has(out[i + 1].id)) [out[i], out[i + 1]] = [out[i + 1], out[i]];
			} else {
				for (let i = 1; i < out.length; i++) if (set.has(out[i].id) && !set.has(out[i - 1].id)) [out[i], out[i - 1]] = [out[i - 1], out[i]];
			}
			return out;
		};
		const labels = { front: 'Bring to Front', forward: 'Bring Forward', backward: 'Send Backward', back: 'Send to Back' };
		this.change(labels[op], () => this.setDoc(reorder(this.doc.nodes)));
		return { ok: true };
	}

	/**
	 * Combines the selected paths (two or more) into one with a boolean operation. `subtract`
	 * removes the upper shapes from the lowest one. The result takes the lowest shape's style
	 * and place.
	 */
	booleanOp(op: VectorBooleanOperation, options: { ids?: readonly string[] } = {}): string | null {
		const roots = options.ids ?? this.selectedRoots();
		const order: string[] = [];
		walkVectorNodes(this.doc.nodes, (n) => {
			if (roots.includes(n.id)) for (const p of collectPathNodes(n)) order.push(p.id);
		});
		const paths = [...new Set(order)].map((id) => this.getNode(id) as VectorPathNode);
		if (paths.length < 2) return null;
		const result = pathBoolean(
			BOOLEAN_OPS[op],
			paths.map((p) => ({
				path: vectorPathWorldBezier(
					{ ...p, subpaths: p.subpaths.filter((s) => s.anchors.length > 1).map((s) => ({ ...s, closed: true })) },
					vectorParentMatrix(this.doc.nodes, p.id) ?? IDENTITY_MATRIX
				),
				fillRule: p.fillRule ?? 'nonzero'
			}))
		);
		const base = paths[0];
		const anchorRoot = roots.find((r) => findVectorNode([this.getNode(r)!], base.id)) ?? base.id;
		const subpaths = bezierToSubpaths(this.intoParentSpace(anchorRoot, result.path));
		if (result.error || !subpaths.length) return null;
		const id = this.newId();
		const { transform: _t, ...baseRest } = cloneVectorNode(base);
		const node: VectorPathNode = { ...baseRest, id, name: BOOLEAN_LABELS[op], subpaths };
		const drop = new Set([...paths.map((p) => p.id), ...roots]);
		this.change(BOOLEAN_LABELS[op], () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === anchorRoot ? node : drop.has(n.id) ? null : n)));
			this.selection = [id];
			this.anchors = [];
			this.editingId = null;
		});
		return id;
	}

	/** Joins the selected paths into one compound path (subpaths kept, lowest style). */
	combine(options: { ids?: readonly string[] } = {}): string | null {
		const roots = options.ids ?? this.selectedRoots();
		const paths: VectorPathNode[] = [];
		walkVectorNodes(this.doc.nodes, (n) => {
			if (roots.includes(n.id)) paths.push(...collectPathNodes(n));
		});
		if (paths.length < 2) return null;
		const id = this.newId();
		const first = roots.find((r) => findVectorNode([this.getNode(r)!], paths[0].id)) ?? paths[0].id;
		const subpaths = paths.flatMap((p) => bezierToSubpaths(this.intoParentSpace(first, vectorPathWorldBezier(p, vectorParentMatrix(this.doc.nodes, p.id) ?? IDENTITY_MATRIX))));
		const { transform: _t, ...baseRest } = cloneVectorNode(paths[0]);
		const node: VectorPathNode = { ...baseRest, id, name: 'Compound Path', subpaths };
		const drop = new Set([...paths.map((p) => p.id), ...roots]);
		this.change('Combine', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (n.id === first ? node : drop.has(n.id) ? null : n)));
			this.selection = [id];
			this.anchors = [];
		});
		return id;
	}

	/** A document-space path mapped into the parent space of node `id`. */
	private intoParentSpace(id: string, path: BezierPath): BezierPath {
		const parent = vectorParentMatrix(this.doc.nodes, id) ?? IDENTITY_MATRIX;
		return isRoot(parent) ? path : transformBezierPath(path, invertMatrix(parent));
	}

	/** Splits selected compound paths into one path per subpath. */
	breakApart(options: { ids?: readonly string[] } = {}): VectorActionResult {
		const paths = (options.ids ?? this.selection).map((id) => this.getNode(id)).filter((n): n is VectorPathNode => n?.type === 'path' && n.subpaths.length > 1);
		if (!paths.length) return { ok: false, message: 'Select a compound path to break apart.' };
		const created: string[] = [];
		const set = new Set(paths.map((p) => p.id));
		this.change('Break Apart', () => {
			const split = (list: readonly VectorNode[]): VectorNode[] =>
				list.flatMap((n): VectorNode[] => {
					if (n.type === 'group') return [{ ...n, children: split(n.children) }];
					if (!set.has(n.id)) return [n];
					return n.subpaths.map((sp, i) => {
						const id = i === 0 ? n.id : this.newId();
						created.push(id);
						return { ...n, id, subpaths: [sp] };
					});
				});
			this.setDoc(split(this.doc.nodes));
			this.selection = created;
		});
		return { ok: true };
	}

	// -------------------------------------------------------------------------
	// Anchor editing
	// -------------------------------------------------------------------------

	private updateAnchors(doc: VectorDocument, refs: readonly VectorAnchorRef[], fn: (a: VectorAnchor, ref: VectorAnchorRef) => VectorAnchor): VectorDocument {
		const byNode = new Map<string, VectorAnchorRef[]>();
		for (const r of refs) byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r]);
		const nodes = mapTree(doc.nodes, (n) => {
			const list = byNode.get(n.id);
			if (!list || n.type !== 'path' || n.locked) return n;
			const subpaths = n.subpaths.map((sp, s) => {
				const hits = list.filter((r) => r.subpath === s);
				if (!hits.length) return sp;
				return { closed: sp.closed, anchors: sp.anchors.map((a, i) => (hits.some((r) => r.index === i) ? fn(a, { nodeId: n.id, subpath: s, index: i }) : a)) };
			});
			return { ...n, subpaths };
		});
		return nodes === doc.nodes ? doc : { ...doc, nodes };
	}

	/** Moves anchors by a document-space offset (converted into each node's own space). */
	private movedAnchors(doc: VectorDocument, refs: readonly VectorAnchorRef[], dx: number, dy: number): VectorDocument {
		const local = new Map<string, Vec2>();
		for (const r of refs) if (!local.has(r.nodeId)) local.set(r.nodeId, applyMatrixLinear(invertMatrix(this.worldOf(r.nodeId, doc)), { x: dx, y: dy }));
		return this.updateAnchors(doc, refs, (a, ref) => {
			const d = local.get(ref.nodeId)!;
			return translateAnchor(a, d.x, d.y);
		});
	}

	/** Moves one anchor to a document position (handles follow). */
	moveAnchor(ref: VectorAnchorRef, to: Vec2): VectorActionResult {
		const a = getAnchorWorld(this.doc, ref);
		if (!a) return { ok: false, message: 'There is no such anchor.' };
		this.change('Move Point', () => {
			this.doc = this.movedAnchors(this.doc, [ref], to.x - a.x, to.y - a.y);
		});
		return { ok: true };
	}

	/** Moves one handle to a document position (see `moveAnchorHandle` for how the opposite handle follows). */
	moveHandle(ref: VectorHandleRef, to: Vec2, options: { breakHandles?: boolean } = {}): VectorActionResult {
		if (!getAnchor(this.doc, ref)) return { ok: false, message: 'There is no such anchor.' };
		const local = this.toLocal(ref.nodeId, to);
		this.change('Move Handle', () => {
			this.doc = this.updateAnchors(this.doc, [ref], (a) => moveAnchorHandle(a, ref.handle, local, options.breakHandles));
		});
		return { ok: true };
	}

	/** Converts the selected (or given) anchors between corner, smooth and symmetric. */
	convertAnchors(type: VectorAnchorType, refs: readonly VectorAnchorRef[] = this.anchors): VectorActionResult {
		if (!refs.length) return { ok: false, message: 'Select points to convert.' };
		this.change(type === 'corner' ? 'Make Corner' : 'Make Smooth', () => {
			const nodes = mapTree(this.doc.nodes, (n) => {
				if (n.type !== 'path') return n;
				const mine = refs.filter((r) => r.nodeId === n.id);
				if (!mine.length) return n;
				const subpaths = n.subpaths.map((sp, s) => mine.filter((r) => r.subpath === s).reduce((acc, r) => convertAnchor(acc, r.index, type), sp));
				return { ...n, subpaths };
			});
			this.setDoc(nodes);
		});
		return { ok: true };
	}

	/** Adds an anchor on the nearest segment of `nodeId` to document point `point` (shape unchanged). */
	insertAnchorAt(nodeId: string, point: Vec2): VectorAnchorRef | null {
		const node = this.getNode(nodeId);
		if (node?.type !== 'path') return null;
		const hit = nearestSegment(node, this.toLocal(nodeId, point));
		if (!hit) return null;
		const { subpath, index } = insertAnchor(node.subpaths[hit.subpath], hit.segment, hit.t);
		const ref = { nodeId, subpath: hit.subpath, index };
		this.change('Add Point', () => {
			this.replaceNode(nodeId, { ...node, subpaths: node.subpaths.map((sp, i) => (i === hit.subpath ? subpath : sp)) });
			this.editingId = nodeId;
			this.anchors = [ref];
		});
		return ref;
	}

	/** Deletes the selected anchors; empty subpaths and paths go too. */
	deleteAnchors(refs: readonly VectorAnchorRef[] = this.anchors): VectorActionResult {
		if (!refs.length) return { ok: false, message: 'Select points to delete.' };
		this.change('Delete Points', () => {
			const nodes = mapTree(this.doc.nodes, (n) => {
				if (n.type !== 'path') return n;
				const mine = refs.filter((r) => r.nodeId === n.id);
				if (!mine.length) return n;
				const subpaths = n.subpaths
					.map((sp, s) => removeAnchors(sp, mine.filter((r) => r.subpath === s).map((r) => r.index)))
					.filter((sp) => sp.anchors.length > 1);
				return subpaths.length ? { ...n, subpaths } : null;
			});
			this.setDoc(nodes);
			this.anchors = [];
			this.selection = this.selection.filter((id) => this.getNode(id));
			if (this.editingId && !this.getNode(this.editingId)) this.editingId = null;
			if (this.pen && !this.getNode(this.pen.nodeId)) this.pen = null;
		});
		return { ok: true };
	}

	/** Opens or closes the subpaths that contain selected anchors (or all subpaths of `nodeId`). */
	setClosed(closed: boolean, nodeId?: string): VectorActionResult {
		const targets = nodeId
			? (() => {
					const n = this.getNode(nodeId);
					return n?.type === 'path' ? n.subpaths.map((_, s) => ({ nodeId, subpath: s })) : [];
				})()
			: this.anchors.map((r) => ({ nodeId: r.nodeId, subpath: r.subpath }));
		if (!targets.length) return { ok: false, message: 'Select a path or points.' };
		this.change(closed ? 'Close Path' : 'Open Path', () => {
			this.setDoc(
				mapTree(this.doc.nodes, (n) =>
					n.type === 'path' && targets.some((t) => t.nodeId === n.id)
						? { ...n, subpaths: n.subpaths.map((sp, s) => (targets.some((t) => t.nodeId === n.id && t.subpath === s) ? { ...sp, closed } : sp)) }
						: n
				)
			);
		});
		return { ok: true };
	}

	/** Reverses the direction of every subpath of the selected paths. */
	reversePaths(ids: readonly string[] = this.selection): VectorActionResult {
		const set = new Set(ids.flatMap((id) => (this.getNode(id) ? collectPathNodes(this.getNode(id)!) : [])).map((p) => p.id));
		if (!set.size) return { ok: false, message: 'Select a path.' };
		this.change('Reverse Path', () => {
			this.setDoc(mapTree(this.doc.nodes, (n) => (n.type === 'path' && set.has(n.id) ? { ...n, subpaths: n.subpaths.map(reverseSubpath) } : n)));
			this.anchors = [];
		});
		return { ok: true };
	}

	/** Ends the pen path being drawn (a lone anchor is removed). */
	finishPath(): void {
		if (!this.pen) return;
		const node = this.getNode(this.pen.nodeId) as VectorPathNode | undefined;
		const sp = node?.subpaths[this.pen.subpath];
		const pen = this.pen;
		this.pen = null;
		this.pointer = null;
		if (node && sp && sp.anchors.length < 2) {
			const subpaths = node.subpaths.filter((_, i) => i !== pen.subpath);
			this.change('Delete Path', () => {
				this.replaceNode(node.id, subpaths.length ? { ...node, subpaths } : null);
				if (!subpaths.length) {
					this.selection = this.selection.filter((id) => id !== node.id);
					if (this.editingId === node.id) this.editingId = null;
				}
				this.anchors = [];
			});
			return;
		}
		this.notify();
	}

	// -------------------------------------------------------------------------
	// Clipboard
	// -------------------------------------------------------------------------

	/** Copies the selection. Returns JSON text for the system clipboard (or null). */
	copy(): string | null {
		const nodes = this.selectedRoots()
			.map((id) => this.getNode(id))
			.filter((n): n is VectorNode => !!n)
			.map((n) => cloneVectorNode(n));
		if (!nodes.length) return null;
		this.clipboard = nodes;
		return JSON.stringify({ type: VECTOR_CLIPBOARD_TYPE, nodes });
	}

	cut(): string | null {
		const text = this.copy();
		if (text) this.removeNodes(this.selectedRoots(), { label: 'Cut' });
		return text;
	}

	/**
	 * Pastes `text` (from `copy()`, or SVG markup) or the internal clipboard, offset by 10, 10.
	 * Returns the new ids.
	 */
	paste(text?: string, options: { offset?: Vec2 } = {}): string[] {
		let nodes: VectorNode[] | null = null;
		if (text) {
			const trimmed = text.trim();
			if (trimmed.startsWith('{')) {
				try {
					const data = JSON.parse(trimmed);
					if (data?.type === VECTOR_CLIPBOARD_TYPE && Array.isArray(data.nodes)) nodes = data.nodes;
				} catch {
					nodes = null;
				}
			} else if (/<svg[\s>]/i.test(trimmed)) {
				try {
					nodes = parseVectorSvg(trimmed).nodes;
				} catch {
					nodes = null;
				}
			}
		} else nodes = this.clipboard;
		if (!nodes?.length) return [];
		const offset = options.offset ?? (text && !text.trim().startsWith('{') ? { x: 0, y: 0 } : { x: 10, y: 10 });
		const copies = nodes.map((n) => transformVectorNode(this.freshIds(n), translateMatrix(offset.x, offset.y)));
		this.change('Paste', () => {
			this.setDoc([...this.doc.nodes, ...copies]);
			this.selection = copies.map((n) => n.id);
			this.anchors = [];
		});
		if (!text) this.clipboard = copies.map((n) => cloneVectorNode(n));
		return copies.map((n) => n.id);
	}

	// -------------------------------------------------------------------------
	// Undo
	// -------------------------------------------------------------------------

	undo(): boolean {
		this.cancelDrag();
		this.pen = null;
		return this.history.undo();
	}

	redo(): boolean {
		this.cancelDrag();
		return this.history.redo();
	}

	/** Deletes selected anchors (direct tool) or nodes. */
	deleteSelection(): VectorActionResult {
		if (this.tool === 'direct' && this.anchors.length) return this.deleteAnchors();
		return this.removeNodes(this.selectedRoots());
	}

	// -------------------------------------------------------------------------
	// Pointer input
	// -------------------------------------------------------------------------

	/** The fields the anchor / handle helpers read, without building a full state. */
	private view() {
		return { document: this.doc, selection: this.selection, editingId: this.editingId, tool: this.tool, pen: this.pen, selectedAnchors: this.anchors };
	}

	private tolerance() {
		return this.hitRadius / this.viewport.zoom;
	}

	private hitTransformHandle(screen: Vec2): VectorTransformHandle | null {
		if (this.tool !== 'select' || !this.selection.length) return null;
		const frame = this.frameOf(this.selectedRoots());
		if (!frame) return null;
		const { box, handles } = getVectorSelectionBoxGeometry(frame, this.viewport);
		const r = this.hitRadius + 2;
		// Tiny boxes: only corners and rotation, so the box can still be grabbed.
		const usable = box.width < 2 * r || box.height < 2 * r ? handles.filter((h) => h.handle.length === 2 || h.handle === 'rotate') : handles;
		for (const h of usable) if (Math.hypot(h.screen.x - screen.x, h.screen.y - screen.y) <= r * Math.SQRT2) return h.handle;
		return null;
	}

	private hitHandle(screen: Vec2): VectorHandleRef | null {
		for (const ref of getVisibleHandles(this.view()).reverse()) {
			const a = getAnchorWorld(this.doc, ref);
			const h = a?.[ref.handle];
			if (!h) continue;
			const s = this.documentToScreen(h);
			if (Math.hypot(s.x - screen.x, s.y - screen.y) <= this.hitRadius) return ref;
		}
		return null;
	}

	private hitAnchor(screen: Vec2, refs: readonly VectorAnchorRef[]): VectorAnchorRef | null {
		let best: VectorAnchorRef | null = null;
		let bestD = Infinity;
		for (const ref of refs) {
			const a = getAnchorWorld(this.doc, ref);
			if (!a) continue;
			const s = this.documentToScreen(a);
			const d = Math.hypot(s.x - screen.x, s.y - screen.y);
			if (d <= this.hitRadius && d < bestD) {
				best = ref;
				bestD = d;
			}
		}
		return best;
	}

	/** Deepest unlocked visible path under `p`. */
	private hitPath(p: Vec2): VectorPathNode | null {
		const tol = this.tolerance();
		const search = (list: readonly VectorNode[], parent: AffineMatrix): VectorPathNode | null => {
			for (let i = list.length - 1; i >= 0; i--) {
				const n = list[i];
				if (n.visible === false || n.locked) continue;
				if (n.type === 'group') {
					const found = search(n.children, multiplyMatrices(nodeMatrix(n), parent));
					if (found) return found;
				} else if (hitTestVectorNode(n, p, tol, parent)) return n;
			}
			return null;
		};
		return search(this.doc.nodes, IDENTITY_MATRIX);
	}

	/** Endpoints of open subpaths of unlocked visible paths (pen tool resumes from them). */
	private openEndpoints(): VectorAnchorRef[] {
		const out: VectorAnchorRef[] = [];
		walkVectorNodes(this.doc.nodes, (n) => {
			if (n.type !== 'path' || n.locked || n.visible === false) return;
			n.subpaths.forEach((sp, s) => {
				if (sp.closed || sp.anchors.length < 1) return;
				out.push({ nodeId: n.id, subpath: s, index: 0 });
				if (sp.anchors.length > 1) out.push({ nodeId: n.id, subpath: s, index: sp.anchors.length - 1 });
			});
		});
		return out;
	}

	private computeHover(screen: Vec2): VectorHover | null {
		const p = this.screenToDocument(screen);
		switch (this.tool) {
			case 'select': {
				const handle = this.hitTransformHandle(screen);
				if (handle) return { nodeId: null, transformHandle: handle };
				const node = hitTestVectorNodes(this.doc.nodes, p, this.tolerance());
				return node ? { nodeId: node.id } : null;
			}
			case 'direct': {
				const handle = this.hitHandle(screen);
				if (handle) return { nodeId: handle.nodeId, handle };
				const anchor = this.hitAnchor(screen, getVisibleAnchors(this.view()));
				if (anchor) return { nodeId: anchor.nodeId, anchor };
				for (const id of getEditablePathIds(this.view())) {
					const node = this.getNode(id) as VectorPathNode;
					const seg = nearestSegment(node, this.toLocal(id, p));
					if (seg && seg.distance <= this.tolerance()) {
						const point = applyMatrix(this.worldOf(id), seg.point);
						return { nodeId: id, segment: { nodeId: id, subpath: seg.subpath, segment: seg.segment, t: seg.t, point } };
					}
				}
				const path = this.hitPath(p);
				return path ? { nodeId: path.id } : null;
			}
			case 'pen': {
				const refs = this.pen ? [{ nodeId: this.pen.nodeId, subpath: this.pen.subpath, index: 0 }] : this.openEndpoints();
				const anchor = this.hitAnchor(screen, refs);
				return anchor ? { nodeId: anchor.nodeId, anchor } : null;
			}
			default:
				return null;
		}
	}

	private sameHover(a: VectorHover | null, b: VectorHover | null): boolean {
		return JSON.stringify(a) === JSON.stringify(b);
	}

	/** Primary button down on the canvas at `screen` (pixels relative to the canvas). */
	pointerDown(screen: Vec2, input: VectorPointerInput = {}): void {
		this.cancelDrag();
		if (input.button === 1 || this.spaceHeld) {
			this.drag = { kind: 'pan', start: screen, viewport: this.viewport };
			this.interaction = { type: 'pan' };
			this.notify();
			return;
		}
		if (input.button !== undefined && input.button !== 0) return;
		const p = this.screenToDocument(screen);
		this.pointer = p;
		switch (this.tool) {
			case 'select':
				return this.downSelect(screen, p, input);
			case 'direct':
				return this.downDirect(screen, p, input);
			case 'pen':
				return this.downPen(screen, p, input);
			case 'pencil':
				return this.downPencil(p);
			default:
				return this.downShape(p);
		}
	}

	private downSelect(screen: Vec2, p: Vec2, input: VectorPointerInput) {
		const handle = this.hitTransformHandle(screen);
		if (handle) {
			const frame = this.frameOf(this.selectedRoots())!;
			const before = this.snapshot();
			const center = applyMatrix(rotateMatrix(frame.angle), { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
			this.drag =
				handle === 'rotate'
					? { kind: 'rotate', start: p, center, before, base: this.doc }
					: { kind: 'scale', handle, start: p, frame, before, base: this.doc };
			this.interaction = handle === 'rotate' ? { type: 'rotate', angle: 0 } : { type: 'scale', handle, sx: 1, sy: 1 };
			this.notify();
			return;
		}
		const node = hitTestVectorNodes(this.doc.nodes, p, this.tolerance());
		if (node) {
			const selected = this.selection.includes(node.id);
			if (input.shift) {
				this.selection = selected ? this.selection.filter((id) => id !== node.id) : [...this.selection, node.id];
				if (selected) {
					this.notify();
					return;
				}
			} else if (!selected) this.selection = [node.id];
			this.anchors = [];
			const before = this.snapshot();
			this.drag = {
				kind: 'move',
				start: p,
				origin: this.boundsOf(this.selectedRoots()),
				before,
				base: this.doc,
				moved: false,
				duplicated: false,
				clickId: selected && !input.shift ? node.id : null
			};
			this.notify();
			return;
		}
		if (!input.shift) this.selection = [];
		this.drag = { kind: 'marquee', start: p, base: this.selection, baseAnchors: [], anchorsMode: false };
		this.interaction = { type: 'marquee', bounds: { x: p.x, y: p.y, width: 0, height: 0 } };
		this.notify();
	}

	private downDirect(screen: Vec2, p: Vec2, input: VectorPointerInput) {
		const handle = this.hitHandle(screen);
		if (handle) {
			this.drag = { kind: 'handle', ref: handle, before: this.snapshot(), base: this.doc };
			this.interaction = { type: 'handle', ref: handle };
			this.notify();
			return;
		}
		const anchor = this.hitAnchor(screen, getVisibleAnchors(this.view()));
		if (anchor) {
			const selected = this.anchors.some((a) => sameRef(a, anchor));
			this.editingId = anchor.nodeId;
			if (input.alt) {
				// Alt-drag an anchor pulls out fresh symmetric handles.
				this.anchors = [anchor];
				this.drag = { kind: 'pull', ref: anchor, before: this.snapshot(), base: this.doc, label: 'Make Smooth', outOnly: false, closing: false, altBreaks: false };
				this.notify();
				return;
			}
			if (input.shift) {
				this.anchors = selected ? this.anchors.filter((a) => !sameRef(a, anchor)) : [...this.anchors, anchor];
				if (selected) {
					this.notify();
					return;
				}
			} else if (!selected) this.anchors = [anchor];
			this.drag = { kind: 'anchors', start: p, before: this.snapshot(), base: this.doc, moved: false, clickRef: selected && !input.shift ? anchor : null };
			this.notify();
			return;
		}
		for (const id of getEditablePathIds(this.view())) {
			const node = this.getNode(id) as VectorPathNode;
			const seg = nearestSegment(node, this.toLocal(id, p));
			if (!seg || seg.distance > this.tolerance()) continue;
			const sp = node.subpaths[seg.subpath];
			if (input.alt) {
				const before = this.snapshot();
				const { subpath, index } = insertAnchor(sp, seg.segment, seg.t);
				this.replaceNode(id, { ...node, subpaths: node.subpaths.map((s, i) => (i === seg.subpath ? subpath : s)) });
				const ref = { nodeId: id, subpath: seg.subpath, index };
				this.anchors = [ref];
				this.editingId = id;
				this.drag = { kind: 'anchors', start: p, before, base: this.doc, moved: true, clickRef: null };
				this.notify(true);
				return;
			}
			const a = { nodeId: id, subpath: seg.subpath, index: seg.segment };
			const b = { nodeId: id, subpath: seg.subpath, index: (seg.segment + 1) % sp.anchors.length };
			this.anchors = input.shift ? [...this.anchors.filter((r) => !sameRef(r, a) && !sameRef(r, b)), a, b] : [a, b];
			this.editingId = id;
			this.drag = { kind: 'anchors', start: p, before: this.snapshot(), base: this.doc, moved: false, clickRef: null };
			this.notify();
			return;
		}
		const path = this.hitPath(p);
		if (path) {
			this.editingId = path.id;
			if (!input.shift) this.selection = [path.id];
			else if (!this.selection.includes(path.id)) this.selection = [...this.selection, path.id];
			this.anchors = path.subpaths.flatMap((sp, s) => sp.anchors.map((_, i) => ({ nodeId: path.id, subpath: s, index: i })));
			this.drag = { kind: 'anchors', start: p, before: this.snapshot(), base: this.doc, moved: false, clickRef: null };
			this.notify();
			return;
		}
		if (!input.shift) {
			this.anchors = [];
		}
		this.drag = { kind: 'marquee', start: p, base: this.selection, baseAnchors: this.anchors, anchorsMode: getEditablePathIds(this.view()).length > 0 };
		this.interaction = { type: 'marquee', bounds: { x: p.x, y: p.y, width: 0, height: 0 } };
		this.notify();
	}

	private downPen(screen: Vec2, p: Vec2, input: VectorPointerInput) {
		const before = this.snapshot();
		const sp = this.pen ? (this.getNode(this.pen.nodeId) as VectorPathNode | undefined)?.subpaths[this.pen.subpath] : undefined;
		if (this.pen && sp) {
			const pen = this.pen;
			const first = { nodeId: pen.nodeId, subpath: pen.subpath, index: 0 };
			if (sp.anchors.length >= 2 && this.hitAnchor(screen, [first])) {
				const node = this.getNode(pen.nodeId) as VectorPathNode;
				this.replaceNode(pen.nodeId, { ...node, subpaths: node.subpaths.map((s, i) => (i === pen.subpath ? { ...s, closed: true } : s)) });
				this.drag = { kind: 'pull', ref: first, before, base: this.doc, label: 'Close Path', outOnly: false, closing: true, altBreaks: true };
				this.interaction = { type: 'pen', nodeId: pen.nodeId };
				this.notify(true);
				return;
			}
			let pt = this.snapPoint(p);
			const last = getAnchorWorld(this.doc, { nodeId: pen.nodeId, subpath: pen.subpath, index: sp.anchors.length - 1 })!;
			if (input.shift) pt = constrain45(last, pt);
			pt = this.toLocal(pen.nodeId, pt);
			const node = this.getNode(pen.nodeId) as VectorPathNode;
			const anchors = [...sp.anchors, { x: pt.x, y: pt.y }];
			this.replaceNode(pen.nodeId, { ...node, subpaths: node.subpaths.map((s, i) => (i === pen.subpath ? { ...s, anchors } : s)) });
			const ref = { nodeId: pen.nodeId, subpath: pen.subpath, index: anchors.length - 1 };
			this.anchors = [ref];
			this.drag = { kind: 'pull', ref, before, base: this.doc, label: 'Add Point', outOnly: false, closing: false, altBreaks: true };
			this.interaction = { type: 'pen', nodeId: pen.nodeId };
			this.notify(true);
			return;
		}
		const endpoint = this.hitAnchor(screen, this.openEndpoints());
		if (endpoint) {
			let node = this.getNode(endpoint.nodeId) as VectorPathNode;
			let index = endpoint.index;
			if (index === 0 && node.subpaths[endpoint.subpath].anchors.length > 1) {
				node = { ...node, subpaths: node.subpaths.map((s, i) => (i === endpoint.subpath ? reverseSubpath(s) : s)) };
				this.replaceNode(node.id, node);
				index = node.subpaths[endpoint.subpath].anchors.length - 1;
			}
			this.pen = { nodeId: node.id, subpath: endpoint.subpath };
			this.selection = [node.id];
			this.editingId = node.id;
			const ref = { nodeId: node.id, subpath: endpoint.subpath, index };
			this.anchors = [ref];
			this.drag = { kind: 'pull', ref, before, base: this.doc, label: 'Continue Path', outOnly: true, closing: false, altBreaks: true };
			this.interaction = { type: 'pen', nodeId: node.id };
			this.notify(this.doc !== before.doc);
			return;
		}
		const pt = this.snapPoint(p);
		const node: VectorPathNode = { id: this.newId(), type: 'path', name: 'Path', ...this.styleFor(true), subpaths: [{ anchors: [{ x: pt.x, y: pt.y }], closed: false }] };
		this.setDoc([...this.doc.nodes, node]);
		this.pen = { nodeId: node.id, subpath: 0 };
		this.selection = [node.id];
		this.editingId = node.id;
		const ref = { nodeId: node.id, subpath: 0, index: 0 };
		this.anchors = [ref];
		this.drag = { kind: 'pull', ref, before, base: this.doc, label: 'Start Path', outOnly: false, closing: false, altBreaks: true };
		this.interaction = { type: 'pen', nodeId: node.id };
		this.notify(true);
	}

	private downPencil(p: Vec2) {
		const before = this.snapshot();
		const node: VectorPathNode = {
			id: this.newId(),
			type: 'path',
			name: 'Pencil',
			...this.styleFor(true),
			strokeLinecap: this.defaults.strokeLinecap ?? 'round',
			strokeLinejoin: this.defaults.strokeLinejoin ?? 'round',
			subpaths: [{ anchors: [{ x: p.x, y: p.y }], closed: false }]
		};
		this.setDoc([...this.doc.nodes, node]);
		this.drag = { kind: 'pencil', nodeId: node.id, points: [[p.x, p.y]], before };
		this.interaction = { type: 'draw', tool: 'pencil', nodeId: node.id, bounds: { x: p.x, y: p.y, width: 0, height: 0 } };
		this.notify(true);
	}

	private downShape(p: Vec2) {
		const before = this.snapshot();
		const start = this.snapPoint(p);
		const kind = this.tool as VectorShapeInput['kind'];
		const node = this.createShapeNode({ kind, x: start.x, y: start.y, width: 0, height: 0 });
		this.setDoc([...this.doc.nodes, node]);
		this.drag = { kind: 'shape', tool: this.tool, start, nodeId: node.id, before };
		this.interaction = { type: 'draw', tool: this.tool, nodeId: node.id, bounds: { x: start.x, y: start.y, width: 0, height: 0 } };
		this.notify(true);
	}

	/** Pointer moved over the canvas (with or without a button down). */
	pointerMove(screen: Vec2, input: VectorPointerInput = {}): void {
		const p = this.screenToDocument(screen);
		const drag = this.drag;
		if (!drag) {
			const hover = this.computeHover(screen);
			const pointerMatters = this.tool === 'pen' && !!this.pen;
			if (this.sameHover(hover, this.hover) && !pointerMatters) return;
			this.hover = hover;
			this.pointer = p;
			this.notify();
			return;
		}
		this.pointer = p;
		switch (drag.kind) {
			case 'pan':
				this.viewport = { ...drag.viewport, x: drag.viewport.x + screen.x - drag.start.x, y: drag.viewport.y + screen.y - drag.start.y };
				this.notify();
				return;
			case 'move': {
				let dx = p.x - drag.start.x;
				let dy = p.y - drag.start.y;
				if (!drag.moved && Math.hypot(dx, dy) * this.viewport.zoom < 2) return;
				drag.moved = true;
				if (input.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
				if (input.alt && !drag.duplicated) {
					drag.duplicated = true;
					const created: string[] = [];
					drag.base = this.withDuplicates(drag.base, this.selectedRoots(), { x: 0, y: 0 }, created);
					this.selection = created;
				}
				({ dx, dy } = this.snapDelta(dx, dy, drag.origin));
				this.doc = this.transformed(drag.base, new Set(this.selectedRoots()), translateMatrix(dx, dy));
				this.interaction = { type: 'move', dx, dy };
				this.notify(true);
				return;
			}
			case 'scale': {
				// Scale in the box's own (possibly rotated) frame.
				const angle = drag.frame.angle;
				const q = angle ? applyMatrix(rotateMatrix(-angle), p) : p;
				const { sx, sy, origin } = scaleFor(drag.handle, drag.frame, q, input);
				const ids = new Set(this.selectedRoots());
				this.doc = this.transformed(drag.base, ids, this.inFrame(angle, scaleMatrix(sx, sy, origin)));
				this.interaction = { type: 'scale', handle: drag.handle, sx, sy };
				this.notify(true);
				return;
			}
			case 'rotate': {
				const a0 = Math.atan2(drag.start.y - drag.center.y, drag.start.x - drag.center.x);
				const a1 = Math.atan2(p.y - drag.center.y, p.x - drag.center.x);
				let angle = ((a1 - a0) * 180) / Math.PI;
				if (input.shift) angle = Math.round(angle / 15) * 15;
				this.doc = this.transformed(drag.base, new Set(this.selectedRoots()), rotateMatrix(angle, drag.center));
				this.interaction = { type: 'rotate', angle };
				this.notify(true);
				return;
			}
			case 'marquee': {
				const bounds = boundsFromPoints(drag.start, p);
				this.interaction = { type: 'marquee', bounds };
				if (drag.anchorsMode) {
					const inside = getVisibleAnchors(this.view()).filter((r) => {
						const a = getAnchorWorld(this.doc, r)!;
						return a.x >= bounds.x && a.x <= bounds.x + bounds.width && a.y >= bounds.y && a.y <= bounds.y + bounds.height;
					});
					this.anchors = [...drag.baseAnchors, ...inside.filter((r) => !drag.baseAnchors.some((b) => sameRef(b, r)))];
				} else {
					const hits = this.doc.nodes
						.filter((n) => !n.locked && n.visible !== false)
						.filter((n) => {
							const b = vectorNodeBounds(n);
							return b && boundsIntersect(b, bounds);
						})
						.map((n) => n.id);
					this.selection = [...new Set([...drag.base, ...hits])];
				}
				this.notify();
				return;
			}
			case 'anchors': {
				let dx = p.x - drag.start.x;
				let dy = p.y - drag.start.y;
				if (!drag.moved && Math.hypot(dx, dy) * this.viewport.zoom < 2) return;
				drag.moved = true;
				if (input.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
				const lead = this.anchors.length ? getAnchorWorld(drag.base, this.anchors[0]) : undefined;
				({ dx, dy } = this.snapDelta(dx, dy, lead ?? null));
				this.doc = this.movedAnchors(drag.base, this.anchors, dx, dy);
				this.interaction = { type: 'anchors', dx, dy };
				this.notify(true);
				return;
			}
			case 'handle': {
				const anchor = getAnchorWorld(drag.base, drag.ref);
				let pt = this.snapPoint(p);
				if (input.shift && anchor) pt = constrain45(anchor, pt);
				const local = this.toLocal(drag.ref.nodeId, pt, drag.base);
				this.doc = this.updateAnchors(drag.base, [drag.ref], (a) => moveAnchorHandle(a, drag.ref.handle, local, input.alt));
				this.interaction = { type: 'handle', ref: drag.ref };
				this.notify(true);
				return;
			}
			case 'pull': {
				const anchor = getAnchorWorld(drag.base, drag.ref);
				if (!anchor) return;
				if (Math.hypot(p.x - anchor.x, p.y - anchor.y) * this.viewport.zoom < 2) {
					this.doc = drag.base;
					this.notify(true);
					return;
				}
				let pt = p;
				if (input.shift) pt = constrain45(anchor, pt);
				const side = drag.closing ? 'in' : 'out';
				// Dragging out of the closing anchor pulls its incoming handle toward the pointer's mirror.
				const pos = this.toLocal(drag.ref.nodeId, drag.closing ? { x: 2 * anchor.x - pt.x, y: 2 * anchor.y - pt.y } : pt, drag.base);
				this.doc = this.updateAnchors(drag.base, [drag.ref], (a) => {
					if (drag.outOnly || (drag.altBreaks && input.alt)) return moveAnchorHandle(a, side, pos, true);
					return moveAnchorHandle({ ...a, type: 'symmetric' }, side, pos);
				});
				this.notify(true);
				return;
			}
			case 'shape': {
				const node = this.getNode(drag.nodeId);
				if (node?.type !== 'path') return;
				let end = this.snapPoint(p);
				let start = drag.start;
				let bounds: VectorBounds;
				if (drag.tool === 'line') {
					if (input.shift) end = constrain45(start, end);
					if (input.alt) start = { x: 2 * start.x - end.x, y: 2 * start.y - end.y };
					bounds = { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
				} else {
					let w = end.x - start.x;
					let h = end.y - start.y;
					if (input.shift) {
						const s = Math.max(Math.abs(w), Math.abs(h));
						w = Math.sign(w || 1) * s;
						h = Math.sign(h || 1) * s;
					}
					if (input.alt) start = { x: start.x - w, y: start.y - h };
					const x2 = drag.start.x + w;
					const y2 = drag.start.y + h;
					bounds = boundsFromPoints(start, { x: x2, y: y2 });
				}
				const shaped = this.createShapeNode({ kind: drag.tool as VectorShapeInput['kind'], ...bounds });
				this.replaceNode(drag.nodeId, { ...node, subpaths: shaped.subpaths });
				this.interaction = { type: 'draw', tool: drag.tool, nodeId: drag.nodeId, bounds };
				this.notify(true);
				return;
			}
			case 'pencil': {
				const last = drag.points[drag.points.length - 1];
				if (Math.hypot(p.x - last[0], p.y - last[1]) * this.viewport.zoom < 1.5) return;
				drag.points.push([p.x, p.y]);
				const node = this.getNode(drag.nodeId);
				if (node?.type !== 'path') return;
				this.replaceNode(drag.nodeId, { ...node, subpaths: [{ anchors: drag.points.map(([x, y]) => ({ x, y })), closed: false }] });
				const xs = drag.points.map((q) => q[0]);
				const ys = drag.points.map((q) => q[1]);
				this.interaction = {
					type: 'draw',
					tool: 'pencil',
					nodeId: drag.nodeId,
					bounds: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
				};
				this.notify(true);
				return;
			}
		}
	}

	/** Primary button released. */
	pointerUp(screen?: Vec2, input: VectorPointerInput = {}): void {
		if (screen && this.drag && this.drag.kind !== 'pan') this.pointerMove(screen, input);
		const drag = this.drag;
		this.drag = null;
		this.interaction = null;
		if (!drag) return;
		switch (drag.kind) {
			case 'pan':
			case 'marquee':
				this.notify();
				return;
			case 'move':
				if (!drag.moved) {
					if (drag.clickId) this.selection = [drag.clickId];
					this.notify();
					return;
				}
				return this.commit(drag.duplicated ? 'Duplicate' : 'Move', drag.before);
			case 'scale':
				return this.commit('Scale', drag.before);
			case 'rotate':
				return this.commit('Rotate', drag.before);
			case 'anchors':
				if (!drag.moved) {
					if (drag.clickRef) this.anchors = [drag.clickRef];
					if (drag.before.doc !== this.doc) return this.commit('Add Point', drag.before);
					this.notify();
					return;
				}
				return this.commit(drag.before.doc !== drag.base ? 'Add Point' : 'Move Points', drag.before);
			case 'handle':
				return this.commit('Move Handle', drag.before);
			case 'pull':
				if (drag.closing) this.pen = null;
				return this.commit(drag.label, drag.before);
			case 'shape': {
				const node = this.getNode(drag.nodeId);
				const b = node ? vectorNodeBounds(node) : null;
				const min = 2 / this.viewport.zoom;
				if (!b || (b.width < min && b.height < min)) {
					this.doc = drag.before.doc;
					this.notify(true);
					return;
				}
				this.selection = [drag.nodeId];
				this.anchors = [];
				this.tool = 'select';
				return this.commit(`Draw ${TOOL_LABELS[drag.tool]}`, drag.before);
			}
			case 'pencil': {
				const node = this.getNode(drag.nodeId);
				if (node?.type !== 'path' || drag.points.length < 2) {
					this.doc = drag.before.doc;
					this.notify(true);
					return;
				}
				const fitted = fitCubics(drag.points, 1.5 / this.viewport.zoom, { cornerAngleDeg: 60 });
				const anchors: VectorAnchor[] = [];
				for (const c of fitted) {
					if (!anchors.length) anchors.push({ x: c.p0[0], y: c.p0[1] });
					anchors[anchors.length - 1].out = { x: c.p1[0], y: c.p1[1] };
					anchors.push({ x: c.p3[0], y: c.p3[1], in: { x: c.p2[0], y: c.p2[1] } });
				}
				const subpaths = anchors.length > 1 ? bezierToSubpaths(subpathsToBezier([{ anchors, closed: false }])) : node.subpaths;
				this.replaceNode(drag.nodeId, { ...node, subpaths });
				this.selection = [drag.nodeId];
				return this.commit('Draw', drag.before);
			}
		}
	}

	/** The pointer left the canvas. */
	pointerLeave(): void {
		if (this.drag) return;
		if (!this.hover && !this.pointer) return;
		this.hover = null;
		this.pointer = null;
		this.notify();
	}

	/** Abandons the drag in progress (Escape, lost capture). */
	cancelDrag(): void {
		const drag = this.drag;
		if (!drag) return;
		this.drag = null;
		this.interaction = null;
		if (drag.kind === 'pan') {
			this.notify();
			return;
		}
		if (drag.kind === 'marquee') {
			this.selection = drag.base;
			this.anchors = drag.baseAnchors;
			this.notify();
			return;
		}
		this.restore(drag.before);
	}

	/** Double click: select tool enters path editing, direct tool toggles an anchor or adds one. */
	doubleClick(screen: Vec2): void {
		const p = this.screenToDocument(screen);
		if (this.tool === 'select') {
			const path = this.hitPath(p);
			if (!path) return;
			this.tool = 'direct';
			this.selection = [path.id];
			this.editingId = path.id;
			this.anchors = [];
			this.notify();
			return;
		}
		if (this.tool === 'direct') {
			const anchor = this.hitAnchor(screen, getVisibleAnchors(this.view()));
			if (anchor) {
				const a = getAnchor(this.doc, anchor)!;
				this.convertAnchors(a.in || a.out ? 'corner' : 'smooth', [anchor]);
				return;
			}
			const id = this.hover?.segment?.nodeId ?? this.editingId;
			if (id) {
				const node = this.getNode(id) as VectorPathNode | undefined;
				const seg = node ? nearestSegment(node, this.toLocal(id, p)) : null;
				if (seg && seg.distance <= this.tolerance()) this.insertAnchorAt(id, p);
			}
			return;
		}
		if (this.tool === 'pen') this.finishPath();
	}

	// -------------------------------------------------------------------------
	// Keyboard input
	// -------------------------------------------------------------------------

	/**
	 * Handles editor shortcuts. Returns true when the key was used (call `preventDefault`).
	 * Do not forward keys typed into text inputs.
	 */
	keyDown(input: VectorKeyInput): boolean {
		const key = input.key;
		const lower = key.length === 1 ? key.toLowerCase() : key;
		if (key === ' ') {
			if (!this.spaceHeld) {
				this.spaceHeld = true;
				this.notify();
			}
			return true;
		}
		if (input.mod) {
			switch (lower) {
				case 'z':
					input.shift ? this.redo() : this.undo();
					return true;
				case 'y':
					this.redo();
					return true;
				case 'a':
					this.selectAll();
					return true;
				case 'd':
					this.duplicate();
					return true;
				case 'g':
					input.shift ? this.ungroup() : this.group();
					return true;
				case ']':
					this.arrange(input.alt ? 'front' : 'forward');
					return true;
				case '[':
					this.arrange(input.alt ? 'back' : 'backward');
					return true;
				case '=':
				case '+':
					this.setViewport({ zoom: this.viewport.zoom * 1.25 });
					return true;
				case '-':
					this.setViewport({ zoom: this.viewport.zoom / 1.25 });
					return true;
				case '0':
					this.setViewport({ zoom: 1 });
					return true;
			}
			return false;
		}
		switch (key) {
			case 'Escape':
				if (this.drag) this.cancelDrag();
				else if (this.pen) this.finishPath();
				else if (this.tool === 'direct' && this.anchors.length) {
					this.anchors = [];
					this.notify();
				} else if (this.tool !== 'select') this.setTool('select');
				else this.clearSelection();
				return true;
			case 'Enter':
				if (this.pen) {
					this.finishPath();
					return true;
				}
				if (this.tool === 'select' && this.selection.length === 1 && this.getNode(this.selection[0])?.type === 'path') {
					this.tool = 'direct';
					this.editingId = this.selection[0];
					this.notify();
					return true;
				}
				return false;
			case 'Delete':
			case 'Backspace':
				if (this.pen) {
					const node = this.getNode(this.pen.nodeId) as VectorPathNode;
					const sp = node.subpaths[this.pen.subpath];
					if (sp.anchors.length > 2) this.deleteAnchors([{ nodeId: node.id, subpath: this.pen.subpath, index: sp.anchors.length - 1 }]);
					else {
						this.removeNodes([node.id], { label: 'Delete Path' });
						this.pen = null;
					}
					return true;
				}
				return this.deleteSelection().ok;
			case 'ArrowLeft':
			case 'ArrowRight':
			case 'ArrowUp':
			case 'ArrowDown': {
				const step = input.shift ? 10 : 1;
				const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
				const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
				return this.translate(dx, dy).ok;
			}
		}
		if (key.length === 1 && !input.alt) {
			const tool = TOOL_KEYS[lower];
			if (tool) {
				this.setTool(tool);
				return true;
			}
		}
		return false;
	}

	keyUp(input: VectorKeyInput): void {
		if (input.key === ' ' && this.spaceHeld) {
			this.spaceHeld = false;
			this.notify();
		}
	}
}

/** Snaps `p` to the nearest 45° direction from `origin`, keeping its distance. */
function constrain45(origin: Vec2, p: Vec2): Vec2 {
	const dx = p.x - origin.x;
	const dy = p.y - origin.y;
	const len = Math.hypot(dx, dy);
	const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
	return { x: origin.x + Math.cos(a) * len, y: origin.y + Math.sin(a) * len };
}

/** Scale factors and origin for dragging a selection-box handle to `p`. */
export function scaleFor(handle: VectorTransformHandle, b: VectorBounds, p: Vec2, mods: VectorModifiers = {}): { sx: number; sy: number; origin: Vec2 } {
	const west = handle.includes('w');
	const east = handle.includes('e');
	const north = handle.startsWith('n');
	const south = handle.startsWith('s');
	const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	const origin = mods.alt ? center : { x: west ? b.x + b.width : east ? b.x : center.x, y: north ? b.y + b.height : south ? b.y : center.y };
	const reachX = mods.alt ? b.width / 2 : b.width;
	const reachY = mods.alt ? b.height / 2 : b.height;
	let sx = west || east ? (reachX > 1e-9 ? ((p.x - origin.x) * (west ? -1 : 1)) / reachX : 1) : 1;
	let sy = north || south ? (reachY > 1e-9 ? ((p.y - origin.y) * (north ? -1 : 1)) / reachY : 1) : 1;
	if (mods.shift) {
		if ((west || east) && (north || south)) {
			const s = Math.max(Math.abs(sx), Math.abs(sy));
			sx = Math.sign(sx || 1) * s;
			sy = Math.sign(sy || 1) * s;
		} else if (west || east) sy = Math.abs(sx);
		else sx = Math.abs(sy);
	}
	return { sx, sy, origin };
}
