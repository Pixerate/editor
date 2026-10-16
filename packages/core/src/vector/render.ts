/**
 * Framework-neutral render data for a vector editor: the scene (document-space SVG paths and
 * gradient defs) and the overlay (screen-space selection box, anchors, handles, marquee and
 * pen preview). React, Svelte or plain DOM code turns these into `<svg>` elements.
 */
import { bezierPathToSvg, transformBezierPath } from '../canvas/pathops/bezier.js';
import type { SvgGradientDef } from '../canvas/gradient.js';

export type { SvgGradientDef };
import {
	getAnchorWorld,
	getVectorCornerWidgets,
	getVectorSelectionBoxGeometry,
	getVisibleAnchors,
	getVisibleHandles,
	type VectorEditorController,
	type VectorEditorState,
	type VectorSelectionBoxGeometry
} from './controller.js';
import {
	findVectorNode,
	IDENTITY_MATRIX,
	inferAnchorType,
	multiplyMatrices,
	nodeMatrix,
	vectorNodeBounds,
	vectorParentMatrix,
	vectorPathData,
	vectorPathWorldBezier,
	type AffineMatrix
} from './geometry.js';
import { vectorPaintToSvg, vectorStrokeSvgParts, type VectorRenderStrokeParts } from './svg.js';
import { vectorCorners } from './corners.js';
import type { VectorGuideKind, VectorSnapKind } from './snap.js';
import type {
	VectorAnchorRef,
	VectorAnchorType,
	VectorArrowAlign,
	VectorArrowhead,
	VectorBounds,
	VectorCornerKind,
	VectorHandleRef,
	VectorNode,
	VectorPaint,
	VectorPathNode,
	VectorStrokeAlign,
	VectorTransformHandle,
	Vec2
} from './types.js';

export interface VectorRenderPath {
	kind: 'path';
	id: string;
	/** SVG `transform` (`matrix(…)`) for a rotated node. */
	transform?: string;
	d: string;
	/** `none`, a colour, or `url(#id)` of a gradient in `defs`. */
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeLinecap?: string;
	strokeLinejoin?: string;
	strokeDasharray?: string;
	fillRule: 'nonzero' | 'evenodd';
	opacity: number;
	/**
	 * Set when the stroke takes more than one element: an inside / outside alignment or
	 * arrowheads. Draw `d` with the fill only, then `stroke.d` with the stroke (at
	 * `stroke.width`, clipped or masked as `stroke.clip` says), then each head filled with
	 * `stroke`; group them under `id`, `transform` and `opacity`.
	 */
	strokeParts?: VectorRenderStrokeParts;
}

export interface VectorRenderGroup {
	kind: 'group';
	id: string;
	/** SVG `transform` (`matrix(…)`) for a rotated group. */
	transform?: string;
	opacity: number;
	children: VectorRenderNode[];
}

export type VectorRenderNode = VectorRenderPath | VectorRenderGroup;

export interface VectorSceneRenderData {
	/** SVG `transform` for the document layer: `translate(x y) scale(zoom)`. */
	transform: string;
	width: number;
	height: number;
	background?: string;
	/** Gradients referenced by `fill` / `stroke` values. */
	defs: SvgGradientDef[];
	/** Visible nodes, bottom to top. */
	nodes: VectorRenderNode[];
}

export interface VectorRenderAnchor {
	ref: VectorAnchorRef;
	/** Screen position. */
	x: number;
	y: number;
	type: VectorAnchorType;
	selected: boolean;
	hovered: boolean;
	/** The pen tool closes the path when this anchor is clicked. */
	closes: boolean;
}

export interface VectorRenderHandle {
	ref: VectorHandleRef;
	x: number;
	y: number;
	/** Screen position of the handle's anchor (draw a line to it). */
	anchorX: number;
	anchorY: number;
	hovered: boolean;
}

/** A live corner widget in screen pixels. */
export interface VectorRenderCornerWidget {
	ref: VectorAnchorRef;
	x: number;
	y: number;
	radius: number;
	kind: VectorCornerKind;
	hovered: boolean;
	/** Its corners are being dragged. */
	active: boolean;
}

/** A smart guide line in screen pixels. */
export interface VectorRenderGuideLine {
	kind: VectorGuideKind;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

/** A smart guide label ("anchor", "intersect", "align", "centre", a gap or a size) at a screen position. */
export interface VectorRenderGuideLabel {
	kind: VectorSnapKind;
	x: number;
	y: number;
	text: string;
}

export interface VectorOverlayRenderData {
	/** Outlines (screen-space path data) of hovered and selected nodes. */
	outlines: { id: string; d: string; selected: boolean }[];
	/**
	 * Selection box with resize and rotate handles (select tool). `x / y / width / height` and
	 * each handle's `x / y` are the unrotated box in screen pixels: draw them inside
	 * `<g transform={transform}>`. `corners` and each handle's `screen` are true positions.
	 */
	selectionBox:
		| (VectorBounds & { angle: number; transform: string; corners: Vec2[]; handles: VectorSelectionBoxGeometry['handles'] })
		| null;
	anchors: VectorRenderAnchor[];
	handles: VectorRenderHandle[];
	/** Marquee rectangle, screen space. */
	marquee: VectorBounds | null;
	/** Rubber-band segment from the pen path's last anchor to the pointer, screen space. */
	penPreview: string | null;
	/** Artboard rectangle, screen space. */
	artboard: VectorBounds;
	/** Smart guides of the snap in progress, screen space (empty when nothing snapped). */
	guides: { lines: VectorRenderGuideLine[]; labels: VectorRenderGuideLabel[] };
	/**
	 * The knife or eraser stroke being drawn, screen space: `d` is an open polyline; draw the
	 * eraser's with a round-capped stroke `width` pixels wide (0 for the knife: a thin line).
	 */
	toolStroke: { tool: 'knife' | 'eraser'; d: string; width: number } | null;
	/** The pencil's lazy-mouse string from the pen to the pointer, screen space. */
	pencilString: { x1: number; y1: number; x2: number; y2: number } | null;
	/** Where the scissors would cut (screen space). */
	cutPoint: Vec2 | null;
	/**
	 * Live corner widgets of the direct tool (screen space): drag one to round its corners,
	 * Alt-click to cycle round / inverted / chamfer, click to pick its corner alone.
	 */
	cornerWidgets: VectorRenderCornerWidget[];
	/** A short status, e.g. "W 120 × H 80" or "45°". */
	status: string | null;
}

const fmt = (n: number) => Math.round(n * 100) / 100;
const fmtMatrix = (m: AffineMatrix) => `matrix(${m.map((n) => Math.round(n * 1e6) / 1e6).join(' ')})`;

function renderNode(node: VectorNode, defs: SvgGradientDef[], idPrefix: string): VectorRenderNode | null {
	if (node.visible === false) return null;
	if (node.type === 'group') {
		const children = node.children.map((c) => renderNode(c, defs, idPrefix)).filter((c): c is VectorRenderNode => !!c);
		return { kind: 'group', id: node.id, ...(node.transform ? { transform: fmtMatrix(node.transform) } : {}), opacity: node.opacity ?? 1, children };
	}
	const fill = vectorPaintToSvg(node.fill, `${idPrefix}fill-${node.id}`);
	const stroke = vectorPaintToSvg(node.stroke, `${idPrefix}stroke-${node.id}`);
	if (fill.gradient) defs.push(fill.gradient);
	if (stroke.gradient) defs.push(stroke.gradient);
	const strokeParts = stroke.value !== 'none' ? vectorStrokeSvgParts(node, `${idPrefix}clip-${node.id}`) : undefined;
	return {
		kind: 'path',
		id: node.id,
		...(node.transform ? { transform: fmtMatrix(node.transform) } : {}),
		...(strokeParts ? { strokeParts } : {}),
		d: vectorPathData(node),
		fill: fill.value,
		stroke: stroke.value,
		strokeWidth: node.strokeWidth ?? 1,
		...(node.strokeLinecap ? { strokeLinecap: node.strokeLinecap } : {}),
		...(node.strokeLinejoin ? { strokeLinejoin: node.strokeLinejoin } : {}),
		...(node.strokeDasharray?.length ? { strokeDasharray: node.strokeDasharray.join(' ') } : {}),
		fillRule: node.fillRule ?? 'nonzero',
		opacity: node.opacity ?? 1
	};
}

/**
 * The document layer. Render the nodes inside `<g transform={transform}>` and `defs` in a
 * `<defs>` block. Pass a unique `idPrefix` when several editors share a page.
 */
export function getVectorSceneRenderData(state: Pick<VectorEditorState, 'document' | 'viewport'>, options: { idPrefix?: string } = {}): VectorSceneRenderData {
	const defs: SvgGradientDef[] = [];
	const prefix = options.idPrefix ?? 've-';
	const nodes = state.document.nodes.map((n) => renderNode(n, defs, prefix)).filter((n): n is VectorRenderNode => !!n);
	const v = state.viewport;
	return {
		transform: `translate(${fmt(v.x)} ${fmt(v.y)}) scale(${v.zoom})`,
		width: state.document.width,
		height: state.document.height,
		...(state.document.background ? { background: state.document.background } : {}),
		defs,
		nodes
	};
}

const toScreen = (state: Pick<VectorEditorState, 'viewport'>, p: Vec2) => ({ x: p.x * state.viewport.zoom + state.viewport.x, y: p.y * state.viewport.zoom + state.viewport.y });

function screenOutline(state: VectorEditorState, node: VectorNode): string {
	const v = state.viewport;
	const view: AffineMatrix = [v.zoom, 0, 0, v.zoom, v.x, v.y];
	const parent = vectorParentMatrix(state.document.nodes, node.id) ?? IDENTITY_MATRIX;
	return collectWithMatrix(node, parent)
		.map(({ path, parent: m }) => bezierPathToSvg(transformBezierPath(vectorPathWorldBezier(path, m), view), { precision: 2 }))
		.join(' ');
}

/** Path nodes in a subtree with the matrix of their parent space → document. */
function collectWithMatrix(node: VectorNode, parent: AffineMatrix): { path: VectorPathNode; parent: AffineMatrix }[] {
	if (node.type === 'path') return [{ path: node, parent }];
	const m = multiplyMatrices(nodeMatrix(node), parent);
	return node.children.flatMap((c) => collectWithMatrix(c, m));
}

function collect(node: VectorNode): VectorPathNode[] {
	if (node.type === 'path') return [node];
	return node.children.flatMap(collect);
}

/** The editing overlay in screen pixels. Render it on top of the scene, untransformed. */
export function getVectorOverlayRenderData(state: VectorEditorState): VectorOverlayRenderData {
	const doc = state.document;
	const z = state.viewport.zoom;
	const outlines: VectorOverlayRenderData['outlines'] = [];
	const seen = new Set<string>();
	const outline = (id: string, selected: boolean) => {
		if (seen.has(id)) return;
		const node = findVectorNode(doc.nodes, id);
		if (!node || node.visible === false) return;
		seen.add(id);
		outlines.push({ id, d: screenOutline(state, node), selected });
	};
	for (const id of state.selection) outline(id, true);
	if (state.editingId) outline(state.editingId, true);
	if (state.hover?.nodeId && !state.interaction) outline(state.hover.nodeId, false);

	let selectionBox: VectorOverlayRenderData['selectionBox'] = null;
	if (state.tool === 'select' && state.selectionFrame && state.interaction?.type !== 'marquee') {
		const g = getVectorSelectionBoxGeometry(state.selectionFrame, state.viewport);
		selectionBox = { ...g.box, angle: g.angle, transform: g.transform, corners: g.corners, handles: g.handles };
	}

	const selected = (r: VectorAnchorRef) => state.selectedAnchors.some((a) => a.nodeId === r.nodeId && a.subpath === r.subpath && a.index === r.index);
	const sameAnchor = (a: VectorAnchorRef | undefined, b: VectorAnchorRef) => !!a && a.nodeId === b.nodeId && a.subpath === b.subpath && a.index === b.index;
	const anchors: VectorRenderAnchor[] = getVisibleAnchors(state).map((ref) => {
		const a = getAnchorWorld(doc, ref)!;
		const s = toScreen(state, a);
		const closes = !!state.pen && state.pen.nodeId === ref.nodeId && state.pen.subpath === ref.subpath && ref.index === 0;
		return { ref, x: s.x, y: s.y, type: a.type ?? inferAnchorType(a), selected: selected(ref), hovered: sameAnchor(state.hover?.anchor, ref), closes };
	});
	if (state.tool === 'pen' && !state.pen && state.hover?.anchor) {
		const a = getAnchorWorld(doc, state.hover.anchor);
		if (a) {
			const s = toScreen(state, a);
			anchors.push({ ref: state.hover.anchor, x: s.x, y: s.y, type: a.type ?? 'corner', selected: false, hovered: true, closes: false });
		}
	}

	const handles: VectorRenderHandle[] = getVisibleHandles(state).flatMap((ref) => {
		const a = getAnchorWorld(doc, ref);
		const h = a?.[ref.handle];
		if (!a || !h) return [];
		const s = toScreen(state, h);
		const sa = toScreen(state, a);
		const hovered = !!state.hover?.handle && sameAnchor(state.hover.handle, ref) && state.hover.handle.handle === ref.handle;
		return [{ ref, x: s.x, y: s.y, anchorX: sa.x, anchorY: sa.y, hovered }];
	});

	let marquee: VectorBounds | null = null;
	if (state.interaction?.type === 'marquee') {
		const b = state.interaction.bounds;
		const tl = toScreen(state, b);
		marquee = { x: tl.x, y: tl.y, width: b.width * z, height: b.height * z };
	}

	let penPreview: string | null = null;
	if (state.tool === 'pen' && state.pen && state.pointer && !state.interaction) {
		const node = findVectorNode(doc.nodes, state.pen.nodeId);
		const sp = node?.type === 'path' ? node.subpaths[state.pen.subpath] : undefined;
		const last = sp ? getAnchorWorld(doc, { nodeId: state.pen.nodeId, subpath: state.pen.subpath, index: sp.anchors.length - 1 }) : undefined;
		if (last) {
			const a = toScreen(state, last);
			const p = toScreen(state, state.pointer);
			const c = last.out ? toScreen(state, last.out) : null;
			penPreview = c ? `M${fmt(a.x)} ${fmt(a.y)}Q${fmt(c.x)} ${fmt(c.y)} ${fmt(p.x)} ${fmt(p.y)}` : `M${fmt(a.x)} ${fmt(a.y)}L${fmt(p.x)} ${fmt(p.y)}`;
		}
	}

	const origin = toScreen(state, { x: 0, y: 0 });
	const artboard = { x: origin.x, y: origin.y, width: doc.width * z, height: doc.height * z };

	let status: string | null = null;
	const it = state.interaction;
	if (it?.type === 'rotate') status = `${Math.round(it.angle)}°`;
	else if (it?.type === 'move' || it?.type === 'anchors') status = `Δ ${fmt(it.dx)}, ${fmt(it.dy)}`;
	else if (it?.type === 'scale' || it?.type === 'draw') {
		const b = it.type === 'draw' ? (findVectorNode(doc.nodes, it.nodeId) ? vectorNodeBounds(findVectorNode(doc.nodes, it.nodeId)!) : null) : state.selectionFrame;
		if (b) status = `W ${fmt(b.width)} × H ${fmt(b.height)}`;
	}

	const guides: VectorOverlayRenderData['guides'] = { lines: [], labels: [] };
	if (state.guides) {
		for (const l of state.guides.lines) {
			const a = toScreen(state, { x: l.x1, y: l.y1 });
			const b = toScreen(state, { x: l.x2, y: l.y2 });
			guides.lines.push({ kind: l.kind, x1: fmt(a.x), y1: fmt(a.y), x2: fmt(b.x), y2: fmt(b.y) });
		}
		for (const l of state.guides.labels) {
			const p = toScreen(state, l);
			guides.labels.push({ kind: l.kind, x: fmt(p.x), y: fmt(p.y), text: l.text });
		}
	}

	let toolStroke: VectorOverlayRenderData['toolStroke'] = null;
	if (it?.type === 'stroke') {
		const pts = it.points.map((q) => toScreen(state, q));
		const d = pts.map((q, i) => `${i ? 'L' : 'M'}${fmt(q.x)} ${fmt(q.y)}`).join('') + (pts.length === 1 ? `L${fmt(pts[0].x)} ${fmt(pts[0].y)}` : '');
		toolStroke = { tool: it.tool, d, width: fmt(it.width * z) };
	}
	let pencilString: VectorOverlayRenderData['pencilString'] = null;
	if (it?.type === 'draw' && it.string) {
		const a = toScreen(state, it.string[0]);
		const b = toScreen(state, it.string[1]);
		pencilString = { x1: fmt(a.x), y1: fmt(a.y), x2: fmt(b.x), y2: fmt(b.y) };
	}
	const dragged = it?.type === 'corner' ? it.ref : null;
	const cornerWidgets: VectorRenderCornerWidget[] = getVectorCornerWidgets(state).map((w) => {
		const s = toScreen(state, w);
		return { ref: w.ref, x: fmt(s.x), y: fmt(s.y), radius: w.radius, kind: w.kind, hovered: sameAnchor(state.hover?.corner, w.ref), active: !!dragged };
	});
	if (it?.type === 'corner') status = `R ${fmt(it.radius)}`;
	const cutPoint = state.tool === 'scissors' && state.hover?.segment && !it ? (({ x, y }) => ({ x: fmt(x), y: fmt(y) }))(toScreen(state, state.hover.segment.point)) : null;

	return { outlines, selectionBox, anchors, handles, marquee, penPreview, artboard, guides, status, toolStroke, pencilString, cutPoint, cornerWidgets };
}

// ---------------------------------------------------------------------------
// Event adapters (duck-typed, so they work with DOM, React and Svelte events)
// ---------------------------------------------------------------------------

/** Colours and sizes (screen pixels) the bundled canvases draw the overlay with. */
export const VECTOR_OVERLAY_THEME = {
	accent: '#0ea5e9',
	/** Smart guide lines and labels. */
	guide: '#ff3dfc',
	handleFill: '#ffffff',
	marqueeFill: 'rgba(14, 165, 233, 0.08)',
	/** The eraser's swath while it is dragged. */
	eraserFill: 'rgba(239, 68, 68, 0.25)',
	transformHandleSize: 8,
	anchorSize: 7,
	handleRadius: 3.5,
	/** Radius of a live corner widget (a ring with a dot). */
	cornerWidgetRadius: 4
} as const;

interface ModifierEventLike {
	shiftKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	ctrlKey?: boolean;
}

/** Modifiers of a mouse / pointer / key event (`mod` is Cmd or Ctrl). */
export function toVectorModifiers(event: ModifierEventLike): { shift: boolean; alt: boolean; mod: boolean } {
	return { shift: !!event.shiftKey, alt: !!event.altKey, mod: !!(event.metaKey || event.ctrlKey) };
}

/** A pointer event as `VectorEditorController.pointerDown/Move/Up` input. */
export function toVectorPointerInput(event: ModifierEventLike & { button?: number }) {
	return { ...toVectorModifiers(event), button: event.button };
}

/** A key event as `VectorEditorController.keyDown/keyUp` input. */
export function toVectorKeyInput(event: ModifierEventLike & { key: string }) {
	return { key: event.key, ...toVectorModifiers(event) };
}

/** True for targets that should keep their own keys (inputs, textareas, contenteditable). */
export function isVectorTextTarget(target: unknown): boolean {
	const el = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null } | null;
	if (!el || typeof el !== 'object') return false;
	const tag = (el.tagName ?? '').toUpperCase();
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
	return !!el.isContentEditable || el.getAttribute?.('contenteditable') === 'true';
}

// ---------------------------------------------------------------------------
// Style panel helpers
// ---------------------------------------------------------------------------

/** Style shown in a style panel: the first selected path's, with `mixed` flags when paths differ. */
export interface VectorSelectionStyle {
	fill: VectorPaint;
	stroke: VectorPaint;
	strokeWidth: number;
	opacity: number;
	strokeAlign: VectorStrokeAlign;
	startArrow: VectorArrowhead | null;
	endArrow: VectorArrowhead | null;
	arrowAlign: VectorArrowAlign;
	startArrowScale: number;
	endArrowScale: number;
	/**
	 * Live corners of the selected anchors (direct tool) or of every corner of the selected
	 * paths: the first one's radius and kind, and how many corners there are (0: none to round).
	 */
	cornerRadius: number;
	cornerKind: VectorCornerKind;
	corners: number;
	/** Some selected path is open, so arrowheads apply. */
	hasOpenPath: boolean;
	mixed: {
		fill: boolean;
		stroke: boolean;
		strokeWidth: boolean;
		opacity: boolean;
		strokeAlign: boolean;
		startArrow: boolean;
		endArrow: boolean;
		arrowAlign: boolean;
		startArrowScale: boolean;
		endArrowScale: boolean;
		cornerRadius: boolean;
		cornerKind: boolean;
	};
	/** Ids of the paths the style applies to. */
	pathIds: string[];
}

export function getVectorSelectionStyle(
	state: Pick<VectorEditorState, 'document' | 'selection'> & Partial<Pick<VectorEditorState, 'selectedAnchors' | 'tool'>>
): VectorSelectionStyle | null {
	const paths: VectorPathNode[] = [];
	for (const id of state.selection) {
		const node = findVectorNode(state.document.nodes, id);
		if (node) paths.push(...collect(node));
	}
	const anchorMode = state.tool === 'direct' && !!state.selectedAnchors?.length;
	if (anchorMode) {
		for (const r of state.selectedAnchors!) {
			if (paths.some((p) => p.id === r.nodeId)) continue;
			const node = findVectorNode(state.document.nodes, r.nodeId);
			if (node?.type === 'path') paths.push(node);
		}
	}
	if (!paths.length) return null;
	const first = paths[0];
	const same = (get: (p: VectorPathNode) => unknown) => paths.every((p) => JSON.stringify(get(p) ?? null) === JSON.stringify(get(first) ?? null));
	// Corners: those of the selected anchors in the direct tool, else every corner of the paths.
	const corners: { radius: number; kind: VectorCornerKind }[] = [];
	for (const p of paths) {
		for (const c of vectorCorners(p.subpaths)) {
			if (anchorMode && !state.selectedAnchors!.some((r) => r.nodeId === p.id && r.subpath === c.subpath && r.index === c.index)) continue;
			const corner = p.subpaths[c.subpath].anchors[c.index].corner;
			corners.push({ radius: corner?.radius ?? 0, kind: corner?.kind ?? 'round' });
		}
	}
	const c0 = corners[0] ?? { radius: 0, kind: 'round' as const };
	return {
		fill: first.fill ?? null,
		stroke: first.stroke ?? null,
		strokeWidth: first.strokeWidth ?? 1,
		opacity: first.opacity ?? 1,
		strokeAlign: first.strokeAlign ?? 'center',
		startArrow: first.startArrow ?? null,
		endArrow: first.endArrow ?? null,
		arrowAlign: first.arrowAlign ?? 'extend',
		startArrowScale: first.startArrowScale ?? 1,
		endArrowScale: first.endArrowScale ?? 1,
		cornerRadius: c0.radius,
		cornerKind: c0.kind,
		corners: corners.length,
		hasOpenPath: paths.some((p) => p.subpaths.some((sp) => !sp.closed && sp.anchors.length > 1)),
		mixed: {
			fill: !same((p) => p.fill),
			stroke: !same((p) => p.stroke),
			strokeWidth: !same((p) => p.strokeWidth ?? 1),
			opacity: !same((p) => p.opacity ?? 1),
			strokeAlign: !same((p) => p.strokeAlign ?? 'center'),
			startArrow: !same((p) => p.startArrow ?? null),
			endArrow: !same((p) => p.endArrow ?? null),
			arrowAlign: !same((p) => p.arrowAlign ?? 'extend'),
			startArrowScale: !same((p) => p.startArrowScale ?? 1),
			endArrowScale: !same((p) => p.endArrowScale ?? 1),
			cornerRadius: corners.some((c) => c.radius !== c0.radius),
			cornerKind: corners.some((c) => c.kind !== c0.kind)
		},
		pathIds: paths.map((p) => p.id)
	};
}

/** Labels of the stroke alignments, corner kinds and arrowheads, for style panels. */
export const VECTOR_STROKE_ALIGN_LABELS: Readonly<Record<VectorStrokeAlign, string>> = { center: 'Center', inside: 'Inside', outside: 'Outside' };
export const VECTOR_CORNER_KIND_LABELS: Readonly<Record<VectorCornerKind, string>> = { round: 'Round', inverted: 'Inverted', chamfer: 'Chamfer' };
export const VECTOR_ARROWHEAD_LABELS: Readonly<Record<VectorArrowhead, string>> = {
	triangle: 'Triangle',
	arrow: 'Arrow',
	open: 'Open arrow',
	circle: 'Circle',
	square: 'Square',
	bar: 'Bar'
};

/** A paint as `#rrggbb` for `<input type="color">`, or null for none, gradients and other CSS colours. */
export function vectorPaintToHex(paint: VectorPaint | undefined): string | null {
	if (typeof paint !== 'string') return null;
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(paint.trim());
	if (!m) return null;
	const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
	return `#${hex.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Toolbar helpers
// ---------------------------------------------------------------------------

/** A path-editing button of the bundled toolbars. */
export interface VectorPathAction {
	id: 'join' | 'average' | 'cut' | 'clean' | 'smooth' | 'outline';
	label: string;
	title: string;
	/** Shortcut after Cmd / Ctrl, if any. */
	shortcut?: string;
	/** Whether it can run with `selected` nodes and `points` selected anchors (direct tool). */
	enabled: (selected: number, points: number) => boolean;
	run: (controller: VectorEditorController) => unknown;
}

/** Join, Average, Cut at Points, Remove Redundant Points, Smooth and Outline Stroke, as the toolbars show them. */
export const VECTOR_PATH_ACTIONS: readonly VectorPathAction[] = [
	{ id: 'join', label: '⋈', title: 'Join', shortcut: 'J', enabled: (s, p) => s + p > 0, run: (c) => c.joinPaths() },
	{ id: 'average', label: '⊹', title: 'Average Points', shortcut: 'Alt+J', enabled: (_s, p) => p > 1, run: (c) => c.averageAnchors('both') },
	{ id: 'cut', label: '✂·', title: 'Cut at Points', enabled: (_s, p) => p > 0, run: (c) => c.cutAtAnchors() },
	{ id: 'clean', label: '⌁', title: 'Remove Redundant Points', enabled: (s, p) => s + p > 0, run: (c) => c.removeRedundantPoints() },
	{ id: 'smooth', label: '∿', title: 'Smooth', enabled: (s, p) => s + p > 0, run: (c) => c.smoothPaths() },
	{ id: 'outline', label: '⊡', title: 'Outline Stroke', enabled: (s) => s > 0, run: (c) => c.outlineStroke() }
];

/** The on / off path-editing settings the toolbars toggle. */
export const VECTOR_EDIT_TOGGLES: readonly { key: 'keepShapeOnDelete' | 'curvatureMoves' | 'recognizeShapes'; label: string; title: string }[] = [
	{ key: 'keepShapeOnDelete', label: 'Keep', title: 'Keep shape when deleting points' },
	{ key: 'curvatureMoves', label: 'Curv', title: 'Curvature point moves (Alt flips while dragging)' },
	{ key: 'recognizeShapes', label: 'Shapes', title: 'Turn pencil scribbles into shapes' }
];

