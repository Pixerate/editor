/**
 * Fill and stroke stacks: several paints per path, each with its own opacity, blend mode and
 * visibility, and each stroke with its own width, alignment, dashes, arrowheads and profile.
 *
 * The stacks live in `fills` / `strokes`, bottom to top; fills draw under strokes. The single
 * `fill` / `stroke` fields (and the stroke settings) stay as shorthands that mirror the top layer
 * of each stack, so everything written against one fill and one stroke — booleans, blends, the
 * gradient tool, agent commands, old documents — keeps working:
 *
 * - A node without `fills` has the one-layer stack its `fill` says (none without a paint); the
 *   same for strokes. Stacks of one plain layer are stored that way, so old documents and simple
 *   nodes look exactly as before.
 * - `normalizeVectorPaintStacks` reconciles the two forms. Loading prefers the stacks (the
 *   shorthand is re-derived); editing prefers the shorthand: a node whose `fill` no longer matches
 *   its top fill was written by shorthand code, so the top layer takes the new paint (`null`
 *   clears the stack). The controller runs it after every change.
 *
 * Paint layers are drawn, hit-tested and exported through `vectorPaintLayerNodes`: one plain path
 * node per layer (the node with only that fill, or only that stroke and its settings), so the
 * existing paint, stroke-part and gradient code serves each layer unchanged.
 *
 * The data model follows figcraft `crates/color/src/lib.rs` (`Paint { kind, opacity, visible,
 * blend }` in a list per node) and vectorcraft `crates/doc/src/appearance.rs` (`FillLayer` /
 * `StrokeLayer`, each stroke with its own settings). Ported from ArtCraft (MIT OR Apache-2.0,
 * © ArtCraft Team and contributors; see THIRD_PARTY_NOTICES.md).
 */
import { pointInBezierPath, distanceToBezierPath, type BezierPath } from '../canvas/pathops/bezier.js';
import { isVectorGradient, sanitizeVectorGradient } from './gradient.js';
import { hitTestVectorStroke, vectorStrokeReach } from './stroke.js';
import { sanitizeWidthProfile } from './width.js';
import {
	VECTOR_ARROWHEADS,
	VECTOR_BLEND_MODES,
	type VectorArrowhead,
	type VectorBlendMode,
	type VectorPaint,
	type VectorPaintLayer,
	type VectorPathNode,
	type VectorStrokeLayer,
	type VectorStrokeSettings,
	type VectorStyle,
	type Vec2
} from './types.js';

/** The stroke settings each stroke layer has of its own, in `VectorStyle` field names. */
export const VECTOR_STROKE_SETTING_KEYS: readonly (keyof VectorStrokeSettings)[] = [
	'strokeWidth',
	'strokeLinecap',
	'strokeLinejoin',
	'strokeDasharray',
	'strokeAlign',
	'startArrow',
	'endArrow',
	'arrowAlign',
	'startArrowScale',
	'endArrowScale',
	'strokeWidthProfile'
];

export const VECTOR_BLEND_MODE_LABELS: Readonly<Record<VectorBlendMode, string>> = {
	normal: 'Normal',
	darken: 'Darken',
	multiply: 'Multiply',
	'color-burn': 'Color Burn',
	lighten: 'Lighten',
	screen: 'Screen',
	'color-dodge': 'Color Dodge',
	'linear-dodge': 'Linear Dodge (Add)',
	overlay: 'Overlay',
	'soft-light': 'Soft Light',
	'hard-light': 'Hard Light',
	difference: 'Difference',
	exclusion: 'Exclusion',
	hue: 'Hue',
	saturation: 'Saturation',
	color: 'Color',
	luminosity: 'Luminosity'
};

export function isVectorBlendMode(value: unknown): value is VectorBlendMode {
	return typeof value === 'string' && (VECTOR_BLEND_MODES as readonly string[]).includes(value);
}

/** A blend mode as a CSS `mix-blend-mode` value, or undefined for `normal` (nothing to write). */
export function vectorBlendModeCss(mode: VectorBlendMode | null | undefined): string | undefined {
	if (!mode || mode === 'normal' || !isVectorBlendMode(mode)) return undefined;
	return mode === 'linear-dodge' ? 'plus-lighter' : mode;
}

/** A CSS `mix-blend-mode` value back to a blend mode (`plus-lighter` is `linear-dodge`), or null when SVG offers it but we don't. */
export function vectorBlendModeFromCss(value: string | null | undefined): VectorBlendMode | null {
	const v = (value ?? '').trim().toLowerCase();
	if (v === 'plus-lighter') return 'linear-dodge';
	return isVectorBlendMode(v) ? v : null;
}

/** True when the paint draws something (not `null`, `'none'`, `'transparent'` or empty). */
const draws = (paint: VectorPaint | undefined): boolean => {
	if (paint === undefined || paint === null) return false;
	if (typeof paint === 'string') {
		const p = paint.trim().toLowerCase();
		return p !== '' && p !== 'none' && p !== 'transparent';
	}
	return true;
};

/** A layer with full opacity, `normal` blending, visible and (strokes) a plain paint: what the shorthand alone can say. */
export function isPlainVectorPaintLayer(layer: VectorPaintLayer | VectorStrokeLayer): boolean {
	return (
		(layer.opacity ?? 1) >= 1 &&
		(layer.blendMode ?? 'normal') === 'normal' &&
		layer.visible !== false &&
		((layer as VectorStrokeLayer).kind ?? 'paint') === 'paint'
	);
}

/** Whether a layer is drawn: visible, a plain paint (strokes), a paint that draws something, above zero opacity. */
export function isDrawnVectorPaintLayer(layer: VectorPaintLayer | VectorStrokeLayer): boolean {
	return layer.visible !== false && ((layer as VectorStrokeLayer).kind ?? 'paint') === 'paint' && draws(layer.paint) && (layer.opacity ?? 1) > 0;
}

/** The fill stack of a path (or style), bottom to top: `fills`, or the one layer `fill` makes. */
export function vectorFills(style: VectorStyle): VectorPaintLayer[] {
	if (Array.isArray(style.fills)) return style.fills;
	return draws(style.fill) ? [{ paint: style.fill! }] : [];
}

/** The stroke settings a style gives its shorthand stroke (only those set). */
export function vectorStrokeSettings(style: VectorStyle): VectorStrokeSettings {
	const out: VectorStrokeSettings = {};
	for (const key of VECTOR_STROKE_SETTING_KEYS) {
		const v = style[key];
		if (v !== undefined && v !== null) (out as Record<string, unknown>)[key] = v;
	}
	return out;
}

/** The stroke stack of a path (or style), bottom to top: `strokes`, or the one layer `stroke` and the stroke settings make. */
export function vectorStrokes(style: VectorStyle): VectorStrokeLayer[] {
	if (Array.isArray(style.strokes)) return style.strokes;
	return draws(style.stroke) ? [{ paint: style.stroke!, ...vectorStrokeSettings(style) }] : [];
}

/** Whether a style stores a stack (more than its shorthand can say). */
export function hasVectorPaintStacks(style: VectorStyle): boolean {
	return Array.isArray(style.fills) || Array.isArray(style.strokes);
}

/** The node with `fills` as its fill stack, stored canonically (see the module comment). */
export function withVectorFills<T extends VectorStyle>(node: T, fills: readonly VectorPaintLayer[]): T {
	const next = { ...node };
	if (fills.length === 0 || (fills.length === 1 && isPlainVectorPaintLayer(fills[0]))) {
		delete next.fills;
		next.fill = fills[0]?.paint ?? null;
		return next;
	}
	next.fills = fills.map((l) => ({ ...l }));
	next.fill = fills[fills.length - 1].paint;
	return next;
}

/** The node with `strokes` as its stroke stack, stored canonically; the shorthand mirrors the top layer. */
export function withVectorStrokes<T extends VectorStyle>(node: T, strokes: readonly VectorStrokeLayer[]): T {
	const next = { ...node };
	if (strokes.length === 0) {
		// The settings stay, for a stroke added later through the shorthand.
		delete next.strokes;
		next.stroke = null;
		return next;
	}
	const top = strokes[strokes.length - 1];
	for (const key of VECTOR_STROKE_SETTING_KEYS) delete next[key];
	Object.assign(next, vectorStrokeSettings(top as VectorStyle));
	next.stroke = top.paint;
	if (strokes.length === 1 && isPlainVectorPaintLayer(top)) delete next.strokes;
	else next.strokes = strokes.map((l) => ({ ...l }));
	return next;
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/** The stroke fields of `node` that differ from what its top stroke layer says. */
function strokeShorthandDiff(node: VectorStyle, top: VectorStrokeLayer | undefined): (keyof VectorStrokeSettings | 'stroke')[] {
	const out: (keyof VectorStrokeSettings | 'stroke')[] = [];
	if (json(node.stroke) !== json(top?.paint)) out.push('stroke');
	for (const key of VECTOR_STROKE_SETTING_KEYS) if (json(node[key]) !== json(top?.[key])) out.push(key);
	return out;
}

const checked = new WeakSet<object>();

/**
 * A node with its stacks and shorthands reconciled and stored canonically (the same object when
 * they already are). `prefer: 'stack'` (loading) re-derives the shorthand from the stacks;
 * `'shorthand'` (after an edit, the default) reads a shorthand that disagrees with its stack's
 * top layer as an edit of that layer: a paint repaints it, a stroke setting changes it, `null`
 * clears the stack.
 */
export function normalizeVectorPaintStacks<T extends VectorStyle>(node: T, prefer: 'stack' | 'shorthand' = 'shorthand'): T {
	if (!hasVectorPaintStacks(node)) {
		if (!('fills' in node) && !('strokes' in node)) return node;
		// `fills: null` / `strokes: null`: no stack.
		const next = { ...node };
		delete next.fills;
		delete next.strokes;
		return next;
	}
	if (checked.has(node)) return node;
	let next: T = node;
	if (Array.isArray(node.fills)) {
		let fills: VectorPaintLayer[] = node.fills;
		const top = fills[fills.length - 1];
		if (prefer === 'shorthand' && json(node.fill) !== json(top?.paint)) {
			if (!draws(node.fill)) fills = [];
			else fills = top ? [...fills.slice(0, -1), { ...top, paint: node.fill! }] : [{ paint: node.fill! }];
		}
		next = withVectorFills(next, fills);
	}
	if (Array.isArray(node.strokes)) {
		let strokes: VectorStrokeLayer[] = node.strokes;
		const top = strokes[strokes.length - 1];
		const diff = prefer === 'shorthand' ? strokeShorthandDiff(node, top) : [];
		if (diff.length) {
			if (diff.includes('stroke') && !draws(node.stroke)) strokes = [];
			else {
				const layer: VectorStrokeLayer = top ? { ...top } : { paint: node.stroke ?? null };
				for (const key of diff) {
					if (key === 'stroke') layer.paint = node.stroke ?? null;
					else if (node[key] === undefined || node[key] === null) delete layer[key];
					else (layer as unknown as Record<string, unknown>)[key] = node[key];
				}
				strokes = top ? [...strokes.slice(0, -1), layer] : [layer];
			}
		}
		next = withVectorStrokes(next, strokes);
	}
	const keys = ['fill', 'fills', 'stroke', 'strokes', ...VECTOR_STROKE_SETTING_KEYS] as const;
	const same = keys.every((k) => k in next === k in node && json(next[k]) === json(node[k]));
	const out = same ? node : next;
	checked.add(out);
	return out;
}

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

function sanitizePaint(value: unknown): VectorPaint {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') return value;
	return sanitizeVectorGradient(value);
}

function sanitizeLayerBase(raw: Record<string, unknown>): VectorPaintLayer {
	const out: VectorPaintLayer = { paint: sanitizePaint(raw.paint) };
	if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity) && raw.opacity < 1) out.opacity = Math.max(0, raw.opacity);
	if (isVectorBlendMode(raw.blendMode) && raw.blendMode !== 'normal') out.blendMode = raw.blendMode;
	if (raw.visible === false) out.visible = false;
	return out;
}

/** Reads a fill stack from untrusted data (JSON, agent input, SVG): malformed layers are dropped. */
export function sanitizeVectorFills(value: unknown): VectorPaintLayer[] {
	if (!Array.isArray(value)) return [];
	return value.filter((l): l is Record<string, unknown> => !!l && typeof l === 'object').map(sanitizeLayerBase);
}

const ARROW_ALIGNS = ['extend', 'tip'];

/** Stroke settings from untrusted data: wrong types and out-of-range values are dropped. */
export function sanitizeVectorStrokeSettings(raw: Record<string, unknown>): VectorStrokeSettings {
	const out: VectorStrokeSettings = {};
	const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
	const width = num(raw.strokeWidth);
	if (width !== undefined && width >= 0) out.strokeWidth = width;
	if (raw.strokeLinecap === 'butt' || raw.strokeLinecap === 'round' || raw.strokeLinecap === 'square') out.strokeLinecap = raw.strokeLinecap;
	if (raw.strokeLinejoin === 'miter' || raw.strokeLinejoin === 'round' || raw.strokeLinejoin === 'bevel') out.strokeLinejoin = raw.strokeLinejoin;
	if (Array.isArray(raw.strokeDasharray)) {
		const dash = raw.strokeDasharray.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0);
		if (dash.length && dash.some((n) => n > 0)) out.strokeDasharray = dash;
	}
	if (raw.strokeAlign === 'center' || raw.strokeAlign === 'inside' || raw.strokeAlign === 'outside') out.strokeAlign = raw.strokeAlign;
	for (const key of ['startArrow', 'endArrow'] as const) if (VECTOR_ARROWHEADS.includes(raw[key] as VectorArrowhead)) out[key] = raw[key] as VectorArrowhead;
	if (ARROW_ALIGNS.includes(raw.arrowAlign as string)) out.arrowAlign = raw.arrowAlign as 'extend' | 'tip';
	for (const key of ['startArrowScale', 'endArrowScale'] as const) {
		const n = num(raw[key]);
		if (n !== undefined && n > 0) out[key] = n;
	}
	if (Array.isArray(raw.strokeWidthProfile)) {
		const p = sanitizeWidthProfile(raw.strokeWidthProfile as never);
		if (p.length) out.strokeWidthProfile = p;
	}
	return out;
}

/**
 * Reads a stroke stack from untrusted data. Layers of a kind this version does not know are kept
 * as they are (a later version's brushstroke, say), so a round trip does not lose them.
 */
export function sanitizeVectorStrokes(value: unknown): VectorStrokeLayer[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
		.map((raw) => {
			if (raw.kind !== undefined && raw.kind !== 'paint') return { ...(raw as unknown as VectorStrokeLayer) };
			return { ...sanitizeLayerBase(raw), ...sanitizeVectorStrokeSettings(raw) };
		});
}

// ---------------------------------------------------------------------------
// Layer nodes: one plain path per layer
// ---------------------------------------------------------------------------

/** One layer of a path's paint as a plain path node (see `vectorPaintLayerNodes`). */
export interface VectorPaintLayerNode {
	kind: 'fill' | 'stroke';
	/** Index in its stack, bottom to top. */
	index: number;
	layer: VectorPaintLayer | VectorStrokeLayer;
	/** The path with only this fill, or only this stroke and its settings (no stacks). */
	node: VectorPathNode;
	/** Visible, a plain paint, painting something, above zero opacity. */
	drawn: boolean;
}

const layerNodeCache = new WeakMap<VectorPathNode, VectorPaintLayerNode[]>();

/**
 * Every fill then every stroke of a path, bottom to top, each as the path painted by that layer
 * alone. Cached per node object (and the layer nodes are the same objects while it is), so the
 * paint and stroke-part caches keyed by node keep working per layer.
 */
export function vectorPaintLayerNodes(node: VectorPathNode): VectorPaintLayerNode[] {
	const hit = layerNodeCache.get(node);
	if (hit) return hit;
	const { fills: _f, strokes: _s, ...base } = node;
	const plain = { ...base } as VectorPathNode;
	for (const key of VECTOR_STROKE_SETTING_KEYS) delete plain[key];
	const out: VectorPaintLayerNode[] = [];
	vectorFills(node).forEach((layer, index) => {
		out.push({ kind: 'fill', index, layer, node: { ...plain, fill: layer.paint, stroke: null }, drawn: isDrawnVectorPaintLayer(layer) });
	});
	vectorStrokes(node).forEach((layer, index) => {
		const settings = (layer.kind ?? 'paint') === 'paint' ? vectorStrokeSettings(layer as VectorStyle) : {};
		out.push({ kind: 'stroke', index, layer, node: { ...plain, fill: null, ...settings, stroke: layer.paint }, drawn: isDrawnVectorPaintLayer(layer) });
	});
	layerNodeCache.set(node, out);
	return out;
}

/** Whether a path draws through its stacks rather than one fill and one stroke (several layers, or one with its own opacity, blend or visibility). */
export function needsVectorPaintLayers(node: VectorPathNode): boolean {
	if (!hasVectorPaintStacks(node)) return false;
	const fills = vectorFills(node);
	const strokes = vectorStrokes(node);
	return fills.length > 1 || strokes.length > 1 || fills.some((l) => !isPlainVectorPaintLayer(l)) || strokes.some((l) => !isPlainVectorPaintLayer(l));
}

/** How far the drawn strokes of a path reach past its outline (the widest layer's reach; 0 without strokes). */
export function vectorStrokeStackReach(node: VectorPathNode): number {
	let reach = 0;
	for (const l of vectorPaintLayerNodes(node)) if (l.kind === 'stroke' && l.drawn) reach = Math.max(reach, vectorStrokeReach(l.node));
	return reach;
}

/** The layer a point hits (see `hitTestVectorPaintLayer`). */
export interface VectorPaintLayerHit {
	kind: 'fill' | 'stroke';
	index: number;
}

/**
 * The topmost drawn layer of a path that `p` hits, or null: strokes top to bottom (their
 * alignment, arrowheads and profiles respected, `tolerance` added), then fills. `path` is the
 * node's outline in the same space as `p` (`vectorPathWorldBezier`).
 */
export function hitTestVectorPaintLayer(node: VectorPathNode, path: BezierPath, p: Vec2, tolerance = 0): VectorPaintLayerHit | null {
	if (!path.length) return null;
	const layers = vectorPaintLayerNodes(node);
	for (let i = layers.length - 1; i >= 0; i--) {
		const l = layers[i];
		if (!l.drawn) continue;
		if (l.kind === 'stroke') {
			if ((l.node.strokeWidth ?? 1) > 0 && hitTestVectorStroke(path, p, l.node, tolerance)) return { kind: 'stroke', index: l.index };
		} else if (pointInBezierPath(path, [p.x, p.y], node.fillRule ?? 'nonzero')) return { kind: 'fill', index: l.index };
	}
	return null;
}

/**
 * Whether `p` hits a path as drawn by its stacks: on a drawn layer, or, when it draws no stroke,
 * within `tolerance` of its outline (so unpainted paths stay pickable).
 */
export function hitTestVectorPaintStack(node: VectorPathNode, path: BezierPath, p: Vec2, tolerance = 0): boolean {
	if (hitTestVectorPaintLayer(node, path, p, tolerance)) return true;
	if (vectorPaintLayerNodes(node).some((l) => l.kind === 'stroke' && l.drawn)) return false;
	return distanceToBezierPath(path, [p.x, p.y]) <= tolerance;
}

/** Whether a fill or stroke stack holds a gradient anywhere (for transforms that move gradients). */
export function vectorStacksHaveGradient(style: VectorStyle): boolean {
	return [...(style.fills ?? []), ...(style.strokes ?? [])].some((l) => isVectorGradient(l.paint));
}

/** Defaults of a new layer added to a stack (a stroke takes the settings of the stack's top stroke). */
export function newVectorStrokeLayer(node: VectorStyle, patch: Partial<VectorStrokeLayer> = {}): VectorStrokeLayer {
	const top = vectorStrokes(node).at(-1);
	const settings = top && (top.kind ?? 'paint') === 'paint' ? vectorStrokeSettings(top as VectorStyle) : { strokeWidth: node.strokeWidth ?? 1 };
	return { paint: '#000000', ...settings, ...patch };
}

/**
 * The paint the gradient tool and editor work on: layer `layer` of the fill or stroke stack, or
 * (null, or an index the stack doesn't have) the shorthand, which is the top layer.
 */
export function vectorTargetPaint(style: VectorStyle, target: 'fill' | 'stroke', layer: number | null = null): VectorPaint | undefined {
	if (layer === null) return style[target];
	const stack = target === 'fill' ? vectorFills(style) : vectorStrokes(style);
	return stack[layer] ? stack[layer].paint : style[target];
}

/** The node with `paint` in the place `vectorTargetPaint` reads (stored canonically). */
export function withVectorTargetPaint<T extends VectorStyle>(node: T, target: 'fill' | 'stroke', layer: number | null, paint: VectorPaint): T {
	const stack = target === 'fill' ? vectorFills(node) : vectorStrokes(node);
	if (layer === null || !stack[layer]) {
		if (!stack.length) return { ...node, [target]: paint };
		layer = stack.length - 1;
	}
	const next = stack.map((l, i) => (i === layer ? { ...l, paint } : l));
	return target === 'fill' ? withVectorFills(node, next) : withVectorStrokes(node, next as VectorStrokeLayer[]);
}
