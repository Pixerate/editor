/**
 * Framework-neutral render data for a vector editor: the scene (document-space SVG paths and
 * gradient defs) and the overlay (screen-space selection box, anchors, handles, marquee and
 * pen preview). React, Svelte or plain DOM code turns these into `<svg>` elements.
 */
import { bezierPathToSvg, transformBezierPath } from '../canvas/pathops/bezier.js';
import type { SvgGradientDef } from '../canvas/gradient.js';

export type { SvgGradientDef };
import { getAnchor, getTransformHandlePositions, getVisibleAnchors, getVisibleHandles, type VectorEditorState } from './controller.js';
import { findVectorNode, inferAnchorType, subpathsToBezier, vectorNodeBounds, vectorPathData } from './geometry.js';
import { vectorPaintToSvg } from './svg.js';
import type { VectorAnchorRef, VectorAnchorType, VectorBounds, VectorHandleRef, VectorNode, VectorPaint, VectorPathNode, VectorTransformHandle, Vec2 } from './types.js';

export interface VectorRenderPath {
	kind: 'path';
	id: string;
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
}

export interface VectorRenderGroup {
	kind: 'group';
	id: string;
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

export interface VectorOverlayRenderData {
	/** Outlines (screen-space path data) of hovered and selected nodes. */
	outlines: { id: string; d: string; selected: boolean }[];
	/** Selection box with resize and rotate handles (select tool), screen space. */
	selectionBox: { x: number; y: number; width: number; height: number; handles: { handle: VectorTransformHandle; x: number; y: number }[] } | null;
	anchors: VectorRenderAnchor[];
	handles: VectorRenderHandle[];
	/** Marquee rectangle, screen space. */
	marquee: VectorBounds | null;
	/** Rubber-band segment from the pen path's last anchor to the pointer, screen space. */
	penPreview: string | null;
	/** Artboard rectangle, screen space. */
	artboard: VectorBounds;
	/** A short status, e.g. "W 120 × H 80" or "45°". */
	status: string | null;
}

const fmt = (n: number) => Math.round(n * 100) / 100;

function renderNode(node: VectorNode, defs: SvgGradientDef[], idPrefix: string): VectorRenderNode | null {
	if (node.visible === false) return null;
	if (node.type === 'group') {
		const children = node.children.map((c) => renderNode(c, defs, idPrefix)).filter((c): c is VectorRenderNode => !!c);
		return { kind: 'group', id: node.id, opacity: node.opacity ?? 1, children };
	}
	const fill = vectorPaintToSvg(node.fill, `${idPrefix}fill-${node.id}`);
	const stroke = vectorPaintToSvg(node.stroke, `${idPrefix}stroke-${node.id}`);
	if (fill.gradient) defs.push(fill.gradient);
	if (stroke.gradient) defs.push(stroke.gradient);
	return {
		kind: 'path',
		id: node.id,
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
	const paths = node.type === 'path' ? [node] : collect(node);
	return paths.map((p) => bezierPathToSvg(transformBezierPath(subpathsToBezier(p.subpaths), [v.zoom, 0, 0, v.zoom, v.x, v.y]), { precision: 2 })).join(' ');
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
	if (state.tool === 'select' && state.selectionBounds && state.interaction?.type !== 'marquee') {
		const b = state.selectionBounds;
		const tl = toScreen(state, b);
		const box = { x: tl.x, y: tl.y, width: b.width * z, height: b.height * z };
		selectionBox = { ...box, handles: getTransformHandlePositions(box) };
	}

	const selected = (r: VectorAnchorRef) => state.selectedAnchors.some((a) => a.nodeId === r.nodeId && a.subpath === r.subpath && a.index === r.index);
	const sameAnchor = (a: VectorAnchorRef | undefined, b: VectorAnchorRef) => !!a && a.nodeId === b.nodeId && a.subpath === b.subpath && a.index === b.index;
	const anchors: VectorRenderAnchor[] = getVisibleAnchors(state).map((ref) => {
		const a = getAnchor(doc, ref)!;
		const s = toScreen(state, a);
		const closes = !!state.pen && state.pen.nodeId === ref.nodeId && state.pen.subpath === ref.subpath && ref.index === 0;
		return { ref, x: s.x, y: s.y, type: a.type ?? inferAnchorType(a), selected: selected(ref), hovered: sameAnchor(state.hover?.anchor, ref), closes };
	});
	if (state.tool === 'pen' && !state.pen && state.hover?.anchor) {
		const a = getAnchor(doc, state.hover.anchor);
		if (a) {
			const s = toScreen(state, a);
			anchors.push({ ref: state.hover.anchor, x: s.x, y: s.y, type: a.type ?? 'corner', selected: false, hovered: true, closes: false });
		}
	}

	const handles: VectorRenderHandle[] = getVisibleHandles(state).flatMap((ref) => {
		const a = getAnchor(doc, ref);
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
		const last = sp?.anchors[sp.anchors.length - 1];
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
		const b = it.type === 'draw' ? (findVectorNode(doc.nodes, it.nodeId) ? vectorNodeBounds(findVectorNode(doc.nodes, it.nodeId)!) : null) : state.selectionBounds;
		if (b) status = `W ${fmt(b.width)} × H ${fmt(b.height)}`;
	}

	return { outlines, selectionBox, anchors, handles, marquee, penPreview, artboard, status };
}

// ---------------------------------------------------------------------------
// Event adapters (duck-typed, so they work with DOM, React and Svelte events)
// ---------------------------------------------------------------------------

/** Colours and sizes (screen pixels) the bundled canvases draw the overlay with. */
export const VECTOR_OVERLAY_THEME = {
	accent: '#0ea5e9',
	handleFill: '#ffffff',
	marqueeFill: 'rgba(14, 165, 233, 0.08)',
	transformHandleSize: 8,
	anchorSize: 7,
	handleRadius: 3.5
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
	mixed: { fill: boolean; stroke: boolean; strokeWidth: boolean; opacity: boolean };
	/** Ids of the paths the style applies to. */
	pathIds: string[];
}

export function getVectorSelectionStyle(state: Pick<VectorEditorState, 'document' | 'selection'>): VectorSelectionStyle | null {
	const paths: VectorPathNode[] = [];
	for (const id of state.selection) {
		const node = findVectorNode(state.document.nodes, id);
		if (node) paths.push(...collect(node));
	}
	if (!paths.length) return null;
	const first = paths[0];
	const same = (get: (p: VectorPathNode) => unknown) => paths.every((p) => JSON.stringify(get(p) ?? null) === JSON.stringify(get(first) ?? null));
	return {
		fill: first.fill ?? null,
		stroke: first.stroke ?? null,
		strokeWidth: first.strokeWidth ?? 1,
		opacity: first.opacity ?? 1,
		mixed: { fill: !same((p) => p.fill), stroke: !same((p) => p.stroke), strokeWidth: !same((p) => p.strokeWidth ?? 1), opacity: !same((p) => p.opacity ?? 1) },
		pathIds: paths.map((p) => p.id)
	};
}

/** A paint as `#rrggbb` for `<input type="color">`, or null for none, gradients and other CSS colours. */
export function vectorPaintToHex(paint: VectorPaint | undefined): string | null {
	if (typeof paint !== 'string') return null;
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(paint.trim());
	if (!m) return null;
	const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
	return `#${hex.toLowerCase()}`;
}
