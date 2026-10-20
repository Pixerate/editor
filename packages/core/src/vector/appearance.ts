/**
 * Live appearance: path effect stacks and live boolean groups, evaluated on demand while the
 * stored anchors and children stay editable.
 *
 * `expandVectorAppearance` is the one place the effected geometry is made (cached per node
 * object, so an edit recomputes only the nodes it replaced). Rendering, hit-testing, bounds,
 * snapping, booleans, the Pathfinder, the Shape Builder and SVG export all read it, the way they
 * read live corners through `subpathsToBezier`; Expand Appearance stores it.
 *
 * Stacking follows After Effects' shape layers (effectcraft `crates/render/src/shapes.rs`): an
 * effect acts on every path above it — the node's own outline, or for a group every path of its
 * children (nested groups included, as drawn by their own effects) — in the order of the stack,
 * and effects placed after a repeater act on its copies. The result paints with the style of the
 * path each shape came from; Merge Paths and live booleans paint with the bottom one's.
 *
 * Live booleans fold their operands bottom to top, each combined with the result below it by its
 * own operation or the group's, and every prefix of the fold is cached under a rolling hash of the
 * operands it covers, so editing one operand recombines only the operands from it up; the cache
 * drops its least recently used half when full. Live groups are hit by their result except while
 * they are being edited (`vectorEnteredGroups`).
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md): the stacking rule of effectcraft `crates/render/src/shapes.rs`
 * (`collect()`); figcraft `crates/render/src/boolean.rs` (`fold_cached`, `PathCache`) and
 * `crates/engine/src/booleans.rs` (`operand_op`, `result_outline`); and the live-object model of
 * vectorcraft `crates/doc/src/live.rs` (`expand_live`, `expanded_group`, `subtree_has_live`).
 */
import { bezierPathBounds, transformBezierPath, type AffineMatrix, type BezierPath } from '../canvas/pathops/bezier.js';
import { pathBoolean } from '../canvas/pathops/boolean.js';
import { bezierToSubpaths, isIdentityMatrix, subpathsToBezier } from './geometry.js';
import {
	mergePaths,
	offsetPaths,
	pathsCenter,
	puckerBloatPaths,
	repeatPaths,
	roundCornerPaths,
	trimPaths,
	trimPathsIndividually,
	twistPaths,
	wigglePaths,
	zigzagPaths
} from './pathEffects.js';
import { mapBezierPath } from './pathMap.js';
import { isVectorMaskGroup, vectorMaskedShapes } from './mask.js';
import { vectorTextPaintSource, vectorTextPaths, vectorTextShaperGeneration } from './text.js';
import { vectorInstanceGroup } from './symbols.js';
import { transformVectorNode } from './geometry.js';
import {
	VECTOR_WARP_STYLES,
	VECTOR_WARP_STYLE_LABELS,
	evalVectorMesh,
	isValidVectorMesh,
	mapVectorMeshPoints,
	resizeVectorMesh,
	vectorIdentityMesh,
	vectorWarpPresetMesh
} from './warp.js';
import type {
	VectorBounds,
	Vec2,
	VectorBooleanOperation,
	VectorEffect,
	VectorEffectParamsMap,
	VectorEffectType,
	VectorFillRule,
	VectorGroupNode,
	VectorInstanceNode,
	VectorNode,
	VectorPathNode,
	VectorWarpMesh
} from './types.js';

/** One shape of a node's appearance: a path in the node's own space, painted in `source`'s style. */
export interface VectorAppearanceShape {
	/** The path whose style paints it. */
	source: VectorPathNode;
	path: BezierPath;
	/** Opacity factor relative to the node (its own opacity not included). */
	opacity: number;
	/** Draw-order key (compared element by element). */
	order: number[];
}

// ---------------------------------------------------------------------------
// Effect definitions
// ---------------------------------------------------------------------------

/** Default parameters of each effect type. */
export const VECTOR_EFFECT_DEFAULTS: { readonly [K in VectorEffectType]: VectorEffectParamsMap[K] } = {
	trim: { start: 0, end: 50, offset: 0, mode: 'simultaneous' },
	roundCorners: { radius: 10 },
	puckerBloat: { amount: 30 },
	twist: { angle: 45, center: { x: 0, y: 0 } },
	zigzag: { size: 5, ridges: 4, smooth: false },
	wiggle: { size: 5, detail: 6, smooth: true, speed: 2, correlation: 50, phase: 0, seed: 1, time: 0 },
	offset: { amount: 5, join: 'miter', miterLimit: 4, copies: 1, copyOffset: 0 },
	merge: { mode: 'add' },
	repeater: {
		copies: 3,
		offset: 0,
		position: { x: 100, y: 0 },
		anchor: { x: 0, y: 0 },
		rotation: 0,
		scale: { x: 100, y: 100 },
		startOpacity: 100,
		endOpacity: 100,
		composite: 'below'
	},
	envelope: { style: 'arc', bend: 50, horizontal: 0, vertical: 0, orientation: 'horizontal', rows: 2, columns: 2, mesh: null }
};

export const VECTOR_EFFECT_LABELS: Record<VectorEffectType, string> = {
	trim: 'Trim Paths',
	roundCorners: 'Round Corners',
	puckerBloat: 'Pucker & Bloat',
	twist: 'Twist',
	zigzag: 'Zig Zag',
	wiggle: 'Wiggle Paths',
	offset: 'Offset Paths',
	merge: 'Merge Paths',
	repeater: 'Repeater',
	envelope: 'Envelope'
};

/** How a panel edits one effect parameter. */
export type VectorEffectParamSpec =
	| { key: string; label: string; kind: 'number'; min?: number; max?: number; step: number; slider?: boolean }
	| { key: string; label: string; kind: 'vec2'; step: number }
	| { key: string; label: string; kind: 'boolean' }
	| { key: string; label: string; kind: 'select'; options: { value: string; label: string }[] };

/** The editable parameters of each effect type, in panel order. */
export const VECTOR_EFFECT_PARAM_SPECS: Record<VectorEffectType, VectorEffectParamSpec[]> = {
	trim: [
		{ key: 'start', label: 'Start %', kind: 'number', min: 0, max: 100, step: 1, slider: true },
		{ key: 'end', label: 'End %', kind: 'number', min: 0, max: 100, step: 1, slider: true },
		{ key: 'offset', label: 'Offset °', kind: 'number', min: -360, max: 360, step: 1, slider: true },
		{
			key: 'mode',
			label: 'Paths',
			kind: 'select',
			options: [
				{ value: 'simultaneous', label: 'Simultaneously' },
				{ value: 'individual', label: 'Individually' }
			]
		}
	],
	roundCorners: [{ key: 'radius', label: 'Radius', kind: 'number', min: 0, max: 200, step: 1, slider: true }],
	puckerBloat: [{ key: 'amount', label: 'Amount %', kind: 'number', min: -100, max: 100, step: 1, slider: true }],
	twist: [
		{ key: 'angle', label: 'Angle °', kind: 'number', min: -720, max: 720, step: 1, slider: true },
		{ key: 'center', label: 'Centre', kind: 'vec2', step: 1 }
	],
	zigzag: [
		{ key: 'size', label: 'Size', kind: 'number', min: 0, max: 100, step: 0.5, slider: true },
		{ key: 'ridges', label: 'Ridges', kind: 'number', min: 0, max: 50, step: 1, slider: true },
		{ key: 'smooth', label: 'Smooth', kind: 'boolean' }
	],
	wiggle: [
		{ key: 'size', label: 'Size', kind: 'number', min: 0, max: 100, step: 0.5, slider: true },
		{ key: 'detail', label: 'Detail', kind: 'number', min: 0, max: 50, step: 1, slider: true },
		{ key: 'smooth', label: 'Smooth', kind: 'boolean' },
		{ key: 'correlation', label: 'Correlation %', kind: 'number', min: 0, max: 100, step: 1, slider: true },
		{ key: 'speed', label: 'Speed', kind: 'number', min: 0, step: 0.1 },
		{ key: 'phase', label: 'Phase °', kind: 'number', step: 1 },
		{ key: 'time', label: 'Time (s)', kind: 'number', min: 0, max: 10, step: 0.05, slider: true },
		{ key: 'seed', label: 'Seed', kind: 'number', step: 1 }
	],
	offset: [
		{ key: 'amount', label: 'Amount', kind: 'number', min: -100, max: 100, step: 0.5, slider: true },
		{
			key: 'join',
			label: 'Join',
			kind: 'select',
			options: [
				{ value: 'miter', label: 'Miter' },
				{ value: 'round', label: 'Round' },
				{ value: 'bevel', label: 'Bevel' }
			]
		},
		{ key: 'miterLimit', label: 'Miter limit', kind: 'number', min: 1, step: 0.5 },
		{ key: 'copies', label: 'Copies', kind: 'number', min: 1, max: 20, step: 1 },
		{ key: 'copyOffset', label: 'Copy offset', kind: 'number', step: 0.5 }
	],
	merge: [
		{
			key: 'mode',
			label: 'Mode',
			kind: 'select',
			options: [
				{ value: 'merge', label: 'Merge' },
				{ value: 'add', label: 'Add' },
				{ value: 'subtract', label: 'Subtract' },
				{ value: 'intersect', label: 'Intersect' },
				{ value: 'exclude', label: 'Exclude' }
			]
		}
	],
	repeater: [
		{ key: 'copies', label: 'Copies', kind: 'number', min: 0, max: 50, step: 0.1, slider: true },
		{ key: 'offset', label: 'Offset', kind: 'number', min: -10, max: 10, step: 0.1, slider: true },
		{ key: 'position', label: 'Position', kind: 'vec2', step: 1 },
		{ key: 'anchor', label: 'Anchor', kind: 'vec2', step: 1 },
		{ key: 'rotation', label: 'Rotation °', kind: 'number', min: -360, max: 360, step: 1, slider: true },
		{ key: 'scale', label: 'Scale %', kind: 'vec2', step: 1 },
		{ key: 'startOpacity', label: 'Start opacity %', kind: 'number', min: 0, max: 100, step: 1, slider: true },
		{ key: 'endOpacity', label: 'End opacity %', kind: 'number', min: 0, max: 100, step: 1, slider: true },
		{
			key: 'composite',
			label: 'Copies',
			kind: 'select',
			options: [
				{ value: 'below', label: 'Below' },
				{ value: 'above', label: 'Above' }
			]
		}
	],
	envelope: [
		{
			key: 'style',
			label: 'Warp',
			kind: 'select',
			options: [...VECTOR_WARP_STYLES.map((value) => ({ value, label: VECTOR_WARP_STYLE_LABELS[value] })), { value: 'mesh', label: 'Mesh' }]
		},
		{ key: 'bend', label: 'Bend %', kind: 'number', min: -100, max: 100, step: 1, slider: true },
		{ key: 'horizontal', label: 'Horizontal distortion %', kind: 'number', min: -100, max: 100, step: 1, slider: true },
		{ key: 'vertical', label: 'Vertical distortion %', kind: 'number', min: -100, max: 100, step: 1, slider: true },
		{
			key: 'orientation',
			label: 'Orientation',
			kind: 'select',
			options: [
				{ value: 'horizontal', label: 'Horizontal' },
				{ value: 'vertical', label: 'Vertical' }
			]
		},
		{ key: 'rows', label: 'Mesh rows', kind: 'number', min: 1, max: 16, step: 1 },
		{ key: 'columns', label: 'Mesh columns', kind: 'number', min: 1, max: 16, step: 1 }
	]
};

/** Envelope parameters. */
export type VectorEnvelopeParams = VectorEffectParamsMap['envelope'];

const cloneMesh = (m: VectorWarpMesh): VectorWarpMesh => ({ us: m.us.slice(), vs: m.vs.slice(), points: m.points.map((p) => ({ x: p.x, y: p.y })) });

/**
 * The envelope's mesh over `bounds` (the paths' combined bounds), in the node's space: its own
 * mesh, the flat mesh of `columns × rows` patches, or a preset split exactly into that many patches.
 */
export function vectorEnvelopeMesh(params: VectorEnvelopeParams, bounds: VectorBounds): VectorWarpMesh {
	if (params.style === 'mesh') return params.mesh ?? vectorIdentityMesh(bounds, params.columns, params.rows);
	const preset = vectorWarpPresetMesh({ style: params.style, bend: params.bend, horizontal: params.horizontal, vertical: params.vertical, orientation: params.orientation }, bounds);
	return preset ? resizeVectorMesh(preset, params.columns, params.rows) : vectorIdentityMesh(bounds, params.columns, params.rows);
}

/** The envelope as a map of the node's space over `bounds`, or null when it changes nothing (or the box is empty). */
export function vectorEnvelopeMap(params: VectorEnvelopeParams, bounds: VectorBounds | null): ((p: { x: number; y: number }) => { x: number; y: number }) | null {
	if (!bounds || !(bounds.width > 0 && bounds.height > 0)) return null;
	const mesh =
		params.style === 'mesh'
			? params.mesh
			: vectorWarpPresetMesh({ style: params.style, bend: params.bend, horizontal: params.horizontal, vertical: params.vertical, orientation: params.orientation }, bounds);
	if (!mesh) return null;
	const { x, y, width, height } = bounds;
	return (p) => evalVectorMesh(mesh, (p.x - x) / width, (p.y - y) / height);
}

/** Combined bounds of paths. */
function pathsBounds(paths: readonly BezierPath[]): VectorBounds | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of paths) {
		const b = bezierPathBounds(p);
		if (!b) continue;
		minX = Math.min(minX, b.minX);
		minY = Math.min(minY, b.minY);
		maxX = Math.max(maxX, b.maxX);
		maxY = Math.max(maxY, b.maxY);
	}
	return minX <= maxX ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

/** The paths through an envelope (each mapped adaptively, within a tolerance relative to their size). */
function envelopePaths(paths: BezierPath[], params: VectorEnvelopeParams): BezierPath[] {
	const bounds = pathsBounds(paths);
	const f = vectorEnvelopeMap(params, bounds);
	if (!f || !bounds) return paths;
	const tol = Math.min(0.25, Math.max(0.01, Math.hypot(bounds.width, bounds.height) / 2000));
	return paths.map((p) => (p.length ? mapBezierPath(p, f, tol) : p));
}

const isVec2 = (v: unknown): v is Vec2 => !!v && typeof v === 'object' && Number.isFinite((v as Vec2).x) && Number.isFinite((v as Vec2).y);

/**
 * Effect parameters with defaults filled in and invalid values dropped (unknown keys go too).
 * Returns null for an unknown type.
 */
export function normalizeVectorEffectParams<K extends VectorEffectType>(type: K, params: Record<string, unknown> | null | undefined, base?: VectorEffectParamsMap[K]): VectorEffectParamsMap[K] | null {
	const defaults = VECTOR_EFFECT_DEFAULTS[type] as Record<string, unknown> | undefined;
	if (!defaults) return null;
	const out: Record<string, unknown> = { ...defaults, ...((base as Record<string, unknown> | undefined) ?? {}) };
	for (const spec of VECTOR_EFFECT_PARAM_SPECS[type]) {
		const v = params?.[spec.key];
		if (v === undefined) continue;
		if (spec.kind === 'number' && typeof v === 'number' && Number.isFinite(v)) out[spec.key] = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, v));
		else if (spec.kind === 'boolean' && typeof v === 'boolean') out[spec.key] = v;
		else if (spec.kind === 'vec2' && isVec2(v)) out[spec.key] = { x: v.x, y: v.y };
		else if (spec.kind === 'select' && spec.options.some((o) => o.value === v)) out[spec.key] = v;
	}
	if (type === 'envelope') {
		const o = out as unknown as VectorEnvelopeParams;
		o.rows = Math.round(o.rows);
		o.columns = Math.round(o.columns);
		const given = params?.mesh;
		let mesh: VectorWarpMesh | null = given !== undefined ? (isValidVectorMesh(given) ? cloneMesh(given) : null) : o.mesh;
		if (o.style !== 'mesh') mesh = null;
		if (mesh && given !== undefined) {
			o.columns = mesh.us.length - 1;
			o.rows = mesh.vs.length - 1;
		} else if (mesh) mesh = resizeVectorMesh(mesh, o.columns, o.rows);
		o.mesh = mesh;
	}
	return out as VectorEffectParamsMap[K];
}

/** A new effect of `type` (defaults merged with `params`), or null for an unknown type. */
export function createVectorEffect<K extends VectorEffectType>(type: K, id: string, params?: Partial<VectorEffectParamsMap[K]> | Record<string, unknown>): Extract<VectorEffect, { type: K }> | null {
	const p = normalizeVectorEffectParams(type, params as Record<string, unknown>);
	return p ? ({ id, type, params: p } as unknown as Extract<VectorEffect, { type: K }>) : null;
}

const isEnabled = (e: VectorEffect) => e.enabled !== false && !!VECTOR_EFFECT_DEFAULTS[e.type];

/** The node's effects that take part (enabled, of a known type). */
export function activeVectorEffects(node: VectorNode): VectorEffect[] {
	return node.effects?.filter(isEnabled) ?? [];
}

/**
 * Whether the node itself draws differently from its stored geometry (effects or a live boolean).
 * Text always does: it draws as its glyphs.
 */
export function hasOwnVectorAppearance(node: VectorNode): boolean {
	return node.type === 'text' || node.type === 'instance' || (node.type === 'group' && !!node.liveBoolean) || !!node.effects?.some(isEnabled);
}

const liveCache = new WeakMap<VectorNode, boolean>();

/** Whether the node or anything inside it has a live appearance. */
export function hasVectorAppearance(node: VectorNode): boolean {
	let v = liveCache.get(node);
	if (v === undefined) {
		v = hasOwnVectorAppearance(node) || (node.type === 'group' && node.children.some(hasVectorAppearance));
		liveCache.set(node, v);
	}
	return v;
}

/** A live boolean group (its children are operands). */
export function isVectorLiveBoolean(node: VectorNode | null | undefined): node is VectorGroupNode & { liveBoolean: VectorBooleanOperation } {
	return node?.type === 'group' && !!node.liveBoolean;
}

/** How operand `child` of a live boolean group combines with the operands below it. */
export function vectorOperandOperation(group: VectorGroupNode, child: VectorNode): VectorBooleanOperation {
	return child.booleanOperation ?? group.liveBoolean ?? 'union';
}

// ---------------------------------------------------------------------------
// Live boolean fold
// ---------------------------------------------------------------------------

const PATH_OPS = { union: 'union', subtract: 'difference', intersect: 'intersection', exclude: 'xor' } as const;

/** A bounded map of fold prefixes; the least recently used half goes when it is full. */
class FoldCache {
	private map = new Map<string, BezierPath>();
	constructor(private readonly cap: number) {}
	get(key: string): BezierPath | undefined {
		const hit = this.map.get(key);
		if (hit) {
			this.map.delete(key);
			this.map.set(key, hit);
		}
		return hit;
	}
	set(key: string, path: BezierPath) {
		if (this.map.size >= this.cap) {
			let drop = Math.floor(this.map.size / 2);
			for (const k of this.map.keys()) {
				if (drop-- <= 0) break;
				this.map.delete(k);
			}
		}
		this.map.set(key, path);
	}
	clear() {
		this.map.clear();
	}
}

const foldCache = new FoldCache(4096);
let foldSteps = 0;

/** How many boolean steps (one operand combined with the result below it) live booleans have computed: what a cache miss costs. */
export function vectorLiveBooleanSteps(): number {
	return foldSteps;
}

/** Empties the live boolean prefix cache. */
export function clearVectorLiveBooleanCache(): void {
	foldCache.clear();
}

/** A rolling hash of operands: two 32-bit FNV-1a lanes over every number's bits. */
class RollingHash {
	private a = 0x811c9dc5;
	private b = 0x01000193 ^ 0x5bd1e995;
	private static view = new DataView(new ArrayBuffer(8));
	byte(v: number) {
		this.a = Math.imul(this.a ^ (v & 0xff), 0x01000193);
		this.b = Math.imul(this.b ^ (v & 0xff), 0x5bd1e995) ^ (this.b >>> 15);
	}
	num(n: number) {
		RollingHash.view.setFloat64(0, n);
		for (let i = 0; i < 8; i++) this.byte(RollingHash.view.getUint8(i));
	}
	path(p: BezierPath) {
		for (const c of p) {
			this.byte(c.type.charCodeAt(0));
			if (c.type === 'Z') continue;
			if (c.type === 'C') {
				this.num(c.x1);
				this.num(c.y1);
				this.num(c.x2);
				this.num(c.y2);
			} else if (c.type === 'Q') {
				this.num(c.x1);
				this.num(c.y1);
			}
			this.num(c.x);
			this.num(c.y);
		}
	}
	key(): string {
		return `${(this.a >>> 0).toString(36)}.${(this.b >>> 0).toString(36)}`;
	}
}

/** One operand of a live boolean: its outline (group space), fill rule and operation (unused for the bottom one). */
export interface VectorBooleanOperand {
	path: BezierPath;
	fillRule: VectorFillRule;
	operation: VectorBooleanOperation;
}

/**
 * The result of folding `operands` bottom to top, reusing the longest cached prefix: only the
 * operands above it are combined. Invalid geometry gives an empty path.
 */
export function foldVectorBooleanOperands(operands: readonly VectorBooleanOperand[]): BezierPath {
	if (!operands.length) return [];
	if (operands.length === 1) return operands[0].path;
	const h = new RollingHash();
	const keys = operands.map((o, i) => {
		if (i > 0) h.byte(o.operation.charCodeAt(0) + o.operation.length);
		h.byte(o.fillRule === 'evenodd' ? 1 : 0);
		h.path(o.path);
		h.byte(9);
		return h.key();
	});
	let start = 0;
	let acc: BezierPath = operands[0].path;
	for (let i = keys.length - 1; i >= 1; i--) {
		const hit = foldCache.get(keys[i]);
		if (hit) {
			if (i === keys.length - 1) return hit;
			start = i;
			acc = hit;
			break;
		}
	}
	let accRule: VectorFillRule = start === 0 ? operands[0].fillRule : 'nonzero';
	for (let i = start + 1; i < operands.length; i++) {
		const o = operands[i];
		foldSteps++;
		const r = pathBoolean(PATH_OPS[o.operation] ?? 'union', [
			{ path: acc, fillRule: accRule },
			{ path: o.path, fillRule: o.fillRule }
		]);
		if (r.error) return [];
		acc = r.path;
		accRule = 'nonzero';
		foldCache.set(keys[i], acc);
	}
	return acc;
}

// ---------------------------------------------------------------------------
// The effect stack
// ---------------------------------------------------------------------------

const compareOrder = (a: readonly number[], b: readonly number[]) => {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
};

const add = (a: Vec2, b: Vec2 | undefined): Vec2 => ({ x: a.x + (b?.x ?? 0), y: a.y + (b?.y ?? 0) });

/** Every path operator maps the shapes' paths one to one. */
const mapPaths = (shapes: VectorAppearanceShape[], fn: (paths: BezierPath[]) => BezierPath[]): VectorAppearanceShape[] => {
	const out = fn(shapes.map((s) => s.path));
	return shapes.map((s, i) => ({ ...s, path: out[i] ?? [] }));
};

/** Applies an effect stack to shapes, top to bottom (disabled effects skipped). */
export function applyVectorEffects(shapes: readonly VectorAppearanceShape[], effects: readonly VectorEffect[] | null | undefined): VectorAppearanceShape[] {
	let list = shapes.slice();
	for (const e of effects ?? []) {
		if (!isEnabled(e) || !list.length) continue;
		switch (e.type) {
			case 'trim': {
				const { start, end, offset, mode } = e.params;
				list = mapPaths(list, (p) => (mode === 'individual' ? trimPathsIndividually(p, start, end, offset) : trimPaths(p, start, end, offset)));
				break;
			}
			case 'roundCorners':
				list = mapPaths(list, (p) => roundCornerPaths(p, e.params.radius));
				break;
			case 'puckerBloat':
				list = mapPaths(list, (p) => puckerBloatPaths(p, e.params.amount));
				break;
			case 'twist':
				list = mapPaths(list, (p) => twistPaths(p, e.params.angle, add(pathsCenter(p), e.params.center)));
				break;
			case 'zigzag':
				list = mapPaths(list, (p) => zigzagPaths(p, e.params.size, e.params.ridges, e.params.smooth));
				break;
			case 'wiggle':
				list = mapPaths(list, (p) => wigglePaths(p, e.params));
				break;
			case 'offset': {
				const o = e.params;
				list = mapPaths(list, (p) => offsetPaths(p, o.amount, o.join, o.miterLimit, o.copies, o.copyOffset));
				break;
			}
			case 'merge': {
				const first = list[0];
				list = [{ ...first, path: mergePaths(list.map((s) => s.path), e.params.mode) }];
				break;
			}
			case 'envelope': {
				const params = e.params;
				list = mapPaths(list, (p) => envelopePaths(p, params));
				break;
			}
			case 'repeater': {
				const r = e.params;
				const copies = repeatPaths(
					list.map((s) => s.path),
					r,
					add(pathsCenter(list.map((s) => s.path)), r.anchor)
				);
				const n = copies.length;
				const next: VectorAppearanceShape[] = [];
				for (const { copy, paths } of copies) {
					// Below: each copy draws under the one before it (the original on top).
					const rank = r.composite === 'above' ? copy.index : n - 1 - copy.index;
					list.forEach((s, i) => next.push({ source: s.source, path: paths[i], opacity: s.opacity * copy.opacity, order: [rank, ...s.order] }));
				}
				list = next;
				break;
			}
		}
	}
	return list;
}

const instanceGroups = new WeakMap<VectorInstanceNode, VectorGroupNode>();

/** What an instance draws as a plain group (cached per instance object; see `vectorInstanceGroup`). */
export function vectorInstanceDrawn(node: VectorInstanceNode): VectorGroupNode {
	let g = instanceGroups.get(node);
	if (!g) {
		g = vectorInstanceGroup(node, (n, m) => transformVectorNode(n, m));
		instanceGroups.set(node, g);
	}
	return g;
}

/** The shapes of a child in its parent's space (hidden children have none), ordered by its index. */
export function vectorChildAppearanceShapes(child: VectorNode, index: number): VectorAppearanceShape[] {
	if (child.visible === false) return [];
	// An instance's transform may scale: its drawn group's is rigid.
	if (child.type === 'instance') child = vectorInstanceDrawn(child);
	const m = child.transform;
	const k = child.opacity ?? 1;
	return vectorAppearanceShapes(child).map((s) => ({
		source: s.source,
		path: m && !isIdentityMatrix(m) ? transformBezierPath(s.path, m) : s.path,
		opacity: s.opacity * k,
		order: [index, ...s.order]
	}));
}

/** A live boolean group's result: its operands folded, in the bottom operand's style. */
function liveBooleanShapes(group: VectorGroupNode): VectorAppearanceShape[] {
	const operands: VectorBooleanOperand[] = [];
	let source: VectorPathNode | null = null;
	group.children.forEach((child, i) => {
		const shapes = vectorChildAppearanceShapes(child, i);
		if (!shapes.length) return;
		source ??= shapes[0].source;
		const path =
			shapes.length === 1 ? shapes[0].path : pathBoolean('union', shapes.map((s) => ({ path: s.path, fillRule: s.source.fillRule ?? 'nonzero' }))).path;
		const fillRule: VectorFillRule = shapes.length === 1 ? (shapes[0].source.fillRule ?? 'nonzero') : 'nonzero';
		operands.push({ path, fillRule, operation: vectorOperandOperation(group, child) });
	});
	if (!source) return [];
	return [{ source, path: foldVectorBooleanOperands(operands), opacity: 1, order: [0] }];
}

/** Caches keyed by node, valid while the text shaper stays the same (text lays out by it). */
const shapeCache = new WeakMap<VectorNode, [number, VectorAppearanceShape[]]>();
const fresh = <T>(entry: [number, T] | undefined): T | undefined => (entry && entry[0] === vectorTextShaperGeneration() ? entry[1] : undefined);

/** What a node's effect stack starts from: its own outline, its live boolean result or its children's shapes. */
function baseShapes(node: VectorNode): VectorAppearanceShape[] {
	if (node.type === 'path') return [{ source: node, path: subpathsToBezier(node.subpaths), opacity: 1, order: [] }];
	// Text: its glyphs, one shape per fill (a run's own fill paints its characters).
	if (node.type === 'text') return vectorTextPaths(node).parts.map((p, k) => ({ source: vectorTextPaintSource(node, p.fill), path: p.path, opacity: 1, order: [k] }));
	if (node.type === 'instance') return baseShapes(vectorInstanceDrawn(node));
	if (node.liveBoolean) return liveBooleanShapes(node);
	// A mask group's effects act on its contents (the mask stays as it is).
	if (isVectorMaskGroup(node)) return node.children.flatMap((c, i) => (i === 0 ? [] : vectorChildAppearanceShapes(c, i)));
	return node.children.flatMap((c, i) => vectorChildAppearanceShapes(c, i));
}

/** The paths entering effect `effectId` of the node's stack (those above it applied), in the node's own space. */
export function vectorEffectInputPaths(node: VectorNode, effectId: string): BezierPath[] | null {
	const list = node.effects ?? [];
	const i = list.findIndex((e) => e.id === effectId);
	if (i < 0) return null;
	return applyVectorEffects(baseShapes(node), list.slice(0, i)).map((s) => s.path);
}

/** The box effect `effectId` (an envelope) bends: the combined bounds of the paths entering it, in the node's own space. */
export function vectorEffectInputBounds(node: VectorNode, effectId: string): VectorBounds | null {
	const paths = vectorEffectInputPaths(node, effectId);
	return paths ? pathsBounds(paths) : null;
}

/** The node's first enabled envelope effect, or null. */
export function vectorNodeEnvelope(node: VectorNode | null | undefined): Extract<VectorEffect, { type: 'envelope' }> | null {
	return (node?.effects?.find((e) => e.type === 'envelope' && e.enabled !== false) as Extract<VectorEffect, { type: 'envelope' }> | undefined) ?? null;
}

/**
 * The editable mesh of a node's envelope (its own mesh, or the preset or flat mesh it stands for)
 * with the box it bends, in the node's own space; null without an envelope or contents.
 */
export function vectorEnvelopeFrame(node: VectorNode, effectId?: string): { effectId: string; bounds: VectorBounds; mesh: VectorWarpMesh } | null {
	const e = effectId ? node.effects?.find((x) => x.id === effectId) : vectorNodeEnvelope(node);
	if (!e || e.type !== 'envelope') return null;
	const bounds = vectorEffectInputBounds(node, e.id);
	if (!bounds || !(bounds.width > 0 && bounds.height > 0)) return null;
	return { effectId: e.id, bounds, mesh: vectorEnvelopeMesh(e.params, bounds) };
}

/**
 * What a node draws as: shapes in its own space (its `transform` and opacity not applied),
 * bottom to top, with its effects and those of everything inside it applied. Cached per node
 * object.
 */
export function vectorAppearanceShapes(node: VectorNode): VectorAppearanceShape[] {
	const hit = fresh(shapeCache.get(node));
	if (hit) return hit;
	if (node.type === 'instance') {
		// In the space of the drawn group (the instance's rotation and translation not applied).
		const shapes = vectorAppearanceShapes(vectorInstanceDrawn(node));
		shapeCache.set(node, [vectorTextShaperGeneration(), shapes]);
		return shapes;
	}
	// A mask group draws its contents (effects applied) clipped by its mask. Text without glyph
	// outlines has only glyph boxes, which effects would distort meaninglessly: they are skipped.
	const effects = node.type === 'text' && !vectorTextPaths(node).outlines ? null : node.effects;
	const out = (isVectorMaskGroup(node) ? vectorMaskedShapes(node) : applyVectorEffects(baseShapes(node), effects)).sort((a, b) => compareOrder(a.order, b.order));
	shapeCache.set(node, [vectorTextShaperGeneration(), out]);
	return out;
}

const outlineCache = new WeakMap<VectorNode, [number, BezierPath]>();

/** Everything a node draws as one path in its own space (live corners cut, effects applied). */
export function vectorAppearanceOutline(node: VectorNode): BezierPath {
	let hit = fresh(outlineCache.get(node));
	if (!hit) {
		hit = node.type === 'path' && !hasOwnVectorAppearance(node) ? subpathsToBezier(node.subpaths) : vectorAppearanceShapes(node).flatMap((s) => s.path);
		outlineCache.set(node, [vectorTextShaperGeneration(), hit]);
	}
	return hit;
}

// ---------------------------------------------------------------------------
// Expanded nodes
// ---------------------------------------------------------------------------

/** A shape as a plain path node in `source`'s style. */
function shapeNode(shape: VectorAppearanceShape, id: string): VectorPathNode {
	const {
		id: _id,
		type: _type,
		subpaths: _s,
		transform: _t,
		effects: _e,
		booleanOperation: _b,
		blendStep: _bs,
		locked: _l,
		visible: _v,
		opacity: _o,
		// The node's own blend mode and filters stay on the node, not on each shape it draws.
		blendMode: _bm,
		filters: _fl,
		...style
	} = shape.source;
	return { ...style, id, type: 'path', subpaths: bezierToSubpaths(shape.path), ...(shape.opacity < 1 ? { opacity: shape.opacity } : {}) };
}

/** The node's own placement and state, kept by its expanded form. */
function placement(node: VectorNode) {
	return {
		...(node.name !== undefined ? { name: node.name } : {}),
		...(node.transform ? { transform: node.transform } : {}),
		...(node.visible === false ? { visible: false } : {}),
		...(node.locked ? { locked: true } : {}),
		...(node.blendStep ? { blendStep: true } : {}),
		...(node.booleanOperation ? { booleanOperation: node.booleanOperation } : {}),
		...(node.blendMode ? { blendMode: node.blendMode } : {}),
		...(node.filters?.length ? { filters: node.filters } : {})
	};
}

/** What a node draws as, one plain path per shape (ids `<id>~fx<n>`, opacity relative to the node). */
export function vectorAppearanceNodes(node: VectorNode): VectorPathNode[] {
	return vectorAppearanceShapes(node).map((s, k) => shapeNode(s, `${node.id}~fx${k}`));
}

const expandCache = new WeakMap<VectorNode, [number, VectorPathNode | VectorGroupNode]>();

/**
 * The node as plain geometry: path effects and live booleans evaluated into paths (the node
 * itself when nothing inside it is live). A path keeps its id when it draws as one shape;
 * otherwise, like any live group, it becomes a group with that id holding one path per shape
 * (ids `<id>~fx<n>`). Groups without effects of their own keep their structure. Cached per node.
 */
export function expandVectorAppearance(node: VectorNode): VectorPathNode | VectorGroupNode {
	// Text always has an appearance (its glyphs), so what is returned as is is a path or group.
	if (!hasVectorAppearance(node)) return node as VectorPathNode | VectorGroupNode;
	const hit = fresh(expandCache.get(node));
	if (hit) return hit;
	if (node.type === 'instance') {
		const drawn = expandVectorAppearance(vectorInstanceDrawn(node));
		expandCache.set(node, [vectorTextShaperGeneration(), drawn]);
		return drawn;
	}
	let out: VectorPathNode | VectorGroupNode;
	if (!hasOwnVectorAppearance(node)) {
		const group = node as VectorGroupNode;
		out = { ...group, children: group.children.map(expandVectorAppearance) };
	} else if (isVectorMaskGroup(node)) {
		// A mask group keeps its mask; its effects act on the contents, wrapped in a group of their own.
		const { effects, ...group } = node;
		const [mask, ...contents] = node.children;
		const wrapper: VectorGroupNode = { id: `${node.id}~content`, type: 'group', effects, children: contents };
		out = { ...group, children: [expandVectorAppearance(mask), ...(contents.length ? [expandVectorAppearance(wrapper)] : [])] };
	} else {
		const shapes = vectorAppearanceShapes(node);
		if (node.type === 'path' && shapes.length === 1) {
			const one = shapes[0];
			const { effects: _e, opacity: _o, ...rest } = node;
			const opacity = (node.opacity ?? 1) * one.opacity;
			out = { ...rest, subpaths: bezierToSubpaths(one.path), ...(opacity < 1 ? { opacity } : {}) };
		} else if (node.type === 'text' && shapes.length === 1) {
			// Text in one paint draws as one compound path with the text's id.
			const one = shapes[0];
			const opacity = (node.opacity ?? 1) * one.opacity;
			out = { ...shapeNode(one, node.id), ...placement(node), ...(opacity < 1 ? { opacity } : {}) };
			if (opacity >= 1) delete out.opacity;
		} else {
			out = {
				id: node.id,
				type: 'group',
				...placement(node),
				...(node.opacity !== undefined ? { opacity: node.opacity } : {}),
				children: vectorAppearanceNodes(node)
			};
		}
	}
	expandCache.set(node, [vectorTextShaperGeneration(), out]);
	return out;
}

/** Every node of a list expanded (the same array when nothing in it is live). */
export function expandVectorAppearances(nodes: readonly VectorNode[]): VectorNode[] {
	let changed = false;
	const out = nodes.map((n) => {
		const e = expandVectorAppearance(n);
		if (e !== n) changed = true;
		return e;
	});
	return changed ? out : (nodes as VectorNode[]);
}

/**
 * Reads effects from untrusted data (JSON, agent input): unknown types and malformed entries are
 * dropped, parameters normalized, ids made unique.
 */
export function sanitizeVectorEffects(value: unknown): VectorEffect[] {
	if (!Array.isArray(value)) return [];
	const out: VectorEffect[] = [];
	const used = new Set<string>();
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		const type = r.type as VectorEffectType;
		if (typeof type !== 'string' || !VECTOR_EFFECT_DEFAULTS[type]) continue;
		let id = typeof r.id === 'string' && r.id && !used.has(r.id) ? r.id : '';
		for (let k = out.length + 1; !id; k++) if (!used.has(`fx${k}`)) id = `fx${k}`;
		used.add(id);
		const effect = createVectorEffect(type, id, (r.params as Record<string, unknown>) ?? {})!;
		out.push(r.enabled === false ? { ...effect, enabled: false } : effect);
	}
	return out;
}

/**
 * Effect parameters carried through a linear map baked into a node's geometry (scaling or
 * flipping it): offsets and positions move with it, angles turn the other way when it mirrors.
 * Lengths such as sizes and radii are kept, like stroke widths.
 */
export function transformVectorEffects(effects: readonly VectorEffect[], m: AffineMatrix, node?: VectorNode): VectorEffect[] {
	const lin = (v: Vec2): Vec2 => ({ x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y });
	const full = (v: Vec2): Vec2 => ({ x: m[0] * v.x + m[2] * v.y + m[4], y: m[1] * v.x + m[3] * v.y + m[5] });
	const mirror = m[0] * m[3] - m[1] * m[2] < 0 ? -1 : 1;
	// A preset is laid over the box of what it bends, so it follows a move or a scale by itself; a
	// skew or a mirror turns it into a mesh, which maps like the geometry.
	const axisScale = Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12 && m[0] > 0 && m[3] > 0;
	return effects.map((e) => {
		if (e.type === 'envelope') {
			if (e.params.style === 'mesh') return e.params.mesh ? { ...e, params: { ...e.params, mesh: mapVectorMeshPoints(e.params.mesh, full) } } : e;
			if (axisScale || !node) return e;
			const bounds = vectorEffectInputBounds(node, e.id);
			if (!bounds || !vectorEnvelopeMap(e.params, bounds)) return e;
			return { ...e, params: { ...e.params, style: 'mesh', mesh: mapVectorMeshPoints(vectorEnvelopeMesh(e.params, bounds), full) } };
		}
		if (e.type === 'twist') return { ...e, params: { ...e.params, center: lin(e.params.center), angle: e.params.angle * mirror } };
		if (e.type === 'repeater')
			return { ...e, params: { ...e.params, position: lin(e.params.position), anchor: lin(e.params.anchor), rotation: e.params.rotation * mirror } };
		return e;
	});
}

/**
 * The live groups (live booleans and groups with effects) being edited: those in `ids` and those
 * holding a node in `ids`; mask groups only when they hold one. Their children are hit and outlined as stored instead of as drawn, so
 * each operand can be picked (figcraft `crates/engine/src/booleans.rs`, `result_outline`).
 */
export function vectorEnteredGroups(nodes: readonly VectorNode[], ids: readonly string[]): Set<string> {
	const out = new Set<string>();
	if (!ids.length) return out;
	const want = new Set(ids);
	const visit = (list: readonly VectorNode[], live: readonly string[]) => {
		for (const n of list) {
			const own = n.type === 'group' && (hasOwnVectorAppearance(n) || isVectorMaskGroup(n));
			if (want.has(n.id)) {
				for (const id of live) out.add(id);
				// A selected mask group stays clipped; selecting inside it opens it.
				if (own && hasOwnVectorAppearance(n)) out.add(n.id);
			}
			if (n.type === 'group') visit(n.children, own ? [...live, n.id] : live);
		}
	};
	visit(nodes, []);
	return out;
}
