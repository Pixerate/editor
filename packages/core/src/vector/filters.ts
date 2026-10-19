/**
 * Visual filters of vector nodes: drop shadow, inner shadow, outer and inner glow, layer blur and
 * feather, drawn as one SVG `<filter>` per node (in the canvases and in SVG export alike).
 *
 * The filter takes everything the node draws (`SourceGraphic`) and its silhouette
 * (`SourceAlpha`) in the node's own space, and builds, in this order:
 *
 * 1. Inner shadows and inner glows, in stack order, over the body: the inverse of the silhouette
 *    (offset for a shadow), grown by `spread` (which chokes the shadow inwards), blurred, coloured
 *    and clipped to the silhouette.
 * 2. Feather: the body kept where the silhouette, eroded by half the radius and blurred by a
 *    quarter of it, is, so the edge fades from about nothing at the outline to full strength
 *    `radius` inside.
 * 3. Drop shadows and outer glows, in stack order, under the body: the silhouette grown by
 *    `spread`, blurred, offset (shadows) and coloured.
 * 4. Layer blurs, over the whole result (shadows included).
 *
 * Blur radii are CSS / Figma blur radii: the Gaussian's standard deviation is half the radius, and
 * it reaches about 1.5 radii. Background blur needs the backdrop, which an SVG filter cannot read
 * (`BackgroundImage` was dropped from browsers) and which other SVG readers cannot either, so it is
 * left to the planned lens objects.
 *
 * The construction of feather, glows and inner shadows from blur, offset and clip follows
 * designcraft `crates/render/src/fx.rs` (`draw_item_fx`, `inner_edge`, `split`); the effect set,
 * defaults and reach follow figcraft `crates/doc/src/props.rs` (`EffectKind`, `Shadow`,
 * `Effect::reach`). Ported from ArtCraft (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md).
 */
import type { VectorEffectParamSpec } from './appearance.js';
import { VECTOR_FILTER_TYPES, type VectorBounds, type VectorFilter, type VectorFilterParamsMap, type VectorFilterType, type VectorNode } from './types.js';

/** Default parameters of each filter type. */
export const VECTOR_FILTER_DEFAULTS: { readonly [K in VectorFilterType]: VectorFilterParamsMap[K] } = {
	dropShadow: { color: '#000000', opacity: 0.25, offsetX: 0, offsetY: 4, blur: 4, spread: 0 },
	innerShadow: { color: '#000000', opacity: 0.25, offsetX: 0, offsetY: 4, blur: 4, spread: 0 },
	outerGlow: { color: '#ffffbe', opacity: 0.75, blur: 10, spread: 0 },
	innerGlow: { color: '#ffffbe', opacity: 0.75, blur: 10, spread: 0 },
	layerBlur: { radius: 4 },
	feather: { radius: 8 }
};

export const VECTOR_FILTER_LABELS: Readonly<Record<VectorFilterType, string>> = {
	dropShadow: 'Drop Shadow',
	innerShadow: 'Inner Shadow',
	outerGlow: 'Outer Glow',
	innerGlow: 'Inner Glow',
	layerBlur: 'Layer Blur',
	feather: 'Feather'
};

/** How a panel edits one filter parameter: an effect parameter spec, or a colour. */
export type VectorFilterParamSpec = VectorEffectParamSpec | { key: string; label: string; kind: 'color' };

const SHADOW_SPECS: VectorFilterParamSpec[] = [
	{ key: 'color', label: 'Color', kind: 'color' },
	{ key: 'opacity', label: 'Opacity', kind: 'number', min: 0, max: 1, step: 0.01, slider: true },
	{ key: 'offsetX', label: 'X', kind: 'number', min: -1000, max: 1000, step: 1 },
	{ key: 'offsetY', label: 'Y', kind: 'number', min: -1000, max: 1000, step: 1 },
	{ key: 'blur', label: 'Blur', kind: 'number', min: 0, max: 500, step: 1 },
	{ key: 'spread', label: 'Spread', kind: 'number', min: 0, max: 500, step: 1 }
];
const GLOW_SPECS = SHADOW_SPECS.filter((s) => s.key !== 'offsetX' && s.key !== 'offsetY');

/** The editable parameters of each filter type, in panel order. */
export const VECTOR_FILTER_PARAM_SPECS: Readonly<Record<VectorFilterType, readonly VectorFilterParamSpec[]>> = {
	dropShadow: SHADOW_SPECS,
	innerShadow: SHADOW_SPECS.map((s) => (s.key === 'spread' ? { ...s, label: 'Choke' } : s)),
	outerGlow: GLOW_SPECS,
	innerGlow: GLOW_SPECS.map((s) => (s.key === 'spread' ? { ...s, label: 'Choke' } : s)),
	layerBlur: [{ key: 'radius', label: 'Radius', kind: 'number', min: 0, max: 500, step: 1, slider: true }],
	feather: [{ key: 'radius', label: 'Radius', kind: 'number', min: 0, max: 500, step: 1, slider: true }]
};

export function isVectorFilterType(value: unknown): value is VectorFilterType {
	return typeof value === 'string' && (VECTOR_FILTER_TYPES as readonly string[]).includes(value);
}

/**
 * Filter parameters with defaults (or `base`) filled in; values of the wrong type are dropped,
 * numbers clamped to their range, unknown keys ignored. Null for an unknown type.
 */
export function normalizeVectorFilterParams<K extends VectorFilterType>(type: K, params: Record<string, unknown> | null | undefined, base?: VectorFilterParamsMap[K]): VectorFilterParamsMap[K] | null {
	if (!isVectorFilterType(type)) return null;
	const out: Record<string, unknown> = { ...VECTOR_FILTER_DEFAULTS[type], ...((base as Record<string, unknown> | undefined) ?? {}) };
	for (const spec of VECTOR_FILTER_PARAM_SPECS[type]) {
		const v = params?.[spec.key];
		if (v === undefined) continue;
		if (spec.kind === 'number' && typeof v === 'number' && Number.isFinite(v)) out[spec.key] = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, v));
		else if (spec.kind === 'color' && typeof v === 'string' && v.trim()) out[spec.key] = v.trim();
	}
	return out as VectorFilterParamsMap[K];
}

/** The parameter keys a filter type takes (for error messages). */
export function vectorFilterParamKeys(type: VectorFilterType): string[] {
	return VECTOR_FILTER_PARAM_SPECS[type].map((s) => s.key);
}

/** A new filter of `type` (defaults merged with `params`), or null for an unknown type. */
export function createVectorFilter<K extends VectorFilterType>(type: K, id: string, params?: Partial<VectorFilterParamsMap[K]> | Record<string, unknown>): Extract<VectorFilter, { type: K }> | null {
	const p = normalizeVectorFilterParams(type, params as Record<string, unknown>);
	return p ? ({ id, type, params: p } as unknown as Extract<VectorFilter, { type: K }>) : null;
}

/**
 * Reads filters from untrusted data (JSON, agent input, SVG): unknown types and malformed entries
 * are dropped, parameters normalized, ids made unique.
 */
export function sanitizeVectorFilters(value: unknown): VectorFilter[] {
	if (!Array.isArray(value)) return [];
	const out: VectorFilter[] = [];
	const used = new Set<string>();
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		if (!isVectorFilterType(r.type)) continue;
		let id = typeof r.id === 'string' && r.id && !used.has(r.id) ? r.id : '';
		for (let k = out.length + 1; !id; k++) if (!used.has(`filter${k}`)) id = `filter${k}`;
		used.add(id);
		const filter = createVectorFilter(r.type, id, (r.params as Record<string, unknown>) ?? {})!;
		out.push(r.enabled === false ? { ...filter, enabled: false } : filter);
	}
	return out;
}

/** The node's filters that draw something (enabled, known, with a visible result). */
export function activeVectorFilters(node: Pick<VectorNode, 'filters'>): VectorFilter[] {
	return (node.filters ?? []).filter((f) => {
		if (f.enabled === false || !isVectorFilterType(f.type)) return false;
		if (f.type === 'layerBlur' || f.type === 'feather') return f.params.radius > 0;
		return f.params.opacity > 0;
	});
}

/** How far a node's filters can paint past what it draws, in its own units. */
export function vectorFilterReach(filters: readonly VectorFilter[]): number {
	let outer = 0;
	let blur = 0;
	for (const f of filters) {
		switch (f.type) {
			case 'dropShadow':
			case 'innerShadow':
				outer = Math.max(outer, Math.max(Math.abs(f.params.offsetX), Math.abs(f.params.offsetY)) + f.params.blur * 1.5 + f.params.spread);
				break;
			case 'outerGlow':
			case 'innerGlow':
				outer = Math.max(outer, f.params.blur * 1.5 + f.params.spread);
				break;
			case 'layerBlur':
				blur += f.params.radius * 1.5;
				break;
		}
	}
	return outer + blur;
}

/** One SVG filter primitive as data: a tag (`feGaussianBlur`, …), its attributes and children. */
export interface VectorFilterPrimitive {
	tag: string;
	attrs: Readonly<Record<string, string | number>>;
	children?: VectorFilterPrimitive[];
}

/**
 * A node's filter as data: draw `<filter id filterUnits="userSpaceOnUse" x y width height
 * color-interpolation-filters="sRGB">` with the primitives inside, and reference it with
 * `filter="url(#id)"` on the node's element. The region is in the node's own space.
 */
export interface VectorRenderFilter {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	primitives: VectorFilterPrimitive[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const fe = (tag: string, attrs: Record<string, string | number>, children?: VectorFilterPrimitive[]): VectorFilterPrimitive => ({ tag, attrs, ...(children ? { children } : {}) });

/**
 * The SVG filter for `filters` over a node whose drawing covers `bounds` (its own space, strokes
 * included), or null when none of them draws.
 */
export function vectorFilterSvg(filters: readonly VectorFilter[], id: string, bounds: VectorBounds | null): VectorRenderFilter | null {
	const active = filters.filter((f) => activeVectorFilters({ filters: [f] }).length);
	if (!active.length || !bounds) return null;
	const primitives: VectorFilterPrimitive[] = [];
	let body = 'SourceGraphic';
	let n = 0;
	const name = (part: string) => `${part}${n}`;
	// Inner shadows and glows, over the body and clipped to the silhouette.
	for (const f of active) {
		if (f.type !== 'innerShadow' && f.type !== 'innerGlow') continue;
		n++;
		const p = f.params;
		primitives.push(fe('feComponentTransfer', { in: 'SourceAlpha', result: name('inv') }, [fe('feFuncA', { type: 'table', tableValues: '1 0' })]));
		let last = name('inv');
		if (f.type === 'innerShadow' && (f.params.offsetX || f.params.offsetY)) {
			primitives.push(fe('feOffset', { in: last, dx: round(f.params.offsetX), dy: round(f.params.offsetY), result: name('off') }));
			last = name('off');
		}
		if (p.spread > 0) {
			primitives.push(fe('feMorphology', { in: last, operator: 'dilate', radius: round(p.spread), result: name('grow') }));
			last = name('grow');
		}
		if (p.blur > 0) {
			primitives.push(fe('feGaussianBlur', { in: last, stdDeviation: round(p.blur / 2), result: name('blur') }));
			last = name('blur');
		}
		primitives.push(fe('feFlood', { 'flood-color': p.color, 'flood-opacity': round(p.opacity), result: name('color') }));
		primitives.push(fe('feComposite', { in: name('color'), in2: last, operator: 'in', result: name('tint') }));
		primitives.push(fe('feComposite', { in: name('tint'), in2: 'SourceAlpha', operator: 'in', result: name('inner') }));
		primitives.push(fe('feComposite', { in: name('inner'), in2: body, operator: 'over', result: name('body') }));
		body = name('body');
	}
	// Feather: keep the body where the eroded, blurred silhouette is.
	for (const f of active) {
		if (f.type !== 'feather') continue;
		n++;
		const r = f.params.radius;
		primitives.push(fe('feMorphology', { in: 'SourceAlpha', operator: 'erode', radius: round(r / 2), result: name('core') }));
		primitives.push(fe('feGaussianBlur', { in: name('core'), stdDeviation: round(r / 4), result: name('fade') }));
		primitives.push(fe('feComposite', { in: body, in2: name('fade'), operator: 'in', result: name('body') }));
		body = name('body');
	}
	// Drop shadows and outer glows, under the body.
	const under: string[] = [];
	for (const f of active) {
		if (f.type !== 'dropShadow' && f.type !== 'outerGlow') continue;
		n++;
		const p = f.params;
		let last = 'SourceAlpha';
		if (p.spread > 0) {
			primitives.push(fe('feMorphology', { in: last, operator: 'dilate', radius: round(p.spread), result: name('grow') }));
			last = name('grow');
		}
		if (p.blur > 0) {
			primitives.push(fe('feGaussianBlur', { in: last, stdDeviation: round(p.blur / 2), result: name('blur') }));
			last = name('blur');
		}
		if (f.type === 'dropShadow' && (f.params.offsetX || f.params.offsetY)) {
			primitives.push(fe('feOffset', { in: last, dx: round(f.params.offsetX), dy: round(f.params.offsetY), result: name('off') }));
			last = name('off');
		}
		primitives.push(fe('feFlood', { 'flood-color': p.color, 'flood-opacity': round(p.opacity), result: name('color') }));
		primitives.push(fe('feComposite', { in: name('color'), in2: last, operator: 'in', result: name('shadow') }));
		under.push(name('shadow'));
	}
	if (under.length) {
		n++;
		primitives.push(fe('feMerge', { result: name('merged') }, [...under, body].map((i) => fe('feMergeNode', { in: i }))));
		body = name('merged');
	}
	// Layer blurs, over everything.
	for (const f of active) {
		if (f.type !== 'layerBlur') continue;
		n++;
		primitives.push(fe('feGaussianBlur', { in: body, stdDeviation: round(f.params.radius / 2), result: name('body') }));
		body = name('body');
	}
	// The last primitive is the filter's result; make sure it is the body.
	const lastResult = primitives[primitives.length - 1]?.attrs.result;
	if (lastResult !== body) primitives.push(fe('feMerge', {}, [fe('feMergeNode', { in: body })]));
	const pad = vectorFilterReach(active) + 2;
	return {
		id,
		x: round(bounds.x - pad),
		y: round(bounds.y - pad),
		width: round(bounds.width + 2 * pad),
		height: round(bounds.height + 2 * pad),
		primitives
	};
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function primitiveMarkup(p: VectorFilterPrimitive): string {
	const attrs = Object.entries(p.attrs)
		.map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
		.join('');
	return p.children?.length ? `<${p.tag}${attrs}>${p.children.map(primitiveMarkup).join('')}</${p.tag}>` : `<${p.tag}${attrs}/>`;
}

/** A render filter as SVG markup (`extra` is added to the `<filter>` element's attributes). */
export function vectorFilterMarkup(filter: VectorRenderFilter, extra = ''): string {
	return `<filter id="${escapeAttr(filter.id)}" filterUnits="userSpaceOnUse" x="${filter.x}" y="${filter.y}" width="${filter.width}" height="${filter.height}" color-interpolation-filters="sRGB"${extra}>${filter.primitives.map(primitiveMarkup).join('')}</filter>`;
}

/** Labels of the filter types, for menus. */
export const VECTOR_FILTER_MENU: readonly { type: VectorFilterType; label: string }[] = VECTOR_FILTER_TYPES.map((type) => ({ type, label: VECTOR_FILTER_LABELS[type] }));
